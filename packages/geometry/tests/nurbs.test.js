// NURBS against closed forms: exact circles and spheres, a Bezier special case, derivatives against differences,
// partition of unity, repeated-knot creases and the input checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tubeGeometry, mergeVertices } from '../dist/index.js';
import { NurbsCurve, NurbsSurface, nurbsCircle, nurbsRevolve, nurbsSurfaceGeometry } from '../dist/nurbs.js';
import {
  assertNormalsAgreeWithWinding,
  assertUVRange,
  assertValid,
  close,
  point,
  signedVolume,
  surfaceArea,
  vertexCount,
  watertight,
} from './support/mesh-checks.js';

test('a full NURBS circle is exact at every parameter, not just at its control points', () => {
  const circle = nurbsCircle(2.5);
  assert.equal(circle.degree, 2);
  assert.equal(circle.points.length, 9);
  for (let i = 0; i <= 997; i++) {
    const p = circle.getPoint(i / 997);
    close(Math.hypot(p[0], p[1]), 2.5, 1e-12, `radius at ${i}`);
    assert.equal(p[2], 0);
  }
  close(circle.getPoint(0)[0], 2.5, 1e-12, 'start');
  close(circle.getPoint(1)[0], 2.5, 1e-12, 'closes');
  close(circle.getPoint(1)[1], 0, 1e-12, 'closes');
  close(circle.getLength(), 2 * Math.PI * 2.5, 1e-3, 'circumference');
});

test('arcs run from the start to the end angle in either direction', () => {
  for (const [from, to] of [
    [0.3, 1.1],
    [0.3, 3.9],
    [2, -2],
  ]) {
    const arc = nurbsCircle(1, from, to),
      a = arc.getPoint(0),
      b = arc.getPoint(1),
      m = arc.getPoint(0.5);
    close(a[0], Math.cos(from), 1e-12, 'start x');
    close(a[1], Math.sin(from), 1e-12, 'start y');
    close(b[0], Math.cos(to), 1e-12, 'end x');
    close(b[1], Math.sin(to), 1e-12, 'end y');
    close(Math.hypot(m[0], m[1]), 1, 1e-12, 'middle radius');
    close(arc.getLength(), Math.abs(to - from), 1e-3, 'arc length');
    // The middle stays on the swept side: the angle halfway through the sweep, whatever the direction.
    const half = (from + to) / 2;
    assert.ok(m[0] * Math.cos(half) + m[1] * Math.sin(half) > 0.9, 'runs through the sweep');
  }
});

test('with unit weights and clamped knots a NURBS curve is the Bezier curve with the same points', () => {
  const points = [
      [0, 0, 0],
      [1, 2, 0],
      [3, 2, 1],
      [4, 0, 1],
    ],
    curve = new NurbsCurve({ points });
  for (let i = 0; i <= 20; i++) {
    const t = i / 20,
      s = 1 - t,
      w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t],
      p = curve.getPoint(t);
    for (let k = 0; k < 3; k++)
      close(
        p[k],
        points.reduce((sum, c, n) => sum + w[n] * c[k], 0),
        1e-12,
        `bezier ${t} ${k}`,
      );
  }
});

test('the rational first, second and third derivatives match differences of the curve', () => {
  const curve = new NurbsCurve({
      degree: 3,
      points: [
        [0, 0, 0],
        [1, 2, 0.5],
        [2, -1, 1],
        [4, 0, 0],
        [5, 2, -1],
        [7, 1, 0],
      ],
      weights: [1, 2, 0.5, 3, 1, 0.7],
      knots: [0, 0, 0, 0, 1, 2.5, 4, 4, 4, 4],
    }),
    h = 1e-3;
  for (const u of [0.4, 1.7, 3.1]) {
    const [p, d1, d2, d3] = curve.derivatives(u, 3),
      before = curve.derivatives(u - h, 2),
      after = curve.derivatives(u + h, 2);
    for (let k = 0; k < 3; k++) {
      close(p[k], curve.evaluate(u)[k], 0, 'order 0');
      close(d1[k], (after[0][k] - before[0][k]) / (2 * h), 1e-4, 'first');
      close(d2[k], (after[1][k] - before[1][k]) / (2 * h), 1e-3, 'second');
      close(d3[k], (after[2][k] - before[2][k]) / (2 * h), 1e-2, 'third');
    }
  }
  // Past the degree a polynomial curve has no derivative left.
  const line = new NurbsCurve({
    degree: 1,
    points: [
      [0, 0],
      [2, 1],
    ],
  });
  assert.deepEqual(line.derivatives(0.5, 2)[2], [0, 0]);
  assert.deepEqual(line.derivatives(0.5, 1)[1], [2, 1]);
});

test('2D curves stay 2D and a circle tangent is perpendicular to its radius', () => {
  const flat = new NurbsCurve({
    points: [
      [0, 0],
      [1, 1],
      [2, 0],
    ],
  });
  assert.equal(flat.degree, 2);
  assert.equal(flat.getPoint(0.5).length, 2);
  const circle = nurbsCircle(3);
  for (const t of [0.1, 0.37, 0.8]) {
    const p = circle.getPoint(t),
      d = circle.getTangent(t);
    close(p[0] * d[0] + p[1] * d[1], 0, 1e-12, 'tangent against radius');
    close(Math.hypot(...d), 1, 1e-12, 'unit tangent');
  }
});

test('the curve feeds the tube builder like any other curve', () => {
  const tube = tubeGeometry(nurbsCircle(2), 64, 0.1, 32, true);
  assertValid(tube, 'nurbs tube');
  close(surfaceArea(tube), 4 * Math.PI ** 2 * 2 * 0.1, 0.05, 'torus area');
});

test('tessellate holds its tolerance, keeps corners and needs fewer points on flat runs', () => {
  const circle = nurbsCircle(1),
    points = circle.tessellate(1e-3);
  // A chord of angle a sags 1 - cos(a / 2); the worst chord must stay within the tolerance.
  for (let i = 1; i < points.length; i++) {
    const a = Math.atan2(points[i][1], points[i][0]),
      b = Math.atan2(points[i - 1][1], points[i - 1][0]),
      step = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    assert.ok(1 - Math.cos(step / 2) <= 1e-3, `chord ${i} sags too far`);
  }
  assert.ok(circle.tessellate(1e-5).length > points.length, 'a tighter tolerance gives more points');

  // Degree 1: the corners are knots, so the result is the polyline itself.
  const polyline = new NurbsCurve({
    degree: 1,
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  });
  assert.deepEqual(polyline.tessellate(), [
    [0, 0],
    [1, 0],
    [1, 1],
  ]);

  // A symmetric S: its midpoint sits on the chord, so a check of the middle alone would stop at once.
  const s = new NurbsCurve({
    degree: 3,
    points: [
      [0, 0],
      [1, 2],
      [2, -2],
      [3, 0],
    ],
  });
  assert.ok(s.tessellate(1e-2).length > 4, 'S-shaped span is refined');
});

test('a NURBS sphere from a revolved half circle is exact, closed and has radial normals', () => {
  const surface = nurbsRevolve(nurbsCircle(2, -Math.PI / 2, Math.PI / 2));
  for (let i = 0; i <= 20; i++)
    for (let j = 0; j <= 20; j++) {
      const p = surface.getPoint(i / 20, j / 20);
      close(Math.hypot(...p), 2, 1e-12, `radius ${i} ${j}`);
    }
  const g = nurbsSurfaceGeometry(surface, 48, 64);
  assertValid(g, 'sphere');
  assertUVRange(g, 'sphere');
  assertNormalsAgreeWithWinding(g, 'sphere');
  for (let k = 0; k < vertexCount(g); k++) {
    const p = point(g, k),
      r = Math.hypot(...p);
    close(r, 2, 1e-6, 'mesh radius');
    const n = [g.normals[k * 3], g.normals[k * 3 + 1], g.normals[k * 3 + 2]];
    close(Math.hypot(...n), 1, 1e-6, 'unit normal');
    const along = (n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / r;
    assert.ok(along > 0.9999, `normal ${k} is radial and outward (${along})`);
  }
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((n) => point(g, g.indices[t + n]).join());
    assert.ok(a !== b && b !== c && a !== c, 'no triangle collapses at a pole');
  }
  const welded = mergeVertices(g, { positionOnly: true, tolerance: 1e-5, removeDegenerate: true });
  assert.ok(watertight(welded), 'welded sphere is closed');
  close(surfaceArea(g), 4 * Math.PI * 4, 0.1, 'sphere area');
  close(signedVolume(g), (4 / 3) * Math.PI * 8, 0.15, 'sphere volume');
});

test('a torus from a revolved circle and a partial revolve', () => {
  // A circle centred at (3, 0): shift its control points, the weights stay.
  const ring = nurbsCircle(1),
    moved = new NurbsCurve({
      degree: 2,
      points: ring.points.map(([x, y, z]) => [x + 3, y, z]),
      knots: ring.knots,
      weights: ring.weights,
    }),
    torus = nurbsRevolve(moved);
  for (let i = 0; i <= 12; i++)
    for (let j = 0; j <= 12; j++) {
      const [x, y, z] = torus.getPoint(i / 12, j / 12);
      close(Math.hypot(Math.hypot(x, z) - 3, y), 1, 1e-12, 'on the torus');
    }
  const g = nurbsSurfaceGeometry(torus, 64, 96);
  close(surfaceArea(g), 4 * Math.PI ** 2 * 3, 0.15, 'torus area');
  assert.ok(signedVolume(g) > 0, 'faces out');

  const quarter = nurbsRevolve(
    new NurbsCurve({
      degree: 1,
      points: [
        [1, 0],
        [1, 1],
      ],
    }),
    Math.PI / 2,
  );
  close(quarter.getPoint(0, 1)[2], 1, 1e-12, 'turned towards +z');
  close(quarter.getPoint(0, 1)[0], 0, 1e-12, 'off +x');
  close(quarter.getPoint(1, 0.5)[1], 1, 1e-12, 'height stays');
});

test('a surface gives exact partial derivatives, and basis weights keep a flat net flat', () => {
  const points = [];
  for (let i = 0; i < 5; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) row.push([i, j, Math.sin(i * 1.3) * Math.cos(j)]);
    points.push(row);
  }
  const weights = points.map((row, i) => row.map((_, j) => 1 + ((i * 3 + j) % 4) / 2)),
    surface = new NurbsSurface({ points, weights, degreeU: 3, degreeV: 2 }),
    h = 1e-5;
  for (const [u, v] of [
    [0.2, 0.3],
    [0.55, 0.7],
    [0.9, 0.15],
  ]) {
    const { du, dv } = surface.derivatives(u, v),
      pu = surface.evaluate(u + h, v),
      mu = surface.evaluate(u - h, v),
      pv = surface.evaluate(u, v + h),
      mv = surface.evaluate(u, v - h);
    for (let k = 0; k < 3; k++) {
      close(du[k], (pu[k] - mu[k]) / (2 * h), 1e-6, 'du');
      close(dv[k], (pv[k] - mv[k]) / (2 * h), 1e-6, 'dv');
    }
  }
  // Any weights on a planar net: the basis sums to one, so every point stays in the plane.
  const flat = new NurbsSurface({ points: points.map((r) => r.map(([x, y]) => [x, y, 2])), weights });
  for (let i = 0; i <= 9; i++) close(flat.getPoint(i / 9, 1 - i / 9)[2], 2, 1e-12, 'in plane');
  close(surface.getPoint(0, 0)[0], 0, 1e-12, 'corner interpolated');
  close(surface.getPoint(1, 1)[1], 3, 1e-12, 'corner interpolated');
});

test('a knot repeated degree times keeps a sharp crease; a mesh line lands on every inner knot', () => {
  // A degree-1 roof profile swept along z: one ridge at x = 1, on the inner knot 0.5.
  const surface = new NurbsSurface({
      degreeU: 1,
      degreeV: 1,
      points: [
        [
          [0, 0, 1],
          [0, 0, 0],
        ],
        [
          [1, 1, 1],
          [1, 1, 0],
        ],
        [
          [2, 0, 1],
          [2, 0, 0],
        ],
      ],
    }),
    g = nurbsSurfaceGeometry(surface, 3, 1);
  // 3 even steps never reach 0.5, so without the knot line the ridge would be cut off.
  let top = 0,
    ridge = [];
  for (let k = 0; k < vertexCount(g); k++) {
    const p = point(g, k);
    top = Math.max(top, p[1]);
    if (p[0] === 1) ridge.push([g.normals[k * 3], g.normals[k * 3 + 1], g.normals[k * 3 + 2]]);
  }
  assert.equal(top, 1, 'ridge reached');
  const slopes = new Set(ridge.map((n) => Math.sign(n[0])));
  assert.equal(slopes.size, 2, 'both slopes keep their own normal on the ridge');
  assertNormalsAgreeWithWinding(g, 'roof');
  close(surfaceArea(g), 2 * Math.SQRT2, 1e-6, 'roof area');
});

test('invalid curves and surfaces are refused with the fix in the message', () => {
  const points = [
    [0, 0],
    [1, 0],
    [2, 1],
  ];
  assert.throws(() => new NurbsCurve({ points: [] }), /needs points/);
  assert.throws(() => new NurbsCurve({ points: [[1]] }), TypeError);
  assert.throws(
    () =>
      new NurbsCurve({
        points: [
          [0, 0],
          [1, 0, 0],
        ],
      }),
    /same size/,
  );
  assert.throws(
    () =>
      new NurbsCurve({
        points: [
          [0, 0],
          [NaN, 0],
        ],
      }),
    /finite/,
  );
  assert.throws(() => new NurbsCurve({ points, degree: 3 }), /add points/);
  assert.throws(() => new NurbsCurve({ points, degree: 0 }), /integer/);
  assert.throws(() => new NurbsCurve({ points, degree: 2, knots: [0, 0, 1] }), /pass 6/);
  assert.throws(() => new NurbsCurve({ points, degree: 2, knots: [0, 0, 0, 1, 0.5, 1] }), /decrease/);
  assert.throws(() => new NurbsCurve({ points, degree: 1, knots: [0, 0, 0, 0, 1] }), /repeats/);
  assert.throws(() => new NurbsCurve({ points, degree: 1, knots: [0, 1, 1, 1, 1].slice(0, 5) }), RangeError);
  assert.throws(() => new NurbsCurve({ points, weights: [1, 1] }), /one per control point/);
  assert.throws(() => new NurbsCurve({ points, weights: [1, 0, 1] }), /value > 0/);
  const curve = new NurbsCurve({ points });
  assert.throws(() => curve.evaluate(2), /outside/);
  assert.throws(() => curve.derivatives(0.5, -1), /order/);
  assert.throws(() => curve.tessellate(0), /tolerance/);
  assert.throws(() => nurbsCircle(0), /radius/);
  assert.throws(() => nurbsCircle(1, 0, 0), /sweep/);
  assert.throws(() => nurbsCircle(1, 0, 7), /sweep/);
  assert.throws(() => nurbsRevolve({}), /NurbsCurve/);
  assert.throws(() => new NurbsSurface({ points: [] }), /control net/);
  const net = [
    [
      [0, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
    ],
  ];
  assert.throws(() => new NurbsSurface({ points: [net[0], [net[1][0]]] }), /rectangular/);
  assert.throws(() => new NurbsSurface({ points: net, weights: [[1, 1]] }), /match the control net/);
  assert.throws(
    () =>
      new NurbsSurface({
        points: [
          [
            [0, 0],
            [0, 1],
          ],
          net[1],
        ],
      }),
    /3 numbers/,
  );
  assert.throws(() => new NurbsSurface({ points: net }).evaluate(2, 0), /outside/);
  assert.throws(() => nurbsSurfaceGeometry({}), /NurbsSurface/);
  assert.throws(() => nurbsSurfaceGeometry(new NurbsSurface({ points: net }), 0), /finite number >= 1/);
  assert.throws(() => nurbsSurfaceGeometry(new NurbsSurface({ points: net }), Infinity), /finite number/);
});
