import type { Spline } from './index.js';
import { CubicSpline } from './kinds.js';
import { checkVector, controls, cross, evaluate, segmentCount } from './polynomial.js';

/** Parallel-curve fitting options; all distances use the source's world units. */
export interface SplineOffsetOptions {
  /** Reference-plane normal; positive offset is normal cross tangent. Default [0,0,1]. */
  normal?: ArrayLike<number>;
  /** Conservative spatial error bound for the returned cubic approximation. Default 0.001. */
  tolerance?: number;
  /** Maximum fitting subdivisions per source piece. Default 20. */
  maxDepth?: number;
  /** Maximum output cubic pieces. Default 16384. */
  maxSegments?: number;
  /** Maximum interval verification nodes. Default 1000000. */
  maxWork?: number;
  /** Arc-length lookup resolution for the result. Default max(256,8*pieces), capped at 1000000. */
  divisions?: number;
}
/** Cubic offset approximation with source-parameter mapping and a conservative verified error bound. */
export interface SplineOffsetResult {
  spline: CubicSpline;
  /** Source t0,t1 for each output piece; a zero-width range denotes a bevel join. */
  ranges: Float64Array;
  /** Maximum interval enclosure of approximation error, including roundoff allowance; excludes bevel joins. */
  maxError: number;
  /** Deterministic interval verification work, not elapsed time. */
  work: number;
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalVector(value: ArrayLike<number>): Float64Array {
  checkVector(value);
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!length) throw new RangeError('Invalid offset normal; pass a nonzero plane normal.');
  return Float64Array.from(value, (v) => v / length);
}
function offsetValue(p: Float64Array, t: number, distance: number, normal: Float64Array): [Float64Array, Float64Array] {
  const point = evaluate(p, t, 0),
    derivative = evaluate(p, t, 1);
  if (!distance) return [point, derivative];
  const w = cross(normal, derivative),
    wp = cross(normal, evaluate(p, t, 2)),
    length = Math.hypot(...w);
  if (!length)
    throw Object.assign(
      new RangeError(
        'Offset normal is undefined; remove stationary points or choose a normal transverse to the tangent.',
      ),
      { code: 'singular' },
    );
  const projection = dot(w, wp) / length ** 3;
  for (let a = 0; a < 3; a++) {
    point[a] += (distance * w[a]) / length;
    derivative[a] += distance * (wp[a] / length - w[a] * projection);
  }
  return [point, derivative];
}

/** Exact signed-distance offset at a source parameter; no polynomial approximation or arc-length remapping. */
export function offsetSplineAt(
  spline: Spline,
  t: number,
  distance: number,
  normal: ArrayLike<number> = [0, 0, 1],
  output = new Float64Array(3),
): Float64Array {
  if (!Number.isFinite(distance) || !Number.isFinite(t) || t < 0 || t > 1 || output.length !== 3)
    throw new RangeError('Invalid offset point; pass finite distance, t in 0..1 and output length three.');
  const n = segmentCount(spline),
    scaled = (spline.closed && t === 1 ? 0 : t) * n,
    i = Math.min(n - 1, Math.floor(scaled));
  output.set(offsetValue(controls(spline, i), scaled - i, distance, normalVector(normal))[0]);
  return output;
}

function halves(p: Float64Array): [Float64Array, Float64Array] {
  const q = p.slice(),
    a = new Float64Array(12),
    b = new Float64Array(12);
  for (let level = 0; level < 4; level++) {
    a.set(q.subarray(0, 3), level * 3);
    b.set(q.subarray((3 - level) * 3, (4 - level) * 3), (3 - level) * 3);
    for (let i = 0; i < 3 - level; i++)
      for (let k = 0; k < 3; k++) q[i * 3 + k] = (q[i * 3 + k] + q[(i + 1) * 3 + k]) / 2;
  }
  return [a, b];
}

// Bernstein hulls enclose both the residual cubic and the quadratic unnormalized normal.
// Interval division then encloses every unit-normal component, not only sampled normals.
function errorBound(source: Float64Array, residual: Float64Array, distance: number, normal: Float64Array): number {
  if (!distance) return Math.max(...residual.map(Math.abs)) * Math.sqrt(3);
  const w = [0, 1, 2].map((i) =>
    cross(normal, new Float64Array([0, 1, 2].map((a) => 3 * (source[(i + 1) * 3 + a] - source[i * 3 + a])))),
  );
  const low = [0, 1, 2].map((a) => Math.min(...w.map((v) => v[a]))),
    high = [0, 1, 2].map((a) => Math.max(...w.map((v) => v[a])));
  const lower = Math.hypot(...low.map((v, a) => (v > 0 ? v : high[a] < 0 ? -high[a] : 0)));
  const upper = Math.hypot(...low.map((v, a) => Math.max(Math.abs(v), Math.abs(high[a]))));
  if (!lower) return Infinity;
  let bound2 = 0;
  for (let a = 0; a < 3; a++) {
    const ratios = [low[a] / lower, low[a] / upper, high[a] / lower, high[a] / upper];
    const n0 = Math.max(-1, Math.min(...ratios)) * distance,
      n1 = Math.min(1, Math.max(...ratios)) * distance;
    const r = [0, 1, 2, 3].map((i) => residual[i * 3 + a]),
      lo = Math.min(...r) - Math.max(n0, n1),
      hi = Math.max(...r) - Math.min(n0, n1);
    bound2 += Math.max(Math.abs(lo), Math.abs(hi)) ** 2;
  }
  const roundoff = 128 * Number.EPSILON * Math.max(1, Math.abs(distance), ...source.map(Math.abs));
  return Math.sqrt(bound2) + roundoff;
}

/** Build cubic parallel pieces; interval verification bounds error everywhere, including between fit samples. */
export function offsetSpline(source: Spline, distance: number, options: SplineOffsetOptions = {}): SplineOffsetResult {
  const normal = normalVector(options.normal ?? [0, 0, 1]),
    tolerance = options.tolerance ?? 0.001,
    maxDepth = options.maxDepth ?? 20,
    maxSegments = options.maxSegments ?? 16384,
    maxWork = options.maxWork ?? 1000000;
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 30 ||
    !Number.isSafeInteger(maxSegments) ||
    maxSegments < 1 ||
    maxSegments > 333333 ||
    !Number.isSafeInteger(maxWork) ||
    maxWork < 1
  )
    throw new RangeError(
      'Invalid offset options; pass finite distance, positive tolerance, maxDepth 0..30 and positive bounded work/segment counts.',
    );
  const pieces: Float64Array[] = [],
    ranges: number[] = [],
    n = segmentCount(source);
  let work = 0,
    maxError = 0;
  const verify = (p: Float64Array, q: Float64Array): number => {
    const residual = q.map((v, i) => v - p[i]);
    const stack: { p: Float64Array; r: Float64Array; depth: number }[] = [{ p, r: residual, depth: 0 }];
    let maximum = 0;
    while (stack.length) {
      if (++work > maxWork)
        throw Object.assign(
          new RangeError('Offset verification work limit reached; raise maxWork or choose a larger tolerance.'),
          { code: 'limit' },
        );
      const current = stack.pop()!,
        bound = errorBound(current.p, current.r, distance, normal);
      if (bound <= tolerance) {
        maximum = Math.max(maximum, bound);
        continue;
      }
      // A midpoint residual exceeding tolerance rejects this fitted cubic without hiding an error.
      const actual = offsetValue(current.p, 0.5, distance, normal)[0],
        base = evaluate(current.p, 0.5, 0),
        r = evaluate(current.r, 0.5, 0);
      if (Math.hypot(...actual.map((v, a) => v - base[a] - r[a])) > tolerance || current.depth >= 20) return Infinity;
      const pp = halves(current.p),
        rr = halves(current.r);
      for (let i = 0; i < 2; i++) stack.push({ p: pp[i], r: rr[i], depth: current.depth + 1 });
    }
    return maximum;
  };
  const fit = (p: Float64Array, t0: number, t1: number, depth: number): void => {
    const [a, da] = offsetValue(p, 0, distance, normal),
      [b, db] = offsetValue(p, 1, distance, normal),
      q = new Float64Array(12);
    q.set(a);
    q.set(b, 9);
    for (let k = 0; k < 3; k++) {
      q[k + 3] = a[k] + da[k] / 3;
      q[k + 6] = b[k] - db[k] / 3;
    }
    let sampleError = 0;
    for (const t of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      const exact = offsetValue(p, t, distance, normal)[0],
        approx = evaluate(q, t, 0);
      sampleError = Math.max(sampleError, Math.hypot(...exact.map((v, a) => v - approx[a])));
    }
    const bound = sampleError <= tolerance / 2 ? verify(p, q) : Infinity;
    if (bound <= tolerance) {
      if (pieces.length >= maxSegments)
        throw Object.assign(
          new RangeError('Offset segment limit reached; raise maxSegments or choose a larger tolerance.'),
          { code: 'limit' },
        );
      if (pieces.length) {
        const end = pieces[pieces.length - 1].subarray(9, 12),
          gap = Math.hypot(...a.map((v, k) => v - end[k]));
        const eps = 128 * Number.EPSILON * Math.max(1, ...end.map(Math.abs), ...a.map(Math.abs));
        if (gap > eps) {
          if (pieces.length + 1 >= maxSegments)
            throw Object.assign(new RangeError('Offset join segment limit reached; raise maxSegments.'), {
              code: 'limit',
            });
          const join = new Float64Array(12);
          for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) join[i * 3 + k] = end[k] + ((a[k] - end[k]) * i) / 3;
          pieces.push(join);
          ranges.push(t0, t0);
        }
      }
      pieces.push(q);
      ranges.push(t0, t1);
      maxError = Math.max(maxError, bound);
      return;
    }
    if (depth >= maxDepth)
      throw Object.assign(new RangeError('Offset fit depth reached; raise maxDepth or choose a larger tolerance.'), {
        code: 'limit',
      });
    const [left, right] = halves(p),
      mid = (t0 + t1) / 2;
    fit(left, t0, mid, depth + 1);
    fit(right, mid, t1, depth + 1);
  };
  for (let i = 0; i < n; i++) fit(controls(source, i), i / n, (i + 1) / n, 0);
  const points: Float64Array[] = [];
  for (const p of pieces) {
    if (!points.length) points.push(p.slice(0, 3));
    points.push(p.slice(3, 6), p.slice(6, 9), p.slice(9, 12));
  }
  if (source.closed) {
    const start = points[0],
      end = points[points.length - 1],
      gap = Math.hypot(...start.map((v, a) => v - end[a]));
    const eps = 128 * Number.EPSILON * Math.max(1, ...start.map(Math.abs), ...end.map(Math.abs));
    if (gap > eps) {
      if (pieces.length >= maxSegments)
        throw Object.assign(new RangeError('Offset closing join limit reached; raise maxSegments.'), { code: 'limit' });
      for (let i = 1; i <= 3; i++) points.push(end.map((v, a) => v + ((start[a] - v) * i) / 3));
      pieces.push(new Float64Array(12));
      ranges.push(1, 1);
    }
    points[points.length - 1] = points[0].slice();
  }
  const closes = source.closed;
  const spline = new CubicSpline(points, {
    closed: closes,
    divisions: options.divisions ?? Math.min(1000000, Math.max(256, pieces.length * 8)),
  });
  return { spline, ranges: Float64Array.from(ranges), maxError, work };
}

/** Reverse every cubic exactly, preserving source geometry, closure and global t -> 1-t correspondence. */
export function reverseSpline(source: Spline): CubicSpline {
  const n = segmentCount(source),
    points: Float64Array[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = controls(source, i);
    if (!points.length) points.push(p.slice(9, 12));
    points.push(p.slice(6, 9), p.slice(3, 6), p.slice(0, 3));
  }
  return new CubicSpline(points, { closed: source.closed, divisions: source.arcLengths.length - 1 });
}
