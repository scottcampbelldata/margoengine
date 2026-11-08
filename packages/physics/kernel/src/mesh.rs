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

/// An edge folds less than this, as the sine of the fold, and it is flat: about 0.06 degrees.
const FOLD: f32 = 1e-3;
/// A normal leans over an edge when its share along the edge's outward perpendicular passes this.
const LEAN: f32 = 1e-4;
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
    pub fn reserve_mesh(&mut self, meshes: u32, vertices: u32, triangles: u32, nodes: u32) -> bool {
        let old = self.header().capacity;
        let have = mesh_capacity(&old);
        let need = [meshes.max(have[0]), vertices.max(have[1]), triangles.max(have[2]), nodes.max(have[3])];
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
        self.reserve_mesh(room(used[0] + 1, have[0]), room(v, have[1]), room(t, have[2]), room(n, have[3]))
    }

    /// Checks the mesh written after `begin_mesh`, sorts its edges into classes and builds its tree. Its row, or a MESH_
    /// code, and then the rows it used are written over by the next. Rows stay for the world's life.
    pub fn end_mesh(&mut self, vertices: u32, triangles: u32, flags: u32) -> i32 {
        let [row, first_vertex, first_triangle, first_node] = self.header().mesh_rows;
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
                    let (p, q) = (corners[k], corners[(k + 1) % 3]);
                    let d = q.sub(p);
                    let length = sqrt(d.dot(d));
                    let d = d.scale(1.0 / length);
                    // The corner across the edge is the one farthest from its line: the other two lie on it.
                    let (mut far, mut width) = (p, 0.0);
                    for r in self.triangle_corners(v0, t0 + across as usize) {
                        let off = r.sub(p);
                        let off = off.sub(d.scale(off.dot(d)));
                        let w = off.dot(off);
                        if w > width {
                            width = w;
                            far = r;
                        }
                    }
                    let (width, height) = (sqrt(width), front.dot(far.sub(p)));
                    let class = if !(width > 0.0) {
                        EDGE_OPEN
                    } else if height < -FOLD * width {
                        EDGE_CONVEX
                    } else if height > FOLD * width {
                        EDGE_CONCAVE
                    } else {
                        EDGE_FLAT
                    };
                    classes |= class << (2 * k);
                }
            }
            self.set_u(TRIANGLE_EDGES, t, classes);
        }
        let at = row as usize;
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
        self.set_u(MESH_NODES, at, used);
        self.set_u(MESH_FLAGS, at, flags);
        self.set_v(MESH_BOX_X, at, center);
        self.set_v(MESH_HALF_X, at, high.sub(low).scale(0.5));
        self.set_s(MESH_RADIUS, at, sqrt(radius));
        self.header_mut().mesh_rows = [row + 1, first_vertex + vertices, first_triangle + triangles, first_node + used];
        row as i32
    }

    /// The mesh and the other collider of a mesh pair, and whether the other is the pair's A.
    #[inline(always)]
    fn mesh_sides(&self, a: usize, b: usize) -> (usize, usize, bool) {
        if self.uu(COLLIDER_SHAPE, a) == SHAPE_TRIMESH { (a, b, false) } else { (b, a, true) }
    }

    /// The manifold of the pair's other collider against one triangle, normal from the pair's A to its B. `fix` turns
    /// on the ghost rule.
    #[allow(clippy::too_many_arguments)]
    fn collide_triangle(&self, other: usize, other_is_a: bool, mesh: usize, t: usize, pose: Pose, limit: f32, out: &mut Manifold) {
        out.count = 0;
        let v0 = self.uu(MESH_FIRST_VERTEX, mesh) as usize;
        let corners = self.triangle_corners(v0, t);
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
            let t0 = self.uu(MESH_FIRST_TRIANGLE, mesh) as usize;
            let mut across = [front; 3];
            for (k, slot) in across.iter_mut().enumerate() {
                let u = self.uu(TRIANGLE_ACROSS_0 + k, t);
                if u != NONE {
                    let c = self.triangle_corners(v0, t0 + u as usize);
                    *slot = triangle_normal(c[0], c[1], c[2]).unwrap_or(front);
                }
            }
            match ghost_verdict(n, corners, front, self.uu(TRIANGLE_EDGES, t), across) {
                Verdict::Stand => {}
                Verdict::Skip => out.count = 0,
                Verdict::Snap => {
                    let face = if n.dot(front) < 0.0 { 1 } else { 0 };
                    if round {
                        snap_round(self.round_of(other), &data, face, pose, limit, out);
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
        let (body_a, body_b) = (self.uu(COLLIDER_BODY, a) as usize, self.uu(COLLIDER_BODY, b) as usize);
        if self.uu(COLLIDER_SHAPE, other) == SHAPE_TRIMESH {
            self.drop_contacts(row, body_a, body_b);
            return;
        }
        let mesh = self.uu(COLLIDER_HULL, mesh_collider) as usize;
        let pose = self.collider_pose(mesh_collider);
        let (low, high) = self.local_box(other, pose);
        let (t0, n0) = (self.uu(MESH_FIRST_TRIANGLE, mesh) as usize, self.uu(MESH_FIRST_NODE, mesh) as usize);
        let mut manifold = Manifold::new();
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
                let part = self.find_part(row, triangle);
                manifold.held_count = 0;
                manifold.feature = 0;
                if part != NONE {
                    manifold.held_count = self.uu(PAIR_CONTACTS, part as usize) as usize;
                    for k in 0..manifold.held_count {
                        manifold.held[k] = self.uu(CONTACT_ID, part as usize * MANIFOLD + k);
                    }
                    manifold.feature = self.uu(PAIR_FEATURE, part as usize);
                }
                self.collide_triangle(other, other_is_a, mesh, t0 + triangle as usize, pose, limit, &mut manifold);
                if manifold.count == 0 {
                    continue;
                }
                let part = if part != NONE { part } else { self.add_part(row, triangle) };
                if part == NONE {
                    return;
                }
                let at = part as usize;
                self.set_u(PAIR_FLAGS, at, self.uu(PAIR_FLAGS, at) | PART_SEEN);
                self.set_u(PAIR_FEATURE, at, manifold.feature);
                self.store_manifold(at, body_a, body_b, &manifold, ratio);
            }
        }
        // Parts no triangle touched this time lose their points.
        let mut part = self.uu(PAIR_CHILD, row);
        while part != NONE {
            let at = part as usize;
            let flags = self.uu(PAIR_FLAGS, at);
            if flags & PART_SEEN == 0 {
                self.drop_contacts(at, body_a, body_b);
                self.header_mut().stale_parts += 1;
            }
            self.set_u(PAIR_FLAGS, at, flags & !PART_SEEN);
            part = self.uu(PAIR_CHILD, at);
        }
    }

    /// True when the other collider of a mesh pair overlaps a triangle, for a pair that only needs to know.
    pub fn mesh_overlaps(&self, a: usize, b: usize) -> bool {
        let (mesh_collider, other, other_is_a) = self.mesh_sides(a, b);
        if self.uu(COLLIDER_SHAPE, other) == SHAPE_TRIMESH {
            return false;
        }
        let mesh = self.uu(COLLIDER_HULL, mesh_collider) as usize;
        let pose = self.collider_pose(mesh_collider);
        let (low, high) = self.local_box(other, pose);
        let (t0, n0) = (self.uu(MESH_FIRST_TRIANGLE, mesh) as usize, self.uu(MESH_FIRST_NODE, mesh) as usize);
        let mut manifold = Manifold::new();
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
                self.collide_triangle(other, other_is_a, mesh, t0 + triangle as usize, pose, 0.0, &mut manifold);
                if manifold.points[..manifold.count].iter().any(|point| point.separation <= 0.0) {
                    return true;
                }
            }
        }
        false
    }

    /// The other collider's fat box in the mesh's frame.
    fn local_box(&self, other: usize, pose: Pose) -> (V3, V3) {
        let (low, high) = (self.v(FAT_MIN_X, other), self.v(FAT_MAX_X, other));
        let (center, half) = (low.add(high).scale(0.5), high.sub(low).scale(0.5));
        let c = pose.unapply(center);
        let (x, y, z) = (pose.q.unrotate(v3(half.x, 0.0, 0.0)).abs(), pose.q.unrotate(v3(0.0, half.y, 0.0)).abs(), pose.q.unrotate(v3(0.0, 0.0, half.z)).abs());
        let e = x.add(y).add(z);
        (c.sub(e), c.add(e))
    }

    /// The part of `row` for `triangle`, or NONE.
    fn find_part(&self, row: usize, triangle: u32) -> u32 {
        let mut part = self.uu(PAIR_CHILD, row);
        while part != NONE && self.uu(PAIR_PART, part as usize) != triangle {
            part = self.uu(PAIR_CHILD, part as usize);
        }
        part
    }

    /// A new part of `row` for `triangle`, on the active list when its pair is; NONE when memory cannot.
    fn add_part(&mut self, row: usize, triangle: u32) -> u32 {
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
        self.set_u(PAIR_PART, at, triangle);
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
fn flip(out: &mut Manifold) {
    out.normal = out.normal.scale(-1.0);
    for point in out.points.iter_mut().take(out.count) {
        core::mem::swap(&mut point.on_a, &mut point.on_b);
    }
}

/// A ball's or capsule's points against the plane of a triangle's face, the normal from the triangle to it, `on_a` on the
/// triangle: the snapped normal of the ghost rule, where only the face can push.
fn snap_round(round: Round, data: &TriData, face: usize, pose: Pose, limit: f32, out: &mut Manifold) {
    let tri = data.poly();
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
