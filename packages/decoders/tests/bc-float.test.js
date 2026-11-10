import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBCFloat } from '../dist/bc.js';

test('float BC4/BC5 preserves signed endpoints and missing channel defaults', () => {
  const block = new Uint8Array([129, 127, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...decodeBCFloat('bc4-r-snorm', block, 4, 4).data.slice(0, 4)], [-1, 0, 0, 1]);
  const both = new Uint8Array([...block, 127, 129, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...decodeBCFloat('bc5-rg-snorm', both, 4, 4).data.slice(0, 4)], [-1, 1, 0, 1]);
  block[0] = 128;
  assert.equal(decodeBCFloat('bc4-r-unorm', block, 4, 4).data[0], Math.fround(128 / 255));
});
test('BC6H float decode retains radiance above one and negative values without sRGB or clamping', () => {
  // BPTC mode 11: two explicit RGB endpoints, ten bits per component, all indices zero.
  const encode = (endpoint) => {
    const b = new Uint8Array(16);
    let bit = 0;
    const put = (value, n) => {
      for (let i = 0; i < n; i++, bit++) b[bit >> 3] |= ((value >> i) & 1) << (bit & 7);
    };
    put(3, 5);
    for (let i = 0; i < 6; i++) put(endpoint, 10);
    return b;
  };
  const positive = decodeBCFloat('bc6h-rgb-ufloat', encode(600), 4, 4);
  assert.ok(positive.data[0] > 1);
  assert.equal(positive.data[3], 1);
  const negative = decodeBCFloat('bc6h-rgb-float', encode(800), 4, 4);
  assert.ok(negative.data[0] < 0);
  assert.throws(() => decodeBCFloat('bc6h-rgb-float', new Uint8Array(15), 4, 4), /too few/);
});
