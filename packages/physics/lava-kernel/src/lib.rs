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

const MAX_MICROSTEPS: usize = 4096;
const BUDGET_WORDS: usize = 12;

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
    let sum = f64x2_extract_lane::<0>(square) + f64x2_extract_lane::<1>(square);
    if sum > 0.0 && sum.is_finite() {
        return sqrt(sum);
    }
    let scale = x.abs().max(z.abs());
    if scale == 0.0 {
        return 0.0;
    }
    let scaled_x = x / scale;
    let scaled_z = z / scale;
    scale * sqrt(scaled_x * scaled_x + scaled_z * scaled_z)
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

    fn plastic_viscosity(&self, temperature: f64) -> f64 {
        self.viscosity * exp(self.viscosity_rise * (self.liquidus - temperature).max(0.0))
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
        let film = if wet { self.water_coefficient } else { 0.0 };
        let sigma = self.emissivity * 5.670374419e-8;
        if sigma == 0.0 && self.convection == 0.0 && film == 0.0 {
            return (temperature, 0.0, 0.0);
        }
        let ar = self.air * self.air;
        let surface_flux = |skin: f64| {
            let square = skin * skin;
            let radiation = if sigma > 0.0 {
                sigma * (square * square - ar * ar)
            } else {
                0.0
            };
            let air = radiation + self.convection * (skin - self.air);
            let water = film * (skin - self.water_temperature);
            (air, water)
        };
        if self.conductivity == 0.0 {
            // With no resolved conduction layer the mixed column exposes its bulk temperature.
            let (air, water) = surface_flux(temperature);
            return (temperature, air, water);
        }
        let conduction = self.conductivity / (self.skin + crust);
        let lower = temperature.min(self.air).min(self.water_temperature);
        let upper = temperature.max(self.air).max(self.water_temperature);
        let (mut low, mut high) = (lower, upper);
        for _ in 0..40 {
            let skin = 0.5 * (low + high);
            let (air, water) = surface_flux(skin);
            let transfer = air + water;
            if !transfer.is_finite() {
                return (f64::NAN, f64::NAN, f64::NAN);
            }
            if conduction * (temperature - skin) > transfer {
                low = skin;
            } else {
                high = skin;
            }
        }
        let skin = 0.5 * (low + high);
        let (air, water) = surface_flux(skin);
        (skin, air, water)
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
    let viscosity = model.plastic_viscosity(temperature) / model.density;
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

/// Wide Bingham sheet with a no-slip base and zero traction at the interface.
/// The same integrated velocity law is used by the inertial drag, but here it
/// is the mass flux at a face so it retains the large-viscosity limit.
fn terminal_face(a: Lava, ba: f64, b: Lava, bb: f64, model: &Model) -> (f64, f64) {
    let slope = ((ba - bb) + (a.depth - b.depth)) / model.spacing;
    let acceleration = model.gravity * slope.abs();
    if model.gravity == 0.0 {
        return (0.0, 0.0);
    }
    let (donor, donor_bed, receiver, receiver_bed, direction) = if slope > 0.0 {
        (a, ba, b, bb, 1.0)
    } else {
        (b, bb, a, ba, -1.0)
    };
    let (temperature, liquid) = model.phase(donor.depth, donor.heat);
    let mobile = donor.depth * liquid;
    let receiver_liquid = model.phase(receiver.depth, receiver.heat).1;
    let receiver_floor = receiver_bed + receiver.depth * (1.0 - receiver_liquid);
    let h = mobile.min(((donor_bed - receiver_floor) + donor.depth).max(0.0));
    if h == 0.0 {
        return (0.0, 0.0);
    }
    let mut viscosity = model.plastic_viscosity(temperature);
    if slope == 0.0 {
        // At equal head the mobility for a perturbation can come from either side.
        let receiver_temperature = model.phase(receiver.depth, receiver.heat).0;
        viscosity = viscosity.min(model.plastic_viscosity(receiver_temperature));
    }
    let mobility_per_height = (model.density / (3.0 * viscosity)) * h * h;
    let mobility = mobility_per_height * h;
    // Differentiate the Newtonian h³ mobility before evaluating shallow films.
    // Dividing acceleration by a subnormal film would overflow before multiplying.
    let stiffness = mobility_per_height * (3.0 * acceleration)
        + mobility * (2.0 * model.gravity / model.spacing);
    let shear = model.density * h * acceleration;
    let yield_stress = model.yield_strength(temperature);
    if shear <= yield_stress {
        return (0.0, stiffness);
    }
    let plug = yield_stress / shear;
    let yielded = 1.0 - plug;
    let rate = mobility * acceleration * yielded * yielded * (1.0 + 0.5 * plug);
    (direction * rate, stiffness)
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

    unsafe fn terminal_cell_bound(
        &self,
        current: *const Lava,
        bed: *const f64,
        model: &Model,
        x: usize,
        z: usize,
        remaining: f64,
        forward_rates: *mut f64,
    ) -> f64 {
        let i = x + z * self.width;
        let value = *current.add(i);
        let mut outflow = 0.0;
        let mut derivative = 0.0;
        for (face, neighbor) in [
            (x > 0).then(|| i - 1),
            (x + 1 < self.width).then(|| i + 1),
            (z > 0).then(|| i - self.width),
            (z + 1 < self.rows).then(|| i + self.width),
        ]
        .into_iter()
        .enumerate()
        {
            let Some(neighbor) = neighbor else { continue };
            let (rate, sensitivity) = terminal_face(
                value,
                *bed.add(i),
                *current.add(neighbor),
                *bed.add(neighbor),
                model,
            );
            if !(rate.is_finite() && sensitivity.is_finite()) {
                return f64::NAN;
            }
            if !forward_rates.is_null() && face % 2 == 1 {
                forward_rates.add(2 * i + face / 2).write(rate);
            }
            outflow += rate.max(0.0);
            derivative += sensitivity;
        }
        let mut step = remaining;
        if outflow > 0.0 {
            step = step.min(0.4 * model.spacing * (value.depth / outflow));
        }
        if derivative > 0.0 {
            step = step.min(0.4 * model.spacing / derivative);
        }
        step
    }

    unsafe fn terminal_step_bound(
        &self,
        current: *const Lava,
        bed: *const f64,
        model: &Model,
        remaining: f64,
    ) -> f64 {
        let mut step = remaining;
        for z in 0..self.rows {
            for x in 0..self.width {
                let local = self.terminal_cell_bound(
                    current,
                    bed,
                    model,
                    x,
                    z,
                    step,
                    core::ptr::null_mut(),
                );
                if !local.is_finite() {
                    return f64::NAN;
                }
                step = local;
            }
        }
        step
    }

    fn conductive_exchange(p: Lava, q: Lava, model: &Model, gain: f64) -> Option<f64> {
        if model.conductivity > 0.0 && p.depth > 0.0 && q.depth > 0.0 {
            let ta = model.phase(p.depth, p.heat).0;
            let tb = model.phase(q.depth, q.heat).0;
            Some(
                model.conductivity / model.density * p.depth.min(q.depth) * (ta - tb) * gain
                    / model.spacing,
            )
        } else {
            None
        }
    }

    unsafe fn conduct_between(
        current: *const Lava,
        trial: *mut Lava,
        i: usize,
        k: usize,
        model: &Model,
        gain: f64,
    ) {
        if let Some(exchange) =
            Self::conductive_exchange(*current.add(i), *current.add(k), model, gain)
        {
            (*trial.add(i)).heat -= exchange;
            (*trial.add(k)).heat += exchange;
        }
    }

    unsafe fn terminal_gather(
        &self,
        current: *const Lava,
        rates: *const f64,
        model: &Model,
        dt: f64,
        x: usize,
        z: usize,
    ) -> Lava {
        let i = x + z * self.width;
        let mut value = *current.add(i);
        value.qx = 0.0;
        value.qz = 0.0;
        let gain = dt / model.spacing;
        // Preserve the serial z-major, X-first scatter order for this cell:
        // previous Z row, previous X cell, then its own X and Z faces.
        for (axis, neighbor, lower) in [
            (1, (z > 0).then(|| i - self.width), false),
            (0, (x > 0).then(|| i - 1), false),
            (0, (x + 1 < self.width).then(|| i + 1), true),
            (1, (z + 1 < self.rows).then(|| i + self.width), true),
        ] {
            let Some(neighbor) = neighbor else { continue };
            let (left, right) = if lower { (i, neighbor) } else { (neighbor, i) };
            let a = *current.add(left);
            let b = *current.add(right);
            let rate = *rates.add(2 * left + axis);
            if rate != 0.0 {
                let donor = if rate > 0.0 { a } else { b };
                let depth = rate * gain;
                let heat = depth * (donor.heat / donor.depth);
                if lower {
                    value.depth -= depth;
                    value.heat -= heat;
                } else {
                    value.depth += depth;
                    value.heat += heat;
                }
                if axis == 0 {
                    value.qx += 0.5 * rate;
                } else {
                    value.qz += 0.5 * rate;
                }
            }
            if let Some(exchange) = Self::conductive_exchange(a, b, model, gain) {
                if lower {
                    value.heat -= exchange;
                } else {
                    value.heat += exchange;
                }
            }
        }
        value
    }

    unsafe fn update_terminal(
        &self,
        current: *const Lava,
        trial: *mut Lava,
        bed: *const f64,
        model: &Model,
        dt: f64,
    ) {
        trial.copy_from_nonoverlapping(current, self.count());
        for i in 0..self.count() {
            (*trial.add(i)).qx = 0.0;
            (*trial.add(i)).qz = 0.0;
        }
        let gain = dt / model.spacing;
        for z in 0..self.rows {
            for x in 0..self.width {
                let i = x + z * self.width;
                for (axis, neighbor) in [
                    (0, (x + 1 < self.width).then(|| i + 1)),
                    (1, (z + 1 < self.rows).then(|| i + self.width)),
                ] {
                    let Some(k) = neighbor else { continue };
                    let a = *current.add(i);
                    let b = *current.add(k);
                    let (rate, _) = terminal_face(a, *bed.add(i), b, *bed.add(k), model);
                    if rate != 0.0 {
                        let donor = if rate > 0.0 { a } else { b };
                        let depth = rate * gain;
                        let heat = depth * (donor.heat / donor.depth);
                        let left = &mut *trial.add(i);
                        let right = &mut *trial.add(k);
                        left.depth -= depth;
                        right.depth += depth;
                        left.heat -= heat;
                        right.heat += heat;
                        if axis == 0 {
                            left.qx += 0.5 * rate;
                            right.qx += 0.5 * rate;
                        } else {
                            left.qz += 0.5 * rate;
                            right.qz += 0.5 * rate;
                        }
                    }
                    Self::conduct_between(current, trial, i, k, model, gain);
                }
            }
        }
    }

    fn sweep(&self, axis: usize) -> (usize, usize, usize, usize) {
        if axis == 0 {
            (self.rows, self.width, 1, self.width)
        } else {
            (self.width, self.rows, self.width, 1)
        }
    }

    unsafe fn inertial_line(
        &self,
        current: *const Lava,
        trial: *mut Lava,
        bed: *const f64,
        model: &Model,
        dt: f64,
        axis: usize,
        line: usize,
    ) {
        let (_, width, stride, line_stride) = self.sweep(axis);
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
            Self::conduct_between(current, trial, i, k, model, gain);
            a = b;
        }
        let last = i + (width - 1) * stride;
        let (upper, _) = face(a, a.reflect(), model);
        apply(&mut *trial.add(last), upper, -gain, axis);
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
            for line in 0..self.sweep(axis).0 {
                self.inertial_line(current, trial, bed, model, dt, axis, line);
            }
        }
    }
}

fn cooling(cell: Lava, bed: f64, model: &Model, dt: f64) -> (f64, f64) {
    if cell.depth == 0.0 {
        return (0.0, 0.0);
    }
    let (temperature, fraction) = model.phase(cell.depth, cell.heat);
    let crust = cell.depth * (1.0 - fraction);
    let wet = bed < model.water_level;
    let (_, air, water) = model.surface(temperature, crust, wet);
    let ground = model.conductivity / (model.skin + crust) * (temperature - model.ground);
    let conversion = dt / model.density;
    let mut low = temperature;
    let mut high = temperature;
    for reservoir in [
        (model.emissivity > 0.0 || model.convection > 0.0).then_some(model.air),
        (model.conductivity > 0.0).then_some(model.ground),
        (wet && model.water_coefficient > 0.0).then_some(model.water_temperature),
    ]
    .into_iter()
    .flatten()
    {
        low = low.min(reservoir);
        high = high.max(reservoir);
    }
    let target = model.enthalpy(low);
    let upper = model.enthalpy(high);
    let raw = (air + water + ground) * conversion;
    if !raw.is_finite() || !target.is_finite() || !upper.is_finite() {
        return (f64::NAN, f64::NAN);
    }
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

struct Tick<'a> {
    model: &'a Model,
    dt: f64,
    start: f64,
    area: f64,
    heat_scale: f64,
    terminal: bool,
}

impl<'a> Tick<'a> {
    fn new(model: &'a Model, dt: f64, start: f64, terminal: bool) -> Option<Self> {
        let area = model.spacing * model.spacing;
        let heat_scale = model.density * area;
        if !(dt > 0.0
            && dt.is_finite()
            && start.is_finite()
            && heat_scale > 0.0
            && heat_scale.is_finite())
        {
            return None;
        }
        Some(Self {
            model,
            dt,
            start,
            area,
            heat_scale,
            terminal,
        })
    }

    unsafe fn receive_ice(
        &self,
        count: usize,
        current: *mut Lava,
        ice: *const f64,
        budget: *mut f64,
    ) -> i32 {
        // The caller maps absorbed ICE-05 power once per published interval to the owning cell.
        for i in 0..count {
            let volume = &mut *current.add(i);
            let draw = *ice.add(i) * self.dt / self.heat_scale;
            if draw > volume.heat || !draw.is_finite() {
                return 2;
            }
            let old = self.model.phase(volume.depth, volume.heat).1;
            volume.heat -= draw;
            let next = self.model.phase(volume.depth, volume.heat).1;
            let ratio = if old > 0.0 {
                (next / old).min(1.0)
            } else {
                0.0
            };
            volume.qx *= ratio;
            volume.qz *= ratio;
            *budget.add(3) += draw * self.heat_scale;
        }
        0
    }

    fn inertial_speed(&self, state: Lava, vent: &Source, t: f64, remaining: f64) -> f64 {
        let mobile = state.depth * self.model.phase(state.depth, state.heat).1;
        let extra = if self.start + t < vent.end && self.start + self.dt > vent.start {
            vent.flux * remaining
        } else {
            0.0
        };
        let spread = if mobile > 0.0 {
            length(state.qx, state.qz) / mobile
        } else {
            0.0
        };
        spread + sqrt(self.model.gravity * (mobile + extra))
    }

    fn microstep(&self, bound: f64, t: f64) -> Option<f64> {
        if !bound.is_finite() {
            return None;
        }
        let mut sub = if self.terminal {
            bound
        } else if bound > 0.0 {
            (self.dt - t).min(0.4 * self.model.spacing / bound)
        } else {
            self.dt - t
        };
        if self.model.conductivity > 0.0 {
            sub = sub.min(
                0.2 * self.area * self.model.density * self.model.cp / self.model.conductivity,
            );
        }
        if !sub.is_finite() || t + sub <= t {
            return None;
        }
        Some(sub)
    }

    fn finish_cell(
        &self,
        state: &mut Lava,
        vent: &Source,
        bed: f64,
        t: f64,
        sub: f64,
    ) -> Option<[f64; 4]> {
        let vent_time =
            ((self.start + t + sub).min(vent.end) - (self.start + t).max(vent.start)).max(0.0);
        let inflow = vent_time * vent.flux;
        state.depth += inflow;
        state.heat += inflow * vent.heat;
        let added_volume = inflow * self.area;
        let added_heat = inflow * vent.heat * self.heat_scale;
        if state.depth < 0.0
            || state.heat < 0.0
            || !state.depth.is_finite()
            || !state.heat.is_finite()
        {
            return None;
        }
        let old = self.model.phase(state.depth, state.heat).1;
        let (loss, water) = cooling(*state, bed, self.model, sub);
        if !(loss.is_finite() && water.is_finite()) {
            return None;
        }
        state.heat -= loss;
        let (temperature, liquid) = self.model.phase(state.depth, state.heat);
        if !(state.heat.is_finite()
            && state.heat >= 0.0
            && temperature.is_finite()
            && liquid.is_finite())
        {
            return None;
        }
        let q = length(state.qx, state.qz);
        let h = state.depth * liquid;
        let scale = if h > 0.0 && q > 0.0 && old > 0.0 {
            let solidification = (liquid / old).min(1.0);
            if self.terminal {
                solidification
            } else {
                resistance(q, h, temperature, self.model, sub) / q * solidification
            }
        } else {
            0.0
        };
        state.qx *= scale;
        state.qz *= scale;
        if !state.qx.is_finite() || !state.qz.is_finite() {
            return None;
        }
        Some([
            added_volume,
            added_heat,
            loss * self.heat_scale,
            water * self.heat_scale,
        ])
    }
}

unsafe fn add_ledger(budget: *mut f64, ledger: [f64; 4]) {
    *budget.add(0) += ledger[0];
    *budget.add(1) += ledger[1];
    *budget.add(2) += ledger[2];
    *budget.add(4) += ledger[3];
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
    terminal: u32,
    receipt: *mut u32,
) -> i32 {
    let Some(tick) = Tick::new(&*model, dt, start, terminal != 0) else {
        return 1;
    };
    let grid = Grid { width, rows };
    let status = tick.receive_ice(grid.count(), current, ice, budget);
    if status != 0 {
        return status;
    }
    let mut t = 0.0;
    let mut steps = 0;
    while t < dt {
        if steps == MAX_MICROSTEPS {
            return 3;
        }
        steps += 1;
        let remaining = dt - t;
        let bound = if tick.terminal {
            grid.terminal_step_bound(current, bed, tick.model, remaining)
        } else {
            let mut speed: f64 = 0.0;
            for i in 0..grid.count() {
                let local = tick.inertial_speed(*current.add(i), &*source.add(i), t, remaining);
                if !local.is_finite() {
                    return 1;
                }
                speed = speed.max(local);
            }
            speed
        };
        let Some(sub) = tick.microstep(bound, t) else {
            return 1;
        };
        if tick.terminal {
            grid.update_terminal(current, trial, bed, tick.model, sub);
        } else {
            grid.update(current, trial, bed, tick.model, sub);
        }
        for i in 0..grid.count() {
            let Some(ledger) =
                tick.finish_cell(&mut *trial.add(i), &*source.add(i), *bed.add(i), t, sub)
            else {
                return 1;
            };
            add_ledger(budget, ledger);
        }
        current.copy_from_nonoverlapping(trial, grid.count());
        t = (t + sub).min(dt);
    }
    if !receipt.is_null() {
        receipt.write(steps as u32);
    }
    0
}

// The host publishes this arena descriptor before launching a worker phase.
// Only the owning agent changes the clock and region offsets between barriers.
#[repr(C)]
struct ThreadJob {
    current: u32,
    trial: u32,
    bed: u32,
    source: u32,
    model: u32,
    nx: u32,
    nz: u32,
    ice: u32,
    budget: u32,
    terminal_rates: u32,
    local_ledger: u32,
    bounds: u32,
    terminal: u32,
    steps: u32,
    dt: f64,
    start: f64,
    t: f64,
    sub: f64,
}

const _: () = assert!(core::mem::size_of::<ThreadJob>() == 88);

impl ThreadJob {
    unsafe fn tick(&self) -> Option<Tick<'_>> {
        Tick::new(
            &*(self.model as *const Model),
            self.dt,
            self.start,
            self.terminal != 0,
        )
    }

    fn grid(&self) -> Option<Grid> {
        let width = self.nx as usize;
        let rows = self.nz as usize;
        if width.checked_mul(rows)? == 0 {
            return None;
        }
        Some(Grid { width, rows })
    }

    fn active(&self) -> bool {
        self.t >= 0.0 && self.t < self.dt
    }
}

fn partition(len: usize, part: u32, parts: u32) -> core::ops::Range<usize> {
    let len = len as u64;
    let part = u64::from(part);
    let parts = u64::from(parts);
    (part * len / parts) as usize..((part + 1) * len / parts) as usize
}

#[unsafe(no_mangle)]
unsafe extern "C" fn lava_thread_begin(job: *mut ThreadJob) -> i32 {
    let Some(job) = job.as_mut() else {
        return 1;
    };
    let Some(grid) = job.grid() else {
        return 1;
    };
    job.steps = 0;
    job.t = 0.0;
    job.sub = 0.0;
    let Some(tick) = job.tick() else {
        return 1;
    };
    tick.receive_ice(
        grid.count(),
        job.current as *mut Lava,
        job.ice as *const f64,
        job.budget as *mut f64,
    )
}

#[unsafe(no_mangle)]
unsafe extern "C" fn lava_thread_phase(
    job: *const ThreadJob,
    stage: u32,
    part: u32,
    parts: u32,
) -> i32 {
    let Some(job) = job.as_ref() else {
        return 1;
    };
    if part >= parts || stage > 3 || !job.active() {
        return 1;
    }
    if job.steps as usize >= MAX_MICROSTEPS {
        return 3;
    }
    let Some(grid) = job.grid() else {
        return 1;
    };
    let Some(tick) = job.tick() else {
        return 1;
    };
    let current = job.current as *const Lava;
    let trial = job.trial as *mut Lava;
    let bed = job.bed as *const f64;
    let source = job.source as *const Source;
    if stage == 0 {
        let remaining = job.dt - job.t;
        let mut bound: f64 = if tick.terminal { remaining } else { 0.0 };
        for i in partition(grid.count(), part, parts) {
            let local = if tick.terminal {
                let Some(z) = i.checked_div(grid.width) else {
                    return 1;
                };
                let x = i - z * grid.width;
                grid.terminal_cell_bound(
                    current,
                    bed,
                    tick.model,
                    x,
                    z,
                    bound,
                    job.terminal_rates as *mut f64,
                )
            } else {
                tick.inertial_speed(*current.add(i), &*source.add(i), job.t, remaining)
            };
            if !local.is_finite() {
                return 1;
            }
            bound = if tick.terminal {
                local
            } else {
                bound.max(local)
            };
        }
        (job.bounds as *mut f64).add(part as usize).write(bound);
        return 0;
    }
    if !(job.sub > 0.0 && job.sub <= job.dt - job.t) {
        return 1;
    }
    if stage < 3 {
        if tick.terminal {
            return 1;
        }
        let axis = (stage - 1) as usize;
        for line in partition(grid.sweep(axis).0, part, parts) {
            if axis == 0 {
                let first = line * grid.width;
                trial
                    .add(first)
                    .copy_from_nonoverlapping(current.add(first), grid.width);
            }
            grid.inertial_line(current, trial, bed, tick.model, job.sub, axis, line);
        }
        return 0;
    }
    let ledger = job.local_ledger as *mut [f64; 4];
    for i in partition(grid.count(), part, parts) {
        let value = &mut *trial.add(i);
        if tick.terminal {
            let Some(z) = i.checked_div(grid.width) else {
                return 1;
            };
            let x = i - z * grid.width;
            *value = grid.terminal_gather(
                current,
                job.terminal_rates as *const f64,
                tick.model,
                job.sub,
                x,
                z,
            );
        }
        let Some(receipt) = tick.finish_cell(value, &*source.add(i), *bed.add(i), job.t, job.sub)
        else {
            return 1;
        };
        ledger.add(i).write(receipt);
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn lava_thread_plan(job: *mut ThreadJob, parts: u32) -> i32 {
    let Some(job) = job.as_mut() else {
        return 1;
    };
    if parts == 0 || !job.active() || job.sub != 0.0 {
        return 1;
    }
    if job.steps as usize >= MAX_MICROSTEPS {
        return 3;
    }
    let Some(tick) = job.tick() else {
        return 1;
    };
    let bounds = job.bounds as *const f64;
    let mut bound: f64 = if tick.terminal { job.dt - job.t } else { 0.0 };
    for part in 0..parts as usize {
        let local = *bounds.add(part);
        if !local.is_finite() {
            return 1;
        }
        bound = if tick.terminal {
            bound.min(local)
        } else {
            bound.max(local)
        };
    }
    if let Some(sub) = tick.microstep(bound, job.t) {
        job.sub = sub;
        0
    } else {
        1
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn lava_thread_accept(job: *mut ThreadJob) -> i32 {
    let Some(job) = job.as_mut() else {
        return 1;
    };
    if !job.active() || !(job.sub > 0.0 && job.sub <= job.dt - job.t) {
        return 1;
    }
    let Some(grid) = job.grid() else {
        return 1;
    };
    let ledger = job.local_ledger as *const [f64; 4];
    let budget = job.budget as *mut f64;
    for i in 0..grid.count() {
        add_ledger(budget, *ledger.add(i));
    }
    (job.current as *mut Lava).copy_from_nonoverlapping(job.trial as *const Lava, grid.count());
    job.t = (job.t + job.sub).min(job.dt);
    job.steps += 1;
    job.sub = 0.0;
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
) -> i32 {
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
            let energy = q.heat * model.density;
            let sample = [
                q.depth,
                temperature,
                surface,
                crust,
                q.qx,
                q.qz,
                z + q.depth,
                energy,
            ];
            let deposit = z + crust;
            let submerged = q.depth.min((model.water_level - z).max(0.0));
            let delta = if initial == 0 {
                (submerged - *previous.add(k)) * area
            } else {
                0.0
            };
            let source = [
                x0 + (i as f64 + 0.5) * model.spacing,
                z0 + (j as f64 + 0.5) * model.spacing,
                1.5 * model.spacing,
                0.0,
                delta,
            ];
            if q.depth < 0.0
                || !deposit.is_finite()
                || !submerged.is_finite()
                || !sample
                    .iter()
                    .chain(source.iter())
                    .all(|word| word.is_finite())
            {
                return 1;
            }
            out.add(8 * k)
                .copy_from_nonoverlapping(sample.as_ptr(), sample.len());
            *deposits.add(k) = deposit;
            *previous.add(k) = submerged;
            sources
                .add(5 * k)
                .copy_from_nonoverlapping(source.as_ptr(), source.len());
            stored_volume += q.depth * area;
            stored_energy += energy * area;
            displaced += delta;
        }
    }
    *budget.add(5) += displaced;
    *budget.add(6) = stored_volume;
    *budget.add(7) = stored_energy;
    if (0..BUDGET_WORDS).any(|word| !(*budget.add(word)).is_finite()) {
        return 1;
    }
    0
}
