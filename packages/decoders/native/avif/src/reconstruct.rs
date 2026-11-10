//! Intra tile reconstruction. Frame filters and container display transforms are separate stages.
use crate::cdf_tables::Table;
use crate::cdfs::Cdfs;
use crate::coefficients::{self, Block as CoeffBlock, Context};
use crate::entropy::{Cdf, Entropy};
use crate::frame::Frame;
use crate::intrabc;
use crate::palette::{self, Palette};
use crate::prediction::{self, Intra, References};
use crate::restoration::{Predictors, Restoration};
use crate::sequence::Sequence;
use crate::transform::{self, HEIGHTS, Tx, WIDTHS};
use crate::{Error, Result};

const BLOCK_W: [usize; 22] = [
    4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64, 128, 128, 4, 16, 8, 32, 16, 64,
];
const BLOCK_H: [usize; 22] = [
    4, 8, 4, 8, 16, 8, 16, 32, 16, 32, 64, 32, 64, 128, 64, 128, 16, 4, 32, 8, 64, 16,
];

pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub coded_width: usize,
    pub coded_height: usize,
    pub data: Vec<u16>,
    pub transform_sizes: Vec<u8>,
    transform_types: Vec<Tx>,
    decoded: Vec<bool>,
}
impl Plane {
    pub(crate) fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            coded_width: width,
            coded_height: height,
            data: vec![0; width * height],
            transform_sizes: vec![0; width * height / 16],
            transform_types: vec![Tx::DctDct; width * height / 16],
            decoded: vec![false; width * height / 16],
        }
    }
    fn at(&self, x: usize, y: usize) -> u16 {
        self.data[y * self.width + x]
    }
    fn done(&self, x: usize, y: usize) -> bool {
        x < self.coded_width
            && y < self.coded_height
            && self.decoded[(y / 4) * (self.width / 4) + x / 4]
    }
}
#[derive(Clone, Copy, Debug)]
pub struct BlockInfo {
    pub width: u8,
    pub height: u8,
    pub y_mode: u8,
    pub uv_mode: u8,
    pub skip: bool,
    pub segment: u8,
    pub tx: u8,
    pub qindex: u8,
    pub delta_lf: [i8; 4],
    pub palettes: [u32; 2],
    pub mv: Option<[i32; 2]>,
}
impl Default for BlockInfo {
    fn default() -> Self {
        Self {
            width: 4,
            height: 4,
            y_mode: 0,
            uv_mode: 0,
            skip: false,
            segment: 0,
            tx: 0,
            qindex: 0,
            delta_lf: [0; 4],
            palettes: [0; 2],
            mv: None,
        }
    }
}
pub struct Reconstruction {
    pub planes: Vec<Plane>,
    pub blocks: Vec<BlockInfo>,
    pub block_stride: usize,
    pub cdef_indices: Vec<i8>,
    pub restoration: Restoration,
    /// Counts actual tool uses, retained by development probes for corpus coverage.
    pub tool_counts: [u32; 2],
    palette_colors: Vec<Vec<u16>>,
    max_luma_width: usize,
    max_luma_height: usize,
}
impl Reconstruction {
    pub fn new(seq: &Sequence, frame: &Frame) -> Self {
        let mi_cols = 2 * frame.width.div_ceil(8) as usize;
        let mi_rows = 2 * frame.height.div_ceil(8) as usize;
        let mut planes = Vec::new();
        for plane in 0..if seq.color.monochrome { 1 } else { 3 } {
            let sx = usize::from(plane > 0 && seq.color.sub_x);
            let sy = usize::from(plane > 0 && seq.color.sub_y);
            let mut pixels = Plane::new(
                (mi_cols * 4).div_ceil(128) * 128 >> sx,
                (mi_rows * 4).div_ceil(128) * 128 >> sy,
            );
            pixels.coded_width = (mi_cols * 4) >> sx;
            pixels.coded_height = (mi_rows * 4) >> sy;
            planes.push(pixels);
        }
        let block_stride = mi_cols + 32;
        Self {
            planes,
            blocks: vec![BlockInfo::default(); block_stride * (mi_rows + 32)],
            block_stride,
            cdef_indices: vec![-1; block_stride * (mi_rows + 32)],
            restoration: Restoration::new(frame, seq),
            tool_counts: [0; 2],
            palette_colors: vec![Vec::new()],
            max_luma_width: 0,
            max_luma_height: 0,
        }
    }
    pub fn tile(&mut self, seq: &Sequence, frame: &Frame, id: usize, bytes: &[u8]) -> Result<()> {
        let columns = frame.tiles.columns.len() - 1;
        let row = id / columns;
        let col = id % columns;
        if row >= frame.tiles.rows.len() - 1 {
            return Err(Error::Invalid);
        }
        let x0 = frame.tiles.columns[col] as usize;
        let x1 = frame.tiles.columns[col + 1] as usize;
        let y0 = frame.tiles.rows[row] as usize;
        let y1 = frame.tiles.rows[row + 1] as usize;
        let contexts = self
            .planes
            .iter()
            .map(|p| Context::new(p.coded_width / 4, p.coded_height / 4))
            .collect();
        let delta_model = Cdf::new(&[28160, 32120, 32677, 32768])?;
        let mut cdfs = Cdfs::new(frame.base_q)?;
        let mv_models = intrabc::Models::new(&mut cdfs)?;
        let mut tile = Tile {
            seq,
            frame,
            output: self,
            e: Entropy::new(bytes, frame.update_cdf)?,
            cdfs,
            mv_models,
            contexts,
            x0,
            y0,
            x1,
            y1,
            qindex: frame.base_q as i32,
            delta_lf: [0; 4],
            read_deltas: false,
            delta_lf_models: std::array::from_fn(|_| delta_model.clone()),
        };
        let sb = if seq.superblock_128 { 32 } else { 16 };
        let mut restoration_predictors = Predictors::default();
        for y in (y0..y1).step_by(sb) {
            for context in &mut tile.contexts {
                context.clear_left();
            }
            for x in (x0..x1).step_by(sb) {
                tile.read_deltas = frame.delta_q_res.is_some();
                tile.output.restoration.read_superblock(
                    &mut tile.e,
                    &mut tile.cdfs,
                    &mut restoration_predictors,
                    seq,
                    frame,
                    y as u32,
                    x as u32,
                )?;
                tile.partition(x, y, sb * 4)?;
            }
        }
        tile.e.finish()
    }
}
struct Tile<'a, 'b> {
    seq: &'a Sequence,
    frame: &'a Frame,
    output: &'b mut Reconstruction,
    e: Entropy<'a>,
    cdfs: Cdfs,
    contexts: Vec<Context>,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    qindex: i32,
    delta_lf: [i32; 4],
    read_deltas: bool,
    delta_lf_models: [Cdf; 4],
    mv_models: intrabc::Models,
}
#[derive(Debug)]
struct Mode {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    y_mode: usize,
    uv_mode: usize,
    angle_y: i32,
    angle_uv: i32,
    cfl: [i32; 2],
    filter: Option<usize>,
    segment: usize,
    skip: bool,
    tx_size: usize,
    has_chroma: bool,
    palette: Palette,
    mv: Option<[i32; 2]>,
}
impl Tile<'_, '_> {
    fn info(&self, x: usize, y: usize) -> BlockInfo {
        self.output.blocks[y * self.output.block_stride + x]
    }
    fn read(&mut self, table: Table, indices: &[usize]) -> Result<usize> {
        self.cdfs.read(&mut self.e, table, indices)
    }
    fn partition(&mut self, x: usize, y: usize, size: usize) -> Result<()> {
        if x >= self.x1 || y >= self.y1 {
            return Ok(());
        }
        if size == 4 {
            return self.block(x, y, size, size);
        }
        let half = size / 8;
        let rows = y + half < self.y1;
        let cols = x + half < self.x1;
        let context = usize::from(x > self.x0 && (self.info(x - 1, y).height as usize) < size) * 2
            + usize::from(y > self.y0 && (self.info(x, y - 1).width as usize) < size);
        let table = match size {
            8 => Table::PartitionW8,
            16 => Table::PartitionW16,
            32 => Table::PartitionW32,
            64 => Table::PartitionW64,
            128 => Table::PartitionW128,
            _ => return Err(Error::Invalid),
        };
        let part = if rows && cols {
            self.read(table, &[context])?
        } else if !rows && !cols {
            3
        } else {
            let thresholds = self.cdfs.model(table, &[context])?.thresholds();
            let symbols: &[usize] = if cols {
                &[2, 3, 4, 6, 7, 9]
            } else {
                &[1, 3, 4, 5, 6, 8]
            };
            let mut mass = 0;
            for symbol in symbols {
                if *symbol < thresholds.len() {
                    mass += thresholds[*symbol] - thresholds[*symbol - 1];
                }
            }
            let mut cdf = Cdf::new(&[32768 - mass, 32768])?;
            if self.e.read(&mut cdf)? != 0 {
                3
            } else if cols {
                1
            } else {
                2
            }
        };
        let half_px = size / 2;
        let quarter = half / 2;
        match part {
            0 => self.block(x, y, size, size),
            1 => {
                self.block(x, y, size, half_px)?;
                if rows {
                    self.block(x, y + half, size, half_px)?;
                }
                Ok(())
            }
            2 => {
                self.block(x, y, half_px, size)?;
                if cols {
                    self.block(x + half, y, half_px, size)?;
                }
                Ok(())
            }
            3 => {
                self.partition(x, y, half_px)?;
                self.partition(x + half, y, half_px)?;
                self.partition(x, y + half, half_px)?;
                self.partition(x + half, y + half, half_px)
            }
            4 => {
                self.block(x, y, half_px, half_px)?;
                self.block(x + half, y, half_px, half_px)?;
                self.block(x, y + half, size, half_px)
            }
            5 => {
                self.block(x, y, size, half_px)?;
                self.block(x, y + half, half_px, half_px)?;
                self.block(x + half, y + half, half_px, half_px)
            }
            6 => {
                self.block(x, y, half_px, half_px)?;
                self.block(x, y + half, half_px, half_px)?;
                self.block(x + half, y, half_px, size)
            }
            7 => {
                self.block(x, y, half_px, size)?;
                self.block(x + half, y, half_px, half_px)?;
                self.block(x + half, y + half, half_px, half_px)
            }
            8 => {
                for i in 0..4 {
                    if y + quarter * i < self.y1 {
                        self.block(x, y + quarter * i, size, size / 4)?;
                    }
                }
                Ok(())
            }
            9 => {
                for i in 0..4 {
                    if x + quarter * i < self.x1 {
                        self.block(x + quarter * i, y, size / 4, size)?;
                    }
                }
                Ok(())
            }
            _ => Err(Error::Invalid),
        }
    }
    fn segment(&mut self, x: usize, y: usize, skip: bool) -> Result<usize> {
        if !self.frame.segmentation {
            return Ok(0);
        }
        let top = if y > self.y0 {
            self.info(x, y - 1).segment as i32
        } else {
            -1
        };
        let left = if x > self.x0 {
            self.info(x - 1, y).segment as i32
        } else {
            -1
        };
        let corner = if y > self.y0 && x > self.x0 {
            self.info(x - 1, y - 1).segment as i32
        } else {
            -1
        };
        let pred = if top < 0 {
            left.max(0)
        } else if left < 0 || corner == top {
            top
        } else {
            left
        } as usize;
        if skip {
            return Ok(pred);
        }
        let context = if corner < 0 {
            0
        } else if corner == top && corner == left {
            2
        } else if corner == top || corner == left || top == left {
            1
        } else {
            0
        };
        let diff = self.read(Table::SegmentId, &[context])?;
        let max = self.frame.last_active_segment as usize + 1;
        if diff >= max {
            return Err(Error::Invalid);
        }
        let result = if pred == 0 {
            diff
        } else if pred >= max - 1 {
            max - diff - 1
        } else if 2 * pred < max {
            if diff <= 2 * pred {
                if diff & 1 != 0 {
                    pred + diff.div_ceil(2)
                } else {
                    pred - diff / 2
                }
            } else {
                diff
            }
        } else if diff <= 2 * (max - pred - 1) {
            if diff & 1 != 0 {
                pred + diff.div_ceil(2)
            } else {
                pred - diff / 2
            }
        } else {
            max - diff - 1
        };
        Ok(result)
    }
    fn delta(&mut self, table: Table, multi: Option<usize>) -> Result<i32> {
        let mut absolute = if let Some(index) = multi {
            self.e.read(&mut self.delta_lf_models[index])?
        } else {
            self.read(table, &[])?
        } as i32;
        if absolute == 3 {
            let bits = self.e.literal(3)? + 1;
            absolute = self.e.literal(bits)? as i32 + (1 << bits) + 1;
        }
        if absolute != 0 && self.e.flag()? {
            absolute = -absolute;
        }
        Ok(absolute)
    }
    fn block(&mut self, x: usize, y: usize, w: usize, h: usize) -> Result<()> {
        let size_id = (0..22)
            .find(|i| BLOCK_W[*i] == w && BLOCK_H[*i] == h)
            .ok_or(Error::Invalid)?;
        let has_chroma = !self.seq.color.monochrome
            && !(h == 4 && self.seq.color.sub_y && y & 1 == 0)
            && !(w == 4 && self.seq.color.sub_x && x & 1 == 0);
        let mut segment = if self.frame.segment_pre_skip {
            self.segment(x, y, false)?
        } else {
            0
        };
        let skip = if self.frame.segment_pre_skip && self.frame.segments[segment].enabled[6] {
            true
        } else {
            let context = usize::from(y > self.y0 && self.info(x, y - 1).skip)
                + usize::from(x > self.x0 && self.info(x - 1, y).skip);
            self.read(Table::Skip, &[context])? != 0
        };
        if !self.frame.segment_pre_skip {
            segment = self.segment(x, y, skip)?;
        }
        let lossless = self.frame.segments[segment].lossless;
        if !skip && !self.frame.coded_lossless && self.seq.cdef && !self.frame.intrabc {
            let start = (y & !15) * self.output.block_stride + (x & !15);
            if self.output.cdef_indices[start] < 0 {
                let index = self.e.literal(self.frame.cdef.bits)? as i8;
                for yy in (y & !15..(y & !15) + h / 4).step_by(16) {
                    for xx in (x & !15..(x & !15) + w / 4).step_by(16) {
                        self.output.cdef_indices[yy * self.output.block_stride + xx] = index;
                    }
                }
            }
        }
        if self.read_deltas
            && !(skip
                && w == if self.seq.superblock_128 { 128 } else { 64 }
                && h == if self.seq.superblock_128 { 128 } else { 64 })
        {
            if let Some(res) = self.frame.delta_q_res {
                self.qindex =
                    (self.qindex + (self.delta(Table::DeltaQ, None)? << res)).clamp(1, 255);
            }
            if let Some(res) = self.frame.delta_lf_res {
                let count = if self.frame.delta_lf_multi {
                    if self.seq.color.monochrome { 2 } else { 4 }
                } else {
                    1
                };
                for i in 0..count {
                    let delta =
                        self.delta(Table::DeltaLf, self.frame.delta_lf_multi.then_some(i))?;
                    self.delta_lf[i] = (self.delta_lf[i] + (delta << res)).clamp(-63, 63);
                }
            }
        }
        self.read_deltas = false;
        let mv = if self.frame.intrabc && self.read(Table::Intrabc, &[])? != 0 {
            let bounds = [self.x0, self.y0, self.x1, self.y1];
            let pred = intrabc::predictor(
                x,
                y,
                w / 4,
                h / 4,
                bounds,
                [
                    2 * self.frame.width.div_ceil(8) as usize,
                    2 * self.frame.height.div_ceil(8) as usize,
                ],
                self.seq.superblock_128,
                |xx, yy| {
                    let n = self.info(xx, yy);
                    intrabc::Neighbor {
                        width: n.width as usize / 4,
                        height: n.height as usize / 4,
                        mv: n.mv,
                    }
                },
            );
            let mv = self.mv_models.read(&mut self.e, pred)?;
            if !intrabc::valid(
                x,
                y,
                w,
                h,
                mv,
                bounds,
                self.seq.superblock_128,
                has_chroma,
                [self.seq.color.sub_x, self.seq.color.sub_y],
            ) {
                return Err(Error::Invalid);
            }
            Some(mv)
        } else {
            None
        };
        let context = [0, 1, 2, 3, 4, 4, 4, 4, 3, 0, 1, 2, 0];
        let above = if y > self.y0 {
            context[self.info(x, y - 1).y_mode as usize]
        } else {
            0
        };
        let left = if x > self.x0 {
            context[self.info(x - 1, y).y_mode as usize]
        } else {
            0
        };
        let y_mode = if mv.is_some() {
            0
        } else {
            self.read(Table::IntraFrameYMode, &[above, left])?
        };
        let angle_y = if size_id >= 3 && (1..=8).contains(&y_mode) {
            self.read(Table::AngleDelta, &[y_mode - 1])? as i32 - 3
        } else {
            0
        };
        let mut uv_mode = 0;
        let mut angle_uv = 0;
        let mut cfl = [0; 2];
        if has_chroma && mv.is_none() {
            let uv_w = (w >> usize::from(self.seq.color.sub_x)).max(4);
            let uv_h = (h >> usize::from(self.seq.color.sub_y)).max(4);
            let cfl_allowed = if lossless {
                uv_w == 4 && uv_h == 4
            } else {
                w.max(h) <= 32
            };
            uv_mode = self.read(
                if cfl_allowed {
                    Table::UvModeCflAllowed
                } else {
                    Table::UvModeCflNotAllowed
                },
                &[y_mode],
            )?;
            if uv_mode == 13 {
                let signs = self.read(Table::CflSign, &[])? + 1;
                let u = signs / 3;
                let v = signs % 3;
                if u != 0 {
                    cfl[0] = (self.read(Table::CflAlpha, &[(u - 1) * 3 + v])? as i32 + 1)
                        * if u == 1 { -1 } else { 1 };
                }
                if v != 0 {
                    cfl[1] = (self.read(Table::CflAlpha, &[(v - 1) * 3 + u])? as i32 + 1)
                        * if v == 1 { -1 } else { 1 };
                }
            }
            if size_id >= 3 && (1..=8).contains(&uv_mode) {
                angle_uv = self.read(Table::AngleDelta, &[uv_mode - 1])? as i32 - 3;
            }
        }
        let mut palette = Palette::default();
        if mv.is_none() && self.frame.screen_content && size_id >= 3 && w <= 64 && h <= 64 {
            let block_context = (w.trailing_zeros() + h.trailing_zeros() - 6) as usize;
            if y_mode == 0 {
                let context = usize::from(y > self.y0 && self.info(x, y - 1).palettes[0] != 0)
                    + usize::from(x > self.x0 && self.info(x - 1, y).palettes[0] != 0);
                if self.read(Table::PaletteYMode, &[block_context, context])? != 0 {
                    let count = self.read(Table::PaletteYSize, &[block_context])? + 2;
                    let cache = self.palette_cache(x, y, 0);
                    palette.colors[0] =
                        palette::colors(&mut self.e, &cache, count, self.seq.color.depth, true)?;
                }
            }
            if has_chroma
                && uv_mode == 0
                && self.read(
                    Table::PaletteUvMode,
                    &[usize::from(!palette.colors[0].is_empty())],
                )? != 0
            {
                let count = self.read(Table::PaletteUvSize, &[block_context])? + 2;
                let cache = self.palette_cache(x, y, 1);
                palette.colors[1] =
                    palette::colors(&mut self.e, &cache, count, self.seq.color.depth, false)?;
                palette.colors[2] = palette::v_colors(&mut self.e, count, self.seq.color.depth)?;
            }
        }
        let filter = if mv.is_none()
            && self.seq.filter_intra
            && y_mode == 0
            && palette.colors[0].is_empty()
            && w <= 32
            && h <= 32
            && self.read(Table::FilterIntra, &[size_id])? != 0
        {
            Some(self.read(Table::FilterIntraMode, &[])?)
        } else {
            None
        };
        for p in 0..2 {
            if palette.colors[p].is_empty() {
                continue;
            }
            let sx = usize::from(p > 0 && self.seq.color.sub_x);
            let sy = usize::from(p > 0 && self.seq.color.sub_y);
            let visible_w = ((w.min((self.x1 - x) * 4)) >> sx).max(4);
            let visible_h = ((h.min((self.y1 - y) * 4)) >> sy).max(4);
            palette.maps[p] = palette::tokens(
                &mut self.e,
                &mut self.cdfs,
                palette.colors[p].len(),
                p > 0,
                (w >> sx).max(4),
                (h >> sy).max(4),
                visible_w,
                visible_h,
            )?;
        }
        let mut tw = w.min(64);
        let mut th = h.min(64);
        if lossless {
            tw = 4;
            th = 4;
        } else if self.frame.tx_select && mv.is_none() && (w > 4 || h > 4) {
            let stride = self.output.planes[0].width / 4;
            let above = y > self.y0 && {
                let b = self.info(x, y - 1);
                (if b.skip && b.mv.is_some() {
                    b.width as usize
                } else {
                    WIDTHS[self.output.planes[0].transform_sizes[(y - 1) * stride + x] as usize]
                }) >= tw
            };
            let left = x > self.x0 && {
                let b = self.info(x - 1, y);
                (if b.skip && b.mv.is_some() {
                    b.height as usize
                } else {
                    HEIGHTS[self.output.planes[0].transform_sizes[y * stride + x - 1] as usize]
                }) >= th
            };
            let context = usize::from(above) + usize::from(left);
            let depth = tw.max(th).trailing_zeros() - 2;
            let table = match depth {
                4 => Table::Tx64x64,
                3 => Table::Tx32x32,
                2 => Table::Tx16x16,
                _ => Table::Tx8x8,
            };
            for _ in 0..self.read(table, &[context])? {
                if tw >= th {
                    tw = (tw / 2).max(4);
                }
                if th > tw {
                    th = (th / 2).max(4);
                }
            }
        }
        let tx_size = find_tx(tw, th)?;
        if mv.is_some() && !lossless && !skip && self.frame.tx_select {
            for yy in (y..y + h / 4).step_by(th / 4) {
                for xx in (x..x + w / 4).step_by(tw / 4) {
                    self.var_tx(xx, yy, tx_size, 0, x, y, w, h)?;
                }
            }
        }
        let mut palette_ids = [0; 2];
        self.output.tool_counts[0] +=
            u32::from(!palette.colors[0].is_empty()) + u32::from(!palette.colors[1].is_empty());
        self.output.tool_counts[1] += u32::from(mv.is_some());
        for p in 0..2 {
            if !palette.colors[p].is_empty() {
                palette_ids[p] = self.output.palette_colors.len() as u32;
                self.output.palette_colors.push(palette.colors[p].clone());
            }
        }
        let mode = Mode {
            x,
            y,
            w,
            h,
            y_mode,
            uv_mode,
            angle_y,
            angle_uv,
            cfl,
            filter,
            segment,
            skip,
            tx_size,
            has_chroma,
            palette,
            mv,
        };
        // Modes are visible to neighboring intra predictions before the current residual is decoded.
        for yy in y..y + h / 4 {
            for xx in x..x + w / 4 {
                self.output.blocks[yy * self.output.block_stride + xx] = BlockInfo {
                    width: w as u8,
                    height: h as u8,
                    y_mode: y_mode as u8,
                    uv_mode: uv_mode as u8,
                    segment: segment as u8,
                    skip,
                    tx: tx_size as u8,
                    qindex: self.qindex as u8,
                    delta_lf: self.delta_lf.map(|v| v as i8),
                    palettes: palette_ids,
                    mv,
                };
            }
        }
        self.residual(&mode)
    }
    fn var_tx(
        &mut self,
        x: usize,
        y: usize,
        size: usize,
        depth: usize,
        bx: usize,
        by: usize,
        bw: usize,
        bh: usize,
    ) -> Result<()> {
        if x >= self.x1 || y >= self.y1 {
            return Ok(());
        }
        let w = WIDTHS[size];
        let h = HEIGHTS[size];
        let pixels = &self.output.planes[0];
        let stride = pixels.width / 4;
        let above = if y == by && y == self.y0 {
            64
        } else {
            let b = self.info(x, y - 1);
            if y == by && b.mv.is_some() && b.skip {
                b.width as usize
            } else {
                WIDTHS[pixels.transform_sizes[(y - 1) * stride + x] as usize]
            }
        };
        let left = if x == bx && x == self.x0 {
            64
        } else {
            let b = self.info(x - 1, y);
            if x == bx && b.mv.is_some() && b.skip {
                b.height as usize
            } else {
                HEIGHTS[pixels.transform_sizes[y * stride + x - 1] as usize]
            }
        };
        let max = bw.max(bh).min(64).trailing_zeros() as usize - 2;
        let square_up = w.max(h).trailing_zeros() as usize - 2;
        let context = usize::from(square_up != max) * 3
            + (4 - max) * 6
            + usize::from(above < w)
            + usize::from(left < h);
        let split = size != 0 && depth < 2 && self.read(Table::TxfmSplit, &[context])? != 0;
        if split {
            let next_w = if w >= h { (w / 2).max(4) } else { w };
            let next_h = if h >= w { (h / 2).max(4) } else { h };
            let next = find_tx(next_w, next_h)?;
            for yy in (y..y + h / 4).step_by(next_h / 4) {
                for xx in (x..x + w / 4).step_by(next_w / 4) {
                    self.var_tx(xx, yy, next, depth + 1, bx, by, bw, bh)?;
                }
            }
        } else {
            let pixels = &mut self.output.planes[0];
            for yy in y..y + h / 4 {
                for xx in x..x + w / 4 {
                    pixels.transform_sizes[yy * stride + xx] = size as u8;
                }
            }
        }
        Ok(())
    }
    fn palette_cache(&self, x: usize, y: usize, p: usize) -> Vec<u16> {
        let above = if y > self.y0 && y % 16 != 0 {
            self.info(x, y - 1).palettes[p]
        } else {
            0
        };
        let left = if x > self.x0 {
            self.info(x - 1, y).palettes[p]
        } else {
            0
        };
        palette::cache(
            &self.output.palette_colors[above as usize],
            &self.output.palette_colors[left as usize],
        )
    }
    fn residual(&mut self, mode: &Mode) -> Result<()> {
        for chunk_y in 0..mode.h.div_ceil(64) {
            for chunk_x in 0..mode.w.div_ceil(64) {
                for plane in 0..if mode.has_chroma { 3 } else { 1 } {
                    let sx = usize::from(plane > 0 && self.seq.color.sub_x);
                    let sy = usize::from(plane > 0 && self.seq.color.sub_y);
                    let block_w = (mode.w >> sx).max(4);
                    let block_h = (mode.h >> sy).max(4);
                    if plane > 0
                        && sx != sy
                        && ((sx != 0 && mode.h > mode.w) || (sy != 0 && mode.w > mode.h))
                    {
                        return Err(Error::Invalid);
                    }
                    let lossless = self.frame.segments[mode.segment].lossless;
                    let size = if lossless {
                        0
                    } else if plane == 0 {
                        mode.tx_size
                    } else {
                        find_tx(block_w.min(32), block_h.min(32))?
                    };
                    let tw = WIDTHS[size];
                    let th = HEIGHTS[size];
                    let start_x = (mode.x >> sx) * 4 + ((chunk_x * 64) >> sx);
                    let start_y = (mode.y >> sy) * 4 + ((chunk_y * 64) >> sy);
                    let chunk_w = (mode.w.min(64) >> sx).max(4);
                    let chunk_h = (mode.h.min(64) >> sy).max(4);
                    if plane == 0
                        && mode.mv.is_some()
                        && !lossless
                        && !mode.skip
                        && self.frame.tx_select
                    {
                        self.var_residual(mode, start_x, start_y, size, block_w, block_h)?;
                        continue;
                    }
                    for dy in (0..chunk_h).step_by(th) {
                        for dx in (0..chunk_w).step_by(tw) {
                            let x = start_x + dx;
                            let y = start_y + dy;
                            if x >= self.output.planes[plane].coded_width
                                || y >= self.output.planes[plane].coded_height
                            {
                                continue;
                            }
                            self.transform(mode, plane, x, y, size, block_w, block_h)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    fn var_residual(
        &mut self,
        mode: &Mode,
        x: usize,
        y: usize,
        size: usize,
        bw: usize,
        bh: usize,
    ) -> Result<()> {
        let pixels = &self.output.planes[0];
        if x >= pixels.coded_width || y >= pixels.coded_height {
            return Ok(());
        }
        let target = pixels.transform_sizes[y / 4 * (pixels.width / 4) + x / 4] as usize;
        if WIDTHS[size] <= WIDTHS[target] && HEIGHTS[size] <= HEIGHTS[target] {
            return self.transform(mode, 0, x, y, size, bw, bh);
        }
        let w = WIDTHS[size];
        let h = HEIGHTS[size];
        let nw = if w >= h { (w / 2).max(4) } else { w };
        let nh = if h >= w { (h / 2).max(4) } else { h };
        let next = find_tx(nw, nh)?;
        for yy in (y..y + h).step_by(nh) {
            for xx in (x..x + w).step_by(nw) {
                self.var_residual(mode, xx, yy, next, bw, bh)?;
            }
        }
        Ok(())
    }
    fn transform(
        &mut self,
        mode: &Mode,
        plane: usize,
        x: usize,
        y: usize,
        size: usize,
        block_w: usize,
        block_h: usize,
    ) -> Result<()> {
        let w = WIDTHS[size];
        let h = HEIGHTS[size];
        let sx = usize::from(plane > 0 && self.seq.color.sub_x);
        let sy = usize::from(plane > 0 && self.seq.color.sub_y);
        let top = y > (self.y0 * 4 >> sy);
        let side = x > (self.x0 * 4 >> sx);
        let pixels = &self.output.planes[plane];
        let right = top && pixels.done(x + w, y - 1);
        let below = side && pixels.done(x - 1, y + h);
        let middle = 1 << (self.seq.color.depth - 1);
        let mut above = vec![0; w + h];
        let mut left = vec![0; w + h];
        for i in 0..w + h {
            above[i] = if top {
                pixels.at(
                    (x + i)
                        .min(x + if right { 2 * w } else { w } - 1)
                        .min(pixels.coded_width - 1),
                    y - 1,
                )
            } else if side {
                pixels.at(x - 1, y)
            } else {
                middle - 1
            };
            left[i] = if side {
                pixels.at(
                    x - 1,
                    (y + i)
                        .min(y + if below { 2 * h } else { h } - 1)
                        .min(pixels.coded_height - 1),
                )
            } else if top {
                pixels.at(x, y - 1)
            } else {
                middle + 1
            };
        }
        let corner = if top && side {
            pixels.at(x - 1, y - 1)
        } else if top {
            pixels.at(x, y - 1)
        } else if side {
            pixels.at(x - 1, y)
        } else {
            middle
        };
        let have_top_mode = mode.y > self.y0 && !(sy != 0 && mode.h == 4 && mode.y < self.y0 + 2);
        let have_left_mode = mode.x > self.x0 && !(sx != 0 && mode.w == 4 && mode.x < self.x0 + 2);
        let above_mode = if have_top_mode {
            let row = mode.y - 1 - usize::from(sy != 0 && mode.y & 1 != 0);
            let col = mode.x + usize::from(sx != 0 && mode.x & 1 == 0);
            let b = self.info(col, row);
            if plane == 0 { b.y_mode } else { b.uv_mode }
        } else {
            0
        };
        let left_mode = if have_left_mode {
            let row = mode.y + usize::from(sy != 0 && mode.y & 1 == 0);
            let col = mode.x - 1 - usize::from(sx != 0 && mode.x & 1 != 0);
            let b = self.info(col, row);
            if plane == 0 { b.y_mode } else { b.uv_mode }
        } else {
            0
        };
        let config = Intra {
            width: w,
            height: h,
            depth: self.seq.color.depth,
            mode: if plane == 0 {
                mode.y_mode
            } else {
                mode.uv_mode
            },
            angle_delta: if plane == 0 {
                mode.angle_y
            } else {
                mode.angle_uv
            },
            filter_intra: if plane == 0 { mode.filter } else { None },
            edge_filter: self.seq.intra_edge_filter,
            smooth_neighbor: (9..=11).contains(&above_mode) || (9..=11).contains(&left_mode),
        };
        let refs = References {
            above: &above,
            left: &left,
            corner,
            have_above: top,
            have_left: side,
            available_width: pixels.coded_width - x,
            available_height: pixels.coded_height - y,
        };
        let mut predicted = prediction::predict(&config, &refs)?;
        if let Some(mv) = mode.mv {
            // Luma displacements are integral. Subsampled chroma may have half-sample bilinear phases.
            let offset_x = mv[1] >> 3;
            let offset_y = mv[0] >> 3;
            let phase_x = if sx > 0 { offset_x & 1 } else { 0 };
            let phase_y = if sy > 0 { offset_y & 1 } else { 0 };
            for yy in 0..h {
                for xx in 0..w {
                    let xx0 = (x as i32 + (offset_x >> sx) + xx as i32) as usize;
                    let yy0 = (y as i32 + (offset_y >> sy) + yy as i32) as usize;
                    if xx0 + phase_x as usize >= pixels.width
                        || yy0 + phase_y as usize >= pixels.height
                    {
                        return Err(Error::Invalid);
                    }
                    let mut sum = 0;
                    for dy in 0..=phase_y as usize {
                        for dx in 0..=phase_x as usize {
                            sum += pixels.at(xx0 + dx, yy0 + dy) as i64;
                        }
                    }
                    predicted[yy * w + xx] =
                        transform::round(sum, (phase_x + phase_y) as u32) as u16;
                }
            }
        }
        if !mode.palette.colors[plane].is_empty() {
            let map = &mode.palette.maps[usize::from(plane > 0)];
            let origin_x = (mode.x >> sx) * 4;
            let origin_y = (mode.y >> sy) * 4;
            for yy in 0..h {
                for xx in 0..w {
                    predicted[yy * w + xx] = mode.palette.colors[plane]
                        [map[(y + yy - origin_y) * block_w + x + xx - origin_x] as usize];
                }
            }
        }
        if plane > 0 && mode.uv_mode == 13 {
            let luma = &self.output.planes[0];
            let max_x = self.output.max_luma_width - (1 << sx);
            let max_y = self.output.max_luma_height - (1 << sy);
            let mut q3 = Vec::with_capacity(w * h);
            for yy in 0..h {
                for xx in 0..w {
                    let mut sum = 0;
                    for dy in 0..1 << sy {
                        for dx in 0..1 << sx {
                            sum += luma.at(
                                ((x + xx) << sx).min(max_x) + dx,
                                ((y + yy) << sy).min(max_y) + dy,
                            ) as i32;
                        }
                    }
                    q3.push(sum << (3 - sx - sy));
                }
            }
            prediction::cfl(
                &mut predicted,
                &q3,
                mode.cfl[plane - 1],
                self.seq.color.depth,
            )?;
        }
        let block = CoeffBlock {
            plane,
            x4: x / 4,
            y4: y / 4,
            size,
            block_width: block_w,
            block_height: block_h,
        };
        let mut tx = Tx::DctDct;
        if mode.skip {
            self.contexts[plane].update(&block, 0, 0);
        } else if !self.contexts[plane].all_zero(&mut self.e, &mut self.cdfs, &block)? {
            tx = self.transform_type(mode, plane, size, x, y)?;
            let quant = self.contexts[plane].nonzero(&mut self.e, &mut self.cdfs, &block, tx)?;
            let qindex = (self.qindex + self.frame.segments[mode.segment].values[0]).clamp(0, 255);
            let delta = if plane == 0 {
                (self.frame.delta_q[0], 0)
            } else if plane == 1 {
                (self.frame.delta_q[1], self.frame.delta_q[2])
            } else {
                (self.frame.delta_q[3], self.frame.delta_q[4])
            };
            let matrix = if self.frame.segments[mode.segment].lossless {
                None
            } else {
                self.frame.qmatrix.map(|m| m[plane] as usize)
            };
            let dequant = coefficients::dequantize(
                &quant,
                size,
                tx,
                self.seq.color.depth,
                qindex,
                delta.0,
                delta.1,
                matrix,
                plane > 0,
            )?;
            let residual = transform::inverse(
                &dequant,
                size,
                tx,
                self.seq.color.depth,
                self.frame.segments[mode.segment].lossless,
            )?;
            let (flip_x, flip_y) = tx.flips();
            for yy in 0..h {
                for xx in 0..w {
                    let target = if flip_y { h - 1 - yy } else { yy } * w
                        + if flip_x { w - 1 - xx } else { xx };
                    predicted[target] = (predicted[target] as i32 + residual[yy * w + xx])
                        .clamp(0, (1 << self.seq.color.depth) - 1)
                        as u16;
                }
            }
        }
        let _ = tx;
        let pixels = &mut self.output.planes[plane];
        for yy in 0..h.min(pixels.height - y) {
            for xx in 0..w.min(pixels.width - x) {
                pixels.data[(y + yy) * pixels.width + x + xx] = predicted[yy * w + xx];
            }
        }
        for yy in (y / 4)..((y + h) / 4).min(pixels.height / 4) {
            for xx in (x / 4)..((x + w) / 4).min(pixels.width / 4) {
                let index = yy * (pixels.width / 4) + xx;
                pixels.decoded[index] = true;
                pixels.transform_sizes[index] = size as u8;
                pixels.transform_types[index] = tx;
            }
        }
        if plane == 0 {
            self.output.max_luma_width = x + w;
            self.output.max_luma_height = y + h;
        }
        Ok(())
    }
    fn transform_type(
        &mut self,
        mode: &Mode,
        plane: usize,
        size: usize,
        x: usize,
        y: usize,
    ) -> Result<Tx> {
        let w = WIDTHS[size];
        let h = HEIGHTS[size];
        if self.frame.segments[mode.segment].lossless
            || w.max(h) > 32
            || (mode.mv.is_none() && w.max(h) == 32)
        {
            return Ok(Tx::DctDct);
        }
        let q = if self.frame.segmentation {
            (self.qindex + self.frame.segments[mode.segment].values[0]).clamp(0, 255)
        } else {
            self.frame.base_q as i32
        };
        if q == 0 {
            return Ok(Tx::DctDct);
        }
        if mode.mv.is_some() {
            if plane > 0 {
                let sx = usize::from(self.seq.color.sub_x);
                let sy = usize::from(self.seq.color.sub_y);
                let luma = &self.output.planes[0];
                let lx = x / 4 << sx;
                let ly = y / 4 << sy;
                return Ok(luma.transform_types[ly * (luma.width / 4) + lx]);
            }
            let sqr = w.min(h).trailing_zeros() as usize - 2;
            let types: &[Tx] = if self.frame.reduced_tx_set || w.max(h) == 32 {
                &[Tx::Identity, Tx::DctDct]
            } else if w.min(h) == 16 {
                &[
                    Tx::Identity,
                    Tx::VDct,
                    Tx::HDct,
                    Tx::DctDct,
                    Tx::AdstDct,
                    Tx::DctAdst,
                    Tx::FlipadstDct,
                    Tx::DctFlipadst,
                    Tx::AdstAdst,
                    Tx::FlipadstFlipadst,
                    Tx::AdstFlipadst,
                    Tx::FlipadstAdst,
                ]
            } else {
                &[
                    Tx::Identity,
                    Tx::VDct,
                    Tx::HDct,
                    Tx::VAdst,
                    Tx::HAdst,
                    Tx::VFlipadst,
                    Tx::HFlipadst,
                    Tx::DctDct,
                    Tx::AdstDct,
                    Tx::DctAdst,
                    Tx::FlipadstDct,
                    Tx::DctFlipadst,
                    Tx::AdstAdst,
                    Tx::FlipadstFlipadst,
                    Tx::AdstFlipadst,
                    Tx::FlipadstAdst,
                ]
            };
            let index = match types.len() {
                2 => self.read(Table::InterTxTypeSet3, &[sqr])?,
                12 => self.read(Table::InterTxTypeSet2, &[])?,
                _ => self.read(Table::InterTxTypeSet1, &[sqr])?,
            };
            return Ok(types[index]);
        }
        if plane > 0 {
            let tx = [
                Tx::DctDct,
                Tx::AdstDct,
                Tx::DctAdst,
                Tx::DctDct,
                Tx::AdstAdst,
                Tx::AdstDct,
                Tx::DctAdst,
                Tx::DctAdst,
                Tx::AdstDct,
                Tx::AdstAdst,
                Tx::AdstDct,
                Tx::DctAdst,
                Tx::AdstAdst,
                Tx::DctDct,
            ][mode.uv_mode];
            return Ok(tx);
        }
        let q = if self.frame.segmentation {
            (self.qindex + self.frame.segments[mode.segment].values[0]).clamp(0, 255)
        } else {
            self.frame.base_q as i32
        };
        if q == 0 {
            return Ok(Tx::DctDct);
        }
        let dir = mode
            .filter
            .map_or(mode.y_mode, |filter| [0, 1, 2, 6, 0][filter]);
        let sqr = w.min(h).trailing_zeros() as usize - 2;
        if self.frame.reduced_tx_set || w.min(h) == 16 {
            let index = self.read(Table::IntraTxTypeSet2, &[sqr, dir])?;
            Ok([
                Tx::Identity,
                Tx::DctDct,
                Tx::AdstAdst,
                Tx::AdstDct,
                Tx::DctAdst,
            ][index])
        } else {
            let index = self.read(Table::IntraTxTypeSet1, &[sqr, dir])?;
            Ok([
                Tx::Identity,
                Tx::DctDct,
                Tx::VDct,
                Tx::HDct,
                Tx::AdstAdst,
                Tx::AdstDct,
                Tx::DctAdst,
            ][index])
        }
    }
}
fn find_tx(w: usize, h: usize) -> Result<usize> {
    (0..19)
        .find(|i| WIDTHS[*i] == w && HEIGHTS[*i] == h)
        .ok_or(Error::Invalid)
}
