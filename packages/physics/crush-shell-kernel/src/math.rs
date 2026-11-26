use core::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};

#[inline]
pub(crate) fn sqrt(value: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};
        f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
    }
    #[cfg(not(target_arch = "wasm32"))]
    value.sqrt()
}

/// Argument reduction followed by the alternating arctangent power series.
/// On the reduced interval its first omitted term is less than 5e-18 radians.
pub(crate) fn atan2(y: f64, x: f64) -> f64 {
    let a = x.abs();
    let b = y.abs();
    if a == 0.0 && b == 0.0 {
        return 0.0;
    }
    let swapped = b > a;
    let ratio = a.min(b) / a.max(b);
    let (target, offset) = if ratio > 0.41421356237309503 {
        ((ratio - 1.0) / (ratio + 1.0), FRAC_PI_4)
    } else {
        (ratio, 0.0)
    };
    let negative_square = -target * target;
    let mut polynomial = 1.0 / 39.0;
    for degree in (0..19).rev() {
        polynomial = 1.0 / (2 * degree + 1) as f64 + negative_square * polynomial;
    }
    let acute = offset + target * polynomial;
    let quadrant = if swapped { FRAC_PI_2 - acute } else { acute };
    let angle = if x < 0.0 { PI - quadrant } else { quadrant };
    angle.copysign(y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argument_reduction_matches_all_quadrants_and_axes() {
        for i in -50..=50 {
            for j in -50..=50 {
                let y = i as f64 / 50.0;
                let x = j as f64 / 50.0;
                assert!((atan2(y, x) - y.atan2(x)).abs() < 9e-16);
            }
        }
    }
}
