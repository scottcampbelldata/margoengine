import { Spline } from './index.js';

/** Options for {@link fitSpline}. */
export interface FitOptions {
  /** Largest distance allowed between any input point and the fitted curve, above 0, in the points' own units. */
  tolerance: number;
  /** Newton refinements of each point's curve parameter before a piece is split, an integer 0..20. Default 4. */
  refinements?: number;
  /** Samples of the arc-length lookup of the returned spline. Default 256. */
  divisions?: number;
}
/** Result of {@link fitSpline}. */
export interface FitResult {
  /** The cubic Bezier control points, 3 numbers each: `3 * pieces + 1` points. */
  points: Float64Array;
  /** The fitted curve as a `kind: 'bezier'` spline. */
  spline: Spline;
  /** Number of cubic pieces. */
  pieces: number;
  /** Largest distance from an input point to the curve, measured at that point's own parameter. At most `tolerance`. */
  maxError: number;
}

type V = [number, number, number];
const sub = (a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number): V => [
  a[ao] - b[bo],
  a[ao + 1] - b[bo + 1],
  a[ao + 2] - b[bo + 2],
];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const bez = (c: Float64Array, u: number, order: 0 | 1 | 2): V => {
  // Value or derivative of a cubic from its 12 control numbers.
  const v = 1 - u,
    w: number[] =
      order === 0
        ? [v * v * v, 3 * v * v * u, 3 * v * u * u, u * u * u]
        : order === 1
          ? [-3 * v * v, 3 * v * v - 6 * v * u, 6 * v * u - 3 * u * u, 3 * u * u]
          : [6 * v, -12 * v + 6 * u, 6 * v - 12 * u, 6 * u],
    out: V = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = w[0] * c[k] + w[1] * c[3 + k] + w[2] * c[6 + k] + w[3] * c[9 + k];
  return out;
};

/** Least-squares cubic through `first..last` with the end tangents fixed in direction. */
function generate(pts: Float64Array, first: number, last: number, params: Float64Array, t1: V, t2: V): Float64Array {
  const n = last - first + 1,
    c = new Float64Array(12),
    p0 = first * 3,
    p3 = last * 3;
  for (let k = 0; k < 3; k++) {
    c[k] = pts[p0 + k];
    c[9 + k] = pts[p3 + k];
  }
  let c00 = 0,
    c01 = 0,
    c11 = 0,
    x0 = 0,
    x1 = 0;
  for (let i = 0; i < n; i++) {
    const u = params[i],
      v = 1 - u,
      b0 = v * v * v,
      b1 = 3 * v * v * u,
      b2 = 3 * v * u * u,
      b3 = u * u * u,
      a1: V = [t1[0] * b1, t1[1] * b1, t1[2] * b1],
      a2: V = [t2[0] * b2, t2[1] * b2, t2[2] * b2],
      q = (first + i) * 3;
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const r: V = [0, 0, 0];
    for (let k = 0; k < 3; k++) r[k] = pts[q + k] - (c[k] * (b0 + b1) + c[9 + k] * (b2 + b3));
    x0 += dot(a1, r);
    x1 += dot(a2, r);
  }
  const det = c00 * c11 - c01 * c01,
    span = Math.hypot(pts[p3] - pts[p0], pts[p3 + 1] - pts[p0 + 1], pts[p3 + 2] - pts[p0 + 2]);
  let alpha1 = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0,
    alpha2 = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  // Handles that collapse or point backward would make loops; fall back to a third of the chord.
  if (!(alpha1 > 1e-6 * span) || !(alpha2 > 1e-6 * span)) alpha1 = alpha2 = span / 3;
  for (let k = 0; k < 3; k++) {
    c[3 + k] = c[k] + t1[k] * alpha1;
    c[6 + k] = c[9 + k] + t2[k] * alpha2;
  }
  return c;
}
/** Largest point-to-curve distance (at the given parameters) and the index it happens at. */
function worst(pts: Float64Array, first: number, last: number, c: Float64Array, params: Float64Array): [number, number] {
  let max = 0,
    at = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i++) {
    const p = bez(c, params[i - first], 0),
      d = Math.hypot(p[0] - pts[i * 3], p[1] - pts[i * 3 + 1], p[2] - pts[i * 3 + 2]);
    if (d > max) {
      max = d;
      at = i;
    }
  }
  return [max, at];
}
function refine(pts: Float64Array, first: number, last: number, c: Float64Array, params: Float64Array): void {
  for (let i = first + 1; i < last; i++) {
    const u = params[i - first],
      p = bez(c, u, 0),
      d1 = bez(c, u, 1),
      d2 = bez(c, u, 2),
      e: V = [p[0] - pts[i * 3], p[1] - pts[i * 3 + 1], p[2] - pts[i * 3 + 2]],
      num = dot(e, d1),
      den = dot(d1, d1) + dot(e, d2);
    if (Math.abs(den) > 1e-12) params[i - first] = Math.min(1, Math.max(0, u - num / den));
  }
}

/**
 * Turn a dense run of 3D points (a GPS track, a freehand stroke) into a few cubic Bezier pieces that stay within
 * `tolerance` of every input point. Each piece is a least-squares cubic with tangents taken from the points, refined
 * by Newton steps on each point's parameter; a piece that misses the tolerance is cut at its worst point and both
 * halves are fitted again. Repeated points are dropped. Pieces join with matching tangents except at cuts forced by
 * sharp corners, where the cut tangent is shared and the curve stays smooth.
 */
export function fitSpline(points: readonly ArrayLike<number>[], { tolerance, refinements = 4, divisions = 256 }: FitOptions): FitResult {
  if (!(Number.isFinite(tolerance) && tolerance > 0)) throw new RangeError('tolerance must be above 0');
  if (!Number.isInteger(refinements) || refinements < 0 || refinements > 20)
    throw new RangeError('refinements must be an integer from 0 to 20');
  if (points.length < 2 || points.length > 10_000_000) throw new RangeError('Give 2 to 10,000,000 points');
  const kept: number[] = [];
  for (const p of points) {
    if (p.length !== 3 || !(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])))
      throw new TypeError('Every point must be a finite 3D point');
    const n = kept.length;
    if (!n || Math.hypot(p[0] - kept[n - 3], p[1] - kept[n - 2], p[2] - kept[n - 1]) > 1e-12) kept.push(p[0], p[1], p[2]);
  }
  const pts = Float64Array.from(kept),
    count = pts.length / 3;
  if (count < 2) throw new RangeError('Need at least two distinct points');
  const out: number[] = [...pts.subarray(0, 3)];
  let maxError = 0;
  // End direction from the quadratic through the end point and the next two points (second-order accurate, so a
  // true cubic is recovered exactly where the plain chord to a neighbor would tilt the handle off the data).
  const endTangent = (i: number, step: 1 | -1): V => {
    const j = i + step,
      k = i + 2 * step;
    if (k < 0 || k >= count) return unit(sub(pts, j * 3, pts, i * 3));
    const s1 = Math.hypot(...sub(pts, j * 3, pts, i * 3)),
      s2 = s1 + Math.hypot(...sub(pts, k * 3, pts, j * 3)),
      w0 = -(s1 + s2) / (s1 * s2),
      w1 = s2 / (s1 * (s2 - s1)),
      w2 = -s1 / (s2 * (s2 - s1)),
      d: V = [0, 0, 0];
    for (let c = 0; c < 3; c++) d[c] = w0 * pts[i * 3 + c] + w1 * pts[j * 3 + c] + w2 * pts[k * 3 + c];
    return unit(d);
  };
  const stack: [number, number, V, V][] = [[0, count - 1, endTangent(0, 1), endTangent(count - 1, -1)]];
  while (stack.length) {
    const [first, last, t1, t2] = stack.pop()!;
    let c: Float64Array;
    if (last - first === 1) {
      const span = Math.hypot(...sub(pts, last * 3, pts, first * 3)) / 3;
      c = new Float64Array(12);
      for (let k = 0; k < 3; k++) {
        c[k] = pts[first * 3 + k];
        c[3 + k] = c[k] + t1[k] * span;
        c[9 + k] = pts[last * 3 + k];
        c[6 + k] = c[9 + k] + t2[k] * span;
      }
      emit(c, 0);
      continue;
    }
    const n = last - first + 1,
      params = new Float64Array(n);
    for (let i = 1; i < n; i++)
      params[i] = params[i - 1] + Math.hypot(...sub(pts, (first + i) * 3, pts, (first + i - 1) * 3));
    const total = params[n - 1];
    for (let i = 1; i < n; i++) params[i] /= total;
    c = generate(pts, first, last, params, t1, t2);
    let [error, at] = worst(pts, first, last, c, params);
    for (let r = 0; r < refinements && error > tolerance; r++) {
      refine(pts, first, last, c, params);
      c = generate(pts, first, last, params, t1, t2);
      [error, at] = worst(pts, first, last, c, params);
    }
    if (error <= tolerance) {
      emit(c, error);
      continue;
    }
    // Cut at the worst point; both sides share the direction through it.
    at = Math.min(last - 1, Math.max(first + 1, at));
    const center = unit(sub(pts, (at - 1) * 3, pts, (at + 1) * 3));
    stack.push([at, last, [-center[0], -center[1], -center[2]], t2], [first, at, t1, center]);
  }
  function emit(c: Float64Array, error: number): void {
    for (let k = 3; k < 12; k++) out.push(c[k]);
    if (error > maxError) maxError = error;
  }
  const result = Float64Array.from(out),
    pieces = (out.length / 3 - 1) / 3;
  const arrays: number[][] = [];
  for (let i = 0; i < result.length; i += 3) arrays.push([result[i], result[i + 1], result[i + 2]]);
  return { points: result, spline: new Spline(arrays, { kind: 'bezier', divisions }), pieces, maxError };
}
