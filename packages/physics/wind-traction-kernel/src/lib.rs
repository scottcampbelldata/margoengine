#![no_std]
#![cfg(target_arch = "wasm32")]

use core::{arch::wasm32::*, slice};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

const PANEL_WORDS: usize = 11;
const WRENCH_WORDS: usize = 6;
const MAX_PROBES: usize = 13;

#[repr(C)]
pub struct Job {
    panels: *const f64,
    motion: *const f64,
    output: *mut f64,
    receipts: *mut u32,
    panels_count: usize,
    probes: usize,
    normal_coefficient: f64,
    friction_coefficient: f64,
}

const _: () = assert!(core::mem::size_of::<Job>() == 40);

#[inline]
fn length(x: v128, y: v128, z: v128) -> v128 {
    // The sum and correctly rounded square root are the pinned TypeScript hypot.
    f64x2_sqrt(f64x2_add(
        f64x2_add(f64x2_mul(x, x), f64x2_mul(y, y)),
        f64x2_mul(z, z),
    ))
}

#[inline]
fn finite(value: v128) -> bool {
    i64x2_all_true(f64x2_le(f64x2_abs(value), f64x2_splat(f64::MAX)))
}

struct Motion {
    vx: v128,
    vy: v128,
    vz: v128,
    wx: v128,
    wy: v128,
    wz: v128,
}

impl Motion {
    fn new(words: &[f64]) -> Self {
        Self {
            vx: f64x2_splat(words[0]),
            vy: f64x2_splat(words[1]),
            vz: f64x2_splat(words[2]),
            wx: f64x2_splat(words[3]),
            wy: f64x2_splat(words[4]),
            wz: f64x2_splat(words[5]),
        }
    }
}

// Hoerner, Fluid-Dynamic Drag (1965), chapters II and III: tangential traction and pressure force. This is the existing
// WindForce windward normal-force approximation, with the same coefficient, local motion and arm about the rigid COM.
#[inline]
fn traction(
    first: &[f64; PANEL_WORDS],
    second: &[f64; PANEL_WORDS],
    motion: &Motion,
    cn: v128,
    cf: v128,
) -> Option<[v128; WRENCH_WORDS]> {
    let word = |i| f64x2(first[i], second[i]);
    let (rx, ry, rz) = (word(0), word(1), word(2));
    let (nx, ny, nz) = (word(3), word(4), word(5));
    let panel_relative = |air: v128, v: v128, wp: v128, rp: v128, wm: v128, rm: v128| {
        f64x2_sub(
            air,
            f64x2_sub(f64x2_add(v, f64x2_mul(wp, rp)), f64x2_mul(wm, rm)),
        )
    };
    let ux = panel_relative(word(6), motion.vx, motion.wy, rz, motion.wz, ry);
    let uy = panel_relative(word(7), motion.vy, motion.wz, rx, motion.wx, rz);
    let uz = panel_relative(word(8), motion.vz, motion.wx, ry, motion.wy, rx);
    let speed = length(ux, uy, uz);
    if !finite(speed) {
        return None;
    }
    let zero = f64x2_splat(0.0);
    let active = f64x2_gt(speed, f64x2_splat(1e-9));
    if !v128_any_true(active) {
        return Some([zero; WRENCH_WORDS]);
    }
    let dn = f64x2_add(
        f64x2_add(f64x2_mul(nx, ux), f64x2_mul(ny, uy)),
        f64x2_mul(nz, uz),
    );
    let tanx = f64x2_sub(ux, f64x2_mul(dn, nx));
    let tany = f64x2_sub(uy, f64x2_mul(dn, ny));
    let tanz = f64x2_sub(uz, f64x2_mul(dn, nz));
    let half = f64x2_mul(f64x2_mul(f64x2_splat(0.5), word(9)), word(10));
    let normal = v128_bitselect(
        f64x2_mul(f64x2_mul(f64x2_mul(half, cn), speed), dn),
        zero,
        f64x2_lt(dn, zero),
    );
    let friction = f64x2_mul(f64x2_mul(half, cf), length(tanx, tany, tanz));
    let fx = f64x2_add(f64x2_mul(normal, nx), f64x2_mul(friction, tanx));
    let fy = f64x2_add(f64x2_mul(normal, ny), f64x2_mul(friction, tany));
    let fz = f64x2_add(f64x2_mul(normal, nz), f64x2_mul(friction, tanz));
    let tx = f64x2_sub(f64x2_mul(ry, fz), f64x2_mul(rz, fy));
    let ty = f64x2_sub(f64x2_mul(rz, fx), f64x2_mul(rx, fz));
    let tz = f64x2_sub(f64x2_mul(rx, fy), f64x2_mul(ry, fx));
    let wrench = [fx, fy, fz, tx, ty, tz].map(|value| v128_bitselect(value, zero, active));
    wrench.iter().all(|&value| finite(value)).then_some(wrench)
}

fn integrate(panels: &[f64], motion: &Motion, cn: v128, cf: v128) -> Option<[f64; WRENCH_WORDS]> {
    let mut total = [0.0; WRENCH_WORDS];
    let (panels, _) = panels.as_chunks::<PANEL_WORDS>();
    let (pairs, tail) = panels.as_chunks::<2>();
    for [first, second] in pairs {
        let values = traction(first, second, motion, cn, cf)?;
        // Do not reduce a pair first: both contributions join the original scalar order.
        for (sum, value) in total.iter_mut().zip(values) {
            *sum += f64x2_extract_lane::<0>(value);
            *sum += f64x2_extract_lane::<1>(value);
        }
    }
    if let Some(tail) = tail.first() {
        let values = traction(tail, tail, motion, cn, cf)?;
        for (sum, value) in total.iter_mut().zip(values) {
            *sum += f64x2_extract_lane::<0>(value);
        }
    }
    total.iter().all(|value| value.is_finite()).then_some(total)
}

// 0 accepted, 1 unrepresentable load, 2 invalid private ABI. Each worker reads the same panels and writes disjoint probes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wind_traction_thread_phase(
    job: *const Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return 2;
    };
    if stage != 0
        || part >= parts
        || parts > MAX_PROBES
        || job.probes == 0
        || job.probes > MAX_PROBES
    {
        return 2;
    }
    let Some(words) = job.panels_count.checked_mul(PANEL_WORDS) else {
        return 2;
    };
    let panels = unsafe { slice::from_raw_parts(job.panels, words) };
    let motion = unsafe { slice::from_raw_parts(job.motion, job.probes * WRENCH_WORDS) };
    let lo = part * job.probes / parts;
    let hi = (part + 1) * job.probes / parts;
    let cn = f64x2_splat(job.normal_coefficient);
    let cf = f64x2_splat(job.friction_coefficient);
    for probe in lo..hi {
        let offset = probe * WRENCH_WORDS;
        let pose = Motion::new(&motion[offset..offset + WRENCH_WORDS]);
        let Some(result) = integrate(panels, &pose, cn, cf) else {
            return 1;
        };
        let output = unsafe { slice::from_raw_parts_mut(job.output.add(offset), WRENCH_WORDS) };
        output.copy_from_slice(&result);
    }
    let probes = hi - lo;
    let receipt = unsafe { slice::from_raw_parts_mut(job.receipts.add(3 * part), 3) };
    receipt[0] = probes as u32;
    receipt[1] = (probes * job.panels_count) as u32;
    receipt[2] = (probes * (job.panels_count / 2)) as u32;
    0
}
