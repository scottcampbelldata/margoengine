// Float64 column-major 4x4 matrices: tile transforms are composed in double precision (ECEF coordinates are millions
// of metres; float32 would lose centimetres). Only the few operations the tiles package needs.

/** A column-major 4x4 matrix in float64 (16 numbers, translation in elements 12 to 14). */
export type Matrix4 = Float64Array;

/** A new identity matrix. */
export function identity(): Matrix4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Copies 16 numbers (a tileset `transform` array) into a new float64 matrix. */
export function fromArray(values: ArrayLike<number>): Matrix4 {
  return Float64Array.from({ length: 16 }, (_, i) => values[i]);
}

/** out = a * b (column-major), safe when out aliases a or b. */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Matrix4 = new Float64Array(16)): Matrix4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++)
      r[c * 4 + row] =
        a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
  out.set(r);
  return out;
}

/** Inverse of a general 4x4 matrix; throws RangeError when it is singular. */
export function invert(m: ArrayLike<number>, out: Matrix4 = new Float64Array(16)): Matrix4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10,
    b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12,
    b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30,
    b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det))
    throw new RangeError('Singular transform; give every tile an invertible transform');
  const s = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * s;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * s;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * s;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * s;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * s;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * s;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * s;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * s;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * s;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * s;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * s;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * s;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * s;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * s;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * s;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * s;
  return out;
}

/** Transforms the point (x, y, z, 1). */
export function transformPoint(m: ArrayLike<number>, p: ArrayLike<number>): [number, number, number] {
  const x = p[0],
    y = p[1],
    z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Transforms the direction (x, y, z, 0). */
export function transformDirection(m: ArrayLike<number>, p: ArrayLike<number>): [number, number, number] {
  const x = p[0],
    y = p[1],
    z = p[2];
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/** A translation matrix. */
export function translation(x: number, y: number, z: number): Matrix4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * glTF is y-up and 3D Tiles is z-up: tile content in glTF is rotated +90 degrees about x before the tile transform
 * (3D Tiles 1.1, "glTF transforms"). Maps (x, y, z) to (x, -z, y).
 */
export const Y_UP_TO_Z_UP: Matrix4 = /* @__PURE__ */ Float64Array.of(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
/** The inverse of `Y_UP_TO_Z_UP`: z-up tileset coordinates to the engine's y-up world. Maps (x, y, z) to (x, z, -y). */
export const Z_UP_TO_Y_UP: Matrix4 = /* @__PURE__ */ Float64Array.of(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

/**
 * Splits an affine matrix without shear into translation, rotation quaternion [x, y, z, w] and scale. A mirrored
 * matrix (negative determinant) puts the reflection in the x scale.
 */
export function decompose(m: ArrayLike<number>): {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
} {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]);
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  // Shepperd's method on the rotation matrix (column-major r[col * 3 + row]).
  const m00 = r[0],
    m11 = r[4],
    m22 = r[8],
    trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r[5] - r[7]) / s;
    y = (r[6] - r[2]) / s;
    z = (r[1] - r[3]) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (r[5] - r[7]) / s;
    x = s / 4;
    y = (r[3] + r[1]) / s;
    z = (r[6] + r[2]) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (r[6] - r[2]) / s;
    x = (r[3] + r[1]) / s;
    y = s / 4;
    z = (r[7] + r[5]) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (r[1] - r[3]) / s;
    x = (r[6] + r[2]) / s;
    y = (r[7] + r[5]) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return { translation: [m[12], m[13], m[14]], rotation: [x / n, y / n, z / n, w / n], scale: [sx, sy, sz] };
}
