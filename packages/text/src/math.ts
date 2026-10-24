/**
 * Helpers only text uses; shared ones come from `@margoengine/math`. `compose` stays local because it writes the
 * world matrix straight into the Text object's Float32Array, with no temporary array per update.
 */
import type { Mat4 } from '@margoengine/math';

export type { Mat4 };

export const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Writes translation(p) * rotation(q) * scale(s) into `out` (column-major) and returns it. `q` is `[x, y, z, w]`,
 * used as given (callers pass unit quaternions). Entry for entry equal to `composeMatrix` from `@margoengine/math`
 * after Float32 storage: the same products, with the factor two applied to exact sums.
 */
export function compose(
  out: Float32Array,
  p: ArrayLike<number>,
  q: ArrayLike<number>,
  s: ArrayLike<number>,
): Float32Array {
  const x = q[0],
    y = q[1],
    z = q[2],
    w = q[3],
    sx = s[0],
    sy = s[1],
    sz = s[2];
  // Pairwise products of the quaternion components, each used once or twice below.
  const xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;
  // Column 0: the image of +X, scaled by s[0].
  out[0] = (1 - 2 * (yy + zz)) * sx;
  out[1] = 2 * (xy + wz) * sx;
  out[2] = 2 * (xz - wy) * sx;
  out[3] = 0;
  // Column 1: the image of +Y, scaled by s[1].
  out[4] = 2 * (xy - wz) * sy;
  out[5] = (1 - 2 * (xx + zz)) * sy;
  out[6] = 2 * (yz + wx) * sy;
  out[7] = 0;
  // Column 2: the image of +Z, scaled by s[2].
  out[8] = 2 * (xz + wy) * sz;
  out[9] = 2 * (yz - wx) * sz;
  out[10] = (1 - 2 * (xx + yy)) * sz;
  out[11] = 0;
  // Column 3: translation.
  out[12] = p[0];
  out[13] = p[1];
  out[14] = p[2];
  out[15] = 1;
  return out;
}

export function finiteArray(values: ArrayLike<number>, length: number, label: string): void {
  if (!values || values.length !== length) throw new TypeError(`${label} needs ${length} values`);
  for (let i = 0; i < length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
      throw new RangeError(`${label} must be finite Float32 values`);
  }
}
