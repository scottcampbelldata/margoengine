import assert from 'node:assert/strict';
import { test } from 'node:test';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { LimbCollisionRig } from '../dist/contact.js';

const local = (positions) => Float64Array.from(positions.flatMap((p) => [...p, 0, 0, 0, 1, 1, 1, 1]));

test('a sleeve segment crossing the chest is rejected even with both arm joints outside', () => {
  const rig = new LimbCollisionRig(
    [-1, 0],
    [{ start: { joint: 0 }, end: { joint: 1 }, radius: 0.14 }],
    [{ start: 0, end: 1, radius: 0.045 }],
  );
  const pose = local([
    [0, 0, 0],
    [0, 0.5, 0],
  ]);
  rig.setBodyPose(pose);
  assert.ok(Math.abs(rig.clearance([-0.4, 0.3, 0, 0.45, 0.3, 0]) + 0.185) < 1e-9);
  assert.ok(rig.clearance([0.24, 0.3, 0, 0.5, 0.37, 0.04]) > 0.05);
});

test('human upper arm extension is bounded relative to a turning chest', () => {
  const pose = local([
    [0, 0, 0],
    [0, 1, 0],
  ]);
  const rig = new LimbCollisionRig(
    [-1, 0],
    [{ start: { joint: 1, offset: [0, -1, 0] }, radius: 0.08 }],
    [{ start: 0, end: 1, radius: 0.05 }],
    [{ start: 0, end: 1, reference: 1, forward: [0, 0, 1], maxBackwards: Math.PI / 5 }],
  );
  rig.setBodyPose(pose);
  assert.ok(rig.clearance([0.35, 1, 0, 0.36, 1, -0.3]) < 0);
  assert.ok(rig.clearance([0.35, 1, 0, 0.36, 1, 0.3]) > 0);
  pose.set(axisAngleToQuaternion([0, 1, 0], Math.PI / 2), 13);
  rig.setBodyPose(pose);
  assert.ok(rig.clearance([0.35, 1, 0, 0.05, 1, 0.02]) < 0);
  assert.ok(rig.clearance([0.35, 1, 0, 0.65, 1, 0.02]) > 0);
});

test('a quadruped foreleg sweep catches a moving chest between two clear poses', () => {
  const positions = local([
    [0, 0.65, 0],
    [0, 0, 0.77],
    [0, 0, 0.36],
  ]);
  const rig = new LimbCollisionRig(
    [-1, 0, 0],
    [{ start: { joint: 1 }, end: { joint: 2 }, radius: 0.135 }],
    [
      { start: 0, end: 1, radius: 0.045, range: [0.32, 1] },
      { start: 1, end: 2, radius: 0.04 },
    ],
  );
  const foreleg = (x) => [x, 0.68, 0.74, x, 0.44, 0.67, x, 0.06, 0.65];
  rig.setBodyPose(positions);
  assert.ok(rig.clearance(foreleg(-0.5)) > 0.3);
  const from = rig.snapshot(foreleg(-0.5));
  positions[0] = -0.12;
  rig.setBodyPose(positions);
  const to = rig.snapshot(foreleg(0.5));
  assert.ok(rig.clearance(foreleg(0.5)) > 0.4);
  const swept = rig.sweep(from, to);
  const proximalHeight = 0.68 + 0.32 * (0.44 - 0.68),
    radialContact = Math.sqrt((0.135 + 0.045) ** 2 - (0.65 - proximalHeight) ** 2),
    time = (0.5 - radialContact) / 1.12;
  assert.equal(swept.clear, false);
  assert.equal(swept.exhausted, false);
  assert.ok(swept.time <= time && time - swept.time < 0.002, JSON.stringify(swept));
  assert.equal(rig.sweep(from, from).clear, true);
  assert.equal(rig.sweep(from, to, { maxSteps: 1 }).exhausted, true);
});
