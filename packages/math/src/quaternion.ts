import type { EulerOrder, MatrixLike, NumberArray, Vec3Like, Vec4Like } from './types.js';

interface EulerLike {
  x: number;
  y: number;
  z: number;
  order: EulerOrder;
}

/** Rotation quaternion (x, y, z, w). Layout matches core `mesh.setQuaternion([x, y, z, w])`. */
export class Quaternion {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1,
  ) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }
  identity(): this {
    return this.set(0, 0, 0, 1);
  }
  copy(q: Vec4Like): this {
    return this.set(q.x, q.y, q.z, q.w);
  }
  clone(): Quaternion {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  /** `axis` must be unit length; `angle` in radians. */
  setFromAxisAngle(axis: Vec3Like, angle: number): this {
    const s = Math.sin(angle / 2);
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2));
  }
  /** Intrinsic rotation in `euler.order`: for 'XYZ' the result is qX * qY * qZ, the convention of core and three.js. */
  setFromEuler(euler: EulerLike): this {
    this.identity();
    for (let i = 0; i < 3; i++) {
      const axis = euler.order[i],
        half = (axis === 'X' ? euler.x : axis === 'Y' ? euler.y : euler.z) / 2,
        s = Math.sin(half),
        c = Math.cos(half);
      this.multiplyComponents(
        this.x,
        this.y,
        this.z,
        this.w,
        axis === 'X' ? s : 0,
        axis === 'Y' ? s : 0,
        axis === 'Z' ? s : 0,
        c,
      );
    }
    return this;
  }
  /** Reads the rotation from a pure-rotation 3x3 or 4x4 matrix (column-major; scale must be removed first). */
  setFromRotationMatrix(m: MatrixLike): this {
    const e = m.elements,
      k = e.length === 9 ? 3 : 4;
    const m11 = e[0],
      m12 = e[k],
      m13 = e[2 * k],
      m21 = e[1],
      m22 = e[k + 1],
      m23 = e[2 * k + 1],
      m31 = e[2],
      m32 = e[k + 2],
      m33 = e[2 * k + 2];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      return this.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
    }
    if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      return this.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
    }
    if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      return this.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
    }
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
  /** Shortest rotation taking unit vector `from` to unit vector `to`. */
  setFromUnitVectors(from: Vec3Like, to: Vec3Like): this {
    const r = from.x * to.x + from.y * to.y + from.z * to.z + 1;
    if (r < 1e-8) {
      // Opposite vectors: rotate 180 degrees about any perpendicular axis.
      if (Math.abs(from.x) > Math.abs(from.z)) this.set(-from.y, from.x, 0, 0);
      else this.set(0, -from.z, from.y, 0);
    } else {
      this.set(from.y * to.z - from.z * to.y, from.z * to.x - from.x * to.z, from.x * to.y - from.y * to.x, r);
    }
    return this.normalize();
  }

  /** this = this * q (apply q first, then this). */
  multiply(q: Vec4Like): this {
    return this.multiplyComponents(this.x, this.y, this.z, this.w, q.x, q.y, q.z, q.w);
  }
  /** this = q * this. */
  premultiply(q: Vec4Like): this {
    return this.multiplyComponents(q.x, q.y, q.z, q.w, this.x, this.y, this.z, this.w);
  }
  multiplyQuaternions(a: Vec4Like, b: Vec4Like): this {
    return this.multiplyComponents(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w);
  }
  private multiplyComponents(
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number,
  ): this {
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }
  conjugate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }
  /** True inverse (conjugate / |q|²); equal to the conjugate for unit quaternions. */
  invert(): this {
    const d = this.lengthSq() || 1;
    return this.set(-this.x / d, -this.y / d, -this.z / d, this.w / d);
  }
  dot(q: Vec4Like): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }
  lengthSq(): number {
    return this.dot(this);
  }
  length(): number {
    return Math.sqrt(this.lengthSq());
  }
  /** Unit length; a zero quaternion becomes the identity. */
  normalize(): this {
    const l = this.length();
    return l ? this.set(this.x / l, this.y / l, this.z / l, this.w / l) : this.identity();
  }
  /** Angle in radians of the rotation between the two (unit) quaternions. */
  angleTo(q: Vec4Like): number {
    return 2 * Math.acos(Math.min(1, Math.abs(this.dot(q))));
  }
  /** Rotates toward `q` by at most `step` radians. */
  rotateTowards(q: Vec4Like, step: number): this {
    const angle = this.angleTo(q);
    return angle ? this.slerp(q, Math.min(1, step / angle)) : this;
  }
  /** Spherical interpolation along the shortest arc; t=0 keeps this, t=1 gives q. */
  slerp(q: Vec4Like, t: number): this {
    if (t === 0) return this;
    if (t === 1) return this.copy(q);
    let { x: bx, y: by, z: bz, w: bw } = q,
      cos = this.dot(q);
    if (cos < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
      cos = -cos;
    }
    if (cos >= 1) return this;
    const sin2 = 1 - cos * cos;
    if (sin2 <= Number.EPSILON) {
      const s = 1 - t;
      return this.set(s * this.x + t * bx, s * this.y + t * by, s * this.z + t * bz, s * this.w + t * bw).normalize();
    }
    const sin = Math.sqrt(sin2),
      half = Math.atan2(sin, cos),
      a = Math.sin((1 - t) * half) / sin,
      b = Math.sin(t * half) / sin;
    return this.set(this.x * a + bx * b, this.y * a + by * b, this.z * a + bz * b, this.w * a + bw * b);
  }
  slerpQuaternions(a: Vec4Like, b: Vec4Like, t: number): this {
    return this.copy(a).slerp(b, t);
  }
  equals(q: Vec4Like, epsilon = 0): boolean {
    return (
      Math.abs(this.x - q.x) <= epsilon &&
      Math.abs(this.y - q.y) <= epsilon &&
      Math.abs(this.z - q.z) <= epsilon &&
      Math.abs(this.w - q.w) <= epsilon
    );
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    return this.set(array[offset], array[offset + 1], array[offset + 2], array[offset + 3]);
  }
  /** With no arguments returns `[x, y, z, w]`, which core `mesh.setQuaternion` accepts directly. */
  toArray(): [number, number, number, number];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray {
    out[offset] = this.x;
    out[offset + 1] = this.y;
    out[offset + 2] = this.z;
    out[offset + 3] = this.w;
    return out;
  }
}
