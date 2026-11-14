// Where a non-rational B-spline edge crosses an analytic surface, the crossing search prunes an interval once the
// distance at its ends is more than the curve can bend back by: it needs a bound on |C''| over the interval. Splines
// had none (Infinity), so an edge running nearly tangent along a cylinder (abc 00000044 step_007's check) was cut to
// the resolution all along it. The bound is the largest second-derivative control point of the spans the interval
// meets (their convex hull holds C''), and Infinity across a corner knot (C' may jump there).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const { curveSurfaceCrossings, frameOf, curveEvaluator } = model;
const mm = 0.001,
  r = 10 * mm;

/** A cylinder of radius r about z whose reads of its radius are counted (a signed distance reads it once). */
function countedCylinder() {
  const s = { kind: 'cylinder', frame: frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0]), radius: r },
    count = { n: 0 };
  return {
    count,
    surface: new Proxy(s, {
      get(t, k) {
        if (k === 'radius') count.n++;
        return t[k];
      },
    }),
  };
}

/**
 * A cubic B-spline over [0, 1] along the cylinder's generator x = r, y = 0, from z = 0 to 50 mm, standing off it by
 * g(t) (control values `gaps`): its signed distance to the cylinder is g(t) exactly.
 */
function alongside(gaps, multiplicities) {
  const n = gaps.length,
    inner = n - 4,
    knots = [0, ...Array.from({ length: inner }, (_, i) => (i + 1) / (inner + 1)), 1];
  return {
    kind: 'spline',
    degrees: [3],
    counts: [n],
    knots: [knots],
    multiplicities: [multiplicities ?? knots.map((_, i) => (i === 0 || i === knots.length - 1 ? 4 : 1))],
    points: gaps.map((g, i) => [r + g, 0, (50 * mm * i) / (n - 1)]),
  };
}

/** The sign changes of the curve's distance g(t) on a fine grid, each bisected (the roots to compare with). */
function roots(curve, samples = 200_000) {
  const c = curveEvaluator(curve),
    g = (t) => c.at(t)[0] - r,
    out = [];
  let a = 0,
    ga = g(0);
  for (let k = 1; k <= samples; k++) {
    const b = k / samples,
      gb = g(b);
    if (ga < 0 !== gb < 0) {
      let lo = a,
        hi = b,
        glo = ga;
      for (let i = 0; i < 200 && hi - lo > 0; i++) {
        const m = (lo + hi) / 2;
        if (m <= lo || m >= hi) break;
        const gm = g(m);
        if (gm < 0 === glo < 0) (lo = m), (glo = gm);
        else hi = m;
      }
      out.push(lo);
    }
    a = b;
    ga = gb;
  }
  return out;
}

test('a spline edge running a tenth of a micron off a cylinder is passed over in a few thousand distances', () => {
  // Before, with no bound on a spline's |C''|, only the speed test pruned: intervals were cut until the curve could
  // not travel the gap between their ends, over a million distances along the 50 mm.
  const gaps = [1, 1.5, 0.8, 1.2, 0.9, 1.4, 1.1, 1].map((g) => g * 1e-7),
    curve = alongside(gaps),
    { surface, count } = countedCylinder();
  assert.deepEqual(curveSurfaceCrossings(curve, surface, 0, 1), []);
  assert.ok(count.n < 20_000, `${count.n} distances`);
});

test('near-tangent crossings of a spline along a cylinder or a plane are all found, where they are', () => {
  // Control values that dip through the surface by a few tenths of a micron: every sign change of g(t) is a crossing.
  // On the plane x = r the bend is the curve's own alone, so a bound on it a thousand times too small loses some.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let trial = 0; trial < 12; trial++) {
    const gaps = Array.from({ length: 24 }, () => random() * 3e-7),
      curve = alongside(gaps),
      plane = { kind: 'plane', frame: frameOf([r, 0, 0], [1, 0, 0], [0, 0, 1]) },
      want = roots(curve);
    for (const surface of [countedCylinder().surface, plane]) {
      const found = curveSurfaceCrossings(curve, surface, 0, 1);
      assert.equal(found.length, want.length, `trial ${trial} on the ${surface.kind}`);
      for (let i = 0; i < want.length; i++)
        assert.ok(Math.abs(found[i] - want[i]) < 1e-9, `trial ${trial} root ${i} on the ${surface.kind}`);
    }
  }
});

test('a corner knot inside an interval leaves its bend unbounded: a V through the surface is crossed twice', () => {
  // Straight on both sides of a triple knot at t = 0.4 (its second-derivative control points all but zero), a corner
  // there dipping 0.1 micron through. Taking the straight spans' bound across the corner would prune the interval of
  // 1/256 holding it from its ends and middle (1.6 microns off, its middle just past the corner) and lose both crossings.
  const gaps = [0.4 * mm, (0.8 / 3) * mm, (0.4 / 3) * mm, -1e-7, (0.4 / 3) * mm, (0.8 / 3) * mm, 0.4 * mm],
    curve = {
      kind: 'spline',
      degrees: [3],
      counts: [7],
      knots: [[0, 0.4, 1]],
      multiplicities: [[4, 3, 4]],
      points: gaps.map((g, i) => [r + g, 0, (50 * mm * i) / 6]),
    },
    { surface } = countedCylinder(),
    found = curveSurfaceCrossings(curve, surface, 0, 1),
    want = roots(curve);
  assert.equal(want.length, 2);
  assert.equal(found.length, 2);
  for (let i = 0; i < 2; i++) assert.ok(Math.abs(found[i] - want[i]) < 1e-9);
});
