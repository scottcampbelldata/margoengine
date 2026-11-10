//! Super-resolution and restoration-stripe filters. All arithmetic is integer and seek independent.
use crate::frame::Frame;
use crate::reconstruct::Reconstruction;
use crate::restoration::Unit;
use crate::sequence::Sequence;
use crate::tables::{SGR_PARAMS, UPSCALE_FILTER};
use crate::transform::round;

#[derive(Clone)]
pub struct ImagePlane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u16>,
}
/// Upscale to the visible width, or crop coded padding when super-resolution is disabled.
pub fn upscale(
    source: &[Vec<u16>],
    layout: &Reconstruction,
    seq: &Sequence,
    frame: &Frame,
) -> Vec<ImagePlane> {
    let mut out = Vec::new();
    for (plane, samples) in source.iter().enumerate() {
        let sx = u32::from(plane > 0 && seq.color.sub_x);
        let sy = u32::from(plane > 0 && seq.color.sub_y);
        let width = frame.upscaled_width.div_ceil(1 << sx) as usize;
        let height = frame.height.div_ceil(1 << sy) as usize;
        let coded = frame.width.div_ceil(1 << sx) as usize;
        let stride = layout.planes[plane].width;
        let mut data = vec![0; width * height];
        if frame.superres_denom == 8 {
            for y in 0..height {
                data[y * width..(y + 1) * width]
                    .copy_from_slice(&samples[y * stride..y * stride + width]);
            }
        } else {
            let step = (((coded as i64) << 14) + width as i64 / 2) / width as i64;
            let error = width as i64 * step - ((coded as i64) << 14);
            let initial = ((-(((width - coded) as i64) << 13) + width as i64 / 2) / width as i64
                + 128
                - error / 2)
                & 16383;
            for y in 0..height {
                for x in 0..width {
                    let coordinate = -16384 + initial + x as i64 * step;
                    let integer = coordinate >> 14;
                    let phase = ((coordinate & 16383) >> 8) as usize;
                    let mut sum = 0_i64;
                    for k in 0..8 {
                        let sample_x = (integer + k as i64 - 3)
                            .clamp(0, layout.planes[plane].coded_width as i64 - 1)
                            as usize;
                        sum +=
                            samples[y * stride + sample_x] as i64 * UPSCALE_FILTER[phase][k] as i64;
                    }
                    data[y * width + x] = round(sum, 7).clamp(0, (1 << seq.color.depth) - 1) as u16;
                }
            }
        }
        out.push(ImagePlane {
            width,
            height,
            data,
        });
    }
    out
}
struct Stripe<'a> {
    deblocked: &'a ImagePlane,
    cdef: &'a ImagePlane,
    start: i32,
    end: i32,
    depth: u32,
}
impl Stripe<'_> {
    fn source(&self, x: i32, y: i32) -> i64 {
        let x = x.clamp(0, self.cdef.width as i32 - 1) as usize;
        let y = y.clamp(0, self.cdef.height as i32 - 1);
        let (plane, y) = if y < self.start {
            (self.deblocked, y.max(self.start - 2))
        } else if y > self.end {
            (self.deblocked, y.min(self.end + 2))
        } else {
            (self.cdef, y)
        };
        plane.data[y as usize * plane.width + x] as i64
    }
    fn wiener(&self, unit: &Unit, x: usize, y: usize, w: usize, h: usize) -> Vec<u16> {
        fn kernel(coeff: &[i32; 3]) -> [i64; 7] {
            [
                coeff[0] as i64,
                coeff[1] as i64,
                coeff[2] as i64,
                (128 - 2 * coeff.iter().sum::<i32>()) as i64,
                coeff[2] as i64,
                coeff[1] as i64,
                coeff[0] as i64,
            ]
        }
        let vertical = kernel(&unit.wiener[0]);
        let horizontal = kernel(&unit.wiener[1]);
        let first_shift = if self.depth == 12 { 5 } else { 3 };
        let offset = 1 << (self.depth + 7 - first_shift - 1);
        let limit = (1 << (self.depth + 1 + 7 - first_shift)) - 1;
        let mut temporary = vec![0; (h + 6) * w];
        for r in 0..h + 6 {
            for c in 0..w {
                let mut sum = 0;
                for t in 0..7 {
                    sum += horizontal[t]
                        * self.source(x as i32 + c as i32 + t as i32 - 3, y as i32 + r as i32 - 3);
                }
                temporary[r * w + c] = round(sum, first_shift).clamp(-offset, limit - offset);
            }
        }
        let mut data = vec![0; w * h];
        for r in 0..h {
            for c in 0..w {
                let mut sum = 0;
                for t in 0..7 {
                    sum += vertical[t] * temporary[(r + t) * w + c] as i64;
                }
                data[r * w + c] =
                    round(sum, 14 - first_shift).clamp(0, (1 << self.depth) - 1) as u16;
            }
        }
        data
    }
    fn box_filter(
        &self,
        set: usize,
        pass: usize,
        x: usize,
        y: usize,
        w: usize,
        h: usize,
    ) -> Vec<i32> {
        let radius = SGR_PARAMS[set][pass * 2];
        if radius == 0 {
            return Vec::new();
        }
        let eps = SGR_PARAMS[set][pass * 2 + 1] as i64;
        let n = ((2 * radius + 1) * (2 * radius + 1)) as i64;
        let n2e = n * n * eps;
        let scale = ((1 << 20) + n2e / 2) / n2e;
        let reciprocal = ((1 << 12) + n / 2) / n;
        let mut a = vec![0_i64; (w + 2) * (h + 2)];
        let mut b = a.clone();
        for r in -1..=h as i32 {
            for c in -1..=w as i32 {
                if pass == 0 && r & 1 == 0 {
                    continue;
                }
                let mut square_sum = 0;
                let mut sum = 0;
                for dy in -radius..=radius {
                    for dx in -radius..=radius {
                        let sample = self.source(x as i32 + c + dx, y as i32 + r + dy);
                        square_sum += sample * sample;
                        sum += sample;
                    }
                }
                let squares = round(square_sum, 2 * (self.depth - 8)) as i64;
                let scaled_sum = round(sum, self.depth - 8) as i64;
                let p = (squares * n - scaled_sum * scaled_sum).max(0);
                let z = round(p * scale, 20) as i64;
                let a2 = if z >= 255 {
                    256
                } else if z == 0 {
                    1
                } else {
                    ((z << 8) + z / 2) / (z + 1)
                };
                let index = (r + 1) as usize * (w + 2) + (c + 1) as usize;
                a[index] = a2;
                b[index] = round((256 - a2) * sum * reciprocal, 12) as i64;
            }
        }
        let mut out = vec![0; w * h];
        for r in 0..h {
            for c in 0..w {
                let shift = if pass == 0 && r & 1 != 0 { 4 } else { 5 };
                let mut aa = 0;
                let mut bb = 0;
                for dy in -1_i32..=1 {
                    for dx in -1_i32..=1 {
                        let weight = if pass == 0 {
                            if (r as i32 + dy) & 1 != 0 {
                                if dx == 0 { 6 } else { 5 }
                            } else {
                                0
                            }
                        } else if dx == 0 || dy == 0 {
                            4
                        } else {
                            3
                        };
                        let index =
                            (r as i32 + dy + 1) as usize * (w + 2) + (c as i32 + dx + 1) as usize;
                        aa += weight * a[index];
                        bb += weight * b[index];
                    }
                }
                let center = self.cdef.data[(y + r) * self.cdef.width + x + c] as i64;
                out[r * w + c] = round(aa * center + bb, 8 + shift - 4);
            }
        }
        out
    }
    fn sgr(&self, unit: &Unit, x: usize, y: usize, w: usize, h: usize) -> Vec<u16> {
        let first = self.box_filter(unit.sgr_set, 0, x, y, w, h);
        let second = self.box_filter(unit.sgr_set, 1, x, y, w, h);
        let w0 = unit.xqd[0] as i64;
        let w1 = unit.xqd[1] as i64;
        let w2 = 128 - w0 - w1;
        let mut out = vec![0; w * h];
        for r in 0..h {
            for c in 0..w {
                let pos = r * w + c;
                let original = (self.cdef.data[(y + r) * self.cdef.width + x + c] as i64) << 4;
                let a = if first.is_empty() {
                    original
                } else {
                    first[pos] as i64
                };
                let b = if second.is_empty() {
                    original
                } else {
                    second[pos] as i64
                };
                out[pos] = round(w1 * original + w0 * a + w2 * b, 11)
                    .clamp(0, (1 << self.depth) - 1) as u16;
            }
        }
        out
    }
}
pub fn restore(
    deblocked: &[ImagePlane],
    cdef: &[ImagePlane],
    layout: &Reconstruction,
    seq: &Sequence,
    frame: &Frame,
) -> Vec<ImagePlane> {
    let mut out = cdef.to_vec();
    for y in (0..frame.height as usize).step_by(4) {
        for x in (0..frame.upscaled_width as usize).step_by(4) {
            for plane in 0..out.len() {
                if frame.restoration[plane] == 0 {
                    continue;
                }
                let sx = usize::from(plane > 0 && seq.color.sub_x);
                let sy = usize::from(plane > 0 && seq.color.sub_y);
                let units = &layout.restoration.planes[plane];
                let unit_size = frame.restoration_size[plane] as usize;
                let row = (((y + 8) >> sy) / unit_size).min(units.rows - 1);
                let col = ((x >> sx) / unit_size).min(units.columns - 1);
                let unit = &units.units[row * units.columns + col];
                if unit.mode == 0 {
                    continue;
                }
                let stripe_num = (y + 8) / 64;
                let start = (-8 + stripe_num as i32 * 64) >> sy;
                let stripe = Stripe {
                    deblocked: &deblocked[plane],
                    cdef: &cdef[plane],
                    start,
                    end: start + (64 >> sy) - 1,
                    depth: seq.color.depth,
                };
                let xx = x >> sx;
                let yy = y >> sy;
                let width = (4 >> sx).min(out[plane].width - xx);
                let height = (4 >> sy).min(out[plane].height - yy);
                let filtered = if unit.mode == 1 {
                    stripe.wiener(unit, xx, yy, width, height)
                } else {
                    stripe.sgr(unit, xx, yy, width, height)
                };
                for r in 0..height {
                    let at = (yy + r) * out[plane].width + xx;
                    out[plane].data[at..at + width]
                        .copy_from_slice(&filtered[r * width..(r + 1) * width]);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wiener_and_all_sgr_sets_match_frozen_constant_vectors() {
        for depth in [8, 10, 12] {
            let value = (1 << (depth - 1)) + 17;
            let source = ImagePlane {
                width: 16,
                height: 16,
                data: vec![value; 256],
            };
            let stripe = Stripe {
                deblocked: &source,
                cdef: &source,
                start: 4,
                end: 11,
                depth,
            };
            let mut unit = Unit {
                mode: 1,
                wiener: [[3, -7, 15]; 2],
                ..Unit::default()
            };
            assert_eq!(stripe.wiener(&unit, 0, 0, 4, 4), vec![value; 16]);
            for set in 0..16 {
                unit.sgr_set = set;
                unit.xqd = [-32, 31];
                // SGR's 12-bit reciprocal for the radius-one box is 455/4096,
                // rather than 1/9. For C=2065 the normative integer calculation
                // gives F1=33032 in Q4, so these sets output 2064. Wiener has
                // unit DC gain; SGR's rounded reciprocals do not preserve it exactly.
                let expected = if depth == 12 && set < 14 { 2064 } else { value };
                assert_eq!(
                    stripe.sgr(&unit, 0, 0, 4, 4),
                    vec![expected; 16],
                    "depth{depth} set{set}"
                );
            }
        }
    }
    #[test]
    fn stripe_uses_exactly_two_deblocked_rows_outside_cdef_region() {
        let before = ImagePlane {
            width: 8,
            height: 16,
            data: (0..128).map(|n| n as u16).collect(),
        };
        let after = ImagePlane {
            width: 8,
            height: 16,
            data: vec![200; 128],
        };
        let stripe = Stripe {
            deblocked: &before,
            cdef: &after,
            start: 4,
            end: 11,
            depth: 8,
        };
        assert_eq!(stripe.source(0, 0), 16);
        assert_eq!(stripe.source(0, 3), 24);
        assert_eq!(stripe.source(0, 4), 200);
        assert_eq!(stripe.source(0, 12), 96);
        assert_eq!(stripe.source(0, 15), 104);
    }
}
