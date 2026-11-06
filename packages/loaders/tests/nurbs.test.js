// NURBS evaluation and tessellation against shapes with known answers: lines, Bezier arcs, exact circles and a sphere.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNurbsCurve,
  evaluateNurbsSurface,
  tessellateNurbsCurve,
  tessellateNurbsSurface,
} from '../dist/nurbs.js';
import { LoaderError } from '../dist/common.js';

const refuses = (run, code) =>
  assert.throws(run, (error) => error instanceof LoaderError && error.format === 'NURBS' && error.code === code);
const near = (actual, expected, tolerance = 1e-9) =>
  [...actual].forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < tolerance, `${[...actual]} against ${expected}`));
const W = Math.SQRT1_2;
// A full unit circle: nine control points, four rational quadratic arcs.
const CIRCLE = {
  degree: 2,
  knots: [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4],
  points: [1, 0, 0, 1, 1, 0, 0, 1, 0, -1, 1, 0, -1, 0, 0, -1, -1, 0, 0, -1, 0, 1, -1, 0, 1, 0, 0],
  weights: [1, W, 1, W, 1, W, 1, W, 1],
};

/** A unit sphere: the circle's half arc turned about z. */
function sphere() {
  const half = [
      [1, 0, 1],
      [1, 1, W],
      [0, 1, 1],
      [-1, 1, W],
      [-1, 0, 1],
    ],
    points = [],
    weights = [];
  for (let i = 0; i < 9; i++) {
    const [cx, cy] = [CIRCLE.points[i * 3], CIRCLE.points[i * 3 + 1]],
      w = CIRCLE.weights[i];
    for (const [z, r, wv] of half) {
      points.push(cx * r, cy * r, z);
      weights.push(w * wv);
    }
  }
  return {
    degreeU: 2,
    degreeV: 2,
    knotsU: CIRCLE.knots,
    knotsV: [0, 0, 0, 1, 1, 2, 2, 2],
    countU: 9,
    countV: 5,
    points,
    weights,
  };
}

test('a line and a quadratic Bezier match their formulas', () => {
  near(evaluateNurbsCurve({ degree: 1, knots: [0, 0, 1, 1], points: [0, 0, 0, 2, 4, 6] }, 0.25), [0.5, 1, 1.5]);
  const bezier = { degree: 2, knots: [0, 0, 0, 1, 1, 1], points: [0, 0, 0, 1, 2, 0, 2, 0, 0] };
  for (const t of [0, 0.3, 0.5, 1]) {
    const y = 2 * (1 - t) * t * 2;
    near(evaluateNurbsCurve(bezier, t), [2 * t, y, 0]);
  }
});

test('weights make an exact circle, at knots and between them, ends included', () => {
  for (const t of [0, 0.2, 1, 1.5, 2, 3.7, 4]) {
    const [x, y] = evaluateNurbsCurve(CIRCLE, t);
    assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-12, `t ${t}`);
  }
  near(evaluateNurbsCurve(CIRCLE, 1), [0, 1, 0]);
  near(evaluateNurbsCurve(CIRCLE, 4), [1, 0, 0]);
});

test('a knot vector without its end knots, as Rhino writes it, reads the same', () => {
  const short = { ...CIRCLE, knots: CIRCLE.knots.slice(1, -1) };
  near(evaluateNurbsCurve(short, 1.5), evaluateNurbsCurve(CIRCLE, 1.5));
});

test('an unclamped curve evaluates on its own domain', () => {
  const uniform = { degree: 2, knots: [0, 1, 2, 3, 4, 5], points: [0, 0, 0, 1, 0, 0, 2, 0, 0] };
  near(evaluateNurbsCurve(uniform, 2.5), [1, 0, 0]);
  near(evaluateNurbsCurve(uniform, 3), [1.5, 0, 0]);
  refuses(() => evaluateNurbsCurve(uniform, 1), 'range');
});

test('a curve polyline stays inside its tolerance, and a tighter tolerance costs more points', () => {
  const measure = (points) => {
    let worst = 0;
    for (let i = 0; i + 3 < points.length; i += 3) {
      const mx = (points[i] + points[i + 3]) / 2,
        my = (points[i + 1] + points[i + 4]) / 2;
      worst = Math.max(worst, 1 - Math.hypot(mx, my));
    }
    return worst;
  };
  const coarse = tessellateNurbsCurve(CIRCLE, { tolerance: 0.01 }),
    fine = tessellateNurbsCurve(CIRCLE, { tolerance: 0.0001 });
  assert.ok(measure(coarse) <= 0.01);
  assert.ok(measure(fine) <= 0.0001);
  assert.ok(fine.length > coarse.length);
  near(coarse.subarray(0, 3), [1, 0, 0], 1e-6);
  near(coarse.subarray(coarse.length - 3), [1, 0, 0], 1e-6);
});

test('a straight curve needs only its knot points, and a sharp knot is kept', () => {
  assert.equal(tessellateNurbsCurve({ degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], points: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0] }).length, 6);
  const corner = tessellateNurbsCurve({ degree: 1, knots: [0, 0, 1, 2, 2], points: [0, 0, 0, 1, 0, 0, 1, 1, 0] });
  near(corner, [0, 0, 0, 1, 0, 0, 1, 1, 0]);
  // S-shaped on one span: its middle lies on the chord, and the quarter points still force a split.
  const wave = tessellateNurbsCurve({ degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], points: [0, 0, 0, 1, 2, 0, 2, -2, 0, 3, 0, 0] }, { tolerance: 0.01 });
  assert.ok(wave.length / 3 > 4);
});

test('a bilinear patch evaluates and tessellates with an upward normal', () => {
  const patch = { degreeU: 1, degreeV: 1, knotsU: [0, 0, 1, 1], knotsV: [0, 0, 1, 1], countU: 2, countV: 2, points: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0] };
  const { position, normal } = evaluateNurbsSurface(patch, 0.25, 0.5);
  near(position, [0.25, 0.5, 0]);
  near(normal, [0, 0, 1]);
  const mesh = tessellateNurbsSurface(patch, { segmentsU: 2, segmentsV: 3 });
  assert.equal(mesh.positions.length / 3, 12);
  assert.equal(mesh.indices.length / 3, 12);
  near(mesh.uvs.subarray(mesh.uvs.length - 2), [1, 1]);
  const [a, b, c] = mesh.indices,
    p = (i) => [...mesh.positions.subarray(i * 3, i * 3 + 3)],
    u = p(b).map((v, i) => v - p(a)[i]),
    w = p(c).map((v, i) => v - p(a)[i]);
  assert.ok(u[0] * w[1] - u[1] * w[0] > 0, 'the triangles wind the way the normals point');
});

test('a rational sphere is exact, with radial normals, poles included', () => {
  const s = sphere();
  for (const [u, v] of [
    [0.5, 0.5],
    [1.3, 1],
    [3.9, 1.7],
  ]) {
    const { position, normal } = evaluateNurbsSurface(s, u, v);
    assert.ok(Math.abs(Math.hypot(...position) - 1) < 1e-12);
    const dot = position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2];
    assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-9, `normal at ${u}, ${v}`);
  }
  assert.deepEqual(evaluateNurbsSurface(s, 1, 0).normal, [0, 0, 0]);
  const mesh = tessellateNurbsSurface(s);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]) - 1) < 1e-5);
    assert.ok(Math.abs(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]) - 1) < 1e-5, 'a pole has a normal too');
  }
});

test('malformed data and limits are named errors', () => {
  const line = { degree: 1, knots: [0, 0, 1, 1], points: [0, 0, 0, 1, 0, 0] };
  refuses(() => evaluateNurbsCurve({ ...line, degree: 0 }, 0), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, degree: 2 }, 0), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, knots: [0, 1, 2] }, 0), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, knots: [0, 1, 0, 1] }, 0), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, knots: [1, 1, 1, 1] }, 1), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, knots: [0, 0, 1, Number.NaN] }, 0), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, weights: [1] }, 0), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, weights: [1, 0] }, 0), 'range');
  refuses(() => evaluateNurbsCurve({ ...line, points: [0, 0, 0, 1, 0, Number.NaN] }, 0), 'range');
  refuses(() => evaluateNurbsCurve(line, 2), 'range');
  refuses(() => evaluateNurbsCurve(line, Number.NaN), 'range');
  refuses(() => tessellateNurbsCurve(line, { tolerance: 0 }), 'range');
  refuses(() => tessellateNurbsCurve(line, { maxPoints: 1 }), 'range');
  refuses(() => tessellateNurbsCurve(CIRCLE, { tolerance: 1e-9, maxPoints: 50 }), 'limit');
  const s = sphere();
  refuses(() => evaluateNurbsSurface({ ...s, countV: 4 }, 0, 0), 'range');
  refuses(() => evaluateNurbsSurface({ ...s, countU: 1.5 }, 0, 0), 'range');
  refuses(() => evaluateNurbsSurface(s, 9, 0), 'range');
  refuses(() => tessellateNurbsSurface(s, { segmentsU: 0 }), 'range');
  refuses(() => tessellateNurbsSurface(s, { maxVertices: 10 }), 'limit');
  refuses(() => tessellateNurbsSurface(s, { maxTriangles: 10 }), 'limit');
});

test('the numbers are those of the one evaluator in @margoengine/geometry/nurbs', async () => {
  const { NurbsCurve, NurbsSurface } = await import('@margoengine/geometry/nurbs'),
    knots = [0, 0, 0, 1, 2, 2, 2],
    net = [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 1]],
    weights = [1, 2, 0.5, 1],
    curve = new NurbsCurve({ points: net, degree: 2, knots, weights }),
    surface = new NurbsSurface({
      points: [net, net.map(([x, y, z]) => [x, y + 1, z + 2]), net.map(([x, y, z]) => [x, y, z + 4])],
      degreeU: 1,
      degreeV: 2,
      knotsU: [0, 0, 0.5, 1, 1],
      knotsV: knots,
    }),
    data = {
      degreeU: 1,
      degreeV: 2,
      knotsU: [0, 0, 0.5, 1, 1],
      knotsV: knots,
      countU: 3,
      countV: 4,
      points: [net, net.map(([x, y, z]) => [x, y + 1, z + 2]), net.map(([x, y, z]) => [x, y, z + 4])].flat(2),
    };
  for (const t of [0, 0.3, 1, 1.7, 2])
    assert.deepEqual(evaluateNurbsCurve({ degree: 2, knots, points: net.flat(), weights }, t), curve.evaluate(t));
  for (const [u, v] of [[0, 0], [0.25, 1.5], [1, 2]])
    assert.deepEqual(evaluateNurbsSurface(data, u, v).position, surface.evaluate(u, v));
});
