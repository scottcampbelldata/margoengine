// The standard atmosphere (K03) in Rust and its TypeScript twin (`@margoengine/math/atmosphere`) give the same bits: both are
// pinned to atmosphere-vectors.txt, written from the Rust when ATMOSPHERE_VECTORS_WRITE=1 and checked otherwise, and read by
// packages/math/test/atmosphere.test.js. Each line: height, sea-level temperature, tropopause, then temperature, pressure
// and density, as the hex bits of f64s. The values also match the ISO 2533 table.
use margoengine_physics_kernel_common::atmosphere::{standard_atmosphere, standard_density};

fn hex(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

#[test]
fn the_typescript_twin_and_rust_give_the_same_bits() {
    let mut cases = vec![];
    for z in [-2000.0, -1000.0, -430.0, 0.0, 1000.0, 5000.0, 11000.0, 15000.0, 20000.0, 25000.0, 32000.0, 40000.0, 47000.0, 60000.0] {
        cases.push((z, 288.15, 11000.0));
    }
    for (z, sea, tropo) in [(2000.0, 303.15, 11000.0), (12000.0, 288.15, 12000.0), (500.0, 273.15, 9000.0), (21000.0, 293.15, 13000.0)] {
        cases.push((z, sea, tropo));
    }
    let mut s: u64 = 11;
    for _ in 0..200 {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let z = (s >> 11) as f64 / (1u64 << 53) as f64 * 52000.0 - 2000.0;
        cases.push((z, 288.15, 11000.0));
    }
    let mut text = String::from(
        "# Standard atmosphere (K03): z, sea-level temperature, tropopause, then temperature, pressure, density (hex bits of f64s).\n\
         # Written by kernel-common/tests/atmosphere_twin.rs with ATMOSPHERE_VECTORS_WRITE=1; read by packages/math/test/atmosphere.test.js.\n",
    );
    for (z, sea, tropo) in cases {
        let (t, p) = standard_atmosphere(z, sea, tropo);
        let rho = standard_density(z, sea, tropo);
        text.push_str(&[z, sea, tropo, t, p, rho].map(hex).join(" "));
        text.push('\n');
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/atmosphere-vectors.txt");
    if std::env::var("ATMOSPHERE_VECTORS_WRITE").as_deref() == Ok("1") {
        std::fs::write(path, &text).unwrap();
    }
    let committed = std::fs::read_to_string(path).expect("atmosphere-vectors.txt; write it with ATMOSPHERE_VECTORS_WRITE=1");
    assert!(committed == text, "the standard atmosphere no longer gives the committed bits; if that is intended, rewrite the file");
}

#[test]
fn the_iso_2533_table() {
    for (z, t, p, rho) in [(-1000.0, 294.65, 113929.0, 1.347), (0.0, 288.15, 101325.0, 1.225), (1000.0, 281.65, 89874.6, 1.1117), (11000.0, 216.65, 22632.1, 0.36392)] {
        let (tt, pp) = standard_atmosphere(z, 288.15, 11000.0);
        assert!((tt - t).abs() < 1e-9 && (pp - p).abs() < 0.5 && (standard_density(z, 288.15, 11000.0) - rho).abs() < 1e-4, "{z}");
    }
}
