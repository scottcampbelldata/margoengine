// @margoengine/rigging/autorig on real files. MakeHuman's base mesh is a real mesh nobody rigged, and its own joint helper
// groups say where its authors put the joints. Seed-san, the Twist sample and Knight are real characters read as bare
// meshes: the fit sees triangles only, and their authored skeletons mark it. Bounds are shares of the figure's height,
// each a little over what was measured; one voxel is 0.008 at the default resolution. A joint has no single true place:
// rigs by different hands differ by more than that, MakeHuman's head and Seed-san's among them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoRig } from '../dist/autorig.js';
import { checkRig, checkSkin } from '../dist/index.js';
import { detectSkeleton, humanoidBones } from '../dist/retarget.js';
import { realFigure } from './real-skin.js';

const asset = (path) => new URL(`../../../examples/assets/${path}`, import.meta.url);

/** The `body` group of the base mesh, and the middle of each `joint-` helper group. */
function makeHuman() {
  const all = [],
    groups = new Map();
  let group = '';
  for (const row of readFileSync(asset('autorig/makehuman-base.obj'), 'utf8').split('\n')) {
    if (row.startsWith('v ')) all.push(row.trim().split(/\s+/).slice(1).map(Number));
    else if (row.startsWith('g ')) group = row.slice(2).trim();
    else if (row.startsWith('f ')) {
      const face = row.trim().split(/\s+/).slice(1).map((v) => parseInt(v, 10) - 1);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(face);
    }
  }
  const keep = new Map(),
    positions = [],
    indices = [];
  const at = (v) => {
    if (!keep.has(v)) {
      keep.set(v, positions.length / 3);
      positions.push(...all[v]);
    }
    return keep.get(v);
  };
  for (const face of groups.get('body'))
    for (let k = 1; k + 1 < face.length; k++) indices.push(at(face[0]), at(face[k]), at(face[k + 1]));
  const helper = (name) => {
    const list = groups.get(`joint-${name}`).flat();
    return [0, 1, 2].map((c) => list.reduce((sum, v) => sum + all[v][c], 0) / list.length);
  };
  const truth = { hips: helper('pelvis'), neck: helper('neck'), head: helper('head') };
  for (const [side, s] of [
    ['left', 'l'],
    ['right', 'r'],
  ])
    Object.assign(truth, {
      [`${side}UpperArm`]: helper(`${s}-shoulder`),
      [`${side}LowerArm`]: helper(`${s}-elbow`),
      [`${side}Hand`]: helper(`${s}-hand`),
      [`${side}UpperLeg`]: helper(`${s}-upper-leg`),
      [`${side}LowerLeg`]: helper(`${s}-knee`),
      [`${side}Foot`]: helper(`${s}-ankle`),
    });
  return { mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, truth };
}

const heightOf = (positions) => {
  let low = Infinity,
    high = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    low = Math.min(low, positions[i]);
    high = Math.max(high, positions[i]);
  }
  return high - low;
};
/** Each marked joint's error as a share of the height, with the mean and the worst. */
function errors(rig, truth, height) {
  const each = Object.entries(truth).map(([name, at]) => {
    const p = rig.joints[rig.humanoid[name]].position;
    return [name, Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) / height];
  });
  return {
    each,
    mean: each.reduce((sum, row) => sum + row[1], 0) / each.length,
    worst: each.reduce((best, row) => (row[1] > best[1] ? row : best)),
  };
}
const turned = (mesh, f) => {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3)
    positions.set(f([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]), i);
  return { positions, indices: mesh.indices };
};

test('a real mesh nobody rigged gets the joints its authors marked', async () => {
  const { mesh, truth } = makeHuman(),
    rig = await autoRig(mesh, { weights: 'none' }),
    { mean, worst } = errors(rig, truth, heightOf(mesh.positions));
  assert.ok(mean < 0.025, `mean error ${mean}`);
  assert.ok(worst[1] < 0.06, `worst is ${worst}`);
  assert.equal(checkRig(rig.joints).length, rig.joints.length);
  assert.ok(rig.facingFound, 'the feet say which way it faces');
  assert.ok(rig.forward[2] > 0.99, `it faces +z (${rig.forward})`);
  const left = rig.joints[rig.humanoid.leftHand].position,
    right = rig.joints[rig.humanoid.rightHand].position;
  assert.ok(left[0] > 0 && right[0] < 0, 'the left hand is on the figure\'s left: +x when it faces +z');
});

const KNIGHT = {
  hips: 'hips',
  spine: 'spine',
  chest: 'chest',
  head: 'head',
  leftUpperArm: 'upperarm.l',
  leftLowerArm: 'lowerarm.l',
  leftHand: 'wrist.l',
  rightUpperArm: 'upperarm.r',
  rightLowerArm: 'lowerarm.r',
  rightHand: 'wrist.r',
  leftUpperLeg: 'upperleg.l',
  leftLowerLeg: 'lowerleg.l',
  leftFoot: 'foot.l',
  rightUpperLeg: 'upperleg.r',
  rightLowerLeg: 'lowerleg.r',
  rightFoot: 'foot.r',
};
for (const [name, path, names, skip, mean, worst] of [
  // Her coat fills the gap between the legs down to its hem, and a third robot arm reaches past her hands.
  ['Seed-san', 'vrm/Seed-san.vrm', null, undefined, 0.035, 0.09],
  ['the Twist sample', 'vrm/VRM1_Constraint_Twist_Sample.vrm', null, undefined, 0.045, 0.12],
  // Big head, short limbs: about two and a half heads tall, far from the proportions the joints are placed by. Its
  // props are unskinned nodes, left out.
  ['Knight', 'kaykit/adventurers/characters/Knight.glb', KNIGHT, (node) => node.skin === undefined, 0.045, 0.09],
])
  test(`${name}, read as a bare mesh, lands near its authored skeleton`, async () => {
    const figure = realFigure(asset(path), skip),
      rig = await autoRig(figure.mesh, { weights: 'none' }),
      truth = Object.fromEntries(
        Object.entries(names ?? figure.human)
          .filter(([bone]) => bone in rig.humanoid)
          .map(([bone, node]) => [bone, figure.bones[node]]),
      ),
      got = errors(rig, truth, heightOf(figure.mesh.positions));
    assert.ok(got.each.length >= 15, `${got.each.length} joints compared`);
    assert.ok(got.mean < mean, `mean error ${got.mean}`);
    assert.ok(got.worst[1] < worst, `worst is ${got.worst}`);
  });

test('a figure turned about up, or lying with another up, gets the same skeleton', async () => {
  const { mesh } = makeHuman(),
    plain = await autoRig(mesh, { weights: 'none' }),
    height = heightOf(mesh.positions),
    angle = 0.7,
    c = Math.cos(angle),
    s = Math.sin(angle),
    yawed = await autoRig(
      turned(mesh, ([x, y, z]) => [c * x + s * z, y, -s * x + c * z]),
      { weights: 'none' },
    ),
    lying = await autoRig(
      turned(mesh, ([x, y, z]) => [x, -z, y]),
      { weights: 'none', up: [0, 0, 1] },
    );
  // The grid does not turn with the mesh, so a joint moves by a voxel or two: 0.03 of the height.
  plain.joints.forEach((joint, i) => {
    const [x, y, z] = joint.position,
      a = [c * x + s * z, y, -s * x + c * z],
      b = [x, -z, y],
      p = yawed.joints[i].position,
      q = lying.joints[i].position;
    assert.ok(Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]) < 0.03 * height, `${joint.name} after a turn`);
    assert.ok(Math.hypot(b[0] - q[0], b[1] - q[1], b[2] - q[2]) < 0.03 * height, `${joint.name} with up +z`);
  });
});

test('left stays the figure\'s own left when it faces the other way, and forward can be told', async () => {
  const { mesh } = makeHuman(),
    back = turned(mesh, ([x, y, z]) => [-x, y, -z]),
    rig = await autoRig(back, { weights: 'none' });
  assert.ok(rig.forward[2] < -0.99, `it faces -z (${rig.forward})`);
  assert.ok(rig.joints[rig.humanoid.leftHand].position[0] < 0, 'so its left is -x');
  const told = await autoRig(back, { weights: 'none', forward: [0, 0, 1] });
  assert.ok(told.joints[told.humanoid.leftHand].position[0] > 0, 'told otherwise, it believes the caller');
});

test('the weights move the mesh with the bones: a bent knee takes the foot and leaves the rest', async () => {
  const { mesh } = makeHuman(),
    rig = await autoRig(mesh),
    { joints, weights } = rig.weights.toInfluences(4),
    height = heightOf(mesh.positions),
    report = checkSkin({ weights: { joints, weights }, joints: rig.joints });
  assert.deepEqual(report.issues, []);
  // The knee and every joint below it turn together, so a vertex's share on those joints is how far it follows.
  const knee = rig.humanoid.leftLowerLeg,
    moved = new Set([knee]);
  rig.joints.forEach((joint, i) => moved.has(joint.parent) && moved.add(i));
  const count = mesh.positions.length / 3,
    near = (v, name, reach) => {
      const q = rig.joints[rig.humanoid[name]].position;
      return (
        Math.hypot(mesh.positions[v * 3] - q[0], mesh.positions[v * 3 + 1] - q[1], mesh.positions[v * 3 + 2] - q[2]) <
        reach * height
      );
    };
  let feet = 0,
    followed = 0,
    stray = 0;
  for (let v = 0; v < count; v++) {
    let share = 0;
    for (let k = 0; k < 4; k++) if (moved.has(joints[v * 4 + k])) share += weights[v * 4 + k];
    if (near(v, 'leftFoot', 0.06)) {
      feet++;
      if (share > 0.95) followed++;
    }
    if (near(v, 'leftHand', 0.05) || near(v, 'rightFoot', 0.06) || near(v, 'leftUpperLeg', 0.05))
      if (share > 0.5) stray++;
  }
  assert.ok(feet > 100 && followed / feet > 0.99, `the foot follows: ${followed} of ${feet}`);
  assert.equal(stray, 0, 'the hand, the other foot and the hip stay');
});

test('the names are the ones the retarget tools read', async () => {
  const { mesh } = makeHuman(),
    rig = await autoRig(mesh, { weights: 'none' }),
    match = detectSkeleton(rig.pose.names);
  assert.equal(match.preset, 'humanoid');
  assert.ok(humanoidBones(rig.pose.names, 'humanoid').size >= 22);
  // Local offsets add up to the joints.
  const at = (i) => {
    const r = rig.pose.rest.subarray(i * 10, i * 10 + 3),
      up = rig.pose.parents[i] < 0 ? [0, 0, 0] : at(rig.pose.parents[i]);
    return [r[0] + up[0], r[1] + up[1], r[2] + up[2]];
  };
  const hand = rig.humanoid.leftHand,
    p = at(hand),
    q = rig.joints[hand].position;
  assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-9);
});

test("the README's figure of boxes, a stand-in, stands as the example says", async () => {
  const positions = [],
    indices = [],
    box = (x0, y0, z0, x1, y1, z1) => {
      const first = positions.length / 3;
      for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z);
      for (const [a, b, c, d] of [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5],
      ])
        indices.push(first + a, first + b, first + c, first + a, first + c, first + d);
    };
  box(-0.17, 0.85, -0.1, 0.17, 1.42, 0.1);
  box(-0.06, 1.4, -0.05, 0.06, 1.5, 0.05);
  box(-0.1, 1.48, -0.1, 0.1, 1.74, 0.1);
  for (const side of [-1, 1]) {
    box(side * 0.1 - 0.06, 0.05, -0.06, side * 0.1 + 0.06, 0.9, 0.06);
    box(side * 0.1 - 0.06, 0, -0.06, side * 0.1 + 0.06, 0.08, 0.2);
    const [near, far] = [side * 0.15, side * 0.85].sort((p, q) => p - q);
    box(near, 1.32, -0.04, far, 1.4, 0.04);
  }
  const rig = await autoRig({ positions, indices });
  assert.ok(rig.joints[rig.humanoid.leftHand].position[0] > 0.5, 'the left hand is out on +x');
  assert.ok(rig.forward[2] > 0.99, 'it faces +z');
  assert.ok(checkSkin({ weights: rig.weights.toInfluences(4), joints: rig.joints }).ok);
});

test('what is not a humanoid is refused with a code, and bad options name the fix', async () => {
  // Stand-in shapes: a box stands on one foot.
  const box = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0, 0, 0, 1, 1, 0, 1, 0, 2, 1, 1, 2, 1]),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]),
  };
  await assert.rejects(autoRig(box), { code: 'failed' });
  await assert.rejects(autoRig(box, { resolution: 8 }), { name: 'RangeError' });
  await assert.rejects(autoRig(box, { closing: -1 }), { name: 'RangeError' });
  await assert.rejects(autoRig(box, { weights: 'paint' }), { name: 'RangeError' });
  await assert.rejects(autoRig(box, { up: [0, 0, 0] }), { name: 'RangeError' });
  await assert.rejects(autoRig(box, { forward: [0, 0, 0] }), { name: 'RangeError' });
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(autoRig(box, { signal: stop.signal }), /stopped/);
});
