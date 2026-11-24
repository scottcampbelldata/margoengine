import assert from 'node:assert/strict';
import test from 'node:test';
import { f16Bits } from '../packages/shared/f16.js';

test('binary16 encoding preserves every finite half value and IEEE special values', { timeout: 5000 }, () => {
  for (let word = 0; word < 65536; word++) {
    const sign = word & 0x8000 ? -1 : 1,
      exponent = (word >>> 10) & 31,
      fraction = word & 1023,
      value = sign * (exponent === 31 ? (fraction ? NaN : Infinity)
        : exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
    if (Number.isNaN(value)) assert.equal(f16Bits(value) & 0x7fff, 0x7e00);
    else assert.equal(f16Bits(value), word, `half word ${word}`);
  }
  for (const [value, expected] of [
    [1 + 2 ** -11, 0x3c00], [1 + 3 * 2 ** -11, 0x3c02],
    [2 ** -25, 0], [3 * 2 ** -25, 2], [65520, 0x7c00],
  ]) {
    for (const signed of [value, -value]) {
      assert.equal(f16Bits(signed), expected | (signed < 0 ? 0x8000 : 0), `ties round to even: ${signed}`);
    }
  }
});

test('scalar half encoding allocates no typed arrays per voxel', { timeout: 5000 }, async (t) => {
  let allocations = 0;
  for (const name of ['Float32Array', 'Uint32Array']) {
    const Native = globalThis[name];
    t.mock.method(globalThis, name, new Proxy(Native, {
      construct(target, args) {
        allocations++;
        return Reflect.construct(target, args);
      },
    }));
  }
  // An independent module instance includes its initialization in the count.
  const { f16Bits: encode } = await import('../packages/shared/f16.js?allocation-proof');
  const initial = allocations;
  for (let i = 0; i < 66 ** 3; i++) assert.equal(encode(0.5), 0x3800);
  assert.equal(allocations - initial, 0, 'a default brick must not allocate two views per voxel');
});
