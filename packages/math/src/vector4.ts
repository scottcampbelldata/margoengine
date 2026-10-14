import type {MatrixLike, NumberArray, Vec4Like} from './types.js';

export class Vector4 {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

  set(x: number, y: number, z: number, w: number): this { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  setScalar(s: number): this { this.x = this.y = this.z = this.w = s; return this; }
  copy(v: Vec4Like): this { this.x = v.x; this.y = v.y; this.z = v.z; this.w = v.w; return this; }
  clone(): Vector4 { return new Vector4(this.x, this.y, this.z, this.w); }

  add(v: Vec4Like): this { this.x += v.x; this.y += v.y; this.z += v.z; this.w += v.w; return this; }
  addScaledVector(v: Vec4Like, s: number): this { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; this.w += v.w * s; return this; }
  sub(v: Vec4Like): this { this.x -= v.x; this.y -= v.y; this.z -= v.z; this.w -= v.w; return this; }
  multiply(v: Vec4Like): this { this.x *= v.x; this.y *= v.y; this.z *= v.z; this.w *= v.w; return this; }
  multiplyScalar(s: number): this { this.x *= s; this.y *= s; this.z *= s; this.w *= s; return this; }
  divideScalar(s: number): this { return this.multiplyScalar(1 / s); }
  negate(): this { return this.multiplyScalar(-1); }
  min(v: Vec4Like): this { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); this.z = Math.min(this.z, v.z); this.w = Math.min(this.w, v.w); return this; }
  max(v: Vec4Like): this { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); this.z = Math.max(this.z, v.z); this.w = Math.max(this.w, v.w); return this; }

  dot(v: Vec4Like): number { return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w; }
  lengthSq(): number { return this.dot(this); }
  length(): number { return Math.sqrt(this.lengthSq()); }
  normalize(): this { return this.divideScalar(this.length() || 1); }
  lerp(v: Vec4Like, t: number): this {
    this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; this.w += (v.w - this.w) * t; return this;
  }
  /** Full 4x4 multiply (no perspective divide). */
  applyMatrix4(m: MatrixLike): this {
    const e = m.elements, x = this.x, y = this.y, z = this.z, w = this.w;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12] * w;
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13] * w;
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14] * w;
    this.w = e[3] * x + e[7] * y + e[11] * z + e[15] * w;
    return this;
  }
  equals(v: Vec4Like, epsilon = 0): boolean {
    return Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon && Math.abs(this.z - v.z) <= epsilon && Math.abs(this.w - v.w) <= epsilon;
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    this.x = array[offset]; this.y = array[offset + 1]; this.z = array[offset + 2]; this.w = array[offset + 3]; return this;
  }
  toArray(): [number, number, number, number];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray {
    out[offset] = this.x; out[offset + 1] = this.y; out[offset + 2] = this.z; out[offset + 3] = this.w; return out;
  }
}
