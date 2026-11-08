// Voxel grids. A grid is a mesh row flagged MESH_VOXELS: no vertices or triangles, a byte a cell in VOXEL_WORD rows, so
// it meets every shape a mesh meets through the mesh's pair code, and other grids too, as Rapier's voxels do (seen from
// outside: a Rapier voxel shape touches convex shapes, compounds and voxels, and falls through meshes and height fields).
//
// A filled cell is a box. Each cell that touches gets a part keyed by its index, so a box across four cells keeps four
// manifolds, as a mesh pair keeps one a triangle. What a grid adds is the seam: a box sliding over a flat run of cells can
// catch on the side face of the next cell, which is hidden inside the solid. The rule is the one the mesh path runs
// (Catto 2020, "Ghost Collisions", box2d.org, read in full): a normal must lie in the region of normals the surface
// allows. A grid's surface is its exposed faces, and the grid hands out their adjacency for free: each cell's byte says
// which of its six neighbours are filled, a coupled grid's border cells included. A normal from a cell may lean only
// toward exposed faces; one that leans toward a filled neighbour, past the same small lean the mesh rule allows, is
// snapped to the cell's exposed face it is closest to, as only that face can push there. A cell with no exposed face
// gives nothing. Two coupled grids (`combine_voxels`, `propagate_voxel`) write each other's border cells into those
// bits, so the seam between them is as smooth as the inside of one grid.
use crate::hull::{BoxData, Poly, box_poly};
use crate::layout::*;
use crate::math::*;
use crate::mesh::LEAN;
use crate::narrow::{Manifold, Round, collide_polys, collide_round_poly, face_contact};
use crate::sat::Pose;
use crate::world::World;

/// Bit 0 of a cell's byte: the cell is filled.
pub const CELL_FILLED: u32 = 1;
/// Cells one grid holds: a cell's index is a part's key and must stay below NONE.
pub const MAX_VOXEL_CELLS: u64 = 1 << 30;
/// The step to the neighbour across each face, in a box's face order.
const STEP: [[i32; 3]; 6] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/// What `end_voxels` and the edits say when they refuse.
pub const VOXELS_BAD_GRID: i32 = -1;
pub const VOXELS_NOT_VOXELS: i32 = -2;
pub const VOXELS_NO_MEMORY: i32 = -3;

/// The ghost rule on one cell: `n` the normal from the cell to the other shape in the grid's frame, `byte` the cell's.
/// None when no face of the cell is exposed; else whether the normal must be snapped, and the exposed face it is closest
/// to (in a box's face order).
pub fn voxel_verdict(n: V3, byte: u32) -> Option<(bool, usize)> {
    let along = [n.x, -n.x, n.y, -n.y, n.z, -n.z];
    let (mut face, mut best, mut snap) = (6, f32::NEG_INFINITY, false);
    for (d, &lean) in along.iter().enumerate() {
        if byte & (2 << d) == 0 {
            if lean > best {
                best = lean;
                face = d;
            }
        } else if lean > LEAN {
            snap = true;
        }
    }
    if face == 6 { None } else { Some((snap, face)) }
}

impl World {
    /// The cells along x, y and z of grid `mesh`.
    #[inline(always)]
    fn voxel_dims(&self, mesh: usize) -> [u32; 3] {
        [self.uu(VOXEL_DIM_X, mesh), self.uu(VOXEL_DIM_Y, mesh), self.uu(VOXEL_DIM_Z, mesh)]
    }

    #[inline(always)]
    fn voxel_min(&self, mesh: usize) -> [i32; 3] {
        [self.uu(VOXEL_MIN_X, mesh) as i32, self.uu(VOXEL_MIN_Y, mesh) as i32, self.uu(VOXEL_MIN_Z, mesh) as i32]
    }

    /// Whether `mesh` is a voxel grid.
    #[inline(always)]
    pub fn is_voxels(&self, mesh: usize) -> bool {
        self.uu(MESH_FLAGS, mesh) & MESH_VOXELS != 0
    }

    /// The byte of cell `index` of grid `mesh`.
    #[inline(always)]
    pub fn cell_byte(&self, mesh: usize, index: u32) -> u32 {
        let word = self.uu(VOXEL_WORD, self.uu(VOXEL_FIRST, mesh) as usize + (index >> 2) as usize);
        (word >> (8 * (index & 3))) & 0xff
    }

    #[inline(always)]
    fn set_cell_byte(&mut self, mesh: usize, index: u32, byte: u32) {
        let at = self.uu(VOXEL_FIRST, mesh) as usize + (index >> 2) as usize;
        let shift = 8 * (index & 3);
        let word = self.uu(VOXEL_WORD, at);
        self.set_u(VOXEL_WORD, at, (word & !(0xff << shift)) | (byte << shift));
    }

    /// The index of the cell at `at` (grid coordinates), or None outside the grid.
    #[inline(always)]
    fn cell_index(&self, mesh: usize, at: [i32; 3]) -> Option<u32> {
        let (min, dims) = (self.voxel_min(mesh), self.voxel_dims(mesh));
        let mut local = [0u32; 3];
        for k in 0..3 {
            let d = at[k] as i64 - min[k] as i64;
            if d < 0 || d >= dims[k] as i64 {
                return None;
            }
            local[k] = d as u32;
        }
        Some(local[0] + dims[0] * (local[1] + dims[1] * local[2]))
    }

    /// The grid coordinates of cell `index`.
    #[inline(always)]
    fn cell_at(&self, mesh: usize, index: u32) -> [i32; 3] {
        let (min, dims) = (self.voxel_min(mesh), self.voxel_dims(mesh));
        let (i, rest) = (index % dims[0], index / dims[0]);
        [min[0] + i as i32, min[1] + (rest % dims[1]) as i32, min[2] + (rest / dims[1]) as i32]
    }

    /// Makes room for one more grid of `cells` cells, zeroed. The caller then sets bit 0 of the bytes of the filled cells
    /// in VOXEL_WORD rows from `mesh_rows[4]`, cell (i, j, k) at index i + dims_x (j + dims_y k) from the corner.
    pub fn begin_voxels(&mut self, cells: u32) -> bool {
        let used = self.header().mesh_rows;
        let Some(words) = used[4].checked_add(cells.div_ceil(4)) else { return false };
        let have = mesh_capacity(&self.header().capacity);
        let room = |need: u32, have: u32| if need > have { need.max(have.saturating_mul(2)) } else { have };
        if !self.reserve_mesh([room(used[0] + 1, have[0]), have[1], have[2], have[3], room(words, have[4])]) {
            return false;
        }
        for at in used[4] as usize..words as usize {
            self.set_u(VOXEL_WORD, at, 0);
        }
        true
    }

    /// Finishes a grid written after `begin_voxels`: `dims` cells along x, y and z from the cell at `min`, each `size`.
    /// Works out every cell's neighbours. Its row, or a VOXELS_ code. Rows stay for the world's life.
    pub fn end_voxels(&mut self, min: [i32; 3], dims: [u32; 3], size: V3) -> i32 {
        let [row, vertices, triangles, nodes, first] = self.header().mesh_rows;
        let cells = dims[0] as u64 * dims[1] as u64 * dims[2] as u64;
        let have = mesh_capacity(&self.header().capacity);
        let sized = size.x > 0.0 && size.y > 0.0 && size.z > 0.0 && size.x.is_finite() && size.y.is_finite() && size.z.is_finite();
        let words = cells.div_ceil(4);
        if cells == 0 || cells > MAX_VOXEL_CELLS || !sized || row >= have[0] || first as u64 + words > have[4] as u64 {
            return VOXELS_BAD_GRID;
        }
        for k in 0..3 {
            if min[k] as i64 + dims[k] as i64 > i32::MAX as i64 {
                return VOXELS_BAD_GRID;
            }
        }
        let at = row as usize;
        for column in [MESH_FIRST_VERTEX, MESH_VERTICES, MESH_FIRST_TRIANGLE, MESH_TRIANGLES, MESH_FIRST_NODE, MESH_NODES, MESH_COLUMNS] {
            self.set_u(column, at, 0);
        }
        self.set_u(MESH_FLAGS, at, MESH_VOXELS);
        self.place_grid(at, first, min, dims);
        self.set_v(VOXEL_SIZE_X, at, size);
        for index in 0..cells as u32 {
            self.link_cell(at, index);
        }
        self.voxel_box(at);
        self.header_mut().mesh_rows = [row + 1, vertices, triangles, nodes, first + words as u32];
        row as i32
    }

    fn place_grid(&mut self, at: usize, first: u32, min: [i32; 3], dims: [u32; 3]) {
        self.set_u(VOXEL_FIRST, at, first);
        for k in 0..3 {
            self.set_u(VOXEL_DIM_X + k, at, dims[k]);
            self.set_u(VOXEL_MIN_X + k, at, min[k] as u32);
        }
    }

    /// Sets the neighbour bits of cell `index` that look inside its grid; bits across the border keep what a coupled grid
    /// wrote.
    #[inline(never)]
    fn link_cell(&mut self, mesh: usize, index: u32) {
        let at = self.cell_at(mesh, index);
        let mut byte = self.cell_byte(mesh, index);
        for (d, step) in STEP.iter().enumerate() {
            if let Some(n) = self.cell_index(mesh, [at[0] + step[0], at[1] + step[1], at[2] + step[2]]) {
                byte = if self.cell_byte(mesh, n) & CELL_FILLED != 0 { byte | (2 << d) } else { byte & !(2 << d) };
            }
        }
        self.set_cell_byte(mesh, index, byte);
    }

    /// The grid's box and radius, over all its cells.
    fn voxel_box(&mut self, mesh: usize) {
        let (min, dims, size) = (self.voxel_min(mesh), self.voxel_dims(mesh), self.v(VOXEL_SIZE_X, mesh));
        let low = v3(min[0] as f32 * size.x, min[1] as f32 * size.y, min[2] as f32 * size.z);
        let high = low.add(v3(dims[0] as f32 * size.x, dims[1] as f32 * size.y, dims[2] as f32 * size.z));
        let half = high.sub(low).scale(0.5);
        self.set_v(MESH_BOX_X, mesh, low.add(half));
        self.set_v(MESH_HALF_X, mesh, half);
        self.set_s(MESH_RADIUS, mesh, sqrt(half.dot(half)));
    }

    /// The voxel grid of a collider, or None.
    #[inline(always)]
    fn grid_of(&self, collider: u32) -> Option<usize> {
        let c = collider as usize;
        if collider >= self.header().collider_rows || self.uu(COLLIDER_SHAPE, c) != SHAPE_TRIMESH {
            return None;
        }
        let mesh = self.uu(COLLIDER_HULL, c) as usize;
        if self.is_voxels(mesh) { Some(mesh) } else { None }
    }

    /// Fills or empties the cell at `at` of a voxel collider in place: the same row, its other cells' contacts kept. A cell
    /// filled outside the grid grows it to hold the cell. The body's mass is worked out again and what touches wakes.
    /// 1, or a VOXELS_ code.
    pub fn set_voxel(&mut self, collider: u32, at: [i32; 3], filled: bool) -> i32 {
        let Some(mesh) = self.grid_of(collider) else { return VOXELS_NOT_VOXELS };
        let index = match self.cell_index(mesh, at) {
            Some(index) => index,
            None if !filled => return 1,
            None => {
                if !self.grow_grid(mesh, at) {
                    return VOXELS_NO_MEMORY;
                }
                self.mark_pending(collider);
                self.cell_index(mesh, at).unwrap_or(0)
            }
        };
        let byte = self.cell_byte(mesh, index);
        self.set_cell_byte(mesh, index, if filled { byte | CELL_FILLED } else { byte & !CELL_FILLED });
        self.link_around(mesh, at);
        self.after_edit(collider);
        1
    }

    /// Links a cell and its six neighbours inside the grid.
    fn link_around(&mut self, mesh: usize, at: [i32; 3]) {
        if let Some(index) = self.cell_index(mesh, at) {
            self.link_cell(mesh, index);
        }
        for step in STEP {
            if let Some(n) = self.cell_index(mesh, [at[0] + step[0], at[1] + step[1], at[2] + step[2]]) {
                self.link_cell(mesh, n);
            }
        }
    }

    /// After a change of cells: the body's mass again, and what touches the collider wakes.
    fn after_edit(&mut self, collider: u32) {
        let body = self.uu(COLLIDER_BODY, collider as usize);
        if self.uu(FLAGS, body as usize) & KIND == DYNAMIC {
            self.update_mass(body);
            self.wake(body);
        }
        self.wake_touching_pairs(collider);
    }

    /// Grows a grid to hold the cell at `at`: new words, the old cells copied, links across the old border made again.
    #[inline(never)]
    fn grow_grid(&mut self, mesh: usize, at: [i32; 3]) -> bool {
        let (min, dims) = (self.voxel_min(mesh), self.voxel_dims(mesh));
        let mut low = min;
        let mut new_dims = dims;
        for k in 0..3 {
            let high = (min[k] as i64 + dims[k] as i64 - 1).max(at[k] as i64);
            low[k] = min[k].min(at[k]);
            let span = high - low[k] as i64 + 1;
            if span > u32::MAX as i64 {
                return false;
            }
            new_dims[k] = span as u32;
        }
        let cells = new_dims[0] as u64 * new_dims[1] as u64 * new_dims[2] as u64;
        if cells > MAX_VOXEL_CELLS || !self.begin_voxels(cells as u32) {
            return false;
        }
        let first = self.header().mesh_rows[4];
        let (old_first, old_cells) = (self.uu(VOXEL_FIRST, mesh), dims[0] * dims[1] * dims[2]);
        self.place_grid(mesh, first, low, new_dims);
        for index in 0..old_cells {
            let word = self.uu(VOXEL_WORD, old_first as usize + (index >> 2) as usize);
            let byte = (word >> (8 * (index & 3))) & 0xff;
            let local = [index % dims[0], (index / dims[0]) % dims[1], index / (dims[0] * dims[1])];
            let place = [min[0] + local[0] as i32, min[1] + local[1] as i32, min[2] + local[2] as i32];
            if let Some(n) = self.cell_index(mesh, place) {
                self.set_cell_byte(mesh, n, byte);
            }
        }
        for index in 0..cells as u32 {
            self.link_cell(mesh, index);
        }
        self.voxel_box(mesh);
        self.header_mut().mesh_rows[4] = first + cells.div_ceil(4) as u32;
        true
    }

    /// Writes into grid `b`'s border cells which of grid `a`'s cells are filled, where `a`'s cell (i, j, k) is `b`'s
    /// (i, j, k) minus `shift`.
    fn couple(&mut self, a: usize, b: usize, shift: [i32; 3]) {
        let cells = { let d = self.voxel_dims(b); d[0] * d[1] * d[2] };
        for index in 0..cells {
            let at = self.cell_at(b, index);
            let mut byte = self.cell_byte(b, index);
            for (d, step) in STEP.iter().enumerate() {
                let n = [at[0] + step[0], at[1] + step[1], at[2] + step[2]];
                if self.cell_index(b, n).is_some() {
                    continue;
                }
                if let Some(other) = self.cell_index(a, [n[0] + shift[0], n[1] + shift[1], n[2] + shift[2]]) {
                    byte = if self.cell_byte(a, other) & CELL_FILLED != 0 { byte | (2 << d) } else { byte & !(2 << d) };
                }
            }
            self.set_cell_byte(b, index, byte);
        }
    }

    /// Makes two voxel colliders see each other's cells along their border, `b`'s cell (0, 0, 0) at `a`'s `shift`, so a
    /// body crosses the seam as it crosses the inside of one grid (Rapier's `combineVoxelStates`). 1, or a VOXELS_ code.
    pub fn combine_voxels(&mut self, a: u32, b: u32, shift: [i32; 3]) -> i32 {
        let (Some(ga), Some(gb)) = (self.grid_of(a), self.grid_of(b)) else { return VOXELS_NOT_VOXELS };
        self.couple(ga, gb, shift);
        self.couple(gb, ga, [-shift[0], -shift[1], -shift[2]]);
        self.wake_touching_pairs(a);
        self.wake_touching_pairs(b);
        1
    }

    /// Tells coupled grid `b` that cell `at` of `a` changed (Rapier's `propagateVoxelChange`). 1, or a VOXELS_ code.
    pub fn propagate_voxel(&mut self, a: u32, b: u32, at: [i32; 3], shift: [i32; 3]) -> i32 {
        let (Some(ga), Some(gb)) = (self.grid_of(a), self.grid_of(b)) else { return VOXELS_NOT_VOXELS };
        let filled = self.cell_index(ga, at).is_some_and(|index| self.cell_byte(ga, index) & CELL_FILLED != 0);
        let here = [at[0] - shift[0], at[1] - shift[1], at[2] - shift[2]];
        for (d, step) in STEP.iter().enumerate() {
            let n = [here[0] - step[0], here[1] - step[1], here[2] - step[2]];
            // b's cell n sees `here` across its face d; only a face across b's border takes a's cell.
            if self.cell_index(gb, here).is_some() {
                continue;
            }
            if let Some(index) = self.cell_index(gb, n) {
                let byte = self.cell_byte(gb, index);
                self.set_cell_byte(gb, index, if filled { byte | (2 << d) } else { byte & !(2 << d) });
            }
        }
        self.wake_touching_pairs(b);
        1
    }

    /// The first and last cell along each axis of grid `mesh` under the box from `low` to `high` in its frame, as indices
    /// from the corner; None when the box misses the grid.
    fn cell_range(&self, mesh: usize, low: V3, high: V3) -> Option<([u32; 3], [u32; 3])> {
        let (min, dims, size) = (self.voxel_min(mesh), self.voxel_dims(mesh), self.v(VOXEL_SIZE_X, mesh));
        let (lo, hi, s) = ([low.x, low.y, low.z], [high.x, high.y, high.z], [size.x, size.y, size.z]);
        let (mut first, mut last) = ([0u32; 3], [0u32; 3]);
        for k in 0..3 {
            let (a, b) = (lo[k] / s[k], hi[k] / s[k]);
            if !(a.is_finite() && b.is_finite()) {
                return None;
            }
            let (a, b) = (floor(a) - min[k] as i64, floor(b) - min[k] as i64);
            if !(b >= 0 && a < dims[k] as i64) {
                return None;
            }
            first[k] = a.max(0) as u32;
            last[k] = b.min(dims[k] as i64 - 1) as u32;
        }
        Some((first, last))
    }

    /// The pose and half size of cell `index` of grid `mesh` posed at `pose`.
    #[inline(never)]
    fn cell_pose(&self, mesh: usize, index: u32, pose: Pose) -> (Pose, V3) {
        let (at, size) = (self.cell_at(mesh, index), self.v(VOXEL_SIZE_X, mesh));
        let center = v3((at[0] as f32 + 0.5) * size.x, (at[1] as f32 + 0.5) * size.y, (at[2] as f32 + 0.5) * size.z);
        (Pose { p: pose.apply(center), q: pose.q }, size.scale(0.5))
    }

    /// Calls `visit` with each filled cell of grid `mesh` that has an exposed face and lies under the box from `low` to
    /// `high` in its frame, until it returns false. False when a visit did. The visit is a dynamic call, so the walk is one
    /// copy for its five callers instead of one each.
    #[inline(never)]
    fn exposed_cells(&self, mesh: usize, low: V3, high: V3, visit: &mut dyn FnMut(&Self, u32) -> bool) -> bool {
        let Some((first, last)) = self.cell_range(mesh, low, high) else { return true };
        let dims = self.voxel_dims(mesh);
        for k in first[2]..=last[2] {
            for j in first[1]..=last[1] {
                for i in first[0]..=last[0] {
                    let index = i + dims[0] * (j + dims[1] * k);
                    let byte = self.cell_byte(mesh, index);
                    if byte & CELL_FILLED != 0 && byte & 0x7e != 0x7e && !visit(self, index) {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// The manifold of convex row `other` against cell `index` of grid `mesh` posed at `pose`, normal from the pair's A to
    /// its B, with the ghost rule of the cell's exposed faces.
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn collide_cell(&self, other: usize, other_is_a: bool, mesh: usize, index: u32, pose: Pose, limit: f32, out: &mut Manifold) {
        out.count = 0;
        let (cell, half) = self.cell_pose(mesh, index, pose);
        let mut data = BoxData::new();
        let poly = box_poly(half, &mut data);
        let shape = self.uu(COLLIDER_SHAPE, other);
        if crate::narrow::is_revolved(shape) {
            // A cylinder or cone: the cell as a solid box through `smooth`, snapped to the face the rule names.
            let mut smooth_data = BoxData::new();
            let Some(solid) = self.solid(self.shape_of(other), self.collider_pose(other), &mut smooth_data) else { return };
            let cell_solid = crate::cast::Solid::Poly { poly, pose: cell };
            crate::smooth::collide_solids(&cell_solid, &solid, limit, out);
            if out.count > 0 {
                match voxel_verdict(pose.q.unrotate(out.normal), self.cell_byte(mesh, index)) {
                    None => out.count = 0,
                    Some((false, _)) => {}
                    Some((true, face)) => {
                        let (core_o, border) = crate::cast::core(&solid);
                        crate::smooth::clip_along(&cell_solid, 0.0, &core_o, border, cell.q.rotate(poly.normal(face)), limit, out);
                    }
                }
            }
            if other_is_a {
                crate::mesh::flip(out);
            }
            return;
        }
        let round = shape == SHAPE_BALL || shape == SHAPE_CAPSULE;
        // The other shape is read once: its pose, round form and polyhedron serve the test and the snap.
        let mut other_data = BoxData::new();
        let (other_round, other_poly, other_pose) = if round {
            (self.round_of(other), poly, cell)
        } else {
            (Round { p: cell.p, q: cell.p, radius: 0.0 }, self.poly_of(other, &mut other_data), self.collider_pose(other))
        };
        // Every routine below gives the normal from the cell to the other shape, `on_a` on the cell.
        if round {
            collide_round_poly(other_round, &poly, cell, limit, out);
            crate::mesh::flip(out);
        } else {
            collide_polys(&poly, cell, &other_poly, other_pose, limit, out);
        }
        if out.count > 0 {
            match voxel_verdict(pose.q.unrotate(out.normal), self.cell_byte(mesh, index)) {
                None => out.count = 0,
                Some((false, _)) => {}
                Some((true, face)) if round => crate::mesh::snap_round(other_round, &poly, face, cell, limit, out),
                Some((true, face)) => snap_poly(&poly, cell, &other_poly, other_pose, face, limit, out),
            }
        }
        if other_is_a {
            crate::mesh::flip(out);
        }
    }

    /// The manifold of cell `ia` of grid `ma` against cell `ib` of grid `mb`, normal from the first to the second, with the
    /// ghost rule of both cells.
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn collide_cells(&self, (ma, ia, pa): (usize, u32, Pose), (mb, ib, pb): (usize, u32, Pose), limit: f32, out: &mut Manifold) {
        out.count = 0;
        let (cell_a, half_a) = self.cell_pose(ma, ia, pa);
        let (cell_b, half_b) = self.cell_pose(mb, ib, pb);
        let (mut data_a, mut data_b) = (BoxData::new(), BoxData::new());
        let (poly_a, poly_b) = (box_poly(half_a, &mut data_a), box_poly(half_b, &mut data_b));
        collide_polys(&poly_a, cell_a, &poly_b, cell_b, limit, out);
        if out.count == 0 {
            return;
        }
        match voxel_verdict(pa.q.unrotate(out.normal), self.cell_byte(ma, ia)) {
            None => {
                out.count = 0;
                return;
            }
            Some((true, face)) => snap_poly(&poly_a, cell_a, &poly_b, cell_b, face, limit, out),
            Some((false, _)) => {}
        }
        if out.count == 0 {
            return;
        }
        match voxel_verdict(pb.q.unrotate(out.normal.scale(-1.0)), self.cell_byte(mb, ib)) {
            None => out.count = 0,
            Some((true, face)) => {
                snap_poly(&poly_b, cell_b, &poly_a, cell_a, face, limit, out);
                crate::mesh::flip(out);
            }
            Some((false, _)) => {}
        }
    }

    /// Every exposed cell of grid collider `grid` near convex row `other` into the parts of pair `row`, keyed by cell.
    /// `sides` holds the row, whether its side is the pair's A, and the compound child it is (NONE for a collider of its
    /// own). False when memory cannot hold a new part.
    #[inline(never)]
    pub(crate) fn voxel_walk(&mut self, row: usize, grid: usize, sides: (usize, bool, u32), limit: f32, ratio: f32, bodies: (usize, usize)) -> bool {
        let (other, other_is_a, sub) = sides;
        let mesh = self.uu(COLLIDER_HULL, grid) as usize;
        let pose = self.collider_pose(grid);
        let (low, high) = self.local_box(other, pose);
        let mut cells = [0u32; 64];
        let mut manifold = Manifold::new();
        // The cells are listed first, in blocks, as touching a part writes rows the walk reads.
        let mut start = 0u32;
        loop {
            let (mut count, mut seen) = (0usize, 0u32);
            let full = !self.exposed_cells(mesh, low, high, &mut |_, index| {
                if seen >= start {
                    if count == cells.len() {
                        return false;
                    }
                    cells[count] = index;
                    count += 1;
                }
                seen += 1;
                true
            });
            for &index in &cells[..count] {
                if !self.touch_part(row, (index, sub), ratio, bodies, &mut manifold, |w, m| w.collide_cell(other, other_is_a, mesh, index, pose, limit, m)) {
                    return false;
                }
            }
            if !full {
                return true;
            }
            start += count as u32;
        }
    }

    /// The narrow phase of two grids: a part for each pair of exposed cells that touch, keyed by both cells.
    #[inline(never)]
    pub(crate) fn voxels_pair(&mut self, row: usize, a: usize, b: usize, limit: f32, ratio: f32, bodies: (usize, usize)) -> bool {
        let (ma, mb) = (self.uu(COLLIDER_HULL, a) as usize, self.uu(COLLIDER_HULL, b) as usize);
        let (pa, pb) = (self.collider_pose(a), self.collider_pose(b));
        let (low, high) = self.local_box(a, pb);
        let mut found = [(0u32, 0u32); 64];
        let mut manifold = Manifold::new();
        let mut start = 0u32;
        loop {
            let (mut count, mut seen) = (0usize, 0u32);
            let full = !self.exposed_cells(mb, low, high, &mut |w, ib| {
                let (cell, half) = w.cell_pose(mb, ib, pb);
                let (lo, hi) = box_in(cell, half, pa);
                w.exposed_cells(ma, lo, hi, &mut |_, ia| {
                    if seen >= start {
                        if count == found.len() {
                            return false;
                        }
                        found[count] = (ia, ib);
                        count += 1;
                    }
                    seen += 1;
                    true
                })
            });
            for &(ia, ib) in &found[..count] {
                if !self.touch_part(row, (ia, ib), ratio, bodies, &mut manifold, |w, m| w.collide_cells((ma, ia, pa), (mb, ib, pb), limit, m)) {
                    return false;
                }
            }
            if !full {
                return true;
            }
            start += count as u32;
        }
    }

    /// True when convex row `other` overlaps an exposed cell of grid collider `grid`.
    #[inline(never)]
    pub(crate) fn voxel_overlaps(&self, grid: usize, other: usize, other_is_a: bool) -> bool {
        let mesh = self.uu(COLLIDER_HULL, grid) as usize;
        let pose = self.collider_pose(grid);
        let (low, high) = self.local_box(other, pose);
        let mut manifold = Manifold::new();
        !self.exposed_cells(mesh, low, high, &mut |w, index| {
            w.collide_cell(other, other_is_a, mesh, index, pose, 0.0, &mut manifold);
            !manifold.points[..manifold.count].iter().any(|point| point.separation <= 0.0)
        })
    }

    /// True when two grids' exposed cells overlap.
    #[inline(never)]
    pub(crate) fn voxels_overlap(&self, a: usize, b: usize) -> bool {
        let (ma, mb) = (self.uu(COLLIDER_HULL, a) as usize, self.uu(COLLIDER_HULL, b) as usize);
        let (pa, pb) = (self.collider_pose(a), self.collider_pose(b));
        let (low, high) = self.local_box(a, pb);
        let mut manifold = Manifold::new();
        !self.exposed_cells(mb, low, high, &mut |w, ib| {
            let (cell, half) = w.cell_pose(mb, ib, pb);
            let (lo, hi) = box_in(cell, half, pa);
            w.exposed_cells(ma, lo, hi, &mut |w, ia| {
                w.collide_cells((ma, ia, pa), (mb, ib, pb), 0.0, &mut manifold);
                !manifold.points[..manifold.count].iter().any(|point| point.separation <= 0.0)
            })
        })
    }

    /// Calls `add` with each filled cell of a voxel collider as a solid box: its centre in the collider's frame and its
    /// half size.
    pub(crate) fn voxel_solids(&self, c: usize, mut add: impl FnMut(V3, V3)) {
        let mesh = self.uu(COLLIDER_HULL, c) as usize;
        let dims = self.voxel_dims(mesh);
        let identity = Pose { p: v3(0.0, 0.0, 0.0), q: Q::IDENTITY };
        for index in 0..dims[0] * dims[1] * dims[2] {
            if self.cell_byte(mesh, index) & CELL_FILLED != 0 {
                let (cell, half) = self.cell_pose(mesh, index, identity);
                add(cell.p, half);
            }
        }
    }
}

/// The whole number at or below `x`, saturating far out.
#[inline(always)]
fn floor(x: f32) -> i64 {
    let t = x as i64;
    if (t as f32) > x { t - 1 } else { t }
}

/// The box in `frame`'s space around a box of half size `half` posed at `pose`.
fn box_in(pose: Pose, half: V3, frame: Pose) -> (V3, V3) {
    let center = frame.unapply(pose.p);
    let turn = frame.q.conjugate().mul(pose.q);
    let e = turn.rotate(v3(half.x, 0.0, 0.0)).abs().add(turn.rotate(v3(0.0, half.y, 0.0)).abs()).add(turn.rotate(v3(0.0, 0.0, half.z)).abs());
    (center.sub(e), center.add(e))
}

/// A polyhedron's points against face `face` of a reference polyhedron, the face's normal from the reference to it, both
/// posed in world space: the snapped normal of the ghost rule.
#[inline(never)]
fn snap_poly(reference: &Poly, pose: Pose, incident: &Poly, other: Pose, face: usize, limit: f32, out: &mut Manifold) {
    face_contact(reference, incident, pose.relative(other), face, limit, out);
    out.normal = pose.q.rotate(out.normal);
    for point in out.points.iter_mut().take(out.count) {
        point.on_a = pose.apply(point.on_a);
        point.on_b = pose.apply(point.on_b);
    }
}
