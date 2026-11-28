#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};
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
    liquid_absorption: f64,
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
    #[inline]
    fn coordinates(&self, i: usize) -> (usize, usize) {
        if self.width == 0 {
            core::arch::wasm32::unreachable();
        }
        (i % self.width, i / self.width)
    }

    fn neighbours(&self, i: usize) -> (usize, usize, usize, usize) {
        let (x, z) = self.coordinates(i);
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

    fn faces(&self, mut visit: impl FnMut(usize, usize, bool) -> bool) -> bool {
        for z in 0..self.height {
            for x in 0..self.width {
                let i = x + z * self.width;
                if x + 1 < self.width && !visit(i, i + 1, true) {
                    return false;
                }
                if z + 1 < self.height && !visit(i, i + self.width, false) {
                    return false;
                }
            }
        }
        true
    }

    fn outward(&self, i: usize, x_velocity: f64, z_velocity: f64) -> f64 {
        let (x, z) = self.coordinates(i);
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

fn resolve(column: Column, air: &Forcing, cfg: &Settings) -> Option<Local> {
    let (temperature, vapour, liquid) = column.phase(air.pressure, air.atmospheric_temperature);
    let virtual_temperature = temperature * (1.0 + vapour / 0.622) / (1.0 + vapour + liquid);
    let ambient_water = air.background_water;
    let ambient_virtual =
        air.atmospheric_temperature * (1.0 + ambient_water / 0.622) / (1.0 + ambient_water);
    let buoyancy = (ambient_virtual - virtual_temperature) / ambient_virtual;
    if !(temperature > 0.0
        && temperature.is_finite()
        && vapour.is_finite()
        && liquid.is_finite()
        && buoyancy.is_finite())
    {
        return None;
    }
    let reduced_gravity = cfg.gravity * buoyancy.max(0.0);
    reduced_gravity.is_finite().then_some(Local {
        temperature,
        vapour,
        liquid,
        reduced_gravity,
    })
}

mod step;
