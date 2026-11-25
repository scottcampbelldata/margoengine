// A uniform-grid neighbour search (K04 of docs/physics-solvers.md): one structure for SPH, position based fluids, MPM, granular
// material and cloth self-contact. Points are binned by the cell they lie in with a counting sort (so no hash table and no
// allocation order decides anything), and a query visits the cells around a point in a fixed order, the points of a cell in id
// order: the sequence of candidates is a function of the positions alone, whatever thread builds or asks. The method is the
// grid of R. Hockney and J. Eastwood, "Computer Simulation Using Particles", McGraw-Hill 1981, chapter 8 (the linked cell
// list), with the counting sort of S. Green, "Particle Simulation using CUDA", NVIDIA 2010, as a description of binning by sort.
use alloc::vec::Vec;

/// Most cells a grid may have: a point set whose bounds, at the cell size asked for, would need more is refused instead of
/// allocating without bound.
pub const MAX_CELLS: u64 = 1 << 26;

/// Why a grid was not built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GridError {
    /// A cell size that is not a finite number above 0, or a point that is not finite.
    NotFinite,
    /// More than `MAX_CELLS` cells at this cell size: ask for larger cells or fewer, closer points.
    TooManyCells,
}

/// The cells of a point set and the points in each.
#[derive(Default, Clone)]
pub struct NeighbourGrid {
    cell: f32,
    origin: [f32; 3],
    dims: [u32; 3],
    /// `ids[start[c]..start[c + 1]]` are the points of cell `c`, ascending.
    start: Vec<u32>,
    ids: Vec<u32>,
}

/// floor(x) as an integer, from integer conversion alone (the crate has no `floor`); saturating for huge x.
#[inline]
fn floor_i64(x: f32) -> i64 {
    let t = x as i64;
    if (t as f32) > x { t - 1 } else { t }
}

impl NeighbourGrid {
    /// Bins `points` into cells of side `cell`. The cell of a point is `floor((p - lowest) / cell)` on each axis.
    pub fn build(&mut self, points: &[[f32; 3]], cell: f32) -> Result<(), GridError> {
        if !(cell.is_finite() && cell > 0.0) || points.iter().any(|p| p.iter().any(|x| !x.is_finite())) {
            return Err(GridError::NotFinite);
        }
        let (mut low, mut high) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for p in points {
            for k in 0..3 {
                low[k] = low[k].min(p[k]);
                high[k] = high[k].max(p[k]);
            }
        }
        if points.is_empty() {
            low = [0.0; 3];
            high = [0.0; 3];
        }
        let mut dims = [1u32; 3];
        let mut total: u64 = 1;
        for k in 0..3 {
            let span = floor_i64((high[k] - low[k]) / cell);
            if !(span < MAX_CELLS as i64) {
                return Err(GridError::TooManyCells);
            }
            dims[k] = span as u32 + 1;
            total *= dims[k] as u64;
            if total > MAX_CELLS {
                return Err(GridError::TooManyCells);
            }
        }
        self.cell = cell;
        self.origin = low;
        self.dims = dims;
        let cells = total as usize;
        self.start.clear();
        self.start.resize(cells + 1, 0);
        for p in points {
            let c = self.cell_of(*p);
            self.start[c + 1] += 1;
        }
        for c in 0..cells {
            self.start[c + 1] += self.start[c];
        }
        // Points go to their cell in id order, so each cell's list is ascending.
        let mut next = self.start.clone();
        self.ids.clear();
        self.ids.resize(points.len(), 0);
        for (id, p) in points.iter().enumerate() {
            let c = self.cell_of(*p);
            self.ids[next[c] as usize] = id as u32;
            next[c] += 1;
        }
        Ok(())
    }

    fn coords(&self, p: [f32; 3]) -> [i64; 3] {
        let mut out = [0i64; 3];
        for k in 0..3 {
            out[k] = floor_i64((p[k] - self.origin[k]) / self.cell);
        }
        out
    }

    fn cell_of(&self, p: [f32; 3]) -> usize {
        let c = self.coords(p);
        let at = |k: usize| c[k].clamp(0, self.dims[k] as i64 - 1) as usize;
        at(0) + self.dims[0] as usize * (at(1) + self.dims[1] as usize * at(2))
    }

    /// Calls `visit` with the id of every point in the cells within `reach` cells of the cell of `p` (1 for points no farther
    /// than the cell size), in a fixed order: cells by z, then y, then x, the points of a cell by id. The candidates include
    /// points beyond the radius the caller wants; the caller checks the distance.
    pub fn candidates(&self, p: [f32; 3], reach: u32, mut visit: impl FnMut(u32)) {
        if self.ids.is_empty() {
            return;
        }
        let c = self.coords(p);
        let r = reach as i64;
        let range = |k: usize| ((c[k] - r).max(0), (c[k] + r).min(self.dims[k] as i64 - 1));
        let ((x0, x1), (y0, y1), (z0, z1)) = (range(0), range(1), range(2));
        for z in z0..=z1 {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let cell = x as usize + self.dims[0] as usize * (y as usize + self.dims[1] as usize * z as usize);
                    for &id in &self.ids[self.start[cell] as usize..self.start[cell + 1] as usize] {
                        visit(id);
                    }
                }
            }
        }
    }

    /// The cells along each axis and the points binned.
    pub fn dims(&self) -> [u32; 3] {
        self.dims
    }
    pub fn len(&self) -> usize {
        self.ids.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}
