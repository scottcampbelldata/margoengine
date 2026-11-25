// The FFT (K17) in Rust and its TypeScript twin (`@margoengine/math/fft`) give the same bits: both are pinned to
// fft-vectors.txt, written from the Rust when FFT_VECTORS_WRITE=1 and checked otherwise, and read by
// packages/math/test/fft.test.js. Each line: a kind and its sizes, then the input and the output as the hex bits of f64s.
// Also checked here against a direct DFT and by round trips.
use margoengine_physics_kernel_common::fft::{Fft, Fft3, RealFft2};
use margoengine_physics_kernel_common::pinned::{cos, sin};

fn stream(seed: u64) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (s >> 11) as f64 / (1u64 << 53) as f64 - 0.5
    }
}

fn hex(values: &[f64]) -> String {
    values.iter().map(|x| format!("{:016x}", x.to_bits())).collect::<Vec<_>>().join(" ")
}

fn lines() -> String {
    let mut text = String::from(
        "# FFT (K17): kind sizes | input | output, values as the hex bits of f64s.\n\
         # Written by kernel-common/tests/fft_twin.rs with FFT_VECTORS_WRITE=1; read by packages/math/test/fft.test.js.\n",
    );
    let mut u = stream(17);
    for n in [1usize, 2, 3, 4, 5, 6, 8, 12, 15, 30, 64, 100, 120, 256, 360] {
        for inverse in [false, true] {
            let input: Vec<f64> = (0..2 * n).map(|_| u()).collect();
            let mut out = input.clone();
            Fft::new(n).unwrap().transform(&mut out, inverse, 0, 1);
            text.push_str(&format!("fft {n} {} | {} | {}\n", inverse as u8, hex(&input), hex(&out)));
        }
    }
    for (nx, ny, nz) in [(4usize, 6usize, 5usize), (8, 8, 1), (16, 4, 2)] {
        let input: Vec<f64> = (0..2 * nx * ny * nz).map(|_| u()).collect();
        let mut out = input.clone();
        Fft3::new(nx, ny, nz).unwrap().transform(&mut out, false);
        text.push_str(&format!("fft3 {nx} {ny} {nz} | {} | {}\n", hex(&input), hex(&out)));
    }
    for (nx, ny) in [(8usize, 6usize), (16, 16)] {
        let field: Vec<f64> = (0..nx * ny).map(|_| u()).collect();
        let mut half = vec![0.0; 2 * (nx / 2 + 1) * ny];
        let mut plan = RealFft2::new(nx, ny).unwrap();
        plan.forward(&field, &mut half);
        text.push_str(&format!("rfft2 {nx} {ny} | {} | {}\n", hex(&field), hex(&half)));
        let mut back = vec![0.0; nx * ny];
        plan.inverse(&half, &mut back);
        text.push_str(&format!("irfft2 {nx} {ny} | {} | {}\n", hex(&half), hex(&back)));
    }
    text
}

#[test]
fn the_typescript_twin_and_rust_give_the_same_bits() {
    let text = lines();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fft-vectors.txt");
    if std::env::var("FFT_VECTORS_WRITE").as_deref() == Ok("1") {
        std::fs::write(path, &text).unwrap();
    }
    let committed = std::fs::read_to_string(path).expect("fft-vectors.txt; write it with FFT_VECTORS_WRITE=1");
    assert!(committed == text, "the FFT no longer gives the committed bits; if that is intended, rewrite the file");
}

#[test]
fn it_is_the_discrete_fourier_transform_and_inverts() {
    let mut u = stream(5);
    for n in [1usize, 2, 3, 5, 6, 12, 30, 60, 128, 243, 360] {
        let x: Vec<f64> = (0..2 * n).map(|_| u()).collect();
        let mut y = x.clone();
        let mut plan = Fft::new(n).unwrap();
        plan.transform(&mut y, false, 0, 1);
        for k in 0..n {
            let (mut re, mut im) = (0.0, 0.0);
            for j in 0..n {
                let a = -6.283185307179586 * ((j * k) % n) as f64 / n as f64;
                let (c, s) = (cos(a), sin(a));
                re += x[2 * j] * c - x[2 * j + 1] * s;
                im += x[2 * j] * s + x[2 * j + 1] * c;
            }
            assert!((y[2 * k] - re).abs() < 1e-12 * n as f64 && (y[2 * k + 1] - im).abs() < 1e-12 * n as f64, "n {n} k {k}");
        }
        plan.transform(&mut y, true, 0, 1);
        for i in 0..2 * n {
            assert!((y[i] - x[i]).abs() < 1e-14 * n as f64, "round trip n {n}");
        }
    }
    assert!(Fft::new(7).is_none() && Fft::new(0).is_none() && RealFft2::new(5, 4).is_none());
    // A real field's half spectrum goes back to the field.
    let (nx, ny) = (12usize, 10usize);
    let field: Vec<f64> = (0..nx * ny).map(|_| u()).collect();
    let mut plan = RealFft2::new(nx, ny).unwrap();
    let mut half = vec![0.0; 2 * (nx / 2 + 1) * ny];
    plan.forward(&field, &mut half);
    let mut back = vec![0.0; nx * ny];
    plan.inverse(&half, &mut back);
    for i in 0..nx * ny {
        assert!((back[i] - field[i]).abs() < 1e-14);
    }
}
