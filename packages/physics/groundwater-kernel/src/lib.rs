#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, v128_load};
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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn groundwater_step(
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
) -> i32 {
    let Some(width) = NonZeroUsize::new(nx) else {
        return 1;
    };
    let n = nx * nz;
    if n == 0 {
        return 1;
    }
    let grid = Grid {
        nx: width,
        nz,
        dx,
        dz,
    };
    let surface = unsafe { read_column(forcing, n, 0) };
    let recharge = unsafe { read_column(forcing, n, 1) };
    let model = Aquifer {
        grid,
        bottom: unsafe { read_column(controls, n, 0) },
        kx: unsafe { read_column(controls, n, 1) },
        kz: unsafe { read_column(controls, n, 2) },
        capacity: unsafe { read_column(controls, n, 3) },
        drain_at: unsafe { read_column(controls, n, 4) },
        drain_k: unsafe { read_column(controls, n, 5) },
        sides: unsafe { slice::from_raw_parts(sides, 4) },
        dt,
    };
    let depth = unsafe { write_column(state, n, 0) };
    let head = unsafe { write_column(state, n, 1) };
    let outlet_rate = unsafe { write_column(state, n, 2) };
    let spring_rate = unsafe { write_column(state, n, 3) };
    let seepage_rate = unsafe { write_column(state, n, 4) };
    let budget = unsafe { slice::from_raw_parts_mut(budget, 5) };
    let east = unsafe { write_column(scratch, n, 0) };
    let south = unsafe { write_column(scratch, n, 1) };
    let diag = unsafe { write_column(scratch, n, 2) };
    let rhs = unsafe { write_column(scratch, n, 3) };
    let x = unsafe { write_column(scratch, n, 4) };
    let residual = unsafe { write_column(scratch, n, 5) };
    let direction = unsafe { write_column(scratch, n, 6) };
    let applied = unsafe { write_column(scratch, n, 7) };
    let spring_on = unsafe { write_column(scratch, n, 8) };
    let supplied = unsafe { write_column(scratch, n, 9) };
    let outgoing = unsafe { write_column(scratch, n, 10) };
    let scale = unsafe { write_column(scratch, n, 11) };
    let area = dx * dz;

    for i in 0..n {
        *word_mut(east, i) = if grid.east(i) {
            model.link(depth, i, i + 1, model.kx, dz / dx)
        } else {
            0.0
        };
        *word_mut(south, i) = if grid.south(i) {
            model.link(depth, i, i + nx, model.kz, dx / dz)
        } else {
            0.0
        };
        *word_mut(x, i) = word(depth, i);
        *word_mut(supplied, i) = model.storage(i) * word(x, i) + word(recharge, i) * area * dt;
        let drain = (word(model.drain_at, i) - word(model.bottom, i)).max(0.0);
        *word_mut(spring_on, i) = if word(model.drain_k, i) > 0.0 && word(depth, i) > drain {
            1.0
        } else {
            0.0
        };
    }

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
            let drain = word(model.drain_at, i).max(word(model.bottom, i)) - word(model.bottom, i);
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
        *word_mut(supplied, i) = (word(supplied, i) - word(outgoing, i) * word(scale, i)).max(0.0);
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
        let top_storage = (word(surface, i) - word(model.bottom, i)).max(0.0) * model.storage(i);
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
