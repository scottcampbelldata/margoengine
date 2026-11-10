//! Integer inverse transforms. Every rounding point and clamp is defined by AV1 section 7.13.
use crate::tables::COS128_LOOKUP;
use crate::{Error, Result};

pub const WIDTHS: [usize; 19] = [
    4, 8, 16, 32, 64, 4, 8, 8, 16, 16, 32, 32, 64, 4, 16, 8, 32, 16, 64,
];
pub const HEIGHTS: [usize; 19] = [
    4, 8, 16, 32, 64, 8, 4, 16, 8, 32, 16, 64, 32, 16, 4, 32, 8, 64, 16,
];
const ROW_SHIFT: [u32; 19] = [0, 1, 2, 2, 2, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2];

/// The sixteen AV1 transform types, in normative bitstream order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Tx {
    DctDct,
    AdstDct,
    DctAdst,
    AdstAdst,
    FlipadstDct,
    DctFlipadst,
    FlipadstFlipadst,
    AdstFlipadst,
    FlipadstAdst,
    Identity,
    VDct,
    HDct,
    VAdst,
    HAdst,
    VFlipadst,
    HFlipadst,
}
impl Tx {
    /// Row and column kernel: DCT=0, ADST=1, identity=2.
    fn kernels(self) -> (u8, u8) {
        match self {
            Self::DctDct => (0, 0),
            Self::AdstDct | Self::FlipadstDct => (0, 1),
            Self::DctAdst | Self::DctFlipadst => (1, 0),
            Self::AdstAdst | Self::FlipadstFlipadst | Self::AdstFlipadst | Self::FlipadstAdst => {
                (1, 1)
            }
            Self::Identity => (2, 2),
            Self::VDct => (2, 0),
            Self::HDct => (0, 2),
            Self::VAdst | Self::VFlipadst => (2, 1),
            Self::HAdst | Self::HFlipadst => (1, 2),
        }
    }
    pub fn flips(self) -> (bool, bool) {
        (
            matches!(
                self,
                Self::DctFlipadst | Self::FlipadstFlipadst | Self::AdstFlipadst | Self::HFlipadst
            ),
            matches!(
                self,
                Self::FlipadstDct | Self::FlipadstFlipadst | Self::FlipadstAdst | Self::VFlipadst
            ),
        )
    }
}
pub fn round(value: i64, shift: u32) -> i32 {
    if shift == 0 {
        value as i32
    } else {
        ((value + (1 << (shift - 1))) >> shift) as i32
    }
}
pub fn round_signed(value: i64, shift: u32) -> i32 {
    if value < 0 {
        -round(-value, shift)
    } else {
        round(value, shift)
    }
}
fn cos(angle: i32) -> i64 {
    let n = angle & 255;
    match n {
        0..=64 => COS128_LOOKUP[n as usize] as i64,
        65..=128 => -COS128_LOOKUP[(128 - n) as usize] as i64,
        129..=192 => -COS128_LOOKUP[(n - 128) as usize] as i64,
        _ => COS128_LOOKUP[(256 - n) as usize] as i64,
    }
}
fn reverse(value: usize, count: u32) -> usize {
    value.reverse_bits() >> (usize::BITS - count)
}
struct Network<'a> {
    data: &'a mut [i32],
    precision: u32,
    valid: bool,
}
impl Network<'_> {
    fn rotation(&mut self, a: usize, b: usize, angle: i32, swap: bool) {
        let c = cos(angle);
        let s = cos(angle - 64);
        let x = self.data[a] as i64;
        let y = self.data[b] as i64;
        let first = round(x * c - y * s, 12);
        let second = round(x * s + y * c, 12);
        let limit = 1_i64 << (self.precision - 1);
        self.valid &= [first, second]
            .iter()
            .all(|v| (*v as i64) >= -limit && (*v as i64) < limit);
        self.data[a] = if swap { second } else { first };
        self.data[b] = if swap { first } else { second };
    }
    fn sumdiff(&mut self, a: usize, b: usize, swap: bool) {
        let (a, b) = if swap { (b, a) } else { (a, b) };
        let x = self.data[a] as i64;
        let y = self.data[b] as i64;
        let limit = 1_i64 << (self.precision - 1);
        self.data[a] = (x + y).clamp(-limit, limit - 1) as i32;
        self.data[b] = (x - y).clamp(-limit, limit - 1) as i32;
    }
}

pub fn dct(data: &mut [i32], precision: u32) -> Result<()> {
    let size = data.len();
    if ![4, 8, 16, 32, 64].contains(&size) || !(16..=20).contains(&precision) {
        return Err(Error::Invalid);
    }
    let copy = data.to_vec();
    let n = size.trailing_zeros();
    for (i, value) in data.iter_mut().enumerate() {
        *value = copy[reverse(i, n)];
    }
    let mut net = Network {
        data,
        precision,
        valid: true,
    };
    // Each stage exposes the next pair of odd-frequency subspaces, then merges
    // the already reconstructed even-frequency subspace with Hadamard butterflies.
    if n == 6 {
        for i in 0..16 {
            net.rotation(32 + i, 63 - i, 63 - 4 * reverse(i, 4) as i32, false);
        }
    }
    if n >= 5 {
        for i in 0..8 {
            net.rotation(16 + i, 31 - i, 6 + 8 * reverse(7 - i, 3) as i32, false);
        }
    }
    if n == 6 {
        for i in 0..16 {
            net.sumdiff(32 + 2 * i, 33 + 2 * i, i & 1 != 0);
        }
    }
    if n >= 4 {
        for i in 0..4 {
            net.rotation(8 + i, 15 - i, 12 + 16 * reverse(3 - i, 2) as i32, false);
        }
    }
    if n >= 5 {
        for i in 0..8 {
            net.sumdiff(16 + 2 * i, 17 + 2 * i, i & 1 != 0);
        }
    }
    if n == 6 {
        for i in 0..4 {
            for j in 0..2 {
                net.rotation(
                    62 - 4 * i - j,
                    33 + 4 * i + j,
                    60 - 16 * reverse(i, 2) as i32 + 64 * j as i32,
                    true,
                );
            }
        }
    }
    if n >= 3 {
        for i in 0..2 {
            net.rotation(4 + i, 7 - i, 56 - 32 * i as i32, false);
        }
    }
    if n >= 4 {
        for i in 0..4 {
            net.sumdiff(8 + 2 * i, 9 + 2 * i, i & 1 != 0);
        }
    }
    if n >= 5 {
        for i in 0..2 {
            for j in 0..2 {
                net.rotation(
                    30 - 4 * i - j,
                    17 + 4 * i + j,
                    56 - 32 * i as i32 + 64 * j as i32,
                    true,
                );
            }
        }
    }
    if n == 6 {
        for i in 0..8 {
            for j in 0..2 {
                net.sumdiff(32 + 4 * i + j, 35 + 4 * i - j, i & 1 != 0);
            }
        }
    }
    net.rotation(0, 1, 32, true);
    net.rotation(2, 3, 48, false);
    if n >= 3 {
        net.sumdiff(4, 5, false);
        net.sumdiff(6, 7, true);
    }
    if n >= 4 {
        net.rotation(14, 9, 48, true);
        net.rotation(13, 10, 112, true);
    }
    if n >= 5 {
        for i in 0..4 {
            for j in 0..2 {
                net.sumdiff(16 + 4 * i + j, 19 + 4 * i - j, i & 1 != 0);
            }
        }
    }
    if n == 6 {
        for i in 0..2 {
            for j in 0..4 {
                net.rotation(
                    61 - 8 * i - j,
                    34 + 8 * i + j,
                    56 - 32 * i as i32 + 64 * (j / 2) as i32,
                    true,
                );
            }
        }
    }
    net.sumdiff(0, 3, false);
    net.sumdiff(1, 2, false);
    if n >= 3 {
        net.rotation(6, 5, 32, true);
    }
    if n >= 4 {
        for i in 0..2 {
            for j in 0..2 {
                net.sumdiff(8 + 4 * i + j, 11 + 4 * i - j, i != 0);
            }
        }
    }
    if n >= 5 {
        for i in 0..4 {
            net.rotation(29 - i, 18 + i, 48 + (i / 2) as i32 * 64, true);
        }
    }
    if n == 6 {
        for i in 0..4 {
            for j in 0..4 {
                net.sumdiff(32 + 8 * i + j, 39 + 8 * i - j, i & 1 != 0);
            }
        }
    }
    if n >= 3 {
        for i in 0..4 {
            net.sumdiff(i, 7 - i, false);
        }
    }
    if n >= 4 {
        for i in 0..2 {
            net.rotation(13 - i, 10 + i, 32, true);
        }
    }
    if n >= 5 {
        for i in 0..2 {
            for j in 0..4 {
                net.sumdiff(16 + 8 * i + j, 23 + 8 * i - j, i != 0);
            }
        }
    }
    if n == 6 {
        for i in 0..8 {
            net.rotation(59 - i, 36 + i, if i < 4 { 48 } else { 112 }, true);
        }
    }
    if n >= 4 {
        for i in 0..8 {
            net.sumdiff(i, 15 - i, false);
        }
    }
    if n >= 5 {
        for i in 0..4 {
            net.rotation(27 - i, 20 + i, 32, true);
        }
    }
    if n == 6 {
        for i in 0..8 {
            net.sumdiff(32 + i, 47 - i, false);
            net.sumdiff(48 + i, 63 - i, true);
        }
    }
    if n >= 5 {
        for i in 0..16 {
            net.sumdiff(i, 31 - i, false);
        }
    }
    if n == 6 {
        for i in 0..8 {
            net.rotation(55 - i, 40 + i, 32, true);
        }
        for i in 0..32 {
            net.sumdiff(i, 63 - i, false);
        }
    }
    if net.valid {
        Ok(())
    } else {
        Err(Error::Invalid)
    }
}

pub fn adst(data: &mut [i32], precision: u32) -> Result<()> {
    let size = data.len();
    if ![4, 8, 16].contains(&size) || !(16..=20).contains(&precision) {
        return Err(Error::Invalid);
    }
    if size == 4 {
        let a = data[0] as i64;
        let b = data[1] as i64;
        let c = data[2] as i64;
        let d = data[3] as i64;
        let first = 1321 * a + 3803 * c + 2482 * d;
        let second = 2482 * a - 1321 * c - 3803 * d;
        let shared = 3344 * b;
        data.copy_from_slice(&[
            round(first + shared, 12),
            round(second + shared, 12),
            round(3344 * (a - c + d), 12),
            round(first + second - shared, 12),
        ]);
        return Ok(());
    }
    let copy = data.to_vec();
    for i in 0..size {
        data[i] = copy[if i & 1 != 0 { i - 1 } else { size - i - 1 }];
    }
    let mut net = Network {
        data,
        precision,
        valid: true,
    };
    if size == 8 {
        for i in 0..4 {
            net.rotation(2 * i, 2 * i + 1, 60 - 16 * i as i32, true);
        }
        for i in 0..4 {
            net.sumdiff(i, 4 + i, false);
        }
        net.rotation(4, 5, 48, true);
        net.rotation(7, 6, 16, true);
    } else {
        for i in 0..8 {
            net.rotation(2 * i, 2 * i + 1, 62 - 8 * i as i32, true);
        }
        for i in 0..8 {
            net.sumdiff(i, 8 + i, false);
        }
        for i in 0..2 {
            net.rotation(8 + 2 * i, 9 + 2 * i, 56 - 32 * i as i32, true);
            net.rotation(13 + 2 * i, 12 + 2 * i, 8 + 32 * i as i32, true);
        }
        for j in 0..2 {
            for i in 0..4 {
                net.sumdiff(8 * j + i, 4 + 8 * j + i, false);
            }
        }
        for j in 0..2 {
            for i in 0..2 {
                net.rotation(4 + 8 * j + 3 * i, 5 + 8 * j + i, 48 - 32 * i as i32, true);
            }
        }
    }
    for j in 0..size / 4 {
        for i in 0..2 {
            net.sumdiff(4 * j + i, 2 + 4 * j + i, false);
        }
    }
    for i in 0..size / 4 {
        net.rotation(2 + 4 * i, 3 + 4 * i, 32, true);
    }
    let valid = net.valid;
    let copy = data.to_vec();
    let n = size.trailing_zeros();
    for (i, value) in data.iter_mut().enumerate() {
        let index = reverse(i ^ (i >> 1), n);
        *value = copy[index] * if i & 1 != 0 { -1 } else { 1 };
    }
    if valid { Ok(()) } else { Err(Error::Invalid) }
}
fn wht(data: &mut [i32], shift: u32) {
    let mut a = data[0] >> shift;
    let mut c = data[1] >> shift;
    let mut d = data[2] >> shift;
    let mut b = data[3] >> shift;
    a += c;
    d -= b;
    let e = (a - d) >> 1;
    b = e - b;
    c = e - c;
    a -= b;
    d += c;
    data.copy_from_slice(&[a, b, c, d]);
}
fn kernel(data: &mut [i32], kind: u8, precision: u32) -> Result<()> {
    match kind {
        0 => dct(data, precision),
        1 => adst(data, precision),
        _ => {
            let size = data.len();
            for value in data {
                *value = match size {
                    4 => round(*value as i64 * 5793, 12),
                    8 => *value * 2,
                    16 => round(*value as i64 * 11586, 12),
                    32 => *value * 4,
                    _ => return Err(Error::Invalid),
                };
            }
            Ok(())
        }
    }
}

/// Four integer lanes use one add/shift/min/max each instead of four scalar sequences.
/// All values here fit i32 before rounding, including malformed input rejected by the caller.
fn row_finish(data: &mut [i32], shift: u32, precision: u32) {
    let limit = 1 << (precision - 1);
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    unsafe {
        use std::arch::wasm32::*;
        let bias = i32x4_splat(if shift == 0 { 0 } else { 1 << (shift - 1) });
        let low = i32x4_splat(-limit);
        let high = i32x4_splat(limit - 1);
        for chunk in data.chunks_exact_mut(4) {
            let value = v128_load(chunk.as_ptr().cast());
            let value = i32x4_shr(i32x4_add(value, bias), shift);
            let value = i32x4_min(i32x4_max(value, low), high);
            v128_store(chunk.as_mut_ptr().cast(), value);
        }
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    for value in data {
        *value = round(*value as i64, shift).clamp(-limit, limit - 1);
    }
}

/// Transform one dequantized block in raster order. Flips are applied by reconstruction.
pub fn inverse(input: &[i32], size: usize, tx: Tx, depth: u32, lossless: bool) -> Result<Vec<i32>> {
    if size >= WIDTHS.len() || ![8, 10, 12].contains(&depth) {
        return Err(Error::Invalid);
    }
    let w = WIDTHS[size];
    let h = HEIGHTS[size];
    if input.len() != w * h
        || (lossless && (size != 0 || tx != Tx::DctDct))
        || input
            .iter()
            .any(|v| (*v as i64) < -(1 << (depth + 7)) || (*v as i64) >= 1 << (depth + 7))
    {
        return Err(Error::Invalid);
    }
    let (row, col) = tx.kernels();
    let row_shift = if lossless { 0 } else { ROW_SHIFT[size] };
    let precision = (depth + 6).max(16);
    let mut out = input.to_vec();
    let rectangular = w.trailing_zeros().abs_diff(h.trailing_zeros()) == 1;
    for (y, data) in out.chunks_exact_mut(w).enumerate() {
        for (x, value) in data.iter_mut().enumerate() {
            if y >= 32 || x >= 32 {
                *value = 0;
            }
            if rectangular {
                *value = round(*value as i64 * 2896, 12);
            }
        }
        if lossless {
            wht(data, 2);
        } else {
            kernel(data, row, depth + 8)?;
        }
        row_finish(data, row_shift, precision);
    }
    let mut column = [0; 64];
    for x in 0..w {
        for y in 0..h {
            column[y] = out[y * w + x];
        }
        if lossless {
            wht(&mut column[..h], 0);
        } else {
            kernel(&mut column[..h], col, precision)?;
        }
        for y in 0..h {
            out[y * w + x] = round(column[y] as i64, if lossless { 0 } else { 4 });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dct4_frozen_basis_vectors() {
        let expected = [
            [2896, 2896, 2896, 2896],
            [3784, 1567, -1567, -3784],
            [2896, -2896, -2896, 2896],
            [1567, -3784, 3784, -1567],
        ];
        for (axis, expected) in expected.iter().enumerate() {
            let mut input = [0; 4];
            input[axis] = 4096;
            dct(&mut input, 20).unwrap();
            assert_eq!(&input, expected);
        }
    }
    #[test]
    fn dct_dc_is_constant_for_all_lengths_and_signs() {
        for size in [4, 8, 16, 32, 64] {
            for dc in [-32767, -2049, -1, 0, 1, 2049, 32767] {
                let mut values = vec![0; size];
                values[0] = dc;
                dct(&mut values, 20).unwrap();
                assert_eq!(values, vec![round(dc as i64 * 2896, 12); size]);
            }
        }
    }
    #[test]
    fn adst4_frozen_basis_vectors() {
        let expected = [
            [1321, 2482, 3344, 3803],
            [3344, 3344, 0, -3344],
            [3803, -1321, -3344, 2482],
            [2482, -3803, 3344, -1321],
        ];
        for (axis, expected) in expected.iter().enumerate() {
            let mut values = [0; 4];
            values[axis] = 4096;
            adst(&mut values, 20).unwrap();
            assert_eq!(&values, expected);
        }
    }
    #[test]
    fn inverse_rectangular_and_lossless_dc() {
        for size in 0..19 {
            let mut input = vec![0; WIDTHS[size] * HEIGHTS[size]];
            input[0] = 1024;
            let residual = inverse(&input, size, Tx::DctDct, 8, false).unwrap();
            let scaled = if WIDTHS[size]
                .trailing_zeros()
                .abs_diff(HEIGHTS[size].trailing_zeros())
                == 1
            {
                round(1024 * 2896, 12)
            } else {
                1024
            };
            let rows = round(round(scaled as i64 * 2896, 12) as i64, ROW_SHIFT[size]);
            let expected = round(round(rows as i64 * 2896, 12) as i64, 4);
            assert_eq!(residual, vec![expected; input.len()]);
        }
        let mut input = [0; 16];
        input[0] = 16;
        assert_eq!(inverse(&input, 0, Tx::DctDct, 8, true), Ok(vec![1; 16]));
    }
    #[test]
    fn simd_row_round_and_clamp_matches_signed_definition() {
        for shift in 0..=2 {
            let mut input: Vec<i32> = (-200000..200000).collect();
            let expected: Vec<_> = input
                .iter()
                .map(|x| round(*x as i64, shift).clamp(-32768, 32767))
                .collect();
            row_finish(&mut input, shift, 16);
            assert_eq!(input, expected);
        }
    }
}
