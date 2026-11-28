#![no_std]

use core::arch::wasm32::{
    f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_le, f64x2_mul,
    f64x2_splat, f64x2_sqrt, f64x2_sub, i64x2_all_true, v128, v128_bitselect, v128_load,
    v128_store,
};
use core::num::NonZeroU64;

const FOUR_PI: f64 = 12.566370614359172;
const CORE_SQUARED: f64 = 1.0e-6 * 1.0e-6;
const NONFINITE: i32 = 1;
const INVALID_JOB: i32 = 2;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

type Vector = [f64; 3];

#[repr(C)]
struct Panel {
    bound_a: Vector,
    bound_b: Vector,
    trail_a: Vector,
    trail_b: Vector,
    collocation: Vector,
    normal: Vector,
    point: Vector,
    // 0 separated; 1 attached and moving; 2 attached with zero applied load.
    mode: f64,
}

#[repr(C)]
struct Receipt {
    matrix_interactions: f64,
    matrix_pairs: f64,
    wake_interactions: f64,
    wake_pairs: f64,
    elimination_updates: f64,
    elimination_pairs: f64,
}

#[repr(C)]
pub struct Job {
    panels: *const Panel,
    matrix: *mut f64,
    rhs_gamma: *mut f64,
    induced: *mut Vector,
    work: *mut Receipt,
    n: usize,
    wake: Vector,
}

fn finite(x: v128) -> bool {
    i64x2_all_true(f64x2_le(f64x2_abs(x), f64x2_splat(f64::MAX)))
}

#[derive(Clone, Copy)]
struct PairVector {
    x: v128,
    y: v128,
    z: v128,
}

impl PairVector {
    fn zip(a: Vector, b: Vector) -> Self {
        Self {
            x: f64x2(a[0], b[0]),
            y: f64x2(a[1], b[1]),
            z: f64x2(a[2], b[2]),
        }
    }

    fn same(a: Vector) -> Self {
        Self::zip(a, a)
    }

    fn add(self, b: Self) -> Self {
        Self {
            x: f64x2_add(self.x, b.x),
            y: f64x2_add(self.y, b.y),
            z: f64x2_add(self.z, b.z),
        }
    }

    fn sub(self, b: Self) -> Self {
        Self {
            x: f64x2_sub(self.x, b.x),
            y: f64x2_sub(self.y, b.y),
            z: f64x2_sub(self.z, b.z),
        }
    }

    fn scale(self, k: v128) -> Self {
        Self {
            x: f64x2_mul(self.x, k),
            y: f64x2_mul(self.y, k),
            z: f64x2_mul(self.z, k),
        }
    }

    fn dot(self, b: Self) -> v128 {
        f64x2_add(
            f64x2_add(f64x2_mul(self.x, b.x), f64x2_mul(self.y, b.y)),
            f64x2_mul(self.z, b.z),
        )
    }

    fn cross(self, b: Self) -> Self {
        Self {
            x: f64x2_sub(f64x2_mul(self.y, b.z), f64x2_mul(self.z, b.y)),
            y: f64x2_sub(f64x2_mul(self.z, b.x), f64x2_mul(self.x, b.z)),
            z: f64x2_sub(f64x2_mul(self.x, b.y), f64x2_mul(self.y, b.x)),
        }
    }

    fn selected(self, keep: v128) -> Self {
        let zero = f64x2_splat(0.0);
        Self {
            x: v128_bitselect(self.x, zero, keep),
            y: v128_bitselect(self.y, zero, keep),
            z: v128_bitselect(self.z, zero, keep),
        }
    }

    fn lane<const L: usize>(self) -> Vector {
        [
            f64x2_extract_lane::<L>(self.x),
            f64x2_extract_lane::<L>(self.y),
            f64x2_extract_lane::<L>(self.z),
        ]
    }

    fn finite(self) -> bool {
        finite(self.x) && finite(self.y) && finite(self.z)
    }
}

// Ranneberg (2015), equations (2) and (3). Preserve the scalar path's operation and core order.
fn segment(start: Vector, end: Vector, point: PairVector) -> Option<PairVector> {
    let start = PairVector::same(start);
    let end = PairVector::same(end);
    let d = end.sub(start);
    let a = start.sub(point);
    let b = end.sub(point);
    let c = a.cross(d);
    let cc = c.dot(c);
    let dd = d.dot(d);
    let threshold = f64x2_mul(f64x2_mul(f64x2_splat(CORE_SQUARED), dd), dd);
    let a_squared = a.dot(a);
    let b_squared = b.dot(b);
    let denominator = f64x2_mul(f64x2_splat(FOUR_PI), cc);
    if !finite(threshold) || !finite(a_squared) || !finite(b_squared) || !finite(denominator) {
        return None;
    }
    let left = f64x2_div(d.dot(b), f64x2_sqrt(b_squared));
    let right = f64x2_div(d.dot(a), f64x2_sqrt(a_squared));
    let k = f64x2_div(f64x2_sub(left, right), denominator);
    let result = c.scale(k).selected(f64x2_gt(cc, threshold));
    result.finite().then_some(result)
}

fn semi_infinite(
    start: Vector,
    wake: PairVector,
    point: PairVector,
    sense: f64,
) -> Option<PairVector> {
    let a = PairVector::same(start).sub(point);
    let c = a.cross(wake);
    let cc = c.dot(c);
    let a_squared = a.dot(a);
    let denominator = f64x2_mul(f64x2_splat(FOUR_PI), cc);
    if !finite(a_squared) || !finite(denominator) {
        return None;
    }
    let projection = f64x2_div(wake.dot(a), f64x2_sqrt(a_squared));
    let numerator = f64x2_mul(f64x2_splat(sense), f64x2_sub(f64x2_splat(1.0), projection));
    let k = f64x2_div(numerator, denominator);
    let result = c.scale(k).selected(f64x2_gt(cc, f64x2_splat(CORE_SQUARED)));
    result.finite().then_some(result)
}

fn horseshoe(source: &Panel, point: PairVector, wake: PairVector) -> Option<PairVector> {
    let u = semi_infinite(source.trail_a, wake, point, -1.0)?;
    let u = u.add(segment(source.trail_a, source.bound_a, point)?);
    let u = u.add(segment(source.bound_a, source.bound_b, point)?);
    let u = u.add(segment(source.bound_b, source.trail_b, point)?);
    Some(u.add(semi_infinite(source.trail_b, wake, point, 1.0)?))
}

unsafe fn influence(job: &Job, lo: usize, hi: usize, part: usize) -> Option<()> {
    let wake = PairVector::same(job.wake);
    let mut interactions = 0.0;
    let mut paired = 0.0;
    let mut i = lo;
    unsafe {
        while i < hi {
            let first = &*job.panels.add(i);
            let second = &*job.panels.add(if i + 1 < hi { i + 1 } else { i });
            let first_attached = first.mode != 0.0;
            let second_attached = i + 1 < hi && second.mode != 0.0;
            if !first_attached {
                *job.matrix.add(i * job.n + i) = 1.0;
            }
            if i + 1 < hi && !second_attached {
                *job.matrix.add((i + 1) * job.n + i + 1) = 1.0;
            }
            if first_attached || second_attached {
                let a = if first_attached { first } else { second };
                let b = if second_attached { second } else { first };
                let point = PairVector::zip(a.collocation, b.collocation);
                let normal = PairVector::zip(a.normal, b.normal);
                for j in 0..job.n {
                    let source = &*job.panels.add(j);
                    if source.mode == 0.0 {
                        continue;
                    }
                    let velocity = horseshoe(source, point, wake)?.dot(normal);
                    if !finite(velocity) {
                        return None;
                    }
                    if first_attached {
                        *job.matrix.add(i * job.n + j) = f64x2_extract_lane::<0>(velocity);
                        interactions += 1.0;
                    }
                    if second_attached {
                        *job.matrix.add((i + 1) * job.n + j) = f64x2_extract_lane::<1>(velocity);
                        interactions += 1.0;
                    }
                    paired += (first_attached && second_attached) as u8 as f64;
                }
            }
            i += 2;
        }
        let work = job.work.add(part);
        (*work).matrix_interactions = interactions;
        (*work).matrix_pairs = paired;
        (*work).elimination_updates = 0.0;
        (*work).elimination_pairs = 0.0;
    }
    Some(())
}

unsafe fn induced_wake(job: &Job, lo: usize, hi: usize, part: usize) -> Option<()> {
    let wake = PairVector::same(job.wake);
    let mut interactions = 0.0;
    let mut paired = 0.0;
    let mut i = lo;
    unsafe {
        while i < hi {
            let first = &*job.panels.add(i);
            let second = &*job.panels.add(if i + 1 < hi { i + 1 } else { i });
            let first_moving = first.mode == 1.0;
            let second_moving = i + 1 < hi && second.mode == 1.0;
            let mut sum = PairVector::same([0.0; 3]);
            if first_moving || second_moving {
                let a = if first_moving { first } else { second };
                let b = if second_moving { second } else { first };
                let point = PairVector::zip(a.point, b.point);
                // The scalar order of the sources stays identical for every target.
                for j in 0..job.n {
                    let source = &*job.panels.add(j);
                    if source.mode == 0.0 {
                        continue;
                    }
                    sum = sum.add(
                        horseshoe(source, point, wake)?.scale(f64x2_splat(*job.rhs_gamma.add(j))),
                    );
                    interactions += (first_moving as u8 + second_moving as u8) as f64;
                    paired += (first_moving && second_moving) as u8 as f64;
                }
                if !sum.finite() {
                    return None;
                }
            }
            *job.induced.add(i) = if first_moving {
                sum.lane::<0>()
            } else {
                [0.0; 3]
            };
            if i + 1 < hi {
                *job.induced.add(i + 1) = if second_moving {
                    sum.lane::<1>()
                } else {
                    [0.0; 3]
                };
            }
            i += 2;
        }
        let work = job.work.add(part);
        (*work).wake_interactions = interactions;
        (*work).wake_pairs = paired;
    }
    Some(())
}

/// Build disjoint influence rows (stage 0) or bound-point induced velocities (stage 1).
/// # Safety
/// The job's arrays are disjoint aligned leases of n panels, n² zeroed matrix entries,
/// n RHS/circulation words, n velocities and one receipt per participant, respectively.
/// Stage 0 must join before solve, whose result must precede the start of stage 1.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flight_lattice_thread_phase(
    job: &Job,
    stage: usize,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(parts_wide) = NonZeroU64::new(parts as u64) else {
        return INVALID_JOB;
    };
    if part >= parts || job.n == 0 || stage > 1 {
        return INVALID_JOB;
    }
    let pairs = (job.n / 2) as u64;
    let lo = 2 * (pairs * part as u64 / parts_wide) as usize;
    let hi = if part + 1 == parts {
        job.n
    } else {
        2 * (pairs * (part as u64 + 1) / parts_wide) as usize
    };
    let result = unsafe {
        if stage == 0 {
            influence(job, lo, hi, part)
        } else {
            induced_wake(job, lo, hi, part)
        }
    };
    if result.is_some() { 0 } else { NONFINITE }
}

/// Fixed-order partial pivot, elimination and backward substitution with in-place RHS.
/// # Safety
/// The same job must have successfully completed and joined stage 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flight_lattice_solve(job: &Job) -> i32 {
    let n = job.n;
    let mut updates = 0.0;
    let mut pairs = 0.0;
    unsafe {
        let a = job.matrix;
        let b = job.rhs_gamma;
        for col in 0..n {
            let pivot_row = a.add(col * n);
            let mut pick = col;
            let mut best = (*pivot_row.add(col)).abs();
            for row in (col + 1)..n {
                let value = (*a.add(row * n + col)).abs();
                if value > best {
                    best = value;
                    pick = row;
                }
            }
            if best == 0.0 {
                continue;
            }
            if pick != col {
                core::ptr::swap_nonoverlapping(pivot_row, a.add(pick * n), n);
                core::ptr::swap(b.add(col), b.add(pick));
            }
            let diagonal = *pivot_row.add(col);
            for row in (col + 1)..n {
                let target = a.add(row * n);
                let f = *target.add(col) / diagonal;
                if f == 0.0 {
                    continue;
                }
                let factor = f64x2_splat(f);
                let mut k = col;
                while k + 1 < n {
                    let current = target.add(k);
                    let values = f64x2_sub(
                        v128_load(current.cast()),
                        f64x2_mul(factor, v128_load(pivot_row.add(k).cast())),
                    );
                    if !finite(values) {
                        return NONFINITE;
                    }
                    v128_store(current.cast(), values);
                    pairs += 1.0;
                    k += 2;
                }
                if k < n {
                    let last = target.add(k);
                    let value = *last - f * *pivot_row.add(k);
                    if !value.is_finite() {
                        return NONFINITE;
                    }
                    *last = value;
                }
                updates += (n - col) as f64;
                let rhs = b.add(row);
                let value = *rhs - f * *b.add(col);
                if !value.is_finite() {
                    return NONFINITE;
                }
                *rhs = value;
            }
        }
        for row in (0..n).rev() {
            let coeffs = a.add(row * n);
            let mut val = *b.add(row);
            for k in (row + 1)..n {
                val -= *coeffs.add(k) * *b.add(k);
            }
            let diagonal = *coeffs.add(row);
            let gamma = if diagonal != 0.0 { val / diagonal } else { 0.0 };
            if !gamma.is_finite() || !val.is_finite() {
                return NONFINITE;
            }
            *b.add(row) = gamma;
        }
        (*job.work).elimination_updates = updates;
        (*job.work).elimination_pairs = pairs;
    }
    0
}
