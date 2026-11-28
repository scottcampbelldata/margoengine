#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_extract_lane, f64x2_max, f64x2_min, f64x2_mul, f64x2_splat, f64x2_sub,
};
use margoengine_physics_kernel_common::pinned::{exp, pow};

const MODEL_WORDS: usize = 9;
const CLIMATE_WORDS: usize = 10;
const HISTORY_WORDS: usize = 5;
const SURFACE_WORDS: usize = 7;
const AGEING_YEAR: f64 = 365.25 * 86400.0;
const STEEL_RATIO: f64 = (0.159687 * 7870.0) / (2.0 * 0.055845 * 5240.0);
const COPPER_RATIO: f64 = (0.143091 * 8960.0) / (2.0 * 0.063546 * 6000.0);
const COPPER_CARBONATE_RATIO: f64 = (0.221116 * 8960.0) / (2.0 * 0.063546 * 4000.0);
const FARADAY: f64 = 96485.33212331002;
const CALCITE_MOLAR_MASS: f64 = 0.1000869;
const CALCITE_DENSITY: f64 = 2710.0;
const NEUTRAL_RECESSION: f64 = 18.8e-6;

// This optional module uses only solver-owned regions despite linking the pinned math crate.
struct ArenaOnly;

unsafe impl core::alloc::GlobalAlloc for ArenaOnly {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }
    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

#[global_allocator]
static NO_HEAP: ArenaOnly = ArenaOnly;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Work {
    patches: f64,
    paired_patches: f64,
    steel: f64,
    copper: f64,
    wood: f64,
    limestone: f64,
}

#[repr(C)]
struct Job {
    model: *const [f64; MODEL_WORDS],
    history: *mut [f64; HISTORY_WORDS],
    surface: *mut [f64; SURFACE_WORDS],
    climate: *const [f64; CLIMATE_WORDS],
    count: usize,
    work: *mut Work,
    seconds: f64,
}

const _: [(); 32] = [(); size_of::<Job>()];

fn min(a: f64, b: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_min(f64x2_splat(a), f64x2_splat(b)))
}
fn max(a: f64, b: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_max(f64x2_splat(a), f64x2_splat(b)))
}
fn unit(x: f64) -> f64 {
    max(0.0, min(1.0, x))
}

fn corrosion_rate(steel: bool, temp: f64, rh: f64, sulphur: f64, chloride: f64) -> f64 {
    let t = temp - 10.0;
    if steel {
        let adjustment = t * if t <= 0.0 { 0.15 } else { -0.054 };
        1e-6 * (1.77 * pow(sulphur, 0.52) * exp(0.02 * rh + adjustment)
            + 0.102 * pow(chloride, 0.62) * exp(0.033 * rh + 0.04 * temp))
    } else {
        let adjustment = t * if t <= 0.0 { 0.126 } else { -0.08 };
        1e-6 * (0.0053 * pow(sulphur, 0.26) * exp(0.059 * rh + adjustment)
            + 0.01025 * pow(chloride, 0.27) * exp(0.036 * rh + 0.049 * temp))
    }
}

fn advance_atmospheric(loss: f64, annual: f64, exponent: f64, transition: f64, years: f64) -> f64 {
    if annual == 0.0 || years == 0.0 {
        return loss;
    }
    let value = loss / annual;
    let slope = (exponent * transition) / 20.0;
    if value >= transition {
        return loss + annual * slope * years;
    }
    let age = pow(value, 1.0 / exponent) + years;
    let next = if age <= 20.0 {
        pow(age, exponent)
    } else {
        transition + slope * (age - 20.0)
    };
    max(loss, annual * next)
}

fn wood_rates(tc: f64, rh: f64) -> (f64, f64) {
    if tc < 0.0 || tc > 30.0 || rh < 95.0 {
        return (-1.0 / 17520.0, 0.0);
    }
    let time =
        (720.0 * (2.3 * tc + 0.035 * rh - 0.024 * tc * rh)) / (-42.0 + 0.14 * tc + 0.45 * rh);
    (
        1.0 / time,
        max(0.0, -0.0596 + 0.000196 * tc + 0.000625 * rh) / 100.0,
    )
}

fn one_minus_exp(x: f64) -> f64 {
    if x >= 1e-3 {
        return 1.0 - exp(-x);
    }
    x * (1.0 - x * (1.0 / 2.0 - x * (1.0 / 6.0 - x * (1.0 / 24.0 - x * (1.0 / 120.0 - x / 720.0)))))
}

/// Material-specific reactions driven by the common paired exposure and climate terms.
fn advance(
    model: &[f64; MODEL_WORDS],
    climate: &[f64; CLIMATE_WORDS],
    state: &mut [f64; HISTORY_WORDS],
    seconds: f64,
    tc: f64,
    rh: f64,
    elapsed: f64,
) -> bool {
    let [
        material,
        thickness,
        _,
        _,
        _,
        settlement,
        wet_removal,
        dry_removal,
        transition,
    ] = *model;
    let [_, _, sulphur, chloride, wet, rain, ph, current, dry, larvae] = *climate;
    let metal = material < 2.0;
    let steel = material == 0.0;
    let mut loss = state[1];
    if metal && loss < thickness {
        let prior = state[0];
        let annual = if wet < 1.0 {
            corrosion_rate(steel, tc, rh, sulphur, chloride)
        } else {
            0.0
        };
        let exponent = if steel { 0.523 } else { 0.667 };
        let next = advance_atmospheric(
            prior,
            annual,
            exponent,
            transition,
            ((1.0 - wet) * seconds) / AGEING_YEAR,
        );
        let immersion = if steel {
            (current * 0.055845) / (2.0 * FARADAY * 7870.0)
        } else {
            (current * 0.063546) / (2.0 * FARADAY * 8960.0)
        };
        loss += next - prior + immersion * (wet * seconds);
        state[0] = min(thickness, next);
    } else if material == 2.0 {
        let (activation, decay) = wood_rates(tc, rh);
        let hours = (seconds * (1.0 - wet)) / 3600.0;
        let active = state[3];
        let wait = if activation > 0.0 {
            (1.0 - active) / activation
        } else {
            f64::INFINITY
        };
        loss += thickness * decay * max(0.0, hours - wait);
        state[3] = unit(active + hours * activation);
    } else if material == 3.0 {
        let excess = max(0.0, pow(10.0, -ph) - pow(10.0, -5.6));
        let carbonate = rain
            * (NEUTRAL_RECESSION
                + (1000.0 * excess * CALCITE_MOLAR_MASS) / (2.0 * CALCITE_DENSITY))
            + dry;
        loss += carbonate * (1.0 - wet) * seconds;
    }
    state[1] = min(thickness, loss);
    let recruit = wet * larvae * settlement;
    let remove = wet * wet_removal + (1.0 - wet) * dry_removal;
    let rate = recruit + remove;
    if rate != 0.0 {
        let cover = state[2];
        state[2] = unit(cover + (recruit / rate - cover) * one_minus_exp(rate * seconds));
    }
    state[4] = elapsed;
    state.iter().all(|value| value.is_finite())
}

fn publish(
    model: &[f64; MODEL_WORDS],
    state: &[f64; HISTORY_WORDS],
    remaining: f64,
) -> [f64; SURFACE_WORDS] {
    let material = model[0];
    let retention = model[3];
    let inner_scale = model[4];
    let lost = state[1];
    let inner_consumed = if material == 1.0 {
        inner_scale * one_minus_exp(lost / inner_scale)
    } else {
        lost
    };
    let inner = if material == 0.0 {
        inner_consumed * STEEL_RATIO * retention
    } else if material == 1.0 {
        inner_consumed * COPPER_RATIO * retention
    } else {
        0.0
    };
    let outer = if material == 1.0 {
        max(0.0, lost - inner_consumed) * COPPER_CARBONATE_RATIO * retention
    } else {
        0.0
    };
    [
        remaining,
        lost,
        inner + outer,
        inner,
        state[3],
        state[2],
        state[4],
    ]
}

/// An independent pair range changes only trial patches and leaves their input climate immutable.
#[unsafe(no_mangle)]
unsafe extern "C" fn ageing_thread_phase(job: &Job, stage: u32, part: usize, parts: usize) -> u32 {
    if stage != 0
        || !matches!(parts, 1 | 2 | 4)
        || part >= parts
        || job.count == 0
        || job.count > isize::MAX as usize / size_of::<[f64; CLIMATE_WORDS]>()
        || !job.seconds.is_finite()
        || job.seconds < 0.0
    {
        return 1;
    }
    let pairs = job.count / 2;
    let first = 2 * (part * pairs / parts);
    let end = if part + 1 == parts {
        job.count
    } else {
        2 * ((part + 1) * pairs / parts)
    };
    let mut counts = [0.0; 4];
    for row in (first..end).step_by(2) {
        let paired = row + 1 < end;
        let second = row + usize::from(paired);
        unsafe {
            let first_model = &*job.model.add(row);
            let second_model = &*job.model.add(second);
            let first_climate = &*job.climate.add(row);
            let second_climate = &*job.climate.add(second);
            // These independent physical terms use both lanes for every complete pair.
            let time = f64x2_mul(
                f64x2_splat(job.seconds),
                f64x2(first_model[2], second_model[2]),
            );
            let tc = f64x2_sub(
                f64x2(first_climate[0], second_climate[0]),
                f64x2_splat(273.15),
            );
            let humidity = f64x2_mul(
                f64x2_splat(100.0),
                f64x2(first_climate[1], second_climate[1]),
            );
            let elapsed = f64x2_add(
                f64x2((*job.history.add(row))[4], (*job.history.add(second))[4]),
                time,
            );
            for lane in 0..(1 + usize::from(paired)) {
                let model = &*job.model.add(row + lane);
                let climate = &*job.climate.add(row + lane);
                let history = &mut *job.history.add(row + lane);
                let material = model[0] as usize;
                if material > 3
                    || model[0] != material as f64
                    || !model
                        .iter()
                        .chain(climate)
                        .chain(history.iter())
                        .all(|v| v.is_finite())
                {
                    return 1;
                }
                let (time, tc, rh, elapsed) = if lane == 0 {
                    (
                        f64x2_extract_lane::<0>(time),
                        f64x2_extract_lane::<0>(tc),
                        f64x2_extract_lane::<0>(humidity),
                        f64x2_extract_lane::<0>(elapsed),
                    )
                } else {
                    (
                        f64x2_extract_lane::<1>(time),
                        f64x2_extract_lane::<1>(tc),
                        f64x2_extract_lane::<1>(humidity),
                        f64x2_extract_lane::<1>(elapsed),
                    )
                };
                if !time.is_finite()
                    || !elapsed.is_finite()
                    || !advance(model, climate, history, time, tc, rh, elapsed)
                {
                    return 1;
                }
                counts[material] += 1.0;
            }
            let remaining = f64x2_sub(
                f64x2(first_model[1], second_model[1]),
                f64x2((*job.history.add(row))[1], (*job.history.add(second))[1]),
            );
            let first_out = publish(
                first_model,
                &*job.history.add(row),
                f64x2_extract_lane::<0>(remaining),
            );
            if !first_out.iter().all(|v| v.is_finite()) {
                return 1;
            }
            job.surface.add(row).write(first_out);
            if paired {
                let second_out = publish(
                    second_model,
                    &*job.history.add(second),
                    f64x2_extract_lane::<1>(remaining),
                );
                if !second_out.iter().all(|v| v.is_finite()) {
                    return 1;
                }
                job.surface.add(second).write(second_out);
            }
        }
    }
    unsafe {
        job.work.add(part).write(Work {
            patches: (end - first) as f64,
            paired_patches: ((end - first) & !1) as f64,
            steel: counts[0],
            copper: counts[1],
            wood: counts[2],
            limestone: counts[3],
        });
    }
    0
}
