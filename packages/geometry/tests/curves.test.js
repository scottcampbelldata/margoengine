import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ArcCurve,
  CatmullRomCurve3,
  CubicBezierCurve,
  CubicBezierCurve3,
  EllipseCurve,
  LineCurve,
  LineCurve3,
  Path,
  QuadraticBezierCurve,
  QuadraticBezierCurve3,
  Shape,
  SplineCurve,
} from '../dist/index.js';

// Behaviour vectors for the curve classes (binding parts only; see the spec's tolerances).
const vectors = JSON.parse(readFileSync(new URL('./fixtures/curves-vectors.json', import.meta.url), 'utf8')).curves;
const PI = Math.PI;
const refPts = [
  [0, 0, 0],
  [1, 2, 0],
  [1.2, 2.1, 0.3],
  [3, 1, 1],
  [4, 4, 2],
];
const curves = {
  'LineCurve [0,1]->[4,-2]': () => new LineCurve([0, 1], [4, -2]),
  'LineCurve3 [0,1,2]->[4,-2,9]': () => new LineCurve3([0, 1, 2], [4, -2, 9]),
  'QuadraticBezierCurve [0,0],[2,5],[6,1]': () => new QuadraticBezierCurve([0, 0], [2, 5], [6, 1]),
  'QuadraticBezierCurve3 [0,0,0],[2,5,-3],[6,1,2]': () => new QuadraticBezierCurve3([0, 0, 0], [2, 5, -3], [6, 1, 2]),
  'CubicBezierCurve [0,0],[1,4],[5,-4],[6,1]': () => new CubicBezierCurve([0, 0], [1, 4], [5, -4], [6, 1]),
  'CubicBezierCurve3 [0,0,0],[1,4,2],[5,-4,-1],[6,1,3]': () =>
    new CubicBezierCurve3([0, 0, 0], [1, 4, 2], [5, -4, -1], [6, 1, 3]),
  'SplineCurve [0,0],[1,2],[3,1],[4,4],[6,0]': () =>
    new SplineCurve([
      [0, 0],
      [1, 2],
      [3, 1],
      [4, 4],
      [6, 0],
    ]),
  'EllipseCurve(1,2,3,1.5,0.3,4,true,0.4)': () => new EllipseCurve(1, 2, 3, 1.5, 0.3, 4, true, 0.4),
  'EllipseCurve defaults': () => new EllipseCurve(),
  'EllipseCurve(0,0,2,1,0,0) same points': () => new EllipseCurve(0, 0, 2, 1, 0, 0),
  'EllipseCurve(0,0,2,1,0,-PI/2,false)': () => new EllipseCurve(0, 0, 2, 1, 0, -PI / 2, false),
  'ArcCurve(1,1,2,0,PI,false)': () => new ArcCurve(1, 1, 2, 0, PI, false),
  'ArcCurve(0,0,1,0,PI/2,true)': () => new ArcCurve(0, 0, 1, 0, PI / 2, true),
  "CatmullRomCurve3(refPts, false, 'catmullrom', tension=0.2)": () =>
    new CatmullRomCurve3(refPts, false, 'catmullrom', 0.2),
  'CatmullRomCurve3 with duplicate points, centripetal': () =>
    new CatmullRomCurve3([
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 0],
    ]),
  'CatmullRomCurve3 two points': () =>
    new CatmullRomCurve3([
      [0, 0, 0],
      [2, 1, 0],
    ]),
};
for (const type of ['centripetal', 'chordal', 'catmullrom', 'uniform'])
  for (const closed of [false, true])
    curves[`CatmullRomCurve3(refPts, closed=${closed}, '${type}')`] = () => new CatmullRomCurve3(refPts, closed, type);

const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
const near = (actual, expected, tolerance, label) => {
  if (typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
    return;
  }
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) near(actual[i], expected[i], tolerance, `${label}[${i}]`);
};
// Absolute 1e-6 for closed forms (vectors are rounded to 1e-6), relative 1e-5 for arc-length quantities.
const rel = (scale) => 1e-6 + 1e-5 * Math.max(1, scale);

test('curves match the recorded behaviour vectors', () => {
  for (const [name, make] of Object.entries(curves)) {
    const expected = vectors[name],
      curve = make();
    assert.ok(expected, name);
    const isLine = curve instanceof LineCurve;
    const length = curve.getLength();
    near(length, expected.getLength, rel(expected.getLength), `${name} getLength`);
    near(curve.getLengths(10), expected.getLengths10, rel(expected.getLength), `${name} getLengths10`);
    near(curve.getPoints(5), expected.getPoints5, 2e-6, `${name} getPoints5`);
    near(curve.getSpacedPoints(5), expected.getSpacedPoints5, rel(length), `${name} getSpacedPoints5`);
    samples.forEach((t, i) => {
      near(curve.getPoint(t), expected.getPoint[i], 2e-6, `${name} getPoint(${t})`);
      near(curve.getPointAt(t), expected.getPointAt[i], rel(length), `${name} getPointAt(${t})`);
      // Tangents: lines are exact; elsewhere the vectors used another finite-difference step, so knots (where the
      // second derivative jumps) differ by that step's error. Closed Catmull-Rom ends are differenced across the
      // seam here and one-sided in the vectors.
      const seam = curve instanceof CatmullRomCurve3 && curve.closed && (t === 0 || t === 1);
      const tangentTolerance = isLine ? 2e-6 : seam ? 1e-2 : 1e-3;
      near(curve.getTangent(t), expected.getTangent[i], tangentTolerance, `${name} getTangent(${t})`);
      near(curve.getTangentAt(t), expected.getTangentAt[i], tangentTolerance, `${name} getTangentAt(${t})`);
    });
  }
});

test('closed Catmull-Rom tangents agree across the seam', () => {
  for (const type of ['centripetal', 'chordal', 'catmullrom']) {
    const curve = new CatmullRomCurve3(refPts, true, type);
    near(curve.getTangent(0), curve.getTangent(1), 1e-9, `${type} seam`);
  }
});

test('getUtoTmapping inverts the chord table and clamps', () => {
  const expected = vectors['getUtoTmapping cubic'],
    curve = new CubicBezierCurve([0, 0], [1, 4], [5, -4], [6, 1]);
  near(
    [0, 0.2, 0.5, 0.8, 1, -0.5, 1.5].map((u) => curve.getUtoTmapping(u)),
    expected.u,
    2e-6,
    'u',
  );
  near(
    [0, 1, 3, 100].map((d) => curve.getUtoTmapping(0, d)),
    expected.distance,
    2e-6,
    'distance',
  );
  // An exact table hit returns exactly i / d.
  const table = curve.getLengths();
  assert.equal(curve.getUtoTmapping(0, table[37]), 37 / 200);
  assert.equal(curve.getLengths(), table, 'the table is cached');
  assert.notEqual(curve.getLengths(10), table, 'another division count rebuilds it');
  curve.updateArcLengths();
  assert.notEqual(curve.getLengths(), table);
  // Zero-length curves map u to itself.
  assert.equal(new LineCurve([1, 1], [1, 1]).getUtoTmapping(0.3), 0.3);
  assert.deepEqual(new QuadraticBezierCurve([1, 1], [1, 1], [1, 1]).getPointAt(0.3), [1, 1]);
});

test('Catmull-Rom knots, degenerate inputs and typed arrays', () => {
  const knots = vectors['CatmullRomCurve3 interpolates knots'].knotsAt_t_i_over_4;
  const curve = new CatmullRomCurve3(refPts);
  knots.forEach((k, i) => near(curve.getPoint(i / 4), k, 1e-12, `knot ${i}`));
  assert.deepEqual(curve.getPoint(1), refPts[4]);
  assert.doesNotThrow(() => new CatmullRomCurve3());
  assert.throws(() => new CatmullRomCurve3([[1, 2, 3]]).getPoint(0.5), RangeError);
  assert.throws(() => new CatmullRomCurve3().getPoint(0.5), /at least two points/);
  assert.throws(() => new SplineCurve().getPoint(0.5), RangeError);
  // Typed control points give typed results of the same kind.
  const typed = new CubicBezierCurve3(
    new Float32Array([0, 0, 0]),
    new Float32Array([1, 4, 2]),
    new Float32Array([5, -4, -1]),
    new Float32Array([6, 1, 3]),
  );
  const p = typed.getPoint(0.5);
  assert.ok(p instanceof Float32Array && p.length === 3);
  near(Array.from(p), new CubicBezierCurve3([0, 0, 0], [1, 4, 2], [5, -4, -1], [6, 1, 3]).getPoint(0.5), 1e-6, 'typed');
  const q = new QuadraticBezierCurve(new Float64Array([0, 0]), new Float64Array([2, 5]), new Float64Array([6, 1]));
  assert.ok(q.getPointAt(0.3) instanceof Float64Array);
  assert.ok(q.getTangent(0.3) instanceof Float64Array);
  // Results are fresh arrays.
  const line = new LineCurve3([0, 0, 0], [1, 2, 3]);
  const end = line.getPoint(1);
  end[0] = 99;
  assert.deepEqual(line.v2, [1, 2, 3]);
});

test('rotation-minimizing frames: orthonormal, right-handed, twist-free, closed loops meet', () => {
  const unit = (v) => Math.hypot(...v);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const crossOf = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const angle = (a, b) => Math.atan2(unit(crossOf(a, b)), dot(a, b));
  const cases = [
    [new CatmullRomCurve3(refPts), false],
    [new CatmullRomCurve3(refPts, true), true],
    [new LineCurve3([0, 0, 0], [0, 5, 0]), false],
    [new CubicBezierCurve([0, 0], [1, 4], [5, -4], [6, 1]), false],
  ];
  for (const [curve, closed] of cases)
    for (const segments of [4, 8, 64]) {
      const { tangents, normals, binormals } = curve.computeFrenetFrames(segments, closed);
      assert.equal(tangents.length, segments + 1);
      for (let i = 0; i <= segments; i++) {
        const T = tangents[i],
          N = normals[i],
          B = binormals[i];
        const expectedT = curve.getTangentAt(i / segments);
        near(T, [expectedT[0], expectedT[1], expectedT[2] ?? 0], 1e-9, 'tangent');
        for (const v of [T, N, B]) near(unit(v), 1, 1e-9, 'unit');
        near(dot(T, N), 0, 1e-9, 'T.N');
        near(dot(N, B), 0, 1e-9, 'N.B');
        near(crossOf(T, N), B, 1e-9, 'B = T x N');
        // Parallel transport adds no spin about the tangent, so consecutive normals turn no more than the tangents.
        if (i > 0 && !closed) assert.ok(angle(normals[i - 1], N) <= angle(tangents[i - 1], T) + 1e-9, 'no twist');
      }
      if (closed)
        assert.ok(
          angle(normals[segments], normals[0]) <= angle(tangents[segments], tangents[0]) + 1e-6,
          'closed frames meet',
        );
      if (curve instanceof LineCurve3) for (const N of normals) near(N, normals[0], 1e-12, 'straight line keeps N');
    }
});

test('CurvePath and Path builders', () => {
  const v = vectors['Path line+quad+cubic+spline'];
  const path = new Path()
    .moveTo(0, 0)
    .lineTo(1, 0)
    .quadraticCurveTo(2, 0, 2, 1)
    .bezierCurveTo(2, 2, 1, 2, 0, 2)
    .splineThru([
      [-1, 1],
      [0, 0],
    ]);
  assert.equal(path.curves.length, v.curves);
  assert.deepEqual(path.currentPoint, v.currentPoint);
  near(path.getLength(), v.getLength, rel(v.getLength), 'length');
  near(path.getCurveLengths(), v.getCurveLengths, rel(v.getLength), 'curve lengths');
  samples.forEach((t, i) => near(path.getPoint(t), v.getPoint[i], rel(v.getLength), `getPoint(${t})`));
  near(path.getSpacedPoints(10), v.getSpacedPoints10, rel(v.getLength), 'spaced 10');
  assert.equal(path.getSpacedPoints().length, v.getSpacedPointsDefaultCount);
  // Outline points: joints once, a line contributes only its end points, the closed outline ends where it started.
  const outline = path.getPoints(6);
  for (let i = 1; i < outline.length; i++) assert.notDeepEqual(outline[i], outline[i - 1]);
  assert.deepEqual(outline.slice(0, 2), [
    [0, 0],
    [1, 0],
  ]);
  assert.deepEqual(outline[outline.length - 1], [0, 0]);

  const b = vectors['Path builders'];
  assert.equal(
    new Path().moveTo(5, 0).absarc(0, 0, 1, 0, PI).curves.length,
    b['moveTo(5,0).absarc(0,0,1,0,PI): curves'],
  );
  assert.equal(
    new Path().moveTo(4, 0).lineTo(5, 0).absarc(0, 0, 1, 0, PI).curves.length,
    b['moveTo(4,0).lineTo(5,0).absarc(...): curves'],
  );
  const relative = new Path().moveTo(1, 1).arc(1, 0, 1, PI, 0, true);
  near(relative.curves[0].getPoint(0), b['moveTo(1,1).arc(1,0,1,PI,0,true): first point'], 1e-12, 'arc start');
  near(relative.currentPoint, b['moveTo(1,1).arc(1,0,1,PI,0,true): currentPoint'], 1e-12, 'arc pen');
  const triangle = () =>
    new Path([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  const closedTriangle = triangle().closePath();
  assert.equal(closedTriangle.curves.length, b['triangle closePath: curves']);
  near(closedTriangle.getLength(), b['triangle closePath: length'], 1e-6, 'closed length');
  assert.equal(closedTriangle.closePath().curves.length, 3, 'closing a closed path adds nothing');
  assert.equal(new Path().closePath().curves.length, 0);
  const auto = triangle();
  auto.autoClose = true;
  assert.deepEqual(auto.getPoints(), b['triangle autoClose getPoints']);
  near(auto.getSpacedPoints(4), b['triangle autoClose getSpacedPoints(4)'], 1e-12, 'autoClose spaced');
  assert.equal(new Path().getLength(), b['empty path getLength']);
  // The pen is replaced, never shared with a curve's points.
  const pen = new Path().moveTo(1, 2).lineTo(3, 4);
  pen.currentPoint[0] = 50;
  assert.deepEqual(pen.curves[0].v2, [3, 4]);
  // A zero-length sub-curve and t past the end stay finite.
  const zero = new Path().moveTo(0, 0).lineTo(0, 0).lineTo(1, 0);
  for (const t of [0, 0.5, 1, 1.0000001]) assert.ok(zero.getPoint(t).every(Number.isFinite));
  // Editing a sub-curve and updating gives the new length.
  const edit = new Path().moveTo(0, 0).lineTo(1, 0);
  near(edit.getLength(), 1, 1e-12, 'before edit');
  edit.curves[0].v2 = [3, 0];
  edit.updateArcLengths();
  near(edit.getLength(), 3, 1e-12, 'after edit');
});

test('Shape extractPoints keeps the outline and samples holes', () => {
  const v = vectors['Shape extractPoints(6)'];
  const shape = new Shape([
    [-2, -1],
    [2, -1],
    [2, 1.5],
    [-2, 1.5],
  ]);
  shape.holes.push(new Path().absarc(0, 0, 0.4, 0, 2 * PI, true));
  const { shape: outer, holes } = shape.extractPoints(6);
  assert.deepEqual(outer, v.shape);
  assert.equal(holes.length, 1);
  let area = 0;
  for (let i = 0, ring = holes[0]; i < ring.length; i++) {
    const [ax, ay] = ring[i],
      [bx, by] = ring[(i + 1) % ring.length];
    area += (ax * by - bx * ay) / 2;
  }
  near(area, v.holeArea, 1e-2, 'hole area (signed, clockwise is negative)');
  near(holes[0][0], holes[0][holes[0].length - 1], 1e-12, 'a full circle closes');
  assert.deepEqual(shape.getPointsHoles(6), holes);
});
