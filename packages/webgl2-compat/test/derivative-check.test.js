import test from 'node:test';
import assert from 'node:assert/strict';
import { derivativeExpected } from './derivative-check.mjs';

const pixel = (values, x, y) => values.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4);

test('derivativeBranch expectation: the differences native WebGPU returned on an RTX A6000 (KB-AMD-HELPERDERIV1)', () => {
  const e = derivativeExpected();
  assert.deepEqual(Object.keys(e).sort(), [
    'dpdx',
    'dpdxCoarse',
    'dpdxFine',
    'dpdy',
    'dpdyCoarse',
    'dpdyFine',
    'fwidth',
    'fwidthCoarse',
    'fwidthFine',
    'helper',
    'vector',
  ]);
  // Read back from the page on the RTX A6000, native and layer alike (2026-11-27).
  assert.deepEqual(pixel(e.helper, 0, 0), [1, 3, 1, 1]);
  assert.deepEqual(pixel(e.helper, 2, 0), [3, 3, 9, 1]);
  assert.deepEqual(pixel(e.helper, 5, 3), [5, 9, 15, 1]);
  assert.deepEqual(pixel(e.vector, 6, 0), [14, 0, 7, 1]);
  assert.deepEqual(pixel(e.dpdx, 3, 1), [3, 0, 3, 1]);
  assert.deepEqual(pixel(e.dpdy, 0, 2), [9, 0, 9, 1]);
  assert.deepEqual(pixel(e.fwidth, 7, 3), [16, 0, 32, 1]);
  // The pixels the branch skips.
  assert.deepEqual(pixel(e.helper, 1, 0), [-1, -1, -1, -1]);
  // What the AMD Radeon's native WebGPU returned for the same pixel is not the expectation.
  assert.notDeepEqual(pixel(e.helper, 2, 0), [-3.5, 3, -10.5, 1]);
  for (const values of Object.values(e)) assert.equal(values.length, 8 * 4 * 4);
});
