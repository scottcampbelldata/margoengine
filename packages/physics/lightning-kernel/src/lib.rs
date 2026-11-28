#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, v128_load};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

/// Solves the cubic finite-difference Poisson equation. Nonzero mask cells keep their Dirichlet value.
/// The side halos mirror the nearest cell for insulation. The host supplies disjoint, padded columns.
/// Returns positive infinity for an unrepresentable correction, and the host discards the candidate.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn relax_potential(
    potential: *mut f64,
    scratch: *mut f64,
    forcing: *const f64,
    mask: *const u8,
    nx: usize,
    ny: usize,
    nz: usize,
    tolerance: f64,
    sweeps: usize,
) -> f64 {
    let pitch = nx + 2;
    let slab = pitch * (ny + 2);
    let length = slab * (nz + 2);
    let n = f64x2_splat(1.0 / 6.0);
    let mut a = potential;
    let mut b = scratch;
    let mut residual = 0.0;
    unsafe {
        for _ in 0..sweeps {
            for y in 1..=ny {
                let near = slab + y * pitch;
                let far = nz * slab + y * pitch;
                core::ptr::copy_nonoverlapping(a.add(near + 1), a.add(near + 1 - slab), nx);
                core::ptr::copy_nonoverlapping(a.add(far + 1), a.add(far + 1 + slab), nx);
            }
            residual = 0.0;
            for z in 1..=nz {
                for y in 1..=ny {
                    let row = z * slab + y * pitch;
                    *a.add(row) = *a.add(row + 1);
                    *a.add(row + nx + 1) = *a.add(row + nx);
                    let load = |at| v128_load(a.add(at).cast());
                    for x in (1..=nx).step_by(2) {
                        let at = row + x;
                        let xy = f64x2_add(
                            f64x2_add(load(at - 1), load(at + 1)),
                            f64x2_add(load(at - pitch), load(at + pitch)),
                        );
                        let z_rhs = f64x2_add(
                            f64x2_add(load(at - slab), load(at + slab)),
                            v128_load(forcing.add(at).cast()),
                        );
                        let trial = f64x2_mul(f64x2_add(xy, z_rhs), n);
                        let v0 = *a.add(at);
                        let v1 = *a.add(at + 1);
                        let q0 = if *mask.add(at) == 0 {
                            f64x2_extract_lane::<0>(trial)
                        } else {
                            v0
                        };
                        let correction0 = (q0 - v0).abs();
                        if !correction0.is_finite() {
                            return f64::INFINITY;
                        }
                        *b.add(at) = q0;
                        residual = f64::max(residual, correction0);
                        if x < nx {
                            let q1 = if *mask.add(at + 1) == 0 {
                                f64x2_extract_lane::<1>(trial)
                            } else {
                                v1
                            };
                            let correction1 = (q1 - v1).abs();
                            if !correction1.is_finite() {
                                return f64::INFINITY;
                            }
                            *b.add(at + 1) = q1;
                            residual = f64::max(residual, correction1);
                        }
                    }
                }
            }
            core::mem::swap(&mut a, &mut b);
            if residual <= tolerance {
                break;
            }
        }
        if a != potential {
            core::ptr::copy_nonoverlapping(a, potential, length);
        }
    }
    residual
}
