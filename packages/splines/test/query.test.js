import assert from 'node:assert/strict';
import test from 'node:test';
import { Spline } from '../dist/index.js';
import { catmullRomSpline, CubicSpline } from '../dist/kinds.js';
import {
  splineBounds,
  splineExtrema,
  intersectSplinePlane,
  intersectSplineRay,
  intersectSplines,
} from '../dist/query.js';
const near = (a, b, e = 1e-7) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const line = (a, b) => new Spline([a, b]);
test('analytic bounds find unsampled extrema and piecewise joins for every existing kind', () => {
  const c = new CubicSpline(
    [
      [0, 0, 0],
      [1 / 3, 3, 0],
      [2 / 3, 3, 0],
      [1, 0, 0],
    ],
    { divisions: 2 },
  );
  const box = splineBounds(c),
    ext = splineExtrema(c);
  near(box.max[1], 2.25);
  near(ext.y[0], 0.5);
  near(box.min[0], 0);
  near(box.max[0], 1);
  for (const kind of ['catmull-rom', 'bspline', 'kochanek-bartels', 'hermite']) {
    const s = new Spline(
      [
        [0, 1, 2],
        [2, 5, -1],
        [1, -2, 4],
        [6, 0, 0],
      ],
      {
        kind,
        tangents: [
          [0, 2, 0],
          [1, 0, 2],
          [1, -1, 0],
          [0, 1, 0],
        ],
      },
    );
    const b = splineBounds(s);
    for (let i = 0; i <= 1000; i++)
      for (let a = 0; a < 3; a++) {
        const value = s.at(i / 1000)[a];
        assert.ok(value >= b.min[a] - 1e-12 && value <= b.max[a] + 1e-12);
      }
  }
});
test('plane query returns all cubic roots, tangencies, endpoint roots and explicit coplanar spans', () => {
  // y=(t-.2)(t-.5)(t-.8)=t^3-1.5t^2+.66t-.08
  const c = new CubicSpline([
    [0, -0.08, 0],
    [1 / 3, 0.14, 0],
    [2 / 3, -0.14, 0],
    [1, 0.08, 0],
  ]);
  const hit = intersectSplinePlane(c, [0, 2, 0]);
  assert.equal(hit.points.length, 3);
  hit.points.forEach((p, i) => near(p.t, [0.2, 0.5, 0.8][i]));
  const tangent = new CubicSpline([
    [0, 0.09, 0],
    [1 / 3, -0.11, 0],
    [2 / 3, 0.09 - 0.4 + 1 / 3, 0],
    [1, 0.49, 0],
  ]);
  const hits = intersectSplinePlane(tangent, [0, 1, 0]);
  assert.equal(hits.points.length, 1);
  near(hits.points[0].t, 0.3);
  assert.equal(intersectSplinePlane(line([0, 0, 0], [1, 1, 0]), [1, 0, 0]).points.length, 1);
  assert.deepEqual(intersectSplinePlane(c, [0, 0, 1]).overlaps, [{ t0: 0, t1: 1 }]);
  assert.throws(() => intersectSplinePlane(c, [0, 0, 0]), RangeError);
});
test('ray query checks the second transverse coordinate, forward direction and collinear spans', () => {
  const c = line([-1, 0, 0], [1, 0, 0]);
  const hits = intersectSplineRay(c, [0, -2, 0], [0, 2, 0]);
  assert.equal(hits.points.length, 1);
  near(hits.points[0].t, 0.5);
  near(hits.points[0].otherT, 1);
  assert.equal(intersectSplineRay(c, [0, 2, 0], [0, 1, 0]).points.length, 0);
  assert.equal(intersectSplineRay(c, [0, -2, 1], [0, 1, 0]).points.length, 0);
  const collinear = intersectSplineRay(c, [0, 0, 0], [2, 0, 0]);
  assert.equal(collinear.overlaps.length, 1);
  near(collinear.overlaps[0].t0, 0.5);
  near(collinear.overlaps[0].otherT1, 0.5);
  assert.throws(() => intersectSplineRay(c, [0, 0, 0], [0, 0, 0]), RangeError);
});
test('curve queries find multiple crossings, 3D skew rejection, arbitrary tangency and overlap', () => {
  const a = new CubicSpline([
      [0, -0.08, 0],
      [1 / 3, 0.14, 0],
      [2 / 3, -0.14, 0],
      [1, 0.08, 0],
    ]),
    b = line([0, 0, 0], [1, 0, 0]);
  const intersections = intersectSplines(a, b);
  assert.equal(intersections.points.length, 3);
  intersections.points.forEach((p, i) => near(p.t, [0.2, 0.5, 0.8][i]));
  assert.equal(intersectSplines(a, line([0, 0, 0.1], [1, 0, 0.1])).points.length, 0);
  const r = 0.37,
    tangent = new CubicSpline([
      [0, r * r, 0],
      [1 / 3, r * r - (2 * r) / 3, 0],
      [2 / 3, r * r - (4 * r) / 3 + 1 / 3, 0],
      [1, (1 - r) ** 2, 0],
    ]);
  const touch = intersectSplines(tangent, b);
  assert.equal(touch.points.length, 1);
  near(touch.points[0].t, r, 1e-6);
  assert.equal(intersectSplines(a, a).overlaps.length, 1);
  const overlap = intersectSplines(line([0, 0, 0], [3, 0, 0]), line([2, 0, 0], [1, 0, 0]));
  assert.equal(overlap.overlaps.length, 1);
  near(overlap.overlaps[0].t0, 1 / 3);
  near(overlap.overlaps[0].t1, 2 / 3);
  near(overlap.overlaps[0].otherT0, 1);
  near(overlap.overlaps[0].otherT1, 0);
  assert.throws(() => intersectSplines(a, b, { maxWork: 1 }), /limit/);
});
test('periodic seam hits deduplicate joins without missing endpoints', () => {
  const c = catmullRomSpline(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ],
    { closed: true },
  );
  const hit = intersectSplinePlane(c, [1, 0, 0], -2);
  assert.ok(hit.points.some((p) => Math.abs(p.t - 0.25) < 1e-10));
  assert.ok(hit.points.some((p) => Math.abs(p.t - 0.5) < 1e-10));
});

test('curved subspans report continuous overlap and reversed control order preserves geometry', () => {
  const a = new CubicSpline([
    [0, 0, 0],
    [1 / 3, 0, 0],
    [2 / 3, 1 / 3, 0],
    [1, 1, 0],
  ]);
  const b = new CubicSpline([
    [0.25, 1 / 16, 0],
    [5 / 12, 7 / 48, 0],
    [7 / 12, 5 / 16, 0],
    [0.75, 9 / 16, 0],
  ]);
  const hit = intersectSplines(a, b);
  assert.equal(hit.overlaps.length, 1);
  near(hit.overlaps[0].t0, 0.25);
  near(hit.overlaps[0].t1, 0.75);
  const reversed = new CubicSpline([
    [1, 1, 0],
    [2 / 3, 1 / 3, 0],
    [1 / 3, 0, 0],
    [0, 0, 0],
  ]);
  assert.equal(intersectSplines(a, reversed).overlaps[0].otherT0, 1);
});
