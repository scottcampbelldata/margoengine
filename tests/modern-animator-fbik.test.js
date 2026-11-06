// Full-body IK (@margoengine/animator/fbik): hands, feet and head meet their targets together, the body moves only as
// far as it must, feet hold their ground, the centre of mass stays over them, bones keep their lengths, and a moving
// target moves the body smoothly. The last test runs RiggedFigure.glb, a real file with a walking clip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addFullBodyIK } from '../packages/animator/dist/fbik.js';
import {
  animatorDocument,
  animatorGLB,
  animatorRun,
  axisAngle,
  BIPED,
  largestGap,
  RIGGED_FIGURE,
} from './support/animator-rig.js';

const CLIPS = { Stand: { duration: 1, tracks: { 'Hips.translation': () => [0, 1, 0] } } };
async function rig(extra = {}) {
  const f = await animatorRun(animatorDocument(BIPED, CLIPS), { initial: 'stand', states: { stand: 'Stand' } }),
    i = (name) => f.index.get(name),
    limb = (a, b, c) => ({ upper: i(a), lower: i(b), end: i(c) });
  f.left = limb('LeftArm', 'LeftForeArm', 'LeftHand');
  f.right = limb('RightArm', 'RightForeArm', 'RightHand');
  f.leftLeg = limb('LeftUpLeg', 'LeftLeg', 'LeftFoot');
  f.rightLeg = limb('RightUpLeg', 'RightLeg', 'RightFoot');
  f.options = {
    pelvis: i('Hips'),
    spine: [i('Spine'), i('Chest')],
    legs: [f.leftLeg, f.rightLeg],
    arms: [f.left, f.right],
    head: { joint: i('Head') },
    ...extra,
  };
  f.ik = addFullBodyIK(f.animator, f.options);
  return f;
}
const ALL = Object.keys(BIPED).filter((name) => name !== 'Root');
const places = (f) => ALL.map((name) => f.world(name));
const near = (a, b, tolerance, label) => {
  const gap = Math.hypot(...a.map((v, c) => v - b[c]));
  assert.ok(gap <= tolerance, `${label}: ${a} is ${gap} from ${b}`);
};
const FEET = [
  [0.1, 0.06, 0],
  [-0.1, 0.06, 0],
];
const planted = (f) => {
  near(f.world('LeftFoot'), FEET[0], 2e-3, 'left foot');
  near(f.world('RightFoot'), FEET[1], 2e-3, 'right foot');
};

test('no targets leaves the animated pose alone', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.step();
  assert.ok(f.ik.result.reached);
  assert.equal(f.ik.result.iterations, 0);
  near(f.world('Hips'), [0, 1, 0], 1e-6, 'hips');
  near(f.world('LeftHand'), [0.74, 1.6, 0], 1e-5, 'hand');
});

test('a hand in reach moves the arm alone', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.right.target = [-0.5, 1.3, 0.2];
  f.step();
  near(f.world('RightHand'), f.right.target, 1e-3, 'hand');
  near(f.world('Hips'), [0, 1, 0], 1e-6, 'hips');
  near(f.world('LeftHand'), [0.74, 1.6, 0], 1e-5, 'other hand');
});

test('a far reach bends the body, keeps the feet down and stays balanced', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.left.target = [0.3, 1.15, 0.85];
  f.step();
  near(f.world('LeftHand'), f.left.target, 1e-3, 'hand');
  planted(f);
  assert.ok(f.ik.result.reached, `left ${f.ik.result.distance}`);
  assert.ok(f.ik.result.balanced, `off balance by ${f.ik.result.imbalance}`);
  assert.ok(f.world('Hips')[2] < -0.005, `the hips went back to balance, to ${f.world('Hips')[2]}`);
  assert.ok(f.world('Chest')[2] > 0.02, `the chest leaned out, to ${f.world('Chest')[2]}`);
});

test('without balance the same reach tips over the supports', async (t) => {
  const f = await rig({ balance: false });
  t.after(() => f.release());
  f.left.target = [0.3, 1.15, 0.85];
  f.step();
  near(f.world('LeftHand'), f.left.target, 1e-3, 'hand');
  const g = await rig();
  t.after(() => g.release());
  g.left.target = [0.3, 1.15, 0.85];
  g.step();
  assert.ok(f.world('Hips')[2] > g.world('Hips')[2] + 0.02, 'balance holds the hips further back');
});

test('picking something off the floor crouches, feet down', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.right.target = [-0.15, 0.1, 0.3];
  f.step();
  near(f.world('RightHand'), f.right.target, 1e-3, 'hand');
  planted(f);
  assert.ok(f.world('Hips')[1] < 0.95, `the hips dropped to ${f.world('Hips')[1]}`);
});

test('a climbing pose: two hands, a raised foot and a head target are met together', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.left.target = [0.25, 1.75, 0.35];
  f.right.target = [-0.25, 1.95, 0.35];
  f.leftLeg.target = [0.12, 0.5, 0.3];
  f.left.support = f.right.support = true;
  f.options.head.target = [0, 1.62, 0.12];
  f.step();
  near(f.world('LeftHand'), f.left.target, 1e-3, 'left hand');
  near(f.world('RightHand'), f.right.target, 1e-3, 'right hand');
  near(f.world('LeftFoot'), f.leftLeg.target, 1e-3, 'raised foot');
  near(f.world('RightFoot'), FEET[1], 2e-3, 'standing foot');
  near(f.world('Head'), f.options.head.target, 3e-3, 'head');
  assert.ok(f.ik.result.reached, `left ${f.ik.result.distance}`);
  assert.ok(f.ik.result.balanced, `off balance by ${f.ik.result.imbalance}`);
});

test('a target out of reach reports how far short it stopped and stays finite', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.left.target = [4, 1.5, 0];
  f.step();
  assert.equal(f.ik.result.reached, false);
  assert.ok(f.ik.result.distance > 1, `short by ${f.ik.result.distance}`);
  for (const place of places(f)) assert.ok(place.every(Number.isFinite));
  planted(f);
});

test('bones keep their lengths', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.step();
  const length = () =>
      ALL.filter((name) => BIPED[name][0] !== 'Root').map((name) =>
        Math.hypot(...f.world(name).map((v, c) => v - f.world(BIPED[name][0])[c])),
      ),
    before = length();
  f.left.target = [0.3, 0.7, 0.7];
  f.right.target = [-0.4, 1.9, 0.4];
  f.step();
  length().forEach((value, i) => assert.ok(Math.abs(value - before[i]) < 1e-5, `bone ${i}: ${value} ${before[i]}`));
});

test('a target moving smoothly moves the whole body smoothly', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  let last = null,
    worst = 0;
  for (let i = 0; i <= 120; i++) {
    const s = i / 120;
    f.left.target = [0.3 - 0.2 * s, 1.5 - 0.9 * s, 0.25 + 0.5 * s];
    f.step();
    const now = places(f);
    if (last) worst = Math.max(worst, largestGap(now, last));
    last = now;
    assert.ok(f.ik.result.reached, `frame ${i} ${f.ik.result.distance}`);
  }
  assert.ok(worst < 0.03, `a joint jumped ${worst} in one frame`);
});

test('weight blends from the animated pose', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.step();
  const animated = f.world('RightHand');
  f.right.target = [-0.4, 1.2, 0.3];
  f.right.weight = 0.5;
  f.step();
  near(f.world('RightHand'), animated.map((v, c) => (v + f.right.target[c]) / 2), 1e-3, 'half way');
  f.options.weight = 0;
  f.step();
  near(f.world('RightHand'), animated, 1e-5, 'off');
});

test('hands and head take a rotation target', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const q = axisAngle([0, 0, 1], 1);
  f.right.target = [-0.5, 1.3, 0.2];
  f.right.rotation = q;
  f.options.head.rotation = q;
  f.step();
  const m = f.node('RightHand').matrix,
    h = f.node('Head').matrix;
  near([m[0], m[1]], [Math.cos(1), Math.sin(1)], 1e-5, 'hand rotation');
  near([h[0], h[1]], [Math.cos(1), Math.sin(1)], 1e-5, 'head rotation');
});

test('an unpinned leg rides with the body', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.rightLeg.pinned = false;
  f.rightLeg.support = false;
  f.left.target = [0.3, 1.15, 0.85];
  f.step();
  near(f.world('LeftFoot'), FEET[0], 2e-3, 'left foot');
  assert.ok(Math.hypot(...f.world('RightFoot').map((v, c) => v - FEET[1][c])) > 2e-3, 'the free foot moved');
});

test('bad rigs name the fix', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const good = f.options,
    { left, right } = f;
  assert.throws(() => addFullBodyIK(f.animator, { ...good, pelvis: 99 }), /not one of/);
  assert.throws(() => addFullBodyIK(f.animator, { ...good, spine: [f.index.get('Chest'), f.index.get('Spine')] }), /spine/);
  assert.throws(
    () => addFullBodyIK(f.animator, { ...good, arms: [{ upper: left.upper, lower: right.lower, end: left.end }] }),
    /direct chain/,
  );
  assert.throws(() => addFullBodyIK(f.animator, { ...good, iterations: 0 }), /iterations/);
  assert.throws(() => addFullBodyIK(f.animator, { ...good, reach: 2 }), /reach/);
  assert.throws(() => addFullBodyIK(f.animator, { ...good, onSolve: 1 }), /onSolve/);
  f.ik.dispose();
  f.ik.dispose();
});

test('RiggedFigure.glb: on its real walking clip a hand reaches a point while the feet keep their animated steps', async (t) => {
  const run = () => animatorRun(animatorGLB(RIGGED_FIGURE), { initial: 'walk', states: { walk: 'Animation 0' } }),
    f = await run(),
    plain = await run();
  t.after(() => {
    f.release();
    plain.release();
  });
  const i = (n) => f.index.get(n),
    limb = (kind, side) => ({ upper: i(`${kind}_joint_${side}_1`), lower: i(`${kind}_joint_${side}_2`), end: i(`${kind}_joint_${side}_3`) }),
    arm = limb('arm', 'L');
  f.step(1 / 30, 10);
  plain.step(1 / 30, 10);
  const ik = addFullBodyIK(f.animator, {
    pelvis: i('torso_joint_1'),
    spine: [i('torso_joint_2'), i('torso_joint_3')],
    legs: [limb('leg', 'L'), limb('leg', 'R')],
    arms: [arm],
    head: { joint: i('neck_joint_1') },
    balance: false,
  });
  const chest = f.world('torso_joint_3'),
    target = [chest[0] + 0.4, chest[1] + 0.25, chest[2] + 0.45];
  arm.target = target;
  for (let frame = 0; frame < 30; frame++) {
    f.step(1 / 30);
    plain.step(1 / 30);
    near(f.world('arm_joint_L_3'), target, 2e-3, `frame ${frame}`);
    assert.ok(ik.result.reached, `frame ${frame} short by ${ik.result.distance}`);
    for (const foot of ['leg_joint_L_3', 'leg_joint_R_3']) near(f.world(foot), plain.world(foot), 2e-3, `${foot} frame ${frame}`);
  }
});
