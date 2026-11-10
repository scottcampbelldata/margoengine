use crate::cdf_tables::Table;
use crate::cdfs::Cdfs;
use crate::entropy::Entropy;
use crate::tables::*;
use crate::transform::{HEIGHTS, Tx, WIDTHS, round};
use crate::{Error, Result};

pub struct Context {
    pub above_level: Vec<i32>,
    pub above_dc: Vec<i32>,
    pub left_level: Vec<i32>,
    pub left_dc: Vec<i32>,
}
impl Context {
    pub fn new(width4: usize, height4: usize) -> Self {
        Self {
            above_level: vec![0; width4],
            above_dc: vec![0; width4],
            left_level: vec![0; height4],
            left_dc: vec![0; height4],
        }
    }
    pub fn clear_left(&mut self) {
        self.left_level.fill(0);
        self.left_dc.fill(0);
    }
    pub fn update(&mut self, block: &Block, level: i32, dc: i32) {
        let w = WIDTHS[block.size] / 4;
        let h = HEIGHTS[block.size] / 4;
        for x in block.x4..(block.x4 + w).min(self.above_level.len()) {
            self.above_level[x] = level;
            self.above_dc[x] = dc;
        }
        for y in block.y4..(block.y4 + h).min(self.left_level.len()) {
            self.left_level[y] = level;
            self.left_dc[y] = dc;
        }
    }
    fn edges<'a>(&'a self, block: &Block) -> (&'a [i32], &'a [i32], &'a [i32], &'a [i32]) {
        let x = block.x4.min(self.above_level.len());
        let y = block.y4.min(self.left_level.len());
        let right = (x + WIDTHS[block.size] / 4).min(self.above_level.len());
        let bottom = (y + HEIGHTS[block.size] / 4).min(self.left_level.len());
        (
            &self.above_level[x..right],
            &self.left_level[y..bottom],
            &self.above_dc[x..right],
            &self.left_dc[y..bottom],
        )
    }
    pub fn all_zero(
        &mut self,
        e: &mut Entropy<'_>,
        cdfs: &mut Cdfs,
        block: &Block,
    ) -> Result<bool> {
        let (top, left, top_dc, left_dc) = self.edges(block);
        let w = WIDTHS[block.size];
        let h = HEIGHTS[block.size];
        let context = if block.plane == 0 {
            let top = top.iter().copied().max().unwrap_or(0).min(255);
            let left = left.iter().copied().max().unwrap_or(0).min(255);
            if block.block_width == w && block.block_height == h {
                0
            } else if top == 0 && left == 0 {
                1
            } else if top == 0 || left == 0 {
                2 + usize::from(top.max(left) > 3)
            } else if top.max(left) <= 3 {
                4
            } else if top.min(left) <= 3 {
                5
            } else {
                6
            }
        } else {
            let above = top.iter().chain(top_dc).any(|n| *n != 0);
            let side = left.iter().chain(left_dc).any(|n| *n != 0);
            7 + usize::from(above)
                + usize::from(side)
                + if block.block_width * block.block_height > w * h {
                    3
                } else {
                    0
                }
        };
        let zero = cdfs.read(e, Table::TxbSkip, &[block.size_context(), context])? != 0;
        if zero {
            self.update(block, 0, 0);
        }
        Ok(zero)
    }
    /// Read the nonzero coefficient syntax after the caller has chosen its transform type.
    pub fn nonzero(
        &mut self,
        e: &mut Entropy<'_>,
        cdfs: &mut Cdfs,
        block: &Block,
        tx: Tx,
    ) -> Result<Vec<i32>> {
        let ptype = usize::from(block.plane > 0);
        let context = block.size_context();
        let class = tx_class(tx);
        let w = WIDTHS[block.size].min(32);
        let h = HEIGHTS[block.size].min(32);
        let scan = scan(w, h, class);
        let category = w.trailing_zeros() + h.trailing_zeros() - 4;
        let table = [
            Table::EobPt16,
            Table::EobPt32,
            Table::EobPt64,
            Table::EobPt128,
            Table::EobPt256,
            Table::EobPt512,
            Table::EobPt1024,
        ][category as usize];
        let point = if category < 5 {
            cdfs.read(e, table, &[ptype, usize::from(class != 0)])?
        } else {
            cdfs.read(e, table, &[ptype])?
        } + 1;
        let mut eob = if point < 2 {
            point
        } else {
            (1 << (point - 2)) + 1
        };
        if point >= 3 {
            if cdfs.read(e, Table::EobExtra, &[context, ptype, point - 3])? != 0 {
                eob += 1 << (point - 3);
            }
            for shift in (0..point - 3).rev() {
                eob += usize::from(e.flag()?) << shift;
            }
        }
        if eob == 0 || eob > w * h {
            return Err(Error::Invalid);
        }
        let mut quant = vec![0_i32; w * h];
        for c in (0..eob).rev() {
            let pos = scan[c];
            let mut level = if c == eob - 1 {
                let ctx = if c == 0 {
                    0
                } else if c <= w * h / 8 {
                    1
                } else if c <= w * h / 4 {
                    2
                } else {
                    3
                };
                cdfs.read(e, Table::CoeffBaseEob, &[context, ptype, ctx])? as i32 + 1
            } else {
                let ctx = base_context(&quant, w, h, pos, block.size, class);
                cdfs.read(e, Table::CoeffBase, &[context, ptype, ctx])? as i32
            };
            if level > 2 {
                let ctx = br_context(&quant, w, h, pos, class);
                for _ in 0..4 {
                    let extra = cdfs.read(e, Table::CoeffBr, &[context.min(3), ptype, ctx])? as i32;
                    level += extra;
                    if extra < 3 {
                        break;
                    }
                }
            }
            quant[pos] = level;
        }
        let (_, _, top_dc, left_dc) = self.edges(block);
        let sign: i32 = top_dc
            .iter()
            .chain(left_dc)
            .map(|n| match n {
                1 => -1,
                2 => 1,
                _ => 0,
            })
            .sum();
        let sign_ctx = if sign < 0 {
            1
        } else if sign > 0 {
            2
        } else {
            0
        };
        let mut sum = 0;
        let mut dc_category = 0;
        for c in 0..eob {
            let pos = scan[c];
            let negative = if quant[pos] != 0 {
                if c == 0 {
                    cdfs.read(e, Table::DcSign, &[ptype, sign_ctx])? != 0
                } else {
                    e.flag()?
                }
            } else {
                false
            };
            if quant[pos] > 14 {
                quant[pos] = e.golomb()? as i32 + 15;
            }
            if pos == 0 && quant[pos] > 0 {
                dc_category = if negative { 1 } else { 2 };
            }
            quant[pos] &= 0xfffff;
            sum += quant[pos];
            if negative {
                quant[pos] = -quant[pos];
            }
        }
        self.update(block, sum.min(63), dc_category);
        Ok(quant)
    }
}
pub struct Block {
    pub plane: usize,
    pub x4: usize,
    pub y4: usize,
    pub size: usize,
    pub block_width: usize,
    pub block_height: usize,
}
impl Block {
    fn size_context(&self) -> usize {
        (WIDTHS[self.size].trailing_zeros() + HEIGHTS[self.size].trailing_zeros() - 3) as usize / 2
    }
}
pub fn tx_class(tx: Tx) -> usize {
    match tx {
        Tx::HDct | Tx::HAdst | Tx::HFlipadst => 1,
        Tx::VDct | Tx::VAdst | Tx::VFlipadst => 2,
        _ => 0,
    }
}
fn scan(w: usize, h: usize, class: usize) -> Vec<usize> {
    if class == 2 {
        return (0..w * h).collect();
    }
    if class == 1 {
        return (0..w)
            .flat_map(|x| (0..h).map(move |y| y * w + x))
            .collect();
    }
    let values: &[i32] = match (w, h) {
        (4, 4) => &DEFAULT_SCAN_4X4,
        (4, 8) => &DEFAULT_SCAN_4X8,
        (8, 4) => &DEFAULT_SCAN_8X4,
        (8, 8) => &DEFAULT_SCAN_8X8,
        (8, 16) => &DEFAULT_SCAN_8X16,
        (16, 8) => &DEFAULT_SCAN_16X8,
        (16, 16) => &DEFAULT_SCAN_16X16,
        (16, 32) => &DEFAULT_SCAN_16X32,
        (32, 16) => &DEFAULT_SCAN_32X16,
        (4, 16) => &DEFAULT_SCAN_4X16,
        (16, 4) => &DEFAULT_SCAN_16X4,
        (8, 32) => &DEFAULT_SCAN_8X32,
        (32, 8) => &DEFAULT_SCAN_32X8,
        _ => &DEFAULT_SCAN_32X32,
    };
    values.iter().map(|n| *n as usize).collect()
}
fn base_context(quant: &[i32], w: usize, h: usize, pos: usize, size: usize, class: usize) -> usize {
    let y = pos / w;
    let x = pos % w;
    let mut magnitude = 0;
    for offset in SIG_REF_DIFF_OFFSET[class] {
        let yy = y + offset[0] as usize;
        let xx = x + offset[1] as usize;
        if yy < h && xx < w {
            magnitude += quant[yy * w + xx].abs().min(3);
        }
    }
    let ctx = ((magnitude + 1) >> 1).min(4) as usize;
    if class == 0 {
        if pos == 0 {
            0
        } else {
            ctx + COEFF_BASE_CTX_OFFSET[size][y.min(4)][x.min(4)] as usize
        }
    } else {
        ctx + [26, 31, 36][if class == 2 { y.min(2) } else { x.min(2) }]
    }
}
fn br_context(quant: &[i32], w: usize, h: usize, pos: usize, class: usize) -> usize {
    let y = pos / w;
    let x = pos % w;
    let offsets = [
        [(0, 1), (1, 0), (1, 1)],
        [(0, 1), (1, 0), (0, 2)],
        [(0, 1), (1, 0), (2, 0)],
    ];
    let mut magnitude = 0;
    for (dy, dx) in offsets[class] {
        if y + dy < h && x + dx < w {
            magnitude += quant[(y + dy) * w + x + dx].min(15);
        }
    }
    let ctx = ((magnitude + 1) >> 1).min(6) as usize;
    if pos == 0 {
        ctx
    } else if (class == 0 && y < 2 && x < 2) || (class == 1 && x == 0) || (class == 2 && y == 0) {
        ctx + 7
    } else {
        ctx + 14
    }
}

pub fn dequantize(
    quant: &[i32],
    size: usize,
    tx: Tx,
    depth: u32,
    qindex: i32,
    delta_dc: i32,
    delta_ac: i32,
    matrix: Option<usize>,
    chroma: bool,
) -> Result<Vec<i32>> {
    if size >= WIDTHS.len() || ![8, 10, 12].contains(&depth) || matrix.is_some_and(|n| n > 15) {
        return Err(Error::Invalid);
    }
    let w = WIDTHS[size];
    let h = HEIGHTS[size];
    let tw = w.min(32);
    let th = h.min(32);
    if quant.len() != tw * th {
        return Err(Error::Invalid);
    }
    let band = (depth as usize - 8) / 2;
    let dc = DC_QLOOKUP[band][(qindex + delta_dc).clamp(0, 255) as usize];
    let ac = AC_QLOOKUP[band][(qindex + delta_ac).clamp(0, 255) as usize];
    let denominator = match size {
        3 | 9 | 10 | 17 | 18 => 2,
        4 | 11 | 12 => 4,
        _ => 1,
    };
    let mut out = vec![0; w * h];
    for y in 0..th {
        for x in 0..tw {
            let pos = y * tw + x;
            let mut q = if pos == 0 { dc } else { ac };
            if let Some(level) = matrix {
                if level < 15 && (tx as u8) < Tx::Identity as u8 {
                    q = round(
                        q as i64
                            * QUANTIZER_MATRIX[level][usize::from(chroma)]
                                [QM_OFFSET[size] as usize + pos]
                                as i64,
                        5,
                    );
                }
            }
            let product = quant[pos] as i64 * q as i64;
            let value = product.signum() * (product.abs() & 0xffffff) / denominator;
            let limit = 1_i64 << (7 + depth);
            out[y * w + x] = value.clamp(-limit, limit - 1) as i32;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_orders_are_complete_permutations_of_coded_coefficients() {
        for size in 0..19 {
            let w = WIDTHS[size].min(32);
            let h = HEIGHTS[size].min(32);
            for class in 0..3 {
                let mut order = scan(w, h, class);
                order.sort_unstable();
                assert_eq!(order, (0..w * h).collect::<Vec<_>>());
            }
        }
        assert_eq!(
            scan(4, 4, 0),
            vec![0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15]
        );
        assert_eq!(tx_class(Tx::HDct), 1);
        assert_eq!(tx_class(Tx::VDct), 2);
        assert_eq!(
            scan(4, 4, tx_class(Tx::HDct)),
            MCOL_SCAN_4X4
                .iter()
                .map(|x| *x as usize)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            scan(4, 4, tx_class(Tx::VDct)),
            MROW_SCAN_4X4
                .iter()
                .map(|x| *x as usize)
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn quantizer_dc_ac_and_24_bit_product_wrap_are_normative() {
        let mut q = [0; 16];
        q[0] = 1;
        q[1] = -1;
        let out = dequantize(&q, 0, Tx::DctDct, 8, 0, 0, 0, None, false).unwrap();
        assert_eq!(&out[..2], &[4, -4]);
        let q = [0xfffff; 16];
        let out = dequantize(&q, 0, Tx::DctDct, 12, 255, 0, 0, None, false).unwrap();
        let expected =
            ((0xfffff_i64 * DC_QLOOKUP[2][255] as i64) & 0xffffff).min((1 << 19) - 1) as i32;
        assert_eq!(out[0], expected);
    }
    #[test]
    fn zero_block_resets_all_covered_contexts() {
        let mut ctx = Context::new(8, 8);
        ctx.above_level.fill(63);
        ctx.left_level.fill(63);
        let block = Block {
            plane: 0,
            x4: 1,
            y4: 2,
            size: 1,
            block_width: 8,
            block_height: 8,
        };
        ctx.update(&block, 0, 0);
        assert_eq!(&ctx.above_level[..4], &[63, 0, 0, 63]);
        assert_eq!(&ctx.left_level[1..5], &[63, 0, 0, 63]);
    }
}
