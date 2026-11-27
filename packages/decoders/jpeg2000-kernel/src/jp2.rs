//! The JP2 file format of T.800 Annex I (I.5 and I.7): the signature, file type, header (image header, colour
//! specification, palette, component mapping and channel definition) and contiguous codestream boxes, and the
//! mapping of a decoded image to RGBA.
use crate::decode::{Image, Plane};
use crate::{Error, Result};
use std::ops::Range;

/// The colour space of the colour specification box (I.5.3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Colour {
    Srgb,
    Grey,
    Sycc,
    /// A restricted ICC profile: its components are taken as RGB or grey by count.
    Icc,
    Unknown,
}

/// A palette (I.5.3.4): per column its bit depth and signedness, and the entries row by row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Palette {
    pub depths: Vec<(u32, bool)>,
    pub entries: Vec<Vec<i32>>,
}

/// The boxes that shape the picture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jp2 {
    pub codestream: Range<usize>,
    pub colour: Colour,
    pub palette: Option<Palette>,
    /// Component mapping (I.5.3.5): per channel the component, 0 direct or 1 through a palette column, the column.
    pub mapping: Vec<(u16, u8, u8)>,
    /// Channel definitions (I.5.3.6): channel, type (0 colour, 1 opacity, 2 premultiplied opacity), association.
    pub channels: Vec<(u16, u16, u16)>,
}

/// Whether the data starts with the JP2 signature box.
pub fn is_jp2(data: &[u8]) -> bool {
    data.len() >= 12 && data[..12] == [0, 0, 0, 12, b'j', b'P', b' ', b' ', 0x0d, 0x0a, 0x87, 0x0a]
}

/// The boxes of `data[range]`: (type, contents).
fn boxes(data: &[u8], range: Range<usize>) -> Result<Vec<([u8; 4], Range<usize>)>> {
    let mut out = Vec::new();
    let mut at = range.start;
    while at < range.end {
        if at + 8 > range.end {
            return Err(Error::Truncated);
        }
        let len = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = data[at + 4..at + 8].try_into().unwrap();
        let (head, len) = match len {
            0 => (8u64, (range.end - at) as u64),
            1 => {
                if at + 16 > range.end {
                    return Err(Error::Truncated);
                }
                (16, u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap()))
            }
            n => (8, n),
        };
        if len < head {
            return Err(Error::Invalid);
        }
        let end = at as u64 + len;
        if end > range.end as u64 {
            // A cut final box keeps what is there (a cut codestream still decodes).
            out.push((kind, at + head as usize..range.end));
            break;
        }
        out.push((kind, at + head as usize..end as usize));
        at = end as usize;
    }
    Ok(out)
}

fn be(d: &[u8], at: usize, n: usize) -> Result<u32> {
    let b = d.get(at..at + n).ok_or(Error::Truncated)?;
    Ok(b.iter().fold(0u32, |v, &x| (v << 8) | x as u32))
}

/// Parses a JP2 file's boxes.
pub fn parse(data: &[u8]) -> Result<Jp2> {
    if !is_jp2(data) {
        return Err(Error::Invalid);
    }
    let top = boxes(data, 0..data.len())?;
    if top.get(1).map(|b| &b.0) != Some(b"ftyp") {
        return Err(Error::Invalid);
    }
    let mut jp2 = Jp2 { codestream: 0..0, colour: Colour::Unknown, palette: None, mapping: Vec::new(), channels: Vec::new() };
    let mut header = false;
    let mut colour_seen = false;
    for (kind, range) in &top {
        match kind {
            b"jp2h" => {
                header = true;
                for (k, r) in boxes(data, range.clone())? {
                    let d = &data[r.clone()];
                    match &k {
                        b"ihdr" => {
                            if d.len() < 14 || d[11] != 7 {
                                return Err(Error::Invalid);
                            }
                        }
                        // The first colour specification governs (I.5.3.3); later ones are alternatives.
                        b"colr" if !colour_seen => {
                            colour_seen = true;
                            jp2.colour = match be(d, 0, 1)? {
                                1 => match be(d, 3, 4)? {
                                    16 => Colour::Srgb,
                                    17 => Colour::Grey,
                                    18 => Colour::Sycc,
                                    _ => Colour::Unknown,
                                },
                                2 => Colour::Icc,
                                _ => Colour::Unknown,
                            };
                        }
                        b"pclr" => {
                            let entries = be(d, 0, 2)? as usize;
                            let columns = be(d, 2, 1)? as usize;
                            if entries == 0 || entries > 1024 || columns == 0 {
                                return Err(Error::Invalid);
                            }
                            let depths: Vec<(u32, bool)> = (0..columns)
                                .map(|i| be(d, 3 + i, 1).map(|b| ((b & 0x7f) + 1, b & 0x80 != 0)))
                                .collect::<Result<_>>()?;
                            let mut at = 3 + columns;
                            let mut rows = Vec::with_capacity(entries);
                            for _ in 0..entries {
                                let mut row = Vec::with_capacity(columns);
                                for &(bits, signed) in &depths {
                                    let n = bits.div_ceil(8) as usize;
                                    if n > 4 {
                                        return Err(Error::Unsupported);
                                    }
                                    let mut v = be(d, at, n)? as i64;
                                    if signed && bits < 32 && v >> (bits - 1) & 1 == 1 {
                                        v -= 1 << bits;
                                    }
                                    row.push(v as i32);
                                    at += n;
                                }
                                rows.push(row);
                            }
                            jp2.palette = Some(Palette { depths, entries: rows });
                        }
                        b"cmap" => {
                            if d.len() % 4 != 0 {
                                return Err(Error::Invalid);
                            }
                            jp2.mapping = d.chunks_exact(4).map(|c| (u16::from_be_bytes([c[0], c[1]]), c[2], c[3])).collect();
                        }
                        b"cdef" => {
                            let n = be(d, 0, 2)? as usize;
                            jp2.channels = (0..n)
                                .map(|i| Ok((be(d, 2 + 6 * i, 2)? as u16, be(d, 4 + 6 * i, 2)? as u16, be(d, 6 + 6 * i, 2)? as u16)))
                                .collect::<Result<_>>()?;
                        }
                        _ => {}
                    }
                }
            }
            b"jp2c" if jp2.codestream.is_empty() => jp2.codestream = range.clone(),
            _ => {}
        }
    }
    if !header || jp2.codestream.is_empty() {
        return Err(Error::Invalid);
    }
    if jp2.palette.is_some() != !jp2.mapping.is_empty() {
        return Err(Error::Invalid);
    }
    Ok(jp2)
}

/// A channel: its samples at image size with their precision and signedness.
struct Channel {
    data: Vec<i32>,
    precision: u32,
    signed: bool,
}

/// A plane resampled (nearest sample) to `w` by `h`, the size of the largest plane.
fn resample(p: &Plane, w: u32, h: u32) -> Vec<i32> {
    if p.width == w && p.height == h {
        return p.data.clone();
    }
    let mut out = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        let sy = ((y as u64 * p.height as u64) / h.max(1) as u64).min(p.height.saturating_sub(1) as u64) as usize;
        for x in 0..w {
            let sx = ((x as u64 * p.width as u64) / w.max(1) as u64).min(p.width.saturating_sub(1) as u64) as usize;
            out.push(p.data.get(sy * p.width as usize + sx).copied().unwrap_or(0));
        }
    }
    out
}

/// The decoded picture in RGBA, `depth` 8 or 16 bits per sample, row by row.
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub data: Vec<u16>,
}

/// Maps a decoded image to RGBA through the JP2 boxes (or, for a raw codestream, by component count: 1 grey, 2 grey and
/// opacity, 3 RGB, 4 RGB and opacity).
pub fn rgba(img: &Image, jp2: Option<&Jp2>, depth: u32) -> Result<Rgba> {
    let w = img.components.iter().map(|p| p.width).max().ok_or(Error::Invalid)?;
    let h = img.components.iter().map(|p| p.height).max().ok_or(Error::Invalid)?;
    let comp = |i: usize| -> Result<Channel> {
        let p = img.components.get(i).ok_or(Error::Invalid)?;
        Ok(Channel { data: resample(p, w, h), precision: p.precision, signed: p.signed })
    };
    // Channels, after the palette.
    let mut chans: Vec<Channel> = Vec::new();
    match jp2.and_then(|j| j.palette.as_ref().map(|p| (j, p))) {
        Some((j, pal)) => {
            for &(c, kind, column) in &j.mapping {
                let src = comp(c as usize)?;
                if kind == 0 {
                    chans.push(src);
                } else {
                    let (bits, signed) = *pal.depths.get(column as usize).ok_or(Error::Invalid)?;
                    let last = pal.entries.len() as i64 - 1;
                    let data = src.data.iter().map(|&v| pal.entries[(v as i64).clamp(0, last) as usize][column as usize]).collect();
                    chans.push(Channel { data, precision: bits, signed });
                }
            }
        }
        None => {
            for i in 0..img.components.len() {
                chans.push(comp(i)?);
            }
        }
    }
    // Colour channels and opacity, by channel definitions or by count.
    let colour: Vec<usize>;
    let mut alpha: Option<(usize, bool)> = None;
    match jp2.filter(|j| !j.channels.is_empty()) {
        Some(j) => {
            let mut slots: Vec<(u16, usize)> = Vec::new();
            for &(cn, typ, asoc) in &j.channels {
                let cn = cn as usize;
                if cn >= chans.len() {
                    return Err(Error::Invalid);
                }
                match typ {
                    0 if asoc > 0 && asoc != 0xffff => slots.push((asoc, cn)),
                    1 | 2 if alpha.is_none() => alpha = Some((cn, typ == 2)),
                    _ => {}
                }
            }
            slots.sort();
            colour = slots.into_iter().map(|(_, c)| c).collect();
        }
        None => {
            let n = chans.len();
            let colours = match jp2.map(|j| j.colour) {
                Some(Colour::Grey) => 1,
                Some(Colour::Srgb | Colour::Sycc) => 3,
                _ => if n >= 3 { 3 } else { 1 },
            };
            colour = (0..colours.min(n)).collect();
            // A raw codestream's extra component is taken as opacity; a JP2 file says so with a channel definition.
            if jp2.is_none() && n > colours {
                alpha = Some((colours, false));
            }
        }
    }
    if colour.is_empty() {
        return Err(Error::Invalid);
    }
    let max = ((1u32 << depth) - 1) as f64;
    let scale = |c: &Channel, v: f64| -> f64 {
        let range = ((1u64 << c.precision.min(32)) - 1) as f64;
        let v = if c.signed { v + (1u64 << (c.precision - 1)) as f64 } else { v };
        (v / range).clamp(0.0, 1.0)
    };
    let sycc = jp2.map(|j| j.colour) == Some(Colour::Sycc) && colour.len() >= 3;
    let n = (w * h) as usize;
    let mut data = vec![0u16; n * 4];
    for i in 0..n {
        let mut rgb = [0f64; 3];
        if colour.len() >= 3 {
            for k in 0..3 {
                let c = &chans[colour[k]];
                rgb[k] = scale(c, c.data[i] as f64);
            }
            if sycc {
                // sYCC (IEC 61966-2-1 Annex G): the chroma channels centred on half range.
                let (y, cb, cr) = (rgb[0], rgb[1] - 0.5, rgb[2] - 0.5);
                rgb = [y + 1.402 * cr, y - 0.344_136 * cb - 0.714_136 * cr, y + 1.772 * cb];
            }
        } else {
            let c = &chans[colour[0]];
            let g = scale(c, c.data[i] as f64);
            rgb = [g; 3];
        }
        let a = match alpha {
            Some((ch, _)) => scale(&chans[ch], chans[ch].data[i] as f64),
            None => 1.0,
        };
        // Premultiplied opacity is divided out, so every output is straight RGBA.
        if let Some((_, true)) = alpha {
            if a > 0.0 {
                for v in rgb.iter_mut() {
                    *v /= a;
                }
            }
        }
        for k in 0..3 {
            data[i * 4 + k] = (rgb[k].clamp(0.0, 1.0) * max).round() as u16;
        }
        data[i * 4 + 3] = (a * max).round() as u16;
    }
    Ok(Rgba { width: w, height: h, depth, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(body);
        b
    }

    fn file(header: &[Vec<u8>], codestream: &[u8]) -> Vec<u8> {
        let mut f = bx(b"jP  ", &[0x0d, 0x0a, 0x87, 0x0a]);
        f.extend(bx(b"ftyp", b"jp2 \0\0\0\0jp2 "));
        let ihdr = vec![0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 7, 7, 0, 0];
        let mut h = bx(b"ihdr", &ihdr);
        for b in header {
            h.extend_from_slice(b);
        }
        f.extend(bx(b"jp2h", &h));
        f.extend(bx(b"jp2c", codestream));
        f
    }

    fn plane(data: &[i32], precision: u32, signed: bool) -> Plane {
        Plane { width: data.len() as u32, height: 1, precision, signed, data: data.to_vec() }
    }

    #[test]
    fn finds_the_codestream_and_colour() {
        let f = file(&[bx(b"colr", &[1, 0, 0, 0, 0, 0, 17])], &[0xff, 0x4f, 0xff, 0x51]);
        assert!(is_jp2(&f));
        let j = parse(&f).unwrap();
        assert_eq!(j.colour, Colour::Grey);
        assert_eq!(&f[j.codestream.clone()], &[0xff, 0x4f, 0xff, 0x51]);
        // A file without its header box, or a palette without a mapping, is refused.
        let mut bad = bx(b"jP  ", &[0x0d, 0x0a, 0x87, 0x0a]);
        bad.extend(bx(b"ftyp", b"jp2 \0\0\0\0jp2 "));
        bad.extend(bx(b"jp2c", &[0xff, 0x4f]));
        assert_eq!(parse(&bad).unwrap_err(), Error::Invalid);
        let pal = bx(b"pclr", &[0, 1, 1, 7, 9]);
        assert_eq!(parse(&file(&[pal], &[0xff, 0x4f])).unwrap_err(), Error::Invalid);
    }

    #[test]
    fn palette_and_channel_definitions_shape_rgba() {
        // Two entries of three 8-bit columns; the one component indexes them; cdef puts the columns in B, G, R order.
        let pclr = bx(b"pclr", &[0, 2, 3, 7, 7, 7, 10, 20, 30, 200, 100, 0]);
        let cmap = bx(b"cmap", &[0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 2]);
        let cdef = bx(b"cdef", &[0, 3, 0, 0, 0, 0, 0, 3, 0, 1, 0, 0, 0, 2, 0, 2, 0, 0, 0, 1]);
        let f = file(&[bx(b"colr", &[1, 0, 0, 0, 0, 0, 16]), pclr, cmap, cdef], &[0xff, 0x4f]);
        let j = parse(&f).unwrap();
        let img = Image { components: vec![plane(&[0, 1, 5], 1, false)], truncated: false };
        let out = rgba(&img, Some(&j), 8).unwrap();
        assert_eq!(out.data, vec![30, 20, 10, 255, 0, 100, 200, 255, 0, 100, 200, 255]);
    }

    #[test]
    fn raw_codestreams_map_by_component_count() {
        let img = Image {
            components: vec![plane(&[255, 0], 8, false), plane(&[0, 4095], 12, false), plane(&[-128, 127], 8, true), plane(&[0, 255], 8, false)],
            truncated: false,
        };
        let out = rgba(&img, None, 8).unwrap();
        assert_eq!(out.data, vec![255, 0, 0, 0, 0, 255, 255, 255]);
        let grey = Image { components: vec![plane(&[0, 65535], 16, false)], truncated: false };
        assert_eq!(rgba(&grey, None, 16).unwrap().data, vec![0, 0, 0, 65535, 65535, 65535, 65535, 65535]);
    }

    #[test]
    fn subsampled_planes_are_resampled_to_the_largest() {
        let img = Image {
            components: vec![
                Plane { width: 4, height: 2, precision: 8, signed: false, data: vec![9; 8] },
                Plane { width: 2, height: 1, precision: 8, signed: false, data: vec![1, 2] },
                Plane { width: 2, height: 1, precision: 8, signed: false, data: vec![3, 4] },
            ],
            truncated: false,
        };
        let out = rgba(&img, None, 8).unwrap();
        assert_eq!((out.width, out.height), (4, 2));
        let g: Vec<u16> = out.data.chunks(4).map(|p| p[1]).collect();
        assert_eq!(g, vec![1, 1, 2, 2, 1, 1, 2, 2]);
    }
}
