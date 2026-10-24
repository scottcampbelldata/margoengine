// The one implementation of each quaternion formula, on plain numbers. Results go to a `sink`, so the array helpers in
// quat.ts write arrays and Quaternion/Vector3 write their own fields, with no temporary arrays. Not a package entry.
import type { NumberArray } from './types.js';

/** Receives a result: `[x, y, z, w]` or `[x, y, z]` (w unused). Returns `out`. */
export type Sink<T> = (out: T, x: number, y: number, z: number, w: number) => T;

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

/** Shepperd's method on a column-major 3x3 or 4x4, each column divided by its scale. Not normalized. */
export function rotation<T>(e: ArrayLike<number>, sx: number, sy: number, sz: number, out: T, sink: Sink<T>): T {
  const k = e.length === 9 ? 3 : 4,
    m11 = e[0] / sx,
    m21 = e[1] / sx,
    m31 = e[2] / sx,
    m12 = e[k] / sy,
    m22 = e[k + 1] / sy,
    m32 = e[k + 2] / sy,
    m13 = e[2 * k] / sz,
    m23 = e[2 * k + 1] / sz,
    m33 = e[2 * k + 2] / sz,
    trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    return sink(out, (m32 - m23) / s, (m13 - m31) / s, (m21 - m12) / s, s / 4);
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return sink(out, s / 4, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return sink(out, (m12 + m21) / s, s / 4, (m23 + m32) / s, (m13 - m31) / s);
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return sink(out, (m13 + m31) / s, (m23 + m32) / s, s / 4, (m21 - m12) / s);
}

/** (x, y, z, w) divided by its length; finite values beyond about 1e±154 are divided by the largest first. A zero length leaves it. */
export function normalized<T>(a: number, b: number, c: number, d: number, out: T, sink: Sink<T>): T {
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
export const conjugated = <T>(x: number, y: number, z: number, w: number, out: T, sink: Sink<T>): T =>
  sink(out, -x, -y, -z, w);

/** Rotation by `angle` radians about the unit axis (x, y, z). */
export function axisAngle<T>(x: number, y: number, z: number, angle: number, out: T, sink: Sink<T>): T {
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
  sink: Sink<T>,
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
