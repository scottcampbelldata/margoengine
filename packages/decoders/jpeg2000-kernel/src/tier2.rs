//! Tier-2 (T.800 B.9 to B.12): the order of packets in the five progressions and their changes (POC), and each
//! packet's header: inclusion, zero bit-planes, new coding passes and their lengths.
use crate::codestream::{Change, Codestream, Order};
use crate::tile::{Block, TileComponent, segment_passes};
use crate::{Error, Result, Work};

/// One packet: component, resolution, precinct and layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Packet {
    pub c: u16,
    pub r: u8,
    pub p: u32,
    pub l: u16,
}

/// The most packets one tile may order (beyond it the tile is refused as over the limit).
const MAX_PACKETS: usize = 1 << 26;

/// Where precinct p of resolution r of a component is first reached on the reference grid by the position-driven
/// progressions (B.12.1.3 to B.12.1.5): a precinct whose resolution starts inside it is met at the tile's corner, every
/// other at its own corner scaled back to the reference grid.
fn anchor(tc: &TileComponent, tile: (u32, u32), r: usize, p: u32) -> (u64, u64) {
    let res = &tc.resolutions[r];
    let s = tc.style.levels as u32 - r as u32;
    let px = (res.rect.x0 >> res.ppx) + p % res.across;
    let py = (res.rect.y0 >> res.ppy) + p / res.across;
    let x = if px == res.rect.x0 >> res.ppx && res.rect.x0 % (1 << res.ppx) != 0 {
        tile.0 as u64
    } else {
        ((px as u64) << res.ppx << s) * tc.dx as u64
    };
    let y = if py == res.rect.y0 >> res.ppy && res.rect.y0 % (1 << res.ppy) != 0 {
        tile.1 as u64
    } else {
        ((py as u64) << res.ppy << s) * tc.dy as u64
    };
    (x, y)
}

/// The packets of tile t in codestream order: each progression of the tile's (or main header's) POC in turn, then the
/// COD progression for any packet none of them reached. At most `most` packets are ordered: the caller's data holds no
/// more. Each precinct visited is spent from `work`, so progression changes cannot repeat them without end.
pub fn sequence(cs: &Codestream, t: usize, comps: &[TileComponent], most: usize, work: &mut Work) -> Result<Vec<Packet>> {
    let global = cs.global(t);
    let layers = global.layers;
    let tile = cs.size.tile(t);
    let corner = (tile.x0, tile.y0);
    // The next layer each precinct waits for.
    let mut next: Vec<Vec<Vec<u16>>> = comps
        .iter()
        .map(|tc| tc.resolutions.iter().map(|res| vec![0u16; res.precincts.len()]).collect())
        .collect();
    let max_r = comps.iter().map(|tc| tc.resolutions.len()).max().unwrap_or(0);
    let mut out = Vec::new();
    let emit = |c: usize, r: usize, p: usize, upto: u16, next: &mut Vec<Vec<Vec<u16>>>, out: &mut Vec<Packet>| -> Result<()> {
        let n = &mut next[c][r][p];
        while *n < upto && out.len() < most {
            if out.len() >= MAX_PACKETS {
                return Err(Error::Limit);
            }
            out.push(Packet { c: c as u16, r: r as u8, p: p as u32, l: *n });
            *n += 1;
        }
        Ok(())
    };
    let whole = Change { rs: 0, cs: 0, le: layers, re: max_r as u8, ce: comps.len() as u16, order: global.order };
    let mut changes: Vec<Change> = cs.changes(t).to_vec();
    changes.push(whole);
    for ch in changes {
        if out.len() >= most {
            break;
        }
        work.spend(1)?;
        let le = ch.le.min(layers);
        let (rs, re) = (ch.rs as usize, (ch.re as usize).min(max_r));
        let (c0, c1) = (ch.cs as usize, (ch.ce as usize).min(comps.len()));
        let has = |c: usize, r: usize| r < comps[c].resolutions.len();
        match ch.order {
            Order::LRCP | Order::RLCP => {
                let layer_first = ch.order == Order::LRCP;
                let (outer, inner) = if layer_first { (le as usize, re) } else { (re, le as usize) };
                for a in 0..outer {
                    for b in 0..inner {
                        let (l, r) = if layer_first { (a, b) } else { (b, a) };
                        if r < rs {
                            continue;
                        }
                        if out.len() >= most {
                            return Ok(out);
                        }
                        for c in c0..c1 {
                            work.spend(1)?;
                            if !has(c, r) {
                                continue;
                            }
                            work.spend(comps[c].resolutions[r].precincts.len() as u64)?;
                            for p in 0..comps[c].resolutions[r].precincts.len() {
                                // Only the layer the precinct waits for: earlier ones are already in the stream.
                                if next[c][r][p] == l as u16 {
                                    emit(c, r, p, l as u16 + 1, &mut next, &mut out)?;
                                }
                            }
                        }
                    }
                }
            }
            Order::RPCL | Order::PCRL | Order::CPRL => {
                // (sort key, c, r, p); the key orders as the progression's loops do.
                let mut list: Vec<([u64; 4], usize, usize, usize)> = Vec::new();
                for c in c0..c1 {
                    for r in rs..re {
                        work.spend(1)?;
                        if !has(c, r) {
                            continue;
                        }
                        // Each precinct is listed and sorted.
                        work.spend(8 * comps[c].resolutions[r].precincts.len() as u64)?;
                        for p in 0..comps[c].resolutions[r].precincts.len() {
                            let (x, y) = anchor(&comps[c], corner, r, p as u32);
                            let key = match ch.order {
                                Order::RPCL => [r as u64, y, x, c as u64],
                                Order::PCRL => [y, x, c as u64, r as u64],
                                _ => [c as u64, y, x, r as u64],
                            };
                            list.push((key, c, r, p));
                        }
                    }
                }
                list.sort_by_key(|e| e.0);
                for (_, c, r, p) in list {
                    emit(c, r, p, le, &mut next, &mut out)?;
                }
            }
        }
    }
    Ok(out)
}

/// The packet header bit reader of B.10.1: after a 0xFF byte the next byte gives only seven bits.
pub struct Bits<'a> {
    data: &'a [u8],
    pub at: usize,
    byte: u8,
    left: u32,
}

impl<'a> Bits<'a> {
    pub fn new(data: &'a [u8], at: usize) -> Bits<'a> {
        Bits { data, at, byte: 0, left: 0 }
    }
    pub fn bit(&mut self) -> Result<u32> {
        if self.left == 0 {
            let stuffed = self.at > 0 && self.byte == 0xff;
            self.byte = *self.data.get(self.at).ok_or(Error::Truncated)?;
            self.at += 1;
            self.left = if stuffed { 7 } else { 8 };
        }
        self.left -= 1;
        Ok(((self.byte >> self.left) & 1) as u32)
    }
    pub fn bits(&mut self, n: u32) -> Result<u32> {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Ok(v)
    }
    /// Ends the header at a byte boundary; a header ending on 0xFF takes the byte after it too (B.10.1).
    pub fn align(&mut self) -> Result<()> {
        if self.left > 0 || self.at > 0 {
            self.left = 0;
            if self.at > 0 && self.byte == 0xff {
                self.data.get(self.at).ok_or(Error::Truncated)?;
                self.at += 1;
                self.byte = 0;
            }
        }
        Ok(())
    }
}

/// The number of new coding passes (Table B.4).
fn passes(bits: &mut Bits) -> Result<u32> {
    if bits.bit()? == 0 {
        return Ok(1);
    }
    if bits.bit()? == 0 {
        return Ok(2);
    }
    let two = bits.bits(2)?;
    if two < 3 {
        return Ok(3 + two);
    }
    let five = bits.bits(5)?;
    if five < 31 {
        return Ok(6 + five);
    }
    Ok(37 + bits.bits(7)?)
}

fn log2(v: u32) -> u32 {
    31 - v.leading_zeros()
}

/// The passes of each codeword segment a block's `new` passes fall into: what fits in its open segment, then whole
/// segments as the block style cuts them.
pub fn pieces(block: &Block, style: u8, new: u32) -> Vec<u32> {
    let mut at = block.passes;
    let mut room = match block.segments.last() {
        Some(last) => segment_passes(style, at - last.passes).saturating_sub(last.passes),
        None => segment_passes(style, at),
    };
    let mut left = new;
    let mut out = Vec::new();
    while left > 0 {
        if room == 0 {
            room = segment_passes(style, at);
        }
        let take = left.min(room);
        out.push(take);
        left -= take;
        at += take;
        room -= take;
    }
    out
}

/// Where a tile's packet headers and bodies come from.
pub struct Streams<'a> {
    /// The concatenated packet data of the tile's tile-parts.
    pub body: &'a [u8],
    pub at: usize,
    /// Packed headers (PPM or PPT), read in turn, or None for headers in the body.
    pub packed: Option<(&'a [u8], usize)>,
}

/// Reads one packet into its precinct's code-blocks. `keep` is false for a layer past the one the caller decodes: its
/// header is read, its bytes skipped. Returns Err(Truncated) when the stream ends inside the packet.
#[allow(clippy::too_many_arguments)]
pub fn read_packet(streams: &mut Streams, tc: &mut TileComponent, r: usize, p: usize, layer: u16, sop: bool, eph: bool, keep: bool, work: &mut Work) -> Result<()> {
    let style = tc.style.block_style;
    // An SOP marker segment may lead the packet, in the body (A.8.1).
    if sop && streams.body.get(streams.at..streams.at + 2) == Some(&[0xff, 0x91]) {
        if streams.at + 6 > streams.body.len() {
            return Err(Error::Truncated);
        }
        streams.at += 6;
    }
    let (source, start) = match streams.packed {
        Some((data, at)) => (data, at),
        None => (streams.body, streams.at),
    };
    let mut bits = Bits::new(source, start);
    let precinct = &mut tc.resolutions[r].precincts[p];
    // (band, block, pieces of (passes, length)) for every block this packet adds to.
    let mut adds: Vec<(usize, usize, Vec<(u32, u32)>)> = Vec::new();
    if bits.bit()? == 1 {
        for (bi, pb) in precinct.bands.iter_mut().enumerate() {
            // A packet of a few bits may still ask every code-block of its precinct whether it is in.
            work.spend(pb.blocks.len() as u64)?;
            for y in 0..pb.down {
                for x in 0..pb.across {
                    let i = (y * pb.across + x) as usize;
                    let blk = &mut pb.blocks[i];
                    let included = if blk.included {
                        bits.bit()? == 1
                    } else {
                        let mut next = || bits.bit();
                        pb.inclusion.decode(x, y, layer as u32, &mut next)?.is_some()
                    };
                    if !included {
                        continue;
                    }
                    if !blk.included {
                        let mut next = || bits.bit();
                        let mut threshold = 0;
                        // Decode the zero bit-plane count in full (B.10.5).
                        let zero = loop {
                            if let Some(v) = pb.zero.decode(x, y, threshold, &mut next)? {
                                break v;
                            }
                            threshold += 1;
                            if threshold > 74 {
                                return Err(Error::Invalid);
                            }
                        };
                        blk.zero_planes = zero;
                        blk.included = true;
                    }
                    let new = passes(&mut bits)?;
                    // Lblock grows by one for each 1 bit before a 0 (B.10.7.1).
                    while bits.bit()? == 1 {
                        blk.lblock += 1;
                        if blk.lblock > 32 {
                            return Err(Error::Invalid);
                        }
                    }
                    let mut got = Vec::new();
                    for n in pieces(blk, style, new) {
                        let width = blk.lblock + log2(n);
                        if width > 32 {
                            return Err(Error::Invalid);
                        }
                        got.push((n, bits.bits(width)?));
                    }
                    if blk.passes + new > 3 * 76 + 1 {
                        return Err(Error::Invalid);
                    }
                    // The header's pass count advances now; the bytes come after the header.
                    adds.push((bi, i, got));
                }
            }
        }
    }
    bits.align()?;
    let mut end = bits.at;
    // An EPH marker ends the header (A.8.2), wherever headers are.
    if eph && source.get(end..end + 2) == Some(&[0xff, 0x92]) {
        end += 2;
    }
    match &mut streams.packed {
        Some((_, at)) => *at = end,
        None => streams.at = end,
    }
    for (bi, i, got) in adds {
        let total: u64 = got.iter().map(|&(_, l)| l as u64).sum();
        let from = streams.at;
        let to = from as u64 + total;
        let blk = &mut precinct.bands[bi].blocks[i];
        if to > streams.body.len() as u64 {
            // The body was cut: keep the whole segments that are there.
            let mut kept = Vec::new();
            let mut at = from as u64;
            for &(n, l) in &got {
                if at + l as u64 > streams.body.len() as u64 {
                    break;
                }
                kept.push((n, l));
                at += l as u64;
            }
            if keep && !kept.is_empty() {
                blk.append(style, &kept, &streams.body[from..at as usize]);
            }
            streams.at = streams.body.len();
            return Err(Error::Truncated);
        }
        if keep {
            blk.append(style, &got, &streams.body[from..to as usize]);
        } else {
            // A skipped layer still advances the pass count, so later headers split segments rightly.
            blk.passes += got.iter().map(|&(n, _)| n).sum::<u32>();
        }
        streams.at = to as usize;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codestream::tests::{Writer, cod, siz};
    use crate::codestream::{self, COD, EOC, QCD, SIZ, SOC, SOD, SOT};
    use crate::tile;

    /// Every packet of tile 0 in order.
    fn all(cs: &codestream::Codestream, tcs: &[TileComponent]) -> Vec<Packet> {
        sequence(cs, 0, tcs, usize::MAX, &mut Work::new(0)).unwrap()
    }

    /// Packet header bits with the 0xFF stuffing rule, for tests.
    struct BitWriter {
        out: Vec<u8>,
        byte: u32,
        n: u32,
    }
    impl BitWriter {
        fn new() -> BitWriter {
            BitWriter { out: Vec::new(), byte: 0, n: 0 }
        }
        fn put(&mut self, bit: u32) {
            let cap = if self.out.last() == Some(&0xff) { 7 } else { 8 };
            self.byte = (self.byte << 1) | bit;
            self.n += 1;
            if self.n == cap {
                self.out.push(self.byte as u8);
                self.byte = 0;
                self.n = 0;
            }
        }
        fn put_bits(&mut self, v: u32, n: u32) {
            for i in (0..n).rev() {
                self.put((v >> i) & 1);
            }
        }
        fn finish(mut self) -> Vec<u8> {
            let cap = if self.out.last() == Some(&0xff) { 7 } else { 8 };
            if self.n > 0 {
                self.byte <<= cap - self.n;
                self.out.push(self.byte as u8);
            }
            if self.out.last() == Some(&0xff) {
                self.out.push(0);
            }
            self.out
        }
    }

    fn stream(w: u32, h: u32, order: u8, levels: u8, layers: u16, precincts: Option<&[u8]>, comps: &[(u8, bool, u8, u8)], extra: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut wr = Writer(Vec::new());
        wr.marker(SOC).segment(SIZ, &siz(w, h, w, h, comps)).segment(COD, &cod(order, layers, 0, levels, true, precincts));
        let mut q = vec![0x40];
        q.extend(std::iter::repeat_n(9 << 3, 3 * levels as usize + 1));
        wr.segment(QCD, &q);
        for (m, b) in extra {
            wr.segment(*m, b);
        }
        let at = wr.0.len();
        wr.segment(SOT, &[0; 8]).marker(SOD);
        let length = (wr.0.len() - at) as u32;
        wr.0[at + 6..at + 10].copy_from_slice(&length.to_be_bytes());
        wr.marker(EOC);
        wr.0
    }

    #[test]
    fn progression_orders() {
        // Two components, two resolutions of 2 x 1 precincts at 2^ppx = 4 wide... a 16 x 8 image, 1 level, PP 3.
        let comps = [(8, false, 1, 1), (8, false, 1, 1)];
        let pp = [0x33, 0x33];
        let check = |order: u8| {
            let data = stream(16, 8, order, 1, 2, Some(&pp), &comps, &[]);
            let cs = codestream::parse(&data).unwrap();
            let tcs = tile::build(&cs, 0).unwrap();
            assert_eq!(tcs[0].resolutions[0].precincts.len(), 1);
            assert_eq!(tcs[0].resolutions[1].precincts.len(), 2);
            all(&cs, &tcs).iter().map(|p| (p.l, p.r, p.c, p.p)).collect::<Vec<_>>()
        };
        let lrcp = check(0);
        assert_eq!(lrcp.len(), 2 * 2 * 3);
        assert_eq!(&lrcp[..6], &[(0, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 1, 0, 1), (0, 1, 1, 0), (0, 1, 1, 1)]);
        let rlcp = check(1);
        assert_eq!(&rlcp[..4], &[(0, 0, 0, 0), (0, 0, 1, 0), (1, 0, 0, 0), (1, 0, 1, 0)]);
        // RPCL: resolution, then position (precinct 0 at x 0 before precinct 1 at x 8), component, layers innermost.
        let rpcl = check(2);
        assert_eq!(&rpcl[4..], &[(0, 1, 0, 0), (1, 1, 0, 0), (0, 1, 1, 0), (1, 1, 1, 0), (0, 1, 0, 1), (1, 1, 0, 1), (0, 1, 1, 1), (1, 1, 1, 1)]);
        // PCRL: position, component, resolution: resolution 0's one precinct sits at x 0 with resolution 1's first.
        let pcrl = check(3);
        assert_eq!(&pcrl[..8], &[(0, 0, 0, 0), (1, 0, 0, 0), (0, 1, 0, 0), (1, 1, 0, 0), (0, 0, 1, 0), (1, 0, 1, 0), (0, 1, 1, 0), (1, 1, 1, 0)]);
        let cprl = check(4);
        assert_eq!(&cprl[..6], &[(0, 0, 0, 0), (1, 0, 0, 0), (0, 1, 0, 0), (1, 1, 0, 0), (0, 1, 0, 1), (1, 1, 0, 1)]);
        for v in [&rlcp, &rpcl, &pcrl, &cprl] {
            let mut a = v.to_vec();
            let mut b = lrcp.clone();
            a.sort();
            b.sort();
            assert_eq!(a, b, "every order holds each packet once");
        }
    }

    #[test]
    fn unaligned_precincts_meet_at_the_tile_corner() {
        // Image from x 3: resolution 1 starts at 3, inside precinct 0 (8 wide), met at the tile corner x 3.
        let mut s = siz(19, 4, 19, 4, &[(8, false, 1, 1)]);
        s[10..14].copy_from_slice(&3u32.to_be_bytes());
        let mut wr = Writer(Vec::new());
        wr.marker(SOC).segment(SIZ, &s).segment(COD, &cod(2, 1, 0, 0, true, Some(&[0x33]))).segment(QCD, &[0x40, 9 << 3]);
        wr.segment(SOT, &[0, 0, 0, 0, 0, 14, 0, 1]).marker(SOD).marker(EOC);
        let cs = codestream::parse(&wr.0).unwrap();
        let tcs = tile::build(&cs, 0).unwrap();
        assert_eq!(anchor(&tcs[0], (3, 0), 0, 0), (3, 0));
        assert_eq!(anchor(&tcs[0], (3, 0), 0, 1), (8, 0));
        assert_eq!(anchor(&tcs[0], (3, 0), 0, 2), (16, 0));
    }

    #[test]
    fn progression_changes_come_first() {
        let comps = [(8, false, 1, 1), (8, false, 1, 1)];
        // POC: resolution 0 of component 1, layer 0 only, in LRCP; then COD's LRCP finishes the rest.
        let poc = vec![0, 1, 0, 1, 1, 2, 0];
        let data = stream(16, 8, 0, 1, 2, None, &comps, &[(codestream::POC, poc)]);
        let cs = codestream::parse(&data).unwrap();
        let tcs = tile::build(&cs, 0).unwrap();
        let seq: Vec<_> = all(&cs, &tcs).iter().map(|p| (p.l, p.r, p.c)).collect();
        assert_eq!(seq[0], (0, 0, 1));
        assert_eq!(&seq[1..4], &[(0, 0, 0), (0, 1, 0), (0, 1, 1)]);
        assert_eq!(seq.len(), 8);
        assert_eq!(seq.iter().filter(|&&s| s == (0, 0, 1)).count(), 1);
    }

    #[test]
    fn pass_counts_and_stuffing() {
        for n in [1u32, 2, 3, 5, 6, 36, 37, 164] {
            let mut w = BitWriter::new();
            match n {
                1 => w.put(0),
                2 => w.put_bits(2, 2),
                3..=5 => w.put_bits(0b1100 | (n - 3), 4),
                6..=36 => w.put_bits((0b1111 << 5) | (n - 6), 9),
                _ => w.put_bits((0b1_1111_1111 << 7) | (n - 37), 16),
            }
            let data = w.finish();
            assert_eq!(passes(&mut Bits::new(&data, 0)).unwrap(), n);
        }
        // After 0xFF only seven bits are read.
        let data = [0xff, 0x7f, 0x80];
        let mut b = Bits::new(&data, 0);
        assert_eq!(b.bits(8).unwrap(), 0xff);
        assert_eq!(b.bits(7).unwrap(), 0x7f);
        assert_eq!(b.bit().unwrap(), 1);
        let mut b = Bits::new(&[0xff, 0x00, 0x55], 0);
        b.bits(8).unwrap();
        b.align().unwrap();
        assert_eq!(b.at, 2, "a header ending on 0xFF takes the next byte");
    }

    #[test]
    fn packet_header_round_trip() {
        // One 8 x 8 block per band at one level; layer 0 includes LL with 2 zero planes, 3 passes of 9 bytes; layer 1
        // adds 2 passes of 4 bytes after an Lblock increase.
        let data = stream(8, 8, 0, 0, 2, None, &[(8, false, 1, 1)], &[]);
        let cs = codestream::parse(&data).unwrap();
        let mut tcs = tile::build(&cs, 0).unwrap();
        let mut w = BitWriter::new();
        w.put(1); // not empty
        // Inclusion tag tree (1 x 1, value 0): one 1 bit at threshold 0.
        w.put(1);
        // Zero planes 2: 0, 0, 1.
        w.put_bits(0b001, 3);
        // Three passes: 1100.
        w.put_bits(0b1100, 4);
        // Lblock stays 3: a 0, then 3 + log2(3) = 4 bits of length 9.
        w.put(0);
        w.put_bits(9, 4);
        let mut packet = w.finish();
        packet.extend_from_slice(&[7; 9]);
        let mut w = BitWriter::new();
        w.put(1);
        w.put(1); // included again
        w.put_bits(0b10, 2); // 2 passes
        w.put_bits(0b10, 2); // Lblock 4
        w.put_bits(4, 5); // 4 + log2(2) bits
        packet.extend(w.finish());
        packet.extend_from_slice(&[8; 4]);
        let mut streams = Streams { body: &packet, at: 0, packed: None };
        read_packet(&mut streams, &mut tcs[0], 0, 0, 0, false, false, true, &mut Work::new(0)).unwrap();
        read_packet(&mut streams, &mut tcs[0], 0, 0, 1, false, false, true, &mut Work::new(0)).unwrap();
        assert_eq!(streams.at, packet.len());
        let blk = &tcs[0].resolutions[0].precincts[0].bands[0].blocks[0];
        assert_eq!((blk.zero_planes, blk.passes, blk.lblock), (2, 5, 4));
        assert_eq!(blk.segments, vec![crate::tile::Segment { passes: 5, length: 13 }]);
        assert_eq!(&blk.data[..], &[7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8]);
    }

    #[test]
    fn empty_packets_and_markers() {
        let data = stream(8, 8, 0, 0, 1, None, &[(8, false, 1, 1)], &[]);
        let cs = codestream::parse(&data).unwrap();
        let mut tcs = tile::build(&cs, 0).unwrap();
        // SOP, an empty header byte, EPH.
        let body = [0xff, 0x91, 0, 4, 0, 0, 0x00, 0xff, 0x92];
        let mut streams = Streams { body: &body, at: 0, packed: None };
        read_packet(&mut streams, &mut tcs[0], 0, 0, 0, true, true, true, &mut Work::new(0)).unwrap();
        assert_eq!(streams.at, body.len());
        // Packed headers: the header comes from the packed stream, the body from the tile data.
        let packed = [0x00];
        let mut streams = Streams { body: &[], at: 0, packed: Some((&packed, 0)) };
        read_packet(&mut streams, &mut tcs[0], 0, 0, 0, false, false, true, &mut Work::new(0)).unwrap();
        assert_eq!(streams.packed.unwrap().1, 1);
        // A stream that ends inside the header is reported.
        let mut streams = Streams { body: &[], at: 0, packed: None };
        assert_eq!(read_packet(&mut streams, &mut tcs[0], 0, 0, 0, false, false, true, &mut Work::new(0)).unwrap_err(), Error::Truncated);
    }
}
