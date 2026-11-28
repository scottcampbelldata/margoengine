#![no_std]

use core::arch::wasm32::{f64x2, f64x2_add, v128_load, v128_store};
use core::ptr;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Source {
    x: i32,
    y: i32,
    z: i32,
    amount: f64,
}

#[repr(C)]
#[derive(Default)]
struct Work {
    sources: f64,
    rows: f64,
    additions: f64,
    paired_additions: f64,
}

struct Grid {
    data: *mut f64,
    nx: i32,
    ny: i32,
}

impl Grid {
    // A participant owns whole X rows. Clip the endpoints of that interval at
    // each pyramid layer, retaining the original ordered additions at each cell.
    unsafe fn deposit<const MEASURE: bool>(
        &self,
        source: &Source,
        depth: i32,
        transmission: f64,
        first: i32,
        end: i32,
        work: &mut Work,
    ) {
        let first_z = first / self.ny;
        let last_z = (end - 1) / self.ny;
        let depth = depth.min(source.y);
        if source.z + depth < first_z || source.z - depth > last_z {
            return;
        }
        let mut amount = source.amount;
        let mut visited = false;
        for d in 0..=depth {
            let layer = source.y - d;
            let x0 = (source.x - d).max(0);
            let x1 = (source.x + d).min(self.nx - 1);
            let z0 = (source.z - d).max(first_z + i32::from(layer < first % self.ny));
            let z1 = (source.z + d).min(last_z - i32::from(layer > (end - 1) % self.ny));
            let wide = f64x2(amount, amount);
            for row in z0..=z1 {
                let offset = (row * self.ny + layer) * self.nx;
                let mut column = x0;
                while column < x1 {
                    // X is contiguous. Vector stores preserve the ordered sum per target voxel.
                    let cell = unsafe { self.data.add((offset + column) as usize) }.cast();
                    unsafe { v128_store(cell, f64x2_add(v128_load(cell), wide)) };
                    column += 2;
                }
                if column == x1 {
                    let cell = unsafe { self.data.add((offset + column) as usize) };
                    unsafe { *cell += amount };
                }
            }
            if MEASURE && z0 <= z1 {
                let rows = (z1 - z0 + 1) as f64;
                let width = x1 - x0 + 1;
                visited = true;
                work.rows += rows;
                work.additions += rows * width as f64;
                work.paired_additions += rows * (width & !1) as f64;
            }
            // Repeated multiplication is intentionally kept even for clipped layers.
            amount *= transmission;
        }
        if MEASURE && visited {
            work.sources += 1.0;
        }
    }
}

/// Deposit one source over the whole grid, keeping the original ABI.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deposit_shadow(
    grid: *mut f64,
    nx: i32,
    ny: i32,
    nz: i32,
    x: i32,
    y: i32,
    z: i32,
    depth: i32,
    strength: f64,
    transmission: f64,
) {
    if ny <= 0 || nz <= 0 {
        return;
    }
    unsafe {
        Grid { data: grid, nx, ny }.deposit::<false>(
            &Source {
                x,
                y,
                z,
                amount: strength,
            },
            depth,
            transmission,
            0,
            ny * nz,
            &mut Work::default(),
        )
    };
}

#[repr(C)]
struct ShadowJob {
    grid: *mut f64,
    sources: *const Source,
    nx: i32,
    ny: i32,
    nz: i32,
    count: usize,
    depth: i32,
    work: *mut Work,
    transmission: f64,
}

const _: [(); 24] = [(); size_of::<Source>()];
const _: [(); 40] = [(); size_of::<ShadowJob>()];

#[unsafe(no_mangle)]
unsafe extern "C" fn growth_shadow_phase(job: &ShadowJob, part: u32, parts: u32) -> u32 {
    if !matches!(parts, 1 | 2 | 4)
        || part >= parts
        || job.nx < 1
        || job.ny < 1
        || job.nz < 1
        || job.depth < 0
        || job.depth >= job.ny
        || !(0.0..=1.0).contains(&job.transmission)
        || job.count > isize::MAX as usize / size_of::<Source>()
    {
        return 1;
    }
    let Some(rows) = job.ny.checked_mul(job.nz) else {
        return 1;
    };
    let Some(cells) = rows.checked_mul(job.nx) else {
        return 1;
    };
    if cells as usize > isize::MAX as usize / size_of::<f64>() {
        return 1;
    }
    let first = (part * rows as u32 / parts) as i32;
    let end = ((part + 1) * rows as u32 / parts) as i32;
    let grid = Grid {
        data: job.grid,
        nx: job.nx,
        ny: job.ny,
    };
    let mut work = Work::default();
    unsafe {
        if first < end {
            ptr::write_bytes(
                grid.data.add((first * job.nx) as usize),
                0,
                ((end - first) * job.nx) as usize,
            );
            for n in 0..job.count {
                let source = &*job.sources.add(n);
                if !(0..job.nx).contains(&source.x)
                    || !(0..job.ny).contains(&source.y)
                    || !(0..job.nz).contains(&source.z)
                    || !(0.0..=1.0).contains(&source.amount)
                {
                    return 1;
                }
                grid.deposit::<true>(source, job.depth, job.transmission, first, end, &mut work);
            }
        }
        job.work.add(part as usize).write(work);
    }
    0
}
