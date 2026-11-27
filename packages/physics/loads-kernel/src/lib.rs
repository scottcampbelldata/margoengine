//! SEA-12 held body wrenches. A data-free SIMD module which imports the world arena.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_mul, memory_size, unreachable};

const INPUT_WORDS: usize = 32;
const OUTPUT_WORDS: usize = 6;

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

fn region_end(address: u32, rows: u32, words: usize, arena_bytes: u64) -> Option<u64> {
    let address = u64::from(address);
    let byte_len = u64::from(rows) * words as u64 * 8;
    let end = address + byte_len;
    (address > 0 && address % 8 == 0 && byte_len <= isize::MAX as u64 && end <= arena_bytes)
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
    if !(gravity.is_finite() && gravity >= 0.0) || count > force_rows {
        return -1;
    }
    if count == 0 {
        return 0;
    }
    let arena_bytes = memory_size::<0>() as u64 * 65_536;
    let Some(input_end) = region_end(scratch, count, INPUT_WORDS, arena_bytes) else {
        return -1;
    };
    let Some(output_end) = region_end(force_region, force_rows, OUTPUT_WORDS, arena_bytes) else {
        return -1;
    };
    if u64::from(scratch) < output_end && u64::from(force_region) < input_end {
        return -1;
    }

    let input_ptr = scratch as *const [f64; INPUT_WORDS];
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
        let wrench = hold(input, gravity);
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
