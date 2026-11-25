import test from 'node:test';
import assert from 'node:assert/strict';
import { blackbodyChromaticity, blackbodyColor, chromaticityToLinearSRGB } from '../dist/color.js';

// Planck's law integrated at 1 nm steps, 360 to 830 nm, against the CIE 1931 2 degree colour-matching functions
// (CIE 018:2019 Table 6, doi:10.25039/CIE.DS.xvudnb9b), c2 = 1.4387769e-2 m K. Computed once from the CIE table and
// written here, independent of the cubic fit the package uses.
const CIE_TABLE = [
  [1860, 0.54232, 0.41012],
  [1900, 0.53778, 0.4112],
  [3000, 0.43693, 0.40407],
  [4943, 0.34672, 0.3529],
  [6504, 0.31346, 0.32357],
];

test('a blackbody chromaticity follows Planck x CIE 1931 within 0.0004', () => {
  for (const [kelvin, x, y] of CIE_TABLE) {
    const [fx, fy] = blackbodyChromaticity(kelvin);
    assert.ok(Math.abs(fx - x) < 4e-4 && Math.abs(fy - y) < 4e-4, `${kelvin} K: (${fx}, ${fy}) against (${x}, ${y})`);
  }
});

test('blackbodyColor is linear sRGB with its largest channel 1, and a flame is far redder than a 3,000 K bulb', () => {
  const flame = blackbodyColor(1900),
    bulb = blackbodyColor(3000);
  assert.equal(Math.max(...flame), 1);
  assert.ok(flame.every((c) => c >= 0));
  assert.ok(Math.abs(flame[1] - 0.2326) < 0.003 && flame[2] === 0, `1,900 K ${flame}`);
  assert.ok(Math.abs(bulb[1] - 0.4769) < 0.003 && Math.abs(bulb[2] - 0.1537) < 0.003, `3,000 K ${bulb}`);
  const out = new Float32Array(5);
  assert.equal(blackbodyColor(6504, out, 2), out);
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[2] - 1) < 1e-6 && out[3] > 0.94 && out[4] > 0.99);
});

test('chromaticityToLinearSRGB keeps the hue of a colour outside sRGB, and bad input throws', () => {
  const c = chromaticityToLinearSRGB(0.6, 0.39);
  assert.equal(c[0], 1);
  assert.ok(c[1] >= 0 && c[2] === 0);
  for (const kelvin of [1000, 1666, 25001, NaN, '2000']) assert.throws(() => blackbodyColor(kelvin), RangeError);
  for (const [x, y] of [
    [0.3, 0],
    [0.7, 0.4],
    [-0.1, 0.3],
  ])
    assert.throws(() => chromaticityToLinearSRGB(x, y), RangeError);
});
