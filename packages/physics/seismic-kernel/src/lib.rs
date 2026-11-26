#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sub, v128, v128_load,
    v128_store,
};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[derive(Clone, Copy)]
struct Column(*mut f64);

impl Column {
    unsafe fn get(self, i: usize) -> f64 {
        unsafe { *self.0.add(i) }
    }

    unsafe fn set(self, i: usize, value: f64) {
        unsafe { *self.0.add(i) = value };
    }

    unsafe fn pair(self, i: usize) -> v128 {
        unsafe { v128_load(self.0.add(i).cast()) }
    }

    unsafe fn write(self, i: usize, v: v128, pair: bool) {
        if pair {
            unsafe { v128_store(self.0.add(i).cast(), v) };
        } else {
            unsafe { self.set(i, f64x2_extract_lane::<0>(v)) };
        }
    }
}

/// Plane-strain velocity–stress step on a Virieux staggered grid. TS allocates eleven columns with a one-cell
/// halo and supplies validated even or odd extents and material coefficients. v_z is stored positive down.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn seismic_step(
    state: *mut f64,
    width: usize,
    depth: usize,
    dx: f64,
    dz: f64,
    dt: f64,
) {
    let pitch = width + 2;
    let count = pitch * (depth + 2);
    let column = |column| Column(unsafe { state.add(column * count) });
    let [
        vx,
        vz,
        sxx,
        szz,
        sxz,
        bx,
        bz,
        lambda,
        mu,
        corner,
        attenuation,
    ] = [
        column(0),
        column(1),
        column(2),
        column(3),
        column(4),
        column(5),
        column(6),
        column(7),
        column(8),
        column(9),
        column(10),
    ];
    let ddx = f64x2_splat(dt / dx);
    let ddz = f64x2_splat(dt / dz);
    let tick = f64x2_splat(dt);
    let one = f64x2_splat(1.0);
    let two = f64x2_splat(2.0);

    unsafe {
        // Zero shear and the odd normal stress extension make the top face traction-free.
        for x in 1..=width {
            let top = x + pitch;
            vz.set(
                x,
                (vz.get(x) + (2.0 * dt / dz) * bz.get(x) * szz.get(top))
                    / (1.0 + dt * attenuation.get(top)),
            );
        }
        for z in 1..=depth {
            for x in (1..=width).step_by(2) {
                let i = z * pitch + x;
                let stretch = f64x2_add(one, f64x2_mul(tick, attenuation.pair(i)));
                let horizontal = f64x2_add(
                    f64x2_mul(ddx, f64x2_sub(sxx.pair(i + 1), sxx.pair(i))),
                    f64x2_mul(ddz, f64x2_sub(sxz.pair(i), sxz.pair(i - pitch))),
                );
                let vertical = f64x2_add(
                    f64x2_mul(ddx, f64x2_sub(sxz.pair(i), sxz.pair(i - 1))),
                    f64x2_mul(ddz, f64x2_sub(szz.pair(i + pitch), szz.pair(i))),
                );
                let add_x = f64x2_mul(bx.pair(i), horizontal);
                let add_z = f64x2_mul(bz.pair(i), vertical);
                vx.write(
                    i,
                    f64x2_div(f64x2_add(vx.pair(i), add_x), stretch),
                    x < width,
                );
                vz.write(
                    i,
                    f64x2_div(f64x2_add(vz.pair(i), add_z), stretch),
                    x < width,
                );
            }
        }
        for z in 1..=depth {
            for x in (1..=width).step_by(2) {
                let i = z * pitch + x;
                let stretch = f64x2_add(one, f64x2_mul(tick, attenuation.pair(i)));
                let dx_x = f64x2_mul(ddx, f64x2_sub(vx.pair(i), vx.pair(i - 1)));
                let dz_z = f64x2_mul(ddz, f64x2_sub(vz.pair(i), vz.pair(i - pitch)));
                let compress = f64x2_mul(lambda.pair(i), f64x2_add(dx_x, dz_z));
                let shear = f64x2_mul(two, mu.pair(i));
                let add_xx = f64x2_add(compress, f64x2_mul(shear, dx_x));
                let add_zz = f64x2_add(compress, f64x2_mul(shear, dz_z));
                let shear_rate = f64x2_add(
                    f64x2_mul(ddz, f64x2_sub(vx.pair(i + pitch), vx.pair(i))),
                    f64x2_mul(ddx, f64x2_sub(vz.pair(i + 1), vz.pair(i))),
                );
                let add_xz = f64x2_mul(corner.pair(i), shear_rate);
                sxx.write(
                    i,
                    f64x2_div(f64x2_add(sxx.pair(i), add_xx), stretch),
                    x < width,
                );
                szz.write(
                    i,
                    f64x2_div(f64x2_add(szz.pair(i), add_zz), stretch),
                    x < width,
                );
                sxz.write(
                    i,
                    f64x2_div(f64x2_add(sxz.pair(i), add_xz), stretch),
                    x < width,
                );
            }
        }
    }
}
