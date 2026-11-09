// scripts/support/raster-snap.mjs: the tolerance of packed depth and distance values in
// scripts/material-depth-distance-gpu-check.js. The Radeon 680M (2026-11-08) gave 3.048e-6 against a flat 3e-6 at a
// steep pixel; vertex snapping alone allows more there, which this test proves for the interpolation the GPU does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SNAP, packedTolerance } from '../scripts/support/raster-snap.mjs';

// A seeded generator, so a failure repeats.
let seed = 12345;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const barycentric = ([a, b, c], [x, y]) => {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]),
    u = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / area,
    v = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / area;
  return [u, v, 1 - u - v];
};
// Perspective-correct interpolation as a rasteriser does it: value / w and 1 / w are linear in screen space.
const interpolate = (screen, values, w, point) => {
  const b = barycentric(screen, point),
    over = b.reduce((sum, bi, i) => sum + (bi * values[i]) / w[i], 0),
    inverse = b.reduce((sum, bi, i) => sum + bi / w[i], 0);
  return over / inverse;
};

test('a snapped triangle interpolates the exact value at a point within the snap of the pixel centre', () => {
  for (let trial = 0; trial < 2000; trial++) {
    const screen = [0, 1, 2].map(() => [random() * 64, random() * 64]),
      w = [0, 1, 2].map(() => 0.5 + random() * 10),
      values = [0, 1, 2].map(() => random() * 10 - 5),
      offsets = [0, 1, 2].map(() => [(random() * 2 - 1) * SNAP, (random() * 2 - 1) * SNAP]),
      snapped = screen.map((s, i) => [s[0] + offsets[i][0], s[1] + offsets[i][1]]),
      // A pixel centre inside the snapped triangle.
      weights = [random(), random(), random()],
      total = weights[0] + weights[1] + weights[2],
      centre = [0, 1].map((axis) => snapped.reduce((sum, s, i) => sum + (weights[i] / total) * s[axis], 0));
    const b = barycentric(snapped, centre),
      moved = [0, 1].map((axis) => centre[axis] - b.reduce((sum, bi, i) => sum + bi * offsets[i][axis], 0));
    assert.ok(Math.abs(moved[0] - centre[0]) <= SNAP * (1 + 1e-9));
    assert.ok(Math.abs(moved[1] - centre[1]) <= SNAP * (1 + 1e-9));
    const gpu = interpolate(snapped, values, w, centre),
      exact = interpolate(screen, values, w, moved),
      scale = Math.max(1, ...values.map(Math.abs));
    assert.ok(Math.abs(gpu - exact) <= 1e-9 * scale, `${gpu} != ${exact}`);
  }
});

test('the snap is half a step of eight fractional bits', () => {
  assert.equal(SNAP, 1 / 512);
});

test('the tolerance keeps 3e-6 for a gentle slope and adds the snap for a steep one', () => {
  assert.equal(packedTolerance(0), 3e-6);
  assert.equal(packedTolerance(1e-3), 3e-6);
  // The failing pixel: distance-mirror at 160,120, slope 0.000186 + 0.001927 per pixel, error 3.048e-6.
  const slope = 0.000186310110020238 + 0.0019269515896813694;
  assert.ok(packedTolerance(slope) > 3.048426511248481e-6);
  assert.ok(packedTolerance(slope) < 5.2e-6);
});
