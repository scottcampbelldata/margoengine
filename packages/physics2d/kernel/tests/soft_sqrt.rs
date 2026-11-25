// The square root of the Wasm build without SIMD, which has no float square root of its own, is integer arithmetic: it must give the
// hardware's bits for every input, so that the scalar build and the SIMD build step a world to the same bits.
use margoengine_physics2d_kernel::math::{soft_sqrt, soft_sqrt64};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

#[test]
fn the_integer_root_of_an_f32_is_the_hardware_root_bit_for_bit() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut checked = 0u32;
    for k in 0..2_000_000u32 {
        // Random bit patterns (every exponent, normals and subnormals), then the ones near perfect squares and ties.
        let bits = if k % 4 == 0 { (rng.next() as u32) & 0x7fff_ffff } else { (rng.next() as u32) & 0x7f7f_ffff };
        let x = f32::from_bits(bits);
        assert_eq!(soft_sqrt(x).to_bits(), x.sqrt().to_bits(), "sqrt of {x:e} ({bits:#x})");
        checked += 1;
    }
    // Squares of numbers with few bits are exact roots; their neighbours are the ties' neighbours.
    for n in 1..4000u32 {
        let square = (n as f32) * (n as f32);
        for delta in [-1i64, 0, 1] {
            let x = f32::from_bits((square.to_bits() as i64 + delta) as u32);
            assert_eq!(soft_sqrt(x).to_bits(), x.sqrt().to_bits(), "sqrt near {n} squared");
        }
    }
    // The special values.
    for x in [0.0f32, -0.0, f32::INFINITY, f32::NEG_INFINITY, f32::NAN, -1.0, f32::MIN_POSITIVE, f32::from_bits(1), f32::MAX] {
        let (a, b) = (soft_sqrt(x), x.sqrt());
        assert!(a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()), "sqrt of {x:e}");
    }
    assert!(checked > 0);
}

#[test]
fn the_integer_root_of_an_f64_is_the_hardware_root_bit_for_bit() {
    let mut rng = Rng(0x0123_4567_89ab_cdef);
    for _ in 0..500_000 {
        let bits = rng.next() & 0x7fff_ffff_ffff_ffff;
        let x = f64::from_bits(bits);
        let (a, b) = (soft_sqrt64(x), x.sqrt());
        assert!(a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()), "sqrt of {x:e} ({bits:#x})");
    }
    for n in 1..4000u64 {
        let square = (n as f64) * (n as f64);
        for delta in [-1i64, 0, 1] {
            let x = f64::from_bits((square.to_bits() as i64 + delta) as u64);
            assert_eq!(soft_sqrt64(x).to_bits(), x.sqrt().to_bits(), "sqrt near {n} squared");
        }
    }
}
