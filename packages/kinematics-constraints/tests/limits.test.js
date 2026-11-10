import assert from 'node:assert/strict';
import test from 'node:test';
import { JointLimitSet, jointLimitPredicate } from '../dist/joint-limits.js';
import { AvoidanceSolver, SphereVolume, SolveStatus } from '../dist/index.js';

const q = (axis, angle) => [...axis.map((v) => v * Math.sin(angle / 2)), Math.cos(angle / 2)];
const multiply = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const xyz = (x, y, z) => multiply(multiply(q([1, 0, 0], x), q([0, 1, 0], y)), q([0, 0, 1], z));
const euler = (min, max) => new JointLimitSet([{ type: 'euler', min, max }]);
test('Euler XYZ boxes match independent composed rotations across every axis', () => {
  const limits = euler([-0.5, -0.4, -0.3], [0.5, 0.4, 0.3]);
  for (let i = 0; i < 300; i++) {
    const angles = [Math.sin(i * 0.91) * 1.2, Math.cos(i * 0.43) * 1.2, Math.sin(i * 0.37) * 1.2];
    const legal = Math.abs(angles[0]) <= 0.5 && Math.abs(angles[1]) <= 0.4 && Math.abs(angles[2]) <= 0.3;
    assert.equal(limits.accepts([xyz(...angles)]), legal, JSON.stringify(angles));
  }
  assert.equal(limits.accepts([xyz(0.5, -0.4, 0.3)]), true);
  assert.equal(limits.accepts([xyz(0.5001, -0.4, 0.3)]), false);
});
test('Euler equivalent branches, signed pi and gimbal lock test existence inside the bounds', () => {
  for (const angles of [
    [0.2, 2.1, 0.4],
    [Math.PI, 0, 0],
    [0.2, Math.PI / 2, 0.4],
    [0.2, -Math.PI / 2, 0.4],
  ]) {
    const limits = euler(angles, angles);
    assert.equal(limits.accepts([xyz(...angles)]), true, JSON.stringify(angles));
  }
  assert.equal(euler([0, Math.PI / 2, 0], [0, Math.PI / 2, 0]).accepts([xyz(0.3, Math.PI / 2, 0.4)]), false);
});
test('hinges reject off-axis swing and preserve signed rotation limits', () => {
  const set = new JointLimitSet([{ type: 'hinge', axis: [2, 0, 0], min: 0.2, max: 0.8 }]);
  assert.equal(set.accepts([q([1, 0, 0], 0.5)]), true);
  assert.equal(set.accepts([q([1, 0, 0], -0.5)]), false);
  assert.equal(set.accepts([q([0, 1, 0], 0.5)]), false);
  assert.equal(set.accepts([q([1, 0, 0], 0.81)]), false);
});
test('cones check both swing and rest-axis twist without quaternion-sign ambiguity', () => {
  const set = new JointLimitSet([{ type: 'cone', axis: [0, 1, 0], angle: 0.5, twist: [-0.2, 0.3] }]);
  const pose = multiply(q([1, 0, 0], 0.4), q([0, 1, 0], 0.25));
  assert.equal(set.accepts([pose]), true);
  assert.equal(set.accepts([pose.map((v) => -v * 3)]), true);
  assert.equal(set.accepts([multiply(q([1, 0, 0], 0.6), q([0, 1, 0], 0.25))]), false);
  assert.equal(set.accepts([multiply(q([1, 0, 0], 0.4), q([0, 1, 0], 0.4))]), false);
});
const evaluate = (_root, target, angle, out) => {
  const half = target[0] / 2,
    height = Math.sqrt(1 - half * half);
  out.set([half, height * Math.cos(angle), height * Math.sin(angle)]);
};
test('swivel skips clear illegal candidates and combines joint legality with obstacle clearance', () => {
  const target = [1.4, 0, 0],
    height = Math.sqrt(1 - 0.7 ** 2);
  const obstacle = new SphereVolume({ center: [0.7, height * Math.cos(0.5), height * Math.sin(0.5)], radius: 0.08 });
  const limits = new JointLimitSet([{ type: 'hinge', axis: [1, 0, 0], min: 0.4, max: 1.3 }]);
  const acceptPose = jointLimitPredicate(limits, (_r, _e, _t, angle) => [q([1, 0, 0], angle)]);
  const solver = new AvoidanceSolver([obstacle], { minClearance: 0.01, complianceMargin: 0, targetRadius: 0.02 });
  const result = solver.solve([0, 0, 0], target, target, 1, 1, 0.02, 0.02, 1, evaluate, {
    searchBudget: 128,
    acceptPose,
  });
  assert.equal(result.status, SolveStatus.Success);
  assert.ok(result.poleAngle >= 0.4 && result.poleAngle <= 1.3);
  assert.ok(limits.accepts([q([1, 0, 0], result.poleAngle)]));
  assert.ok(obstacle.segmentClearance([0, 0, 0], result.elbow, 0.02) >= 0.01 - 1e-6);
  assert.ok(obstacle.segmentClearance(result.elbow, result.target, 0.02) >= 0.01 - 1e-6);
});
test('rejected candidates never advance accepted history, and predicate scratch cannot corrupt the pose', () => {
  const solver = new AvoidanceSolver([], { minClearance: 0, complianceMargin: 0 });
  const args = [[0, 0, 0], [1.4, 0, 0], [1.4, 0, 0], 1, 1, 0, 0, 1, evaluate];
  const first = solver.solve(...args);
  const pole = first.poleAngle;
  assert.equal(first.resolved, true);
  assert.equal(solver.solve(...args, { acceptPose: () => false }).resolved, false);
  const next = solver.solve(...args, {
    acceptPose: (root, elbow, target) => {
      root[0] = 90;
      elbow[0] = 90;
      target[0] = 90;
      return true;
    },
  });
  assert.equal(next.resolved, true);
  assert.equal(next.poleAngle, pole);
  assert.ok(Math.abs(Math.hypot(...next.elbow) - 1) < 1e-6);
  assert.deepEqual(Array.from(next.target), [Math.fround(1.4), 0, 0]);
});
test('bound snapshots, missing rotations and malformed quaternions never admit illegal joints', () => {
  const bounds = { type: 'hinge', axis: [1, 0, 0], min: 0, max: 0.4 };
  const set = new JointLimitSet([bounds, null]);
  bounds.max = 3;
  for (const rotations of [
    [],
    [[0, 0, 0, 0], q([1, 0, 0], 0)],
    [[NaN, 0, 0, 1], q([1, 0, 0], 0)],
    [[0, 0, 0, '1'], q([1, 0, 0], 0)],
  ])
    assert.equal(set.accepts(rotations), false);
  assert.equal(set.accepts([q([1, 0, 0], 0.8), q([1, 0, 0], 0)]), false);
  assert.equal(set.accepts([q([1, 0, 0], 0.2), q([1, 0, 0], 2)]), true);
  assert.throws(() => new JointLimitSet([{ type: 'euler', min: [0, 0, 0], max: [-1, 0, 0] }]));
  assert.throws(() => new JointLimitSet([{ type: 'cone', angle: 4 }]));
  assert.throws(() => new JointLimitSet([{ type: 'hinge', axis: [0, 0, 0] }]));
  assert.throws(
    () => new AvoidanceSolver().solve([0, 0, 0], [1, 0, 0], [1, 0, 0], 1, 1, 0, 0, 1, evaluate, { acceptPose: 4 }),
    /acceptPose/,
  );
});
