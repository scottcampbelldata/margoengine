#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
};
use margoengine_physics_kernel_common::pinned::{cos, exp, pow, sin};

// This is an explicit solver. Refuse a requested tick that needs more work
// than this budget rather than stepping over the CFL bound or dropping time.
const MAX_CFL_SUBSTEPS: u32 = 4096;

#[repr(u32)]
enum StepFailure {
    Numeric = 1,
    Work = 2,
}

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
    unreachable()
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

fn floor(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(value)))
}

fn norm(x: f64, z: f64) -> f64 {
    let v = f64x2(x, z);
    let p = f64x2_mul(v, v);
    sqrt(f64x2_extract_lane::<0>(p) + f64x2_extract_lane::<1>(p))
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Water {
    h: f64,
    x: f64,
    z: f64,
}

impl Water {
    fn add(self, rhs: Self) -> Self {
        Self {
            h: self.h + rhs.h,
            x: self.x + rhs.x,
            z: self.z + rhs.z,
        }
    }

    fn sub(self, rhs: Self) -> Self {
        Self {
            h: self.h - rhs.h,
            x: self.x - rhs.x,
            z: self.z - rhs.z,
        }
    }

    fn scale(self, factor: f64) -> Self {
        Self {
            h: self.h * factor,
            x: self.x * factor,
            z: self.z * factor,
        }
    }

    fn swap(self) -> Self {
        Self {
            h: self.h,
            x: self.z,
            z: self.x,
        }
    }

    fn is_finite(self) -> bool {
        self.h.is_finite() && self.x.is_finite() && self.z.is_finite()
    }

    fn velocity(self, dry: f64) -> (f64, f64) {
        if self.h > dry {
            (self.x / self.h, self.z / self.h)
        } else {
            (0.0, 0.0)
        }
    }

    fn flux(self, g: f64, dry: f64) -> Self {
        let (u, _) = self.velocity(dry);
        Self {
            h: self.x,
            x: self.x * u + hydrostatic(self.h, g),
            z: self.z * u,
        }
    }
}

#[repr(C)]
struct Model {
    spacing: f64,
    gravity: f64,
    density: f64,
    sea: f64,
    roughness: f64,
    dry: f64,
    open: f64,
    origin_x: f64,
    origin_z: f64,
    coriolis: f64,
}

#[derive(Clone, Copy)]
struct Grid {
    width: usize,
    rows: usize,
    size: usize,
}

impl Grid {
    fn index(self, x: usize, z: usize) -> usize {
        x + z * self.width
    }

    fn strides(self, axis: usize) -> (usize, usize, usize, usize) {
        if axis == 0 {
            (self.width, self.rows, 1, self.width)
        } else {
            (self.rows, self.width, self.width, 1)
        }
    }
}

#[derive(Clone, Copy)]
struct Rep {
    h: f64,
    u: f64,
    v: f64,
    bed: f64,
}

impl Rep {
    fn water(self, crest: f64) -> Water {
        let h = (self.h + self.bed - crest).max(0.0);
        Water {
            h,
            x: h * self.u,
            z: h * self.v,
        }
    }
}

fn hydrostatic(h: f64, g: f64) -> f64 {
    (0.5 * g * h) * h
}

fn slope(a: f64, b: f64) -> f64 {
    if a > 0.0 && b > 0.0 {
        a.min(b)
    } else if a < 0.0 && b < 0.0 {
        a.max(b)
    } else {
        0.0
    }
}

#[inline]
fn hll(left: Water, right: Water, model: &Model) -> Water {
    let g = model.gravity;
    let (u, _) = left.velocity(model.dry);
    let (v, _) = right.velocity(model.dry);
    let c = sqrt(g * left.h);
    let d = sqrt(g * right.h);
    let low = (u - c).min(v - d).min(if left.h == 0.0 {
        v - 2.0 * d
    } else {
        f64::INFINITY
    });
    let high = (u + c).max(v + d).max(if right.h == 0.0 {
        u + 2.0 * c
    } else {
        f64::NEG_INFINITY
    });
    if low >= 0.0 {
        return left.flux(g, model.dry);
    }
    if high <= 0.0 {
        return right.flux(g, model.dry);
    }
    left.flux(g, model.dry)
        .scale(high)
        .sub(right.flux(g, model.dry).scale(low))
        .add(right.sub(left).scale(high * low))
        .scale(1.0 / (high - low))
}

fn reconstruct(left: Rep, right: Rep, model: &Model) -> (Water, Water) {
    let crest = left.bed.max(right.bed);
    let a = left.water(crest);
    let b = right.water(crest);
    let flux = hll(a, b, model);
    let mut fa = flux;
    let mut fb = flux;
    fa.x += hydrostatic(left.h, model.gravity) - hydrostatic(a.h, model.gravity);
    fb.x += hydrostatic(right.h, model.gravity) - hydrostatic(b.h, model.gravity);
    (fa, fb)
}

#[derive(Clone, Copy)]
#[repr(C)]
struct BoundaryWave {
    active: f64,
    surface: f64,
    outward_velocity: f64,
}

fn ghost(inside: Rep, outward: f64, open: bool, model: &Model, wave: Option<BoundaryWave>) -> Rep {
    if !open {
        return Rep {
            u: -inside.u,
            ..inside
        };
    }
    let exterior_surface = wave.map_or(model.sea, |wave| wave.surface);
    let exterior_depth = (exterior_surface - inside.bed).max(0.0);
    let exterior_normal = if exterior_depth > model.dry {
        wave.map_or(0.0, |wave| wave.outward_velocity)
    } else {
        0.0
    };
    let c0 = sqrt(model.gravity * exterior_depth);
    let c = sqrt(model.gravity * inside.h);
    let normal = inside.u * outward;
    if normal >= c && c > 0.0 {
        return inside;
    }
    if (normal <= -c && c > 0.0) || (exterior_normal < 0.0 && exterior_normal <= -c0) {
        return Rep {
            h: exterior_depth,
            u: if wave.is_some() {
                exterior_normal * outward
            } else {
                0.0
            },
            v: 0.0,
            bed: inside.bed,
        };
    }
    let outgoing = normal + 2.0 * c;
    let incoming = if wave.is_some() {
        exterior_normal - 2.0 * c0
    } else {
        -2.0 * c0
    };
    let characteristic = (0.25 * (outgoing - incoming)).max(0.0);
    Rep {
        h: characteristic * characteristic / model.gravity,
        u: 0.5 * (outgoing + incoming) * outward,
        ..inside
    }
}

struct LaminarBed {
    viscosity_root: f64,
    frequency: f64,
    stokes_root: f64,
}

impl LaminarBed {
    // Real bed impedance of a no-slip, stress-free harmonic Stokes column.
    // If z=(1+i)h/delta and w=tanh(z)/z, the impedance is i*frequency*w/(1-w).
    fn decay(&self, depth: f64, dt: f64) -> f64 {
        let diffusion = self.viscosity_root / depth;
        let stokes_depth = self.stokes_root / diffusion;
        let exponent = if stokes_depth <= 1.0 {
            // Evaluate Re[cosh(z) / ((z cosh(z) - sinh(z))/z^3)] without
            // subtracting near-equal terms. Re(i*frequency) is zero.
            let chi = 2.0 * stokes_depth * stokes_depth;
            let mut c = (1.0, 0.0);
            let mut d = (1.0 / 3.0, 0.0);
            let mut c_term = c;
            let mut d_term = d;
            for n in 0..11 {
                let k = f64::from(2 * n);
                let c_ratio = chi / ((k + 1.0) * (k + 2.0));
                let d_ratio = chi / ((k + 2.0) * (k + 5.0));
                c_term = (-c_term.1 * c_ratio, c_term.0 * c_ratio);
                d_term = (-d_term.1 * d_ratio, d_term.0 * d_ratio);
                c.0 += c_term.0;
                c.1 += c_term.1;
                d.0 += d_term.0;
                d.1 += d_term.1;
            }
            let ratio = (c.0 * d.0 + c.1 * d.1) / (d.0 * d.0 + d.1 * d.1);
            let scaled = diffusion * sqrt(dt);
            (scaled * scaled) * ratio
        } else {
            let half_reciprocal = 0.5 / stokes_depth;
            let (real, negative_imaginary) = if stokes_depth < 20.0 {
                // Scale sinh and cosh by e^(-2a), where a=h/delta, so both
                // components of tanh stay finite at any depth.
                let angle = 2.0 * stokes_depth;
                let e = exp(-angle);
                let e2 = e * e;
                let denominator = 1.0 + e2 + 2.0 * e * cos(angle);
                let tanh_real = (1.0 - e2) / denominator;
                let tanh_imaginary = (2.0 * e * sin(angle)) / denominator;
                (
                    (tanh_real + tanh_imaginary) * half_reciprocal,
                    (tanh_real - tanh_imaginary) * half_reciprocal,
                )
            } else {
                // For a>=20, |tanh(z)-1| < 9e-18. Retain the finite-depth
                // normalization to the depth-mean velocity.
                (half_reciprocal, half_reciprocal)
            };
            let remainder = 1.0 - real;
            let integral = if stokes_depth.is_finite() {
                (self.frequency * dt) * negative_imaginary
            } else {
                // Evaluate omega/(2a) without the overflowing intermediate a.
                ((self.viscosity_root * self.stokes_root) / depth) * dt
            };
            integral / (remainder * remainder + negative_imaginary * negative_imaginary)
        };
        exp(-exponent)
    }
}

struct Sweep {
    axis: usize,
    width: usize,
    lines: usize,
    stride: usize,
    between: usize,
    low_open: bool,
    high_open: bool,
    low_wave: Option<BoundaryWave>,
    high_wave: Option<BoundaryWave>,
}

struct Basin<'a> {
    grid: Grid,
    model: &'a Model,
    bed: *const f64,
    pressure: *const f64,
    incoming: Option<&'a [BoundaryWave; 4]>,
    laminar: Option<LaminarBed>,
}

impl Basin<'_> {
    fn wave(&self, side: usize) -> Option<BoundaryWave> {
        self.incoming
            .map(|waves| waves[side])
            .filter(|wave| wave.active != 0.0)
    }

    unsafe fn primitive(&self, water: *const Water, i: usize, axis: usize) -> Rep {
        let q = if axis == 0 {
            *water.add(i)
        } else {
            (*water.add(i)).swap()
        };
        let (u, v) = q.velocity(self.model.dry);
        Rep {
            h: q.h,
            u,
            v,
            bed: *self.bed.add(i),
        }
    }

    unsafe fn face_state(
        &self,
        water: *const Water,
        index: usize,
        j: usize,
        width: usize,
        axis: usize,
        stride: usize,
        direction: f64,
    ) -> Rep {
        let here = self.primitive(water, index, axis);
        if j == 0 || j + 1 == width || here.h <= self.model.dry {
            return here;
        }
        let before = self.primitive(water, index - stride, axis);
        let after = self.primitive(water, index + stride, axis);
        if before.h <= self.model.dry || after.h <= self.model.dry {
            return here;
        }
        let eta = here.bed + here.h;
        let up = 0.5 * direction;
        Rep {
            h: (here.h + up * slope(eta - (before.bed + before.h), after.bed + after.h - eta))
                .max(0.0),
            u: here.u + up * slope(here.u - before.u, after.u - here.u),
            v: here.v + up * slope(here.v - before.v, after.v - here.v),
            bed: here.bed,
        }
    }

    fn sweep(&self, axis: usize) -> Sweep {
        let (width, lines, stride, between) = self.grid.strides(axis);
        let flags = self.model.open as u32;
        Sweep {
            axis,
            width,
            lines,
            stride,
            between,
            low_open: flags & (1 << (2 * axis)) != 0,
            high_open: flags & (2 << (2 * axis)) != 0,
            low_wave: self.wave(2 * axis),
            high_wave: self.wave(2 * axis + 1),
        }
    }

    unsafe fn line_update(
        &self,
        base: *const Water,
        target: *mut Water,
        ratio: f64,
        sweep: &Sweep,
        row: usize,
    ) -> (f64, f64) {
        let Sweep {
            axis,
            width,
            stride,
            between,
            low_open,
            high_open,
            low_wave,
            high_wave,
            ..
        } = *sweep;
        let start = row * between;
        let mut inside = self.primitive(base, start, axis);
        let outside = ghost(inside, -1.0, low_open, self.model, low_wave);
        let (_, b) = reconstruct(outside, inside, self.model);
        let low = b.h;
        *target.add(start) =
            (*target.add(start)).add(if axis == 0 { b } else { b.swap() }.scale(ratio));
        for j in 0..width - 1 {
            let first = start + j * stride;
            let second = first + stride;
            let left = self.face_state(base, first, j, width, axis, stride, 1.0);
            let right = self.face_state(base, second, j + 1, width, axis, stride, -1.0);
            let (a, b) = reconstruct(left, right, self.model);
            *target.add(first) =
                (*target.add(first)).sub(if axis == 0 { a } else { a.swap() }.scale(ratio));
            *target.add(second) =
                (*target.add(second)).add(if axis == 0 { b } else { b.swap() }.scale(ratio));
        }
        let end = start + (width - 1) * stride;
        inside = self.primitive(base, end, axis);
        let outside = ghost(inside, 1.0, high_open, self.model, high_wave);
        let (a, _) = reconstruct(inside, outside, self.model);
        *target.add(end) =
            (*target.add(end)).sub(if axis == 0 { a } else { a.swap() }.scale(ratio));
        (low, a.h)
    }

    unsafe fn pressure_cell(
        &self,
        base: *const Water,
        target: *mut Water,
        ratio: f64,
        x: usize,
        z: usize,
    ) -> usize {
        let at = self.grid.index(x, z);
        let p = *self.pressure.add(at);
        let left = if x == 0 {
            p
        } else {
            *self.pressure.add(at - 1)
        };
        let right = if x + 1 == self.grid.width {
            p
        } else {
            *self.pressure.add(at + 1)
        };
        let low = if z == 0 {
            p
        } else {
            *self.pressure.add(at - self.grid.width)
        };
        let high = if z + 1 == self.grid.rows {
            p
        } else {
            *self.pressure.add(at + self.grid.width)
        };
        let accel = -0.5 * ratio * (*base.add(at)).h / self.model.density;
        (*target.add(at)).x += (right - left) * accel;
        (*target.add(at)).z += (high - low) * accel;
        at
    }

    unsafe fn flux_update(&self, base: *const Water, target: *mut Water, dt: f64) -> f64 {
        target.copy_from_nonoverlapping(base, self.grid.size);
        let ratio = dt / self.model.spacing;
        let mut outgoing = 0.0;
        for axis in 0..2 {
            let sweep = self.sweep(axis);
            for row in 0..sweep.lines {
                let (low, high) = self.line_update(base, target, ratio, &sweep, row);
                outgoing -= low;
                outgoing += high;
            }
        }
        for z in 0..self.grid.rows {
            for x in 0..self.grid.width {
                self.pressure_cell(base, target, ratio, x, z);
            }
        }
        outgoing * self.model.spacing * dt
    }

    unsafe fn bound(&self, field: *const Water) -> Option<f64> {
        let mut speed: f64 = 0.0;
        for i in 0..self.grid.size {
            let q = *field.add(i);
            let (u, v) = q.velocity(self.model.dry);
            let c = sqrt(self.model.gravity * q.h);
            // Both horizontal directions can drain a cell during one update.
            let local = u.abs() + v.abs() + 4.0 * c;
            if !local.is_finite() {
                return None;
            }
            speed = speed.max(local);
        }
        if self.incoming.is_some() {
            for side in 0..4 {
                let Some(wave) = self.wave(side) else {
                    continue;
                };
                let axis = side / 2;
                let high = side % 2 == 1;
                let (width, lines, step, between) = self.grid.strides(axis);
                let edge = if high { (width - 1) * step } else { 0 };
                let outward = if high { 1.0 } else { -1.0 };
                for row in 0..lines {
                    let inside = self.primitive(field, row * between + edge, axis);
                    let outside = ghost(inside, outward, true, self.model, Some(wave));
                    let local = outside.u.abs()
                        + outside.v.abs()
                        + 4.0 * sqrt(self.model.gravity * outside.h);
                    if !local.is_finite() {
                        return None;
                    }
                    speed = speed.max(local);
                }
            }
        }
        Some(speed)
    }

    fn dissipate(&self, q: &mut Water, dt: f64) {
        let m = self.model;
        if q.h <= m.dry {
            q.x = 0.0;
            q.z = 0.0;
            return;
        }
        if m.roughness > 0.0 {
            let drag = m.gravity * m.roughness * m.roughness * norm(q.x, q.z) / pow(q.h, 7.0 / 3.0);
            let factor = 1.0 / (1.0 + dt * drag);
            q.x *= factor;
            q.z *= factor;
        }
        if let Some(laminar) = &self.laminar {
            let factor = laminar.decay(q.h, dt);
            q.x *= factor;
            q.z *= factor;
        }
        if m.coriolis != 0.0 {
            let rotation = 0.5 * dt * m.coriolis;
            let square = rotation * rotation;
            let (sine, cosine) = if square.is_finite() {
                let inverse = 1.0 / (1.0 + square);
                (2.0 * rotation * inverse, (1.0 - square) * inverse)
            } else {
                // The same Cayley rotation in reciprocal coordinates, with
                // its finite half-turn limit as the half-angle tends to infinity.
                let reciprocal = 1.0 / rotation;
                let square = reciprocal * reciprocal;
                let inverse = 1.0 / (1.0 + square);
                (2.0 * reciprocal * inverse, (square - 1.0) * inverse)
            };
            let x = cosine * q.x - sine * q.z;
            q.z = sine * q.x + cosine * q.z;
            q.x = x;
        }
    }

    fn sanitize_cell(&self, q: &mut Water, old_depth: f64) -> bool {
        if !q.is_finite() {
            return false;
        }
        if q.h < 0.0 {
            if q.h < -64.0 * f64::EPSILON * old_depth {
                return false;
            }
            q.h = 0.0;
        }
        if q.h <= self.model.dry {
            q.x = 0.0;
            q.z = 0.0;
        }
        true
    }

    unsafe fn sanitize(&self, state: *mut Water, old: *const Water) -> bool {
        for i in 0..self.grid.size {
            if !self.sanitize_cell(&mut *state.add(i), (*old.add(i)).h) {
                return false;
            }
        }
        true
    }

    unsafe fn combine(&self, state: *mut Water, trial: *const Water, i: usize, dt: f64) {
        let mut q = (*state.add(i)).add(*trial.add(i)).scale(0.5);
        self.dissipate(&mut q, dt);
        state.add(i).write(q);
    }

    unsafe fn next_step(
        &self,
        state: *const Water,
        remaining: f64,
        dt: f64,
        substeps: u32,
    ) -> Result<f64, StepFailure> {
        if substeps == MAX_CFL_SUBSTEPS {
            return Err(StepFailure::Work);
        }
        let speed = self.bound(state).ok_or(StepFailure::Numeric)?;
        let step = remaining.min(if speed == 0.0 {
            remaining
        } else {
            0.42 * self.model.spacing / speed
        });
        if !(remaining - step < remaining)
            || (substeps == 0 && step < dt / f64::from(MAX_CFL_SUBSTEPS))
        {
            return Err(StepFailure::Work);
        }
        Ok(step)
    }

    unsafe fn integrate(
        &self,
        state: *mut Water,
        rk: *mut Water,
        trial: *mut Water,
        dt: f64,
    ) -> Result<(f64, u32), StepFailure> {
        let mut remaining = dt;
        let mut out = 0.0;
        let mut substeps = 0_u32;
        while remaining > 0.0 {
            let step = self.next_step(state, remaining, dt, substeps)?;
            let first = self.flux_update(state, rk, step);
            if !self.sanitize(rk, state) {
                return Err(StepFailure::Numeric);
            }
            let second = self.flux_update(rk, trial, step);
            if !self.sanitize(trial, rk) {
                return Err(StepFailure::Numeric);
            }
            for i in 0..self.grid.size {
                self.combine(state, trial, i, step);
            }
            out += 0.5 * (first + second);
            remaining -= step;
            substeps += 1;
        }
        Ok((out, substeps))
    }
}

#[repr(C)]
struct Source {
    x: f64,
    z: f64,
    radius: f64,
    pressure: f64,
    volume: f64,
}

fn source_weight(source: &Source, x: f64, z: f64) -> f64 {
    let dx = (x - source.x) / source.radius;
    let dz = (z - source.z) / source.radius;
    let radial = (1.0 - dx * dx - dz * dz).max(0.0);
    radial * radial
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_sources(
    state: *mut Water,
    pressure: *mut f64,
    nx: u32,
    nz: u32,
    model: *const Model,
    sources: *const Source,
    count: u32,
    dx: f64,
    dz: f64,
    inject: u32,
    report: *mut f64,
) -> u32 {
    let m = &*model;
    let grid = Grid {
        width: nx as usize,
        rows: nz as usize,
        size: nx as usize * nz as usize,
    };
    let area = m.spacing * m.spacing;
    let mut accepted = 0.0;
    let mut proposed = 0.0;
    for i in 0..count as usize {
        let src = &*sources.add(i);
        let volume = if inject == 0 { 0.0 } else { src.volume };
        if volume == 0.0 && src.pressure == 0.0 {
            continue;
        }
        let source = Source {
            x: src.x + dx,
            z: src.z + dz,
            radius: src.radius,
            pressure: src.pressure,
            volume,
        };
        if !(source.x.is_finite()
            && source.z.is_finite()
            && source.radius > 0.0
            && source.radius.is_finite()
            && source.volume.is_finite()
            && source.pressure.is_finite())
        {
            return 1;
        }
        proposed += source.volume;
        let x0 = floor((source.x - source.radius - m.origin_x) / m.spacing).max(0.0) as usize;
        let z0 = floor((source.z - source.radius - m.origin_z) / m.spacing).max(0.0) as usize;
        let x1 = ((floor((source.x + source.radius - m.origin_x) / m.spacing) + 1.0).max(0.0)
            as usize)
            .min(grid.width);
        let z1 = ((floor((source.z + source.radius - m.origin_z) / m.spacing) + 1.0).max(0.0)
            as usize)
            .min(grid.rows);
        let mut weights = 0.0;
        for z in z0..z1 {
            for x in x0..x1 {
                let wx = m.origin_x + (x as f64 + 0.5) * m.spacing;
                let wz = m.origin_z + (z as f64 + 0.5) * m.spacing;
                weights += source_weight(&source, wx, wz);
            }
        }
        if weights == 0.0 {
            let x = floor((source.x - m.origin_x) / m.spacing);
            let z = floor((source.z - m.origin_z) / m.spacing);
            if x >= 0.0 && z >= 0.0 && x < f64::from(nx) && z < f64::from(nz) {
                let at = grid.index(x as usize, z as usize);
                *pressure.add(at) += source.pressure;
                accepted += inject_water(&mut *state.add(at), source.volume / area) * area;
            }
            continue;
        }
        for z in z0..z1 {
            for x in x0..x1 {
                let wx = m.origin_x + (x as f64 + 0.5) * m.spacing;
                let wz = m.origin_z + (z as f64 + 0.5) * m.spacing;
                let weight = source_weight(&source, wx, wz);
                let key = grid.index(x, z);
                *pressure.add(key) += source.pressure * weight;
                accepted += inject_water(
                    &mut *state.add(key),
                    weight * source.volume / (area * weights),
                ) * area;
            }
        }
    }
    if !(accepted.is_finite() && proposed.is_finite()) {
        return 1;
    }
    *report += accepted;
    *report.add(1) += proposed - accepted;
    0
}

fn inject_water(point: &mut Water, depth: f64) -> f64 {
    let old = point.h;
    let change = depth.max(-old);
    point.h += change;
    if change < 0.0 {
        let remaining = point.h / old;
        point.x *= remaining;
        point.z *= remaining;
    }
    change
}

fn laminar_bed(
    model: &Model,
    viscosity: f64,
    frequency: f64,
) -> Result<Option<LaminarBed>, StepFailure> {
    if viscosity == 0.0 {
        Ok(None)
    } else if viscosity > 0.0
        && viscosity.is_finite()
        && frequency > 0.0
        && frequency.is_finite()
        && model.roughness == 0.0
    {
        Ok(Some(LaminarBed {
            viscosity_root: sqrt(viscosity),
            frequency,
            stokes_root: sqrt(frequency) * core::f64::consts::FRAC_1_SQRT_2,
        }))
    } else {
        Err(StepFailure::Numeric)
    }
}

fn valid_tick(dt: f64, time: f64) -> bool {
    dt.is_finite() && dt > 0.0 && time.is_finite() && time >= 0.0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_step(
    state: *mut Water,
    rk: *mut Water,
    trial: *mut Water,
    bed: *const f64,
    pressure: *const f64,
    parameters: *const Model,
    nx: u32,
    nz: u32,
    log: *mut f64,
    metrics: *mut f64,
    dt: f64,
    time: f64,
    incoming: *const [BoundaryWave; 4],
    kinematic_viscosity: f64,
    angular_frequency: f64,
) -> u32 {
    let grid = Grid {
        width: nx as usize,
        rows: nz as usize,
        size: nx as usize * nz as usize,
    };
    let model = &*parameters;
    let laminar = match laminar_bed(model, kinematic_viscosity, angular_frequency) {
        Ok(laminar) => laminar,
        Err(reason) => return reason as u32,
    };
    let basin = Basin {
        grid,
        model,
        bed,
        pressure,
        incoming: incoming.as_ref(),
        laminar,
    };
    if !valid_tick(dt, time) {
        return StepFailure::Numeric as u32;
    }
    let (out, iterations) = match basin.integrate(state, rk, trial, dt) {
        Ok(receipt) => receipt,
        Err(reason) => return reason as u32,
    };
    write_receipt(&basin, state, log, metrics, time, out, iterations)
}

unsafe fn write_receipt(
    basin: &Basin<'_>,
    state: *const Water,
    log: *mut f64,
    metrics: *mut f64,
    time: f64,
    out: f64,
    iterations: u32,
) -> u32 {
    let grid = basin.grid;
    let model = basin.model;
    let mut volume = 0.0;
    let mut area = 0.0;
    let mut runup = model.sea;
    let mut peak: f64 = 0.0;
    for i in 0..grid.size {
        let q = &*state.add(i);
        let elevation = *basin.bed.add(i);
        let surface = elevation + q.h;
        let (u, v) = q.velocity(model.dry);
        if !(q.is_finite() && surface.is_finite() && u.is_finite() && v.is_finite()) {
            return StepFailure::Numeric as u32;
        }
        if q.h > model.dry {
            let wet = log.add(2 * i);
            *wet = (*wet).max(q.h);
            if *wet.add(1) < 0.0 {
                *wet.add(1) = time;
            }
            if elevation >= model.sea {
                runup = runup.max(surface);
                area += 1.0;
            }
        }
        peak = peak.max(q.h);
        volume += q.h;
    }
    let cell_area = model.spacing * model.spacing;
    let receipt = [
        volume * cell_area,
        out,
        area * cell_area,
        runup,
        peak,
        f64::from(iterations),
    ];
    if !(receipt.iter().all(|value| value.is_finite()) && (runup - model.sea).is_finite()) {
        return StepFailure::Numeric as u32;
    }
    metrics.copy_from_nonoverlapping(receipt.as_ptr(), receipt.len());
    0
}

// The host publishes this scratch job before its workers read it and waits
// for every worker before changing it. Pointers are arena byte offsets.
#[repr(C)]
struct ThreadJob {
    state: u32,
    rk: u32,
    trial: u32,
    bed: u32,
    pressure: u32,
    model: u32,
    nx: u32,
    nz: u32,
    log: u32,
    metrics: u32,
    incoming: u32,
    ledger: u32,
    dt: f64,
    time: f64,
    viscosity: f64,
    frequency: f64,
    remaining: f64,
    step: f64,
    out: f64,
    iterations: f64,
}

const _: () = assert!(core::mem::size_of::<ThreadJob>() == 112);
const THREAD_FINISHED: u32 = 3;

impl ThreadJob {
    unsafe fn basin(&self) -> Result<Basin<'_>, StepFailure> {
        let width = self.nx as usize;
        let rows = self.nz as usize;
        let size = width.checked_mul(rows).ok_or(StepFailure::Numeric)?;
        if size == 0 {
            return Err(StepFailure::Numeric);
        }
        let model = &*(self.model as *const Model);
        Ok(Basin {
            grid: Grid { width, rows, size },
            model,
            bed: self.bed as *const f64,
            pressure: self.pressure as *const f64,
            incoming: (self.incoming as *const [BoundaryWave; 4]).as_ref(),
            laminar: laminar_bed(model, self.viscosity, self.frequency)?,
        })
    }

    fn valid(&self) -> bool {
        valid_tick(self.dt, self.time)
            && (0.0..=self.dt).contains(&self.remaining)
            && (0.0..=f64::from(MAX_CFL_SUBSTEPS)).contains(&self.iterations)
    }
}

fn partition(len: usize, part: u32, parts: u32) -> core::ops::Range<usize> {
    let len = len as u64;
    let parts = u64::from(parts);
    let part = u64::from(part);
    ((part * len) / parts) as usize..(((part + 1) * len) / parts) as usize
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_thread_plan(job: *mut ThreadJob) -> u32 {
    let Some(job) = job.as_mut() else {
        return StepFailure::Numeric as u32;
    };
    if !job.valid() || job.step != 0.0 {
        return StepFailure::Numeric as u32;
    }
    if job.remaining == 0.0 {
        return THREAD_FINISHED;
    }
    let basin = match job.basin() {
        Ok(basin) => basin,
        Err(reason) => return reason as u32,
    };
    let next = basin.next_step(
        job.state as *const Water,
        job.remaining,
        job.dt,
        job.iterations as u32,
    );
    match next {
        Ok(step) => {
            job.step = step;
            0
        }
        Err(reason) => reason as u32,
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_thread_phase(
    job: *const ThreadJob,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    let Some(job) = job.as_ref() else {
        return StepFailure::Numeric as u32;
    };
    if !(job.step > 0.0 && job.step <= job.remaining && stage < 6 && part < parts) {
        return StepFailure::Numeric as u32;
    }
    let basin = match job.basin() {
        Ok(basin) => basin,
        Err(reason) => return reason as u32,
    };
    let state = job.state as *mut Water;
    let rk = job.rk as *mut Water;
    let trial = job.trial as *mut Water;
    let second = stage >= 3;
    let (base, target) = if second {
        (rk.cast_const(), trial)
    } else {
        (state.cast_const(), rk)
    };
    let ratio = job.step / basin.model.spacing;
    let phase = (stage % 3) as usize;
    if phase < 2 {
        let sweep = basin.sweep(phase);
        let mut offset = 0;
        if second {
            offset += 2 * (basin.grid.width + basin.grid.rows);
        }
        if phase == 1 {
            offset += 2 * basin.grid.rows;
        }
        let ledger = (job.ledger as *mut f64).add(offset);
        for row in partition(sweep.lines, part, parts) {
            if phase == 0 {
                let start = row * sweep.width;
                target
                    .add(start)
                    .copy_from_nonoverlapping(base.add(start), sweep.width);
            }
            let (low, high) = basin.line_update(base, target, ratio, &sweep, row);
            ledger.add(2 * row).write(low);
            ledger.add(2 * row + 1).write(high);
        }
    } else {
        let cells = partition(basin.grid.size, part, parts);
        let width = basin.grid.width;
        for z in cells.start / width..cells.end.div_ceil(width) {
            let row = z * width;
            for x in cells.start.saturating_sub(row)..(cells.end - row).min(width) {
                let i = basin.pressure_cell(base, target, ratio, x, z);
                if !basin.sanitize_cell(&mut *target.add(i), (*base.add(i)).h) {
                    return StepFailure::Numeric as u32;
                }
                if second {
                    basin.combine(state, trial, i, job.step);
                }
            }
        }
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_thread_accept(job: *mut ThreadJob) -> u32 {
    let Some(job) = job.as_mut() else {
        return StepFailure::Numeric as u32;
    };
    if !job.valid() || !(job.step > 0.0 && job.step <= job.remaining) {
        return StepFailure::Numeric as u32;
    }
    let model = &*(job.model as *const Model);
    let ledger = job.ledger as *const f64;
    let lines = job.nx as usize + job.nz as usize;
    let fold = |start: usize| {
        let mut outgoing = 0.0;
        for line in start..start + lines {
            outgoing -= *ledger.add(2 * line);
            outgoing += *ledger.add(2 * line + 1);
        }
        outgoing * model.spacing * job.step
    };
    job.out += 0.5 * (fold(0) + fold(lines));
    job.remaining -= job.step;
    job.step = 0.0;
    job.iterations += 1.0;
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_thread_finish(job: *const ThreadJob) -> u32 {
    let Some(job) = job.as_ref() else {
        return StepFailure::Numeric as u32;
    };
    if !job.valid() || job.remaining != 0.0 || job.step != 0.0 {
        return StepFailure::Numeric as u32;
    }
    let basin = match job.basin() {
        Ok(basin) => basin,
        Err(reason) => return reason as u32,
    };
    write_receipt(
        &basin,
        job.state as *const Water,
        job.log as *mut f64,
        job.metrics as *mut f64,
        job.time,
        job.out,
        job.iterations as u32,
    )
}

// The eikonal update uses the smaller neighbour along each horizontal axis.
unsafe fn travel_neighbours(grid: Grid, out: *const f64, x: usize, z: usize) -> (f64, f64) {
    let i = grid.index(x, z);
    let left = if x == 0 {
        f64::INFINITY
    } else {
        *out.add(i - 1)
    };
    let right = if x + 1 == grid.width {
        f64::INFINITY
    } else {
        *out.add(i + 1)
    };
    let low = if z == 0 {
        f64::INFINITY
    } else {
        *out.add(i - grid.width)
    };
    let high = if z + 1 == grid.rows {
        f64::INFINITY
    } else {
        *out.add(i + grid.width)
    };
    let x_time = left.min(right);
    let z_time = low.min(high);
    (x_time.min(z_time), x_time.max(z_time))
}

fn travel_arrival(model: &Model, bed: f64, depth: f64, near: f64, far: f64) -> f64 {
    // For an overflowing depth difference, halve the depth and scale the
    // numerator by the same square-root factor to retain the physical speed.
    let (distance, depth) = if depth.is_finite() {
        (model.spacing, depth)
    } else {
        (
            model.spacing * core::f64::consts::FRAC_1_SQRT_2,
            0.5 * model.sea - 0.5 * bed,
        )
    };
    let c2 = model.gravity * depth;
    let speed = if c2.is_normal() {
        sqrt(c2)
    } else {
        sqrt(model.gravity) * sqrt(depth)
    };
    let cost = distance / speed;
    let diff = far - near;
    if cost == 0.0 {
        return if near == 0.0 { f64::NAN } else { near };
    }
    if !cost.is_finite() {
        // The two-neighbour diagonal can still fit when the axis cost does not.
        let half_cost = (0.5 * distance) / speed;
        return if half_cost.is_finite() && far.is_finite() {
            let ratio = (0.5 * diff) / half_cost;
            near + half_cost * (ratio + sqrt(2.0 - ratio * ratio))
        } else {
            f64::INFINITY
        };
    }
    if diff >= cost {
        return near + cost;
    }
    let discriminant = 2.0 * cost * cost - diff * diff;
    if discriminant.is_normal() {
        near + 0.5 * (diff + sqrt(discriminant))
    } else {
        let ratio = diff / cost;
        near + cost * (0.5 * (ratio + sqrt(2.0 - ratio * ratio)))
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_travel(
    bed: *const f64,
    out: *mut f64,
    parameters: *const Model,
    nx: u32,
    nz: u32,
    source: u32,
) -> u32 {
    let grid = Grid {
        width: nx as usize,
        rows: nz as usize,
        size: nx as usize * nz as usize,
    };
    let m = &*parameters;
    for i in 0..grid.size {
        out.add(i).write(f64::INFINITY);
    }
    if source as usize >= grid.size || m.sea - *bed.add(source as usize) <= m.dry {
        return 0;
    }
    out.add(source as usize).write(0.0);
    // Monotone alternating sweeps of the first-order upwind eikonal equation.
    // Each sweep can reach at least as far as a monotone set of grid edges.
    for _ in 0..grid.size {
        let mut revised = false;
        for direction in 0..4 {
            for row in 0..grid.rows {
                let z = if direction & 2 == 0 {
                    row
                } else {
                    grid.rows - 1 - row
                };
                for column in 0..grid.width {
                    let x = if direction & 1 == 0 {
                        column
                    } else {
                        grid.width - 1 - column
                    };
                    let i = grid.index(x, z);
                    let elevation = *bed.add(i);
                    let h = m.sea - elevation;
                    if i == source as usize || h <= m.dry {
                        continue;
                    }
                    let (near, far) = travel_neighbours(grid, out, x, z);
                    if !near.is_finite() {
                        continue;
                    }
                    let t = travel_arrival(m, elevation, h, near, far);
                    if t.is_nan() {
                        return StepFailure::Numeric as u32;
                    }
                    if t < *out.add(i) {
                        *out.add(i) = t;
                        revised = true;
                    }
                }
            }
        }
        if !revised {
            break;
        }
    }
    // Keep infinity as the dry/disconnected sentinel. A wet cell adjoining
    // a reached cell is connected by definition, so reject an unresolved time.
    for z in 0..grid.rows {
        for x in 0..grid.width {
            let i = grid.index(x, z);
            if !(*out.add(i)).is_finite()
                && m.sea - *bed.add(i) > m.dry
                && travel_neighbours(grid, out, x, z).0.is_finite()
            {
                return StepFailure::Numeric as u32;
            }
        }
    }
    0
}

unsafe fn bottom_row(
    state: *const Water,
    input: *const f64,
    grid: Grid,
    i: usize,
    factor: f64,
    dry: f64,
) -> (f64, f64) {
    let mut value = *input.add(i);
    let mut diagonal = 1.0;
    if (*state.add(i)).h <= dry {
        return (value, diagonal);
    }
    let x = i.checked_rem(grid.width).unwrap_or_else(|| unreachable());
    let z = i.checked_div(grid.width).unwrap_or_else(|| unreachable());
    let mut add = |j: usize| {
        if (*state.add(j)).h > dry {
            value += factor * (*input.add(i) - *input.add(j));
            diagonal += factor;
        }
    };
    if x > 0 {
        add(i - 1);
    }
    if x + 1 < grid.width {
        add(i + 1);
    }
    if z > 0 {
        add(i - grid.width);
    }
    if z + 1 < grid.rows {
        add(i + grid.width);
    }
    (value, diagonal)
}

// A volume-conserving Padé approximation of the linear Kajiura transfer
// sech(kh). The boundary condition is zero normal flux over the wet patch.
#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_bottom(
    state: *mut Water,
    previous: *const f64,
    next: *const f64,
    parameters: *const Model,
    nx: u32,
    nz: u32,
    filter_depth: f64,
    memory: *mut f64,
) -> u32 {
    let grid = Grid {
        width: nx as usize,
        rows: nz as usize,
        size: nx as usize * nz as usize,
    };
    let model = &*parameters;
    let n = grid.size;
    let increment = memory;
    let step = memory.add(n);
    let residual = memory.add(2 * n);
    let product = memory.add(3 * n);
    let inv_diag = memory.add(4 * n);
    let ratio = filter_depth / model.spacing;
    let factor = 0.5 * ratio * ratio;
    let mut rhs = 0.0;
    let mut lap = 0.0;
    for i in 0..n {
        if (*state.add(i)).h > model.dry {
            let change = *next.add(i) - *previous.add(i);
            rhs += change * change;
            residual.add(i).write(change);
        } else {
            residual.add(i).write(0.0);
        }
        increment.add(i).write(0.0);
    }
    if rhs == 0.0 {
        return 0;
    }
    for i in 0..n {
        let (_, diag) = bottom_row(state, increment, grid, i, factor, model.dry);
        inv_diag.add(i).write(1.0 / diag);
        let r = *residual.add(i);
        let seed = r / diag;
        step.add(i).write(seed);
        lap += r * seed;
    }
    let mut converged = false;
    for _ in 0..n {
        let mut denom = 0.0;
        for i in 0..n {
            let (value, _) = bottom_row(state, step, grid, i, factor, model.dry);
            product.add(i).write(value);
            denom += value * *step.add(i);
        }
        if !(denom > 0.0 && denom.is_finite()) {
            return 1;
        }
        let alpha = lap / denom;
        let mut norm = 0.0;
        let mut inner = 0.0;
        for i in 0..n {
            *increment.add(i) += alpha * *step.add(i);
            *residual.add(i) -= alpha * *product.add(i);
            let sq = *residual.add(i) * *residual.add(i);
            norm += sq;
            inner += sq * *inv_diag.add(i);
        }
        if norm <= rhs * 1e-22 {
            converged = true;
            break;
        }
        let beta = inner / lap;
        lap = inner;
        for i in 0..n {
            *step.add(i) = *residual.add(i) * *inv_diag.add(i) + beta * *step.add(i);
        }
    }
    if !converged {
        return 1;
    }
    // Correct the zero mode of each face solve with its conservative divergence.
    // Using delta minus M*filtered_delta avoids applying the approximate CG zero mode.
    for i in 0..n {
        let (ap, _) = bottom_row(state, increment, grid, i, factor, model.dry);
        product.add(i).write(*increment.add(i) - ap);
    }
    for i in 0..n {
        let q = &mut *state.add(i);
        let h = q.h + *product.add(i);
        if !(h >= 0.0 && h.is_finite()) {
            return 2;
        }
        q.h = h;
    }
    0
}
