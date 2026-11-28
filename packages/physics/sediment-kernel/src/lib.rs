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

struct Face {
    left: Option<usize>,
    right: Option<usize>,
    along_x: bool,
    length: f64,
    side: u32,
}

impl Grid {
    fn vertices(self, cell: usize) -> [usize; 4] {
        let stride = self.nz + 1;
        let a = cell / self.nx + (cell % self.nx) * stride;
        [a, a + 1, a + stride, a + stride + 1]
    }

    fn face(self, index: usize) -> Face {
        let x_faces = (self.nx + 1) * self.nz;
        if index < x_faces {
            let columns = self.nx + 1;
            let i = index % columns;
            let j = index / columns;
            Face {
                left: i.checked_sub(1).map(|x| x + j * self.nx),
                right: (i < self.nx).then_some(i + j * self.nx),
                along_x: true,
                length: self.dz,
                side: if i == 0 {
                    1
                } else if i == self.nx {
                    2
                } else {
                    0
                },
            }
        } else {
            let index = index - x_faces;
            let i = index % self.nx;
            let j = index / self.nx;
            Face {
                left: j.checked_sub(1).map(|z| i + z * self.nx),
                right: (j < self.nz).then_some(i + j * self.nx),
                along_x: false,
                length: self.dx,
                side: if j == 0 {
                    4
                } else if j == self.nz {
                    8
                } else {
                    0
                },
            }
        }
    }

    // Ikeda, Parker and Sawai (1981), Eq. 12, compares near-bank tangential
    // speed with a downstream reference. Integrate q_t and h across this
    // face's connected transverse wet band, ending at the first dry cell.
    fn bank_excess(self, flow: &[f32], wet: usize, face_normal_x: bool, wet_on_left: bool) -> f64 {
        let (start, extent, stride) = if face_normal_x {
            (wet % self.nx, self.nx, 1)
        } else {
            (wet / self.nx, self.nz, self.nx)
        };
        let bank = Water::at(flow, wet);
        let q_bank = bank.discharge(!face_normal_x);
        let mut depth_sum = bank.depth;
        let mut discharge_sum = q_bank;
        let mut offset = 1;
        let steps = if wet_on_left {
            start
        } else {
            extent - start - 1
        };
        while offset <= steps {
            let index = if wet_on_left {
                wet - offset * stride
            } else {
                wet + offset * stride
            };
            let center = Water::at(flow, index);
            if center.depth <= DRY {
                break;
            }
            depth_sum += center.depth;
            discharge_sum += center.discharge(!face_normal_x);
            offset += 1;
        }
        if offset == 1 || discharge_sum == 0.0 {
            return 0.0;
        }
        let perturbation = q_bank / bank.depth - discharge_sum / depth_sum;
        if discharge_sum > 0.0 {
            perturbation
        } else {
            -perturbation
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
    fn take(&mut self, vertices: [usize; 4], demand: f64) -> Option<f64> {
        if !(demand >= 0.0 && demand.is_finite()) {
            return None;
        }
        let mut amount = demand;
        for k in 0..4 {
            amount = amount.min(self.available[vertices[k]] / WEIGHTS[k]);
        }
        for k in 0..4 {
            let v = vertices[k];
            let cut = (amount * WEIGHTS[k]).min(self.available[v]);
            self.available[v] -= cut;
            self.delta[v] -= cut;
            if !(self.available[v].is_finite() && self.delta[v].is_finite()) {
                return None;
            }
        }
        Some(amount)
    }

    fn put(&mut self, vertices: [usize; 4], volume: f64) -> bool {
        if !(volume >= 0.0 && volume.is_finite()) {
            return false;
        }
        for k in 0..4 {
            let v = vertices[k];
            let fill = volume * WEIGHTS[k];
            self.available[v] += fill;
            self.delta[v] += fill;
            if !(self.available[v].is_finite() && self.delta[v].is_finite()) {
                return false;
            }
        }
        true
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

#[repr(C)]
struct Material {
    rho: f64,
    grain_density: f64,
    grain: f64,
    porosity: f64,
    gravity: f64,
    roughness: f64,
    settling: f64,
    dimensionless_grain: f64,
    critical_shields: f64,
    bank_erodibility: f64,
}

struct Rates {
    transport_scale: f64,
    threshold: f64,
    shear_gain: f64,
}

impl Material {
    fn rates(&self) -> Option<Rates> {
        if ![
            self.rho,
            self.grain_density,
            self.grain,
            self.porosity,
            self.gravity,
            self.roughness,
            self.settling,
            self.dimensionless_grain,
            self.critical_shields,
            self.bank_erodibility,
        ]
        .iter()
        .all(|&x| x >= 0.0 && x.is_finite())
            || !(self.rho > 0.0
                && self.grain_density > self.rho
                && self.grain > 0.0
                && self.porosity < 1.0
                && self.gravity > 0.0
                && self.dimensionless_grain > 0.0
                && self.critical_shields > 0.0)
        {
            return None;
        }
        let submerged_acceleration = (self.grain_density / self.rho - 1.0) * self.gravity;
        let transport_scale = sqrt(submerged_acceleration * self.grain * self.grain * self.grain);
        let threshold = (self.grain_density - self.rho) * self.gravity * self.grain;
        let shear_gain = self.rho * self.gravity * self.roughness * self.roughness;
        if !(transport_scale > 0.0
            && transport_scale.is_finite()
            && threshold > 0.0
            && threshold.is_finite()
            && shear_gain.is_finite())
        {
            return None;
        }
        Some(Rates {
            transport_scale,
            threshold,
            shear_gain,
        })
    }

    fn column_proposal(
        &self,
        rates: &Rates,
        water: Water,
        column: f64,
        speed_squared: f64,
        cohesion: f64,
        area: f64,
        dt: f64,
    ) -> Option<(f64, f64, f64)> {
        if water.depth <= DRY {
            return Some((0.0, 0.0, 0.0));
        }
        let water_volume = water.depth * area;
        let tau = rates.shear_gain * speed_squared / pow(water.depth, 1.0 / 3.0);
        let shields = tau / rates.threshold;
        let critical = self.critical_shields + cohesion / rates.threshold;
        if !(water_volume > 0.0
            && water_volume.is_finite()
            && tau.is_finite()
            && shields.is_finite()
            && critical.is_finite())
        {
            return None;
        }
        let excess = (shields - critical).max(0.0);
        let load = 3.97 * excess * sqrt(excess) * rates.transport_scale;
        let reference_height = (0.01 * water.depth).max(self.grain);
        let reference = if excess > 0.0 && reference_height < water.depth * 0.5 {
            let stage = excess / critical;
            let value = 0.015 * self.grain / reference_height * stage * sqrt(stage)
                / pow(self.dimensionless_grain, 0.3);
            let rouse = self.settling / (0.4 * sqrt(tau / self.rho));
            let ratio = reference_height / water.depth;
            if !(value.is_finite() && rouse.is_finite() && ratio > 0.0 && ratio < 1.0) {
                return None;
            }
            depth_mean(value.min(1.0 - self.porosity), ratio, rouse)
        } else {
            0.0
        };
        // exp(-infinity) is the analytical fully settled limit of the column.
        let desired =
            (reference * water_volume - column) * (1.0 - exp(-self.settling * dt / water.depth));
        if !(reference.is_finite() && load.is_finite() && desired.is_finite()) {
            return None;
        }
        Some((tau, load, desired))
    }
}

#[derive(Clone, Copy)]
struct Geometry {
    grid: Grid,
    n: usize,
    nv: usize,
    nf: usize,
    cell_area: f64,
}

fn nonnegative(value: f64) -> bool {
    value >= 0.0 && value.is_finite()
}

#[repr(C)]
struct SedimentJob {
    state: *mut f64,
    available: *mut f64,
    delta: *mut f64,
    area: *const f64,
    flow: *const f32,
    cohesion: *const f64,
    scratch: *mut f64,
    budget: *mut f64,
    material: *const Material,
    nx: usize,
    nz: usize,
    open: u32,
    receipts: *mut u32,
    reserved: u32,
    dx: f64,
    dz: f64,
    dt: f64,
}

const _: () = assert!(core::mem::size_of::<SedimentJob>() == 80);
const _: () = assert!(core::mem::size_of::<Material>() == 10 * 8);

impl SedimentJob {
    fn geometry(&self) -> Option<Geometry> {
        let Self {
            nx, nz, dx, dz, dt, ..
        } = *self;
        let n = nx.checked_mul(nz)?;
        let nx_vert = nx.checked_add(1)?;
        let nz_vert = nz.checked_add(1)?;
        let nv = nx_vert.checked_mul(nz_vert)?;
        let nf = nx_vert
            .checked_mul(nz)?
            .checked_add(nx.checked_mul(nz_vert)?)?;
        let words = n.checked_mul(4)?.checked_add(nf.checked_mul(2)?)?;
        let maximum = isize::MAX as usize / core::mem::size_of::<f64>();
        let cell_area = dx * dz;
        if !(n > 0
            && nv <= maximum
            && words <= maximum
            && dx > 0.0
            && dz > 0.0
            && cell_area > 0.0
            && cell_area.is_finite()
            && dt > 0.0
            && dt.is_finite())
        {
            return None;
        }
        Some(Geometry {
            grid: Grid { nx, nz, dx, dz },
            n,
            nv,
            nf,
            cell_area,
        })
    }

    unsafe fn validate(&self, shape: Geometry) -> bool {
        let Geometry { n, nv, .. } = shape;
        unsafe {
            let m = &*self.material;
            if m.rates().is_none() {
                return false;
            }
            let available = slice::from_raw_parts(self.available, nv);
            let area = slice::from_raw_parts(self.area, nv);
            let solid = slice::from_raw_parts(self.state, n);
            let cohesion = slice::from_raw_parts(self.cohesion, n);
            let flow = slice::from_raw_parts(self.flow, 3 * n);
            let budget = slice::from_raw_parts(self.budget, 3);
            let pore = 1.0 - m.porosity;
            available
                .iter()
                .chain(solid)
                .chain(cohesion)
                .chain(budget)
                .copied()
                .all(nonnegative)
                && area
                    .iter()
                    .all(|&a| a > 0.0 && a.is_finite() && a * pore > 0.0)
                && flow
                    .chunks_exact(3)
                    .all(|w| w[0] >= 0.0 && w.iter().all(|x| x.is_finite()))
        }
    }

    // Worker writes are disjoint slices of each candidate plane and of the
    // proposal workspace. The old solid plane is read-only until the barrier.
    #[inline(never)]
    unsafe fn cells(&self, shape: Geometry, range: core::ops::Range<usize>) -> bool {
        let Geometry { n, cell_area, .. } = shape;
        unsafe {
            let m = &*self.material;
            let Some(rates) = m.rates() else { return false };
            let flow = slice::from_raw_parts(self.flow, 3 * n);
            let solid = slice::from_raw_parts(self.state, n);
            let cohesion = slice::from_raw_parts(self.cohesion, n);
            let speed = slice::from_raw_parts_mut(self.scratch.add(range.start), range.len());
            speeds_squared(&flow[3 * range.start..3 * range.end], speed);
            for (i, s2) in range.zip(speed.iter().copied()) {
                let Some((tau, load, desired)) = m.column_proposal(
                    &rates,
                    Water::at(flow, i),
                    solid[i],
                    s2,
                    cohesion[i],
                    cell_area,
                    self.dt,
                ) else {
                    return false;
                };
                self.state.add(SHEAR * n + i).write(tau);
                self.state.add(BEDLOAD * n + i).write(load);
                self.scratch.add(2 * n + i).write(desired);
                self.scratch.add(3 * n + i).write(load);
            }
            let pair_end = speed.len() & !1;
            for i in (0..pair_end).step_by(2) {
                let pair = f64x2_sqrt(f64x2(speed[i], speed[i + 1]));
                v128_store(speed.as_mut_ptr().add(i).cast(), pair);
            }
            if pair_end < speed.len() {
                speed[pair_end] = sqrt(speed[pair_end]);
            }
        }
        true
    }

    #[inline(never)]
    unsafe fn settle_cells(&self, shape: Geometry) -> bool {
        let Geometry {
            grid,
            n,
            nv,
            cell_area,
            ..
        } = shape;
        unsafe {
            let m = &*self.material;
            let flow = slice::from_raw_parts(self.flow, 3 * n);
            let state = slice::from_raw_parts_mut(self.state, PLANES * n);
            let vertices = slice::from_raw_parts_mut(self.available, nv);
            let delta = slice::from_raw_parts_mut(self.delta, nv);
            let proposals = slice::from_raw_parts_mut(self.scratch.add(2 * n), n);
            delta.fill(0.0);
            let mut bed = Bed {
                available: vertices,
                delta,
            };
            for (i, proposed) in proposals.iter_mut().enumerate() {
                let w = Water::at(flow, i);
                let column = state[SOLID * n + i];
                let mut concentration = 0.0;
                let vertices = grid.vertices(i);
                if w.depth > DRY {
                    let water_volume = w.depth * cell_area;
                    let desired = *proposed;
                    let exchange = if desired >= 0.0 {
                        let Some(moved) = bed.take(vertices, desired) else {
                            return false;
                        };
                        moved
                    } else {
                        if !bed.put(vertices, -desired) {
                            return false;
                        }
                        desired
                    };
                    let sum = column + exchange;
                    if !sum.is_finite() {
                        return false;
                    }
                    let held = sum.max(0.0).min(water_volume * (1.0 - m.porosity));
                    if !bed.put(vertices, (sum - held).max(0.0)) {
                        return false;
                    }
                    state[SOLID * n + i] = held;
                    concentration = held / water_volume;
                } else {
                    if !bed.put(vertices, column) {
                        return false;
                    }
                    state[SOLID * n + i] = 0.0;
                }
                if !concentration.is_finite() {
                    return false;
                }
                state[CONCENTRATION * n + i] = concentration;
                *proposed = 0.0;
            }
        }
        true
    }

    #[inline(never)]
    unsafe fn face_proposals(&self, shape: Geometry, range: core::ops::Range<usize>) -> bool {
        let Geometry { grid, n, nf, .. } = shape;
        unsafe {
            let flow = slice::from_raw_parts(self.flow, 3 * n);
            let concentration = slice::from_raw_parts(self.state.add(CONCENTRATION * n), n);
            let speed = slice::from_raw_parts(self.scratch, n);
            let capacity = slice::from_raw_parts(self.scratch.add(3 * n), n);
            for index in range {
                let Face {
                    left,
                    right,
                    along_x,
                    length,
                    side,
                } = grid.face(index);
                let exterior = side != 0;
                let (suspended, bed) = if exterior && self.open & side == 0 {
                    (0.0, 0.0)
                } else {
                    let a = left.map_or(Water::DRY_CELL, |i| Water::at(flow, i));
                    let b = right.map_or(Water::DRY_CELL, |i| Water::at(flow, i));
                    let q_water =
                        directional_average(a.discharge(along_x), b.discharge(along_x), exterior);
                    let (giver, _) = donor(q_water, left, right);
                    let suspended =
                        giver.map_or(0.0, |i| q_water * concentration[i] * length * self.dt);
                    let qa = left.map_or(0.0, |i| {
                        directed_capacity(capacity[i], a, speed[i], along_x)
                    });
                    let qb = right.map_or(0.0, |i| {
                        directed_capacity(capacity[i], b, speed[i], along_x)
                    });
                    (
                        suspended,
                        directional_average(qa, qb, exterior) * length * self.dt,
                    )
                };
                if !(suspended.is_finite() && bed.is_finite()) {
                    return false;
                }
                self.scratch.add(4 * n + index).write(suspended);
                self.scratch.add(4 * n + nf + index).write(bed);
            }
        }
        true
    }

    #[inline(never)]
    unsafe fn finish(&self, shape: Geometry) -> bool {
        let Geometry {
            grid,
            n,
            nv,
            nf,
            cell_area,
        } = shape;
        unsafe {
            let m = &*self.material;
            let flow = slice::from_raw_parts(self.flow, 3 * n);
            let cohesion = slice::from_raw_parts(self.cohesion, n);
            let area = slice::from_raw_parts(self.area, nv);
            let vertices = slice::from_raw_parts_mut(self.available, nv);
            let delta = slice::from_raw_parts_mut(self.delta, nv);
            let mut bed = Bed {
                available: vertices,
                delta,
            };
            let state = slice::from_raw_parts_mut(self.state, PLANES * n);
            let budget = slice::from_raw_parts_mut(self.budget, 3);
            let scratch = slice::from_raw_parts_mut(self.scratch.add(n), 3 * n + 2 * nf);
            let (outgoing, scratch) = scratch.split_at_mut(n);
            let (change, scratch) = scratch.split_at_mut(n);
            let (suspended, bedload) = scratch[n..].split_at(nf);

            // Donor totals and every later ledger addition use canonical face
            // order. This matches the former scalar proposal and transfer loops.
            outgoing.fill(0.0);
            for (index, &proposal) in suspended.iter().enumerate() {
                if proposal != 0.0 {
                    let face = grid.face(index);
                    let (from, _) = donor(proposal, face.left, face.right);
                    if let Some(from) = from {
                        outgoing[from] += proposal.abs();
                        if !outgoing[from].is_finite() {
                            return false;
                        }
                    }
                }
            }

            for (index, (&suspended, &bedload)) in suspended.iter().zip(bedload).enumerate() {
                let Face {
                    left,
                    right,
                    along_x,
                    length,
                    ..
                } = grid.face(index);
                let (from, to) = donor(suspended, left, right);
                if suspended != 0.0 {
                    if let Some(from) = from {
                        let scale = (state[SOLID * n + from] / outgoing[from]).min(1.0);
                        let moved = suspended.abs() * scale;
                        change[from] -= moved;
                        if let Some(to) = to {
                            change[to] += moved;
                        } else {
                            budget[0] += moved;
                        }
                    }
                }

                let (from, to) = donor(bedload, left, right);
                if bedload != 0.0 {
                    if let Some(from) = from {
                        let Some(moved) = bed.take(grid.vertices(from), bedload.abs()) else {
                            return false;
                        };
                        if let Some(to) = to {
                            if !bed.put(grid.vertices(to), moved) {
                                return false;
                            }
                        } else {
                            budget[1] += moved;
                        }
                    }
                }

                if m.bank_erodibility > 0.0 {
                    if let (Some(a), Some(b)) = (left, right) {
                        let wa = Water::at(flow, a);
                        let wb = Water::at(flow, b);
                        let left_wet = wa.depth > DRY;
                        if left_wet != (wb.depth > DRY) {
                            let (wet, dry, depth) = if left_wet {
                                (a, b, wa.depth)
                            } else {
                                (b, a, wb.depth)
                            };
                            let excess = grid.bank_excess(flow, wet, along_x, left_wet);
                            let offset = m.bank_erodibility * excess;
                            if !offset.is_finite() {
                                return false;
                            }
                            if offset != 0.0 {
                                let (from, to) = if offset > 0.0 { (dry, wet) } else { (wet, dry) };
                                let shear = state[SHEAR * n + wet];
                                let mobilised = if shear > 0.0 {
                                    (1.0 - cohesion[from] / shear).max(0.0)
                                } else {
                                    0.0
                                };
                                let demand = offset.abs()
                                    * depth
                                    * length
                                    * self.dt
                                    * (1.0 - m.porosity)
                                    * mobilised;
                                let Some(moved) = bed.take(grid.vertices(from), demand) else {
                                    return false;
                                };
                                if !bed.put(grid.vertices(to), moved) {
                                    return false;
                                }
                                budget[2] += moved;
                            }
                        }
                    }
                }
            }

            for i in 0..n {
                let sum = state[SOLID * n + i] + change[i];
                let water_volume = Water::at(flow, i).depth * cell_area;
                if !(sum.is_finite() && water_volume.is_finite()) {
                    return false;
                }
                let volume = sum.max(0.0);
                let retained = if water_volume > DRY * cell_area {
                    volume.min(water_volume * (1.0 - m.porosity))
                } else {
                    0.0
                };
                if !bed.put(grid.vertices(i), volume - retained) {
                    return false;
                }
                state[SOLID * n + i] = retained;
                let concentration = if retained > 0.0 {
                    let mass = retained * m.grain_density;
                    if mass.is_finite() {
                        mass / water_volume
                    } else {
                        (retained / water_volume) * m.grain_density
                    }
                } else {
                    0.0
                };
                if !concentration.is_finite() {
                    return false;
                }
                state[CONCENTRATION * n + i] = concentration;
            }
            for (i, &a) in area.iter().enumerate() {
                bed.delta[i] /= a * (1.0 - m.porosity);
                if !bed.delta[i].is_finite() {
                    return false;
                }
            }
            budget.iter().all(|&word| nonnegative(word))
        }
    }
}

/// Advances a caller-owned candidate and commits receipts only after all
/// local proposals and ordered bed and donor transfers succeed.
#[unsafe(no_mangle)]
unsafe extern "C" fn sediment_step(
    state: *mut f64,
    available: *mut f64,
    delta: *mut f64,
    area: *const f64,
    flow: *const f32,
    cohesion: *const f64,
    scratch: *mut f64,
    budget: *mut f64,
    material: *const Material,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    open: u32,
    dt: f64,
    receipts: *mut u32,
) -> u32 {
    let job = SedimentJob {
        state,
        available,
        delta,
        area,
        flow,
        cohesion,
        scratch,
        budget,
        material,
        nx,
        nz,
        open,
        receipts,
        reserved: 0,
        dx,
        dz,
        dt,
    };
    let Some(shape) = job.geometry() else {
        return 1;
    };
    unsafe {
        if !(job.validate(shape)
            && job.cells(shape, 0..shape.n)
            && job.settle_cells(shape)
            && job.face_proposals(shape, 0..shape.nf)
            && job.finish(shape))
        {
            return 1;
        }
        if !receipts.is_null() {
            receipts.write(shape.n as u32);
            receipts.add(1).write(shape.nf as u32);
        }
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn sediment_thread_prepare(job: *const SedimentJob) -> u32 {
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let Some(shape) = job.geometry() else {
            return 1;
        };
        u32::from(!job.validate(shape))
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn sediment_thread_phase(
    job: *const SedimentJob,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    if stage > 1 || part >= parts {
        return 1;
    }
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let Some(shape) = job.geometry() else {
            return 1;
        };
        let count = if stage == 0 { shape.n } else { shape.nf } as u64;
        let start = (u64::from(part) * count / u64::from(parts)) as usize;
        let end = ((u64::from(part) + 1) * count / u64::from(parts)) as usize;
        let successful = if stage == 0 {
            job.cells(shape, start..end)
        } else {
            job.face_proposals(shape, start..end)
        };
        if !successful {
            return 1;
        }
        if !job.receipts.is_null() {
            job.receipts
                .add(2 * part as usize + stage as usize)
                .write((end - start) as u32);
        }
        0
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn sediment_thread_settle_cells(job: *const SedimentJob) -> u32 {
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let Some(shape) = job.geometry() else {
            return 1;
        };
        u32::from(!job.settle_cells(shape))
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn sediment_thread_finish(job: *const SedimentJob) -> u32 {
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let Some(shape) = job.geometry() else {
            return 1;
        };
        u32::from(!job.finish(shape))
    }
}
