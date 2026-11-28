#![no_std]

use core::arch::wasm32::{
    f64x2_abs, f64x2_add, f64x2_extract_lane, f64x2_le, f64x2_mul, f64x2_splat, i64x2_all_true,
    v128_load, v128_store,
};
use core::num::NonZeroUsize;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

const NONFINITE: i32 = 1;
const INVALID_JOB: i32 = 2;

/// One acoustic interval. All buffers, including both pressure lanes, are private trial allocations.
#[repr(C)]
pub struct WaveJob {
    current: *mut f64,
    previous: *mut f64,
    coefficients: *const f64,
    input: *const f64,
    trace: *mut f64,
    receipts: *mut f64,
    n: usize,
    row: usize,
    plane: usize,
    source: usize,
    receiver: usize,
    samples: usize,
    lambda_squared: f64,
}

impl WaveJob {
    fn pairs(&self) -> Option<usize> {
        let (Some(row), Some(plane)) = (NonZeroUsize::new(self.row), NonZeroUsize::new(self.plane))
        else {
            return None;
        };
        if self.row < 4
            || !self.row.is_multiple_of(2)
            || self.plane < self.row
            || self.plane - (self.plane / row) * self.row != 0
            || self.n / plane < 3
            || self.n - (self.n / plane) * self.plane != 0
            || self.source < self.plane
            || self.source >= self.n - self.plane
            || self.receiver < self.plane
            || self.receiver >= self.n - self.plane
            || !self.lambda_squared.is_finite()
            || self.lambda_squared < 0.0
        {
            return None;
        }
        Some((self.n - 2 * self.plane) / 2)
    }

    fn lanes(&self, sample: usize) -> (*mut f64, *mut f64) {
        if sample.is_multiple_of(2) {
            (self.current, self.previous)
        } else {
            (self.previous, self.current)
        }
    }
}

/// Rescale only an overflowing lane. Absorb damping before multiplying pressure: even when loss
/// D is large, |(D-1)/(1+D)| <= 1, and division by 16 bounds the remaining intermediate sums.
#[cold]
unsafe fn recover_pressure(
    job: &WaveJob,
    current: *const f64,
    previous: *const f64,
    i: usize,
) -> f64 {
    const SCALE: f64 = 0.0625;
    unsafe {
        let damping = *job.coefficients.add(2 * job.n + i);
        if damping == 0.0 {
            return 0.0;
        }
        let at = current.add(i);
        let px = *at.sub(1) * SCALE + *at.add(1) * SCALE;
        let py = *at.sub(job.row) * SCALE + *at.add(job.row) * SCALE;
        let pz = *at.sub(job.plane) * SCALE + *at.add(job.plane) * SCALE;
        let centre = (damping * *job.coefficients.add(i)) * (*at * SCALE);
        let past = (damping * *job.coefficients.add(job.n + i)) * (*previous.add(i) * SCALE);
        let neighbours = (damping * job.lambda_squared) * ((px + py) + pz);
        ((centre + past) + neighbours) * (1.0 / SCALE)
    }
}

/// Run the original seven-point leapfrog in pairs. Each partition writes only its own old-pressure lanes.
unsafe fn advance_pairs(job: &WaveJob, sample: usize, lo: usize, hi: usize) -> i32 {
    let (current, previous) = job.lanes(sample);
    let lambda_squared = f64x2_splat(job.lambda_squared);
    let finite_limit = f64x2_splat(f64::MAX);
    unsafe {
        let old_weight = job.coefficients.add(job.n);
        let damping = old_weight.add(job.n);
        let mut i = job.plane + 2 * lo;
        let stop = job.plane + 2 * hi;
        while i < stop {
            let at = current.add(i);
            let px = f64x2_add(v128_load(at.sub(1).cast()), v128_load(at.add(1).cast()));
            let py = f64x2_add(
                v128_load(at.sub(job.row).cast()),
                v128_load(at.add(job.row).cast()),
            );
            let pz = f64x2_add(
                v128_load(at.sub(job.plane).cast()),
                v128_load(at.add(job.plane).cast()),
            );
            let neighbours = f64x2_add(f64x2_add(px, py), pz);
            let centre = f64x2_mul(
                v128_load(job.coefficients.add(i).cast()),
                v128_load(at.cast()),
            );
            let write = previous.add(i);
            let past = f64x2_mul(v128_load(old_weight.add(i).cast()), v128_load(write.cast()));
            let stress = f64x2_add(
                f64x2_add(centre, past),
                f64x2_mul(lambda_squared, neighbours),
            );
            let next = f64x2_mul(v128_load(damping.add(i).cast()), stress);
            if i64x2_all_true(f64x2_le(f64x2_abs(next), finite_limit)) {
                v128_store(write.cast(), next);
            } else {
                let recover = |value: f64, lane| {
                    if value.is_finite() {
                        value
                    } else {
                        recover_pressure(job, current, previous, i + lane)
                    }
                };
                let a = recover(f64x2_extract_lane::<0>(next), 0);
                let b = recover(f64x2_extract_lane::<1>(next), 1);
                if !a.is_finite() || !b.is_finite() {
                    return NONFINITE;
                }
                *write.cast::<[f64; 2]>() = [a, b];
            }
            i += 2;
        }
    }
    0
}

/// Apply the source and tap the receiver only after all partitions have joined.
unsafe fn finish_sample(job: &WaveJob, sample: usize) -> i32 {
    let (_, previous) = job.lanes(sample);
    unsafe {
        let source = previous.add(job.source);
        let pressure = *source + *job.input.add(sample);
        let received = if job.receiver == job.source {
            pressure
        } else {
            *previous.add(job.receiver)
        };
        if !pressure.is_finite() || !received.is_finite() {
            return NONFINITE;
        }
        *source = pressure;
        *job.trace.add(sample) = received;
    }
    0
}

unsafe fn apply(job: &WaveJob) -> i32 {
    let Some(pairs) = job.pairs() else {
        return INVALID_JOB;
    };
    for sample in 0..job.samples {
        unsafe {
            let phase = advance_pairs(job, sample, 0, pairs);
            if phase != 0 {
                return phase;
            }
            let finish = finish_sample(job, sample);
            if finish != 0 {
                return finish;
            }
        }
    }
    if !job.receipts.is_null() {
        unsafe {
            *job.receipts.cast::<[f64; 2]>() =
                [job.samples as f64, pairs as f64 * job.samples as f64]
        };
    }
    0
}

/// Advance padded interior slabs and record receiver samples. The coefficient columns are
/// (2-lambda² N_open), (D-1), and mask/(1+D). D is lambda*wall_admittance/2 per closed face.
/// # Safety
/// Pointer ranges are disjoint aligned world leases. Pressure lanes contain n words, coefficients contain
/// 3*n words, and input and output contain samples words. Guard and solid rows must be initialized.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn acoustic_wave(
    current: *mut f64,
    previous: *mut f64,
    coefficients: *const f64,
    input: *const f64,
    trace: *mut f64,
    n: usize,
    row: usize,
    plane: usize,
    source: usize,
    receiver: usize,
    samples: usize,
    lambda_squared: f64,
) -> i32 {
    unsafe {
        apply(&WaveJob {
            current,
            previous,
            coefficients,
            input,
            trace,
            receipts: core::ptr::null_mut(),
            n,
            row,
            plane,
            source,
            receiver,
            samples,
            lambda_squared,
        })
    }
}

/// # Safety
/// The job and all of its ranges must satisfy acoustic_wave, with two receipt words for the caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn acoustic_wave_apply(job: &WaveJob) -> i32 {
    unsafe { apply(job) }
}

/// # Safety
/// The job and all of its ranges must satisfy acoustic_wave, with two receipt words per part.
/// Each part is called exactly once per sample, then all parts synchronize before finish_sample.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn acoustic_wave_thread_phase(
    job: &WaveJob,
    sample: usize,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(pairs) = job.pairs() else {
        return INVALID_JOB;
    };
    let Some(parts) = core::num::NonZeroU64::new(parts as u64) else {
        return INVALID_JOB;
    };
    if sample >= job.samples || part as u64 >= parts.get() || job.receipts.is_null() {
        return INVALID_JOB;
    }
    let lo = (pairs as u64 * part as u64 / parts) as usize;
    let hi = (pairs as u64 * (part as u64 + 1) / parts) as usize;
    unsafe {
        let status = advance_pairs(job, sample, lo, hi);
        if status == 0 {
            let work = job.receipts.cast::<[f64; 2]>().add(part);
            let [samples, pairs] = if sample == 0 { [0.0, 0.0] } else { *work };
            *work = [samples + 1.0, pairs + (hi - lo) as f64];
        }
        status
    }
}

/// # Safety
/// The valid job's stencil parts must all have joined for this sample.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn acoustic_wave_finish_sample(job: &WaveJob, sample: usize) -> i32 {
    if job.pairs().is_none() || sample >= job.samples {
        return INVALID_JOB;
    }
    unsafe { finish_sample(job, sample) }
}
