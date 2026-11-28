use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_mul, f64x2_neg, f64x2_splat, f64x2_sub,
    i64x2_shuffle, v128, v128_load, v128_store,
};
use core::num::NonZeroUsize;

#[repr(C)]
struct Work {
    modes: u32,
    paired_modes: u32,
}

#[repr(C)]
struct Job {
    height: *mut v128,
    pressure: *const v128,
    potential: *mut v128,
    vertical: *const f64,
    first: *const f64,
    second: *const f64,
    third: *const f64,
    count: usize,
    work: *mut Work,
    extended: u32,
    level: f64,
}

#[inline]
fn scale(value: v128, factor: f64) -> v128 {
    f64x2_mul(value, f64x2_splat(factor))
}

#[inline]
fn cross_terms(value: v128, imaginary: f64) -> v128 {
    f64x2_mul(
        i64x2_shuffle::<1, 0>(value, value),
        f64x2(-imaginary, imaginary),
    )
}

#[inline]
fn rotate(value: v128, real: f64, imaginary: f64) -> v128 {
    f64x2_add(scale(value, real), cross_terms(value, imaginary))
}

#[inline]
fn finite(value: v128) -> bool {
    f64x2_extract_lane::<0>(value).is_finite() && f64x2_extract_lane::<1>(value).is_finite()
}

impl Job {
    unsafe fn gravity(&self, m: usize, h: v128, f: v128, p: v128) -> (v128, v128) {
        let (k, c, so, st) = unsafe {
            (
                *self.vertical.add(m),
                *self.first.add(m),
                *self.second.add(m),
                *self.third.add(m),
            )
        };
        let rest = scale(f64x2_neg(p), self.level);
        let lift = f64x2_sub(h, rest);
        let height = f64x2_add(f64x2_add(rest, scale(lift, c)), scale(scale(f, k), so));
        let potential = f64x2_sub(scale(f, c), f64x2_div(scale(lift, st), f64x2_splat(k)));
        (height, potential)
    }

    unsafe fn current(&self, m: usize, h: v128, f: v128, p: v128) -> (v128, v128) {
        let [cr, ci, sr, si, chr, chi, cpr, cpi] =
            unsafe { self.first.cast::<[f64; 8]>().add(m).read() };
        let (k, omega) = unsafe { (*self.vertical.add(m), *self.second.add(m)) };
        let restoring = (omega / k) * omega;
        // The two pressure sums are deliberately applied separately. Combining
        // them first as one complex product would change the existing rounding.
        let height = f64x2_add(rotate(h, cr, ci), scale(rotate(f, sr, si), k));
        let height = f64x2_add(f64x2_add(height, scale(p, chr)), cross_terms(p, chi));
        let potential = f64x2_sub(rotate(f, cr, ci), scale(rotate(h, sr, si), restoring));
        let potential = f64x2_add(f64x2_add(potential, scale(p, cpr)), cross_terms(p, cpi));
        (height, potential)
    }
}

// The FFT and pinned coefficients are already prepared. Each participant has
// a disjoint half-spectrum interval; each f64x2 holds a real/imaginary pair.
#[unsafe(no_mangle)]
unsafe extern "C" fn wake_mode_phase(
    job: *const Job,
    phase: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if phase != 0 || !matches!(parts, 1 | 2 | 4) || part >= parts {
        return 1;
    }
    let stride = NonZeroUsize::new(parts)
        .unwrap_or_else(|| core::arch::wasm32::unreachable())
        .get();
    let job = unsafe { &*job };
    let lo = part * job.count / stride;
    let hi = (part + 1) * job.count / stride;
    if lo == 0 && hi != 0 {
        let mean = unsafe { v128_load(job.height) };
        if !finite(mean) {
            return 2;
        }
        // Signed source volume remains the mean elevation. Potential's mean is a gauge.
        unsafe { v128_store(job.potential, f64x2_splat(0.0)) };
    }
    let start = lo.max(1).min(hi);
    for m in start..hi {
        let (h, f, p) = unsafe {
            (
                v128_load(job.height.add(m)),
                v128_load(job.potential.add(m)),
                v128_load(job.pressure.add(m)),
            )
        };
        let (height, potential) = if job.extended == 0 {
            unsafe { job.gravity(m, h, f, p) }
        } else {
            unsafe { job.current(m, h, f, p) }
        };
        if !finite(height) || !finite(potential) {
            return 2;
        }
        unsafe {
            v128_store(job.height.add(m), height);
            v128_store(job.potential.add(m), potential);
        }
    }
    let modes = (hi - start) as u32;
    unsafe {
        job.work.add(part).write(Work {
            modes,
            paired_modes: modes,
        })
    };
    0
}
