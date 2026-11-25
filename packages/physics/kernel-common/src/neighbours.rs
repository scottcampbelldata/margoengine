// A uniform-grid neighbour search (K04 of docs/physics-solvers.md): one structure for SPH, position based fluids, MPM, granular
// material and cloth self-contact. Points are binned by the cell they lie in with a counting sort (so no hash table and no
// allocation order decides anything), and a query visits the cells around a point in a fixed order, the points of a cell in id
// order: the sequence of candidates is a function of the positions alone, whatever thread builds or asks. The method is the
// grid of R. Hockney and J. Eastwood, "Computer Simulation Using Particles", McGraw-Hill 1981, chapter 8 (the linked cell
// list), with the counting sort of S. Green, "Particle Simulation using CUDA", NVIDIA 2010, as a description of binning by sort.
//
// Two storages hold the same grid and give the same candidates in the same order. Dense storage keeps one counter per cell of the
// points' bounding box. Sparse storage keeps only the cells that hold a point: the occupied cells' keys, sorted, and a lookup by
// binary search (the compact, sorted-cell layout of M. Ihmsen, N. Akinci, M. Becker and M. Teschner, "A parallel SPH
// implementation on multi-core CPUs", Computer Graphics Forum 30(1), 2011, without their hash table, so there are no collisions
// and no table whose layout could depend on insertion order). A key is the cell's three coordinates, 32 bits each, z most
// significant, so sorted keys are exactly the order a query visits cells in.
use alloc::vec::Vec;

/// Most cells a dense grid may have: a point set whose bounds, at the cell size asked for, would need more is stored sparsely
/// instead of allocating without bound.
pub const MAX_CELLS: u64 = 1 << 26;

/// Most cells along one axis: a grid counts its cells along an axis in 32 bits, and a sparse key holds each coordinate in
/// 32. No f32 point set comes near it at a cell its points can tell apart (an f32 has 24 bits of mantissa), so it refuses only
/// a cell far smaller than the spacing of the coordinates it bins.
pub const MAX_SPAN: i64 = u32::MAX as i64;

/// How a grid stores its cells. Both keep the 4-byte id of every point. Dense adds a 4-byte counter per cell of the bounding box;
/// sparse adds at most a 16-byte key and a 4-byte start per occupied cell, so at most 20 bytes per point. `Auto` picks dense when
/// its counters are the smaller cost, `4 * cells <= 20 * n`, that is `cells <= 5 * n`, and always sparse above `MAX_CELLS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Storage {
    #[default]
    Auto,
    Dense,
    Sparse,
}

/// Why a grid was not built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GridError {
    /// A cell size that is not a finite number above 0, or a point that is not finite.
    NotFinite,
    /// A span of more than `MAX_SPAN` cells along an axis, or a dense grid of more than `MAX_CELLS` cells was asked for: ask for
    /// larger cells or closer points.
    TooManyCells,
}

/// The cells of a point set and the points in each.
#[derive(Default, Clone)]
pub struct NeighbourGrid {
    cell: f32,
    origin: [f32; 3],
    dims: [u32; 3],
    /// `ids[start[c]..start[c + 1]]` are the points of cell `c`, ascending. In sparse storage `c` indexes `keys`.
    start: Vec<u32>,
    ids: Vec<u32>,
    /// Sparse storage only: the keys of the occupied cells, ascending (empty for dense storage).
    keys: Vec<u128>,
    sparse: bool,
    /// Build scratch of sparse storage: the (key, id) pairs and the sort's spare.
    scratch: Vec<(u128, u32)>,
    spare: Vec<(u128, u32)>,
}

/// floor(x) as an integer, from integer conversion alone (the crate has no `floor`); saturating for huge x.
#[inline]
fn floor_i64(x: f32) -> i64 {
    let t = x as i64;
    if (t as f32) > x { t - 1 } else { t }
}

impl NeighbourGrid {
    /// Bins `points` into cells of side `cell`, in the storage `Auto` picks. The cell of a point is `floor((p - lowest) / cell)`
    /// on each axis.
    pub fn build(&mut self, points: &[[f32; 3]], cell: f32) -> Result<(), GridError> {
        self.build_with(points, cell, Storage::Auto)
    }

    /// As `build`, in the storage asked for. Dense storage of more than `MAX_CELLS` cells is refused with `TooManyCells`.
    pub fn build_with(&mut self, points: &[[f32; 3]], cell: f32, storage: Storage) -> Result<(), GridError> {
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
        let mut total: u128 = 1;
        for k in 0..3 {
            let span = floor_i64((high[k] - low[k]) / cell);
            if !(span < MAX_SPAN) {
                return Err(GridError::TooManyCells);
            }
            dims[k] = span as u32 + 1;
            total *= dims[k] as u128;
        }
        let sparse = match storage {
            Storage::Dense => false,
            Storage::Sparse => true,
            Storage::Auto => total > MAX_CELLS as u128 || total > 5 * points.len() as u128,
        };
        if !sparse && total > MAX_CELLS as u128 {
            return Err(GridError::TooManyCells);
        }
        self.cell = cell;
        self.origin = low;
        self.dims = dims;
        self.sparse = sparse;
        if sparse {
            self.build_sparse(points);
            return Ok(());
        }
        self.keys.clear();
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

    /// Sparse storage: the points sorted by (cell key, id) with a stable least-significant-digit radix sort, then the runs of equal
    /// keys cut into cells. Integer work only; ids ascend inside a cell because the sort is stable over ids already in order.
    fn build_sparse(&mut self, points: &[[f32; 3]]) {
        self.scratch.clear();
        for (id, p) in points.iter().enumerate() {
            self.scratch.push((self.key_of(self.cell_coords(*p)), id as u32));
        }
        let (items, spare) = (&mut self.scratch, &mut self.spare);
        spare.clear();
        spare.resize(items.len(), (0, 0));
        // Twelve byte passes over the 96-bit key; a pass whose byte is the same everywhere is skipped.
        for byte in 0..12 {
            let shift = byte * 8;
            let mut count = [0u32; 256];
            for &(k, _) in items.iter() {
                count[(k >> shift) as usize & 255] += 1;
            }
            if count.iter().any(|&n| n as usize == items.len()) {
                continue;
            }
            let mut at = 0u32;
            for n in count.iter_mut() {
                let here = *n;
                *n = at;
                at += here;
            }
            for &x in items.iter() {
                let d = (x.0 >> shift) as usize & 255;
                spare[count[d] as usize] = x;
                count[d] += 1;
            }
            core::mem::swap(items, spare);
        }
        self.keys.clear();
        self.start.clear();
        self.ids.clear();
        for (n, &(key, id)) in self.scratch.iter().enumerate() {
            if self.keys.last() != Some(&key) {
                self.keys.push(key);
                self.start.push(n as u32);
            }
            self.ids.push(id);
        }
        self.start.push(self.ids.len() as u32);
    }

    /// The cell coordinates of `p` inside the point bounds (a point of the set always is).
    fn cell_coords(&self, p: [f32; 3]) -> [i64; 3] {
        let c = self.coords(p);
        [0, 1, 2].map(|k| c[k].clamp(0, self.dims[k] as i64 - 1))
    }

    fn key_of(&self, c: [i64; 3]) -> u128 {
        (c[2] as u128) << 64 | (c[1] as u128) << 32 | c[0] as u128
    }

    /// The range of ids stored for the cell `(x, y, z)`, empty when no point is in it.
    fn cell_ids(&self, x: i64, y: i64, z: i64) -> &[u32] {
        let cell = if self.sparse {
            let key = self.key_of([x, y, z]);
            let at = self.keys.partition_point(|&k| k < key);
            if self.keys.get(at) != Some(&key) {
                return &[];
            }
            at
        } else {
            x as usize + self.dims[0] as usize * (y as usize + self.dims[1] as usize * z as usize)
        };
        &self.ids[self.start[cell] as usize..self.start[cell + 1] as usize]
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
                    for &id in self.cell_ids(x, y, z) {
                        visit(id);
                    }
                }
            }
        }
    }

    /// Whether the cells are stored sparsely.
    pub fn is_sparse(&self) -> bool {
        self.sparse
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
