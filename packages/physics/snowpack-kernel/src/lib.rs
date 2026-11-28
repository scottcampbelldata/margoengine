#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_lt, f64x2_mul, f64x2_splat,
    f64x2_sqrt, f64x2_sub, v128, v128_bitselect,
};
use core::slice;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

const ICE: f64 = 917.0;
const WATER: f64 = 1000.0;
const CI: f64 = 2100.0;
const CW: f64 = 4186.0;
const LF: f64 = 333700.0;

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

#[inline(always)]
fn at<T>(data: &[T], i: usize) -> &T {
    if i >= data.len() {
        core::arch::wasm32::unreachable();
    }
    unsafe { data.get_unchecked(i) }
}

#[inline(always)]
fn at_mut<T>(data: &mut [T], i: usize) -> &mut T {
    if i >= data.len() {
        core::arch::wasm32::unreachable();
    }
    unsafe { data.get_unchecked_mut(i) }
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Pack {
    mass: f64,
    heat: f64,
    depth: f64,
}

impl Pack {
    fn zero() -> Self {
        Self {
            mass: 0.0,
            heat: 0.0,
            depth: 0.0,
        }
    }

    fn add(&mut self, other: Self) {
        self.mass += other.mass;
        self.heat += other.heat;
        self.depth += other.depth;
    }

    fn take(&mut self, other: Self) {
        self.mass -= other.mass;
        self.heat -= other.heat;
        self.depth = (self.depth - other.depth).max(0.0);
    }

    fn scale(self, factor: f64) -> Self {
        Self {
            mass: self.mass * factor,
            heat: self.heat * factor,
            depth: self.depth * factor,
        }
    }

    fn liquid(self) -> f64 {
        (self.heat / LF).max(0.0).min(self.mass)
    }

    fn temp(self) -> f64 {
        if self.mass == 0.0 {
            0.0
        } else if self.heat < 0.0 {
            self.heat / (CI * self.mass)
        } else {
            (self.heat - LF * self.mass).max(0.0) / (CW * self.mass)
        }
    }

    fn with_heat(self, heat: f64) -> Self {
        Self { heat, ..self }
    }

    fn conductivity(self) -> f64 {
        let liquid = self.liquid();
        let density = (self.mass - liquid) / (self.depth * WATER);
        let base = if density < 0.156 {
            0.023 + 0.234 * density
        } else if density <= 0.6 {
            0.138 - 1.01 * density + 3.233 * density * density
        } else {
            // Continue from the verified empirical range to solid ice.
            0.69588 + (2.2 - 0.69588) * (density - 0.6) / 0.317
        };
        let saturation = (liquid / WATER / self.depth).min(1.0);
        base * (1.0 - saturation) + 0.56 * saturation
    }
}

const BISECTION_STEPS: u32 = 54;

struct Conduction {
    hot: Pack,
    cold: Pack,
    hot_layer: usize,
    cold_layer: usize,
    factor: f64,
    upper: f64,
}

impl Conduction {
    fn between(pack: &[Pack], a: usize, b: usize, dt: f64) -> Option<Self> {
        let top = *at(pack, a);
        let bottom = *at(pack, b);
        if top.mass == 0.0 || bottom.mass == 0.0 || top.depth == 0.0 || bottom.depth == 0.0 {
            return None;
        }
        let delta = top.temp() - bottom.temp();
        if delta == 0.0 {
            return None;
        }
        let (hot, cold, hot_layer, cold_layer) = if delta > 0.0 {
            (top, bottom, a, b)
        } else {
            (bottom, top, b, a)
        };
        let conductance = 2.0 / (hot.depth / hot.conductivity() + cold.depth / cold.conductivity());
        let factor = conductance * dt;
        // Bracket the backward-Euler root by the explicit flux and the freezing-plateau energy.
        let upper = (factor * delta.abs())
            .min(hot.heat.abs() + cold.heat.abs() + LF * (hot.mass + cold.mass));
        Some(Self {
            hot,
            cold,
            hot_layer,
            cold_layer,
            factor,
            upper,
        })
    }

    fn scalar(&self) -> f64 {
        let mut lo = 0.0;
        let mut hi = self.upper;
        for _ in 0..BISECTION_STEPS {
            let middle = lo + (hi - lo) * 0.5;
            let target = self.hot.with_heat(self.hot.heat - middle).temp()
                - self.cold.with_heat(self.cold.heat + middle).temp();
            if middle < self.factor * target {
                lo = middle;
            } else {
                hi = middle;
            }
        }
        (lo + hi) * 0.5
    }

    fn accept(&self, pack: &mut [Pack], moved: f64) {
        at_mut(pack, self.hot_layer).heat -= moved;
        at_mut(pack, self.cold_layer).heat += moved;
    }
}

struct ThermalLanes {
    heat: v128,
    latent: v128,
    ice_capacity: v128,
    water_capacity: v128,
}

impl ThermalLanes {
    fn new(a: Pack, b: Pack) -> Self {
        let mass = f64x2(a.mass, b.mass);
        Self {
            heat: f64x2(a.heat, b.heat),
            latent: f64x2_mul(f64x2_splat(LF), mass),
            ice_capacity: f64x2_mul(f64x2_splat(CI), mass),
            water_capacity: f64x2_mul(f64x2_splat(CW), mass),
        }
    }

    fn temperature(&self, heat: v128) -> v128 {
        let zero = f64x2_splat(0.0);
        let excess = f64x2_sub(heat, self.latent);
        let liquid_heat = v128_bitselect(excess, zero, f64x2_gt(excess, zero));
        v128_bitselect(
            f64x2_div(heat, self.ice_capacity),
            f64x2_div(liquid_heat, self.water_capacity),
            f64x2_lt(heat, zero),
        )
    }
}

fn conduct_two(a: &Conduction, b: &Conduction) -> (f64, f64) {
    // Each lane owns a different column, preserving the dependency between interfaces in a
    // single column, as required by its layerwise heat budget (Bartelt & Lehning 2002, Part I).
    let hot = ThermalLanes::new(a.hot, b.hot);
    let cold = ThermalLanes::new(a.cold, b.cold);
    let factor = f64x2(a.factor, b.factor);
    let half = f64x2_splat(0.5);
    let mut lo = f64x2_splat(0.0);
    let mut hi = f64x2(a.upper, b.upper);
    for _ in 0..BISECTION_STEPS {
        let middle = f64x2_add(lo, f64x2_mul(f64x2_sub(hi, lo), half));
        let target = f64x2_sub(
            hot.temperature(f64x2_sub(hot.heat, middle)),
            cold.temperature(f64x2_add(cold.heat, middle)),
        );
        let take_lower = f64x2_lt(middle, f64x2_mul(factor, target));
        lo = v128_bitselect(middle, lo, take_lower);
        hi = v128_bitselect(hi, middle, take_lower);
    }
    let moved = f64x2_mul(f64x2_add(lo, hi), half);
    (
        f64x2_extract_lane::<0>(moved),
        f64x2_extract_lane::<1>(moved),
    )
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Cornice {
    mass: f64,
    east: f64,
    south: f64,
}

#[repr(C)]
struct Forcing {
    ground: f64,
    snowfall: f64,
    rain: f64,
    air_celsius: f64,
    top_heat: f64,
    bottom_heat: f64,
    fresh_density: f64,
    friction_x: f64,
    friction_z: f64,
    air_density: f64,
    support: f64,
}

#[repr(C)]
struct Output {
    mass: f64,
    liquid: f64,
    temperature: f64,
    depth: f64,
    stability: f64,
    slab_depth: f64,
    cornice_east: f64,
    cornice_south: f64,
    cornice_mass: f64,
    unused_energy: f64,
    runoff_energy: f64,
    slab_mass: f64,
}

#[repr(C)]
struct Settings {
    gravity: f64,
    spacing: f64,
    liquid_retention: f64,
    friction: f64,
    wind_threshold: f64,
    cornice_efficiency: f64,
    cliff_slope: f64,
    cornice_thickness: f64,
    cornice_density: f64,
    cornice_upper_ratio: f64,
}

#[repr(C)]
struct Job {
    packs: *mut Pack,
    caps: *mut Cornice,
    drift: *mut Pack,
    forcing: *const Forcing,
    viscosity: *const f64,
    cohesion: *const f64,
    old_ice: *mut f64,
    config: *const Settings,
    runoff: *mut f64,
    discharge: *mut f64,
    summary: *mut Output,
    cover: *mut f32,
    width: usize,
    depth: usize,
    layers: usize,
    work: *mut Work,
    dt: f64,
    world_dt: f64,
}

#[repr(C)]
#[derive(Default)]
struct Work {
    columns: f64,
    layers: f64,
    conduction_interfaces: f64,
    paired_interfaces: f64,
    bisection_iterations: f64,
}

impl Job {
    fn nonzero_width(&self) -> core::num::NonZeroUsize {
        if let Some(width) = core::num::NonZeroUsize::new(self.width) {
            width
        } else {
            core::arch::wasm32::unreachable()
        }
    }

    fn count(&self) -> Option<usize> {
        let count = self.width.checked_mul(self.depth)?;
        let words = count.checked_mul(self.layers)?;
        if words == 0
            || words > isize::MAX as usize / size_of::<Pack>()
            || count > isize::MAX as usize / size_of::<Forcing>()
        {
            None
        } else {
            Some(count)
        }
    }

    // Runs on the caller before the barrier. Each ordered drift source may write its neighbours.
    unsafe fn prepare(&self, count: usize) {
        let width = self.nonzero_width().get();
        let depth = self.depth;
        let layers = self.layers;
        let dt = self.dt;
        let pack = unsafe { slice::from_raw_parts_mut(self.packs, count * layers) };
        let caps = unsafe { slice::from_raw_parts_mut(self.caps, count) };
        let drift = unsafe { slice::from_raw_parts_mut(self.drift, count) };
        let forcing = unsafe { slice::from_raw_parts(self.forcing, count) };
        let cfg = unsafe { &*self.config };
        drift.fill(Pack::zero());

        for i in 0..count {
            let air = at(forcing, i);
            let start = i * layers;
            let top = at_mut(pack, start);
            let snow = dt * air.snowfall;
            top.add(Pack {
                mass: snow,
                heat: snow * CI * air.air_celsius.min(0.0),
                depth: snow / air.fresh_density,
            });
            let speed = sqrt(air.friction_x * air.friction_x + air.friction_z * air.friction_z);
            let mut surface = start;
            while surface + 1 < start + layers && at(pack, surface).mass == 0.0 {
                surface += 1;
            }
            let top = at_mut(pack, surface);
            let scours = speed >= cfg.wind_threshold * cfg.cornice_upper_ratio;
            let held = if scours { 0.0 } else { at(caps, i).mass };
            let available = (top.mass - top.liquid() - held).max(0.0);
            if speed <= cfg.wind_threshold || available == 0.0 {
                continue;
            }
            // Pomeroy–Gray equilibrium saltation flux, accumulated in canonical source order.
            // See Lehning et al. (2008), §2, for the distinct redistribution mechanisms.
            let critical = cfg.wind_threshold;
            let flux = 0.68 * air.air_density * critical * (speed * speed - critical * critical)
                / (cfg.gravity * speed);
            let sx = air.friction_x / speed;
            let sz = air.friction_z / speed;
            let x = i % width;
            let z = i / width;
            let face_x = if sx > 0.0 && x + 1 < width {
                Some(i + 1)
            } else if sx < 0.0 && x > 0 {
                Some(i - 1)
            } else {
                None
            };
            let face_z = if sz > 0.0 && z + 1 < depth {
                Some(i + width)
            } else if sz < 0.0 && z > 0 {
                Some(i - width)
            } else {
                None
            };
            let share_x = if face_x.is_some() { sx.abs() } else { 0.0 };
            let share_z = if face_z.is_some() { sz.abs() } else { 0.0 };
            let shares = share_x + share_z;
            if shares == 0.0 {
                continue;
            }
            let moved = (dt * flux * shares / cfg.spacing).min(available);
            let solid = Pack {
                mass: moved,
                heat: top.heat.min(0.0) * moved / top.mass,
                depth: top.depth * moved / (top.mass - top.liquid()),
            };
            top.take(solid);
            if scours {
                let cap = at_mut(caps, i);
                if cap.mass > 0.0 {
                    let remaining = (cap.mass - moved).max(0.0) / cap.mass;
                    cap.mass *= remaining;
                    cap.east *= remaining;
                    cap.south *= remaining;
                }
            }
            let mut send = |neighbour: Option<usize>, share: f64, dx: f64, dz: f64| {
                if let Some(j) = neighbour {
                    let pulse = solid.scale(share / shares);
                    let rim = if !scours
                        && air.ground - at(forcing, j).ground > cfg.cliff_slope * cfg.spacing
                    {
                        cfg.cornice_efficiency
                    } else {
                        0.0
                    };
                    let caught = pulse.scale(rim);
                    let cap = at_mut(caps, i);
                    cap.mass += caught.mass;
                    cap.east += dx * caught.mass;
                    cap.south += dz * caught.mass;
                    at_mut(drift, i).add(caught);
                    at_mut(drift, j).add(pulse.scale(1.0 - rim));
                }
            };
            send(face_x, share_x, sx.signum(), 0.0);
            send(face_z, share_z, 0.0, sz.signum());
        }
    }

    // Every participant owns disjoint columns of each mutable plane after preparation.
    unsafe fn columns(&self, count: usize, part: u32, parts: core::num::NonZeroU32) {
        let pairs = (count / 2) as u64;
        let begin = 2 * (pairs * u64::from(part) / u64::from(parts.get())) as usize;
        let end = 2 * (pairs * u64::from(part + 1) / u64::from(parts.get())) as usize;
        let has_tail = part + 1 == parts.get() && count % 2 != 0;
        let columns = end - begin + usize::from(has_tail);
        let mut work = Work {
            columns: columns as f64,
            layers: (columns * self.layers) as f64,
            ..Work::default()
        };
        let dt = self.dt;
        for i in (begin..end).step_by(2) {
            let mut a = unsafe { Column::new(self, i) };
            let mut b = unsafe { Column::new(self, i + 1) };
            let first = a.first.min(b.first);
            let last = a.last.max(b.last);
            for j in (first + 1)..=last {
                match (a.interface(j, dt), b.interface(j, dt)) {
                    (Some(left), Some(right)) => {
                        let (moved_left, moved_right) = conduct_two(&left, &right);
                        left.accept(a.pack, moved_left);
                        right.accept(b.pack, moved_right);
                        work.conduction_interfaces += 2.0;
                        work.paired_interfaces += 2.0;
                    }
                    (Some(link), None) => {
                        link.accept(a.pack, link.scalar());
                        work.conduction_interfaces += 1.0;
                    }
                    (None, Some(link)) => {
                        link.accept(b.pack, link.scalar());
                        work.conduction_interfaces += 1.0;
                    }
                    (None, None) => {}
                }
            }
            a.finish(count);
            b.finish(count);
        }
        if has_tail {
            let mut column = unsafe { Column::new(self, end) };
            for j in (column.first + 1)..=column.last {
                if let Some(link) = column.interface(j, dt) {
                    link.accept(column.pack, link.scalar());
                    work.conduction_interfaces += 1.0;
                }
            }
            column.finish(count);
        }
        if !self.work.is_null() {
            work.bisection_iterations = work.conduction_interfaces * f64::from(BISECTION_STEPS);
            unsafe { self.work.add(part as usize).write(work) };
        }
    }
}

struct Column<'a> {
    job: &'a Job,
    index: usize,
    pack: &'a mut [Pack],
    previous_ice: &'a mut [f64],
    first: usize,
    last: usize,
    previous: usize,
    drain: f64,
    drain_heat: f64,
    unused: f64,
}

impl<'a> Column<'a> {
    /// The caller owns this column for the phase and never borrows another participant's pack.
    unsafe fn new(job: &'a Job, index: usize) -> Self {
        let layers = job.layers;
        let start = index * layers;
        let air = unsafe { &*job.forcing.add(index) };
        let pack = unsafe { slice::from_raw_parts_mut(job.packs.add(start), layers) };
        let previous_ice = unsafe { slice::from_raw_parts_mut(job.old_ice.add(start), layers) };
        let dt = job.dt;
        at_mut(pack, 0).add(unsafe { *job.drift.add(index) });
        let mut first = layers;
        let mut last = 0;
        for j in 0..layers {
            let layer = *at(pack, j);
            *at_mut(previous_ice, j) = layer.mass - layer.liquid();
            if layer.mass > 0.0 {
                first = first.min(j);
                last = j;
            }
        }
        let drain = dt * air.rain;
        let drain_heat = drain * (LF + CW * air.air_celsius.max(0.0));
        let mut unused = dt * (air.top_heat + air.bottom_heat);
        if first < layers {
            at_mut(pack, first).add(Pack {
                mass: drain,
                heat: drain_heat,
                depth: 0.0,
            });
            at_mut(pack, first).heat += dt * air.top_heat;
            at_mut(pack, last).heat += dt * air.bottom_heat;
            unused = 0.0;
        }
        Self {
            job,
            index,
            pack,
            previous_ice,
            first,
            last,
            previous: first,
            drain,
            drain_heat,
            unused,
        }
    }

    fn interface(&mut self, j: usize, dt: f64) -> Option<Conduction> {
        if j > self.first && j <= self.last && at(self.pack, j).mass > 0.0 {
            let previous = self.previous;
            self.previous = j;
            Conduction::between(self.pack, previous, j, dt)
        } else {
            None
        }
    }

    fn finish(self, count: usize) {
        let i = self.index;
        let layers = self.job.layers;
        let start = i * layers;
        let width = self.job.nonzero_width().get();
        let depth = self.job.depth;
        let dt = self.job.dt;
        let world_dt = self.job.world_dt;
        let forcing = unsafe { slice::from_raw_parts(self.job.forcing, count) };
        let air = at(forcing, i);
        let cfg = unsafe { &*self.job.config };
        let eta = unsafe { slice::from_raw_parts(self.job.viscosity.add(start), layers) };
        let strength = unsafe { slice::from_raw_parts(self.job.cohesion.add(start), layers) };
        let cap = unsafe { &mut *self.job.caps.add(i) };
        let pack = self.pack;
        let previous_ice = self.previous_ice;
        let first = self.first;
        let last = self.last;
        let mut drain = self.drain;
        let mut drain_heat = self.drain_heat;
        let mut unused = self.unused;
        let mut slab_depth = 0.0;
        let mut slab_mass = 0.0;
        let mut stability = f64::INFINITY;
        if first < layers {
            let x = i % width;
            let z = i / width;
            let west = if x > 0 { i - 1 } else { i };
            let east = if x + 1 < width { i + 1 } else { i };
            let north = if z > 0 { i - width } else { i };
            let south = if z + 1 < depth { i + width } else { i };
            let gx = if east == west {
                0.0
            } else {
                (at(forcing, east).ground - at(forcing, west).ground)
                    / (cfg.spacing * (east - west) as f64)
            };
            let gz = if south == north {
                0.0
            } else {
                (at(forcing, south).ground - at(forcing, north).ground)
                    / (cfg.spacing * (((south - north) / width) as f64))
            };
            let slope = sqrt(gx * gx + gz * gz);
            let normal_weight = cfg.gravity / (1.0 + slope * slope);
            let mut overburden = 0.0;
            let mut elevation = 0.0;
            drain = 0.0;
            drain_heat = 0.0;
            for j in first..=last {
                let k = j;
                let layer = at_mut(pack, k);
                layer.add(Pack {
                    mass: drain,
                    heat: drain_heat,
                    depth: 0.0,
                });
                let liquid = layer.liquid();
                let ice = layer.mass - liquid;
                if ice > 0.0 {
                    let before = *at(previous_ice, k);
                    if ice < before {
                        layer.depth *= ice / before;
                    } else {
                        layer.depth += (ice - before) / ICE;
                    }
                    let pressure = normal_weight * (overburden + 0.5 * layer.mass);
                    layer.depth =
                        (layer.depth / (1.0 + dt * pressure / *at(eta, k))).max(ice / ICE);
                    let supported =
                        (layer.depth - ice / ICE).max(0.0) * WATER * cfg.liquid_retention;
                    drain = (liquid - supported).max(0.0);
                } else {
                    drain = liquid;
                }
                if dt == 0.0 {
                    drain = 0.0;
                }
                drain_heat = drain * (LF + CW * layer.temp().max(0.0));
                layer.mass -= drain;
                layer.heat -= drain_heat;
                if layer.mass <= 0.0 {
                    unused += layer.heat;
                    *layer = Pack::zero();
                }
                if layer.mass > 0.0 {
                    let normal = normal_weight * overburden;
                    let shear = normal * slope;
                    if shear > 0.0 {
                        let factor =
                            (*at(strength, k) + air.support + cfg.friction * normal) / shear;
                        if factor < stability {
                            stability = factor;
                            slab_depth = elevation;
                            slab_mass = overburden;
                        }
                    }
                    overburden += layer.mass;
                    elevation += layer.depth;
                }
            }
            let normal = normal_weight * overburden;
            if normal * slope > 0.0 {
                let factor =
                    (*at(strength, last) + air.support + cfg.friction * normal) / (normal * slope);
                if factor < stability {
                    stability = factor;
                    slab_depth = elevation;
                    slab_mass = overburden;
                }
            }
        }

        let mut mass = 0.0;
        let mut depth = 0.0;
        let mut water = 0.0;
        let mut surface = air.air_celsius;
        let mut seen = false;
        for j in 0..layers {
            let layer = *at(pack, j);
            if layer.mass > 0.0 && !seen {
                surface = layer.temp();
                seen = true;
            }
            mass += layer.mass;
            depth += layer.depth;
            water += layer.liquid();
        }
        let top = *at(pack, 0);
        let fraction = if cap.mass > 0.0 {
            ((top.mass - top.liquid()) / cap.mass).min(1.0)
        } else {
            0.0
        };
        cap.mass *= fraction;
        cap.east *= fraction;
        cap.south *= fraction;
        let cross_section = cfg.spacing / (cfg.cornice_density * cfg.cornice_thickness);
        let runoff = drain / (WATER * world_dt);
        unsafe { *self.job.runoff.add(i) = runoff };
        unsafe { *self.job.discharge.add(i) = runoff * cfg.spacing * cfg.spacing };
        unsafe { *self.job.cover.add(2 * i) = air.ground as f32 };
        unsafe { *self.job.cover.add(2 * i + 1) = depth as f32 };
        let output = Output {
            mass,
            liquid: water,
            temperature: surface + 273.15,
            depth,
            stability,
            slab_depth,
            cornice_east: cap.east * cross_section,
            cornice_south: cap.south * cross_section,
            cornice_mass: cap.mass,
            unused_energy: unused / world_dt,
            runoff_energy: drain_heat / world_dt,
            slab_mass,
        };
        unsafe { *self.job.summary.add(i) = output };
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn snowpack_step(
    packs: *mut Pack,
    caps: *mut Cornice,
    drift: *mut Pack,
    forcing: *const Forcing,
    viscosity: *const f64,
    cohesion: *const f64,
    old_ice: *mut f64,
    config: *const Settings,
    runoff: *mut f64,
    discharge: *mut f64,
    summary: *mut Output,
    cover: *mut f32,
    width: usize,
    depth: usize,
    layers: usize,
    dt: f64,
    world_dt: f64,
    work: *mut Work,
) -> u32 {
    let job = Job {
        packs,
        caps,
        drift,
        forcing,
        viscosity,
        cohesion,
        old_ice,
        config,
        runoff,
        discharge,
        summary,
        cover,
        width,
        depth,
        layers,
        work,
        dt,
        world_dt,
    };
    let Some(count) = job.count() else { return 1 };
    unsafe {
        job.prepare(count);
        job.columns(count, 0, core::num::NonZeroU32::MIN);
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn snowpack_prepare(job: &Job) -> u32 {
    let Some(count) = job.count() else { return 1 };
    unsafe { job.prepare(count) };
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn snowpack_thread_phase(job: &Job, stage: u32, part: u32, parts: u32) -> u32 {
    let Some(count) = job.count() else { return 1 };
    let Some(parts) = core::num::NonZeroU32::new(parts) else {
        return 1;
    };
    if stage != 0 || part >= parts.get() {
        return 1;
    }
    unsafe { job.columns(count, part, parts) };
    0
}
