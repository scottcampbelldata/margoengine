// primariesToLinearSRGB: linear RGB in any CIE xy primaries and white to linear sRGB (D65), Bradford white adaptation.
// environment's parseHDR uses it for the Radiance PRIMARIES header, so the HDR loader and the P3 matrices share one
// RGB to XYZ derivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { primariesToLinearSRGB, P3_TO_SRGB } from '../dist/color.js';

const near = (got, want, tolerance, label) =>
  got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= tolerance, `${label}[${i}]: ${v} against ${want[i]}`));
const apply = (m, v) => [0, 3, 6].map((r) => m[r] * v[0] + m[r + 1] * v[1] + m[r + 2] * v[2]);

test('the sRGB primaries give the identity', () => {
  near(
    primariesToLinearSRGB([0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329]),
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    1e-12,
    'sRGB',
  );
});

test('Display P3 (D65 white, so no adaptation) matches P3_TO_SRGB', () => {
  near(primariesToLinearSRGB([0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329]), P3_TO_SRGB, 1e-12, 'P3');
});

test('ACEScg red adapts its D60 white to D65 and keeps white white', () => {
  const m = primariesToLinearSRGB([0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767]);
  near(apply(m, [1, 0, 0]), [1.70505, -0.13026, -0.024], 2e-3, 'ACEScg red');
  near(apply(m, [1, 1, 1]), [1, 1, 1], 1e-5, 'ACEScg white');
});

test('primaries that span no colour space give entries that are not finite', () => {
  assert.ok(!primariesToLinearSRGB([0, 0, 0, 0, 0, 0, 0, 0]).every(Number.isFinite));
});
