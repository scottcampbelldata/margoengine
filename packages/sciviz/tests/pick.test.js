import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatValue,
  heightAt,
  inRegion,
  nearestPoint,
  pointInPolygon,
  rayHeightField,
  screenRay,
  selectPoints,
} from '@margoengine/sciviz/maths';

// Data units straight to clip space: data x, y in [-1, 1] cover a 100 x 100 canvas, y up.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('pointInPolygon follows the even-odd rule, concave shapes included', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(11, 5, square), false);
  // An L: the notch at the top right is outside.
  const ell = [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10];
  assert.equal(pointInPolygon(2, 8, ell), true);
  assert.equal(pointInPolygon(8, 8, ell), false);
  assert.equal(pointInPolygon(8, 2, ell), true);
  assert.equal(inRegion(3, 3, { rect: [5, 5, 1, 1] }), true, 'a rectangle dragged up and left');
  assert.equal(inRegion(6, 3, { rect: [5, 5, 1, 1] }), false);
});

test('nearestPoint finds the closest projected point within the radius, the nearer one on a tie', () => {
  // Screen: (0, 0) -> (50, 50), (0.5, 0) -> (75, 50), the third point in front of the first (nearer to the eye has larger
  // reversed-Z depth, i.e. smaller clip z).
  const positions = [0, 0, 0.1, 0.5, 0, 0, 0, 0, 0];
  assert.deepEqual(nearestPoint(IDENTITY, positions, 100, 100, 74, 51, 8), { index: 1, distance: Math.hypot(1, 1) });
  assert.equal(nearestPoint(IDENTITY, positions, 100, 100, 62, 50, 8), null, 'nothing within 8 px');
  assert.equal(nearestPoint(IDENTITY, positions, 100, 100, 50, 50, 8).index, 2, 'the point nearer the eye wins');
});

test('selectPoints keeps the points inside a box or a lasso', () => {
  const positions = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) positions.push(-0.8 + i * 0.4, -0.8 + j * 0.4, 0);
  // Screen x = (x + 1) * 50: columns at 10, 30, 50, 70, 90. The left half box takes columns 0 and 1 of every row.
  assert.deepEqual(
    [...selectPoints(IDENTITY, positions, 100, 100, { rect: [0, 0, 40, 100] })],
    [0, 1, 5, 6, 10, 11, 15, 16, 20, 21],
  );
  // A triangle lasso around the bottom-left corner (screen y grows downwards: data y -0.8 is screen 90).
  const lasso = selectPoints(IDENTITY, positions, 100, 100, { polygon: [0, 100, 45, 100, 0, 55] });
  assert.deepEqual([...lasso], [0, 1, 5]);
});

test('screenRay unprojects a pixel to a ray from the near plane, away from the eye', () => {
  const ray = screenRay(IDENTITY, 100, 100, 75, 25);
  assert.deepEqual(ray.origin, [0.5, 0.5, 1]);
  assert.deepEqual(ray.direction, [0, 0, -1]);
  assert.equal(screenRay(new Array(16).fill(0), 100, 100, 0, 0), null);
});

test('rayHeightField meets the bilinear surface, skips NaN holes and misses outside the grid', () => {
  // A plane z = x over x, y in [0, 4] with 5 x 5 samples.
  const nx = 5,
    heights = new Float32Array(25);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) heights[j * nx + i] = i;
  const grid = { heights, nx, ny: 5, x0: 0, dx: 1, y0: 0, dy: 1 };
  assert.equal(heightAt(grid, 2.5, 1.2), 2.5);
  assert.ok(Number.isNaN(heightAt(grid, 5, 1)));
  // Slanted ray from (0, 2, 4) towards +x and down: z = 4 - t/sqrt2, x = t/sqrt2; meets z = x at x = 2.
  const s = Math.SQRT1_2;
  const hit = rayHeightField([0, 2, 4], [s, 0, -s], grid);
  assert.ok(Math.abs(hit.x - 2) < 1e-6 && Math.abs(hit.z - 2) < 1e-6, JSON.stringify(hit));
  // Straight down onto (3.25, 1): the height there.
  assert.deepEqual(rayHeightField([3.25, 1, 10], [0, 0, -1], grid), { x: 3.25, y: 1, z: 3.25, t: 6.75 });
  assert.equal(rayHeightField([9, 9, 10], [0, 0, -1], grid), null, 'outside the grid');
  // A NaN hole where the crossing would be: the ray passes through it and misses.
  const holed = Float32Array.from(heights);
  for (let j = 0; j < 5; j++) holed[j * nx + 2] = Number.NaN;
  assert.equal(rayHeightField([0, 2, 4], [s, 0, -s], { ...grid, heights: holed }), null);
});

test('formatValue gives four significant digits with a true minus', () => {
  assert.equal(formatValue(Math.PI), '3.142');
  assert.equal(formatValue(-0.0012346), '−0.001235');
  assert.equal(formatValue(12345678), '1.235e7');
  assert.equal(formatValue(0.00001), '1e-5');
  assert.equal(formatValue(0), '0');
  assert.equal(formatValue(Number.NaN), 'NaN');
});
