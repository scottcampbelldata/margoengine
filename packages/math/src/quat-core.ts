// The one implementation of each quaternion formula, on plain numbers. Results go to a `sink`, so the array helpers in
// quat.ts write arrays and Quaternion/Vector3 write their own fields, with no temporary arrays. Not a package entry.
import type { NumberArray } from './types.js';

// A sink receives a result: `[x, y, z, w]` or `[x, y, z]` (w unused), and returns `out`.

/** Writes into an array: x, y, z and, for a quaternion, w. */
export const toArray = <T extends NumberArray>(out: T, x: number, y: number, z: number, w: number): T => {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
};
/** Writes x, y, z into an array. */
export const toVector = <T extends NumberArray>(out: T, x: number, y: number, z: number): T => {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
};

/**
 * Quaternion of the rotation in a column-major 3x3 (9 elements) or 4x4 matrix, each rotation column first divided by
 * its scale `sx`, `sy`, `sz` (1 for a pure rotation, negative to undo a mirror). Not normalized. Shepperd's method
 * (Journal of Guidance and Control 1(3), 1978): the square root is taken of the largest of 1 + trace and the three
 * 1 + 2 m_ii - trace terms, so it is bounded away from zero; that component comes out positive.
 */
export function rotation<T>(
  e: ArrayLike<number>,
  sx: number,
  sy: number,
  sz: number,
  out: T,
  sink: (out: T, x: number, y: number, z: number, w: number) => T,
): T {
  const n = e.length === 9 ? 3 : 4,
    // mRC: row R, column C.
    m00 = e[0] / sx,
    m10 = e[1] / sx,
    m20 = e[2] / sx,
    m01 = e[n] / sy,
    m11 = e[n + 1] / sy,
    m21 = e[n + 2] / sy,
    m02 = e[2 * n] / sz,
    m12 = e[2 * n + 1] / sz,
    m22 = e[2 * n + 2] / sz,
    trace = m00 + m11 + m22;
  // Branch rule kept fixed (exporters write these signs to files): trace when strictly positive, else the strictly
  // largest diagonal term, with ties going to the later axis.
  if (trace > 0) {
    const r = Math.sqrt(1 + trace),
      f = 0.5 / r;
    return sink(out, (m21 - m12) * f, (m02 - m20) * f, (m10 - m01) * f, r / 2);
  }
  if (m00 > m11 && m00 > m22) {
    const r = Math.sqrt(1 + m00 - m11 - m22),
      f = 0.5 / r;
    return sink(out, r / 2, (m01 + m10) * f, (m02 + m20) * f, (m21 - m12) * f);
  }
  if (m11 > m22) {
    const r = Math.sqrt(1 + m11 - m00 - m22),
      f = 0.5 / r;
    return sink(out, (m01 + m10) * f, r / 2, (m12 + m21) * f, (m02 - m20) * f);
  }
  const r = Math.sqrt(1 + m22 - m00 - m11),
    f = 0.5 / r;
  return sink(out, (m02 + m20) * f, (m12 + m21) * f, r / 2, (m10 - m01) * f);
}

/** (x, y, z, w) divided by its length; finite values beyond about 1e±154 are divided by the largest first. A zero length leaves it. */
export function normalized<T>(
  a: number,
  b: number,
  c: number,
  d: number,
  out: T,
  sink: (out: T, x: number, y: number, z: number, w: number) => T,
): T {
  let l = Math.sqrt(a * a + b * b + c * c + d * d);
  if (!(l > 2 ** -511 && l < Infinity)) {
    const m = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    if (m > 0 && m < Infinity) {
      a /= m;
      b /= m;
      c /= m;
      d /= m;
      l = Math.sqrt(a * a + b * b + c * c + d * d);
    }
  }
  l ||= 1;
  return sink(out, a / l, b / l, c / l, d / l);
}

/** The inverse rotation of a unit quaternion: x, y and z negated. */
export const conjugated = <T>(
  x: number,
  y: number,
  z: number,
  w: number,
  out: T,
  sink: (out: T, x: number, y: number, z: number, w: number) => T,
): T => sink(out, -x, -y, -z, w);

/** Rotation by `angle` radians about the unit axis (x, y, z). */
export function axisAngle<T>(
  x: number,
  y: number,
  z: number,
  angle: number,
  out: T,
  sink: (out: T, x: number, y: number, z: number, w: number) => T,
): T {
  const s = Math.sin(angle / 2);
  return sink(out, x * s, y * s, z * s, Math.cos(angle / 2));
}

/** (x, y, z) rotated by the unit quaternion (qx, qy, qz, qw): v + 2w(u×v) + 2u×(u×v). */
export function rotated<T>(
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: T,
  sink: (out: T, x: number, y: number, z: number, w: number) => T,
): T {
  const tx = 2 * (qy * z - qz * y),
    ty = 2 * (qz * x - qx * z),
    tz = 2 * (qx * y - qy * x);
  return sink(
    out,
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
    0,
  );
}
