// The pinned maths against the host's: within a few ulp over the ranges they state, exact where the exact answer is known, and
// the sums the same whatever the partition.
use margoengine_physics_kernel_common::pinned::{cos, dot, exp, ln, pow, sin, sum};

/// How many representable doubles apart two finite values are.
fn ulps(a: f64, b: f64) -> u64 {
    if a == b {
        return 0;
    }
    let key = |x: f64| {
        let bits = x.to_bits() as i64;
        if bits < 0 { i64::MIN - bits } else { bits }
    };
    key(a).abs_diff(key(b))
}

fn stream(seed: u64) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (s >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[test]
fn exp_ln_sin_cos_are_within_two_ulp_of_the_host() {
    let mut u = stream(1);
    let (mut worst_exp, mut worst_ln, mut worst_sin, mut worst_cos) = (0, 0, 0, 0);
    for _ in 0..200_000 {
        let x = (u() - 0.5) * 1400.0;
        worst_exp = worst_exp.max(ulps(exp(x.clamp(-700.0, 700.0)), x.clamp(-700.0, 700.0).exp()));
        let y = (u() * 600.0 - 300.0).exp() * (0.5 + u());
        worst_ln = worst_ln.max(ulps(ln(y), y.ln()));
        let a = (u() - 0.5) * 2000.0;
        worst_sin = worst_sin.max(ulps(sin(a), a.sin()));
        worst_cos = worst_cos.max(ulps(cos(a), a.cos()));
    }
    assert!(worst_exp <= 2, "exp {worst_exp} ulp");
    assert!(worst_ln <= 2, "ln {worst_ln} ulp");
    assert!(worst_sin <= 2, "sin {worst_sin} ulp");
    assert!(worst_cos <= 2, "cos {worst_cos} ulp");
}

#[test]
fn the_answers_known_exactly_come_out_exactly() {
    assert_eq!(exp(0.0), 1.0);
    assert_eq!(ln(1.0), 0.0);
    assert_eq!(sin(0.0), 0.0);
    assert_eq!(cos(0.0), 1.0);
    assert_eq!(pow(2.0, 0.0), 1.0);
    assert_eq!(exp(f64::NEG_INFINITY), 0.0);
    assert_eq!(exp(800.0), f64::INFINITY);
    assert_eq!(ln(0.0), f64::NEG_INFINITY);
    assert!(ln(-1.0).is_nan() && exp(f64::NAN).is_nan() && sin(f64::INFINITY).is_nan());
    // Subnormals and the edges of the range.
    assert!(ulps(ln(5e-324), 5e-324f64.ln()) <= 2);
    assert!(ulps(exp(-740.0), (-740.0f64).exp()) <= 2);
    assert!(ulps(exp(709.0), 709.0f64.exp()) <= 2);
}

#[test]
fn pow_is_close_and_the_identities_hold() {
    let mut u = stream(2);
    for _ in 0..50_000 {
        let (x, y) = (0.01 + u() * 100.0, (u() - 0.5) * 8.0);
        let (got, want) = (pow(x, y), x.powf(y));
        assert!(ulps(got, want) <= 4, "pow({x}, {y}) is {got}, the host's {want}");
    }
    for k in 0..200 {
        let a = k as f64 * 0.37 - 30.0;
        let (s, c) = (sin(a), cos(a));
        assert!((s * s + c * c - 1.0).abs() < 4e-16);
    }
}

#[test]
fn a_sum_is_a_function_of_its_values_and_the_dot_product_is_the_sum_of_the_products() {
    let mut u = stream(3);
    let values: Vec<f64> = (0..100_000).map(|_| (u() - 0.5) * 1e6).collect();
    assert_eq!(sum(&values).to_bits(), sum(&values.clone()).to_bits());
    assert_eq!(dot(&values, &values).to_bits(), sum(&values.iter().map(|x| x * x).collect::<Vec<_>>()).to_bits());
    assert_eq!(sum(&[]), 0.0);
    assert_eq!(sum(&[1.5]), 1.5);
    // The partition is fixed by the length, not by who adds: a block of 256 is added in order, so a short slice is the plain
    // left-to-right sum, which differs from the tree's for a long one.
    let short = &values[..200];
    assert_eq!(sum(short).to_bits(), short.iter().fold(0.0, |a, b| a + b).to_bits());
}
