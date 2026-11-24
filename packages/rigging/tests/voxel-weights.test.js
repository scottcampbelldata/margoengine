// Geodesic voxel weights: closed, open, doubled and flipped tubes, parts apart, and real rigged models with their
// authored weights as the yardstick, whole and broken.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boneHeatWeights } from '../dist/index.js';
import { voxelWeights } from '../dist/voxel-weights.js';
import { chain, merge, split, tube } from './fixtures.js';
import { compare, realSkin } from './real-skin.js';

const row = (weights, v) => Array.from(weights.values.subarray(v * weights.boneCount, (v + 1) * weights.boneCount));
const sums = (weights) => {
  for (let v = 0; v < weights.vertexCount; v++) {
    const sum = row(weights, v).reduce((a, b) => a + b);
    assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${v} sums to ${sum}`);
  }
};
/** The vertex of `mesh` nearest height `y` on its side wall. */
const atHeight = (mesh, y) => {
  let best = 0,
    gap = Infinity;
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const d = Math.abs(mesh.positions[v * 3 + 1] - y) + (Math.hypot(mesh.positions[v * 3], mesh.positions[v * 3 + 2]) < 0.1 ? 9 : 0);
    if (d < gap) {
      gap = d;
      best = v;
    }
  }
  return best;
};
/** The same mesh with the triangles `keep` passes, by index. */
const only = (mesh, keep) => {
  const indices = [];
  for (let t = 0; t < mesh.indices.length / 3; t++)
    if (keep(t, mesh)) indices.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  return { positions: mesh.positions, indices: Uint32Array.from(indices) };
};

test('a closed tube: each end binds to its bone and the weights blend across the joint', async () => {
  const mesh = tube(),
    { weights, grid, voxels, unreached } = await voxelWeights(mesh, chain, { resolution: 48 });
  sums(weights);
  assert.equal(unreached, 0);
  assert.ok(voxels > 100 && grid.every((n) => n >= 8));
  assert.ok(row(weights, atHeight(mesh, 0.2))[0] > 0.95, 'near the base');
  const top = row(weights, atHeight(mesh, 1.75));
  assert.ok(top[1] > 0.9, `the upper bone holds the top: ${top}`);
  const middle = row(weights, atHeight(mesh, 1));
  assert.ok(middle[0] > 0.2 && middle[1] > 0.2, `the joint blends: ${middle}`);
});

test('holes, an open end, doubled and flipped faces and split vertices give the same weights', async () => {
  const mesh = tube(),
    { weights: whole } = await voxelWeights(mesh, chain, { resolution: 48 }),
    faces = mesh.indices.length / 3,
    // No caps, and every seventh quad gone.
    open = only(mesh, (t) => t < faces - 24 && (t >> 1) % 7 !== 3),
    doubled = { positions: mesh.positions, indices: Uint32Array.from([...mesh.indices, ...mesh.indices]) },
    flipped = {
      positions: mesh.positions,
      indices: Uint32Array.from(Array.from(mesh.indices, (_, i) => mesh.indices[i % 6 < 3 ? i : i - (i % 3) + 2 - (i % 3)])),
    };
  for (const [name, broken] of Object.entries({ open, doubled, flipped })) {
    const { weights, unreached } = await voxelWeights(broken, chain, { resolution: 48 });
    sums(weights);
    assert.equal(unreached, 0, name);
    // Half the row's gap, averaged: the open tube's rim at the bone's end has no cap to carry a second bone.
    let gap = 0;
    for (let i = 0; i < whole.values.length; i++) gap += Math.abs(whole.values[i] - weights.values[i]) / 2;
    gap /= whole.vertexCount;
    assert.ok(gap < (name === 'open' ? 0.03 : 1e-6), `${name} differs by ${gap}`);
  }
  const { weights } = await voxelWeights(split(mesh), chain, { resolution: 48 });
  sums(weights);
  assert.equal(weights.vertexCount, mesh.indices.length);
});

test('a hole does not flood a bone out: an open tube with the bone inside still fills', async () => {
  const mesh = tube({ rings: 8, sides: 12 }),
    faces = mesh.indices.length / 3,
    open = only(mesh, (t) => t < faces - 24),
    { voxels: solid } = await voxelWeights(mesh, chain, { resolution: 32 }),
    { voxels, unreached } = await voxelWeights(open, chain, { resolution: 32 });
  assert.equal(unreached, 0);
  assert.ok(voxels > solid * 0.9, `${voxels} voxels of ${solid}`);
});

test('two limbs side by side stay apart, and a closing fuses them when asked', async () => {
  const legs = (gap) => {
    const a = tube({ cx: -0.2 - gap / 2 }),
      b = tube({ cx: 0.2 + gap / 2 });
    return {
      a,
      mesh: merge(a, b),
      joints: [
        { name: 'hips', parent: -1, position: [0, 2.3, 0] },
        { name: 'left', parent: 0, position: [-0.2 - gap / 2, 2, 0] },
        { name: 'leftEnd', parent: 1, position: [-0.2 - gap / 2, 0, 0] },
        { name: 'right', parent: 0, position: [0.2 + gap / 2, 2, 0] },
        { name: 'rightEnd', parent: 3, position: [0.2 + gap / 2, 0, 0] },
      ],
    };
  };
  const { a: left, mesh, joints } = legs(0.4),
    { weights } = await voxelWeights(mesh, joints, { resolution: 64, skip: ['hips'] });
  sums(weights);
  const count = left.positions.length / 3;
  for (let v = 0; v < count; v++) {
    const r = row(weights, v);
    assert.ok(r[3] + r[4] < 1e-3, `a left vertex took the right leg: ${r}`);
  }
  await assert.rejects(voxelWeights(mesh, joints, { closing: 9 }), RangeError);
  // A slit of two voxels: a closing of two fills it, and the inner side of each leg takes both bones.
  const slit = legs(0.09),
    across = async (closing) => {
      const { weights: w } = await voxelWeights(slit.mesh, slit.joints, { resolution: 64, skip: ['hips'], closing });
      let most = 0;
      for (let v = 0; v < slit.a.positions.length / 3; v++) most = Math.max(most, row(w, v)[3] + row(w, v)[4]);
      return most;
    };
  assert.ok((await across(0)) < 1e-3, 'apart with no closing');
  assert.ok((await across(2)) > 0.01, 'fused by the closing');
});

test('a loose part no bone touches is counted and takes the straight-line falloff', async () => {
  const body = tube(),
    hat = tube({ cx: 0, y0: 2.3, y1: 2.5, radius: 0.1, rings: 2, sides: 6 }),
    mesh = merge(body, hat),
    { weights, unreached } = await voxelWeights(mesh, chain, { resolution: 48 });
  sums(weights);
  assert.equal(unreached, hat.positions.length / 3);
  const v = body.positions.length / 3;
  assert.ok(row(weights, v)[1] + row(weights, v)[2] > 0.99, `the hat follows the top: ${row(weights, v)}`);
});

test('skip, influences and duplicates at one position', async () => {
  const mesh = tube(),
    { weights } = await voxelWeights(mesh, chain, { resolution: 32, skip: ['tip'], influences: 1 });
  for (let v = 0; v < weights.vertexCount; v++) {
    const r = row(weights, v);
    assert.equal(r[2], 0, 'a skipped joint moves nothing');
    assert.equal(r.filter((w) => w > 0).length, 1);
  }
  const { weights: apart } = await voxelWeights(split(mesh), chain, { resolution: 32 });
  const seen = new Map();
  const positions = split(mesh).positions;
  for (let v = 0; v < apart.vertexCount; v++) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    if (seen.has(key)) assert.deepEqual(row(apart, v), seen.get(key));
    else seen.set(key, row(apart, v));
  }
});

test('bad options are refused and a signal cancels', async () => {
  const mesh = tube({ rings: 2 });
  await assert.rejects(voxelWeights(mesh, chain, { resolution: 4 }), RangeError);
  await assert.rejects(voxelWeights(mesh, chain, { resolution: 8.5 }), RangeError);
  await assert.rejects(voxelWeights(mesh, chain, { falloff: 0 }), RangeError);
  await assert.rejects(voxelWeights(mesh, chain, { curve: 2 }), RangeError);
  await assert.rejects(voxelWeights(mesh, chain, { influences: 0 }), RangeError);
  await assert.rejects(voxelWeights(mesh, chain, { skip: [0, 1, 2] }), RangeError);
  await assert.rejects(voxelWeights(mesh, [], {}), RangeError);
  await assert.rejects(voxelWeights(mesh, chain, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
});

const asset = (path) => new URL(`../../../examples/assets/${path}`, import.meta.url);
const MODELS = {
  RiggedFigure: [asset('khronos/RiggedFigure/RiggedFigure.glb'), 96],
  Fox: [asset('khronos/Fox/Fox.glb'), 96],
  'Seed-san': [asset('vrm/Seed-san.vrm'), 64],
};

// The yardstick: the strongest bone of a vertex, against the author's or the bone next to it. Weights differ by taste
// (bone heat agrees no better), a limb on the wrong bone does not.
for (const [name, [url, resolution]] of Object.entries(MODELS))
  test(`${name}: a real model against its authored weights, whole and with a fifth of its faces gone`, async () => {
    const { joints, mesh, authored } = realSkin(url),
      { weights, unreached } = await voxelWeights(mesh, joints, { resolution });
    sums(weights);
    assert.equal(unreached, 0);
    const whole = compare(authored, weights, joints);
    assert.ok(whole.near > 0.95, `${name} whole: ${JSON.stringify(whole)}`);
    const { weights: holed } = await voxelWeights(
        only(mesh, (t) => t % 5 !== 2),
        joints,
        { resolution },
      ),
      broken = compare(authored, holed, joints);
    sums(holed);
    assert.ok(broken.near > 0.95, `${name} holed: ${JSON.stringify(broken)}`);
    assert.ok(Math.abs(broken.gap - whole.gap) < 0.03, `the holes barely show: ${whole.gap} and ${broken.gap}`);
  });

/** `mesh` and a second shell over it, 1% of its size out along the normals: a coat modelled over a body, in one mesh. */
function coated(mesh) {
  const n = mesh.positions.length / 3,
    p = mesh.positions,
    normals = new Float64Array(n * 3),
    positions = new Float32Array(n * 6),
    size = Math.max(...p.map(Math.abs));
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]],
      u = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]),
      v = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]),
      normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) normals[i * 3 + k] += normal[k];
  }
  positions.set(p);
  for (let i = 0; i < n; i++) {
    const length = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) positions[(n + i) * 3 + k] = p[i * 3 + k] + (normals[i * 3 + k] / length) * size * 0.01;
  }
  return {
    positions,
    indices: Uint32Array.from([...mesh.indices, ...Array.from(mesh.indices, (i) => i + n)]),
  };
}

test('where bone heat fails: the Fox with a coat over it in one mesh', async () => {
  // The body blocks the coat's view of the bones, so bone heat has no heat source there.
  const { joints, mesh, authored } = realSkin(MODELS.Fox[0]),
    coat = coated(mesh),
    bones = joints.length,
    outer = (weights) => ({ boneCount: bones, values: weights.values.subarray(authored.length * bones) }),
    { weights } = await voxelWeights(coat, joints, { resolution: 64 }),
    voxel = compare(authored, outer(weights), joints),
    heat = compare(authored, outer(await boneHeatWeights(coat, joints)), joints);
  assert.ok(voxel.near > 0.95, `voxel weights: ${JSON.stringify(voxel)}`);
  assert.ok(heat.near < 0.6, `bone heat: ${JSON.stringify(heat)}`);
});
