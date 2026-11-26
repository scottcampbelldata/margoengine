// IEEE 754 binary16 encoding with round-to-nearest-even (overflow to infinity, subnormals kept): the bytes
// DataView.setFloat16 stores, also on runtimes without it (Node 22). A number is narrowed to binary32 with rounding to
// odd first, so it is rounded once, not twice (S. Boldo and G. Melquiond, "Emulation of FMA and correctly rounded
// sums: proved algorithms using rounding to odd", IEEE Transactions on Computers 57(4), 2008,
// https://doi.org/10.1109/TC.2007.70819). Format: IEEE 754-2019, https://doi.org/10.1109/IEEESTD.2019.8766229

// Encoding is synchronous. Reuse the bit-cast storage instead of allocating two views per voxel.
const f = new Float32Array(1),
  u = new Uint32Array(f.buffer);

/** The binary16 bit pattern of `value`. */
export function f16Bits(value) {
  f[0] = value;
  // Round to odd: an inexact binary32 result with an even last bit steps to its neighbour on the value's side.
  const lost = Math.abs(value) - Math.abs(f[0]);
  if ((lost > 0 || lost < 0) && !(u[0] & 1)) u[0] += lost > 0 ? 1 : -1;
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
