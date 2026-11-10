//! AV1 deblocking and constrained directional enhancement, from specification sections 7.14 and 7.15.
use crate::frame::Frame;
use crate::reconstruct::{BlockInfo, Plane, Reconstruction};
use crate::sequence::Sequence;
use crate::transform::{HEIGHTS, WIDTHS, round};

fn level(frame: &Frame, block: BlockInfo, plane: usize, pass: usize) -> (i32, i32, i32, i32) {
    let index = if plane == 0 { pass } else { plane + 1 };
    let delta = block.delta_lf[if frame.delta_lf_multi { index } else { 0 }] as i32;
    let mut value = (frame.loop_filter.levels[index] as i32 + delta).clamp(0, 63);
    let segment = &frame.segments[block.segment as usize];
    if segment.enabled[index + 1] {
        value = (value + segment.values[index + 1]).clamp(0, 63);
    }
    if frame.loop_filter.delta_enabled {
        value = (value + (frame.loop_filter.ref_deltas[0] << (value >> 5))).clamp(0, 63);
    }
    let sharpness = frame.loop_filter.sharpness as i32;
    let shift = if sharpness > 4 {
        2
    } else {
        i32::from(sharpness > 0)
    };
    let limit = if sharpness > 0 {
        (value >> shift).clamp(1, 9 - sharpness)
    } else {
        (value >> shift).max(1)
    };
    (value, limit, 2 * (value + 2) + limit, value >> 4)
}

pub fn deblock(output: &mut Reconstruction, seq: &Sequence, frame: &Frame) {
    if frame.coded_lossless
        || frame.intrabc
        || (frame.loop_filter.levels[0] == 0 && frame.loop_filter.levels[1] == 0)
    {
        return;
    }
    let cols = 2 * frame.width.div_ceil(8) as usize;
    let rows = 2 * frame.height.div_ceil(8) as usize;
    for plane in 0..output.planes.len() {
        if plane > 0 && frame.loop_filter.levels[plane + 1] == 0 {
            continue;
        }
        let sx = usize::from(plane > 0 && seq.color.sub_x);
        let sy = usize::from(plane > 0 && seq.color.sub_y);
        for pass in 0..2 {
            for r in (0..rows).step_by(1 << sy) {
                for c in (0..cols).step_by(1 << sx) {
                    let x = c * 4;
                    let y = r * 4;
                    if x >= frame.width as usize
                        || y >= frame.height as usize
                        || (pass == 0 && x == 0)
                        || (pass == 1 && y == 0)
                    {
                        continue;
                    }
                    let row = r | sy;
                    let col = c | sx;
                    let prev_row = row - if pass == 1 { 1 << sy } else { 0 };
                    let prev_col = col - if pass == 0 { 1 << sx } else { 0 };
                    let current = output.blocks[row * output.block_stride + col];
                    let previous = output.blocks[prev_row * output.block_stride + prev_col];
                    let pixels = &output.planes[plane];
                    let tx = pixels.transform_sizes[(row >> sy) * (pixels.width / 4) + (col >> sx)]
                        as usize;
                    let prev_tx = pixels.transform_sizes
                        [(prev_row >> sy) * (pixels.width / 4) + (prev_col >> sx)]
                        as usize;
                    let (dimension, prev_dimension) = if pass == 0 {
                        (WIDTHS[tx], WIDTHS[prev_tx])
                    } else {
                        (HEIGHTS[tx], HEIGHTS[prev_tx])
                    };
                    let coordinate = if pass == 0 { x >> sx } else { y >> sy };
                    if coordinate % dimension != 0 {
                        continue;
                    }
                    let size = dimension
                        .min(prev_dimension)
                        .min(if plane == 0 { 16 } else { 8 });
                    let mut limits = level(frame, current, plane, pass);
                    if limits.0 == 0 {
                        limits = level(frame, previous, plane, pass);
                    }
                    if limits.0 == 0 {
                        continue;
                    }
                    for i in 0..4 {
                        let xx = (x >> sx) + if pass == 1 { i } else { 0 };
                        let yy = (y >> sy) + if pass == 0 { i } else { 0 };
                        filter_edge(
                            &mut output.planes[plane],
                            xx,
                            yy,
                            pass,
                            plane > 0,
                            size,
                            seq.color.depth,
                            limits.1,
                            limits.2,
                            limits.3,
                        );
                    }
                }
            }
        }
    }
}
fn filter_edge(
    plane: &mut Plane,
    x: usize,
    y: usize,
    pass: usize,
    chroma: bool,
    size: usize,
    depth: u32,
    limit: i32,
    boundary: i32,
    threshold: i32,
) {
    let stride = if pass == 0 { 1 } else { plane.width };
    let center = y * plane.width + x;
    let mut samples = [0_i32; 14];
    for (i, sample) in samples.iter_mut().enumerate() {
        let coordinate = if pass == 0 { x } else { y } as i32 + i as i32 - 7;
        let coordinate = coordinate.clamp(
            0,
            if pass == 0 { plane.width } else { plane.height } as i32 - 1,
        ) as usize;
        let at = if pass == 0 {
            y * plane.width + coordinate
        } else {
            coordinate * plane.width + x
        };
        *sample = plane.data[at] as i32;
    }
    let p = |i: usize| samples[6 - i];
    let q = |i: usize| samples[7 + i];
    let scale = 1 << (depth - 8);
    let taps = if size == 4 {
        4
    } else if chroma {
        6
    } else {
        size
    };
    let high_variance =
        (p(1) - p(0)).abs() > threshold * scale || (q(1) - q(0)).abs() > threshold * scale;
    let mut mask = (p(1) - p(0)).abs() > limit * scale
        || (q(1) - q(0)).abs() > limit * scale
        || (p(0) - q(0)).abs() * 2 + (p(1) - q(1)).abs() / 2 > boundary * scale;
    if taps >= 6 {
        mask |= (p(2) - p(1)).abs() > limit * scale || (q(2) - q(1)).abs() > limit * scale;
    }
    if taps >= 8 {
        mask |= (p(3) - p(2)).abs() > limit * scale || (q(3) - q(2)).abs() > limit * scale;
    }
    if mask {
        return;
    }
    let flat = size >= 8
        && (1..=if taps >= 8 { 3 } else { 2 })
            .all(|i| (p(i) - p(0)).abs() <= scale && (q(i) - q(0)).abs() <= scale);
    let flat_wide =
        size >= 16 && (4..=6).all(|i| (p(i) - p(0)).abs() <= scale && (q(i) - q(0)).abs() <= scale);
    if size == 4 || !flat {
        let bias = 1 << (depth - 1);
        let clamp = |v: i32| v.clamp(-bias, bias - 1);
        let first = if high_variance { clamp(p(1) - q(1)) } else { 0 };
        let filter = clamp(first + 3 * (q(0) - p(0)));
        let a = clamp(filter + 4) >> 3;
        let b = clamp(filter + 3) >> 3;
        plane.data[center] = (clamp(q(0) - bias - a) + bias) as u16;
        plane.data[center - stride] = (clamp(p(0) - bias + b) + bias) as u16;
        if !high_variance {
            let adjustment = round(a as i64, 1);
            plane.data[center + stride] = (clamp(q(1) - bias - adjustment) + bias) as u16;
            plane.data[center - 2 * stride] = (clamp(p(1) - bias + adjustment) + bias) as u16;
        }
    } else {
        let shift = if size == 8 || !flat_wide { 3 } else { 4 };
        let n: i32 = if shift == 4 {
            6
        } else if chroma {
            2
        } else {
            3
        };
        let double = if shift == 3 && !chroma { 0 } else { 1 };
        for i in -n..n {
            let mut sum = 0;
            for j in -n..=n {
                let pos = (i + j).clamp(-(n + 1), n);
                sum += samples[(pos + 7) as usize] * if j.abs() <= double { 2 } else { 1 };
            }
            let target = (center as isize + i as isize * stride as isize) as usize;
            plane.data[target] = round(sum as i64, shift) as u16;
        }
    }
}

fn direction(plane: &Plane, x: usize, y: usize, depth: u32) -> (usize, i64) {
    let mut partial = [[0_i64; 15]; 8];
    let mut count = [[0_i64; 15]; 8];
    for i in 0..8 {
        for j in 0..8 {
            let sample = (plane.data[(y + i) * plane.width + x + j] >> (depth - 8)) as i64 - 128;
            let bins = [
                i + j,
                i + j / 2,
                i,
                3 + i - j / 2,
                7 + i - j,
                3 + j - i / 2,
                j,
                i / 2 + j,
            ];
            for d in 0..8 {
                partial[d][bins[d]] += sample;
                count[d][bins[d]] += 1;
            }
        }
    }
    // 840 is divisible by every possible line population. This is the least-squares
    // directional cost expressed directly, without eight specialized cost loops.
    let mut costs = [0; 8];
    for d in 0..8 {
        for bin in 0..15 {
            if count[d][bin] != 0 {
                costs[d] += partial[d][bin] * partial[d][bin] * (840 / count[d][bin]);
            }
        }
    }
    let mut best = 0;
    for d in 1..8 {
        if costs[d] > costs[best] {
            best = d;
        }
    }
    (best, (costs[best] - costs[(best + 4) & 7]) >> 10)
}
fn constrain(diff: i32, strength: i32, damping: i32) -> i32 {
    if strength == 0 {
        return 0;
    }
    let shift = (damping - (31 - strength.leading_zeros()) as i32).max(0);
    diff.signum() * (strength - (diff.abs() >> shift)).clamp(0, diff.abs())
}
const DIRECTIONS: [[(i32, i32); 2]; 8] = [
    [(-1, 1), (-2, 2)],
    [(0, 1), (-1, 2)],
    [(0, 1), (0, 2)],
    [(0, 1), (1, 2)],
    [(1, 1), (2, 2)],
    [(1, 0), (2, 1)],
    [(1, 0), (2, 0)],
    [(1, 0), (2, -1)],
];
fn cdef_region(
    source: &Plane,
    destination: &mut [u16],
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    primary: i32,
    secondary: i32,
    damping: i32,
    dir: usize,
    depth: u32,
) {
    let taps = if (primary >> (depth - 8)) & 1 == 0 {
        [4, 2]
    } else {
        [3, 3]
    };
    for yy in y..y + h {
        for xx in x..x + w {
            let center = source.data[yy * source.width + xx] as i32;
            let mut low = center;
            let mut high = center;
            let mut sum = 0;
            for k in 0..2 {
                for sign in [-1, 1] {
                    for (d, strength, weight) in [
                        (dir, primary, taps[k]),
                        ((dir + 2) & 7, secondary, 2 - k as i32),
                        ((dir + 6) & 7, secondary, 2 - k as i32),
                    ] {
                        let (dy, dx) = DIRECTIONS[d][k];
                        let y = yy as i32 + sign * dy;
                        let x = xx as i32 + sign * dx;
                        if y >= 0
                            && x >= 0
                            && y < source.coded_height as i32
                            && x < source.coded_width as i32
                        {
                            let sample = source.data[y as usize * source.width + x as usize] as i32;
                            sum += weight * constrain(sample - center, strength, damping);
                            low = low.min(sample);
                            high = high.max(sample);
                        }
                    }
                }
            }
            destination[yy * source.width + xx] =
                (center + ((8 + sum - i32::from(sum < 0)) >> 4)).clamp(low, high) as u16;
        }
    }
}
/// Return a distinct CDEF image. The deblocked source is retained for restoration-stripe boundaries.
pub fn cdef(output: &Reconstruction, seq: &Sequence, frame: &Frame) -> Vec<Vec<u16>> {
    let mut planes: Vec<Vec<u16>> = output
        .planes
        .iter()
        .map(|plane| plane.data.clone())
        .collect();
    if frame.coded_lossless || frame.intrabc || !seq.cdef {
        return planes;
    }
    let rows = output.planes[0].coded_height / 4;
    let cols = output.planes[0].coded_width / 4;
    let shift = seq.color.depth - 8;
    for r in (0..rows).step_by(2) {
        for c in (0..cols).step_by(2) {
            let index = output.cdef_indices[(r & !15) * output.block_stride + (c & !15)];
            if index < 0 {
                continue;
            }
            let skip = (0..2)
                .all(|y| (0..2).all(|x| output.blocks[(r + y) * output.block_stride + c + x].skip));
            if skip {
                continue;
            }
            let (dir, variance) = direction(&output.planes[0], c * 4, r * 4, seq.color.depth);
            let strengths = frame.cdef.strengths[index as usize];
            let primary = (strengths[0] << shift) as i32;
            let var_strength = if variance >> 6 != 0 {
                (63 - (variance >> 6).leading_zeros()).min(12) as i32
            } else {
                0
            };
            let primary_adjusted = if variance == 0 {
                0
            } else {
                (primary * (4 + var_strength) + 8) >> 4
            };
            cdef_region(
                &output.planes[0],
                &mut planes[0],
                c * 4,
                r * 4,
                8,
                8,
                primary_adjusted,
                (strengths[1] << shift) as i32,
                frame.cdef.damping as i32 + shift as i32,
                if primary == 0 { 0 } else { dir },
                seq.color.depth,
            );
            if seq.color.monochrome {
                continue;
            }
            let sx = usize::from(seq.color.sub_x);
            let sy = usize::from(seq.color.sub_y);
            let uv_dir = [
                [[0, 1, 2, 3, 4, 5, 6, 7], [1, 2, 2, 2, 3, 4, 6, 0]],
                [[7, 0, 2, 4, 5, 6, 6, 6], [0, 1, 2, 3, 4, 5, 6, 7]],
            ][sx][sy][dir];
            for plane in 1..3 {
                cdef_region(
                    &output.planes[plane],
                    &mut planes[plane],
                    (c * 4) >> sx,
                    (r * 4) >> sy,
                    8 >> sx,
                    8 >> sy,
                    (strengths[2] << shift) as i32,
                    (strengths[3] << shift) as i32,
                    frame.cdef.damping as i32 + shift as i32 - 1,
                    if strengths[2] == 0 { 0 } else { uv_dir },
                    seq.color.depth,
                );
            }
        }
    }
    planes
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plane(width: usize, height: usize, value: u16) -> Plane {
        // The frame helper owns allocation so tests exercise the same row layout as production.
        let mut p = Plane::new(width, height);
        p.data.fill(value);
        p
    }
    #[test]
    fn narrow_filter_frozen_step() {
        let mut p = plane(16, 8, 100);
        for y in 0..8 {
            for x in 8..16 {
                p.data[y * 16 + x] = 108;
            }
        }
        filter_edge(&mut p, 8, 4, 0, false, 4, 8, 20, 40, 2);
        assert_eq!(&p.data[4 * 16 + 6..4 * 16 + 10], &[102, 103, 105, 106]);
    }
    #[test]
    fn every_filter_preserves_constant_planes_at_all_depths() {
        for depth in [8, 10, 12] {
            let value = (1 << (depth - 1)) + 13;
            for size in [4, 8, 16] {
                for chroma in [false, true] {
                    for pass in 0..2 {
                        let mut p = plane(32, 32, value);
                        filter_edge(&mut p, 16, 16, pass, chroma, size, depth, 20, 40, 2);
                        assert!(p.data.iter().all(|sample| *sample == value));
                    }
                }
            }
            let p = plane(32, 32, value);
            assert_eq!(direction(&p, 8, 8, depth), (0, 0));
            for dir in 0..8 {
                let mut destination = p.data.clone();
                cdef_region(
                    &p,
                    &mut destination,
                    0,
                    0,
                    8,
                    8,
                    15 << (depth - 8),
                    4 << (depth - 8),
                    depth as i32 - 5,
                    dir,
                    depth,
                );
                assert_eq!(destination, p.data);
            }
        }
    }
    #[test]
    fn cdef_detects_horizontal_and_vertical_lines() {
        let mut p = plane(8, 8, 0);
        for y in 0..8 {
            for x in 0..8 {
                p.data[y * 8 + x] = y as u16 * 30;
            }
        }
        assert_eq!(direction(&p, 0, 0, 8).0, 2);
        for y in 0..8 {
            for x in 0..8 {
                p.data[y * 8 + x] = x as u16 * 30;
            }
        }
        assert_eq!(direction(&p, 0, 0, 8).0, 6);
    }
    #[test]
    fn zero_frame_levels_bypass_reference_deltas() {
        use crate::{bits::Bits, container::File, obu::Obus, sequence::Sequence};
        let data = include_bytes!("../tests/fixtures/kimono.mirror-vertical.rotate270.crop.avif");
        let file = File::parse(data).unwrap();
        let bytes = file.item_data(file.primary, data.len()).unwrap();
        let obus = Obus::new(&bytes)
            .collect::<crate::Result<Vec<_>>>()
            .unwrap();
        let seq = Sequence::parse(obus.iter().find(|o| o.kind == 1).unwrap().payload).unwrap();
        let header = obus.iter().find(|o| o.kind == 3).unwrap();
        let frame = Frame::parse(&mut Bits::new(header.payload), &seq, 0, 0, 1 << 26).unwrap();
        assert_eq!(frame.loop_filter.levels, [0; 4]);
        assert_eq!(frame.loop_filter.ref_deltas[0], 1);
        let mut output = Reconstruction::new(&seq, &frame);
        for plane in &mut output.planes {
            for (i, sample) in plane.data.iter_mut().enumerate() {
                *sample = 100 + ((i / 4) & 1) as u16 * 8;
            }
        }
        let original: Vec<_> = output.planes.iter().map(|p| p.data.clone()).collect();
        deblock(&mut output, &seq, &frame);
        assert!(
            output
                .planes
                .iter()
                .zip(original)
                .all(|(p, expected)| p.data == expected)
        );
    }
}
