// ceilPowerOfTwo and floorPowerOfTwo start from Math.log2 and correct one step when it rounds across an integer.
// Their second correction (a log2 that rounds past the next power of two) can only fire if log2 is not monotone at a
// power of two: v <= 2^m with log2(v) > m, or v >= 2^m with log2(v) < m. This pins that it never is on this platform,
// at every power of two (subnormals included) and 4096 steps either side, which covers every v whose true log2 is
// within one unit in the last place of m; farther out a log2 accurate to under 1 ulp cannot cross m. The mutation
// table lists the mutants of that branch as equivalent on this proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ceilPowerOfTwo, floorPowerOfTwo } from '../dist/mathutils.js';

const f = new Float64Array(1),
  bits = new BigUint64Array(f.buffer);
const step = (x, n) => {
  f[0] = x;
  bits[0] += BigInt(n);
  return f[0];
};

test('Math.log2 is exact at every power of two and never crosses it within 4096 steps', () => {
  let bad = 0;
  for (let m = -1074; m <= 1023; m++) {
    const p = 2 ** m;
    if (Math.log2(p) !== m) bad++;
    for (let i = 1; i <= 4096; i++) {
      const below = step(p, -i),
        above = step(p, i);
      if (below > 0 && Math.log2(below) > m) bad++;
      if (above < Infinity && Math.log2(above) < m) bad++;
    }
  }
  assert.equal(bad, 0);
});

test('ceilPowerOfTwo and floorPowerOfTwo next to powers of two, against a bit-level reference', () => {
  for (let m = -1074; m <= 1023; m += 7) {
    const p = 2 ** m;
    for (const i of [-3, -1, 0, 1, 3]) {
      const v = i ? step(p, i) : p;
      if (!(v > 0 && v < Infinity)) continue;
      // Reference: the power of two of v's exponent field (or of its subnormal top bit), then one step up for ceil.
      let floor = 2 ** -1074;
      while (floor * 2 <= v) floor *= 2;
      assert.equal(floorPowerOfTwo(v), floor, `floor near 2^${m} (${i})`);
      assert.equal(ceilPowerOfTwo(v), floor === v ? v : floor * 2, `ceil near 2^${m} (${i})`);
    }
  }
  assert.equal(ceilPowerOfTwo(0), 0);
  assert.equal(floorPowerOfTwo(0), 0);
  assert.equal(ceilPowerOfTwo(Infinity), Infinity);
  assert.equal(floorPowerOfTwo(Infinity), Infinity);
});
