import { cross, distance, dot, finiteNumber, normalize, rotateAxis, sub, to3, type Vec, type Vec3 } from './math.js';

/** Per-sample orthonormal frames along a curve. Arrays have `segments + 1` entries. */
export interface FrenetFrames {
  tangents: Vec3[];
  normals: Vec3[];
  binormals: Vec3[];
}

/**
 * Base class for 2D and 3D parametric curves (Three.js `Curve`). `t` is the raw parameter, `u` is normalized arc
 * length. Arc lengths are cached; call `updateArcLengths()` after mutating a curve's control points.
 */
export abstract class Curve<V extends Vec> {
  arcLengthDivisions = 200;
  private lengths: number[] | null = null;

  /** Point at parameter `t` in [0, 1]. */
  abstract getPoint(t: number): V;

  /** Point at normalized arc length `u` in [0, 1]. */
  getPointAt(u: number): V {
    return this.getPoint(this.getUtoTmapping(u));
  }

  /** `divisions + 1` points at evenly spaced `t`. */
  getPoints(divisions = 5): V[] {
    finiteNumber(divisions);
    const points: V[] = [];
    for (let d = 0; d <= divisions; d++) points.push(this.getPoint(d / divisions));
    return points;
  }

  /** `divisions + 1` points evenly spaced by arc length. */
  getSpacedPoints(divisions = 5): V[] {
    finiteNumber(divisions);
    const points: V[] = [];
    for (let d = 0; d <= divisions; d++) points.push(this.getPointAt(d / divisions));
    return points;
  }

  getLength(): number {
    const l = this.getLengths();
    return l[l.length - 1];
  }

  /** Cumulative chord lengths at `divisions + 1` evenly spaced `t` values. */
  getLengths(divisions = this.arcLengthDivisions): number[] {
    finiteNumber(divisions);
    if (this.lengths && this.lengths.length === divisions + 1) return this.lengths;
    const lengths = [0];
    let last = this.getPoint(0),
      sum = 0;
    for (let p = 1; p <= divisions; p++) {
      const current = this.getPoint(p / divisions);
      sum += distance(current, last);
      lengths.push(sum);
      last = current;
    }
    return (this.lengths = lengths);
  }

  updateArcLengths(): void {
    this.lengths = null;
  }

  /** Maps normalized arc length `u` (or an absolute `distance`) to the parameter `t`. */
  getUtoTmapping(u: number, distanceAlong?: number): number {
    const arcLengths = this.getLengths(),
      il = arcLengths.length,
      total = arcLengths[il - 1];
    if (!(total > 0)) return u;
    const target = Math.min(Math.max(distanceAlong ?? u * total, 0), total);
    let low = 0,
      high = il - 1;
    while (low <= high) {
      const i = Math.floor(low + (high - low) / 2),
        comparison = arcLengths[i] - target;
      if (comparison < 0) low = i + 1;
      else if (comparison > 0) high = i - 1;
      else {
        high = i;
        break;
      }
    }
    const i = Math.max(0, Math.min(high, il - 2));
    if (arcLengths[i] === target) return i / (il - 1);
    const segment = arcLengths[i + 1] - arcLengths[i];
    return (i + (segment > 0 ? (target - arcLengths[i]) / segment : 0)) / (il - 1);
  }

  /** Unit tangent at `t`, by central difference unless a subclass knows it exactly. */
  getTangent(t: number): V {
    const delta = 0.0001,
      t1 = Math.max(0, t - delta),
      t2 = Math.min(1, t + delta);
    return normalize(sub(this.getPoint(t2), this.getPoint(t1)));
  }

  getTangentAt(u: number): V {
    return this.getTangent(this.getUtoTmapping(u));
  }

  /**
   * Parallel-transport frames (Three.js `computeFrenetFrames`), sampled at `segments + 1` arc-length positions.
   * `closed` spreads the twist between the first and last frame over the whole curve so a closed tube meets itself.
   */
  computeFrenetFrames(segments: number, closed = false): FrenetFrames {
    finiteNumber(segments);
    const tangents: Vec3[] = [],
      normals: Vec3[] = [],
      binormals: Vec3[] = [];
    for (let i = 0; i <= segments; i++) tangents.push(normalize(to3(this.getTangentAt(i / segments))));
    const t0 = tangents[0],
      ax = Math.abs(t0[0]),
      ay = Math.abs(t0[1]),
      az = Math.abs(t0[2]);
    let min = Infinity,
      seed: Vec3 = [0, 0, 1];
    if (ax <= min) {
      min = ax;
      seed = [1, 0, 0];
    }
    if (ay <= min) {
      min = ay;
      seed = [0, 1, 0];
    }
    if (az <= min) seed = [0, 0, 1];
    const v = normalize(cross(t0, seed));
    normals[0] = cross(t0, v);
    binormals[0] = cross(t0, normals[0]);
    for (let i = 1; i <= segments; i++) {
      let n = normals[i - 1];
      const axis = cross(tangents[i - 1], tangents[i]),
        axisLength = Math.hypot(...axis);
      if (axisLength > Number.EPSILON) {
        const theta = Math.acos(Math.min(1, Math.max(-1, dot(tangents[i - 1], tangents[i]))));
        n = rotateAxis(n, normalize(axis), theta);
      }
      normals[i] = n;
      binormals[i] = cross(tangents[i], n);
    }
    if (closed) {
      let theta = Math.acos(Math.min(1, Math.max(-1, dot(normals[0], normals[segments])))) / segments;
      if (dot(tangents[0], cross(normals[0], normals[segments])) > 0) theta = -theta;
      for (let i = 1; i <= segments; i++) {
        normals[i] = rotateAxis(normals[i], tangents[i], theta * i);
        binormals[i] = cross(tangents[i], normals[i]);
      }
    }
    return { tangents, normals, binormals };
  }
}
