#![no_std]

use core::arch::wasm32::{
    f64x2_add, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sub, v128_load, v128_store,
};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

/// Implicit Pringle mass transport in x = sqrt(r). The backward-Euler matrix is an M-matrix.
/// # Safety
/// All pointers are disjoint f64 arena leases. `config` contains four n-word columns and n+1 face conductances.
/// `scratch` contains n pivots and n right hand sides. The outputs have n entries, except `flux` (n+1)
/// and `budget` (five). The caller validates coefficients, reserves the Wasm stack, and provides n >= 1.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn accretion_step(
    n: usize,
    config: *const f64,
    scratch: *mut f64,
    mass: *mut f64,
    density: *mut f64,
    heat: *mut f64,
    phase: *mut f64,
    flux: *mut f64,
    budget: *mut f64,
    dt: f64,
    feed: f64,
) {
    unsafe {
        let inv_area = config.add(n);
        let omega = inv_area.add(n);
        let heat_factor = omega.add(n);
        let face = heat_factor.add(n);
        let rhs = scratch.add(n);
        let mut residual_fraction = 1.0;
        let mut elimination = 0.0;
        // The raw pivot subtraction is replaced by the positive residual/pivot ratio of the previous row.
        for i in 0..n {
            let left = dt * *face.add(i);
            let right = dt * *face.add(i + 1);
            let w = *config.add(i);
            let residual = 1.0 + (left * w) * residual_fraction;
            let diagonal = residual + right * w;
            let original = *mass.add(i) + if i + 1 == n { dt * feed } else { 0.0 };
            *rhs.add(i) = original
                + if i == 0 {
                    0.0
                } else {
                    elimination * *rhs.add(i - 1)
                };
            *scratch.add(i) = diagonal;
            residual_fraction = residual / diagonal;
            elimination = (right * w) / diagonal;
        }
        for i in (0..n).rev() {
            let d = *scratch.add(i);
            let next = if i + 1 == n {
                0.0
            } else {
                ((dt * *face.add(i + 1)) * *config.add(i + 1) / d) * *mass.add(i + 1)
            };
            *mass.add(i) = *rhs.add(i) / d + next;
        }
        let mut previous = 0.0;
        let mut total_mass = 0.0;
        let mut luminosity = 0.0;
        for i in 0..n {
            let current = *mass.add(i) * *config.add(i);
            *flux.add(i) = *face.add(i) * (current - previous);
            previous = current;
            total_mass += *mass.add(i);
        }
        *flux.add(n) = feed - *face.add(n) * previous;
        *budget += dt * feed;
        *budget.add(1) += dt * *flux;
        *budget.add(2) += dt * (*face.add(n) * previous);
        *budget.add(3) = total_mass;

        let step = f64x2_splat(dt);
        let tau = core::f64::consts::TAU;
        let period = f64x2_splat(tau);
        let inverse_period = f64x2_splat(1.0 / tau);
        let mut i = 0;
        while i + 1 < n {
            let sigma = f64x2_mul(
                v128_load(mass.add(i).cast()),
                v128_load(inv_area.add(i).cast()),
            );
            v128_store(density.add(i).cast(), sigma);
            v128_store(
                heat.add(i).cast(),
                f64x2_mul(sigma, v128_load(heat_factor.add(i).cast())),
            );
            let angle = f64x2_add(
                v128_load(phase.add(i).cast()),
                f64x2_mul(step, v128_load(omega.add(i).cast())),
            );
            let turns = f64x2_floor(f64x2_mul(angle, inverse_period));
            v128_store(
                phase.add(i).cast(),
                f64x2_sub(angle, f64x2_mul(period, turns)),
            );
            i += 2;
        }
        if i < n {
            *density.add(i) = *mass.add(i) * *inv_area.add(i);
            *heat.add(i) = *density.add(i) * *heat_factor.add(i);
            let angle = *phase.add(i) + dt * *omega.add(i);
            *phase.add(i) = angle
                - tau
                    * core::arch::wasm32::f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(
                        angle * (1.0 / tau),
                    )));
        }
        for i in 0..n {
            luminosity += (2.0 * *heat.add(i)) / *inv_area.add(i);
        }
        *budget.add(4) = luminosity;
    }
}
