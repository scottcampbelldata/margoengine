//! SEA-12 held body wrenches. A data-free SIMD module which imports the world arena.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_mul, memory_size, unreachable};

const INPUT_WORDS: usize = 32;
const COUPLED_WORDS: usize = INPUT_WORDS + 9;
const OUTPUT_WORDS: usize = 6;
const MOBILITY_WORDS: usize = 9;

#[panic_handler]
fn trap(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

/// Two independent products run in SIMD. Do not reassociate the scalar sum or use a fused multiply-add.
#[inline]
fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    let products = f64x2_mul(f64x2(a[0], a[1]), f64x2(b[0], b[1]));
    (f64x2_extract_lane::<0>(products) + f64x2_extract_lane::<1>(products)) + a[2] * b[2]
}

#[inline]
fn solve(matrix: [f64; 9], vector: [f64; 3]) -> [f64; 3] {
    let [a, b, c, d, e, f, g, h, i] = matrix;
    let first = e * i - f * h;
    let second = -(d * i - f * g);
    let third = d * h - e * g;
    let determinant = (a * first + b * second) + c * third;
    [
        dot3(
            [
                first / determinant,
                -(b * i - c * h) / determinant,
                (b * f - c * e) / determinant,
            ],
            vector,
        ),
        dot3(
            [
                second / determinant,
                (a * i - c * g) / determinant,
                -(a * f - c * d) / determinant,
            ],
            vector,
        ),
        dot3(
            [
                third / determinant,
                -(a * h - b * g) / determinant,
                (a * e - b * d) / determinant,
            ],
            vector,
        ),
    ]
}

/// One element of (I + added rotational inertia * dry world inverse inertia).
#[inline]
fn angular_element(diagonal: f64, added: [f64; 3], mobility: [f64; 3]) -> f64 {
    let products = f64x2_mul(f64x2(added[0], added[1]), f64x2(mobility[0], mobility[1]));
    ((diagonal + f64x2_extract_lane::<0>(products)) + f64x2_extract_lane::<1>(products))
        + added[2] * mobility[2]
}

#[inline]
fn hold(input: &[f64; INPUT_WORDS], gravity: f64) -> [f64; OUTPUT_WORDS] {
    let m = input[1];
    let weight = -m * gravity;
    let translation = solve(
        [
            m + input[8],
            input[9],
            input[10],
            input[11],
            m + input[12],
            input[13],
            input[14],
            input[15],
            m + input[16],
        ],
        [input[2] + 0.0, input[3] + weight, input[4] + 0.0],
    );
    let mut torque = [input[5], input[6], input[7]];
    let a = [input[17], input[18], input[19]];
    let b = [input[20], input[21], input[22]];
    let c = [input[23], input[24], input[25]];
    if a != [0.0; 3] || b != [0.0; 3] || c != [0.0; 3] {
        let [xx, xy, xz, yy, yz, zz] = [
            input[26], input[27], input[28], input[29], input[30], input[31],
        ];
        let u = [xx, xy, xz];
        let v = [xy, yy, yz];
        let w = [xz, yz, zz];
        torque = solve(
            [
                angular_element(1.0, a, u),
                angular_element(0.0, a, v),
                angular_element(0.0, a, w),
                angular_element(0.0, b, u),
                angular_element(1.0, b, v),
                angular_element(0.0, b, w),
                angular_element(0.0, c, u),
                angular_element(0.0, c, v),
                angular_element(1.0, c, w),
            ],
            torque,
        );
    }
    [
        m * translation[0] - 0.0,
        m * translation[1] - weight,
        m * translation[2] - 0.0,
        torque[0],
        torque[1],
        torque[2],
    ]
}

/// Forms (I + A M_dry^-1) in wrench space. The last nine input words are
/// the translation-to-rotation block of the symmetric added inertia A.
fn hold_coupled(input: &[f64; COUPLED_WORDS], gravity: f64, axes: [bool; 3]) -> [f64; OUTPUT_WORDS] {
    let [xx, xy, xz, yy, yz, zz] = [
        input[26], input[27], input[28], input[29], input[30], input[31],
    ];
    let angular_mobility = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
    let mass = input[1];
    let inverse_mass = axes.map(|free| if free { 1.0 / mass } else { 0.0 });
    let weight = -mass * gravity;
    let mut system = [[0.0; 7]; 6];
    for (row, equation) in system.iter_mut().enumerate() {
        let (linear, angular) = if row < 3 {
            (block_row(input, 8, row), block_row(input, INPUT_WORDS, row))
        } else {
            let at = INPUT_WORDS + row - 3;
            (
                [input[at], input[at + 3], input[at + 6]],
                block_row(input, 17, row - 3),
            )
        };
        for col in 0..3 {
            let linear_diagonal = if row == col { 1.0 } else { 0.0 };
            let angular_diagonal = if row == col + 3 { 1.0 } else { 0.0 };
            equation[col] = linear_diagonal + linear[col] * inverse_mass[col];
            equation[col + 3] = angular_element(angular_diagonal, angular, angular_mobility[col]);
        }
        equation[6] = input[2 + row] + if row == 1 { weight } else { 0.0 };
    }
    let mut held = solve_coupled(system);
    held[1] -= weight;
    held
}

#[inline]
fn block_row(input: &[f64; COUPLED_WORDS], offset: usize, row: usize) -> [f64; 3] {
    let start = offset + 3 * row;
    [input[start], input[start + 1], input[start + 2]]
}

fn solve_coupled(mut system: [[f64; 7]; 6]) -> [f64; 6] {
    for k in 0..6 {
        let mut pivot = k;
        for row in k + 1..6 {
            if system[row][k].abs() > system[pivot][k].abs() {
                pivot = row;
            }
        }
        let diagonal = system[pivot][k];
        if diagonal == 0.0 || !diagonal.is_finite() {
            return [f64::NAN; 6];
        }
        system.swap(pivot, k);
        let top = system[k];
        for row in system.iter_mut().skip(k + 1) {
            let multiplier = row[k] / diagonal;
            for column in k + 1..7 {
                row[column] -= multiplier * top[column];
            }
        }
    }
    let mut solution = [0.0; 6];
    for k in (0..6).rev() {
        let mut rhs = system[k][6];
        for j in k + 1..6 {
            rhs -= system[k][j] * solution[j];
        }
        solution[k] = rhs / system[k][k];
    }
    solution
}

fn region_end(address: u32, rows: u32, words: usize, word_bytes: u64, arena_bytes: u64) -> Option<u64> {
    let address = u64::from(address);
    let byte_len = u64::from(rows) * words as u64 * word_bytes;
    let end = address + byte_len;
    (address > 0 && address % word_bytes == 0 && byte_len <= isize::MAX as u64 && end <= arena_bytes)
        .then_some(end)
}

/// Adds the held wrench of each input to its selected output row. Return zero on success, -1 for the
/// argument envelope, or the one-based input index of a row with an invalid address or nonfinite arithmetic.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn loads_hold(
    scratch: u32,
    count: u32,
    force_region: u32,
    force_rows: u32,
    gravity: f64,
) -> i32 {
    hold_rows(scratch, count, force_region, force_rows, gravity, None, |input, gravity, _| hold(input, gravity))
}

/// Adds held wrenches with all six motions coupled. The input has the legacy
/// 32 words followed by the nine cross-inertia words in row-major order.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn loads_hold_coupled(
    scratch: u32,
    count: u32,
    force_region: u32,
    force_rows: u32,
    gravity: f64,
) -> i32 {
    hold_rows(
        scratch,
        count,
        force_region,
        force_rows,
        gravity,
        None,
        hold_coupled,
    )
}

/// Uses the linear free axes from the layout-1 f32 rigid mobility port. The packed input still holds
/// 41 words, with the six projected angular entries already copied into the dry inertia slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn loads_hold_coupled_mobility(
    scratch: u32,
    count: u32,
    force_region: u32,
    force_rows: u32,
    gravity: f64,
    mobility: u32,
) -> i32 {
    hold_rows(scratch, count, force_region, force_rows, gravity, Some(mobility), hold_coupled)
}

fn hold_rows<const WORDS: usize>(
    scratch: u32,
    count: u32,
    force_region: u32,
    force_rows: u32,
    gravity: f64,
    mobility: Option<u32>,
    solve: impl Fn(&[f64; WORDS], f64, [bool; 3]) -> [f64; OUTPUT_WORDS],
) -> i32 {
    if !(gravity.is_finite() && gravity >= 0.0) || count > force_rows {
        return -1;
    }
    if count == 0 {
        return 0;
    }
    let arena_bytes = memory_size::<0>() as u64 * 65_536;
    let Some(input_end) = region_end(scratch, count, WORDS, 8, arena_bytes) else {
        return -1;
    };
    let Some(output_end) = region_end(force_region, force_rows, OUTPUT_WORDS, 8, arena_bytes) else {
        return -1;
    };
    if u64::from(scratch) < output_end && u64::from(force_region) < input_end {
        return -1;
    }
    let mobility = if let Some(address) = mobility {
        let Some(end) = region_end(address, force_rows, MOBILITY_WORDS, 4, arena_bytes) else {
            return -1;
        };
        if u64::from(address) < output_end && u64::from(force_region) < end {
            return -1;
        }
        Some(address as *const [f32; MOBILITY_WORDS])
    } else {
        None
    };

    let input_ptr = scratch as *const [f64; WORDS];
    let output_ptr = force_region as *mut [f64; OUTPUT_WORDS];
    for index in 0..count {
        // The rectangular regions were checked above, and the selected row is validated before writing it.
        let input = unsafe { &*input_ptr.add(index as usize) };
        let row = input[0] as u32;
        if input[0] != f64::from(row)
            || row >= force_rows
            || input[1] <= 0.0
            || input.iter().any(|value| !value.is_finite())
        {
            return index as i32 + 1;
        }
        let axes = if let Some(mobility) = mobility {
            let response = unsafe { &*mobility.add(row as usize) };
            let linear = [response[0], response[1], response[2]];
            if linear.iter().any(|value| !value.is_finite() || *value < 0.0) {
                return index as i32 + 1;
            }
            linear.map(|value| value > 0.0)
        } else {
            [true; 3]
        };
        let wrench = solve(input, gravity, axes);
        let output = unsafe { &mut *output_ptr.add(row as usize) };
        let next = [
            output[0] + wrench[0],
            output[1] + wrench[1],
            output[2] + wrench[2],
            output[3] + wrench[3],
            output[4] + wrench[4],
            output[5] + wrench[5],
        ];
        if next.iter().any(|value| !value.is_finite()) {
            return index as i32 + 1;
        }
        *output = next;
    }
    0
}
