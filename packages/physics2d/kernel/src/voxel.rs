// A grid of solid cells that answers scene queries by cell lookup. The shape that carries it takes part in no contact (the
// grid's outlines, chains, do the colliding, and merge cells so a body slides over seams); queries meet the cells
// themselves: a point is inside when its cell is filled, a ray walks the cells in turn (Amanatides and Woo, "A Fast Voxel
// Traversal Algorithm for Ray Tracing", Eurographics 1987), and a shape meets each filled cell its box reaches as a box.
use alloc::vec::Vec;

use crate::math::{V2, v2};
use crate::shape::Core;

/// The greatest whole number not above `x` (no `floor` without std).
fn floor(x: f32) -> i64 {
    let t = x as i64;
    if (t as f32) > x { t - 1 } else { t }
}

/// Filled cells of a `cols` by `rows` grid whose top left corner is `origin` (in the body's frame); cell (c, r) spans
/// `origin + (c, r) * cell` to `origin + (c + 1, r + 1) * cell`, rows growing along y.
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub cols: u32,
    pub rows: u32,
    pub cell: V2,
    pub origin: V2,
    solid: Vec<u8>,
}

impl Grid {
    /// `bits` holds one bit a cell, row by row, 32 to a word, lowest bit first. Refused: no cells, a cell size that is
    /// not above 0 and finite, or too few bits.
    pub fn new(cols: u32, rows: u32, cell: V2, origin: V2, bits: &[u32]) -> Option<Grid> {
        let cells = (cols as usize).checked_mul(rows as usize)?;
        if cols == 0 || rows == 0 || !(cell.x > 0.0 && cell.y > 0.0 && cell.x.is_finite() && cell.y.is_finite()) || !origin.x.is_finite() || !origin.y.is_finite() || bits.len() < cells.div_ceil(32) {
            return None;
        }
        let solid = (0..cells).map(|i| ((bits[i / 32] >> (i % 32)) & 1) as u8).collect();
        Some(Grid { cols, rows, cell, origin, solid })
    }

    pub fn bits(&self) -> Vec<u32> {
        let mut words = alloc::vec![0u32; self.solid.len().div_ceil(32)];
        for (i, &s) in self.solid.iter().enumerate() {
            words[i / 32] |= (s as u32) << (i % 32);
        }
        words
    }

    #[inline]
    fn filled(&self, c: i64, r: i64) -> bool {
        c >= 0 && r >= 0 && c < self.cols as i64 && r < self.rows as i64 && self.solid[r as usize * self.cols as usize + c as usize] != 0
    }

    pub fn any(&self) -> bool {
        self.solid.iter().any(|&s| s != 0)
    }

    /// The box around the whole grid, as a core, for the broad phase.
    pub fn bounds_core(&self) -> Core {
        let (w, h) = (self.cols as f32 * self.cell.x, self.rows as f32 * self.cell.y);
        let centre = v2(self.origin.x + 0.5 * w, self.origin.y + 0.5 * h);
        Core::rect(0.5 * w, 0.5 * h, centre, 1.0, 0.0, 0.0).unwrap_or_else(|_| Core::circle(centre, 0.0).unwrap())
    }

    fn cell_of(&self, p: V2) -> (i64, i64) {
        (floor(((p.x - self.origin.x) / self.cell.x).clamp(-1.0e9, 1.0e9)), floor(((p.y - self.origin.y) / self.cell.y).clamp(-1.0e9, 1.0e9)))
    }

    /// Whether `local` (the body's frame) lies in a filled cell.
    pub fn contains(&self, local: V2) -> bool {
        let (c, r) = self.cell_of(local);
        self.filled(c, r)
    }

    /// The box of cell (c, r) as a core.
    pub fn cell_core(&self, c: i64, r: i64) -> Core {
        let centre = v2(self.origin.x + (c as f32 + 0.5) * self.cell.x, self.origin.y + (r as f32 + 0.5) * self.cell.y);
        Core::rect(0.5 * self.cell.x, 0.5 * self.cell.y, centre, 1.0, 0.0, 0.0).unwrap_or_else(|_| Core::circle(centre, 0.0).unwrap())
    }

    /// The filled cells whose box meets `lo..hi` (the body's frame), as (column, row).
    pub fn cells_in(&self, lo: V2, hi: V2) -> Vec<(i64, i64)> {
        let (c0, r0) = self.cell_of(lo);
        let (c1, r1) = self.cell_of(hi);
        let mut out = Vec::new();
        for r in r0.max(0)..=r1.min(self.rows as i64 - 1) {
            for c in c0.max(0)..=c1.min(self.cols as i64 - 1) {
                if self.filled(c, r) {
                    out.push((c, r));
                }
            }
        }
        out
    }

    /// Every filled cell.
    pub fn filled_cells(&self) -> Vec<(i64, i64)> {
        self.cells_in(self.origin, v2(self.origin.x + self.cols as f32 * self.cell.x, self.origin.y + self.rows as f32 * self.cell.y))
    }

    /// The first entry of the ray `o + t d` (unit `d`, the body's frame) into a filled cell within `max`, or, from inside
    /// and not `solid`, its exit from the filled cells it starts in. The normal points against the ray.
    pub fn ray(&self, o: V2, d: V2, max: f32, solid: bool) -> Option<(f32, V2)> {
        let (c0, r0) = self.cell_of(o);
        let inside = self.filled(c0, r0);
        if inside && solid {
            return Some((0.0, d.neg()));
        }
        // Where the ray is within the grid's box, and the face it enters by.
        let (w, h) = (self.cols as f32 * self.cell.x, self.rows as f32 * self.cell.y);
        let (mut t_in, mut t_out) = (0.0f32, max);
        let mut entry = v2(0.0, 0.0);
        for (axis, p, v, lo, hi) in [(0, o.x, d.x, self.origin.x, self.origin.x + w), (1, o.y, d.y, self.origin.y, self.origin.y + h)] {
            if v == 0.0 {
                if p < lo || p > hi {
                    return None;
                }
                continue;
            }
            let (a, b) = ((lo - p) / v, (hi - p) / v);
            let near = a.min(b);
            if near > t_in {
                t_in = near;
                let n = -v.signum();
                entry = if axis == 0 { v2(n, 0.0) } else { v2(0.0, n) };
            }
            t_out = t_out.min(a.max(b));
        }
        if t_in > t_out {
            return None;
        }
        let start = o.add(d.scale(t_in));
        let (mut c, mut r) = self.cell_of(start);
        c = c.clamp(0, self.cols as i64 - 1);
        r = r.clamp(0, self.rows as i64 - 1);
        // From outside, the first filled cell is the hit; from inside (not solid), the first empty cell is the exit.
        if !inside && self.filled(c, r) {
            return Some((t_in, entry));
        }
        let step = (if d.x > 0.0 { 1i64 } else { -1 }, if d.y > 0.0 { 1i64 } else { -1 });
        let boundary = |index: i64, s: i64, base: f32, size: f32| base + (index + (s > 0) as i64) as f32 * size;
        let mut t_max = (
            if d.x == 0.0 { f32::INFINITY } else { (boundary(c, step.0, self.origin.x, self.cell.x) - o.x) / d.x },
            if d.y == 0.0 { f32::INFINITY } else { (boundary(r, step.1, self.origin.y, self.cell.y) - o.y) / d.y },
        );
        let delta = (if d.x == 0.0 { f32::INFINITY } else { self.cell.x / d.x.abs() }, if d.y == 0.0 { f32::INFINITY } else { self.cell.y / d.y.abs() });
        loop {
            let along_x = t_max.0 < t_max.1;
            let t = if along_x { t_max.0 } else { t_max.1 };
            if t > t_out {
                return None;
            }
            let crossed = if along_x { v2(-(step.0 as f32), 0.0) } else { v2(0.0, -(step.1 as f32)) };
            if along_x {
                c += step.0;
                t_max.0 += delta.0;
            } else {
                r += step.1;
                t_max.1 += delta.1;
            }
            let on_grid = c >= 0 && r >= 0 && c < self.cols as i64 && r < self.rows as i64;
            let now = on_grid && self.filled(c, r);
            if inside {
                if !now {
                    return Some((t, crossed.neg()));
                }
            } else if now {
                return Some((t, crossed));
            }
            if !on_grid {
                return None;
            }
        }
    }
}
