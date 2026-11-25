import assert from 'node:assert/strict';
import test from 'node:test';
import { CCDSolver } from '@margoengine/animator/ccd';

test('standalone CCD projects a sampled rotation without moving the bind offsets', () => {
  const solver = new CCDSolver([
    [0, 0, 0],
    [0, 0.4, 0],
  ]);
  solver.setLimit(0, { type: 'hinge', axis: [0, 0, 1], min: 0, max: 0.35 });
  const angle = 1.05;
  solver.rotations.set([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]);
  const offsets = solver.offsets.slice();
  solver.projectRotations();
  solver.update();
  assert.ok(Math.abs(2 * Math.atan2(solver.rotations[2], solver.rotations[3]) - 0.35) < 1e-10);
  assert.deepEqual(solver.offsets, offsets);
});

test('a forearm can roll while bent, with independent flexion and axial limits', () => {
  const solver = new CCDSolver([
    [0, 0, 0],
    [0.4, 0, 0],
  ]);
  const hinge = { type: 'hinge', axis: [0, 0, 1], min: 0, max: 1.3 };
  const limit = { ...hinge, twist: { axis: [1, 0, 0], range: [-0.75, 0.65] } };
  const rotation = (bend, roll) => {
    const [a, b] = [bend / 2, roll / 2];
    return [Math.cos(a) * Math.sin(b), Math.sin(a) * Math.sin(b), Math.sin(a) * Math.cos(b), Math.cos(a) * Math.cos(b)];
  };
  solver.setLimit(0, limit);
  const project = (bend, roll) => {
    solver.rotations.set(rotation(bend, roll));
    solver.projectRotations();
    solver.update();
  };
  const close = (a, b) => a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < 1e-10));
  project(1.2, 0.6);
  close(rotation(1.2, 0.6), solver.rotations);
  const flexed = solver.positions.slice(3, 6);
  project(1.2, -0.65);
  close(rotation(1.2, -0.65), solver.rotations);
  close(flexed, solver.positions.slice(3, 6));
  project(-0.4, 1.2);
  close(rotation(0, 0.65), solver.rotations);
  project(1.6, -1.2);
  close(rotation(1.3, -0.75), solver.rotations);
  assert.throws(() => solver.setLimit(0, { ...limit, twist: { ...limit.twist, axis: [0, 0, 1] } }), /perpendicular/);
  assert.throws(() => solver.setLimit(0, { ...limit, twist: { ...limit.twist, range: [1, -1] } }), /twist range/);
  solver.setLimit(1, { ...hinge, max: 0 });
  project(0.8, 0);
  const target = solver.positions.slice(3, 6);
  const result = solver.solve(target, rotation(0.8, 0.62));
  assert.ok(result.reached && result.distance < 1e-10 && result.angle < 1e-6);
  close(rotation(0.8, 0.62), solver.rotations);
});
