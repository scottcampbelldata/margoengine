// Quaternions as plain [x, y, z, w] arrays, shared by the packages (bundled into each). Keep the operand order: the
// packages rely on bit-identical results (examples/package-benchmarks/proofs/math-consolidation.proof.js).
import type { NumberArray } from './types.js';
import { axisAngle, conjugated, normalized, rotated, rotation, toArray, toVector } from './quat-core.js';

type Quat4 = [number, number, number, number];

/** Quaternion for XYZ Euler angles in radians (qX * qY * qZ), the convention of core `Mesh.setRotation`. */
export function eulerToQuaternion(x: number, y: number, z: number): [number, number, number, number] {
  const sx = Math.sin(x / 2),
    cx = Math.cos(x / 2),
    sy = Math.sin(y / 2),
    cy = Math.cos(y / 2),
    sz = Math.sin(z / 2),
    cz = Math.cos(z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** a * b (apply b, then a) as a new array. */
export const multiplyQuaternions = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * Interpolates unit quaternions `a` to `b` (`[x, y, z, w]`) along the shorter arc with an explicit close-angle switch,
 * as a new normalized array. With `dot = a · b` (b negated first when it is negative, then clamped to 1): above
 * `linearAbove` the blend is linear, `a + (b - a) * t`; otherwise it is spherical,
 * `a * sin((1 - t) θ) / sin θ + b * sin(t θ) / sin θ` with `θ = acos(dot)`. The result is divided by its length in
 * both cases, so `t = 0` and `t = 1` return normalized copies of `a` and of `b` on `a`'s side.
 *
 * `linearAbove = 0.9995` reproduces the close-angle curve Margo Voxel Studio saved before version 1 of the engine.
 * `Quaternion.slerp` keeps its own switch; this is the selectable contract for data that depends on this one.
 * @param t Blend factor, usually 0-1 (not checked; values outside extrapolate).
 * @param linearAbove The `dot` above which the blend is linear, from 0 to below 1.
 * @throws RangeError when `linearAbove` is not a number from 0 to below 1.
 */
export function interpolateQuaternions(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  t: number,
  linearAbove: number,
): [number, number, number, number] {
  if (!(linearAbove >= 0 && linearAbove < 1))
    throw new RangeError(`Quaternion linearAbove ${linearAbove} is invalid; pass a dot from 0 to below 1, e.g. 0.9995`);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
    sign = 1;
  if (dot < 0) {
    sign = -1;
    dot = -dot;
  }
  dot = Math.min(1, dot);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  if (dot > linearAbove) for (let i = 0; i < 4; i++) out[i] = a[i] + (b[i] * sign - a[i]) * t;
  else {
    const angle = Math.acos(dot),
      sin = Math.sin(angle),
      left = Math.sin((1 - t) * angle) / sin,
      right = Math.sin(t * angle) / sin;
    for (let i = 0; i < 4; i++) out[i] = a[i] * left + b[i] * sign * right;
  }
  const length = Math.hypot(out[0], out[1], out[2], out[3]);
  for (let i = 0; i < 4; i++) out[i] /= length;
  return out;
}

/**
 * Quaternion `[x, y, z, w]` of the rotation in a column-major 3x3 (9 values) or 4x4 matrix, not normalized
 * (Shepperd's method: it branches on the largest diagonal term). Each column is divided by its scale first; pass a
 * negative `sx` for a mirrored matrix. Writes `out` (a new array by default) and returns it.
 * @param e Matrix elements; a 4x4 needs only its first 11.
 * @param out Receives x, y, z, w.
 * @param sx Length of the first column (1 for a pure rotation), negative to undo a mirror; `sy`, `sz` likewise.
 */
export const rotationToQuaternion = <T extends NumberArray = Quat4>(
  e: ArrayLike<number>,
  out: T = [0, 0, 0, 0] as unknown as T,
  sx = 1,
  sy = 1,
  sz = 1,
): T => rotation(e, sx, sy, sz, out, toArray);

// These helpers and the Quaternion/Vector3 methods share one implementation each (quat-core.ts). Each writes `out`
// (a new array by default) and returns it; `out` may be the input.

/** Rotation by `angle` radians about unit `axis` `[x, y, z]`, as `[x, y, z, w]`. */
export const axisAngleToQuaternion = <T extends NumberArray = Quat4>(
  axis: ArrayLike<number>,
  angle: number,
  out: T = [0, 0, 0, 0] as unknown as T,
): T => axisAngle(axis[0], axis[1], axis[2], angle, out, toArray);
/** The inverse rotation of a unit quaternion: x, y and z negated. */
export const conjugateQuaternion = <T extends NumberArray = Quat4>(
  q: ArrayLike<number>,
  out: T = [0, 0, 0, 0] as unknown as T,
): T => conjugated(q[0], q[1], q[2], q[3], out, toArray);
/**
 * `q` divided by its length (left unchanged when the length is 0). Finite values whose squares would overflow or
 * underflow (beyond about 1e154 or below 1e-154) are divided by the largest component first, so they still normalize.
 */
export const normalizeQuaternion = <T extends NumberArray = Quat4>(
  q: ArrayLike<number>,
  out: T = [0, 0, 0, 0] as unknown as T,
): T => normalized(q[0], q[1], q[2], q[3], out, toArray);
/** `v` `[x, y, z]` rotated by unit quaternion `q` (v + 2w(u×v) + 2u×(u×v), with u = q's vector part). */
export const rotateByQuaternion = <T extends NumberArray = [number, number, number]>(
  v: ArrayLike<number>,
  q: ArrayLike<number>,
  out: T = [0, 0, 0] as unknown as T,
): T => rotated(v[0], v[1], v[2], q[0], q[1], q[2], q[3], out, toVector);
