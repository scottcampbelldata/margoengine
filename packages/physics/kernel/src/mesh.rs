// Triangle meshes. A mesh lives in rows of the world, like a hull, so a snapshot carries it: vertices, triangles with the
// triangle across each edge, and a tree over the triangles, built once by the binned surface area heuristic (bvh.rs).
//
// A mesh pair (a mesh and any other shape but a mesh) holds no points: each triangle that touches gets a part, a pair row
// of its own with its own normal and up to four points, so a box across a crease keeps both faces' normals. Parts are off
// the broad phase's lists and table, solved like any pair, and silent in events, which speak for the whole pair.
//
// A triangle is a flat polyhedron of two faces, front and back, so every shape meets it through the code a hull runs.
// What a flat shape adds is the ghost collision (Catto 2020, "Ghost Collisions", box2d.org, read in full): a shape sliding
// over a flat run of triangles can catch on an inner edge, whose own normal points sideways. Catto's rule, written for
// chains of edges, carries to the edges of a triangle: a normal must lie in the triangle's Voronoi region of normals.
// Each edge knows from the triangle across it whether it is convex, concave or flat. A normal leaning over a concave or
// flat edge is snapped to the face normal, as only the face can push there; a normal leaning past a convex edge's
// neighbour is skipped, as the neighbour handles it; a normal within the arc between the faces stands. Open edges stand.
//
// A height field is a mesh row with vertex rows only: a grid of heights, column major as Rapier's `heightfield` takes
// them, each cell split in two along the diagonal from its corner at (row + 1, column) to the one at (row, column + 1),
// the split Rapier's height field makes (seen from outside, by rays). Its triangles, the triangle across each edge and
// the edge classes follow from the cell, so it costs 12 bytes a vertex and no tree: the cells under a box are found by
// halving along each axis. Its triangles meet every shape through the same code as a mesh's, so a part's manifold is the
// same bits as on a mesh of the same triangles.
use crate::bvh::{Nodes, Prims, build};
use crate::hull::Poly;
use crate::layout::*;
use crate::math::*;
use crate::narrow::{Manifold, Point, Round, collide_polys, collide_round_poly, face_contact, ID_END};
use crate::sat::Pose;
use crate::world::{NONE, World};

// What `end_mesh` says when it refuses, as negative rows.
pub const MESH_EMPTY: i32 = -1;
pub const MESH_BAD_INDEX: i32 = -2;
pub const MESH_NOT_FINITE: i32 = -3;
pub const MESH_BAD_ACROSS: i32 = -4;
/// A height field whose size or vertices do not make the grid `end_grid` reads.
pub const MESH_BAD_GRID: i32 = -5;

/// An edge folds less than this, as the sine of the fold, and it is flat: about 0.06 degrees.
const FOLD: f32 = 1e-3;
/// A normal leans over an edge when its share along the edge's outward perpendicular passes this.
pub(crate) const LEAN: f32 = 1e-4;
/// A triangle whose doubled area squared is this small a share of its longest edge's fourth power has no normal.
const SLIVER: f32 = 1e-12;
/// A part this pair saw in this narrow phase.
const PART_SEEN: u32 = 32;

/// A triangle as a flat polyhedron: front face a, b, c counter-clockwise, back face a, c, b.
pub struct TriData {
    vx: [f32; 3],
    vy: [f32; 3],
    vz: [f32; 3],
    nx: [f32; 2],
    ny: [f32; 2],
    nz: [f32; 2],
    offset: [f32; 2],
}

static TRI_ORIGIN: [u32; 6] = [0, 1, 2, 0, 2, 1];
static TRI_NEXT: [u32; 6] = [1, 2, 0, 4, 5, 3];
static TRI_TWIN: [u32; 6] = [5, 4, 3, 2, 1, 0];
static TRI_FACE: [u32; 6] = [0, 0, 0, 1, 1, 1];
static TRI_FIRST: [u32; 2] = [0, 3];

impl TriData {
    /// The triangle of `a`, `b`, `c` with unit normal `n`, front first.
    pub fn new(a: V3, b: V3, c: V3, n: V3) -> Self {
        let d = n.dot(a);
        Self { vx: [a.x, b.x, c.x], vy: [a.y, b.y, c.y], vz: [a.z, b.z, c.z], nx: [n.x, -n.x], ny: [n.y, -n.y], nz: [n.z, -n.z], offset: [d, -d] }
    }
    pub fn poly(&self) -> Poly {
        let third = 1.0 / 3.0;
        Poly {
            vx: self.vx.as_ptr(),
            vy: self.vy.as_ptr(),
            vz: self.vz.as_ptr(),
            nx: self.nx.as_ptr(),
            ny: self.ny.as_ptr(),
            nz: self.nz.as_ptr(),
            offset: self.offset.as_ptr(),
            origin: TRI_ORIGIN.as_ptr(),
            next: TRI_NEXT.as_ptr(),
            twin: TRI_TWIN.as_ptr(),
            face: TRI_FACE.as_ptr(),
            first: TRI_FIRST.as_ptr(),
            vertices: 3,
            edges: 6,
            faces: 2,
            center: v3((self.vx[0] + self.vx[1] + self.vx[2]) * third, (self.vy[0] + self.vy[1] + self.vy[2]) * third, (self.vz[0] + self.vz[1] + self.vz[2]) * third),
        }
    }
}

/// The unit normal of a triangle, counter-clockwise from its front; None for a sliver.
#[inline(always)]
pub fn triangle_normal(a: V3, b: V3, c: V3) -> Option<V3> {
    let (ab, ac) = (b.sub(a), c.sub(a));
    let n = ab.cross(ac);
    let squared = n.dot(n);
    let bc = c.sub(b);
    let longest = ab.dot(ab).max(ac.dot(ac)).max(bc.dot(bc));
    if !(squared > SLIVER * longest * longest) {
        return None;
    }
    Some(n.scale(1.0 / sqrt(squared)))
}

/// The class of edge `k` of a triangle of `corners` and unit normal `front`, from the corners of the triangle across it:
/// the corner across is the one farthest from the edge's line, as the other two lie on it, and its height over the face
/// says convex, concave or flat.
pub fn edge_class(corners: [V3; 3], front: V3, k: usize, other: [V3; 3]) -> u32 {
    let (p, q) = (corners[k], corners[(k + 1) % 3]);
    let d = q.sub(p);
    let length = sqrt(d.dot(d));
    let d = d.scale(1.0 / length);
    let (mut far, mut width) = (p, 0.0);
    for r in other {
        let off = r.sub(p);
        let off = off.sub(d.scale(off.dot(d)));
        let w = off.dot(off);
        if w > width {
            width = w;
            far = r;
        }
    }
    let (width, height) = (sqrt(width), front.dot(far.sub(p)));
    if !(width > 0.0) {
        EDGE_OPEN
    } else if height < -FOLD * width {
        EDGE_CONVEX
    } else if height > FOLD * width {
        EDGE_CONCAVE
    } else {
        EDGE_FLAT
    }
}

/// The cells of a run of `count` cells along one axis that reach from `low` to `high`, as the first and last, where
/// `at(i)` is the coordinate of the line before cell `i` and grows with `i`; None when the run misses.
fn cell_span(count: u32, at: impl Fn(u32) -> f32, low: f32, high: f32) -> Option<(u32, u32)> {
    if !(at(count) >= low && at(0) <= high) {
        return None;
    }
    let (mut a, mut b) = (0, count - 1);
    while a < b {
        let m = a + (b - a) / 2;
        if at(m + 1) >= low { b = m } else { a = m + 1 }
    }
    let first = a;
    b = count - 1;
    while a < b {
        let m = a + (b - a).div_ceil(2);
        if at(m) <= high { a = m } else { b = m - 1 }
    }
    Some((first, a))
}

/// What the ghost rule makes of a normal.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Verdict {
    Stand,
    Snap,
    Skip,
}

/// The ghost rule for a normal `n` from a triangle to the other shape, all in the mesh's frame: `corners` the triangle,
/// `front` its unit normal, `classes` its TRIANGLE_EDGES bits, `across` the unit front normal of the triangle across each
/// edge (any value for an open edge). The side the normal comes from is the triangle's face there, so a mesh is two-sided
/// and an edge convex from the front is concave from the back.
pub fn ghost_verdict(n: V3, corners: [V3; 3], front: V3, classes: u32, across: [V3; 3]) -> Verdict {
    let flip = n.dot(front) < 0.0;
    let face = if flip { front.scale(-1.0) } else { front };
    let mut verdict = Verdict::Stand;
    for k in 0..3 {
        let (p, q) = (corners[k], corners[(k + 1) % 3]);
        let side = q.sub(p).cross(front);
        let length = sqrt(side.dot(side));
        if !(length > 0.0) {
            continue;
        }
        let out = side.scale(1.0 / length);
        let lean = n.dot(out);
        if lean <= LEAN {
            continue;
        }
        let class = match classes >> (2 * k) & 3 {
            EDGE_CONVEX if flip => EDGE_CONCAVE,
            EDGE_CONCAVE if flip => EDGE_CONVEX,
            class => class,
        };
        match class {
            EDGE_OPEN => {}
            EDGE_CONVEX => {
                // The neighbour's face on this side leans out over the edge.
                let g = across[k];
                let g = if g.dot(out) < 0.0 { g.scale(-1.0) } else { g };
                let (ga, gb) = (g.dot(face), g.dot(out));
                // Past the neighbour's normal, in the plane square to the edge: the neighbour's own region.
                if ga * lean - gb * n.dot(face) > LEAN {
                    return Verdict::Skip;
                }
            }
            _ => verdict = Verdict::Snap,
        }
    }
    verdict
}

/// The tree builder's view of a mesh's rows, as raw columns from the mesh's first rows: the build reads each triangle's
/// corners several times a level, so it reads them with no column lookups.
struct MeshRows {
    a: *const u32,
    b: *const u32,
    c: *const u32,
    x: *const f32,
    y: *const f32,
    z: *const f32,
}

impl Prims for MeshRows {
    #[inline(always)]
    fn bounds(&self, prim: u32) -> (V3, V3) {
        let i = prim as usize;
        let corner = |column: *const u32| unsafe {
            let v = *column.add(i) as usize;
            v3(*self.x.add(v), *self.y.add(v), *self.z.add(v))
        };
        let (a, b, c) = unsafe { (corner(self.a), corner(self.b), corner(self.c)) };
        (a.min(b).min(c), a.max(b).max(c))
    }
}

struct NodeRows {
    min: [*mut f32; 3],
    max: [*mut f32; 3],
    first: *mut u32,
    count: *mut u32,
}

impl Nodes for NodeRows {
    #[inline(always)]
    fn set(&mut self, node: u32, min: V3, max: V3, first: u32, count: u32) {
        let at = node as usize;
        unsafe {
            for (k, (low, high)) in [(min.x, max.x), (min.y, max.y), (min.z, max.z)].into_iter().enumerate() {
                *self.min[k].add(at) = low;
                *self.max[k].add(at) = high;
            }
            *self.first.add(at) = first;
            *self.count.add(at) = count;
        }
    }
}

impl World {
    /// The corners of a triangle row of the mesh whose vertices start at `v0`.
    #[inline(always)]
    pub fn triangle_corners(&self, v0: usize, t: usize) -> [V3; 3] {
        let corner = |column: usize| self.v(MESH_VERTEX_X, v0 + self.uu(column, t) as usize);
        [corner(TRIANGLE_A), corner(TRIANGLE_B), corner(TRIANGLE_C)]
    }

    /// Grows the mesh classes to at least these rows; false when memory cannot.
    pub fn reserve_mesh(&mut self, rows: [u32; 5]) -> bool {
        let old = self.header().capacity;
        let have = mesh_capacity(&old);
        let need = core::array::from_fn(|k| rows[k].max(have[k]));
        if need == have {
            return true;
        }
        self.grow(capacities(old[0], old[1], old[3], hull_capacity(&old), old[11], need))
    }

    /// Makes room for one more mesh. The caller then writes MESH_VERTEX_ columns, TRIANGLE_A, B, C and TRIANGLE_ACROSS_
    /// from the rows `mesh_rows` names.
    pub fn begin_mesh(&mut self, vertices: u32, triangles: u32) -> bool {
        let used = self.header().mesh_rows;
        let Some(nodes) = triangles.checked_mul(2) else { return false };
        let (Some(v), Some(t), Some(n)) = (used[1].checked_add(vertices), used[2].checked_add(triangles), used[3].checked_add(nodes)) else {
            return false;
        };
        let have = mesh_capacity(&self.header().capacity);
        let room = |need: u32, have: u32| if need > have { need.max(have.saturating_mul(2)) } else { have };
        self.reserve_mesh([room(used[0] + 1, have[0]), room(v, have[1]), room(t, have[2]), room(n, have[3]), have[4]])
    }

    /// Checks the mesh written after `begin_mesh`, sorts its edges into classes and builds its tree. Its row, or a MESH_
    /// code, and then the rows it used are written over by the next. Rows stay for the world's life.
    pub fn end_mesh(&mut self, vertices: u32, triangles: u32, flags: u32) -> i32 {
        let [row, first_vertex, first_triangle, first_node, _] = self.header().mesh_rows;
        if vertices < 3 || triangles < 1 {
            return MESH_EMPTY;
        }
        let (v0, t0, n0) = (first_vertex as usize, first_triangle as usize, first_node as usize);
        let (mut low, mut high) = (v3(f32::INFINITY, f32::INFINITY, f32::INFINITY), v3(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY));
        for i in v0..v0 + vertices as usize {
            let p = self.v(MESH_VERTEX_X, i);
            if !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite()) {
                return MESH_NOT_FINITE;
            }
            low = low.min(p);
            high = high.max(p);
        }
        for t in t0..t0 + triangles as usize {
            for column in [TRIANGLE_A, TRIANGLE_B, TRIANGLE_C] {
                if self.uu(column, t) >= vertices {
                    return MESH_BAD_INDEX;
                }
            }
            for k in 0..3 {
                let across = self.uu(TRIANGLE_ACROSS_0 + k, t);
                if across != NONE && (across >= triangles || across as usize == t - t0) {
                    return MESH_BAD_ACROSS;
                }
            }
        }
        for t in t0..t0 + triangles as usize {
            self.set_u(TRIANGLE_ORDER, t, (t - t0) as u32);
        }
        let ids = unsafe { core::slice::from_raw_parts_mut(self.u(TRIANGLE_ORDER).add(t0), triangles as usize) };
        let rows = unsafe {
            MeshRows {
                a: self.u(TRIANGLE_A).add(t0),
                b: self.u(TRIANGLE_B).add(t0),
                c: self.u(TRIANGLE_C).add(t0),
                x: self.f(MESH_VERTEX_X).add(v0),
                y: self.f(MESH_VERTEX_Y).add(v0),
                z: self.f(MESH_VERTEX_Z).add(v0),
            }
        };
        let mut nodes = unsafe {
            NodeRows {
                min: [self.f(NODE_MIN_X).add(n0), self.f(NODE_MIN_Y).add(n0), self.f(NODE_MIN_Z).add(n0)],
                max: [self.f(NODE_MAX_X).add(n0), self.f(NODE_MAX_Y).add(n0), self.f(NODE_MAX_Z).add(n0)],
                first: self.u(NODE_FIRST).add(n0),
                count: self.u(NODE_COUNT).add(n0),
            }
        };
        // TRIANGLE_EDGES holds each triangle's bin while the tree is built, and its edge classes after.
        let bins = unsafe { core::slice::from_raw_parts_mut(self.u(TRIANGLE_EDGES).add(t0), triangles as usize) };
        let used = build(&rows, ids, bins, &mut nodes);
        for t in t0..t0 + triangles as usize {
            let corners = self.triangle_corners(v0, t);
            let mut classes = 0;
            if let Some(front) = triangle_normal(corners[0], corners[1], corners[2]) {
                for k in 0..3 {
                    let across = self.uu(TRIANGLE_ACROSS_0 + k, t);
                    if across == NONE {
                        continue;
                    }
                    let class = edge_class(corners, front, k, self.triangle_corners(v0, t0 + across as usize));
                    classes |= class << (2 * k);
                }
            }
            self.set_u(TRIANGLE_EDGES, t, classes);
        }
        self.finish_mesh([row, first_vertex, vertices, first_triangle, triangles, first_node, used, flags, 0], low, high)
    }

    /// Writes a mesh's row and hands out its rows: `rows` holds its row, first vertex, vertices, first triangle,
    /// triangles, first node, nodes, MESH_ bits and columns, and `low` to `high` is the box around its vertices.
    fn finish_mesh(&mut self, rows: [u32; 9], low: V3, high: V3) -> i32 {
        let [row, first_vertex, vertices, first_triangle, triangles, first_node, nodes, flags, columns] = rows;
        let (at, v0) = (row as usize, first_vertex as usize);
        let center = low.add(high).scale(0.5);
        let mut radius = 0.0f32;
        for i in v0..v0 + vertices as usize {
            let off = self.v(MESH_VERTEX_X, i).sub(center);
            radius = radius.max(off.dot(off));
        }
        self.set_u(MESH_FIRST_VERTEX, at, first_vertex);
        self.set_u(MESH_VERTICES, at, vertices);
        self.set_u(MESH_FIRST_TRIANGLE, at, first_triangle);
        self.set_u(MESH_TRIANGLES, at, triangles);
        self.set_u(MESH_FIRST_NODE, at, first_node);
        self.set_u(MESH_NODES, at, nodes);
        self.set_u(MESH_FLAGS, at, flags);
        self.set_u(MESH_COLUMNS, at, columns);
        self.set_v(MESH_BOX_X, at, center);
        self.set_v(MESH_HALF_X, at, high.sub(low).scale(0.5));
        self.set_s(MESH_RADIUS, at, sqrt(radius));
        let words = self.header().mesh_rows[4];
        self.header_mut().mesh_rows = [row + 1, first_vertex + vertices, first_triangle + triangles, first_node + nodes, words];
        row as i32
    }

    /// Finishes a height field written after `begin_mesh(vertices, 0)`: `(rows + 1) (columns + 1)` vertices, the one at
    /// row r and column c at `r + (rows + 1) c`, every column at one x growing with c and every row at one z growing
    /// with r. Its row, or a MESH_ code. Rows stay for the world's life.
    pub fn end_grid(&mut self, rows: u32, columns: u32, flags: u32) -> i32 {
        let [row, first_vertex, first_triangle, first_node, _] = self.header().mesh_rows;
        if rows == 0 || columns == 0 {
            return MESH_EMPTY;
        }
        let (cells, count) = (rows as u64 * columns as u64, (rows as u64 + 1) * (columns as u64 + 1));
        let have = mesh_capacity(&self.header().capacity);
        // Triangle ids are 2 a cell and must stay below NONE; the vertices must fit the rows `begin_mesh` made.
        if 2 * cells >= NONE as u64 || row >= have[0] || first_vertex as u64 + count > have[1] as u64 {
            return MESH_BAD_GRID;
        }
        let (v0, stride, vertices) = (first_vertex as usize, rows as usize + 1, count as u32);
        let (mut low, mut high) = (v3(f32::INFINITY, f32::INFINITY, f32::INFINITY), v3(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY));
        for c in 0..=columns as usize {
            let x = self.s(MESH_VERTEX_X, v0 + stride * c);
            for r in 0..stride {
                let p = self.v(MESH_VERTEX_X, v0 + r + stride * c);
                if !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite()) {
                    return MESH_NOT_FINITE;
                }
                let z = self.s(MESH_VERTEX_Z, v0 + r);
                let rising = (c == 0 || x > self.s(MESH_VERTEX_X, v0 + stride * (c - 1))) && (r == 0 || z > self.s(MESH_VERTEX_Z, v0 + r - 1));
                if p.x != x || p.z != z || !rising {
                    return MESH_BAD_GRID;
                }
                low = low.min(p);
                high = high.max(p);
            }
        }
        self.finish_mesh([row, first_vertex, vertices, first_triangle, 0, first_node, 0, flags, columns], low, high)
    }

    /// A height field's rows and columns of cells, or None for a mesh of triangle rows.
    #[inline(always)]
    pub(crate) fn grid_size(&self, mesh: usize) -> Option<(u32, u32)> {
        let columns = self.uu(MESH_COLUMNS, mesh);
        if columns == 0 {
            return None;
        }
        Some((self.uu(MESH_VERTICES, mesh) / (columns + 1) - 1, columns))
    }

    /// The corners of triangle `t` of a mesh, counted from its first; for a height field, half `t % 2` of cell `t / 2`.
    #[inline(always)]
    pub fn mesh_triangle(&self, mesh: usize, t: u32) -> [V3; 3] {
        let v0 = self.uu(MESH_FIRST_VERTEX, mesh) as usize;
        let Some((rows, _)) = self.grid_size(mesh) else {
            return self.triangle_corners(v0, self.uu(MESH_FIRST_TRIANGLE, mesh) as usize + t as usize);
        };
        let cell = t / 2;
        let (r, c, stride) = ((cell % rows) as usize, (cell / rows) as usize, rows as usize + 1);
        let at = |r: usize, c: usize| self.v(MESH_VERTEX_X, v0 + r + stride * c);
        if t % 2 == 0 { [at(r, c), at(r + 1, c), at(r, c + 1)] } else { [at(r + 1, c), at(r + 1, c + 1), at(r, c + 1)] }
    }

    /// The triangle across edge `k` (corner k to k + 1) of triangle `t` of a mesh, or NONE for an open edge.
    #[inline(always)]
    pub fn mesh_across(&self, mesh: usize, t: u32, k: usize) -> u32 {
        let Some((rows, columns)) = self.grid_size(mesh) else {
            return self.uu(TRIANGLE_ACROSS_0 + k, self.uu(MESH_FIRST_TRIANGLE, mesh) as usize + t as usize);
        };
        let cell = t / 2;
        let (r, c) = (cell % rows, cell / rows);
        let id = |r: u32, c: u32, half: u32| 2 * (r + rows * c) + half;
        // The first half's edges run up its column line, along the diagonal and back along its row line; the second
        // half's along the far row line, back along the far column line and along the diagonal.
        match (t % 2, k) {
            (0, 0) if c > 0 => id(r, c - 1, 1),
            (0, 1) => t + 1,
            (0, 2) if r > 0 => id(r - 1, c, 1),
            (1, 0) if r + 1 < rows => id(r + 1, c, 0),
            (1, 1) if c + 1 < columns => id(r, c + 1, 0),
            (1, 2) => t - 1,
            _ => NONE,
        }
    }

    /// The cells of height field `mesh` under the box from `low` to `high` in its frame along x and z: the first and last
    /// row and column. None when the box misses the grid.
    pub(crate) fn grid_cells(&self, mesh: usize, rows: u32, columns: u32, low: V3, high: V3) -> Option<[u32; 4]> {
        let (v0, stride) = (self.uu(MESH_FIRST_VERTEX, mesh) as usize, rows as usize + 1);
        let (c0, c1) = cell_span(columns, |c| self.s(MESH_VERTEX_X, v0 + stride * c as usize), low.x, high.x)?;
        let (r0, r1) = cell_span(rows, |r| self.s(MESH_VERTEX_Z, v0 + r as usize), low.z, high.z)?;
        Some([r0, r1, c0, c1])
    }

    /// Whether a height field cell's heights reach from `low` to `high`.
    #[inline(always)]
    pub(crate) fn cell_reaches(&self, mesh: usize, rows: u32, r: u32, c: u32, low: f32, high: f32) -> bool {
        let (v0, stride) = (self.uu(MESH_FIRST_VERTEX, mesh) as usize, rows as usize + 1);
        let at = v0 + r as usize + stride * c as usize;
        let h = [self.s(MESH_VERTEX_Y, at), self.s(MESH_VERTEX_Y, at + 1), self.s(MESH_VERTEX_Y, at + stride), self.s(MESH_VERTEX_Y, at + stride + 1)];
        h[0].min(h[1]).min(h[2]).min(h[3]) <= high && h[0].max(h[1]).max(h[2]).max(h[3]) >= low
    }

    /// The mesh and the other collider of a mesh pair, and whether the other is the pair's A.
    #[inline(always)]
    fn mesh_sides(&self, a: usize, b: usize) -> (usize, usize, bool) {
        if self.uu(COLLIDER_SHAPE, a) == SHAPE_TRIMESH { (a, b, false) } else { (b, a, true) }
    }

    /// The manifold of the pair's other collider against triangle `t` of the mesh, counted from its first, normal from
    /// the pair's A to its B. The mesh's MESH_FIX_EDGES bit turns on the ghost rule.
    #[allow(clippy::too_many_arguments)]
    fn collide_triangle(&self, other: usize, other_is_a: bool, mesh: usize, t: u32, pose: Pose, limit: f32, out: &mut Manifold) {
        out.count = 0;
        let corners = self.mesh_triangle(mesh, t);
        let Some(front) = triangle_normal(corners[0], corners[1], corners[2]) else { return };
        let data = TriData::new(corners[0], corners[1], corners[2], front);
        let tri = data.poly();
        let shape = self.uu(COLLIDER_SHAPE, other);
        let round = shape == SHAPE_BALL || shape == SHAPE_CAPSULE;
        // Every routine below gives the normal from the triangle to the other shape, `on_a` on the triangle.
        if round {
            let r = self.round_of(other);
            collide_round_poly(r, &tri, pose, limit, out);
            flip(out);
        } else {
            let mut box_data = crate::hull::BoxData::new();
            let poly = self.poly_of(other, &mut box_data);
            collide_polys(&tri, pose, &poly, self.collider_pose(other), limit, out);
        }
        if out.count > 0 && self.uu(MESH_FLAGS, mesh) & MESH_FIX_EDGES != 0 {
            let n = pose.q.unrotate(out.normal);
            // A mesh of rows keeps its edge classes; a height field's follow from the same neighbours.
            let grid = self.grid_size(mesh).is_some();
            let mut classes = if grid { 0 } else { self.uu(TRIANGLE_EDGES, self.uu(MESH_FIRST_TRIANGLE, mesh) as usize + t as usize) };
            let mut across = [front; 3];
            for (k, slot) in across.iter_mut().enumerate() {
                let u = self.mesh_across(mesh, t, k);
                if u != NONE {
                    let c = self.mesh_triangle(mesh, u);
                    *slot = triangle_normal(c[0], c[1], c[2]).unwrap_or(front);
                    if grid {
                        classes |= edge_class(corners, front, k, c) << (2 * k);
                    }
                }
            }
            match ghost_verdict(n, corners, front, classes, across) {
                Verdict::Stand => {}
                Verdict::Skip => out.count = 0,
                Verdict::Snap => {
                    let face = if n.dot(front) < 0.0 { 1 } else { 0 };
                    if round {
                        snap_round(self.round_of(other), &tri, face, pose, limit, out);
                    } else {
                        let mut box_data = crate::hull::BoxData::new();
                        let poly = self.poly_of(other, &mut box_data);
                        let rel = pose.relative(self.collider_pose(other));
                        face_contact(&tri, &poly, rel, face, limit, out);
                        out.normal = pose.q.rotate(out.normal);
                        for point in out.points.iter_mut().take(out.count) {
                            point.on_a = pose.apply(point.on_a);
                            point.on_b = pose.apply(point.on_b);
                        }
                    }
                }
            }
        }
        if other_is_a {
            flip(out);
        }
    }

    /// The narrow phase of a mesh pair: a part for each triangle the other collider touches, kept by triangle from one
    /// step to the next so its points carry their impulses. Parts no triangle touched lose their points, and go after the
    /// narrow phase. `ratio` is the new substep over the old.
    pub fn mesh_pair(&mut self, row: usize, a: usize, b: usize, limit: f32, ratio: f32) {
        let (mesh_collider, other, other_is_a) = self.mesh_sides(a, b);
        let bodies = (self.uu(COLLIDER_BODY, a) as usize, self.uu(COLLIDER_BODY, b) as usize);
        if self.uu(COLLIDER_SHAPE, other) == SHAPE_TRIMESH {
            // Two voxel grids meet cell by cell; a grid and a mesh, or two meshes, do not meet, as on Rapier.
            let voxels = |c: usize| self.is_voxels(self.uu(COLLIDER_HULL, c) as usize);
            if voxels(a) && voxels(b) {
                if self.voxels_pair(row, a, b, limit, ratio, bodies) {
                    self.drop_unseen(row, bodies);
                }
            } else {
                self.drop_contacts(row, bodies.0, bodies.1);
            }
            return;
        }
        if self.mesh_walk(row, mesh_collider, (other, other_is_a, NONE), limit, ratio, bodies) {
            self.drop_unseen(row, bodies);
        }
    }

    /// The mesh and the other collider of a mesh pair, and whether the other is the pair's A.
    #[inline(always)]
    pub(crate) fn mesh_of(&self, a: usize, b: usize) -> (usize, usize, bool) {
        self.mesh_sides(a, b)
    }

    /// Every triangle of `mesh_collider` near convex row `other` into the parts of pair `row`. `sides` holds the row,
    /// whether its side is the pair's A, and the compound child it is (NONE for a collider of its own). False when memory
    /// cannot hold a new part.
    pub(crate) fn mesh_walk(&mut self, row: usize, mesh_collider: usize, sides: (usize, bool, u32), limit: f32, ratio: f32, bodies: (usize, usize)) -> bool {
        let (other, other_is_a, sub) = sides;
        let mesh = self.uu(COLLIDER_HULL, mesh_collider) as usize;
        if self.is_voxels(mesh) {
            return self.voxel_walk(row, mesh_collider, sides, limit, ratio, bodies);
        }
        let pose = self.collider_pose(mesh_collider);
        let (low, high) = self.local_box(other, pose);
        let mut manifold = Manifold::new();
        if let Some((rows, columns)) = self.grid_size(mesh) {
            if let Some([r0, r1, c0, c1]) = self.grid_cells(mesh, rows, columns, low, high) {
                for c in c0..=c1 {
                    for r in r0..=r1 {
                        if !self.cell_reaches(mesh, rows, r, c, low.y, high.y) {
                            continue;
                        }
                        let cell = 2 * (r + rows * c);
                        for triangle in [cell, cell + 1] {
                            if !self.touch_triangle(row, (other, other_is_a, mesh, sub), triangle, pose, limit, ratio, bodies, &mut manifold) {
                                return false;
                            }
                        }
                    }
                }
            }
            return true;
        }
        let (t0, n0) = (self.uu(MESH_FIRST_TRIANGLE, mesh) as usize, self.uu(MESH_FIRST_NODE, mesh) as usize);
        let mut stack = [0u32; crate::bvh::STACK + 1];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = n0 + stack[top] as usize;
            let (lo, hi) = (self.v(NODE_MIN_X, node), self.v(NODE_MAX_X, node));
            if lo.x > high.x || lo.y > high.y || lo.z > high.z || hi.x < low.x || hi.y < low.y || hi.z < low.z {
                continue;
            }
            let (first, count) = (self.uu(NODE_FIRST, node), self.uu(NODE_COUNT, node));
            if count == 0 {
                stack[top] = first + 1;
                stack[top + 1] = first;
                top += 2;
                continue;
            }
            for place in first..first + count {
                let triangle = self.uu(TRIANGLE_ORDER, t0 + place as usize);
                if !self.touch_triangle(row, (other, other_is_a, mesh, sub), triangle, pose, limit, ratio, bodies, &mut manifold) {
                    return false;
                }
            }
        }
        true
    }

    /// After a pair's parts are walked: parts nothing touched this time lose their points.
    pub(crate) fn drop_unseen(&mut self, row: usize, bodies: (usize, usize)) {
        let mut part = self.uu(PAIR_CHILD, row);
        while part != NONE {
            let at = part as usize;
            let flags = self.uu(PAIR_FLAGS, at);
            if flags & PART_SEEN == 0 {
                self.drop_contacts(at, bodies.0, bodies.1);
                self.header_mut().stale_parts += 1;
            }
            self.set_u(PAIR_FLAGS, at, flags & !PART_SEEN);
            part = self.uu(PAIR_CHILD, at);
        }
    }

    /// One triangle of mesh pair `row`: its manifold against the other collider (`sides` holds the other, whether it is
    /// the pair's A, the mesh row and the compound child or NONE), stored in the triangle's part, made when it first
    /// touches. False when memory cannot hold a new part.
    #[allow(clippy::too_many_arguments)]
    fn touch_triangle(&mut self, row: usize, sides: (usize, bool, usize, u32), triangle: u32, pose: Pose, limit: f32, ratio: f32, bodies: (usize, usize), manifold: &mut Manifold) -> bool {
        let (other, other_is_a, mesh, sub) = sides;
        self.touch_part(row, (triangle, sub), ratio, bodies, manifold, |w, m| w.collide_triangle(other, other_is_a, mesh, triangle, pose, limit, m))
    }

    /// One part of pair `row`, named by `key` (its PAIR_PART and PAIR_SUB): `collide` fills the manifold, which starts
    /// with the points the part held, and a manifold with points is stored in the part, made when it first touches.
    /// False when memory cannot hold a new part.
    pub(crate) fn touch_part(
        &mut self, row: usize, key: (u32, u32), ratio: f32, bodies: (usize, usize), manifold: &mut Manifold, collide: impl FnOnce(&Self, &mut Manifold),
    ) -> bool {
        // Only the call to `collide` is generic; the bookkeeping either side is one copy for every caller.
        let part = self.open_part(row, key, manifold);
        collide(self, manifold);
        self.close_part(row, key, part, ratio, bodies, manifold)
    }

    /// The part of pair `row` named by `key`, or NONE, with the points it held loaded into `manifold`.
    #[inline(never)]
    fn open_part(&self, row: usize, key: (u32, u32), manifold: &mut Manifold) -> u32 {
        let part = self.find_part(row, key);
        manifold.held_count = 0;
        manifold.feature = 0;
        if part != NONE {
            manifold.held_count = self.uu(PAIR_CONTACTS, part as usize) as usize;
            for k in 0..manifold.held_count {
                manifold.held[k] = self.uu(CONTACT_ID, part as usize * MANIFOLD + k);
            }
            manifold.feature = self.uu(PAIR_FEATURE, part as usize);
        }
        part
    }

    /// Stores a manifold with points in `part` (made now when NONE). False when memory cannot hold a new part.
    #[inline(never)]
    fn close_part(&mut self, row: usize, key: (u32, u32), part: u32, ratio: f32, bodies: (usize, usize), manifold: &Manifold) -> bool {
        if manifold.count == 0 {
            return true;
        }
        let part = if part != NONE { part } else { self.add_part(row, key) };
        if part == NONE {
            return false;
        }
        let at = part as usize;
        self.set_u(PAIR_FLAGS, at, self.uu(PAIR_FLAGS, at) | PART_SEEN);
        self.set_u(PAIR_FEATURE, at, manifold.feature);
        self.store_manifold(at, bodies.0, bodies.1, manifold, ratio);
        true
    }

    /// True when the other collider of a mesh pair overlaps a triangle, for a pair that only needs to know.
    pub fn mesh_overlaps(&self, a: usize, b: usize) -> bool {
        let (mesh_collider, other, other_is_a) = self.mesh_sides(a, b);
        if self.uu(COLLIDER_SHAPE, other) == SHAPE_TRIMESH {
            let voxels = |c: usize| self.is_voxels(self.uu(COLLIDER_HULL, c) as usize);
            return voxels(a) && voxels(b) && self.voxels_overlap(a, b);
        }
        self.mesh_overlaps_with(mesh_collider, other, other_is_a)
    }

    /// True when convex row `other` overlaps a triangle of `mesh_collider`.
    pub(crate) fn mesh_overlaps_with(&self, mesh_collider: usize, other: usize, other_is_a: bool) -> bool {
        let mesh = self.uu(COLLIDER_HULL, mesh_collider) as usize;
        if self.is_voxels(mesh) {
            return self.voxel_overlaps(mesh_collider, other, other_is_a);
        }
        let pose = self.collider_pose(mesh_collider);
        let (low, high) = self.local_box(other, pose);
        let mut manifold = Manifold::new();
        let mut touches = |w: &Self, triangle: u32| {
            w.collide_triangle(other, other_is_a, mesh, triangle, pose, 0.0, &mut manifold);
            manifold.points[..manifold.count].iter().any(|point| point.separation <= 0.0)
        };
        if let Some((rows, columns)) = self.grid_size(mesh) {
            let Some([r0, r1, c0, c1]) = self.grid_cells(mesh, rows, columns, low, high) else { return false };
            for c in c0..=c1 {
                for r in r0..=r1 {
                    let cell = 2 * (r + rows * c);
                    if self.cell_reaches(mesh, rows, r, c, low.y, high.y) && (touches(self, cell) || touches(self, cell + 1)) {
                        return true;
                    }
                }
            }
            return false;
        }
        let (t0, n0) = (self.uu(MESH_FIRST_TRIANGLE, mesh) as usize, self.uu(MESH_FIRST_NODE, mesh) as usize);
        let mut stack = [0u32; crate::bvh::STACK + 1];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = n0 + stack[top] as usize;
            let (lo, hi) = (self.v(NODE_MIN_X, node), self.v(NODE_MAX_X, node));
            if lo.x > high.x || lo.y > high.y || lo.z > high.z || hi.x < low.x || hi.y < low.y || hi.z < low.z {
                continue;
            }
            let (first, count) = (self.uu(NODE_FIRST, node), self.uu(NODE_COUNT, node));
            if count == 0 {
                stack[top] = first + 1;
                stack[top + 1] = first;
                top += 2;
                continue;
            }
            for place in first..first + count {
                if touches(self, self.uu(TRIANGLE_ORDER, t0 + place as usize)) {
                    return true;
                }
            }
        }
        false
    }

    /// The other collider's fat box in the mesh's frame.
    pub(crate) fn local_box(&self, other: usize, pose: Pose) -> (V3, V3) {
        let (low, high) = (self.v(FAT_MIN_X, other), self.v(FAT_MAX_X, other));
        let (center, half) = (low.add(high).scale(0.5), high.sub(low).scale(0.5));
        let c = pose.unapply(center);
        let (x, y, z) = (pose.q.unrotate(v3(half.x, 0.0, 0.0)).abs(), pose.q.unrotate(v3(0.0, half.y, 0.0)).abs(), pose.q.unrotate(v3(0.0, 0.0, half.z)).abs());
        let e = x.add(y).add(z);
        (c.sub(e), c.add(e))
    }

    /// The part of `row` named `key` (PAIR_PART, PAIR_SUB), or NONE.
    fn find_part(&self, row: usize, key: (u32, u32)) -> u32 {
        let mut part = self.uu(PAIR_CHILD, row);
        while part != NONE && (self.uu(PAIR_PART, part as usize) != key.0 || self.uu(PAIR_SUB, part as usize) != key.1) {
            part = self.uu(PAIR_CHILD, part as usize);
        }
        part
    }

    /// A new part of `row` named `key`, on the active list when its pair is; NONE when memory cannot.
    fn add_part(&mut self, row: usize, key: (u32, u32)) -> u32 {
        let Some(part) = self.take_pair_row() else { return NONE };
        let at = part as usize;
        self.set_u(PAIR_A, at, self.uu(PAIR_A, row));
        self.set_u(PAIR_B, at, self.uu(PAIR_B, row));
        self.set_u(PAIR_FLAGS, at, PAIR_IS_PART);
        self.set_u(PAIR_CONTACTS, at, 0);
        self.set_u(PAIR_FEATURE, at, 0);
        self.set_s(PAIR_FORCE, at, 0.0);
        for column in [PAIR_NEXT_A, PAIR_PREVIOUS_A, PAIR_NEXT_B, PAIR_PREVIOUS_B, PAIR_SLOT] {
            self.set_u(column, at, NONE);
        }
        self.set_u(PAIR_PART, at, key.0);
        self.set_u(PAIR_SUB, at, key.1);
        self.set_u(PAIR_CHILD, at, self.uu(PAIR_CHILD, row));
        self.set_u(PAIR_CHILD, row, part);
        if self.uu(PAIR_SLOT, row) != NONE {
            self.list_pair(part);
        }
        part
    }

    /// Frees one part, taken off its pair's chain already.
    fn free_part(&mut self, part: u32) {
        self.unlist_pair(part);
        let at = part as usize;
        self.set_u(PAIR_A, at, NONE);
        self.set_u(PAIR_CHILD, at, NONE);
        self.set_u(PAIR_NEXT_A, at, self.header().free_pair);
        self.header_mut().free_pair = part;
    }

    /// Frees every part of a pair.
    pub fn free_parts(&mut self, row: usize) {
        let mut part = self.uu(PAIR_CHILD, row);
        self.set_u(PAIR_CHILD, row, NONE);
        while part != NONE {
            let next = self.uu(PAIR_CHILD, part as usize);
            self.free_part(part);
            part = next;
        }
    }

    /// After the narrow phase: frees the parts that lost their points. The walk runs from the end of the active list: a
    /// freed part's slot takes the last entry, which the walk has seen already, so every pair is seen at least once.
    pub fn sweep_parts(&mut self) {
        if self.header().stale_parts == 0 {
            return;
        }
        self.header_mut().stale_parts = 0;
        let mut i = self.header().active_pairs as usize;
        while i > 0 {
            i -= 1;
            if i >= self.header().active_pairs as usize {
                continue;
            }
            let row = self.uu(ACTIVE_PAIRS, i) as usize;
            if self.uu(PAIR_FLAGS, row) & PAIR_IS_PART != 0 {
                continue;
            }
            let mut previous = NONE;
            let mut part = self.uu(PAIR_CHILD, row);
            while part != NONE {
                let next = self.uu(PAIR_CHILD, part as usize);
                if self.uu(PAIR_CONTACTS, part as usize) == 0 {
                    if previous == NONE {
                        self.set_u(PAIR_CHILD, row, next);
                    } else {
                        self.set_u(PAIR_CHILD, previous as usize, next);
                    }
                    self.free_part(part);
                } else {
                    previous = part;
                }
                part = next;
            }
        }
    }
}

/// Turns a manifold round: the normal and the two surfaces.
#[inline(always)]
pub(crate) fn flip(out: &mut Manifold) {
    out.normal = out.normal.scale(-1.0);
    for point in out.points.iter_mut().take(out.count) {
        core::mem::swap(&mut point.on_a, &mut point.on_b);
    }
}

/// A ball's or capsule's points against the plane of a face of a triangle or a voxel cell, the normal from it to the
/// round shape, `on_a` on the face: the snapped normal of the ghost rule, where only the face can push.
pub(crate) fn snap_round(round: Round, tri: &Poly, face: usize, pose: Pose, limit: f32, out: &mut Manifold) {
    let n = tri.normal(face);
    let offset = tri.plane(face);
    let ends = if round.p.x == round.q.x && round.p.y == round.q.y && round.p.z == round.q.z { 1 } else { 2 };
    out.count = 0;
    for (k, end) in [round.p, round.q].into_iter().take(ends).enumerate() {
        let local = pose.unapply(end);
        let height = n.dot(local) - offset;
        let separation = height - round.radius;
        if separation <= limit {
            let on_plane = local.sub(n.scale(height));
            out.points[out.count] = Point { on_a: pose.apply(on_plane), on_b: pose.apply(local.sub(n.scale(round.radius))), separation, id: ID_END | k as u32 };
            out.count += 1;
        }
    }
    out.normal = pose.q.rotate(n);
}
