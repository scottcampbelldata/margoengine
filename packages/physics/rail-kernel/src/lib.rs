#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2_add, f64x2_mul, f64x2_splat, f64x2_sub, v128, v128_load, v128_store,
};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

/// The two vector lanes carry lateral and vertical displacement. The world allocates all three columns.
/// Anchor nodes stay fixed. Separate velocity and position passes avoid reading already advanced neighbours.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rail_wire_step(
    position: *mut v128,
    velocity: *mut v128,
    force: *const v128,
    nodes: usize,
    intervals: usize,
    tension_per_mass_dx2: f64,
    inverse_mass: f64,
    damping: f64,
    dt: f64,
) {
    let two = f64x2_splat(2.0);
    let c2 = f64x2_splat(tension_per_mass_dx2);
    let inv_m = f64x2_splat(inverse_mass);
    let retain = f64x2_splat(1.0 - dt * damping);
    let h = f64x2_splat(dt);
    for i in 1..nodes - 1 {
        if i % intervals == 0 {
            continue;
        }
        unsafe {
            let d = v128_load(position.add(i));
            let laplacian = f64x2_sub(
                f64x2_add(
                    v128_load(position.add(i - 1)),
                    v128_load(position.add(i + 1)),
                ),
                f64x2_mul(two, d),
            );
            let accel = f64x2_add(
                f64x2_mul(c2, laplacian),
                f64x2_mul(inv_m, v128_load(force.add(i))),
            );
            let v = f64x2_add(
                f64x2_mul(retain, v128_load(velocity.add(i))),
                f64x2_mul(h, accel),
            );
            v128_store(velocity.add(i), v);
        }
    }
    for i in 1..nodes - 1 {
        unsafe {
            let d = f64x2_add(
                v128_load(position.add(i)),
                f64x2_mul(h, v128_load(velocity.add(i))),
            );
            v128_store(position.add(i), d);
        }
    }
}
