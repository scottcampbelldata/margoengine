import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameDelta } from './clock.js';

test('bootstrap does not seed the animation clock from performance.now', () => {
  assert.equal(frameDelta(undefined, undefined), 0);
  assert.equal(frameDelta(undefined, 399.5), 0);
  assert.equal(frameDelta(399.5, 415.5), .016);
});
test('an earlier presentation timestamp never reaches Margo as a negative delta', () => {
  assert.equal(frameDelta(410, 398), 0);
  assert.equal(frameDelta(410, 1210), .065);
});
