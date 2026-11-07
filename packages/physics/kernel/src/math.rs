// Scalar helpers. Every one is a correctly rounded IEEE 754 operation on both targets, so native and Wasm agree bit for
// bit: Rust never contracts a * b + c into a fused operation, and Wasm has none outside relaxed SIMD.

/// Correctly rounded square root. Wasm: the `f32.sqrt` instruction through the SIMD form, as core has no float maths.
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
