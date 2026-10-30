import test from 'node:test';
import assert from 'node:assert/strict';
import { preetham } from '@margoengine/sky/preetham';
import { preethamRGB, preethamXyY } from './preetham-reference.js';

const level = [0, 0.01 / Math.hypot(1, 0.01), -1 / Math.hypot(1, 0.01)],
  noon = [0, 1, 0];

test('the Preetham fit alone puts the noon horizon on the pink side of the daylight locus', () => {
  // The cause of the pink band: y from the paper's distribution sits 0.013 below the CIE daylight locus at the
  // horizon (turbidity 2), so red exceeds green there. Physical daylight does not fall on that side.
  const { x, y } = preethamXyY(level, noon, 2, { locus: false }),
    rgb = preethamRGB(level, noon, 2, { locus: false });
  assert.ok(-3 * x * x + 2.87 * x - 0.275 - y > 0.01, `y ${y} at x ${x}`);
  assert.ok(rgb[0] > rgb[1], `fit rgb ${rgb}`);
});

test('the day sky keeps its chromaticity off the pink side of the daylight locus', () => {
  assert.match(preetham.wgsl, /let chroma=max\(-3\.0\*x\*x\+2\.87\*x-0\.275,/);
  // Clear to hazy: red never above green (the pink tint); a clear sky's horizon also stays bluest.
  for (const t of [2, 3, 5, 10]) {
    const rgb = preethamRGB(level, noon, t);
    assert.ok(rgb[0] <= rgb[1] && (t > 5 || rgb[1] <= rgb[2]), `turbidity ${t}: rgb ${rgb}`);
  }
  // Where the fit is already on the daylight side (the zenith at noon), the sky is unchanged.
  assert.deepEqual(preethamRGB(noon, noon, 2), preethamRGB(noon, noon, 2, { locus: false }));
});

test('the day sky reads turbidity below 2 as 2 instead of drawing black', () => {
  // The fit's luminance normaliser 1 + A e^B (A = 0.1787 T - 1.463, B = -0.3554 T + 0.4275) is negative below about 1.65.
  const normaliser = (t) => 1 + (0.1787 * t - 1.463) * Math.exp(-0.3554 * t + 0.4275);
  assert.ok(normaliser(1) < 0 && normaliser(1.6) < 0 && normaliser(2) > 0.1);
  assert.match(preetham.wgsl, /let t=max\(2\.0,frame\.settings\.z\);/);
  assert.deepEqual(preethamRGB(level, noon, 1), preethamRGB(level, noon, 2));
});
