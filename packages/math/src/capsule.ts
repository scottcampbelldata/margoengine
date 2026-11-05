import { Line3 } from './line3.js';
import { Vector3 } from './vector3.js';
import type { Triangle } from './triangle.js';
import type { BoxLike, MatrixLike, PlaneLike, SphereLike, Vec3Like } from './types.js';

/** A ray as {@link Capsule.intersectRay} reads it, such as a `Ray`; `direction` need not be unit length. */
export interface CapsuleRay {
  origin: Vec3Like;
  direction: Vec3Like;
}
/** An oriented box as {@link Capsule.intersectsOBB} reads it, such as an `OBB`. */
export interface OBBLike {
  center: Vec3Like;
  halfSize: Vec3Like;
  rotation: MatrixLike;
}

// Columns of a similarity matrix may differ this much, relative, in length or angle (float rounding of composed matrices).
const UNIFORM_TOLERANCE = 1e-6;

// Scratch: the break points of segment-to-box distance, a point pair, the triangle's edges as segments.
const breaks = new Float64Array(8),
  onSegment = new Vector3(),
  onOther = new Vector3(),
  edgeLine = new Line3(),
  normal = new Vector3(),
  hit = new Vector3();

/**
 * Squared distance from the segment a + t d (t in 0..1) to the box of half sizes h centred on the origin. The distance
 * is convex and a plain quadratic between the t where a coordinate crosses a face, so each such piece has a closed form.
 */
function segmentBoxDistanceSq(
  ax: number,
  ay: number,
  az: number,
  dx: number,
  dy: number,
  dz: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  let count = 0;
  breaks[count++] = 0;
  breaks[count++] = 1;
  const cross = (a: number, d: number, h: number): void => {
    if (d === 0) return;
    const t0 = (-h - a) / d,
      t1 = (h - a) / d;
    if (t0 > 0 && t0 < 1) breaks[count++] = t0;
    if (t1 > 0 && t1 < 1) breaks[count++] = t1;
  };
  cross(ax, dx, hx);
  cross(ay, dy, hy);
  cross(az, dz, hz);
  const sorted = breaks.subarray(0, count).sort();
  // Signed excess of a coordinate beyond its face, 0 inside.
  const beyond = (v: number, h: number): number => (v > h ? v - h : v < -h ? v + h : 0);
  const at = (t: number): number =>
    beyond(ax + dx * t, hx) ** 2 + beyond(ay + dy * t, hy) ** 2 + beyond(az + dz * t, hz) ** 2;
  let best = Math.min(at(0), at(1));
  for (let i = 0; i + 1 < count; i++) {
    const t0 = sorted[i],
      t1 = sorted[i + 1],
      m = (t0 + t1) / 2,
      // Which faces are active on this piece, read at its middle.
      ex = beyond(ax + dx * m, hx) === 0 ? 0 : dx,
      ey = beyond(ay + dy * m, hy) === 0 ? 0 : dy,
      ez = beyond(az + dz * m, hz) === 0 ? 0 : dz,
      slope = ex * ex + ey * ey + ez * ez;
    if (slope === 0) continue;
    const gx = ex === 0 ? 0 : ex * (beyond(ax + dx * m, hx) - dx * m),
      gy = ey === 0 ? 0 : ey * (beyond(ay + dy * m, hy) - dy * m),
      gz = ez === 0 ? 0 : ez * (beyond(az + dz * m, hz) - dz * m),
      t = Math.max(t0, Math.min(t1, -(gx + gy + gz) / slope));
    best = Math.min(best, at(t));
  }
  return best;
}

/**
 * Capsule: every point within `radius` of the segment from `start` to `end`, the usual shape of a character's collider.
 * The boundary counts as inside, so touching shapes intersect. `start` and `end` may be equal (a sphere). Methods that
 * take an `out` write into it and return it; it may be an input.
 * @throws RangeError from the constructor and `set` for a negative or non-finite radius.
 */
export class Capsule {
  /** The axis, sharing `start` and `end`. */
  readonly axis: Line3;
  readonly start: Vector3;
  readonly end: Vector3;
  radius = 0.5;

  /** Defaults to a capsule 2 tall and 0.5 in radius, standing on the origin. */
  constructor(start: Vec3Like = { x: 0, y: 0.5, z: 0 }, end: Vec3Like = { x: 0, y: 1.5, z: 0 }, radius = 0.5) {
    this.start = new Vector3();
    this.end = new Vector3();
    this.axis = new Line3(this.start, this.end);
    this.set(start, end, radius);
  }

  set(start: Vec3Like, end: Vec3Like, radius: number): this {
    if (!(radius >= 0) || radius === Infinity)
      throw new RangeError(`Capsule radius ${radius} must be finite and >= 0; pass the half width`);
    this.start.copy(start);
    this.end.copy(end);
    this.radius = radius;
    return this;
  }
  copy(capsule: Capsule): this {
    return this.set(capsule.start, capsule.end, capsule.radius);
  }
  clone(): Capsule {
    return new Capsule().copy(this);
  }
  getCenter<T extends Vec3Like>(out: T): T {
    return this.axis.getCenter(out);
  }
  translate(offset: Vec3Like): this {
    this.start.add(offset);
    this.end.add(offset);
    return this;
  }
  /**
   * Moves the capsule by rotation, translation and uniform scale (the radius scales too). A capsule stays one only
   * under those.
   * @throws RangeError for any other matrix, such as non-uniform scale or shear.
   */
  applyMatrix4(m: MatrixLike): this {
    const e = m.elements,
      dot = (i: number, j: number): number => e[i] * e[j] + e[i + 1] * e[j + 1] + e[i + 2] * e[j + 2],
      scale2 = dot(0, 0),
      limit = UNIFORM_TOLERANCE * scale2;
    if (
      !(scale2 > 0) ||
      e[3] !== 0 ||
      e[7] !== 0 ||
      e[11] !== 0 ||
      e[15] !== 1 ||
      !(Math.abs(dot(4, 4) - scale2) <= limit) ||
      !(Math.abs(dot(8, 8) - scale2) <= limit) ||
      !(Math.abs(dot(0, 4)) <= limit) ||
      !(Math.abs(dot(0, 8)) <= limit) ||
      !(Math.abs(dot(4, 8)) <= limit)
    )
      throw new RangeError(
        'Capsule.applyMatrix4 takes rotation, translation and uniform scale only; a capsule stays one only under those',
      );
    this.axis.applyMatrix4(m);
    this.radius *= Math.sqrt(scale2);
    return this;
  }
  getBoundingBox<T extends BoxLike>(out: T): T {
    const { start, end, radius } = this;
    out.min.x = Math.min(start.x, end.x) - radius;
    out.min.y = Math.min(start.y, end.y) - radius;
    out.min.z = Math.min(start.z, end.z) - radius;
    out.max.x = Math.max(start.x, end.x) + radius;
    out.max.y = Math.max(start.y, end.y) + radius;
    out.max.z = Math.max(start.z, end.z) + radius;
    return out;
  }
  getBoundingSphere<T extends SphereLike>(out: T): T {
    this.getCenter(out.center);
    out.radius = this.axis.distance() / 2 + this.radius;
    return out;
  }
  containsPoint(p: Vec3Like): boolean {
    return this.axis.distanceSqToPoint(p) <= this.radius * this.radius;
  }
  /** Distance from `p` to the capsule's surface; 0 inside. */
  distanceToPoint(p: Vec3Like): number {
    return Math.max(0, this.axis.distanceToPoint(p) - this.radius);
  }
  /** The point of the solid capsule nearest `p`: `p` itself when inside. */
  clampPoint<T extends Vec3Like>(p: Vec3Like, out: T): T {
    this.axis.closestPointToPoint(p, true, onSegment);
    const dx = p.x - onSegment.x,
      dy = p.y - onSegment.y,
      dz = p.z - onSegment.z,
      length = Math.hypot(dx, dy, dz),
      scale = length > this.radius ? this.radius / length : 1;
    out.x = onSegment.x + dx * scale;
    out.y = onSegment.y + dy * scale;
    out.z = onSegment.z + dz * scale;
    return out;
  }
  intersectsSphere(sphere: SphereLike): boolean {
    const r = this.radius + sphere.radius;
    return this.axis.distanceSqToPoint(sphere.center) <= r * r;
  }
  intersectsCapsule(capsule: Capsule): boolean {
    const r = this.radius + capsule.radius;
    return this.axis.distanceSqToLine3(capsule.axis) <= r * r;
  }
  /** `plane.normal` must be unit length, as in `Plane`. */
  intersectsPlane(plane: PlaneLike): boolean {
    const n = plane.normal,
      a = n.x * this.start.x + n.y * this.start.y + n.z * this.start.z + plane.constant,
      b = n.x * this.end.x + n.y * this.end.y + n.z * this.end.z + plane.constant;
    return (a <= 0 && b >= 0) || (a >= 0 && b <= 0) || Math.min(Math.abs(a), Math.abs(b)) <= this.radius;
  }
  /** Exact against an axis-aligned box. An empty box (`max` below `min`) meets nothing. */
  intersectsBox(box: BoxLike): boolean {
    const { min, max } = box;
    if (max.x < min.x || max.y < min.y || max.z < min.z) return false;
    const { start, end, radius } = this,
      cx = (min.x + max.x) / 2,
      cy = (min.y + max.y) / 2,
      cz = (min.z + max.z) / 2;
    return (
      segmentBoxDistanceSq(
        start.x - cx,
        start.y - cy,
        start.z - cz,
        end.x - start.x,
        end.y - start.y,
        end.z - start.z,
        (max.x - min.x) / 2,
        (max.y - min.y) / 2,
        (max.z - min.z) / 2,
      ) <=
      radius * radius
    );
  }
  /** Exact against an oriented box, such as an `OBB`. */
  intersectsOBB(obb: OBBLike): boolean {
    const { start, end, radius } = this,
      e = obb.rotation.elements,
      c = obb.center,
      h = obb.halfSize,
      px = start.x - c.x,
      py = start.y - c.y,
      pz = start.z - c.z,
      dx = end.x - start.x,
      dy = end.y - start.y,
      dz = end.z - start.z;
    return (
      segmentBoxDistanceSq(
        e[0] * px + e[1] * py + e[2] * pz,
        e[3] * px + e[4] * py + e[5] * pz,
        e[6] * px + e[7] * py + e[8] * pz,
        e[0] * dx + e[1] * dy + e[2] * dz,
        e[3] * dx + e[4] * dy + e[5] * dz,
        e[6] * dx + e[7] * dy + e[8] * dz,
        h.x,
        h.y,
        h.z,
      ) <=
      radius * radius
    );
  }
  /**
   * Squared distance from the axis to `triangle`, leaving the nearest points in the scratch `onSegment` and `onOther`.
   * 0 when the axis pierces the triangle.
   */
  private axisToTriangle(triangle: Triangle): number {
    const { start, end } = this,
      { a, b, c } = triangle,
      n = triangle.getNormal(normal),
      ds = n.x * (start.x - a.x) + n.y * (start.y - a.y) + n.z * (start.z - a.z),
      de = n.x * (end.x - a.x) + n.y * (end.y - a.y) + n.z * (end.z - a.z);
    if ((ds < 0 && de > 0) || (ds > 0 && de < 0)) {
      this.axis.at(ds / (ds - de), hit);
      if (triangle.containsPoint(hit)) {
        onSegment.copy(hit);
        onOther.copy(hit);
        return 0;
      }
    }
    let best = Infinity,
      bestSegmentX = 0,
      bestSegmentY = 0,
      bestSegmentZ = 0,
      bestOtherX = 0,
      bestOtherY = 0,
      bestOtherZ = 0;
    const keep = (d: number): void => {
      if (d >= best) return;
      best = d;
      bestSegmentX = onSegment.x;
      bestSegmentY = onSegment.y;
      bestSegmentZ = onSegment.z;
      bestOtherX = onOther.x;
      bestOtherY = onOther.y;
      bestOtherZ = onOther.z;
    };
    for (const end0 of [start, end]) {
      triangle.closestPointToPoint(end0, onOther);
      onSegment.copy(end0);
      keep(onSegment.distanceToSquared(onOther));
    }
    keep(this.axis.distanceSqToLine3(edgeLine.set(a, b), onSegment, onOther));
    keep(this.axis.distanceSqToLine3(edgeLine.set(b, c), onSegment, onOther));
    keep(this.axis.distanceSqToLine3(edgeLine.set(c, a), onSegment, onOther));
    onSegment.set(bestSegmentX, bestSegmentY, bestSegmentZ);
    onOther.set(bestOtherX, bestOtherY, bestOtherZ);
    return best;
  }
  intersectsTriangle(triangle: Triangle): boolean {
    return this.axisToTriangle(triangle) <= this.radius * this.radius;
  }
  /**
   * The move that takes this capsule off `triangle`, into `out`: add it with {@link Capsule.translate} to resolve a
   * character's step, and use its direction as the contact normal. Returns null, leaving `out` as it was, when the two
   * do not overlap (touching is not an overlap). An axis through the triangle moves out along the triangle's normal, to
   * the nearer side; an axis lying in a degenerate triangle has no direction to leave by, and gives null.
   */
  pushOutOfTriangle<T extends Vec3Like>(triangle: Triangle, out: T): T | null {
    const radius = this.radius,
      distance2 = this.axisToTriangle(triangle);
    if (distance2 >= radius * radius) return null;
    const distance = Math.sqrt(distance2);
    if (distance > 0) {
      const scale = (radius - distance) / distance;
      out.x = (onSegment.x - onOther.x) * scale;
      out.y = (onSegment.y - onOther.y) * scale;
      out.z = (onSegment.z - onOther.z) * scale;
      return out;
    }
    const n = triangle.getNormal(normal);
    if (n.x === 0 && n.y === 0 && n.z === 0) return null;
    const { a } = triangle,
      { start, end } = this,
      ds = n.x * (start.x - a.x) + n.y * (start.y - a.y) + n.z * (start.z - a.z),
      de = n.x * (end.x - a.x) + n.y * (end.y - a.y) + n.z * (end.z - a.z),
      up = radius - Math.min(ds, de),
      down = radius + Math.max(ds, de),
      move = up <= down ? up : -down;
    out.x = n.x * move;
    out.y = n.y * move;
    out.z = n.z * move;
    return out;
  }
  /**
   * The first point of the capsule along `ray` into `out`: the ray's origin when it starts inside, null (leaving `out`
   * as it was) on a miss.
   */
  intersectRay<T extends Vec3Like>(ray: CapsuleRay, out: T): T | null {
    const o = ray.origin,
      d = ray.direction,
      { start, end, radius } = this;
    if (this.containsPoint(o)) {
      out.x = o.x;
      out.y = o.y;
      out.z = o.z;
      return out;
    }
    const dd = d.x * d.x + d.y * d.y + d.z * d.z;
    let first = Infinity;
    // The two end spheres: the entry root of each.
    for (const c of [start, end]) {
      const mx = o.x - c.x,
        my = o.y - c.y,
        mz = o.z - c.z,
        b = mx * d.x + my * d.y + mz * d.z,
        disc = b * b - dd * (mx * mx + my * my + mz * mz - radius * radius);
      if (disc < 0 || dd === 0) continue;
      const t = (-b - Math.sqrt(disc)) / dd;
      if (t >= 0 && t < first) first = t;
    }
    // The side wall, held to the length of the axis.
    const ax = end.x - start.x,
      ay = end.y - start.y,
      az = end.z - start.z,
      length2 = ax * ax + ay * ay + az * az;
    if (length2 > 0) {
      const mx = o.x - start.x,
        my = o.y - start.y,
        mz = o.z - start.z,
        md = (mx * ax + my * ay + mz * az) / length2,
        dv = (d.x * ax + d.y * ay + d.z * az) / length2,
        px = mx - ax * md,
        py = my - ay * md,
        pz = mz - az * md,
        qx = d.x - ax * dv,
        qy = d.y - ay * dv,
        qz = d.z - az * dv,
        A = qx * qx + qy * qy + qz * qz,
        B = px * qx + py * qy + pz * qz,
        C = px * px + py * py + pz * pz - radius * radius,
        disc = B * B - A * C;
      if (A > 0 && disc >= 0) {
        const t = (-B - Math.sqrt(disc)) / A,
          along = md + t * dv;
        if (t >= 0 && t < first && along >= 0 && along <= 1) first = t;
      }
    }
    if (first === Infinity) return null;
    const x = o.x + d.x * first,
      y = o.y + d.y * first,
      z = o.z + d.z * first;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  intersectsRay(ray: CapsuleRay): boolean {
    return this.intersectRay(ray, hit) !== null;
  }
  equals(capsule: Capsule, epsilon = 0): boolean {
    return this.axis.equals(capsule.axis, epsilon) && Math.abs(this.radius - capsule.radius) <= epsilon;
  }
}
