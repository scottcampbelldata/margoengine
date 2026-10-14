import type {MatrixLike, NumberArray, Vec3Like, Vec4Like} from './types.js';

/** Spherical coordinates as used by `setFromSpherical` (see `Spherical`). */
interface SphericalLike { radius: number; phi: number; theta: number }

export class Vector3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s: number): this { this.x = this.y = this.z = s; return this; }
  /** Copies any `{x, y, z}`, including a core `mesh.position`, `mesh.scale` or another Vector3. */
  copy(v: Vec3Like): this { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone(): Vector3 { return new Vector3(this.x, this.y, this.z); }

  add(v: Vec3Like): this { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScalar(s: number): this { this.x += s; this.y += s; this.z += s; return this; }
  addVectors(a: Vec3Like, b: Vec3Like): this { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  addScaledVector(v: Vec3Like, s: number): this { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  sub(v: Vec3Like): this { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a: Vec3Like, b: Vec3Like): this { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  multiply(v: Vec3Like): this { this.x *= v.x; this.y *= v.y; this.z *= v.z; return this; }
  multiplyScalar(s: number): this { this.x *= s; this.y *= s; this.z *= s; return this; }
  divide(v: Vec3Like): this { this.x /= v.x; this.y /= v.y; this.z /= v.z; return this; }
  divideScalar(s: number): this { return this.multiplyScalar(1 / s); }
  negate(): this { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  min(v: Vec3Like): this { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); this.z = Math.min(this.z, v.z); return this; }
  max(v: Vec3Like): this { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); this.z = Math.max(this.z, v.z); return this; }
  clamp(min: Vec3Like, max: Vec3Like): this { return this.max(min).min(max); }

  dot(v: Vec3Like): number { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v: Vec3Like): this { return this.crossVectors(this, v); }
  crossVectors(a: Vec3Like, b: Vec3Like): this {
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by; this.y = az * bx - ax * bz; this.z = ax * by - ay * bx; return this;
  }
  lengthSq(): number { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length(): number { return Math.sqrt(this.lengthSq()); }
  manhattanLength(): number { return Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z); }
  /** Unit length; a zero vector stays zero. */
  normalize(): this { return this.divideScalar(this.length() || 1); }
  setLength(length: number): this { return this.normalize().multiplyScalar(length); }
  distanceTo(v: Vec3Like): number { return Math.sqrt(this.distanceToSquared(v)); }
  distanceToSquared(v: Vec3Like): number { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  /** Angle in radians between the two directions; π/2 if either is zero. */
  angleTo(v: Vec3Like): number {
    const denominator = Math.sqrt(this.lengthSq() * (v.x * v.x + v.y * v.y + v.z * v.z));
    return denominator ? Math.acos(Math.max(-1, Math.min(1, this.dot(v) / denominator))) : Math.PI / 2;
  }

  lerp(v: Vec3Like, t: number): this { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  lerpVectors(a: Vec3Like, b: Vec3Like, t: number): this {
    this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this;
  }
  projectOnVector(v: Vec3Like): this {
    const d = v.x * v.x + v.y * v.y + v.z * v.z, s = d ? this.dot(v) / d : 0;
    return this.set(v.x * s, v.y * s, v.z * s);
  }
  projectOnPlane(normal: Vec3Like): this {
    const d = normal.x * normal.x + normal.y * normal.y + normal.z * normal.z;
    return d ? this.addScaledVector(normal, -this.dot(normal) / d) : this;
  }
  /** Mirrors this across the plane orthogonal to the unit `normal`. */
  reflect(normal: Vec3Like): this { return this.addScaledVector(normal, -2 * this.dot(normal)); }

  /** Multiplies by a 3x3 matrix (column-major elements). */
  applyMatrix3(m: MatrixLike): this {
    const e = m.elements, x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[3] * y + e[6] * z; this.y = e[1] * x + e[4] * y + e[7] * z; this.z = e[2] * x + e[5] * y + e[8] * z;
    return this;
  }
  /** Transforms this point by a 4x4 matrix, including the perspective divide. Accepts any `{elements}`, e.g. `{elements: engine.camera.matrix}` for clip space. */
  applyMatrix4(m: MatrixLike): this {
    const e = m.elements, x = this.x, y = this.y, z = this.z, w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }
  /** Rotates this direction by the upper 3x3 of a 4x4 matrix and normalizes it. */
  transformDirection(m: MatrixLike): this {
    const e = m.elements, x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8] * z; this.y = e[1] * x + e[5] * y + e[9] * z; this.z = e[2] * x + e[6] * y + e[10] * z;
    return this.normalize();
  }
  applyQuaternion(q: Vec4Like): this {
    const {x, y, z} = this, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + qy * tz - qz * ty;
    this.y = y + qw * ty + qz * tx - qx * tz;
    this.z = z + qw * tz + qx * ty - qy * tx;
    return this;
  }
  setFromMatrixPosition(m: MatrixLike): this { const e = m.elements; return this.set(e[12], e[13], e[14]); }
  setFromMatrixColumn(m: MatrixLike, index: number): this { return this.fromArray(m.elements, index * (m.elements.length === 9 ? 3 : 4)); }
  setFromMatrixScale(m: MatrixLike): this {
    const e = m.elements;
    return this.set(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
  }
  /** y-up: `phi` is measured from +y, `theta` around +y starting at +z. */
  setFromSpherical(s: SphericalLike): this {
    const ring = Math.sin(s.phi) * s.radius;
    return this.set(ring * Math.sin(s.theta), Math.cos(s.phi) * s.radius, ring * Math.cos(s.theta));
  }
  equals(v: Vec3Like, epsilon = 0): boolean {
    return Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon && Math.abs(this.z - v.z) <= epsilon;
  }

  fromArray(array: ArrayLike<number>, offset = 0): this { this.x = array[offset]; this.y = array[offset + 1]; this.z = array[offset + 2]; return this; }
  /** With no arguments returns a new `[x, y, z]` tuple that core `setPosition`, `setScale`, `setRotation` and `camera.position` accept directly. */
  toArray(): [number, number, number];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray { out[offset] = this.x; out[offset + 1] = this.y; out[offset + 2] = this.z; return out; }
}
