//! Two-mode transverse response of rooted plants. The world supplies every byte
//! of storage. Modal x/z pairs use fixed-order f64 Wasm SIMD.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;
use core::ptr;

const MODEL_WORDS: usize = 14;
const STATIONS: usize = 6;
const STATION_WORDS: usize = 9;
const SAMPLE_WORDS: usize = 5;
const SECTIONS: usize = 9;
const SECTION_WORDS: usize = 3;
const STATE_WORDS: usize = 13;
const PHASE_STEP: f64 = 0.346_410_161_513_775_46; // sqrt(0.12)

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

#[inline]
unsafe fn load(from: *const f64, at: usize) -> v128 {
    unsafe { v128_load(from.add(at).cast()) }
}

#[inline]
unsafe fn store(to: *mut f64, at: usize, value: v128) {
    unsafe { v128_store(to.add(at).cast(), value) }
}

#[inline]
fn mul(a: v128, b: f64) -> v128 {
    f64x2_mul(a, f64x2_splat(b))
}

#[inline]
fn mix(a: v128, wa: f64, b: v128, wb: f64) -> v128 {
    f64x2_add(mul(a, wa), mul(b, wb))
}

#[inline]
fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

#[inline]
fn length(v: v128) -> f64 {
    let x = f64x2_extract_lane::<0>(v).abs();
    let z = f64x2_extract_lane::<1>(v).abs();
    if !x.is_finite() || !z.is_finite() {
        return f64::NAN;
    }
    let high = x.max(z);
    if high == 0.0 {
        return 0.0;
    }
    let low = x.min(z) / high;
    high * sqrt(1.0 + low * low)
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
unsafe fn plant(
    model: *const f64,
    stations: *const f64,
    sections: *const f64,
    samples: *const f64,
    state: *mut f64,
    impulse: *const f64,
    dt: f64,
    gravity: f64,
    tick: f64,
) -> u32 {
    unsafe {
        if *state.add(9) != 0.0 {
            return 0;
        }
        let mut m00 = *model;
        let mut m01 = *model.add(1);
        let mut m11 = *model.add(2);
        let mut k00 = *model.add(3);
        let mut k01 = *model.add(4);
        let mut k11 = *model.add(5);
        let ca = *model.add(10);
        let mut inertia0 = f64x2_splat(0.0);
        let mut inertia1 = f64x2_splat(0.0);
        for i in 0..STATIONS {
            let a = stations.add(i * STATION_WORDS);
            let b = samples.add(i * SAMPLE_WORDS);
            let density = *b.add(4);
            let p0 = *a.add(1);
            let p1 = *a.add(2);
            let displaced = density * *a.add(4);
            let added = ca * displaced;
            m00 += added * p0 * p0;
            m01 += added * p0 * p1;
            m11 += added * p1 * p1;
            let acceleration = load(b, 2);
            inertia0 = f64x2_add(inertia0, mul(acceleration, (displaced + added) * p0));
            inertia1 = f64x2_add(inertia1, mul(acceleration, (displaced + added) * p1));
            if gravity != 0.0 {
                let net = gravity * (displaced - *a.add(5));
                k00 += net * *a.add(6);
                k01 += net * *a.add(7);
                k11 += net * *a.add(8);
            }
        }
        let md = m00 * m11 - m01 * m01;
        let kd = k00 * k11 - k01 * k01;
        if !(m00 > 0.0 && m11 > 0.0 && md > 0.0 && k00 > 0.0 && k11 > 0.0 && kd > 0.0)
            || !md.is_finite()
            || !kd.is_finite()
        {
            return 1;
        }
        let mixed = m00 * k11 + m11 * k00 - 2.0 * m01 * k01;
        let radicand = (mixed * mixed - 4.0 * md * kd).max(0.0);
        let omega = sqrt((mixed + sqrt(radicand)) / (2.0 * md));
        let steps =
            f64x2_extract_lane::<0>(f64x2_ceil(f64x2_splat(dt * omega / PHASE_STEP))).max(1.0);
        if !omega.is_finite() || omega <= 0.0 || steps > 4_294_967_295.0 {
            return 2;
        }
        let h = dt / steps;
        let half = h * 0.5;
        let quarter = half * half;
        let mut q0 = load(state, 0);
        let mut q1 = load(state, 2);
        let mut v0 = load(state, 4);
        let mut v1 = load(state, 6);
        if !impulse.is_null() {
            let j0 = load(impulse, 0);
            let j1 = load(impulse, 2);
            v0 = f64x2_add(v0, mul(mix(j0, m11, j1, -m01), 1.0 / md));
            v1 = f64x2_add(v1, mul(mix(j0, -m01, j1, m00), 1.0 / md));
        }
        let mut ratio = *state.add(8);
        let mut base_moment = 0.0;
        let mut status = 0.0;
        let mut height = 0.0;
        for _ in 0..steps as u32 {
            let mut c00 = *model.add(6);
            let mut c01 = *model.add(7);
            let mut c11 = *model.add(8);
            let mut f0 = inertia0;
            let mut f1 = inertia1;
            for i in 0..STATIONS {
                let a = stations.add(i * STATION_WORDS);
                let b = samples.add(i * SAMPLE_WORDS);
                let p0 = *a.add(1);
                let p1 = *a.add(2);
                let speed = load(b, 0);
                let relative = f64x2_sub(speed, mix(v0, p0, v1, p1));
                let drag = (0.5 * *b.add(4)) * *a.add(3) * length(relative);
                c00 += drag * p0 * p0;
                c01 += drag * p0 * p1;
                c11 += drag * p1 * p1;
                f0 = f64x2_add(f0, mul(speed, drag * p0));
                f1 = f64x2_add(f1, mul(speed, drag * p1));
            }

            let a00 = m00 + half * c00 + quarter * k00;
            let a01 = m01 + half * c01 + quarter * k01;
            let a11 = m11 + half * c11 + quarter * k11;
            let ad = a00 * a11 - a01 * a01;
            if !ad.is_finite() || !(ad > 0.0) {
                return 2;
            }
            let rhs0 = f64x2_add(
                mix(v0, m00, v1, m01),
                mul(f64x2_sub(f0, mix(q0, k00, q1, k01)), half),
            );
            let rhs1 = f64x2_add(
                mix(v0, m01, v1, m11),
                mul(f64x2_sub(f1, mix(q0, k01, q1, k11)), half),
            );
            let mid0 = mul(mix(rhs0, a11, rhs1, -a01), 1.0 / ad);
            let mid1 = mul(mix(rhs0, -a01, rhs1, a00), 1.0 / ad);
            q0 = f64x2_add(q0, mul(mid0, h));
            q1 = f64x2_add(q1, mul(mid1, h));
            v0 = f64x2_sub(mul(mid0, 2.0), v0);
            v1 = f64x2_sub(mul(mid1, 2.0), v1);
            if !length(q0).is_finite()
                || !length(q1).is_finite()
                || !length(v0).is_finite()
                || !length(v1).is_finite()
            {
                return 2;
            }
            base_moment = length(mix(q0, *model.add(11), q1, *model.add(12)));
            let root_ratio = base_moment * *model.add(13);
            if !root_ratio.is_finite() {
                return 2;
            }
            let mut stem_ratio = 0.0;
            for i in 0..SECTIONS {
                let a = sections.add(i * SECTION_WORDS);
                let local = length(mix(q0, *a.add(1), q1, *a.add(2)));
                if !local.is_finite() {
                    return 2;
                }
                if local > stem_ratio {
                    stem_ratio = local;
                    height = *a;
                }
            }
            ratio = ratio.max(root_ratio.max(stem_ratio));
            if root_ratio >= 1.0 && root_ratio >= stem_ratio {
                status = 2.0;
                height = 0.0;
                break;
            }
            if stem_ratio >= 1.0 {
                status = 1.0;
                break;
            }
        }

        store(state, 0, q0);
        store(state, 2, q1);
        store(state, 4, v0);
        store(state, 6, v1);
        *state.add(8) = ratio;
        *state.add(9) = status;
        *state.add(10) = if status != 0.0 { height } else { 0.0 };
        *state.add(11) = base_moment;
        *state.add(12) = if status != 0.0 { tick } else { -1.0 };
    }
    0
}

#[allow(clippy::too_many_arguments)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vegetation_step(
    models: *const f64,
    stations: *const f64,
    sections: *const f64,
    samples: *const f64,
    current: *mut f64,
    work: *mut f64,
    impulses: *const f64,
    count: usize,
    dt: f64,
    gravity: f64,
    tick: f64,
) -> u32 {
    unsafe {
        ptr::copy_nonoverlapping(current, work, count * STATE_WORDS);
        for i in 0..count {
            let status = plant(
                models.add(i * MODEL_WORDS),
                stations.add(i * STATIONS * STATION_WORDS),
                sections.add(i * SECTIONS * SECTION_WORDS),
                samples.add(i * STATIONS * SAMPLE_WORDS),
                work.add(i * STATE_WORDS),
                if impulses.is_null() {
                    impulses
                } else {
                    impulses.add(i * 4)
                },
                dt,
                gravity,
                tick,
            );
            if status != 0 {
                return status;
            }
        }
        ptr::copy_nonoverlapping(work, current, count * STATE_WORDS);
    }
    0
}
