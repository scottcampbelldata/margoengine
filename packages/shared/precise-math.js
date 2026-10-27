// Precise f32 elementary functions in WGSL, the same on every GPU. WGSL lets the builtins be far off: sin and cos 2^-11
// absolute inside [-pi, pi] and unbounded outside, atan and atan2 4096 ulp, asin and acos 6.8e-5 absolute, exp
// 3 + 2|x| ulp, log 2^-21 absolute near 1, pow unbounded and undefined for x < 0. Measured: an RTX A6000 (Dawn, D3D12)
// is within 3e-7 for sin and cos in [-pi, pi] but 1e-5 at |x| near 100, 133 ulp for tanh and 114 for pow; an Intel Arc
// 140V is 1.1e-5 off for sin and cos near 1.5. Code that compares the GPU with the CPU, or one GPU with another, uses
// these instead. Each is within 2 ulp of the exact value: sin, cos, acos, exp, exp2 and log within 1, asin and log2
// 1.5, tan 2.5, pow 2 while |y log2 x| < 16 and 5 beyond (the bounds are shown over dense inputs, with fused and
// unfused rounding and with the builtin division and sqrt at WGSL's limits, by tests/precise-math.test.js, and on the
// GPU by packages/compute/tests/compute-precise-browser.js).
//
// Written clean room from public algorithm descriptions:
//   - argument reduction by pi/2 in integers with a 2/pi bit table (M. Payne and R. Hanek, "Radian reduction for
//     trigonometric functions", SIGNUM Newsletter 18(1), 1983), so it is exact for every f32, including huge ones;
//   - Cody-Waite reduction by ln 2 and the identities of W. J. Cody and W. Waite, "Software Manual for the Elementary
//     Functions", Prentice-Hall, 1980 (asin and acos through sqrt((1 - x) / 2), log through s = f / (2 + f), atan
//     through (x - 1) / (x + 1) and 1 / x);
//   - exact products from 12-bit halves (the halves of each operand cut from its bits, so no fused multiply-add can
//     change them) to correct the builtin division and square root to about half an ulp (T. J. Dekker, "A
//     floating-point technique for extending the available precision", Numerische Mathematik 18, 1971);
//   - polynomial coefficients computed by scripts/precise-math-coefficients.mjs (minimax in relative error), which
//     also derives every constant here from pi, ln 2 and 2/pi computed to 600 bits.
// Only exactly rounded WGSL operations are relied on (+, -, *, comparisons, integer and bit operations, ldexp, floor,
// round); a fused multiply-add anywhere is allowed. The builtin division and sqrt are used only where their error is
// corrected or scaled away. Infinities and NaN follow Math.* where the GPU keeps them (WGSL may assume there are none).

/** The constants of the WGSL below, for the host reference (tests/precise-math-reference.js). */
export const PRECISE = /* @__PURE__ */ Object.freeze({
  /** A zero word, then the bits of 2/pi after the binary point. */
  twoOverPi: [0x00000000, 0xa2f9836e, 0x4e441529, 0xfc2757d1, 0xf534ddc0, 0xdb629599, 0x3c439041, 0xfe5163ab],
  /** round(pi/2 * 2^31). */
  halfPiFixed: 3373259426,
  halfPi: [1.5707963705062866, -4.371138828673793e-8],
  quarterPi: [0.7853981852531433, -2.1855694143368964e-8],
  pi: [3.1415927410125732, -8.742277657347586e-8],
  /** ln 2 with 16 significant bits, and the rest. */
  ln2: [0.693145751953125, 0.000001428606765330187],
  /** f32(ln 2) and the rest. */
  ln2Pair: [0.6931471824645996, -1.9046542121259336e-9],
  log2e: [1.4426950216293335, 1.925963033500011e-8],
  sin: [-0.1666666716337204, 0.008333379402756691, -0.00019853089179378003, 0.000002833021881087916],
  cos: [0.0416666679084301, -0.0013888980029150844, 0.00002482202216924634, -2.8881245839329495e-7],
  atan: [
    -0.3333333432674408, 0.20000059902668, -0.14286741614341736, 0.11114691942930222, -0.09025663882493973,
    0.06947030127048492, -0.03550770878791809,
  ],
  asin: [
    0.1666666716337204, 0.07499949634075165, 0.044659871608018875, 0.03011295571923256, 0.024605773389339447,
    0.007497195154428482, 0.03466988354921341,
  ],
  sinh: [
    0.1666666716337204, 0.00833326205611229, 0.00019874409190379083, 0.0000020846018742304295, 6.411173671949655e-7,
    -2.0997923400045693e-7,
  ],
  cosh: [
    0.0416666679084301, 0.0013888796092942357, 0.00002482521813362837, 2.506288865333772e-7, 1.1460320692435744e-8,
  ],
  tanh: [
    -0.3333333432674408, 0.1333339661359787, -0.05398159474134445, 0.021997952833771706, -0.009480519220232964,
    0.004997917450964451, -0.0024830466136336327,
  ],
  expm1: [
    0.5, 0.1666666567325592, 0.04166649281978607, 0.008333546109497547, 0.0013932319125160575, 0.00019761594012379646,
  ],
  log: [0.6666666269302368, 0.40000975131988525, 0.28498485684394836, 0.24286234378814697],
});

const P = PRECISE;
/** The shortest WGSL literal whose nearest f32 is exactly v (an f32 value). */
const lit = (v) => {
  let s = String(v);
  for (let digits = 1; digits <= 9; digits++) {
    const short = v.toPrecision(digits);
    if (Math.fround(Number(short)) === v) {
      s = short;
      break;
    }
  }
  return /[.e]/.test(s) ? s : `${s}.0`;
};
/** Horner's rule for c[0] + w c[1] + ... in the nesting the host reference rounds. */
const horner = (w, c) => {
  let s = lit(c[c.length - 1]);
  for (let i = c.length - 2; i >= 0; i--) s = `(${w} * ${s} + ${lit(c[i])})`;
  return s;
};
const hex = (v) => `0x${v.toString(16)}u`;

// Each piece: the names it needs and its WGSL. Helpers are `pm*`; the public functions `precise*`.
// Built on first use, so importing this module runs nothing (bundlers can drop it where it is not called).
let built;
const pieces = () =>
  (built ??= {
    pmBits: [
      [],
      `fn pmExponent(x: f32) -> u32 { return (bitcast<u32>(x) >> 23u) & 0xffu; }
fn pmNegative(x: f32) -> bool { return (bitcast<u32>(x) >> 31u) == 1u; }
fn pmIsNan(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u; }
fn pmIsZero(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) == 0u; }
fn pmNan(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) | 0x7fc00000u); }
fn pmInfinity(negative: bool, x: f32) -> f32 { return bitcast<f32>((bitcast<u32>(x) & 0u) | select(0x7f800000u, 0xff800000u, negative)); }
fn pmWithSign(v: f32, x: f32) -> f32 { return select(v, -v, pmNegative(x)); }
fn pmSplit(v: f32) -> vec2f { let h = bitcast<f32>(bitcast<u32>(v) & 0xfffff000u); return vec2f(h, v - h); }
const PM_PIO2_HI: f32 = ${lit(P.halfPi[0])};
const PM_PIO2_LO: f32 = ${lit(P.halfPi[1])};
const PM_PIO4_HI: f32 = ${lit(P.quarterPi[0])};
const PM_PIO4_LO: f32 = ${lit(P.quarterPi[1])};
const PM_PI_HI: f32 = ${lit(P.pi[0])};
const PM_PI_LO: f32 = ${lit(P.pi[1])};
const PM_LN2_HI: f32 = ${lit(P.ln2[0])};
const PM_LN2_LO: f32 = ${lit(P.ln2[1])};
const PM_LN2: f32 = ${lit(P.ln2Pair[0])};
const PM_LN2_TAIL: f32 = ${lit(P.ln2Pair[1])};
const PM_LOG2E: f32 = ${lit(P.log2e[0])};
const PM_LOG2E_LO: f32 = ${lit(P.log2e[1])};
`,
    ],
    // a / b to about half an ulp: the residual a - q b from exact products of 12-bit halves, then one correction.
    preciseDiv: [
      ['pmBits'],
      `fn preciseDiv(a: f32, b: f32) -> f32 {
 let q = a / b;
 if (pmExponent(a) == 255u || pmExponent(b) == 255u || pmExponent(q) == 255u || pmExponent(q) == 0u) { return q; }
 let qs = pmSplit(q);
 let bs = pmSplit(b);
 let r = (((a - qs.x * bs.x) - qs.x * bs.y) - qs.y * bs.x) - qs.y * bs.y;
 return q + r / b;
}
`,
    ],
    // sqrt(a) as hi + lo, hi to about half an ulp (the residual a - s s from exact products, then one correction).
    preciseSqrt: [
      ['pmBits'],
      `fn pmSqrt2(a: f32) -> vec2f {
 let s = sqrt(a);
 if (a <= 0.0 || pmIsNan(a) || pmExponent(a) == 255u || pmExponent(s) == 0u) { return vec2f(s, 0.0); }
 let h = pmSplit(s);
 let r = ((a - h.x * h.x) - (2.0 * h.x) * h.y) - h.y * h.y;
 let c = r / (2.0 * s);
 let hi = s + c;
 return vec2f(hi, c - (hi - s));
}
fn preciseSqrt(a: f32) -> f32 { return pmSqrt2(a).x; }
`,
    ],
    // (hi, lo) words of m v, m < 2^24.
    // (hi, lo) words of a b.
    // a = k pi/2 + r for finite a > pi/4 (Payne-Hanek, all in integers): r = hi + lo (signed), k mod 4.
    // 96 bits of 2/pi from bit e - 1 on: the bits before it only add multiples of 4 to a 2/pi.
    // Bits 95..94 are k mod 4, bits 93..30 the fraction: rounded to the nearest k, the fraction in [-1/2, 1/2).
    // |fraction| times round(pi/2 2^31): the top 64 bits are r 2^63.
    pmReduce: [
      ['pmBits'],
      `fn pmTwoOverPi(i: u32) -> u32 {
 switch i {
${P.twoOverPi.map((w, i) => `    case ${i}u: { return ${hex(w)}; }`).join('\n')}
  default: { return 0u; }
 }
}
fn pmMul24x32(m: u32, v: u32) -> vec2u {
 let ml = m & 0xfffu; let mh = m >> 12u; let vl = v & 0xffffu; let vh = v >> 16u;
 let p0 = ml * vl; let p1 = ml * vh; let p2 = mh * vl; let p3 = mh * vh;
 var lo = p0;
 var hi = (p1 >> 16u) + (p2 >> 20u) + (p3 >> 4u);
 var t = lo + (p1 << 16u); hi = hi + select(0u, 1u, t < lo); lo = t;
 t = lo + (p2 << 12u); hi = hi + select(0u, 1u, t < lo); lo = t;
 t = lo + (p3 << 28u); hi = hi + select(0u, 1u, t < lo); lo = t;
 return vec2u(hi, lo);
}
fn pmMul32(a: u32, b: u32) -> vec2u {
 let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u;
 let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
 let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu);
 return vec2u(hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u), (ll & 0xffffu) | (mid << 16u));
}
struct PmReduced { hi: f32, lo: f32, q: u32 }
fn pmReduce(a: f32) -> PmReduced {
 let u = bitcast<u32>(a);
 let e = i32(u >> 23u) - 150;
 let m = (u & 0x7fffffu) | 0x800000u;
 let t = u32(e + 30);
 let w = t >> 5u; let s = t & 31u; let r = 32u - s;
 let A = pmTwoOverPi(w); let B = pmTwoOverPi(w + 1u); let C = pmTwoOverPi(w + 2u); let D = pmTwoOverPi(w + 3u);
 let v0 = select((A << s) | (B >> r), A, s == 0u);
 let v1 = select((B << s) | (C >> r), B, s == 0u);
 let v2 = select((C << s) | (D >> r), C, s == 0u);
 let P0 = pmMul24x32(m, v0); let P1 = pmMul24x32(m, v1); let P2 = pmMul24x32(m, v2);
 let p0 = P2.y;
 let p1 = P1.y + P2.x;
 let p2 = P0.y + P1.x + select(0u, 1u, p1 < P1.y);
 var q = p2 >> 30u;
 var hi = (p2 << 2u) | (p1 >> 30u);
 var lo = (p1 << 2u) | (p0 >> 30u);
 let neg = (hi >> 31u) == 1u;
 if (neg) { q = q + 1u; lo = ~lo + 1u; hi = ~hi + select(0u, 1u, lo == 0u); }
 let L = pmMul32(lo, ${P.halfPiFixed}u); let H = pmMul32(hi, ${P.halfPiFixed}u);
 let g1 = H.y + L.x;
 let g2 = H.x + select(0u, 1u, g1 < H.y);
 var n: u32; var top: u32; var low: u32;
 if (g2 != 0u) {
  n = countLeadingZeros(g2);
  top = select((g2 << n) | (g1 >> (32u - n)), g2, n == 0u);
  low = g1 << n;
 } else {
  let z = countLeadingZeros(g1);
  n = 32u + z;
  top = select(g1 << z, 0u, z == 32u);
  low = 0u;
 }
 let hi24 = top >> 8u;
 let next = ((top & 0xffu) << 16u) | (low >> 16u);
 let sign = select(1.0, -1.0, neg);
 return PmReduced(sign * ldexp(f32(hi24), -23 - i32(n)), sign * ldexp(f32(next), -47 - i32(n)), q & 3u);
}
`,
    ],
    // sin and cos of r = h + l, |r| <= pi/4 (minimax polynomials).
    pmTrig: [
      ['pmReduce', 'pmBits'],
      `fn pmSinK(h: f32, l: f32) -> f32 {
 let w = h * h;
 let p = ${horner('w', P.sin)};
 return h + (l * (1.0 - 0.5 * w) + (h * w) * p);
}
fn pmCosK(h: f32, l: f32) -> f32 {
 let w = h * h; let hw = 0.5 * w; let t = 1.0 - hw;
 let s = pmSplit(h);
 let ew = ((s.x * s.x - w) + (2.0 * s.x) * s.y) + s.y * s.y;
 let p = ${horner('w', P.cos)};
 return t + ((((1.0 - t) - hw) - 0.5 * ew) + ((w * w) * p - h * l));
}
fn pmReduceTrig(a: f32) -> PmReduced {
 if (a <= 0.78125) { return PmReduced(a, 0.0, 0u); }
 return pmReduce(a);
}
`,
    ],
    preciseSin: [
      ['pmTrig'],
      `fn preciseSin(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 let v = select(select(select(-c, -s, r.q == 2u), c, r.q == 1u), s, r.q == 0u);
 return pmWithSign(v, x);
}
`,
    ],
    preciseCos: [
      ['pmTrig'],
      `fn preciseCos(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return 1.0; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 return select(select(select(s, -c, r.q == 2u), -s, r.q == 1u), c, r.q == 0u);
}
`,
    ],
    preciseTan: [
      ['pmTrig', 'preciseDiv'],
      `fn preciseTan(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 var v: f32;
 if ((r.q & 1u) == 0u) { v = preciseDiv(s, c); } else { v = -preciseDiv(c, s); }
 return pmWithSign(v, x);
}
`,
    ],
    // atan(u), |u| <= 1/2.
    pmAtanK: [
      ['pmBits'],
      `fn pmAtanK(u: f32) -> f32 {
 let w = u * u;
 let p = ${horner('w', P.atan)};
 return (u * w) * p + u;
}
`,
    ],
    preciseAtan: [
      ['pmAtanK', 'preciseDiv'],
      `fn preciseAtan(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 var r: f32;
 if (a <= 0.5) { r = pmAtanK(a); }
 else if (a <= 2.0) { r = PM_PIO4_HI + (pmAtanK(preciseDiv(a - 1.0, a + 1.0)) + PM_PIO4_LO); }
 else { r = PM_PIO2_HI + (PM_PIO2_LO - pmAtanK(preciseDiv(1.0, a))); }
 return pmWithSign(r, x);
}
`,
    ],
    // x < 0 (or x = -0 with y = 0): the angle from the negative x axis. x = -0 with y != 0 stays +-pi/2.
    preciseAtan2: [
      ['pmAtanK', 'preciseDiv'],
      `fn preciseAtan2(y: f32, x: f32) -> f32 {
 if (pmIsNan(x) || pmIsNan(y)) { return pmNan(x + y); }
 var ax = abs(x); var ay = abs(y);
 var t: f32;
 if (pmExponent(ax) == 255u && pmExponent(ay) == 255u) { t = PM_PIO4_HI; }
 else {
  if (ax > 4.253529586511731e37 || ay > 4.253529586511731e37) { ax = ax * 0.25; ay = ay * 0.25; }
  let big = max(ax, ay); let small = min(ax, ay);
  if (big == 0.0) { t = 0.0; }
  else if (small <= 0.5 * big) {
   let k = pmAtanK(preciseDiv(small, big));
   t = select(k, PM_PIO2_HI + (PM_PIO2_LO - k), ay > ax);
  } else { t = PM_PIO4_HI + (pmAtanK(preciseDiv(ay - ax, ay + ax)) + PM_PIO4_LO); }
 }
 if (pmNegative(x) && (!pmIsZero(x) || pmIsZero(y))) { t = PM_PI_HI + (PM_PI_LO - t); }
 return pmWithSign(t, y);
}
`,
    ],
    // asin(x) - x, |x| <= 1/2.
    // 2 asin(sqrt((1 - a) / 2)) for a in [1/2, 1], as hi + tail.
    pmAsin: [
      ['preciseSqrt', 'pmBits'],
      `fn pmAsinK(x: f32) -> f32 {
 let w = x * x;
 let p = ${horner('w', P.asin)};
 return (x * w) * p;
}
fn pmAsinTail(a: f32) -> vec2f {
 let z = 0.5 * (1.0 - a);
 let s = pmSqrt2(z);
 return vec2f(2.0 * s.x, 2.0 * (s.y + pmAsinK(s.x)));
}
`,
    ],
    preciseAsin: [
      ['pmAsin'],
      `fn preciseAsin(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x) || a > 1.0) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 var r: f32;
 if (a < 0.5) { r = a + pmAsinK(a); }
 else { let t = pmAsinTail(a); r = PM_PIO2_HI - (t.x - (PM_PIO2_LO - t.y)); }
 return pmWithSign(r, x);
}
`,
    ],
    preciseAcos: [
      ['pmAsin'],
      `fn preciseAcos(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x) || a > 1.0) { return pmNan(x); }
 if (a < 0.5) { return PM_PIO2_HI - (x - (PM_PIO2_LO - pmAsinK(x))); }
 let t = pmAsinTail(a);
 if (pmNegative(x)) { return PM_PI_HI - (t.x - (PM_PI_LO - t.y)); }
 return t.x + t.y;
}
`,
    ],
    // (e^r - 1 - r) / r^2 and e^r - 1, |r| <= ln2 / 2.
    // x = k ln2 + r (Cody-Waite; k ln2Hi and x - k ln2Hi are exact): (k, r, rHi, rLo).
    // v 2^k in two steps, so the first stays in the normal range.
    pmExp: [
      ['pmBits'],
      `fn pmExpm1P(r: f32) -> f32 { return ${horner('r', P.expm1)}; }
fn pmExpm1K(r: f32) -> f32 { return (r * r) * pmExpm1P(r) + r; }
fn pmReduceLn2(x: f32) -> vec4f {
 let k = round(x * PM_LOG2E);
 let hi = x - k * PM_LN2_HI;
 let lo = -k * PM_LN2_LO;
 return vec4f(k, hi + lo, hi, lo);
}
fn pmScale(v: f32, k: i32) -> f32 { let h = k / 2; return ldexp(ldexp(v, k - h), h); }
`,
    ],
    preciseExp: [
      ['pmExp'],
      `fn preciseExp(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x > 88.72284) { return pmInfinity(false, x); }
 if (x < -103.97208) { return 0.0; }
 if (abs(x) < 2.9802322387695312e-8) { return 1.0 + x; }
 let k = pmReduceLn2(x);
 return pmScale(1.0 + pmExpm1K(k.y), i32(k.x));
}
`,
    ],
    preciseExp2: [
      ['pmExp'],
      `fn preciseExp2(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x >= 128.0) { return pmInfinity(false, x); }
 if (x < -150.0) { return 0.0; }
 let k = round(x);
 return pmScale(1.0 + pmExpm1K((x - k) * PM_LN2), i32(k));
}
`,
    ],
    // 2^k (1 + r + T) - 1 with T = e^r - 1 - r and 2^k - 1 exact: for k > 0 ((2^k - 1) + 2^k rHi) + 2^k (rLo + T),
    // the first sum exact; for k < 0 (2^k - 1) + 2^k (e^r - 1).
    preciseExpm1: [
      ['preciseExp'],
      `fn preciseExpm1(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x > 88.72284) { return pmInfinity(false, x); }
 let a = abs(x);
 if (a < 2.9802322387695312e-8) { return x; }
 if (a <= 0.3465735) { return pmExpm1K(x); }
 if (x < -17.0) { return preciseExp(x) - 1.0; }
 let k = pmReduceLn2(x);
 if (k.x > 24.0) { return preciseExp(x) - 1.0; }
 let T = (k.y * k.y) * pmExpm1P(k.y);
 let p = ldexp(1.0, i32(k.x));
 if (k.x > 0.0) { return ((p - 1.0) + p * k.z) + p * (k.w + T); }
 return p * (k.z + (k.w + T)) + (p - 1.0);
}
`,
    ],
    preciseSinh: [
      ['preciseExpm1', 'preciseDiv'],
      `fn preciseSinh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 var r: f32;
 if (a <= 1.0) { let w = a * a; r = (a * w) * ${horner('w', P.sinh)} + a; }
 else if (a > 88.72284) { let t = preciseExp(0.5 * a); r = (0.5 * t) * t; }
 else if (a > 9.0) { r = 0.5 * preciseExp(a); }
 else { let e = preciseExpm1(a); r = 0.5 * (e + preciseDiv(e, e + 1.0)); }
 return pmWithSign(r, x);
}
`,
    ],
    preciseCosh: [
      ['preciseExp', 'preciseDiv'],
      `fn preciseCosh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return 1.0; }
 if (a <= 1.0) { let w = a * a; return 1.0 + ((w * w) * ${horner('w', P.cosh)} + 0.5 * w); }
 if (a > 88.72284) { let t = preciseExp(0.5 * a); return (0.5 * t) * t; }
 let t = preciseExp(a);
 return 0.5 * (t + preciseDiv(1.0, t));
}
`,
    ],
    preciseTanh: [
      ['preciseExpm1', 'preciseDiv'],
      `fn preciseTanh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 if (a > 9.1) { return pmWithSign(1.0, x); }
 if (a <= 0.55) { let w = a * a; return pmWithSign((a * w) * ${horner('w', P.tanh)} + a, x); }
 let e = preciseExpm1(2.0 * a);
 return pmWithSign(preciseDiv(e, e + 2.0), x);
}
`,
    ],
    // log(1 + f) = f - hfsq + t, t = s (hfsq + R), s = f / (2 + f), f in [sqrt(1/2) - 1, sqrt(2) - 1].
    // x = 2^e (1 + f), 1 + f in [sqrt(1/2), sqrt(2)), from the bits (a subnormal x normalised in integers): (e, f).
    // log(0) = -inf, log(+inf) = +inf, NaN below 0; 0 when x is an ordinary positive number.
    pmLog: [
      ['preciseDiv'],
      `struct PmLogK { s: f32, R: f32, hfsq: f32, t: f32 }
fn pmLogK(f: f32) -> PmLogK {
 let s = preciseDiv(f, 2.0 + f);
 let z = s * s;
 let R = z * ${horner('z', P.log)};
 let hfsq = (0.5 * f) * f;
 return PmLogK(s, R, hfsq, s * (hfsq + R));
}
fn pmDecompose(x: f32) -> vec2f {
 var u = bitcast<u32>(x);
 var e = i32(u >> 23u) - 127;
 if (e == -127) { let z = countLeadingZeros(u) - 8u; u = u << z; e = -126 - i32(z); }
 var m = bitcast<f32>((u & 0x7fffffu) | 0x3f800000u);
 if (m > 1.4142135) { m = 0.5 * m; e = e + 1; }
 return vec2f(f32(e), m - 1.0);
}
fn pmLogSpecial(x: f32) -> u32 {
 if (pmIsNan(x) || (pmNegative(x) && !pmIsZero(x))) { return 1u; }
 if (pmIsZero(x)) { return 2u; }
 if (pmExponent(x) == 255u) { return 3u; }
 return 0u;
}
fn pmLogSpecialValue(kind: u32, x: f32) -> f32 {
 return select(select(x, pmInfinity(true, x), kind == 2u), pmNan(x), kind == 1u);
}
`,
    ],
    preciseLog: [
      ['pmLog'],
      `fn preciseLog(x: f32) -> f32 {
 let special = pmLogSpecial(x);
 if (special != 0u) { return pmLogSpecialValue(special, x); }
 let d = pmDecompose(x);
 let k = pmLogK(d.y);
 return d.x * PM_LN2_HI + (d.y - (k.hfsq - (k.t + d.x * PM_LN2_LO)));
}
`,
    ],
    // f log2(e) exactly as ah + al (f is exact, so are the products of 12-bit halves).
    preciseLog2: [
      ['pmLog'],
      `fn preciseLog2(x: f32) -> f32 {
 let special = pmLogSpecial(x);
 if (special != 0u) { return pmLogSpecialValue(special, x); }
 let d = pmDecompose(x);
 let k = pmLogK(d.y);
 let fs = pmSplit(d.y); let ls = pmSplit(PM_LOG2E);
 let ah = d.y * PM_LOG2E;
 let al = (((fs.x * ls.x - ah) + fs.x * ls.y) + fs.y * ls.x) + fs.y * ls.y;
 let tail = (al + d.y * PM_LOG2E_LO) - (k.hfsq - k.t) * PM_LOG2E;
 return (d.x + ah) + tail;
}
`,
    ],
    // u = 1 + x - c exactly (Fast2Sum, the larger of 1 and |x| first).
    preciseLog1p: [
      ['preciseLog'],
      `fn preciseLog1p(x: f32) -> f32 {
 if (pmIsNan(x) || x < -1.0) { return pmNan(x); }
 if (x == -1.0) { return pmInfinity(true, x); }
 if (pmExponent(x) == 255u) { return x; }
 let u = 1.0 + x;
 if (u == 1.0) { return x; }
 let c = select(1.0 - (u - x), x - (u - 1.0), abs(x) <= 1.0);
 return preciseLog(u) + preciseDiv(c, u);
}
`,
    ],
    // a b - fl(a b), exactly (the products of 12-bit halves are exact).
    // s + e = a + b exactly (TwoSum, additions only).
    // log2(x) for finite x > 0 as hi + lo, to about 2^-30 relative.
    // s = f / (2 + f) as s + sl.
    // t = s hh (exact pair) + (s hl + sl hh + s R).
    // x^y with Math.pow's special cases (x < 0 needs an integer y).
    // 2^f = e^(f ln2), f ln2 = r + rl to about 2^-40.
    precisePow: [
      ['pmLog', 'pmExp'],
      `fn pmProductError(a: f32, b: f32, p: f32) -> f32 {
 let x = pmSplit(a); let y = pmSplit(b);
 return (((x.x * y.x - p) + x.x * y.y) + x.y * y.x) + x.y * y.y;
}
fn pmTwoSum(a: f32, b: f32) -> vec2f {
 let s = a + b; let bb = s - a;
 return vec2f(s, (a - (s - bb)) + (b - bb));
}
fn pmLog2Pair(x: f32) -> vec2f {
 let d = pmDecompose(x);
 let e = d.x; let f = d.y;
 let k = pmLogK(f);
 let q = f * f;
 let hh = 0.5 * q;
 let hl = 0.5 * pmProductError(f, f, q);
 let dh = 2.0 + f;
 let dl = f - (dh - 2.0);
 let sd = k.s * dh;
 let rho = (f - sd) - pmProductError(k.s, dh, sd);
 let sl = (rho - k.s * dl) / dh;
 let th = k.s * hh;
 let tl = ((pmProductError(k.s, hh, th) + k.s * hl) + sl * hh) + k.s * k.R;
 let ah = f * PM_LOG2E; let al = pmProductError(f, PM_LOG2E, ah);
 let bh = hh * PM_LOG2E; let bl = pmProductError(hh, PM_LOG2E, bh);
 let ch = th * PM_LOG2E; let cl = pmProductError(th, PM_LOG2E, ch);
 let s1 = pmTwoSum(e, ah); let s2 = pmTwoSum(s1.x, -bh); let s3 = pmTwoSum(s2.x, ch);
 let small = ((f - hh) + th) * PM_LOG2E_LO;
 let tail = (((s1.y + s2.y) + s3.y) + ((al - bl) + cl)) + ((tl - hl) * PM_LOG2E + small);
 let hi = s3.x + tail;
 return vec2f(hi, tail - (hi - s3.x));
}
fn pmIsOdd(y: f32) -> bool { return abs(y) < 16777216.0 && floor(y) == y && (i32(y) & 1) == 1; }
fn precisePow(x: f32, y: f32) -> f32 {
 if (pmIsNan(y)) { return y; }
 if (y == 0.0) { return 1.0; }
 if (pmIsNan(x)) { return x; }
 let ax = abs(x); let ay = abs(y);
 if (pmExponent(ay) == 255u) {
  if (ax == 1.0) { return pmNan(x); }
  return select(0.0, pmInfinity(false, x), (ax > 1.0) == (y > 0.0));
 }
 let negative = pmNegative(x) && pmIsOdd(y);
 if (pmExponent(ax) == 255u) { return select(select(0.0, -0.0, negative), pmInfinity(negative, x), y > 0.0); }
 if (pmIsZero(ax)) { return select(pmInfinity(negative, x), select(0.0, -0.0, negative), y > 0.0); }
 if (pmNegative(x) && floor(y) != y) { return pmNan(x); }
 let L = pmLog2Pair(ax);
 let ph = y * L.x;
 let pl = pmProductError(y, L.x, ph) + y * L.y;
 if (ph > 128.0 || (ph == 128.0 && pl >= 0.0)) { return pmInfinity(negative, x); }
 if (ph < -151.0) { return select(0.0, -0.0, negative); }
 let k = round(ph);
 let f = (ph - k) + pl;
 let r = f * PM_LN2;
 let rl = pmProductError(f, PM_LN2, r) + f * PM_LN2_TAIL;
 let v = pmScale(1.0 + (pmExpm1K(r) + rl), i32(k));
 return select(v, -v, negative);
}
`,
    ],
  });

/** Every public function of {@link preciseMathWgsl}. */
export const PRECISE_FUNCTIONS = /* @__PURE__ */ Object.freeze([
  'preciseDiv',
  'preciseSqrt',
  'preciseSin',
  'preciseCos',
  'preciseTan',
  'preciseAtan',
  'preciseAtan2',
  'preciseAsin',
  'preciseAcos',
  'preciseExp',
  'preciseExp2',
  'preciseExpm1',
  'preciseSinh',
  'preciseCosh',
  'preciseTanh',
  'preciseLog',
  'preciseLog2',
  'preciseLog1p',
  'precisePow',
]);

/**
 * WGSL source of the named precise functions (`preciseSin`, `preciseAtan2`, ...) and the helpers they need, each
 * once, ready to paste into a shader. Every function takes and returns f32.
 */
export function preciseMathWgsl(names) {
  const order = [],
    seen = new Set();
  const add = (name) => {
    if (seen.has(name)) return;
    const piece = pieces()[name];
    if (!piece)
      throw new RangeError(`Unknown precise maths function ${name}; use one of ${PRECISE_FUNCTIONS.join(', ')}`);
    seen.add(name);
    for (const dep of piece[0]) add(dep);
    order.push(piece[1]);
  };
  for (const name of names) add(name);
  return order.join('');
}
