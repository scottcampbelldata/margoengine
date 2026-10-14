import type {NumberArray} from './types.js';

// Column-major 4x4 matrices as plain arrays (number[], Float32Array, Float64Array: the layout of core `camera.matrix`
// and mesh world matrices). Arithmetic is float64; a Float32Array `out` rounds once on store. Nothing allocates.
// These are the one copy the packages share and they rely on bit-identical results, so keep every expression's operand
// order as it is (examples/package-benchmarks/proofs/math-consolidation.proof.js checks them against the old copies).

/** out = a * b. `out` must not alias `a` or `b`. */
export function multiplyMatrices<T extends NumberArray>(a: ArrayLike<number>, b: ArrayLike<number>, out: T): T {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

/** Inverse by cofactors. Returns `out`, or null (leaving `out` untouched) when the determinant is 0 or not finite. */
export function invertMatrix<T extends NumberArray>(m: ArrayLike<number>, out: T): T | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/**
 * Inverse by Gauss-Jordan elimination with scaled partial pivoting, for camera and model matrices where accuracy near
 * singular matters more than speed. Returns null (leaving `out` untouched) for non-finite input, a singular matrix, or a
 * result that is not finite (or overflows Float32 when `out` is a Float32Array). `out` may be `m`. Pass a `workspace`
 * of 52 float64s, sharing no buffer with `out` or `m`, to avoid the allocation.
 */
export function invertMatrixStable<T extends Float32Array | Float64Array>(m: ArrayLike<number>, out: T, workspace?: Float64Array): T | null {
  if (!out || out.length < 16 || !m || m.length < 16) return null;
  const a = workspace ?? new Float64Array(52);
  if (!(a instanceof Float64Array) || a.length < 52 || a.buffer === out.buffer || a.buffer === (m as Partial<Float64Array>).buffer) return null;
  for (let r = 0; r < 4; r++) {
    let scale = 0;
    for (let c = 0; c < 8; c++) { const v = c < 4 ? m[c * 4 + r] : +(c - 4 === r); if (!Number.isFinite(v)) return null; a[r * 8 + c] = v; if (c < 4) scale = Math.max(scale, Math.abs(v)); }
    if (!scale) return null; a[32 + r] = scale;
  }
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 8 + c]) / a[32 + r] > Math.abs(a[pivot * 8 + c]) / a[32 + pivot]) pivot = r;
    if (a[pivot * 8 + c] === 0 || !Number.isFinite(a[pivot * 8 + c])) return null;
    for (let k = 0; k < 8; k++) { const value = a[c * 8 + k]; a[c * 8 + k] = a[pivot * 8 + k]; a[pivot * 8 + k] = value; }
    const scale = a[32 + c]; a[32 + c] = a[32 + pivot]; a[32 + pivot] = scale;
    const d = a[c * 8 + c]; for (let k = 0; k < 8; k++) a[c * 8 + k] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r * 8 + c]; for (let k = 0; k < 8; k++) a[r * 8 + k] -= f * a[c * 8 + k]; }
  }
  for (let i = 0; i < 16; i++) { const v = a[(i % 4) * 8 + (i >> 2) + 4]; if (!Number.isFinite(v) || out instanceof Float32Array && !Number.isFinite(Math.fround(v))) return null; a[36 + i] = v; }
  for (let i = 0; i < 16; i++) out[i] = a[36 + i];
  return out;
}