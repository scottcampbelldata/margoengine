// Small allocation-light vector and matrix helpers shared by every control (plain vec3 and quaternion ones are in
// @margoengine/math/vec3 and /quat).
import { cross, dot } from '@margoengine/math/vec3';
import { normalizeQuaternion, rotationToQuaternion } from '@margoengine/math/quat';
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

export const EPS = 1e-6;
/** Throws a RangeError unless every value is finite, so one NaN from a script cannot reach the camera. */
export function finiteInput(what: string, ...values: number[]): void {
  for (const value of values)
    if (!Number.isFinite(value)) throw new RangeError(`${what} must be finite; pass a finite number, not ${value}`);
}
/** Throws a RangeError unless a dolly factor is finite and above 0. */
export function dollyFactor(factor: number): void {
  if (!(factor > 0) || !Number.isFinite(factor))
    throw new RangeError(`Dolly factor must be finite and above 0; pass a positive number, not ${factor}`);
}
export const madd = (a: readonly number[], b: readonly number[], s: number): V3 => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
];

/** Rotates `v` around unit `axis` by `angle` radians (Rodrigues). */
export function rotateAxis(v: readonly number[], axis: readonly number[], angle: number): V3 {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    k = dot(axis, v) * (1 - c),
    x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

/** Rotation part of a column-major 4x4 (columns normalized, so scale is removed). */
export function quatFromMatrix(m: ArrayLike<number>): Q4 {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1,
    sy = Math.hypot(m[4], m[5], m[6]) || 1,
    sz = Math.hypot(m[8], m[9], m[10]) || 1;
  return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 0], sx, sy, sz));
}

export const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const transformPoint = (m: ArrayLike<number>, p: readonly number[]): V3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
/** Inverse of an affine column-major 4x4. */
export function invertAffine(m: ArrayLike<number>): number[] {
  const a = m[0],
    b = m[4],
    c = m[8],
    d = m[1],
    e = m[5],
    f = m[9],
    g = m[2],
    h = m[6],
    i = m[10];
  const A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g,
    det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det))
    throw new RangeError('Parent matrix is not invertible; use a parent with non-zero scale on every axis');
  const r = 1 / det;
  const n = [
    A * r,
    B * r,
    C * r,
    0,
    (c * h - b * i) * r,
    (a * i - c * g) * r,
    (b * g - a * h) * r,
    0,
    (b * f - c * e) * r,
    (c * d - a * f) * r,
    (a * e - b * d) * r,
    0,
    0,
    0,
    0,
    1,
  ];
  const t = transformPoint(n, [m[12], m[13], m[14]]);
  n[12] = -t[0];
  n[13] = -t[1];
  n[14] = -t[2];
  return n;
}
