import assert from 'node:assert/strict';
import { test } from 'node:test';
import { axisAngleToQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { solveTwoBoneIK } from '@margoengine/animator';
import { LimbCollisionRig, solveContactIK } from '../dist/contact.js';
import { checkRig } from '../dist/index.js';

const pose = () => ({
  parents: [-1, 0, 1, 2],
  local: Float64Array.from(
    [
      [0, 0, 0],
      [0, 0, 0],
      [0.4, 0, 0],
      [0.38, 0, 0],
    ].flatMap((position) => [...position, 0, 0, 0, 1, 1, 1, 1]),
  ),
});
const contact = {
  joints: [1, 2, 3],
  point: [0.45, 0.26, 0.12],
  rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  anchor: [0.11, 0, 0],
  pole: [0.2, 0.1, 0.55],
  tolerance: 1e-6,
};

test('the palm landmark lands on the surface after a wrist turn and the arm keeps its lengths', () => {
  const arm = pose();
  arm.local.set([1.25, 1.25, 1.25], 7);
  arm.local.set([1.1, 1, 0.8], 37);
  const before = arm.local.slice();
  const result = solveContactIK(arm, contact);
  assert.ok(result.locked, JSON.stringify(result));
  assert.ok(Math.hypot(...result.point.map((v, i) => v - contact.point[i])) < contact.tolerance);
  assert.ok(result.angle < 1e-6);
  for (const joint of contact.joints) {
    const at = joint * 10;
    assert.deepEqual(arm.local.slice(at, at + 3), before.slice(at, at + 3));
    assert.deepEqual(arm.local.slice(at + 7, at + 10), before.slice(at + 7, at + 10));
  }
});

test('a hand in the air or a wrist at its local turn limit cannot report a grip', () => {
  const far = solveContactIK(pose(), { ...contact, point: [2, 0.2, 0] });
  assert.equal(far.locked, false);
  assert.ok(far.distance > 1);
  const limited = pose();
  const result = solveContactIK(limited, {
    ...contact,
    limits: [1, 2, 3].map((joint) => ({
      joint,
      neutral: [0, 0, 0, 1],
      limit: { type: 'hinge', axis: [0, 0, 1], min: 0, max: 0 },
    })),
  });
  assert.equal(result.locked, false);
  assert.ok(result.angle > 0.1);
  assert.deepEqual(limited.local.slice(33, 37), Float64Array.of(0, 0, 0, 1));
});

test('approach blends the actual landmark and zero weight leaves the rig alone', () => {
  const arm = pose();
  const before = arm.local.slice();
  const start = solveContactIK(arm, { ...contact, weight: 0 });
  assert.deepEqual(arm.local, before);
  const halfway = solveContactIK(arm, { ...contact, weight: 0.5 });
  const midpoint = start.point.map((v, i) => (v + contact.point[i]) / 2);
  assert.ok(Math.hypot(...halfway.point.map((v, i) => v - midpoint[i])) < contact.tolerance);
  assert.equal(halfway.locked, false);
});

test('bad transforms and disconnected joints are rejected before editing the pose', () => {
  const arm = pose();
  arm.local[7] = 2;
  const before = arm.local.slice();
  assert.throws(() => solveContactIK(arm, contact), /uniform positive ancestor scales/);
  assert.throws(() => solveContactIK(arm, { ...contact, joints: [0, 2, 3] }), /parent-child chain/);
  assert.throws(() => solveContactIK(arm, { ...contact, rotation: [0, 0, 0, 0] }), /nonzero quaternion/);
  assert.deepEqual(arm.local, before);
});

test('contact can swivel an already planted arm around a torso, keeping the wrist on the hold', () => {
  const arm = pose();
  for (const [joint, turn] of [
    [1, Math.PI / 4],
    [2, -Math.PI / 2],
    [3, Math.PI / 4],
  ])
    arm.local.set(axisAngleToQuaternion([0, 0, 1], turn), joint * 10 + 3);
  const wrist = [0.78 * Math.SQRT1_2, 0.02 * Math.SQRT1_2, 0];
  const guard = new LimbCollisionRig(
    arm.parents,
    [{ start: { joint: 0, offset: [0.28, 0.17, 0] }, end: { joint: 0, offset: [0.28, 0.4, 0] }, radius: 0.105 }],
    [
      { start: 1, end: 2, radius: 0.045 },
      { start: 2, end: 3, radius: 0.04 },
    ],
  );
  guard.setBodyPose(arm.local);
  const target = {
    joints: [0, 1, 2, 3],
    point: wrist,
    anchor: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    pole: [0.3, 0.3, 0],
    tolerance: 1e-6,
    limits: [{ joint: 0, neutral: [0, 0, 0, 1], limit: { type: 'hinge', axis: [0, 0, 1], min: 0, max: 0 } }],
    clearance: guard.clearance,
  };
  const before = arm.local.slice();
  const initial = solveContactIK(arm, { ...target, weight: 0 });
  assert.ok(initial.blocked && initial.clearance < -0.12);
  assert.deepEqual(arm.local, before);
  const solved = solveContactIK(arm, target);
  assert.ok(solved.locked && solved.blocked === false && solved.clearance >= 0, JSON.stringify(solved));
  assert.notDeepEqual(arm.local, before);
  assert.deepEqual(arm.local.slice(0, 10), before.slice(0, 10), 'the clavicle stays locked');
  assert.ok(solved.distance < 1e-6 && solved.angle < 1e-6);
});

test('if the whole arm cannot clear the obstacle, palm contact reports blocked without committing angles', () => {
  const arm = pose();
  const before = arm.local.slice();
  const rejected = solveContactIK(arm, { ...contact, clearance: () => -0.01 });
  assert.equal(rejected.locked, false);
  assert.equal(rejected.blocked, true);
  assert.equal(rejected.clearance, -0.01);
  assert.deepEqual(arm.local, before);
  assert.throws(() => solveContactIK(arm, { ...contact, clearance: () => NaN }), /signed distance/);
  assert.deepEqual(arm.local, before);
});

test('hinged contact follows one continuous elbow plane through a planted wrist, independent of incoming elbow keys', () => {
  const pole = [0.12, 0.36, 0.35],
    joints = [1, 2, 3],
    limits = [{ joint: 2, neutral: [0, 0, 0, 1], limit: { type: 'hinge', axis: [0, 0, 1], min: 0, max: 2.75 } }];
  const samples = Array.from({ length: 101 }, (_, i) => [0.48 + i * 0.001, 0.21, 0.12 + 0.023 * Math.sin(i / 30)]);
  const positions = [];
  for (const [i, point] of samples.entries()) {
    const arm = pose();
    // This unrelated shoulder animation flips 126 degrees each frame. The explicit bend plane stays fixed.
    arm.local.set(axisAngleToQuaternion([1, 0, 0], i % 2 ? -1.1 : 1.1), 13);
    const result = solveContactIK(arm, {
      ...contact,
      point,
      joints,
      pole,
      limits,
      anchor: [0, 0, 0],
      reach: 'hinged',
      clearance: (packed) => {
        positions.push(Array.from(packed.slice(3, 6)));
        return 0.02;
      },
    });
    const expected = solveTwoBoneIK([0, 0, 0], [0.4, 0, 0], [0.78, 0, 0], point, pole).knee;
    assert.ok(result.locked && result.distance < 1e-7, JSON.stringify(result));
    assert.ok(Math.hypot(...positions[i].map((v, k) => v - expected[k])) < 1e-7);
    if (i) assert.ok(Math.hypot(...positions[i].map((v, k) => v - positions[i - 1][k])) < 0.002);
  }
  const arm = pose(),
    before = arm.local.slice();
  const blocked = solveContactIK(arm, { ...contact, joints, limits, pole, reach: 'hinged', clearance: () => -0.04 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.locked, false);
  assert.deepEqual(arm.local, before);
});

test('the elbow stays on its hinge and the wrist stays inside its cone on a 1,207-joint character', () => {
  const identity = [0, 0, 0, 1];
  const base = pose(),
    n = 1207,
    local = new Float64Array(n * 10);
  local.set(base.local);
  const parents = [...base.parents];
  for (let joint = parents.length; joint < n; joint++) {
    // Face, twist and secondary joints hang off the main joint hierarchy and keep their animation.
    parents.push(Math.floor(joint / 2));
    local.set([0.001, 0.002, 0, ...identity, 1, 1, 1], joint * 10);
  }
  const angular = (i) => local.subarray(i * 10 + 3, i * 10 + 7);
  const limits = [
    { joint: 2, neutral: identity, limit: { type: 'hinge', axis: [0, 0, 1], min: 0.12, max: 1.9 } },
    { joint: 3, neutral: identity, limit: { type: 'cone', axis: [1, 0, 0], angle: 0.52, twist: [-0.28, 0.28] } },
  ];
  const before = local.slice(40);
  assert.equal(
    checkRig(parents.map((parent, i) => ({ name: `joint${i}`, parent, position: [0, i * 0.001, 0] }))).length,
    n,
  );
  for (const point of [
    [0.55, 0.3, 0.05],
    [0.4, 0.08, -0.17],
    [0.8, 0.18, 0.08],
  ]) {
    solveContactIK({ parents, local }, { ...contact, point, limits, tolerance: 0.003 });
    const elbow = angular(2),
      bend = 2 * Math.atan2(elbow[2], elbow[3]);
    assert.ok(Math.hypot(elbow[0], elbow[1]) < 1e-8 && bend >= 0.12 - 1e-8 && bend <= 1.9 + 1e-8);
    const wrist = angular(3),
      facing = rotateByQuaternion([1, 0, 0], wrist);
    assert.ok(Math.acos(Math.min(1, facing[0])) <= 0.52 + 1e-8);
    assert.ok(Math.abs(2 * Math.atan2(wrist[0], wrist[3])) <= 0.28 + 1e-8);
  }
  assert.deepEqual(local.slice(40), before);
});

test('a hoof can plant the bottom of a long leg with several independent anatomical hinges', () => {
  const identity = [0, 0, 0, 1],
    offsets = [
      [0, 1.38, 0],
      [0, -0.32, 0.19],
      [0, -0.37, -0.15],
      [0, -0.32, 0],
      [0, -0.16, 0.11],
      [0, -0.12, 0.034],
    ];
  const limb = {
    parents: [-1, 0, 1, 2, 3, 4],
    local: Float64Array.from(offsets.flatMap((at) => [...at, ...identity, 1, 1, 1])),
  };
  const anchor = [0, -0.082, 0.038],
    point = [0, 0.008, 0.222];
  const limits = [
    { joint: 1, neutral: identity, limit: { type: 'hinge', axis: [1, 0, 0], min: -0.85, max: 0.5 } },
    { joint: 2, neutral: identity, limit: { type: 'hinge', axis: [1, 0, 0], min: -0.15, max: 1.3 } },
    { joint: 3, neutral: identity, limit: { type: 'hinge', axis: [1, 0, 0], min: -0.15, max: 1.6 } },
  ];
  // Start ahead of the landing with the proximal limb turned. The flat sole is a different frame from the ankle.
  limb.local.set(axisAngleToQuaternion([1, 0, 0], -0.18), 3);
  const hit = solveContactIK(limb, {
    joints: [0, 1, 2, 3, 4, 5],
    point,
    rotation: identity,
    anchor,
    limits,
    tolerance: 0.003,
    iterations: 160,
  });
  assert.ok(hit.locked, JSON.stringify(hit));
  assert.ok(hit.distance <= 0.003);
  assert.ok(hit.angle < 0.02);
});
