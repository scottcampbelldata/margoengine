// Correctly rounded square root on both targets. Wasm: the `f32.sqrt` instruction through the SIMD form, as core has no float maths.
#[inline(always)]
pub fn sqrt(value: f32) -> f32 {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(value)))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        value.sqrt()
    }
}

/// Correctly rounded root used for the scalar gas projection's f64 discriminant.
#[inline(always)]
pub fn sqrt64(value: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        value.sqrt()
    }
}

#[inline(always)]
pub fn abs(value: f32) -> f32 {
    f32::from_bits(value.to_bits() & 0x7fff_ffff)
}

/// 1 for a positive number or zero, -1 for a negative one.
#[inline(always)]
pub fn sign(value: f32) -> f32 {
    if value.to_bits() >> 31 == 0 { 1.0 } else { -1.0 }
}
