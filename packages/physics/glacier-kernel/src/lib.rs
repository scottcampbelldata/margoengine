//! Grounded shallow ice, column fracture and surface drainage in world-owned memory.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::{arch::wasm32::*, slice};
use margoengine_physics_kernel_common::pinned::pow;

struct HostMemory;

// Only the shared crate's allocating APIs need an allocator. This module uses world regions.
unsafe impl core::alloc::GlobalAlloc for HostMemory {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }

    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

#[global_allocator]
static NO_HEAP: HostMemory = HostMemory;

#[panic_handler]
fn trap(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

const GROUND: f64 = 0.0;
const WATER: f64 = 1.0;
const DROP: f64 = 2.0;
const OUTLET: u32 = u32::MAX;

struct Grid {
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
}

impl Grid {
    fn neighbor(&self, i: usize, x: i32, z: i32) -> Option<usize> {
        let x = (i % self.nx).checked_add_signed(x as isize)?;
        let z = (i / self.nx).checked_add_signed(z as isize)?;
        (x < self.nx && z < self.nz).then_some(z * self.nx + x)
    }

    fn cross(&self, i: usize, values: &[f64], boundary: &[f64], x: i32, z: i32) -> f64 {
        let lower = self.neighbor(i, -x, -z).filter(|&j| boundary[j] == GROUND);
        let upper = self.neighbor(i, x, z).filter(|&j| boundary[j] == GROUND);
        let distance = if x != 0 { self.dx } else { self.dz };
        match (lower, upper) {
            (Some(lo), Some(hi)) => (values[hi] - values[lo]) / (2.0 * distance),
            (Some(lo), None) => (values[i] - values[lo]) / distance,
            (None, Some(hi)) => (values[hi] - values[i]) / distance,
            (None, None) => 0.0,
        }
    }

    fn faces(&self, mut visit: impl FnMut(usize, usize, bool)) {
        for z in 0..self.nz {
            for x in 0..self.nx {
                let i = z * self.nx + x;
                if x + 1 < self.nx {
                    visit(i, i + 1, true);
                }
                if z + 1 < self.nz {
                    visit(i, i + self.nx, false);
                }
            }
        }
    }
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut sum = f64x2_splat(0.0);
    for i in (0..a.len() / 2 * 2).step_by(2) {
        // Each vector has two words in these equally sized work columns.
        let left = unsafe { v128_load(a.as_ptr().add(i).cast()) };
        let right = unsafe { v128_load(b.as_ptr().add(i).cast()) };
        sum = f64x2_add(sum, f64x2_mul(left, right));
    }
    let tail = if a.len() % 2 != 0 {
        a[a.len() - 1] * b[b.len() - 1]
    } else {
        0.0
    };
    (f64x2_extract_lane::<0>(sum) + f64x2_extract_lane::<1>(sum)) + tail
}

struct Weights<'a> {
    x: &'a [f64],
    z: &'a [f64],
}

impl Weights<'_> {
    fn at(&self, i: usize, x: bool) -> f64 {
        if x { self.x[i] } else { self.z[i] }
    }

    fn laplacian(&self, grid: &Grid, values: &[f64], result: &mut [f64], sign: f64) {
        grid.faces(|i, j, x| {
            let difference = sign * self.at(i, x) * (values[i] - values[j]);
            result[i] += difference;
            result[j] -= difference;
        });
    }
}

/// Diagonal-preconditioned conjugate gradients of the identity plus the symmetric face Laplacian.
fn solve(
    grid: &Grid,
    weights: &Weights<'_>,
    surface: &[f64],
    solution: &mut [f64],
    residual: &mut [f64],
    direction: &mut [f64],
    product: &mut [f64],
    diagonal: &mut [f64],
) -> bool {
    solution.fill(0.0);
    residual.fill(0.0);
    weights.laplacian(grid, surface, residual, -1.0);
    diagonal.fill(1.0);
    grid.faces(|i, j, x| {
        let coefficient = weights.at(i, x);
        diagonal[i] += coefficient;
        diagonal[j] += coefficient;
    });
    for i in 0..surface.len() {
        direction[i] = residual[i] / diagonal[i];
    }
    let rhs_norm2 = dot(residual, residual);
    if !rhs_norm2.is_finite() {
        return false;
    }
    if rhs_norm2 == 0.0 {
        return true;
    }
    let mut energy = dot(residual, direction);
    let tolerance2 = f64::EPSILON * rhs_norm2;
    // Exact arithmetic terminates in at most n directions. The second sweep permits roundoff on stiff grids.
    for _ in 0..surface.len().saturating_mul(2) {
        product.copy_from_slice(direction);
        weights.laplacian(grid, direction, product, 1.0);
        let alpha = energy / dot(direction, product);
        if !alpha.is_finite() {
            return false;
        }
        for i in 0..surface.len() {
            solution[i] += alpha * direction[i];
            residual[i] -= alpha * product[i];
        }
        if dot(residual, residual) <= tolerance2 {
            return true;
        }
        for i in 0..surface.len() {
            product[i] = residual[i] / diagonal[i];
        }
        let next = dot(residual, product);
        let beta = next / energy;
        for i in 0..surface.len() {
            direction[i] = product[i] + beta * direction[i];
        }
        energy = next;
    }
    false
}

/// Derives the 2-D face diffusivities with H averaged across a face and transverse slopes averaged from both cells.
fn diffuse(
    grid: &Grid,
    h: &mut [f64],
    bed: &[f64],
    boundary: &[f64],
    scratch: &mut [f64],
    coefficient: f64,
    dt: f64,
) -> bool {
    let n = h.len();
    let (surface, scratch) = scratch.split_at_mut(n);
    let (gx, scratch) = scratch.split_at_mut(n);
    let (gz, scratch) = scratch.split_at_mut(n);
    let (wx, scratch) = scratch.split_at_mut(n);
    let (wz, scratch) = scratch.split_at_mut(n);
    let (increment, scratch) = scratch.split_at_mut(n);
    let (residual, scratch) = scratch.split_at_mut(n);
    let (direction, scratch) = scratch.split_at_mut(n);
    let (product, scratch) = scratch.split_at_mut(n);
    let (diagonal, scratch) = scratch.split_at_mut(n);
    let (outgoing, incoming) = scratch.split_at_mut(n);
    for i in 0..n {
        surface[i] = bed[i] + h[i];
    }
    for i in 0..n {
        gx[i] = grid.cross(i, surface, boundary, 1, 0);
        gz[i] = grid.cross(i, surface, boundary, 0, 1);
    }
    wx.fill(0.0);
    wz.fill(0.0);
    grid.faces(|i, j, x| {
        if boundary[i] != GROUND || boundary[j] != GROUND {
            return;
        }
        let drop = surface[i] - surface[j];
        if (drop >= 0.0 && h[i] == 0.0) || (drop <= 0.0 && h[j] == 0.0) {
            return;
        }
        let (size, tangent, result) = if x {
            (grid.dx, &*gz, &mut *wx)
        } else {
            (grid.dz, &*gx, &mut *wz)
        };
        let normal = drop / size;
        let other = 0.5 * (tangent[i] + tangent[j]);
        let thickness = 0.5 * (h[i] + h[j]);
        let h2 = thickness * thickness;
        result[i] = dt * coefficient * (h2 * h2 * thickness) * (normal * normal + other * other)
            / (size * size);
    });
    let weights = Weights { x: wx, z: wz };
    if !solve(
        grid, &weights, surface, increment, residual, direction, product, diagonal,
    ) {
        return false;
    }

    // Use equal-and-opposite face transfers. Limit each donor's outgoing sum to its own ice.
    // This also excludes spurious transport from a dry cell if an implicit slope reverses.
    outgoing.fill(0.0);
    incoming.fill(0.0);
    let transfer = |i: usize, j: usize, x| {
        weights.at(i, x) * ((surface[i] - surface[j]) + (increment[i] - increment[j]))
    };
    grid.faces(|i, j, x| {
        let amount = transfer(i, j, x);
        if amount >= 0.0 {
            outgoing[i] += amount;
        } else {
            outgoing[j] -= amount;
        }
    });
    for i in 0..n {
        residual[i] = if outgoing[i] > h[i] {
            h[i] / outgoing[i]
        } else {
            1.0
        };
        h[i] -= outgoing[i].min(h[i]);
    }
    grid.faces(|i, j, x| {
        let amount = transfer(i, j, x);
        if amount >= 0.0 {
            incoming[j] += amount * residual[i];
        } else {
            incoming[i] -= amount * residual[j];
        }
    });
    for i in 0..n {
        h[i] += incoming[i];
    }
    h.iter().all(|value| value.is_finite())
}

struct Material {
    gravity: f64,
    softness: f64,
    ice: f64,
    water: f64,
}

fn velocity(
    grid: &Grid,
    h: &[f64],
    bed: &[f64],
    boundary: &[f64],
    material: &Material,
    surface: &mut [f64],
    ux: &mut [f64],
    uz: &mut [f64],
) {
    let stress = material.ice * material.gravity;
    let speed = (2.0 / 5.0) * material.softness * stress * stress * stress;
    for i in 0..h.len() {
        surface[i] = bed[i] + h[i];
    }
    for i in 0..h.len() {
        let gx = grid.cross(i, surface, boundary, 1, 0);
        let gz = grid.cross(i, surface, boundary, 0, 1);
        let h2 = h[i] * h[i];
        let factor = -speed * h2 * h2 * (gx * gx + gz * gz);
        ux[i] = if gx == 0.0 { 0.0 } else { factor * gx };
        uz[i] = if gz == 0.0 { 0.0 } else { factor * gz };
    }
}

fn fracture(
    grid: &Grid,
    h: &mut [f64],
    bed: &[f64],
    boundary: &[f64],
    water_depth: &[f64],
    material: &Material,
    sea: f64,
    dt: f64,
    ux: &[f64],
    uz: &[f64],
    cracks: &mut [f64],
    calving: &mut [f64],
    falls: &mut [f64],
) {
    let area = grid.dx * grid.dz;
    let ratio = material.water / material.ice;
    for i in 0..h.len() {
        let u = ux[i];
        let v = uz[i];
        let speed2 = u * u + v * v;
        let depth = if h[i] > 0.0 && speed2 > 0.0 {
            let dux = grid.cross(i, ux, boundary, 1, 0);
            let duz = grid.cross(i, ux, boundary, 0, 1);
            let dvx = grid.cross(i, uz, boundary, 1, 0);
            let dvz = grid.cross(i, uz, boundary, 0, 1);
            let strain = ((u * u) * dux + (u * v) * (duz + dvx) + (v * v) * dvz) / speed2;
            if strain > 0.0 {
                // The n=3 free-surface velocity is 5/4 of the depth-averaged velocity.
                let surface_strain = 1.25 * strain;
                2.0 / (material.ice * material.gravity)
                    * pow(surface_strain / material.softness, 1.0 / 3.0)
                    + ratio * water_depth[i]
            } else {
                0.0
            }
        } else {
            0.0
        };
        cracks[i] = depth.min(h[i]);
        if dt == 0.0 || h[i] == 0.0 {
            continue;
        }
        let mut marine = false;
        let mut drop = false;
        for (x, z) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            if let Some(j) = grid.neighbor(i, x, z) {
                marine |= boundary[j] == WATER && bed[j] < sea && bed[i] < sea;
                drop |= boundary[j] == DROP && bed[j] < bed[i];
            }
        }
        if marine && (h[i] <= ratio * (sea - bed[i]) || depth >= bed[i] + h[i] - sea) {
            calving[i] = h[i] * area;
            h[i] = 0.0;
        } else if drop && depth >= h[i] {
            falls[i] = h[i] * area;
            h[i] = 0.0;
        }
    }
}

/// Steepest-descending D8 links, then an upstream-first sweep. Every cell ends at a unique outlet.
fn route(grid: &Grid, height: &[f64], discharge: &mut [f64], graph: &mut [u32]) {
    let n = height.len();
    let (links, rest) = graph.split_at_mut(n);
    let (degrees, queue) = rest.split_at_mut(n);
    let diagonal = sqrt(grid.dx * grid.dx + grid.dz * grid.dz);
    degrees.fill(0);
    for i in 0..n {
        let mut slope = 0.0;
        let mut downstream = OUTLET;
        for z in -1..=1 {
            for x in -1..=1 {
                if x == 0 && z == 0 {
                    continue;
                }
                if let Some(j) = grid.neighbor(i, x, z) {
                    let length = if x == 0 {
                        grid.dz
                    } else if z == 0 {
                        grid.dx
                    } else {
                        diagonal
                    };
                    let gradient = (height[i] - height[j]) / length;
                    if gradient > slope {
                        slope = gradient;
                        downstream = j as u32;
                    }
                }
            }
        }
        links[i] = downstream;
        if downstream != OUTLET {
            degrees[downstream as usize] += 1;
        }
    }
    let mut tail = 0;
    for (i, &incoming) in degrees.iter().enumerate() {
        if incoming == 0 {
            queue[tail] = i as u32;
            tail += 1;
        }
    }
    let mut head = 0;
    while head < tail {
        let i = queue[head] as usize;
        head += 1;
        let to = links[i];
        if to != OUTLET {
            let j = to as usize;
            discharge[j] += discharge[i];
            discharge[i] = 0.0;
            degrees[j] -= 1;
            if degrees[j] == 0 {
                queue[tail] = to;
                tail += 1;
            }
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn glacier_step(
    state: *mut f64,
    data: *const f64,
    work: *mut f64,
    drainage: *mut u32,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    gravity: f64,
    softness: f64,
    ice_density: f64,
    water_density: f64,
    sea_level: f64,
    seconds: f64,
    dt: f64,
) -> u32 {
    let n = nx * nz;
    let grid = Grid { nx, nz, dx, dz };
    let material = Material {
        gravity,
        softness,
        ice: ice_density,
        water: water_density,
    };
    // The host owns and validates these distinct allocations before calling into the module.
    let (state, budget) =
        unsafe { slice::from_raw_parts_mut(state, 7 * n + 4) }.split_at_mut(7 * n);
    let data = unsafe { slice::from_raw_parts(data, 5 * n) };
    let work = unsafe { slice::from_raw_parts_mut(work, 12 * n) };
    let graph = unsafe { slice::from_raw_parts_mut(drainage, 3 * n) };
    let (h, state) = state.split_at_mut(n);
    let (cracks, state) = state.split_at_mut(n);
    let (discharge, state) = state.split_at_mut(n);
    let (calving, state) = state.split_at_mut(n);
    let (falls, state) = state.split_at_mut(n);
    let (ux, uz) = state.split_at_mut(n);
    let (bed, data) = data.split_at(n);
    let (snow, data) = data.split_at(n);
    let (melt, data) = data.split_at(n);
    let (water, boundary) = data.split_at(n);

    let area = dx * dz;
    let stress = ice_density * gravity;
    let coefficient = (2.0 / 5.0) * softness * stress * stress * stress;
    calving.fill(0.0);
    falls.fill(0.0);
    for i in 0..n {
        let added = snow[i] * seconds;
        let available = h[i] + added;
        let melted = (melt[i] * seconds).min(available);
        h[i] = available - melted;
        budget[0] += added * area;
        budget[1] += melted * area;
        discharge[i] = if dt > 0.0 {
            (ice_density / water_density) * (melted * area) / dt
        } else {
            0.0
        };
    }
    if seconds > 0.0 && !diffuse(&grid, h, bed, boundary, work, coefficient, seconds) {
        return 1;
    }
    let surface = &mut work[..n];
    velocity(&grid, h, bed, boundary, &material, surface, ux, uz);
    fracture(
        &grid, h, bed, boundary, water, &material, sea_level, seconds, ux, uz, cracks, calving,
        falls,
    );
    if seconds > 0.0 {
        for i in 0..n {
            budget[2] += calving[i];
            budget[3] += falls[i];
            if h[i] == 0.0 {
                ux[i] = 0.0;
                uz[i] = 0.0;
            }
            surface[i] = if boundary[i] == WATER {
                sea_level
            } else {
                bed[i] + h[i]
            };
        }
        if discharge.iter().any(|value| *value > 0.0) {
            route(&grid, surface, discharge, graph);
        }
    }
    if state_finite(
        h, cracks, discharge, calving, falls, ux, uz, budget, surface,
    ) {
        0
    } else {
        2
    }
}

fn state_finite(
    h: &[f64],
    cracks: &[f64],
    discharge: &[f64],
    calving: &[f64],
    falls: &[f64],
    ux: &[f64],
    uz: &[f64],
    budget: &[f64],
    surface: &[f64],
) -> bool {
    [
        h, cracks, discharge, calving, falls, ux, uz, budget, surface,
    ]
    .into_iter()
    .flatten()
    .all(|value| value.is_finite())
}
