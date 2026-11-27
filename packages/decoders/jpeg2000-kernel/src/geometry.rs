//! The canvas geometry of T.800 Annex B: tiles (B.3), tile-components (B.3), resolutions (B.5), sub-bands (B.5),
//! precincts (B.6) and code-blocks (B.7), all on the reference grid with ceiling divisions.

/// A rectangle [x0, x1) x [y0, y1) on some grid.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Rect {
    pub fn width(&self) -> u32 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> u32 {
        self.y1 - self.y0
    }
    pub fn is_empty(&self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }
    pub fn area(&self) -> u64 {
        if self.is_empty() { 0 } else { self.width() as u64 * self.height() as u64 }
    }
    /// The intersection, empty (x0 = x1 or y0 = y1) when they do not meet.
    pub fn intersect(&self, other: &Rect) -> Rect {
        let x0 = self.x0.max(other.x0);
        let y0 = self.y0.max(other.y0);
        Rect { x0, y0, x1: self.x1.min(other.x1).max(x0), y1: self.y1.min(other.y1).max(y0) }
    }
}

/// ceil(a / b) for a >= 0, b > 0.
pub fn ceil_div(a: u64, b: u64) -> u64 {
    a.div_ceil(b)
}

/// ceil(a / 2^s) for a signed numerator, as B.5 needs when a band offset passes the origin.
fn ceil_shift(a: i64, s: u32) -> i64 {
    if s == 0 {
        return a;
    }
    let d = 1i64 << s;
    // Euclidean floor of (a + d - 1) / d is the ceiling for any sign.
    (a + d - 1).div_euclid(d)
}

/// The sub-bands of B.5: LL, HL (horizontally high pass), LH (vertically high pass), HH.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Band {
    LL = 0,
    HL = 1,
    LH = 2,
    HH = 3,
}

impl Band {
    /// (xob, yob) of Equation B-15.
    pub fn offsets(self) -> (u32, u32) {
        match self {
            Band::LL => (0, 0),
            Band::HL => (1, 0),
            Band::LH => (0, 1),
            Band::HH => (1, 1),
        }
    }
    /// The base-2 logarithm of the band's nominal gain (Table E.1): 0, 1, 1, 2.
    pub fn log_gain(self) -> u32 {
        match self {
            Band::LL => 0,
            Band::HL | Band::LH => 1,
            Band::HH => 2,
        }
    }
    /// The bands of resolution r: LL alone at r = 0, then HL, LH, HH (the order of B.9 and B.10.8).
    pub fn of_resolution(r: u32) -> &'static [Band] {
        if r == 0 { &[Band::LL] } else { &[Band::HL, Band::LH, Band::HH] }
    }
}

/// The tile-component rectangle (Equation B-12): the tile's rectangle divided, rounding up, by the sub-sampling.
pub fn tile_component(tile: &Rect, dx: u32, dy: u32) -> Rect {
    Rect {
        x0: ceil_div(tile.x0 as u64, dx as u64) as u32,
        y0: ceil_div(tile.y0 as u64, dy as u64) as u32,
        x1: ceil_div(tile.x1 as u64, dx as u64) as u32,
        y1: ceil_div(tile.y1 as u64, dy as u64) as u32,
    }
}

/// Resolution r of a tile-component with `levels` decomposition levels (Equation B-14).
pub fn resolution(component: &Rect, levels: u32, r: u32) -> Rect {
    let s = levels - r;
    let f = |v: u32| ceil_shift(v as i64, s) as u32;
    Rect { x0: f(component.x0), y0: f(component.y0), x1: f(component.x1), y1: f(component.y1) }
}

/// The decomposition level nb of a band of resolution r (B.5): NL for the LL band of resolution 0, NL - r + 1 else.
pub fn band_level(levels: u32, r: u32) -> u32 {
    if r == 0 { levels } else { levels - r + 1 }
}

/// Sub-band `band` of resolution r (Equation B-15).
pub fn band(component: &Rect, levels: u32, r: u32, band: Band) -> Rect {
    let nb = band_level(levels, r);
    if nb == 0 {
        return *component;
    }
    let (xob, yob) = band.offsets();
    let half = 1i64 << (nb - 1);
    let fx = |v: u32| ceil_shift(v as i64 - half * xob as i64, nb).max(0) as u32;
    let fy = |v: u32| ceil_shift(v as i64 - half * yob as i64, nb).max(0) as u32;
    Rect { x0: fx(component.x0), y0: fy(component.y0), x1: fx(component.x1), y1: fy(component.y1) }
}

/// The precinct grid of a resolution (Equation B-16): columns and rows of 2^ppx by 2^ppy precincts anchored at the
/// origin, (0, 0) when the resolution is empty.
pub fn precinct_count(res: &Rect, ppx: u32, ppy: u32) -> (u32, u32) {
    if res.is_empty() {
        return (0, 0);
    }
    let across = ceil_div(res.x1 as u64, 1 << ppx) - (res.x0 as u64 >> ppx);
    let down = ceil_div(res.y1 as u64, 1 << ppy) - (res.y0 as u64 >> ppy);
    (across as u32, down as u32)
}

/// The code-block size exponents in a resolution (Equation B-17): never larger than the precinct, which in the bands of
/// a resolution above 0 is half the resolution's precinct.
pub fn block_exponents(xcb: u32, ycb: u32, ppx: u32, ppy: u32, r: u32) -> (u32, u32) {
    if r == 0 { (xcb.min(ppx), ycb.min(ppy)) } else { (xcb.min(ppx - 1), ycb.min(ppy - 1)) }
}

/// The rectangle of precinct `index` (raster order) of a resolution, mapped into one of its bands: the band region the
/// precinct covers, clipped to the band.
pub fn precinct_in_band(res: &Rect, band_rect: &Rect, ppx: u32, ppy: u32, r: u32, index: u32) -> Rect {
    let (across, _) = precinct_count(res, ppx, ppy);
    let px = (res.x0 >> ppx) + index % across;
    let py = (res.y0 >> ppy) + index / across;
    // In a band of resolution r > 0 the precinct spans half as many samples (B.6).
    let (sx, sy) = if r == 0 { (ppx, ppy) } else { (ppx - 1, ppy - 1) };
    let x0 = (px as u64) << sx;
    let y0 = (py as u64) << sy;
    let clip = |v: u64| v.min(u32::MAX as u64) as u32;
    Rect { x0: clip(x0), y0: clip(y0), x1: clip(x0 + (1 << sx)), y1: clip(y0 + (1 << sy)) }.intersect(band_rect)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_of_an_odd_offset_tile_component() {
        // A component from x = 3 to 10 at one level: L samples at even positions 4, 6, 8 (3 of them), H at 3, 5, 7, 9.
        let c = Rect { x0: 3, y0: 0, x1: 10, y1: 1 };
        let ll = band(&c, 1, 0, Band::LL);
        let hl = band(&c, 1, 1, Band::HL);
        assert_eq!((ll.x0, ll.x1), (2, 5));
        assert_eq!((hl.x0, hl.x1), (1, 5));
        assert_eq!(ll.width() + hl.width(), c.width());
        assert_eq!(resolution(&c, 1, 0), Rect { x0: 2, y0: 0, x1: 5, y1: 1 });
    }

    #[test]
    fn band_offsets_below_the_origin_clip_to_zero() {
        let c = Rect { x0: 0, y0: 0, x1: 1, y1: 1 };
        let hh = band(&c, 1, 1, Band::HH);
        assert!(hh.is_empty());
        assert_eq!(band(&c, 1, 0, Band::LL), Rect { x0: 0, y0: 0, x1: 1, y1: 1 });
    }

    #[test]
    fn precincts_and_blocks() {
        let res = Rect { x0: 5, y0: 0, x1: 70, y1: 33 };
        assert_eq!(precinct_count(&res, 5, 5), (3, 2));
        assert_eq!(precinct_count(&Rect { x0: 4, y0: 4, x1: 4, y1: 9 }, 5, 5), (0, 0));
        assert_eq!(block_exponents(6, 6, 15, 15, 1), (6, 6));
        assert_eq!(block_exponents(6, 6, 5, 4, 1), (4, 3));
        assert_eq!(block_exponents(6, 6, 5, 4, 0), (5, 4));
        // Precinct 1 of resolution 1 (2^5 wide) covers band x 16 to 32.
        let b = Rect { x0: 2, y0: 0, x1: 35, y1: 17 };
        assert_eq!(precinct_in_band(&res, &b, 5, 5, 1, 1), Rect { x0: 16, y0: 0, x1: 32, y1: 16 });
        assert_eq!(precinct_in_band(&res, &b, 5, 5, 1, 0), Rect { x0: 2, y0: 0, x1: 16, y1: 16 });
    }
}
