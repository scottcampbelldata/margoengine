#![no_std]
#![cfg(target_arch = "wasm32")]

use core::{
    arch::wasm32::{f64x2_extract_lane, f64x2_mul, f64x2_sub, v128, v128_load, v128_store},
    slice,
};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Job {
    input: *const f64,
    degree: *const f64,
    output: *mut f64,
    receipts: *mut u32,
    nx: usize,
    ny: usize,
    nz: usize,
    reserved: u32,
}

const _: () = assert!(core::mem::size_of::<Job>() == 32);

struct Rows {
    width: usize,
    height: usize,
    depth: usize,
    plane: usize,
}

impl Rows {
    fn neighbours(&self, row: usize) -> Option<[Option<usize>; 4]> {
        let j = row.checked_rem(self.height)?;
        let k = row.checked_div(self.height)?;
        let at = row * self.width;
        Some([
            (j > 0).then(|| at - self.width),
            (j + 1 < self.height).then(|| at + self.width),
            (k > 0).then(|| at - self.plane),
            (k + 1 < self.depth).then(|| at + self.plane),
        ])
    }
}

struct Stencil {
    input: *const f64,
    degree: *const f64,
    width: usize,
}

impl Stencil {
    // Positive homogeneous-Neumann Laplacian of the MAC pressure solve
    // (Harlow and Welch, 1965; Chorin, 1968). Each missing face drops its
    // neighbour. Preserve the canonical x, y, z arithmetic in both routes.
    unsafe fn one(&self, base: usize, i: usize, cross: [Option<usize>; 4]) -> f64 {
        unsafe {
            let at = base + i;
            let mut value = self.degree.add(at).read() * self.input.add(at).read();
            if i > 0 {
                value -= self.input.add(at - 1).read();
            }
            if i + 1 < self.width {
                value -= self.input.add(at + 1).read();
            }
            for other in cross.into_iter().flatten() {
                value -= self.input.add(other + i).read();
            }
            value
        }
    }

    // Both lanes are interior in X and share the same Y/Z wall conditions.
    unsafe fn pair(&self, base: usize, i: usize, cross: [Option<usize>; 4]) -> v128 {
        unsafe {
            let at = base + i;
            let from = |index| v128_load(self.input.add(index).cast());
            let diag = v128_load(self.degree.add(at).cast());
            let mut value = f64x2_mul(diag, from(at));
            value = f64x2_sub(value, from(at - 1));
            value = f64x2_sub(value, from(at + 1));
            for other in cross.into_iter().flatten() {
                value = f64x2_sub(value, from(other + i));
            }
            value
        }
    }

    unsafe fn row(
        &self,
        base: usize,
        result: &mut [f64],
        cross: [Option<usize>; 4],
    ) -> Option<usize> {
        let (left, rest) = result.split_first_mut()?;
        let value = unsafe { self.one(base, 0, cross) };
        if !value.is_finite() {
            return None;
        }
        *left = value;
        let Some((right, inner)) = rest.split_last_mut() else {
            return Some(0);
        };
        let mut pairs = inner.chunks_exact_mut(2);
        let paired = 2 * pairs.len();
        for (pair, output) in pairs.by_ref().enumerate() {
            let value = unsafe { self.pair(base, 1 + 2 * pair, cross) };
            if !(f64x2_extract_lane::<0>(value).is_finite()
                && f64x2_extract_lane::<1>(value).is_finite())
            {
                return None;
            }
            unsafe { v128_store(output.as_mut_ptr().cast(), value) };
        }
        if let Some(last) = pairs.into_remainder().first_mut() {
            let value = unsafe { self.one(base, paired + 1, cross) };
            if !value.is_finite() {
                return None;
            }
            *last = value;
        }
        let value = unsafe { self.one(base, self.width - 1, cross) };
        if !value.is_finite() {
            return None;
        }
        *right = value;
        Some(paired)
    }
}

unsafe fn apply(job: *const Job, part: u32, parts: u32) -> Option<()> {
    let job = unsafe { job.as_ref()? };
    if part >= parts
        || job.nx == 0
        || job.input.is_null()
        || job.degree.is_null()
        || job.output.is_null()
    {
        return None;
    }
    let height_depth = job.ny.checked_mul(job.nz)?;
    let cells = job.nx.checked_mul(height_depth)?;
    if cells == 0 || cells > isize::MAX as usize / size_of::<f64>() {
        return None;
    }
    let grid = Rows {
        width: job.nx,
        height: job.ny,
        depth: job.nz,
        plane: job.nx * job.ny,
    };
    let first = (u64::from(part) * height_depth as u64 / u64::from(parts)) as usize;
    let end = ((u64::from(part) + 1) * height_depth as u64 / u64::from(parts)) as usize;
    let stencil = Stencil {
        input: job.input,
        degree: job.degree,
        width: job.nx,
    };

    // The host gives the candidate output its own region. Every participant
    // borrows only its disjoint X rows, and inputs stay immutable to the join.
    let work = (end - first) * job.nx;
    let output = unsafe { slice::from_raw_parts_mut(job.output.add(first * job.nx), work) };
    let mut paired = 0;
    for (row, output) in (first..end).zip(output.chunks_exact_mut(job.nx)) {
        let cross = grid.neighbours(row)?;
        paired += unsafe { stencil.row(row * job.nx, output, cross)? };
    }
    if !job.receipts.is_null() {
        let receipt = unsafe { job.receipts.add(2 * part as usize) };
        unsafe {
            receipt.write(work as u32);
            receipt.add(1).write(paired as u32);
        }
    }
    Some(())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn cloud_projection_apply(job: *const Job) -> u32 {
    u32::from(unsafe { apply(job, 0, 1) }.is_none())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn cloud_projection_thread_phase(
    job: *const Job,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    if stage != 0 {
        return 1;
    }
    u32::from(unsafe { apply(job, part, parts) }.is_none())
}
