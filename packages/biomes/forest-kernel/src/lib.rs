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
    (u64::from(reach - distance as u32) * u64::from(ONE as u32) / u64::from(diameter)) as i32
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
        let next = scratch;
        let table = Table {
            heads: scratch.add(capacity),
            x: scratch.add(capacity + table_size),
            z: scratch.add(capacity + 2 * table_size),
            mask: table_size - 1,
        };
        let x = population;
        let z = population.add(capacity);
        let radius = population.add(2 * capacity);
        let death = population.add(4 * capacity);
        let id = population.add(6 * capacity);
        core::ptr::write_bytes(table.heads, 255, table_size);

        for i in 0..n {
            if *death.add(i) >= 0 {
                continue;
            }
            let cx = floor_cell(*x.add(i), cell);
            let cz = floor_cell(*z.add(i), cell);
            let at = table.slot(cx, cz);
            *table.x.add(at) = cx;
            *table.z.add(at) = cz;
            *next.add(i) = *table.heads.add(at);
            *table.heads.add(at) = i as i32;
        }
        for i in 0..n {
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
                        cursor = *next.add(j);
                        let rj = *radius.add(j);
                        if j == i || rj < ri || (rj == ri && *id.add(j) > older) {
                            continue;
                        }
                        let ex = i64::from(*x.add(j) - xi);
                        let ez = i64::from(*z.add(j) - zi);
                        let reach = (ri + rj) as u32;
                        // Exact mm² overlap test before taking square roots. An adjacent pair of grid cells
                        // bounds the differences within 16,002 cm per axis, well inside binary64 integer precision.
                        let squared = (ex * ex + ez * ez) as u64 * 100;
                        if squared >= u64::from(reach) * u64::from(reach) {
                            continue;
                        }
                        if pending == 0 {
                            pending = reach;
                            prior = squared;
                            continue;
                        }
                        covered += pair([prior, squared], [pending, reach], diameter);
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
