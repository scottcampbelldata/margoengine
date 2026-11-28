#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_le, f64x2_max,
    f64x2_min, f64x2_mul, f64x2_splat, f64x2_sub, i64x2_bitmask, v128, v128_bitselect,
};

const INPUT_WORDS: usize = 9;
const OUTPUT_WORDS: usize = 4;
const FUSION: f64 = 333500.0;
const STEAM_POINT: f64 = 373.15;
const WATER_HEAT_CAPACITY: f64 = 4180.0;
const VAPORIZATION: f64 = 2257000.0;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Work {
    sites: u32,
    paired_sites: u32,
}

#[repr(C)]
struct Job {
    input: *const f64,
    output: *mut f64,
    work: *mut Work,
    sites: u32,
    dt: f64,
}

const _: [(); 24] = [(); size_of::<Job>()];

fn finite(value: v128) -> bool {
    i64x2_bitmask(f64x2_le(f64x2_abs(value), f64x2_splat(f64::MAX))) == 3
}

fn partition_heat(input: impl Fn(usize) -> v128, dt: v128) -> Option<[v128; OUTPUT_WORDS]> {
    let area = input(0);
    let mass_per_metre = input(1);
    let solid_mass = input(2);
    let extent = input(3);
    let basal_heat = input(4);
    let external_heat = input(5);
    let boundary_meltwater = input(6);
    let freezing_temperature = input(7);
    let unfrozen_drainage = input(8);
    let zero = f64x2_splat(0.0);
    let fusion = f64x2_splat(FUSION);
    let vaporization = f64x2_splat(VAPORIZATION);

    // Keep basal ablation and externally supplied energy separate. Each lane consumes its own meltwater.
    let basal_melt = f64x2_min(
        solid_mass,
        f64x2_div(f64x2_mul(f64x2_mul(basal_heat, area), dt), fusion),
    );
    let offered = f64x2_mul(f64x2_mul(external_heat, area), dt);
    let melted = f64x2_min(
        f64x2_max(zero, f64x2_sub(solid_mass, basal_melt)),
        f64x2_div(offered, fusion),
    );
    let fusion_heat = f64x2_mul(melted, fusion);
    let remaining = f64x2_max(zero, f64x2_sub(offered, fusion_heat));
    let meltwater = f64x2_add(boundary_meltwater, f64x2_add(basal_melt, melted));
    let heat_to_boil = f64x2_mul(
        f64x2_mul(meltwater, f64x2_splat(WATER_HEAT_CAPACITY)),
        f64x2_sub(f64x2_splat(STEAM_POINT), freezing_temperature),
    );
    let steam = f64x2_min(
        meltwater,
        f64x2_div(
            f64x2_max(zero, f64x2_sub(remaining, heat_to_boil)),
            vaporization,
        ),
    );
    let used = f64x2_min(
        offered,
        f64x2_add(
            f64x2_add(fusion_heat, f64x2_min(remaining, heat_to_boil)),
            f64x2_mul(steam, vaporization),
        ),
    );
    let removed = f64x2_add(melted, basal_melt);
    let new_extent = v128_bitselect(
        f64x2_div(
            f64x2_max(zero, f64x2_sub(solid_mass, removed)),
            mass_per_metre,
        ),
        extent,
        f64x2_gt(removed, zero),
    );
    let output = [
        new_extent,
        f64x2_div(
            f64x2_add(f64x2_sub(meltwater, steam), unfrozen_drainage),
            dt,
        ),
        f64x2_div(steam, dt),
        f64x2_div(used, dt),
    ];
    (finite(offered) && output.iter().copied().all(finite)).then_some(output)
}

/// Apply the common fusion, warming and evaporation balance to an independent range of paired sites.
#[unsafe(no_mangle)]
unsafe extern "C" fn ice_thermal_thread_phase(job: &Job, stage: u32, part: u32, parts: u32) -> u32 {
    if stage != 0
        || !matches!(parts, 1 | 2 | 4)
        || part >= parts
        || !job.dt.is_finite()
        || job.dt <= 0.0
    {
        return 1;
    }
    let sites = job.sites as usize;
    if sites == 0 || sites > isize::MAX as usize / (INPUT_WORDS * size_of::<f64>()) {
        return 1;
    }
    // A partition never splits a physical pair. The last partition owns the single odd tail.
    let pairs = sites / 2;
    let first = 2 * (part as usize * pairs / parts as usize);
    let end = if part + 1 == parts {
        sites
    } else {
        2 * ((part + 1) as usize * pairs / parts as usize)
    };
    let dt = f64x2_splat(job.dt);
    for row in (first..end).step_by(2) {
        let paired = row + 1 < end;
        let second_row = row + usize::from(paired);
        let input = |word| unsafe {
            f64x2(
                *job.input.add(row * INPUT_WORDS + word),
                *job.input.add(second_row * INPUT_WORDS + word),
            )
        };
        let Some(output) = partition_heat(input, dt) else {
            return 1;
        };
        for (word, value) in output.into_iter().enumerate() {
            unsafe {
                *job.output.add(row * OUTPUT_WORDS + word) = f64x2_extract_lane::<0>(value);
                if paired {
                    *job.output.add(second_row * OUTPUT_WORDS + word) =
                        f64x2_extract_lane::<1>(value);
                }
            }
        }
    }
    unsafe {
        job.work.add(part as usize).write(Work {
            sites: (end - first) as u32,
            paired_sites: ((end - first) & !1) as u32,
        });
    }
    0
}
