import assert from 'node:assert/strict';
import test from 'node:test';
import { Spline } from '../dist/index.js';
import { catmullRomSpline, CubicSpline, splineDerivative, splineCurvature, splineTorsion } from '../dist/kinds.js';

const near = (a, b, eps = 1e-10) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${i}: ${v} != ${b[i]}`));
};
// Independent Barry-Goldman interpolation pyramid from the paper's Figure 3.
function reference(points, alpha, u) {
  const knots = [0];
  for (let i = 1; i < 4; i++)
    knots.push(knots[i - 1] + Math.hypot(...points[i].map((v, a) => v - points[i - 1][a])) ** alpha);
  const t = knots[1] + u * (knots[2] - knots[1]);
  const mix = (a, b, lo, hi) => a.map((v, i) => ((hi - t) * v + (t - lo) * b[i]) / (hi - lo));
  const a = [0, 1, 2].map((i) => mix(points[i], points[i + 1], knots[i], knots[i + 1]));
  return mix(mix(a[0], a[1], knots[0], knots[2]), mix(a[1], a[2], knots[1], knots[3]), knots[1], knots[2]);
}
test('centripetal default and chordal match the independent nonuniform interpolation pyramid', () => {
  const p = [
    [-8, 2, 1],
    [0, 0, 0],
    [0.1, 1, 2],
    [12, -3, 4],
  ];
  for (const [kind, alpha] of [
    ['centripetal', 0.5],
    ['chordal', 1],
    ['uniform', 0],
  ]) {
    const curve = catmullRomSpline(p, { parameterization: kind });
    for (const u of [0, 0.13, 0.5, 0.87, 1]) near(curve.at((1 + u) / 3), reference(p, alpha, u));
    for (let i = 0; i < 4; i++) near(curve.at(i / 3), p[i]);
  }
  const a = catmullRomSpline(p),
    b = catmullRomSpline(p, { parameterization: 'centripetal' });
  near(a.points, b.points);
  const uniform = new Spline(p);
  near(catmullRomSpline(p, { parameterization: 'uniform' }).at(0.47), uniform.at(0.47));
});
test('analytic derivatives, unit tangent, curvature and torsion match known polynomials', () => {
  // r(t) = (t, t^2, t^3), one Bezier piece.
  const curve = new CubicSpline([
    [0, 0, 0],
    [1 / 3, 0, 0],
    [2 / 3, 1 / 3, 0],
    [1, 1, 1],
  ]);
  for (const t of [0, 0.2, 0.5, 1]) {
    near(splineDerivative(curve, t), [1, 2 * t, 3 * t * t]);
    near(splineDerivative(curve, t, 2), [0, 2, 6 * t]);
    near(splineDerivative(curve, t, 3), [0, 0, 6]);
    const n = Math.hypot(1, 2 * t, 3 * t * t);
    near(curve.tangent(t), [1 / n, (2 * t) / n, (3 * t * t) / n]);
  }
  assert.equal(splineCurvature(curve, 0), 2);
  assert.equal(splineTorsion(curve, 0), 3);
  const out = new Float64Array(3);
  assert.equal(splineDerivative(curve, 0.5, 1, out), out);
  const parabola = new Spline(
    [
      [0, 0, 0],
      [1, 0, 0],
    ],
    {
      kind: 'hermite',
      tangents: [
        [1, 0, 0],
        [1, 2, 0],
      ],
    },
  );
  near(splineDerivative(parabola, 0), [1, 0, 0]);
  for (const kind of ['catmull-rom', 'bspline', 'kochanek-bartels']) {
    const c = new Spline(
      [
        [0, 0, 0],
        [1, 2, 0],
        [3, -1, 2],
        [5, 0, 0],
      ],
      { kind },
    );
    const t = 0.42,
      h = 1e-5;
    const before = Float64Array.from(c.at(t - h)),
      after = Float64Array.from(c.at(t + h));
    near(
      splineDerivative(c, t),
      after.map((v, a) => (v - before[a]) / (2 * h)),
      1e-7,
    );
  }
});
test('global derivative scaling, periodic seam and coincident knots remain defined', () => {
  const p = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 2, 0],
    [0, 2, 0],
  ];
  const c = catmullRomSpline(p, { closed: true });
  assert.ok(c instanceof Spline);
  assert.equal(c.closed, true);
  near(c.at(0), c.at(1));
  near(splineDerivative(c, 0), splineDerivative(c, 1));
  near(c.tangent(0), c.tangent(1));
  const line = catmullRomSpline([
    [0, 0, 0],
    [2, 0, 0],
    [4, 0, 0],
  ]);
  near(splineDerivative(line, 0.2), [4, 0, 0]);
  assert.equal(splineCurvature(line, 0.2), 0);
  const repeated = catmullRomSpline([
    [0, 0, 0],
    [0, 0, 0],
    [1, 2, 0],
  ]);
  for (let i = 0; i <= 50; i++) assert.ok([...repeated.at(i / 50)].every(Number.isFinite));
  const constant = catmullRomSpline([
    [0, 0, 0],
    [0, 0, 0],
  ]);
  assert.equal(constant.length, 0);
  assert.ok(Number.isNaN(splineCurvature(constant, 0.5)));
  assert.ok(Number.isNaN(splineTorsion(constant, 0.5)));
  assert.throws(() => catmullRomSpline(p, { parameterization: 'wrong' }), RangeError);
  assert.throws(() => splineDerivative(c, NaN), RangeError);
  assert.throws(() => splineDerivative(c, 0.5, 4), RangeError);
  assert.throws(
    () =>
      new CubicSpline(
        [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
          [3, 0, 0],
        ],
        { closed: true },
      ),
    RangeError,
  );
});
