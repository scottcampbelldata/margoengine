// IEEE 754 binary16 conversions shared by the EXR decoder and GPU upload.

const floatView = new Float32Array(1);
const intView = new Uint32Array(floatView.buffer);

/** Decodes one binary16 value (as its 16-bit pattern) to a JS number. NaN and infinities are preserved. */
export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, mantissa = bits & 1023;
  if (exponent === 0) return sign * mantissa * 5.960464477539063e-8;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** Encodes a number as binary16 with round-to-nearest-even. Values beyond 65504 become infinity, NaN stays NaN. */
export function floatToHalf(value: number): number {
  floatView[0] = value;
  const x = intView[0], sign = (x >>> 16) & 0x8000, exponent = (x >>> 23) & 255;
  let mantissa = x & 0x7fffff;
  if (exponent === 255) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  let e = exponent - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e, half = mantissa >>> shift, rest = mantissa & ((1 << shift) - 1), midpoint = 1 << (shift - 1);
    return sign | (half + (rest > midpoint || (rest === midpoint && (half & 1)) ? 1 : 0));
  }
  const half = (e << 10) | (mantissa >>> 13), rest = mantissa & 0x1fff;
  return sign | (half + (rest > 0x1000 || (rest === 0x1000 && (half & 1)) ? 1 : 0));
}

/** Largest finite binary16 value. */
export const HALF_MAX = 65504;

/**
 * Converts RGBA float texels to binary16 for an rgba16float upload. Lighting data must be finite and
 * non-negative, so NaN and negatives become 0 and values above 65504 clamp to 65504 instead of infinity.
 */
export function toHalfLighting(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = v > 0 ? floatToHalf(v < HALF_MAX ? v : HALF_MAX) : 0;
  }
  return out;
}

/** Same sanitizing as toHalfLighting, kept in float32 for rgba32float uploads. */
export function sanitizeLighting(data: Float32Array): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = v > 0 ? (v < 3.4e38 ? v : 3.4e38) : 0;
  }
  return out;
}
