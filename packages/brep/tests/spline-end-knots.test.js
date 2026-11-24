// A B-spline whose knot list repeats its end value (abc 00000011, 12, 94, 205 and 207: a cubic listing its start knot
// twice, multiplicities 4 then 3, seven knots at t = 0, its first three control points dangling a few hundredths of a
// micron apart). Its first spans are empty: evaluating at the domain's start took one of them, whose basis is 0 / 0,
// and gave NaN, and projecting a point onto the curve lost its start: a vertex there landed on the far end of a curve
// coming back to 2.38 mm of its start. The span at an end is now the first (last) one of non-zero length.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const { curveEvaluator, surfaceEvaluator } = model;

/**
 * A cubic over [0, 1] with `extra` more knots at 0 than a clamped one (and at 1 when `bothEnds`), its first `extra`
 * control points dangling 2e-8 m apart before the real start at the origin, running out 0.1 m and back to 2.38 mm from
 * its start.
 */
function hairpin(extra, bothEnds = false) {
  const body = Array.from({ length: 20 }, (_, i) => {
      const s = i / 19,
        a = Math.PI * s;
      return [0.05 * Math.sin(a) + 0.00143 * s, 0.015 * (1 - Math.cos(a)) + 0.0019 * s - 0.03 * s, 0];
    }),
    dangling = (from, k) => Array.from({ length: extra }, (_, i) => from.map((x, c) => x + (c < 2 ? (k * (extra - i)) * 2e-8 : 0))),
    points = [...dangling(body[0], -1), ...body, ...(bothEnds ? dangling(body[body.length - 1], 1).reverse() : [])],
    inner = body.length - 4,
    knots = [0, 0, ...Array.from({ length: inner }, (_, i) => (i + 1) / (inner + 1)), 1, ...(bothEnds ? [1] : [])],
    multiplicities = [4, extra, ...Array(inner).fill(1), 4, ...(bothEnds ? [extra] : [])];
  return { curve: { kind: 'spline', degrees: [3], counts: [points.length], knots: [knots], multiplicities: [multiplicities], points }, body };
}

test('a cubic with seven knots at its start is evaluated there, and a point at its start projects to it', () => {
  for (const bothEnds of [false, true]) {
    const { curve, body } = hairpin(3, bothEnds),
      c = curveEvaluator(curve),
      start = body[0],
      end = body[body.length - 1];
    assert.deepEqual(c.domain, [0, 1]);
    const a = c.at(0),
      b = c.at(1);
    assert.ok(a.every(Number.isFinite) && b.every(Number.isFinite), `ends evaluate (${a}; ${b})`);
    assert.ok(Math.hypot(a[0] - start[0], a[1] - start[1], a[2] - start[2]) < 1e-15, `start ${a}`);
    assert.ok(Math.hypot(b[0] - end[0], b[1] - end[1], b[2] - end[2]) < 1e-15, `end ${b}`);
    // The ends are 2.38 mm apart: before, the start projected to t = 1.
    assert.ok(Math.abs(Math.hypot(end[0] - start[0], end[1] - start[1]) - 0.00238) < 1e-5);
    // The vertex a writer puts at the first (dangling) control point, 4e-8 m from the curve's start.
    const vertex = curve.points[0];
    assert.ok(c.parameter(vertex) < 1e-6, `start vertex at ${c.parameter(vertex)}`);
    assert.ok(c.parameter(start) < 1e-12, `start at ${c.parameter(start)}`);
    assert.ok(c.parameter(end, 0) > 1 - 1e-12, `end at ${c.parameter(end, 0)}`);
    assert.ok(c.parameter(end) > 1 - 1e-12, `end at ${c.parameter(end)}`);
  }
});

test('a B-spline surface with a repeated end knot is evaluated on its domain edges', () => {
  // Bicubic over [0, 1]^2, u's start knot listed twice (4 then 2): the first u spans are empty.
  const nu = 6,
    nv = 4,
    points = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) points.push([Math.max(0, i - 2) * 0.01, j * 0.01, 0.001 * Math.max(0, i - 2) * j]);
  const s = surfaceEvaluator({
      kind: 'spline',
      degrees: [3, 3],
      counts: [nu, nv],
      knots: [
        [0, 0, 1],
        [0, 1],
      ],
      multiplicities: [
        [4, 2, 4],
        [4, 4],
      ],
      points,
    }),
    q = s.at(0, 0.5);
  assert.deepEqual(s.uDomain, [0, 1]);
  assert.ok(q.every(Number.isFinite), `${q}`);
  assert.ok(Math.abs(q[0]) < 1e-15 && Math.abs(q[1] - 0.015) < 1e-12, `${q}`);
});
