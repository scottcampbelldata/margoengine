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

/// Greve's shallow-ice diffusivity with n=3, averaged at the same faces as in the scalar step.
struct Face {
    drop: f64,
    tangent: f64,
    thickness: f64,
    size: f64,
}

impl Face {
    fn get(
        i: usize,
        j: usize,
        size: f64,
        terrain: &FlowTerrain<'_>,
        tangent: &[f64],
    ) -> Option<Self> {
        if terrain.boundary[i] != GROUND || terrain.boundary[j] != GROUND {
            return None;
        }
        let drop = terrain.surface[i] - terrain.surface[j];
        let h = terrain.h;
        if (drop >= 0.0 && h[i] == 0.0) || (drop <= 0.0 && h[j] == 0.0) {
            return None;
        }
        Some(Self {
            drop,
            tangent: 0.5 * (tangent[i] + tangent[j]),
            thickness: 0.5 * (h[i] + h[j]),
            size,
        })
    }

    fn weight(&self, scale: f64) -> f64 {
        let normal = self.drop / self.size;
        let h2 = self.thickness * self.thickness;
        scale * (h2 * h2 * self.thickness) * (normal * normal + self.tangent * self.tangent)
            / (self.size * self.size)
    }
}

fn paired_weights(x: &Face, z: &Face, scale: f64) -> (f64, f64) {
    let size = f64x2(x.size, z.size);
    let normal = f64x2_div(f64x2(x.drop, z.drop), size);
    let tangent = f64x2(x.tangent, z.tangent);
    let h = f64x2(x.thickness, z.thickness);
    let h2 = f64x2_mul(h, h);
    let h5 = f64x2_mul(f64x2_mul(h2, h2), h);
    let gradient2 = f64x2_add(f64x2_mul(normal, normal), f64x2_mul(tangent, tangent));
    let weights = f64x2_div(
        f64x2_mul(f64x2_mul(f64x2_splat(scale), h5), gradient2),
        f64x2_mul(size, size),
    );
    (
        f64x2_extract_lane::<0>(weights),
        f64x2_extract_lane::<1>(weights),
    )
}

struct FlowTerrain<'a> {
    h: &'a [f64],
    surface: &'a [f64],
    boundary: &'a [f64],
}

fn diffuse(grid: &Grid, h: &mut [f64], scratch: &mut [f64]) -> bool {
    let n = h.len();
    let (surface, scratch) = scratch.split_at_mut(n);
    let (_, scratch) = scratch.split_at_mut(2 * n); // frozen transverse gradients
    let (wx, scratch) = scratch.split_at_mut(n);
    let (wz, scratch) = scratch.split_at_mut(n);
    let (increment, scratch) = scratch.split_at_mut(n);
    let (residual, scratch) = scratch.split_at_mut(n);
    let (direction, scratch) = scratch.split_at_mut(n);
    let (product, scratch) = scratch.split_at_mut(n);
    let (diagonal, scratch) = scratch.split_at_mut(n);
    let (outgoing, incoming) = scratch.split_at_mut(n);
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
    start: usize,
) -> f64 {
    let area = grid.dx * grid.dz;
    let ratio = material.water / material.ice;
    let mut roots = 0.0;
    for row in 0..h.len() {
        let i = start + row;
        let u = ux[i];
        let v = uz[i];
        let speed2 = u * u + v * v;
        let depth = if h[row] > 0.0 && speed2 > 0.0 {
            let dux = grid.cross(i, ux, boundary, 1, 0);
            let duz = grid.cross(i, ux, boundary, 0, 1);
            let dvx = grid.cross(i, uz, boundary, 1, 0);
            let dvz = grid.cross(i, uz, boundary, 0, 1);
            let strain = ((u * u) * dux + (u * v) * (duz + dvx) + (v * v) * dvz) / speed2;
            if strain > 0.0 {
                roots += 1.0;
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
        cracks[row] = depth.min(h[row]);
        if dt == 0.0 || h[row] == 0.0 {
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
        if marine && (h[row] <= ratio * (sea - bed[i]) || depth >= bed[i] + h[row] - sea) {
            calving[row] = h[row] * area;
            h[row] = 0.0;
        } else if drop && depth >= h[row] {
            falls[row] = h[row] * area;
            h[row] = 0.0;
        }
    }
    roots
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

#[repr(C)]
#[derive(Default)]
struct Work {
    weights_rows: f64,
    face_weights: f64,
    paired_face_weights: f64,
    fracture_rows: f64,
    crevasse_roots: f64,
}

#[repr(C)]
struct Job {
    state: *mut f64,
    data: *const f64,
    work: *mut f64,
    drainage: *mut u32,
    nx: usize,
    nz: usize,
    receipt: *mut Work,
    _padding: u32,
    dx: f64,
    dz: f64,
    gravity: f64,
    softness: f64,
    ice_density: f64,
    water_density: f64,
    sea_level: f64,
    seconds: f64,
    dt: f64,
}

const _: [(); 104] = [(); size_of::<Job>()];

impl Job {
    fn count(&self) -> Option<usize> {
        let count = self.nx.checked_mul(self.nz)?;
        (count > 0 && count <= isize::MAX as usize / (12 * size_of::<f64>())).then_some(count)
    }

    fn grid(&self) -> Grid {
        Grid {
            nx: self.nx,
            nz: self.nz,
            dx: self.dx,
            dz: self.dz,
        }
    }

    fn material(&self) -> Material {
        Material {
            gravity: self.gravity,
            softness: self.softness,
            ice: self.ice_density,
            water: self.water_density,
        }
    }

    unsafe fn prepare(&self, n: usize) {
        let (state, budget) =
            unsafe { slice::from_raw_parts_mut(self.state, 7 * n + 4) }.split_at_mut(7 * n);
        let (h, rest) = state.split_at_mut(n);
        let (discharge, rest) = rest[n..].split_at_mut(n);
        rest[..2 * n].fill(0.0);
        let data = unsafe { slice::from_raw_parts(self.data, 5 * n) };
        let (bed, data) = data.split_at(n);
        let (snow, data) = data.split_at(n);
        let (melt, data) = data.split_at(n);
        let boundary = &data[n..];
        let area = self.dx * self.dz;
        for i in 0..n {
            let added = snow[i] * self.seconds;
            let available = h[i] + added;
            let melted = (melt[i] * self.seconds).min(available);
            h[i] = available - melted;
            budget[0] += added * area;
            budget[1] += melted * area;
            discharge[i] = if self.dt > 0.0 {
                (self.ice_density / self.water_density) * (melted * area) / self.dt
            } else {
                0.0
            };
        }
        if self.seconds > 0.0 {
            let grid = self.grid();
            let (surface, rest) =
                unsafe { slice::from_raw_parts_mut(self.work, 3 * n) }.split_at_mut(n);
            let (gx, gz) = rest.split_at_mut(n);
            for i in 0..n {
                surface[i] = bed[i] + h[i];
            }
            for i in 0..n {
                gx[i] = grid.cross(i, surface, boundary, 1, 0);
                gz[i] = grid.cross(i, surface, boundary, 0, 1);
            }
        }
    }

    unsafe fn weights(&self, n: usize, start: usize, end: usize, part: usize) -> u32 {
        let mut count = Work::default();
        if self.seconds > 0.0 {
            let grid = self.grid();
            let boundary = unsafe { slice::from_raw_parts(self.data.add(4 * n), n) };
            let h = unsafe { slice::from_raw_parts(self.state, n) };
            let (surface, rest) = unsafe { slice::from_raw_parts(self.work, 3 * n) }.split_at(n);
            let (gx, gz) = rest.split_at(n);
            let terrain = FlowTerrain {
                h,
                surface,
                boundary,
            };
            let stride = end - start;
            // Every participant gets only its own face rows in both output planes.
            let wx = unsafe { slice::from_raw_parts_mut(self.work.add(3 * n + start), stride) };
            let wz = unsafe { slice::from_raw_parts_mut(self.work.add(4 * n + start), stride) };
            let stress = self.ice_density * self.gravity;
            let coefficient = (2.0 / 5.0) * self.softness * stress * stress * stress;
            let scale = self.seconds * coefficient;
            count.weights_rows = stride as f64;
            for row in 0..stride {
                let i = start + row;
                let x = grid
                    .neighbor(i, 1, 0)
                    .and_then(|j| Face::get(i, j, grid.dx, &terrain, gz));
                let z = grid
                    .neighbor(i, 0, 1)
                    .and_then(|j| Face::get(i, j, grid.dz, &terrain, gx));
                let (w_x, w_z) = match (x, z) {
                    (Some(x), Some(z)) => {
                        count.face_weights += 2.0;
                        count.paired_face_weights += 2.0;
                        paired_weights(&x, &z, scale)
                    }
                    (Some(x), None) => {
                        count.face_weights += 1.0;
                        (x.weight(scale), 0.0)
                    }
                    (None, Some(z)) => {
                        count.face_weights += 1.0;
                        (0.0, z.weight(scale))
                    }
                    (None, None) => (0.0, 0.0),
                };
                if !w_x.is_finite() || !w_z.is_finite() {
                    return 1;
                }
                wx[row] = w_x;
                wz[row] = w_z;
            }
        }
        if !self.receipt.is_null() {
            unsafe { self.receipt.add(part).write(count) };
        }
        0
    }

    unsafe fn solve(&self, n: usize) -> u32 {
        let grid = self.grid();
        let material = self.material();
        let (h, rest) = unsafe { slice::from_raw_parts_mut(self.state, 7 * n) }.split_at_mut(n);
        let (ux, uz) = rest[4 * n..].split_at_mut(n);
        let data = unsafe { slice::from_raw_parts(self.data, 5 * n) };
        let bed = &data[..n];
        let boundary = &data[4 * n..];
        let work = unsafe { slice::from_raw_parts_mut(self.work, 12 * n) };
        if self.seconds > 0.0 && !diffuse(&grid, h, work) {
            return 1;
        }
        velocity(&grid, h, bed, boundary, &material, &mut work[..n], ux, uz);
        0
    }

    unsafe fn fracture(&self, n: usize, start: usize, end: usize, part: usize) {
        let len = end - start;
        // Fracture reads neighbour velocities and bed only. No worker reads another mutable ice row.
        let h = unsafe { slice::from_raw_parts_mut(self.state.add(start), len) };
        let cracks = unsafe { slice::from_raw_parts_mut(self.state.add(n + start), len) };
        let calving = unsafe { slice::from_raw_parts_mut(self.state.add(3 * n + start), len) };
        let falls = unsafe { slice::from_raw_parts_mut(self.state.add(4 * n + start), len) };
        let ux = unsafe { slice::from_raw_parts(self.state.add(5 * n), n) };
        let uz = unsafe { slice::from_raw_parts(self.state.add(6 * n), n) };
        let data = unsafe { slice::from_raw_parts(self.data, 5 * n) };
        let roots = fracture(
            &self.grid(),
            h,
            &data[..n],
            &data[4 * n..],
            &data[3 * n..4 * n],
            &self.material(),
            self.sea_level,
            self.seconds,
            ux,
            uz,
            cracks,
            calving,
            falls,
            start,
        );
        if !self.receipt.is_null() {
            let receipt = unsafe { &mut *self.receipt.add(part) };
            receipt.fracture_rows = len as f64;
            receipt.crevasse_roots = roots;
        }
    }

    unsafe fn finish(&self, n: usize) -> u32 {
        let grid = self.grid();
        let (state, budget) =
            unsafe { slice::from_raw_parts_mut(self.state, 7 * n + 4) }.split_at_mut(7 * n);
        let (h, state) = state.split_at_mut(n);
        let (cracks, state) = state.split_at_mut(n);
        let (discharge, state) = state.split_at_mut(n);
        let (calving, state) = state.split_at_mut(n);
        let (falls, state) = state.split_at_mut(n);
        let (ux, uz) = state.split_at_mut(n);
        let bed = unsafe { slice::from_raw_parts(self.data, n) };
        let boundary = unsafe { slice::from_raw_parts(self.data.add(4 * n), n) };
        let surface = unsafe { slice::from_raw_parts_mut(self.work, n) };
        let graph = unsafe { slice::from_raw_parts_mut(self.drainage, 3 * n) };
        if self.seconds > 0.0 {
            for i in 0..n {
                budget[2] += calving[i];
                budget[3] += falls[i];
                if h[i] == 0.0 {
                    ux[i] = 0.0;
                    uz[i] = 0.0;
                }
                surface[i] = if boundary[i] == WATER {
                    self.sea_level
                } else {
                    bed[i] + h[i]
                };
            }
            if discharge.iter().any(|value| *value > 0.0) {
                route(&grid, surface, discharge, graph);
            }
        }
        let area = self.dx * self.dz;
        let thickness = h.iter().sum::<f64>();
        let volume = if thickness.is_finite() {
            thickness * area
        } else {
            h.iter().map(|value| value * area).sum()
        };
        if volume.is_finite()
            && state_finite(
                h, cracks, discharge, calving, falls, ux, uz, budget, surface,
            )
        {
            0
        } else {
            2
        }
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn glacier_step(
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
    receipt: *mut Work,
) -> u32 {
    let job = Job {
        state,
        data,
        work,
        drainage,
        nx,
        nz,
        receipt,
        _padding: 0,
        dx,
        dz,
        gravity,
        softness,
        ice_density,
        water_density,
        sea_level,
        seconds,
        dt,
    };
    let Some(n) = job.count() else { return 2 };
    unsafe {
        job.prepare(n);
        let status = job.weights(n, 0, n, 0);
        if status != 0 {
            return status;
        }
        let status = job.solve(n);
        if status != 0 {
            return status;
        }
        job.fracture(n, 0, n, 0);
        job.finish(n)
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn glacier_prepare(job: &Job) -> u32 {
    let Some(n) = job.count() else { return 2 };
    unsafe { job.prepare(n) };
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn glacier_solve(job: &Job) -> u32 {
    let Some(n) = job.count() else { return 2 };
    unsafe { job.solve(n) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn glacier_thread_phase(job: &Job, stage: u32, part: u32, parts: u32) -> u32 {
    let Some(n) = job.count() else { return 2 };
    let Some(parts) = core::num::NonZeroU64::new(u64::from(parts)) else {
        return 2;
    };
    if u64::from(part) >= parts.get() {
        return 2;
    }
    let start = (n as u64 * u64::from(part) / parts.get()) as usize;
    let end = (n as u64 * u64::from(part + 1) / parts.get()) as usize;
    match stage {
        0 => unsafe { job.weights(n, start, end, part as usize) },
        1 => {
            unsafe { job.fracture(n, start, end, part as usize) };
            0
        }
        _ => 2,
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn glacier_finish(job: &Job) -> u32 {
    let Some(n) = job.count() else { return 2 };
    unsafe { job.finish(n) }
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
