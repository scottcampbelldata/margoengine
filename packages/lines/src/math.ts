/** Column-major 4x4 helpers kept local so the package does not depend on other packages' internals. */
export type Mat4 = ArrayLike<number>;

export const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Inverts a column-major 4x4 matrix in double precision. Returns false when it is singular. */
export function invert(out: Float64Array | Float32Array, m: Mat4): boolean {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return false;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return true;
}

/** Writes M * (x, y, z, 1) divided by w into out at offset. */
export function transformPoint(out: Float32Array | number[], offset: number, m: Mat4, x: number, y: number, z: number): void {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[offset] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[offset + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[offset + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
}

/** Copies source into target and reports whether anything changed. */
export function copyIfChanged(target: Float32Array, source: Mat4): boolean {
  let changed = false;
  for (let i = 0; i < target.length; i++) if (target[i] !== source[i]) {target[i] = source[i]; changed = true;}
  return changed;
}

export function finiteArray(values: ArrayLike<number>, label: string): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} must be finite Float32 values`);
  }
}
