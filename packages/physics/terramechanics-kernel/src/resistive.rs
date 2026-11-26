use core::arch::wasm32::{f64x2, f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sub};

#[repr(C)]
pub(crate) struct Sample {
    x: f64,
    y: f64,
    z: f64,
    depth_area: f64,
    cos_2b: f64,
    sin_2b: f64,
    cos_g: f64,
    sin_g: f64,
}

/// Li, Zhang and Goldman (2013), Eq. 2 and S8–S9. Each lane carries one independent buried element.
///
/// # Safety
/// The host owns aligned, disjoint arrays of nine coefficients, `count` samples and six output words.
/// The sample count is even. The host zero-pads the last lane if necessary.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn resistive(
    coefficients: *const [f64; 9],
    samples: *const Sample,
    count: usize,
    horizontal_x: f64,
    horizontal_z: f64,
    forces: *mut [f64; 6],
) {
    let [a00, a10, b11, b01, b_minus, c11, c01, c_minus, d10] =
        (*coefficients).map(|value| f64x2_splat(value));
    let horizontal_x = f64x2_splat(horizontal_x);
    let horizontal_z = f64x2_splat(horizontal_z);
    let mut totals = [0.0; 6];
    for pair in 0..count / 2 {
        let a = &*samples.add(2 * pair);
        let b = &*samples.add(2 * pair + 1);
        let depth_area = f64x2(a.depth_area, b.depth_area);
        let cos_2b = f64x2(a.cos_2b, b.cos_2b);
        let sin_2b = f64x2(a.sin_2b, b.sin_2b);
        let cos_g = f64x2(a.cos_g, b.cos_g);
        let sin_g = f64x2(a.sin_g, b.sin_g);
        let cos_product = f64x2_mul(cos_2b, cos_g);
        let sin_product = f64x2_mul(sin_2b, sin_g);
        let mixed_a = f64x2_mul(cos_2b, sin_g);
        let mixed_b = f64x2_mul(sin_2b, cos_g);
        let alpha_y = f64x2_add(
            f64x2_add(
                f64x2_add(a00, f64x2_mul(a10, cos_2b)),
                f64x2_mul(b11, f64x2_add(mixed_a, mixed_b)),
            ),
            f64x2_add(
                f64x2_mul(b01, sin_g),
                f64x2_mul(b_minus, f64x2_sub(mixed_a, mixed_b)),
            ),
        );
        let alpha_h = f64x2_add(
            f64x2_add(
                f64x2_mul(c11, f64x2_sub(cos_product, sin_product)),
                f64x2_mul(c01, cos_g),
            ),
            f64x2_add(
                f64x2_mul(c_minus, f64x2_add(cos_product, sin_product)),
                f64x2_mul(d10, sin_2b),
            ),
        );
        let fy = f64x2_mul(depth_area, alpha_y);
        let fh = f64x2_mul(depth_area, alpha_h);
        let fx = f64x2_mul(fh, horizontal_x);
        let fz = f64x2_mul(fh, horizontal_z);
        let rx = f64x2(a.x, b.x);
        let ry = f64x2(a.y, b.y);
        let rz = f64x2(a.z, b.z);
        let tx = f64x2_sub(f64x2_mul(ry, fz), f64x2_mul(rz, fy));
        let ty = f64x2_sub(f64x2_mul(rz, fx), f64x2_mul(rx, fz));
        let tz = f64x2_sub(f64x2_mul(rx, fy), f64x2_mul(ry, fx));
        for (total, values) in totals.iter_mut().zip([fx, fy, fz, tx, ty, tz]) {
            // Preserve the source element order, including the final odd element.
            *total += f64x2_extract_lane::<0>(values);
            *total += f64x2_extract_lane::<1>(values);
        }
    }
    *forces = totals;
}
