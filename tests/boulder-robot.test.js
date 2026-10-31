// The Boulder climber (examples/assets/boulder-robot.glb): the Light Keeper robot with a hip and two legs. Checks the
// shipped file: Khronos validation, the joint hierarchy and rest positions, hinge axes, clean skin weights at the hips,
// link hull sizes for rigging's jointHulls, the size budget, and that gltf-pro loads it. The build script's
// optimize-and-validate step is run on a small stand-in GLB so the test needs no Blender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convexGeometry } from '@margoengine/geometry/extras';
import { GLTFAsset, parseGLTFAsync } from '@margoengine/gltf-pro';
import { buildBoulderAssets } from '../scripts/build-boulder-assets.mjs';
import { CHARACTER } from '../examples/boulder/rig.ts';
import { headless, headlessModels } from './support/pbr-snapshot.js';

const require = createRequire(import.meta.url),
  validator = require('gltf-validator'),
  assets = new URL('../examples/assets/', import.meta.url),
  path = new URL('boulder-robot.glb', assets),
  bytes = readFileSync(path),
  jsonLength = bytes.readUInt32LE(12),
  doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)),
  asset = new GLTFAsset(doc, [bytes.subarray(20 + jsonLength + 8)]);
await asset.decode();

const skin = doc.skins[0],
  joints = skin.joints,
  names = joints.map((j) => doc.nodes[j].name),
  index = (name) => {
    const i = names.indexOf(name);
    assert.ok(i >= 0, `joint ${name} exists`);
    return i;
  },
  ibm = asset.accessor(skin.inverseBindMatrices),
  // World position and local X axis of a joint from its inverse bind matrix (a rigid transform, column-major).
  world = (name) => {
    const m = ibm.subarray(index(name) * 16, index(name) * 16 + 16),
      t = [m[12], m[13], m[14]],
      r = [
        [m[0], m[4], m[8]],
        [m[1], m[5], m[9]],
        [m[2], m[6], m[10]],
      ];
    // position = -R^T t, where R's columns are m[0..2], m[4..6], m[8..10]
    const position = [0, 1, 2].map((i) => -(m[i * 4] * t[0] + m[i * 4 + 1] * t[1] + m[i * 4 + 2] * t[2]));
    return { position, xAxis: [m[0], m[4], m[8]], r };
  },
  parentOf = (name) => {
    const node = joints[index(name)],
      parent = doc.nodes.findIndex((n) => (n.children ?? []).includes(node));
    return parent < 0 ? null : doc.nodes[parent].name;
  };

const dotAxes = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const primitives = doc.meshes.flatMap((m) => m.primitives);
const vertexData = primitives.map((p) => ({
  positions: asset.accessor(p.attributes.POSITION),
  joints: asset.accessor(p.attributes.JOINTS_0),
  weights: asset.accessor(p.attributes.WEIGHTS_0),
}));
const vertexCount = vertexData.reduce((n, v) => n + v.positions.length / 3, 0);

test('Boulder GLB passes Khronos validation with no errors or warnings and carries the copyright', async () => {
  const report = await validator.validateBytes(new Uint8Array(bytes), { uri: 'boulder-robot.glb', maxIssues: 1000 });
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages.slice(0, 3)));
  assert.equal(report.issues.numWarnings, 0, JSON.stringify(report.issues.messages.slice(0, 3)));
  assert.match(doc.asset.copyright, /Scott Campbell.*Apache License 2\.0/);
});

test('Boulder is one small file: no textures, six material draws, under the 1.5 MB budget', () => {
  assert.ok(statSync(path).size < 1_500_000, `${statSync(path).size} bytes`);
  assert.equal(doc.images, undefined);
  assert.equal(doc.textures, undefined);
  assert.equal(doc.meshes.length, 6);
  assert.equal(doc.skins.length, 1);
  assert.ok(vertexCount > 20_000 && vertexCount < 50_000, `${vertexCount} vertices`);
});

test('the rig has a hip, two legs of four joints and two foot targets under one skeleton', () => {
  assert.equal(joints.length, 20);
  assert.equal(parentOf('Hips'), 'Root');
  assert.equal(parentOf('Body'), 'Hips');
  assert.equal(parentOf('Head'), 'Body');
  for (const side of ['Left', 'Right']) {
    assert.equal(parentOf(`${side}UpperLeg`), 'Hips');
    assert.equal(parentOf(`${side}LowerLeg`), `${side}UpperLeg`);
    assert.equal(parentOf(`${side}Foot`), `${side}LowerLeg`);
    assert.equal(parentOf(`${side}Toe`), `${side}Foot`);
    assert.equal(parentOf(`${side}FootTarget`), 'Root');
  }
  for (const arm of ['UpperArm', 'RightUpperArm']) assert.equal(parentOf(arm), 'Body');
});

test('leg proportions match the robot: hip .66, knee .37, ankle .145 above the sole, both legs 0.13 m off centre', () => {
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 2e-3, `${label}: ${a} vs ${b}`);
  for (const [side, sign] of [
    ['Left', -1],
    ['Right', 1],
  ]) {
    const hip = world(`${side}UpperLeg`).position,
      knee = world(`${side}LowerLeg`).position,
      ankle = world(`${side}Foot`).position,
      ball = world(`${side}Toe`).position,
      target = world(`${side}FootTarget`).position;
    near(hip[0], sign * 0.13, `${side} hip x`);
    near(hip[1], 0.66, `${side} hip y`);
    near(knee[1], 0.37, `${side} knee y`);
    near(ankle[1], 0.145, `${side} ankle y`);
    near(ball[1], 0.05, `${side} ball y`);
    // The knee sits slightly in front of the hip to ankle line so a two-bone solver has a bend direction.
    assert.ok(knee[2] < (hip[2] + ankle[2]) / 2 - 0.01, `${side} knee forward of the leg line`);
    for (let i = 0; i < 3; i++) near(target[i], ankle[i], `${side} foot target at the ankle, axis ${i}`);
  }
});

test('knee, ankle and toe bend about the world X axis', () => {
  for (const side of ['Left', 'Right'])
    for (const joint of ['UpperLeg', 'LowerLeg', 'Foot', 'Toe']) {
      const { xAxis } = world(`${side}${joint}`);
      assert.ok(xAxis[0] > 0.999, `${side}${joint} local X axis is world X (${xAxis.map((v) => v.toFixed(3))})`);
    }
});

// Which way the parts face at rest. The climber's code aims each bone by these axes, so a model that disagrees with them
// comes out with a knee bent backward or a palm to the room, and passes every clearance check while it does.
const boneAxis = (name, axis) => world(name).r[axis],
  // The vertices a joint owns, in that joint's own space, optionally of one material.
  ownedInBoneSpace = (name, material) => {
    const out = [],
      j = index(name),
      m = ibm.subarray(j * 16, j * 16 + 16);
    for (const [p, primitive] of primitives.entries()) {
      if (material && doc.materials[primitive.material].name !== material) continue;
      const { positions, joints: jn, weights } = vertexData[p];
      for (let i = 0; i < positions.length / 3; i++) {
        let owned = false;
        for (let k = 0; k < 4; k++) if (jn[i * 4 + k] === j && weights[i * 4 + k] >= 0.5) owned = true;
        if (!owned) continue;
        const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
        out.push([0, 1, 2].map((a) => m[a] * x + m[a + 4] * y + m[a + 8] * z + m[a + 12]));
      }
    }
    return out;
  },
  mean = (points, axis) => points.reduce((sum, p) => sum + p[axis], 0) / points.length;

test('at rest the pelvis and chest face the same way, with the character forward at -Z and its right at +X', () => {
  for (const name of ['Hips', 'Body']) {
    const x = boneAxis(name, 0);
    assert.ok(x[0] > 0.99, `${name} bone X is the character's right: ${x}`);
  }
  assert.ok(dotAxes(boneAxis('Hips', 2), boneAxis('Body', 2)) > 0.99, 'pelvis and chest share a forward');
});

test('at rest each knee bends forward, each foot points forward, and the toe tip is where the rig says', () => {
  for (const side of ['Left', 'Right']) {
    const hip = world(`${side}UpperLeg`).position,
      knee = world(`${side}LowerLeg`).position,
      ankle = world(`${side}Foot`).position,
      ball = world(`${side}Toe`).position;
    assert.ok(knee[2] < (hip[2] + ankle[2]) / 2 - 0.01, `${side} knee is forward of the leg line`);
    assert.ok(ball[2] < ankle[2] - 0.05, `${side} toe joint is forward of the ankle: ${ball[2]} against ${ankle[2]}`);
    // Toe space is translation from the toe joint: the rig's tip is measured from the ankle.
    const toe = ownedInBoneSpace(`${side}Toe`).map((p) => [
        0,
        p[0] * boneAxis(`${side}Toe`, 0)[1] + p[1] * boneAxis(`${side}Toe`, 1)[1] + p[2] * boneAxis(`${side}Toe`, 2)[1],
        p[0] * boneAxis(`${side}Toe`, 0)[2] + p[1] * boneAxis(`${side}Toe`, 1)[2] + p[2] * boneAxis(`${side}Toe`, 2)[2],
      ]),
      tip = Math.min(...toe.map((p) => p[2])) + ball[2] - ankle[2];
    assert.ok(Math.abs(tip - CHARACTER.toeTip[2]) < 0.02, `${side} toe tip ${tip} against ${CHARACTER.toeTip[2]}`);
  }
});

test('both hands are built the same way and mirrored: fingers, palm and thumb lie on the axes the rig aims by', () => {
  const { fingers, palm, thumb } = CHARACTER.hand,
    along = (p, axis) => dotAxes(p, axis);
  for (const [i, name] of ['Hand', 'RightHand'].entries()) {
    // The same rest axes on both, so one aim works for both.
    assert.ok(boneAxis(name, 0)[0] > 0.99, `${name} bone X is world X`);
    assert.ok(boneAxis(name, 1)[2] < -0.99, `${name} bone Y points forward at rest`);
    assert.ok(boneAxis(name, 2)[1] > 0.99, `${name} bone Z points up at rest`);
    const all = ownedInBoneSpace(name),
      cream = ownedInBoneSpace(name, 'Boulder / porcelain enamel'),
      copper = ownedInBoneSpace(name, 'Boulder / copper joints');
    assert.ok(all.length > 100 && cream.length > 20 && copper.length > 20, `${name} has a hand to measure`);
    const out = all.map((p) => along(p, fingers));
    assert.ok(Math.max(...out) > 2 * -Math.min(...out), `${name}: the fingers lie along +Y of the bone`);
    // Fingers curl toward the palm, and the porcelain back plate is the far side from it.
    const ends = all.filter((p) => along(p, fingers) > 0.09),
      curl = mean(ends, 2) * palm[2],
      back = Math.min(...cream.map((p) => along(p, palm)));
    assert.ok(curl > 0.02, `${name}: the finger ends at ${curl} curl to the palm side`);
    assert.ok(back < -0.01, `${name}: the back plate at ${back} is opposite the palm`);
    // The copper knuckles are the thumb's.
    assert.ok(mean(copper, 0) * thumb[i][0] > 0.02, `${name}: the thumb at ${mean(copper, 0)} is on its own side`);
  }
});

test('skin weights are normalized, use at most four joints, and stay clean at the hips', () => {
  const hipBand = [];
  const legOf = (j) => (names[j].startsWith('Left') ? 'L' : names[j].startsWith('Right') ? 'R' : '');
  for (const { positions, joints: jn, weights } of vertexData)
    for (let i = 0; i < positions.length / 3; i++) {
      let sum = 0;
      const used = [];
      for (let k = 0; k < 4; k++) {
        const w = weights[i * 4 + k];
        assert.ok(w >= 0 && w <= 1.0001);
        sum += w;
        if (w > 1e-4) used.push(jn[i * 4 + k]);
      }
      assert.ok(Math.abs(sum - 1) < 2e-3, `weights sum to ${sum}`);
      // No vertex is shared between the two legs, and no vertex mixes a leg with a part of the other side.
      assert.ok(new Set(used.map(legOf).filter(Boolean)).size <= 1, 'one leg per vertex');
      const y = positions[i * 3 + 1];
      if (y > 0.6 && y < 0.7 && Math.abs(positions[i * 3]) < 0.2) hipBand.push(used.map((j) => names[j]));
    }
  assert.ok(hipBand.length > 1000);
  // Around the hips only the hips, the torso and the thigh on that side carry a vertex.
  const allowed = new Set(['Hips', 'Body', 'LeftUpperLeg', 'RightUpperLeg']);
  for (const used of hipBand)
    for (const name of used) assert.ok(allowed.has(name), `hip band vertex weighted to ${name}`);
});

test('every link has a hull that jointHulls can take: corners per joint, all reducible to 64 points', () => {
  const perJoint = names.map(() => []);
  for (const { positions, joints: jn, weights } of vertexData)
    for (let i = 0; i < positions.length / 3; i++)
      for (let k = 0; k < 4; k++)
        if (weights[i * 4 + k] >= 0.5)
          perJoint[jn[i * 4 + k]].push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  for (const name of [
    'Hips',
    'Body',
    'Head',
    ...['Left', 'Right'].flatMap((side) => ['UpperLeg', 'LowerLeg', 'Foot', 'Toe'].map((part) => side + part)),
  ]) {
    const points = perJoint[index(name)];
    assert.ok(points.length / 3 >= 100, `${name} has vertices to build a hull from (${points.length / 3})`);
    const hull = convexGeometry(points),
      corners = new Set();
    for (let i = 0; i < hull.positions.length; i += 3)
      corners.add(
        `${hull.positions[i].toFixed(5)},${hull.positions[i + 1].toFixed(5)},${hull.positions[i + 2].toFixed(5)}`,
      );
    assert.ok(corners.size >= 4);
  }
  // Foot targets carry no mesh: jointHulls leaves joints with fewer than four vertices out.
  for (const name of ['LeftFootTarget', 'RightFootTarget', 'Root']) assert.equal(perJoint[index(name)].length, 0);
});

test('gltf-pro loads Boulder with its skin, the idle clip and meshopt-compressed geometry', async () => {
  assert.ok(doc.extensionsUsed.includes('EXT_meshopt_compression'));
  assert.equal(doc.animations.length, 1);
  assert.equal(doc.animations[0].name, 'Boulder idle');
  const model = await headlessModels(async () => parseGLTFAsync(await headless(), new Uint8Array(bytes).slice()));
  assert.ok(model.primitives.reduce((n, p) => n + p.indices.length / 3, 0) > 40_000);
});

test('the Boulder build script optimizes a GLB and validates the result', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boulder-assets-')),
    output = join(dir, 'out.glb');
  try {
    const result = await buildBoulderAssets({
      input: fileURLToPath(new URL('skinning-ik-orb.glb', assets)),
      output,
    });
    assert.equal(result.errors, 0);
    assert.equal(result.warnings, 0);
    assert.ok(result.bytes > 0 && result.bytes < result.rawBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Plates must sit on their shells. The first Boulder preview had teal plates whose triangles cut through the porcelain
// shell under them (chest and shin), which showed as torn, jagged edges. Count every pair of triangles that cross.
function triangles(materialName, jointName, front) {
  const out = [];
  for (const [p, primitive] of primitives.entries()) {
    if (doc.materials[primitive.material].name !== materialName) continue;
    const { positions, joints: jn, weights } = vertexData[p],
      indices = asset.accessor(primitive.indices),
      owner = (v) => {
        let best = 0;
        for (let k = 1; k < 4; k++) if (weights[v * 4 + k] > weights[v * 4 + best]) best = k;
        return names[jn[v * 4 + best]];
      };
    for (let t = 0; t < indices.length; t += 3) {
      const ids = [indices[t], indices[t + 1], indices[t + 2]];
      if (!ids.every((v) => owner(v) === jointName)) continue;
      const tri = ids.map((v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
      if (front && tri[0][2] + tri[1][2] + tri[2][2] > 3 * front.maxZ) continue;
      if (front && !tri.some((v) => Math.abs(v[0]) < front.maxAbsX && v[1] > front.minY && v[1] < front.maxY)) continue;
      out.push(tri);
    }
  }
  return out;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Moller-Trumbore for a segment: true when it pierces the triangle strictly inside both. */
function segmentPierces(p, q, [a, b, c]) {
  const d = sub(q, p),
    e1 = sub(b, a),
    e2 = sub(c, a),
    h = cross(d, e2),
    det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const s = sub(p, a),
    u = dot(s, h) / det,
    qv = cross(s, e1),
    v = dot(d, qv) / det,
    t = dot(e2, qv) / det,
    eps = 1e-4;
  return u > eps && v > eps && u + v < 1 - eps && t > eps && t < 1 - eps;
}
const box = (t) => [0, 1, 2].flatMap((k) => [Math.min(t[0][k], t[1][k], t[2][k]), Math.max(t[0][k], t[1][k], t[2][k])]),
  apart = (p, q) => [0, 2, 4].some((k) => p[k] > q[k + 1] || q[k] > p[k + 1]);
function crossings(plates, shell) {
  let count = 0;
  const shellBoxes = shell.map(box);
  for (const A of plates) {
    const boxA = box(A);
    for (const [index, B] of shell.entries())
      if (apart(boxA, shellBoxes[index])) continue;
      else if (
        [
          [A[0], A[1]],
          [A[1], A[2]],
          [A[2], A[0]],
        ].some(([p, q]) => segmentPierces(p, q, B)) ||
        [
          [B[0], B[1]],
          [B[1], B[2]],
          [B[2], B[0]],
        ].some(([p, q]) => segmentPierces(p, q, A))
      )
        count++;
  }
  return count;
}

test('the teal chest plate and shin plates lie on their porcelain shells without cutting through them', () => {
  const teal = 'Boulder / oxidized teal',
    cream = 'Boulder / porcelain enamel',
    chestFront = { maxZ: -0.05, maxAbsX: 0.25, minY: 0.74, maxY: 1.1 },
    chestPlate = triangles(teal, 'Body', chestFront),
    torso = triangles(cream, 'Body', chestFront);
  assert.ok(chestPlate.length > 100, `chest plate triangles: ${chestPlate.length}`);
  assert.ok(torso.length > 100, `torso triangles: ${torso.length}`);
  assert.equal(crossings(chestPlate, torso), 0, 'chest plate crosses the torso shell');
  for (const side of ['Left', 'Right']) {
    const plate = triangles(teal, `${side}LowerLeg`),
      calf = triangles(cream, `${side}LowerLeg`);
    assert.ok(plate.length > 40 && calf.length > 100, `${side} shin triangles: ${plate.length}, ${calf.length}`);
    assert.equal(crossings(plate, calf), 0, `${side} shin plate crosses the calf shell`);
  }
});

test('the shoulder caps and the arm shells do not cross each other, on either arm', () => {
  const cream = 'Boulder / porcelain enamel',
    upper = { Left: triangles(cream, 'UpperArm'), Right: triangles(cream, 'RightUpperArm') },
    fore = { Left: triangles(cream, 'Forearm'), Right: triangles(cream, 'RightForearm') };
  for (const side of ['Left', 'Right']) {
    // The upper arm's cream triangles are the cap and the shell: they must not pass through each other.
    assert.ok(upper[side].length > 2000 && fore[side].length > 100, `${side} arm triangles`);
    assert.equal(crossings(upper[side], upper[side]), 0, `${side} shoulder cap crosses the upper arm shell`);
    assert.equal(crossings(upper[side], fore[side]), 0, `${side} upper arm shell crosses the forearm shell`);
  }
});
