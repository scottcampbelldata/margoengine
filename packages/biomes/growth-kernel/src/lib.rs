#![no_std]

use core::arch::wasm32::{f64x2, f64x2_add, v128_load, v128_store};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// Deposit the square layer of a pyramidal penumbra. The caller owns and zeros the
// f64 grid, and each deposit lies within the declared rows and planes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deposit_shadow(
    grid: *mut f64,
    nx: i32,
    ny: i32,
    nz: i32,
    x: i32,
    y: i32,
    z: i32,
    depth: i32,
    strength: f64,
    transmission: f64,
) {
    let mut amount = strength;
    for d in 0..=depth.min(y) {
        let x0 = (x - d).max(0);
        let x1 = (x + d).min(nx - 1);
        let z0 = (z - d).max(0);
        let z1 = (z + d).min(nz - 1);
        let wide = f64x2(amount, amount);
        for row in z0..=z1 {
            let offset = (row * ny + y - d) * nx;
            let mut column = x0;
            while column < x1 {
                // X is contiguous. Vector stores preserve the per-deposit accumulation order.
                let cell = unsafe { grid.add((offset + column) as usize) }.cast();
                unsafe { v128_store(cell, f64x2_add(v128_load(cell), wide)) };
                column += 2;
            }
            if column == x1 {
                let cell = unsafe { grid.add((offset + column) as usize) };
                unsafe { *cell += amount };
            }
        }
        amount *= transmission;
    }
}
