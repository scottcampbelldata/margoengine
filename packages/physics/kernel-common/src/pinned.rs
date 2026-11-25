// Pinned maths (K01 of docs/physics-solvers.md): `exp`, `ln`, `sin`, `cos`, `pow` and fixed-order sums over f64 that use only
// + - * / and integer operations, so a native build, a Wasm build and a browser give the same bits, which the host's own `exp` and
// `sin` (left to the implementation by the language) do not promise. Every function is a pure function of its argument.
//
// Methods, all textbook: argument reduction to a short interval and a Taylor series there, run to the term below one part in 2^60
// (W. J. Cody and W. Waite, "Software Manual for the Elementary Functions", Prentice-Hall 1980, for the reduction by the
// leading and trailing parts of ln 2 and of pi / 2; J.-M. Muller, "Elementary Functions: Algorithms and Implementation",
// 3rd ed., Birkhauser 2016, chapters 4 and 11, for the series and the error analysis). The accuracy is stated on each function and
// held by `tests/pinned.rs` against the host's functions over their ranges.

/// ln 2 as the sum of a leading part of 42 bits (so `k * LN2_HI` is exact for |k| < 2^11) and a remainder, split with exact
/// arithmetic from the decimal digits of ln 2.
const LN2_HI: f64 = 0.693_147_180_559_890_3;
const LN2_LO: f64 = 5.497_923_018_708_371e-14;
const INV_LN2: f64 = 1.442_695_040_888_963_4;
/// pi / 2 in parts of 33, 33 and 33 bits and the rest, split with exact arithmetic from the decimal digits of pi, so
/// `k * PIO2_n` is exact for |k| < 2^20.
const PIO2_1: f64 = 1.570_796_326_734_125_6;
const PIO2_2: f64 = 6.077_100_506_303_966e-11;
const PIO2_3: f64 = 2.022_266_248_711_166_5e-21;
const PIO2_3T: f64 = 8.478_427_660_368_9e-32;
const TWO_OVER_PI: f64 = 6.366_197_723_675_814e-1;

/// 2^k for k in [-1022, 1023], by its bits.
#[inline]
fn pow2(k: i64) -> f64 {
    f64::from_bits(((k + 1023) as u64) << 52)
}

/// e^x. Within 2 ulp for |x| < 700; 0 below -745 and infinity above 709.78; NaN stays NaN.
pub fn exp(x: f64) -> f64 {
    if x.is_nan() {
        return x;
    }
    if x > 709.782_712_893_384 {
        return f64::INFINITY;
    }
    if x < -745.133_219_101_941_1 {
        return 0.0;
    }
    // x = k ln 2 + r with |r| <= ln 2 / 2.
    let k = (x * INV_LN2 + if x < 0.0 { -0.5 } else { 0.5 }) as i64;
    let kf = k as f64;
    let r = (x - kf * LN2_HI) - kf * LN2_LO;
    // Taylor to r^16 (the next term is below 2^-62 of the sum for |r| <= 0.35), by Horner.
    let mut sum = 1.0 / 20_922_789_888_000.0;
    for n in (1..=15).rev() {
        let mut fact = 1.0f64;
        let mut m = 1;
        while m < n {
            m += 1;
            fact *= m as f64;
        }
        sum = sum * r + 1.0 / fact;
    }
    let e = sum * r + 1.0;
    // Scale by 2^k in two steps so that subnormal results and k = 1024 do not overflow the exponent field.
    if k > 1023 {
        e * pow2(k - 1000) * pow2(1000)
    } else if k < -1022 {
        e * pow2(k + 1000) * pow2(-1000)
    } else {
        e * pow2(k)
    }
}

/// ln x for x > 0. Within 2 ulp; -infinity at 0, NaN below 0, infinity at infinity.
pub fn ln(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return x;
    }
    // Scale a subnormal up by 2^54 so its exponent is readable.
    let (x, shift) = if x < f64::MIN_POSITIVE { (x * pow2(54), -54i64) } else { (x, 0) };
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023 + shift;
    // The mantissa in [sqrt(2)/2, sqrt(2)).
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > 1.414_213_562_373_095_1 {
        m *= 0.5;
        e += 1;
    }
    // ln m = 2 atanh s, s = (m - 1) / (m + 1), |s| <= 0.1716: 2 (s + s^3 / 3 + s^5 / 5 + ...) to s^25.
    let s = (m - 1.0) / (m + 1.0);
    let z = s * s;
    let mut sum = 1.0 / 27.0;
    let mut n = 25.0;
    while n >= 3.0 {
        sum = sum * z + 1.0 / n;
        n -= 2.0;
    }
    // sum now holds 1/3 + z/5 + ...; ln m = 2 s (1 + z * sum).
    let ln_m = 2.0 * s * (1.0 + z * sum);
    let ef = e as f64;
    ef * LN2_HI + (ln_m + ef * LN2_LO)
}

/// Reduces x to r in [-pi/4, pi/4] with x = k pi / 2 + r, returning (k mod 4, r); valid for |x| < 2^20 (about a million radians).
fn reduce(x: f64) -> (i64, f64) {
    let k = (x * TWO_OVER_PI + if x < 0.0 { -0.5 } else { 0.5 }) as i64;
    let kf = k as f64;
    let mut r = x - kf * PIO2_1;
    r -= kf * PIO2_2;
    r -= kf * PIO2_3;
    r -= kf * PIO2_3T;
    (k & 3, r)
}

/// sin r for |r| <= pi/4 by its Taylor series to r^27.
fn sin_kernel(r: f64) -> f64 {
    let z = r * r;
    let mut sum = 0.0f64;
    let mut fact = 1.0f64;
    // Coefficients 1 / (2 n + 1)! built by running products, highest first.
    let mut coef = [0.0f64; 14];
    for (n, c) in coef.iter_mut().enumerate() {
        if n > 0 {
            fact *= ((2 * n) * (2 * n + 1)) as f64;
        }
        *c = 1.0 / fact;
    }
    for n in (0..14).rev() {
        let sign = if n % 2 == 0 { 1.0 } else { -1.0 };
        sum = sum * z + sign * coef[n];
    }
    r * sum
}

/// cos r for |r| <= pi/4 by its Taylor series to r^28.
fn cos_kernel(r: f64) -> f64 {
    let z = r * r;
    let mut sum = 0.0f64;
    let mut fact = 1.0f64;
    let mut coef = [0.0f64; 15];
    for (n, c) in coef.iter_mut().enumerate() {
        if n > 0 {
            fact *= ((2 * n - 1) * (2 * n)) as f64;
        }
        *c = 1.0 / fact;
    }
    for n in (0..15).rev() {
        let sign = if n % 2 == 0 { 1.0 } else { -1.0 };
        sum = sum * z + sign * coef[n];
    }
    sum
}

/// sin x for |x| < 2^20 radians, within 2 ulp; NaN beyond (no Payne and Hanek reduction here).
pub fn sin(x: f64) -> f64 {
    if !(x.abs() < 1_048_576.0) {
        return f64::NAN;
    }
    let (k, r) = reduce(x);
    match k {
        0 => sin_kernel(r),
        1 => cos_kernel(r),
        2 => -sin_kernel(r),
        _ => -cos_kernel(r),
    }
}

/// cos x for |x| < 2^20 radians, within 2 ulp; NaN beyond.
pub fn cos(x: f64) -> f64 {
    if !(x.abs() < 1_048_576.0) {
        return f64::NAN;
    }
    let (k, r) = reduce(x);
    match k {
        0 => cos_kernel(r),
        1 => -sin_kernel(r),
        2 => -cos_kernel(r),
        _ => sin_kernel(r),
    }
}

/// a + b exactly as a rounded sum and its rounding error (Knuth's TwoSum; Muller 2016, section 4.3.2), `a` and `b` any order.
#[inline]
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let t = s - a;
    (s, (a - (s - t)) + (b - t))
}

/// a * b exactly as a rounded product and its rounding error, by Dekker's split of each factor into halves of 26 bits (no fused
/// multiply-add), valid while the factors are below 2^995.
#[inline]
fn two_prod(a: f64, b: f64) -> (f64, f64) {
    const SPLIT: f64 = 134_217_729.0; // 2^27 + 1
    let split = |x: f64| {
        let c = SPLIT * x;
        let hi = c - (c - x);
        (hi, x - hi)
    };
    let p = a * b;
    let ((ah, al), (bh, bl)) = (split(a), split(b));
    (p, ((ah * bh - p) + ah * bl + al * bh) + al * bl)
}

/// ln x for x > 0 as a pair `hi + lo` with `lo` below half an ulp of `hi`: about 105 bits of the result.
fn ln_pair(x: f64) -> (f64, f64) {
    if !(x > f64::MIN_POSITIVE) {
        return (ln(x), 0.0);
    }
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > 1.414_213_562_373_095_1 {
        m *= 0.5;
        e += 1;
    }
    let s = (m - 1.0) / (m + 1.0);
    let z = s * s;
    let mut sum = 1.0 / 27.0;
    let mut n = 25.0;
    while n >= 3.0 {
        sum = sum * z + 1.0 / n;
        n -= 2.0;
    }
    let ln_m = 2.0 * s * (1.0 + z * sum);
    let ef = e as f64;
    let (hi, err) = two_sum(ef * LN2_HI, ln_m);
    let lo = err + ef * LN2_LO;
    two_sum(hi, lo)
}

/// x^y for x > 0 as e^(y ln x) with ln x and the product y ln x carried to about 105 bits, so that the exponent's error does
/// not grow with its size: within 4 ulp for |y ln x| < 700. 1 for y = 0, 0 or infinity where the result under or overflows.
pub fn pow(x: f64, y: f64) -> f64 {
    if y == 0.0 {
        return 1.0;
    }
    if !(x > 0.0) || !x.is_finite() || !y.is_finite() {
        return exp(y * ln(x));
    }
    let (hi, lo) = ln_pair(x);
    let (p, q) = two_prod(y, hi);
    let q = q + y * lo;
    // e^(p + q) = e^p (1 + q + q^2 / 2) with |q| below an ulp of p.
    let r = exp(p);
    r + r * (q + 0.5 * q * q)
}

/// The sum of `values` in a fixed order that does not depend on how many threads add them: partial sums over blocks of 256 in
/// order, then the blocks' sums combined by a balanced tree over their indices (Demmel and Nguyen, "Parallel reproducible
/// summation", IEEE Transactions on Computers 64(7), 2015, as a description of fixed-partition summation). A thread that sums a
/// block gets the block's bits whoever it is.
pub fn sum(values: &[f64]) -> f64 {
    const BLOCK: usize = 256;
    let blocks = values.len().div_ceil(BLOCK);
    let mut partial = alloc::vec::Vec::with_capacity(blocks);
    for chunk in values.chunks(BLOCK) {
        let mut s = 0.0;
        for &v in chunk {
            s += v;
        }
        partial.push(s);
    }
    tree(&partial)
}

/// A balanced tree sum over `values` by index: the left half of the indices, the right half, and the two added.
fn tree(values: &[f64]) -> f64 {
    match values.len() {
        0 => 0.0,
        1 => values[0],
        n => {
            let (left, right) = values.split_at(n / 2);
            tree(left) + tree(right)
        }
    }
}

/// The dot product of two slices of equal length, summed as `sum` sums the products.
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());
    let products: alloc::vec::Vec<f64> = a.iter().zip(b).map(|(x, y)| x * y).collect();
    sum(&products)
}
