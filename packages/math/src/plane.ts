import {Vector3} from './vector3.js';
import type {MatrixLike, Vec3Like} from './types.js';

interface BoxLike { intersectsPlane(plane: Plane): boolean }
interface SphereLike { center: Vec3Like; radius: number }

/** Plane `normal · p + constant = 0`, with the positive side in front of the normal. */
export class Plane {
  constructor(public normal = new Vector3(1, 0, 0), public constant = 0) {}

  set(normal: Vec3Like, constant: number): this { this.normal.copy(normal); this.constant = constant; return this; }
  setComponents(x: number, y: number, z: number, w: number): this { this.normal.set(x, y, z); this.constant = w; return this; }
  /** `normal` must be unit length. */
  setFromNormalAndCoplanarPoint(normal: Vec3Like, point: Vec3Like): this {
    this.normal.copy(normal);
    this.constant = -this.normal.dot(point);
    return this;
  }
  /** Counter-clockwise a, b, c (seen from the front) gives a normal facing the viewer. */
  setFromCoplanarPoints(a: Vec3Like, b: Vec3Like, c: Vec3Like): this {
    const ux = c.x - b.x, uy = c.y - b.y, uz = c.z - b.z, vx = a.x - b.x, vy = a.y - b.y, vz = a.z - b.z;
    this.normal.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
    return this.setFromNormalAndCoplanarPoint(this.normal, a);
  }
  copy(plane: Plane): this { return this.set(plane.normal, plane.constant); }
  clone(): Plane { return new Plane().copy(this); }
  /** Scales so the normal is unit length (distances become true distances). */
  normalize(): this {
    const inverse = 1 / (this.normal.length() || 1);
    this.normal.multiplyScalar(inverse); this.constant *= inverse;
    return this;
  }
  negate(): this { this.normal.negate(); this.constant = -this.constant; return this; }

  distanceToPoint(p: Vec3Like): number { return this.normal.dot(p) + this.constant; }
  distanceToSphere(sphere: SphereLike): number { return this.distanceToPoint(sphere.center) - sphere.radius; }
  projectPoint<T extends Vec3Like>(p: Vec3Like, out: T): T {
    const d = this.distanceToPoint(p);
    out.x = p.x - this.normal.x * d; out.y = p.y - this.normal.y * d; out.z = p.z - this.normal.z * d;
    return out;
  }
  coplanarPoint<T extends Vec3Like>(out: T): T {
    out.x = -this.normal.x * this.constant; out.y = -this.normal.y * this.constant; out.z = -this.normal.z * this.constant;
    return out;
  }
  intersectsBox(box: BoxLike): boolean { return box.intersectsPlane(this); }
  intersectsSphere(sphere: SphereLike): boolean { return Math.abs(this.distanceToPoint(sphere.center)) <= sphere.radius; }
  /** Transforms the plane by an affine matrix (normals use its inverse-transpose, computed here). */
  applyMatrix4(m: MatrixLike): this {
    const e = m.elements, n = this.normal;
    // Reference point on the plane, transformed as a point.
    const px = -n.x * this.constant, py = -n.y * this.constant, pz = -n.z * this.constant;
    const qx = e[0] * px + e[4] * py + e[8] * pz + e[12], qy = e[1] * px + e[5] * py + e[9] * pz + e[13], qz = e[2] * px + e[6] * py + e[10] * pz + e[14];
    // Normal times the inverse-transpose of the upper 3x3 equals the cofactor matrix times the normal (up to scale).
    const a = e[0], b = e[4], c = e[8], d = e[1], f = e[5], g = e[9], h = e[2], i = e[6], k = e[10];
    n.set(
      (f * k - g * i) * n.x + (g * h - d * k) * n.y + (d * i - f * h) * n.z,
      (c * i - b * k) * n.x + (a * k - c * h) * n.y + (b * h - a * i) * n.z,
      (b * g - c * f) * n.x + (c * d - a * g) * n.y + (a * f - b * d) * n.z,
    );
    if (a * (f * k - g * i) + b * (g * h - d * k) + c * (d * i - f * h) < 0) n.negate();
    n.normalize();
    this.constant = -(n.x * qx + n.y * qy + n.z * qz);
    return this;
  }
  translate(offset: Vec3Like): this { this.constant -= this.normal.dot(offset); return this; }
  equals(plane: Plane): boolean { return this.normal.equals(plane.normal) && this.constant === plane.constant; }
}
