// Convex polyhedra. A hull lives in rows of the world, so a snapshot carries it: vertices, half-edges with their twins, and
// faces as planes. Gregorius 2015 asks for exactly this shape of data, for large faces with no coplanar neighbours (the
// clipper would see only part of a face), and for a box to run the same code as a hull, so `Poly` serves both: a box
// builds one on the stack around tables made at compile time.
use crate::layout::*;
use crate::mass::{Sym, add_offset, principal};
use crate::math::*;
use crate::world::{NONE, World};

// What `end_hull` says when it refuses, as negative rows.
pub const HULL_TOO_SMALL: i32 = -1;
pub const HULL_BAD_INDEX: i32 = -2;
pub const HULL_NOT_PLANAR: i32 = -3;
pub const HULL_NOT_CLOSED: i32 = -4;
pub const HULL_NOT_CONVEX: i32 = -5;
pub const HULL_COPLANAR_FACES: i32 = -6;
pub const HULL_FACE_TOO_LARGE: i32 = -7;

/// Two neighbouring faces closer than this cosine, about 0.8 degrees, count as one plane.
const COPLANAR: f32 = 0.9999;
/// How far a vertex may stray from a plane, as a share of the hull's size.
const FLAT: f32 = 1e-4;

/// A convex polyhedron in its own frame, as raw views: a hull's rows, or a box's tables and a `BoxData`.
#[derive(Clone, Copy)]
pub struct Poly {
    pub vx: *const f32,
    pub vy: *const f32,
    pub vz: *const f32,
    pub nx: *const f32,
    pub ny: *const f32,
    pub nz: *const f32,
    pub offset: *const f32,
    pub origin: *const u32,
    pub next: *const u32,
    pub twin: *const u32,
    pub face: *const u32,
    pub first: *const u32,
    pub vertices: usize,
    pub edges: usize,
    pub faces: usize,
    /// A point inside.
    pub center: V3,
}

impl Poly {
    #[inline(always)]
    pub fn vertex(&self, i: usize) -> V3 {
        unsafe { v3(*self.vx.add(i), *self.vy.add(i), *self.vz.add(i)) }
    }
    #[inline(always)]
    pub fn normal(&self, f: usize) -> V3 {
        unsafe { v3(*self.nx.add(f), *self.ny.add(f), *self.nz.add(f)) }
    }
    #[inline(always)]
    pub fn plane(&self, f: usize) -> f32 {
        unsafe { *self.offset.add(f) }
    }
    #[inline(always)]
    pub fn origin(&self, e: usize) -> usize {
        unsafe { *self.origin.add(e) as usize }
    }
    #[inline(always)]
    pub fn next(&self, e: usize) -> usize {
        unsafe { *self.next.add(e) as usize }
    }
    #[inline(always)]
    pub fn twin(&self, e: usize) -> usize {
        unsafe { *self.twin.add(e) as usize }
    }
    #[inline(always)]
    pub fn face(&self, e: usize) -> usize {
        unsafe { *self.face.add(e) as usize }
    }
    #[inline(always)]
    pub fn first(&self, f: usize) -> usize {
        unsafe { *self.first.add(f) as usize }
    }
    /// The vertex farthest along `d`; the first of equals, so the answer is a pure function of the data.
    #[inline]
    pub fn support(&self, d: V3) -> V3 {
        let mut best = self.vertex(0);
        let mut most = best.dot(d);
        for i in 1..self.vertices {
            let v = self.vertex(i);
            let along = v.dot(d);
            if along > most {
                most = along;
                best = v;
            }
        }
        best
    }
}

/// Vertices and planes of one box; the topology is shared.
pub struct BoxData {
    vx: [f32; 8],
    vy: [f32; 8],
    vz: [f32; 8],
    offset: [f32; 6],
}

impl BoxData {
    pub const fn new() -> Self {
        Self { vx: [0.0; 8], vy: [0.0; 8], vz: [0.0; 8], offset: [0.0; 6] }
    }
}

impl Default for BoxData {
    fn default() -> Self {
        Self::new()
    }
}

/// A box's faces, counter-clockwise seen from outside. Vertex i has x, y, z positive where bits 0, 1, 2 of i are set.
const BOX_FACES: [[u32; 4]; 6] = [[1, 3, 7, 5], [0, 4, 6, 2], [2, 6, 7, 3], [0, 1, 5, 4], [4, 5, 7, 6], [0, 2, 3, 1]];
static BOX_NX: [f32; 6] = [1.0, -1.0, 0.0, 0.0, 0.0, 0.0];
static BOX_NY: [f32; 6] = [0.0, 0.0, 1.0, -1.0, 0.0, 0.0];
static BOX_NZ: [f32; 6] = [0.0, 0.0, 0.0, 0.0, 1.0, -1.0];
static BOX_FIRST: [u32; 6] = [0, 4, 8, 12, 16, 20];

const fn box_origin() -> [u32; 24] {
    let mut out = [0; 24];
    let mut e = 0;
    while e < 24 {
        out[e] = BOX_FACES[e / 4][e % 4];
        e += 1;
    }
    out
}
const fn box_next() -> [u32; 24] {
    let mut out = [0; 24];
    let mut e = 0;
    while e < 24 {
        out[e] = ((e / 4) * 4 + (e + 1) % 4) as u32;
        e += 1;
    }
    out
}
const fn box_face() -> [u32; 24] {
    let mut out = [0; 24];
    let mut e = 0;
    while e < 24 {
        out[e] = (e / 4) as u32;
        e += 1;
    }
    out
}
const fn box_twin() -> [u32; 24] {
    let origin = box_origin();
    let next = box_next();
    let mut out = [0; 24];
    let mut e = 0;
    while e < 24 {
        let mut other = 0;
        while other < 24 {
            if origin[other] == origin[next[e] as usize] && origin[next[other] as usize] == origin[e] {
                out[e] = other as u32;
            }
            other += 1;
        }
        e += 1;
    }
    out
}
static BOX_ORIGIN: [u32; 24] = box_origin();
static BOX_NEXT: [u32; 24] = box_next();
static BOX_FACE: [u32; 24] = box_face();
static BOX_TWIN: [u32; 24] = box_twin();

/// A box of half extents `h`, its numbers kept in `data`, which must outlive the result.
pub fn box_poly(h: V3, data: &mut BoxData) -> Poly {
    for i in 0..8 {
        data.vx[i] = if i & 1 != 0 { h.x } else { -h.x };
        data.vy[i] = if i & 2 != 0 { h.y } else { -h.y };
        data.vz[i] = if i & 4 != 0 { h.z } else { -h.z };
    }
    data.offset = [h.x, h.x, h.y, h.y, h.z, h.z];
    Poly {
        vx: data.vx.as_ptr(),
        vy: data.vy.as_ptr(),
        vz: data.vz.as_ptr(),
        nx: BOX_NX.as_ptr(),
        ny: BOX_NY.as_ptr(),
        nz: BOX_NZ.as_ptr(),
        offset: data.offset.as_ptr(),
        origin: BOX_ORIGIN.as_ptr(),
        next: BOX_NEXT.as_ptr(),
        twin: BOX_TWIN.as_ptr(),
        face: BOX_FACE.as_ptr(),
        first: BOX_FIRST.as_ptr(),
        vertices: 8,
        edges: 24,
        faces: 6,
        center: v3(0.0, 0.0, 0.0),
    }
}

impl World {
    /// The view of a hull row.
    pub fn hull_poly(&self, hull: usize) -> Poly {
        let (v, e, f) = (self.uu(HULL_FIRST_VERTEX, hull) as usize, self.uu(HULL_FIRST_EDGE, hull) as usize, self.uu(HULL_FIRST_FACE, hull) as usize);
        unsafe {
            Poly {
                vx: self.f(VERTEX_X).add(v),
                vy: self.f(VERTEX_Y).add(v),
                vz: self.f(VERTEX_Z).add(v),
                nx: self.f(FACE_NORMAL_X).add(f),
                ny: self.f(FACE_NORMAL_Y).add(f),
                nz: self.f(FACE_NORMAL_Z).add(f),
                offset: self.f(FACE_OFFSET).add(f),
                origin: self.u(EDGE_ORIGIN).add(e),
                next: self.u(EDGE_NEXT).add(e),
                twin: self.u(EDGE_TWIN).add(e),
                face: self.u(EDGE_FACE).add(e),
                first: self.u(FACE_EDGE).add(f),
                vertices: self.uu(HULL_VERTICES, hull) as usize,
                edges: self.uu(HULL_EDGES, hull) as usize,
                faces: self.uu(HULL_FACES, hull) as usize,
                center: self.v(HULL_CENTER_X, hull),
            }
        }
    }

    /// Grows the hull classes to at least these rows; false when memory cannot.
    pub fn reserve_hull(&mut self, hulls: u32, vertices: u32, edges: u32, faces: u32) -> bool {
        let old = self.header().capacity;
        let need = [hulls.max(old[7]), vertices.max(old[8]), edges.max(old[9]), faces.max(old[10])];
        if need == [old[7], old[8], old[9], old[10]] {
            return true;
        }
        self.grow(capacities(old[0], old[1], old[3], need, old[11]))
    }

    /// Makes room for one more hull. The caller then writes VERTEX_ columns, FACE_EDGE with each face's first index into
    /// EDGE_ORIGIN, and EDGE_ORIGIN with each face's vertices in order, from the rows `hull_rows` names.
    pub fn begin_hull(&mut self, vertices: u32, faces: u32, edges: u32) -> bool {
        let used = self.header().hull_rows;
        let (Some(v), Some(f), Some(e)) = (used[1].checked_add(vertices), used[3].checked_add(faces), used[2].checked_add(edges)) else {
            return false;
        };
        // Doubling keeps a world of many small hulls from moving every column each time.
        let old = self.header().capacity;
        let room = |need: u32, have: u32| if need > have { need.max(have.saturating_mul(2)) } else { have };
        self.reserve_hull(room(used[0] + 1, old[7]), room(v, old[8]), room(e, old[9]), room(f, old[10]))
    }

    /// Checks the hull written after `begin_hull`, links its half-edges and works out its mass. Its row, or a HULL_ code,
    /// and then the rows it used are simply written over by the next. Rows stay for the world's life.
    pub fn end_hull(&mut self, vertices: u32, faces: u32, edges: u32) -> i32 {
        let [row, first_vertex, first_edge, first_face] = self.header().hull_rows;
        if vertices < 4 || faces < 4 || edges < 12 {
            return HULL_TOO_SMALL;
        }
        let (v0, e0, f0) = (first_vertex as usize, first_edge as usize, first_face as usize);
        let (nv, ne, nf) = (vertices as usize, edges as usize, faces as usize);
        for e in 0..ne {
            if self.uu(EDGE_ORIGIN, e0 + e) >= vertices {
                return HULL_BAD_INDEX;
            }
            self.set_u(EDGE_TWIN, e0 + e, NONE);
        }
        // The vertices' middle is a point inside, which the mass integrals start from.
        let mut sum = v3(0.0, 0.0, 0.0);
        let (mut low, mut high) = (self.v(VERTEX_X, v0), self.v(VERTEX_X, v0));
        for i in 0..nv {
            let v = self.v(VERTEX_X, v0 + i);
            sum = sum.add(v);
            low = low.min(v);
            high = high.max(v);
            self.set_u(VERTEX_CHAIN, v0 + i, NONE);
        }
        let middle = sum.scale(1.0 / vertices as f32);
        let span = high.sub(low);
        let size = sqrt(span.dot(span));
        // Faces: the edges of each are a run, closed into a loop. Newell's sum of edge crosses gives the plane.
        for f in 0..nf {
            let start = self.uu(FACE_EDGE, f0 + f) as usize;
            let end = if f + 1 < nf { self.uu(FACE_EDGE, f0 + f + 1) as usize } else { ne };
            if end < start + 3 || end > ne {
                return HULL_BAD_INDEX;
            }
            if (end - start) as u32 > MAX_FACE_EDGES {
                return HULL_FACE_TOO_LARGE;
            }
            let mut area = v3(0.0, 0.0, 0.0);
            let mut point = v3(0.0, 0.0, 0.0);
            for e in start..end {
                let next = if e + 1 < end { e + 1 } else { start };
                self.set_u(EDGE_NEXT, e0 + e, next as u32);
                self.set_u(EDGE_FACE, e0 + e, f as u32);
                let (a, b) = (self.vertex_of(v0, e0 + e), self.vertex_of(v0, e0 + next));
                area = area.add(a.sub(middle).cross(b.sub(middle)));
                point = point.add(a);
            }
            let length = sqrt(area.dot(area));
            if !(length > 0.0) {
                return HULL_NOT_PLANAR;
            }
            let normal = area.scale(1.0 / length);
            let offset = normal.dot(point.scale(1.0 / (end - start) as f32));
            self.set_v(FACE_NORMAL_X, f0 + f, normal);
            self.set_s(FACE_OFFSET, f0 + f, offset);
            for e in start..end {
                if (normal.dot(self.vertex_of(v0, e0 + e)) - offset).abs() > FLAT * size {
                    return HULL_NOT_PLANAR;
                }
            }
        }
        // Twins: a chain of the edges leaving each vertex finds a's edge back from b in the vertex's degree.
        for e in 0..ne {
            let origin = self.uu(EDGE_ORIGIN, e0 + e) as usize;
            self.set_u(EDGE_CHAIN, e0 + e, self.uu(VERTEX_CHAIN, v0 + origin));
            self.set_u(VERTEX_CHAIN, v0 + origin, e as u32);
        }
        for e in 0..ne {
            if self.uu(EDGE_TWIN, e0 + e) != NONE {
                continue;
            }
            let (from, to) = (self.uu(EDGE_ORIGIN, e0 + e), self.edge_end(e0, e));
            let mut other = self.uu(VERTEX_CHAIN, v0 + to as usize);
            let mut found = NONE;
            while other != NONE {
                if self.edge_end(e0, other as usize) == from {
                    if found != NONE {
                        return HULL_NOT_CLOSED;
                    }
                    found = other;
                }
                other = self.uu(EDGE_CHAIN, e0 + other as usize);
            }
            if found == NONE || self.uu(EDGE_TWIN, e0 + found as usize) != NONE || found as usize == e {
                return HULL_NOT_CLOSED;
            }
            self.set_u(EDGE_TWIN, e0 + e, found);
            self.set_u(EDGE_TWIN, e0 + found as usize, e as u32);
            let (a, b) = (self.uu(EDGE_FACE, e0 + e) as usize, self.uu(EDGE_FACE, e0 + found as usize) as usize);
            if self.v(FACE_NORMAL_X, f0 + a).dot(self.v(FACE_NORMAL_X, f0 + b)) > COPLANAR {
                return HULL_COPLANAR_FACES;
            }
        }
        for f in 0..nf {
            let (normal, offset) = (self.v(FACE_NORMAL_X, f0 + f), self.s(FACE_OFFSET, f0 + f));
            for i in 0..nv {
                if normal.dot(self.v(VERTEX_X, v0 + i)) - offset > FLAT * size {
                    return HULL_NOT_CONVEX;
                }
            }
        }
        // Euler's formula rejects a closed surface of the wrong kind, such as two hulls in one list.
        if vertices as i64 + faces as i64 - (edges / 2) as i64 != 2 {
            return HULL_NOT_CLOSED;
        }
        let at = row as usize;
        self.set_u(HULL_FIRST_VERTEX, at, first_vertex);
        self.set_u(HULL_VERTICES, at, vertices);
        self.set_u(HULL_FIRST_EDGE, at, first_edge);
        self.set_u(HULL_EDGES, at, edges);
        self.set_u(HULL_FIRST_FACE, at, first_face);
        self.set_u(HULL_FACES, at, faces);
        self.set_v(HULL_BOX_X, at, low.add(high).scale(0.5));
        self.set_v(HULL_HALF_X, at, span.scale(0.5));
        self.hull_mass(at, middle, v0, e0, nf, ne);
        let center = self.v(HULL_CENTER_X, at);
        let mut radius = 0.0f32;
        for i in 0..nv {
            let d = self.v(VERTEX_X, v0 + i).sub(center);
            let squared = d.dot(d);
            if squared > radius {
                radius = squared;
            }
        }
        self.set_s(HULL_RADIUS, at, sqrt(radius));
        self.header_mut().hull_rows = [row + 1, first_vertex + vertices, first_edge + edges, first_face + faces];
        row as i32
    }

    #[inline(always)]
    fn vertex_of(&self, v0: usize, edge: usize) -> V3 {
        self.v(VERTEX_X, v0 + self.uu(EDGE_ORIGIN, edge) as usize)
    }

    #[inline(always)]
    fn edge_end(&self, e0: usize, e: usize) -> u32 {
        self.uu(EDGE_ORIGIN, e0 + self.uu(EDGE_NEXT, e0 + e) as usize)
    }

    /// Volume, centroid and inertia per unit of density, summed over tetrahedra from `apex` to each face's fan of triangles.
    /// With the apex at the origin, a tetrahedron of volume V and vertices a, b, c has `integral x_i = V/4 sum p_i` and
    /// `integral x_i x_j = V/20 (sum p_i p_j + sum p_i sum p_j)`.
    fn hull_mass(&mut self, at: usize, apex: V3, v0: usize, e0: usize, faces: usize, edges: usize) {
        let mut volume = 0.0f32;
        let mut first_moment = v3(0.0, 0.0, 0.0);
        let mut second = Sym { xx: 0.0, yy: 0.0, zz: 0.0, xy: 0.0, xz: 0.0, yz: 0.0 };
        let (mut xx, mut yy, mut zz) = (0.0f32, 0.0f32, 0.0f32);
        let f0 = self.header().hull_rows[3] as usize;
        for f in 0..faces {
            let start = self.uu(FACE_EDGE, f0 + f) as usize;
            let end = if f + 1 < faces { self.uu(FACE_EDGE, f0 + f + 1) as usize } else { edges };
            let a = self.vertex_of(v0, e0 + start).sub(apex);
            for e in start + 1..end - 1 {
                let b = self.vertex_of(v0, e0 + e).sub(apex);
                let c = self.vertex_of(v0, e0 + e + 1).sub(apex);
                let v = a.dot(b.cross(c)) / 6.0;
                volume += v;
                let s = a.add(b).add(c);
                first_moment = first_moment.add(s.scale(v * 0.25));
                let w = v / 20.0;
                xx += w * (a.x * a.x + b.x * b.x + c.x * c.x + s.x * s.x);
                yy += w * (a.y * a.y + b.y * b.y + c.y * c.y + s.y * s.y);
                zz += w * (a.z * a.z + b.z * b.z + c.z * c.z + s.z * s.z);
                second.xy -= w * (a.x * a.y + b.x * b.y + c.x * c.y + s.x * s.y);
                second.xz -= w * (a.x * a.z + b.x * b.z + c.x * c.z + s.x * s.z);
                second.yz -= w * (a.y * a.z + b.y * b.z + c.y * c.z + s.y * s.z);
            }
        }
        second.xx = yy + zz;
        second.yy = xx + zz;
        second.zz = xx + yy;
        let offset = first_moment.scale(1.0 / volume);
        // The parallel axis theorem, backwards: from the apex to the centroid.
        add_offset(&mut second, -volume, offset);
        let (moments, frame) = principal(second);
        self.set_s(HULL_VOLUME, at, volume);
        self.set_v(HULL_CENTER_X, at, apex.add(offset));
        self.set_v(HULL_MOMENT_X, at, moments);
        self.set_q(HULL_FRAME_X, at, frame);
    }

    /// Adds a hull from vertices and faces (each a list of vertex indices, counter-clockwise seen from outside): what the
    /// rows path of `begin_hull` and `end_hull` does for JS, for callers on this side.
    pub fn add_hull(&mut self, vertices: &[[f32; 3]], faces: &[&[u32]]) -> i32 {
        let edges: usize = faces.iter().map(|face| face.len()).sum();
        if !self.begin_hull(vertices.len() as u32, faces.len() as u32, edges as u32) {
            return HULL_TOO_SMALL;
        }
        let [_, v0, e0, f0] = self.header().hull_rows;
        for (i, v) in vertices.iter().enumerate() {
            self.set_v(VERTEX_X, v0 as usize + i, v3(v[0], v[1], v[2]));
        }
        let mut edge = 0;
        for (f, face) in faces.iter().enumerate() {
            self.set_u(FACE_EDGE, f0 as usize + f, edge as u32);
            for &index in face.iter() {
                self.set_u(EDGE_ORIGIN, e0 as usize + edge, index);
                edge += 1;
            }
        }
        self.end_hull(vertices.len() as u32, faces.len() as u32, edges as u32)
    }
}
