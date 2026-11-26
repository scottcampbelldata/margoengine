#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};
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

fn conduct(a: &mut Pack, b: &mut Pack, dt: f64) {
    if a.mass == 0.0 || b.mass == 0.0 || a.depth == 0.0 || b.depth == 0.0 {
        return;
    }
    let delta = a.temp() - b.temp();
    if delta == 0.0 {
        return;
    }
    let (hot, cold) = if delta > 0.0 { (a, b) } else { (b, a) };
    let conductance = 2.0 / (hot.depth / hot.conductivity() + cold.depth / cold.conductivity());
    let factor = conductance * dt;
    // At equilibrium the temperatures agree. The backward-Euler root is bracketed by zero and the
    // smaller of the explicit flux and the energy needed to pass across the freezing plateau.
    let hot_heat = hot.heat;
    let cold_heat = cold.heat;
    let mut lo = 0.0;
    let mut hi =
        (factor * delta.abs()).min(hot_heat.abs() + cold_heat.abs() + LF * (hot.mass + cold.mass));
    for _ in 0..54 {
        let middle = lo + (hi - lo) * 0.5;
        let target =
            hot.with_heat(hot_heat - middle).temp() - cold.with_heat(cold_heat + middle).temp();
        if middle < factor * target {
            lo = middle;
        } else {
            hi = middle;
        }
    }
    let moved = (lo + hi) * 0.5;
    hot.heat -= moved;
    cold.heat += moved;
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
) {
    if width == 0 || depth == 0 || layers == 0 {
        return;
    }
    let count = width * depth;
    let pack = unsafe { slice::from_raw_parts_mut(packs, count * layers) };
    let caps = unsafe { slice::from_raw_parts_mut(caps, count) };
    let drift = unsafe { slice::from_raw_parts_mut(drift, count) };
    let forcing = unsafe { slice::from_raw_parts(forcing, count) };
    let eta = unsafe { slice::from_raw_parts(viscosity, count * layers) };
    let strength = unsafe { slice::from_raw_parts(cohesion, count * layers) };
    let previous_ice = unsafe { slice::from_raw_parts_mut(old_ice, count * layers) };
    let runoff = unsafe { slice::from_raw_parts_mut(runoff, count) };
    let discharge = unsafe { slice::from_raw_parts_mut(discharge, count) };
    let output = unsafe { slice::from_raw_parts_mut(summary, count) };
    let cover = unsafe { slice::from_raw_parts_mut(cover, count * 2) };
    let cfg = unsafe { &*config };
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
        // Pomeroy–Gray equilibrium flux, sent to adjacent columns in the wind direction.
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

    for i in 0..count {
        let air = at(forcing, i);
        let start = i * layers;
        at_mut(pack, start).add(*at(drift, i));
        let mut first = layers;
        let mut last = 0;
        for j in 0..layers {
            let layer = *at(pack, start + j);
            *at_mut(previous_ice, start + j) = layer.mass - layer.liquid();
            if layer.mass > 0.0 {
                first = first.min(j);
                last = j;
            }
        }
        let rain = dt * air.rain;
        let liquid_heat = LF + CW * air.air_celsius.max(0.0);
        let mut drain = rain;
        let mut drain_heat = rain * liquid_heat;
        let mut unused = dt * (air.top_heat + air.bottom_heat);
        let mut slab_depth = 0.0;
        let mut slab_mass = 0.0;
        let mut stability = f64::INFINITY;
        if first < layers {
            at_mut(pack, start + first).add(Pack {
                mass: rain,
                heat: rain * liquid_heat,
                depth: 0.0,
            });
            at_mut(pack, start + first).heat += dt * air.top_heat;
            at_mut(pack, start + last).heat += dt * air.bottom_heat;
            unused = 0.0;
            let mut previous = start + first;
            for j in (first + 1)..=last {
                let k = start + j;
                let lower = *at(pack, k);
                if lower.mass > 0.0 {
                    let mut updated = lower;
                    conduct(at_mut(pack, previous), &mut updated, dt);
                    *at_mut(pack, k) = updated;
                    previous = k;
                }
            }
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
                let k = start + j;
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
                let factor = (*at(strength, start + last) + air.support + cfg.friction * normal)
                    / (normal * slope);
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
            let layer = *at(pack, start + j);
            if layer.mass > 0.0 && !seen {
                surface = layer.temp();
                seen = true;
            }
            mass += layer.mass;
            depth += layer.depth;
            water += layer.liquid();
        }
        let top = *at(pack, start);
        let cap = at_mut(caps, i);
        let fraction = if cap.mass > 0.0 {
            ((top.mass - top.liquid()) / cap.mass).min(1.0)
        } else {
            0.0
        };
        cap.mass *= fraction;
        cap.east *= fraction;
        cap.south *= fraction;
        let cross_section = cfg.spacing / (cfg.cornice_density * cfg.cornice_thickness);
        *at_mut(runoff, i) = drain / (WATER * world_dt);
        *at_mut(discharge, i) = *at(runoff, i) * cfg.spacing * cfg.spacing;
        *at_mut(cover, 2 * i) = air.ground as f32;
        *at_mut(cover, 2 * i + 1) = depth as f32;
        *at_mut(output, i) = Output {
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
    }
}
