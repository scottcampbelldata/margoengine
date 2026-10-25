// IEEE 754 binary16 encoding with round-to-nearest-even (overflow to infinity, subnormals kept), for f16 uniforms
// (@margoengine/compute) and half-float volume textures (@margoengine/sciviz).

/** The binary16 bit pattern of `value`. */
export function f16Bits(value) {
  const f = new Float32Array(1),
    u = new Uint32Array(f.buffer);
  f[0] = value;
  const x = u[0],
    sign = (x >>> 16) & 0x8000,
    exponent = (x >>> 23) & 0xff,
    mantissa = x & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  const e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = (mantissa | 0x800000) >>> (1 - e + 13),
      rest = (mantissa | 0x800000) & ((1 << (1 - e + 13)) - 1),
      half = 1 << (1 - e + 12);
    return sign | (m + (rest > half || (rest === half && m & 1) ? 1 : 0));
  }
  const m = mantissa >>> 13,
    rest = mantissa & 0x1fff;
  let bits = sign | (e << 10) | m;
  if (rest > 0x1000 || (rest === 0x1000 && m & 1)) bits++;
  return bits;
}
