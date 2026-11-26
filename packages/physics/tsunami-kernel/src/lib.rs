#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
};
use margoengine_physics_kernel_common::pinned::pow;

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

fn ghost(inside: Rep, outward: f64, open: bool, model: &Model) -> Rep {
    if !open {
        return Rep {
            u: -inside.u,
            ..inside
        };
    }
    let undisturbed = (model.sea - inside.bed).max(0.0);
    let c0 = sqrt(model.gravity * undisturbed);
    let c = sqrt(model.gravity * inside.h);
    let normal = inside.u * outward;
    if normal >= c && c > 0.0 {
        return inside;
    }
    if normal <= -c && c > 0.0 {
        return Rep {
            h: undisturbed,
            u: 0.0,
            v: 0.0,
            bed: inside.bed,
        };
    }
    let outgoing = normal + 2.0 * c;
    let incoming = -2.0 * c0;
    let characteristic = (0.25 * (outgoing - incoming)).max(0.0);
    Rep {
        h: characteristic * characteristic / model.gravity,
        u: 0.5 * (outgoing + incoming) * outward,
        ..inside
    }
}

struct Basin<'a> {
    grid: Grid,
    model: &'a Model,
    bed: *const f64,
    pressure: *const f64,
}

impl Basin<'_> {
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

    unsafe fn flux_update(&self, base: *const Water, target: *mut Water, dt: f64) -> f64 {
        target.copy_from_nonoverlapping(base, self.grid.size);
        let ratio = dt / self.model.spacing;
        let mut outgoing = 0.0;
        let flags = self.model.open as u32;
        for axis in 0..2 {
            let (width, lines, step, between) = self.grid.strides(axis);
            let low_open = flags & (1 << (2 * axis)) != 0;
            let high_open = flags & (2 << (2 * axis)) != 0;
            for row in 0..lines {
                let start = row * between;
                let mut inside = self.primitive(base, start, axis);
                let outside = ghost(inside, -1.0, low_open, self.model);
                let (_, b) = reconstruct(outside, inside, self.model);
                outgoing -= b.h;
                *target.add(start) =
                    (*target.add(start)).add(if axis == 0 { b } else { b.swap() }.scale(ratio));
                for j in 0..width - 1 {
                    let first = start + j * step;
                    let second = first + step;
                    let left = self.face_state(base, first, j, width, axis, step, 1.0);
                    let right = self.face_state(base, second, j + 1, width, axis, step, -1.0);
                    let (a, b) = reconstruct(left, right, self.model);
                    *target.add(first) =
                        (*target.add(first)).sub(if axis == 0 { a } else { a.swap() }.scale(ratio));
                    *target.add(second) = (*target.add(second))
                        .add(if axis == 0 { b } else { b.swap() }.scale(ratio));
                }
                let end = start + (width - 1) * step;
                inside = self.primitive(base, end, axis);
                let outside = ghost(inside, 1.0, high_open, self.model);
                let (a, _) = reconstruct(inside, outside, self.model);
                outgoing += a.h;
                *target.add(end) =
                    (*target.add(end)).sub(if axis == 0 { a } else { a.swap() }.scale(ratio));
            }
        }
        for z in 0..self.grid.rows {
            for x in 0..self.grid.width {
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
            }
        }
        outgoing * self.model.spacing * dt
    }

    unsafe fn bound(&self, field: *const Water) -> f64 {
        let mut speed: f64 = 0.0;
        for i in 0..self.grid.size {
            let q = *field.add(i);
            let (u, v) = q.velocity(self.model.dry);
            let c = sqrt(self.model.gravity * q.h);
            // Both horizontal directions can drain a cell during one update.
            speed = speed.max(u.abs() + v.abs() + 4.0 * c);
        }
        speed
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
        if m.coriolis != 0.0 {
            let rotation = 0.5 * dt * m.coriolis;
            let inverse = 1.0 / (1.0 + rotation * rotation);
            let sine = 2.0 * rotation * inverse;
            let cosine = (1.0 - rotation * rotation) * inverse;
            let x = cosine * q.x - sine * q.z;
            q.z = sine * q.x + cosine * q.z;
            q.x = x;
        }
    }

    unsafe fn sanitize(&self, state: *mut Water, old: *const Water) -> bool {
        for i in 0..self.grid.size {
            let q = &mut *state.add(i);
            if !(q.h.is_finite() && q.x.is_finite() && q.z.is_finite()) {
                return false;
            }
            if q.h < 0.0 {
                if q.h < -64.0 * f64::EPSILON * (*old.add(i)).h {
                    return false;
                }
                q.h = 0.0;
            }
            if q.h <= self.model.dry {
                q.x = 0.0;
                q.z = 0.0;
            }
        }
        true
    }

    unsafe fn integrate(
        &self,
        state: *mut Water,
        rk: *mut Water,
        trial: *mut Water,
        dt: f64,
    ) -> Option<(f64, u32)> {
        let mut remaining = dt;
        let mut out = 0.0;
        let mut substeps = 0_u32;
        while remaining > 0.0 {
            let speed = self.bound(state);
            let step = remaining.min(if speed == 0.0 {
                remaining
            } else {
                0.42 * self.model.spacing / speed
            });
            let next = remaining - step;
            if !(step.is_finite() && next < remaining) {
                return None;
            }
            let first = self.flux_update(state, rk, step);
            if !self.sanitize(rk, state) {
                return None;
            }
            let second = self.flux_update(rk, trial, step);
            if !self.sanitize(trial, rk) {
                return None;
            }
            for i in 0..self.grid.size {
                let mut q = (*state.add(i)).add(*trial.add(i)).scale(0.5);
                self.dissipate(&mut q, step);
                state.add(i).write(q);
            }
            out += 0.5 * (first + second);
            remaining = next;
            substeps += 1;
        }
        Some((out, substeps))
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
) -> u32 {
    let grid = Grid {
        width: nx as usize,
        rows: nz as usize,
        size: nx as usize * nz as usize,
    };
    let model = &*parameters;
    let basin = Basin {
        grid,
        model,
        bed,
        pressure,
    };
    let Some((out, iterations)) = basin.integrate(state, rk, trial, dt) else {
        return 1;
    };
    let mut volume = 0.0;
    let mut area = 0.0;
    let mut runup = model.sea;
    let mut peak: f64 = 0.0;
    for i in 0..grid.size {
        let q = &*state.add(i);
        let elevation = *bed.add(i);
        if q.h > model.dry {
            let wet = log.add(2 * i);
            *wet = (*wet).max(q.h);
            if *wet.add(1) < 0.0 {
                *wet.add(1) = time;
            }
            if elevation >= model.sea {
                runup = runup.max(elevation + q.h);
                area += 1.0;
            }
        }
        peak = peak.max(q.h);
        volume += q.h;
    }
    let cell_area = model.spacing * model.spacing;
    metrics.write(volume * cell_area);
    metrics.add(1).write(out);
    metrics.add(2).write(area * cell_area);
    metrics.add(3).write(runup);
    metrics.add(4).write(peak);
    metrics.add(5).write(f64::from(iterations));
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn tsunami_travel(
    bed: *const f64,
    out: *mut f64,
    parameters: *const Model,
    nx: u32,
    nz: u32,
    source: u32,
) {
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
        return;
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
                    let h = m.sea - *bed.add(i);
                    if i == source as usize || h <= m.dry {
                        continue;
                    }
                    let l = if x == 0 {
                        f64::INFINITY
                    } else {
                        *out.add(i - 1)
                    };
                    let r = if x + 1 == grid.width {
                        f64::INFINITY
                    } else {
                        *out.add(i + 1)
                    };
                    let b = if z == 0 {
                        f64::INFINITY
                    } else {
                        *out.add(i - grid.width)
                    };
                    let t = if z + 1 == grid.rows {
                        f64::INFINITY
                    } else {
                        *out.add(i + grid.width)
                    };
                    let a = l.min(r);
                    let b = b.min(t);
                    let near = a.min(b);
                    if !near.is_finite() {
                        continue;
                    }
                    let cost = m.spacing / sqrt(m.gravity * h);
                    let diff = a.max(b) - near;
                    let t = if diff >= cost {
                        near + cost
                    } else {
                        near + 0.5 * (diff + sqrt(2.0 * cost * cost - diff * diff))
                    };
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
