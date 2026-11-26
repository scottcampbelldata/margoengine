#![no_std]

use core::arch::wasm32::{f64x2_add, f64x2_mul, f64x2_splat, v128_load, v128_store};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

/// Advance the pressure field in two lanes over each pair of sites, and record the receiver sample at each substep.
/// The grid includes one ghost cell on each side. Guard plus solid cells stay zero. Three coefficient columns contain
/// (2-lambda² N_open), (D-1), and mask/(1+D). For a wall D=lambda*wall_admittance/2 per closed face.
/// # Safety
/// All pointer ranges are disjoint world arena leases and 8-byte aligned. Pressure arrays have n words, coefficients
/// 3*n words, and forcing and trace samples words each. row and plane are padded strides; n is three or more planes
/// with even row stride and plane width. Source and receiver are interior air sites.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn acoustic_wave(
    mut current: *mut f64,
    mut previous: *mut f64,
    coefficients: *const f64,
    input: *const f64,
    out: *mut f64,
    n: usize,
    row: usize,
    plane: usize,
    source: usize,
    receiver: usize,
    samples: usize,
    lambda_squared: f64,
) {
    let lambda_squared = f64x2_splat(lambda_squared);
    unsafe {
        let old_weight = coefficients.add(n);
        let damping = old_weight.add(n);
        for sample in 0..samples {
            let stop = n - plane;
            let mut i = plane;
            while i < stop {
                let at = current.add(i);
                let px = f64x2_add(v128_load(at.sub(1).cast()), v128_load(at.add(1).cast()));
                let py = f64x2_add(v128_load(at.sub(row).cast()), v128_load(at.add(row).cast()));
                let pz = f64x2_add(
                    v128_load(at.sub(plane).cast()),
                    v128_load(at.add(plane).cast()),
                );
                let neighbours = f64x2_add(f64x2_add(px, py), pz);
                let centre = f64x2_mul(v128_load(coefficients.add(i).cast()), v128_load(at.cast()));
                let write = previous.add(i);
                let past = f64x2_mul(v128_load(old_weight.add(i).cast()), v128_load(write.cast()));
                let stress = f64x2_add(
                    f64x2_add(centre, past),
                    f64x2_mul(lambda_squared, neighbours),
                );
                v128_store(
                    write.cast(),
                    f64x2_mul(v128_load(damping.add(i).cast()), stress),
                );
                i += 2;
            }
            *previous.add(source) += *input.add(sample);
            *out.add(sample) = *previous.add(receiver);
            core::mem::swap(&mut current, &mut previous);
        }
    }
}
