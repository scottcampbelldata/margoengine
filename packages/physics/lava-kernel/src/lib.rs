#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
};
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
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

fn length(x: f64, z: f64) -> f64 {
    let pair = f64x2(x, z);
    let square = f64x2_mul(pair, pair);
    sqrt(f64x2_extract_lane::<0>(square) + f64x2_extract_lane::<1>(square))
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Lava {
    depth: f64,
    qx: f64,
    qz: f64,
    heat: f64,
}

#[repr(C)]
struct Model {
    gravity: f64,
    spacing: f64,
    density: f64,
    cp: f64,
    latent: f64,
    solidus: f64,
    liquidus: f64,
    viscosity: f64,
    viscosity_rise: f64,
    yield_stress: f64,
    yield_rise: f64,
    air: f64,
    ground: f64,
    emissivity: f64,
    convection: f64,
    conductivity: f64,
    skin: f64,
    water_coefficient: f64,
    water_level: f64,
    water_temperature: f64,
}

impl Model {
    fn yield_strength(&self, temperature: f64) -> f64 {
        if self.yield_stress == 0.0 {
            return 0.0;
        }
        self.yield_stress
            * exp(self.yield_rise * (self.liquidus - temperature.max(self.solidus)).max(0.0))
    }

    fn capacity(&self) -> f64 {
        self.cp + self.latent / (self.liquidus - self.solidus)
    }

    fn phase(&self, depth: f64, heat: f64) -> (f64, f64) {
        if depth == 0.0 {
            return (self.air, 0.0);
        }
        let specific = heat / depth;
        let solid = self.cp * self.solidus;
        if specific <= solid {
            return (specific / self.cp, 0.0);
        }
        let liquid = self.cp * self.liquidus + self.latent;
        if specific >= liquid {
            return ((specific - self.latent) / self.cp, 1.0);
        }
        let offset = (specific - solid) / self.capacity();
        (
            self.solidus + offset,
            offset / (self.liquidus - self.solidus),
        )
    }

    fn enthalpy(&self, temperature: f64) -> f64 {
        self.cp * temperature
            + self.latent
                * ((temperature - self.solidus) / (self.liquidus - self.solidus)).clamp(0.0, 1.0)
    }

    fn surface(&self, temperature: f64, crust: f64, wet: bool) -> (f64, f64, f64) {
        let conduction = self.conductivity / (self.skin + crust);
        let film = if wet { self.water_coefficient } else { 0.0 };
        let sigma = self.emissivity * 5.670374419e-8;
        let ar = self.air * self.air;
        let lower = temperature.min(self.air).min(self.water_temperature);
        let upper = temperature.max(self.air).max(self.water_temperature);
        let (mut low, mut high) = (lower, upper);
        for _ in 0..40 {
            let skin = 0.5 * (low + high);
            let sq = skin * skin;
            let transfer = sigma * (sq * sq - ar * ar)
                + self.convection * (skin - self.air)
                + film * (skin - self.water_temperature);
            if conduction * (temperature - skin) > transfer {
                low = skin;
            } else {
                high = skin;
            }
        }
        let skin = 0.5 * (low + high);
        let square = skin * skin;
        let air = sigma * (square * square - ar * ar) + self.convection * (skin - self.air);
        (skin, air, film * (skin - self.water_temperature))
    }
}

#[derive(Clone, Copy)]
struct Primitive {
    liquid: f64,
    bed: f64,
    u: f64,
    v: f64,
    heat: f64,
    yield_strength: f64,
}

impl Primitive {
    fn get(cell: Lava, bed: f64, model: &Model, axis: usize) -> Self {
        let (temperature, fraction) = model.phase(cell.depth, cell.heat);
        let liquid = fraction * cell.depth;
        let (normal, cross) = if axis == 0 {
            (cell.qx, cell.qz)
        } else {
            (cell.qz, cell.qx)
        };
        let (u, v) = if liquid > 0.0 {
            (normal / liquid, cross / liquid)
        } else {
            (0.0, 0.0)
        };
        Self {
            liquid,
            bed: bed + (cell.depth - liquid),
            u,
            v,
            heat: model.cp * temperature + model.latent,
            yield_strength: model.yield_strength(temperature),
        }
    }

    fn reflect(self) -> Self {
        Self { u: -self.u, ..self }
    }
}

#[derive(Clone, Copy)]
struct Flux {
    mass: f64,
    normal: f64,
    cross: f64,
    heat: f64,
}

fn pressure(gravity: f64, h: f64) -> f64 {
    0.5 * gravity * h * h
}

fn face(a: Primitive, b: Primitive, model: &Model) -> (Flux, Flux) {
    let g = model.gravity;
    let step = a.bed.max(b.bed);
    let ha = (a.liquid - (step - a.bed)).max(0.0);
    let hb = (b.liquid - (step - b.bed)).max(0.0);
    let mut flux = Flux {
        mass: 0.0,
        normal: 0.0,
        cross: 0.0,
        heat: 0.0,
    };
    let head = (a.bed + a.liquid - b.bed - b.liquid).abs();
    let drive = model.density * g * a.liquid.max(b.liquid) * head / model.spacing;
    let yield_strength = if a.liquid == 0.0 {
        b.yield_strength
    } else if b.liquid == 0.0 {
        a.yield_strength
    } else {
        a.yield_strength.min(b.yield_strength)
    };
    if yield_strength > 0.0 && a.u == 0.0 && b.u == 0.0 && drive <= yield_strength {
        return (
            Flux {
                normal: pressure(g, a.liquid),
                ..flux
            },
            Flux {
                normal: pressure(g, b.liquid),
                ..flux
            },
        );
    }
    if ha > 0.0 || hb > 0.0 {
        let (ua, va) = if ha > 0.0 { (a.u, a.v) } else { (0.0, 0.0) };
        let (ub, vb) = if hb > 0.0 { (b.u, b.v) } else { (0.0, 0.0) };
        let ca = sqrt(g * ha);
        let cb = sqrt(g * hb);
        let negative = (ua - ca).min(ub - cb).min(0.0);
        let positive = (ua + ca).max(ub + cb).max(0.0);
        let qa = ha * ua;
        let qb = hb * ub;
        let divide = 1.0 / (positive - negative);
        let hll = |fa, fb, xa, xb| {
            (positive * fa - negative * fb + negative * positive * (xb - xa)) * divide
        };
        flux.mass = hll(qa, qb, ha, hb);
        flux.normal = hll(qa * ua + pressure(g, ha), qb * ub + pressure(g, hb), qa, qb);
        flux.cross = hll(qa * va, qb * vb, ha * va, hb * vb);
        flux.heat = flux.mass * if flux.mass >= 0.0 { a.heat } else { b.heat };
    }
    (
        Flux {
            normal: flux.normal + pressure(g, a.liquid) - pressure(g, ha),
            ..flux
        },
        Flux {
            normal: flux.normal + pressure(g, b.liquid) - pressure(g, hb),
            ..flux
        },
    )
}

fn apply(cell: &mut Lava, flux: Flux, ratio: f64, axis: usize) {
    cell.depth += ratio * flux.mass;
    cell.heat += ratio * flux.heat;
    if axis == 0 {
        cell.qx += ratio * flux.normal;
        cell.qz += ratio * flux.cross;
    } else {
        cell.qx += ratio * flux.cross;
        cell.qz += ratio * flux.normal;
    }
}

fn resistance(q: f64, h: f64, temperature: f64, model: &Model, dt: f64) -> f64 {
    let offset = (model.liquidus - temperature).max(0.0);
    let viscosity = model.viscosity * exp(model.viscosity_rise * offset) / model.density;
    let yield_accel = model.yield_strength(temperature) / (model.density * h);
    if yield_accel == 0.0 {
        return q / (1.0 + 3.0 * viscosity * dt / (h * h));
    }
    if q <= dt * h * yield_accel {
        return 0.0;
    }
    // Implicit momentum balance with the exact wide-sheet Bingham discharge for a given basal drive.
    let mut low = yield_accel;
    let mut high = q / (dt * h);
    let mobility = h * h * h / (3.0 * viscosity);
    for _ in 0..40 {
        let accel = 0.5 * (low + high);
        let plug = yield_accel / accel;
        let flow = mobility * accel * (1.0 - plug) * (1.0 - plug) * (1.0 + 0.5 * plug);
        if flow + dt * h * accel < q {
            low = accel;
        } else {
            high = accel;
        }
    }
    (q - dt * h * (0.5 * (low + high))).max(0.0)
}

#[repr(C)]
struct Source {
    flux: f64,
    heat: f64,
    start: f64,
    end: f64,
}

struct Grid {
    width: usize,
    rows: usize,
}

impl Grid {
    fn count(&self) -> usize {
        self.width * self.rows
    }

    unsafe fn update(
        &self,
        current: *const Lava,
        trial: *mut Lava,
        bed: *const f64,
        model: &Model,
        dt: f64,
    ) {
        trial.copy_from_nonoverlapping(current, self.count());
        for axis in 0..2 {
            let (lines, width, stride, line_stride) = if axis == 0 {
                (self.rows, self.width, 1, self.width)
            } else {
                (self.width, self.rows, self.width, 1)
            };
            for line in 0..lines {
                let i = line * line_stride;
                let mut a = Primitive::get(*current.add(i), *bed.add(i), model, axis);
                let (_, lower) = face(a.reflect(), a, model);
                let gain = dt / model.spacing;
                apply(&mut *trial.add(i), lower, gain, axis);
                for j in 0..width - 1 {
                    let i = i + j * stride;
                    let k = i + stride;
                    let b = Primitive::get(*current.add(k), *bed.add(k), model, axis);
                    let (x, y) = face(a, b, model);
                    apply(&mut *trial.add(i), x, -gain, axis);
                    apply(&mut *trial.add(k), y, gain, axis);
                    // Equal and opposite lateral conduction between filled columns.
                    if model.conductivity > 0.0
                        && (*current.add(i)).depth > 0.0
                        && (*current.add(k)).depth > 0.0
                    {
                        let p = *current.add(i);
                        let q = *current.add(k);
                        let ta = model.phase(p.depth, p.heat).0;
                        let tb = model.phase(q.depth, q.heat).0;
                        let exchange = model.conductivity / model.density
                            * p.depth.min(q.depth)
                            * (ta - tb)
                            * gain
                            / model.spacing;
                        (*trial.add(i)).heat -= exchange;
                        (*trial.add(k)).heat += exchange;
                    }
                    a = b;
                }
                let last = i + (width - 1) * stride;
                let (upper, _) = face(a, a.reflect(), model);
                apply(&mut *trial.add(last), upper, -gain, axis);
            }
        }
    }
}

fn cooling(cell: Lava, bed: f64, model: &Model, dt: f64) -> (f64, f64) {
    if cell.depth == 0.0 || model.conductivity == 0.0 {
        return (0.0, 0.0);
    }
    let (temperature, fraction) = model.phase(cell.depth, cell.heat);
    let crust = cell.depth * (1.0 - fraction);
    let wet = bed < model.water_level;
    let (_, air, water) = model.surface(temperature, crust, wet);
    let ground = model.conductivity / (model.skin + crust) * (temperature - model.ground);
    let conversion = dt / model.density;
    let target = model.enthalpy(model.air.min(model.ground).min(if wet {
        model.water_temperature
    } else {
        model.air
    }));
    let upper = model.enthalpy(model.air.max(model.ground).max(if wet {
        model.water_temperature
    } else {
        model.air
    }));
    let raw = (air + water + ground) * conversion;
    let budget = raw
        .max((cell.heat - cell.depth * upper).min(0.0))
        .min((cell.heat - cell.depth * target).max(0.0));
    let wet_part = if raw == 0.0 {
        0.0
    } else {
        (budget / raw) * water * conversion
    };
    (budget, wet_part)
}

#[unsafe(no_mangle)]
unsafe extern "C" fn lava_step(
    current: *mut Lava,
    trial: *mut Lava,
    bed: *const f64,
    source: *const Source,
    model: *const Model,
    width: usize,
    rows: usize,
    ice: *const f64,
    budget: *mut f64,
    dt: f64,
    start: f64,
) -> i32 {
    let model = &*model;
    let grid = Grid { width, rows };
    let area = model.spacing * model.spacing;
    let heat_scale = model.density * area;
    // The caller maps absorbed ICE-05 power once per published interval to the owning cell.
    for i in 0..grid.count() {
        let volume = &mut *current.add(i);
        let draw = *ice.add(i) * dt / heat_scale;
        if draw > volume.heat || !draw.is_finite() {
            return 2;
        }
        let old = model.phase(volume.depth, volume.heat).1;
        volume.heat -= draw;
        let next = model.phase(volume.depth, volume.heat).1;
        let ratio = if old > 0.0 {
            (next / old).min(1.0)
        } else {
            0.0
        };
        volume.qx *= ratio;
        volume.qz *= ratio;
        *budget.add(3) += draw * heat_scale;
    }
    let mut t = 0.0;
    while t < dt {
        let mut sub = dt - t;
        let mut speed: f64 = 0.0;
        for i in 0..grid.count() {
            let state = *current.add(i);
            let mobile = state.depth * model.phase(state.depth, state.heat).1;
            let vent = &*source.add(i);
            let extra = if start + t < vent.end && start + dt > vent.start {
                vent.flux * sub
            } else {
                0.0
            };
            let spread = if mobile > 0.0 {
                length(state.qx, state.qz) / mobile
            } else {
                0.0
            };
            speed = speed.max(spread + sqrt(model.gravity * (mobile + extra)));
        }
        if speed > 0.0 {
            sub = sub.min(0.4 * model.spacing / speed);
        }
        if model.conductivity > 0.0 {
            sub = sub.min(0.2 * area * model.density * model.cp / model.conductivity);
        }
        if !sub.is_finite() || t + sub <= t {
            return 1;
        }
        grid.update(current, trial, bed, model, sub);
        for i in 0..grid.count() {
            let state = &mut *trial.add(i);
            let vent = &*source.add(i);
            let vent_time =
                ((start + t + sub).min(vent.end) - (start + t).max(vent.start)).max(0.0);
            let inflow = vent_time * vent.flux;
            state.depth += inflow;
            state.heat += inflow * vent.heat;
            *budget.add(0) += inflow * area;
            *budget.add(1) += inflow * vent.heat * heat_scale;
            if state.depth < 0.0
                || state.heat < 0.0
                || !state.depth.is_finite()
                || !state.heat.is_finite()
            {
                return 1;
            }
            let old = model.phase(state.depth, state.heat).1;
            let (loss, water) = cooling(*state, *bed.add(i), model, sub);
            state.heat -= loss;
            *budget.add(2) += loss * heat_scale;
            *budget.add(4) += water * heat_scale;
            let (temperature, liquid) = model.phase(state.depth, state.heat);
            let q = length(state.qx, state.qz);
            let h = state.depth * liquid;
            let scale = if h > 0.0 && q > 0.0 && old > 0.0 {
                resistance(q, h, temperature, model, sub) / q * (liquid / old).min(1.0)
            } else {
                0.0
            };
            state.qx *= scale;
            state.qz *= scale;
            if !state.qx.is_finite() || !state.qz.is_finite() {
                return 1;
            }
        }
        current.copy_from_nonoverlapping(trial, grid.count());
        t = (t + sub).min(dt);
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn lava_publish(
    state: *const Lava,
    bed: *const f64,
    model: *const Model,
    out: *mut f64,
    deposits: *mut f64,
    sources: *mut f64,
    previous: *mut f64,
    width: usize,
    rows: usize,
    x0: f64,
    z0: f64,
    budget: *mut f64,
    initial: i32,
) {
    let model = &*model;
    let area = model.spacing * model.spacing;
    let mut stored_volume = 0.0;
    let mut stored_energy = 0.0;
    let mut displaced = 0.0;
    for j in 0..rows {
        for i in 0..width {
            let k = i + j * width;
            let q = *state.add(k);
            let (temperature, fraction) = model.phase(q.depth, q.heat);
            let crust = q.depth * (1.0 - fraction);
            let z = *bed.add(k);
            let wet = z < model.water_level;
            let surface = if q.depth > 0.0 {
                model.surface(temperature, crust, wet).0
            } else {
                model.air
            };
            let row = out.add(8 * k);
            *row = q.depth;
            *row.add(1) = temperature;
            *row.add(2) = surface;
            *row.add(3) = crust;
            *row.add(4) = q.qx;
            *row.add(5) = q.qz;
            *row.add(6) = z + q.depth;
            *row.add(7) = q.heat * model.density;
            *deposits.add(k) = z + crust;
            stored_volume += q.depth * area;
            stored_energy += q.heat * model.density * area;
            let submerged = q.depth.min((model.water_level - z).max(0.0));
            let delta = if initial == 0 {
                (submerged - *previous.add(k)) * area
            } else {
                0.0
            };
            *previous.add(k) = submerged;
            let source = sources.add(5 * k);
            *source = x0 + (i as f64 + 0.5) * model.spacing;
            *source.add(1) = z0 + (j as f64 + 0.5) * model.spacing;
            *source.add(2) = 1.5 * model.spacing;
            *source.add(3) = 0.0;
            *source.add(4) = delta;
            displaced += delta;
        }
    }
    *budget.add(5) += displaced;
    *budget.add(6) = stored_volume;
    *budget.add(7) = stored_energy;
}
