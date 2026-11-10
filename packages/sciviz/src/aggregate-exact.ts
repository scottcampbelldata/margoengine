/** Binary64 superaccumulator, in units of the smallest subnormal, following Neal (2015). */
const buffer = new ArrayBuffer(8),
  view = new DataView(buffer);
export function words(value: number): readonly [number, number] {
  view.setFloat64(0, value, true);
  return [view.getUint32(0, true), view.getUint32(4, true)];
}
export function numberOf(lo: number, hi: number): number {
  view.setUint32(0, lo, true);
  view.setUint32(4, hi, true);
  return view.getFloat64(0, true);
}
export function integerOf(lo: number, hi: number): bigint {
  const exponent = (hi >>> 20) & 2047;
  const mantissa = BigInt(lo) | (BigInt((hi & 0xfffff) | (exponent ? 0x100000 : 0)) << 32n);
  return (hi >>> 31 ? -mantissa : mantissa) << BigInt(exponent ? exponent - 1 : 0);
}
/** Correctly round an exact integer/rational to binary64, including subnormals and overflow. */
export function rounded(value: bigint, divisor = 1): number {
  if (!value) return 0;
  const negative = value < 0n,
    n = negative ? -value : value,
    d = BigInt(divisor);
  let length = n.toString(2).length - d.toString(2).length;
  if (length >= 0 && n < d << BigInt(length)) length--;
  const shift = Math.max(0, length - 52),
    denominator = d << BigInt(shift);
  let q = n / denominator;
  const remainder = n % denominator;
  if (2n * remainder > denominator || (2n * remainder === denominator && q & 1n)) q++;
  const result = Number(q) * 2 ** (shift - 1074);
  return negative ? -result : result;
}
export const LIMBS = 134;
export const STATS = 12;
export function partialInteger(data: Uint32Array, offset: number): bigint {
  let value = 0n;
  for (let i = LIMBS - 1; i >= 0; i--)
    value = (value << 16n) + BigInt(data[offset + i]) - BigInt(data[offset + LIMBS + i]);
  return value;
}
