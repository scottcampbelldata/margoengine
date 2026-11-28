#![no_std]

use core::arch::wasm32::{
    f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_le, f64x2_mul, f64x2_splat, i64x2_all_true, v128,
    v128_store,
};
use core::num::NonZeroU64;
use core::slice;
use margoengine_physics_kernel_common::pinned::{exp, pow};

const STANDARD_TEMPERATURE: f64 = 293.15;
const STANDARD_PRESSURE: f64 = 101325.0;
const BAND_PAIRS: usize = 4;
const NONFINITE: i32 = 1;
const INVALID_JOB: i32 = 2;

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
struct Sample {
    distance: f64,
    speed: f64,
    temperature: f64,
    pressure: f64,
}

#[repr(C)]
pub struct Job {
    samples: *const Sample,
    first_counts: *const u32,
    total_counts: *const u32,
    output: *mut [f64; 10],
    work: *mut [f64; 4],
    links: usize,
    slots: usize,
    _reserved: u32,
    humidity: f64,
}

fn finite_pair(x: v128) -> bool {
    i64x2_all_true(f64x2_le(f64x2_abs(x), f64x2_splat(f64::MAX)))
}

// ISO 9613-1:1993 equations (3)–(5) and (B.1), at the eight octave centres.
// Share terms independent of frequency, preserving the scalar parenthesization of every band.
fn absorption(temperature: f64, pressure: f64, humidity: f64) -> Option<[v128; BAND_PAIRS]> {
    let tr = temperature / STANDARD_TEMPERATURE;
    let pr = pressure / STANDARD_PRESSURE;
    let saturation = pow(10.0, -6.8346 * pow(273.16 / temperature, 1.261) + 4.6151);
    let h = (100.0 * humidity * saturation) / pr;
    let oxygen = pr * (24.0 + (40400.0 * h * (0.02 + h)) / (0.391 + h));
    let nitrogen =
        pr * pow(tr, -0.5) * (9.0 + 280.0 * h * exp(-4.17 * (pow(tr, -1.0 / 3.0) - 1.0)));
    let classical = f64x2_splat((1.84e-11 * pow(tr, 0.5)) / pr);
    let thermal = f64x2_splat(pow(tr, -2.5));
    let oxygen_loss = f64x2_splat(0.01275 * exp(-2239.1 / temperature) * oxygen);
    let nitrogen_loss = f64x2_splat(0.1068 * exp(-3352.0 / temperature) * nitrogen);
    let omega2 = f64x2_splat(oxygen * oxygen);
    let nu2 = f64x2_splat(nitrogen * nitrogen);
    let bands = |square| {
        let relaxation = f64x2_add(
            f64x2_div(oxygen_loss, f64x2_add(omega2, square)),
            f64x2_div(nitrogen_loss, f64x2_add(nu2, square)),
        );
        f64x2_mul(
            f64x2_mul(f64x2_splat(8.686), square),
            f64x2_add(classical, f64x2_mul(thermal, relaxation)),
        )
    };
    let result = [
        bands(f64x2(63.0 * 63.0, 125.0 * 125.0)),
        bands(f64x2(250.0 * 250.0, 500.0 * 500.0)),
        bands(f64x2(1000.0 * 1000.0, 2000.0 * 2000.0)),
        bands(f64x2(4000.0 * 4000.0, 8000.0 * 8000.0)),
    ];
    result.into_iter().all(finite_pair).then_some(result)
}

struct Path {
    loss: [v128; BAND_PAIRS],
    coefficients: [v128; BAND_PAIRS],
    temperature: f64,
    pressure: f64,
    coefficient_sets: f64,
}

impl Path {
    fn new() -> Self {
        Self {
            loss: [f64x2_splat(0.0); BAND_PAIRS],
            coefficients: [f64x2_splat(0.0); BAND_PAIRS],
            temperature: f64::NAN,
            pressure: f64::NAN,
            coefficient_sets: 0.0,
        }
    }

    fn leg(&mut self, samples: &[Sample], humidity: f64) -> Option<(f64, f64)> {
        let mut length = 0.0;
        let mut delay = 0.0;
        for sample in samples {
            if !(sample.distance.is_finite()
                && sample.distance >= 0.0
                && sample.speed.is_finite()
                && sample.speed > 0.0
                && sample.temperature.is_finite()
                && sample.temperature > 0.0
                && sample.pressure.is_finite()
                && sample.pressure > 0.0)
            {
                return None;
            }
            if sample.temperature != self.temperature || sample.pressure != self.pressure {
                self.coefficients = absorption(sample.temperature, sample.pressure, humidity)?;
                self.temperature = sample.temperature;
                self.pressure = sample.pressure;
                self.coefficient_sets += 1.0;
            }
            let distance = f64x2_splat(sample.distance);
            for (loss, coefficient) in self.loss.iter_mut().zip(self.coefficients) {
                *loss = f64x2_add(*loss, f64x2_mul(distance, coefficient));
            }
            delay += sample.distance / sample.speed;
            length += sample.distance;
        }
        Some((length, delay))
    }

    fn integrate(samples: &[Sample], first: usize, humidity: f64) -> Option<([f64; 10], f64)> {
        let mut path = Self::new();
        let (first_leg, second_leg) = samples.split_at_checked(first)?;
        let (mut distance, mut delay) = path.leg(first_leg, humidity)?;
        if !second_leg.is_empty() {
            let (other_distance, other_delay) = path.leg(second_leg, humidity)?;
            distance += other_distance;
            delay += other_delay;
        }
        if !distance.is_finite() || !delay.is_finite() || !path.loss.into_iter().all(finite_pair) {
            return None;
        }
        let mut row = [0.0; 10];
        row[0] = distance;
        row[1] = delay;
        for (pair, losses) in path.loss.into_iter().enumerate() {
            unsafe { v128_store(row.as_mut_ptr().add(2 + 2 * pair).cast(), losses) };
        }
        Some((row, path.coefficient_sets))
    }
}

/// Integrate one contiguous partition in link order, with independent lanes for each octave pair.
/// # Safety
/// All leases are disjoint, aligned, and valid until phase completion. Samples have links×slots rows,
/// counts and output have one row per link, and work has one row per participant.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn outdoor_sound_thread_phase(
    job: &Job,
    stage: usize,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(parts_wide) = NonZeroU64::new(parts as u64) else {
        return INVALID_JOB;
    };
    if stage != 0
        || part >= parts
        || job.slots == 0
        || !(job.humidity >= 0.0 && job.humidity <= 1.0)
    {
        return INVALID_JOB;
    }
    let lo = (job.links as u64 * part as u64 / parts_wide) as usize;
    let hi = (job.links as u64 * (part as u64 + 1) / parts_wide) as usize;
    let mut sample_count = 0.0;
    let mut coefficient_sets = 0.0;
    unsafe {
        for index in lo..hi {
            let first = *job.first_counts.add(index) as usize;
            let total = *job.total_counts.add(index) as usize;
            if first > total || total > job.slots {
                return INVALID_JOB;
            }
            let samples = slice::from_raw_parts(job.samples.add(job.slots * index), total);
            let Some((integrated, sets)) = Path::integrate(samples, first, job.humidity) else {
                return NONFINITE;
            };
            *job.output.add(index) = integrated;
            sample_count += total as f64;
            coefficient_sets += sets;
        }
        *job.work.add(part) = [
            (hi - lo) as f64,
            sample_count,
            sample_count * BAND_PAIRS as f64,
            coefficient_sets,
        ];
    }
    0
}
