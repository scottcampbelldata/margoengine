//! The structure of one tile as packets reach it: per component its resolutions, their precincts, and in each precinct
//! band its code-blocks with the inclusion and zero bit-plane tag trees (B.6, B.7 and B.10.2).
use crate::codestream::{Codestream, Style, block};
use crate::geometry::{self, Band, Rect};
use crate::{Error, Result};

/// A tag tree (B.10.2): a quad tree of minima over a grid of leaves, decoded value by value.
#[derive(Clone, Debug)]
pub struct TagTree {
    /// Width and height of each level, leaves first.
    levels: Vec<(u32, u32)>,
    /// Offset of each level's first node in `low` and `value`.
    offsets: Vec<usize>,
    /// The lowest value each node may still have.
    low: Vec<u32>,
    /// The node's value, once decoded.
    value: Vec<Option<u32>>,
}

impl TagTree {
    pub fn new(width: u32, height: u32) -> TagTree {
        let mut levels = vec![(width, height)];
        let (mut w, mut h) = (width, height);
        while w > 1 || h > 1 {
            w = w.div_ceil(2);
            h = h.div_ceil(2);
            levels.push((w, h));
        }
        let mut offsets = Vec::with_capacity(levels.len());
        let mut total = 0;
        for &(w, h) in &levels {
            offsets.push(total);
            total += (w * h) as usize;
        }
        TagTree { levels, offsets, low: vec![0; total], value: vec![None; total] }
    }
    /// Decodes until it knows whether leaf (x, y) has a value at most `threshold`, and returns that value if so.
    pub fn decode(&mut self, x: u32, y: u32, threshold: u32, bits: &mut impl FnMut() -> Result<u32>) -> Result<Option<u32>> {
        let mut low = 0;
        for level in (0..self.levels.len()).rev() {
            let (w, _) = self.levels[level];
            let node = self.offsets[level] + ((y >> level) * w + (x >> level)) as usize;
            low = low.max(self.low[node]);
            while self.value[node].is_none() && low <= threshold {
                if bits()? == 1 {
                    self.value[node] = Some(low);
                } else {
                    low += 1;
                }
            }
            self.low[node] = low;
            match self.value[node] {
                // A child's value is at least its parent's.
                Some(v) => low = v,
                None => return Ok(None),
            }
        }
        let leaf = self.value[(y * self.levels[0].0 + x) as usize];
        Ok(leaf.filter(|&v| v <= threshold))
    }
}

/// One codeword segment's share of a code-block (D.4.1): passes and bytes, joined across layers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Segment {
    pub passes: u32,
    pub length: u32,
}

/// A code-block: its rectangle in the band and what the packets gave it.
#[derive(Clone, Debug, Default)]
pub struct Block {
    pub rect: Rect,
    pub included: bool,
    pub lblock: u32,
    /// Missing most significant bit-planes (the zero bit-plane tag tree's value).
    pub zero_planes: u32,
    pub passes: u32,
    pub segments: Vec<Segment>,
    /// The bytes of every segment, in order.
    pub data: Vec<u8>,
}

/// The passes from `start` on that one codeword segment holds (D.4.1, Table D.8): every pass with termination on each
/// pass; with the arithmetic coding bypass the first ten (four bit-planes of significance propagation, refinement and
/// cleanup less the first two), then raw segments of a significance propagation and refinement pass and MQ segments of
/// one cleanup pass; otherwise all of them.
pub fn segment_passes(style: u8, start: u32) -> u32 {
    if style & block::TERMINATE != 0 {
        return 1;
    }
    if style & block::BYPASS != 0 {
        if start < 10 {
            return 10 - start;
        }
        // Passes 10, 13, ... are significance propagation (raw, with the refinement after it), 12, 15, ... cleanup.
        return match (start - 10) % 3 {
            0 => 2,
            1 => 1,
            _ => 1,
        };
    }
    u32::MAX
}

/// True when pass `index` of a code-block is coded raw (the bypass's significance propagation and refinement passes).
pub fn raw_pass(style: u8, index: u32) -> bool {
    style & block::BYPASS != 0 && index >= 10 && (index - 10) % 3 != 2
}

impl Block {
    /// Appends a packet's contribution: `passes` new passes in pieces of (passes, length) as the header gave them.
    pub fn append(&mut self, style: u8, pieces: &[(u32, u32)], bytes: &[u8]) {
        for &(passes, length) in pieces {
            let start = self.passes;
            // A piece continues the last segment while that segment still has room for its passes.
            let joins = match self.segments.last() {
                Some(last) => {
                    let first = start - last.passes;
                    segment_passes(style, first) > last.passes
                }
                None => false,
            };
            if joins {
                let last = self.segments.last_mut().unwrap();
                last.passes += passes;
                last.length += length;
            } else {
                self.segments.push(Segment { passes, length });
            }
            self.passes += passes;
        }
        self.data.extend_from_slice(bytes);
    }
}

/// One band of a precinct: its code-blocks in raster order and its two tag trees.
#[derive(Clone, Debug)]
pub struct PrecinctBand {
    pub band: Band,
    pub across: u32,
    pub down: u32,
    pub blocks: Vec<Block>,
    pub inclusion: TagTree,
    pub zero: TagTree,
}

#[derive(Clone, Debug)]
pub struct Precinct {
    pub bands: Vec<PrecinctBand>,
}

/// A resolution of a tile-component.
#[derive(Clone, Debug)]
pub struct Resolution {
    pub rect: Rect,
    pub ppx: u32,
    pub ppy: u32,
    pub across: u32,
    pub down: u32,
    /// The band rectangles (LL alone at resolution 0, else HL, LH, HH).
    pub bands: Vec<(Band, Rect)>,
    pub precincts: Vec<Precinct>,
}

/// A tile-component: its rectangle, coding style and resolutions.
#[derive(Clone, Debug)]
pub struct TileComponent {
    pub rect: Rect,
    pub style: Style,
    pub dx: u32,
    pub dy: u32,
    pub resolutions: Vec<Resolution>,
}

/// The most code-blocks one tile may hold, to keep a hostile header from claiming unbounded memory.
const MAX_BLOCKS: u64 = 1 << 24;

impl TileComponent {
    pub fn build(cs: &Codestream, t: usize, c: usize, budget: &mut u64) -> Result<TileComponent> {
        let tile = cs.size.tile(t);
        let component = cs.size.components[c];
        let (dx, dy) = (component.dx as u32, component.dy as u32);
        let rect = geometry::tile_component(&tile, dx, dy);
        let style = cs.style(t, c).clone();
        let levels = style.levels as u32;
        let mut resolutions = Vec::with_capacity(levels as usize + 1);
        for r in 0..=levels {
            let res = geometry::resolution(&rect, levels, r);
            let (ppx, ppy) = style.precincts[r as usize];
            let (ppx, ppy) = (ppx as u32, ppy as u32);
            let (across, down) = geometry::precinct_count(&res, ppx, ppy);
            let bands: Vec<(Band, Rect)> =
                Band::of_resolution(r).iter().map(|&b| (b, geometry::band(&rect, levels, r, b))).collect();
            let (xcb, ycb) =
                geometry::block_exponents(style.block_width as u32, style.block_height as u32, ppx, ppy, r);
            let count = across as u64 * down as u64;
            if count > MAX_BLOCKS {
                return Err(Error::Limit);
            }
            let mut precincts = Vec::with_capacity(count as usize);
            for index in 0..across * down {
                let mut pbands = Vec::with_capacity(bands.len());
                for &(b, band_rect) in &bands {
                    let area = geometry::precinct_in_band(&res, &band_rect, ppx, ppy, r, index);
                    let (bx0, by0) = (area.x0 >> xcb, area.y0 >> ycb);
                    let (bx1, by1) = if area.is_empty() {
                        (bx0, by0)
                    } else {
                        (area.x1.div_ceil(1 << xcb), area.y1.div_ceil(1 << ycb))
                    };
                    let (w, h) = (bx1 - bx0, by1 - by0);
                    let n = w as u64 * h as u64;
                    if n > *budget {
                        return Err(Error::Limit);
                    }
                    *budget -= n;
                    let mut blocks = Vec::with_capacity(n as usize);
                    for y in by0..by1 {
                        for x in bx0..bx1 {
                            let r = Rect { x0: x << xcb, y0: y << ycb, x1: (x + 1) << xcb, y1: (y + 1) << ycb };
                            blocks.push(Block { rect: r.intersect(&area), lblock: 3, ..Block::default() });
                        }
                    }
                    pbands.push(PrecinctBand {
                        band: b,
                        across: w,
                        down: h,
                        blocks,
                        inclusion: TagTree::new(w.max(1), h.max(1)),
                        zero: TagTree::new(w.max(1), h.max(1)),
                    });
                }
                precincts.push(Precinct { bands: pbands });
            }
            resolutions.push(Resolution { rect: res, ppx, ppy, across, down, bands, precincts });
        }
        Ok(TileComponent { rect, style, dx, dy, resolutions })
    }
}

/// All tile-components of tile t.
pub fn build(cs: &Codestream, t: usize) -> Result<Vec<TileComponent>> {
    let mut budget = MAX_BLOCKS;
    (0..cs.size.components.len()).map(|c| TileComponent::build(cs, t, c, &mut budget)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes values into a tag tree's bit stream the way B.10.2 describes, for tests.
    pub fn encode_tag_tree(width: u32, height: u32, values: &[u32], queries: &[(u32, u32, u32)]) -> Vec<u32> {
        // Node values are minima over children.
        let mut levels = vec![values.to_vec()];
        let (mut w, mut h) = (width, height);
        let mut dims = vec![(w, h)];
        while w > 1 || h > 1 {
            let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
            let prev = levels.last().unwrap();
            let mut next = vec![u32::MAX; (nw * nh) as usize];
            for y in 0..h {
                for x in 0..w {
                    let v = prev[(y * w + x) as usize];
                    let n = &mut next[((y / 2) * nw + x / 2) as usize];
                    *n = (*n).min(v);
                }
            }
            levels.push(next);
            dims.push((nw, nh));
            w = nw;
            h = nh;
        }
        let mut low: Vec<Vec<u32>> = levels.iter().map(|l| vec![0; l.len()]).collect();
        let mut known: Vec<Vec<bool>> = levels.iter().map(|l| vec![false; l.len()]).collect();
        let mut bits = Vec::new();
        for &(x, y, threshold) in queries {
            let mut lo = 0;
            for level in (0..levels.len()).rev() {
                let i = ((y >> level) * dims[level].0 + (x >> level)) as usize;
                lo = lo.max(low[level][i]);
                let v = levels[level][i];
                while !known[level][i] && lo <= threshold {
                    if v == lo {
                        bits.push(1);
                        known[level][i] = true;
                    } else {
                        bits.push(0);
                        lo += 1;
                    }
                }
                low[level][i] = lo;
                if known[level][i] {
                    lo = v;
                } else {
                    break;
                }
            }
        }
        bits
    }

    #[test]
    fn tag_tree_round_trip() {
        let values = [1, 3, 2, 3, 2, 2, 1, 4, 0, 2, 2, 5];
        let (w, h) = (4, 3);
        let mut queries = Vec::new();
        for threshold in 0..6 {
            for i in 0..12 {
                queries.push((i % w, i / w, threshold));
            }
        }
        let bits = encode_tag_tree(w, h, &values, &queries);
        let mut tree = TagTree::new(w, h);
        let mut at = 0;
        let mut next = || -> Result<u32> {
            at += 1;
            bits.get(at - 1).copied().ok_or(Error::Truncated)
        };
        for &(x, y, threshold) in &queries {
            let got = tree.decode(x, y, threshold, &mut next).unwrap();
            let v = values[(y * w + x) as usize];
            assert_eq!(got, (v <= threshold).then_some(v));
        }
        assert_eq!(at, bits.len());
    }

    #[test]
    fn segments_follow_the_block_style() {
        assert_eq!(segment_passes(0, 0), u32::MAX);
        assert_eq!(segment_passes(block::TERMINATE, 7), 1);
        assert_eq!(segment_passes(block::BYPASS, 3), 7);
        assert_eq!((10..16).map(|p| raw_pass(block::BYPASS, p)).collect::<Vec<_>>(), [true, true, false, true, true, false]);
        let mut b = Block::default();
        // Bypass: passes 0 to 9 in one MQ segment across two layers, then a raw pair and an MQ cleanup.
        b.append(block::BYPASS, &[(6, 10)], &[0; 10]);
        b.append(block::BYPASS, &[(4, 5), (2, 3), (1, 2)], &[0; 10]);
        assert_eq!(b.segments, vec![Segment { passes: 10, length: 15 }, Segment { passes: 2, length: 3 }, Segment { passes: 1, length: 2 }]);
        // A raw pair split across layers joins.
        let mut b = Block::default();
        b.append(block::BYPASS, &[(10, 1), (1, 1)], &[0; 2]);
        b.append(block::BYPASS, &[(1, 1)], &[0; 1]);
        assert_eq!(b.segments.len(), 2);
        assert_eq!(b.segments[1], Segment { passes: 2, length: 2 });
    }
}
