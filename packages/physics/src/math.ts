import { eulerToQuaternion } from '@margoengine/math/quat';

/** A 3-component vector [x, y, z]. */
export type Vec3 = readonly [number, number, number];
/** A quaternion [x, y, z, w]. */
export type Quat = readonly [number, number, number, number];

export const vec = (v: Vec3 | undefined, fallback: Vec3 = [0, 0, 0]): { x: number; y: number; z: number } => {
  const [x, y, z] = v ?? fallback;
  return { x, y, z };
};
export const quat = (q: Quat | undefined): { x: number; y: number; z: number; w: number } => {
  const [x, y, z, w] = q ?? [0, 0, 0, 1];
  return { x, y, z, w };
};
export const tuple = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z];
export const tuple4 = (q: { x: number; y: number; z: number; w: number }): [number, number, number, number] => [
  q.x,
  q.y,
  q.z,
  q.w,
];

export function checkVec(value: unknown, label: string): asserts value is Vec3 {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError(`${label} must be [x, y, z]`);
  const v = value as ArrayLike<number>;
  if (v.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2]))
    throw new RangeError(`${label} must be three finite numbers`);
}

/** Same XYZ Euler convention as core's `Mesh.setRotation` (`@margoengine/math/quat` eulerToQuaternion). */
export const eulerToQuat: (x: number, y: number, z: number) => [number, number, number, number] = eulerToQuaternion;

/** The product of two quaternions [x, y, z, w]: `b` turned first, then `a`. */
export function multiplyQuat(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [
    a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
    a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
    a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
    a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
  ];
}
/** A vector turned by a unit quaternion. */
export function rotateVec(q: readonly number[], v: readonly number[]): [number, number, number] {
  const [x, y, z, w] = q as [number, number, number, number],
    tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}
/** The quaternion of a turn by the rotation vector `turn` (axis times angle), by series: no `Math`, the same in every browser. */
export function quatFromTurn(turn: readonly number[]): [number, number, number, number] {
  const half = [turn[0]! / 2, turn[1]! / 2, turn[2]! / 2],
    x2 = half[0]! * half[0]! + half[1]! * half[1]! + half[2]! * half[2]!;
  // sin(x) / x and cos(x) in x^2, to 16 terms: exact in f64 far past a turn of 2 pi.
  let sinc = 1,
    cos = 1,
    s = 1,
    c = 1;
  for (let n = 1; n <= 16; n++) {
    c = (-c * x2) / ((2 * n - 1) * (2 * n));
    s = (-s * x2) / (2 * n * (2 * n + 1));
    cos += c;
    sinc += s;
  }
  return [half[0]! * sinc, half[1]! * sinc, half[2]! * sinc, cos];
}
/** The rows of the rotation matrix of a unit quaternion, row major. */
export function matrixOf(q: readonly number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}
