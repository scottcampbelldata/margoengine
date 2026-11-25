// The TypeScript twin of the pinned maths (`@margoengine/math/pinned`, packages/math/src/pinned.ts) and this crate's `pinned`
// give the same bits: both are pinned to pinned-vectors.txt, which this test writes from the Rust when
// PINNED_VECTORS_WRITE=1 and checks otherwise, and which packages/math/test/pinned.test.js reads. Each line is a function, its
// arguments and its result as the hex bits of f64s.
use margoengine_physics_kernel_common::pinned::{cos, dot, exp, ln, pow, sin, sum};

fn stream(seed: u64) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (s >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn hex(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

/// Every vector: [function, arguments, result], arguments and result as f64s.
fn vectors() -> Vec<(&'static str, Vec<f64>, f64)> {
    let mut out = Vec::new();
    let mut u = stream(7);
    // Edges first, then spread values over each function's range.
    for x in [0.0, -0.0, 1.0, -1.0, 0.5, 709.0, -744.0, 1e-300, 700.5, -700.5] {
        out.push(("exp", vec![x], exp(x)));
    }
    for _ in 0..400 {
        let x = (u() - 0.5) * 1400.0;
        out.push(("exp", vec![x], exp(x)));
    }
    for x in [1.0, 2.0, 0.5, 1e-310, 5e-324, 1e300, core::f64::consts::E, 1.4142135623730951] {
        out.push(("ln", vec![x], ln(x)));
    }
    for _ in 0..400 {
        let x = (u() * 600.0 - 300.0).exp2();
        out.push(("ln", vec![x], ln(x)));
    }
    for x in [0.0, 1.0, -1.0, core::f64::consts::FRAC_PI_4, core::f64::consts::PI, 1000.0, 1048575.0] {
        out.push(("sin", vec![x], sin(x)));
        out.push(("cos", vec![x], cos(x)));
    }
    for _ in 0..400 {
        let x = (u() - 0.5) * 2_000_000.0;
        out.push(("sin", vec![x], sin(x)));
        out.push(("cos", vec![x], cos(x)));
        let small = (u() - 0.5) * 20.0;
        out.push(("sin", vec![small], sin(small)));
        out.push(("cos", vec![small], cos(small)));
    }
    for (x, y) in [(2.0, 10.0), (2.0, 0.5), (10.0, -3.0), (0.0, 2.0), (1.5, 0.0)] {
        out.push(("pow", vec![x, y], pow(x, y)));
    }
    for _ in 0..400 {
        let x = (u() * 40.0 - 20.0).exp2();
        let y = (u() - 0.5) * 30.0;
        out.push(("pow", vec![x, y], pow(x, y)));
    }
    // Fixed-order sums over arrays crossing block boundaries, and a dot product.
    for n in [0usize, 1, 255, 256, 257, 1000] {
        let values: Vec<f64> = (0..n).map(|_| (u() - 0.5) * 1e6).collect();
        let s = sum(&values);
        out.push(("sum", values, s));
    }
    let a: Vec<f64> = (0..600).map(|_| u() - 0.5).collect();
    let b: Vec<f64> = (0..600).map(|_| u() - 0.5).collect();
    let mut ab = a.clone();
    ab.extend(&b);
    out.push(("dot", ab, dot(&a, &b)));
    out
}

#[test]
fn the_typescript_twin_and_rust_give_the_same_bits() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/pinned-vectors.txt");
    let mut text = String::from(
        "# Pinned maths of the physics framework (K01): function, arguments, result, as the hex bits of f64s.\n\
         # Written by kernel-common/tests/pinned_twin.rs with PINNED_VECTORS_WRITE=1; read by packages/math/test/pinned.test.js.\n",
    );
    for (name, args, result) in vectors() {
        text.push_str(name);
        for a in &args {
            text.push(' ');
            text.push_str(&hex(*a));
        }
        text.push(' ');
        text.push_str(&hex(result));
        text.push('\n');
    }
    if std::env::var("PINNED_VECTORS_WRITE").as_deref() == Ok("1") {
        std::fs::write(path, &text).unwrap();
    }
    let committed = std::fs::read_to_string(path).expect("pinned-vectors.txt; write it with PINNED_VECTORS_WRITE=1");
    assert!(committed == text, "the pinned functions no longer give the committed bits; if that is intended, rewrite the file");
}
