import assert from 'node:assert/strict';
import { test } from 'node:test';
import { axisAngleToQuaternion, multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import { addPoseJointLimits, PoseJointLimits, redistributeJointTwist } from '../dist/joint-limits.js';

const rest = [0, 0, 0, 1];
const hinge = (joint) => ({ joint, neutral: rest, limit: { type: 'hinge', axis: [1, 0, 0], min: -0.2, max: 0.5 } });
const angular = (a, b) => {
  const dot = Math.abs(a.reduce((sum, v, i) => sum + v * b[i], 0));
  return 2 * Math.acos(Math.min(1, dot));
};

test('limit projection covers 1,207 joints in one pose and leaves off-profile joints alone', () => {
  const n = 1207,
    input = axisAngleToQuaternion([1, 0, 0], -1.8);
  const pose = Float64Array.from(Array.from({ length: n }, () => [0, 0, 0, ...input, 1, 1, 1]).flat());
  const profile = new PoseJointLimits(
    n,
    Array.from({ length: n - 1 }, (_, i) => hinge(i + 1)),
  );
  profile.apply(pose);
  const output = axisAngleToQuaternion([1, 0, 0], -0.2);
  for (let i = 1; i < n; i++) assert.ok(angular(pose.subarray(i * 10 + 3, i * 10 + 7), output) < 1e-7);
  assert.deepEqual([...pose.slice(3, 7)], input);
  const broken = pose.slice();
  broken[13] = 1;
  broken[(n - 1) * 10 + 6] = NaN;
  const before = broken.slice();
  assert.throws(() => profile.apply(broken), /nonzero quaternion/);
  assert.deepEqual(broken, before);
});

test('forearm pronation keeps the wrist origin and world rotation while removing a local wrist twist', () => {
  const forearm = axisAngleToQuaternion([0, 1, 0], 0.43),
    offset = [0.35, 0, 0];
  const wrist = multiplyQuaternions(axisAngleToQuaternion([0, 0, 1], 0.3), axisAngleToQuaternion([1, 0, 0], 1.9));
  const pose = Float64Array.of(0, 0, 0, ...forearm, 1, 1, 1, ...offset, ...wrist, 1, 1, 1);
  const transfer = redistributeJointTwist(pose, [-1, 0], 1, rest, [-0.28, 0.28]);
  const afterForearm = pose.subarray(3, 7),
    afterWrist = pose.subarray(13, 17);
  assert.ok(Math.abs(transfer - 1.62) < 1e-9);
  assert.ok(angular(multiplyQuaternions(afterForearm, afterWrist), multiplyQuaternions(forearm, wrist)) < 1e-7);
  const p = rotateByQuaternion(offset, afterForearm),
    want = rotateByQuaternion(offset, forearm);
  assert.ok(Math.hypot(...p.map((v, i) => v - want[i])) < 1e-12);
  assert.ok(Math.abs(2 * Math.atan2(afterWrist[0], afterWrist[3]) - 0.28) < 1e-9);
  assert.equal(redistributeJointTwist(pose, [-1, 0], 1, rest, [-0.28, 0.28]), 0);
});

test('the Animator hook limits the live sampled rotation and returns its remover', () => {
  const input = axisAngleToQuaternion([1, 0, 0], 1.2),
    node = { id: 0 };
  const transforms = { qx: [input[0]], qy: [0], qz: [0], qw: [input[3]] };
  const store = { transforms, tick() {} };
  let step, written;
  const animator = {
    animation: { model: { nodes: [node], root: { engine: { store } } } },
    addSolver(fn) {
      step = fn;
      return () => {
        step = undefined;
      };
    },
    writeNodeRotation(target, rotation) {
      assert.equal(target, node);
      written = [...rotation];
    },
  };
  const remove = addPoseJointLimits(animator, [hinge(0)]);
  step();
  assert.ok(angular(written, axisAngleToQuaternion([1, 0, 0], 0.5)) < 1e-7);
  remove();
  assert.equal(step, undefined);
});
