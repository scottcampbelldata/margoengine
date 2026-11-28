use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_mul, f64x2_splat, f64x2_sub, v128, v128_load, v128_store,
};
use core::num::NonZeroU64;

use crate::Grid;

#[repr(C)]
pub(crate) struct MatrixWork {
    pub(crate) products: f64,
    pub(crate) transpose_rows: f64,
    pub(crate) pressure_rows: f64,
    pub(crate) gradient_faces: f64,
    pub(crate) pressure_pairs: f64,
    pub(crate) gradient_pairs: f64,
}

#[repr(C)]
pub(crate) struct MatrixJob {
    pub(crate) input: *const f64,
    pub(crate) result: *mut f64,
    pub(crate) transpose: *mut f64,
    pub(crate) pressure: *mut f64,
    pub(crate) weight: *const f64,
    pub(crate) wetting: *const f64,
    pub(crate) curvature: *const f64,
    pub(crate) contact: *const f64,
    pub(crate) work: *mut MatrixWork,
    pub(crate) n: usize,
    pub(crate) cols: usize,
    pub(crate) parts: usize,
    pub(crate) inv_dx: f64,
    pub(crate) k: f64,
    pub(crate) sigma: f64,
    pub(crate) dt: f64,
}

#[cfg(feature = "threaded")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    pub(crate) fn thin_film_join(stage: u32);
}

impl MatrixJob {
    unsafe fn transpose_row(&self, grid: Grid, i: usize) {
        let face = |f| *self.input.add(f) * *self.weight.add(f) * self.inv_dx;
        // Each incoming face has exactly its old contribution in the former scatter's order.
        let mut sum = 0.0;
        if let Some(j) = grid.previous(i, 1) {
            sum += face(2 * j + 1);
        }
        if let Some(j) = grid.previous(i, 0) {
            sum += face(2 * j);
        }
        if grid.neighbor(i, 0).is_some() {
            sum -= face(2 * i);
        }
        if grid.neighbor(i, 1).is_some() {
            sum -= face(2 * i + 1);
        }
        *self.transpose.add(i) = sum;
    }

    unsafe fn pressure_row(&self, grid: Grid, i: usize) {
        let height = *self.transpose.add(i);
        let inv_dx2 = self.inv_dx * self.inv_dx;
        let edge = |a: usize, b: usize, f| {
            let base = (*self.transpose.add(a) - *self.transpose.add(b)) * inv_dx2;
            if self.curvature.is_null() {
                base
            } else {
                base * *self.curvature.add(f)
            }
        };
        let mut sum = 0.0;
        if self.sigma != 0.0 {
            if let Some(j) = grid.previous(i, 1) {
                sum -= edge(j, i, 2 * j + 1);
            }
            if let Some(j) = grid.previous(i, 0) {
                sum -= edge(j, i, 2 * j);
            }
            if let Some(j) = grid.neighbor(i, 0) {
                sum += edge(i, j, 2 * i);
            }
            if let Some(j) = grid.neighbor(i, 1) {
                sum += edge(i, j, 2 * i + 1);
            }
        }
        let mut value = self.k * height + self.sigma * sum;
        if !self.wetting.is_null() {
            value += *self.wetting.add(i) * height;
        }
        if !self.contact.is_null() {
            let scale = *self.contact.add(i);
            value = self.dt * value + scale * scale * height;
        }
        *self.pressure.add(i) = value;
    }

    unsafe fn pressure_pair(&self, grid: Grid, i: usize) {
        let heights = v128_load(self.transpose.add(i).cast());
        let inv_dx2 = f64x2_splat(self.inv_dx * self.inv_dx);
        let apply = |a: v128, b: v128, f| {
            let base = f64x2_mul(f64x2_sub(a, b), inv_dx2);
            if self.curvature.is_null() {
                base
            } else {
                f64x2_mul(
                    base,
                    f64x2(*self.curvature.add(f), *self.curvature.add(f + 2)),
                )
            }
        };
        let read = |j| v128_load(self.transpose.add(j).cast());
        let mut sum = f64x2_splat(0.0);
        if self.sigma != 0.0 {
            if let Some(j) = grid.previous(i, 1) {
                sum = f64x2_sub(sum, apply(read(j), heights, 2 * j + 1));
            }
            sum = f64x2_sub(sum, apply(read(i - 1), heights, 2 * (i - 1)));
            sum = f64x2_add(sum, apply(heights, read(i + 1), 2 * i));
            if let Some(j) = grid.neighbor(i, 1) {
                sum = f64x2_add(sum, apply(heights, read(j), 2 * i + 1));
            }
        }
        let mut value = f64x2_add(
            f64x2_mul(f64x2_splat(self.k), heights),
            f64x2_mul(f64x2_splat(self.sigma), sum),
        );
        if !self.wetting.is_null() {
            let wetting = v128_load(self.wetting.add(i).cast());
            value = f64x2_add(value, f64x2_mul(wetting, heights));
        }
        if !self.contact.is_null() {
            let scale = v128_load(self.contact.add(i).cast());
            value = f64x2_add(
                f64x2_mul(f64x2_splat(self.dt), value),
                f64x2_mul(f64x2_mul(scale, scale), heights),
            );
        }
        v128_store(self.pressure.add(i).cast(), value);
    }

    unsafe fn gradient_row(&self, grid: Grid, factor: v128, i: usize) {
        let p = *self.pressure.add(i);
        let difference = |axis| match grid.neighbor(i, axis) {
            Some(j) => (*self.pressure.add(j) - p) * self.inv_dx,
            None => 0.0,
        };
        let g = f64x2(difference(0), difference(1));
        let face = 2 * i;
        let input = v128_load(self.input.add(face).cast());
        let weights = v128_load(self.weight.add(face).cast());
        let answer = f64x2_add(input, f64x2_mul(f64x2_mul(factor, g), weights));
        v128_store(self.result.add(face).cast(), answer);
    }
}

/// # Safety
/// Each phase sees immutable input and writes only its partition; its caller joins before using
/// the output as the next phase's input. All scratch offsets point to initialized world leases.
#[unsafe(no_mangle)]
unsafe extern "C" fn thin_film_thread_phase(
    job: &MatrixJob,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    let Some(partition) = NonZeroU64::new(parts as u64) else {
        return 1;
    };
    if part >= parts || job.parts != parts || stage > 2 || job.cols == 0 {
        return 1;
    }
    let grid = Grid {
        cols: job.cols,
        rows: job.n.checked_div(job.cols).unwrap_or(0),
        n: job.n,
        inv_dx: job.inv_dx,
    };
    let map = |part: usize| ((job.n as u64 * part as u64) / partition) as usize;
    let lo = map(part);
    let hi = map(part + 1);
    let count = (hi - lo) as f64;
    let work = &mut *job.work.add(part);
    match stage {
        0 => {
            for i in lo..hi {
                job.transpose_row(grid, i);
            }
            work.transpose_rows += count;
        }
        1 => {
            let mut i = lo;
            while i < hi {
                let x = i.checked_rem(job.cols).unwrap_or(0);
                if i + 1 < hi && x > 0 && x + 2 < job.cols {
                    job.pressure_pair(grid, i);
                    work.pressure_pairs += 1.0;
                    i += 2;
                } else {
                    job.pressure_row(grid, i);
                    i += 1;
                }
            }
            work.pressure_rows += count;
        }
        _ => {
            let factor = f64x2_splat(if job.contact.is_null() { job.dt } else { 1.0 });
            for i in lo..hi {
                job.gradient_row(grid, factor, i);
            }
            work.products += 1.0;
            work.gradient_faces += 2.0 * count;
            work.gradient_pairs += count;
        }
    }
    0
}
