import test from 'node:test';
import assert from 'node:assert/strict';
import { panWindow, zoomWindow } from '../src/plot-window.ts';

const F32_MAX = 3.4028234663852886e38;

test('a repeated wheel zoom keeps the 2D window wide enough to draw and pan', () => {
  let [lo, hi] = [1, 2];
  for (let i = 0; i < 400; i++) [lo, hi] = zoomWindow(lo, hi, 0.5, 0.3);
  assert.ok(hi - lo >= 2 ** -17, `window ${lo} to ${hi} collapsed`);
  // float32 still tells the two ends apart, as the GPU draws them.
  assert.ok(Math.fround(hi) > Math.fround(lo));
  const [a, b] = panWindow(lo, hi, (hi - lo) / 10);
  assert.ok(a > lo && b > hi, 'the narrowest window still pans');
  // Near zero the floor is absolute.
  [lo, hi] = [-1, 1];
  for (let i = 0; i < 400; i++) [lo, hi] = zoomWindow(lo, hi, 0.5, 0.5);
  assert.ok(hi - lo >= 2 ** -100 && hi > lo);
});

test('a repeated zoom out and pan stop at the largest float32', () => {
  let [lo, hi] = [-1, 3];
  for (let i = 0; i < 2000; i++) [lo, hi] = zoomWindow(lo, hi, 2, 0.25);
  assert.ok(Number.isFinite(Math.fround(lo)) && Number.isFinite(Math.fround(hi)), `${lo} to ${hi}`);
  assert.ok(lo >= -F32_MAX && hi <= F32_MAX && hi > lo);
  for (let i = 0; i < 100; i++) [lo, hi] = panWindow(lo, hi, hi - lo);
  assert.ok(Number.isFinite(Math.fround(hi)) && hi <= F32_MAX && hi > lo);
});

test('zooming a window wider than the largest double keeps it finite', () => {
  const [lo, hi] = zoomWindow(-1e308, 1e308, 0.5, 0.5);
  assert.deepEqual([lo, hi], [-5e307, 5e307]);
  assert.deepEqual(zoomWindow(0, 4, 0.5, 0.5), [1, 3]);
  assert.deepEqual(zoomWindow(0, 4, 2, 0), [0, 8]);
  assert.deepEqual(zoomWindow(0, 4, NaN, 0), [0, 4]);
});
