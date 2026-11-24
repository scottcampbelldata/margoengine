import test from 'node:test';
import assert from 'node:assert/strict';
import { SplatSet } from '../dist/set.js';

const cloud = (n, sh) => ({
  positions: new Float32Array(n * 3).map((_, i) => i * 0.01),
  covariances: new Float32Array(n * 6).map((_, i) => ([0, 3, 5].includes(i % 6) ? 0.1 : 0)),
  colors: new Float32Array(n * 4).fill(0.5),
  ...(sh ? { sphericalHarmonics: new Float32Array(n * sh * 3) } : {}),
});

test('SplatSet hands out free ranges, reuses and merges them, and refuses what does not fit', () => {
  const set = new SplatSet({ capacity: 10 });
  assert.equal(set.cloud.count, 10);
  const a = set.add(cloud(3)),
    b = set.add(cloud(4)),
    c = set.add(cloud(3));
  assert.deepEqual([a.first, b.first, c.first], [0, 3, 7]);
  assert.equal(set.used, 10);
  assert.throws(() => set.add(cloud(1)), RangeError, 'full');
  b.remove();
  b.remove();
  assert.equal(set.used, 6);
  assert.equal(set.add(cloud(2)).first, 3, 'first fit');
  a.remove();
  // Free: [0,3) and [5,7) apart; a 4-splat cloud fits neither until they merge.
  assert.throws(() => set.add(cloud(4)), RangeError, 'fragmented');
  set.clouds.find((m) => m.first === 3).remove();
  assert.equal(set.add(cloud(7)).first, 0, 'the freed ranges merged into one of 7');
  assert.deepEqual(set.clouds.map((m) => [m.first, m.count]), [[7, 3], [0, 7]]);
  set.dispose();
  assert.throws(() => set.add(cloud(1)), { code: 'disposed' });
  assert.throws(() => c.setMatrix(null), { code: 'disposed' });
});

test('SplatSet checks capacity, SH and the matrix', () => {
  assert.throws(() => new SplatSet({ capacity: 0 }), RangeError);
  assert.throws(() => new SplatSet({ capacity: 3_000_001 }), RangeError);
  assert.throws(() => new SplatSet({ coefficients: 2 }), RangeError);
  const set = new SplatSet({ capacity: 8, coefficients: 4 });
  assert.throws(() => set.add(cloud(2)), RangeError, 'no SH in a set with SH');
  assert.equal(set.used, 0, 'a refused cloud takes no range');
  const m = set.add(cloud(2, 4), { matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1] });
  m.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.throws(() => m.setMatrix([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), RangeError, 'a singular matrix');
  m[Symbol.dispose]();
  assert.equal(set.used, 0);
  set.dispose();
});
