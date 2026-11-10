//! Normative AV1 film-grain synthesis (7.18.3). Two stripes per plane bound temporary storage.
use crate::frame::Grain;
use crate::restore_filter::ImagePlane;
use crate::sequence::Color;
use crate::tables::GAUSSIAN_SEQUENCE;
fn round(value: i32, shift: u32) -> i32 {
    crate::transform::round(value as i64, shift)
}

fn random(state: &mut u32, bits: u32) -> usize {
    let bit = (*state ^ (*state >> 1) ^ (*state >> 3) ^ (*state >> 12)) & 1;
    *state = (*state >> 1) | (bit << 15);
    ((*state >> (16 - bits)) & ((1 << bits) - 1)) as usize
}
fn lut(points: &[[u32; 2]]) -> [i32; 256] {
    let mut out = [0; 256];
    if points.is_empty() {
        return out;
    }
    out.fill(points[0][1] as i32);
    for pair in points.windows(2) {
        let dx = pair[1][0] - pair[0][0];
        let dy = pair[1][1] as i32 - pair[0][1] as i32;
        let step = dy * ((65536 + (dx >> 1)) / dx) as i32;
        for x in 0..dx {
            out[(pair[0][0] + x) as usize] = pair[0][1] as i32 + ((x as i32 * step + 32768) >> 16);
        }
    }
    let last = points[points.len() - 1];
    out[last[0] as usize..].fill(last[1] as i32);
    out
}
fn scale(table: &[i32; 256], sample: i32, depth: u32) -> i32 {
    let shift = depth - 8;
    let x = (sample >> shift) as usize;
    if shift == 0 || x == 255 {
        table[x]
    } else {
        table[x]
            + round(
                (table[x + 1] - table[x]) * (sample - ((x as i32) << shift)),
                shift,
            )
    }
}

pub fn apply(planes: &mut [ImagePlane], color: &Color, grain: &Grain) {
    if !grain.apply {
        return;
    }
    let depth = color.depth;
    let minimum = -(128 << (depth - 8));
    let maximum = (128 << (depth - 8)) - 1;
    let sample_max = (1 << depth) - 1;
    let sx = usize::from(color.sub_x);
    let sy = usize::from(color.sub_y);
    let mut templates = Vec::<Vec<i32>>::new();
    let mut widths = Vec::new();
    for p in 0..planes.len() {
        let width = if p > 0 && sx != 0 { 44 } else { 82 };
        let height = if p > 0 && sy != 0 { 38 } else { 73 };
        let present = !grain.points[p].is_empty() || (p > 0 && grain.chroma_from_luma);
        let mut state = grain.seed ^ [0, 0xb524, 0x49d8][p];
        let mut values = vec![0; width * height];
        if present {
            for value in &mut values {
                *value = round(
                    GAUSSIAN_SEQUENCE[random(&mut state, 11)],
                    12 - depth + grain.scale_shift,
                );
            }
            let lag = grain.lag as i32;
            for y in 3..height {
                for x in 3..width - 3 {
                    let mut sum = 0;
                    let mut position = 0;
                    for dy in -lag..=0 {
                        for dx in -lag..=lag {
                            if dy == 0 && dx == 0 {
                                if p > 0 && !grain.points[0].is_empty() {
                                    let mut luma = 0;
                                    let lx = ((x - 3) << sx) + 3;
                                    let ly = ((y - 3) << sy) + 3;
                                    for yy in 0..=sy {
                                        for xx in 0..=sx {
                                            luma += templates[0][(ly + yy) * 82 + lx + xx];
                                        }
                                    }
                                    sum += round(luma, (sx + sy) as u32)
                                        * grain.coefficients[p][position];
                                }
                                break;
                            }
                            sum += values
                                [(y as i32 + dy) as usize * width + (x as i32 + dx) as usize]
                                * grain.coefficients[p][position];
                            position += 1;
                        }
                    }
                    values[y * width + x] = (values[y * width + x]
                        + round(sum, grain.coefficient_shift))
                    .clamp(minimum, maximum);
                }
            }
        }
        widths.push(width);
        templates.push(values);
    }
    let tables: Vec<_> = (0..planes.len())
        .map(|p| {
            lut(&grain.points[if p > 0 && grain.chroma_from_luma {
                0
            } else {
                p
            }])
        })
        .collect();
    let width = planes[0].width;
    let height = planes[0].height;
    // Stripes include the two overlap rows/columns and full final blocks, avoiding edge clamping of noise.
    let stride = width.div_ceil(32) * 32 + 2;
    let mut previous: Vec<Vec<i32>> = (0..planes.len())
        .map(|p| {
            vec![0; (stride >> if p > 0 { sx } else { 0 }) * (34 >> if p > 0 { sy } else { 0 })]
        })
        .collect();
    for stripe in 0..height.div_ceil(32) {
        let mut state = grain.seed
            ^ (((stripe as u32 * 37 + 178) & 255) << 8)
            ^ ((stripe as u32 * 173 + 105) & 255);
        let mut current: Vec<Vec<i32>> = previous.iter().map(|v| vec![0; v.len()]).collect();
        for block in 0..width.div_ceil(32) {
            let rand = random(&mut state, 8);
            for p in 0..planes.len() {
                let px = if p > 0 { sx } else { 0 };
                let py = if p > 0 { sy } else { 0 };
                let ox = if px != 0 {
                    6 + (rand >> 4)
                } else {
                    9 + (rand >> 4) * 2
                };
                let oy = if py != 0 {
                    6 + (rand & 15)
                } else {
                    9 + (rand & 15) * 2
                };
                let pitch = stride >> px;
                for y in 0..34 >> py {
                    for x in 0..34 >> px {
                        let index = y * pitch + (block * 32 >> px) + x;
                        let mut g = templates[p][(oy + y) * widths[p] + ox + x];
                        if grain.overlap && block > 0 && x < (2 >> px) {
                            let (old_weight, weight) = if px != 0 {
                                (23, 22)
                            } else if x == 0 {
                                (27, 17)
                            } else {
                                (17, 27)
                            };
                            g = round(current[p][index] * old_weight + g * weight, 5)
                                .clamp(minimum, maximum);
                        }
                        current[p][index] = g;
                    }
                }
            }
        }
        // Chroma reads original luma. Apply luma last, including the last odd-sized row/column.
        for p in (1..planes.len()).chain(std::iter::once(0)) {
            if grain.points[p].is_empty() && !(p > 0 && grain.chroma_from_luma) {
                continue;
            }
            let px = if p > 0 { sx } else { 0 };
            let py = if p > 0 { sy } else { 0 };
            let pitch = stride >> px;
            let start = stripe * 32 >> py;
            for yy in 0..(32 >> py).min(planes[p].height - start) {
                let y = start + yy;
                for x in 0..planes[p].width {
                    let mut noise = current[p][yy * pitch + x];
                    if grain.overlap && stripe > 0 && yy < (2 >> py) {
                        let old = previous[p][(yy + (32 >> py)) * pitch + x];
                        let (a, b) = if py != 0 {
                            (23, 22)
                        } else if yy == 0 {
                            (27, 17)
                        } else {
                            (17, 27)
                        };
                        noise = round(old * a + noise * b, 5).clamp(minimum, maximum);
                    }
                    let original = planes[p].data[y * planes[p].width + x] as i32;
                    let merged = if p == 0 {
                        original
                    } else {
                        let lx = x << sx;
                        let ly = y << sy;
                        let luma = if sx != 0 {
                            round(
                                planes[0].data[ly * width + lx] as i32
                                    + planes[0].data[ly * width + (lx + 1).min(width - 1)] as i32,
                                1,
                            )
                        } else {
                            planes[0].data[ly * width + lx] as i32
                        };
                        if grain.chroma_from_luma {
                            luma
                        } else {
                            let [mult, luma_mult, offset] = grain.chroma_mult[p - 1];
                            (((luma * (luma_mult as i32 - 128) + original * (mult as i32 - 128))
                                >> 6)
                                + ((offset as i32 - 256) << (depth - 8)))
                                .clamp(0, sample_max)
                        }
                    };
                    let noise = round(
                        scale(&tables[p], merged, depth) * noise,
                        grain.scaling_shift,
                    );
                    let lo = if grain.restricted_range {
                        16 << (depth - 8)
                    } else {
                        0
                    };
                    let hi = if grain.restricted_range {
                        (if p == 0 || color.matrix == 0 {
                            235
                        } else {
                            240
                        }) << (depth - 8)
                    } else {
                        sample_max
                    };
                    let index = y * planes[p].width + x;
                    planes[p].data[index] = (original + noise).clamp(lo, hi) as u16;
                }
            }
        }
        previous = current;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn random_register_and_high_precision_scaling_are_exact() {
        let mut state = 1;
        assert_eq!(random(&mut state, 16), 32768);
        assert_eq!(random(&mut state, 16), 16384);
        let table = lut(&[[10, 20], [20, 40]]);
        assert_eq!(table[0], 20);
        assert_eq!(table[15], 30);
        assert_eq!(table[255], 40);
        assert_eq!(scale(&table, (15 << 4) + 8, 12), 31);
    }
}
