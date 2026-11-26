#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, v128_store,
};
use core::slice;
use margoengine_physics_kernel_common::pinned::{exp, pow};

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

// Column state is solid volume, concentration (kg/m³), bedload capacity (m²/s), shear stress (Pa).
const SOLID: usize = 0;
const CONCENTRATION: usize = 1;
const BEDLOAD: usize = 2;
const SHEAR: usize = 3;
const PLANES: usize = 4;
const DRY: f64 = 1e-6;
const WEIGHTS: [f64; 4] = [1.0 / 6.0, 1.0 / 3.0, 1.0 / 3.0, 1.0 / 6.0];

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

#[derive(Clone, Copy)]
struct Grid {
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
}

impl Grid {
    fn count(self) -> usize {
        self.nx * self.nz
    }

    fn vertices(self, cell: usize) -> [usize; 4] {
        let stride = self.nz + 1;
        let a = cell / self.nx + (cell % self.nx) * stride;
        [a, a + 1, a + stride, a + stride + 1]
    }

    fn faces(self, mut visit: impl FnMut(usize, Option<usize>, Option<usize>, bool, f64, u32)) {
        let mut k = 0;
        for j in 0..self.nz {
            for i in 0..=self.nx {
                let left = if i > 0 {
                    Some(i - 1 + j * self.nx)
                } else {
                    None
                };
                let right = if i < self.nx {
                    Some(i + j * self.nx)
                } else {
                    None
                };
                let side = if i == 0 {
                    1
                } else if i == self.nx {
                    2
                } else {
                    0
                };
                visit(k, left, right, true, self.dz, side);
                k += 1;
            }
        }
        for j in 0..=self.nz {
            for i in 0..self.nx {
                let left = if j > 0 {
                    Some(i + (j - 1) * self.nx)
                } else {
                    None
                };
                let right = if j < self.nz {
                    Some(i + j * self.nx)
                } else {
                    None
                };
                let side = if j == 0 {
                    4
                } else if j == self.nz {
                    8
                } else {
                    0
                };
                visit(k, left, right, false, self.dx, side);
                k += 1;
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Water {
    depth: f64,
    qx: f64,
    qz: f64,
}

impl Water {
    const DRY_CELL: Self = Self {
        depth: 0.0,
        qx: 0.0,
        qz: 0.0,
    };

    fn at(flow: &[f32], cell: usize) -> Self {
        Self {
            depth: flow[3 * cell] as f64,
            qx: flow[3 * cell + 1] as f64,
            qz: flow[3 * cell + 2] as f64,
        }
    }

    fn speed_squared(self) -> f64 {
        if self.depth <= DRY {
            return 0.0;
        }
        (self.qx * self.qx + self.qz * self.qz) / (self.depth * self.depth)
    }

    fn discharge(self, along_x: bool) -> f64 {
        if self.depth <= DRY {
            return 0.0;
        }
        if along_x { self.qx } else { self.qz }
    }
}

struct Bed<'a> {
    available: &'a mut [f64],
    delta: &'a mut [f64],
}

impl Bed<'_> {
    fn take(&mut self, vertices: [usize; 4], demand: f64) -> f64 {
        let mut amount = demand;
        for k in 0..4 {
            amount = amount.min(self.available[vertices[k]] / WEIGHTS[k]);
        }
        for k in 0..4 {
            let v = vertices[k];
            let cut = (amount * WEIGHTS[k]).min(self.available[v]);
            self.available[v] -= cut;
            self.delta[v] -= cut;
        }
        amount
    }

    fn put(&mut self, vertices: [usize; 4], volume: f64) {
        for k in 0..4 {
            let v = vertices[k];
            let fill = volume * WEIGHTS[k];
            self.available[v] += fill;
            self.delta[v] += fill;
        }
    }
}

// Gauss-Legendre integration of Van Rijn's Rouse-profile option from a to h.
fn depth_mean(reference: f64, ratio: f64, exponent: f64) -> f64 {
    let mut sum = reference * ratio;
    let relative = ratio / (1.0 - ratio);
    let mut start = ratio;
    while start < 1.0 {
        // Log-spaced panels resolve the changing concentration near the bed.
        let end = (2.0 * start).min(1.0);
        let radius = (end - start) * 0.5;
        let mid = start + radius;
        for (x, weight) in [
            (0.1834346424956498, 0.3626837833783620),
            (0.5255324099163290, 0.3137066458778873),
            (0.7966664774136267, 0.2223810344533745),
            (0.9602898564975363, 0.1012285362903763),
        ] {
            let low = mid - radius * x;
            let high = mid + radius * x;
            sum += radius
                * weight
                * reference
                * (pow(relative * (1.0 - low) / low, exponent)
                    + pow(relative * (1.0 - high) / high, exponent));
        }
        start = end;
    }
    sum
}

fn speeds_squared(flow: &[f32], speed: &mut [f64]) {
    let n = speed.len();
    for i in (0..n & !1).step_by(2) {
        let a = Water::at(flow, i);
        let b = Water::at(flow, i + 1);
        let h = f64x2(a.depth.max(DRY), b.depth.max(DRY));
        let x = f64x2(a.discharge(true), b.discharge(true));
        let z = f64x2(a.discharge(false), b.discharge(false));
        let q = f64x2_add(f64x2_mul(x, x), f64x2_mul(z, z));
        // A full pair fits before the scalar tail.
        unsafe {
            v128_store(
                speed.as_mut_ptr().add(i).cast(),
                f64x2_div(q, f64x2_mul(h, h)),
            );
        }
    }
    if n % 2 != 0 {
        speed[n - 1] = Water::at(flow, n - 1).speed_squared();
    }
}

fn donor(q: f64, left: Option<usize>, right: Option<usize>) -> (Option<usize>, Option<usize>) {
    if q >= 0.0 {
        (left, right)
    } else {
        (right, left)
    }
}

fn directed_capacity(capacity: f64, flow: Water, speed: f64, along_x: bool) -> f64 {
    if speed == 0.0 {
        0.0
    } else {
        capacity * flow.discharge(along_x) / (flow.depth * speed)
    }
}

fn directional_average(a: f64, b: f64, boundary: bool) -> f64 {
    if boundary { a + b } else { (a + b) * 0.5 }
}

/// Advances bed and suspended solid volume. The bridge validates the pointers and every grid size before calling Wasm.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sediment_step(
    state_ptr: *mut f64,
    available_ptr: *mut f64,
    delta_ptr: *mut f64,
    area_ptr: *const f64,
    flow_ptr: *const f32,
    cohesion_ptr: *const f64,
    scratch_ptr: *mut f64,
    budget_ptr: *mut f64,
    material_ptr: *const f64,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    open: u32,
    dt: f64,
) {
    let grid = Grid { nx, nz, dx, dz };
    let n = grid.count();
    let nv = (nx + 1) * (nz + 1);
    let nf = (nx + 1) * nz + nx * (nz + 1);
    let state = unsafe { slice::from_raw_parts_mut(state_ptr, PLANES * n) };
    let vertices = unsafe { slice::from_raw_parts_mut(available_ptr, nv) };
    let delta = unsafe { slice::from_raw_parts_mut(delta_ptr, nv) };
    let area = unsafe { slice::from_raw_parts(area_ptr, nv) };
    let flow = unsafe { slice::from_raw_parts(flow_ptr, n * 3) };
    let cohesion = unsafe { slice::from_raw_parts(cohesion_ptr, n) };
    let scratch = unsafe { slice::from_raw_parts_mut(scratch_ptr, n * 4 + nf * 2) };
    let budget = unsafe { slice::from_raw_parts_mut(budget_ptr, 3) };
    let m = unsafe { slice::from_raw_parts(material_ptr, 10) };
    let rho = m[0];
    let grain_density = m[1];
    let grain = m[2];
    let porosity = m[3];
    let gravity = m[4];
    let roughness = m[5];
    let settling = m[6];
    let dimensionless_grain = m[7];
    let critical_shields = m[8];
    let bank_erodibility = m[9];
    delta.fill(0.0);
    let mut bed = Bed {
        available: vertices,
        delta,
    };
    let (speed, rest) = scratch.split_at_mut(n);
    let (suspended_out, rest) = rest.split_at_mut(n);
    let (suspended_change, rest) = rest.split_at_mut(n);
    let (capacity, faces) = rest.split_at_mut(n);
    let (suspended_faces, bed_faces) = faces.split_at_mut(nf);
    suspended_out.fill(0.0);
    suspended_change.fill(0.0);
    speeds_squared(flow, speed);

    let cell_area = dx * dz;
    let submerged_acceleration = (grain_density / rho - 1.0) * gravity;
    let transport_scale = sqrt(submerged_acceleration * grain * grain * grain);
    let threshold = (grain_density - rho) * gravity * grain;
    let shear_gain = rho * gravity * roughness * roughness;
    let mut speed_sum = 0.0;
    let mut wet_count = 0;
    for i in 0..n {
        let w = Water::at(flow, i);
        let column = state[SOLID * n + i];
        let mut c = 0.0;
        let mut tau = 0.0;
        let mut load = 0.0;
        if w.depth > DRY {
            let water_volume = w.depth * cell_area;
            tau = shear_gain * speed[i] / pow(w.depth, 1.0 / 3.0);
            let shields = tau / threshold;
            let critical = critical_shields + cohesion[i] / threshold;
            let excess = (shields - critical).max(0.0);
            load = 3.97 * excess * sqrt(excess) * transport_scale;
            let reference_height = (0.01 * w.depth).max(grain);
            let reference = if excess > 0.0 && reference_height < w.depth * 0.5 {
                let stage = excess / critical;
                let value = 0.015 * grain / reference_height * stage * sqrt(stage)
                    / pow(dimensionless_grain, 0.3);
                let rouse = settling / (0.4 * sqrt(tau / rho));
                depth_mean(value.min(1.0 - porosity), reference_height / w.depth, rouse)
            } else {
                0.0
            };
            let desired =
                (reference * water_volume - column) * (1.0 - exp(-settling * dt / w.depth));
            let exchange = if desired >= 0.0 {
                bed.take(grid.vertices(i), desired)
            } else {
                bed.put(grid.vertices(i), -desired);
                desired
            };
            let held = (column + exchange)
                .max(0.0)
                .min(water_volume * (1.0 - porosity));
            bed.put(grid.vertices(i), (column + exchange - held).max(0.0));
            state[SOLID * n + i] = held;
            c = held / water_volume;
            speed_sum += sqrt(speed[i]);
            wet_count += 1;
        } else {
            bed.put(grid.vertices(i), column);
            state[SOLID * n + i] = 0.0;
        }
        state[CONCENTRATION * n + i] = c;
        state[SHEAR * n + i] = tau;
        state[BEDLOAD * n + i] = load;
        capacity[i] = load;
    }
    // Keep scalar speed magnitudes for the signed bedload projection and the bank perturbation.
    let pair_end = n & !1;
    for i in (0..pair_end).step_by(2) {
        let x = f64x2_sqrt(f64x2(speed[i], speed[i + 1]));
        unsafe {
            v128_store(speed.as_mut_ptr().add(i).cast(), x);
        }
    }
    if pair_end < n {
        speed[pair_end] = sqrt(speed[pair_end]);
    }

    grid.faces(|face, left, right, along_x, length, side| {
        let exterior = side != 0;
        if exterior && open & side == 0 {
            suspended_faces[face] = 0.0;
            bed_faces[face] = 0.0;
            return;
        }
        let a = left.map_or(Water::DRY_CELL, |i| Water::at(flow, i));
        let b = right.map_or(Water::DRY_CELL, |i| Water::at(flow, i));
        let q_water = directional_average(a.discharge(along_x), b.discharge(along_x), exterior);
        let (giver, _) = donor(q_water, left, right);
        let suspended = giver.map_or(0.0, |i| {
            q_water * state[CONCENTRATION * n + i] * length * dt
        });
        if let Some(i) = giver {
            suspended_out[i] += suspended.abs();
        }
        let qa = left.map_or(0.0, |i| {
            directed_capacity(capacity[i], a, speed[i], along_x)
        });
        let qb = right.map_or(0.0, |i| {
            directed_capacity(capacity[i], b, speed[i], along_x)
        });
        suspended_faces[face] = suspended;
        bed_faces[face] = directional_average(qa, qb, exterior) * length * dt;
    });

    let mean_speed = if wet_count > 0 {
        speed_sum / wet_count as f64
    } else {
        0.0
    };
    grid.faces(|face, left, right, _, length, _| {
        let proposed = suspended_faces[face];
        let (from, to) = donor(proposed, left, right);
        if proposed != 0.0 {
            if let Some(from) = from {
                let scale = (state[SOLID * n + from] / suspended_out[from]).min(1.0);
                let moved = proposed.abs() * scale;
                suspended_change[from] -= moved;
                if let Some(to) = to {
                    suspended_change[to] += moved;
                } else {
                    budget[0] += moved;
                }
            }
        }
        let proposed = bed_faces[face];
        let (from, to) = donor(proposed, left, right);
        if proposed != 0.0 {
            if let Some(from) = from {
                let moved = bed.take(grid.vertices(from), proposed.abs());
                if let Some(to) = to {
                    bed.put(grid.vertices(to), moved);
                } else {
                    budget[1] += moved;
                }
            }
        }
        if bank_erodibility > 0.0 {
            if let (Some(a), Some(b)) = (left, right) {
                let wa = Water::at(flow, a);
                let wb = Water::at(flow, b);
                if (wa.depth > DRY) != (wb.depth > DRY) {
                    let (wet, dry, depth) = if wa.depth > DRY {
                        (a, b, wa.depth)
                    } else {
                        (b, a, wb.depth)
                    };
                    let offset = bank_erodibility * (speed[wet] - mean_speed);
                    let (from, to) = if offset > 0.0 { (dry, wet) } else { (wet, dry) };
                    let shear = state[SHEAR * n + wet];
                    let mobilised = if shear > 0.0 {
                        (1.0 - cohesion[from] / shear).max(0.0)
                    } else {
                        0.0
                    };
                    let moved = bed.take(
                        grid.vertices(from),
                        offset.abs() * depth * length * dt * (1.0 - porosity) * mobilised,
                    );
                    bed.put(grid.vertices(to), moved);
                    budget[2] += moved;
                }
            }
        }
    });

    for i in 0..n {
        let volume = (state[SOLID * n + i] + suspended_change[i]).max(0.0);
        let water_volume = Water::at(flow, i).depth * cell_area;
        let retained = if water_volume > DRY * cell_area {
            volume.min(water_volume * (1.0 - porosity))
        } else {
            0.0
        };
        bed.put(grid.vertices(i), volume - retained);
        state[SOLID * n + i] = retained;
        state[CONCENTRATION * n + i] = if retained > 0.0 {
            retained * grain_density / water_volume
        } else {
            0.0
        };
    }
    for i in 0..nv {
        bed.delta[i] /= area[i] * (1.0 - porosity);
    }
}
