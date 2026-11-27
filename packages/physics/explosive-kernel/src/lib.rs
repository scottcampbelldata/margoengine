#![no_std]
#![cfg(target_arch = "wasm32")]
//! Fragment flight for the explosive source (FIRE-05): every fragment and shot in one call, under gravity and quadratic air
//! drag, landing on a flat ground or on the terrain bed. The TypeScript twin in `explosive/flight.ts` does the same
//! operations in the same order, so the two give the same bits.

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sqrt,
};

/// The IEEE square root and floor (wasm's f64x2 forms, lane 0), as Math.sqrt and Math.floor round.
fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}
fn floor(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(x)))
}

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

const WORDS: usize = 8;
const WAITING: f64 = 0.0;
const FLYING: f64 = 1.0;
const LANDED: f64 = 2.0;

/// The bed's elevation at (x, z) on the triangles the physics kernel cuts its grid into (BedSurface.sample), the grid
/// clamped so the bed continues at its border's elevation.
unsafe fn bed_height(
    bed: *const f32,
    columns: usize,
    rows: usize,
    width: f64,
    depth: f64,
    cx: f64,
    cz: f64,
    x: f64,
    z: f64,
) -> f64 {
    let cf = columns as f64;
    let rf = rows as f64;
    let u = f64::min(cf, f64::max(0.0, ((x - cx) / width + 0.5) * cf));
    let v = f64::min(rf, f64::max(0.0, ((z - cz) / depth + 0.5) * rf));
    let c = f64::min(cf - 1.0, floor(u));
    let r = f64::min(rf - 1.0, floor(v));
    let s = u - c;
    let t = v - r;
    let ci = c as usize;
    let ri = r as usize;
    let stride = rows + 1;
    unsafe {
        let a = *bed.add(ri + stride * ci) as f64;
        let b = *bed.add(ri + 1 + stride * ci) as f64;
        let d = *bed.add(ri + stride * (ci + 1)) as f64;
        let e = *bed.add(ri + 1 + stride * (ci + 1)) as f64;
        if s + t <= 1.0 {
            a + s * (d - a) + t * (b - a)
        } else {
            e + (1.0 - s) * (b - e) + (1.0 - t) * (d - e)
        }
    }
}

/// Steps `count` fragment rows (x, y, z, vx, vy, vz, mass, state) by `dt` to world time `end`: a waiting fragment whose
/// `launch` time is before `end` starts flying; a flying one loses speed s to s / (1 + k s dt) along its velocity (the
/// quadratic drag alone, exactly over the step), gains gravity, moves, and lands where it reaches the ground (`bed` null:
/// the height `ground`). Writes the fragments still flying and the fragment steps taken to `counts`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fly(
    fragments: *mut f64,
    drag: *const f64,
    launch: *const f64,
    count: usize,
    dt: f64,
    end: f64,
    gx: f64,
    gy: f64,
    gz: f64,
    ground: f64,
    bed: *const f32,
    columns: usize,
    rows: usize,
    width: f64,
    depth: f64,
    cx: f64,
    cz: f64,
    counts: *mut f64,
) {
    let mut flying = 0.0;
    let mut steps = 0.0;
    let step = f64x2_splat(dt);
    let gravity = f64x2_mul(f64x2(gx, gy), step);
    let gzdt = gz * dt;
    unsafe {
        for i in 0..count {
            let f = fragments.add(i * WORDS);
            let mut state = *f.add(7);
            if state == WAITING && *launch.add(i) < end {
                state = FLYING;
            }
            if state != FLYING {
                *f.add(7) = state;
                continue;
            }
            let vx = *f.add(3);
            let vy = *f.add(4);
            let vz = *f.add(5);
            let s = sqrt(vx * vx + vy * vy + vz * vz);
            let keep = 1.0 / (1.0 + *drag.add(i) * s * dt);
            let n = f64x2_add(f64x2_mul(f64x2(vx, vy), f64x2_splat(keep)), gravity);
            let nz = vz * keep + gzdt;
            let p = f64x2_add(f64x2(*f, *f.add(1)), f64x2_mul(n, step));
            let x = f64x2_extract_lane::<0>(p);
            let y = f64x2_extract_lane::<1>(p);
            let z = *f.add(2) + nz * dt;
            steps += 1.0;
            let height = if bed.is_null() {
                ground
            } else {
                bed_height(bed, columns, rows, width, depth, cx, cz, x, z)
            };
            *f = x;
            *f.add(2) = z;
            if y < height {
                *f.add(1) = height;
                *f.add(3) = 0.0;
                *f.add(4) = 0.0;
                *f.add(5) = 0.0;
                *f.add(7) = LANDED;
            } else {
                *f.add(1) = y;
                *f.add(3) = f64x2_extract_lane::<0>(n);
                *f.add(4) = f64x2_extract_lane::<1>(n);
                *f.add(5) = nz;
                *f.add(7) = FLYING;
                flying += 1.0;
            }
        }
        *counts = flying;
        *counts.add(1) = steps;
    }
}
