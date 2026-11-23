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
