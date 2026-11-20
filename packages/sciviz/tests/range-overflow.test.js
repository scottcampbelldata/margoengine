// A colour range or data extent past the float32 or double limit keeps finite GPU words (the browser half is
// range-overflow-browser.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeUniform } from '../src/color-lookup.ts';
import { dataToScene } from '@margoengine/sciviz';

const f = Math.fround;
// The WGSL colourFraction in float32 steps: (v / 2 - c / 2) * s + d.
const fraction = (v, [c, s, d]) => f(f(f(f(f(v) * 0.5) - f(f(c) * 0.5)) * f(s)) + f(d));

test('rangeUniform keeps every word finite in float32 and gives the fraction along the range', () => {
  const cases = [
    [[-1e308, 1e308], [0, 1e30, -3e38], [0.5, 0.5, 0.5]],
    [[-1e39, 1e39], [0, 1e38], [0.5, 0.55]],
    [[0.1, 0.3], [0.1, 0.2, 0.3], [0, 0.5, 1]],
    [[-5, 1e10], [-5, 5e9], [0, 0.5]],
    [[3e38, 3.4e38], [3.2e38], [0.5]],
    [[1e300, 2e300], [3e38], [-1]],
  ];
  for (const [range, values, expected] of cases) {
    const words = rangeUniform(range);
    assert.ok(words.every((w) => Number.isFinite(f(w))), `${range}: ${words}`);
    values.forEach((v, i) => {
      const t = fraction(v, words);
      assert.ok(Math.abs(t - expected[i]) < 1e-6, `${range} at ${v}: ${t}, not ${expected[i]}`);
    });
  }
});

test('dataToScene keeps a finite transform for an extent past the double limit', () => {
  for (const bounds of [
    [0, 1, 0, 1, 1e308, 1.7e308],
    [-1.7e308, -1e308, 0, 1, 0, 1],
    [0, 1, -1e308, 1e308, 0, 1],
  ]) {
    const m = dataToScene(bounds, [1, 1, 0.75]);
    assert.ok(m.every(Number.isFinite), `${bounds}: ${[...m]}`);
  }
});
