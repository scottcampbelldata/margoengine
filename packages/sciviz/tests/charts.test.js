import test from 'node:test';
import assert from 'node:assert/strict';
import { barRects, heatmapRects, histogram, rectAt } from '@margoengine/sciviz/maths';

test('histogram counts into equal bins, the last bin closed, NaN skipped', () => {
  const h = histogram([1, 2, 2, 3, Number.NaN], { bins: 2 });
  assert.deepEqual([...h.edges], [1, 2, 3]);
  assert.deepEqual([...h.counts], [1, 3], 'values on an inner edge go up; the maximum stays in the last bin');
  const ranged = histogram([0, 5, 10, 20], { bins: 2, range: [0, 10] });
  assert.deepEqual([...ranged.counts], [1, 2], 'values outside the range are not counted');
  const density = histogram([0, 1, 1, 2], { bins: 2, density: true });
  assert.equal(density.counts[0] * 1 + density.counts[1] * 1, 1, 'density areas sum to 1');
  assert.throws(() => histogram([1], { bins: 0 }), RangeError);
  assert.throws(() => histogram([1], { range: [1, 1] }), RangeError);
});

test("histogram bins: 'auto' follows Freedman-Diaconis, and Sturges when the spread is zero", () => {
  // 1000 values evenly over [0, 1]: IQR 0.5, width 2 * 0.5 / 1000^(1/3) = 0.1, so 10 bins.
  const even = Array.from({ length: 1000 }, (_, i) => i / 999);
  assert.equal(histogram(even).counts.length, 10);
  // All equal: IQR 0, Sturges gives ceil(log2(8) + 1) = 4 bins over the widened range.
  const flat = histogram([5, 5, 5, 5, 5, 5, 5, 5]);
  assert.equal(flat.counts.length, 4);
  assert.deepEqual([flat.edges[0], flat.edges[4]], [4.5, 5.5]);
});

test('barRects centre bars on x, 0.8 of the smallest gap wide, from the base to y', () => {
  const r = barRects([0, 1, 3], [2, -1, Number.NaN]);
  assert.deepEqual([...r.slice(0, 4)], [-0.4, 0, 0.4, 2].map(Math.fround));
  assert.deepEqual([...r.slice(4, 8)], [0.6, -1, 1.4, 0].map(Math.fround), 'a negative bar hangs below the base');
  assert.equal(r[9], r[11], 'a NaN height draws nothing');
  assert.deepEqual([...barRects([2], [5], { width: 1, base: 1 })], [1.5, 1, 2.5, 5]);
  assert.throws(() => barRects([1, 2], [1]), RangeError);
});

test('heatmapRects puts cell centres on the x and y ranges; NaN cells are empty; rectAt finds cells', () => {
  const r = heatmapRects([1, 2, 3, Number.NaN], 2, 2, [0, 1], [0, 1]);
  assert.deepEqual([...r.slice(0, 4)], [-0.5, -0.5, 0.5, 0.5]);
  assert.deepEqual([...r.slice(12, 16)], [1, 1, 1, 1], 'the NaN cell collapses to its centre');
  assert.equal(rectAt(r, 0.9, 0.1), 1);
  assert.equal(rectAt(r, 0.1, 0.9), 2);
  assert.equal(rectAt(r, 1, 1), -1, 'nothing in the NaN cell');
  assert.equal(rectAt(r, 3, 3), -1);
});
