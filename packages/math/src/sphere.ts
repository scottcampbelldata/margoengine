import { Vector3 } from './vector3.js';
import type { MatrixLike, Vec3Like } from './types.js';

interface BoxLike {
  min: Vec3Like;
  max: Vec3Like;
}
interface PlaneLike {
  normal: Vec3Like;
  constant: number;
}

/** Bounding sphere. A negative radius means empty. */
export class Sphere {
  constructor(
    public center = new Vector3(),
    public radius = -1,
  ) {}

  set(center: Vec3Like, radius: number): this {
    this.center.copy(center);
    this.radius = radius;
    return this;
  }
  copy(sphere: Sphere): this {
    return this.set(sphere.center, sphere.radius);
  }
  clone(): Sphere {
    return new Sphere().copy(this);
  }
  makeEmpty(): this {
    this.center.set(0, 0, 0);
    this.radius = -1;
    return this;
  }
  isEmpty(): boolean {
    return this.radius < 0;
  }

  /** Encloses `points` around `center`, or around the center of their bounding box when omitted (not the minimal sphere). */
  setFromPoints(points: readonly Vec3Like[], center?: Vec3Like): this {
    if (!points.length) return this.makeEmpty();
    if (center) this.center.copy(center);
    else {
      let x0 = Infinity,
        y0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity,
        z1 = -Infinity;
      for (const p of points) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        z0 = Math.min(z0, p.z);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
        z1 = Math.max(z1, p.z);
      }
      this.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    }
    let radiusSq = 0;
    for (const p of points) radiusSq = Math.max(radiusSq, this.center.distanceToSquared(p));
    this.radius = Math.sqrt(radiusSq);
    return this;
  }
  containsPoint(p: Vec3Like): boolean {
    return this.center.distanceToSquared(p) <= this.radius * this.radius;
  }
  /** Signed: negative inside. */
  distanceToPoint(p: Vec3Like): number {
    return this.center.distanceTo(p) - this.radius;
  }
  intersectsSphere(sphere: Sphere): boolean {
    const r = this.radius + sphere.radius;
    return this.center.distanceToSquared(sphere.center) <= r * r;
  }
  intersectsBox(box: BoxLike): boolean {
    const c = this.center,
      dx = Math.max(box.min.x - c.x, 0, c.x - box.max.x),
      dy = Math.max(box.min.y - c.y, 0, c.y - box.max.y),
      dz = Math.max(box.min.z - c.z, 0, c.z - box.max.z);
    return dx * dx + dy * dy + dz * dz <= this.radius * this.radius;
  }
  intersectsPlane(plane: PlaneLike): boolean {
    return (
      Math.abs(
        plane.normal.x * this.center.x +
          plane.normal.y * this.center.y +
          plane.normal.z * this.center.z +
          plane.constant,
      ) <= this.radius
    );
  }
  clampPoint<T extends Vec3Like>(p: Vec3Like, out: T): T {
    const dx = p.x - this.center.x,
      dy = p.y - this.center.y,
      dz = p.z - this.center.z,
      d = Math.hypot(dx, dy, dz);
    const s = d > this.radius ? this.radius / d : 1;
    out.x = this.center.x + dx * s;
    out.y = this.center.y + dy * s;
    out.z = this.center.z + dz * s;
    return out;
  }
  getBoundingBox<T extends BoxLike>(out: T): T {
    if (this.isEmpty()) {
      out.min.x = out.min.y = out.min.z = Infinity;
      out.max.x = out.max.y = out.max.z = -Infinity;
      return out;
    }
    const { x, y, z } = this.center,
      r = this.radius;
    out.min.x = x - r;
    out.min.y = y - r;
    out.min.z = z - r;
    out.max.x = x + r;
    out.max.y = y + r;
    out.max.z = z + r;
    return out;
  }
  expandByPoint(p: Vec3Like): this {
    if (this.isEmpty()) return this.set(p, 0);
    const d = this.center.distanceTo(p);
    if (d > this.radius) {
      const half = (d - this.radius) / 2;
      this.center.lerp(p, half / d);
      this.radius += half;
    }
    return this;
  }
  union(sphere: Sphere): this {
    if (sphere.isEmpty()) return this;
    if (this.isEmpty()) return this.copy(sphere);
    const d = this.center.distanceTo(sphere.center);
    if (d + sphere.radius <= this.radius) return this;
    if (d + this.radius <= sphere.radius) return this.copy(sphere);
    const radius = (d + this.radius + sphere.radius) / 2;
    this.center.lerp(sphere.center, (radius - this.radius) / d);
    this.radius = radius;
    return this;
  }
  /** Transforms the center and scales the radius by the largest axis scale. */
  applyMatrix4(m: MatrixLike): this {
    const e = m.elements;
    this.center.applyMatrix4(m);
    this.radius *= Math.sqrt(
      Math.max(
        e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
        e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
        e[8] * e[8] + e[9] * e[9] + e[10] * e[10],
      ),
    );
    return this;
  }
  translate(offset: Vec3Like): this {
    this.center.add(offset);
    return this;
  }
  equals(sphere: Sphere): boolean {
    return this.center.equals(sphere.center) && this.radius === sphere.radius;
  }
}
