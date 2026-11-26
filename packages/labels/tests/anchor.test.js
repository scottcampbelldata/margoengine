import test from 'node:test';
import assert from 'node:assert/strict';
import { boxAnchorPoint } from '@margoengine/labels';

const min = [-1, 0, 2],
  max = [3, 4, 6];
test('face names, corners, edges and centre land on the box', () => {
  assert.deepEqual(boxAnchorPoint(min, max), [1, 2, 4]);
  assert.deepEqual(boxAnchorPoint(min, max, 'top'), [1, 4, 4]);
  assert.deepEqual(boxAnchorPoint(min, max, 'left'), [-1, 2, 4]);
  assert.deepEqual(boxAnchorPoint(min, max, 'front'), [1, 2, 6]);
  assert.deepEqual(boxAnchorPoint(min, max, [1, 1, 1]), max);
  assert.deepEqual(boxAnchorPoint(min, max, [-1, -1, -1]), min);
  assert.deepEqual(boxAnchorPoint(min, max, [1, 1, 0]), [3, 4, 4]);
});
test('a world matrix moves the anchor with the box and out is reused', () => {
  // Translate by (10, 0, 0) after scaling by 2 (column-major).
  const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1];
  const out = [0, 0, 0];
  assert.equal(boxAnchorPoint(min, max, [1, 1, 1], m, out), out);
  assert.deepEqual(out, [16, 8, 12]);
});
test('bad boxes and anchors throw a RangeError that names the fix', () => {
  assert.throws(() => boxAnchorPoint(max, min), (e) => e instanceof RangeError && /fix the arguments/.test(e.message));
  assert.throws(() => boxAnchorPoint(min, max, 'middle'), RangeError);
  assert.throws(() => boxAnchorPoint(min, max, [2, 0, 0]), RangeError);
  assert.throws(() => boxAnchorPoint([NaN, 0, 0], max), RangeError);
});
