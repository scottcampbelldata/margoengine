#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_neg, f64x2_splat,
    f64x2_sqrt, f64x2_sub, v128,
};
use core::slice;
use margoengine_physics_kernel_common::{
    atmosphere::{air_density, standard_atmosphere},
    pinned::ln,
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

const ROW_WORDS: usize = 5;
const RECEIPT_WORDS: usize = 3;

#[repr(C)]
struct Material {
    roughness: f64,
    obukhov_length: f64,
    friction_scale: f64,
    roughness_psi: f64,
    size: [f64; 3],
}

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

fn floor(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(x)))
}

// Nonnegative branch of the TypeScript pinned atan. The two half-angle
// reductions and the order of the polynomial terms match exactly.
fn atan(x: f64) -> f64 {
    let invert = x > 1.0;
    let t = if invert { 1.0 / x } else { x };
    let t = t / (1.0 + sqrt(1.0 + t * t));
    let t = t / (1.0 + sqrt(1.0 + t * t));
    let t2 = t * t;
    let mut term = 1.0 / 25.0;
    for n in (0..=11).rev() {
        term = 1.0 / f64::from(2 * n + 1) - t2 * term;
    }
    let result = 4.0 * (t * term);
    if invert {
        1.5707963267341256 - result + 6.077100506303966e-11
    } else {
        result
    }
}

impl Material {
    fn valid(&self) -> bool {
        self.roughness > 0.0
            && self.roughness.is_finite()
            && self.friction_scale >= 0.0
            && self.friction_scale.is_finite()
            && self.roughness_psi.is_finite()
            && (self.obukhov_length == f64::INFINITY
                || (self.obukhov_length.is_finite() && self.obukhov_length != 0.0))
    }

    // Integrated Monin–Obukhov momentum profile (Dyer and Hicks, 1970;
    // Dyer, 1974), normalized by the caller's friction scale u_* / kappa.
    fn mean(&self, h: f64) -> f64 {
        if h <= self.roughness || self.friction_scale == 0.0 {
            return 0.0;
        }
        let length = self.obukhov_length;
        let ratio = h / self.roughness;
        let log = if ratio.is_finite() {
            ln(ratio)
        } else {
            ln(h) - ln(self.roughness)
        };
        let potential = if length == f64::INFINITY {
            log
        } else if length > 0.0 {
            log + 5.0 * ((h - self.roughness) / length)
        } else {
            let zeta = h / length;
            let q = sqrt(sqrt(1.0 - 16.0 * zeta));
            let psi = 2.0 * ln((1.0 + q) / 2.0) + ln((1.0 + q * q) / 2.0) - 2.0 * atan(q)
                + core::f64::consts::FRAC_PI_2;
            log - psi + self.roughness_psi
        };
        self.friction_scale * potential
    }
}

#[derive(Clone, Copy)]
struct Profile {
    h: f64,
    mean: f64,
    density: f64,
    temperature: f64,
}

#[repr(C)]
struct Job {
    output: *mut f64,
    receipts: *mut u32,
    cells: [usize; 3],
    mann: [*const f64; 3],
    mann_cells: [usize; 3],
    material: *const Material,
    origin: [f64; 3],
    spacing: [f64; 3],
    time: f64,
    ground: f64,
    altitude: f64,
    sea_level: f64,
    along_x: f64,
    along_z: f64,
}

const _: () = assert!(core::mem::size_of::<Job>() == 144);
const _: () = assert!(core::mem::size_of::<Material>() == 56);

fn volume(cells: [usize; 3], words: usize) -> Option<usize> {
    let n = cells[0].checked_mul(cells[1])?.checked_mul(cells[2])?;
    (n > 0 && n <= (isize::MAX as usize / size_of::<f64>()) / words).then_some(n)
}

impl Job {
    fn valid(&self) -> bool {
        !self.output.is_null()
            && !self.material.is_null()
            && self.origin.iter().all(|v| v.is_finite())
            && self.spacing.iter().all(|&v| v > 0.0 && v.is_finite())
            && self.time.is_finite()
            && self.ground.is_finite()
            && self.altitude.is_finite()
            && self.sea_level > 0.0
            && self.sea_level.is_finite()
            && self.along_x.is_finite()
            && self.along_z.is_finite()
    }

    fn indices(&self, row: usize) -> Option<(usize, usize, usize)> {
        let [nx, ny, _] = self.cells;
        let layer = row.checked_div(nx)?;
        Some((
            row.checked_rem(nx)?,
            layer.checked_rem(ny)?,
            layer.checked_div(ny)?,
        ))
    }

    fn profile(&self, j: usize, material: &Material) -> Option<Profile> {
        let y = self.origin[1] + j as f64 * self.spacing[1];
        let h = y - self.ground;
        let z = self.altitude + h;
        if !(h.is_finite() && z.is_finite()) {
            return None;
        }
        let mean = material.mean(h);
        let (temperature, pressure) = standard_atmosphere(z, self.sea_level, 11000.0);
        let density = air_density(temperature, pressure);
        if !(mean >= 0.0
            && mean.is_finite()
            && temperature > 0.0
            && temperature.is_finite()
            && density >= 0.0
            && density.is_finite())
        {
            return None;
        }
        Some(Profile {
            h,
            mean,
            density,
            temperature,
        })
    }
}

struct Axis {
    lo: usize,
    hi: usize,
    t: f64,
}

impl Axis {
    fn from_mann(position: f64, size: f64, cells: usize) -> Option<Self> {
        let n = cells as f64;
        let f = (position / size) * n;
        let r = f - floor(f / n) * n;
        if !(r >= 0.0 && r.is_finite()) {
            return None;
        }
        let r = if r >= n { 0.0 } else { r };
        let lo = floor(r) as usize;
        Some(Self {
            lo,
            hi: if lo + 1 == cells { 0 } else { lo + 1 },
            t: r - lo as f64,
        })
    }
}

struct Gust {
    at: [usize; 8],
    tx: f64,
    ty: f64,
    tz: f64,
    gain: f64,
}

struct Mann<'a> {
    fields: [&'a [f64]; 3],
    cells: [usize; 3],
    size: [f64; 3],
    roughness: f64,
    dz: f64,
}

impl<'a> Mann<'a> {
    // These are immutable world regions. Their owner keeps them distinct
    // from the output and exposes only the three stored component planes.
    unsafe fn from_job(job: &'a Job, material: &Material) -> Option<Option<Self>> {
        if job.mann.iter().all(|p| p.is_null()) {
            return Some(None);
        }
        if job.mann.iter().any(|p| p.is_null())
            || !material
                .size
                .iter()
                .all(|&size| size > 0.0 && size.is_finite())
        {
            return None;
        }
        let cells = job.mann_cells;
        let length = volume(cells, 1)?;
        let dz = material.size[2] / cells[2] as f64;
        if !(dz > 0.0 && dz.is_finite()) {
            return None;
        }
        Some(Some(Self {
            fields: job
                .mann
                .map(|p| unsafe { slice::from_raw_parts(p, length) }),
            cells,
            size: material.size,
            roughness: material.roughness,
            dz,
        }))
    }

    fn lookup(&self, s: f64, c: f64, h: f64) -> Option<Option<Gust>> {
        let top = self.size[2];
        if !(h > self.roughness && h < top) {
            return Some(None);
        }
        // The interior preserves the existing Mann trilinear interpolant.
        // Keep its last vertical interval fixed at the last stored plane;
        // the bounded taper makes both physical ends continuous.
        let x = Axis::from_mann(s, self.size[0], self.cells[0])?;
        let y = Axis::from_mann(c, self.size[1], self.cells[1])?;
        let z = Axis::from_mann(h.min(top - self.dz), top, self.cells[2])?;
        let gain = ((h - self.roughness) / self.dz).clamp(0.0, 1.0)
            * ((top - h) / self.dz).clamp(0.0, 1.0);
        let [nx, ny, _] = self.cells;
        let at = |i, j, k| i + nx * (j + ny * k);
        Some(Some(Gust {
            at: [
                at(x.lo, y.lo, z.lo),
                at(x.hi, y.lo, z.lo),
                at(x.lo, y.hi, z.lo),
                at(x.hi, y.hi, z.lo),
                at(x.lo, y.lo, z.hi),
                at(x.hi, y.lo, z.hi),
                at(x.lo, y.hi, z.hi),
                at(x.hi, y.hi, z.hi),
            ],
            tx: x.t,
            ty: y.t,
            tz: z.t,
            gain,
        }))
    }

    fn interpolate(&self, gust: &Gust) -> [f64; 3] {
        self.fields.map(|field| {
            let [a, b, c, d, e, f, g, h] = gust.at.map(|i| mann_word(field, i));
            let x00 = lerp(a, b, gust.tx);
            let x10 = lerp(c, d, gust.tx);
            let x01 = lerp(e, f, gust.tx);
            let x11 = lerp(g, h, gust.tx);
            let y0 = lerp(x00, x10, gust.ty);
            let y1 = lerp(x01, x11, gust.ty);
            lerp(y0, y1, gust.tz) * gust.gain
        })
    }

    fn interpolate_pair(&self, a: &Gust, b: &Gust) -> [v128; 3] {
        let tx = f64x2(a.tx, b.tx);
        let ty = f64x2(a.ty, b.ty);
        let tz = f64x2(a.tz, b.tz);
        let gain = f64x2(a.gain, b.gain);
        self.fields.map(|field| {
            let get = |k: usize| f64x2(mann_word(field, a.at[k]), mann_word(field, b.at[k]));
            let x00 = lerp_pair(get(0), get(1), tx);
            let x10 = lerp_pair(get(2), get(3), tx);
            let x01 = lerp_pair(get(4), get(5), tx);
            let x11 = lerp_pair(get(6), get(7), tx);
            let y0 = lerp_pair(x00, x10, ty);
            let y1 = lerp_pair(x01, x11, ty);
            f64x2_mul(lerp_pair(y0, y1, tz), gain)
        })
    }
}

// Lookup indices come from wrapped axes strictly below their cell counts;
// these three planes have the checked product of the same counts.
fn mann_word(field: &[f64], i: usize) -> f64 {
    unsafe { *field.get_unchecked(i) }
}
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn lerp_pair(a: v128, b: v128, t: v128) -> v128 {
    f64x2_add(a, f64x2_mul(f64x2_sub(b, a), t))
}

struct Sample<'a> {
    job: &'a Job,
    material: &'a Material,
    mann: Option<Mann<'a>>,
}

impl Sample<'_> {
    fn one(&self, index: usize, out: &mut [f64]) -> Option<u32> {
        let job = self.job;
        let (i, j, k) = job.indices(index)?;
        let local = job.profile(j, self.material)?;
        let x = job.origin[0] + i as f64 * job.spacing[0];
        let z = job.origin[2] + k as f64 * job.spacing[2];
        if !(x.is_finite() && z.is_finite()) {
            return None;
        }
        let ([fu, fv, fw], turbulent) = if let Some(mann) = &self.mann {
            let s = x * job.along_x + z * job.along_z - local.mean * job.time;
            let c = -x * job.along_z + z * job.along_x;
            if let Some(gust) = mann.lookup(s, c, local.h)? {
                (mann.interpolate(&gust), 1)
            } else {
                ([0.0; 3], 0)
            }
        } else {
            ([0.0; 3], 0)
        };
        let u = local.mean + fu;
        write(
            out,
            [
                u * job.along_x - fv * job.along_z,
                fw,
                u * job.along_z + fv * job.along_x,
            ],
            local,
        )?;
        Some(turbulent)
    }

    fn two(&self, index: usize, out: &mut [f64]) -> Option<u32> {
        let job = self.job;
        let (i0, j0, k0) = job.indices(index)?;
        let (i1, j1, k1) = job.indices(index + 1)?;
        let a = job.profile(j0, self.material)?;
        let b = if j1 == j0 {
            a
        } else {
            job.profile(j1, self.material)?
        };
        let x = f64x2_add(
            f64x2_splat(job.origin[0]),
            f64x2_mul(f64x2(i0 as f64, i1 as f64), f64x2_splat(job.spacing[0])),
        );
        let z = f64x2_add(
            f64x2_splat(job.origin[2]),
            f64x2_mul(f64x2(k0 as f64, k1 as f64), f64x2_splat(job.spacing[2])),
        );
        if ![lane::<0>(x), lane::<1>(x), lane::<0>(z), lane::<1>(z)]
            .iter()
            .all(|v| v.is_finite())
        {
            return None;
        }
        let ax = f64x2_splat(job.along_x);
        let az = f64x2_splat(job.along_z);
        let mean = f64x2(a.mean, b.mean);
        let zero = f64x2_splat(0.0);
        let ([fu, fv, fw], turbulent) = if let Some(mann) = &self.mann {
            let s = f64x2_sub(
                f64x2_add(f64x2_mul(x, ax), f64x2_mul(z, az)),
                f64x2_mul(mean, f64x2_splat(job.time)),
            );
            let c = f64x2_add(f64x2_mul(f64x2_neg(x), az), f64x2_mul(z, ax));
            let gust_a = mann.lookup(lane::<0>(s), lane::<0>(c), a.h)?;
            let gust_b = mann.lookup(lane::<1>(s), lane::<1>(c), b.h)?;
            match (gust_a, gust_b) {
                (Some(a), Some(b)) => (mann.interpolate_pair(&a, &b), 2),
                (Some(a), None) => (mann.interpolate(&a).map(|v| f64x2(v, 0.0)), 1),
                (None, Some(b)) => (mann.interpolate(&b).map(|v| f64x2(0.0, v)), 1),
                (None, None) => ([zero; 3], 0),
            }
        } else {
            ([zero; 3], 0)
        };
        let u = f64x2_add(mean, fu);
        let ux = f64x2_sub(f64x2_mul(u, ax), f64x2_mul(fv, az));
        let uz = f64x2_add(f64x2_mul(u, az), f64x2_mul(fv, ax));
        write(
            &mut out[..ROW_WORDS],
            [lane::<0>(ux), lane::<0>(fw), lane::<0>(uz)],
            a,
        )?;
        write(
            &mut out[ROW_WORDS..],
            [lane::<1>(ux), lane::<1>(fw), lane::<1>(uz)],
            b,
        )?;
        Some(turbulent)
    }
}

fn lane<const N: usize>(x: v128) -> f64 {
    f64x2_extract_lane::<N>(x)
}

fn write(out: &mut [f64], velocity: [f64; 3], local: Profile) -> Option<()> {
    if !velocity.iter().all(|v| v.is_finite()) {
        return None;
    }
    let [x, y, z] = velocity;
    out.copy_from_slice(&[x, y, z, local.density, local.temperature]);
    Some(())
}

unsafe fn sample(job: *const Job, part: u32, parts: u32) -> Option<()> {
    let job = unsafe { job.as_ref()? };
    if part >= parts || !job.valid() {
        return None;
    }
    let material = unsafe { &*job.material };
    if !material.valid() {
        return None;
    }
    let rows = volume(job.cells, ROW_WORDS)?;
    let start = (u64::from(part) * rows as u64 / u64::from(parts)) as usize;
    let end = ((u64::from(part) + 1) * rows as u64 / u64::from(parts)) as usize;
    let sampler = Sample {
        job,
        material,
        mann: unsafe { Mann::from_job(job, material)? },
    };
    let rows = end - start;
    let paired = rows & !1;
    // Each worker holds only its own mutable range. A failed candidate is
    // discarded by the caller, and no worker writes its receipt on failure.
    let out =
        unsafe { slice::from_raw_parts_mut(job.output.add(ROW_WORDS * start), ROW_WORDS * rows) };
    let mut turbulent = 0;
    let mut loads = out.chunks_exact_mut(2 * ROW_WORDS);
    for (pair, out) in loads.by_ref().enumerate() {
        turbulent += sampler.two(start + 2 * pair, out)?;
    }
    if rows > paired {
        turbulent += sampler.one(start + paired, loads.into_remainder())?;
    }
    if !job.receipts.is_null() {
        unsafe {
            let receipt = job.receipts.add(RECEIPT_WORDS * part as usize);
            receipt.write(rows as u32);
            receipt.add(1).write(paired as u32);
            receipt.add(2).write(turbulent);
        }
    }
    Some(())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn boundary_layer_sample(job: *const Job) -> u32 {
    u32::from(unsafe { sample(job, 0, 1) }.is_none())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn boundary_layer_thread_phase(
    job: *const Job,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    if stage != 0 {
        return 1;
    }
    u32::from(unsafe { sample(job, part, parts) }.is_none())
}
