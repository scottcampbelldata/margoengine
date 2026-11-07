// Constants and polynomial coefficients of the precise WGSL maths in packages/shared/precise-math.js, computed here
// from first principles (clean room: public algorithm descriptions only, no other library's tables):
//   - pi and 2/pi to 600 bits with BigInt (Machin's formula, pi = 16 atan(1/5) - 4 atan(1/239));
//   - the 2/pi bit table for the integer argument reduction of sin, cos and tan (M. Payne and R. Hanek, "Radian
//     reduction for trigonometric functions", SIGNUM Newsletter 18(1), 1983);
//   - the smallest reduced argument |x - k pi/2| over every finite f32 x (continued fractions of 2^e 2/pi), which
//     sets how many bits the reduction must keep;
//   - minimax polynomials (relative error) by Lawson's iteratively reweighted least squares on a dense grid
//     (C. L. Lawson, "Contributions to the theory of linear least maximum approximation", PhD thesis, UCLA, 1961),
//     rounded to f32.
// Usage: node scripts/precise-math-coefficients.mjs        prints the constants (paste into precise-math.js)
// tests/precise-math.test.js imports `derive()` and checks that the module's constants are exactly these.

const BITS = 600n;
const ONE = 1n << BITS;

/** atan(1/n) * 2^BITS by its Taylor series (n > 1). */
function atanInv(n) {
  const n2 = n * n;
  let term = ONE / n,
    sum = term,
    k = 1n,
    sign = -1n;
  while (term !== 0n) {
    term /= n2;
    const t = term / (2n * k + 1n);
    sum += sign * t;
    sign = -sign;
    k++;
  }
  return sum;
}

/** pi * 2^BITS (truncated). */
export const PI_FIXED = 16n * atanInv(5n) - 4n * atanInv(239n);

const f32 = Math.fround;
/** A BigInt fixed-point value (scale 2^-shift) as the nearest double. */
const toNumber = (v, shift) => {
  // Keep 64 significant bits, then scale.
  const neg = v < 0n;
  let a = neg ? -v : v,
    s = Number(shift);
  const extra = Math.max(0, a.toString(2).length - 64);
  a >>= BigInt(extra);
  s -= extra;
  return (neg ? -1 : 1) * Number(a) * 2 ** -s;
};
/** hi + lo f32 pair of value v (fixed point, scale 2^-shift): hi = f32(v), lo = f32(v - hi). */
const pair = (v, shift) => {
  const hi = f32(toNumber(v, shift));
  // hi exactly as fixed point.
  const hiFixed = BigInt(Math.round(hi * 2 ** 40)) << (BigInt(shift) - 40n);
  const lo = f32(toNumber(v - hiFixed, shift));
  return [hi, lo];
};
/** hi with only `bits` significant bits (so k * hi is exact for |k| < 2^(24 - bits)), lo the f32 remainder. */
const splitConstant = (v, shift, bits) => {
  const x = toNumber(v, shift),
    e = Math.floor(Math.log2(Math.abs(x))),
    q = 2 ** (e - bits + 1),
    hi = Math.floor(x / q) * q;
  const hiFixed = BigInt(hi * 2 ** 60) << (BigInt(shift) - 60n);
  return [hi, f32(toNumber(v - hiFixed, shift))];
};

/** The bits of 2/pi after the binary point, as eight u32 words preceded by one zero word (see the reduction). */
export function twoOverPiTable(words = 8) {
  // 2/pi * 2^(32 * (words - 1)) = (2 * 2^BITS / pi) * 2^(32 (words - 1)) / 2^BITS.
  const scaled = ((2n * ONE * ONE) / PI_FIXED) >> (BITS - 32n * BigInt(words - 1));
  const table = [0];
  for (let i = words - 2; i >= 0; i--) table.push(Number((scaled >> (32n * BigInt(i))) & 0xffffffffn));
  return table;
}

/**
 * The smallest |x - k pi/2| over finite f32 x >= pi/4 (k the nearest integer to x 2/pi), by exponent: for x = M 2^e
 * (2^23 <= M < 2^24) it is (pi/2) min ||M beta||, beta = 2^e 2/pi, bounded below by ||q beta|| for the last continued
 * fraction denominator q < 2^24 (best approximation property). Returns the minimum as a power of two.
 */
export function smallestReducedArgument() {
  const twoOverPi = (2n * ONE * ONE) / PI_FIXED; // 2/pi * 2^BITS
  let worst = Number.POSITIVE_INFINITY,
    at = 0;
  for (let e = -24; e <= 104; e++) {
    // beta mod 1 as a fraction num / den.
    const den = ONE << 200n;
    let num = e >= 0 ? (twoOverPi << BigInt(e + 200)) % den : (twoOverPi << 200n) >> BigInt(-e);
    num %= den;
    // Continued fraction of num / den; convergent denominators q_k.
    let [a, b] = [num, den],
      [q0, q1] = [0n, 1n],
      best = 1n;
    // beta = 0 + 1/(a1 + ...): swap to get the expansion of num/den (< 1).
    [a, b] = [b, a];
    while (b !== 0n) {
      const t = a / b;
      [a, b] = [b, a - t * b];
      const q2 = t * q1 + q0;
      if (q2 >= 1n << 24n) break;
      [q0, q1] = [q1, q2];
      best = q1;
    }
    // ||best * beta||: distance of best * num / den to the nearest integer.
    const prod = best * num,
      frac = prod % den,
      dist = frac * 2n > den ? den - frac : frac;
    const r = (Math.PI / 2) * toNumber(dist, 800n);
    if (r < worst) {
      worst = r;
      at = e;
    }
  }
  return { log2: Math.log2(worst), exponent: at };
}

/**
 * Least squares: the c minimising |X c - y| for X m x n (m >= n), by Householder QR of X with its columns scaled to unit
 * length. Not the normal equations X^T X c = X^T y: they square X's condition number, and for a monomial basis such as
 * atan's u^3 .. u^15 that made the result hang on the last bit of the host's Math.cos and Math.atan (a 1 ulp change
 * moved atan's leading coefficient across an f32 rounding midpoint, so macOS derived other constants than Windows).
 */
function leastSquares(X, y) {
  const m = X.length,
    n = X[0].length,
    scale = [];
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let i = 0; i < m; i++) sum += X[i][j] * X[i][j];
    scale.push(Math.sqrt(sum) || 1);
  }
  const R = X.map((row) => row.map((v, j) => v / scale[j])),
    b = [...y],
    v = new Array(m);
  for (let k = 0; k < n; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += R[i][k] * R[i][k];
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = R[k][k] > 0 ? -norm : norm;
    let length = 0;
    for (let i = k; i < m; i++) {
      v[i] = i === k ? R[k][k] - alpha : R[i][k];
      length += v[i] * v[i];
    }
    const reflect = (get, set) => {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i] * get(i);
      const f = (2 * dot) / length;
      for (let i = k; i < m; i++) set(i, get(i) - f * v[i]);
    };
    for (let j = k; j < n; j++)
      reflect(
        (i) => R[i][j],
        (i, value) => (R[i][j] = value),
      );
    reflect(
      (i) => b[i],
      (i, value) => (b[i] = value),
    );
  }
  const c = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= R[i][j] * c[j];
    c[i] = s / R[i][i];
  }
  return c.map((value, j) => value / scale[j]);
}

/** Relative error (2^-44, 512 f64 ulps) below which Lawson's reweighting stops: what is left is f64 rounding noise. */
const LAWSON_FLOOR = 2 ** -44;

/**
 * Minimax fit of f(x) ~ base(x) + sum c_j b_j(x) in relative error over [lo, hi] (Lawson's algorithm), then the
 * coefficients rounded to f32 one at a time from the leading one, refitting the rest each time so they absorb its
 * rounding. Returns the f32 coefficients and the max relative error of the f64 evaluation with them.
 */
function fit({ f, base, basis, lo, hi, points = 1500 }) {
  const xs = [];
  for (let i = 0; i < points; i++) {
    const t = Math.cos((Math.PI * (i + 0.5)) / points);
    xs.push(lo + ((hi - lo) * (t + 1)) / 2);
  }
  const rows = xs.filter((x) => f(x) !== 0).map((x) => ({ x, fx: f(x) }));
  const fixed = [];
  const lawson = (n) => {
    let w = rows.map(() => 1 / rows.length),
      c;
    for (let it = 0; it < 120; it++) {
      const X = [],
        y = [];
      for (let i = 0; i < rows.length; i++) {
        const { x, fx } = rows[i],
          bs = basis(x),
          root = Math.sqrt(w[i]);
        let target = (fx - base(x)) / fx;
        for (let j = 0; j < fixed.length; j++) target -= (fixed[j] * bs[j]) / fx;
        X.push(bs.slice(fixed.length).map((v) => (root * v) / fx));
        y.push(root * target);
      }
      c = leastSquares(X, y);
      const err = rows.map(({ x, fx }) => {
        const bs = basis(x);
        let v = base(x);
        for (let j = 0; j < bs.length; j++) v += (j < fixed.length ? fixed[j] : c[j - fixed.length]) * bs[j];
        return Math.abs((v - fx) / fx);
      });
      // At this error the fit is far past what f32 can hold, and the rest is rounding noise in f64: reweighting by it
      // piles every weight onto a few points until the system is singular (sinh did that).
      if (Math.max(...err) < LAWSON_FLOOR) break;
      const total = err.reduce((s, e, i) => s + w[i] * e, 0);
      w = w.map((wi, i) => (wi * err[i]) / total);
    }
    return c;
  };
  const count = basis(lo + (hi - lo) / 3).length;
  while (fixed.length < count) {
    const c = lawson(count - fixed.length);
    fixed.push(f32(c[0]));
  }
  let maxError = 0;
  for (const { x, fx } of rows) {
    const bs = basis(x);
    let v = base(x);
    for (let j = 0; j < bs.length; j++) v += fixed[j] * bs[j];
    maxError = Math.max(maxError, Math.abs((v - fx) / fx));
  }
  return { coefficients: fixed, log2Error: Math.log2(maxError) };
}

const powers = (x, from, n) => Array.from({ length: n }, (_, j) => x ** (from + j));

/**
 * What each polynomial fits: the function, the part kept exact (`base`), the basis of the f32 coefficients and the
 * range. Built on each call, so it reads Math.* as it is then (the derivation test nudges them).
 */
const polynomials = () => ({
  sin: {
    f: Math.sin,
    base: (r) => r,
    basis: (r) => powers(r * r, 0, 4).map((v) => v * r * r * r),
    lo: 1e-4,
    hi: Math.PI / 4 + 1e-6,
  },
  cos: {
    f: Math.cos,
    base: (r) => 1 - (r * r) / 2,
    basis: (r) => powers(r * r, 0, 4).map((v) => v * r ** 4),
    lo: 1e-4,
    hi: Math.PI / 4 + 1e-6,
  },
  atan: {
    f: Math.atan,
    base: (u) => u,
    basis: (u) => powers(u * u, 0, 7).map((v) => v * u ** 3),
    lo: 1e-4,
    hi: 0.5 + 1e-6,
  },
  asin: {
    f: Math.asin,
    base: (x) => x,
    basis: (x) => powers(x * x, 0, 7).map((v) => v * x ** 3),
    lo: 1e-4,
    hi: 0.5 + 1e-6,
  },
  sinh: {
    f: Math.sinh,
    base: (x) => x,
    basis: (x) => powers(x * x, 0, 6).map((v) => v * x ** 3),
    lo: 1e-4,
    hi: 1 + 1e-6,
  },
  cosh: {
    f: Math.cosh,
    base: (x) => 1 + (x * x) / 2,
    basis: (x) => powers(x * x, 0, 5).map((v) => v * x ** 4),
    lo: 1e-4,
    hi: 1 + 1e-6,
  },
  tanh: {
    f: Math.tanh,
    base: (x) => x,
    basis: (x) => powers(x * x, 0, 7).map((v) => v * x ** 3),
    lo: 1e-4,
    hi: 0.55 + 1e-6,
  },
  expm1: {
    f: Math.expm1,
    base: (r) => r,
    basis: (r) => powers(r, 2, 6),
    lo: -Math.LN2 / 2 - 1e-6,
    hi: Math.LN2 / 2 + 1e-6,
  },
  log: {
    f: (s) => 2 * Math.atanh(s),
    base: (s) => 2 * s,
    basis: (s) => powers(s * s, 1, 4).map((v) => v * s),
    lo: 1e-4,
    hi: (Math.SQRT2 - 1) / (Math.SQRT2 + 1) + 1e-6,
  },
});

/** The f32 coefficients of one polynomial (sin, cos, atan, asin, sinh, cosh, tanh, expm1 or log) and its error. */
export const fitPolynomial = (name) => fit(polynomials()[name]);

/** Every constant of the precise maths module. */
export function derive() {
  const shift = BITS;
  const half = PI_FIXED / 2n,
    quarter = PI_FIXED / 4n;
  // ln 2 and log2(e) to 600 bits: ln 2 = 2 atanh(1/3) = 2 sum 1 / ((2k+1) 3^(2k+1)).
  let term = ONE / 3n,
    ln2 = 0n;
  for (let k = 0n; term !== 0n; k++) {
    ln2 += term / (2n * k + 1n);
    term /= 9n;
  }
  ln2 *= 2n;
  const log2e = (ONE * ONE) / ln2;
  const [sin, cos, atan, asin, sinh, cosh, tanh, expm1, log] = [
    'sin',
    'cos',
    'atan',
    'asin',
    'sinh',
    'cosh',
    'tanh',
    'expm1',
    'log',
  ].map(fitPolynomial);
  return {
    twoOverPi: twoOverPiTable(),
    // round(pi/2 * 2^31): the reduced fraction times this, in fixed point.
    halfPiFixed: Number((half + (1n << (shift - 32n))) >> (shift - 31n)),
    halfPi: pair(half, shift),
    quarterPi: pair(quarter, shift),
    pi: pair(PI_FIXED, shift),
    // ln 2 with 16 significant bits (k ln2Hi exact for |k| < 256) and the rest.
    ln2: splitConstant(ln2, shift, 16),
    ln2Pair: pair(ln2, shift),
    log2e: pair(log2e, shift),
    sin,
    cos,
    atan,
    asin,
    sinh,
    cosh,
    tanh,
    expm1,
    log,
    reduction: smallestReducedArgument(),
  };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/').replace(/^\//, '')}`) {
  const d = derive();
  const hex = (n) => `0x${n.toString(16).padStart(8, '0')}u`;
  console.log(`twoOverPi: ${d.twoOverPi.map(hex).join(', ')}`);
  console.log(`halfPiFixed: ${d.halfPiFixed}u`);
  for (const k of ['halfPi', 'quarterPi', 'pi', 'ln2', 'ln2Pair', 'log2e']) console.log(`${k}: ${d[k].join(', ')}`);
  for (const k of ['sin', 'cos', 'atan', 'asin', 'sinh', 'cosh', 'tanh', 'expm1', 'log'])
    console.log(`${k}: [${d[k].coefficients.join(', ')}] (relative error 2^${d[k].log2Error.toFixed(1)})`);
  console.log(`smallest |x - k pi/2| over f32: 2^${d.reduction.log2.toFixed(2)} (exponent ${d.reduction.exponent})`);
}
