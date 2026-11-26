#![no_std]
use core::arch::wasm32::{
    f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, f64x2_sub, v128_load,
    v128_store,
};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

const ROW: usize = 16;
const AIR: usize = 11;

/// Integrate a frozen environmental flow/drag interval and the liquid d² law.
/// Position and velocity axes X/Y are processed together while Z uses the same scalar order.
/// # Safety
/// parcels and air are disjoint f64 regions of at least count*16 and count*11 words respectively.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn disperse(parcels: *mut f64, air: *const f64, count: usize, dt: f64) {
    unsafe {
        for i in 0..count {
            let p = parcels.add(i * ROW);
            let input = air.add(i * AIR);
            let u = v128_load(input.cast());
            let gravity = v128_load(input.add(3).cast());
            let drag = *input.add(6);
            let velocity_time = *input.add(7);
            let position_time = *input.add(8);
            let old_velocity = v128_load(p.add(3).cast());
            let relative = f64x2_sub(old_velocity, u);
            let delta = f64x2_add(
                f64x2_add(
                    f64x2_mul(u, f64x2_splat(dt)),
                    f64x2_mul(relative, f64x2_splat(velocity_time)),
                ),
                f64x2_mul(gravity, f64x2_splat(position_time)),
            );
            let next = f64x2_add(
                f64x2_add(u, f64x2_mul(relative, f64x2_splat(drag))),
                f64x2_mul(gravity, f64x2_splat(velocity_time)),
            );
            v128_store(p.cast(), f64x2_add(v128_load(p.cast()), delta));
            v128_store(p.add(3).cast(), next);
            let relative_z = *p.add(5) - *input.add(2);
            *p.add(2) +=
                (*input.add(2) * dt + relative_z * velocity_time) + *input.add(5) * position_time;
            *p.add(5) = (*input.add(2) + relative_z * drag) + *input.add(5) * velocity_time;

            let drying = *input.add(9);
            let diameter = *p.add(10);
            let floor = *p.add(11);
            let equilibrium = *input.add(10);
            if drying > 0.0 && diameter > equilibrium {
                let square = (diameter * diameter - dt * drying).max(equilibrium * equilibrium);
                let smaller = f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(square)));
                // Water and dry sea salt have different densities. The dry volume does not evaporate.
                let solute = 1.16 * floor * floor * floor;
                *p.add(9) *= (smaller * smaller * smaller + solute)
                    / (diameter * diameter * diameter + solute);
                *p.add(10) = smaller;
            }
            *p.add(15) += dt;
        }
    }
}
