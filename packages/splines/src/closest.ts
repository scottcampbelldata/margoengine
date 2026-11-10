import type { Spline } from './index.js';
import { controls, evaluate, segmentCount } from './polynomial.js';

/** Where a point lands on a spline: see {@link closestPointOnSpline}. */
export interface SplineClosestPoint {
  /** Curve parameter, 0..1, the value `spline.at` takes. */
  t: number;
  /** Arc-length position in world units, the value `spline.atDistance` takes. */
  arc: number;
  /** The nearest point on the curve. */
  point: Float64Array;
  /** Distance from the query point to `point`. */
  distance: number;
}
/** Options for {@link closestPointOnSpline}. */
export interface SplineClosestOptions {
  /**
   * Evenly spaced samples that seed the exact search (a closer seed skips more pieces; the answer does not depend on
   * it), an integer 2..1,000,000. Default: the spline's own `divisions`.
   */
  samples?: number;
  /**
   * Bisection steps that refine each minimum of the distance, an integer 0..200. Default 52 (to full double precision).
   * 0 skips the exact search and returns the nearest sample.
   */
  iterations?: number;
}

/** Arc-length position of curve parameter `t`, read from the spline's cached lookup (the inverse of `atDistance`). */
export function distanceAt(spline: Spline, t: number): number {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('Curve parameter must be 0..1');
  const lengths = spline.arcLengths,
    scaled = t * (lengths.length - 1),
    index = Math.min(lengths.length - 2, Math.floor(scaled));
  return lengths[index] + (lengths[index + 1] - lengths[index]) * (scaled - index);
}

const squared = (spline: Spline, t: number, scratch: Float64Array, x: number, y: number, z: number): number => {
  spline.at(t, scratch);
  const dx = scratch[0] - x,
    dy = scratch[1] - y,
    dz = scratch[2] - z;
  return dx * dx + dy * dy + dz * dz;
};

// Bernstein coefficients (degree 5) of g(u) = (B(u) - q) . B'(u) for one cubic piece: zero where the squared distance
// is stationary. Product of Bernstein forms: c[i + j] += C(3, i) C(2, j) / C(5, i + j) a[i] . b[j].
const BINOMIAL3 = [1, 3, 3, 1],
  BINOMIAL2 = [1, 2, 1],
  BINOMIAL5 = [1, 5, 10, 10, 5, 1];
function stationary(p: Float64Array, x: number, y: number, z: number, out: Float64Array): void {
  out.fill(0);
  for (let i = 0; i < 4; i++) {
    const ax = p[i * 3] - x,
      ay = p[i * 3 + 1] - y,
      az = p[i * 3 + 2] - z;
    for (let j = 0; j < 3; j++) {
      const b = j * 3,
        dot = 3 * (ax * (p[b + 3] - p[b]) + ay * (p[b + 4] - p[b + 1]) + az * (p[b + 5] - p[b + 2]));
      out[i + j] += ((BINOMIAL3[i] * BINOMIAL2[j]) / BINOMIAL5[i + j]) * dot;
    }
  }
}
const slopeAt = (
  p: Float64Array,
  u: number,
  x: number,
  y: number,
  z: number,
  a: Float64Array<ArrayBuffer>,
  b: Float64Array<ArrayBuffer>,
) => {
  evaluate(p, u, 0, a);
  evaluate(p, u, 1, b);
  return (a[0] - x) * b[0] + (a[1] - y) * b[1] + (a[2] - z) * b[2];
};
const changes = (c: Float64Array): number => {
  let count = 0,
    last = 0;
  for (let i = 0; i < c.length; i++)
    if (c[i] !== 0) {
      if (last && Math.sign(c[i]) !== last) count++;
      last = Math.sign(c[i]);
    }
  return count;
};

/**
 * Nearest position on a spline to a 3D point, for snapping, rails, cameras on tracks and AI paths. Exact for every
 * curve kind: each cubic piece whose control-point box could hold a closer point has the stationary points of its
 * squared distance, the roots of a quintic, isolated by subdividing its Bernstein form (the variation-diminishing
 * property bounds the roots by the sign changes of the coefficients) and refined by bisection; the piece ends are
 * candidates too. `samples` only seeds the search, so close passes of a tight spiral need no extra samples. Ties go
 * to the smaller parameter.
 */
export function closestPointOnSpline(
  spline: Spline,
  query: ArrayLike<number>,
  { samples = spline.arcLengths.length - 1, iterations = 52 }: SplineClosestOptions = {},
  output: SplineClosestPoint = { t: 0, arc: 0, point: new Float64Array(3), distance: 0 },
): SplineClosestPoint {
  if (query.length !== 3 || !(Number.isFinite(query[0]) && Number.isFinite(query[1]) && Number.isFinite(query[2])))
    throw new TypeError('Query must be a finite 3D point');
  if (!Number.isInteger(samples) || samples < 2 || samples > 1_000_000)
    throw new RangeError('samples must be an integer from 2 to 1,000,000');
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 200)
    throw new RangeError('iterations must be an integer from 0 to 200');
  const x = query[0],
    y = query[1],
    z = query[2],
    scratch = new Float64Array(3);
  let t = 0,
    bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = squared(spline, i / samples, scratch, x, y, z);
    if (d < bestD) {
      bestD = d;
      t = i / samples;
    }
  }
  if (iterations > 0) {
    const n = segmentCount(spline),
      a = new Float64Array(3),
      b = new Float64Array(3),
      roots: number[] = [];
    const isolate = (p: Float64Array, c: Float64Array, lo: number, hi: number, depth: number): void => {
      const count = changes(c);
      if (!count) return;
      if (count === 1 || depth >= 48) {
        // One sign change: one root, a minimum when the slope rises through it. Deeper ties (a double root) bisect too.
        let l = lo,
          h = hi;
        if (!(slopeAt(p, l, x, y, z, a, b) < 0 && slopeAt(p, h, x, y, z, a, b) > 0)) {
          if (count > 1) roots.push((lo + hi) / 2);
          return;
        }
        for (let k = 0; k < iterations && l < h; k++) {
          const mid = (l + h) / 2;
          if (slopeAt(p, mid, x, y, z, a, b) < 0) l = mid;
          else h = mid;
        }
        roots.push((l + h) / 2);
        return;
      }
      // de Casteljau split at the middle.
      const left = new Float64Array(6),
        right = new Float64Array(6),
        w = Float64Array.from(c);
      for (let r = 0; r < 6; r++) {
        left[r] = w[0];
        right[5 - r] = w[5 - r];
        for (let k = 0; k < 5 - r; k++) w[k] = (w[k] + w[k + 1]) / 2;
      }
      const mid = (lo + hi) / 2;
      isolate(p, left, lo, mid, depth + 1);
      isolate(p, right, mid, hi, depth + 1);
    };
    const coefficients = new Float64Array(6);
    for (let i = 0; i < n; i++) {
      const p = controls(spline, i);
      // Convex hull: no point of the piece is nearer than the box of its control points.
      let gap = 0;
      for (let axis = 0; axis < 3; axis++) {
        const v = query[axis],
          lo = Math.min(p[axis], p[axis + 3], p[axis + 6], p[axis + 9]),
          hi = Math.max(p[axis], p[axis + 3], p[axis + 6], p[axis + 9]);
        gap += v < lo ? (lo - v) ** 2 : v > hi ? (v - hi) ** 2 : 0;
      }
      if (gap > bestD) continue;
      roots.length = 0;
      roots.push(0);
      stationary(p, x, y, z, coefficients);
      isolate(p, coefficients, 0, 1, 0);
      roots.push(1);
      for (const u of roots) {
        const at = Math.min(1, (i + u) / n),
          d = squared(spline, at, scratch, x, y, z);
        if (d < bestD || (d === bestD && at < t)) {
          bestD = d;
          t = at;
        }
      }
    }
  }
  spline.at(t, output.point);
  output.t = t;
  output.arc = distanceAt(spline, t);
  output.distance = Math.sqrt(bestD);
  return output;
}
