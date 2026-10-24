// gradeSRGB grades display-space colours the way palette editors do: hue, contrast, brightness, then tint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, gradeSRGB } from '../dist/index.js';

const close = (a, b, eps = 1e-12) => [...a].every((v, i) => Math.abs(v - b[i]) <= eps);

test('an empty grade leaves the colour unchanged', () => {
  assert.ok(close(gradeSRGB([0.2, 0.4, 0.6], {}), [0.2, 0.4, 0.6]));
});

test('contrast, brightness and tint apply in that order', () => {
  // (0.25 - 0.5) * 2 + 0.5 + 0.1 = 0.1, then * (1 + (0.5 - 1) * 1) = 0.05
  const out = gradeSRGB([0.25, 0.25, 0.25], { contrast: 2, brightness: 0.1, tint: [0.5, 1, 1], tintStrength: 1 });
  assert.ok(close(out, [0.05, 0.1, 0.1]));
});

test('hue rotates through HSL of the given sRGB values', () => {
  const out = gradeSRGB([1, 0, 0], { hue: 120 }),
    expected = new Color().setHSL(1 / 3, 1, 0.5, 'srgb-linear').toArray();
  assert.ok(close(out, expected));
  assert.ok(close(out, [0, 1, 0], 1e-9));
});

test('writes into out at offset and refuses non-finite values', () => {
  const out = new Float32Array(6);
  gradeSRGB([1, 1, 1], { brightness: -0.5 }, out, 3);
  assert.deepEqual([...out], [0, 0, 0, 0.5, 0.5, 0.5]);
  assert.throws(() => gradeSRGB([0, 0, 0], { contrast: Number.NaN }), RangeError);
});
