import type {MatrixLike, NumberArray, Vec2Like} from './types.js';

export class Vector2 {
  constructor(public x = 0, public y = 0) {}

  set(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setScalar(s: number): this { this.x = this.y = s; return this; }
  copy(v: Vec2Like): this { this.x = v.x; this.y = v.y; return this; }
  clone(): Vector2 { return new Vector2(this.x, this.y); }

  add(v: Vec2Like): this { this.x += v.x; this.y += v.y; return this; }
  addScalar(s: number): this { this.x += s; this.y += s; return this; }
  addVectors(a: Vec2Like, b: Vec2Like): this { this.x = a.x + b.x; this.y = a.y + b.y; return this; }
  addScaledVector(v: Vec2Like, s: number): this { this.x += v.x * s; this.y += v.y * s; return this; }
  sub(v: Vec2Like): this { this.x -= v.x; this.y -= v.y; return this; }
  subVectors(a: Vec2Like, b: Vec2Like): this { this.x = a.x - b.x; this.y = a.y - b.y; return this; }
  multiply(v: Vec2Like): this { this.x *= v.x; this.y *= v.y; return this; }
  multiplyScalar(s: number): this { this.x *= s; this.y *= s; return this; }
  divide(v: Vec2Like): this { this.x /= v.x; this.y /= v.y; return this; }
  divideScalar(s: number): this { return this.multiplyScalar(1 / s); }
  negate(): this { this.x = -this.x; this.y = -this.y; return this; }
  min(v: Vec2Like): this { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); return this; }
  max(v: Vec2Like): this { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); return this; }
  clamp(min: Vec2Like, max: Vec2Like): this { return this.max(min).min(max); }

  dot(v: Vec2Like): number { return this.x * v.x + this.y * v.y; }
  /** z component of the 3D cross product. */
  cross(v: Vec2Like): number { return this.x * v.y - this.y * v.x; }
  lengthSq(): number { return this.x * this.x + this.y * this.y; }
  length(): number { return Math.hypot(this.x, this.y); }
  manhattanLength(): number { return Math.abs(this.x) + Math.abs(this.y); }
  normalize(): this { return this.divideScalar(this.length() || 1); }
  setLength(length: number): this { return this.normalize().multiplyScalar(length); }
  /** Angle in radians from the +x axis, in [0, 2π). */
  angle(): number { return Math.atan2(-this.y, -this.x) + Math.PI; }
  distanceTo(v: Vec2Like): number { return Math.hypot(this.x - v.x, this.y - v.y); }
  distanceToSquared(v: Vec2Like): number { const dx = this.x - v.x, dy = this.y - v.y; return dx * dx + dy * dy; }

  lerp(v: Vec2Like, t: number): this { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; return this; }
  lerpVectors(a: Vec2Like, b: Vec2Like, t: number): this { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; return this; }
  rotateAround(center: Vec2Like, angle: number): this {
    const c = Math.cos(angle), s = Math.sin(angle), x = this.x - center.x, y = this.y - center.y;
    this.x = x * c - y * s + center.x; this.y = x * s + y * c + center.y; return this;
  }
  /** Treats this as a point (x, y, 1) and applies a 3x3 affine matrix. */
  applyMatrix3(m: MatrixLike): this {
    const e = m.elements, x = this.x, y = this.y;
    this.x = e[0] * x + e[3] * y + e[6]; this.y = e[1] * x + e[4] * y + e[7]; return this;
  }
  equals(v: Vec2Like, epsilon = 0): boolean { return Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon; }

  fromArray(array: ArrayLike<number>, offset = 0): this { this.x = array[offset]; this.y = array[offset + 1]; return this; }
  toArray(): [number, number];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray { out[offset] = this.x; out[offset + 1] = this.y; return out; }
}
