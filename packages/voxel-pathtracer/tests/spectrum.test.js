// Batch 132 audit: the colour matching functions must be Wyman, Sloan and Shirley 2013 eq. 4 with Table 1's numbers.
// The code used to divide by widths rounded to three figures (16.0 for 1 / 0.0624 = 16.03), up to 0.2 % off the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { xyzBar, SPECTRUM } from '../src/spectrum.ts';

// Listing 1 of the paper, transcribed from its text.
const g = (l, mu, below, above) => {
  const t = (l - mu) * (l < mu ? below : above);
  return Math.exp(-0.5 * t * t);
};
const listing = (l) => [
  0.362 * g(l, 442.0, 0.0624, 0.0374) + 1.056 * g(l, 599.8, 0.0264, 0.0323) - 0.065 * g(l, 501.1, 0.049, 0.0382),
  0.821 * g(l, 568.8, 0.0213, 0.0247) + 0.286 * g(l, 530.9, 0.0613, 0.0322),
  1.217 * g(l, 437.0, 0.0845, 0.0278) + 0.681 * g(l, 459.0, 0.0385, 0.0725),
];

test('xyzBar is the published multi-lobe fit at every nanometre from 380 to 780', () => {
  for (let l = 380; l <= 780; l++) {
    const got = xyzBar(l),
      want = listing(l);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-12, `channel ${i} at ${l} nm: ${got[i]} vs ${want[i]}`);
  }
});

test('the WGSL fit carries the same inverse widths', () => {
  for (const k of ['0.0624', '0.0374', '0.0264', '0.0323', '0.049', '0.0382', '0.0213', '0.0247', '0.0613', '0.0322', '0.0845', '0.0278', '0.0385', '0.0725'])
    assert.ok(SPECTRUM.includes(`,${k}`), `inverse width ${k} missing from the shader`);
  assert.match(SPECTRUM, /let t=\(x-mu\)\*select\(k2,k1,x<mu\)/);
});
