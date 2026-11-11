// IEEE 754 binary16 conversions shared by the EXR decoder and GPU upload.

const floatView = new Float32Array(1);
const intView = new Uint32Array(floatView.buffer);

/** Decodes one binary16 value (as its 16-bit pattern) to a JS number. NaN and infinities are preserved. */
export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1,
    exponent = (bits >> 10) & 31,
    mantissa = bits & 1023;
  if (exponent === 0) return sign * mantissa * 5.960464477539063e-8;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

let table: Float32Array | undefined;
/**
 * Every binary16 pattern decoded once (halfToFloat of each index, 256 KiB, built on first use). Every half value is
 * exact in float32, so a lookup equals the computed value, about 10x faster than computing each texel.
 */
export function halfFloats(): Float32Array {
  if (!table) {
    table = new Float32Array(65536);
    for (let bits = 0; bits < 65536; bits++) table[bits] = halfToFloat(bits);
  }
  return table;
}

/** Encodes a number as binary16 with round-to-nearest-even. Values beyond 65504 become infinity, NaN stays NaN. */
export function floatToHalf(value: number): number {
  floatView[0] = value;
  const x = intView[0],
    sign = (x >>> 16) & 0x8000,
    exponent = (x >>> 23) & 255;
  let mantissa = x & 0x7fffff;
  if (exponent === 255) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  const e = exponent - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e,
      half = mantissa >>> shift,
      rest = mantissa & ((1 << shift) - 1),
      midpoint = 1 << (shift - 1);
    return sign | (half + (rest > midpoint || (rest === midpoint && half & 1) ? 1 : 0));
  }
  const half = (e << 10) | (mantissa >>> 13),
    rest = mantissa & 0x1fff;
  return sign | (half + (rest > 0x1000 || (rest === 0x1000 && half & 1) ? 1 : 0));
}

/** Largest finite binary16 value. */
export const HALF_MAX = 65504;

/**
 * Peak radiance the rgba16float environment textures store as it is: 60,000, below 65,504 so the bilinear and box
 * filters, the prefilter and blend rounding stay finite. A brighter source is divided by peak / HALF_PEAK.
 */
export const HALF_PEAK = 60000;

/**
 * The factor a lighting image is divided by before rgba16float storage: max(1, peak / HALF_PEAK), where peak is
 * the largest finite positive RGB value, rounded to float32 (alpha is not radiance). NaN, infinities and negatives carry no finite
 * energy and are stored as 0, so they are left out of the peak.
 */
export function lightingScale(data: Float32Array): number {
  const peak = lightingPeak(data);
  // An f32, so a baked file (which stores it as float32) reloads the same factor.
  return peak > HALF_PEAK ? Math.fround(peak / HALF_PEAK) : 1;
}

/** The largest finite positive RGB value of RGBA lighting texels (alpha is not radiance), 0 for none. */
export function lightingPeak(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v > peak && v < Infinity && (i & 3) !== 3) peak = v;
  }
  return peak;
}

/**
 * Converts RGBA float texels to binary16 for an rgba16float upload. Lighting data must be finite and non-negative,
 * so NaN, infinities and negatives become 0; RGB is divided by `scale` (lightingScale) and anything still above
 * 65504 clamps to 65504 instead of infinity.
 */
export function toHalfLighting(data: Float32Array, native = true, scale = 1): Uint16Array {
  // The built-in Float16Array store rounds to nearest even like floatToHalf (same bits), about 3x faster than the
  // bit-twiddling loop (p-pmrem converted its 1024 x 512 HDR in 7.4 ms, half of Environment.create's time).
  const F16 = native
      ? (
          globalThis as {
            Float16Array?: new (length: number) => ArrayBufferView<ArrayBuffer> & { [i: number]: number };
          }
        ).Float16Array
      : undefined,
    out = F16 ? new F16(data.length) : new Uint16Array(data.length),
    inverse = 1 / scale;
  for (let i = 0; i < data.length; i++) {
    const s = Math.min(stored(data, i, inverse), HALF_MAX);
    out[i] = F16 ? s : floatToHalf(s);
  }
  return F16 ? new Uint16Array(out.buffer) : (out as Uint16Array);
}

// Texel `i` as stored: finite positive RGB divided by the scale (`inverse` is 1 / scale) and rounded to f32 first,
// so the Float16Array store and floatToHalf (which reads an f32) round the same value; alpha as it is; NaN,
// infinities and negatives 0.
const stored = (data: Float32Array, i: number, inverse: number) => {
  const v = data[i];
  return v > 0 && v < Infinity ? (inverse === 1 || (i & 3) === 3 ? v : Math.fround(v * inverse)) : 0;
};

/** Same sanitizing and scale as toHalfLighting, kept in float32 for rgba32float uploads. */
export function sanitizeLighting(data: Float32Array, scale = 1): Float32Array {
  const out = new Float32Array(data.length),
    inverse = 1 / scale;
  for (let i = 0; i < data.length; i++) out[i] = stored(data, i, inverse);
  return out;
}
