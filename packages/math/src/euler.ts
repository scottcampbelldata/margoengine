import type { EulerOrder, MatrixLike, NumberArray, Vec3Like, Vec4Like } from './types.js';

const DEGREES = Math.PI / 180;

let scratch: Float64Array | undefined;
// Axis indices (0 = x, 1 = y, 2 = z) of the first, middle and last rotation of each order.
const ORDER_AXES: Record<string, readonly [number, number, number] | undefined> = {
  XYZ: [0, 1, 2],
  XZY: [0, 2, 1],
  YXZ: [1, 0, 2],
  YZX: [1, 2, 0],
  ZXY: [2, 0, 1],
  ZYX: [2, 1, 0],
};
/** @throws RangeError for an order that is not one of the six (as Quaternion.setFromEuler). */
const orderAxes = (order: string): readonly [number, number, number] => {
  const axes = Object.hasOwn(ORDER_AXES, order) ? ORDER_AXES[order] : undefined;
  if (!axes) throw new RangeError(`Invalid Euler order ${order}; use XYZ, XZY, YXZ, YZX, ZXY or ZYX`);
  return axes;
};

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

  /**
   * Reads the angles in `order` (default: the receiver's order) from the rotation part of a column-major 3x3 or 4x4
   * matrix (unscaled; it is not normalized) and sets `this.order = order`. The middle angle comes back in
   * [-π/2, π/2], the outer two in [-π, π]. The last angle is read first and the first angle is then solved from it,
   * so the triple reproduces the matrix even next to a gimbal pole; at an exact pole the last angle is 0.
   * @throws RangeError for an order that is not one of the six.
   */
  setFromRotationMatrix(m: MatrixLike, order: EulerOrder = this.order): this {
    const e = m.elements,
      n = e.length === 9 ? 3 : 4,
      // Axes of the first, middle and last rotation: R = R_a * R_b * R_c.
      [a, b, c] = orderAxes(order),
      // +1 when (a, b, c) is a cyclic shift of (X, Y, Z), so that axis a x axis b = +axis c; -1 otherwise.
      sign = (b - a + 3) % 3 === 1 ? 1 : -1,
      at = (row: number, column: number): number => e[column * n + row];
    // R_a leaves its own axis alone, so row a of R is row a of R_b * R_c:
    //   R[a][a] = cos B cos C,  R[a][b] = -sign cos B sin C,  R[a][c] = sign sin B.
    const raa = at(a, a),
      rab = at(a, b),
      cosB = Math.hypot(raa, rab),
      sinB = Math.max(-1, Math.min(1, sign * at(a, c))),
      // From both sine and cosine, so B keeps its small distance from a pole even where sin B rounds to ±1.
      angleB = Math.atan2(sinB, cosB),
      // At an exact pole (cos B = 0) only the combination of A and C is defined: A carries all of it.
      angleC = cosB === 0 ? 0 : Math.atan2(-sign * rab, raa),
      cc = Math.cos(angleC),
      sc = sign * Math.sin(angleC);
    // Undo R_c: column b of R * R_c^T is cos C * (column b of R) + sign sin C * (column a of R), and it equals
    // R_a * axis b = cos A * axis b + sign sin A * axis c. A is solved from the chosen C, so the two stay consistent.
    const mbb = cc * at(b, b) + sc * at(b, a),
      mcb = cc * at(c, b) + sc * at(c, a);
    this.setAxis(a, Math.atan2(sign * mcb, mbb));
    this.setAxis(b, angleB);
    this.setAxis(c, angleC);
    this.order = order;
    return this;
  }
  /**
   * Angles in `order` (default: the receiver's order) of the unit quaternion `q`, read through its rotation matrix
   * exactly as {@link Euler.setFromRotationMatrix}. Does not modify `q`; `q` and `-q` give the same angles.
   * @throws RangeError for an order that is not one of the six.
   */
  setFromQuaternion(q: Vec4Like, order: EulerOrder = this.order): this {
    const { x, y, z, w } = q,
      r = (scratch ??= new Float64Array(9));
    // The standard unit-quaternion rotation matrix, column-major 3x3; each term is a product of two components.
    r[0] = 1 - 2 * (y * y + z * z);
    r[1] = 2 * (x * y + w * z);
    r[2] = 2 * (x * z - w * y);
    r[3] = 2 * (x * y - w * z);
    r[4] = 1 - 2 * (x * x + z * z);
    r[5] = 2 * (y * z + w * x);
    r[6] = 2 * (x * z + w * y);
    r[7] = 2 * (y * z - w * x);
    r[8] = 1 - 2 * (x * x + y * y);
    return this.setFromRotationMatrix({ elements: r }, order);
  }
  // Writes the angle about axis 0 (x), 1 (y) or 2 (z).
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
 * @throws RangeError for a non-finite angle or an unknown order.
 */
export function degreesToQuaternion(
  degrees: ArrayLike<number>,
  order: EulerOrder = 'XYZ',
): [number, number, number, number] {
  const [x, y, z] = [0, 1, 2].map((i) => degrees[i] * DEGREES);
  if (![x, y, z].every(Number.isFinite)) throw new RangeError('Euler angles must be three finite degree values');
  const axes = orderAxes(order);
  // q = q * axis(angle) for each axis of order, as Quaternion.setFromEuler.
  let q: [number, number, number, number] = [0, 0, 0, 1];
  for (let i = 0; i < 3; i++) {
    const axis = axes[i],
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
 * @throws RangeError for a non-finite or zero quaternion, or an unknown order.
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
