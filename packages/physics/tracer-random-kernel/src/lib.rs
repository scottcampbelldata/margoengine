#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_mul, i64x2, i64x2_extract_lane, i64x2_mul, i64x2_splat,
    u64x2_shr, v128_and, v128_xor,
};
use core::num::NonZeroU64;
use margoengine_physics_kernel_common::{
    pinned::{cos, ln, pow, sin},
    random::philox4x32,
};

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

const ROUNDS: usize = 10;

#[repr(C)]
struct Work {
    rows: f64,
    paired_rows: f64,
    round_pairs: f64,
    normal_values: f64,
}

#[repr(C)]
pub struct Job {
    rows: *const u32,
    normals: *mut [f64; 3],
    work: *mut Work,
    count: usize,
    tick_lo: u32,
    tick_hi: u32,
    seed: u32,
    solver: u32,
}

// Salmon et al., SC11 §4.3: two independent Philox4x32 counters, with one whole product in each
// i64 lane so the wrapping low word and the unsigned high word follow the scalar permutation.
fn philox_pair(job: &Job, a: u32, b: u32) -> ([u32; 4], [u32; 4]) {
    const M0: i64 = 0xD251_1F53;
    const M1: i64 = 0xCD9E_8D57;
    const W0: u32 = 0x9E37_79B9;
    const W1: u32 = 0xBB67_AE85;
    let low = i64x2_splat(u32::MAX as i64);
    let mut w0 = i64x2(a as i64, b as i64);
    let mut w1 = i64x2_splat(0); // stream 0 is the production parcel Brownian draw
    let mut w2 = i64x2_splat(job.tick_lo as i64);
    let mut w3 = i64x2_splat(job.tick_hi as i64);
    let mut key0 = job.seed;
    let mut key1 = job.solver;
    for _ in 0..ROUNDS {
        let p0 = i64x2_mul(i64x2_splat(M0), w0);
        let p1 = i64x2_mul(i64x2_splat(M1), w2);
        w0 = v128_xor(v128_xor(u64x2_shr(p1, 32), w1), i64x2_splat(key0 as i64));
        w1 = v128_and(p1, low);
        w2 = v128_xor(v128_xor(u64x2_shr(p0, 32), w3), i64x2_splat(key1 as i64));
        w3 = v128_and(p0, low);
        key0 = key0.wrapping_add(W0);
        key1 = key1.wrapping_add(W1);
    }
    let output = [w0, w1, w2, w3];
    (
        output.map(|word| i64x2_extract_lane::<0>(word) as u32),
        output.map(|word| i64x2_extract_lane::<1>(word) as u32),
    )
}

fn box_muller([a, b, c, d]: [u32; 4]) -> ([f64; 3], [f64; 3]) {
    let unit = |word| (f64::from(word) + 0.5) / 4_294_967_296.0;
    // Box and Muller (1958), using the pinned pow of the existing tracer path for the radius.
    let r1 = pow(-2.0 * ln(unit(a)), 0.5);
    let r2 = pow(-2.0 * ln(unit(c)), 0.5);
    let a1 = core::f64::consts::TAU * unit(b);
    let a2 = core::f64::consts::TAU * unit(d);
    ([r1, r1, r2], [cos(a1), sin(a1), cos(a2)])
}

fn normal_pair(job: &Job, a: u32, b: u32) -> ([f64; 3], [f64; 3]) {
    let (left, right) = philox_pair(job, a, b);
    let (radius_a, trig_a) = box_muller(left);
    let (radius_b, trig_b) = box_muller(right);
    let values = core::array::from_fn::<_, 3, _>(|i| {
        f64x2_mul(f64x2(radius_a[i], radius_b[i]), f64x2(trig_a[i], trig_b[i]))
    });
    (
        values.map(|x| f64x2_extract_lane::<0>(x)),
        values.map(|x| f64x2_extract_lane::<1>(x)),
    )
}

fn normal(job: &Job, index: u32) -> [f64; 3] {
    let (radius, trig) = box_muller(philox4x32(
        [index, 0, job.tick_lo, job.tick_hi],
        [job.seed, job.solver],
    ));
    [
        radius[0] * trig[0],
        radius[1] * trig[1],
        radius[2] * trig[2],
    ]
}

/// # Safety
/// The input must cover count slot IDs. Each participant owns its disjoint output range
/// and receipt. The caller joins all participants before reading their results.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tracer_random_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(partition) = NonZeroU64::new(parts as u64) else {
        return 1;
    };
    if stage != 0 || part >= parts {
        return 1;
    }
    let pairs = (job.count / 2) as u64;
    let start = 2 * (pairs * part as u64 / partition) as usize;
    let end = if part + 1 == parts {
        job.count
    } else {
        2 * (pairs * (part + 1) as u64 / partition) as usize
    };
    unsafe {
        let mut i = start;
        let mut performed_pairs = 0;
        while i + 1 < end {
            let (a, b) = normal_pair(job, *job.rows.add(i), *job.rows.add(i + 1));
            *job.normals.add(i) = a;
            *job.normals.add(i + 1) = b;
            performed_pairs += 1;
            i += 2;
        }
        if i < end {
            *job.normals.add(i) = normal(job, *job.rows.add(i));
        }
        *job.work.add(part) = Work {
            rows: (end - start) as f64,
            paired_rows: 2.0 * f64::from(performed_pairs),
            round_pairs: ROUNDS as f64 * f64::from(performed_pairs),
            normal_values: 3.0 * (end - start) as f64,
        };
    }
    0
}
