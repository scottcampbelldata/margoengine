// Integer fixed-point arithmetic for everything that decides a biome map's output (spec decision D9). Every function
// here uses only integer-valued doubles below 2^53, `Math.imul`, shifts and `| 0`, so its result is the same bit
// pattern on every JavaScript engine, and each one maps onto WGSL i32 and u32 operations (a 32 x 32 to 64-bit
// multiply built from 16-bit limbs). Where `Math.sqrt` or a double division gives a first guess, an integer
// correction step makes the final value exact, so the guess never decides anything.
// Sources: CORDIC, Volder, "The CORDIC trigonometric computing technique", IRE Transactions on Electronic Computers,
// 1959 (vectoring and rotation modes, gain K); the binary logarithm by repeated squaring is the textbook digit-by-digit
// method (each squaring of a mantissa in [1, 2) yields one fraction bit).
import { rangeError } from '../../shared/errors.js';

/** 1.0 in Q16.16, the format of most fixed-point values in this package. */
export const ONE = 65536;

/** A full turn as a 32-bit binary angle: angles wrap at 2^32, so a turn is 0 again. Half a turn is -2^31 as i32. */
export const TURN = 4294967296;

let high = 0;

/**
 * The exact signed 64-bit product of two i32 values. Returns the low 32 bits as a u32; read the high 32 bits (i32)
 * with {@link mulHigh} right after the call.
 * @example
 * const lo = mul64(-3, 1 << 30); // high: mulHigh() === -1, lo === 0x40000000
 */
export function mul64(a: number, b: number): number {
  a |= 0;
  b |= 0;
  const ah = a >> 16,
    al = a & 0xffff,
    bh = b >> 16,
    bl = b & 0xffff;
  // ah*bh*2^32 + (ah*bl + al*bh)*2^16 + al*bl, each term exact in a double; the floor division by 2^32 is exact.
  high = (ah * bh + Math.floor(((ah * bl + al * bh) * 65536 + al * bl) / TURN)) | 0;
  return Math.imul(a, b) >>> 0;
}

/** The high 32 bits (i32) of the last {@link mul64} product. */
export function mulHigh(): number {
  return high;
}

/**
 * `floor(a * b / 2^shift)` of two i32 values, from the exact 64-bit product, wrapped to i32 (the low 32 bits).
 * `shift` is an integer in 0..32.
 */
export function mulShift(a: number, b: number, shift: number): number {
  // Fast path: a product below 2^53 is exact as a double, and so is its floor division by a power of two.
  const p = (a | 0) * (b | 0);
  if (p < 9007199254740992 && p > -9007199254740992) return Math.floor(p / 2 ** shift) | 0;
  const lo = mul64(a, b);
  if (shift === 0) return lo | 0;
  if (shift === 32) return high;
  return (high << (32 - shift)) | (lo >>> shift) | 0;
}

/** Q16.16 product, `floor(a * b / 65536)`, exact, wrapped to i32. */
export function qmul(a: number, b: number): number {
  return mulShift(a, b, 16);
}

// Division follows WGSL's integer rules exactly (WGSL section 8.8), so the CPU and a GPU kernel give the same bytes
// even for a zero divisor: x / 0 is x, x % 0 is 0, INT_MIN / -1 is INT_MIN and INT_MIN % -1 is 0. A raw `/` or `%` on
// integers would not (in JavaScript `(x / 0) | 0` is 0); tests/no-raw-division.test.js bans them in this package
// except by a non-zero constant.

/** i32 division as WGSL's `/`: rounded toward zero; `x / 0` is `x`; `-2^31 / -1` is `-2^31`. */
export function idiv(a: number, b: number): number {
  a |= 0;
  b |= 0;
  if (b === 0 || (b === -1 && a === -2147483648)) return a;
  return (a / b) | 0; // |a / b| < 2^31 and the double quotient is never within rounding of the next integer
}

/** i32 remainder as WGSL's `%`: `a - trunc(a / b) * b`; `x % 0` and `-2^31 % -1` are 0. */
export function imod(a: number, b: number): number {
  a |= 0;
  b |= 0;
  if (b === 0 || (b === -1 && a === -2147483648)) return 0;
  return (a % b) | 0;
}

/** u32 division as WGSL's `/` on u32: floor; `x / 0` is `x`. */
export function udiv(a: number, b: number): number {
  a >>>= 0;
  b >>>= 0;
  return b === 0 ? a : Math.floor(a / b) >>> 0;
}

/** u32 remainder as WGSL's `%` on u32; `x % 0` is 0. */
export function umod(a: number, b: number): number {
  a >>>= 0;
  b >>>= 0;
  return b === 0 ? 0 : (a % b) >>> 0;
}

/**
 * Division of integers wider than 32 bits (|n| below 2^53), rounded toward zero and exact, with WGSL's zero rule
 * (`n / 0` is `n`): for CPU-only steps whose numerator does not fit an i32. A double quotient guesses and one integer
 * correction step makes it exact.
 */
export function divWide(n: number, d: number): number {
  if (d === 0) return n;
  let q = Math.trunc(n / d);
  const r = n - q * d,
    ad = Math.abs(d),
    s = d < 0 ? -1 : 1;
  if (n >= 0) {
    if (r < 0) q -= s;
    else if (r >= ad) q += s;
  } else if (r > 0) q += s;
  else if (r <= -ad) q -= s;
  return q + 0;
}

/** Floor division of integers below 2^53 in magnitude, exact, with WGSL's zero rule (`n / 0` is `n`). CPU only. */
export function divFloor(n: number, d: number): number {
  const q = divWide(n, d);
  return d !== 0 && q * d !== n && n < 0 !== d < 0 ? q - 1 : q;
}

/**
 * Q16.16 quotient `a / b` rounded toward zero, exact, wrapped to i32. `a / 0` is `a * 65536` wrapped (WGSL's zero rule
 * on the 48-bit numerator).
 */
export function qdiv(a: number, b: number): number {
  return divWide((a | 0) * ONE, b | 0) | 0;
}

/**
 * `floor(sqrt(n))` for an integer `n` in 0..2^52, exact (a double square root guesses, integer steps correct it).
 * @throws RangeError for a negative, fractional or too large `n`.
 */
export function isqrt(n: number): number {
  if (!(n >= 0 && n <= 4503599627370496) || n !== Math.floor(n))
    throw rangeError('isqrt needs an integer in 0..2^52; clamp or scale the value first', 'biomes');
  let s = Math.floor(Math.sqrt(n));
  while (s * s > n) s--;
  while ((s + 1) * (s + 1) <= n) s++;
  return s;
}

/** Q16.16 square root of a non-negative Q16.16 value, `floor(sqrt(x) * 65536)`. */
export function qsqrt(x: number): number {
  return isqrt((x >>> 0) * ONE);
}

/**
 * Binary logarithm of a positive Q16.16 value, as Q16.16. The fraction comes from 16 squarings of a Q15 mantissa
 * (every product fits a u32), rounded at each step, so it is within 6 units of the last place of `log2`
 * (1e-4). 0 or less gives -2^31.
 */
export function qlog2(x: number): number {
  x |= 0;
  if (x <= 0) return -2147483648;
  const e = 31 - Math.clz32(x);
  let m = e >= 15 ? x >>> (e - 15) : x << (15 - e),
    frac = 0;
  for (let bit = 1 << 15; bit; bit >>>= 1) {
    m = ((Math.imul(m, m) >>> 0) + 16384) >>> 15; // m < 2^16, so m^2 + 2^14 < 2^32: exact
    if (m >= 65536) {
      m >>>= 1;
      frac |= bit;
    }
  }
  return ((e - 16) * ONE + frac) | 0;
}

// round(2^(j/16) * 2^24), j = 0..16.
const EXP2 = [
  16777216, 17520007, 18295684, 19105703, 19951585, 20834917, 21757357, 22720638, 23726566, 24777031, 25874004,
  27019544, 28215802, 29465022, 30769550, 32131834, 33554432,
];

/**
 * Two to the power of a Q16.16 value, as Q16.16: a 17-entry Q24 table for sixteenths and a third-order series in Q24
 * for the rest (every product below 2^53), within 1 unit of the last place relative to the result. Inputs at or above
 * 15.0 saturate to 2^31 - 1; inputs below -18.0 give 0.
 */
export function qexp2(x: number): number {
  x |= 0;
  if (x >= 15 * ONE) return 2147483647;
  const n = x >> 16,
    f = x & 0xffff,
    t = Math.floor(((f & 0xfff) * 11629080) / ONE), // r ln 2 in Q24, r below 1/16
    t2 = Math.floor((t * t) / 33554432), // t^2 / 2
    t3 = Math.floor((t2 * t) / 50331648), // t^3 / 6
    m = Math.floor((EXP2[f >>> 12] * (16777216 + t + t2 + t3)) / 4294967296); // Q16
  if (n >= 0) return Math.min(2147483647, m * 2 ** n) | 0;
  return n <= -18 ? 0 : Math.floor(m / 2 ** -n);
}

/** `qexp2(qmul(y, qlog2(x)))`: a positive Q16.16 value to a Q16.16 power. */
export function qpow(x: number, y: number): number {
  return x <= 0 ? 0 : qexp2(qmul(y, qlog2(x)));
}

// round(atan(2^-i) / 2 pi * 2^32): CORDIC angles as 32-bit binary angles.
const ATAN = [
  536870912, 316933406, 167458907, 85004756, 42667331, 21354465, 10679838, 5340245, 2670163, 1335087, 667544, 333772,
  166886, 83443, 41722, 20861, 10430, 5215, 2608, 1304, 652, 326, 163, 81, 41, 20, 10, 5, 3, 1,
];
// round(prod cos(atan(2^-i)) * 2^29): the inverse CORDIC gain in Q29.
const GAIN = 326016437;

/**
 * `atan2(y, x)` of two integers (any common scale) as a 32-bit binary angle (i32: 2^31 is half a turn, so -2^31..2^31
 * covers -pi..pi), by CORDIC vectoring. Within about 64 binary-angle units (1e-7 radians). `atan2(0, 0)` is 0.
 */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  let z = 0;
  if (x < 0) {
    x = -x;
    y = -y;
    z = -2147483648;
  }
  // Scale so the larger magnitude is in [2^28, 2^29): the CORDIC gain (1.65) then stays below 2^31.
  const m = Math.max(Math.abs(x), Math.abs(y));
  let shift = m < 2147483648 ? Math.clz32(m) - 3 : 28 - Math.floor(Math.log2(m));
  while (m * 2 ** shift >= 536870912) shift--;
  while (m * 2 ** shift < 268435456) shift++;
  let px = Math.floor(x * 2 ** shift) | 0,
    py = Math.floor(y * 2 ** shift) | 0;
  for (let i = 0; i < ATAN.length; i++) {
    const dx = px >> i,
      dy = py >> i;
    if (py > 0) {
      px += dy;
      py -= dx;
      z = (z + ATAN[i]) | 0;
    } else {
      px -= dy;
      py += dx;
      z = (z - ATAN[i]) | 0;
    }
  }
  return z;
}

/**
 * Cosine and sine of a 32-bit binary angle (see {@link atan2}) by CORDIC rotation, written to `out` as Q16.16
 * `[cos, sin]`, within 2 units of the last place.
 */
export function sincos<T extends { [index: number]: number }>(angle: number, out: T): T {
  let z = angle | 0,
    sign = 1;
  // Fold into -pi/2..pi/2: rotating by half a turn negates both outputs.
  if (z > 1073741824 || z < -1073741824) {
    z = (z + 2147483648) | 0;
    sign = -1;
  }
  let x = GAIN,
    y = 0;
  for (let i = 0; i < ATAN.length; i++) {
    const dx = x >> i,
      dy = y >> i;
    if (z >= 0) {
      x -= dy;
      y += dx;
      z = (z - ATAN[i]) | 0;
    } else {
      x += dy;
      y -= dx;
      z = (z + ATAN[i]) | 0;
    }
  }
  out[0] = sign * ((x + 4096) >> 13);
  out[1] = sign * ((y + 4096) >> 13);
  return out;
}

// Hastings' arccos polynomial, Abramowitz and Stegun 4.4.46 (|error| below 2e-8 rad), coefficients in Q24.
const ACOS = [26353589, -3600370, 1492820, -841785, 518280, -286691, 111906, -21181];

/**
 * Arc cosine of a Q16.16 value (clamped to -1..1) as Q16.16 radians, within 3 units: `sqrt(1 - |x|)` times a
 * degree-7 polynomial (Abramowitz and Stegun 4.4.46), mirrored for negative x.
 */
export function qacos(x: number): number {
  x = clampInt(x | 0, -ONE, ONE);
  const t = Math.abs(x);
  let p = ACOS[7];
  for (let i = 6; i >= 0; i--) p = Math.floor((p * t) / ONE) + ACOS[i];
  const r = Math.floor((qsqrt(ONE - t) * p) / 16777216);
  return x < 0 ? 205887 - r : r;
}

/** A binary angle from degrees (quantised once by plain arithmetic, which every engine rounds the same way). */
export function degreesToAngle(degrees: number): number {
  return Math.round(((((degrees % 360) + 540) % 360) - 180) * (TURN / 360)) | 0;
}

/** Clamps an integer to `[min, max]`. */
export function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Wendland's compactly supported C2 kernel (Wendland 1995, d <= 3) on Q16.16: `(1 - r)^4 (4 r + 1)` for r in 0..1,
 * 1.0 at 0 and exactly 0 from 1 on.
 */
export function wendland(r: number): number {
  if (r <= 0) return ONE;
  if (r >= ONE) return 0;
  const s = ONE - r,
    s2 = qmul(s, s);
  return qmul(qmul(s2, s2), 4 * r + ONE);
}

/**
 * Quintic fade `6t^5 - 15t^4 + 10t^3` on Q16.16 t in 0..1 (Perlin, "Improving Noise", SIGGRAPH 2002), within 2 units
 * of the last place, every product below 2^53.
 */
export function fade(t: number): number {
  const a = t * t,
    cube = Math.floor((a * t) / ONE),
    poly = Math.floor((6 * a - 15 * ONE * t + 10 * ONE * ONE) / ONE);
  return Math.floor((cube * poly) / 4294967296);
}
