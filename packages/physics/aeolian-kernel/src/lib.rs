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

    fn active_faces(self, n: usize, mut visit: impl FnMut(usize, usize, bool, f64)) {
        for i in 0..n {
            let (x, z) = self.coords(i);
            if x + 1 < self.nx() {
                visit(i, i + 1, true, self.x_width(z));
            }
            if z + 1 < self.nz {
                visit(i, i + self.nx(), false, self.z_width(x));
            }
        }
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

    fn sample(self, values: &[f64], x: f64, z: f64) -> f64 {
        if x < 0.0 || z < 0.0 || x > (self.nx() - 1) as f64 || z > (self.nz - 1) as f64 {
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

fn relax(mass: f64, growth: f64, saturation: f64, source: f64, dt: f64) -> f64 {
    // Backward Euler of S + r m (1 - m/m_s), the positive root of the quadratic.
    let rhs = mass + dt * source;
    let a = 1.0 - dt * growth;
    let b = dt * growth / saturation;
    if b == 0.0 {
        return rhs;
    }
    let discriminant = sqrt(a * a + 4.0 * b * rhs);
    if rhs == 0.0 {
        0.0
    } else if a >= 0.0 {
        2.0 * rhs / (discriminant + a)
    } else {
        (discriminant - a) / (2.0 * b)
    }
}

fn hill_multiplier(
    grid: Grid,
    i: usize,
    sx: &[f64],
    sz: &[f64],
    ux: f64,
    uz: f64,
    p: &Settings,
) -> f64 {
    if p.hill_strength == 0.0 {
        return 1.0;
    }
    let (x, z) = grid.coords(i);
    let h = grid.dx.min(grid.dz);
    let width = (grid.nx() - 1) as f64 * grid.dx;
    let depth = (grid.nz - 1) as f64 * grid.dz;
    let diagonal = sqrt(width * width + depth * depth);
    let samples = (p.hill_fetch.min(diagonal) / h) as usize;
    let mut hilbert = 0.0;
    for k in 1..=samples {
        let distance = k as f64 * h;
        let ix = ux * distance / grid.dx;
        let iz = uz * distance / grid.dz;
        let left = grid.sample(sx, x as f64 - ix, z as f64 - iz) * ux
            + grid.sample(sz, x as f64 - ix, z as f64 - iz) * uz;
        let right = grid.sample(sx, x as f64 + ix, z as f64 + iz) * ux
            + grid.sample(sz, x as f64 + ix, z as f64 + iz) * uz;
        hilbert += (left - right) / k as f64;
    }
    let slope = word(sx, i) * ux + word(sz, i) * uz;
    (1.0 + p.hill_strength * (hilbert / core::f64::consts::PI + p.hill_slope * slope)).max(0.0)
}

unsafe fn read_col<'a>(base: *const f64, n: usize, column: usize) -> &'a [f64] {
    unsafe { slice::from_raw_parts(base.add(column * n), n) }
}

unsafe fn write_col<'a>(base: *mut f64, n: usize, column: usize) -> &'a mut [f64] {
    unsafe { slice::from_raw_parts_mut(base.add(column * n), n) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn aeolian_step(
    wind: *const f64,
    controls: *const f64,
    height: *const f64,
    parameters: *const f64,
    mass: *mut f64,
    mobile: *mut f64,
    bed_delta: *mut f64,
    motion: *mut f64,
    dust: *mut f64,
    drag: *mut f64,
    budget: *mut f64,
    scratch: *mut f64,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    open: u32,
    dt: f64,
    world_dt: f64,
) {
    let Some(width) = NonZeroUsize::new(nx) else {
        return;
    };
    if nx < 2 || nz < 2 {
        return;
    }
    let grid = Grid {
        nx: width,
        nz,
        dx,
        dz,
        open,
    };
    let n = nx * nz;
    let p = unsafe { &*parameters.cast::<Settings>() };
    let area = unsafe { read_col(controls, n, 0) };
    let cover = unsafe { read_col(controls, n, 1) };
    let ux = unsafe { read_col(wind, n, 0) };
    let uz = unsafe { read_col(wind, n, 1) };
    let air = unsafe { read_col(wind, n, 2) };
    let hop_tail = unsafe { read_col(wind, n, 3) };
    let height = unsafe { read_col(height, n, 0) };
    let mass = unsafe { write_col(mass, n, 0) };
    let mobile = unsafe { write_col(mobile, n, 0) };
    let bed_delta = unsafe { write_col(bed_delta, n, 0) };
    let motion = unsafe { write_col(motion, 3 * n, 0) };
    let dust = unsafe { write_col(dust, n, 0) };
    let drag = unsafe { write_col(drag, 2 * n, 0) };
    let budget = unsafe { write_col(budget, 2, 0) };
    let sx = unsafe { write_col(scratch, n, 0) };
    let sz = unsafe { write_col(scratch, n, 1) };
    let vx = unsafe { write_col(scratch, n, 2) };
    let vz = unsafe { write_col(scratch, n, 3) };
    let tau = unsafe { write_col(scratch, n, 4) };
    let threshold = unsafe { write_col(scratch, n, 5) };
    let buffer = unsafe { write_col(scratch, n, 6) };
    let out = unsafe { write_col(scratch, n, 7) };
    let donor = unsafe { write_col(scratch, n, 8) };
    let mut max_departure: f64 = 0.0;
    let particle_mass =
        p.grain_density * core::f64::consts::PI / 6.0 * p.diameter * p.diameter * p.diameter;
    let birth_period = sqrt(p.diameter / p.gravity);

    bed_delta.fill(0.0);
    dust.fill(0.0);
    for i in 0..n {
        let (x, z) = grid.coords(i);
        let left = if x > 0 { i - 1 } else { i };
        let right = if x + 1 < nx { i + 1 } else { i };
        let near = if z > 0 { i - nx } else { i };
        let far = if z + 1 < nz { i + nx } else { i };
        *word_mut(sx, i) =
            (word(height, right) - word(height, left)) / ((right - left) as f64 * dx);
        *word_mut(sz, i) =
            (word(height, far) - word(height, near)) / ((far - near) as f64 / nx as f64 * dz);
    }
    for i in 0..n {
        let (wx, wz, rho) = (word(ux, i), word(uz, i), word(air, i));
        let speed = sqrt(wx * wx + wz * wz);
        let (east, south) = if speed > 0.0 {
            (wx / speed, wz / speed)
        } else {
            (0.0, 0.0)
        };
        let bed_shear = if rho > 0.0 && speed > 0.0 {
            rho * speed * speed * word(cover, i) * hill_multiplier(grid, i, sx, sz, east, south, p)
        } else {
            0.0
        };
        *word_mut(tau, i) = bed_shear;
        *word_mut(threshold, i) = if p.impact_threshold > 0.0 {
            rho * p.impact_threshold * p.impact_threshold
        } else {
            0.0064 * (p.grain_density - rho).max(0.0) * p.gravity * p.diameter
        };
        *word_mut(vx, i) = east * p.grain_speed;
        *word_mut(vz, i) = south * p.grain_speed;
        max_departure = max_departure.max(6.0 * (word(vx, i).abs() / dx + word(vz, i).abs() / dz));
    }
    let crossings = dt * max_departure;
    let whole = crossings as usize;
    let count = (whole + usize::from((whole as f64) < crossings)).max(1);
    let sub_dt = dt / count as f64;
    let mass_to_shear = p.gravity / (2.0 * p.restitution);

    for _ in 0..count {
        for i in 0..n {
            let m = word(mass, i);
            let a = word(area, i);
            let critical = word(threshold, i);
            let local_shear = word(tau, i);
            let target = if local_shear > critical && critical > 0.0 {
                let excess = local_shear - critical;
                let mut sat = excess / mass_to_shear;
                if p.snow > 0.0 {
                    let rho = word(air, i);
                    let friction = sqrt(local_shear / (rho * word(cover, i)));
                    let threshold_velocity = sqrt(critical / rho);
                    // Pomeroy–Gray Eq. 11 removes vegetation stress in the numerator only.
                    sat =
                        0.68 * threshold_velocity * excess / (p.gravity * friction * p.grain_speed);
                }
                let growth = p.multiplication * mass_to_shear * excess / (p.grain_speed * critical);
                let fluid_threshold = critical * p.initiation_ratio * p.initiation_ratio;
                let birth = if local_shear > fluid_threshold {
                    particle_mass / birth_period
                } else {
                    0.0
                };
                if sat > 0.0 {
                    relax(m, growth, sat, birth, sub_dt)
                } else {
                    m
                }
            } else {
                m * p.settling_time / (p.settling_time + sub_dt)
            };
            let pickup = ((target - m) * a).min(word(mobile, i));
            let moving = (m + pickup / a).max(0.0);
            *word_mut(mass, i) = moving;
            *word_mut(mobile, i) -= pickup;
            let speed = sqrt(word(vx, i) * word(vx, i) + word(vz, i) * word(vz, i));
            let blown_dust = (p.dust_efficiency * moving * speed * word(cover, i) * a * sub_dt)
                .min(word(mobile, i));
            *word_mut(dust, i) += blown_dust;
            *word_mut(mobile, i) -= blown_dust;
            *word_mut(bed_delta, i) -= (pickup + blown_dust) / (a * p.bulk_density);
            let open_out = grid.outward_rate(i, word(vx, i), word(vz, i)) * moving * sub_dt;
            *word_mut(out, i) = open_out;
            *word_mut(buffer, i) = moving * a;
            *word_mut(donor, i) = open_out;
        }
        grid.active_faces(n, |i, j, east, face| {
            let v = if east { vx as &[f64] } else { vz as &[f64] };
            let speed = 0.5 * (word(v, i) + word(v, j));
            let from = if speed >= 0.0 { i } else { j };
            *word_mut(donor, from) += speed.abs() * face * sub_dt * word(mass, from);
        });
        for i in 0..n {
            let scale = if word(donor, i) > word(buffer, i) {
                word(buffer, i) / word(donor, i)
            } else {
                1.0
            };
            *word_mut(donor, i) = scale;
            let export = scale * word(out, i);
            *word_mut(buffer, i) -= export;
            *word_mut(budget, 0) += export;
        }
        grid.active_faces(n, |i, j, east, face| {
            let v = if east { vx as &[f64] } else { vz as &[f64] };
            let speed = 0.5 * (word(v, i) + word(v, j));
            let (from, to) = if speed >= 0.0 { (i, j) } else { (j, i) };
            let moved = speed.abs() * face * sub_dt * word(mass, from) * word(donor, from);
            *word_mut(buffer, from) -= moved;
            *word_mut(buffer, to) += moved;
        });
        for i in 0..n {
            *word_mut(mass, i) = (word(buffer, i) / word(area, i)).max(0.0);
        }
        if p.ripple_rate > 0.0 {
            buffer.fill(0.0);
            for i in 0..n {
                let (vx, vz) = (word(vx, i), word(vz, i));
                let crossing = (vx.abs() / dx).max(vz.abs() / dz);
                let ejected = if crossing > 0.0 {
                    let slope = (vx * word(sx, i) + vz * word(sz, i)) / p.grain_speed;
                    let impacts = (1.0 + p.ripple_cotangent * slope).max(0.0);
                    (sub_dt
                        * p.ripple_rate
                        * word(mass, i)
                        * impacts
                        * word(area, i)
                        * word(cover, i))
                    .min(word(mobile, i))
                } else {
                    0.0
                };
                *word_mut(out, i) = ejected;
                if ejected > 0.0 {
                    let delta = (vx / (dx * crossing), vz / (dz * crossing));
                    *word_mut(budget, 0) += grid.hop(buffer, i, delta, word(hop_tail, i), ejected);
                }
            }
            for i in 0..n {
                let moved = word(buffer, i) - word(out, i);
                *word_mut(mobile, i) += moved;
                *word_mut(bed_delta, i) += moved / (p.bulk_density * word(area, i));
            }
        }
        if p.avalanche_time > 0.0 {
            grid.active_faces(n, |i, j, east, _| {
                let difference =
                    (word(height, i) - word(height, j)) + (word(bed_delta, i) - word(bed_delta, j));
                let (up, down) = if difference >= 0.0 { (i, j) } else { (j, i) };
                let distance = if east { dx } else { dz };
                let excess = (difference.abs() - p.repose * distance).max(0.0);
                let reduction = excess * sub_dt / (p.avalanche_time + sub_dt);
                let mass = (reduction * p.bulk_density
                    / (1.0 / word(area, up) + 1.0 / word(area, down)))
                .min(word(mobile, up));
                *word_mut(mobile, up) -= mass;
                *word_mut(mobile, down) += mass;
                *word_mut(bed_delta, up) -= mass / (p.bulk_density * word(area, up));
                *word_mut(bed_delta, down) += mass / (p.bulk_density * word(area, down));
            });
        }
    }
    for i in 0..n {
        let moving = word(mass, i);
        *word_mut(motion, 3 * i) = moving;
        *word_mut(motion, 3 * i + 1) = word(vx, i);
        *word_mut(motion, 3 * i + 2) = word(vz, i);
        let stress = (moving * mass_to_shear).min(word(tau, i)) / p.grain_speed;
        *word_mut(drag, 2 * i) = -stress * word(vx, i);
        *word_mut(drag, 2 * i + 1) = -stress * word(vz, i);
        *word_mut(budget, 1) += word(dust, i);
        *word_mut(dust, i) /= word(area, i) * world_dt;
    }
}
