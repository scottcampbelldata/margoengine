#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_max, f64x2_min, f64x2_mul,
    f64x2_splat, f64x2_sub, v128, v128_bitselect, v128_load,
};
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

#[derive(Clone, Copy)]
struct Grid {
    nx: NonZeroUsize,
    nz: usize,
    dx: f64,
    dz: f64,
}

// Trap on an invalid index without storing Rust's panic text in a static memory window.
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

impl Grid {
    fn east(self, i: usize) -> bool {
        i % self.nx.get() + 1 < self.nx.get()
    }

    fn south(self, i: usize) -> bool {
        i / self.nx.get() + 1 < self.nz
    }

    fn pairs(self, east: &[f64], south: &[f64], mut visit: impl FnMut(usize, usize, f64)) {
        for i in 0..east.len() {
            if self.east(i) && word(east, i) > 0.0 {
                visit(i, i + 1, word(east, i));
            }
            if self.south(i) && word(south, i) > 0.0 {
                visit(i, i + self.nx.get(), word(south, i));
            }
        }
    }
}

struct Aquifer<'a> {
    grid: Grid,
    bottom: &'a [f64],
    kx: &'a [f64],
    kz: &'a [f64],
    capacity: &'a [f64],
    drain_at: &'a [f64],
    drain_k: &'a [f64],
    sides: &'a [f64],
    dt: f64,
}

fn harmonic(a: f64, b: f64) -> f64 {
    let low = a.min(b);
    let high = a.max(b);
    if low == 0.0 {
        0.0
    } else {
        low / (0.5 + 0.5 * (low / high))
    }
}

impl Aquifer<'_> {
    fn link(&self, depth: &[f64], i: usize, j: usize, k: &[f64], width_over_length: f64) -> f64 {
        // Only the saturated thickness above both bottoms connects the cells.
        let floor = word(self.bottom, i).max(word(self.bottom, j));
        let depth_i = (word(depth, i) - (floor - word(self.bottom, i))).max(0.0);
        let depth_j = (word(depth, j) - (floor - word(self.bottom, j))).max(0.0);
        self.dt
            * harmonic(word(k, i), word(k, j))
            * (0.5 * depth_i + 0.5 * depth_j)
            * width_over_length
    }

    fn paired_links(&self, depth: &[f64], i: usize, east: usize, south: usize) -> (f64, f64) {
        let half = f64x2_splat(0.5);
        let zero = f64x2_splat(0.0);
        let positive_part = |value: v128| v128_bitselect(value, zero, f64x2_gt(value, zero));
        let bottom = f64x2_splat(word(self.bottom, i));
        let neighbor_bottom = f64x2(word(self.bottom, east), word(self.bottom, south));
        let floor = f64x2_max(bottom, neighbor_bottom);
        let depth_i = positive_part(f64x2_sub(
            f64x2_splat(word(depth, i)),
            f64x2_sub(floor, bottom),
        ));
        let depth_j = positive_part(f64x2_sub(
            f64x2(word(depth, east), word(depth, south)),
            f64x2_sub(floor, neighbor_bottom),
        ));
        let overlap = f64x2_add(f64x2_mul(half, depth_i), f64x2_mul(half, depth_j));
        let first = f64x2(word(self.kx, i), word(self.kz, i));
        let second = f64x2(word(self.kx, east), word(self.kz, south));
        let low = f64x2_min(first, second);
        let high = f64x2_max(first, second);
        // Preserve the scalar harmonic mean's order and its zero-conductivity branch in each lane.
        let denominator = f64x2_add(half, f64x2_mul(half, f64x2_div(low, high)));
        let conductivity = v128_bitselect(f64x2_div(low, denominator), zero, f64x2_gt(low, zero));
        let grid = self.grid;
        let result = f64x2_mul(
            f64x2_mul(f64x2_mul(f64x2_splat(self.dt), conductivity), overlap),
            f64x2(grid.dz / grid.dx, grid.dx / grid.dz),
        );
        (
            f64x2_extract_lane::<0>(result),
            f64x2_extract_lane::<1>(result),
        )
    }

    fn boundaries(&self, i: usize, depth: f64, mut visit: impl FnMut(f64, f64)) {
        let g = self.grid;
        let x = i % g.nx.get();
        let z = i / g.nx.get();
        for (side, at_edge) in [x == 0, x + 1 == g.nx.get(), z == 0, z + 1 == g.nz]
            .into_iter()
            .enumerate()
        {
            if !at_edge || !word(self.sides, side).is_finite() {
                continue;
            }
            let bottom = word(self.bottom, i);
            let boundary = word(self.sides, side).max(bottom);
            let overlap = 0.5 * depth + 0.5 * (boundary - bottom);
            let transverse = if side < 2 {
                word(self.kx, i) * g.dz / g.dx
            } else {
                word(self.kz, i) * g.dx / g.dz
            };
            visit(2.0 * self.dt * transverse * overlap, boundary);
        }
    }

    fn storage(&self, i: usize) -> f64 {
        word(self.capacity, i) * self.grid.dx * self.grid.dz
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut lanes = f64x2_splat(0.0);
    let pair_end = a.len() & !1;
    unsafe {
        for i in (0..pair_end).step_by(2) {
            let x = v128_load(a.as_ptr().add(i).cast());
            let y = v128_load(b.as_ptr().add(i).cast());
            lanes = f64x2_add(lanes, f64x2_mul(x, y));
        }
    }
    let pairs = f64x2_extract_lane::<0>(lanes) + f64x2_extract_lane::<1>(lanes);
    if pair_end == a.len() {
        pairs
    } else {
        pairs + word(a, pair_end) * word(b, pair_end)
    }
}

fn apply(grid: Grid, east: &[f64], south: &[f64], diag: &[f64], x: &[f64], out: &mut [f64]) {
    for i in 0..x.len() {
        *word_mut(out, i) = word(diag, i) * word(x, i);
    }
    grid.pairs(east, south, |i, j, weight| {
        *word_mut(out, i) -= weight * word(x, j);
        *word_mut(out, j) -= weight * word(x, i);
    });
}

fn infinity_norm(x: &[f64]) -> f64 {
    x.iter().fold(0.0, |m, v| {
        if v.is_finite() {
            m.max(v.abs())
        } else {
            f64::INFINITY
        }
    })
}

fn pcg(
    grid: Grid,
    east: &[f64],
    south: &[f64],
    diag: &[f64],
    rhs: &[f64],
    x: &mut [f64],
    residual: &mut [f64],
    direction: &mut [f64],
    active_work: &mut [f64],
    tolerance: f64,
) -> bool {
    apply(grid, east, south, diag, x, active_work);
    for i in 0..x.len() {
        *word_mut(residual, i) = word(rhs, i) - word(active_work, i);
        *word_mut(direction, i) = word(residual, i) / word(diag, i);
    }
    let rhs_scale = infinity_norm(rhs);
    if !rhs_scale.is_finite() {
        return false;
    }
    let target = tolerance * rhs_scale.max(f64::MIN_POSITIVE);
    let mut energy = dot(residual, direction);
    // Conjugate gradients converge in the dimension of the linear space in exact arithmetic.
    // Allow one extra pass for finite precision and check the true, rather than recursive, residual.
    for step in 0..=2 * x.len() {
        if infinity_norm(residual) <= target || step == 2 * x.len() {
            apply(grid, east, south, diag, x, active_work);
            for i in 0..x.len() {
                *word_mut(residual, i) = word(rhs, i) - word(active_work, i);
            }
            if infinity_norm(residual) <= target {
                return true;
            }
            if step == 2 * x.len() {
                return false;
            }
            for i in 0..x.len() {
                *word_mut(direction, i) = word(residual, i) / word(diag, i);
            }
            energy = dot(residual, direction);
        }
        if !energy.is_finite() || energy <= 0.0 {
            return false;
        }
        apply(grid, east, south, diag, direction, active_work);
        let curvature = dot(direction, active_work);
        if !curvature.is_finite() || curvature <= 0.0 {
            return false;
        }
        let scale = energy / curvature;
        for i in 0..x.len() {
            *word_mut(x, i) += scale * word(direction, i);
            *word_mut(residual, i) -= scale * word(active_work, i);
            *word_mut(active_work, i) = word(residual, i) / word(diag, i);
        }
        let next = dot(residual, active_work);
        let beta = next / energy;
        for i in 0..x.len() {
            *word_mut(direction, i) = word(active_work, i) + beta * word(direction, i);
        }
        energy = next;
    }
    false
}

fn pair_volume(x: &[f64], base: &[f64], i: usize, j: usize, g: f64) -> f64 {
    g * ((word(x, i) - word(x, j)) + (word(base, i) - word(base, j)))
}

// The caller assigns contiguous columns in separately allocated regions of exactly the documented
// lengths. A column is taken once and the writable columns are disjoint for the entire step.
unsafe fn read_column<'a>(base: *const f64, n: usize, column: usize) -> &'a [f64] {
    unsafe { slice::from_raw_parts(base.add(column * n), n) }
}

unsafe fn write_column<'a>(base: *mut f64, n: usize, column: usize) -> &'a mut [f64] {
    unsafe { slice::from_raw_parts_mut(base.add(column * n), n) }
}

#[repr(C)]
#[derive(Default)]
struct Work {
    cells: f64,
    face_conductances: f64,
    paired_face_conductances: f64,
    initial_active_springs: f64,
}

#[repr(C)]
struct Job {
    controls: *const f64,
    forcing: *const f64,
    sides: *const f64,
    state: *mut f64,
    budget: *mut f64,
    scratch: *mut f64,
    nx: usize,
    nz: usize,
    work: *mut Work,
    _padding: u32,
    dx: f64,
    dz: f64,
    dt: f64,
    output_dt: f64,
    tolerance: f64,
}

const _: [(); 80] = [(); core::mem::size_of::<Job>()];

impl Job {
    fn geometry(&self) -> Option<(Grid, usize)> {
        let nx = NonZeroUsize::new(self.nx)?;
        let n = self.nx.checked_mul(self.nz)?;
        if n == 0 || n > isize::MAX as usize / (12 * size_of::<f64>()) {
            return None;
        }
        Some((
            Grid {
                nx,
                nz: self.nz,
                dx: self.dx,
                dz: self.dz,
            },
            n,
        ))
    }

    unsafe fn aquifer(&self, grid: Grid, n: usize) -> Aquifer<'_> {
        unsafe {
            Aquifer {
                grid,
                bottom: read_column(self.controls, n, 0),
                kx: read_column(self.controls, n, 1),
                kz: read_column(self.controls, n, 2),
                capacity: read_column(self.controls, n, 3),
                drain_at: read_column(self.controls, n, 4),
                drain_k: read_column(self.controls, n, 5),
                sides: slice::from_raw_parts(self.sides, 4),
                dt: self.dt,
            }
        }
    }

    unsafe fn prepare(&self, grid: Grid, n: usize, first: usize, end: usize, part: usize) {
        let depth = unsafe { read_column(self.state, n, 0) };
        let recharge = unsafe { read_column(self.forcing, n, 1) };
        let model = unsafe { self.aquifer(grid, n) };
        let count = end - first;
        // Each participant borrows only its own writable cells within each assembly column.
        let chunk = |column| unsafe {
            slice::from_raw_parts_mut(self.scratch.add(column * n + first), count)
        };
        let east = chunk(0);
        let south = chunk(1);
        let x = chunk(4);
        let spring_on = chunk(8);
        let supplied = chunk(9);
        let area = grid.dx * grid.dz;
        let nx = grid.nx.get();
        let mut work = Work {
            cells: count as f64,
            ..Work::default()
        };

        for row in 0..count {
            let i = first + row;
            let (east_value, south_value) = match (grid.east(i), grid.south(i)) {
                (true, true) => {
                    work.face_conductances += 2.0;
                    work.paired_face_conductances += 2.0;
                    model.paired_links(depth, i, i + 1, i + nx)
                }
                (true, false) => {
                    work.face_conductances += 1.0;
                    (
                        model.link(depth, i, i + 1, model.kx, grid.dz / grid.dx),
                        0.0,
                    )
                }
                (false, true) => {
                    work.face_conductances += 1.0;
                    (
                        0.0,
                        model.link(depth, i, i + nx, model.kz, grid.dx / grid.dz),
                    )
                }
                (false, false) => (0.0, 0.0),
            };
            *word_mut(east, row) = east_value;
            *word_mut(south, row) = south_value;
            let water = word(depth, i);
            *word_mut(x, row) = water;
            *word_mut(supplied, row) =
                model.storage(i) * water + word(recharge, i) * area * self.dt;
            let drain = (word(model.drain_at, i) - word(model.bottom, i)).max(0.0);
            let on = if word(model.drain_k, i) > 0.0 && water > drain {
                1.0
            } else {
                0.0
            };
            *word_mut(spring_on, row) = on;
            work.initial_active_springs += on;
        }
        if !self.work.is_null() {
            unsafe { self.work.add(part).write(work) };
        }
    }

    // PCG dot reduction, drain active-set changes and matched face-volume recovery retain order.
    unsafe fn finish(&self, grid: Grid, n: usize) -> i32 {
        let dt = self.dt;
        let output_dt = self.output_dt;
        let tolerance = self.tolerance;
        let surface = unsafe { read_column(self.forcing, n, 0) };
        let recharge = unsafe { read_column(self.forcing, n, 1) };
        let model = unsafe { self.aquifer(grid, n) };
        let depth = unsafe { write_column(self.state, n, 0) };
        let head = unsafe { write_column(self.state, n, 1) };
        let outlet_rate = unsafe { write_column(self.state, n, 2) };
        let spring_rate = unsafe { write_column(self.state, n, 3) };
        let seepage_rate = unsafe { write_column(self.state, n, 4) };
        let budget = unsafe { slice::from_raw_parts_mut(self.budget, 5) };
        let east = unsafe { write_column(self.scratch, n, 0) };
        let south = unsafe { write_column(self.scratch, n, 1) };
        let diag = unsafe { write_column(self.scratch, n, 2) };
        let rhs = unsafe { write_column(self.scratch, n, 3) };
        let x = unsafe { write_column(self.scratch, n, 4) };
        let residual = unsafe { write_column(self.scratch, n, 5) };
        let direction = unsafe { write_column(self.scratch, n, 6) };
        let applied = unsafe { write_column(self.scratch, n, 7) };
        let spring_on = unsafe { write_column(self.scratch, n, 8) };
        let supplied = unsafe { write_column(self.scratch, n, 9) };
        let outgoing = unsafe { write_column(self.scratch, n, 10) };
        let scale = unsafe { write_column(self.scratch, n, 11) };
        let area = grid.dx * grid.dz;

        let mut solved = false;
        // A MODFLOW-style drain is unilateral. Rebuild the linear diagonal when a solution crosses a drain's elevation.
        for _ in 0..=2 * n {
            for i in 0..n {
                let drain = word(model.drain_at, i).max(word(model.bottom, i));
                let c = word(spring_on, i) * dt * word(model.drain_k, i);
                *word_mut(diag, i) = model.storage(i) + c;
                *word_mut(rhs, i) = word(supplied, i) + c * (drain - word(model.bottom, i));
                model.boundaries(i, word(depth, i), |weight, elevation| {
                    *word_mut(diag, i) += weight;
                    *word_mut(rhs, i) += weight * (elevation - word(model.bottom, i));
                });
            }
            grid.pairs(east, south, |i, j, weight| {
                *word_mut(diag, i) += weight;
                *word_mut(diag, j) += weight;
                let shift = weight * (word(model.bottom, i) - word(model.bottom, j));
                *word_mut(rhs, i) -= shift;
                *word_mut(rhs, j) += shift;
            });
            if !pcg(
                grid, east, south, diag, rhs, x, residual, direction, applied, tolerance,
            ) {
                return 1;
            }
            solved = true;
            for i in 0..n {
                let drain =
                    word(model.drain_at, i).max(word(model.bottom, i)) - word(model.bottom, i);
                let on = if word(model.drain_k, i) > 0.0 && word(x, i) > drain {
                    1.0
                } else {
                    0.0
                };
                solved &= on == word(spring_on, i);
                *word_mut(spring_on, i) = on;
            }
            if solved {
                break;
            }
        }
        if !solved {
            return 2;
        }

        // Reconstruct the step from matching face volumes. Drainage cannot spend water absent
        // from the donor at the start of this step, including recharge and incoming boundary flow.
        let mut boundary_in = 0.0;
        for i in 0..n {
            let drain = word(model.drain_at, i).max(word(model.bottom, i)) - word(model.bottom, i);
            let spring = dt * word(model.drain_k, i) * (word(x, i) - drain).max(0.0);
            *word_mut(spring_on, i) = spring;
            *word_mut(outgoing, i) = spring;
            model.boundaries(i, word(depth, i), |weight, elevation| {
                let q = weight * (word(x, i) + (word(model.bottom, i) - elevation));
                *word_mut(outgoing, i) += q.max(0.0);
                *word_mut(supplied, i) -= q.min(0.0);
                boundary_in -= q.min(0.0);
            });
        }
        grid.pairs(east, south, |i, j, weight| {
            let q = pair_volume(x, model.bottom, i, j, weight);
            *word_mut(outgoing, i) += q.max(0.0);
            *word_mut(outgoing, j) -= q.min(0.0);
        });
        for i in 0..n {
            if !word(supplied, i).is_finite() || !word(outgoing, i).is_finite() {
                return 1;
            }
            *word_mut(scale, i) = if word(outgoing, i) > word(supplied, i) {
                word(supplied, i) / word(outgoing, i)
            } else {
                1.0
            };
        }

        // Subtract outgoing in one operation so a donor at zero remains nonnegative.
        for i in 0..n {
            *word_mut(supplied, i) =
                (word(supplied, i) - word(outgoing, i) * word(scale, i)).max(0.0);
        }
        grid.pairs(east, south, |i, j, weight| {
            let q = pair_volume(x, model.bottom, i, j, weight);
            if q >= 0.0 {
                *word_mut(supplied, j) += q * word(scale, i);
            } else {
                *word_mut(supplied, i) -= q * word(scale, j);
            }
        });
        let mut boundary_out = 0.0;
        let mut total_spring = 0.0;
        let mut total_seepage = 0.0;
        let mut total_recharge = 0.0;
        for i in 0..n {
            model.boundaries(i, word(depth, i), |weight, elevation| {
                let q = weight * (word(x, i) + (word(model.bottom, i) - elevation));
                boundary_out += q.max(0.0) * word(scale, i);
            });
            let top_storage =
                (word(surface, i) - word(model.bottom, i)).max(0.0) * model.storage(i);
            let seep = (word(supplied, i) - top_storage).max(0.0);
            let spring = word(spring_on, i) * word(scale, i);
            total_spring += spring;
            total_seepage += seep;
            total_recharge += word(recharge, i) * area * dt;
            *word_mut(depth, i) = word(supplied, i).min(top_storage) / model.storage(i);
            *word_mut(head, i) = word(model.bottom, i) + word(depth, i);
            *word_mut(spring_rate, i) = spring / output_dt;
            *word_mut(seepage_rate, i) = seep / output_dt;
            *word_mut(outlet_rate, i) = (spring + seep) / output_dt;
        }
        *word_mut(budget, 0) += total_recharge;
        *word_mut(budget, 1) += boundary_in;
        *word_mut(budget, 2) += boundary_out;
        *word_mut(budget, 3) += total_spring;
        *word_mut(budget, 4) += total_seepage;
        0
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn groundwater_step(
    controls: *const f64,
    forcing: *const f64,
    sides: *const f64,
    state: *mut f64,
    budget: *mut f64,
    scratch: *mut f64,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    dt: f64,
    output_dt: f64,
    tolerance: f64,
    work: *mut Work,
) -> i32 {
    let job = Job {
        controls,
        forcing,
        sides,
        state,
        budget,
        scratch,
        nx,
        nz,
        work,
        _padding: 0,
        dx,
        dz,
        dt,
        output_dt,
        tolerance,
    };
    let Some((grid, n)) = job.geometry() else {
        return 1;
    };
    unsafe {
        job.prepare(grid, n, 0, n, 0);
        job.finish(grid, n)
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn groundwater_thread_phase(job: &Job, stage: u32, part: u32, parts: u32) -> i32 {
    let Some((grid, n)) = job.geometry() else {
        return 1;
    };
    let Some(parts) = core::num::NonZeroU64::new(u64::from(parts)) else {
        return 1;
    };
    if stage != 0 || u64::from(part) >= parts.get() {
        return 1;
    }
    let first = (n as u64 * u64::from(part) / parts.get()) as usize;
    let end = (n as u64 * u64::from(part + 1) / parts.get()) as usize;
    unsafe { job.prepare(grid, n, first, end, part as usize) };
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn groundwater_finish(job: &Job) -> i32 {
    let Some((grid, n)) = job.geometry() else {
        return 1;
    };
    unsafe { job.finish(grid, n) }
}
