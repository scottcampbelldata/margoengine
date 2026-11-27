//! The whole decode of a codestream: tier-2 and tier-1 per tile, dequantization, the inverse wavelet, the component
//! transform, the DC level shift, and each tile's samples placed in the image's component planes.
use crate::codestream::{self, Codestream, Quantization};
use crate::geometry::{self, Rect, ceil_div, ceil_shift};
use crate::tier2::{self, Streams};
use crate::tile::{self, TileComponent};
use crate::{Error, Result, Work, dwt, recon, t1};

/// What to decode.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Resolution levels to drop: 0 decodes full size, n halves the size n times.
    pub reduce: u32,
    /// Quality layers to decode; 0 decodes them all.
    pub layers: u32,
    /// The most samples, over all components, the image may hold.
    pub max_samples: u64,
    /// The most pixels (the widest component times the tallest, after `reduce`) the picture may hold.
    pub max_pixels: u64,
}

impl Default for Options {
    fn default() -> Options {
        Options { reduce: 0, layers: 0, max_samples: 1 << 28, max_pixels: 1 << 26 }
    }
}

/// One component plane of the decoded image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plane {
    pub width: u32,
    pub height: u32,
    pub precision: u32,
    pub signed: bool,
    /// Samples row by row, in the component's range.
    pub data: Vec<i32>,
}

/// A decoded image: its component planes (each at its own subsampling) and whether the stream was cut short.
#[derive(Clone, Debug)]
pub struct Image {
    pub components: Vec<Plane>,
    pub truncated: bool,
}

/// A component's region on the canvas at `reduce` levels down (Equations B-12 and B-14).
fn component_rect(image: &Rect, dx: u32, dy: u32, reduce: u32) -> Rect {
    let r = Rect {
        x0: ceil_div(image.x0 as u64, dx as u64) as u32,
        y0: ceil_div(image.y0 as u64, dy as u64) as u32,
        x1: ceil_div(image.x1 as u64, dx as u64) as u32,
        y1: ceil_div(image.y1 as u64, dy as u64) as u32,
    };
    let f = |v: u32| ceil_shift(v as i64, reduce) as u32;
    Rect { x0: f(r.x0), y0: f(r.y0), x1: f(r.x1), y1: f(r.y1) }
}

/// The most tile-components (tiles times components) a stream may name; each is built even when it holds no sample.
const MAX_TILE_COMPONENTS: u64 = 1 << 20;

/// Decodes a raw codestream (starting at SOC).
pub fn decode(data: &[u8], opts: &Options) -> Result<Image> {
    // A component has at most 32 decomposition levels (A.6.1), so more can never be dropped.
    if opts.reduce > 32 {
        return Err(Error::Invalid);
    }
    let cs = codestream::parse(data)?;
    let size = &cs.size;
    if size.tile_count() as u64 * size.components.len() as u64 > MAX_TILE_COMPONENTS {
        return Err(Error::Limit);
    }
    let mut work = Work::new(data.len());
    let mut planes = Vec::with_capacity(size.components.len());
    let mut total = 0u64;
    let (mut widest, mut tallest) = (0u64, 0u64);
    for comp in &size.components {
        let rect = component_rect(&size.image, comp.dx as u32, comp.dy as u32, opts.reduce);
        total += rect.area();
        // Subsampling differs by axis between components, so the picture can be far larger than any one plane.
        widest = widest.max(rect.width() as u64);
        tallest = tallest.max(rect.height() as u64);
        if total > opts.max_samples || widest * tallest > opts.max_pixels {
            return Err(Error::Limit);
        }
        planes.push((rect, Plane {
            width: rect.width(),
            height: rect.height(),
            precision: comp.precision as u32,
            signed: comp.signed,
            data: vec![0; rect.area() as usize],
        }));
    }
    let mut truncated = cs.truncated;
    for t in 0..size.tile_count() {
        let (samples, cut) = decode_tile(&cs, t, opts, &mut work)?;
        truncated |= cut;
        for (c, (tc_rect, values)) in samples.into_iter().enumerate() {
            let (rect, plane) = &mut planes[c];
            let w = tc_rect.width() as usize;
            for v in 0..tc_rect.height() as usize {
                let row = (tc_rect.y0 - rect.y0) as usize + v;
                let col = (tc_rect.x0 - rect.x0) as usize;
                let at = row * plane.width as usize + col;
                plane.data[at..at + w].copy_from_slice(&values[v * w..(v + 1) * w]);
            }
        }
    }
    Ok(Image { components: planes.into_iter().map(|(_, p)| p).collect(), truncated })
}

/// Coefficients of one tile-component in either arithmetic.
enum Samples {
    Int(Vec<i32>),
    Float(Vec<f32>),
}

/// Decodes tile t into each component's region at the reduced resolution and its samples, shifted and clamped.
fn decode_tile(cs: &Codestream, t: usize, opts: &Options, work: &mut Work) -> Result<(Vec<(Rect, Vec<i32>)>, bool)> {
    let mut comps = tile::build(cs, t)?;
    for tc in &comps {
        if opts.reduce > tc.style.levels as u32 {
            return Err(Error::Invalid);
        }
    }
    let global = cs.global(t);
    let tile = &cs.tiles[t];
    let body: Vec<u8> = tile.parts.iter().flat_map(|p| cs.data[p.data.clone()].iter().copied()).collect();
    let mut streams = Streams { body: &body, at: 0, packed: tile.packed.as_deref().map(|p| (p, 0)) };
    let layers = if opts.layers == 0 { u32::MAX } else { opts.layers };
    let mut truncated = false;
    // A packet header takes at least one byte, so no more packets than those bytes, and the one that finds them spent.
    let most = streams.packed.map_or(body.len(), |(p, _)| p.len()) + 1;
    for pk in tier2::sequence(cs, t, &comps, most, work)? {
        let tc = &mut comps[pk.c as usize];
        let keep = (pk.l as u32) < layers && (pk.r as u32) + opts.reduce <= tc.style.levels as u32;
        let at_end = match streams.packed {
            Some((p, at)) => at >= p.len(),
            None => streams.at >= body.len(),
        };
        if at_end {
            // The tile's data stops before this packet: every later packet is missing too.
            truncated = true;
            break;
        }
        match tier2::read_packet(&mut streams, tc, pk.r as usize, pk.p as usize, pk.l, global.sop, global.eph, keep, work) {
            Ok(()) => {}
            Err(Error::Truncated) => {
                truncated = true;
                break;
            }
            Err(e) => return Err(e),
        }
    }
    let mut out = Vec::with_capacity(comps.len());
    let mut samples = Vec::with_capacity(comps.len());
    for (c, tc) in comps.iter().enumerate() {
        samples.push(component(cs, t, c, tc, opts.reduce)?);
    }
    if global.mct && comps.len() >= 3 {
        let same = |a: &TileComponent, b: &TileComponent| a.dx == b.dx && a.dy == b.dy;
        if !same(&comps[0], &comps[1]) || !same(&comps[0], &comps[2]) {
            return Err(Error::Invalid);
        }
        let (a, rest) = samples.split_at_mut(1);
        let (b, c) = rest.split_at_mut(1);
        match (&mut a[0], &mut b[0], &mut c[0]) {
            (Samples::Int(y0), Samples::Int(y1), Samples::Int(y2)) => recon::inverse_rct(y0, y1, y2),
            (Samples::Float(y0), Samples::Float(y1), Samples::Float(y2)) => recon::inverse_ict(y0, y1, y2),
            // The component transform needs one filter on all three components (G.2 and G.3).
            _ => return Err(Error::Invalid),
        }
    }
    for (c, s) in samples.into_iter().enumerate() {
        let comp = cs.size.components[c];
        let (p, signed) = (comp.precision as u32, comp.signed);
        let values = match s {
            Samples::Int(v) => v.into_iter().map(|x| recon::level_shift(x as f64, p, signed)).collect(),
            Samples::Float(v) => v.into_iter().map(|x| recon::level_shift(x as f64, p, signed)).collect(),
        };
        let levels = comps[c].style.levels as u32;
        out.push((comps[c].resolutions[(levels - opts.reduce) as usize].rect, values));
    }
    Ok((out, truncated))
}

/// One tile-component's samples at `reduce` levels down: every code-block decoded and dequantized into its band, then
/// 2D_SR level by level from the LL band up.
fn component(cs: &Codestream, t: usize, c: usize, tc: &TileComponent, reduce: u32) -> Result<Samples> {
    let levels = tc.style.levels as u32;
    let target = levels - reduce;
    let quant = cs.quant(t, c);
    let roi = cs.roi(t, c);
    let precision = cs.size.components[c].precision as u32;
    let reversible = tc.style.reversible;
    // A reversible filter with quantized steps is legal but rare; it dequantizes in floating point.
    let int = reversible && quant.style == Quantization::None;
    // Bands of resolutions 0..=target, each its rectangle and coefficients.
    let mut ll: Option<(Rect, Samples)> = None;
    for r in 0..=target {
        let res = &tc.resolutions[r as usize];
        let mut bands: Vec<(Rect, Samples)> = Vec::with_capacity(3);
        for (k, &(band, rect)) in res.bands.iter().enumerate() {
            let index = if r == 0 { 0 } else { 3 * (r as usize - 1) + 1 + k };
            let nb = geometry::band_level(levels, r);
            let (exponent, mantissa) = quant.step(index, levels, nb)?;
            let mb = recon::planes(quant.guard, exponent) + roi as u32;
            let stride = rect.width() as usize;
            let mut data =
                if int { Samples::Int(vec![0; rect.area() as usize]) } else { Samples::Float(vec![0.0; rect.area() as usize]) };
            let delta = if int { 1.0 } else { recon::step(precision, band, exponent, mantissa) };
            for precinct in &res.precincts {
                let pb = &precinct.bands[k];
                debug_assert_eq!(pb.band, band);
                for blk in &pb.blocks {
                    if blk.rect.is_empty() || blk.segments.is_empty() {
                        continue;
                    }
                    let d = t1::decode(blk, band, tc.style.block_style, mb)?;
                    let at = (blk.rect.y0 - rect.y0) as usize * stride + (blk.rect.x0 - rect.x0) as usize;
                    match &mut data {
                        Samples::Int(v) => recon::reversible(&d, roi, &mut v[at..], stride),
                        Samples::Float(v) => recon::irreversible(&d, roi, delta, &mut v[at..], stride),
                    }
                }
            }
            bands.push((rect, data));
        }
        ll = Some(match ll {
            None => bands.pop().ok_or(Error::Invalid)?,
            Some((lr, low)) => {
                let mut it = bands.into_iter();
                let (hl, lh, hh) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
                let out = match (low, hl.1, lh.1, hh.1) {
                    (Samples::Int(a), Samples::Int(b), Samples::Int(c), Samples::Int(d)) => Samples::Int(dwt::level(
                        &res.rect,
                        (&lr, &a),
                        (&hl.0, &b),
                        (&lh.0, &c),
                        (&hh.0, &d),
                    )),
                    (Samples::Float(a), Samples::Float(b), Samples::Float(c), Samples::Float(d)) => {
                        if reversible {
                            // A reversible filter on quantized coefficients: the 5-3 lifting on rounded values.
                            let rnd = |v: &[f32]| v.iter().map(|x| x.round() as i32).collect::<Vec<i32>>();
                            let o = dwt::level(&res.rect, (&lr, &rnd(&a)), (&hl.0, &rnd(&b)), (&lh.0, &rnd(&c)), (&hh.0, &rnd(&d)));
                            Samples::Float(o.into_iter().map(|x| x as f32).collect())
                        } else {
                            Samples::Float(dwt::level(&res.rect, (&lr, &a), (&hl.0, &b), (&lh.0, &c), (&hh.0, &d)))
                        }
                    }
                    _ => return Err(Error::Invalid),
                };
                (res.rect, out)
            }
        });
    }
    Ok(ll.ok_or(Error::Invalid)?.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codestream::tests::{Writer, cod, siz};

    /// A codestream of one 8-bit grey tile whose packets are all empty (a single 0 bit each).
    fn empty_stream(w: u32, h: u32, levels: u8, reversible: bool) -> Vec<u8> {
        let mut b = Writer(Vec::new());
        b.marker(0xff4f);
        b.segment(0xff51, &siz(w, h, w, h, &[(8, false, 1, 1)]));
        b.segment(0xff52, &cod(0, 1, 0, levels, reversible, None));
        let mut q = vec![if reversible { 0x20 } else { 0x22 }];
        for _ in 0..(3 * levels as usize + 1) {
            if reversible {
                q.push(8 << 3);
            } else {
                q.extend_from_slice(&[0x40, 0x00]);
            }
        }
        b.segment(0xff5c, &q);
        let packets = levels as usize + 1;
        let body = vec![0u8; packets];
        let mut sot = Vec::new();
        sot.extend_from_slice(&0u16.to_be_bytes());
        sot.extend_from_slice(&((12 + 2 + body.len()) as u32).to_be_bytes());
        sot.extend_from_slice(&[0, 1]);
        b.segment(0xff90, &sot);
        b.marker(0xff93);
        b.0.extend_from_slice(&body);
        b.marker(0xffd9);
        b.0
    }

    #[test]
    fn empty_packets_decode_to_mid_grey() {
        for reversible in [true, false] {
            let img = decode(&empty_stream(13, 9, 2, reversible), &Options::default()).unwrap();
            assert!(!img.truncated);
            let p = &img.components[0];
            assert_eq!((p.width, p.height, p.precision), (13, 9, 8));
            assert!(p.data.iter().all(|&v| v == 128));
        }
    }

    #[test]
    fn reduce_halves_the_size() {
        let img = decode(&empty_stream(13, 9, 2, true), &Options { reduce: 1, ..Options::default() }).unwrap();
        assert_eq!((img.components[0].width, img.components[0].height), (7, 5));
        assert_eq!(decode(&empty_stream(13, 9, 2, true), &Options { reduce: 3, ..Options::default() }).unwrap_err(), Error::Invalid);
    }

    #[test]
    fn sample_limit_refuses_large_images() {
        let opts = Options { max_samples: 100, ..Options::default() };
        assert_eq!(decode(&empty_stream(13, 9, 2, true), &opts).unwrap_err(), Error::Limit);
    }

    #[test]
    fn a_reduce_past_every_level_is_refused() {
        for reduce in [33, 64, u32::MAX] {
            let opts = Options { reduce, ..Options::default() };
            assert_eq!(decode(&empty_stream(13, 9, 2, true), &opts).unwrap_err(), Error::Invalid);
        }
    }

    #[test]
    fn the_pixel_limit_covers_planes_subsampled_on_different_axes() {
        // 200 x 200 on the grid: planes of 200 x 1 and 1 x 200 hold 400 samples and make a 40,000 pixel picture.
        let mut b = Writer(Vec::new());
        b.marker(0xff4f);
        b.segment(0xff51, &siz(200, 200, 200, 200, &[(8, false, 1, 200), (8, false, 200, 1)]));
        b.segment(0xff52, &cod(0, 1, 0, 0, true, None));
        b.segment(0xff5c, &[0x20, 8 << 3]);
        // One tile-part with no packet data: Psot counts the SOT segment and the SOD marker.
        b.segment(0xff90, &[0, 0, 0, 0, 0, 14, 0, 1]);
        b.marker(0xff93);
        b.marker(0xffd9);
        let opts = Options { max_pixels: 39_999, ..Options::default() };
        assert_eq!(decode(&b.0, &opts).unwrap_err(), Error::Limit);
    }

    #[test]
    fn a_cut_body_reports_truncation() {
        let mut s = empty_stream(13, 9, 2, true);
        // Drop the EOC and the last packet byte, keeping Psot as written: the parser sees a cut tile-part.
        s.truncate(s.len() - 3);
        let img = decode(&s, &Options::default()).unwrap();
        assert!(img.truncated);
        assert!(img.components[0].data.iter().all(|&v| v == 128));
    }
}
