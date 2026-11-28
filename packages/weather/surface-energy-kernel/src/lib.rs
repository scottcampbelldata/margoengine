#![no_std]

use core::arch::wasm32::{f64x2, f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sub};
use core::num::NonZeroU64;
use margoengine_physics_kernel_common::pinned::exp;

const FREEZING: f64 = 273.15;
const LATENT_VAPOR: f64 = 2.45e6;
const LATENT_FUSION: f64 = 333700.0;

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
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Patch {
    before: f64,
    liquid_rate: f64,
    snow_rate: f64,
    pressure: f64,
    humidity_air: f64,
    air_temperature: f64,
    deep_temperature: f64,
    sensible: f64,
    vapour: f64,
    conductance: f64,
    emission: f64,
    incoming: f64,
    capacity_rate: f64,
}

#[derive(Default)]
struct Work {
    rows: usize,
    pairs: usize,
    evaluations: f64,
    paired_evaluations: f64,
}

fn minimum(a: f64, b: f64) -> f64 {
    if b.is_nan() || b < a || (b == 0.0 && a == 0.0 && b.is_sign_negative()) {
        b
    } else {
        a
    }
}

impl Patch {
    fn valid(self) -> bool {
        self.before.is_finite()
            && self.before > 0.0
            && self.liquid_rate.is_finite()
            && self.liquid_rate >= 0.0
            && self.snow_rate.is_finite()
            && self.snow_rate >= 0.0
            && self.pressure.is_finite()
            && self.pressure > 0.0
            && self.humidity_air.is_finite()
            && self.humidity_air >= 0.0
            && self.air_temperature.is_finite()
            && self.air_temperature > 0.0
            && self.deep_temperature.is_finite()
            && self.deep_temperature > 0.0
            && self.sensible.is_finite()
            && self.sensible >= 0.0
            && self.vapour.is_finite()
            && self.vapour >= 0.0
            && self.conductance.is_finite()
            && self.conductance >= 0.0
            && self.emission.is_finite()
            && self.emission >= 0.0
            && self.incoming.is_finite()
            && self.incoming >= 0.0
            && self.capacity_rate.is_finite()
            && self.capacity_rate > 0.0
    }

    fn evaporate(self, temperature: f64) -> f64 {
        // FAO-56 Eq. (11), in Pa. Below the liquid-water singularity its value has rounded to zero.
        let celsius = temperature - FREEZING;
        let saturation = if celsius <= -237.3 {
            0.0
        } else {
            minimum(
                self.pressure,
                610.8 * exp((17.27 * celsius) / (celsius + 237.3)),
            )
        };
        let fraction = saturation / self.pressure;
        let humidity = (0.622 * fraction) / (1.0 - 0.378 * fraction);
        minimum(
            self.liquid_rate,
            self.vapour * (humidity - self.humidity_air),
        )
    }

    fn balance(self, temperature: f64) -> f64 {
        let square = temperature * temperature;
        self.capacity_rate * (temperature - self.before) - self.incoming
            + self.emission * (square * square)
            + self.sensible * (temperature - self.air_temperature)
            + self.conductance * (temperature - self.deep_temperature)
            + LATENT_VAPOR * self.evaporate(temperature)
    }
}

fn evaluate(
    patches: [Patch; 2],
    temperatures: [Option<f64>; 2],
    work: &mut Work,
) -> Option<[f64; 2]> {
    let result = match temperatures {
        [Some(t0), Some(t1)] => {
            let [a, b] = patches;
            let t = f64x2(t0, t1);
            let square = f64x2_mul(t, t);
            let retained = f64x2_mul(
                f64x2(a.capacity_rate, b.capacity_rate),
                f64x2_sub(t, f64x2(a.before, b.before)),
            );
            let radiation = f64x2_mul(f64x2(a.emission, b.emission), f64x2_mul(square, square));
            let sensible = f64x2_mul(
                f64x2(a.sensible, b.sensible),
                f64x2_sub(t, f64x2(a.air_temperature, b.air_temperature)),
            );
            let ground = f64x2_mul(
                f64x2(a.conductance, b.conductance),
                f64x2_sub(t, f64x2(a.deep_temperature, b.deep_temperature)),
            );
            let latent = f64x2_mul(
                f64x2_splat(LATENT_VAPOR),
                f64x2(a.evaporate(t0), b.evaporate(t1)),
            );
            let energy = f64x2_sub(retained, f64x2(a.incoming, b.incoming));
            let energy = f64x2_add(
                f64x2_add(f64x2_add(f64x2_add(energy, radiation), sensible), ground),
                latent,
            );
            work.evaluations += 2.0;
            work.paired_evaluations += 1.0;
            [
                f64x2_extract_lane::<0>(energy),
                f64x2_extract_lane::<1>(energy),
            ]
        }
        [Some(t), None] => {
            work.evaluations += 1.0;
            [patches[0].balance(t), 0.0]
        }
        [None, Some(t)] => {
            work.evaluations += 1.0;
            [0.0, patches[1].balance(t)]
        }
        [None, None] => [0.0; 2],
    };
    (result[0].is_finite() && result[1].is_finite()).then_some(result)
}

fn temperatures(patches: [Patch; 2], active: [bool; 2], work: &mut Work) -> Option<[[f64; 4]; 2]> {
    let [a, b] = patches;
    if !a.valid() || (active[1] && !b.valid()) {
        return None;
    }
    let melt_limits = [a.snow_rate * LATENT_FUSION, b.snow_rate * LATENT_FUSION];
    let at_freezing =
        core::array::from_fn(|i| (active[i] && patches[i].snow_rate > 0.0).then_some(FREEZING));
    let freezing = evaluate(patches, at_freezing, work)?;
    let melt_heat: [f64; 2] =
        core::array::from_fn(|i| minimum(melt_limits[i], (-freezing[i]).max(0.0)));
    if !melt_limits[0].is_finite() || !melt_limits[1].is_finite() {
        return None;
    }
    let mut searching = active;
    let mut surface = [FREEZING; 2];
    let mut lo = [0.0; 2];
    let mut hi = [0.0; 2];
    for i in 0..2 {
        let p = patches[i];
        searching[i] = active[i] && !(melt_heat[i] > 0.0 && melt_heat[i] < melt_limits[i]);
        if searching[i] {
            hi[i] = p.before.max(p.air_temperature).max(p.deep_temperature)
                + (p.incoming + LATENT_VAPOR * p.vapour * p.humidity_air) / p.capacity_rate;
            if !hi[i].is_finite() {
                return None;
            }
        }
    }
    let high = evaluate(
        patches,
        core::array::from_fn(|i| searching[i].then_some(hi[i])),
        work,
    )?;
    for i in 0..2 {
        // The analytic bracket can land a few ulps below zero after independent rounding.
        // Bisection's rounded-endpoint rule below still picks the closest endpoint.
        if searching[i] && !(high[i] + melt_heat[i]).is_finite() {
            return None;
        }
    }
    while searching[0] || searching[1] {
        let mid: [f64; 2] = core::array::from_fn(|i| lo[i] + (hi[i] - lo[i]) * 0.5);
        let mut endpoints = [None; 2];
        for i in 0..2 {
            if searching[i] && (mid[i] == lo[i] || mid[i] == hi[i]) {
                endpoints[i] = Some(lo[i]);
                searching[i] = false;
            }
        }
        if endpoints[0].is_some() || endpoints[1].is_some() {
            let low = evaluate(patches, endpoints, work)?;
            let high = evaluate(
                patches,
                core::array::from_fn(|i| endpoints[i].map(|_| hi[i])),
                work,
            )?;
            for i in 0..2 {
                if endpoints[i].is_some() {
                    let low = low[i] + melt_heat[i];
                    let high = high[i] + melt_heat[i];
                    if !low.is_finite() || !high.is_finite() {
                        return None;
                    }
                    surface[i] = if low.abs() < high.abs() { lo[i] } else { hi[i] };
                }
            }
        }
        let residual = evaluate(
            patches,
            core::array::from_fn(|i| searching[i].then_some(mid[i])),
            work,
        )?;
        for i in 0..2 {
            if searching[i] {
                let residual = residual[i] + melt_heat[i];
                if !residual.is_finite() {
                    return None;
                }
                if residual == 0.0 {
                    surface[i] = mid[i];
                    searching[i] = false;
                } else if residual > 0.0 {
                    hi[i] = mid[i];
                } else {
                    lo[i] = mid[i];
                }
            }
        }
    }
    let mut result = [[0.0; 4]; 2];
    for i in 0..2 {
        if active[i] {
            let evaporation = patches[i].evaporate(surface[i]);
            let melt = if melt_heat[i] == melt_limits[i] {
                patches[i].snow_rate
            } else {
                melt_heat[i] / LATENT_FUSION
            };
            if !(surface[i] > 0.0 && evaporation.is_finite() && melt.is_finite()) {
                return None;
            }
            result[i] = [surface[i], evaporation, melt, melt_heat[i]];
        }
    }
    Some(result)
}

/// Solve disjoint whole SIMD pairs, with at most one final scalar patch.
/// # Safety
/// Input and output contain count input patches and four f64 per output patch. All pointers are
/// aligned and disjoint. Receipts hold four f64 per participant. Concurrent callers use distinct parts.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn surface_energy_apply(
    input: *const Patch,
    output: *mut [f64; 4],
    receipts: *mut [f64; 4],
    count: usize,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(parts_wide) = NonZeroU64::new(parts as u64) else {
        return 1;
    };
    if part >= parts {
        return 1;
    }
    let pairs = (count / 2) as u64;
    let lo = 2 * (pairs * part as u64 / parts_wide) as usize;
    let hi = 2 * (pairs * (part as u64 + 1) / parts_wide) as usize;
    let mut work = Work::default();
    unsafe {
        let mut i = lo;
        while i < hi {
            let Some([a, b]) =
                temperatures([*input.add(i), *input.add(i + 1)], [true; 2], &mut work)
            else {
                return 1;
            };
            *output.add(i) = a;
            *output.add(i + 1) = b;
            work.rows += 2;
            work.pairs += 1;
            i += 2;
        }
        if part + 1 == parts && hi < count {
            let tail = *input.add(hi);
            let Some([last, _]) = temperatures([tail; 2], [true, false], &mut work) else {
                return 1;
            };
            *output.add(hi) = last;
            work.rows += 1;
        }
        *receipts.add(part) = [
            work.rows as f64,
            work.pairs as f64,
            work.evaluations,
            work.paired_evaluations,
        ];
    }
    0
}
