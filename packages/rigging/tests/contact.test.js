import assert from 'node:assert/strict';
import { test } from 'node:test';
import { axisAngleToQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { solveContactIK } from '../dist/contact.js';
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
