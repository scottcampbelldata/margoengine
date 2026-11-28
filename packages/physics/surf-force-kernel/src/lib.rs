#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_mul, f64x2_neg, f64x2_splat,
    f64x2_sqrt, f64x2_sub, v128, v128_bitselect,
};
use core::num::NonZeroUsize;
use core::ops::{Add, Div, Mul, Neg, Sub};
use margoengine_physics_kernel_common::pinned::exp;

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
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

type Stress = [f64; 3];
type Force = [f64; 5];

#[repr(C)]
struct Job {
    energy: *const f64,
    roller: *const f64,
    properties: *const f64,
    direction_x: *const f64,
    direction_z: *const f64,
    stress: *mut Stress,
    output: *mut Force,
    work: *mut Work,
    nx: usize,
    nz: usize,
    bins: usize,
    wrap_x: u32,
    wrap_z: u32,
    reserved: u32,
    dx: f64,
    dz: f64,
    density: f64,
    gravity: f64,
    wet_depth: f64,
    dtheta: f64,
}

#[derive(Default)]
#[repr(C)]
struct Work {
    moment_cells: u32,
    paired_moments: u32,
    directional_bins: u32,
    divergence_cells: u32,
    paired_divergence: u32,
}

const _: [(); 104] = [(); core::mem::size_of::<Job>()];
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
    fn divide_positive(self, denominator: Self) -> Self;
}

impl Float for f64 {
    fn splat(value: f64) -> Self {
        value
    }
    fn sqrt(self) -> Self {
        Pair::splat(self).sqrt().lane::<0>()
    }
    fn divide_positive(self, denominator: Self) -> Self {
        if denominator > 0.0 {
            self / denominator
        } else {
            0.0
        }
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
    fn divide_positive(self, denominator: Self) -> Self {
        let zero = f64x2_splat(0.0);
        Self(v128_bitselect(
            f64x2_div(self.0, denominator.0),
            zero,
            f64x2_gt(denominator.0, zero),
        ))
    }
}

struct MomentInputs<F> {
    phase_speed: F,
    group_speed: F,
    depth: F,
    roller: F,
}

struct Moment<F> {
    stress: [F; 3],
    drift: [F; 2],
    height_rms: F,
}

/// Longuet-Higgins and Stewart (1964), tensor components and rotation. Roelvink et al.
/// (2009), Eqs. 0.11 and 0.17: add the directional wave and roller stresses.
fn moments<F: Float>(
    job: &Job,
    material: MomentInputs<F>,
    energy: impl Fn(usize) -> F,
) -> Moment<F> {
    let ratio = material.group_speed / material.phase_speed;
    let [mut xx, mut xz, mut zz, mut ew, mut mx, mut mz] = [F::splat(0.0); 6];
    let one = F::splat(1.0);
    let half = F::splat(0.5);
    let dtheta = F::splat(job.dtheta);
    for bin in 0..job.bins {
        let e = energy(bin) * dtheta;
        let cs = F::splat(unsafe { *job.direction_x.add(bin) });
        let sn = F::splat(unsafe { *job.direction_z.add(bin) });
        xx = xx + (ratio * (one + cs * cs) - half) * e;
        xz = xz + ratio * sn * cs * e;
        zz = zz + (ratio * (one + sn * sn) - half) * e;
        ew = ew + e;
        mx = mx + e * cs;
        mz = mz + e * sn;
    }
    let norm = (mx * mx + mz * mz).sqrt();
    let ex = mx.divide_positive(norm);
    let ez = mz.divide_positive(norm);
    let roller = F::splat(2.0) * material.roller;
    let drift = (ew + roller) / (F::splat(job.density) * material.depth * material.phase_speed);
    Moment {
        stress: [
            xx + roller * ex * ex,
            xz + roller * ex * ez,
            zz + roller * ez * ez,
        ],
        drift: [drift * ex, drift * ez],
        height_rms: (F::splat(8.0) * ew / F::splat(job.density * job.gravity)).sqrt(),
    }
}

/// Roelvink et al. Eq. 0.18: negative divergence of the summed stress, divided by water density.
fn divergence<F: Float>(job: &Job, read: impl Fn(usize, usize) -> F) -> [F; 2] {
    let dx = |component| (read(1, component) - read(0, component)) / F::splat(2.0 * job.dx);
    let dz = |component| {
        if job.nz > 1 {
            (read(3, component) - read(2, component)) / F::splat(2.0 * job.dz)
        } else {
            F::splat(0.0)
        }
    };
    [
        -(dx(0) + dz(1)) / F::splat(job.density),
        -(dx(1) + dz(2)) / F::splat(job.density),
    ]
}

impl Job {
    fn property(&self, plane: usize, cell: usize) -> f64 {
        unsafe { *self.properties.add(plane * self.nx * self.nz + cell) }
    }

    fn material<F: Float>(&self, read: impl Fn(usize) -> F, roller: F) -> MomentInputs<F> {
        MomentInputs {
            group_speed: read(0),
            phase_speed: read(1),
            depth: read(2),
            roller,
        }
    }

    fn wave(&self, cell: usize) -> bool {
        self.property(0, cell) > 0.0
    }
    fn wet(&self, cell: usize) -> bool {
        self.property(2, cell) > self.wet_depth
    }

    fn clear(&self, cell: usize) {
        unsafe {
            self.stress.add(cell).write([0.0; 3]);
            self.output.add(cell).write([0.0; 5]);
        }
    }

    fn publish_moment(&self, cell: usize, m: Moment<f64>) -> bool {
        let kh = self.property(3, cell) * self.property(2, cell);
        let orbital = if kh < 20.0 {
            let e = exp(kh);
            let sinh = (e - 1.0 / e) / 2.0;
            self.property(4, cell) * m.height_rms / (2.0 * core::f64::consts::SQRT_2 * sinh)
        } else {
            0.0
        };
        let [u, w] = m.drift;
        if !m
            .stress
            .iter()
            .chain([&u, &w, &orbital])
            .all(|value| value.is_finite())
        {
            return false;
        }
        unsafe {
            self.stress.add(cell).write(m.stress);
            self.output.add(cell).write([0.0, 0.0, u, w, orbital]);
        }
        true
    }

    fn single_moment(&self, cell: usize, work: &mut Work) -> bool {
        if !self.wave(cell) {
            self.clear(cell);
            return true;
        }
        let inputs = self.material(|plane| self.property(plane, cell), unsafe {
            *self.roller.add(cell)
        });
        let m = moments(self, inputs, |bin| unsafe {
            *self.energy.add(cell * self.bins + bin)
        });
        work.moment_cells += 1;
        work.directional_bins += self.bins as u32;
        self.publish_moment(cell, m)
    }

    fn paired_moment(&self, a: usize, b: usize, work: &mut Work) -> bool {
        if !self.wave(a) || !self.wave(b) {
            return self.single_moment(a, work) && self.single_moment(b, work);
        }
        let inputs = self.material(
            |plane| Pair::new(self.property(plane, a), self.property(plane, b)),
            unsafe { Pair::new(*self.roller.add(a), *self.roller.add(b)) },
        );
        let m = moments(self, inputs, |bin| unsafe {
            Pair::new(
                *self.energy.add(a * self.bins + bin),
                *self.energy.add(b * self.bins + bin),
            )
        });
        work.moment_cells += 2;
        work.paired_moments += 2;
        work.directional_bins += 2 * self.bins as u32;
        self.publish_moment(
            a,
            Moment {
                stress: m.stress.map(Pair::lane::<0>),
                drift: m.drift.map(Pair::lane::<0>),
                height_rms: m.height_rms.lane::<0>(),
            },
        ) && self.publish_moment(
            b,
            Moment {
                stress: m.stress.map(Pair::lane::<1>),
                drift: m.drift.map(Pair::lane::<1>),
                height_rms: m.height_rms.lane::<1>(),
            },
        )
    }

    fn neighbors(&self, nx: NonZeroUsize, cell: usize) -> [usize; 4] {
        let i = cell % nx;
        let j = cell / nx;
        let wrap_x = self.wrap_x != 0;
        let wrap_z = self.wrap_z != 0;
        [
            if i > 0 {
                cell - 1
            } else if wrap_x {
                cell + self.nx - 1
            } else {
                cell
            },
            if i + 1 < self.nx {
                cell + 1
            } else if wrap_x {
                cell - (self.nx - 1)
            } else {
                cell
            },
            if j > 0 {
                cell - self.nx
            } else if wrap_z {
                cell + self.nx * (self.nz - 1)
            } else {
                cell
            },
            if j + 1 < self.nz {
                cell + self.nx
            } else if wrap_z {
                cell - self.nx * (self.nz - 1)
            } else {
                cell
            },
        ]
        .map(|k| if self.wave(k) { k } else { cell })
    }

    fn stress(&self, cell: usize, component: usize) -> f64 {
        // Stage 0 zeroes dry stresses. It is fully joined before any stage 1 reader.
        unsafe { *self.stress.add(cell).cast::<f64>().add(component) }
    }

    fn publish_divergence(&self, cell: usize, [x, z]: [f64; 2]) -> bool {
        if !(x.is_finite() && z.is_finite()) {
            return false;
        }
        unsafe {
            let target = self.output.add(cell).cast::<f64>();
            target.write(x);
            target.add(1).write(z);
        }
        true
    }

    fn single_divergence(&self, nx: NonZeroUsize, cell: usize, work: &mut Work) -> bool {
        if !self.wet(cell) {
            return true;
        }
        let neighbors = self.neighbors(nx, cell);
        work.divergence_cells += 1;
        self.publish_divergence(
            cell,
            divergence(self, |side, axis| self.stress(neighbors[side], axis)),
        )
    }

    fn paired_divergence(&self, nx: NonZeroUsize, a: usize, b: usize, work: &mut Work) -> bool {
        if !self.wet(a) || !self.wet(b) {
            return self.single_divergence(nx, a, work) && self.single_divergence(nx, b, work);
        }
        let left = self.neighbors(nx, a);
        let right = self.neighbors(nx, b);
        let force = divergence(self, |side, axis| {
            Pair::new(
                self.stress(left[side], axis),
                self.stress(right[side], axis),
            )
        });
        work.divergence_cells += 2;
        work.paired_divergence += 2;
        self.publish_divergence(a, force.map(Pair::lane::<0>))
            && self.publish_divergence(b, force.map(Pair::lane::<1>))
    }
}

/// Safety: the private loader validates array dimensions, assigns disjoint cell ranges and joins
/// the stress writers before anyone reads a neighbor. Result rows remain private until both phases pass.
#[unsafe(no_mangle)]
unsafe extern "C" fn surf_force_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    let Some(nx) = NonZeroUsize::new(job.nx) else {
        return 1;
    };
    if stage > 1 || !matches!(parts, 1 | 2 | 4) || part >= parts || job.nz == 0 || job.bins == 0 {
        return 1;
    }
    let cells = job.nx * job.nz;
    let pairs = cells / 2;
    let start = 2 * (pairs * part / parts);
    let end = 2 * (pairs * (part + 1) / parts);
    let work = unsafe { &mut *job.work.add(part) };
    if stage == 0 {
        *work = Work::default();
        for cell in (start..end).step_by(2) {
            if !job.paired_moment(cell, cell + 1, work) {
                return 2;
            }
        }
        if part + 1 == parts && end < cells && !job.single_moment(end, work) {
            return 2;
        }
    } else {
        for cell in (start..end).step_by(2) {
            if !job.paired_divergence(nx, cell, cell + 1, work) {
                return 2;
            }
        }
        if part + 1 == parts && end < cells && !job.single_divergence(nx, end, work) {
            return 2;
        }
    }
    0
}
