#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};
use core::num::NonZeroUsize;
use core::slice;

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

#[inline(always)]
fn word(values: &[f64], i: usize) -> f64 {
    if i >= values.len() {
        core::arch::wasm32::unreachable()
    }
    unsafe { *values.get_unchecked(i) }
}

#[inline(always)]
fn word_mut(values: &mut [f64], i: usize) -> &mut f64 {
    if i >= values.len() {
        core::arch::wasm32::unreachable()
    }
    unsafe { values.get_unchecked_mut(i) }
}

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

#[derive(Clone, Copy)]
struct Grid {
    nx: NonZeroUsize,
    nz: usize,
    dx: f64,
    dz: f64,
    open: u32,
}

impl Grid {
    fn nx(self) -> usize {
        self.nx.get()
    }

    fn coords(self, i: usize) -> (usize, usize) {
        (i % self.nx(), i / self.nx())
    }

    fn x_width(self, z: usize) -> f64 {
        if z == 0 || z + 1 == self.nz {
            self.dz * 0.5
        } else {
            self.dz
        }
    }

    fn z_width(self, x: usize) -> f64 {
        if x == 0 || x + 1 == self.nx() {
            self.dx * 0.5
        } else {
            self.dx
        }
    }

    fn active_faces(
        self,
        n: usize,
        mut visit: impl FnMut(usize, usize, bool, f64) -> bool,
    ) -> bool {
        for i in 0..n {
            let (x, z) = self.coords(i);
            if x + 1 < self.nx() && !visit(i, i + 1, true, self.x_width(z)) {
                return false;
            }
            if z + 1 < self.nz && !visit(i, i + self.nx(), false, self.z_width(x)) {
                return false;
            }
        }
        true
    }

    fn outward_rate(self, i: usize, vx: f64, vz: f64) -> f64 {
        let (x, z) = self.coords(i);
        let mut result = 0.0;
        if x == 0 && self.open & 1 != 0 {
            result += (-vx).max(0.0) * self.x_width(z);
        }
        if x + 1 == self.nx() && self.open & 2 != 0 {
            result += vx.max(0.0) * self.x_width(z);
        }
        if z == 0 && self.open & 4 != 0 {
            result += (-vz).max(0.0) * self.z_width(x);
        }
        if z + 1 == self.nz && self.open & 8 != 0 {
            result += vz.max(0.0) * self.z_width(x);
        }
        result
    }

    fn outside(self, x: f64, z: f64) -> bool {
        x < 0.0 || z < 0.0 || x > (self.nx() - 1) as f64 || z > (self.nz - 1) as f64
    }

    fn sample(self, values: &[f64], x: f64, z: f64) -> f64 {
        if self.outside(x, z) {
            return 0.0;
        }
        let i = (x as usize).min(self.nx() - 2);
        let j = (z as usize).min(self.nz - 2);
        let f = x - i as f64;
        let g = z - j as f64;
        let k = i + self.nx() * j;
        let a = word(values, k) * (1.0 - f) + word(values, k + 1) * f;
        let b = word(values, k + self.nx()) * (1.0 - f) + word(values, k + self.nx() + 1) * f;
        a * (1.0 - g) + b * g
    }

    fn deposit(self, values: &mut [f64], x: f64, z: f64, mass: f64) {
        let x = x.max(0.0).min((self.nx() - 1) as f64);
        let z = z.max(0.0).min((self.nz - 1) as f64);
        let i = (x as usize).min(self.nx() - 2);
        let j = (z as usize).min(self.nz - 2);
        let f = x - i as f64;
        let g = z - j as f64;
        let k = i + self.nx() * j;
        *word_mut(values, k) += mass * (1.0 - f) * (1.0 - g);
        *word_mut(values, k + 1) += mass * f * (1.0 - g);
        *word_mut(values, k + self.nx()) += mass * (1.0 - f) * g;
        *word_mut(values, k + self.nx() + 1) += mass * f * g;
    }

    fn hop(self, buffer: &mut [f64], i: usize, delta: (f64, f64), half: f64, mass: f64) -> f64 {
        let (x, z) = self.coords(i);
        let (x, z) = (x as f64, z as f64);
        let (sx, sz) = delta;
        let (dist_x, x_edge) = if sx > 0.0 {
            (((self.nx() - 1) as f64 - x) / sx, 2)
        } else if sx < 0.0 {
            (-x / sx, 1)
        } else {
            (f64::INFINITY, 0)
        };
        let (dist_z, z_edge) = if sz > 0.0 {
            (((self.nz - 1) as f64 - z) / sz, 8)
        } else if sz < 0.0 {
            (-z / sz, 4)
        } else {
            (f64::INFINITY, 0)
        };
        let mut edge = 0;
        if dist_x <= dist_z {
            edge |= x_edge;
        }
        if dist_z <= dist_x {
            edge |= z_edge;
        }
        let reach = dist_x.min(dist_z);
        let tail = half * half;
        *word_mut(buffer, i) += mass * (1.0 - half);
        let mut left = mass * half;
        let mut at = 1.0;
        while at + 0.5 <= reach && left > 0.0 {
            self.deposit(buffer, x + at * sx, z + at * sz, left * (1.0 - tail));
            left *= tail;
            at += 1.0;
        }
        if self.open & edge != 0 {
            left
        } else {
            self.deposit(buffer, x + reach * sx, z + reach * sz, left);
            0.0
        }
    }
}

#[repr(C)]
struct Settings {
    gravity: f64,
    grain_density: f64,
    bulk_density: f64,
    diameter: f64,
    restitution: f64,
    multiplication: f64,
    grain_speed: f64,
    impact_threshold: f64,
    initiation_ratio: f64,
    settling_time: f64,
    dust_efficiency: f64,
    repose: f64,
    avalanche_time: f64,
    hill_strength: f64,
    hill_slope: f64,
    hill_fetch: f64,
    snow: f64,
    ripple_rate: f64,
    ripple_cotangent: f64,
}

fn relax(mass: f64, growth: f64, saturation: f64, source: f64, dt: f64) -> Option<f64> {
    // Backward Euler of S + r m (1 - m/m_s), the positive root of the quadratic.
    let rhs = mass + dt * source;
    let a = 1.0 - dt * growth;
    let b = dt * growth / saturation;
    if b == 0.0 {
        return rhs.is_finite().then_some(rhs);
    }
    let discriminant = sqrt(a * a + 4.0 * b * rhs);
    if !discriminant.is_finite() {
        return None;
    }
    let value = if rhs == 0.0 {
        0.0
    } else if a >= 0.0 {
        let divisor = discriminant + a;
        if !divisor.is_finite() {
            return None;
        }
        2.0 * rhs / divisor
    } else {
        let divisor = 2.0 * b;
        if !divisor.is_finite() {
            return None;
        }
        (discriminant - a) / divisor
    };
    value.is_finite().then_some(value)
}

enum HillError {
    Range,
    Fetch,
}

fn hill_multiplier(
    grid: Grid,
    i: usize,
    sx: &[f64],
    sz: &[f64],
    ux: f64,
    uz: f64,
    p: &Settings,
) -> Result<f64, HillError> {
    if p.hill_strength == 0.0 {
        return Ok(1.0);
    }
    let (x, z) = grid.coords(i);
    let h = grid.dx.min(grid.dz);
    let width = (grid.nx() - 1) as f64 * grid.dx;
    let depth = (grid.nz - 1) as f64 * grid.dz;
    let diagonal = sqrt(width * width + depth * depth);
    let samples = p.hill_fetch.min(diagonal) / h;
    if samples.is_nan() {
        return Err(HillError::Range);
    }
    let displacement = |sample: f64| {
        let distance = sample * h;
        (ux * distance / grid.dx, uz * distance / grid.dz)
    };
    let outside = |ix, iz| {
        grid.outside(x as f64 - ix, z as f64 - iz) && grid.outside(x as f64 + ix, z as f64 + iz)
    };
    // If the first index outside the native range still overlaps the bed, refuse before evaluating the ray.
    let first_unrepresentable = usize::MAX as f64 + 1.0;
    if samples >= first_unrepresentable {
        let (ix, iz) = displacement(first_unrepresentable);
        if !outside(ix, iz) {
            return Err(HillError::Fetch);
        }
    }
    let mut hilbert = 0.0;
    let mut k = 1usize;
    while (k as f64) <= samples {
        let (ix, iz) = displacement(k as f64);
        if ix.is_nan() || iz.is_nan() {
            return Err(HillError::Range);
        }
        // Both rays keep moving away from the cell, so their remaining out-of-grid samples are exactly zero.
        if outside(ix, iz) {
            break;
        }
        let left = grid.sample(sx, x as f64 - ix, z as f64 - iz) * ux
            + grid.sample(sz, x as f64 - ix, z as f64 - iz) * uz;
        let right = grid.sample(sx, x as f64 + ix, z as f64 + iz) * ux
            + grid.sample(sz, x as f64 + ix, z as f64 + iz) * uz;
        hilbert += (left - right) / k as f64;
        if k as f64 + 1.0 > samples || k == usize::MAX {
            break;
        }
        k += 1;
    }
    let slope = word(sx, i) * ux + word(sz, i) * uz;
    let multiplier =
        1.0 + p.hill_strength * (hilbert / core::f64::consts::PI + p.hill_slope * slope);
    if !multiplier.is_finite() {
        return Err(HillError::Range);
    }
    Ok(multiplier.max(0.0))
}

unsafe fn read_col<'a>(base: *const f64, n: usize, column: usize) -> &'a [f64] {
    unsafe { slice::from_raw_parts(base.add(column * n), n) }
}

unsafe fn write_col<'a>(base: *mut f64, n: usize, column: usize) -> &'a mut [f64] {
    unsafe { slice::from_raw_parts_mut(base.add(column * n), n) }
}

mod step;
