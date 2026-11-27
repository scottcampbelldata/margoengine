//! The codestream syntax of T.800 Annex A: the main header, tile-part headers and the packet data they delimit.
use crate::geometry::Rect;
use crate::{Error, Result};

pub const SOC: u16 = 0xff4f;
pub const CAP: u16 = 0xff50;
pub const SIZ: u16 = 0xff51;
pub const COD: u16 = 0xff52;
pub const COC: u16 = 0xff53;
pub const TLM: u16 = 0xff55;
pub const PLM: u16 = 0xff57;
pub const PLT: u16 = 0xff58;
pub const CPF: u16 = 0xff59;
pub const QCD: u16 = 0xff5c;
pub const QCC: u16 = 0xff5d;
pub const RGN: u16 = 0xff5e;
pub const POC: u16 = 0xff5f;
pub const PPM: u16 = 0xff60;
pub const PPT: u16 = 0xff61;
pub const CRG: u16 = 0xff63;
pub const COM: u16 = 0xff64;
pub const SOT: u16 = 0xff90;
pub const SOP: u16 = 0xff91;
pub const EPH: u16 = 0xff92;
pub const SOD: u16 = 0xff93;
pub const EOC: u16 = 0xffd9;

/// The most components SIZ allows (Csiz, A.5.1).
pub const MAX_COMPONENTS: usize = 16384;

/// One component of SIZ (Ssiz, XRsiz, YRsiz).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Component {
    /// Bits per sample, 1 to 38.
    pub precision: u8,
    pub signed: bool,
    pub dx: u8,
    pub dy: u8,
}

/// The image and tile size (SIZ, A.5.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Size {
    pub capabilities: u16,
    /// The image area on the reference grid: [x0, x1) x [y0, y1).
    pub image: Rect,
    pub tile_width: u32,
    pub tile_height: u32,
    pub tile_x0: u32,
    pub tile_y0: u32,
    pub components: Vec<Component>,
}

impl Size {
    pub fn tiles_across(&self) -> u32 {
        (self.image.x1 - self.tile_x0).div_ceil(self.tile_width)
    }
    pub fn tiles_down(&self) -> u32 {
        (self.image.y1 - self.tile_y0).div_ceil(self.tile_height)
    }
    /// The product is taken in 64 bits: a hostile SIZ passes 32, the width of this count in Wasm.
    pub fn tile_count(&self) -> usize {
        usize::try_from(self.tiles_across() as u64 * self.tiles_down() as u64).unwrap_or(usize::MAX)
    }
    /// Tile t's rectangle on the reference grid (Equation B-7).
    pub fn tile(&self, t: usize) -> Rect {
        let p = t as u64 % self.tiles_across() as u64;
        let q = t as u64 / self.tiles_across() as u64;
        let x = self.tile_x0 as u64 + p * self.tile_width as u64;
        let y = self.tile_y0 as u64 + q * self.tile_height as u64;
        let w = self.tile_width as u64;
        let h = self.tile_height as u64;
        Rect {
            x0: x.max(self.image.x0 as u64) as u32,
            y0: y.max(self.image.y0 as u64) as u32,
            x1: (x + w).min(self.image.x1 as u64) as u32,
            y1: (y + h).min(self.image.y1 as u64) as u32,
        }
    }
}

/// The progression orders of Table A.16.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    LRCP = 0,
    RLCP = 1,
    RPCL = 2,
    PCRL = 3,
    CPRL = 4,
}

impl Order {
    fn from(v: u8) -> Result<Order> {
        Ok(match v {
            0 => Order::LRCP,
            1 => Order::RLCP,
            2 => Order::RPCL,
            3 => Order::PCRL,
            4 => Order::CPRL,
            _ => return Err(Error::Invalid),
        })
    }
}

/// The tile-wide part of COD (Scod and SGcod, A.6.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Global {
    /// SOP marker segments may precede packets.
    pub sop: bool,
    /// EPH markers follow packet headers.
    pub eph: bool,
    pub order: Order,
    pub layers: u16,
    /// Multiple component transform: the RCT or ICT on components 0 to 2.
    pub mct: bool,
}

/// Code-block style bits of Table A.19.
pub mod block {
    /// Selective arithmetic coding bypass.
    pub const BYPASS: u8 = 0x01;
    /// Reset context probabilities on coding pass boundaries.
    pub const RESET: u8 = 0x02;
    /// Termination on each coding pass.
    pub const TERMINATE: u8 = 0x04;
    /// Vertically causal context.
    pub const CAUSAL: u8 = 0x08;
    /// Predictable termination.
    pub const PREDICTABLE: u8 = 0x10;
    /// Segmentation symbols.
    pub const SEGMENTATION: u8 = 0x20;
}

/// One component's coding style (SPcod or SPcoc with the precinct flag, A.6.1 and A.6.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Style {
    pub levels: u8,
    /// Code-block width and height exponents (xcb, ycb of Equation A-1 with the 2 added), 2 to 10, sum at most 12.
    pub block_width: u8,
    pub block_height: u8,
    pub block_style: u8,
    /// The 5-3 reversible filter; false is the 9-7 irreversible one.
    pub reversible: bool,
    /// (PPx, PPy) for resolutions 0 to levels; 15 everywhere without user precincts.
    pub precincts: Vec<(u8, u8)>,
}

/// The quantization style of A.6.4: no quantization, scalar derived or scalar expounded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quantization {
    None = 0,
    Derived = 1,
    Expounded = 2,
}

/// A component's quantization (QCD or QCC, A.6.4 and A.6.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quant {
    pub style: Quantization,
    pub guard: u8,
    /// (exponent, mantissa) per band in the order LL, then HL, LH, HH from the lowest resolution up; one entry when
    /// derived. Mantissas are 0 without quantization.
    pub steps: Vec<(u8, u16)>,
}

impl Quant {
    /// (exponent, mantissa) of band `index` (0 the LL band, 3(n-1) + 1 + k for band k of resolution n), at the given
    /// decomposition level nb when derived (Equation E-5).
    pub fn step(&self, index: usize, levels: u32, nb: u32) -> Result<(u8, u16)> {
        match self.style {
            Quantization::Derived => {
                let (e, m) = self.steps[0];
                let e = e as i32 - levels as i32 + nb as i32;
                if e < 0 {
                    return Err(Error::Invalid);
                }
                Ok((e as u8, m))
            }
            _ => self.steps.get(index).copied().ok_or(Error::Invalid),
        }
    }
}

/// One progression of POC (A.6.6): resolutions [rs, re), components [cs, ce) and layers [0, le) in `order`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change {
    pub rs: u8,
    pub cs: u16,
    pub le: u16,
    pub re: u8,
    pub ce: u16,
    pub order: Order,
}

/// Values for the components a header names, sorted by component: a table of every component in every tile header
/// would take gigabytes at 65,535 tiles of 16,384 components.
#[derive(Clone, Debug)]
pub struct Sparse<T>(Vec<(u16, T)>);

impl<T> Default for Sparse<T> {
    fn default() -> Sparse<T> {
        Sparse(Vec::new())
    }
}

impl<T> Sparse<T> {
    fn at(&self, component: u16) -> std::result::Result<usize, usize> {
        self.0.binary_search_by_key(&component, |e| e.0)
    }
    /// A later marker for a component replaces an earlier one.
    pub fn insert(&mut self, component: u16, value: T) {
        match self.at(component) {
            Ok(i) => self.0[i].1 = value,
            Err(i) => self.0.insert(i, (component, value)),
        }
    }
    pub fn get(&self, component: u16) -> Option<&T> {
        self.at(component).ok().map(|i| &self.0[i].1)
    }
}

/// The parameters one header (main or tile) sets.
#[derive(Clone, Debug, Default)]
pub struct Header {
    pub global: Option<Global>,
    pub style: Option<Style>,
    pub component_style: Sparse<Style>,
    pub quant: Option<Quant>,
    pub component_quant: Sparse<Quant>,
    /// The ROI maxshift (RGN, A.6.3) per component.
    pub roi: Sparse<u8>,
    pub changes: Vec<Change>,
}

/// One tile-part: its index within the tile and the byte range of its packet data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TilePart {
    pub index: u8,
    pub data: std::ops::Range<usize>,
}

/// A tile: its header (the markers of all its tile-parts), its tile-parts in codestream order, and the packet headers
/// held in PPM (main header) or PPT (tile-part headers) marker segments, if any.
#[derive(Clone, Debug, Default)]
pub struct Tile {
    pub header: Header,
    pub parts: Vec<TilePart>,
    /// Packed packet headers, in order, when the codestream carries them apart from the packet data.
    pub packed: Option<Vec<u8>>,
    ppt: Vec<(u8, Vec<u8>)>,
}

/// A parsed codestream: borrowed packet data, the image size and every header.
#[derive(Debug)]
pub struct Codestream<'a> {
    pub data: &'a [u8],
    pub size: Size,
    pub main: Header,
    pub tiles: Vec<Tile>,
    /// The stream stops before its end of codestream marker (or inside a tile-part); what is there is decoded.
    pub truncated: bool,
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8> {
        let v = *self.data.get(self.at).ok_or(Error::Truncated)?;
        self.at += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(((self.u8()? as u16) << 8) | self.u8()? as u16)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(((self.u16()? as u32) << 16) | self.u16()? as u32)
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or(Error::Truncated)?;
        let v = self.data.get(self.at..end).ok_or(Error::Truncated)?;
        self.at = end;
        Ok(v)
    }
    fn left(&self) -> usize {
        self.data.len() - self.at
    }
}

/// Reads a marker segment's body (after its marker): the length field counts itself.
fn segment<'a>(r: &mut Reader<'a>) -> Result<&'a [u8]> {
    let length = r.u16()? as usize;
    if length < 2 {
        return Err(Error::Invalid);
    }
    r.bytes(length - 2)
}

fn component_index(r: &mut Reader, components: usize) -> Result<usize> {
    let c = if components < 257 { r.u8()? as usize } else { r.u16()? as usize };
    if c >= components {
        return Err(Error::Invalid);
    }
    Ok(c)
}

fn parse_size(body: &[u8]) -> Result<Size> {
    let mut r = Reader { data: body, at: 0 };
    let capabilities = r.u16()?;
    let (x1, y1, x0, y0) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
    let (tile_width, tile_height, tile_x0, tile_y0) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
    let count = r.u16()? as usize;
    if count == 0 || count > MAX_COMPONENTS || body.len() != 36 + 3 * count {
        return Err(Error::Invalid);
    }
    if x1 <= x0 || y1 <= y0 || tile_width == 0 || tile_height == 0 || tile_x0 > x0 || tile_y0 > y0 {
        return Err(Error::Invalid);
    }
    if tile_x0 as u64 + tile_width as u64 <= x0 as u64 || tile_y0 as u64 + tile_height as u64 <= y0 as u64 {
        return Err(Error::Invalid);
    }
    let mut components = Vec::with_capacity(count);
    for _ in 0..count {
        let s = r.u8()?;
        let (dx, dy) = (r.u8()?, r.u8()?);
        let precision = (s & 0x7f) + 1;
        if precision > 38 || dx == 0 || dy == 0 {
            return Err(Error::Invalid);
        }
        components.push(Component { precision, signed: s & 0x80 != 0, dx, dy });
    }
    let size = Size { capabilities, image: Rect { x0, y0, x1, y1 }, tile_width, tile_height, tile_x0, tile_y0, components };
    // Isot is 16 bits (A.4.2), so a codestream names at most 65,535 tiles.
    if size.tile_count() > 65535 {
        return Err(Error::Invalid);
    }
    Ok(size)
}

/// SPcod or SPcoc (Table A.15) with the precinct flag of Scod or Scoc.
fn parse_style(r: &mut Reader, precincts: bool) -> Result<Style> {
    let levels = r.u8()?;
    let (xcb, ycb) = (r.u8()?, r.u8()?);
    let block_style = r.u8()?;
    let transform = r.u8()?;
    if levels > 32 || xcb > 8 || ycb > 8 || xcb + ycb > 8 {
        return Err(Error::Invalid);
    }
    // Bit 6 selects the HT block coder of Rec. ITU-T T.814 | ISO/IEC 15444-15; bit 7 is reserved.
    if block_style & 0xc0 != 0 {
        return Err(Error::Unsupported);
    }
    // Values above 1 name Part 2 arbitrary wavelet kernels.
    if transform > 1 {
        return Err(Error::Unsupported);
    }
    let mut sizes = Vec::with_capacity(levels as usize + 1);
    for res in 0..=levels {
        if precincts {
            let v = r.u8()?;
            let (ppx, ppy) = (v & 15, v >> 4);
            // Only resolution 0 may have 1 x 1 precincts (A.6.1): above it each band holds half a precinct.
            if res > 0 && (ppx == 0 || ppy == 0) {
                return Err(Error::Invalid);
            }
            sizes.push((ppx, ppy));
        } else {
            sizes.push((15, 15));
        }
    }
    Ok(Style {
        levels,
        block_width: xcb + 2,
        block_height: ycb + 2,
        block_style,
        reversible: transform == 1,
        precincts: sizes,
    })
}

fn parse_cod(body: &[u8], header: &mut Header) -> Result<()> {
    let mut r = Reader { data: body, at: 0 };
    let scod = r.u8()?;
    let order = Order::from(r.u8()?)?;
    let layers = r.u16()?;
    let mct = r.u8()?;
    if layers == 0 || scod & 0xf8 != 0 {
        return Err(Error::Invalid);
    }
    // MCT values above 1 are Part 2 array-based transforms.
    if mct > 1 {
        return Err(Error::Unsupported);
    }
    let style = parse_style(&mut r, scod & 1 != 0)?;
    if r.left() != 0 {
        return Err(Error::Invalid);
    }
    header.global = Some(Global { sop: scod & 2 != 0, eph: scod & 4 != 0, order, layers, mct: mct == 1 });
    header.style = Some(style);
    Ok(())
}

fn parse_coc(body: &[u8], header: &mut Header, components: usize) -> Result<()> {
    let mut r = Reader { data: body, at: 0 };
    let c = component_index(&mut r, components)?;
    let scoc = r.u8()?;
    if scoc & 0xfe != 0 {
        return Err(Error::Invalid);
    }
    let style = parse_style(&mut r, scoc & 1 != 0)?;
    if r.left() != 0 {
        return Err(Error::Invalid);
    }
    header.component_style.insert(c as u16, style);
    Ok(())
}

/// Sqcd or Sqcc and SPqcd or SPqcc (Tables A.27 to A.30).
fn parse_quant(r: &mut Reader) -> Result<Quant> {
    let s = r.u8()?;
    let style = match s & 31 {
        0 => Quantization::None,
        1 => Quantization::Derived,
        2 => Quantization::Expounded,
        _ => return Err(Error::Invalid),
    };
    let mut steps = Vec::new();
    match style {
        Quantization::None => {
            while r.left() > 0 {
                steps.push((r.u8()? >> 3, 0));
            }
        }
        Quantization::Derived | Quantization::Expounded => {
            if r.left() % 2 != 0 {
                return Err(Error::Invalid);
            }
            while r.left() > 0 {
                let v = r.u16()?;
                steps.push(((v >> 11) as u8, v & 0x7ff));
            }
            if style == Quantization::Derived && steps.len() != 1 {
                return Err(Error::Invalid);
            }
        }
    }
    if steps.is_empty() || steps.len() > 3 * 32 + 1 {
        return Err(Error::Invalid);
    }
    Ok(Quant { style, guard: s >> 5, steps })
}

fn parse_poc(body: &[u8], header: &mut Header, components: usize) -> Result<()> {
    let wide = components >= 257;
    let entry = if wide { 9 } else { 7 };
    if body.is_empty() || body.len() % entry != 0 {
        return Err(Error::Invalid);
    }
    let mut r = Reader { data: body, at: 0 };
    while r.left() > 0 {
        let rs = r.u8()?;
        let cs = if wide { r.u16()? } else { r.u8()? as u16 };
        let le = r.u16()?;
        let re = r.u8()?;
        // CEpoc 0 means 256 when a component index is one byte (Table A.32).
        let ce = if wide { r.u16()? } else { r.u8()? as u16 };
        let ce = if ce == 0 && !wide { 256 } else { ce };
        let order = Order::from(r.u8()?)?;
        if rs > 32 || re <= rs || ce as usize <= cs as usize || cs as usize >= components || le == 0 {
            return Err(Error::Invalid);
        }
        header.changes.push(Change { rs, cs, le, re: re.min(33), ce: ce.min(components as u16), order });
    }
    Ok(())
}

/// Applies one marker segment of a main or tile-part header; `false` when the marker is not one a header holds.
fn header_segment(marker: u16, body: &[u8], header: &mut Header, components: usize, main: bool) -> Result<bool> {
    match marker {
        COD => parse_cod(body, header)?,
        COC => parse_coc(body, header, components)?,
        QCD => {
            let mut r = Reader { data: body, at: 0 };
            header.quant = Some(parse_quant(&mut r)?);
        }
        QCC => {
            let mut r = Reader { data: body, at: 0 };
            let c = component_index(&mut r, components)?;
            header.component_quant.insert(c as u16, parse_quant(&mut r)?);
        }
        RGN => {
            let mut r = Reader { data: body, at: 0 };
            let c = component_index(&mut r, components)?;
            // Srgn 0 is the implicit (maxshift) method, the only one in Part 1 (Table A.25).
            if r.u8()? != 0 {
                return Err(Error::Unsupported);
            }
            header.roi.insert(c as u16, r.u8()?);
            if r.left() != 0 {
                return Err(Error::Invalid);
            }
        }
        POC => parse_poc(body, header, components)?,
        COM | PLT | CAP | CPF => {}
        TLM | PLM | CRG if main => {}
        _ => return Ok(false),
    }
    Ok(true)
}

/// True for the Part 2 marker range 0xFF70 to 0xFF7F (DCO, VMS, DFS, ADS, ATK, CBD, MCT, MCC, MCO, NLT and the
/// like): their coding tools change the decoded samples, so skipping them would decode wrongly.
fn extension_marker(marker: u16) -> bool {
    (0xff70..=0xff7f).contains(&marker)
}

/// True for 0xFF30 to 0xFF3F, markers that stand alone, with no length or parameters (A.1).
fn bare_marker(marker: u16) -> bool {
    (0xff30..=0xff3f).contains(&marker)
}

/// Parses a codestream (starting at SOC) into its headers and tile-part data ranges.
pub fn parse(data: &[u8]) -> Result<Codestream<'_>> {
    let mut r = Reader { data, at: 0 };
    if r.u16()? != SOC {
        return Err(Error::Invalid);
    }
    if r.u16()? != SIZ {
        return Err(Error::Invalid);
    }
    let size = parse_size(segment(&mut r)?)?;
    let components = size.components.len();
    let mut main = Header::default();
    // PPM bodies by Zppm.
    let mut ppm: Vec<(u8, Vec<u8>)> = Vec::new();
    loop {
        let marker = r.u16()?;
        if marker == SOT {
            r.at -= 2;
            break;
        }
        if marker == PPM {
            let body = segment(&mut r)?;
            let (&z, rest) = body.split_first().ok_or(Error::Invalid)?;
            ppm.push((z, rest.to_vec()));
            continue;
        }
        if extension_marker(marker) {
            return Err(Error::Unsupported);
        }
        if marker < 0xff00 {
            return Err(Error::Invalid);
        }
        if bare_marker(marker) {
            continue;
        }
        let body = segment(&mut r)?;
        if !header_segment(marker, body, &mut main, components, true)? {
            // An unknown marker segment of no coding tool this decoder knows: skipped (A.1.3 allows informational
            // segments; Part 1 decoders ignore those they do not use).
            continue;
        }
    }
    if main.global.is_none() || main.style.is_none() || main.quant.is_none() {
        return Err(Error::Invalid);
    }
    // A header holds only the components its markers name, so 65,535 tiles of 16,384 components stay small.
    let mut tiles: Vec<Tile> = (0..size.tile_count()).map(|_| Tile::default()).collect();
    let mut order: Vec<usize> = Vec::new();
    let mut truncated = false;
    // The data ends before EOC; Psot 0 runs to there.
    let end = if data.len() >= 2 && data[data.len() - 2..] == [0xff, 0xd9] { data.len() - 2 } else { data.len() };
    while r.at < end {
        let start = r.at;
        let marker = r.u16()?;
        if marker == EOC {
            break;
        }
        if marker != SOT {
            return Err(Error::Invalid);
        }
        let body = match segment(&mut r) {
            Ok(b) => b,
            Err(Error::Truncated) => {
                truncated = true;
                break;
            }
            Err(e) => return Err(e),
        };
        if body.len() != 8 {
            return Err(Error::Invalid);
        }
        let mut s = Reader { data: body, at: 0 };
        let t = s.u16()? as usize;
        let length = s.u32()? as usize;
        let index = s.u8()?;
        let _count = s.u8()?;
        if t >= tiles.len() {
            return Err(Error::Invalid);
        }
        if index as usize != tiles[t].parts.len() {
            return Err(Error::Invalid);
        }
        let stop = if length == 0 { end } else { start.checked_add(length).ok_or(Error::Invalid)? };
        if length != 0 && length < 14 {
            return Err(Error::Invalid);
        }
        let stop = if stop > end {
            truncated = true;
            end
        } else {
            stop
        };
        // The tile-part header.
        let tile = &mut tiles[t];
        let mut header_ok = true;
        loop {
            if r.at + 2 > stop {
                header_ok = false;
                break;
            }
            let marker = r.u16()?;
            if marker == SOD {
                break;
            }
            if extension_marker(marker) {
                return Err(Error::Unsupported);
            }
            if marker < 0xff00 {
                return Err(Error::Invalid);
            }
            if bare_marker(marker) {
                continue;
            }
            let body = match segment(&mut r) {
                Ok(b) if r.at <= stop => b,
                Ok(_) | Err(Error::Truncated) => {
                    header_ok = false;
                    break;
                }
                Err(e) => return Err(e),
            };
            if marker == PPT {
                let (&z, rest) = body.split_first().ok_or(Error::Invalid)?;
                tile.ppt.push((z, rest.to_vec()));
                continue;
            }
            // Coding style and quantization segments belong to the first tile-part only (A.4.2, Table A.3).
            if index > 0 && matches!(marker, COD | COC | QCD | QCC | RGN) {
                return Err(Error::Invalid);
            }
            header_segment(marker, body, &mut tile.header, components, false)?;
        }
        if !header_ok {
            truncated = true;
            break;
        }
        tile.parts.push(TilePart { index, data: r.at..stop });
        order.push(t);
        r.at = stop;
        if truncated {
            break;
        }
    }
    if r.at >= end && end == data.len() {
        // No EOC at the end.
        truncated = true;
    }
    if !ppm.is_empty() {
        if tiles.iter().any(|t| !t.ppt.is_empty()) {
            return Err(Error::Invalid);
        }
        ppm.sort_by_key(|(z, _)| *z);
        let all: Vec<u8> = ppm.into_iter().flat_map(|(_, b)| b).collect();
        // Nppm then Ippm for each tile-part in codestream order (A.7.4).
        let mut p = Reader { data: &all, at: 0 };
        for &t in &order {
            if p.left() == 0 {
                break;
            }
            let n = p.u32().map_err(|_| Error::Invalid)? as usize;
            let bytes = p.bytes(n).map_err(|_| Error::Invalid)?;
            tiles[t].packed.get_or_insert_with(Vec::new).extend_from_slice(bytes);
        }
    }
    for tile in &mut tiles {
        if !tile.ppt.is_empty() {
            tile.ppt.sort_by_key(|(z, _)| *z);
            tile.packed = Some(tile.ppt.drain(..).flat_map(|(_, b)| b).collect());
        }
    }
    Ok(Codestream { data, size, main, tiles, truncated })
}

impl Codestream<'_> {
    /// The tile-wide coding parameters of tile t (tile COD over main COD).
    pub fn global(&self, t: usize) -> Global {
        self.tiles[t].header.global.or(self.main.global).expect("parse requires a main COD")
    }
    /// Component c's coding style in tile t: tile COC, then tile COD, then main COC, then main COD (A.6.1).
    pub fn style(&self, t: usize, c: usize) -> &Style {
        let tile = &self.tiles[t].header;
        tile.component_style
            .get(c as u16)
            .or(tile.style.as_ref())
            .or(self.main.component_style.get(c as u16))
            .or(self.main.style.as_ref())
            .expect("parse requires a main COD")
    }
    /// Component c's quantization in tile t: tile QCC, then tile QCD, then main QCC, then main QCD (A.6.4).
    pub fn quant(&self, t: usize, c: usize) -> &Quant {
        let tile = &self.tiles[t].header;
        tile.component_quant
            .get(c as u16)
            .or(tile.quant.as_ref())
            .or(self.main.component_quant.get(c as u16))
            .or(self.main.quant.as_ref())
            .expect("parse requires a main QCD")
    }
    /// Component c's ROI maxshift in tile t (tile RGN over main RGN), 0 without one.
    pub fn roi(&self, t: usize, c: usize) -> u8 {
        let c = c as u16;
        self.tiles[t].header.roi.get(c).or(self.main.roi.get(c)).copied().unwrap_or(0)
    }
    /// The progression changes of tile t: the tile's POC segments, else the main header's.
    pub fn changes(&self, t: usize) -> &[Change] {
        let tile = &self.tiles[t].header.changes;
        if tile.is_empty() { &self.main.changes } else { tile }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A writer of marker segments for hand-built codestreams.
    pub struct Writer(pub Vec<u8>);
    impl Writer {
        pub fn marker(&mut self, m: u16) -> &mut Self {
            self.0.extend_from_slice(&m.to_be_bytes());
            self
        }
        pub fn segment(&mut self, m: u16, body: &[u8]) -> &mut Self {
            self.marker(m);
            self.0.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
            self.0.extend_from_slice(body);
            self
        }
    }
    pub fn siz(w: u32, h: u32, tw: u32, th: u32, comps: &[(u8, bool, u8, u8)]) -> Vec<u8> {
        let mut b = vec![0, 0];
        for v in [w, h, 0, 0, tw, th, 0, 0] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        b.extend_from_slice(&(comps.len() as u16).to_be_bytes());
        for &(p, s, dx, dy) in comps {
            b.extend_from_slice(&[(p - 1) | if s { 0x80 } else { 0 }, dx, dy]);
        }
        b
    }
    pub fn cod(order: u8, layers: u16, mct: u8, levels: u8, reversible: bool, precincts: Option<&[u8]>) -> Vec<u8> {
        let mut b = vec![if precincts.is_some() { 1 } else { 0 }, order];
        b.extend_from_slice(&layers.to_be_bytes());
        b.extend_from_slice(&[mct, levels, 4, 4, 0, reversible as u8]);
        if let Some(p) = precincts {
            b.extend_from_slice(p);
        }
        b
    }
    fn minimal(tile_parts: &[(u16, u8, &[u8])]) -> Vec<u8> {
        let mut w = Writer(Vec::new());
        w.marker(SOC)
            .segment(SIZ, &siz(16, 16, 8, 16, &[(8, false, 1, 1)]))
            .segment(COD, &cod(0, 1, 0, 1, true, None))
            .segment(QCD, &[0x40, 8 << 3, 9 << 3, 9 << 3, 10 << 3]);
        for &(t, i, payload) in tile_parts {
            let at = w.0.len();
            w.segment(SOT, &[0; 8]).marker(SOD);
            w.0.extend_from_slice(payload);
            let length = (w.0.len() - at) as u32;
            w.0[at + 4..at + 6].copy_from_slice(&t.to_be_bytes());
            w.0[at + 6..at + 10].copy_from_slice(&length.to_be_bytes());
            w.0[at + 10] = i;
        }
        w.marker(EOC);
        w.0
    }

    #[test]
    fn main_header_and_tile_parts() {
        let data = minimal(&[(0, 0, &[1, 2, 3]), (1, 0, &[4]), (0, 1, &[5, 6])]);
        let cs = parse(&data).unwrap();
        assert!(!cs.truncated);
        assert_eq!(cs.size.tile_count(), 2);
        assert_eq!(cs.size.tile(1), Rect { x0: 8, y0: 0, x1: 16, y1: 16 });
        assert_eq!(cs.tiles[0].parts.len(), 2);
        assert_eq!(&data[cs.tiles[0].parts[0].data.clone()], &[1, 2, 3]);
        assert_eq!(&data[cs.tiles[0].parts[1].data.clone()], &[5, 6]);
        assert_eq!(&data[cs.tiles[1].parts[0].data.clone()], &[4]);
        let style = cs.style(0, 0);
        assert_eq!((style.levels, style.block_width, style.reversible), (1, 6, true));
        assert_eq!(style.precincts, vec![(15, 15), (15, 15)]);
        let q = cs.quant(0, 0);
        assert_eq!((q.style, q.guard, q.steps.len()), (Quantization::None, 2, 4));
        assert_eq!(q.step(3, 1, 1).unwrap(), (10, 0));
    }

    /// 0xFF30 to 0xFF3F are markers with no length or parameters (A.1): test codestream p0_02 of T.803 holds one.
    #[test]
    fn markers_without_a_segment_are_stepped_over() {
        let mut w = Writer(Vec::new());
        w.marker(SOC)
            .segment(SIZ, &siz(8, 8, 8, 8, &[(8, false, 1, 1)]))
            .marker(0xff30)
            .segment(COD, &cod(0, 1, 0, 0, true, None))
            .segment(QCD, &[0x40, 8 << 3])
            .marker(0xff3f);
        let at = w.0.len();
        w.segment(SOT, &[0; 8]).marker(0xff30).segment(COM, &[0, 1]).marker(0xff35).marker(SOD);
        w.0.extend_from_slice(&[7, 9]);
        let length = (w.0.len() - at) as u32;
        w.0[at + 6..at + 10].copy_from_slice(&length.to_be_bytes());
        w.marker(EOC);
        let cs = parse(&w.0).unwrap();
        assert!(!cs.truncated);
        assert_eq!(&w.0[cs.tiles[0].parts[0].data.clone()], &[7, 9]);
    }

    #[test]
    fn tile_cod_overrides_main_coc() {
        let mut w = Writer(Vec::new());
        w.marker(SOC)
            .segment(SIZ, &siz(8, 8, 8, 8, &[(8, false, 1, 1), (8, false, 1, 1)]))
            .segment(COD, &cod(0, 1, 0, 1, true, None))
            .segment(COC, &[1, 0, 3, 4, 4, 0, 1])
            .segment(QCD, &[0x21, 0x40, 0x00])
            .segment(QCC, &[1, 0x22, 0x48, 0x00]);
        let at = w.0.len();
        w.segment(SOT, &[0, 0, 0, 0, 0, 0, 0, 1]);
        w.segment(COD, &cod(2, 3, 1, 2, false, Some(&[0x77, 0x88, 0x99])));
        w.marker(SOD);
        let length = (w.0.len() - at) as u32;
        w.0[at + 6..at + 10].copy_from_slice(&length.to_be_bytes());
        w.marker(EOC);
        let cs = parse(&w.0).unwrap();
        // Tile COD beats main COC for component 1.
        assert_eq!(cs.style(0, 1).levels, 2);
        assert_eq!(cs.style(0, 1).precincts, vec![(7, 7), (8, 8), (9, 9)]);
        assert!(!cs.style(0, 0).reversible);
        let g = cs.global(0);
        assert_eq!((g.order, g.layers, g.mct), (Order::RPCL, 3, true));
        // Main QCC beats main QCD for component 1; derived steps scale with the level (E-5).
        assert_eq!(cs.quant(0, 1).steps, vec![(9, 0)]);
        assert_eq!(cs.quant(0, 0).step(7, 2, 1).unwrap(), (7, 0));
        assert_eq!(cs.quant(0, 0).guard, 1);
    }

    #[test]
    fn truncated_tile_part_keeps_what_is_there() {
        let mut data = minimal(&[(0, 0, &[1, 2, 3, 4, 5]), (1, 0, &[6])]);
        data.truncate(data.len() - 18);
        let cs = parse(&data).unwrap();
        assert!(cs.truncated);
        assert_eq!(&data[cs.tiles[0].parts[0].data.clone()], &[1, 2, 3, 4]);
        assert!(cs.tiles[1].parts.is_empty());
    }

    #[test]
    fn packed_headers_follow_tile_part_order() {
        let mut w = Writer(Vec::new());
        w.marker(SOC)
            .segment(SIZ, &siz(16, 8, 8, 8, &[(8, false, 1, 1)]))
            .segment(COD, &cod(0, 1, 0, 0, true, None))
            .segment(QCD, &[0x40, 8 << 3])
            // Zppm 1 before Zppm 0 in the stream: the index orders them.
            .segment(PPM, &[1, 0, 0, 0, 1, 0xcc])
            .segment(PPM, &[0, 0, 0, 0, 2, 0xaa, 0xbb]);
        for t in [1u16, 0] {
            let at = w.0.len();
            w.segment(SOT, &[0; 8]).marker(SOD);
            let length = (w.0.len() - at) as u32;
            w.0[at + 4..at + 6].copy_from_slice(&t.to_be_bytes());
            w.0[at + 6..at + 10].copy_from_slice(&length.to_be_bytes());
        }
        w.marker(EOC);
        let cs = parse(&w.0).unwrap();
        assert_eq!(cs.tiles[1].packed.as_deref(), Some(&[0xaa, 0xbb][..]));
        assert_eq!(cs.tiles[0].packed.as_deref(), Some(&[0xcc][..]));
    }

    #[test]
    fn refusals() {
        // HT block coding (Part 15) and Part 2 kernels are not Part 1.
        let mut ht = cod(0, 1, 0, 1, true, None);
        ht[8] = 0x40;
        let mut w = Writer(Vec::new());
        w.marker(SOC).segment(SIZ, &siz(8, 8, 8, 8, &[(8, false, 1, 1)])).segment(COD, &ht);
        assert_eq!(parse(&w.0).unwrap_err(), Error::Unsupported);
        let mut w = Writer(Vec::new());
        w.marker(SOC).segment(SIZ, &siz(8, 8, 8, 8, &[(8, false, 1, 1)])).segment(0xff74, &[0, 0]);
        assert_eq!(parse(&w.0).unwrap_err(), Error::Unsupported);
        // A tile offset past the image origin breaks Equation B-3.
        let mut bad = siz(8, 8, 8, 8, &[(8, false, 1, 1)]);
        bad[30..34].copy_from_slice(&5u32.to_be_bytes());
        let mut w = Writer(Vec::new());
        w.marker(SOC).segment(SIZ, &bad);
        assert_eq!(parse(&w.0).unwrap_err(), Error::Invalid);
        // No COD or QCD in the main header.
        let mut w = Writer(Vec::new());
        w.marker(SOC).segment(SIZ, &siz(8, 8, 8, 8, &[(8, false, 1, 1)])).segment(SOT, &[0; 8]);
        assert_eq!(parse(&w.0).unwrap_err(), Error::Invalid);
        // Not a codestream.
        assert_eq!(parse(&[0xff, 0xd8]).unwrap_err(), Error::Invalid);
        assert_eq!(parse(&[0xff]).unwrap_err(), Error::Truncated);
    }

    #[test]
    fn poc_entries() {
        let mut h = Header::default();
        parse_poc(&[0, 0, 0, 2, 1, 3, 2, 1, 1, 0, 3, 6, 0, 4], &mut h, 3).unwrap();
        assert_eq!(h.changes.len(), 2);
        assert_eq!(h.changes[0], Change { rs: 0, cs: 0, le: 2, re: 1, ce: 3, order: Order::RPCL });
        // CEpoc 0 with one-byte indices is 256, clipped to the component count.
        assert_eq!(h.changes[1].ce, 3);
        assert_eq!(h.changes[1].order, Order::CPRL);
        assert!(parse_poc(&[0, 0, 0, 2, 0, 3, 2], &mut h, 3).is_err());
    }
}
