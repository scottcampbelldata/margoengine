// Small allocation-light vector, quaternion and matrix helpers shared by every control (the plain vec3 ones are in @margoengine/math/vec3).
import {add, cross, dot, scale} from '@margoengine/math/vec3';
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

export const EPS = 1e-6;
export const madd = (a: readonly number[], b: readonly number[], s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Rotates `v` around unit `axis` by `angle` radians (Rodrigues). */
export function rotateAxis(v: readonly number[], axis: readonly number[], angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v) * (1 - c), x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

export const quatAxis = (axis: readonly number[], angle: number): Q4 => {const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];};
export const quatConj = (q: readonly number[]): Q4 => [-q[0], -q[1], -q[2], q[3]];
export function quatNormalize(q: readonly number[]): Q4 {const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];}
export function quatRotate(q: readonly number[], v: readonly number[]): V3 {
  const u: V3 = [q[0], q[1], q[2]], t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}
/** Rotation part of a column-major 4x4 (columns normalized, so scale is removed). */
export function quatFromMatrix(m: ArrayLike<number>): Q4 {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const m00 = m[0] / sx, m10 = m[1] / sx, m20 = m[2] / sx, m01 = m[4] / sy, m11 = m[5] / sy, m21 = m[6] / sy, m02 = m[8] / sz, m12 = m[9] / sz, m22 = m[10] / sz;
  const trace = m00 + m11 + m22;
  let q: Q4;
  if (trace > 0) {const s = 0.5 / Math.sqrt(trace + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];}
  else if (m00 > m11 && m00 > m22) {const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];}
  else if (m11 > m22) {const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];}
  else {const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];}
  return quatNormalize(q);
}

export const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const transformPoint = (m: ArrayLike<number>, p: readonly number[]): V3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
/** Inverse of an affine column-major 4x4. */
export function invertAffine(m: ArrayLike<number>): number[] {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) throw new RangeError('Parent matrix is not invertible');
  const r = 1 / det;
  const n = [A * r, B * r, C * r, 0, (c * h - b * i) * r, (a * i - c * g) * r, (b * g - a * h) * r, 0, (b * f - c * e) * r, (c * d - a * f) * r, (a * e - b * d) * r, 0, 0, 0, 0, 1];
  const t = transformPoint(n, [m[12], m[13], m[14]]);
  n[12] = -t[0]; n[13] = -t[1]; n[14] = -t[2];
  return n;
}
