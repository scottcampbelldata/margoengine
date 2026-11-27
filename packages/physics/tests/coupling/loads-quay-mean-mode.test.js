import assert from 'node:assert/strict';
import test from 'node:test';
import { QuayPotential } from '../../dist/loads.js';

test('the Robin solve balances the signed volume independently in each closed basin', () => {
  const nx = 48;
  const nz = 25;
  const cellSize = 0.5;
  const plane = nx * nz;
  const depths = [0, 0.08, 0.32, 0.97];
  const count = plane * (depths.length - 1);
  const divide = nx / 2 - 1;
  const openX = new Float64Array(count).fill(1);
  for (let i = divide; i < count; i += nx) openX[i] = 0;
  const surface = Float64Array.from({ length: plane }, (_, i) => {
    const x = i % nx;
    const z = Math.floor(i / nx);
    return 30 * Math.sin(0.31 * x + 0.47 * z) + 85 * Math.sin(0.92 * x - 0.14 * z);
  });
  const source = new Float64Array(count);
  source[plane + 11 * nx + 10] = 0.75;
  source[2 * plane + 19 * nx + 8] = -0.25;
  source[plane + 4 * nx + 31] = -0.625;
  source[2 * plane + 9 * nx + 33] = 0.375;
  const operator = new QuayPotential({ cells: [nx, nz], cellSize, depths, openX, horizontalOrder: 4 });
  const rise = new Float64Array(plane);
  const bulk = new Float64Array(count);
  for (const forcing of [undefined, source]) {
    operator.project(surface, rise, forcing, 0.003, bulk);
    const totals = [0, 0];
    for (let i = 0; i < plane; i++) totals[i % nx > divide ? 1 : 0] += rise[i] * cellSize ** 2;
    const target = forcing ? [0.5, -0.25] : [0, 0];
    for (let side = 0; side < 2; side++) {
      assert.ok(Math.abs(totals[side] - target[side]) < 1e-10, `${totals[side]} differs from ${target[side]}`);
    }
    for (let i = divide; i < count; i += nx) assert.equal(operator.faceFlux('x', i, bulk), 0);
  }
});
