//! Tier-1 (T.800 Annex D): the significance propagation, magnitude refinement and cleanup passes of EBCOT
//! (Taubman 2000) over a code-block's bit-planes, with every code-block style option of Table A.19.
use crate::codestream::block;
use crate::geometry::Band;
use crate::mq::{Context, Mq, Raw};
use crate::tile::{Block, raw_pass};
use crate::{Error, Result};

const SIG: u8 = 1;
const VISITED: u8 = 2;
const REFINED: u8 = 4;
const NEG: u8 = 8;

/// Context labels: zero coding 0 to 8, sign coding 9 to 13, magnitude refinement 14 to 16, run length 17, uniform 18.
const RUN: usize = 17;
const UNIFORM: usize = 18;

/// The initial states of Table D.7: uniform 46, run length 3, the all-zero-neighbour zero coding context 4.
fn fresh() -> [Context; 19] {
    let mut c = [Context::default(); 19];
    c[0].state = 4;
    c[RUN].state = 3;
    c[UNIFORM].state = 46;
    c
}

/// Zero coding context (Table D.1) from the counts of significant horizontal, vertical and diagonal neighbours.
fn zero_context(band: Band, h: u32, v: u32, d: u32) -> usize {
    let (h, v) = if band == Band::HL { (v, h) } else { (h, v) };
    if band == Band::HH {
        let hv = h + v;
        return match d {
            0 => [0, 1, 2][hv.min(2) as usize],
            1 => [3, 4, 5][hv.min(2) as usize],
            2 => if hv == 0 { 6 } else { 7 },
            _ => 8,
        };
    }
    match h {
        0 => match v {
            0 => [0, 1, 2][d.min(2) as usize],
            1 => 3,
            _ => 4,
        },
        1 => {
            if v > 0 {
                7
            } else if d > 0 {
                6
            } else {
                5
            }
        }
        _ => 8,
    }
}

/// Sign coding context and XOR bit (Tables D.2 and D.3) from the clamped horizontal and vertical sign contributions.
fn sign_context(h: i32, v: i32) -> (usize, u32) {
    match (h, v) {
        (1, 1) => (13, 0),
        (1, 0) => (12, 0),
        (1, -1) => (11, 0),
        (0, 1) => (10, 0),
        (0, 0) => (9, 0),
        (0, -1) => (10, 1),
        (-1, 1) => (11, 1),
        (-1, 0) => (12, 1),
        _ => (13, 1),
    }
}

/// The decoded magnitude bits and signs of one code-block, with the lowest bit-plane each sample was coded down to.
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    /// Magnitudes in units of bit-plane 0, signs apart.
    pub magnitude: Vec<u32>,
    pub negative: Vec<bool>,
    /// The lowest bit-plane coded for each sample (its magnitude is known to within 2^low).
    pub low: Vec<u8>,
}

struct State<'a> {
    w: usize,
    h: usize,
    /// Flags with a one-sample border, (w + 2) wide.
    flags: Vec<u8>,
    mag: Vec<u32>,
    low: Vec<u8>,
    band: Band,
    causal: bool,
    cx: [Context; 19],
    _data: std::marker::PhantomData<&'a ()>,
}

/// Where a pass's bits come from.
enum Source<'a> {
    Mq(Mq<'a>),
    Raw(Raw<'a>),
}

impl State<'_> {
    #[inline]
    fn at(&self, x: usize, y: usize) -> usize {
        (y + 1) * (self.w + 2) + x + 1
    }
    /// Significant neighbours (h, v, d); a vertically causal block ignores the stripe below on a stripe's last row.
    #[inline]
    fn neighbours(&self, x: usize, y: usize) -> (u32, u32, u32) {
        let i = self.at(x, y);
        let s = self.w + 2;
        let f = &self.flags;
        let sig = |j: usize| (f[j] & SIG) as u32;
        let below = !(self.causal && y % 4 == 3);
        let h = sig(i - 1) + sig(i + 1);
        let mut v = sig(i - s);
        let mut d = sig(i - s - 1) + sig(i - s + 1);
        if below {
            v += sig(i + s);
            d += sig(i + s - 1) + sig(i + s + 1);
        }
        (h, v, d)
    }
    #[inline]
    fn signs(&self, x: usize, y: usize) -> (i32, i32) {
        let i = self.at(x, y);
        let s = self.w + 2;
        let f = &self.flags;
        let c = |j: usize| -> i32 {
            if f[j] & SIG == 0 {
                0
            } else if f[j] & NEG != 0 {
                -1
            } else {
                1
            }
        };
        let below = !(self.causal && y % 4 == 3);
        let h = (c(i - 1) + c(i + 1)).clamp(-1, 1);
        let v = (c(i - s) + if below { c(i + s) } else { 0 }).clamp(-1, 1);
        (h, v)
    }
    fn sign(&mut self, src: &mut Source, x: usize, y: usize) {
        let bit = match src {
            Source::Raw(r) => r.bit(),
            Source::Mq(m) => {
                let (h, v) = self.signs(x, y);
                let (ctx, xor) = sign_context(h, v);
                m.decode(&mut self.cx[ctx]) ^ xor
            }
        };
        let i = self.at(x, y);
        if bit == 1 {
            self.flags[i] |= NEG;
        }
    }
    fn significant(&mut self, src: &mut Source, x: usize, y: usize, plane: u32) {
        let i = self.at(x, y);
        let k = y * self.w + x;
        self.mag[k] |= 1 << plane;
        self.low[k] = plane as u8;
        self.flags[i] |= SIG;
        self.sign(src, x, y);
    }
    /// D.3.1: insignificant samples with a significant neighbour.
    fn propagation(&mut self, src: &mut Source, plane: u32) {
        for y0 in (0..self.h).step_by(4) {
            for x in 0..self.w {
                for y in y0..(y0 + 4).min(self.h) {
                    let i = self.at(x, y);
                    if self.flags[i] & SIG != 0 {
                        continue;
                    }
                    let (h, v, d) = self.neighbours(x, y);
                    if h + v + d == 0 {
                        continue;
                    }
                    let bit = match src {
                        Source::Raw(r) => r.bit(),
                        Source::Mq(m) => m.decode(&mut self.cx[zero_context(self.band, h, v, d)]),
                    };
                    self.flags[i] |= VISITED;
                    self.low[y * self.w + x] = plane as u8;
                    if bit == 1 {
                        self.significant(src, x, y, plane);
                    }
                }
            }
        }
    }
    /// D.3.3: significant samples not newly significant in this bit-plane.
    fn refinement(&mut self, src: &mut Source, plane: u32) {
        for y0 in (0..self.h).step_by(4) {
            for x in 0..self.w {
                for y in y0..(y0 + 4).min(self.h) {
                    let i = self.at(x, y);
                    if self.flags[i] & (SIG | VISITED) != SIG {
                        continue;
                    }
                    let bit = match src {
                        Source::Raw(r) => r.bit(),
                        Source::Mq(m) => {
                            let ctx = if self.flags[i] & REFINED != 0 {
                                16
                            } else {
                                let (h, v, d) = self.neighbours(x, y);
                                if h + v + d == 0 { 14 } else { 15 }
                            };
                            m.decode(&mut self.cx[ctx])
                        }
                    };
                    let k = y * self.w + x;
                    self.mag[k] |= bit << plane;
                    self.low[k] = plane as u8;
                    self.flags[i] |= REFINED;
                }
            }
        }
    }
    /// D.3.4: every sample the bit-plane has not coded yet, by runs of four where a whole column has no context.
    /// Cleanup passes are always arithmetic coded.
    fn cleanup(&mut self, src: &mut Source, plane: u32) -> Result<()> {
        if !matches!(src, Source::Mq(_)) {
            return Err(Error::Invalid);
        }
        let decide = |src: &mut Source, cx: &mut Context| match src {
            Source::Mq(m) => m.decode(cx),
            Source::Raw(_) => 0,
        };
        for y0 in (0..self.h).step_by(4) {
            for x in 0..self.w {
                let mut y = y0;
                let end = (y0 + 4).min(self.h);
                if end - y0 == 4
                    && (y0..end).all(|y| {
                        let (h, v, d) = self.neighbours(x, y);
                        self.flags[self.at(x, y)] & (SIG | VISITED) == 0 && h + v + d == 0
                    })
                {
                    if decide(src, &mut self.cx[RUN]) == 0 {
                        continue;
                    }
                    let hi = decide(src, &mut self.cx[UNIFORM]);
                    let lo = decide(src, &mut self.cx[UNIFORM]);
                    y = y0 + ((hi << 1) | lo) as usize;
                    self.significant(src, x, y, plane);
                    y += 1;
                }
                while y < end {
                    let i = self.at(x, y);
                    if self.flags[i] & (SIG | VISITED) == 0 {
                        let (h, v, d) = self.neighbours(x, y);
                        let ctx = zero_context(self.band, h, v, d);
                        if decide(src, &mut self.cx[ctx]) == 1 {
                            self.significant(src, x, y, plane);
                        } else {
                            self.low[y * self.w + x] = plane as u8;
                        }
                    }
                    y += 1;
                }
            }
        }
        for f in self.flags.iter_mut() {
            *f &= !VISITED;
        }
        Ok(())
    }
}

/// Decodes a code-block's passes. `planes` is Mb of Equation E-2 (plus any ROI shift): the bit-planes the band may
/// hold, of which the block's zero bit-planes are missing.
pub fn decode(blk: &Block, band: Band, style: u8, planes: u32) -> Result<Decoded> {
    let w = blk.rect.width() as usize;
    let h = blk.rect.height() as usize;
    let mut st = State {
        w,
        h,
        flags: vec![0; (w + 2) * (h + 2)],
        mag: vec![0; w * h],
        low: vec![0; w * h],
        band,
        causal: style & block::CAUSAL != 0,
        cx: fresh(),
        _data: std::marker::PhantomData,
    };
    if blk.passes > 0 && w > 0 && h > 0 {
        if blk.zero_planes >= planes {
            // No bit-plane left to code: a header this decoder cannot follow. The block decodes as zero.
            if planes == 0 || blk.zero_planes > planes + 1 {
                return Err(Error::Invalid);
            }
        } else {
            if planes > 31 {
                return Err(Error::Limit);
            }
            let top = planes - 1 - blk.zero_planes;
            let mut offset = 0usize;
            let mut pass = 0u32;
            'segments: for seg in &blk.segments {
                let end = offset + seg.length as usize;
                let bytes = blk.data.get(offset..end).ok_or(Error::Invalid)?;
                offset = end;
                let raw = raw_pass(style, pass);
                let mut src = if raw { Source::Raw(Raw::new(bytes)) } else { Source::Mq(Mq::new(bytes)) };
                for _ in 0..seg.passes {
                    // Pass 0 is the top plane's cleanup; then propagation, refinement and cleanup per plane.
                    let kind = (pass + 2) % 3;
                    let shift = (pass + 2) / 3;
                    if shift > top {
                        break 'segments;
                    }
                    let plane = top - shift;
                    match kind {
                        0 => st.propagation(&mut src, plane),
                        1 => st.refinement(&mut src, plane),
                        _ => {
                            st.cleanup(&mut src, plane)?;
                            if style & block::SEGMENTATION != 0 {
                                let Source::Mq(m) = &mut src else { return Err(Error::Invalid) };
                                let mut sym = 0;
                                for _ in 0..4 {
                                    sym = (sym << 1) | m.decode(&mut st.cx[UNIFORM]);
                                }
                                // A wrong segmentation symbol marks damage: what came before it stands.
                                if sym != 0b1010 {
                                    break 'segments;
                                }
                            }
                        }
                    }
                    if style & block::RESET != 0 {
                        st.cx = fresh();
                    }
                    pass += 1;
                }
            }
        }
    }
    let mut negative = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            negative[y * w + x] = st.flags[st.at(x, y)] & NEG != 0;
        }
    }
    Ok(Decoded { width: w, height: h, magnitude: st.mag, negative, low: st.low })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Rect;
    use crate::mq::tests::Encoder;
    use crate::tile::Segment;

    #[test]
    fn zero_contexts_match_table_d1() {
        // LL and LH.
        assert_eq!(zero_context(Band::LL, 2, 0, 0), 8);
        assert_eq!(zero_context(Band::LH, 1, 1, 0), 7);
        assert_eq!(zero_context(Band::LH, 1, 0, 3), 6);
        assert_eq!(zero_context(Band::LL, 1, 0, 0), 5);
        assert_eq!(zero_context(Band::LL, 0, 2, 0), 4);
        assert_eq!(zero_context(Band::LL, 0, 1, 4), 3);
        assert_eq!(zero_context(Band::LL, 0, 0, 2), 2);
        assert_eq!(zero_context(Band::LL, 0, 0, 1), 1);
        assert_eq!(zero_context(Band::LL, 0, 0, 0), 0);
        // HL swaps the roles of h and v.
        assert_eq!(zero_context(Band::HL, 0, 2, 0), 8);
        assert_eq!(zero_context(Band::HL, 2, 0, 0), 4);
        // HH.
        assert_eq!(zero_context(Band::HH, 0, 0, 3), 8);
        assert_eq!(zero_context(Band::HH, 1, 0, 2), 7);
        assert_eq!(zero_context(Band::HH, 0, 0, 2), 6);
        assert_eq!(zero_context(Band::HH, 2, 0, 1), 5);
        assert_eq!(zero_context(Band::HH, 0, 1, 1), 4);
        assert_eq!(zero_context(Band::HH, 0, 0, 1), 3);
        assert_eq!(zero_context(Band::HH, 1, 1, 0), 2);
        assert_eq!(zero_context(Band::HH, 1, 0, 0), 1);
        assert_eq!(zero_context(Band::HH, 0, 0, 0), 0);
    }

    #[test]
    fn sign_contexts_are_symmetric() {
        for h in -1..=1 {
            for v in -1..=1 {
                let (a, x) = sign_context(h, v);
                let (b, y) = sign_context(-h, -v);
                assert_eq!(a, b);
                assert_eq!(x ^ y, if h == 0 && v == 0 { 0 } else { 1 });
            }
        }
    }

    /// A test encoder of the three passes, written from D.3 the encoder's way round (it knows the samples).
    struct Coder {
        w: usize,
        h: usize,
        values: Vec<i32>,
        flags: Vec<u8>,
        band: Band,
        causal: bool,
        cx: [Context; 19],
        /// Raw bits while a bypassed pass codes.
        raw: Option<Vec<u32>>,
    }
    impl Coder {
        fn st(&self) -> State<'static> {
            State {
                w: self.w,
                h: self.h,
                flags: self.flags.clone(),
                mag: vec![0; self.w * self.h],
                low: vec![0; self.w * self.h],
                band: self.band,
                causal: self.causal,
                cx: self.cx,
                _data: std::marker::PhantomData,
            }
        }
        fn bit(&self, x: usize, y: usize, plane: u32) -> u32 {
            (self.values[y * self.w + x].unsigned_abs() >> plane) & 1
        }
        fn sign_bit(&mut self, e: &mut Encoder, x: usize, y: usize) {
            let st = self.st();
            let (h, v) = st.signs(x, y);
            let (ctx, xor) = sign_context(h, v);
            let neg = (self.values[y * self.w + x] < 0) as u32;
            // A raw pass sends the sign itself.
            self.code(e, ctx, if self.raw.is_some() { neg } else { neg ^ xor });
            self.flags[st.at(x, y)] |= SIG | if neg == 1 { NEG } else { 0 };
        }
        fn code(&mut self, e: &mut Encoder, ctx: usize, bit: u32) {
            if let Some(raw) = &mut self.raw {
                raw.push(bit);
                return;
            }
            let mut c = self.cx[ctx];
            e.encode(&mut c, bit);
            self.cx[ctx] = c;
        }
        fn propagation(&mut self, e: &mut Encoder, plane: u32) {
            for y0 in (0..self.h).step_by(4) {
                for x in 0..self.w {
                    for y in y0..(y0 + 4).min(self.h) {
                        let st = self.st();
                        let i = st.at(x, y);
                        if self.flags[i] & SIG != 0 {
                            continue;
                        }
                        let (h, v, d) = st.neighbours(x, y);
                        if h + v + d == 0 {
                            continue;
                        }
                        let b = self.bit(x, y, plane);
                        self.code(e, zero_context(self.band, h, v, d), b);
                        self.flags[i] |= VISITED;
                        if b == 1 {
                            self.sign_bit(e, x, y);
                        }
                    }
                }
            }
        }
        fn refinement(&mut self, e: &mut Encoder, plane: u32) {
            for y0 in (0..self.h).step_by(4) {
                for x in 0..self.w {
                    for y in y0..(y0 + 4).min(self.h) {
                        let st = self.st();
                        let i = st.at(x, y);
                        if self.flags[i] & (SIG | VISITED) != SIG {
                            continue;
                        }
                        let ctx = if self.flags[i] & REFINED != 0 {
                            16
                        } else {
                            let (h, v, d) = st.neighbours(x, y);
                            if h + v + d == 0 { 14 } else { 15 }
                        };
                        self.code(e, ctx, self.bit(x, y, plane));
                        self.flags[i] |= REFINED;
                    }
                }
            }
        }
        fn cleanup(&mut self, e: &mut Encoder, plane: u32) {
            for y0 in (0..self.h).step_by(4) {
                for x in 0..self.w {
                    let end = (y0 + 4).min(self.h);
                    let mut y = y0;
                    let st = self.st();
                    if end - y0 == 4 && (y0..end).all(|y| {
                        let (h, v, d) = st.neighbours(x, y);
                        self.flags[st.at(x, y)] & (SIG | VISITED) == 0 && h + v + d == 0
                    }) {
                        let first = (y0..end).find(|&y| self.bit(x, y, plane) == 1);
                        match first {
                            None => {
                                self.code(e, RUN, 0);
                                continue;
                            }
                            Some(f) => {
                                self.code(e, RUN, 1);
                                let r = (f - y0) as u32;
                                self.code(e, UNIFORM, r >> 1);
                                self.code(e, UNIFORM, r & 1);
                                self.sign_bit(e, x, f);
                                y = f + 1;
                            }
                        }
                    }
                    while y < end {
                        let st = self.st();
                        let i = st.at(x, y);
                        if self.flags[i] & (SIG | VISITED) == 0 {
                            let (h, v, d) = st.neighbours(x, y);
                            let b = self.bit(x, y, plane);
                            self.code(e, zero_context(self.band, h, v, d), b);
                            if b == 1 {
                                self.sign_bit(e, x, y);
                            }
                        }
                        y += 1;
                    }
                }
            }
            for f in self.flags.iter_mut() {
                *f &= !VISITED;
            }
        }
    }

    fn samples(w: usize, h: usize, seed: u32) -> Vec<i32> {
        let mut s = seed;
        (0..w * h)
            .map(|i| {
                s = s.wrapping_mul(1103515245).wrapping_add(12345);
                // Mostly small, some large, clustered on the left.
                let x = i % w;
                let m = if x < w / 3 { (s >> 16) % 300 } else if (s >> 12) % 5 == 0 { (s >> 16) % 20 } else { 0 };
                if (s >> 28) & 1 == 1 { -(m as i32) } else { m as i32 }
            })
            .collect()
    }

    /// Raw bits to bytes with the stuffed bit after 0xFF (D.6), padded with 0 bits.
    fn raw_bytes(bits: &[u32]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let (mut byte, mut n) = (0u32, 0u32);
        for &b in bits {
            let cap = if out.last() == Some(&0xff) { 7 } else { 8 };
            byte = (byte << 1) | b;
            n += 1;
            if n == cap {
                out.push(byte as u8);
                byte = 0;
                n = 0;
            }
        }
        if n > 0 {
            let cap = if out.last() == Some(&0xff) { 7 } else { 8 };
            out.push((byte << (cap - n)) as u8);
        }
        out
    }

    /// Codes a block's every pass, cutting codeword segments as `style` does; returns (segments, bytes, passes).
    fn encode_block(values: &[i32], w: usize, h: usize, band: Band, style: u8, planes: u32, zero: u32) -> (Vec<Segment>, Vec<u8>, u32) {
        let mut c = Coder { w, h, values: values.to_vec(), flags: vec![0; (w + 2) * (h + 2)], band, causal: style & block::CAUSAL != 0, cx: fresh(), raw: None };
        let top = planes - 1 - zero;
        let total = 3 * top + 1;
        let (mut segments, mut data) = (Vec::new(), Vec::new());
        let mut pass = 0;
        while pass < total {
            let n = crate::tile::segment_passes(style, pass).min(total - pass);
            let raw = raw_pass(style, pass);
            c.raw = raw.then(Vec::new);
            let mut e = Encoder::new();
            for _ in 0..n {
                let kind = (pass + 2) % 3;
                let plane = top - (pass + 2) / 3;
                match kind {
                    0 => c.propagation(&mut e, plane),
                    1 => c.refinement(&mut e, plane),
                    _ => {
                        c.cleanup(&mut e, plane);
                        if style & block::SEGMENTATION != 0 {
                            for b in [1, 0, 1, 0] {
                                c.code(&mut e, UNIFORM, b);
                            }
                        }
                    }
                }
                if style & block::RESET != 0 {
                    c.cx = fresh();
                }
                pass += 1;
            }
            let bytes = match c.raw.take() {
                Some(bits) => raw_bytes(&bits),
                None => e.finish(),
            };
            segments.push(Segment { passes: n, length: bytes.len() as u32 });
            data.extend(bytes);
        }
        (segments, data, total)
    }

    #[test]
    fn three_passes_round_trip() {
        for (band, style, w, h) in [
            (Band::LL, 0, 16, 16),
            (Band::HL, 0, 13, 9),
            (Band::LH, block::CAUSAL, 8, 12),
            (Band::HH, block::SEGMENTATION, 7, 5),
            (Band::HH, block::CAUSAL | block::SEGMENTATION, 32, 4),
            (Band::LL, block::BYPASS, 16, 16),
            (Band::HL, block::TERMINATE, 9, 7),
            (Band::LH, block::RESET | block::TERMINATE, 12, 8),
            (Band::HH, block::BYPASS | block::TERMINATE | block::RESET | block::CAUSAL, 20, 11),
            (Band::LL, block::BYPASS | block::SEGMENTATION | block::PREDICTABLE, 11, 13),
        ] {
            let values = samples(w, h, w as u32 * 31 + h as u32);
            let max = values.iter().map(|v| v.unsigned_abs()).max().unwrap();
            let used = 32 - max.leading_zeros();
            let planes = used + 3;
            let zero = planes - used;
            let (segments, bytes, passes) = encode_block(&values, w, h, band, style, planes, zero);
            assert_eq!(segments.len() > 1, style & (block::BYPASS | block::TERMINATE) != 0);
            let blk = Block {
                rect: Rect { x0: 0, y0: 0, x1: w as u32, y1: h as u32 },
                included: true,
                lblock: 3,
                zero_planes: zero,
                passes,
                segments,
                data: bytes,
            };
            let got = decode(&blk, band, style, planes).unwrap();
            for i in 0..w * h {
                let v = values[i];
                assert_eq!(got.magnitude[i], v.unsigned_abs(), "{band:?} sample {i}");
                if v != 0 {
                    assert_eq!(got.negative[i], v < 0);
                    assert_eq!(got.low[i], 0);
                }
            }
            // Fewer passes: the planes above stay right, the lower ones unknown.
            let mut cut = blk.clone();
            cut.passes = cut.segments[0].passes.min(4);
            cut.segments.truncate(1);
            cut.segments[0].passes = cut.passes;
            let part = decode(&cut, band, style, planes).unwrap();
            for i in 0..w * h {
                let known = part.magnitude[i];
                if known != 0 {
                    let low = part.low[i] as u32;
                    assert_eq!(known >> low, values[i].unsigned_abs() >> low);
                }
            }
        }
    }
}
