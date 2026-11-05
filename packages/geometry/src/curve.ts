import { cross, dot, normalize, rotateAxis, sub, to3, type MutableVec3, type Vec } from './math.js';

/**
 * Moving frames along a curve, one per sample: `segments + 1` entries in each list, sampled at equal arc length.
 * `binormals[i] = tangents[i] x normals[i]`; all three are unit length and mutually perpendicular.
 */
export interface FrenetFrames {
  tangents: MutableVec3[];
  normals: MutableVec3[];
  binormals: MutableVec3[];
}

// Parameter step for the finite-difference tangent. Central differences have O(h^2) truncation error and O(eps / h)
// rounding error; 1e-5 keeps both well under 1e-8 for curves of everyday scale.
export const tangentStep = 1e-5;
// Below this |T(i-1) x T(i)| two consecutive tangents count as parallel and the normal is carried over unchanged.
const parallelLimit = 1e-12;

/** Throws a RangeError naming the method when a sample count is not finite, before any loop runs. */
export function sampleCount(method: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RangeError(`${method} got ${value} divisions; pass a finite number`);
  return value;
}

/**
 * A parametric curve in 2D (`[x, y]`) or 3D (`[x, y, z]`).
 *
 * Two parameters run along every curve, both in [0, 1]:
 * - `t`, the raw parameter of the curve's own formula (`getPoint`, `getTangent`, `getPoints`). Equal steps in `t` are
 *   generally not equal steps in distance.
 * - `u`, the normalized arc length (`getPointAt`, `getTangentAt`, `getSpacedPoints`): `u = 0.5` is halfway along the
 *   curve by distance.
 *
 * Arc length comes from a table of cumulative chord lengths over `arcLengthDivisions + 1` evenly spaced `t` samples,
 * cached on the instance. After editing control points call `updateArcLengths()`, or the cached table is reused.
 *
 * Every point and tangent is a new array the caller may keep or mutate.
 */
export abstract class Curve<V extends Vec> {
  /** Number of chords in the cached arc-length table. Default 200. */
  arcLengthDivisions = 200;
  /** Cached cumulative chord lengths and the division count they were built with. */
  protected arcTable: number[] | null = null;
  protected arcTableDivisions = -1;

  /** The point at raw parameter `t` in [0, 1]. */
  abstract getPoint(t: number): V;

  /** The point at normalized arc length `u` in [0, 1]. */
  getPointAt(u: number): V {
    return this.getPoint(this.getUtoTmapping(u));
  }

  /** `divisions + 1` points at evenly spaced raw parameter `t = i / divisions`. */
  getPoints(divisions = 5): V[] {
    sampleCount('getPoints', divisions);
    const points: V[] = [];
    for (let i = 0; i <= divisions; i++) points.push(this.getPoint(i / divisions));
    return points;
  }

  /** `divisions + 1` points at evenly spaced arc length `u = i / divisions`. */
  getSpacedPoints(divisions = 5): V[] {
    sampleCount('getSpacedPoints', divisions);
    const points: V[] = [];
    for (let i = 0; i <= divisions; i++) points.push(this.getPointAt(i / divisions));
    return points;
  }

  /** Total length: the sum of `arcLengthDivisions` chords. */
  getLength(): number {
    const table = this.getLengths();
    return table[table.length - 1];
  }

  /**
   * Cumulative chord lengths at `divisions + 1` evenly spaced `t` samples; entry 0 is 0 and the last is the length.
   * The most recent table is cached and returned as the same array while `divisions` is unchanged.
   */
  getLengths(divisions = this.arcLengthDivisions): number[] {
    sampleCount('getLengths', divisions);
    if (this.arcTable && this.arcTableDivisions === divisions) return this.arcTable;
    const table: number[] = [0];
    let previous = this.getPoint(0),
      sum = 0;
    for (let i = 1; i <= divisions; i++) {
      const point = this.getPoint(i / divisions);
      let squared = 0;
      for (let k = 0; k < point.length; k++) squared += (point[k] - previous[k]) ** 2;
      sum += Math.sqrt(squared);
      table.push(sum);
      previous = point;
    }
    this.arcTable = table;
    this.arcTableDivisions = divisions;
    return table;
  }

  /** Drops the cached arc-length table. Call after changing the curve's control points. */
  updateArcLengths(): void {
    this.arcTable = null;
    this.arcTableDivisions = -1;
  }

  /**
   * Converts normalized arc length `u` (or an absolute `distanceAlong` the curve, when given) to raw parameter `t`, by
   * inverting the cached chord-length table with linear interpolation inside the bracketing chord. The target
   * distance is clamped to [0, length]. A curve with no length returns `u` unchanged.
   */
  getUtoTmapping(u: number, distanceAlong?: number): number {
    const table = this.getLengths(),
      last = table.length - 1,
      total = table[last];
    if (!(total > 0)) return u;
    let target = distanceAlong === undefined ? u * total : distanceAlong;
    target = target < 0 ? 0 : target > total ? total : target;
    // Largest index whose cumulative length does not exceed the target (the table is non-decreasing).
    let low = 0,
      high = last;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (table[mid] <= target) low = mid;
      else high = mid - 1;
    }
    if (table[low] === target || low === last) return low / last;
    const fraction = (target - table[low]) / (table[low + 1] - table[low]);
    return (low + fraction) / last;
  }

  /**
   * Unit tangent at raw parameter `t`: the normalized central difference of `getPoint` over a small step, one-sided
   * where the step would leave [0, 1]. Curves with a closed-form direction override this.
   */
  getTangent(t: number): V {
    const before = Math.max(0, t - tangentStep),
      after = Math.min(1, t + tangentStep);
    return normalize(sub(this.getPoint(after), this.getPoint(before)));
  }

  /** Unit tangent at normalized arc length `u`. */
  getTangentAt(u: number): V {
    return this.getTangent(this.getUtoTmapping(u));
  }

  /**
   * `segments + 1` orthonormal, right-handed frames at equal arc length, for sweeping a profile along the curve
   * (tubes, extrusions). The frames are rotation-minimizing (parallel transport): each normal is the previous one
   * turned by the smallest rotation that takes the previous tangent onto the current one, so the profile does not
   * twist on its own. The first normal is perpendicular to the first tangent, built from the world axis least aligned
   * with it. With `closed`, the twist left over after going once round is spread evenly over the frames so the last
   * frame lines up with the first (a closed tube meets itself without a seam). 2D curves get frames in the z = 0 plane.
   */
  computeFrenetFrames(segments: number, closed = false): FrenetFrames {
    sampleCount('computeFrenetFrames', segments);
    const tangents: MutableVec3[] = [],
      normals: MutableVec3[] = [],
      binormals: MutableVec3[] = [];
    for (let i = 0; i <= segments; i++) tangents.push(normalize(to3(this.getTangentAt(i / segments))));
    if (tangents.length === 0) return { tangents, normals, binormals };

    // Seed normal: the world axis least aligned with the first tangent, made perpendicular to it.
    const first = tangents[0],
      ax = Math.abs(first[0]),
      ay = Math.abs(first[1]),
      az = Math.abs(first[2]);
    const axis: MutableVec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    normals.push(perpendicular(axis, first));

    for (let i = 1; i <= segments; i++) normals.push(transport(normals[i - 1], tangents[i - 1], tangents[i]));

    if (closed && segments > 0) {
      // Carry the last normal on to the first tangent, measure how far it ends up from the first normal about that
      // tangent, then turn frame i about its own tangent by i / segments of that angle.
      const last = segments,
        carried = transport(normals[last], tangents[last], first),
        angle = Math.atan2(dot(cross(carried, normals[0]), first), dot(carried, normals[0]));
      for (let i = 1; i <= last; i++)
        normals[i] = perpendicular(rotateAxis(normals[i], tangents[i], (angle * i) / last), tangents[i]);
    }

    for (let i = 0; i <= segments; i++) binormals.push(normalize(cross(tangents[i], normals[i])));
    return { tangents, normals, binormals };
  }
}

// `v` with its component along unit `t` removed, normalized.
export function perpendicular(v: MutableVec3, t: MutableVec3): MutableVec3 {
  const along = dot(v, t);
  return normalize([v[0] - t[0] * along, v[1] - t[1] * along, v[2] - t[2] * along]);
}

// Parallel transport of `normal` from unit tangent `from` to unit tangent `to`: rotate about `from x to` by the angle
// between them (Bishop 1975; Hanson and Ma 1995). Re-orthogonalized against `to` so rounding cannot accumulate.
export function transport(normal: MutableVec3, from: MutableVec3, to: MutableVec3): MutableVec3 {
  const axis = cross(from, to),
    sine = Math.sqrt(dot(axis, axis));
  if (sine <= parallelLimit) return perpendicular(normal, to);
  const angle = Math.atan2(sine, dot(from, to));
  return perpendicular(rotateAxis(normal, [axis[0] / sine, axis[1] / sine, axis[2] / sine], angle), to);
}
