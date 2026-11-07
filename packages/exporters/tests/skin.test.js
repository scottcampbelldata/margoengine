// Skin authoring (@margoengine/exporters/skin): nearest-bone weights against a brute-force reference, rest matrices
// that invert each other, and a skinned voxel mesh exported as glTF the Khronos validator accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exportGLB } from '@margoengine/exporters';
import { checkJoints, humanoidJoints, skinBindMatrices, skinHierarchy, skinWeights } from '@margoengine/exporters/skin';
import { accessor, readGLB, validate, validator } from './helpers.js';

const needsValidator = validator ? {} : { skip: 'gltf-validator not installed' };
const chain = [
  { name: 'Root', parent: -1, position: [1, 0, 0.5] },
  { name: 'Spine', parent: 0, position: [1, 2, 0.5] },
  { name: 'Head', parent: 1, position: [1, 3, 0.5] },
  { name: 'Arm', parent: 1, position: [3, 2, 0.5] },
];

// Brute force: every joint's segment distance, sorted by distance then index, the nearest four by inverse distance.
function reference(point, joints) {
  const distance = (p, a, b) => {
    const d = b.map((v, i) => v - a[i]),
      dd = d.reduce((s, v) => s + v * v, 0),
      t = dd ? Math.min(1, Math.max(0, p.reduce((s, v, i) => s + (v - a[i]) * d[i], 0) / dd)) : 0;
    return Math.hypot(...p.map((v, i) => v - a[i] - d[i] * t));
  };
  const nearest = joints
    .map((joint, index) => ({
      index,
      distance: distance(point, joint.parent === -1 ? joint.position : joints[joint.parent].position, joint.position),
    }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, 4);
  const inverse = nearest.map((n) => 1 / Math.max(1e-6, n.distance)),
    total = inverse.reduce((s, v) => s + v, 0);
  return { joints: nearest.map((n) => n.index), weights: inverse.map((v) => Math.fround(v / total)) };
}

test('skinWeights matches the brute-force nearest-bone reference, ties to the lower joint', () => {
  const origin = [1, 0, 0.5],
    positions = [];
  for (let x = -1; x <= 3; x++) for (let y = 0; y <= 3; y++) for (let z = 0; z <= 1; z++) positions.push(x, y, z - 0.5);
  const { joints, weights } = skinWeights(positions, chain, { origin });
  for (let v = 0; v < positions.length / 3; v++) {
    const point = [positions[v * 3] + 1, positions[v * 3 + 1], positions[v * 3 + 2] + 0.5],
      expected = reference(point, chain);
    assert.deepEqual([...joints.subarray(v * 4, v * 4 + 4)], expected.joints, `vertex ${v} joints`);
    assert.deepEqual([...weights.subarray(v * 4, v * 4 + 4)], expected.weights, `vertex ${v} weights`);
  }
  // A vertex on a joint is held by that joint's bones; fewer influences zero the rest.
  const one = skinWeights([0, 3, 0], chain, { origin, influences: 1 });
  assert.deepEqual([...one.joints], [2, 0, 0, 0]);
  assert.deepEqual([...one.weights], [1, 0, 0, 0]);
  const single = skinWeights([5, 5, 5], [{ name: 'Only', parent: -1, position: [0, 0, 0] }]);
  assert.deepEqual([...single.joints, ...single.weights], [0, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(skinWeights(positions, chain, { origin }), skinWeights(positions, chain, { origin }));
});

test('skinBindMatrices: local chains to world, world times inverse bind is identity', () => {
  const origin = [1, 0, 0.5],
    { local, world, inverseBind } = skinBindMatrices(chain, origin),
    t = (m, j) => [...m.subarray(j * 16 + 12, j * 16 + 15)];
  assert.deepEqual(t(local, 0), [0, 0, 0], 'the root sits at the mesh origin');
  assert.deepEqual(t(local, 3), [2, 0, 0]);
  assert.deepEqual(t(world, 3), [2, 2, 0]);
  assert.deepEqual(t(inverseBind, 2), [0, -3, 0]);
  for (let j = 0; j < chain.length; j++) {
    let sum = [0, 0, 0];
    for (let at = j; at !== -1; at = chain[at].parent) sum = sum.map((v, i) => v + local[at * 16 + 12 + i]);
    assert.deepEqual(sum, t(world, j));
    assert.deepEqual(
      t(world, j).map((v, i) => v + t(inverseBind, j)[i] || 0),
      [0, 0, 0],
    );
  }
});

test(
  'a skinned voxel mesh from skinHierarchy and skinWeights validates and keeps its rest pose',
  needsValidator,
  async () => {
    // An L of three unit cubes' corner vertices, pivot (origin) at [1, 0, 0.5] in grid coordinates.
    const origin = [1, 0, 0.5],
      positions = [],
      indices = [];
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ]) {
      const base = positions.length / 3;
      for (let k = 0; k < 8; k++) positions.push(x + (k & 1) - 1, y + ((k >> 1) & 1), ((k >> 2) & 1) - 0.5);
      for (const [a, b, c, d] of [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5],
      ])
        indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
    }
    const { root, nodes, skin } = skinHierarchy(chain, { origin, name: 'Rig' }),
      weights = skinWeights(positions, chain, { origin }),
      mesh = {
        name: 'Figure_Mesh',
        geometry: { positions, normals: positions.map(() => 0), indices, ...weights },
        skin,
      };
    const glb = exportGLB({ nodes: [mesh, root] }),
      report = await validate(glb);
    assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
    const { json, bin } = readGLB(glb),
      gltfSkin = json.skins[0];
    assert.equal(gltfSkin.name, 'Rig');
    assert.deepEqual(
      gltfSkin.joints.map((j) => json.nodes[j].name),
      chain.map((j) => j.name),
    );
    assert.equal(json.nodes[gltfSkin.skeleton].name, 'Root');
    // What the file holds for each vertex, not what went in.
    const { attributes } = json.meshes[json.nodes.find((node) => node.skin !== undefined).mesh].primitives[0],
      held = (name) => Array.from(accessor(json, bin, attributes[name]));
    assert.deepEqual(held('POSITION'), Array.from(positions, Math.fround));
    assert.deepEqual(held('JOINTS_0'), Array.from(weights.joints));
    assert.deepEqual(held('WEIGHTS_0'), Array.from(weights.weights));
    // Rest pose: each joint's node-chain translation plus its inverse bind translation is zero.
    const parents = new Map();
    json.nodes.forEach((node, i) => (node.children ?? []).forEach((c) => parents.set(c, i)));
    const ibm = accessor(json, bin, gltfSkin.inverseBindMatrices);
    gltfSkin.joints.forEach((node, j) => {
      const sum = [0, 0, 0];
      for (let at = node; at !== undefined; at = parents.get(at))
        (json.nodes[at].translation ?? [0, 0, 0]).forEach((v, i) => (sum[i] += v));
      assert.deepEqual(
        sum.map((v, i) => v + ibm[j * 16 + 12 + i] || 0),
        [0, 0, 0],
        `${chain[j].name} rest`,
      );
    });
    assert.equal(nodes.length, 4);
  },
);

test('checkJoints and humanoidJoints', () => {
  assert.throws(() => checkJoints([]), RangeError);
  assert.throws(() => checkJoints([{ name: 'A', parent: -1, position: [0, 0] }]), /three finite/);
  assert.throws(
    () =>
      checkJoints([
        { name: 'A', parent: -1, position: [0, 0, 0] },
        { name: 'A', parent: 0, position: [0, 0, 0] },
      ]),
    /unique/,
  );
  assert.throws(
    () =>
      checkJoints([
        { name: 'A', parent: -1, position: [0, 0, 0] },
        { name: 'B', parent: -1, position: [0, 0, 0] },
      ]),
    /exactly one root/,
  );
  assert.throws(
    () =>
      checkJoints([
        { name: 'A', parent: -1, position: [0, 0, 0] },
        { name: 'B', parent: 2, position: [0, 0, 0] },
        { name: 'C', parent: 1, position: [0, 0, 0] },
      ]),
    /cycle/,
  );
  assert.throws(() => skinWeights([0, 0], chain), /xyz per vertex/);
  assert.throws(() => skinWeights([0, 0, 0], chain, { influences: 5 }), /1, 2, 3 or 4/);
  const humanoid = humanoidJoints([0, 0, 0], [10, 20, 4]);
  checkJoints(humanoid);
  assert.equal(humanoid.length, 18);
  assert.deepEqual(humanoid[5], { name: 'head', parent: 4, position: [5, 19, 2] });
  assert.deepEqual(humanoid[14].position, [5 + 10 * 0.14, 20 * 0.03, 2 + 4 * 0.05]);
  // glTF figures face +z, so their left side is +x: every left joint sits at +x, its right twin mirrored at -x.
  for (const joint of humanoid.filter((j) => j.name.startsWith('left'))) {
    const twin = humanoid.find((j) => j.name === joint.name.replace('left', 'right'));
    assert.ok(joint.position[0] > 5, `${joint.name} is on the figure's left (+x)`);
    assert.ok(Math.abs(twin.position[0] - 5 + (joint.position[0] - 5)) < 1e-12, `${twin.name} mirrors ${joint.name}`);
  }
  assert.throws(() => humanoidJoints([0, 0, 0], [1, -1, 1]), RangeError);
});

test('the skin subpath loads only its own module', async () => {
  const skin = await import('@margoengine/exporters/skin');
  assert.deepEqual(Object.keys(skin).sort(), [
    'checkJoints',
    'humanoidJoints',
    'skinBindMatrices',
    'skinHierarchy',
    'skinWeights',
  ]);
  const entry = await readFile(new URL('../dist/skin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /^import (?!type)/m, 'no runtime imports');
  const root = await import('@margoengine/exporters');
  assert.equal(root.skinWeights, undefined, 'not in the root entry');
});

test('skinWeights gives positive weights summing to 1 for any finite point, however far away', () => {
  for (const point of [
    [1.7e308, 0, 0],
    [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE],
    [-1e300, 1e300, 0],
    [1e-300, 3, 0.5],
  ]) {
    const { joints, weights } = skinWeights(point, chain),
      used = [...weights].filter((w) => w > 0);
    assert.ok(used.length >= 1, `${point}: some weight`);
    assert.ok([...weights].every(Number.isFinite), `${point}: finite`);
    assert.ok(Math.abs(used.reduce((s, w) => s + w, 0) - 1) < 1e-6, `${point}: sums to 1`);
    assert.ok([...joints].every((j) => j < chain.length));
  }
  // Joints are Float32-bounded, so from 1.7e308 they are all equidistant in double precision: ties go to index order.
  assert.deepEqual([...skinWeights([1.7e308, 2, 0.5], chain).joints], [0, 1, 2, 3]);
  // A nonfinite point is refused, not given zero weights.
  assert.throws(() => skinWeights([Number.POSITIVE_INFINITY, 0, 0], chain), /not finite/);
});
