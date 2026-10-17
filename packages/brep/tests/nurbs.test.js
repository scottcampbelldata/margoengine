// NURBS evaluation (The NURBS Book, A2.1, A2.3 and the rational quotient rule) against exact answers: the knot span,
// partition of unity, derivatives against finite differences, and the standard 9-point rational circle and cylinder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  basisDerivatives,
  clamped,
  curveAt,
  findSpan,
  knotVector,
  spanBreaks,
  surfaceAt,
} from '../src/geometry/nurbs.ts';

const circleKnots = knotVector([0, 1, 2, 3, 4], [3, 2, 2, 2, 3]);
const ring = (r) => [
  [r, 0],
  [r, r],
  [0, r],
  [-r, r],
  [-r, 0],
  [-r, -r],
  [0, -r],
  [r, -r],
  [r, 0],
];
const weight = (i) => (i % 2 ? Math.SQRT1_2 : 1);

test('knot vectors from STEP knots and multiplicities, and their spans', () => {
  assert.deepEqual(circleKnots, [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  assert.throws(() => knotVector([0, 1], [1]), TypeError);
  assert.throws(() => knotVector([1, 0], [2, 2]), TypeError);
  assert.throws(() => knotVector([0, 1], [0, 2]), TypeError);
  assert.equal(clamped(circleKnots, 2), true);
  assert.equal(clamped([0, 1, 2, 3, 4, 5], 2), false);
  assert.deepEqual(spanBreaks(circleKnots, 2, 8), [0, 1, 2, 3, 4]);
  const U = [0, 0, 0, 1, 2, 3, 3, 3];
  assert.deepEqual(
    [0, 0.5, 1, 1.5, 2.5, 3].map((u) => findSpan(4, 2, u, U)),
    [2, 2, 3, 3, 4, 4],
  );
});

test('basis functions sum to one, their derivatives to zero, and match finite differences', () => {
  const U = knotVector([0, 0.3, 0.5, 1], [4, 1, 2, 4]),
    p = 3,
    n = U.length - p - 2,
    h = 1e-6;
  for (let k = 1; k < 50; k++) {
    const u = k / 50,
      span = findSpan(n, p, u, U),
      [N, dN] = basisDerivatives(span, u, p, U);
    assert.ok(Math.abs(N.reduce((s, v) => s + v, 0) - 1) < 1e-12);
    assert.ok(Math.abs(dN.reduce((s, v) => s + v, 0)) < 1e-9);
    // Away from knots, the same span on both sides: compare with central differences.
    if (findSpan(n, p, u - h, U) !== span || findSpan(n, p, u + h, U) !== span) continue;
    const [Na] = basisDerivatives(span, u - h, p, U),
      [Nb] = basisDerivatives(span, u + h, p, U);
    for (let j = 0; j <= p; j++) assert.ok(Math.abs((Nb[j] - Na[j]) / (2 * h) - dN[j]) < 1e-5);
  }
});

test('the rational 9-point circle: every point on the circle, tangents perpendicular and counter-clockwise', () => {
  const r = 2,
    points = new Float64Array(ring(r).flatMap(([x, y], i) => [x * weight(i), y * weight(i), 0, weight(i)])),
    curve = { degree: 2, points, knots: circleKnots };
  for (let k = 0; k <= 400; k++) {
    const [x, y, z, dx, dy] = curveAt(curve, (4 * k) / 400);
    assert.ok(Math.abs(Math.hypot(x, y) - r) < 1e-12, `radius at ${k}`);
    assert.ok(z === 0);
    assert.ok(Math.abs(x * dx + y * dy) < 1e-9, 'tangent perpendicular to the radius');
    assert.ok(x * dy - y * dx > 0, 'counter-clockwise');
  }
  // Quarter points at the knots.
  const at = (u) => curveAt(curve, u).slice(0, 2);
  for (const [u, expected] of [
    [0, [2, 0]],
    [1, [0, 2]],
    [2, [-2, 0]],
    [3, [0, -2]],
    [4, [2, 0]],
  ])
    at(u).forEach((c, i) => assert.ok(Math.abs(c - expected[i]) < 1e-12));
});

test('a rational B-spline cylinder: points at the radius, derivatives along the circle and the axis', () => {
  const r = 3,
    h = 5,
    nu = 9,
    nv = 2,
    points = new Float64Array(nu * nv * 4);
  ring(r).forEach(([x, y], i) => {
    const w = weight(i);
    points.set([x * w, y * w, 0, w], i * nv * 4);
    points.set([x * w, y * w, h * w, w], (i * nv + 1) * 4);
  });
  const surface = {
    uDegree: 2,
    vDegree: 1,
    nu,
    nv,
    points,
    uKnots: circleKnots,
    vKnots: [0, 0, 1, 1],
  };
  for (let a = 0; a <= 40; a++)
    for (let b = 0; b <= 4; b++) {
      const u = (4 * a) / 40,
        v = b / 4,
        [x, y, z, ux, uy, uz, vx, vy, vz] = surfaceAt(surface, u, v);
      assert.ok(Math.abs(Math.hypot(x, y) - r) < 1e-12);
      assert.ok(Math.abs(z - h * v) < 1e-12);
      assert.ok(Math.abs(x * ux + y * uy) < 1e-9 && Math.abs(uz) < 1e-12, 'Su along the circle');
      assert.ok(Math.abs(vx) < 1e-12 && Math.abs(vy) < 1e-12 && Math.abs(vz - h) < 1e-12, 'Sv along the axis');
    }
});
