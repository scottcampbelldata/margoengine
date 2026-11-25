// Pinned maths, the TypeScript twin of kernel-common's K01 (`packages/physics/kernel-common/src/pinned.rs`): `exp`, `ln`,
// `sin`, `cos`, `pow` and fixed-order sums over f64 built only from + - * /, integer operations and truncation, step for step
// as the Rust is, so every browser engine, a native build and a Wasm build give the same bits. `Math.exp`, `Math.sin` and
// `**` are left to the engine by the language and differ between engines in the last bits, so anything that feeds the state
// of a deterministic simulation uses these instead (docs/physics-framework.md, section 7).
// `packages/physics/kernel-common/tests/pinned-vectors.txt` pins both languages to the same bits.
//
// Methods, as the Rust: argument reduction by the leading and trailing parts of ln 2 and of pi / 2 (W. J. Cody and W. Waite,
// "Software Manual for the Elementary Functions", Prentice-Hall 1980) and Taylor series on the reduced interval
// (J.-M. Muller, "Elementary Functions: Algorithms and Implementation", 3rd ed., Birkhauser 2016, chapters 4 and 11); `pow`
// carries ln x and y ln x as pairs of doubles (TwoSum; T. J. Dekker, "A floating-point technique for extending the available
// precision", Numerische Mathematik 18, 1971); `sum` adds blocks of 256 in order and the blocks by a balanced tree (J. Demmel
// and H. D. Nguyen, "Parallel reproducible summation", IEEE Transactions on Computers 64(7), 2015).

const LN2_HI = 0.6931471805598903;
const LN2_LO = 5.497923018708371e-14;
const INV_LN2 = 1.4426950408889634;
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_3 = 2.0222662487111665e-21;
const PIO2_3T = 8.4784276603689e-32;
const TWO_OVER_PI = 6.366197723675814e-1;
const SQRT2 = 1.4142135623730951;
const MIN_POSITIVE = 2.2250738585072014e-308;

// One f64 viewed as its two 32-bit words (little-endian, as every platform JavaScript runs on).
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** 2^k for k in [-1022, 1023], by its bits. */
function pow2(k: number): number {
  u32[0] = 0;
  u32[1] = (k + 1023) << 20;
  return f64[0]!;
}

/** Rust's `as i64` for the small values used here: truncation toward zero. */
const truncate = (x: number): number => (x < 0 ? -Math.floor(-x) : Math.floor(x));

/** e^x. Within 2 ulp for |x| < 700; 0 below -745 and infinity above 709.78; NaN stays NaN. */
export function exp(x: number): number {
  if (x !== x) return x;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  const k = truncate(x * INV_LN2 + (x < 0 ? -0.5 : 0.5));
  const r = x - k * LN2_HI - k * LN2_LO;
  let sum = 1 / 20922789888000;
  for (let n = 15; n >= 1; n--) {
    let fact = 1,
      m = 1;
    while (m < n) {
      m++;
      fact *= m;
    }
    sum = sum * r + 1 / fact;
  }
  const e = sum * r + 1;
  if (k > 1023) return e * pow2(k - 1000) * pow2(1000);
  if (k < -1022) return e * pow2(k + 1000) * pow2(-1000);
  return e * pow2(k);
}

/** The exponent and the mantissa in [sqrt(2)/2, sqrt(2)) of a positive normal x. */
function split(x: number): [number, number] {
  f64[0] = x;
  let e = ((u32[1]! >>> 20) & 0x7ff) - 1023;
  u32[1] = (u32[1]! & 0x000fffff) | 0x3ff00000;
  let m = f64[0]!;
  if (m > SQRT2) {
    m *= 0.5;
    e += 1;
  }
  return [e, m];
}

/** ln m for m in [sqrt(2)/2, sqrt(2)): 2 atanh s, s = (m - 1) / (m + 1), to s^25. */
function lnMantissa(m: number): number {
  const s = (m - 1) / (m + 1),
    z = s * s;
  let sum = 1 / 27,
    n = 25;
  while (n >= 3) {
    sum = sum * z + 1 / n;
    n -= 2;
  }
  return 2 * s * (1 + z * sum);
}

/** ln x for x > 0. Within 2 ulp; -infinity at 0, NaN below 0, infinity at infinity. */
export function ln(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return x;
  let shift = 0;
  if (x < MIN_POSITIVE) {
    x *= pow2(54);
    shift = -54;
  }
  const [e0, m] = split(x),
    e = e0 + shift;
  return e * LN2_HI + (lnMantissa(m) + e * LN2_LO);
}

/** x = k pi / 2 + r with r in [-pi/4, pi/4]: [k mod 4, r], for |x| < 2^20. */
function reduce(x: number): [number, number] {
  const k = truncate(x * TWO_OVER_PI + (x < 0 ? -0.5 : 0.5));
  let r = x - k * PIO2_1;
  r -= k * PIO2_2;
  r -= k * PIO2_3;
  r -= k * PIO2_3T;
  return [k & 3, r];
}

const SIN_COEF = new Float64Array(14);
const COS_COEF = new Float64Array(15);
{
  let fact = 1;
  for (let n = 0; n < 14; n++) {
    if (n > 0) fact *= 2 * n * (2 * n + 1);
    SIN_COEF[n] = 1 / fact;
  }
  fact = 1;
  for (let n = 0; n < 15; n++) {
    if (n > 0) fact *= (2 * n - 1) * (2 * n);
    COS_COEF[n] = 1 / fact;
  }
}

function sinKernel(r: number): number {
  const z = r * r;
  let sum = 0;
  for (let n = 13; n >= 0; n--) sum = sum * z + (n % 2 === 0 ? 1 : -1) * SIN_COEF[n]!;
  return r * sum;
}

function cosKernel(r: number): number {
  const z = r * r;
  let sum = 0;
  for (let n = 14; n >= 0; n--) sum = sum * z + (n % 2 === 0 ? 1 : -1) * COS_COEF[n]!;
  return sum;
}

/** sin x for |x| < 2^20 radians, within 2 ulp; NaN beyond. */
export function sin(x: number): number {
  if (!(x < 1048576 && x > -1048576)) return NaN;
  const [k, r] = reduce(x);
  return k === 0 ? sinKernel(r) : k === 1 ? cosKernel(r) : k === 2 ? -sinKernel(r) : -cosKernel(r);
}

/** cos x for |x| < 2^20 radians, within 2 ulp; NaN beyond. */
export function cos(x: number): number {
  if (!(x < 1048576 && x > -1048576)) return NaN;
  const [k, r] = reduce(x);
  return k === 0 ? cosKernel(r) : k === 1 ? -sinKernel(r) : k === 2 ? -cosKernel(r) : sinKernel(r);
}

/** a + b as a rounded sum and its exact error (TwoSum). */
function twoSum(a: number, b: number): [number, number] {
  const s = a + b,
    t = s - a;
  return [s, a - (s - t) + (b - t)];
}

/** a * b as a rounded product and its exact error, by Dekker's split into halves of 26 bits. */
function twoProd(a: number, b: number): [number, number] {
  const SPLIT = 134217729,
    ca = SPLIT * a,
    ah = ca - (ca - a),
    al = a - ah,
    cb = SPLIT * b,
    bh = cb - (cb - b),
    bl = b - bh,
    p = a * b;
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}

/** ln x for x > 0 as a pair hi + lo, about 105 bits. */
function lnPair(x: number): [number, number] {
  if (!(x > MIN_POSITIVE)) return [ln(x), 0];
  const [e, m] = split(x),
    [hi, err] = twoSum(e * LN2_HI, lnMantissa(m));
  return twoSum(hi, err + e * LN2_LO);
}

/** x^y for x > 0 as e^(y ln x) carried to about 105 bits: within 4 ulp for |y ln x| < 700. 1 for y = 0. */
export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  if (!(x > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return exp(y * ln(x));
  const [hi, lo] = lnPair(x),
    [p, q0] = twoProd(y, hi),
    q = q0 + y * lo,
    r = exp(p);
  return r + r * (q + 0.5 * q * q);
}

/** The sum of `values` in a fixed order: blocks of 256 in order, the blocks' sums by a balanced tree over their indices. */
export function sum(values: ArrayLike<number>): number {
  const BLOCK = 256,
    partial: number[] = [];
  for (let at = 0; at < values.length; at += BLOCK) {
    let s = 0;
    const end = Math.min(at + BLOCK, values.length);
    for (let i = at; i < end; i++) s += values[i]!;
    partial.push(s);
  }
  return tree(partial, 0, partial.length);
}

function tree(values: readonly number[], from: number, to: number): number {
  const n = to - from;
  if (n === 0) return 0;
  if (n === 1) return values[from]!;
  const middle = from + (n >> 1);
  return tree(values, from, middle) + tree(values, middle, to);
}

/** The dot product of two arrays of equal length, summed as {@link sum} sums the products. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length)
    throw new RangeError(`dot takes two arrays of one length (got ${a.length} and ${b.length}).`);
  const products = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) products[i] = a[i]! * b[i]!;
  return sum(products);
}

/**
 * sqrt(x^2 + y^2 + z^2): the squares summed in order and the square root, which IEEE 754 rounds correctly on every engine
 * (unlike `Math.hypot`, whose algorithm each engine picks). For lengths whose squares stay finite, below about 1e154.
 */
export function hypot(x: number, y: number, z = 0): number {
  return Math.sqrt(x * x + y * y + z * z);
}
