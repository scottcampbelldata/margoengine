import { Vector3 } from './vector3.js';
import type { MatrixLike, Vec3Like } from './types.js';

// sin² of the angle between two directions below which they count as parallel (float rounding of the cross term).
const PARALLEL = 1e-14;
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Line segment from `start` to `end`. Parameter `t` runs from 0 at `start` to 1 at `end`; a zero-length segment acts
 * as the single point `start`. Methods that take an `out` write into it and return it; it may be an input.
 */
export class Line3 {
  constructor(
    public start = new Vector3(),
    public end = new Vector3(),
  ) {}

  set(start: Vec3Like, end: Vec3Like): this {
    this.start.copy(start);
    this.end.copy(end);
    return this;
  }
  copy(line: Line3): this {
    return this.set(line.start, line.end);
  }
  clone(): Line3 {
    return new Line3().copy(this);
  }
  getCenter<T extends Vec3Like>(out: T): T {
    return this.at(0.5, out);
  }
  /** `end - start`. */
  delta<T extends Vec3Like>(out: T): T {
    const { start, end } = this,
      x = end.x - start.x,
      y = end.y - start.y,
      z = end.z - start.z;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  distance(): number {
    return this.start.distanceTo(this.end);
  }
  distanceSq(): number {
    return this.start.distanceToSquared(this.end);
  }
  /** The point at parameter `t`; values outside 0..1 lie on the infinite line. */
  at<T extends Vec3Like>(t: number, out: T): T {
    const { start, end } = this,
      x = start.x + (end.x - start.x) * t,
      y = start.y + (end.y - start.y) * t,
      z = start.z + (end.z - start.z) * t;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  /** Parameter of the point nearest `p`: on the infinite line, or within 0..1 with `clampToLine`. 0 for zero length. */
  closestPointToPointParameter(p: Vec3Like, clampToLine = false): number {
    const { start, end } = this,
      dx = end.x - start.x,
      dy = end.y - start.y,
      dz = end.z - start.z,
      length2 = dx * dx + dy * dy + dz * dz;
    if (length2 === 0) return 0;
    const t = ((p.x - start.x) * dx + (p.y - start.y) * dy + (p.z - start.z) * dz) / length2;
    return clampToLine ? clamp01(t) : t;
  }
  /** The point nearest `p`: on the infinite line, or on the segment with `clampToLine`. */
  closestPointToPoint<T extends Vec3Like>(p: Vec3Like, clampToLine: boolean, out: T): T {
    return this.at(this.closestPointToPointParameter(p, clampToLine), out);
  }
  /** Squared distance from `p` to the segment. */
  distanceSqToPoint(p: Vec3Like): number {
    const t = this.closestPointToPointParameter(p, true),
      { start, end } = this,
      dx = start.x + (end.x - start.x) * t - p.x,
      dy = start.y + (end.y - start.y) * t - p.y,
      dz = start.z + (end.z - start.z) * t - p.z;
    return dx * dx + dy * dy + dz * dz;
  }
  /** Distance from `p` to the segment. */
  distanceToPoint(p: Vec3Like): number {
    return Math.sqrt(this.distanceSqToPoint(p));
  }
  /**
   * Squared distance between this segment and `line`, with the nearest point of each written to `outThis` and
   * `outOther` when given (both optional). Overlapping parallel segments report one of their nearest pairs.
   */
  distanceSqToLine3(line: Line3, outThis?: Vec3Like, outOther?: Vec3Like): number {
    const p = this.start,
      q = line.start,
      ux = this.end.x - p.x,
      uy = this.end.y - p.y,
      uz = this.end.z - p.z,
      vx = line.end.x - q.x,
      vy = line.end.y - q.y,
      vz = line.end.z - q.z,
      wx = p.x - q.x,
      wy = p.y - q.y,
      wz = p.z - q.z,
      a = ux * ux + uy * uy + uz * uz,
      e = vx * vx + vy * vy + vz * vz,
      f = vx * wx + vy * wy + vz * wz;
    let s = 0,
      t = 0;
    if (a === 0) t = e === 0 ? 0 : clamp01(f / e);
    else {
      const c = ux * wx + uy * wy + uz * wz;
      if (e === 0) s = clamp01(-c / a);
      else {
        const b = ux * vx + uy * vy + uz * vz,
          denominator = a * e - b * b;
        // The lines' nearest point, held to this segment; parallel lines have no single one, so start from s = 0.
        if (denominator > PARALLEL * a * e) s = clamp01((b * f - c * e) / denominator);
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = clamp01(-c / a);
        } else if (t > 1) {
          t = 1;
          s = clamp01((b - c) / a);
        }
      }
    }
    const x = wx + ux * s - vx * t,
      y = wy + uy * s - vy * t,
      z = wz + uz * s - vz * t;
    if (outThis) this.at(s, outThis);
    if (outOther) line.at(t, outOther);
    return x * x + y * y + z * z;
  }
  /** Distance between this segment and `line`. */
  distanceToLine3(line: Line3): number {
    return Math.sqrt(this.distanceSqToLine3(line));
  }
  applyMatrix4(m: MatrixLike): this {
    this.start.applyMatrix4(m);
    this.end.applyMatrix4(m);
    return this;
  }
  equals(line: Line3, epsilon = 0): boolean {
    return this.start.equals(line.start, epsilon) && this.end.equals(line.end, epsilon);
  }
}
