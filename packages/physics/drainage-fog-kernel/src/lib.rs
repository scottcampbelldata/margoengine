#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};
use core::slice;
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
    core::arch::wasm32::unreachable()
}

const CP: f64 = 1005.0;
const LV: f64 = 2_500_000.0;
const K0: f64 = 273.15;
const STEFAN: f64 = 5.670_374_419e-8;

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}
fn length(x: f64, z: f64) -> f64 {
    sqrt(x * x + z * z)
}

#[inline(always)]
fn at<T>(data: &[T], i: usize) -> &T {
    if i >= data.len() {
        core::arch::wasm32::unreachable()
    }
    unsafe { data.get_unchecked(i) }
}

#[inline(always)]
fn at_mut<T>(data: &mut [T], i: usize) -> &mut T {
    if i >= data.len() {
        core::arch::wasm32::unreachable()
    }
    unsafe { data.get_unchecked_mut(i) }
}

fn saturation(celsius: f64, pressure: f64) -> f64 {
    if celsius <= -243.5 {
        return 0.0;
    }
    let vapour = 611.2 * exp(17.67 * celsius / (celsius + 243.5));
    if vapour >= pressure {
        f64::INFINITY
    } else {
        0.622 * vapour / (pressure - vapour)
    }
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Column {
    h: f64,
    px: f64,
    pz: f64,
    energy: f64,
    water: f64,
}

impl Column {
    fn velocity(self) -> (f64, f64) {
        if self.h > 0.0 {
            (self.px / self.h, self.pz / self.h)
        } else {
            (0.0, 0.0)
        }
    }

    fn fraction(self, ratio: f64) -> Self {
        Self {
            h: self.h * ratio,
            px: self.px * ratio,
            pz: self.pz * ratio,
            energy: self.energy * ratio,
            water: self.water * ratio,
        }
    }

    fn add(&mut self, other: Self) {
        self.h += other.h;
        self.px += other.px;
        self.pz += other.pz;
        self.energy += other.energy;
        self.water += other.water;
    }

    fn phase(self, pressure: f64, ambient: f64) -> (f64, f64, f64) {
        if self.h <= 0.0 {
            return (ambient, 0.0, 0.0);
        }
        let available = (self.water / self.h).max(0.0);
        let enthalpy = self.energy / self.h;
        let dry = (enthalpy - LV * available) / CP;
        if available <= saturation(dry, pressure) {
            return (dry + K0, available, 0.0);
        }
        // Solve for the saturated vapour fraction at fixed total water and moist enthalpy.
        let (mut lo, mut hi) = (0.0, available);
        for _ in 0..54 {
            let v = (lo + hi) * 0.5;
            let temperature = (enthalpy - LV * v) / CP;
            if v > saturation(temperature, pressure) {
                hi = v;
            } else {
                lo = v;
            }
        }
        let vapour = (lo + hi) * 0.5;
        (
            (enthalpy - LV * vapour) / CP + K0,
            vapour,
            (available - vapour).max(0.0),
        )
    }
}

#[repr(C)]
struct Forcing {
    ground: f64,
    atmospheric_temperature: f64,
    background_water: f64,
    wind_x: f64,
    wind_z: f64,
    heat: f64,
    moisture: f64,
    sky: f64,
    pressure: f64,
}

#[repr(C)]
struct Settings {
    gravity: f64,
    air: f64,
    drag: f64,
    entrainment: f64,
    emissivity: f64,
    settling_speed: f64,
    extinction_per_mass: f64,
    dx: f64,
    dz: f64,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Local {
    temperature: f64,
    vapour: f64,
    liquid: f64,
    reduced_gravity: f64,
}

#[repr(C)]
struct Output {
    surface: f64,
    thickness: f64,
    x_velocity: f64,
    z_velocity: f64,
    temperature: f64,
    vapour: f64,
    liquid: f64,
    extinction: f64,
    settling: f64,
}

struct Grid {
    width: usize,
    height: usize,
    open: u32,
    dx: f64,
    dz: f64,
}

impl Grid {
    fn neighbours(&self, i: usize) -> (usize, usize, usize, usize) {
        let (x, z) = (i % self.width, i / self.width);
        (
            if x > 0 { i - 1 } else { i },
            if x + 1 < self.width { i + 1 } else { i },
            if z > 0 { i - self.width } else { i },
            if z + 1 < self.height {
                i + self.width
            } else {
                i
            },
        )
    }

    fn faces(&self, mut visit: impl FnMut(usize, usize, bool)) {
        for z in 0..self.height {
            for x in 0..self.width {
                let i = x + z * self.width;
                if x + 1 < self.width {
                    visit(i, i + 1, true);
                }
                if z + 1 < self.height {
                    visit(i, i + self.width, false);
                }
            }
        }
    }

    fn outward(&self, i: usize, x_velocity: f64, z_velocity: f64) -> f64 {
        let (x, z) = (i % self.width, i / self.width);
        let mut out = 0.0;
        if x == 0 && self.open & 1 != 0 {
            out += (-x_velocity).max(0.0) / self.dx;
        }
        if x + 1 == self.width && self.open & 2 != 0 {
            out += x_velocity.max(0.0) / self.dx;
        }
        if z == 0 && self.open & 4 != 0 {
            out += (-z_velocity).max(0.0) / self.dz;
        }
        if z + 1 == self.height && self.open & 8 != 0 {
            out += z_velocity.max(0.0) / self.dz;
        }
        out
    }

    fn slope(&self, i: usize, columns: &[Column], forcing: &[Forcing]) -> (f64, f64) {
        let difference = |a: usize, b: usize| {
            (at(forcing, b).ground - at(forcing, a).ground) + (at(columns, b).h - at(columns, a).h)
        };
        let (left, right, north, south) = self.neighbours(i);
        let gx = if left == right {
            0.0
        } else {
            difference(left, right) / ((right - left) as f64 * self.dx)
        };
        let gz = if north == south {
            0.0
        } else {
            difference(north, south) / (((south - north) / self.width) as f64 * self.dz)
        };
        (gx, gz)
    }

    fn transfer(
        &self,
        a: usize,
        b: usize,
        east: bool,
        state: &[Column],
        forcing: &[Forcing],
    ) -> (usize, usize, f64) {
        let (pa, pb) = (*at(state, a), *at(state, b));
        let (ax, az) = pa.velocity();
        let (bx, bz) = pb.velocity();
        let speed = if east {
            0.5 * (ax + bx) / self.dx
        } else {
            0.5 * (az + bz) / self.dz
        };
        let (from, to) = if speed > 0.0 { (a, b) } else { (b, a) };
        let donor = at(state, from);
        let base = at(forcing, from).ground;
        // Only the column above a shared face sill can pass across it.
        let wet_height = (donor.h - (at(forcing, to).ground - base).max(0.0)).max(0.0);
        (from, to, speed.abs() * wet_height)
    }
}

fn fourth(x: f64) -> f64 {
    let square = x * x;
    square * square
}

fn resolve(column: Column, air: &Forcing, cfg: &Settings) -> Local {
    let (temperature, vapour, liquid) = column.phase(air.pressure, air.atmospheric_temperature);
    let virtual_temperature = temperature * (1.0 + vapour / 0.622) / (1.0 + vapour + liquid);
    let ambient_water = air.background_water;
    let ambient_virtual =
        air.atmospheric_temperature * (1.0 + ambient_water / 0.622) / (1.0 + ambient_water);
    let reduced_gravity =
        cfg.gravity * ((ambient_virtual - virtual_temperature) / ambient_virtual).max(0.0);
    Local {
        temperature,
        vapour,
        liquid,
        reduced_gravity,
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn fog_step(
    state: *mut Column,
    next: *mut Column,
    local: *mut Local,
    forcing: *const Forcing,
    settings: *const Settings,
    departure: *mut f64,
    settling: *mut f64,
    ledger: *mut f64,
    output: *mut Output,
    optical: *mut f32,
    width: usize,
    height: usize,
    open: u32,
    dt: f64,
    world_dt: f64,
) {
    if width == 0 || height == 0 {
        return;
    }
    let n = width * height;
    let columns = unsafe { slice::from_raw_parts_mut(state, n) };
    let next = unsafe { slice::from_raw_parts_mut(next, n) };
    let local = unsafe { slice::from_raw_parts_mut(local, n) };
    let forcing = unsafe { slice::from_raw_parts(forcing, n) };
    let cfg = unsafe { &*settings };
    let departure = unsafe { slice::from_raw_parts_mut(departure, n) };
    let settling = unsafe { slice::from_raw_parts_mut(settling, n) };
    let ledger = unsafe { slice::from_raw_parts_mut(ledger, 6) };
    let output = unsafe { slice::from_raw_parts_mut(output, n) };
    let optical = unsafe { slice::from_raw_parts_mut(optical, 4 * n) };
    let grid = Grid {
        width,
        height,
        open,
        dx: cfg.dx,
        dz: cfg.dz,
    };
    let area = cfg.dx * cfg.dz;
    settling.fill(0.0);
    let mut time = dt;
    while time > 0.0 {
        let mut crossing: f64 = 0.0;
        let mut change: f64 = 0.0;
        for i in 0..n {
            let column = *at(columns, i);
            let cell = resolve(column, at(forcing, i), cfg);
            *at_mut(local, i) = cell;
            let (vx, vz) = column.velocity();
            let c = sqrt(cell.reduced_gravity * column.h);
            crossing = crossing.max((vx.abs() + c) / cfg.dx + (vz.abs() + c) / cfg.dz);
            let (gx, gz) = grid.slope(i, columns, forcing);
            change = change.max(cell.reduced_gravity * (gx.abs() / cfg.dx + gz.abs() / cfg.dz));
        }
        let cfl = crossing + sqrt(change);
        let sub = if cfl > 0.0 {
            time.min(0.45 / cfl)
        } else {
            time
        };
        time -= sub;
        for i in 0..n {
            let (gx, gz) = grid.slope(i, columns, forcing);
            let f = at(forcing, i);
            let a = *at(local, i);
            let mut c = *at(columns, i);
            if c.h > 0.0 {
                let (ux, uz) = c.velocity();
                let relative = length(ux - f.wind_x, uz - f.wind_z);
                let shear = relative * relative;
                let entrained = if shear > 0.0 {
                    sub * cfg.entrainment * relative * shear / (shear + a.reduced_gravity * c.h)
                } else {
                    0.0
                };
                let outside = Column {
                    h: entrained,
                    px: entrained * f.wind_x,
                    pz: entrained * f.wind_z,
                    energy: entrained
                        * (CP * (f.atmospheric_temperature - K0) + LV * f.background_water),
                    water: entrained * f.background_water,
                };
                c.add(outside);
                *at_mut(ledger, 0) += outside.h * cfg.air * area;
                *at_mut(ledger, 1) += outside.water * cfg.air * area;
                c.px -= sub * c.h * a.reduced_gravity * gx;
                c.pz -= sub * c.h * a.reduced_gravity * gz;
                let (px, pz) = (c.px - c.h * f.wind_x, c.pz - c.h * f.wind_z);
                let resistance = 1.0 + sub * cfg.drag * length(px, pz) / (c.h * c.h);
                c.px = c.h * f.wind_x + px / resistance;
                c.pz = c.h * f.wind_z + pz / resistance;
                let radiation = cfg.emissivity * STEFAN * (fourth(f.sky) - fourth(a.temperature));
                let surface_water = (sub * f.moisture / cfg.air).max(-c.water);
                c.energy += sub * (radiation + f.heat) / cfg.air + LV * surface_water;
                c.water += surface_water;
                *at_mut(ledger, 2) += surface_water * cfg.air * area;
            }
            *at_mut(next, i) = c;
            let (vx, vz) = c.velocity();
            *at_mut(departure, i) = sub * grid.outward(i, vx, vz) * c.h;
        }
        grid.faces(|a, b, east| {
            let (from, _, rate) = grid.transfer(a, b, east, next, forcing);
            *at_mut(departure, from) += sub * rate;
        });
        for i in 0..n {
            let c = *at(next, i);
            let (ux, uz) = c.velocity();
            let capacity = *at(departure, i);
            // Use simultaneous donor-limited transfers in all four directions.
            let fraction = if c.h > 0.0 {
                1.0 / c.h.max(capacity)
            } else {
                0.0
            };
            *at_mut(departure, i) = fraction;
            let export = (sub * grid.outward(i, ux, uz) * c.h * fraction).min(1.0);
            *at_mut(columns, i) = c.fraction(1.0 - export);
            *at_mut(ledger, 3) += export * c.h * cfg.air * area;
            *at_mut(ledger, 4) += export * c.water * cfg.air * area;
        }
        grid.faces(|a, b, east| {
            let (from, to, rate) = grid.transfer(a, b, east, next, forcing);
            let moving = at(next, from).fraction(sub * rate * *at(departure, from));
            at_mut(columns, from).add(moving.fraction(-1.0));
            at_mut(columns, to).add(moving);
        });
        for i in 0..n {
            let c = at_mut(columns, i);
            if c.h <= 0.0 {
                *c = Column {
                    h: 0.0,
                    px: 0.0,
                    pz: 0.0,
                    energy: 0.0,
                    water: 0.0,
                };
                continue;
            }
            let f = at(forcing, i);
            let (_, _, droplets) = c.phase(f.pressure, f.atmospheric_temperature);
            let deposited =
                c.h * droplets * (sub * cfg.settling_speed / (c.h + sub * cfg.settling_speed));
            c.water -= deposited;
            let mass = cfg.air * deposited;
            *at_mut(settling, i) += mass;
            *at_mut(ledger, 5) += area * mass;
        }
    }
    for i in 0..n {
        let c = *at(columns, i);
        let f = at(forcing, i);
        let a = resolve(c, f, cfg);
        let (ux, uz) = c.velocity();
        let beta = a.liquid * cfg.air * cfg.extinction_per_mass;
        *at_mut(output, i) = Output {
            surface: f.ground,
            thickness: c.h,
            x_velocity: ux,
            z_velocity: uz,
            temperature: a.temperature,
            vapour: a.vapour,
            liquid: a.liquid,
            extinction: beta,
            settling: *at(settling, i) / world_dt,
        };
        *at_mut(optical, 4 * i) = f.ground as f32;
        *at_mut(optical, 4 * i + 1) = (f.ground + c.h) as f32;
        *at_mut(optical, 4 * i + 2) = beta as f32;
        *at_mut(optical, 4 * i + 3) = 0.0;
    }
}
