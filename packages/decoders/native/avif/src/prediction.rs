//! AV1 intra prediction, including the normative edge filter and upsampling stages.
use crate::tables::*;
use crate::transform::{round, round_signed};
use crate::{Error, Result};

pub struct References<'a> {
    /// Extended samples, with unavailable right/bottom samples already replicated.
    pub above: &'a [u16],
    pub left: &'a [u16],
    pub corner: u16,
    pub have_above: bool,
    pub have_left: bool,
    pub available_width: usize,
    pub available_height: usize,
}
pub struct Intra {
    pub width: usize,
    pub height: usize,
    pub depth: u32,
    pub mode: usize,
    pub angle_delta: i32,
    pub filter_intra: Option<usize>,
    pub edge_filter: bool,
    pub smooth_neighbor: bool,
}
fn weights(size: usize) -> &'static [i32] {
    match size {
        4 => &SM_WEIGHTS_TX_4X4,
        8 => &SM_WEIGHTS_TX_8X8,
        16 => &SM_WEIGHTS_TX_16X16,
        32 => &SM_WEIGHTS_TX_32X32,
        _ => &SM_WEIGHTS_TX_64X64,
    }
}
fn strength(total: usize, smooth: bool, delta: i32) -> usize {
    let d = delta.unsigned_abs();
    if smooth {
        match total {
            0..=8 => {
                if d >= 64 {
                    2
                } else {
                    usize::from(d >= 40)
                }
            }
            9..=16 => {
                if d >= 48 {
                    2
                } else {
                    usize::from(d >= 20)
                }
            }
            17..=24 => {
                if d >= 4 {
                    3
                } else {
                    0
                }
            }
            _ => 3,
        }
    } else {
        match total {
            0..=8 => usize::from(d >= 56),
            9..=16 => usize::from(d >= 40),
            17..=24 => {
                if d >= 32 {
                    3
                } else if d >= 16 {
                    2
                } else {
                    usize::from(d >= 8)
                }
            }
            25..=32 => {
                if d >= 32 {
                    3
                } else if d >= 4 {
                    2
                } else {
                    1
                }
            }
            _ => 3,
        }
    }
}
fn use_upsample(total: usize, smooth: bool, delta: i32) -> bool {
    (1..40).contains(&delta.unsigned_abs()) && total <= if smooth { 8 } else { 16 }
}
// Index 2 stores sample 0, leaving slots for the -1 corner and the -2 upsampled corner.
fn edge_filter(edge: &mut [i32; 258], count: usize, strength: usize) {
    if strength == 0 {
        return;
    }
    let kernels = [[0, 4, 8, 4, 0], [0, 5, 6, 5, 0], [2, 4, 4, 4, 2]];
    let copy = *edge;
    for i in 1..count {
        let mut sum = 0;
        for j in 0..5 {
            let index = (i as i32 - 2 + j as i32).clamp(0, count as i32 - 1) as usize;
            sum += kernels[strength - 1][j] * copy[index + 1];
        }
        edge[i + 1] = (sum + 8) >> 4;
    }
}
fn upsample(edge: &mut [i32; 258], count: usize, depth: u32) {
    let copy = *edge;
    let mut duplicate = [0; 131];
    duplicate[0] = copy[1];
    duplicate[1..count + 2].copy_from_slice(&copy[1..count + 2]);
    duplicate[count + 2] = copy[count + 1];
    edge[0] = duplicate[0];
    for i in 0..count {
        let value = -duplicate[i] + 9 * duplicate[i + 1] + 9 * duplicate[i + 2] - duplicate[i + 3];
        edge[2 * i + 1] = round(value as i64, 4).clamp(0, (1 << depth) - 1);
        edge[2 * i + 2] = duplicate[i + 2];
    }
}

pub fn predict(config: &Intra, refs: &References<'_>) -> Result<Vec<u16>> {
    let w = config.width;
    let h = config.height;
    if ![4, 8, 16, 32, 64].contains(&w)
        || ![4, 8, 16, 32, 64].contains(&h)
        || ![8, 10, 12].contains(&config.depth)
        || config.mode > 13
        || !(-3..=3).contains(&config.angle_delta)
        || refs.above.len() < w + h
        || refs.left.len() < w + h
    {
        return Err(Error::Invalid);
    }
    let max = (1 << config.depth) - 1;
    let mut out = vec![0; w * h];
    let mut above = [0_i32; 258];
    let mut left = [0_i32; 258];
    above[1] = refs.corner as i32;
    left[1] = refs.corner as i32;
    for i in 0..w + h {
        above[i + 2] = refs.above[i] as i32;
        left[i + 2] = refs.left[i] as i32;
    }
    if let Some(filter) = config.filter_intra {
        if filter >= 5 || w > 32 || h > 32 || config.mode != 0 {
            return Err(Error::Invalid);
        }
        for y in (0..h).step_by(2) {
            for x in (0..w).step_by(4) {
                let mut neighbors = [0; 7];
                for i in 0..5 {
                    neighbors[i] = if y == 0 {
                        above[x + i + 1]
                    } else if x == 0 && i == 0 {
                        left[y + 1]
                    } else {
                        out[(y - 1) * w + x + i - 1] as i32
                    };
                }
                for i in 0..2 {
                    neighbors[5 + i] = if x == 0 {
                        left[y + i + 2]
                    } else {
                        out[(y + i) * w + x - 1] as i32
                    };
                }
                for j in 0..8 {
                    let sum: i32 = neighbors
                        .iter()
                        .zip(INTRA_FILTER_TAPS[filter][j])
                        .map(|(a, b)| a * b)
                        .sum();
                    out[(y + j / 4) * w + x + j % 4] =
                        round_signed(sum as i64, 4).clamp(0, max) as u16;
                }
            }
        }
        return Ok(out);
    }
    if config.mode == 0 || config.mode == 13 {
        let mut sum = 0;
        let mut count = 0;
        if refs.have_above {
            sum += above[2..w + 2].iter().sum::<i32>();
            count += w;
        }
        if refs.have_left {
            sum += left[2..h + 2].iter().sum::<i32>();
            count += h;
        }
        let average = if count > 0 {
            (sum + count as i32 / 2) / count as i32
        } else {
            1 << (config.depth - 1)
        };
        out.fill(average as u16);
        return Ok(out);
    }
    if config.mode >= 9 {
        let wx = weights(w);
        let wy = weights(h);
        for y in 0..h {
            for x in 0..w {
                let top = above[x + 2];
                let side = left[y + 2];
                let prediction = match config.mode {
                    9 => round(
                        (wy[y] * top
                            + (256 - wy[y]) * left[h + 1]
                            + wx[x] * side
                            + (256 - wx[x]) * above[w + 1]) as i64,
                        9,
                    ),
                    10 => round((wy[y] * top + (256 - wy[y]) * left[h + 1]) as i64, 8),
                    11 => round((wx[x] * side + (256 - wx[x]) * above[w + 1]) as i64, 8),
                    _ => {
                        let p = top + side - above[1];
                        let a = (p - side).abs();
                        let b = (p - top).abs();
                        let c = (p - above[1]).abs();
                        if a <= b && a <= c {
                            side
                        } else if b <= c {
                            top
                        } else {
                            above[1]
                        }
                    }
                };
                out[y * w + x] = prediction as u16;
            }
        }
        return Ok(out);
    }
    let angle = [0, 90, 180, 45, 135, 113, 157, 203, 67][config.mode] + 3 * config.angle_delta;
    let mut up_a = 0;
    let mut up_l = 0;
    if config.edge_filter {
        if angle != 90 && angle != 180 {
            if angle > 90 && angle < 180 && w + h >= 24 {
                let corner = round((left[2] * 5 + above[1] * 6 + above[2] * 5) as i64, 4);
                above[1] = corner;
                left[1] = corner;
            }
            if refs.have_above {
                let count = w.min(refs.available_width) + if angle < 90 { h } else { 0 } + 1;
                edge_filter(
                    &mut above,
                    count,
                    strength(w + h, config.smooth_neighbor, angle - 90),
                );
            }
            if refs.have_left {
                let count = h.min(refs.available_height) + if angle > 180 { w } else { 0 } + 1;
                edge_filter(
                    &mut left,
                    count,
                    strength(w + h, config.smooth_neighbor, angle - 180),
                );
            }
        }
        if use_upsample(w + h, config.smooth_neighbor, angle - 90) {
            upsample(&mut above, w + if angle < 90 { h } else { 0 }, config.depth);
            up_a = 1;
        }
        if use_upsample(w + h, config.smooth_neighbor, angle - 180) {
            upsample(&mut left, h + if angle > 180 { w } else { 0 }, config.depth);
            up_l = 1;
        }
    }
    let dx = if angle < 90 {
        DR_INTRA_DERIVATIVE[angle as usize]
    } else if angle > 90 && angle < 180 {
        DR_INTRA_DERIVATIVE[(180 - angle) as usize]
    } else {
        0
    };
    let dy = if angle > 180 {
        DR_INTRA_DERIVATIVE[(270 - angle) as usize]
    } else if angle > 90 && angle < 180 {
        DR_INTRA_DERIVATIVE[(angle - 90) as usize]
    } else {
        0
    };
    let interpolate = |edge: &[i32; 258], index: i32, up: u32, origin: i32| -> Result<i32> {
        let base = (index >> (6 - up)) + origin;
        let shift = ((index << up) >> 1) & 31;
        let offset = usize::try_from(base + 2).map_err(|_| Error::Invalid)?;
        let a = *edge.get(offset).ok_or(Error::Invalid)?;
        let b = *edge.get(offset + 1).ok_or(Error::Invalid)?;
        Ok(round((a * (32 - shift) + b * shift) as i64, 5))
    };
    for y in 0..h {
        for x in 0..w {
            let value = if angle < 90 {
                let index = (y as i32 + 1) * dx;
                let base = (index >> (6 - up_a)) + ((x as i32) << up_a);
                let last = ((w + h - 1) as i32) << up_a;
                if base < last {
                    interpolate(&above, index, up_a, (x as i32) << up_a)?
                } else {
                    above[last as usize + 2]
                }
            } else if angle == 90 {
                above[x + 2]
            } else if angle < 180 {
                let index = ((x as i32) << 6) - (y as i32 + 1) * dx;
                if (index >> (6 - up_a)) >= -(1 << up_a) {
                    interpolate(&above, index, up_a, 0)?
                } else {
                    interpolate(&left, ((y as i32) << 6) - (x as i32 + 1) * dy, up_l, 0)?
                }
            } else if angle == 180 {
                left[y + 2]
            } else {
                interpolate(&left, (x as i32 + 1) * dy, up_l, (y as i32) << up_l)?
            };
            out[y * w + x] = value as u16;
        }
    }
    Ok(out)
}

/// Chroma-from-luma takes subsampled luma in Q3 precision and a signed Q3 alpha.
pub fn cfl(predicted: &mut [u16], luma_q3: &[i32], alpha: i32, depth: u32) -> Result<()> {
    if predicted.len() != luma_q3.len() || predicted.is_empty() || alpha.abs() > 16 {
        return Err(Error::Invalid);
    }
    let count = luma_q3.len();
    let average =
        (luma_q3.iter().map(|x| *x as i64).sum::<i64>() + count as i64 / 2) / count as i64;
    for (sample, luma) in predicted.iter_mut().zip(luma_q3) {
        let residual = round_signed((*luma as i64 - average) * alpha as i64, 6);
        *sample = (*sample as i32 + residual).clamp(0, (1 << depth) - 1) as u16;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_intra_mode_preserves_constant_edges_at_all_depths_and_angles() {
        for depth in [8, 10, 12] {
            let value = (1 << (depth - 1)) + 17;
            let edge = [value; 128];
            let refs = References {
                above: &edge,
                left: &edge,
                corner: value,
                have_above: true,
                have_left: true,
                available_width: 64,
                available_height: 64,
            };
            for (w, h) in [
                (4, 4),
                (8, 4),
                (4, 16),
                (8, 8),
                (16, 32),
                (32, 16),
                (64, 64),
            ] {
                for mode in 0..13 {
                    for delta in -3..=3 {
                        for smooth in [false, true] {
                            let config = Intra {
                                width: w,
                                height: h,
                                depth,
                                mode,
                                angle_delta: delta,
                                filter_intra: None,
                                edge_filter: true,
                                smooth_neighbor: smooth,
                            };
                            assert_eq!(
                                predict(&config, &refs),
                                Ok(vec![value; w * h]),
                                "{depth} {w}x{h} mode {mode} delta {delta}"
                            );
                        }
                    }
                }
                if w <= 32 && h <= 32 {
                    for filter in 0..5 {
                        let config = Intra {
                            width: w,
                            height: h,
                            depth,
                            mode: 0,
                            angle_delta: 0,
                            filter_intra: Some(filter),
                            edge_filter: false,
                            smooth_neighbor: false,
                        };
                        assert_eq!(predict(&config, &refs), Ok(vec![value; w * h]));
                    }
                }
            }
        }
    }
    #[test]
    fn dc_uses_available_edges_and_center_without_neighbors() {
        let top = [10; 16];
        let left = [30; 16];
        let config = Intra {
            width: 4,
            height: 8,
            depth: 8,
            mode: 0,
            angle_delta: 0,
            filter_intra: None,
            edge_filter: false,
            smooth_neighbor: false,
        };
        for (a, l, expected) in [
            (true, true, 23),
            (true, false, 10),
            (false, true, 30),
            (false, false, 128),
        ] {
            let refs = References {
                above: &top,
                left: &left,
                corner: 0,
                have_above: a,
                have_left: l,
                available_width: 4,
                available_height: 8,
            };
            assert_eq!(predict(&config, &refs), Ok(vec![expected; 32]));
        }
    }
    #[test]
    fn vertical_and_horizontal_project_edges_without_filtering() {
        let top: Vec<u16> = (0..16).collect();
        let left: Vec<u16> = (100..116).collect();
        let refs = References {
            above: &top,
            left: &left,
            corner: 50,
            have_above: true,
            have_left: true,
            available_width: 8,
            available_height: 4,
        };
        for mode in [1, 2] {
            let config = Intra {
                width: 8,
                height: 4,
                depth: 8,
                mode,
                angle_delta: 0,
                filter_intra: None,
                edge_filter: true,
                smooth_neighbor: false,
            };
            let expected: Vec<_> = (0..32)
                .map(|i| if mode == 1 { top[i % 8] } else { left[i / 8] })
                .collect();
            assert_eq!(predict(&config, &refs), Ok(expected));
        }
    }
    #[test]
    fn chroma_from_luma_signed_rounding_and_clipping() {
        let mut out = [100, 100, 100, 100];
        cfl(&mut out, &[0, 8, 16, 24], 8, 8).unwrap();
        assert_eq!(out, [98, 99, 101, 102]);
        let mut out = [254, 254, 254, 254];
        cfl(&mut out, &[0, 8, 16, 24], -16, 8).unwrap();
        assert_eq!(out, [255, 255, 253, 251]);
    }
}
