//! Integer displacement syntax and the single-reference still-image MV stack (AV1 7.10).
use crate::cdf_tables::Table;
use crate::cdfs::Cdfs;
use crate::entropy::{Cdf, Entropy};
use crate::{Error, Result};

pub struct Models {
    joint: Cdf,
    sign: [Cdf; 2],
    class: [Cdf; 2],
    zero: [Cdf; 2],
    bit: [[Cdf; 10]; 2],
}
impl Models {
    pub fn new(cdfs: &mut Cdfs) -> Result<Self> {
        let joint = cdfs.model(Table::MvJoint, &[])?.clone();
        let sign = cdfs.model(Table::MvSign, &[])?.clone();
        let class = [
            cdfs.model(Table::MvClass, &[0])?.clone(),
            cdfs.model(Table::MvClass, &[1])?.clone(),
        ];
        let zero = cdfs.model(Table::MvClass0Bit, &[])?.clone();
        let bit = std::array::from_fn(|i| cdfs.model(Table::MvBit, &[i]).unwrap().clone());
        Ok(Self {
            joint,
            sign: [sign.clone(), sign],
            class,
            zero: [zero.clone(), zero],
            bit: [bit.clone(), bit],
        })
    }
    pub fn read(&mut self, e: &mut Entropy<'_>, pred: [i32; 2]) -> Result<[i32; 2]> {
        let joint = e.read(&mut self.joint)?;
        let mut mv = pred;
        for c in 0..2 {
            if !((c == 0 && joint >= 2) || (c == 1 && joint & 1 != 0)) {
                continue;
            }
            let negative = e.read(&mut self.sign[c])? != 0;
            let class = e.read(&mut self.class[c])?;
            let magnitude = if class == 0 {
                (e.read(&mut self.zero[c])? as i32 + 1) * 8
            } else {
                let mut value = 0;
                for i in 0..class {
                    value |= (e.read(&mut self.bit[c][i])? as i32) << i;
                }
                (2 << (class + 2)) + value * 8 + 8
            };
            mv[c] += if negative { -magnitude } else { magnitude };
        }
        if mv.iter().any(|v| v.abs() >= (1 << 14) || v & 7 != 0) {
            return Err(Error::Invalid);
        }
        Ok(mv)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Neighbor {
    pub width: usize,
    pub height: usize,
    pub mv: Option<[i32; 2]>,
}

pub fn predictor(
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    bounds: [usize; 4],
    frame_size: [usize; 2],
    sb128: bool,
    at: impl Fn(usize, usize) -> Neighbor,
) -> [i32; 2] {
    let [x0, y0, x1, y1] = bounds;
    let mut stack: Vec<([i32; 2], usize)> = Vec::new();
    let inside =
        |xx: i32, yy: i32| xx >= x0 as i32 && yy >= y0 as i32 && xx < x1 as i32 && yy < y1 as i32;
    let mut add = |xx: i32, yy: i32, weight: usize| {
        if !inside(xx, yy) {
            return;
        }
        if let Some(mv) = at(xx as usize, yy as usize).mv {
            if let Some(entry) = stack.iter_mut().find(|v| v.0 == mv) {
                entry.1 += weight;
            } else if stack.len() < 8 {
                stack.push((mv, weight));
            }
        }
    };
    // Immediate row and column are ranked separately from the outer ring.
    for (vertical, delta) in [(false, -1), (true, -1)] {
        let extent = if vertical {
            h.min(y1 - y)
        } else {
            w.min(x1 - x)
        }
        .min(16);
        let mut i = 0;
        while i < extent {
            let xx = x as i32 + if vertical { delta } else { i as i32 };
            let yy = y as i32 + if vertical { i as i32 } else { delta };
            if !inside(xx, yy) {
                break;
            }
            let n = at(xx as usize, yy as usize);
            let size = if vertical {
                n.height.min(h)
            } else {
                n.width.min(w)
            };
            let step = size.max(if (if vertical { h } else { w }) >= 16 {
                4
            } else {
                1
            });
            add(xx, yy, step * 2);
            i += step;
        }
    }
    if w.max(h) <= 16 {
        add((x + w) as i32, y as i32 - 1, 4);
    }
    drop(add);
    let nearest = stack.len();
    for entry in &mut stack {
        entry.1 += 640;
    }
    let mut add = |xx: i32, yy: i32, weight: usize| {
        if !inside(xx, yy) {
            return;
        }
        if let Some(mv) = at(xx as usize, yy as usize).mv {
            if let Some(entry) = stack.iter_mut().find(|v| v.0 == mv) {
                entry.1 += weight;
            } else if stack.len() < 8 {
                stack.push((mv, weight));
            }
        }
    };
    add(x as i32 - 1, y as i32 - 1, 4);
    for (vertical, delta) in [(false, -3), (true, -3), (false, -5), (true, -5)] {
        if delta == -5 && (if vertical { w } else { h }) <= 1 {
            continue;
        }
        let extent = if vertical {
            h.min(y1 - y)
        } else {
            w.min(x1 - x)
        }
        .min(16);
        let mut i = 0;
        while i < extent {
            let xx = x as i32
                + if vertical {
                    delta + (x & 1) as i32
                } else {
                    (1 - (x & 1) + i) as i32
                };
            let yy = y as i32
                + if vertical {
                    (1 - (y & 1) + i) as i32
                } else {
                    delta + (y & 1) as i32
                };
            if !inside(xx, yy) {
                break;
            }
            let n = at(xx as usize, yy as usize);
            let size = if vertical {
                n.height.min(h)
            } else {
                n.width.min(w)
            };
            let step = size.max(if (if vertical { h } else { w }) >= 16 {
                4
            } else {
                2
            });
            add(xx, yy, step * 2);
            i += step;
        }
    }
    drop(add);
    stack[..nearest].sort_by_key(|v| std::cmp::Reverse(v.1));
    stack[nearest..].sort_by_key(|v| std::cmp::Reverse(v.1));
    for entry in &mut stack {
        entry.0[0] = entry.0[0].clamp(
            -(y as i32) * 32 - 128 - h as i32 * 32,
            (frame_size[1] - y) as i32 * 32 + 128,
        );
        entry.0[1] = entry.0[1].clamp(
            -(x as i32) * 32 - 128 - w as i32 * 32,
            (frame_size[0] - x) as i32 * 32 + 128,
        );
    }
    // There are no inter-frame candidates in an intra still. Global candidates are zero.
    let mut pred = stack.first().map_or([0; 2], |v| v.0);
    if pred == [0; 2] {
        pred = stack.get(1).map_or([0; 2], |v| v.0);
    }
    if pred == [0; 2] {
        let sb = if sb128 { 32 } else { 16 };
        pred = if y < y0 + sb {
            [0, -((sb * 4 + 256) as i32) * 8]
        } else {
            [-((sb * 4) as i32) * 8, 0]
        };
    }
    pred
}

pub fn valid(
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    mv: [i32; 2],
    bounds: [usize; 4],
    sb128: bool,
    chroma: bool,
    sub: [bool; 2],
) -> bool {
    let [x0, y0, x1, y1] = bounds.map(|v| v as i32 * 4);
    let left = x as i32 * 4 + mv[1] / 8;
    let top = y as i32 * 4 + mv[0] / 8;
    let right = left + w as i32;
    let bottom = top + h as i32;
    if left - i32::from(chroma && w < 8 && sub[0]) * 4 < x0
        || top - i32::from(chroma && h < 8 && sub[1]) * 4 < y0
        || right > x1
        || bottom > y1
    {
        return false;
    }
    let sbh = if sb128 { 128 } else { 64 };
    let active_row = y as i32 * 4 / sbh;
    let active_col = x as i32 * 4 >> 6;
    let source_row = (bottom - 1) / sbh;
    let source_col = (right - 1) >> 6;
    let columns = ((x1 - x0 - 4) >> 6) + 1;
    source_row * columns + source_col < active_row * columns + active_col - 4
        && source_row <= active_row
        && source_col < active_col - 4 + (5 + i32::from(sb128)) * (active_row - source_row)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_requires_decoded_distant_tile_region() {
        assert_eq!(
            predictor(0, 0, 2, 2, [0, 0, 256, 256], [256, 256], false, |_, _| {
                Neighbor::default()
            }),
            [0, -2560]
        );
        assert!(valid(
            96,
            0,
            8,
            8,
            [0, -2560],
            [0, 0, 256, 256],
            false,
            false,
            [true, true]
        ));
        assert!(!valid(
            96,
            0,
            8,
            8,
            [0, -8],
            [0, 0, 256, 256],
            false,
            false,
            [true, true]
        ));
    }
}
