// The precise WGSL maths of packages/shared/precise-math.js, operation for operation in f32 (Math.fround after every
// step), for the host-side error bounds (tests/precise-math.test.js) and the GPU check that the shader computes the
// same values (packages/compute/tests/compute-precise-browser.js). Keep it in step with the WGSL: the GPU check
// compares the two element by element.
//   preciseReference()                         every operation rounded once, as WGSL evaluates it without fusing
//   preciseReference({ fused: true })          every a * b + c marked below rounded once (a fused multiply-add)
//   preciseReference({ divUlps, sqrtUlps })    the builtin a / b and sqrt off by that many ulp (WGSL allows 2.5 and
//                                              about 4.5), to show the results do not lean on them
import { PRECISE } from '../packages/shared/precise-math.js';

const F = Math.fround;
const buffer = new ArrayBuffer(4),
  f32 = new Float32Array(buffer),
  u32 = new Uint32Array(buffer);
export const bitsOf = (x) => {
  f32[0] = x;
  return u32[0];
};
export const fromBits = (u) => {
  u32[0] = u >>> 0;
  return f32[0];
};
const exponentOf = (x) => (bitsOf(x) >>> 23) & 0xff;
const NAN = Number.NaN;
/** x moved by n ulp of itself (towards +infinity for n > 0). */
const nudge = (x, n) => {
  if (n === 0 || !Number.isFinite(x) || x === 0) return x;
  let b = bitsOf(x);
  const up = n > 0 === x > 0;
  for (let i = 0; i < Math.abs(Math.trunc(n)); i++) b = up ? b + 1 : b - 1;
  return fromBits(b);
};

const C = PRECISE;
// Thresholds, as the f32 the WGSL literal rounds to.
const EXP_MAX = F(88.72284),
  EXP_MIN = F(-103.97208),
  HALF_LN2 = F(0.3465735),
  TANH_ONE = F(9.1),
  TANH_POLY = F(0.55),
  SQRT2 = F(1.4142135);
const ldexp = (x, n) => F(x * 2 ** n);
const clz = Math.clz32;

/** (hi, lo) words of m * v, m < 2^24. */
function mul24x32(m, v) {
  const ml = m & 0xfff,
    mh = m >>> 12,
    vl = v & 0xffff,
    vh = v >>> 16;
  const p0 = ml * vl,
    p1 = ml * vh,
    p2 = mh * vl,
    p3 = mh * vh;
  let lo = p0 >>> 0,
    hi = ((p1 >>> 16) + (p2 >>> 20) + (p3 >>> 4)) >>> 0,
    t = (lo + ((p1 << 16) >>> 0)) >>> 0;
  hi = (hi + (t < lo ? 1 : 0)) >>> 0;
  lo = t;
  t = (lo + ((p2 << 12) >>> 0)) >>> 0;
  hi = (hi + (t < lo ? 1 : 0)) >>> 0;
  lo = t;
  t = (lo + ((p3 << 28) >>> 0)) >>> 0;
  hi = (hi + (t < lo ? 1 : 0)) >>> 0;
  lo = t;
  return [hi, lo];
}
/** (hi, lo) words of a * b. */
function mul32(a, b) {
  const al = a & 0xffff,
    ah = a >>> 16,
    bl = b & 0xffff,
    bh = b >>> 16;
  const ll = al * bl,
    lh = al * bh,
    hl = ah * bl,
    hh = ah * bh;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  const lo = ((ll & 0xffff) | (mid << 16)) >>> 0;
  const hi = (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
  return [hi, lo];
}

/** |x| = k pi/2 + r for |x| > pi/4: r as hi + lo (signed) and k mod 4 (Payne-Hanek, in integers). */
export function reduceHalfPi(a) {
  const u = bitsOf(a),
    e = (u >>> 23) - 150,
    m = (u & 0x7fffff) | 0x800000,
    t = e + 30,
    w = t >>> 5,
    s = t & 31,
    T = C.twoOverPi,
    A = T[w],
    B = T[w + 1],
    Cw = T[w + 2],
    D = T[w + 3],
    r = 32 - s;
  const v0 = s === 0 ? A : ((A << s) | (B >>> r)) >>> 0,
    v1 = s === 0 ? B : ((B << s) | (Cw >>> r)) >>> 0,
    v2 = s === 0 ? Cw : ((Cw << s) | (D >>> r)) >>> 0;
  const P0 = mul24x32(m, v0),
    P1 = mul24x32(m, v1),
    P2 = mul24x32(m, v2);
  const p0 = P2[1],
    p1 = (P1[1] + P2[0]) >>> 0,
    c1 = p1 < P1[1] ? 1 : 0,
    p2 = (P0[1] + P1[0] + c1) >>> 0;
  let q = p2 >>> 30,
    hi = ((p2 << 2) | (p1 >>> 30)) >>> 0,
    lo = ((p1 << 2) | (p0 >>> 30)) >>> 0;
  const neg = hi >>> 31 === 1;
  if (neg) {
    q = q + 1;
    lo = (~lo + 1) >>> 0;
    hi = (~hi + (lo === 0 ? 1 : 0)) >>> 0;
  }
  const L = mul32(lo, C.halfPiFixed),
    H = mul32(hi, C.halfPiFixed),
    g1 = (H[1] + L[0]) >>> 0,
    g2 = (H[0] + (g1 < H[1] ? 1 : 0)) >>> 0;
  let n, top, low;
  if (g2 !== 0) {
    n = clz(g2);
    top = n === 0 ? g2 : ((g2 << n) | (g1 >>> (32 - n))) >>> 0;
    low = (g1 << n) >>> 0;
  } else {
    const z = clz(g1);
    n = 32 + z;
    top = z === 32 ? 0 : (g1 << z) >>> 0;
    low = 0;
  }
  const hi24 = top >>> 8,
    next = (((top & 0xff) << 16) | (low >>> 16)) >>> 0;
  const sign = neg ? -1 : 1;
  return { hi: sign * ldexp(hi24, -23 - n), lo: sign * ldexp(next, -47 - n), q: q & 3 };
}

export function preciseReference({ fused = false, divUlps = 0, sqrtUlps = 0 } = {}) {
  // a * b + c: one rounding when fused, two otherwise.
  const ma = fused ? (a, b, c) => F(a * b + c) : (a, b, c) => F(F(a * b) + c);
  const div = (a, b) => nudge(F(a / b), divUlps);
  const sqrt = (a) => nudge(F(Math.sqrt(a)), sqrtUlps);
  const split = (v) => {
    const h = fromBits(bitsOf(v) & 0xfffff000);
    return [h, F(v - h)];
  };

  // Division and square root to about half an ulp from the builtins (at most 2.5 and 4.5 ulp off): the residual of
  // each from exact products of 12-bit halves, then one correction.
  function preciseDiv(a, b) {
    const q = div(a, b);
    if (exponentOf(a) === 255 || exponentOf(b) === 255 || exponentOf(q) === 255 || exponentOf(q) === 0) return q;
    const p = F(q * b),
      r = F(F(a - p) - productError(q, b, p));
    return F(q + div(r, b));
  }
  /** sqrt(a) as [hi, lo]: hi the corrected root, lo what is left. */
  function sqrt2(a) {
    const s = sqrt(a);
    if (!(a > 0) || exponentOf(a) === 255 || exponentOf(s) === 0) return [s, 0];
    const p = F(s * s),
      r = F(F(a - p) - productError(s, s, p));
    const c = div(r, F(2 * s)),
      hi = F(s + c);
    return [hi, F(c - F(hi - s))];
  }
  const preciseSqrt = (a) => sqrt2(a)[0];

  const S = C.sin,
    Q = C.cos,
    At = C.atan,
    As = C.asin,
    E = C.expm1,
    Lg = C.log;
  function sinK(h, l) {
    const w = F(h * h);
    const p = ma(w, ma(w, ma(w, S[3], S[2]), S[1]), S[0]);
    return F(h + ma(l, F(1 - F(0.5 * w)), F(F(h * w) * p)));
  }
  function cosK(h, l) {
    const w = F(h * h),
      hw = F(0.5 * w),
      t = F(1 - hw);
    // h * h - w, exactly: what rounding w lost.
    const ew = productError(h, h, w);
    const p = ma(w, ma(w, ma(w, Q[3], Q[2]), Q[1]), Q[0]);
    const tail = F(F(F(F(1 - t) - hw) - F(0.5 * F(ew))) + F(F(F(w * w) * p) - F(h * l)));
    return F(t + tail);
  }
  /** [hi, lo, quadrant] of |x| for sin, cos and tan. */
  function reduce(a) {
    if (a <= 0.78125) return [a, 0, 0];
    const r = reduceHalfPi(a);
    return [r.hi, r.lo, r.q];
  }
  const negative = (x) => bitsOf(x) >>> 31 === 1;
  const withSign = (v, x) => (negative(x) ? -v : v);
  function sin(x) {
    const a = Math.abs(x);
    if (exponentOf(x) === 255) return NAN;
    if (a < 2 ** -12) return x;
    const [h, l, q] = reduce(a);
    const s = sinK(h, l),
      c = cosK(h, l),
      v = q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c;
    return withSign(v, x);
  }
  function cos(x) {
    const a = Math.abs(x);
    if (exponentOf(x) === 255) return NAN;
    if (a < 2 ** -12) return 1;
    const [h, l, q] = reduce(a);
    const s = sinK(h, l),
      c = cosK(h, l);
    return q === 0 ? c : q === 1 ? -s : q === 2 ? -c : s;
  }
  function tan(x) {
    const a = Math.abs(x);
    if (exponentOf(x) === 255) return NAN;
    if (a < 2 ** -12) return x;
    const [h, l, q] = reduce(a);
    const s = sinK(h, l),
      c = cosK(h, l),
      v = (q & 1) === 0 ? preciseDiv(s, c) : -preciseDiv(c, s);
    return withSign(v, x);
  }

  function atanK(u) {
    const w = F(u * u);
    const p = ma(w, ma(w, ma(w, ma(w, ma(w, ma(w, At[6], At[5]), At[4]), At[3]), At[2]), At[1]), At[0]);
    return F(u + F(F(u * w) * p));
  }
  const [PIO2_HI, PIO2_LO] = C.halfPi,
    [PIO4_HI, PIO4_LO] = C.quarterPi,
    [PI_HI, PI_LO] = C.pi;
  function atan(x) {
    const a = Math.abs(x);
    if (a !== a) return NAN;
    let r;
    if (a <= 0.5) r = atanK(a);
    else if (a <= 2) r = F(PIO4_HI + F(atanK(preciseDiv(F(a - 1), F(a + 1))) + PIO4_LO));
    else r = F(PIO2_HI + F(PIO2_LO - atanK(preciseDiv(1, a))));
    return withSign(r, x);
  }
  function atan2(y, x) {
    if (x !== x || y !== y) return NAN;
    let ax = Math.abs(x),
      ay = Math.abs(y);
    let t;
    if (exponentOf(ax) === 255 && exponentOf(ay) === 255) t = PIO4_HI;
    else {
      if (ax > 2 ** 125 || ay > 2 ** 125) {
        ax = F(ax * 0.25);
        ay = F(ay * 0.25);
      }
      const big = Math.max(ax, ay),
        small = Math.min(ax, ay);
      if (big === 0) t = 0;
      else if (small <= F(0.5 * big)) {
        const k = atanK(preciseDiv(small, big));
        t = ay > ax ? F(PIO2_HI + F(PIO2_LO - k)) : k;
      } else t = F(PIO4_HI + F(atanK(preciseDiv(F(ay - ax), F(ay + ax))) + PIO4_LO));
    }
    // x < 0 (or x = -0 with y = 0): the angle from the negative x axis. x = -0 with y != 0 stays +-pi/2.
    if (negative(x) && (x !== 0 || y === 0)) t = F(PI_HI + F(PI_LO - t));
    return withSign(t, y);
  }
  function asinK(x) {
    const w = F(x * x);
    const p = ma(w, ma(w, ma(w, ma(w, ma(w, ma(w, As[6], As[5]), As[4]), As[3]), As[2]), As[1]), As[0]);
    return F(F(x * w) * p);
  }
  /** asin(x) for |x| in [0.5, 1] as pi/2 - 2 asin(sqrt((1 - |x|) / 2)): returns 2 asin(s) as [s2hi, tail]. */
  function asinTail(a) {
    const z = F(0.5 * F(1 - a)),
      [s, sl] = sqrt2(z);
    return [F(2 * s), F(2 * F(sl + asinK(s)))];
  }
  function asin(x) {
    const a = Math.abs(x);
    if (!(a <= 1)) return NAN;
    if (a < 2 ** -12) return x;
    let r;
    if (a < 0.5) r = F(a + asinK(a));
    else {
      const [s2, tail] = asinTail(a);
      r = F(PIO2_HI - F(s2 - F(PIO2_LO - tail)));
    }
    return withSign(r, x);
  }
  function acos(x) {
    const a = Math.abs(x);
    if (!(a <= 1)) return NAN;
    if (a < 0.5) return F(PIO2_HI - F(x - F(PIO2_LO - asinK(x))));
    const [s2, tail] = asinTail(a);
    if (negative(x)) return F(PI_HI - F(s2 - F(PI_LO - tail)));
    return F(s2 + tail);
  }

  // e^r - 1 for |r| <= ln2 / 2.
  const expm1P = (r) => ma(r, ma(r, ma(r, ma(r, ma(r, E[5], E[4]), E[3]), E[2]), E[1]), E[0]);
  const expm1K = (r) => F(r + F(F(r * r) * expm1P(r)));
  const [LN2_HI, LN2_LO] = C.ln2,
    [LOG2E, LOG2E_LO] = C.log2e,
    [LN2, LN2_TAIL] = C.ln2Pair;
  /** [k, r, rHi, rLo]: x = k ln2 + r, |r| <= ln2 / 2, r = rHi + rLo rounded (Cody-Waite). */
  function reduceLn2(x) {
    const k = roundEven(F(x * LOG2E));
    // k ln2Hi is exact (16-bit constant, |k| < 256), and so is x - k ln2Hi.
    const hi = F(x - F(k * LN2_HI)),
      lo = F(-k * LN2_LO);
    return [k, F(hi + lo), hi, lo];
  }
  /** v * 2^k in two steps, so neither step leaves the normal range before the last. */
  const scale = (v, k) => {
    const h = Math.trunc(k / 2);
    return ldexp(ldexp(v, k - h), h);
  };
  function exp(x) {
    if (x !== x) return NAN;
    if (x > EXP_MAX) return Number.POSITIVE_INFINITY;
    if (x < EXP_MIN) return 0;
    if (Math.abs(x) < 2 ** -25) return F(1 + x);
    const [k, r] = reduceLn2(x);
    return scale(F(1 + expm1K(r)), k);
  }
  function exp2(x) {
    if (x !== x) return NAN;
    if (x >= 128) return Number.POSITIVE_INFINITY;
    if (x < -150) return 0;
    const k = roundEven(x),
      r = F(x - k);
    return scale(F(1 + expm1K(F(r * LN2))), k);
  }
  function expm1(x) {
    if (x !== x) return NAN;
    if (x > EXP_MAX) return Number.POSITIVE_INFINITY;
    const a = Math.abs(x);
    if (a < 2 ** -25) return x;
    if (a <= HALF_LN2) return expm1K(x);
    if (x < -17) return F(exp(x) - 1);
    const [k, r, rh, rl] = reduceLn2(x);
    if (k > 24) return F(exp(x) - 1);
    // 2^k (1 + r + T) - 1, T = expm1(r) - r and 2^k - 1 exact for |k| <= 24: for k > 0 as
    // ((2^k - 1) + 2^k rHi) + 2^k (rLo + T), the first sum exact; for k < 0 as (2^k - 1) + 2^k expm1(r).
    const T = F(F(r * r) * expm1P(r)),
      p = F(2 ** k);
    if (k > 0) return F(F(F(p - 1) + F(p * rh)) + F(p * F(rl + T)));
    return F(F(p * F(rh + F(rl + T))) + F(p - 1));
  }
  /** x + x^3 P(x^2), |x| <= 1 (or 0.55 for tanh): the odd series fitted directly. */
  const oddK = (x, c) => {
    const w = F(x * x);
    let p = c[c.length - 1];
    for (let i = c.length - 2; i >= 0; i--) p = ma(w, p, c[i]);
    return F(x + F(F(x * w) * p));
  };
  function sinh(x) {
    const a = Math.abs(x);
    if (a !== a) return NAN;
    if (a < 2 ** -12) return x;
    let r;
    if (a <= 1) r = oddK(a, C.sinh);
    else if (a > EXP_MAX) {
      const t = exp(F(0.5 * a));
      r = F(F(0.5 * t) * t);
    } else if (a > 9) r = F(0.5 * exp(a));
    else {
      const e = expm1(a);
      r = F(0.5 * F(e + preciseDiv(e, F(e + 1))));
    }
    return withSign(r, x);
  }
  function cosh(x) {
    const a = Math.abs(x);
    if (a !== a) return NAN;
    if (a < 2 ** -12) return 1;
    if (a <= 1) {
      const w = F(a * a),
        Ch = C.cosh;
      let p = Ch[Ch.length - 1];
      for (let i = Ch.length - 2; i >= 0; i--) p = ma(w, p, Ch[i]);
      return F(1 + ma(F(w * w), p, F(0.5 * w)));
    }
    if (a > EXP_MAX) {
      const t = exp(F(0.5 * a));
      return F(F(0.5 * t) * t);
    }
    const t = exp(a);
    return F(0.5 * F(t + preciseDiv(1, t)));
  }
  function tanh(x) {
    const a = Math.abs(x);
    if (a !== a) return NAN;
    if (a < 2 ** -12) return x;
    if (a > TANH_ONE) return withSign(1, x);
    if (a <= TANH_POLY) return withSign(oddK(a, C.tanh), x);
    const e = expm1(F(2 * a));
    return withSign(preciseDiv(e, F(e + 2)), x);
  }

  /** log(1 + f) for f = m - 1, m in [sqrt(1/2), sqrt(2)]: [f - hfsq, s (hfsq + R)] pieces and the total. */
  function logK(f) {
    const s = preciseDiv(f, F(2 + f)),
      z = F(s * s),
      R = F(z * ma(z, ma(z, ma(z, Lg[3], Lg[2]), Lg[1]), Lg[0])),
      hfsq = F(F(0.5 * f) * f);
    return { f, s, R, hfsq, t: F(s * F(hfsq + R)) };
  }
  /** x = 2^e m, m in [sqrt(1/2), sqrt(2)): [e, m - 1] from the bits (subnormal x normalised in integers). */
  function decompose(x) {
    let u = bitsOf(x),
      e = (u >>> 23) - 127;
    if (e === -127) {
      const z = clz(u) - 8; // shift that brings the leading mantissa bit to bit 23
      u = (u << z) >>> 0;
      e = -126 - z;
    }
    let m = fromBits((u & 0x7fffff) | 0x3f800000);
    if (m > SQRT2) {
      m = F(0.5 * m);
      e += 1;
    }
    return [e, F(m - 1)];
  }
  function logSpecial(x) {
    if (x !== x || x < 0) return NAN;
    if (x === 0) return Number.NEGATIVE_INFINITY;
    if (x === Number.POSITIVE_INFINITY) return x;
    return undefined;
  }
  function log(x) {
    const special = logSpecial(x);
    if (special !== undefined) return special;
    const [e, f] = decompose(x),
      { hfsq, t } = logK(f);
    return F(F(e * LN2_HI) + F(f - F(hfsq - F(t + F(e * LN2_LO)))));
  }
  function log2(x) {
    const special = logSpecial(x);
    if (special !== undefined) return special;
    const [e, f] = decompose(x),
      { hfsq, t } = logK(f);
    // f log2(e) exactly as ah + al (f is exact; the products of 12-bit halves are exact).
    const [fh, fl] = split(f),
      [Lh, Ll] = split(LOG2E),
      ah = F(f * LOG2E),
      al = F(F(F(F(F(fh * Lh) - ah) + F(fh * Ll)) + F(fl * Lh)) + F(fl * Ll));
    const tail = F(F(al + F(f * LOG2E_LO)) - F(F(hfsq - t) * LOG2E));
    return F(F(e + ah) + tail);
  }
  function log1p(x) {
    if (x !== x || x < -1) return NAN;
    if (x === -1) return Number.NEGATIVE_INFINITY;
    if (x === Number.POSITIVE_INFINITY) return x;
    const u = F(1 + x);
    if (u === 1) return x;
    // u = 1 + x - c exactly (Fast2Sum, the larger of 1 and |x| first).
    const c = Math.abs(x) <= 1 ? F(x - F(u - 1)) : F(1 - F(u - x));
    return F(log(u) + preciseDiv(c, u));
  }
  /** a * b - fl(a * b), exactly (the four products of 12-bit halves are exact). */
  function productError(a, b, p) {
    const [ah, al] = split(a),
      [bh, bl] = split(b);
    return F(F(F(F(F(ah * bh) - p) + F(ah * bl)) + F(al * bh)) + F(al * bl));
  }
  /** s + e = a + b exactly (Knuth's TwoSum: additions only). */
  function twoSum(a, b) {
    const s = F(a + b),
      bb = F(s - a);
    return [s, F(F(a - F(s - bb)) + F(b - bb))];
  }
  /** log2(x), x > 0 finite, as hi + lo to about 2^-30 relative: pow's exponent needs it. */
  function log2Pair(x) {
    const [e, f] = decompose(x),
      { s } = logK(f);
    const q = F(f * f),
      hh = F(0.5 * q),
      hl = F(0.5 * productError(f, f, q)); // hfsq = hh + hl exactly
    // s = f / (2 + f) as s + sl: 2 + f = dh + dl exactly, then the residual of s against dh.
    const dh = F(2 + f),
      dl = F(f - F(dh - 2)),
      sd = F(s * dh),
      rho = F(F(f - sd) - productError(s, dh, sd)),
      sl = div(F(rho - F(s * dl)), dh);
    // t = s (hfsq + R) = s hh (exact pair) + s R (a pair too, from the series of R) + the small rest.
    const th = F(s * hh),
      z = F(s * s),
      zl = F(productError(s, s, z) + F(F(2 * s) * sl));
    let poly = F(2 / 15);
    for (const c of [2 / 13, 2 / 11, 2 / 9, 2 / 7, 2 / 5]) poly = ma(z, poly, F(c));
    const third = F(2 / 3),
      [wh, wl] = twoSum(third, ma(z, poly, F(2 / 3 - third))),
      rh = F(z * wh),
      rl = F(F(productError(z, wh, rh) + F(z * wl)) + F(zl * wh)),
      uh = F(s * rh),
      [ux, uy] = twoSum(th, uh),
      tl = F(
        F(F(F(productError(s, hh, th) + F(s * hl)) + F(sl * hh)) + F(F(productError(s, rh, uh) + F(s * rl)) + F(sl * rh))) + uy,
      );
    // log2(x) = e + log2(e) (f - hfsq + t), each product with log2(e) as an exact pair plus the small rest.
    const ah = F(f * LOG2E),
      al = productError(f, LOG2E, ah),
      bh = F(hh * LOG2E),
      bl = productError(hh, LOG2E, bh),
      ch = F(ux * LOG2E),
      cl = productError(ux, LOG2E, ch);
    const [s1, e1] = twoSum(e, ah),
      [s2, e2] = twoSum(s1, -bh),
      [s3, e3] = twoSum(s2, ch);
    const small = F(F(F(f - hh) + ux) * LOG2E_LO),
      tail = F(F(F(F(e1 + e2) + e3) + F(F(al - bl) + cl)) + F(F(F(tl - hl) * LOG2E) + small));
    const hi = F(s3 + tail);
    return [hi, F(tail - F(hi - s3))];
  }
  const isInteger = (y) => Math.floor(y) === y;
  const isOdd = (y) => Math.abs(y) < 16777216 && isInteger(y) && (Math.trunc(y) & 1) === 1;
  /** x^y with Math.pow's special cases. */
  function pow(x, y) {
    if (y !== y) return NAN;
    if (y === 0) return 1;
    if (x !== x) return NAN;
    const ax = Math.abs(x),
      ay = Math.abs(y),
      INF = Number.POSITIVE_INFINITY;
    if (ay === INF) return ax === 1 ? NAN : ax > 1 === y > 0 ? INF : 0;
    const odd = isOdd(y),
      sign = negative(x) && odd ? -1 : 1;
    if (ax === INF) return sign * (y > 0 ? INF : 0);
    if (ax === 0) return sign * (y > 0 ? 0 : INF);
    if (x < 0 && !isInteger(y)) return NAN;
    const [Lh, Ll] = log2Pair(ax);
    const ph = F(y * Lh),
      pl = F(productError(y, Lh, ph) + F(y * Ll));
    if (ph > 128 || (ph === 128 && pl >= 0)) return sign * INF;
    if (ph < -151) return sign * 0;
    const k = roundEven(ph),
      f = F(F(ph - k) + pl);
    // 2^f = e^(f ln2), f ln2 = r + rl to about 2^-40.
    const r = F(f * LN2),
      rl = F(productError(f, LN2, r) + F(f * LN2_TAIL));
    return sign * scale(F(1 + F(expm1K(r) + rl)), k);
  }
  return {
    sin,
    cos,
    tan,
    asin,
    acos,
    atan,
    atan2,
    exp,
    exp2,
    expm1,
    log,
    log2,
    log1p,
    sinh,
    cosh,
    tanh,
    pow,
    preciseDiv,
    preciseSqrt,
    log2Pair,
  };
}

/** The f32 ulp at |v| (v exact): what the error bounds count in. */
export const ulpOf = (v) => {
  const a = Math.abs(v);
  return a < 2 ** -126 ? 2 ** -149 : 2 ** (Math.floor(Math.log2(a)) - 23);
};

/**
 * Dense input sets per function (n points each, deterministic), the exact value (double precision), and the bound
 * in ulp of the exact value. The host test and the GPU check both use these.
 */
export function preciseCases(n) {
  const lin = (lo, hi) => Array.from({ length: n }, (_, i) => F(lo + ((hi - lo) * i) / (n - 1)));
  const logs = (lo, hi) => Array.from({ length: n }, (_, i) => F(lo * (hi / lo) ** (i / (n - 1))));
  const sym = (lo, hi) => logs(lo, hi).map((v, i) => (i & 1 ? -v : v));
  let s = 7;
  const random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const pairs = (make) => {
    const a = [],
      b = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = make();
      a.push(F(x));
      b.push(F(y));
    }
    return [a, b];
  };
  const one = (ref, bound, ...sets) => ({ ref, bound, sets: sets.map((x) => [x]) });
  // n / 128 random f32 per binade from 2^-12 to 2^127 (both signs): every exponent the pi/2 reduction handles, with mantissas
  // dense enough that a kernel rounding 1 ulp off for a few percent of reduced arguments shows (bug 29).
  const binades = (seed) => {
    const out = [];
    for (let e = 115, k = 0; e <= 254; e++)
      for (let i = 0; i < Math.ceil(n / 128); i++, k++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        out.push(fromBits(((k & 1) << 31) | (e << 23) | (seed >>> 9)));
      }
    return out;
  };
  return {
    sin: one(Math.sin, 1, lin(-4, 4), lin(-1e4, 1e4), sym(1e-8, 3e38), binades(11)),
    cos: one(Math.cos, 1, lin(-4, 4), lin(-1e4, 1e4), sym(1e-8, 3e38), binades(12)),
    tan: one(Math.tan, 2.5, lin(-1.6, 1.6), sym(1e-8, 3e38), binades(13)),
    asin: one(Math.asin, 1.5, lin(-1, 1), sym(1e-10, 1)),
    acos: one(Math.acos, 1, lin(-1, 1), sym(1e-10, 1)),
    atan: one(Math.atan, 2, lin(-4, 4), sym(1e-10, 3e38)),
    atan2: {
      ref: Math.atan2,
      bound: 2,
      sets: [
        pairs(() => [(random() * 2 - 1) * 10 ** (random() * 8 - 4), (random() * 2 - 1) * 10 ** (random() * 8 - 4)]),
        pairs(() => [random() * 2 - 1, random() * 2 - 1]),
      ],
    },
    exp: one(Math.exp, 1, lin(-87, 88.7), lin(-1, 1)),
    exp2: one((x) => 2 ** x, 1, lin(-125, 127.9), lin(-1, 1)),
    expm1: one(Math.expm1, 2, lin(-20, 88.7), sym(1e-10, 1)),
    log: one(Math.log, 1, logs(1e-38, 3e38), lin(0.5, 2)),
    log2: one(Math.log2, 1.5, logs(1e-38, 3e38), lin(0.5, 2)),
    log1p: one(Math.log1p, 2, sym(1e-10, 0.999), logs(1e-10, 3e38)),
    sinh: one(Math.sinh, 2, lin(-89, 89), sym(1e-10, 1)),
    cosh: one(Math.cosh, 2, lin(-89, 89)),
    tanh: one(Math.tanh, 2, lin(-10, 10), sym(1e-10, 1)),
    pow: {
      ref: (x, y) => x ** y,
      // 2 ulp while |y log2 x| < 16; up to 5 as the result nears the ends of the f32 range.
      bound: (x, y) => (Math.abs(y * Math.log2(Math.abs(x))) < 16 ? 2 : 5),
      sets: [
        pairs(() => [10 ** (random() * 8 - 4), (random() * 2 - 1) * 10 ** (random() * 3)]),
        pairs(() => [0.7 + random() * 0.72, (random() * 2 - 1) * 400]),
        pairs(() => [-random() * 10, Math.round(random() * 20 - 10)]),
        // Extreme exponents: x within 2^-23 to 1/2 of 1 and |y| up to 2^30, where log2 x must be good to 2^-30.
        pairs(() => [1 + (random() * 2 - 1) * 2 ** -(1 + random() * 22), (random() * 2 - 1) * 2 ** (random() * 30)]),
      ],
    },
  };
}

/**
 * Worst error of `fn` (an f32 function) over a case's sets, in ulp of the exact value and as a fraction of the
 * bound: { ulp, ratio, at }. Exact values that overflow f32, or are subnormal (a GPU may flush them), are skipped.
 */
export function worstError(fn, { ref, bound, sets }) {
  let ulp = 0,
    ratio = 0,
    at = null,
    k = -1;
  for (const set of sets)
    for (let i = 0; i < set[0].length; i++) {
      k++;
      const args = set.map((column) => column[i]),
        want = ref(...args);
      if (!Number.isFinite(want) || Math.abs(want) >= 2 ** 128 || Math.abs(want) < 2 ** -126) continue;
      // fn also gets the element's position in all the sets, for results computed elsewhere (the GPU).
      const got = fn(...args, k),
        u = Number.isNaN(got) ? Number.POSITIVE_INFINITY : Math.abs(got - want) / ulpOf(want),
        b = typeof bound === 'function' ? bound(...args) : bound;
      if (u / b > ratio) {
        ratio = u / b;
        ulp = u;
        at = { args, got, want, bound: b };
      }
    }
  return { ulp, ratio, at };
}

/** Round half to even, as WGSL round. */
export function roundEven(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
