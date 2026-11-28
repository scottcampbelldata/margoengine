#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

const ONE: i32 = 65536;

#[derive(Clone, Copy)]
struct Table {
    x: *mut i32,
    z: *mut i32,
    heads: *mut i32,
    mask: usize,
}

impl Table {
    // Each populated bucket owns a distinct cartesian grid cell. An occupancy at most one-half guarantees a free bucket.
    #[inline]
    unsafe fn slot(self, x: i32, z: i32) -> usize {
        let mut i = ((x as u32).wrapping_mul(0x8da6b343) ^ (z as u32).wrapping_mul(0xd8163841))
            as usize
            & self.mask;
        unsafe {
            while *self.heads.add(i) >= 0 && (*self.x.add(i) != x || *self.z.add(i) != z) {
                i = (i + 1) & self.mask;
            }
        }
        i
    }
}

#[inline]
fn floor_cell(position: i32, cell: u32) -> i32 {
    let distance = position.unsigned_abs();
    // Caller establishes the positive denominator; positions are centimetres within 100 km.
    let q = distance / cell;
    if position < 0 {
        -(q as i32) - i32::from(distance % cell != 0)
    } else {
        q as i32
    }
}

#[inline]
fn integral_root(squared: u64, root: f64) -> i32 {
    let mut distance = root as u64;
    if distance * distance > squared {
        distance -= 1;
    }
    distance as i32
}

#[inline]
fn overlap(reach: u32, distance: i32, diameter: u32) -> i32 {
    let depth = reach - distance as u32;
    // A crown covering at least this diameter already reaches the final Q16 saturation.
    if depth >= diameter {
        return ONE;
    }
    (u64::from(depth) * u64::from(ONE as u32) / u64::from(diameter)) as i32
}

#[inline]
fn pair(squared: [u64; 2], reaches: [u32; 2], diameter: u32) -> i32 {
    use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_sqrt};
    let distances = f64x2_sqrt(f64x2(squared[0] as f64, squared[1] as f64));
    overlap(
        reaches[0],
        integral_root(squared[0], f64x2_extract_lane::<0>(distances)),
        diameter,
    ) + overlap(
        reaches[1],
        integral_root(squared[1], f64x2_extract_lane::<1>(distances)),
        diameter,
    )
}

#[derive(Clone, Copy)]
struct Population {
    x: *const i32,
    z: *const i32,
    radius: *const i32,
    death: *const i32,
    id: *const i32,
}

impl Population {
    unsafe fn get(rows: *const i32, capacity: usize) -> Self {
        unsafe {
            Self {
                x: rows,
                z: rows.add(capacity),
                radius: rows.add(2 * capacity),
                death: rows.add(4 * capacity),
                id: rows.add(6 * capacity),
            }
        }
    }
}

struct Neighbours {
    next: *mut i32,
    table: Table,
    size: usize,
}

impl Neighbours {
    unsafe fn get(scratch: *mut i32, capacity: usize, size: usize) -> Self {
        unsafe {
            Self {
                next: scratch,
                table: Table {
                    heads: scratch.add(capacity),
                    x: scratch.add(capacity + size),
                    z: scratch.add(capacity + 2 * size),
                    mask: size - 1,
                },
                size,
            }
        }
    }

    unsafe fn prepare(&self, trees: Population, n: usize, cell: u32) {
        unsafe {
            core::ptr::write_bytes(self.table.heads, 255, self.size);
            for i in 0..n {
                if *trees.death.add(i) >= 0 {
                    continue;
                }
                let cx = floor_cell(*trees.x.add(i), cell);
                let cz = floor_cell(*trees.z.add(i), cell);
                let at = self.table.slot(cx, cz);
                *self.table.x.add(at) = cx;
                *self.table.z.add(at) = cz;
                *self.next.add(i) = *self.table.heads.add(at);
                *self.table.heads.add(at) = i as i32;
            }
        }
    }

    unsafe fn queries<const MEASURE: bool>(
        &self,
        population: Population,
        shade: *mut i32,
        first: usize,
        end: usize,
        cell: u32,
        work: &mut Work,
    ) {
        let Population {
            x,
            z,
            radius,
            death,
            id,
        } = population;
        let table = self.table;
        unsafe {
            for i in first..end {
                *shade.add(i) = 0;
                if *death.add(i) >= 0 {
                    continue;
                }
                let xi = *x.add(i);
                let zi = *z.add(i);
                let ri = *radius.add(i);
                let older = *id.add(i);
                if ri <= 0 {
                    continue;
                }
                if MEASURE {
                    work.live_queries += 1.0;
                }
                let cx = floor_cell(xi, cell);
                let cz = floor_cell(zi, cell);
                let mut covered = 0;
                let mut pending = 0;
                let mut prior = 0;
                let diameter = 2 * ri as u32;
                'cells: for dz in -1..=1 {
                    for dx in -1..=1 {
                        let mut cursor = *table.heads.add(table.slot(cx + dx, cz + dz));
                        while cursor >= 0 {
                            let j = cursor as usize;
                            cursor = *self.next.add(j);
                            if MEASURE {
                                work.candidate_visits += 1.0;
                            }
                            let rj = *radius.add(j);
                            if j == i || rj < ri || (rj == ri && *id.add(j) > older) {
                                continue;
                            }
                            let ex = i64::from(*x.add(j) - xi);
                            let ez = i64::from(*z.add(j) - zi);
                            let reach = (ri + rj) as u32;
                            // Adjacent table cells bound squared mm distances within binary64 integer precision.
                            let squared = (ex * ex + ez * ez) as u64 * 100;
                            if squared >= u64::from(reach) * u64::from(reach) {
                                continue;
                            }
                            if MEASURE {
                                work.overlaps += 1.0;
                            }
                            if pending == 0 {
                                pending = reach;
                                prior = squared;
                                continue;
                            }
                            covered += pair([prior, squared], [pending, reach], diameter);
                            if MEASURE {
                                work.paired_overlaps += 2.0;
                            }
                            pending = 0;
                            if covered >= ONE {
                                break 'cells;
                            }
                        }
                    }
                }
                if pending != 0 {
                    // The unpaired final crown needs only one lane.
                    covered += pair([prior, 0], [pending, 0], diameter);
                }
                *shade.add(i) = covered.min(ONE);
            }
        }
    }
}

#[repr(C)]
#[derive(Default)]
struct Work {
    trees: f64,
    live_queries: f64,
    candidate_visits: f64,
    overlaps: f64,
    paired_overlaps: f64,
}

/// Finds Q16 crown cover with the same older-tree tie-breaker and overlap depth as the offline ecosystem.
/// # Safety
/// All pointers must refer to separate valid word-aligned regions. Population: seven capacity-wide columns.
/// Output: n words, with n <= capacity. Scratch: capacity plus three times table_size words. table_size is a
/// power of two and at least twice capacity. Radii are at least 1 mm. No pointers survive this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn forest_shade(
    population: *const i32,
    shade: *mut i32,
    scratch: *mut i32,
    capacity: usize,
    n: usize,
    table_size: usize,
    cell: u32,
) {
    if cell == 0 || table_size == 0 {
        return;
    }
    unsafe {
        let table = Neighbours::get(scratch, capacity, table_size);
        let trees = Population::get(population, capacity);
        table.prepare(trees, n, cell);
        table.queries::<false>(trees, shade, 0, n, cell, &mut Work::default());
    }
}

#[repr(C)]
struct Job {
    population: *const i32,
    shade: *mut i32,
    scratch: *mut i32,
    capacity: usize,
    count: usize,
    table_size: usize,
    cell: u32,
    work: *mut Work,
}

const _: [(); 32] = [(); size_of::<Job>()];

fn well_sized(job: &Job) -> bool {
    let max_words = isize::MAX as usize / size_of::<i32>();
    let scratch_words = job
        .table_size
        .checked_mul(3)
        .and_then(|words| words.checked_add(job.capacity));
    job.capacity <= max_words / 7
        && job.count <= job.capacity
        && job.table_size.is_power_of_two()
        && job.table_size >= 2 * job.capacity
        && job.cell != 0
        && scratch_words.is_some_and(|words| words <= max_words)
}

/// Build the table in original tree order before the read-only query phase.
#[unsafe(no_mangle)]
unsafe extern "C" fn forest_prepare(job: &Job) -> u32 {
    if !well_sized(job) {
        return 1;
    }
    unsafe {
        let table = Neighbours::get(job.scratch, job.capacity, job.table_size);
        table.prepare(
            Population::get(job.population, job.capacity),
            job.count,
            job.cell,
        );
    }
    0
}

/// Read the same completed table and write only this participant's Q16 tree rows.
#[unsafe(no_mangle)]
unsafe extern "C" fn forest_shade_phase(job: &Job, part: usize, parts: usize) -> u32 {
    if !well_sized(job) || !matches!(parts, 1 | 2 | 4) || part >= parts {
        return 1;
    }
    let first = part * job.count / parts;
    let end = (part + 1) * job.count / parts;
    let mut work = Work {
        trees: (end - first) as f64,
        ..Work::default()
    };
    unsafe {
        let table = Neighbours::get(job.scratch, job.capacity, job.table_size);
        let trees = Population::get(job.population, job.capacity);
        table.queries::<true>(trees, job.shade, first, end, job.cell, &mut work);
        job.work.add(part).write(work);
    }
    0
}
