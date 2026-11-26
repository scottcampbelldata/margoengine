//! Conservative cell-centred heat transport. The world owns all memory. This module
//! has no static data, allocator, or stack storage in linear memory.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;
use core::ptr;

mod stress;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

// Coefficients are planar in this order. Face conductances name the positive face;
// the adjoining cell reads the same coefficient for its negative face.
const INV_SOLID: usize = 0;
const INV_LIQUID: usize = 1;
const SOLIDUS: usize = 2;
const LIQUIDUS: usize = 3;
const INV_LATENT: usize = 4;
const FACE_X: usize = 5;
const FACE_Y: usize = 6;
const FACE_Z: usize = 7;
const BOUNDARY: usize = 8;
const POWER: usize = 9;
const CONDUCTANCE: usize = 10;

#[inline]
unsafe fn load2(base: *const f64, i: usize) -> v128 {
    unsafe { v128_load(base.add(i).cast()) }
}

// Invert enthalpy without a division per cell. Using two f64 lanes preserves the
// arithmetic and evaluation order of the scalar tail.
unsafe fn decode(
    energy: *const f64,
    temperature: *mut f64,
    liquid: *mut f64,
    coeff: *const f64,
    n: usize,
) {
    let mut i = 0;
    let zero = f64x2_splat(0.0);
    let one = f64x2_splat(1.0);
    unsafe {
        while i + 1 < n {
            let h = load2(energy, i);
            let hs = load2(coeff, SOLIDUS * n + i);
            let hl = load2(coeff, LIQUIDUS * n + i);
            let base = f64x2_mul(f64x2_min(h, hs), load2(coeff, INV_SOLID * n + i));
            let excess = f64x2_mul(
                f64x2_max(zero, f64x2_sub(h, hl)),
                load2(coeff, INV_LIQUID * n + i),
            );
            let fraction = f64x2_mul(f64x2_sub(h, hs), load2(coeff, INV_LATENT * n + i));
            v128_store(temperature.add(i).cast(), f64x2_add(base, excess));
            v128_store(
                liquid.add(i).cast(),
                f64x2_min(one, f64x2_max(zero, fraction)),
            );
            i += 2;
        }
        if i < n {
            let h = *energy.add(i);
            let hs = *coeff.add(SOLIDUS * n + i);
            let hl = *coeff.add(LIQUIDUS * n + i);
            *temperature.add(i) = h.min(hs) * *coeff.add(INV_SOLID * n + i)
                + (h - hl).max(0.0) * *coeff.add(INV_LIQUID * n + i);
            *liquid.add(i) = ((h - hs) * *coeff.add(INV_LATENT * n + i)).clamp(0.0, 1.0);
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn thermal_decode(
    energy: *const f64,
    temperature: *mut f64,
    liquid: *mut f64,
    coeff: *const f64,
    count: usize,
) {
    unsafe { decode(energy, temperature, liquid, coeff, count) };
}

#[inline]
unsafe fn face(
    temp: *const f64,
    g: *const f64,
    neighbour: usize,
    positive: usize,
    cell: f64,
) -> f64 {
    unsafe { *g.add(positive) * (*temp.add(neighbour) - cell) }
}

// Conduction through the half cell and exchange with the surroundings carry the
// same flux at the face. Solve in watts so conductivity does not erase a small
// surface-to-cell temperature difference through rounding.
fn radiative_power(cell: f64, conductance: f64, factor: f64, film: f64, ambient: f64) -> f64 {
    let delta = ambient - cell;
    let direction = if delta < 0.0 { -1.0 } else { 1.0 };
    let exchange = |surface: f64| {
        let difference = (ambient - surface).abs();
        (film + factor * (ambient + surface) * (ambient * ambient + surface * surface)) * difference
    };
    let mut lo = 0.0;
    let mut hi = (conductance * delta.abs()).min(exchange(cell));
    if hi == 0.0 {
        return 0.0;
    }
    if !hi.is_finite() {
        return f64::NAN;
    }
    let colder = cell.min(ambient);
    let hotter = cell.max(ambient);
    // Each iteration halves the initial bracket. 53 halvings match the
    // significand width of f64 and fix the operation order across runtimes.
    for _ in 0..53 {
        let middle = lo + (hi - lo) * 0.5;
        let surface = (cell + direction * (middle / conductance))
            .max(colder)
            .min(hotter);
        if exchange(surface) > middle {
            lo = middle;
        } else {
            hi = middle;
        }
    }
    direction * (lo + (hi - lo) * 0.5)
}

struct Stencil {
    coefficients: *const f64,
    nx: usize,
    ny: usize,
    nz: usize,
}

impl Stencil {
    #[inline(always)]
    fn visit(&self, mut cell: impl FnMut(usize, usize, usize, usize) -> bool) -> bool {
        let mut i = 0;
        for z in 0..self.nz {
            for y in 0..self.ny {
                for x in 0..self.nx {
                    if !cell(i, x, y, z) {
                        return false;
                    }
                    i += 1;
                }
            }
        }
        true
    }

    // Use the same face fluxes for forward Euler and the final conservative
    // projection of a backward Euler step.
    #[inline(always)]
    unsafe fn watts(
        &self,
        temperature: *const f64,
        i: usize,
        x: usize,
        y: usize,
        z: usize,
        radiated: f64,
    ) -> f64 {
        let plane = self.nx * self.ny;
        let n = plane * self.nz;
        let coeff = self.coefficients;
        unsafe {
            let t = *temperature.add(i);
            let mut watts = *coeff.add(POWER * n + i) - *coeff.add(BOUNDARY * n + i) * t;
            watts += radiated;
            let gx = coeff.add(FACE_X * n);
            let gy = coeff.add(FACE_Y * n);
            let gz = coeff.add(FACE_Z * n);
            if x != 0 {
                watts += face(temperature, gx, i - 1, i - 1, t);
            }
            if x + 1 < self.nx {
                watts += face(temperature, gx, i + 1, i, t);
            }
            if y != 0 {
                watts += face(temperature, gy, i - self.nx, i - self.nx, t);
            }
            if y + 1 < self.ny {
                watts += face(temperature, gy, i + self.nx, i, t);
            }
            if z != 0 {
                watts += face(temperature, gz, i - plane, i - plane, t);
            }
            if z + 1 < self.nz {
                watts += face(temperature, gz, i + plane, i, t);
            }
            watts
        }
    }
}

#[inline]
unsafe fn update_radiation(
    power: *mut f64,
    temp: *const f64,
    radiation: *const f64,
    radiators: usize,
    n: usize,
) {
    if radiators == 0 {
        return;
    }
    unsafe {
        ptr::write_bytes(power, 0, n);
        for index in 0..radiators {
            let entry = radiation.add(index * 5);
            let cell = *entry as usize;
            *power.add(cell) += radiative_power(
                (*temp.add(cell)).max(0.0),
                *entry.add(1),
                *entry.add(2),
                *entry.add(3),
                *entry.add(4),
            );
        }
    }
}

// Invert H(T) + theta*T. The interval of RHS values between the
// shifted solidus and liquidus maps to exactly the phase temperature.
#[inline]
unsafe fn implicit_temperature(rhs: f64, theta: f64, coeff: *const f64, n: usize, i: usize) -> f64 {
    unsafe {
        let inv_solid = *coeff.add(INV_SOLID * n + i);
        let inv_liquid = *coeff.add(INV_LIQUID * n + i);
        let hs = *coeff.add(SOLIDUS * n + i);
        let hl = *coeff.add(LIQUIDUS * n + i);
        let melting = hs * inv_solid;
        let shifted = rhs - theta * melting;
        let sensible = if shifted < hs {
            let inv = if hs == 0.0 { inv_liquid } else { inv_solid };
            (rhs / (1.0 + theta * inv)) * inv
        } else if shifted > hl {
            melting + ((shifted - hl) / (1.0 + theta * inv_liquid)) * inv_liquid
        } else {
            melting
        };
        if !rhs.is_finite() || !shifted.is_finite() {
            return f64::NAN;
        }
        sensible
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn thermal_step(
    energy: *mut f64,
    temperature: *mut f64,
    liquid: *mut f64,
    coeff: *const f64,
    scratch: *mut f64,
    source: *const f64,
    radiation: *const f64,
    radiators: usize,
    nx: usize,
    ny: usize,
    nz: usize,
    steps: u32,
    dt: f64,
    implicit: u32,
) -> u32 {
    let n = nx * ny * nz;
    let stencil = Stencil {
        coefficients: coeff,
        nx,
        ny,
        nz,
    };
    unsafe {
        let first = scratch.add(n);
        let fraction = scratch.add(2 * n);
        let second = scratch.add(3 * n);
        let radiation_power = scratch.add((3 + implicit as usize) * n);
        for i in 0..n {
            let input = if source.is_null() {
                0.0
            } else {
                *source.add(i)
            };
            let h = *energy.add(i) + input;
            if !h.is_finite() || h < 0.0 {
                return 1;
            }
            *scratch.add(i) = h;
        }
        for _ in 0..steps {
            decode(scratch, first, fraction, coeff, n);
            let mut temp = first;
            if implicit != 0 {
                let mut next = second;
                // Each row moves the sum of conductances to its diagonal.
                // A radiating face adds g*T_surface(T_cell) to the iterate's
                // RHS, with slope in [0,g]. Thus every row is Lipschitz with
                // constant at most dt*G/(min(C)+dt*G) <= 2/3.
                let mut converged = false;
                for _ in 0..192 {
                    update_radiation(radiation_power, temp, radiation, radiators, n);
                    let mut delta: f64 = 0.0;
                    let mut magnitude: f64 = 1.0;
                    let valid = stencil.visit(|i, x, y, z| {
                        let previous = *temp.add(i);
                        let rad = if radiators == 0 {
                            0.0
                        } else {
                            *radiation_power.add(i)
                        };
                        let theta = dt * *coeff.add(CONDUCTANCE * n + i);
                        let rhs = *scratch.add(i)
                            + dt * stencil.watts(temp, i, x, y, z, rad)
                            + theta * previous;
                        let t = implicit_temperature(rhs, theta, coeff, n, i);
                        if !t.is_finite() {
                            return false;
                        }
                        *next.add(i) = t;
                        delta = delta.max((t - previous).abs());
                        magnitude = magnitude.max(t.abs());
                        true
                    });
                    if !valid {
                        return 1;
                    }
                    core::mem::swap(&mut temp, &mut next);
                    // A posteriori bound: ||T_next - T_exact|| <= 2*delta.
                    if delta <= (64.0 * f64::EPSILON) * magnitude {
                        converged = true;
                        break;
                    }
                }
                if !converged {
                    return 2;
                }
            }
            update_radiation(radiation_power, temp, radiation, radiators, n);
            let valid = stencil.visit(|i, x, y, z| {
                let rad = if radiators == 0 {
                    0.0
                } else {
                    *radiation_power.add(i)
                };
                let h = *scratch.add(i) + dt * stencil.watts(temp, i, x, y, z, rad);
                if !h.is_finite() || h < 0.0 {
                    return false;
                }
                *scratch.add(i) = h;
                true
            });
            if !valid {
                return 1;
            }
        }
        decode(scratch, first, fraction, coeff, n);
        for i in 0..n {
            if !(*first.add(i)).is_finite() {
                return 1;
            }
        }
        ptr::copy_nonoverlapping(scratch, energy, n);
        ptr::copy_nonoverlapping(first, temperature, n);
        ptr::copy_nonoverlapping(fraction, liquid, n);
    }
    0
}
