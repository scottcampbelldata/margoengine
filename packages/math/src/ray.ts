import { Vector3 } from './vector3.js';
import type { MatrixLike, Vec3Like } from './types.js';

interface SphereLike {
  center: Vec3Like;
  radius: number;
}
interface PlaneLike {
  normal: Vec3Like;
  constant: number;
}
interface BoxLike {
  min: Vec3Like;
  max: Vec3Like;
}

const write = <T extends Vec3Like>(out: T, x: number, y: number, z: number): T => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

/** Half-line from `origin` along unit `direction`. Intersection methods write into `out` and return it, or return null on a miss. */
export class Ray {
  constructor(
    public origin = new Vector3(),
    public direction = new Vector3(0, 0, -1),
  ) {}

  set(origin: Vec3Like, direction: Vec3Like): this {
    this.origin.copy(origin);
    this.direction.copy(direction);
    return this;
  }
  copy(ray: Ray): this {
    return this.set(ray.origin, ray.direction);
  }
  clone(): Ray {
    return new Ray().copy(this);
  }
  at<T extends Vec3Like>(t: number, out: T): T {
    const o = this.origin,
      d = this.direction;
    return write(out, o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
  }
  lookAt(target: Vec3Like): this {
    this.direction.subVectors(target, this.origin).normalize();
    return this;
  }
  recast(t: number): this {
    this.origin.addScaledVector(this.direction, t);
    return this;
  }

  /** Parameter of the closest point to `p`, clamped to the ray (t >= 0). */
  private closestT(p: Vec3Like): number {
    const o = this.origin,
      d = this.direction;
    return Math.max(0, (p.x - o.x) * d.x + (p.y - o.y) * d.y + (p.z - o.z) * d.z);
  }
  closestPointToPoint<T extends Vec3Like>(p: Vec3Like, out: T): T {
    return this.at(this.closestT(p), out);
  }
  distanceSqToPoint(p: Vec3Like): number {
    const t = this.closestT(p),
      o = this.origin,
      d = this.direction;
    const dx = o.x + d.x * t - p.x,
      dy = o.y + d.y * t - p.y,
      dz = o.z + d.z * t - p.z;
    return dx * dx + dy * dy + dz * dz;
  }
  distanceToPoint(p: Vec3Like): number {
    return Math.sqrt(this.distanceSqToPoint(p));
  }

  intersectSphere<T extends Vec3Like>(sphere: SphereLike, out: T): T | null {
    const o = this.origin,
      d = this.direction,
      c = sphere.center;
    const lx = c.x - o.x,
      ly = c.y - o.y,
      lz = c.z - o.z,
      along = lx * d.x + ly * d.y + lz * d.z;
    const distanceSq = lx * lx + ly * ly + lz * lz - along * along,
      radiusSq = sphere.radius * sphere.radius;
    if (distanceSq > radiusSq) return null;
    const half = Math.sqrt(radiusSq - distanceSq),
      t0 = along - half,
      t1 = along + half;
    if (t1 < 0) return null;
    return this.at(t0 < 0 ? t1 : t0, out);
  }
  intersectsSphere(sphere: SphereLike): boolean {
    return this.distanceSqToPoint(sphere.center) <= sphere.radius * sphere.radius;
  }

  /** Distance along the ray to the plane, 0 if the origin lies on it, null if parallel or behind. */
  distanceToPlane(plane: PlaneLike): number | null {
    const n = plane.normal,
      o = this.origin,
      denominator = n.x * this.direction.x + n.y * this.direction.y + n.z * this.direction.z;
    const distance = n.x * o.x + n.y * o.y + n.z * o.z + plane.constant;
    if (denominator === 0) return distance === 0 ? 0 : null;
    const t = -distance / denominator;
    return t >= 0 ? t : null;
  }
  intersectPlane<T extends Vec3Like>(plane: PlaneLike, out: T): T | null {
    const t = this.distanceToPlane(plane);
    return t === null ? null : this.at(t, out);
  }
  intersectsPlane(plane: PlaneLike): boolean {
    return this.distanceToPlane(plane) !== null;
  }

  /** Slab test. Returns the entry point, or the origin when it starts inside the box. */
  intersectBox<T extends Vec3Like>(box: BoxLike, out: T): T | null {
    const t = this.distanceToBox(box);
    return t === null ? null : this.at(t, out);
  }
  intersectsBox(box: BoxLike): boolean {
    return this.distanceToBox(box) !== null;
  }
  private distanceToBox(box: BoxLike): number | null {
    const o = this.origin,
      d = this.direction;
    let near = -Infinity,
      far = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const origin = axis === 0 ? o.x : axis === 1 ? o.y : o.z,
        direction = axis === 0 ? d.x : axis === 1 ? d.y : d.z;
      const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z,
        hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;
      if (direction === 0) {
        if (origin < lo || origin > hi) return null;
        continue;
      }
      const inverse = 1 / direction;
      let t0 = (lo - origin) * inverse,
        t1 = (hi - origin) * inverse;
      if (t0 > t1) {
        const t = t0;
        t0 = t1;
        t1 = t;
      }
      if (t0 > near) near = t0;
      if (t1 < far) far = t1;
      if (near > far) return null;
    }
    return far < 0 ? null : Math.max(near, 0);
  }
  /** Möller–Trumbore. With `backfaceCulling`, triangles wound clockwise as seen from the ray are skipped. */
  intersectTriangle<T extends Vec3Like>(
    a: Vec3Like,
    b: Vec3Like,
    c: Vec3Like,
    backfaceCulling: boolean,
    out: T,
  ): T | null {
    const d = this.direction,
      o = this.origin;
    const e1x = b.x - a.x,
      e1y = b.y - a.y,
      e1z = b.z - a.z,
      e2x = c.x - a.x,
      e2y = c.y - a.y,
      e2z = c.z - a.z;
    const px = d.y * e2z - d.z * e2y,
      py = d.z * e2x - d.x * e2z,
      pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (backfaceCulling ? det <= 0 : det === 0) return null;
    const inverse = 1 / det,
      tx = o.x - a.x,
      ty = o.y - a.y,
      tz = o.z - a.z;
    const u = (tx * px + ty * py + tz * pz) * inverse;
    if (u < 0 || u > 1) return null;
    const qx = ty * e1z - tz * e1y,
      qy = tz * e1x - tx * e1z,
      qz = tx * e1y - ty * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * inverse;
    if (v < 0 || u + v > 1) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    return t < 0 ? null : this.at(t, out);
  }
  /** Moves the ray into another space, e.g. world to a mesh's local space with an inverted world matrix. */
  applyMatrix4(m: MatrixLike): this {
    this.origin.applyMatrix4(m);
    this.direction.transformDirection(m);
    return this;
  }
  equals(ray: Ray): boolean {
    return this.origin.equals(ray.origin) && this.direction.equals(ray.direction);
  }
}
