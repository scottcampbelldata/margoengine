import { Vector3 } from './vector3.js';
import type { MatrixLike, PlaneLike, SphereLike, Vec3Like } from './types.js';

/**
 * Axis-aligned bounding box. Empty boxes have min = +Infinity and max = -Infinity.
 * `camera.fitToBoundingBox(box.min.toArray(), box.max.toArray())` frames it with a core camera.
 */
export class Box3 {
  constructor(
    public min = new Vector3(Infinity, Infinity, Infinity),
    public max = new Vector3(-Infinity, -Infinity, -Infinity),
  ) {}

  set(min: Vec3Like, max: Vec3Like): this {
    this.min.copy(min);
    this.max.copy(max);
    return this;
  }
  copy(box: Box3): this {
    return this.set(box.min, box.max);
  }
  clone(): Box3 {
    return new Box3().copy(this);
  }
  makeEmpty(): this {
    this.min.setScalar(Infinity);
    this.max.setScalar(-Infinity);
    return this;
  }
  isEmpty(): boolean {
    return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
  }

  /** Bounds of packed positions (x, y, z, ...), e.g. a geometry `positions` Float32Array. */
  setFromArray(array: ArrayLike<number>, stride = 3, offset = 0): this {
    this.makeEmpty();
    for (let i = offset; i + 2 < array.length; i += stride)
      this.expandByComponents(array[i], array[i + 1], array[i + 2]);
    return this;
  }
  setFromPoints(points: readonly Vec3Like[]): this {
    this.makeEmpty();
    for (const p of points) this.expandByPoint(p);
    return this;
  }
  setFromCenterAndSize(center: Vec3Like, size: Vec3Like): this {
    this.min.set(center.x - size.x / 2, center.y - size.y / 2, center.z - size.z / 2);
    this.max.set(center.x + size.x / 2, center.y + size.y / 2, center.z + size.z / 2);
    return this;
  }
  getCenter<T extends Vec3Like>(out: T): T {
    if (this.isEmpty()) {
      out.x = out.y = out.z = 0;
      return out;
    }
    out.x = (this.min.x + this.max.x) / 2;
    out.y = (this.min.y + this.max.y) / 2;
    out.z = (this.min.z + this.max.z) / 2;
    return out;
  }
  getSize<T extends Vec3Like>(out: T): T {
    const empty = this.isEmpty();
    out.x = empty ? 0 : this.max.x - this.min.x;
    out.y = empty ? 0 : this.max.y - this.min.y;
    out.z = empty ? 0 : this.max.z - this.min.z;
    return out;
  }

  expandByPoint(p: Vec3Like): this {
    return this.expandByComponents(p.x, p.y, p.z);
  }
  private expandByComponents(x: number, y: number, z: number): this {
    const { min, max } = this;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
    return this;
  }
  expandByVector(v: Vec3Like): this {
    this.min.sub(v);
    this.max.add(v);
    return this;
  }
  expandByScalar(s: number): this {
    this.min.addScalar(-s);
    this.max.addScalar(s);
    return this;
  }
  intersect(box: Box3): this {
    this.min.max(box.min);
    this.max.min(box.max);
    return this.isEmpty() ? this.makeEmpty() : this;
  }
  union(box: Box3): this {
    this.min.min(box.min);
    this.max.max(box.max);
    return this;
  }
  translate(offset: Vec3Like): this {
    this.min.add(offset);
    this.max.add(offset);
    return this;
  }
  /** Replaces this with the axis-aligned bounds of the transformed box (affine matrices). */
  applyMatrix4(m: MatrixLike): this {
    if (this.isEmpty()) return this;
    const e = m.elements,
      lo = this.min,
      hi = this.max;
    let nx0 = e[12],
      ny0 = e[13],
      nz0 = e[14],
      nx1 = e[12],
      ny1 = e[13],
      nz1 = e[14];
    for (let axis = 0; axis < 3; axis++) {
      const a = axis === 0 ? lo.x : axis === 1 ? lo.y : lo.z,
        b = axis === 0 ? hi.x : axis === 1 ? hi.y : hi.z;
      for (let row = 0; row < 3; row++) {
        const k = e[axis * 4 + row],
          u = k * a,
          v = k * b,
          low = Math.min(u, v),
          high = Math.max(u, v);
        if (row === 0) {
          nx0 += low;
          nx1 += high;
        } else if (row === 1) {
          ny0 += low;
          ny1 += high;
        } else {
          nz0 += low;
          nz1 += high;
        }
      }
    }
    lo.set(nx0, ny0, nz0);
    hi.set(nx1, ny1, nz1);
    return this;
  }

  containsPoint(p: Vec3Like): boolean {
    return (
      p.x >= this.min.x &&
      p.x <= this.max.x &&
      p.y >= this.min.y &&
      p.y <= this.max.y &&
      p.z >= this.min.z &&
      p.z <= this.max.z
    );
  }
  containsBox(box: Box3): boolean {
    return (
      this.min.x <= box.min.x &&
      box.max.x <= this.max.x &&
      this.min.y <= box.min.y &&
      box.max.y <= this.max.y &&
      this.min.z <= box.min.z &&
      box.max.z <= this.max.z
    );
  }
  intersectsBox(box: Box3): boolean {
    return (
      box.max.x >= this.min.x &&
      box.min.x <= this.max.x &&
      box.max.y >= this.min.y &&
      box.min.y <= this.max.y &&
      box.max.z >= this.min.z &&
      box.min.z <= this.max.z
    );
  }
  intersectsSphere(sphere: SphereLike): boolean {
    return this.distanceSqToComponents(sphere.center) <= sphere.radius * sphere.radius;
  }
  intersectsPlane(plane: PlaneLike): boolean {
    const n = plane.normal;
    let low = 0,
      high = 0;
    low += n.x > 0 ? n.x * this.min.x : n.x * this.max.x;
    high += n.x > 0 ? n.x * this.max.x : n.x * this.min.x;
    low += n.y > 0 ? n.y * this.min.y : n.y * this.max.y;
    high += n.y > 0 ? n.y * this.max.y : n.y * this.min.y;
    low += n.z > 0 ? n.z * this.min.z : n.z * this.max.z;
    high += n.z > 0 ? n.z * this.max.z : n.z * this.min.z;
    return low <= -plane.constant && high >= -plane.constant;
  }
  clampPoint<T extends Vec3Like>(p: Vec3Like, out: T): T {
    out.x = Math.max(this.min.x, Math.min(this.max.x, p.x));
    out.y = Math.max(this.min.y, Math.min(this.max.y, p.y));
    out.z = Math.max(this.min.z, Math.min(this.max.z, p.z));
    return out;
  }
  distanceToPoint(p: Vec3Like): number {
    return Math.sqrt(this.distanceSqToComponents(p));
  }
  private distanceSqToComponents(p: Vec3Like): number {
    const dx = Math.max(this.min.x - p.x, 0, p.x - this.max.x),
      dy = Math.max(this.min.y - p.y, 0, p.y - this.max.y),
      dz = Math.max(this.min.z - p.z, 0, p.z - this.max.z);
    return dx * dx + dy * dy + dz * dz;
  }
  /** Sphere through the box corners (radius -1 when empty). */
  getBoundingSphere<T extends SphereLike>(out: T): T {
    if (this.isEmpty()) {
      out.center.x = out.center.y = out.center.z = 0;
      out.radius = -1;
      return out;
    }
    this.getCenter(out.center);
    out.radius = Math.hypot(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z) / 2;
    return out;
  }
  equals(box: Box3): boolean {
    return this.min.equals(box.min) && this.max.equals(box.max);
  }
}
