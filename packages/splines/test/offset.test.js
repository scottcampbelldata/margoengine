import assert from 'node:assert/strict';
import test from 'node:test';
import { Spline } from '../dist/index.js';
import { CubicSpline, catmullRomSpline, splineDerivative } from '../dist/kinds.js';
import { offsetSplineAt, offsetSpline, reverseSpline } from '../dist/offset.js';
const near = (a, b, e = 1e-9) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= e, `${i}: ${v} != ${b[i]}`));
test('exact point offsets have signed constant distance perpendicular to source and plane normal', () => {
  const source = new CubicSpline([
      [0, 0, 0],
      [1, 3, 1],
      [4, -1, 2],
      [6, 0, 3],
    ]),
    out = new Float64Array(3);
  for (const distance of [-2, 0, 2])
    for (const t of [0, 0.1, 0.4, 0.8, 1]) {
      const p = Float64Array.from(source.at(t)),
        q = offsetSplineAt(source, t, distance, [0, 0, 2], out),
        d = splineDerivative(source, t);
      assert.equal(q, out);
      const delta = q.map((v, a) => v - p[a]);
      assert.ok(Math.abs(Math.hypot(...delta) - Math.abs(distance)) < 1e-12);
      assert.ok(Math.abs(delta[0] * d[0] + delta[1] * d[1] + delta[2] * d[2]) < 1e-12);
      assert.ok(Math.abs(delta[2]) < 1e-12);
    }
  near(
    offsetSplineAt(
      new Spline([
        [0, 0, 0],
        [10, 0, 0],
      ]),
      0.5,
      2,
    ),
    [5, 2, 0],
  );
  near(
    offsetSplineAt(
      new Spline([
        [0, 0, 0],
        [10, 0, 0],
      ]),
      0.5,
      -2,
    ),
    [5, -2, 0],
  );
});
test('adaptive cubic offsets verify an interval error bound between all fit samples', () => {
  const source = new CubicSpline([
    [0, 0, 0],
    [1, 4, 0],
    [5, -3, 0],
    [7, 1, 0],
  ]);
  const tolerance = 0.002,
    result = offsetSpline(source, 0.7, { tolerance }),
    count = result.ranges.length / 2;
  assert.ok(count > 1);
  assert.ok(result.work > 0);
  assert.ok(result.maxError <= tolerance);
  for (let i = 0; i < count; i++)
    for (let j = 0; j <= 40; j++) {
      const t0 = result.ranges[i * 2],
        t1 = result.ranges[i * 2 + 1];
      if (t0 === t1) continue;
      const u = j / 40,
        p = result.spline.at((i + u) / count),
        exact = offsetSplineAt(source, t0 + (t1 - t0) * u, 0.7);
      assert.ok(Math.hypot(...p.map((v, a) => v - exact[a])) <= result.maxError + 1e-11);
    }
  const straight = offsetSpline(
    new Spline([
      [0, 0, 0],
      [10, 0, 0],
    ]),
    2,
  );
  assert.equal(straight.ranges.length, 2);
  near(straight.spline.at(0.35), [3.5, 2, 0]);
});
test('closed offsets retain the seam and corners have explicit bevel join ranges', () => {
  const closed = catmullRomSpline(
    [
      [0, 0, 0],
      [4, 0, 0],
      [4, 4, 0],
      [0, 4, 0],
    ],
    { closed: true },
  );
  const result = offsetSpline(closed, 0.3, { tolerance: 0.005 });
  assert.equal(result.spline.closed, true);
  near(result.spline.at(0), result.spline.at(1));
  const corner = new CubicSpline([
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    [3, 0, 0],
    [3, 1, 0],
    [3, 2, 0],
    [3, 3, 0],
  ]);
  const joined = offsetSpline(corner, 0.5);
  assert.deepEqual([...joined.ranges], [0, 0.5, 0.5, 0.5, 0.5, 1]);
  near(joined.spline.at(1 / 3), [3, 0.5, 0]);
  near(joined.spline.at(2 / 3), [2.5, 0, 0]);
});
test('reverse preserves each kind exactly, owns its controls and reverses the global parameter', () => {
  const p = [
    [0, 0, 0],
    [2, 4, 1],
    [3, -1, 3],
    [8, 0, 0],
  ];
  const curves = ['catmull-rom', 'bspline', 'kochanek-bartels', 'hermite'].map(
    (kind) =>
      new Spline(p, {
        kind,
        tangents: [
          [1, 0, 0],
          [2, 1, 0],
          [1, 1, 1],
          [1, 0, 0],
        ],
      }),
  );
  curves.push(
    catmullRomSpline(p),
    catmullRomSpline(p, { closed: true, parameterization: 'chordal' }),
    new CubicSpline(p),
  );
  for (const curve of curves) {
    const reversed = reverseSpline(curve),
      twice = reverseSpline(reversed);
    assert.equal(reversed.closed, curve.closed);
    for (let j = 0; j <= 100; j++) {
      const t = j / 100;
      near(reversed.at(t), curve.at(1 - t), 2e-12);
      near(twice.at(t), curve.at(t), 2e-12);
    }
    assert.notEqual(reversed.points, curve.points);
  }
});
test('zero offsets preserve stationary curves; undefined normals and exhausted budgets reject explicitly', () => {
  const stationary = new Spline([
    [0, 0, 0],
    [0, 0, 0],
  ]);
  near(offsetSplineAt(stationary, 0.5, 0), [0, 0, 0]);
  assert.equal(offsetSpline(stationary, 0).spline.length, 0);
  assert.throws(() => offsetSplineAt(stationary, 0.5, 1), /undefined/);
  assert.throws(
    () =>
      offsetSplineAt(
        new Spline([
          [0, 0, 0],
          [0, 0, 1],
        ]),
        0.5,
        1,
      ),
    /undefined/,
  );
  assert.throws(() => offsetSplineAt(stationary, 0.5, 0, [0, 0, 0]), /normal/);
  const curved = new CubicSpline([
    [0, 0, 0],
    [1, 4, 0],
    [5, -3, 0],
    [7, 1, 0],
  ]);
  assert.throws(() => offsetSpline(curved, 1, { maxDepth: 0, tolerance: 1e-8 }), /depth/);
  assert.throws(() => offsetSpline(curved, 1, { maxWork: 1 }), /work limit/);
  assert.throws(() => offsetSpline(curved, 1, { maxSegments: 1 }), /segment limit/);
});

test('negative offsets in another plane retain distance, enclosure and source independence', () => {
  const source = new CubicSpline([
      [0, 0, 0],
      [1, 0, 3],
      [4, 0, -1],
      [6, 0, 0],
    ]),
    before = source.points.slice();
  const result = offsetSpline(source, -0.4, { normal: [0, 3, 0], tolerance: 0.003 });
  const n = result.ranges.length / 2;
  for (let i = 0; i < n; i++)
    for (const u of [0.13, 0.29, 0.73, 0.91]) {
      const t = result.ranges[i * 2] + u * (result.ranges[i * 2 + 1] - result.ranges[i * 2]);
      const expected = offsetSplineAt(source, t, -0.4, [0, 1, 0]),
        actual = result.spline.at((i + u) / n);
      assert.ok(Math.hypot(...actual.map((v, a) => v - expected[a])) <= result.maxError + 1e-11);
    }
  assert.deepEqual(source.points, before);
});
