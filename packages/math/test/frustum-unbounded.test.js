// Frustum.intersectsBox on a box that is unbounded (or empty) along an axis a plane does not use: a zero normal
// component must add nothing, not 0 * Infinity (NaN), which kept boxes that lie fully outside the frustum.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Frustum, Plane, Vector3 } from '../dist/index.js';

const inf = Infinity;
const v3 = (a) => new Vector3(...a);
const box = (lo, hi) => new Box3(v3(lo), v3(hi));
const plane = (n, c) => new Plane(v3(n), c);

// The cube -1..1 on every axis, planes facing inward (normal . p + constant >= 0 inside).
const cube = () =>
  new Frustum(
    plane([1, 0, 0], 1),
    plane([-1, 0, 0], 1),
    plane([0, 1, 0], 1),
    plane([0, -1, 0], 1),
    plane([0, 0, 1], 1),
    plane([0, 0, -1], 1),
  );

test('Frustum.intersectsBox drops a box unbounded along x and z that lies above the frustum', () => {
  const f = cube();
  assert.equal(f.intersectsBox(box([-inf, 10, -inf], [inf, 20, inf])), false);
  assert.equal(f.intersectsBox(box([-inf, -20, 0], [0, -10, 0.5])), false);
  assert.equal(f.intersectsBox(box([0, 0, 5], [0.5, inf, inf])), false);
  assert.equal(f.intersectsBox(box([-inf, -inf, -inf], [-3, inf, inf])), false);
});

test('Frustum.intersectsBox keeps an unbounded box that crosses the frustum', () => {
  const f = cube();
  assert.equal(f.intersectsBox(box([-inf, -0.5, -inf], [inf, 0.5, inf])), true);
  assert.equal(f.intersectsBox(box([-inf, -inf, -inf], [inf, inf, inf])), true);
  assert.equal(f.intersectsBox(box([0.5, -inf, 0], [inf, inf, 0.25])), true);
});

test('Frustum.intersectsBox treats a negative-zero normal component as zero', () => {
  const f = new Frustum(
    plane([-0, -1, 0], 1),
    plane([0, 1, -0], 1),
    plane([1, -0, 0], 1),
    plane([-1, 0, -0], 1),
    plane([-0, 0, 1], 1),
    plane([0, -0, -1], 1),
  );
  assert.equal(f.intersectsBox(box([-inf, 10, -inf], [inf, 20, inf])), false);
  assert.equal(f.intersectsBox(box([-inf, 0, -inf], [inf, 0.5, inf])), true);
});

test('Frustum.intersectsBox drops an empty box (min above max)', () => {
  assert.equal(cube().intersectsBox(new Box3()), false);
  assert.equal(cube().intersectsBox(box([inf, inf, inf], [-inf, -inf, -inf])), false);
});

test('Frustum.intersectsBox keeps finite results unchanged for a tilted frustum', () => {
  // A slanted plane x + y <= 1 (normal (-1, -1, 0) / sqrt 2) with the cube's other planes.
  const s = Math.SQRT1_2;
  const f = cube();
  f.planes[3].set(v3([-s, -s, 0]), s);
  assert.equal(f.intersectsBox(box([0.6, 0.6, 0], [0.9, 0.9, 0.1])), false);
  assert.equal(f.intersectsBox(box([0.4, 0.4, 0], [0.9, 0.9, 0.1])), true);
  assert.equal(f.intersectsBox(box([0.6, 0.6, -inf], [0.9, 0.9, inf])), false);
});
