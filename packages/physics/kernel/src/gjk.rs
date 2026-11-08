// Distance between convex shapes by the Gilbert, Johnson, Keerthi descent, as Montanari, Petrinic and Barbieri (ACM TOG
// 2017) state it (their Algorithm 1), with their Signed Volumes sub-algorithm in place of Johnson's: it picks the face of the
// simplex that holds the closest point by comparing the signs of volumes, areas and lengths, and solves for barycentric
// coordinates only then, so a needle or a sliver costs no accuracy and needs no backup procedure. Everything is one
// support function, so any convex shape can come here.
//
// When the shapes overlap, a descent ends with the origin inside its simplex. The expanding polytope method (van den
// Bergen, GDC 2001, named by the plan, could not be fetched; the method is written from its name's idea and the
// support-function view of the paper above) grows that simplex toward the boundary of the Minkowski difference until the
// face closest to the origin stops moving: its normal and distance are the way out and the depth.
use crate::hull::Poly;
use crate::math::*;
use crate::sat::Pose;

/// A convex shape, by its support function: the point farthest along `d`.
pub trait Convex {
    fn support(&self, d: V3) -> V3;
}

impl Convex for Poly {
    #[inline]
    fn support(&self, d: V3) -> V3 {
        Poly::support(self, d)
    }
}

/// A segment, or a point when its ends meet.
#[derive(Clone, Copy)]
pub struct Segment {
    pub p: V3,
    pub q: V3,
}

impl Convex for Segment {
    #[inline(always)]
    fn support(&self, d: V3) -> V3 {
        if self.q.dot(d) > self.p.dot(d) { self.q } else { self.p }
    }
}

/// A shape at a pose.
#[derive(Clone, Copy)]
pub struct Posed<'a, T> {
    pub shape: &'a T,
    pub pose: Pose,
}

impl<T: Convex> Convex for Posed<'_, T> {
    #[inline]
    fn support(&self, d: V3) -> V3 {
        self.pose.apply(self.shape.support(self.pose.q.unrotate(d)))
    }
}

/// A's and B's support points and their difference.
#[derive(Clone, Copy, Debug)]
pub struct Vertex {
    pub w: V3,
    pub a: V3,
    pub b: V3,
}

#[inline(always)]
fn vertex(a: &impl Convex, b: &impl Convex, d: V3) -> Vertex {
    let (on_a, on_b) = (a.support(d), b.support(d.scale(-1.0)));
    Vertex { w: on_a.sub(on_b), a: on_a, b: on_b }
}

/// The subset of a simplex that holds its closest point to the origin, by place in the simplex, with coordinates, and the
/// point. The point is not the sum of the coordinates times the vertices: that sum carries a rounding of the vertices'
/// size, which near a touch is larger than the point. It is the origin's projection on the line or plane of the subset,
/// taken from the subset's vertex nearest the origin, so its error scales with the distance (van den Bergen, "Collision
/// Detection in Interactive 3D Environments", 2004, section 4.3: the error in v bounds how small a distance GJK resolves).
#[derive(Clone, Copy, Debug)]
pub struct Closest {
    pub count: usize,
    pub places: [usize; 4],
    pub lambda: [f32; 4],
    pub point: V3,
    pub squared: f32,
}

/// True when both are positive or both negative; false for a zero or a NaN, which Montanari et al. rely on: a degenerate
/// face fails this test and hands the search down to its sides.
#[inline(always)]
fn same_sign(a: f32, b: f32) -> bool {
    (a > 0.0 && b > 0.0) || (a < 0.0 && b < 0.0)
}

/// A single vertex of the simplex.
#[inline(always)]
fn vertex_of(s: &[V3; 4], i: usize) -> Closest {
    finish(s[i], 1, [i, 0, 0, 0], [1.0, 0.0, 0.0, 0.0])
}

#[inline(always)]
fn finish(point: V3, count: usize, places: [usize; 4], lambda: [f32; 4]) -> Closest {
    Closest { count, places, lambda, point, squared: point.dot(point) }
}

/// Of three points, the one nearest the origin.
#[inline(always)]
fn nearest(a: V3, b: V3, c: V3) -> V3 {
    let (la, lb, lc) = (a.dot(a), b.dot(b), c.dot(c));
    if la <= lb && la <= lc {
        a
    } else if lb <= lc {
        b
    } else {
        c
    }
}

/// Twice the area vector of the triangle x, y, z, from the two shorter of its edges. The edges sum to zero, so any two give
/// the same cross product in exact arithmetic; in floating point a needle's two long sides are nearly parallel and their
/// cross product cancels away most of its digits, while the short side against one long side keeps them (Kahan,
/// "Miscalculating Area and Angles of a Needle-like Triangle", 2014). GJK on a curved shape feeds the sub-algorithm exactly
/// such needles: support points crowd together near the closest point while an early one stays far away.
#[inline(always)]
fn area_vector(x: V3, y: V3, z: V3) -> V3 {
    let (e1, e2, e3) = (y.sub(x), z.sub(y), x.sub(z));
    let (l1, l2, l3) = (e1.dot(e1), e2.dot(e2), e3.dot(e3));
    if l1 >= l2 && l1 >= l3 {
        e2.cross(e3)
    } else if l2 >= l3 {
        e3.cross(e1)
    } else {
        e1.cross(e2)
    }
}

/// The segment's closest point (their S1D): project the origin on the line, on the axis where the segment is longest. The
/// projection starts from the end nearer the origin, so a far end's rounding does not reach it.
fn s1d(s: &[V3; 4], i: usize, j: usize) -> Closest {
    let (a, b) = (s[i], s[j]);
    let t = b.sub(a);
    let from = if a.dot(a) < b.dot(b) { a } else { b };
    let projected = from.sub(t.scale(from.dot(t) / t.dot(t)));
    let (mut most, mut pa, mut pb, mut po) = (0.0, 0.0, 0.0, 0.0);
    for (x, y, o) in [(a.x, b.x, projected.x), (a.y, b.y, projected.y), (a.z, b.z, projected.z)] {
        let length = x - y;
        if length.abs() > f32::abs(most) {
            most = length;
            pa = x;
            pb = y;
            po = o;
        }
    }
    let (c1, c2) = (po - pb, pa - po);
    if same_sign(most, c1) && same_sign(most, c2) {
        return finish(projected, 2, [i, j, 0, 0], [c1 / most, c2 / most, 0.0, 0.0]);
    }
    if a.dot(a) < b.dot(b) { vertex_of(s, i) } else { vertex_of(s, j) }
}

/// The triangle's closest point (their S2D): project the origin on its plane, then compare signed areas in the Cartesian
/// plane where the triangle's shadow is largest. Every area comes from `area_vector`, and the plane's offset from the
/// vertex nearest the origin.
fn s2d(s: &[V3; 4], i: usize, j: usize, k: usize) -> Closest {
    let (a, b, c) = (s[i], s[j], s[k]);
    let n = area_vector(a, b, c);
    let p = n.scale(nearest(a, b, c).dot(n) / n.dot(n));
    // A shadow's signed area, on each plane: the components of an area vector.
    let axis = if n.x.abs() >= n.y.abs() && n.x.abs() >= n.z.abs() {
        0
    } else if n.y.abs() >= n.z.abs() {
        1
    } else {
        2
    };
    let pick = |x: V3| match axis {
        0 => x.x,
        1 => x.y,
        _ => x.z,
    };
    let (whole, c1, c2, c3) = (pick(n), pick(area_vector(p, b, c)), pick(area_vector(a, p, c)), pick(area_vector(a, b, p)));
    if same_sign(whole, c1) && same_sign(whole, c2) && same_sign(whole, c3) {
        return finish(p, 3, [i, j, k, 0], [c1 / whole, c2 / whole, c3 / whole, 0.0]);
    }
    let mut best: Option<Closest> = None;
    for (keep, first, second) in [(c1, j, k), (c2, i, k), (c3, i, j)] {
        if !same_sign(whole, keep) {
            let found = s1d(s, first, second);
            if best.is_none_or(|old| found.squared < old.squared) {
                best = Some(found);
            }
        }
    }
    best.unwrap_or_else(|| s1d(s, i, j))
}

/// The tetrahedron's closest point (their S3D): cofactors of the matrix of vertices with a row of ones are the volumes with
/// the origin put in place of each vertex, so they are the barycentric coordinates' numerators. Each is a face's area
/// vector against the face's vertex nearest the origin, which is the determinant of the three without its cancellation.
fn s3d(s: &[V3; 4]) -> Closest {
    let (a, b, c, d) = (s[0], s[1], s[2], s[3]);
    let volume = |x: V3, y: V3, z: V3| nearest(x, y, z).dot(area_vector(x, y, z));
    let (c1, c2, c3, c4) = (-volume(b, c, d), volume(a, c, d), -volume(a, b, d), volume(a, b, c));
    let whole = c1 + c2 + c3 + c4;
    if same_sign(whole, c1) && same_sign(whole, c2) && same_sign(whole, c3) && same_sign(whole, c4) {
        return finish(v3(0.0, 0.0, 0.0), 4, [0, 1, 2, 3], [c1 / whole, c2 / whole, c3 / whole, c4 / whole]);
    }
    let mut best: Option<Closest> = None;
    for (keep, i, j, k) in [(c1, 1, 2, 3), (c2, 0, 2, 3), (c3, 0, 1, 3), (c4, 0, 1, 2)] {
        if !same_sign(whole, keep) {
            let found = s2d(s, i, j, k);
            if best.is_none_or(|old| found.squared < old.squared) {
                best = Some(found);
            }
        }
    }
    best.unwrap_or_else(|| s2d(s, 0, 1, 2))
}

/// Signed Volumes: the closest point to the origin of a simplex of `count` vertices.
pub fn signed_volumes(s: &[V3; 4], count: usize) -> Closest {
    match count {
        4 => s3d(s),
        3 => s2d(s, 0, 1, 2),
        2 => s1d(s, 0, 1),
        _ => vertex_of(s, 0),
    }
}

/// How a descent ended.
#[derive(Clone, Copy, Debug)]
pub struct Distance {
    /// The closest points, on A and on B; meaningful when `overlap` and `apart` are false.
    pub on_a: V3,
    pub on_b: V3,
    /// A's point minus B's, as the projection read it: its direction is the normal from B to A. The witness points'
    /// difference carries the rounding of the vertices' size, which near a touch tilts it by more than the distance.
    pub v: V3,
    pub distance: f32,
    /// The origin is inside the Minkowski difference: the shapes overlap.
    pub overlap: bool,
    /// The shapes are farther apart than was asked about, so the search stopped early.
    pub apart: bool,
    pub simplex: [Vertex; 4],
    pub count: usize,
}

/// Their equation 10, v.v - v.w <= eps^2 v.v: as v.w / |v| bounds the distance from below, this stops at a gap of 1e-6 of the
/// distance, a few f32 roundings. Their tolerances of 1e-8 to 1e-16 are for doubles.
const RELATIVE: f32 = 1e-6;
/// Squared distance, relative to the simplex's size, that counts as touching: their equation 9 at f32.
const TOUCHING: f32 = 1e-11;
const ITERATIONS: usize = 64;

/// GJK: the distance between `a` and `b`, which must be in one frame, from a first guess at A's point minus B's. Stops once
/// the shapes are proved farther apart than `limit`.
pub fn gjk(a: &impl Convex, b: &impl Convex, first: V3, limit: f32) -> Distance {
    let zero = v3(0.0, 0.0, 0.0);
    let mut simplex = [Vertex { w: zero, a: zero, b: zero }; 4];
    let mut count = 0;
    let mut v = if first.dot(first) > 0.0 { first } else { v3(1.0, 0.0, 0.0) };
    let mut squared = f32::INFINITY;
    let mut lambda = [1.0, 0.0, 0.0, 0.0];
    let mut overlap = false;
    let mut apart = false;
    for _ in 0..ITERATIONS {
        let w = vertex(a, b, v.scale(-1.0));
        let along = v.dot(w.w);
        // Any support plane bounds the distance from below.
        if along > 0.0 && along * along > limit * limit * v.dot(v) {
            apart = true;
            break;
        }
        if count > 0 {
            if squared - along <= RELATIVE * squared {
                break;
            }
            let mut seen = false;
            for vertex in simplex.iter().take(count) {
                seen |= vertex.w == w.w;
            }
            if seen {
                break;
            }
        }
        simplex[count] = w;
        count += 1;
        let mut points = [zero; 4];
        for i in 0..count {
            points[i] = simplex[i].w;
        }
        let closest = signed_volumes(&points, count);
        let (point, new_squared) = (closest.point, closest.squared);
        if !(new_squared < squared) && count > 1 {
            // Rounding stopped the descent: keep what the last pass found, without the vertex that did not help.
            count -= 1;
            break;
        }
        let kept = [simplex[closest.places[0]], simplex[closest.places[1]], simplex[closest.places[2]], simplex[closest.places[3]]];
        simplex[..closest.count].copy_from_slice(&kept[..closest.count]);
        count = closest.count;
        lambda = closest.lambda;
        squared = new_squared;
        v = point;
        let mut largest = 0.0f32;
        for vertex in simplex.iter().take(count) {
            let size = vertex.w.dot(vertex.w);
            if size > largest {
                largest = size;
            }
        }
        if count == 4 || squared <= TOUCHING * largest {
            overlap = true;
            break;
        }
    }
    let (mut on_a, mut on_b) = (zero, zero);
    for i in 0..count {
        on_a = on_a.add(simplex[i].a.scale(lambda[i]));
        on_b = on_b.add(simplex[i].b.scale(lambda[i]));
    }
    Distance { on_a, on_b, v, distance: sqrt(squared), overlap, apart, simplex, count }
}

const EPA_VERTICES: usize = 96;
const EPA_FACES: usize = 192;
const EPA_EDGES: usize = 96;
/// The face stops moving when a support point adds less than this, in metres plus a share of the depth.
const EPA_ABSOLUTE: f32 = 1e-5;
const EPA_RELATIVE: f32 = 1e-5;

#[derive(Clone, Copy)]
struct Face {
    v: [u16; 3],
    normal: V3,
    distance: f32,
}

/// The way out of an overlap: `normal` from A to B, so B leaves by moving `depth` along it, with the deepest points of each.
#[derive(Clone, Copy, Debug)]
pub struct Penetration {
    pub normal: V3,
    pub depth: f32,
    pub on_a: V3,
    pub on_b: V3,
}

struct Polytope {
    vertices: [Vertex; EPA_VERTICES],
    count: usize,
    faces: [Face; EPA_FACES],
    live: usize,
}

impl Polytope {
    /// Adds a face turned so that its normal points away from `inside`. False for a sliver with no normal.
    fn add(&mut self, i: usize, j: usize, k: usize, inside: V3) -> bool {
        if self.live == EPA_FACES {
            return false;
        }
        let (a, b, c) = (self.vertices[i].w, self.vertices[j].w, self.vertices[k].w);
        let n = b.sub(a).cross(c.sub(a));
        let squared = n.dot(n);
        if !(squared > 1e-20) {
            return false;
        }
        let mut normal = n.scale(1.0 / sqrt(squared));
        let mut v = [i as u16, j as u16, k as u16];
        if normal.dot(a.sub(inside)) < 0.0 {
            normal = normal.scale(-1.0);
            v = [i as u16, k as u16, j as u16];
        }
        self.faces[self.live] = Face { v, normal, distance: normal.dot(a) };
        self.live += 1;
        true
    }
}

/// Grows what a descent left into a solid around the origin. `count` under 4 means the origin lies on a point, an edge or
/// a triangle of the difference, so supports along directions across it fill in the missing dimensions.
fn seed(a: &impl Convex, b: &impl Convex, start: &Distance, polytope: &mut Polytope) -> bool {
    polytope.vertices[..start.count].copy_from_slice(&start.simplex[..start.count]);
    polytope.count = start.count;
    const AXES: [V3; 6] = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0), v3(-1.0, 0.0, 0.0), v3(0.0, -1.0, 0.0), v3(0.0, 0.0, -1.0)];
    if polytope.count == 1 {
        let mut best = polytope.vertices[0];
        let mut most = 0.0;
        for axis in AXES {
            let w = vertex(a, b, axis);
            let d = w.w.sub(polytope.vertices[0].w);
            if d.dot(d) > most {
                most = d.dot(d);
                best = w;
            }
        }
        if !(most > 0.0) {
            return false;
        }
        polytope.vertices[1] = best;
        polytope.count = 2;
    }
    if polytope.count == 2 {
        let edge = polytope.vertices[1].w.sub(polytope.vertices[0].w);
        let mut best = polytope.vertices[0];
        let mut most = 0.0;
        for axis in AXES {
            let across = edge.cross(axis);
            let w = vertex(a, b, across);
            let height = w.w.sub(polytope.vertices[0].w).cross(edge);
            if height.dot(height) > most {
                most = height.dot(height);
                best = w;
            }
        }
        if !(most > 0.0) {
            return false;
        }
        polytope.vertices[2] = best;
        polytope.count = 3;
    }
    if polytope.count == 3 {
        // The origin lies on the triangle, so the triangle and its taller side make a solid with the origin on a face. One apex
        // and not one each side: their line can miss the triangle, and the solid then has a dent whose faces point inward. On
        // the surface of the difference, a shape with its core on a face of the other, one side has no height at all.
        let (p, q, r) = (polytope.vertices[0].w, polytope.vertices[1].w, polytope.vertices[2].w);
        let n = q.sub(p).cross(r.sub(p));
        let (up, down) = (vertex(a, b, n), vertex(a, b, n.scale(-1.0)));
        polytope.vertices[3] = if n.dot(up.w.sub(p)) < n.dot(p.sub(down.w)) { down } else { up };
        polytope.count = 4;
    }
    let (p, q, r, s) = (polytope.vertices[0].w, polytope.vertices[1].w, polytope.vertices[2].w, polytope.vertices[3].w);
    let inside = p.add(q).add(r).add(s).scale(0.25);
    let mut made = true;
    for (i, j, k) in [(0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)] {
        made &= polytope.add(i, j, k, inside);
    }
    made
}

/// The penetration of two overlapping shapes, from a descent that found the overlap. None when the shapes only touch on a
/// set too thin to grow from.
pub fn epa(a: &impl Convex, b: &impl Convex, start: &Distance) -> Option<Penetration> {
    let zero = v3(0.0, 0.0, 0.0);
    let mut polytope = Polytope {
        vertices: [Vertex { w: zero, a: zero, b: zero }; EPA_VERTICES],
        count: 0,
        faces: [Face { v: [0; 3], normal: zero, distance: 0.0 }; EPA_FACES],
        live: 0,
    };
    if !seed(a, b, start, &mut polytope) {
        return None;
    }
    let mut inside = zero;
    for vertex in polytope.vertices.iter().take(polytope.count) {
        inside = inside.add(vertex.w);
    }
    let inside = inside.scale(1.0 / polytope.count as f32);
    loop {
        // The live face nearest the origin; the first of equals, so the walk is a pure function of the shapes.
        let mut nearest = 0;
        for f in 1..polytope.live {
            if polytope.faces[f].distance < polytope.faces[nearest].distance {
                nearest = f;
            }
        }
        let face = polytope.faces[nearest];
        let w = vertex(a, b, face.normal);
        let reach = face.normal.dot(w.w);
        if reach - face.distance <= EPA_ABSOLUTE + EPA_RELATIVE * face.distance.abs() || polytope.count == EPA_VERTICES {
            return Some(witness(&polytope, &face));
        }
        let new = polytope.count;
        polytope.vertices[new] = w;
        polytope.count += 1;
        // Faces that see the new vertex go; the edges only one of them owns are the horizon.
        let mut edges = [[0u16; 2]; EPA_EDGES];
        let mut horizon = 0;
        let mut f = 0;
        while f < polytope.live {
            let current = polytope.faces[f];
            if current.normal.dot(w.w.sub(polytope.vertices[current.v[0] as usize].w)) > 0.0 {
                for e in 0..3 {
                    let (from, to) = (current.v[e], current.v[(e + 1) % 3]);
                    let mut shared = false;
                    for at in 0..horizon {
                        if edges[at] == [to, from] {
                            edges[at] = edges[horizon - 1];
                            horizon -= 1;
                            shared = true;
                            break;
                        }
                    }
                    if !shared {
                        if horizon == EPA_EDGES {
                            return Some(witness(&polytope, &face));
                        }
                        edges[horizon] = [from, to];
                        horizon += 1;
                    }
                }
                polytope.live -= 1;
                polytope.faces[f] = polytope.faces[polytope.live];
            } else {
                f += 1;
            }
        }
        for edge in edges.iter().take(horizon) {
            if !polytope.add(edge[0] as usize, edge[1] as usize, new, inside) {
                return Some(witness(&polytope, &face));
            }
        }
        if polytope.live == 0 {
            return Some(witness(&polytope, &face));
        }
    }
}

/// The points on A and B behind the origin's projection on a face.
fn witness(polytope: &Polytope, face: &Face) -> Penetration {
    let (p, q, r) = (polytope.vertices[face.v[0] as usize], polytope.vertices[face.v[1] as usize], polytope.vertices[face.v[2] as usize]);
    let point = face.normal.scale(face.distance);
    let (e1, e2, d) = (q.w.sub(p.w), r.w.sub(p.w), point.sub(p.w));
    let (d11, d12, d22, d31, d32) = (e1.dot(e1), e1.dot(e2), e2.dot(e2), d.dot(e1), d.dot(e2));
    let denominator = d11 * d22 - d12 * d12;
    let (mut u, mut v) = if denominator > 0.0 { ((d22 * d31 - d12 * d32) / denominator, (d11 * d32 - d12 * d31) / denominator) } else { (0.0, 0.0) };
    u = if u < 0.0 { 0.0 } else if u > 1.0 { 1.0 } else { u };
    v = if v < 0.0 { 0.0 } else if v > 1.0 - u { 1.0 - u } else { v };
    let t = 1.0 - u - v;
    Penetration {
        normal: face.normal,
        depth: face.distance,
        on_a: p.a.scale(t).add(q.a.scale(u)).add(r.a.scale(v)),
        on_b: p.b.scale(t).add(q.b.scale(u)).add(r.b.scale(v)),
    }
}
