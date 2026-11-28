#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_mul, f64x2_neg, f64x2_splat, f64x2_sqrt,
    f64x2_sub, v128, v128_store,
};
use core::ops::{Add, Div, Mul, Neg, Sub};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// Match the simultaneous Earth-fixed vectors of SPACE-02 and the GM values in space/effects.ts.
const SUN_GM: f64 = 1.327_124_4e20;
const MOON_GM: f64 = 4.902_800_118e12;
const PRESSURE: u32 = 1;
const TIDE: u32 = 2;
const REFERENCE: u32 = 4;

#[repr(C)]
struct Job {
    parts: *mut [f64; 2],
    wet: *const u8,
    positions: *const [f64; 3],
    potential: *mut f64,
    work: *mut Work,
    wet_count: *mut u32,
    cells: usize,
    mode: u32,
    sun: [f64; 3],
    moon: [f64; 3],
    rho_g: f64,
    gravity: f64,
    love: f64,
    grow: f64,
    reference: f64,
    tidal_mean: f64,
}

#[repr(C)]
struct Work {
    pressure_cells: u32,
    tide_cells: u32,
    paired_tides: u32,
    synthesized_cells: u32,
    paired_synthesis: u32,
}

const _: [(); 128] = [(); core::mem::size_of::<Job>()];
const _: [(); 20] = [(); core::mem::size_of::<Work>()];

trait Float:
    Copy
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
{
    fn splat(value: f64) -> Self;
    fn sqrt(self) -> Self;
    fn finite(self) -> bool;
    fn positive_finite(self) -> bool;
}

impl Float for f64 {
    fn splat(value: f64) -> Self {
        value
    }
    fn sqrt(self) -> Self {
        Pair::splat(self).sqrt().lane::<0>()
    }
    fn finite(self) -> bool {
        self.is_finite()
    }
    fn positive_finite(self) -> bool {
        self > 0.0 && self.finite()
    }
}

#[derive(Clone, Copy)]
struct Pair(v128);

impl Pair {
    fn new(a: f64, b: f64) -> Self {
        Self(f64x2(a, b))
    }
    fn lane<const INDEX: usize>(self) -> f64 {
        f64x2_extract_lane::<INDEX>(self.0)
    }
}

macro_rules! binary {
    ($trait:ident, $op:ident, $intrinsic:ident) => {
        impl $trait for Pair {
            type Output = Self;
            fn $op(self, rhs: Self) -> Self {
                Self($intrinsic(self.0, rhs.0))
            }
        }
    };
}

binary!(Add, add, f64x2_add);
binary!(Sub, sub, f64x2_sub);
binary!(Mul, mul, f64x2_mul);
binary!(Div, div, f64x2_div);

impl Neg for Pair {
    type Output = Self;
    fn neg(self) -> Self {
        Self(f64x2_neg(self.0))
    }
}

impl Float for Pair {
    fn splat(value: f64) -> Self {
        Self(f64x2_splat(value))
    }
    fn sqrt(self) -> Self {
        Self(f64x2_sqrt(self.0))
    }
    fn finite(self) -> bool {
        self.lane::<0>().is_finite() && self.lane::<1>().is_finite()
    }
    fn positive_finite(self) -> bool {
        self.lane::<0>().positive_finite() && self.lane::<1>().positive_finite()
    }
}

fn dot<F: Float>(a: [F; 3], b: [F; 3]) -> F {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

struct Body {
    direction: [f64; 3],
    reciprocal_radius: f64,
    gm_over_radius: f64,
}

impl Body {
    fn new(xyz: [f64; 3], gm: f64) -> Option<Self> {
        let radius = dot(xyz, xyz).sqrt();
        if !radius.positive_finite() {
            return None;
        }
        let reciprocal_radius = 1.0 / radius;
        Some(Self {
            direction: xyz.map(|axis| axis * reciprocal_radius),
            reciprocal_radius,
            gm_over_radius: gm / radius,
        })
    }

    /// The direct geocentric tidal potential with its constant and uniform terms removed
    /// (Stewart, Introduction to Physical Oceanography §17.4). The rationalized expression
    /// is identical to the potential in SPACE-02, with two distinct grid points per pair.
    fn potential<F: Float>(&self, xyz: [F; 3]) -> Option<F> {
        let n = self.direction.map(F::splat);
        let u = xyz.map(|axis| axis * F::splat(self.reciprocal_radius));
        let projection = dot(n, u);
        let squared = dot(u, u);
        let two = F::splat(2.0);
        let delta = squared - two * projection;
        let difference = [n[0] - u[0], n[1] - u[1], n[2] - u[2]];
        let k = dot(difference, difference).sqrt();
        if !k.positive_finite() {
            return None;
        }
        let one_plus = F::splat(1.0) + k;
        Some(
            F::splat(self.gm_over_radius) * (-projection * delta * (two + k) / one_plus - squared)
                / (k * one_plus),
        )
    }
}

fn tide<F: Float>(sun: &Body, moon: &Body, xyz: [F; 3]) -> Option<F> {
    let result = sun.potential(xyz)? + moon.potential(xyz)? + F::splat(0.0);
    result.finite().then_some(result)
}

impl Job {
    fn apply_tide(&self, start: usize, end: usize, has_tail: bool) -> bool {
        let Some(sun) = Body::new(self.sun, SUN_GM) else {
            return false;
        };
        let Some(moon) = Body::new(self.moon, MOON_GM) else {
            return false;
        };
        for cell in (start..end).step_by(2) {
            let a = unsafe { *self.positions.add(cell) };
            let b = unsafe { *self.positions.add(cell + 1) };
            let xyz = [
                Pair::new(a[0], b[0]),
                Pair::new(a[1], b[1]),
                Pair::new(a[2], b[2]),
            ];
            let Some(u) = tide(&sun, &moon, xyz) else {
                return false;
            };
            unsafe {
                self.set_tide(cell, u.lane::<0>());
                self.set_tide(cell + 1, u.lane::<1>());
            }
        }
        if has_tail {
            let Some(u) = tide(&sun, &moon, unsafe { *self.positions.add(end) }) else {
                return false;
            };
            unsafe { self.set_tide(end, u) };
        }
        true
    }

    unsafe fn set_tide(&self, cell: usize, potential: f64) {
        unsafe { self.parts.add(cell).cast::<f64>().add(1).write(potential) };
    }

    /// The inverse barometer and equilibrium-potential height make a common
    /// pressure/head gradient, following the sign convention of SurgeSolver.
    fn synthesize<F: Float>(&self, pressure: F, tide: F) -> F {
        let barometer = if self.mode & PRESSURE != 0 {
            (pressure - F::splat(self.reference)) / F::splat(self.rho_g)
        } else {
            F::splat(0.0)
        };
        let tidal_height = if self.mode & TIDE != 0 {
            F::splat(-self.love) * (tide - F::splat(self.tidal_mean)) / F::splat(self.gravity)
        } else {
            F::splat(0.0)
        };
        F::splat(self.grow) * (barometer + tidal_height)
    }

    fn apply_synthesis(&self, start: usize, end: usize, has_tail: bool) -> bool {
        for cell in (start..end).step_by(2) {
            if self.mode & TIDE == 0 {
                unsafe {
                    self.set_tide(cell, 0.0);
                    self.set_tide(cell + 1, 0.0);
                }
            }
            let [pa, ua] = unsafe { *self.parts.add(cell) };
            let [pb, ub] = unsafe { *self.parts.add(cell + 1) };
            let result = self.synthesize(Pair::new(pa, pb), Pair::new(ua, ub));
            if !result.finite() {
                return false;
            }
            unsafe { v128_store(self.potential.add(cell).cast(), result.0) };
        }
        if has_tail {
            if self.mode & TIDE == 0 {
                unsafe { self.set_tide(end, 0.0) };
            }
            let [p, u] = unsafe { *self.parts.add(end) };
            let result = self.synthesize(p, u);
            if !result.finite() {
                return false;
            }
            unsafe { self.potential.add(end).write(result) };
        }
        true
    }
}

/// Safety: the staging bridge assigns disjoint cell and work ranges and joins the tidal rows
/// before reading the ordered wet reduction. This phase touches private candidate arrays only.
#[unsafe(no_mangle)]
unsafe extern "C" fn surge_potential_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if stage > 1 || !matches!(parts, 1 | 2 | 4) || part >= parts || job.cells == 0 {
        return 1;
    }
    let pairs = job.cells / 2;
    let start = 2 * (pairs * part / parts);
    let end = 2 * (pairs * (part + 1) / parts);
    let tail = part + 1 == parts && end < job.cells;
    let paired = (end - start) as u32;
    let cells = paired + u32::from(tail);
    let work = unsafe { &mut *job.work.add(part) };
    if stage == 0 {
        if job.mode & TIDE == 0 || job.positions.is_null() {
            return 1;
        }
        if !job.apply_tide(start, end, tail) {
            return 2;
        }
        work.tide_cells = cells;
        work.paired_tides = paired;
    } else {
        if !job.apply_synthesis(start, end, tail) {
            return 2;
        }
        work.pressure_cells = if job.mode & PRESSURE != 0 { cells } else { 0 };
        work.synthesized_cells = cells;
        work.paired_synthesis = paired;
    }
    0
}

/// Safety: private input ranges remain immutable after the tidal phase joins. Keep each wet
/// addition in X-fast cell order so no number depends on the number of participants.
#[unsafe(no_mangle)]
unsafe extern "C" fn surge_potential_reduce(job: &mut Job) -> u32 {
    let mut count = 0;
    let mut pressure = 0.0;
    let mut tide = 0.0;
    for cell in 0..job.cells {
        if unsafe { *job.wet.add(cell) } != 0 {
            let [p, u] = unsafe { *job.parts.add(cell) };
            count += 1;
            pressure += p;
            if job.mode & TIDE != 0 {
                tide += u;
            }
        }
    }
    if !(pressure.is_finite() && tide.is_finite()) {
        return 2;
    }
    let p_mean = if count > 0 {
        pressure / f64::from(count)
    } else {
        0.0
    };
    if job.mode & REFERENCE == 0 {
        job.reference = p_mean;
    }
    job.tidal_mean = if count > 0 {
        tide / f64::from(count)
    } else {
        0.0
    };
    unsafe { job.wet_count.write(count) };
    0
}
