import type { Spline } from './index.js';

/** Where a point lands on a spline: see {@link closestPointOnSpline}. */
export interface ClosestPoint {
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
export interface ClosestPointOptions {
  /** Coarse samples tried before refining, an integer 2..1,000,000. Default: the spline's own `divisions`. */
  samples?: number;
  /** Bisection steps that refine the best sample, an integer 0..200. Default 52 (to full double precision). */
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

/**
 * Nearest position on a spline to a 3D point, for snapping, rails, cameras on tracks and AI paths.
 * It samples the curve, then refines around the best sample by bisecting on the slope of the distance, so a curve with several
 * close passes (a tight spiral) needs `samples` high enough to tell them apart. Ties go to the smaller parameter.
 */
export function closestPointOnSpline(
  spline: Spline,
  query: ArrayLike<number>,
  { samples = spline.arcLengths.length - 1, iterations = 52 }: ClosestPointOptions = {},
  output: ClosestPoint = { t: 0, arc: 0, point: new Float64Array(3), distance: 0 },
): ClosestPoint {
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
  let best = 0,
    bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = squared(spline, i / samples, scratch, x, y, z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // The minimum lies between the neighbors of the best sample (a closed curve's seam is one point, so ends clamp).
  // Inside, the slope of the distance is (curve - query) . tangent: bisect on its sign, which stays exact to the last
  // digit where minimizing the squared distance directly would stop at about its square root.
  let low = Math.max(0, best - 1) / samples,
    high = Math.min(samples, best + 1) / samples,
    t = best / samples;
  const tangent = new Float64Array(3),
    slope = (at: number): number => {
      spline.at(at, scratch);
      spline.tangent(at, tangent);
      return (scratch[0] - x) * tangent[0] + (scratch[1] - y) * tangent[1] + (scratch[2] - z) * tangent[2];
    };
  if (iterations > 0 && slope(low) < 0 && slope(high) > 0) {
    for (let i = 0; i < iterations; i++) {
      const mid = (low + high) / 2;
      if (slope(mid) < 0) low = mid;
      else high = mid;
    }
    const candidate = (low + high) / 2,
      fCandidate = squared(spline, candidate, scratch, x, y, z);
    if (fCandidate <= bestD) {
      t = candidate;
      bestD = fCandidate;
    }
  } else if (iterations > 0) {
    // No interior minimum: the best sample, or an end of the curve, is already the answer.
    for (const edge of [low, high]) {
      const f = squared(spline, edge, scratch, x, y, z);
      if (f < bestD) {
        bestD = f;
        t = edge;
      }
    }
  }
  spline.at(t, output.point);
  output.t = t;
  output.arc = distanceAt(spline, t);
  output.distance = Math.sqrt(bestD);
  return output;
}
