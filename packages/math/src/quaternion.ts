import { axisAngle, conjugated, normalized, rotation } from './quat-core.js';
import type { EulerOrder, MatrixLike, NumberArray, Vec3Like, Vec4Like } from './types.js';

// Result sink for the quat-core formulas: writes the components into the Quaternion.
const assign = <T extends Quaternion>(q: T, x: number, y: number, z: number, w: number): T => q.set(x, y, z, w);

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
    return axisAngle(axis.x, axis.y, axis.z, angle, this, assign);
  }
  /** Intrinsic rotation in `euler.order`: for 'XYZ' the result is qX * qY * qZ, the convention of core. */
  setFromEuler(euler: EulerLike): this {
    // The product of the three half-angle axis quaternions written out per order (no per-axis loop: this runs once per
    // object per frame in animation code). Cyclic orders (XYZ, YZX, ZXY) and the others differ only in signs.
    const sx = Math.sin(euler.x / 2),
      cx = Math.cos(euler.x / 2),
      sy = Math.sin(euler.y / 2),
      cy = Math.cos(euler.y / 2),
      sz = Math.sin(euler.z / 2),
      cz = Math.cos(euler.z / 2);
    const a = sx * cy * cz,
      b = cx * sy * sz,
      c = cx * sy * cz,
      d = sx * cy * sz,
      e = cx * cy * sz,
      f = sx * sy * cz,
      g = cx * cy * cz,
      h = sx * sy * sz;
    switch (euler.order) {
      case 'XYZ':
        return this.set(a + b, c - d, e + f, g - h);
      case 'YXZ':
        return this.set(a + b, c - d, e - f, g + h);
      case 'ZXY':
        return this.set(a - b, c + d, e + f, g - h);
      case 'ZYX':
        return this.set(a - b, c + d, e - f, g + h);
      case 'YZX':
        return this.set(a + b, c + d, e - f, g - h);
      case 'XZY':
        return this.set(a - b, c - d, e + f, g + h);
    }
    throw new RangeError(`Invalid Euler order ${euler.order}; use XYZ, XZY, YXZ, YZX, ZXY or ZYX`);
  }
  /** Reads the rotation from a pure-rotation 3x3 or 4x4 matrix (column-major; scale must be removed first). */
  setFromRotationMatrix(m: MatrixLike): this {
    return rotation(m.elements, 1, 1, 1, this, assign);
  }
  /**
   * Shortest rotation taking unit vector `from` onto unit vector `to`, normalized: the half-way construction
   * (vector part `from x to`, scalar part `1 + from . to`). Opposite vectors give a half turn about an axis
   * perpendicular to `from`.
   */
  setFromUnitVectors(from: Vec3Like, to: Vec3Like): this {
    const { x: ax, y: ay, z: az } = from,
      { x: bx, y: by, z: bz } = to,
      r = 1 + ax * bx + ay * by + az * bz;
    // Below this the half-way vector is shorter than about 1.4e-4 and the cross product no longer pins the axis
    // to the 1e-12 level, so the vectors count as opposite.
    if (r < 1e-8) {
      // Half turn (w = 0) about from x e, with e the world axis least aligned with from: perpendicular to from.
      const mx = Math.abs(ax),
        my = Math.abs(ay),
        mz = Math.abs(az);
      if (mx <= my && mx <= mz) this.set(0, az, -ay, 0);
      else if (my <= mz) this.set(-az, 0, ax, 0);
      else this.set(ay, -ax, 0, 0);
      return this.normalize();
    }
    return this.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx, r).normalize();
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
    return conjugated(this.x, this.y, this.z, this.w, this, assign);
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
    const { x, y, z, w } = this,
      l = this.length();
    // Normalizes also when the squares underflow (l is 0 but a component is not); NaN and zero give the identity.
    return l === l && (l || x || y || z || w) ? normalized(x, y, z, w, this, assign) : this.identity();
  }
  /** Angle in radians of the rotation between this and `q` (both unit), in [0, π]; `q` and `-q` give the same. */
  angleTo(q: Vec4Like): number {
    return 2 * Math.acos(Math.min(1, Math.abs(this.dot(q))));
  }
  /** Rotates toward `q` by at most `step` radians; never overshoots, and lands exactly on `q` once within reach. */
  rotateTowards(q: Vec4Like, step: number): this {
    const angle = this.angleTo(q);
    return angle === 0 ? this : this.slerp(q, Math.min(1, step / angle));
  }
  /**
   * Spherical linear interpolation along the shortest arc (Shoemake, SIGGRAPH 1985): t = 0 keeps this exactly,
   * t = 1 copies `q` exactly, `t` outside [0, 1] extrapolates along the same great circle. Not re-normalized.
   */
  slerp(q: Vec4Like, t: number): this {
    if (t === 0) return this;
    if (t === 1) return this.copy(q);
    const { x, y, z, w } = this;
    let cos = this.dot(q),
      bx = q.x,
      by = q.y,
      bz = q.z,
      bw = q.w;
    // q and -q are the same rotation; the one with a non-negative dot is the shorter way round.
    if (cos < 0) {
      cos = -cos;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    if (cos >= 1) return this;
    const sinSq = 1 - cos * cos;
    // A half-angle sine at rounding level cannot be divided by reliably; there the arc is a straight line.
    if (sinSq <= Number.EPSILON) {
      return this.set(x + (bx - x) * t, y + (by - y) * t, z + (bz - z) * t, w + (bw - w) * t).normalize();
    }
    const sin = Math.sqrt(sinSq),
      angle = Math.atan2(sin, cos),
      ka = Math.sin((1 - t) * angle) / sin,
      kb = Math.sin(t * angle) / sin;
    return this.set(x * ka + bx * kb, y * ka + by * kb, z * ka + bz * kb, w * ka + bw * kb);
  }
  /** this = `a` slerped toward `b` by `t` (see {@link Quaternion.slerp}). */
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
