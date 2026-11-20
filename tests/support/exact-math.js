// Trigonometry from exactly specified operations only, for digests that must be the same bits on every machine.
// ECMA-262 leaves Math.sin, cos, tan, atan, atan2, acos, asin, exp, log and hypot implementation-approximated, and the x64
// machine that recorded the digests and an arm64 Mac disagree in the last bit of some of them. These use +, -, *, /,
// Math.sqrt, Math.round, Math.abs and exact powers of two (all correctly rounded or exact) and are within a few units in the last place.

// pi / 2 as a 33-bit head, exact when multiplied by a small whole number, and the remainder.
const HALF_PI_HEAD = 1.5707963267341256,
  HALF_PI_TAIL = 6.077100506506192e-11;

/** The angle reduced to r in [-pi / 4, pi / 4] and its quadrant: a = q pi / 2 + r. */
function reduce(a) {
  const q = Math.round(a / (Math.PI / 2));
  return [a - q * HALF_PI_HEAD - q * HALF_PI_TAIL, ((q % 4) + 4) % 4];
}
// Taylor series on [-pi / 4, pi / 4]: the terms fall below 1e-20 by degree 22.
function sinSeries(r) {
  const r2 = r * r;
  let term = r,
    sum = r;
  for (let k = 2; k <= 22; k += 2) {
    term *= -r2 / (k * (k + 1));
    sum += term;
  }
  return sum;
}
function cosSeries(r) {
  const r2 = r * r;
  let term = 1,
    sum = 1;
  for (let k = 1; k <= 21; k += 2) {
    term *= -r2 / (k * (k + 1));
    sum += term;
  }
  return sum;
}
export function sin(a) {
  if (!Number.isFinite(a)) return Number.NaN;
  if (a === 0) return a;
  const [r, q] = reduce(a);
  return q === 0 ? sinSeries(r) : q === 1 ? cosSeries(r) : q === 2 ? -sinSeries(r) : -cosSeries(r);
}
export function cos(a) {
  if (!Number.isFinite(a)) return Number.NaN;
  const [r, q] = reduce(a);
  return q === 0 ? cosSeries(r) : q === 1 ? -sinSeries(r) : q === 2 ? -cosSeries(r) : sinSeries(r);
}
export const tan = (a) => sin(a) / cos(a);
export function atan(x) {
  if (Number.isNaN(x)) return x;
  if (x === 0) return x;
  if (x === Number.POSITIVE_INFINITY) return Math.PI / 2;
  if (x === Number.NEGATIVE_INFINITY) return -Math.PI / 2;
  // Beyond 1, atan x = +-pi / 2 - atan(1 / x); then two halvings, atan x = 2 atan(x / (1 + sqrt(1 + x^2))), bring
  // |x| to tan(pi / 16), where the series falls below 1e-20 by degree 27.
  if (Math.abs(x) > 1) return (x > 0 ? Math.PI / 2 : -Math.PI / 2) - atan(1 / x);
  let y = x;
  for (let h = 0; h < 2; h++) y = y / (1 + Math.sqrt(1 + y * y));
  const y2 = y * y;
  let power = y,
    sum = y;
  for (let k = 3; k <= 27; k += 2) {
    power *= -y2;
    sum += power / k;
  }
  return 4 * sum;
}
export function atan2(y, x) {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  const negativeY = y < 0 || Object.is(y, -0);
  if (y === 0) {
    const toward = x < 0 || Object.is(x, -0) ? Math.PI : 0;
    return negativeY ? -toward : toward;
  }
  if (x === 0) return negativeY ? -Math.PI / 2 : Math.PI / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (!Number.isFinite(x) && !Number.isFinite(y)) {
      const r = x > 0 ? Math.PI / 4 : (3 * Math.PI) / 4;
      return negativeY ? -r : r;
    }
    if (!Number.isFinite(y)) return negativeY ? -Math.PI / 2 : Math.PI / 2;
    return x > 0 ? (negativeY ? -0 : 0) : negativeY ? -Math.PI : Math.PI;
  }
  // Measured from the nearer axis, so the quotient stays at or below 1 and keeps its precision.
  if (Math.abs(y) > Math.abs(x)) return (negativeY ? -Math.PI / 2 : Math.PI / 2) - atan(x / y);
  const a = atan(y / x);
  return x > 0 ? a : negativeY ? a - Math.PI : a + Math.PI;
}
export const asin = (x) => (Math.abs(x) > 1 ? Number.NaN : atan2(x, Math.sqrt((1 - x) * (1 + x))));
export const acos = (x) => (Math.abs(x) > 1 ? Number.NaN : atan2(Math.sqrt((1 - x) * (1 + x)), x));
export function hypot(...values) {
  let largest = 0;
  for (const v of values) {
    const a = Math.abs(v);
    if (a === Number.POSITIVE_INFINITY) return a;
    if (a > largest || Number.isNaN(a)) largest = a;
  }
  if (Number.isNaN(largest)) return largest;
  if (largest === 0) return 0;
  let sum = 0;
  for (const v of values) {
    const s = v / largest;
    sum += s * s;
  }
  return Math.sqrt(sum) * largest;
}
// ln 2 as a head whose products with whole numbers up to 2^11 are exact, and the remainder.
const LN2_HEAD = 0.6931471803691238,
  LN2_TAIL = 1.9082149292705877e-10;
const bits = new DataView(new ArrayBuffer(8));
/** 2^k for a whole k in the normal range, built from its bits. */
function twoTo(k) {
  bits.setUint32(0, (k + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}
export function exp(x) {
  if (Number.isNaN(x)) return x;
  if (x > 709.782712893384) return Number.POSITIVE_INFINITY;
  if (x < -708.3964185322641) return x === Number.NEGATIVE_INFINITY ? 0 : expSmall(x);
  // x = k ln 2 + r with |r| <= ln 2 / 2; e^r by its Taylor series, which falls below 1e-20 by degree 18.
  const k = Math.round(x / Math.LN2),
    r = x - k * LN2_HEAD - k * LN2_TAIL;
  let term = 1,
    sum = 1;
  for (let n = 1; n <= 18; n++) {
    term *= r / n;
    sum += term;
  }
  return sum * twoTo(k);
}
// Below e^-708 the result is subnormal: scale in two exact steps.
const expSmall = (x) => exp(x + 600 * Math.LN2) * twoTo(-600);
export function log(x) {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return x;
  // x = m 2^e with m in [sqrt(1/2), sqrt(2)); ln m = 2 atanh(s), s = (m - 1) / (m + 1), |s| < 0.172, whose odd series
  // falls below 1e-20 by degree 25.
  let scaled = x,
    e = 0;
  if (scaled < 2.2250738585072014e-308) {
    scaled *= twoTo(600);
    e = -600;
  }
  bits.setFloat64(0, scaled);
  const high = bits.getUint32(0);
  e += ((high >>> 20) & 0x7ff) - 1023;
  bits.setUint32(0, (high & 0x800fffff) | (1023 << 20));
  let m = bits.getFloat64(0);
  if (m >= Math.SQRT2) {
    m /= 2;
    e++;
  }
  const s = (m - 1) / (m + 1),
    s2 = s * s;
  let power = s,
    sum = s;
  for (let k = 3; k <= 25; k += 2) {
    power *= s2;
    sum += power / k;
  }
  return e * LN2_HEAD + (2 * sum + e * LN2_TAIL);
}
const exact = { sin, cos, tan, atan, atan2, asin, acos, exp, log, hypot };

/**
 * Runs `body` with the Math functions above in place of the engine's own, and puts them back when it returns or, for
 * a promise, settles. Tests in one file run one after another, so nothing else sees the swap.
 */
export function withExactMath(body) {
  const saved = {};
  for (const name of Object.keys(exact)) {
    saved[name] = Math[name];
    Math[name] = exact[name];
  }
  const restore = () => Object.assign(Math, saved);
  let result;
  try {
    result = body();
  } finally {
    if (!(result instanceof Promise)) restore();
  }
  return result instanceof Promise ? result.finally(restore) : result;
}
