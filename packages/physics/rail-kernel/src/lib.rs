#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2_abs, f64x2_add, f64x2_extract_lane, f64x2_le, f64x2_mul, f64x2_splat, f64x2_sqrt,
    f64x2_sub, i64x2_all_true, v128, v128_load, v128_store,
};
use core::num::NonZeroUsize;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Job {
    position: *mut v128,
    velocity: *mut v128,
    force: *const v128,
    receipts: *mut [u32; 2],
    nodes: usize,
    intervals: usize,
    tension_per_mass_dx2: f64,
    inverse_mass: f64,
    damping: f64,
    dt: f64,
}

const _: () = assert!(core::mem::size_of::<Job>() == 56);

#[inline]
fn finite(value: v128) -> bool {
    i64x2_all_true(f64x2_le(f64x2_abs(value), f64x2_splat(f64::MAX)))
}

impl Job {
    fn valid(&self) -> bool {
        if self.nodes < 3
            || self.intervals < 2
            || !self.tension_per_mass_dx2.is_finite()
            || self.tension_per_mass_dx2 <= 0.0
            || !self.inverse_mass.is_finite()
            || self.inverse_mass <= 0.0
            || !self.dt.is_finite()
            || self.dt < 0.0
            || !self.damping.is_finite()
            || self.damping < 0.0
        {
            return false;
        }
        let wave =
            self.dt * f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(self.tension_per_mass_dx2)));
        // With explicit damping d, the highest linear modal stability condition is h² ω² <= 4 - 2 h d.
        // The world clock uses a stronger accuracy margin for both the wire and the collector.
        wave * wave <= 1.0 - 0.5 * self.dt * self.damping
    }
}

/// Shared by the old one-thread ABI and the work-metered phased entry. The two lanes are lateral/up at one node.
/// Velocity reads the frozen displacement stencil. Drift reads only its own row after the full velocity barrier.
unsafe fn advance(job: &Job, stage: u32, lo: usize, hi: usize) -> Result<u32, i32> {
    let two = f64x2_splat(2.0);
    let c2 = f64x2_splat(job.tension_per_mass_dx2);
    let inv_m = f64x2_splat(job.inverse_mass);
    let retain = f64x2_splat(1.0 - job.dt * job.damping);
    let h = f64x2_splat(job.dt);
    let mut rows = 0;
    if stage == 0 {
        let Some(intervals) = NonZeroUsize::new(job.intervals) else {
            return Err(2);
        };
        for i in lo..hi {
            if i % intervals.get() == 0 {
                continue;
            }
            unsafe {
                let d = v128_load(job.position.add(i));
                let laplacian = f64x2_sub(
                    f64x2_add(
                        v128_load(job.position.add(i - 1)),
                        v128_load(job.position.add(i + 1)),
                    ),
                    f64x2_mul(two, d),
                );
                let accel = f64x2_add(
                    f64x2_mul(c2, laplacian),
                    f64x2_mul(inv_m, v128_load(job.force.add(i))),
                );
                let v = f64x2_add(
                    f64x2_mul(retain, v128_load(job.velocity.add(i))),
                    f64x2_mul(h, accel),
                );
                if !finite(v) {
                    return Err(1);
                }
                v128_store(job.velocity.add(i), v);
            }
            rows += 1;
        }
    } else {
        for i in lo..hi {
            unsafe {
                let d = f64x2_add(
                    v128_load(job.position.add(i)),
                    f64x2_mul(h, v128_load(job.velocity.add(i))),
                );
                if !finite(d) {
                    return Err(1);
                }
                v128_store(job.position.add(i), d);
            }
            rows += 1;
        }
    }
    Ok(rows)
}

/// 0 accepts this partition, 1 rejects a nonfinite candidate, and 2 rejects private stage or stability inputs.
#[unsafe(no_mangle)]
unsafe extern "C" fn rail_wire_thread_phase(
    job: *const Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return 2;
    };
    let Some(parts_nz) = NonZeroUsize::new(parts) else {
        return 2;
    };
    if stage > 1 || part >= parts || !job.valid() {
        return 2;
    }
    let interior = (job.nodes - 2) as u64;
    let boundary = |part| 1 + (part as u64 * interior / parts_nz.get() as u64) as usize;
    let rows = match unsafe { advance(job, stage, boundary(part), boundary(part + 1)) } {
        Ok(rows) => rows,
        Err(status) => return status,
    };
    let receipt = unsafe { &mut *job.receipts.add(part) };
    if stage == 0 {
        receipt[0] = rows;
        receipt[1] = 0
    } else {
        receipt[1] = rows
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn rail_wire_apply(job: *const Job) -> i32 {
    let status = unsafe { rail_wire_thread_phase(job, 0, 0, 1) };
    if status != 0 {
        return status;
    }
    unsafe { rail_wire_thread_phase(job, 1, 0, 1) }
}

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
) -> i32 {
    let mut receipt = [0; 2];
    let job = Job {
        position,
        velocity,
        force,
        receipts: &mut receipt,
        nodes,
        intervals,
        tension_per_mass_dx2,
        inverse_mass,
        damping,
        dt,
    };
    unsafe { rail_wire_apply(&job) }
}
