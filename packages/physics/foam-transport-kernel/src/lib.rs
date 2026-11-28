#![no_std]

use core::arch::wasm32::{
    f64x2_abs, f64x2_add, f64x2_extract_lane, f64x2_gt, f64x2_le, f64x2_min, f64x2_mul, f64x2_neg,
    f64x2_splat, f64x2_sub, i64x2_all_true, v128, v128_bitselect, v128_load, v128_store,
};
use core::num::NonZeroU64;

const NONFINITE: i32 = 1;
const INVALID_JOB: i32 = 2;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Work {
    x_lines: f64,
    z_lines: f64,
    x_face_pairs: f64,
    z_face_pairs: f64,
    cell_pairs: f64,
    clamp_pairs: f64,
}

#[repr(C)]
pub struct Job {
    foam: *mut [f64; 2],
    temporary: *mut [f64; 2],
    fx: *const f64,
    fz: *const f64,
    work: *mut Work,
    nx: usize,
    nz: usize,
    _reserved: u32,
    h: f64,
    sub: f64,
}

impl Job {
    fn valid(&self) -> bool {
        self.nx > 0
            && self.nz > 0
            && self.h > 0.0
            && self.h.is_finite()
            && self.sub >= 0.0
            && self.sub.is_finite()
            && (self.sub / self.h).is_finite()
    }
}

struct Sweep {
    input: *const [f64; 2],
    output: *mut [f64; 2],
    faces: *const f64,
    along: usize,
    across: usize,
    cell_line_stride: usize,
    cell_along_stride: usize,
    face_line_stride: usize,
    face_along_stride: usize,
}

impl Sweep {
    fn new(job: &Job, x: bool) -> Self {
        if x {
            Self {
                input: job.foam,
                output: job.temporary,
                faces: job.fx,
                along: job.nx,
                across: job.nz,
                cell_line_stride: job.nx,
                cell_along_stride: 1,
                face_line_stride: job.nx + 1,
                face_along_stride: 1,
            }
        } else {
            Self {
                input: job.temporary,
                output: job.foam,
                faces: job.fz,
                along: job.nz,
                across: job.nx,
                cell_line_stride: 1,
                cell_along_stride: job.nx,
                face_line_stride: 1,
                face_along_stride: job.nx,
            }
        }
    }
}

fn finite(value: v128) -> bool {
    i64x2_all_true(f64x2_le(f64x2_abs(value), f64x2_splat(f64::MAX)))
}

// Van Leer (1977) Eq. (66), applied to the centered slope from Eq. (16).
// Do the original product test, including its signed-zero behavior.
fn centered(a: v128, b: v128) -> v128 {
    let zero = f64x2_splat(0.0);
    let two = f64x2_splat(2.0);
    let mag = f64x2_min(
        f64x2_min(
            f64x2_mul(f64x2_abs(f64x2_add(a, b)), f64x2_splat(0.5)),
            f64x2_mul(two, f64x2_abs(a)),
        ),
        f64x2_mul(two, f64x2_abs(b)),
    );
    let signed = v128_bitselect(mag, f64x2_neg(mag), f64x2_gt(a, zero));
    v128_bitselect(zero, signed, f64x2_le(f64x2_mul(a, b), zero))
}

fn clamp(result: v128) -> v128 {
    let zero = f64x2_splat(0.0);
    let nonnegative = v128_bitselect(result, zero, f64x2_gt(result, zero));
    let white = f64x2_extract_lane::<0>(nonnegative);
    let scale = if white > 1.0 { 1.0 / white } else { 1.0 };
    f64x2_mul(nonnegative, f64x2_splat(scale))
}

unsafe fn phase(job: &Job, x: bool, part: usize, parts: NonZeroU64) -> i32 {
    let sweep = Sweep::new(job, x);
    let lo = (sweep.across as u64 * part as u64 / parts) as usize;
    let hi = (sweep.across as u64 * (part as u64 + 1) / parts) as usize;
    let scale = f64x2_splat(job.sub / job.h);
    let zero = f64x2_splat(0.0);
    let mut reconstructed = 0.0;
    unsafe {
        for line in lo..hi {
            let cell = |p| sweep.cell_line_stride * line + sweep.cell_along_stride * p;
            let value = |p| v128_load(sweep.input.add(cell(p)).cast());
            let mut previous = zero;
            // Keep the scalar path's left-to-right flux reuse and empty inflow ghosts.
            for p in 0..=sweep.along {
                let u = *sweep
                    .faces
                    .add(sweep.face_line_stride * line + sweep.face_along_stride * p);
                let c = (u * job.sub) / job.h;
                if !c.is_finite() {
                    return NONFINITE;
                }
                let (upwind, sign) = if u >= 0.0 {
                    (p.wrapping_sub(1), 1.0)
                } else {
                    (p, -1.0)
                };
                let flux = if upwind < sweep.along {
                    let v = value(upwind);
                    let left = if upwind > 0 { value(upwind - 1) } else { zero };
                    let right = if upwind + 1 < sweep.along {
                        value(upwind + 1)
                    } else {
                        zero
                    };
                    let slope = centered(f64x2_sub(v, left), f64x2_sub(right, v));
                    let weight = f64x2_splat(0.5 * sign * (1.0 - c.abs()));
                    reconstructed += 1.0;
                    f64x2_mul(f64x2_splat(u), f64x2_add(v, f64x2_mul(weight, slope)))
                } else {
                    zero
                };
                if !finite(flux) {
                    return NONFINITE;
                }
                if p > 0 {
                    let result =
                        f64x2_add(value(p - 1), f64x2_mul(scale, f64x2_sub(previous, flux)));
                    if !finite(result) {
                        return NONFINITE;
                    }
                    // The Z pass only reads the X field, so its completed cell can already be clamped.
                    v128_store(
                        sweep.output.add(cell(p - 1)).cast(),
                        if x { result } else { clamp(result) },
                    );
                }
                previous = flux;
            }
        }
        let work = job.work.add(part);
        let lines = (hi - lo) as f64;
        let cells = lines * sweep.along as f64;
        if x {
            (*work).x_lines += lines;
            (*work).x_face_pairs += reconstructed;
        } else {
            (*work).z_lines += lines;
            (*work).z_face_pairs += reconstructed;
            (*work).clamp_pairs += cells;
        }
        (*work).cell_pairs += cells;
    }
    0
}

/// Apply a single split transport phase to the participant's disjoint range of grid lines.
/// # Safety
/// Job buffers are disjoint, in bounds and aligned: nx*nz interleaved cells per state buffer,
/// (nx+1)*nz X faces, nx*(nz+1) Z faces, and one zero-initialized work row per participant.
/// Join every stage before starting the next. Stage 0 reads foam; stage 1 reads temporary.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn foam_transport_thread_phase(
    job: &Job,
    stage: usize,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(parts_wide) = NonZeroU64::new(parts as u64) else {
        return INVALID_JOB;
    };
    if !job.valid() || stage > 1 || part >= parts {
        return INVALID_JOB;
    }
    unsafe { phase(job, stage == 0, part, parts_wide) }
}

/// Execute the same split sweeps locally in one Wasm invocation.
/// # Safety
/// The pointer regions must satisfy foam_transport_thread_phase for a single participant.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn foam_transport_apply(job: &Job, steps: usize) -> i32 {
    if !job.valid() {
        return INVALID_JOB;
    }
    for _ in 0..steps {
        unsafe {
            let x = phase(job, true, 0, NonZeroU64::MIN);
            if x != 0 {
                return x;
            }
            let z = phase(job, false, 0, NonZeroU64::MIN);
            if z != 0 {
                return z;
            }
        }
    }
    0
}
