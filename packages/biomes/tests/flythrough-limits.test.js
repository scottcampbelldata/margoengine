// The flythrough check's limits compare whole timer steps: float noise in a difference of medians never decides
// (Radeon 680M runs gave 0.30000000261 and 0.29999999981 for the same three 0.1 ms steps), and nothing is loosened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settle, withinLimits } from './flythrough-limits.mjs';

test('three timer steps pass whatever the float noise; four fail', () => {
  assert.equal(settle(0.30000000261), 0.3);
  assert.equal(settle(0.29999999981), 0.3);
  assert.equal(withinLimits(1.9 - 1.6, 0.4), true, '1.9 - 1.6 is 0.29999999999999982 in floats');
  assert.equal(withinLimits(0.30000000261, 0.4), true);
  assert.equal(withinLimits(0.29999999981, 0.99999999814), true);
  assert.equal(withinLimits(0.4, 0.5), false);
  assert.equal(withinLimits(0.31, 0.5), false, 'a finer timer keeps its resolution');
  assert.equal(withinLimits(0.2, 1.0000000026), true);
  assert.equal(withinLimits(0.2, 1.1), false);
});
