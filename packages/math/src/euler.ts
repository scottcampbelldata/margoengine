import type { EulerOrder, MatrixLike, NumberArray, Vec3Like, Vec4Like } from './types.js';

const DEGREES = Math.PI / 180;

let scratch: Float64Array | undefined;
const axisIndex = (order: string, i: number): number => order.charCodeAt(i) - 88; // 'X' = 88

/**
 * Intrinsic Euler angles in radians. The default 'XYZ' order matches core `mesh.rotation`
 * and `mesh.setRotation`, so `euler.setFromVector3(mesh.rotation)` and `mesh.setRotation(euler.toArray())` round-trip.
 */
export class Euler {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public order: EulerOrder = 'XYZ',
  ) {}

  set(x: number, y: number, z: number, order: EulerOrder = this.order): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
    return this;
  }
  copy(e: { x: number; y: number; z: number; order: EulerOrder }): this {
    return this.set(e.x, e.y, e.z, e.order);
  }
  clone(): Euler {
    return new Euler(this.x, this.y, this.z, this.order);
  }
  /** Takes angles from any `{x, y, z}`, such as core `mesh.rotation`. */
  setFromVector3(v: Vec3Like, order: EulerOrder = this.order): this {
    return this.set(v.x, v.y, v.z, order);
  }

  /** Reads angles from the rotation part of a 3x3 or 4x4 matrix (column-major, unscaled). */
  setFromRotationMatrix(m: MatrixLike, order: EulerOrder = this.order): this {
    const e = m.elements,
      k = e.length === 9 ? 3 : 4,
      at = (row: number, column: number): number => e[column * k + row];
    // Order "ABC" means R = R_A * R_B * R_C. With axis indices i, j, l, element (i, l) is ±sin(B).
    const i = axisIndex(order, 0),
      j = axisIndex(order, 1),
      l = axisIndex(order, 2),
      sign = (j - i + 3) % 3 === 1 ? 1 : -1;
    const sinB = Math.max(-1, Math.min(1, sign * at(i, l))),
      cosB = Math.hypot(at(i, i), at(i, j)),
      c = cosB === 0 ? 0 : Math.atan2(-sign * at(i, j), at(i, i)),
      sinC = Math.sin(c),
      cosC = Math.cos(c);
    // Remove R_C first: the (j,j) and (l,j) entries of R * inverse(R_C) are cos(A) and ±sin(A).
    // Unlike reading A and C independently from terms proportional to cos(B), this keeps their combination
    // consistent even when those terms are at rounding precision. At an exact pole either C is valid.
    const a = Math.atan2(at(l, i) * sinC + sign * at(l, j) * cosC, sign * at(j, i) * sinC + at(j, j) * cosC);
    this.order = order;
    this.setAxis(i, a);
    // atan2 retains the distance from the pole when sin(B) has rounded to ±1.
    this.setAxis(j, Math.atan2(sinB, cosB));
    this.setAxis(l, c);
    return this;
  }
  /** Converts a unit quaternion to angles in `order`. */
  setFromQuaternion(q: Vec4Like, order: EulerOrder = this.order): this {
    const { x, y, z, w } = q,
      m = (scratch ??= new Float64Array(9));
    m[0] = 1 - 2 * (y * y + z * z);
    m[3] = 2 * (x * y - z * w);
    m[6] = 2 * (x * z + y * w);
    m[1] = 2 * (x * y + z * w);
    m[4] = 1 - 2 * (x * x + z * z);
    m[7] = 2 * (y * z - x * w);
    m[2] = 2 * (x * z - y * w);
    m[5] = 2 * (y * z + x * w);
    m[8] = 1 - 2 * (x * x + y * y);
    return this.setFromRotationMatrix({ elements: m }, order);
  }
  private setAxis(index: number, value: number): void {
    if (index === 0) this.x = value;
    else if (index === 1) this.y = value;
    else this.z = value;
  }
  equals(e: { x: number; y: number; z: number; order: EulerOrder }, epsilon = 0): boolean {
    return (
      e.order === this.order &&
      Math.abs(this.x - e.x) <= epsilon &&
      Math.abs(this.y - e.y) <= epsilon &&
      Math.abs(this.z - e.z) <= epsilon
    );
  }

  /** Reads x, y, z (order unchanged). */
  fromArray(array: ArrayLike<number>, offset = 0): this {
    return this.set(array[offset], array[offset + 1], array[offset + 2]);
  }
  /** With no arguments returns `[x, y, z]` for core `mesh.setRotation` (which uses 'XYZ'). */
  toArray(): [number, number, number];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray {
    out[offset] = this.x;
    out[offset + 1] = this.y;
    out[offset + 2] = this.z;
    return out;
  }
}

/**
 * Quaternion `[x, y, z, w]` of intrinsic Euler angles given in degrees, applied in `order` (the {@link Euler}
 * convention). For angles saved in degrees, as editors and file formats usually keep them.
 * @throws RangeError for a non-finite angle.
 */
export function degreesToQuaternion(
  degrees: ArrayLike<number>,
  order: EulerOrder = 'XYZ',
): [number, number, number, number] {
  const [x, y, z] = [0, 1, 2].map((i) => degrees[i] * DEGREES);
  if (![x, y, z].every(Number.isFinite)) throw new RangeError('Euler angles must be three finite degree values');
  // q = q * axis(angle) for each axis of order, as Quaternion.setFromEuler.
  let q: [number, number, number, number] = [0, 0, 0, 1];
  for (let i = 0; i < 3; i++) {
    const axis = axisIndex(order, i),
      half = [x, y, z][axis] / 2,
      s = Math.sin(half),
      b = [0, 0, 0, Math.cos(half)];
    b[axis] = s;
    q = [
      q[3] * b[0] + q[0] * b[3] + q[1] * b[2] - q[2] * b[1],
      q[3] * b[1] - q[0] * b[2] + q[1] * b[3] + q[2] * b[0],
      q[3] * b[2] + q[0] * b[1] - q[1] * b[0] + q[2] * b[3],
      q[3] * b[3] - q[0] * b[0] - q[1] * b[1] - q[2] * b[2],
    ];
  }
  return q;
}

/**
 * Intrinsic Euler angles in degrees, in `order`, of quaternion `[x, y, z, w]` (normalized first). At a gimbal
 * singularity the result is still a valid angle set for the same orientation.
 * @throws RangeError for a non-finite or zero quaternion.
 */
export function quaternionToDegrees(
  quaternion: ArrayLike<number>,
  order: EulerOrder = 'XYZ',
): [number, number, number] {
  const [x, y, z, w] = [0, 1, 2, 3].map((i) => quaternion[i]),
    length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('Quaternion must be finite and non-zero');
  const e = new Euler().setFromQuaternion({ x: x / length, y: y / length, z: z / length, w: w / length }, order);
  return [e.x / DEGREES, e.y / DEGREES, e.z / DEGREES];
}
