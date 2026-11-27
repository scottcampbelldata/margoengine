//! Dequantization of T.800 Annex E (E.1), the region-of-interest Maxshift of Annex H (H.2), and the component
//! transforms and DC level shift of Annex G (G.1.2, G.2 and G.3).
use crate::geometry::Band;
use crate::t1::Decoded;

/// Mb of Equation E-2: the bit-planes a band may hold, G + epsilon_b - 1.
pub fn planes(guard: u8, exponent: u8) -> u32 {
    (guard as u32 + exponent as u32).saturating_sub(1)
}

/// The step size of Equation E-3: 2^(Rb - epsilon_b) (1 + mu_b / 2^11), Rb the component precision plus the band's
/// log2 gain (Table E.1).
pub fn step(precision: u32, band: Band, exponent: u8, mantissa: u16) -> f32 {
    let rb = precision as i32 + band.log_gain() as i32;
    (2f64.powi(rb - exponent as i32) * (1.0 + mantissa as f64 / 2048.0)) as f32
}

/// The magnitude of one decoded coefficient after the Maxshift of H.2 with shift `roi`: a magnitude at or above 2^roi
/// belongs to the region and is scaled back down, any other is background as coded. Returns (magnitude, its lowest
/// known plane).
#[inline]
fn unshift(mag: u32, low: u8, roi: u8) -> (u32, u32) {
    if roi > 0 && mag >> roi != 0 {
        (mag >> roi, (low as u32).saturating_sub(roi as u32))
    } else {
        (mag, low as u32)
    }
}

/// Reversible coefficients (E.1.1.2 with a step of 1): the integer magnitudes, with a coefficient whose lowest planes
/// were not decoded placed at the middle of what is left (r = 1/2).
pub fn reversible(d: &Decoded, roi: u8, out: &mut [i32], stride: usize) {
    for y in 0..d.height {
        for x in 0..d.width {
            let i = y * d.width + x;
            let (mag, low) = unshift(d.magnitude[i], d.low[i], roi);
            let mut v = mag as i64;
            if v != 0 && low > 0 {
                v += 1 << (low - 1);
            }
            let v = v.min(i32::MAX as i64) as i32;
            out[y * stride + x] = if d.negative[i] { -v } else { v };
        }
    }
}

/// Irreversible coefficients (Equation E-6): (|q| + r 2^low) * step for a non-zero q, with r = 1/2.
pub fn irreversible(d: &Decoded, roi: u8, delta: f32, out: &mut [f32], stride: usize) {
    for y in 0..d.height {
        for x in 0..d.width {
            let i = y * d.width + x;
            let (mag, low) = unshift(d.magnitude[i], d.low[i], roi);
            let v = if mag == 0 { 0.0 } else { (mag as f64 + 0.5 * (1u64 << low) as f64) * delta as f64 };
            out[y * stride + x] = if d.negative[i] { -v as f32 } else { v as f32 };
        }
    }
}

/// The inverse reversible component transform (Equation G-7).
pub fn inverse_rct(y0: &mut [i32], y1: &mut [i32], y2: &mut [i32]) {
    for ((a, b), c) in y0.iter_mut().zip(y1.iter_mut()).zip(y2.iter_mut()) {
        let g = *a - ((*b + *c) >> 2);
        let r = *c + g;
        let bl = *b + g;
        (*a, *b, *c) = (r, g, bl);
    }
}

/// The inverse irreversible component transform (Equation G-9).
pub fn inverse_ict(y0: &mut [f32], y1: &mut [f32], y2: &mut [f32]) {
    for ((a, b), c) in y0.iter_mut().zip(y1.iter_mut()).zip(y2.iter_mut()) {
        let (y, cb, cr) = (*a, *b, *c);
        *a = y + 1.402 * cr;
        *b = y - 0.344_13 * cb - 0.714_14 * cr;
        *c = y + 1.772 * cb;
    }
}

/// The inverse DC level shift (Equation G-2) and the clamp to the component's range, rounding irreversible samples to
/// the nearest integer.
pub fn level_shift(v: f64, precision: u32, signed: bool) -> i32 {
    let v = v.round() as i64;
    let (lo, hi, shift) = if signed {
        (-(1i64 << (precision - 1)), (1i64 << (precision - 1)) - 1, 0)
    } else {
        (0, (1i64 << precision) - 1, 1i64 << (precision - 1))
    };
    (v + shift).clamp(lo, hi) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(mag: &[u32], neg: &[bool], low: &[u8]) -> Decoded {
        Decoded { width: mag.len(), height: 1, magnitude: mag.to_vec(), negative: neg.to_vec(), low: low.to_vec() }
    }

    #[test]
    fn step_follows_equation_e3() {
        // 8-bit HH (gain 2): Rb = 10; epsilon 8 and mu 1024 give 4 * 1.5.
        assert_eq!(step(8, Band::HH, 8, 1024), 6.0);
        assert_eq!(step(8, Band::LL, 8, 0), 1.0);
        assert_eq!(planes(2, 9), 10);
    }

    #[test]
    fn reversible_midpoint_only_where_planes_were_cut() {
        let d = decoded(&[5, 8, 0, 12], &[false, true, true, false], &[0, 2, 3, 2]);
        let mut out = [0; 4];
        reversible(&d, 0, &mut out, 4);
        assert_eq!(out, [5, -10, 0, 14]);
    }

    #[test]
    fn maxshift_separates_region_from_background() {
        // Shift 4: 0b1010_0000 is a region coefficient (10), 0b1001 background (9).
        let d = decoded(&[0xa0, 9], &[false, true], &[0, 0]);
        let mut out = [0; 2];
        reversible(&d, 4, &mut out, 2);
        assert_eq!(out, [10, -9]);
        // A region coefficient cut at plane 5 keeps one cut plane after the shift.
        let d = decoded(&[0xa0], &[false], &[5]);
        let mut out = [0; 1];
        reversible(&d, 4, &mut out, 1);
        assert_eq!(out, [11]);
    }

    #[test]
    fn irreversible_reconstructs_at_the_bin_middle() {
        let d = decoded(&[0, 3, 4], &[false, true, false], &[0, 0, 2]);
        let mut out = [0.0; 3];
        irreversible(&d, 0, 2.0, &mut out, 3);
        assert_eq!(out, [0.0, -7.0, 12.0]);
    }

    #[test]
    fn rct_inverts_the_forward_transform() {
        for (r, g, b) in [(0, 0, 0), (255, 0, 17), (3, 200, 255), (-40, 77, 12)] {
            // Equation G-6.
            let y0 = (r + 2 * g + b) >> 2;
            let (y1, y2) = (b - g, r - g);
            let (mut a, mut c1, mut c2) = ([y0], [y1], [y2]);
            inverse_rct(&mut a, &mut c1, &mut c2);
            assert_eq!((a[0], c1[0], c2[0]), (r, g, b));
        }
    }

    #[test]
    fn ict_inverts_the_forward_transform() {
        let (r, g, b) = (200.0f32, 30.0f32, -60.0f32);
        // Equation G-8.
        let y = 0.299 * r + 0.587 * g + 0.114 * b;
        let cb = -0.168_75 * r - 0.331_26 * g + 0.5 * b;
        let cr = 0.5 * r - 0.418_69 * g - 0.081_31 * b;
        let (mut a, mut c1, mut c2) = ([y], [cb], [cr]);
        inverse_ict(&mut a, &mut c1, &mut c2);
        assert!((a[0] - r).abs() < 0.05 && (c1[0] - g).abs() < 0.05 && (c2[0] - b).abs() < 0.05);
    }

    #[test]
    fn level_shift_rounds_and_clamps() {
        assert_eq!(level_shift(-128.0, 8, false), 0);
        assert_eq!(level_shift(127.4, 8, false), 255);
        assert_eq!(level_shift(200.0, 8, false), 255);
        assert_eq!(level_shift(-0.6, 8, false), 127);
        assert_eq!(level_shift(-300.0, 8, true), -128);
        assert_eq!(level_shift(5000.0, 12, false), 4095);
    }
}
