use crate::bits::Bits;
use crate::sequence::Sequence;
use crate::{Error, Result};

#[derive(Clone, Debug)]
pub struct Tiles {
    /// Tile edges in units of four luma pixels, including the final image edge.
    pub columns: Vec<u32>,
    pub rows: Vec<u32>,
    pub column_bits: u32,
    pub row_bits: u32,
    pub size_bytes: u32,
    pub context_update_id: u32,
}
#[derive(Clone, Debug, Default)]
pub struct Segment {
    pub enabled: [bool; 8],
    pub values: [i32; 8],
    pub lossless: bool,
}
#[derive(Clone, Debug)]
pub struct LoopFilter {
    pub levels: [u32; 4],
    pub sharpness: u32,
    pub delta_enabled: bool,
    pub ref_deltas: [i32; 8],
    pub mode_deltas: [i32; 2],
}
impl Default for LoopFilter {
    fn default() -> Self {
        Self {
            levels: [0; 4],
            sharpness: 0,
            delta_enabled: true,
            ref_deltas: [1, 0, 0, 0, -1, 0, -1, -1],
            mode_deltas: [0; 2],
        }
    }
}
#[derive(Clone, Debug)]
pub struct Cdef {
    pub damping: u32,
    pub bits: u32,
    /// Luma primary, luma secondary, chroma primary, chroma secondary.
    pub strengths: [[u32; 4]; 8],
}
impl Default for Cdef {
    fn default() -> Self {
        Self {
            damping: 3,
            bits: 0,
            strengths: [[0; 4]; 8],
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Grain {
    pub apply: bool,
    pub seed: u32,
    pub points: [Vec<[u32; 2]>; 3],
    pub chroma_from_luma: bool,
    pub scaling_shift: u32,
    pub lag: u32,
    pub coefficients: [Vec<i32>; 3],
    pub coefficient_shift: u32,
    pub scale_shift: u32,
    pub chroma_mult: [[u32; 3]; 2],
    pub overlap: bool,
    pub restricted_range: bool,
}
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub upscaled_width: u32,
    pub render_width: u32,
    pub render_height: u32,
    pub superres_denom: u32,
    pub update_cdf: bool,
    pub screen_content: bool,
    pub intrabc: bool,
    pub tiles: Tiles,
    pub base_q: u32,
    /// Y DC, U DC, U AC, V DC, V AC.
    pub delta_q: [i32; 5],
    pub qmatrix: Option<[u32; 3]>,
    pub segmentation: bool,
    pub segments: [Segment; 8],
    pub segment_pre_skip: bool,
    pub last_active_segment: u32,
    pub delta_q_res: Option<u32>,
    pub delta_lf_res: Option<u32>,
    pub delta_lf_multi: bool,
    pub coded_lossless: bool,
    pub all_lossless: bool,
    pub loop_filter: LoopFilter,
    pub cdef: Cdef,
    /// Normative RESTORE_NONE=0, WIENER=1, SGRPROJ=2, SWITCHABLE=3.
    pub restoration: [u32; 3],
    pub restoration_size: [u32; 3],
    pub tx_select: bool,
    pub reduced_tx_set: bool,
    pub grain: Grain,
}

impl Frame {
    /// Parse an independently decodable intra header. Animated inter frames have no place in a still image.
    pub fn parse(
        b: &mut Bits<'_>,
        seq: &Sequence,
        temporal: u8,
        spatial: u8,
        max_pixels: u64,
    ) -> Result<Self> {
        let mut kind = 0;
        let mut show = true;
        let mut showable = false;
        let mut resilient = true;
        if !seq.reduced {
            if b.flag()? {
                return Err(Error::Unsupported);
            }
            kind = b.read(2)?;
            if kind != 0 && kind != 2 {
                return Err(Error::Unsupported);
            }
            show = b.flag()?;
            if show && seq.frame_presentation_bits > 0 && !seq.equal_picture_interval {
                b.read(seq.frame_presentation_bits)?;
            }
            showable = if show { kind != 0 } else { b.flag()? };
            resilient = (kind == 0 && show) || b.flag()?;
            if seq.still_picture && (kind != 0 || !show) {
                return Err(Error::Invalid);
            }
        }
        let update_cdf = !b.flag()?;
        let screen_content = match seq.screen_content_tools {
            2 => b.flag()?,
            value => value != 0,
        };
        if screen_content && seq.integer_mv == 2 {
            b.flag()?;
        }
        b.read(seq.frame_id_bits)?;
        let size_override = !seq.reduced && b.flag()?;
        b.read(seq.order_hint_bits)?;
        if seq.buffer_removal_bits > 0 && b.flag()? {
            for op in &seq.operating_points {
                if op.decoder_model
                    && (op.idc == 0
                        || ((op.idc >> temporal) & 1 != 0 && (op.idc >> (spatial + 8)) & 1 != 0))
                {
                    b.read(seq.buffer_removal_bits)?;
                }
            }
        }
        let refresh = if kind == 0 && show { 255 } else { b.read(8)? };
        if refresh != 255 && resilient && seq.order_hint_bits > 0 {
            for _ in 0..8 {
                b.read(seq.order_hint_bits)?;
            }
        }
        let upscaled_width = if size_override {
            b.read(seq.width_bits)? + 1
        } else {
            seq.max_width
        };
        let height = if size_override {
            b.read(seq.height_bits)? + 1
        } else {
            seq.max_height
        };
        if upscaled_width > seq.max_width || height > seq.max_height {
            return Err(Error::Invalid);
        }
        if upscaled_width as u64 * height as u64 > max_pixels {
            return Err(Error::Limit);
        }
        let superres_denom = if seq.superres && b.flag()? {
            b.read(3)? + 9
        } else {
            8
        };
        let width = (upscaled_width * 8 + superres_denom / 2) / superres_denom;
        let (render_width, render_height) = if b.flag()? {
            (b.read(16)? + 1, b.read(16)? + 1)
        } else {
            (upscaled_width, height)
        };
        let intrabc = screen_content && width == upscaled_width && b.flag()?;
        if !seq.reduced && update_cdf {
            b.flag()?; // Frame-end CDF retention cannot affect a single independently decoded image.
        }
        let tiles = Tiles::parse(b, seq, width, height)?;
        let base_q = b.read(8)?;
        let mut delta_q = [0; 5];
        delta_q[0] = read_delta_q(b)?;
        if !seq.color.monochrome {
            let different = seq.color.separate_uv_delta_q && b.flag()?;
            delta_q[1] = read_delta_q(b)?;
            delta_q[2] = read_delta_q(b)?;
            if different {
                delta_q[3] = read_delta_q(b)?;
                delta_q[4] = read_delta_q(b)?;
            } else {
                delta_q[3] = delta_q[1];
                delta_q[4] = delta_q[2];
            }
        }
        let qmatrix = if b.flag()? {
            let y = b.read(4)?;
            let u = b.read(4)?;
            let v = if seq.color.separate_uv_delta_q {
                b.read(4)?
            } else {
                u
            };
            Some([y, u, v])
        } else {
            None
        };
        let segmentation = b.flag()?;
        let mut segments: [Segment; 8] = std::array::from_fn(|_| Segment::default());
        let mut segment_pre_skip = false;
        let mut last_active_segment = 0;
        if segmentation {
            for (id, segment) in segments.iter_mut().enumerate() {
                for (feature, bits) in [8, 6, 6, 6, 6, 3, 0, 0].into_iter().enumerate() {
                    if b.flag()? {
                        segment.enabled[feature] = true;
                        let limit = if feature == 0 {
                            255
                        } else if feature < 5 {
                            63
                        } else {
                            7
                        };
                        segment.values[feature] = if feature < 5 {
                            b.signed(bits + 1)?.clamp(-limit, limit)
                        } else {
                            b.read(bits)? as i32
                        };
                        segment_pre_skip |= feature >= 5;
                        last_active_segment = id as u32;
                    }
                }
            }
        }
        let delta_q_res = if base_q > 0 && b.flag()? {
            Some(b.read(2)?)
        } else {
            None
        };
        let delta_lf_res = if delta_q_res.is_some() && !intrabc && b.flag()? {
            Some(b.read(2)?)
        } else {
            None
        };
        let delta_lf_multi = delta_lf_res.is_some() && b.flag()?;
        let mut coded_lossless = true;
        for segment in &mut segments {
            let q = (base_q as i32 + segment.values[0]).clamp(0, 255);
            segment.lossless = q == 0 && delta_q.iter().all(|value| *value == 0);
            coded_lossless &= segment.lossless;
        }
        let all_lossless = coded_lossless && width == upscaled_width;
        let loop_filter = if !coded_lossless && !intrabc {
            LoopFilter::parse(b, seq)?
        } else {
            LoopFilter::default()
        };
        let cdef = if !coded_lossless && !intrabc && seq.cdef {
            Cdef::parse(b, seq)?
        } else {
            Cdef::default()
        };
        let mut restoration = [0; 3];
        let mut restoration_size = [64; 3];
        if !all_lossless && !intrabc && seq.restoration {
            let planes = if seq.color.monochrome { 1 } else { 3 };
            for mode in &mut restoration[..planes] {
                *mode = [0, 3, 1, 2][b.read(2)? as usize];
            }
            if restoration.iter().any(|mode| *mode != 0) {
                let mut shift = b.read(1)?;
                if seq.superblock_128 {
                    shift += 1;
                } else if shift > 0 {
                    shift += b.read(1)?;
                }
                restoration_size[0] = 64 << shift;
                let uv = if seq.color.sub_x
                    && seq.color.sub_y
                    && (restoration[1] != 0 || restoration[2] != 0)
                {
                    b.read(1)?
                } else {
                    0
                };
                restoration_size[1] = restoration_size[0] >> uv;
                restoration_size[2] = restoration_size[1];
            }
        }
        let tx_select = !coded_lossless && b.flag()?;
        let reduced_tx_set = b.flag()?;
        let grain = if seq.film_grain && (show || showable) {
            Grain::parse(b, seq)?
        } else {
            Grain::default()
        };
        Ok(Self {
            width,
            height,
            upscaled_width,
            render_width,
            render_height,
            superres_denom,
            update_cdf,
            screen_content,
            intrabc,
            tiles,
            base_q,
            delta_q,
            qmatrix,
            segmentation,
            segments,
            segment_pre_skip,
            last_active_segment,
            delta_q_res,
            delta_lf_res,
            delta_lf_multi,
            coded_lossless,
            all_lossless,
            loop_filter,
            cdef,
            restoration,
            restoration_size,
            tx_select,
            reduced_tx_set,
            grain,
        })
    }
}
fn read_delta_q(b: &mut Bits<'_>) -> Result<i32> {
    if b.flag()? { b.signed(7) } else { Ok(0) }
}
fn tile_log2(size: u32, target: u32) -> u32 {
    let mut bits = 0;
    while (size << bits) < target {
        bits += 1;
    }
    bits
}
impl Tiles {
    fn parse(b: &mut Bits<'_>, seq: &Sequence, width: u32, height: u32) -> Result<Self> {
        let mi_cols = 2 * width.div_ceil(8);
        let mi_rows = 2 * height.div_ceil(8);
        let shift = if seq.superblock_128 { 5 } else { 4 };
        let sb_cols = mi_cols.div_ceil(1 << shift);
        let sb_rows = mi_rows.div_ceil(1 << shift);
        let max_width = 4096 >> (shift + 2);
        let max_area = (4096 * 2304) >> (2 * (shift + 2));
        let min_cols = tile_log2(max_width, sb_cols);
        let max_cols = tile_log2(1, sb_cols.min(64));
        let max_rows = tile_log2(1, sb_rows.min(64));
        let min_tiles = min_cols.max(tile_log2(max_area, sb_cols * sb_rows));
        let mut columns = Vec::new();
        let mut rows = Vec::new();
        let column_bits;
        let row_bits;
        if b.flag()? {
            let mut cols = min_cols;
            while cols < max_cols && b.flag()? {
                cols += 1;
            }
            column_bits = cols;
            let tile_width = sb_cols.div_ceil(1 << cols);
            for start in (0..sb_cols).step_by(tile_width as usize) {
                columns.push(start << shift);
            }
            let mut row = min_tiles.saturating_sub(cols);
            while row < max_rows && b.flag()? {
                row += 1;
            }
            row_bits = row;
            let tile_height = sb_rows.div_ceil(1 << row);
            for start in (0..sb_rows).step_by(tile_height as usize) {
                rows.push(start << shift);
            }
        } else {
            let mut start = 0;
            let mut widest = 0;
            while start < sb_cols {
                columns.push(start << shift);
                let size = b.ns((sb_cols - start).min(max_width))? + 1;
                widest = widest.max(size);
                start += size;
                if columns.len() > 64 {
                    return Err(Error::Invalid);
                }
            }
            column_bits = tile_log2(1, columns.len() as u32);
            let area = if min_tiles > 0 {
                (sb_rows * sb_cols) >> (min_tiles + 1)
            } else {
                sb_rows * sb_cols
            };
            let max_height = (area / widest).max(1);
            start = 0;
            while start < sb_rows {
                rows.push(start << shift);
                start += b.ns((sb_rows - start).min(max_height))? + 1;
                if rows.len() > 64 {
                    return Err(Error::Invalid);
                }
            }
            row_bits = tile_log2(1, rows.len() as u32);
        }
        columns.push(mi_cols);
        rows.push(mi_rows);
        let (context_update_id, size_bytes) = if column_bits + row_bits > 0 {
            (b.read(column_bits + row_bits)?, b.read(2)? + 1)
        } else {
            (0, 0)
        };
        if context_update_id as usize >= (columns.len() - 1) * (rows.len() - 1) {
            return Err(Error::Invalid);
        }
        Ok(Self {
            columns,
            rows,
            column_bits,
            row_bits,
            size_bytes,
            context_update_id,
        })
    }
    /// Borrow the encoded tiles from a tile-group OBU, preserving their frame-wide indices.
    pub fn group<'a>(
        &self,
        bytes: &'a [u8],
        expected_start: usize,
    ) -> Result<Vec<(usize, &'a [u8])>> {
        let count = (self.columns.len() - 1) * (self.rows.len() - 1);
        let mut b = Bits::new(bytes);
        let (start, end) = if count > 1 && b.flag()? {
            (
                b.read(self.column_bits + self.row_bits)? as usize,
                b.read(self.column_bits + self.row_bits)? as usize,
            )
        } else {
            (0, count - 1)
        };
        if start != expected_start || end < start || end >= count {
            return Err(Error::Invalid);
        }
        b.align()?;
        let mut at = b.position() / 8;
        let mut tiles = Vec::new();
        for id in start..=end {
            let size = if id == end {
                bytes.len() - at
            } else {
                let size_bytes = self.size_bytes as usize;
                let size = bytes.get(at..at + size_bytes).ok_or(Error::Truncated)?;
                let mut value = 0_u64;
                for (i, byte) in size.iter().enumerate() {
                    value |= (*byte as u64) << (i * 8);
                }
                at += size_bytes;
                usize::try_from(value + 1).map_err(|_| Error::Limit)?
            };
            if size == 0 {
                return Err(Error::Invalid);
            }
            let stop = at.checked_add(size).ok_or(Error::Limit)?;
            let tile = bytes.get(at..stop).ok_or(Error::Truncated)?;
            tiles.push((id, tile));
            at = stop;
        }
        Ok(tiles)
    }
}
impl LoopFilter {
    fn parse(b: &mut Bits<'_>, seq: &Sequence) -> Result<Self> {
        let mut filter = Self::default();
        filter.levels[0] = b.read(6)?;
        filter.levels[1] = b.read(6)?;
        if !seq.color.monochrome && (filter.levels[0] != 0 || filter.levels[1] != 0) {
            filter.levels[2] = b.read(6)?;
            filter.levels[3] = b.read(6)?;
        }
        filter.sharpness = b.read(3)?;
        filter.delta_enabled = b.flag()?;
        if filter.delta_enabled && b.flag()? {
            for value in filter.ref_deltas.iter_mut().chain(&mut filter.mode_deltas) {
                if b.flag()? {
                    *value = b.signed(7)?;
                }
            }
        }
        Ok(filter)
    }
}
impl Cdef {
    fn parse(b: &mut Bits<'_>, seq: &Sequence) -> Result<Self> {
        let mut cdef = Self {
            damping: b.read(2)? + 3,
            bits: b.read(2)?,
            strengths: [[0; 4]; 8],
        };
        for strengths in &mut cdef.strengths[..1 << cdef.bits] {
            strengths[0] = b.read(4)?;
            let secondary = b.read(2)?;
            strengths[1] = secondary + u32::from(secondary == 3);
            if !seq.color.monochrome {
                strengths[2] = b.read(4)?;
                let secondary = b.read(2)?;
                strengths[3] = secondary + u32::from(secondary == 3);
            }
        }
        Ok(cdef)
    }
}
impl Grain {
    fn parse(b: &mut Bits<'_>, seq: &Sequence) -> Result<Self> {
        let mut grain = Self::default();
        grain.apply = b.flag()?;
        if !grain.apply {
            return Ok(grain);
        }
        grain.seed = b.read(16)?;
        fn points(b: &mut Bits<'_>, limit: usize) -> Result<Vec<[u32; 2]>> {
            let count = b.read(4)? as usize;
            if count > limit {
                return Err(Error::Invalid);
            }
            let mut out: Vec<[u32; 2]> = Vec::new();
            for _ in 0..count {
                let point = [b.read(8)?, b.read(8)?];
                if out.last().is_some_and(|prev| prev[0] >= point[0]) {
                    return Err(Error::Invalid);
                }
                out.push(point);
            }
            Ok(out)
        }
        grain.points[0] = points(b, 14)?;
        grain.chroma_from_luma = !seq.color.monochrome && b.flag()?;
        if !seq.color.monochrome
            && !grain.chroma_from_luma
            && !(seq.color.sub_x && seq.color.sub_y && grain.points[0].is_empty())
        {
            grain.points[1] = points(b, 10)?;
            grain.points[2] = points(b, 10)?;
            if seq.color.sub_x
                && seq.color.sub_y
                && grain.points[1].is_empty() != grain.points[2].is_empty()
            {
                return Err(Error::Invalid);
            }
        }
        grain.scaling_shift = b.read(2)? + 8;
        grain.lag = b.read(2)?;
        let count = 2 * grain.lag * (grain.lag + 1);
        for plane in 0..3 {
            let present = !grain.points[plane].is_empty() || (plane > 0 && grain.chroma_from_luma);
            if present {
                let n = count + u32::from(plane > 0 && !grain.points[0].is_empty());
                for _ in 0..n {
                    grain.coefficients[plane].push(b.read(8)? as i32 - 128);
                }
            }
        }
        grain.coefficient_shift = b.read(2)? + 6;
        grain.scale_shift = b.read(2)?;
        for plane in 1..3 {
            if !grain.points[plane].is_empty() {
                grain.chroma_mult[plane - 1] = [b.read(8)?, b.read(8)?, b.read(9)?];
            }
        }
        grain.overlap = b.flag()?;
        grain.restricted_range = b.flag()?;
        Ok(grain)
    }
}
