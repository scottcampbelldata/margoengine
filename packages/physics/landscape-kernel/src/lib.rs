#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, v128_load, v128_store,
};
use core::slice;
use margoengine_physics_kernel_common::pinned::{exp, ln, pow};

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

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

// Stable even when only nanometres move during one world tick.
fn decay_loss(x: f64) -> f64 {
    if x < 0.001 {
        x * (1.0 - x * (0.5 - x * (1.0 / 6.0 - x * (1.0 / 24.0 - x * (1.0 / 120.0 - x / 720.0)))))
    } else {
        1.0 - exp(-x)
    }
}

const NEIGHBOURS: [(isize, isize); 8] = [
    (-1, 0),
    (1, 0),
    (0, -1),
    (0, 1),
    (-1, -1),
    (-1, 1),
    (1, -1),
    (1, 1),
];

#[derive(Clone, Copy)]
struct Grid {
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    outlets: u32,
}

impl Grid {
    fn outlet(self, i: usize) -> bool {
        let (x, z) = (i / self.nz, i % self.nz);
        (x == 0 && self.outlets & 1 != 0)
            || (x + 1 == self.nx && self.outlets & 2 != 0)
            || (z == 0 && self.outlets & 4 != 0)
            || (z + 1 == self.nz && self.outlets & 8 != 0)
    }

    fn adjacent(self, i: usize, k: usize) -> Option<usize> {
        let (ox, oz) = NEIGHBOURS[k];
        let x = (i / self.nz).checked_add_signed(ox)?;
        let z = (i % self.nz).checked_add_signed(oz)?;
        (x < self.nx && z < self.nz).then_some(x * self.nz + z)
    }

    fn distances(self) -> [f64; 8] {
        let diagonal = sqrt(self.dx * self.dx + self.dz * self.dz);
        [
            self.dx, self.dx, self.dz, self.dz, diagonal, diagonal, diagonal, diagonal,
        ]
    }

    fn routes(
        self,
        height: &[f64],
        i: usize,
        distances: &[f64; 8],
        visit: impl FnMut(usize, f64, f64),
    ) {
        if self.outlet(i) {
            return;
        }
        let mut visit = visit;
        for (k, &distance) in distances.iter().enumerate() {
            if let Some(j) = self.adjacent(i, k) {
                let slope = (height[i] - height[j]) / distance;
                if slope > 0.0 {
                    visit(j, distance, pow(slope, 1.1));
                }
            }
        }
    }
}

#[repr(C)]
struct Settings {
    incision: f64,
    discharge_exp: f64,
    roughness: f64,
    water_density: f64,
    gravity: f64,
    rock_threshold: f64,
    porosity: f64,
    diffusivity: f64,
    thermal: f64,
    talus: f64,
}

#[repr(C)]
struct Grain {
    diameter: f64,
    relative_density: f64,
    critical_shields: f64,
    parent_fraction: f64,
    travel_length: f64,
}

// A strict downhill graph has no cycles. Count each node's receivers, then release its donors
// when the last receiver has been placed. The resulting order serves both triangular sweeps.
fn receiver_order(grid: Grid, height: &[f64], count: &mut [u32], order: &mut [u32]) {
    let mut tail = 0;
    for i in 0..height.len() {
        let receiver_count = if grid.outlet(i) {
            0
        } else {
            (0..NEIGHBOURS.len())
                .filter_map(|k| grid.adjacent(i, k))
                .filter(|&j| height[j] < height[i])
                .count() as u32
        };
        count[i] = receiver_count;
        if receiver_count == 0 {
            order[tail] = i as u32;
            tail += 1;
        }
    }
    let mut head = 0;
    while head < tail {
        let i = order[head] as usize;
        head += 1;
        for k in 0..NEIGHBOURS.len() {
            if let Some(j) = grid.adjacent(i, k) {
                if height[j] > height[i] && !grid.outlet(j) {
                    count[j] -= 1;
                    if count[j] == 0 {
                        order[tail] = j as u32;
                        tail += 1;
                    }
                }
            }
        }
    }
}

// Initialise two nodes at once. Rainfall and uplift are sampled before the update.
fn initialise(
    uplift: &[f64],
    rain: &[f64],
    area: &[f64],
    delta: &mut [f64],
    discharge: &mut [f64],
    dt: f64,
) {
    let n = uplift.len();
    let pair_end = n & !1;
    unsafe {
        for i in (0..pair_end).step_by(2) {
            let u = v128_load(uplift.as_ptr().add(i).cast());
            let p = v128_load(rain.as_ptr().add(i).cast());
            let a = v128_load(area.as_ptr().add(i).cast());
            v128_store(
                delta.as_mut_ptr().add(i).cast(),
                f64x2_mul(u, f64x2_splat(dt)),
            );
            v128_store(discharge.as_mut_ptr().add(i).cast(), f64x2_mul(p, a));
        }
    }
    if pair_end < n {
        delta[pair_end] = dt * uplift[pair_end];
        discharge[pair_end] = rain[pair_end] * area[pair_end];
    }
}

fn erode_class(
    mobile: &mut [f64],
    class_pos: usize,
    mobile_total: f64,
    removal: f64,
    grain: &Grain,
) -> f64 {
    let alluvium = if mobile_total == 0.0 {
        0.0
    } else {
        mobile[class_pos] * (removal.min(mobile_total) / mobile_total)
    };
    mobile[class_pos] -= alluvium;
    alluvium + (removal - mobile_total).max(0.0) * grain.parent_fraction
}

fn diffuse_pair(
    i: usize,
    j: usize,
    area: &[f64],
    floor: &[f64],
    roots: &[f64],
    height: &mut [f64],
    delta: &mut [f64],
    mobile: &mut [f64],
    grains: &[Grain],
    distance: f64,
    face_width: f64,
    settings: &Settings,
    dt: f64,
) {
    let (up, down) = if height[i] >= height[j] {
        (i, j)
    } else {
        (j, i)
    };
    let n = height.len();
    let mobile_total: f64 = (0..grains.len()).map(|k| mobile[k * n + up]).sum();
    let drop = height[up] - height[down];
    let conductance = face_width / distance * (1.0 / area[up] + 1.0 / area[down]);
    let mut critical = settings.talus * distance;
    if roots[up] > 0.0 && mobile_total > 0.0 && settings.gravity > 0.0 {
        let mass = grains
            .iter()
            .enumerate()
            .map(|(k, grain)| grain.relative_density * mobile[k * n + up])
            .sum::<f64>()
            * settings.water_density
            * (1.0 - settings.porosity);
        critical += roots[up] * area[up] * distance / (mass * settings.gravity);
    }
    let linear = settings.diffusivity;
    let thermal = settings.thermal;
    // While both processes are active, the difference relaxes towards a shifted equilibrium.
    // If it reaches the repose threshold part way through, finish with linear diffusion alone.
    let reduction = if drop > critical && thermal > 0.0 {
        let total = linear + thermal;
        let equilibrium = thermal / total * critical;
        let loss = (drop - equilibrium) * decay_loss(total * conductance * dt);
        if loss <= drop - critical || linear == 0.0 || critical == 0.0 {
            loss
        } else {
            let crossing =
                ln((drop - equilibrium) / (critical - equilibrium)) / (total * conductance);
            drop - critical + critical * decay_loss(linear * conductance * (dt - crossing).max(0.0))
        }
    } else {
        drop * decay_loss(linear * conductance * dt)
    };
    let inverse_area = 1.0 / area[up] + 1.0 / area[down];
    let volume =
        (reduction.max(0.0) / inverse_area).min((height[up] - floor[up]).max(0.0) * area[up]);
    let cut = volume / area[up];
    let fill = volume / area[down];
    height[up] -= cut;
    height[down] += fill;
    delta[up] -= cut;
    delta[down] += fill;
    for (k, grain) in grains.iter().enumerate() {
        let moved = erode_class(mobile, k * n + up, mobile_total, volume, grain);
        mobile[k * n + down] += moved;
    }
}

fn diffuse(
    grid: Grid,
    height: &mut [f64],
    delta: &mut [f64],
    floor: &[f64],
    area: &[f64],
    roots: &[f64],
    mobile: &mut [f64],
    grains: &[Grain],
    settings: &Settings,
    dt: f64,
) {
    if settings.diffusivity == 0.0 && settings.thermal == 0.0 {
        return;
    }
    // Symmetric splitting over four matchings. Within a matching no two faces share vertices.
    for colour in [0, 1, 2, 3, 2, 1, 0] {
        let along_x = colour < 2;
        let duration = if colour == 3 { dt } else { dt * 0.5 };
        let (distance, width) = if along_x {
            (grid.dx, grid.dz)
        } else {
            (grid.dz, grid.dx)
        };
        for i in 0..height.len() {
            let (along, cross, cross_count) = if along_x {
                (i / grid.nz, i % grid.nz, grid.nz)
            } else {
                (i % grid.nz, i / grid.nz, grid.nx)
            };
            if along % 2 != colour % 2 || grid.outlet(i) {
                continue;
            }
            if let Some(j) = grid.adjacent(i, if along_x { 1 } else { 3 }) {
                if !grid.outlet(j) {
                    let face_width = if cross == 0 || cross + 1 == cross_count {
                        width * 0.5
                    } else {
                        width
                    };
                    diffuse_pair(
                        i, j, area, floor, roots, height, delta, mobile, grains, distance,
                        face_width, settings, duration,
                    );
                }
            }
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn landscape_step(
    input_ptr: *const f64,
    constants_ptr: *const f64,
    settings: *const f64,
    grain_ptr: *const f64,
    state_ptr: *mut f64,
    delta_ptr: *mut f64,
    budget_ptr: *mut f64,
    scratch_ptr: *mut f64,
    topology_ptr: *mut u32,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    classes: usize,
    outlets: u32,
    dt: f64,
) {
    let n = nx * nz;
    let grid = Grid {
        nx,
        nz,
        dx,
        dz,
        outlets,
    };
    let distances = grid.distances();
    let settings = unsafe { &*settings.cast::<Settings>() };
    let grains = unsafe { slice::from_raw_parts(grain_ptr.cast::<Grain>(), classes) };
    let input = unsafe { slice::from_raw_parts(input_ptr, n * 4) };
    let constants = unsafe { slice::from_raw_parts(constants_ptr, n * 3) };
    let (height, inputs) = input.split_at(n);
    let (effective_rain, inputs) = inputs.split_at(n);
    let (forced_shear, root) = inputs.split_at(n);
    let (area, constants) = constants.split_at(n);
    let (uplift, floor) = constants.split_at(n);
    let (state, mobile) =
        unsafe { slice::from_raw_parts_mut(state_ptr, n * (3 + classes)) }.split_at_mut(3 * n);
    let (discharge, diagnostics) = state.split_at_mut(n);
    let (incision, sediment_rate) = diagnostics.split_at_mut(n);
    let delta = unsafe { slice::from_raw_parts_mut(delta_ptr, n) };
    let budget = unsafe { slice::from_raw_parts_mut(budget_ptr, 3 + classes) };
    let scratch = unsafe { slice::from_raw_parts_mut(scratch_ptr, n * (6 + classes)) };
    let (base, scratch) = scratch.split_at_mut(n);
    let (potential, scratch) = scratch.split_at_mut(n);
    let (normalisation, scratch) = scratch.split_at_mut(n);
    let (slope, scratch) = scratch.split_at_mut(n);
    let (shear, scratch) = scratch.split_at_mut(n);
    let (length, load) = scratch.split_at_mut(n);
    let (counts, order) = unsafe { slice::from_raw_parts_mut(topology_ptr, 2 * n) }.split_at_mut(n);

    initialise(uplift, effective_rain, area, delta, discharge, dt);
    for i in 0..n {
        if grid.outlet(i) {
            delta[i] = 0.0;
        } else {
            delta[i] = delta[i].max((floor[i] - height[i]).min(0.0));
            budget[1] += delta[i] * area[i];
        }
        base[i] = height[i] + delta[i];
        normalisation[i] = 0.0;
        slope[i] = 0.0;
        length[i] = 0.0;
        grid.routes(height, i, &distances, |j, distance, weight| {
            normalisation[i] += weight;
            slope[i] += weight * (height[i] - height[j]) / distance;
            length[i] += weight * distance;
        });
        if normalisation[i] > 0.0 {
            slope[i] /= normalisation[i];
            length[i] /= normalisation[i];
        }
    }
    receiver_order(grid, height, counts, order);
    for &index in order.iter().rev() {
        let i = index as usize;
        if normalisation[i] > 0.0 {
            let scale = discharge[i] / normalisation[i];
            grid.routes(height, i, &distances, |j, _, weight| {
                discharge[j] += scale * weight
            });
            let width = area[i] / length[i];
            let depth = pow(
                discharge[i] * settings.roughness / (width * sqrt(slope[i])),
                0.6,
            );
            shear[i] = if forced_shear[i] >= 0.0 {
                forced_shear[i]
            } else {
                settings.water_density * settings.gravity * depth * slope[i]
            };
        } else {
            shear[i] = 0.0;
        }
    }

    // Backward Euler for the weighted linear-slope stream-power law. The downstream solved
    // elevations are already available. Write the drop directly to preserve sub-ULP erosion.
    for &index in order.iter() {
        let i = index as usize;
        let mut drop = 0.0;
        if normalisation[i] > 0.0 && shear[i] > settings.rock_threshold + root[i] {
            let coefficient = dt * settings.incision * pow(discharge[i], settings.discharge_exp)
                / normalisation[i];
            let mut diagonal = 1.0;
            grid.routes(height, i, &distances, |j, distance, weight| {
                let a = coefficient * weight / distance;
                diagonal += a;
                drop += a * (base[i] - potential[j]);
            });
            drop = (drop / diagonal)
                .max(0.0)
                .min((base[i] - floor[i]).max(0.0));
        }
        potential[i] = base[i] - drop;
        incision[i] = drop / dt;
    }

    load.fill(0.0);
    sediment_rate.fill(0.0);
    for &index in order.iter().rev() {
        let i = index as usize;
        let removal = incision[i] * dt * area[i];
        let mobile_total = (0..classes).map(|k| mobile[k * n + i]).sum::<f64>();
        // Maintain the change separately so an update smaller than the height ULP reaches the bed.
        delta[i] -= removal / area[i];
        for (k, grain) in grains.iter().enumerate() {
            let p = k * n + i;
            let incoming = load[p] + erode_class(mobile, p, mobile_total, removal, grain);
            if grid.outlet(i) {
                budget[3 + k] += incoming;
                sediment_rate[i] += incoming / dt;
                continue;
            }
            let mut passing = 0.0;
            if normalisation[i] > 0.0 && incoming > 0.0 {
                let scaled_gravity = (grain.relative_density - 1.0) * settings.gravity;
                let shields = (shear[i] - root[i]).max(0.0)
                    / (settings.water_density * scaled_gravity * grain.diameter);
                let excess = (shields - grain.critical_shields).max(0.0);
                let capacity = 3.97
                    * excess
                    * sqrt(excess)
                    * sqrt(scaled_gravity * grain.diameter * grain.diameter * grain.diameter)
                    * (area[i] / length[i])
                    * dt
                    / (1.0 - settings.porosity);
                let remaining = if grain.travel_length > 0.0 {
                    incoming * exp(-length[i] / grain.travel_length)
                } else {
                    incoming
                };
                passing = capacity.min(remaining);
                let scale = passing / normalisation[i];
                grid.routes(height, i, &distances, |j, _, weight| {
                    load[k * n + j] += scale * weight
                });
            }
            let deposited = incoming - passing;
            mobile[p] += deposited;
            delta[i] += deposited / area[i];
            sediment_rate[i] += passing / dt;
        }
        base[i] = height[i] + delta[i];
    }

    diffuse(
        grid, base, delta, floor, area, root, mobile, grains, settings, dt,
    );
    budget[0] += dt;
    budget[2] = mobile.iter().sum();
}
