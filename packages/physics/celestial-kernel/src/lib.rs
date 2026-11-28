#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, f64x2_sub,
    v128,
};
use core::f64::consts::PI;
use margoengine_physics_kernel_common::pinned::{cos, sin};

const PLANETS: usize = 8;
const ELEMENTS: usize = 6;
const NEWTON_STEPS: usize = 6;
const ASTRONOMICAL_UNIT: f64 = 149597870700.0;
const RAD: f64 = PI / 180.0;

// The pinned math crate has alloc-enabled modules. This feature uses no Rust heap.
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
struct Work {
    planets: f64,
    paired_planets: f64,
    kepler_iterations: f64,
}

#[repr(C)]
struct Job {
    table: *const [f64; 2 * ELEMENTS],
    output: *mut [f64; 3],
    work: *mut Work,
    reserved: u32,
    centuries: f64,
}

const _: [(); 24] = [(); size_of::<Job>()];

#[inline]
fn map(v: v128, f: fn(f64) -> f64) -> v128 {
    f64x2(f(f64x2_extract_lane::<0>(v)), f(f64x2_extract_lane::<1>(v)))
}

fn wrapped(mean: f64) -> f64 {
    let circle = 2.0 * PI;
    (((mean + PI) % circle + circle) % circle) - PI
}

/// Standish Table 1 orbital positions, measured in metres in the mean J2000 ecliptic.
/// Pairing does not change the scalar operation order or the fixed count of Newton updates.
fn pair(first: &[f64; 12], second: &[f64; 12], t: f64) -> [v128; 3] {
    let t = f64x2_splat(t);
    let elements = |k| {
        let start = f64x2(first[k], second[k]);
        let rate = f64x2(first[k + ELEMENTS], second[k + ELEMENTS]);
        f64x2_add(start, f64x2_mul(rate, t))
    };
    let rad = f64x2_splat(RAD);
    let one = f64x2_splat(1.0);
    let a = f64x2_mul(f64x2_splat(ASTRONOMICAL_UNIT), elements(0));
    let e = elements(1);
    let incl = f64x2_mul(rad, elements(2));
    let longitude = elements(3);
    let perihelion = elements(4);
    let node = f64x2_mul(rad, elements(5));
    let m = map(f64x2_mul(rad, f64x2_sub(longitude, perihelion)), wrapped);
    let mut anomaly = f64x2_add(m, f64x2_mul(e, map(m, sin)));
    for _ in 0..NEWTON_STEPS {
        let numerator = f64x2_sub(f64x2_sub(anomaly, f64x2_mul(e, map(anomaly, sin))), m);
        let denominator = f64x2_sub(one, f64x2_mul(e, map(anomaly, cos)));
        anomaly = f64x2_sub(anomaly, f64x2_div(numerator, denominator));
    }
    let xp = f64x2_mul(a, f64x2_sub(map(anomaly, cos), e));
    let yp = f64x2_mul(
        f64x2_mul(a, f64x2_sqrt(f64x2_sub(one, f64x2_mul(e, e)))),
        map(anomaly, sin),
    );
    let omega = f64x2_sub(f64x2_mul(rad, perihelion), node);
    let cs = map(omega, cos);
    let sn = map(omega, sin);
    let orbital_x = f64x2_sub(f64x2_mul(cs, xp), f64x2_mul(sn, yp));
    let orbital_y = f64x2_add(f64x2_mul(sn, xp), f64x2_mul(cs, yp));
    let cos_node = map(node, cos);
    let sin_node = map(node, sin);
    let cos_incl = map(incl, cos);
    [
        f64x2_sub(
            f64x2_mul(cos_node, orbital_x),
            f64x2_mul(f64x2_mul(sin_node, cos_incl), orbital_y),
        ),
        f64x2_add(
            f64x2_mul(sin_node, orbital_x),
            f64x2_mul(f64x2_mul(cos_node, cos_incl), orbital_y),
        ),
        f64x2_mul(map(incl, sin), orbital_y),
    ]
}

/// Independent planet pairs share immutable elements and write only their own output rows.
#[unsafe(no_mangle)]
unsafe extern "C" fn celestial_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if stage != 0
        || !matches!(parts, 1 | 2 | 4)
        || part >= parts
        || !(-2.0..=0.5).contains(&job.centuries)
    {
        return 1;
    }
    let first = part * PLANETS / parts;
    let end = (part + 1) * PLANETS / parts;
    unsafe {
        for row in (first..end).step_by(2) {
            let a = &*job.table.add(row);
            let b = &*job.table.add(row + 1);
            let [x, y, z] = pair(a, b, job.centuries);
            let left = [
                f64x2_extract_lane::<0>(x),
                f64x2_extract_lane::<0>(y),
                f64x2_extract_lane::<0>(z),
            ];
            let right = [
                f64x2_extract_lane::<1>(x),
                f64x2_extract_lane::<1>(y),
                f64x2_extract_lane::<1>(z),
            ];
            if !left.iter().chain(&right).all(|value| value.is_finite()) {
                return 1;
            }
            job.output.add(row).write(left);
            job.output.add(row + 1).write(right);
        }
        let planets = (end - first) as f64;
        job.work.add(part).write(Work {
            planets,
            paired_planets: planets,
            kepler_iterations: planets * NEWTON_STEPS as f64,
        });
    }
    0
}
