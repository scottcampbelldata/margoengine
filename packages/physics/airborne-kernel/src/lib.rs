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
    unsafe { disperse_rows(parcels, air, count, dt) };
}

unsafe fn disperse_rows(parcels: *mut f64, air: *const f64, count: usize, dt: f64) -> u32 {
    let mut evaporation_updates = 0;
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
                evaporation_updates += 1;
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
    evaporation_updates
}

#[repr(C)]
struct Job {
    parcels: *mut f64,
    forcing: *const f64,
    count: usize,
    receipts: *mut u32,
    dt: f64,
    reserved: [u32; 2],
}

const _: () = assert!(core::mem::size_of::<Job>() == 32);

unsafe fn apply(job: *const Job, part: u32, parts: u32) -> Option<()> {
    let job = unsafe { job.as_ref()? };
    if part >= parts
        || job.parcels.is_null()
        || job.forcing.is_null()
        || job.count > isize::MAX as usize / (ROW * size_of::<f64>())
        || !(job.dt > 0.0 && job.dt.is_finite())
    {
        return None;
    }
    let count = job.count as u64;
    let start = (u64::from(part) * count / u64::from(parts)) as usize;
    let end = ((u64::from(part) + 1) * count / u64::from(parts)) as usize;
    let rows = end - start;
    // Each native participant writes its own half-open slice of whole
    // parcels. Environmental forcing is immutable through the host join.
    let evaporation_updates = unsafe {
        disperse_rows(
            job.parcels.add(start * ROW),
            job.forcing.add(start * AIR),
            rows,
            job.dt,
        )
    };
    if !job.receipts.is_null() {
        let output = unsafe { job.receipts.add(2 * part as usize) };
        unsafe {
            output.write(rows as u32);
            output.add(1).write(evaporation_updates);
        }
    }
    Some(())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn airborne_apply(job: *const Job) -> u32 {
    u32::from(unsafe { apply(job, 0, 1) }.is_none())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn airborne_thread_phase(
    job: *const Job,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    if stage != 0 {
        return 1;
    }
    u32::from(unsafe { apply(job, part, parts) }.is_none())
}
