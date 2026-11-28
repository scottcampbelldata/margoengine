#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, v128_load};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

struct Grid {
    nx: usize,
    ny: usize,
    nz: usize,
    pitch: usize,
    slab: usize,
    words: usize,
}

impl Grid {
    fn new(nx: usize, ny: usize, nz: usize) -> Option<Self> {
        if nx < 3 || ny < 3 || nz < 3 {
            return None;
        }
        let pitch = nx.checked_add(2)?;
        let slab = pitch.checked_mul(ny.checked_add(2)?)?;
        let words = slab.checked_mul(nz.checked_add(2)?)?;
        if words > isize::MAX as usize / core::mem::size_of::<f64>() {
            return None;
        }
        Some(Self {
            nx,
            ny,
            nz,
            pitch,
            slab,
            words,
        })
    }

    unsafe fn mirror_z(&self, values: *mut f64) {
        unsafe {
            for y in 1..=self.ny {
                let near = self.slab + y * self.pitch;
                let far = self.nz * self.slab + y * self.pitch;
                core::ptr::copy_nonoverlapping(
                    values.add(near + 1),
                    values.add(near + 1 - self.slab),
                    self.nx,
                );
                core::ptr::copy_nonoverlapping(
                    values.add(far + 1),
                    values.add(far + 1 + self.slab),
                    self.nx,
                );
            }
        }
    }

    unsafe fn mirror_x(&self, values: *mut f64, row: usize) {
        unsafe {
            *values.add(row) = *values.add(row + 1);
            *values.add(row + self.nx + 1) = *values.add(row + self.nx);
        }
    }

    #[inline]
    unsafe fn sweep_row(
        &self,
        source: *const f64,
        target: *mut f64,
        forcing: *const f64,
        mask: *const u8,
        row: usize,
    ) -> f64 {
        let one_sixth = f64x2_splat(1.0 / 6.0);
        let mut residual = 0.0;
        unsafe {
            let load = |at| v128_load(source.add(at).cast());
            for x in (1..=self.nx).step_by(2) {
                let at = row + x;
                let xy = f64x2_add(
                    f64x2_add(load(at - 1), load(at + 1)),
                    f64x2_add(load(at - self.pitch), load(at + self.pitch)),
                );
                let z_rhs = f64x2_add(
                    f64x2_add(load(at - self.slab), load(at + self.slab)),
                    v128_load(forcing.add(at).cast()),
                );
                let trial = f64x2_mul(f64x2_add(xy, z_rhs), one_sixth);
                let v0 = *source.add(at);
                let v1 = *source.add(at + 1);
                let q0 = if *mask.add(at) == 0 {
                    f64x2_extract_lane::<0>(trial)
                } else {
                    v0
                };
                let correction0 = (q0 - v0).abs();
                if !correction0.is_finite() {
                    return f64::INFINITY;
                }
                *target.add(at) = q0;
                residual = f64::max(residual, correction0);
                if x < self.nx {
                    let q1 = if *mask.add(at + 1) == 0 {
                        f64x2_extract_lane::<1>(trial)
                    } else {
                        v1
                    };
                    let correction1 = (q1 - v1).abs();
                    if !correction1.is_finite() {
                        return f64::INFINITY;
                    }
                    *target.add(at + 1) = q1;
                    residual = f64::max(residual, correction1);
                }
            }
        }
        residual
    }
}

/// Solves the cubic finite-difference Poisson equation. Nonzero mask cells keep their Dirichlet value.
/// The side halos mirror the nearest cell for insulation. The host supplies disjoint, padded columns.
/// Returns positive infinity for an unrepresentable correction, and the host discards the candidate.
/// If non-null, the receipt holds the number of completed sweeps on successful return.
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
    completed_sweeps: *mut u32,
) -> f64 {
    let Some(grid) = Grid::new(nx, ny, nz) else {
        return f64::INFINITY;
    };
    let mut a = potential;
    let mut b = scratch;
    let mut residual = 0.0;
    let mut completed = 0;
    unsafe {
        for _ in 0..sweeps {
            grid.mirror_z(a);
            residual = 0.0;
            for z in 1..=grid.nz {
                for y in 1..=grid.ny {
                    let row = z * grid.slab + y * grid.pitch;
                    grid.mirror_x(a, row);
                    let local = grid.sweep_row(a, b, forcing, mask, row);
                    if !local.is_finite() {
                        return f64::INFINITY;
                    }
                    residual = f64::max(residual, local);
                }
            }
            completed += 1;
            core::mem::swap(&mut a, &mut b);
            if residual <= tolerance {
                break;
            }
        }
        if a != potential {
            core::ptr::copy_nonoverlapping(a, potential, grid.words);
        }
        if !completed_sweeps.is_null() {
            completed_sweeps.write(completed);
        }
    }
    residual
}

/// Writes all insulated halos before any worker reads this sweep's source buffer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn relax_prepare(source: *mut f64, nx: usize, ny: usize, nz: usize) {
    let Some(grid) = Grid::new(nx, ny, nz) else {
        return;
    };
    unsafe {
        grid.mirror_z(source);
        for z in 1..=grid.nz {
            for y in 1..=grid.ny {
                grid.mirror_x(source, z * grid.slab + y * grid.pitch);
            }
        }
    }
}

#[repr(C)]
pub struct RelaxJob {
    source: u32,
    target: u32,
    forcing: u32,
    mask: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    residuals: u32,
}

const _: () = assert!(core::mem::size_of::<RelaxJob>() == 32);

/// Stage 0 owns complete, disjoint output rows and reads immutable source halos.
/// Writes the local max correction (positive infinity on overflow) in part order.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lightning_thread_phase(
    job: *const RelaxJob,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    if stage != 0 || part >= parts {
        return 1;
    }
    unsafe {
        let Some(job) = job.as_ref() else {
            return 1;
        };
        let Some(grid) = Grid::new(job.nx as usize, job.ny as usize, job.nz as usize) else {
            return 1;
        };
        let rows = (grid.ny * grid.nz) as u64;
        let parts = u64::from(parts);
        let part64 = u64::from(part);
        let low = (part64 * rows / parts) as usize;
        let high = ((part64 + 1) * rows / parts) as usize;
        let residuals = job.residuals as *mut f64;
        let mut residual = 0.0;
        for index in low..high {
            let z = index / grid.ny + 1;
            let y = index % grid.ny + 1;
            let row = z * grid.slab + y * grid.pitch;
            let local = grid.sweep_row(
                job.source as *const f64,
                job.target as *mut f64,
                job.forcing as *const f64,
                job.mask as *const u8,
                row,
            );
            if !local.is_finite() {
                residuals.add(part as usize).write(f64::INFINITY);
                return 1;
            }
            residual = f64::max(residual, local);
        }
        residuals.add(part as usize).write(residual);
    }
    0
}
