// Contact manifolds between two cores with radii, up to two points each. Sources: the separating axis test and closest
// points between segments (Ericson, "Real-Time Collision Detection", 2005, sections 5.1.2 and 5.2.1); the reference
// and incident face clipping of Catto, "Fast and Simple Physics using Sequential Impulses" (GDC 2006), where the face of
// least penetration is the reference, the most anti-parallel face of the other shape is the incident one, and the
// incident face is clipped to the reference face's side planes.
//
// Cores that overlap take the clip from the face of largest separation. Cores apart are measured exactly, vertex to
// segment both ways, so rounded corners meet as rounded corners; when the best face's separation is the distance (a
// face is the closest feature), the clip gives that face's two points, as a box resting on a box needs.
use crate::math::{V2, Xf, v2};
use margoengine_physics_kernel_common::lanes::F4;
use crate::shape::{Core, LINEAR_SLOP, MAX_VERTICES};

/// How far a face's separation may sit under the true distance and still count as the closest feature.
const FACE_TOLERANCE: f32 = 0.1 * LINEAR_SLOP;
/// How close the two faces' separations must be for a pair to keep last step's reference face. Boxes resting on boxes tilt
/// by thousandths of a radian, which swings the separations by millimetres; within one slop the old choice stands, so the
/// points keep their ids and their warm start (Gregorius, "Robust Contact Creation for Physics Simulations", GDC 2015).
const FACE_HYSTERESIS: f32 = LINEAR_SLOP;

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct ManifoldPoint {
    /// Midway between the two surfaces, in world space.
    pub point: V2,
    /// Distance between the surfaces along the normal; below 0 when they overlap.
    pub separation: f32,
    /// The features that made the point, the same while they touch, for warm starting.
    pub id: u32,
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Manifold {
    /// The world unit normal from shape A to shape B.
    pub normal: V2,
    pub points: [ManifoldPoint; 2],
    pub count: usize,
}

/// A point id: the reference face's shape and edge, the incident edge and which of its ends.
const fn clip_id(flip: bool, reference: usize, incident: usize, end: usize) -> u32 {
    ((flip as u32) << 31) | ((reference as u32) << 16) | ((incident as u32) << 8) | end as u32
}
/// A point id for one closest pair of features: bit 30 set, then A's and B's feature, each a vertex or an edge.
const fn pair_id(a: u32, b: u32) -> u32 {
    (1 << 30) | (a << 12) | b
}

/// The closest point to `p` on the segment from `a` to `b`, and the fraction along it.
fn closest_on_segment(p: V2, a: V2, b: V2) -> (V2, f32) {
    let ab = b.sub(a);
    let span = ab.length_squared();
    if span <= 0.0 {
        return (a, 0.0);
    }
    let t = (p.sub(a).dot(ab) / span).clamp(0.0, 1.0);
    (a.add(ab.scale(t)), t)
}

/// A core's vertices and normals as `clip`, `best_face` and `closest` read them: a placed core of any count, or four
/// corners in lanes.
pub(crate) trait Poly {
    fn count(&self) -> usize;
    fn edges(&self) -> usize;
    fn vertex(&self, i: usize) -> V2;
    fn normal(&self, i: usize) -> V2;
    /// The ends of edge `i`; the next index wraps by a compare, not a remainder.
    #[inline(always)]
    fn edge(&self, i: usize) -> (V2, V2) {
        let j = i + 1;
        (self.vertex(i), self.vertex(if j == self.count() { 0 } else { j }))
    }
    /// The face most against the normal `n`: the first edge of least normal . n.
    #[inline(always)]
    fn incident(&self, n: V2) -> usize {
        let (mut least, mut incident) = (f32::INFINITY, 0usize);
        for j in 0..self.edges() {
            let d = self.normal(j).dot(n);
            if d < least {
                least = d;
                incident = j;
            }
        }
        incident
    }
    /// The segment of feature `i` for distance tests: the point itself for a circle, the one segment of a capsule.
    #[inline(always)]
    fn segments(&self) -> usize {
        match self.count() {
            1 | 2 => 1,
            n => n,
        }
    }
}

/// A core's vertices and normals in another frame.
pub(crate) struct Placed {
    pub(crate) count: usize,
    pub(crate) edges: usize,
    pub(crate) vertices: [V2; MAX_VERTICES],
    pub(crate) normals: [V2; MAX_VERTICES],
}

pub(crate) fn place(core: &Core, xf: Xf) -> Placed {
    let mut placed = Placed { count: core.count, edges: core.edges(), vertices: [V2::ZERO; MAX_VERTICES], normals: [V2::ZERO; MAX_VERTICES] };
    for i in 0..core.count {
        placed.vertices[i] = xf.apply(core.vertices[i]);
        placed.normals[i] = xf.q.apply(core.normals[i]);
    }
    placed
}

impl Poly for Placed {
    #[inline(always)]
    fn count(&self) -> usize {
        self.count
    }
    #[inline(always)]
    fn edges(&self) -> usize {
        self.edges
    }
    #[inline(always)]
    fn vertex(&self, i: usize) -> V2 {
        self.vertices[i]
    }
    #[inline(always)]
    fn normal(&self, i: usize) -> V2 {
        self.normals[i]
    }
}

/// A four-cornered polygon placed in another frame, one lane a corner: x and y of the vertices and of the normals,
/// and the same values as arrays for the scalar reads.
pub(crate) struct Quad {
    x: F4,
    y: F4,
    nx: F4,
    ny: F4,
    vx: [f32; 4],
    vy: [f32; 4],
    wx: [f32; 4],
    wy: [f32; 4],
}

/// `place` for a four-vertex core, the same operations a lane at a time: v' = (c x - s y) + p, n' = (c nx - s ny, ...).
#[inline(always)]
fn place_quad(core: &Core, xf: Xf) -> Quad {
    let (v, n) = (&core.vertices, &core.normals);
    let (x, y) = (F4::new([v[0].x, v[1].x, v[2].x, v[3].x]), F4::new([v[0].y, v[1].y, v[2].y, v[3].y]));
    let (nx, ny) = (F4::new([n[0].x, n[1].x, n[2].x, n[3].x]), F4::new([n[0].y, n[1].y, n[2].y, n[3].y]));
    let (c, s) = (F4::splat(xf.q.c), F4::splat(xf.q.s));
    let px = c * x - s * y + F4::splat(xf.p.x);
    let py = s * x + c * y + F4::splat(xf.p.y);
    let (qx, qy) = (c * nx - s * ny, s * nx + c * ny);
    Quad { x: px, y: py, nx: qx, ny: qy, vx: px.get(), vy: py.get(), wx: qx.get(), wy: qy.get() }
}

impl Poly for Quad {
    #[inline(always)]
    fn count(&self) -> usize {
        4
    }
    #[inline(always)]
    fn edges(&self) -> usize {
        4
    }
    #[inline(always)]
    fn vertex(&self, i: usize) -> V2 {
        v2(self.vx[i], self.vy[i])
    }
    #[inline(always)]
    fn normal(&self, i: usize) -> V2 {
        v2(self.wx[i], self.wy[i])
    }
    /// The four dot products in lanes (the scalar's products and sum), the first least by compares.
    #[inline(always)]
    fn incident(&self, n: V2) -> usize {
        first_least(self.nx * F4::splat(n.x) + self.ny * F4::splat(n.y)).1
    }
}

/// The face of `a` with the largest separation from the core `b`: (separation, edge); (-inf, none) with no faces.
fn best_face(a: &impl Poly, b: &impl Poly) -> (f32, usize) {
    let mut best = (f32::NEG_INFINITY, usize::MAX);
    for i in 0..a.edges() {
        let (n, v) = (a.normal(i), a.vertex(i));
        let mut least = f32::INFINITY;
        for j in 0..b.count() {
            least = least.min(n.dot(b.vertex(j).sub(v)));
        }
        if least > best.0 {
            best = (least, i);
        }
    }
    best
}

/// `best_face` of two quads, the four faces of `a` in lanes. Each lane's separation is the scalar's: the same products
/// and sums, the least taken by `pmin` (a compare and select), which can differ from `f32::min` only in the sign of a
/// zero, a value the callers only compare.
#[inline(always)]
fn best_face_quads(a: &Quad, b: &Quad) -> (f32, usize) {
    let mut least = F4::splat(f32::INFINITY);
    for j in 0..4 {
        let d = a.nx * (F4::splat(b.vx[j]) - a.x) + a.ny * (F4::splat(b.vy[j]) - a.y);
        least = least.pmin(d);
    }
    first_most(least)
}

/// The largest lane of `v` and the first lane holding it, without branches: the pair a strict `>` scan from lane 0
/// keeps (zeros of either sign count as equal, as they do there).
#[inline(always)]
fn first_most(v: F4) -> (f32, usize) {
    let l = v.get();
    let pick = |a: f32, b: f32| if b > a { b } else { a };
    let most = pick(pick(l[0], l[1]), pick(l[2], l[3]));
    (most, v.ge(F4::splat(most)).bits().trailing_zeros() as usize)
}

/// The first lane of `v` holding its least value, without branches: the lane a strict `<` scan from lane 0 keeps.
#[inline(always)]
fn first_least(v: F4) -> (f32, usize) {
    let l = v.get();
    let pick = |a: f32, b: f32| if b < a { b } else { a };
    let least = pick(pick(l[0], l[1]), pick(l[2], l[3]));
    (least, v.le(F4::splat(least)).bits().trailing_zeros() as usize)
}

/// A vertex is its index; an edge is 0x800 plus its index; a circle's point is vertex 0.
#[inline(always)]
fn feature(count: usize, segment: usize, t: f32) -> u32 {
    if count == 1 || t <= 0.0 {
        segment as u32
    } else if t >= 1.0 {
        let next = segment + 1;
        (if next == count { 0 } else { next }) as u32
    } else {
        0x800 | segment as u32
    }
}

/// The closest points of two cores that do not overlap: (distance, point on a, point on b, id).
fn closest(a: &impl Poly, b: &impl Poly) -> (f32, V2, V2, u32) {
    let mut best = (f32::INFINITY, V2::ZERO, V2::ZERO, 0);
    for i in 0..b.count() {
        for s in 0..a.segments() {
            let (p, q) = a.edge(s);
            let (on_a, t) = closest_on_segment(b.vertex(i), p, q);
            let d = b.vertex(i).sub(on_a).length_squared();
            if d < best.0 {
                best = (d, on_a, b.vertex(i), pair_id(feature(a.count(), s, t), i as u32));
            }
        }
    }
    for i in 0..a.count() {
        for s in 0..b.segments() {
            let (p, q) = b.edge(s);
            let (on_b, t) = closest_on_segment(a.vertex(i), p, q);
            let d = a.vertex(i).sub(on_b).length_squared();
            if d < best.0 {
                best = (d, a.vertex(i), on_b, pair_id(i as u32, feature(b.count(), s, t)));
            }
        }
    }
    (crate::math::sqrt(best.0), best.1, best.2, best.3)
}

/// The edge vectors of a quad, b - a per edge, and their squared lengths.
#[inline(always)]
fn quad_edges(q: &Quad) -> (F4, F4, F4) {
    let ex = F4::new([q.vx[1] - q.vx[0], q.vx[2] - q.vx[1], q.vx[3] - q.vx[2], q.vx[0] - q.vx[3]]);
    let ey = F4::new([q.vy[1] - q.vy[0], q.vy[2] - q.vy[1], q.vy[3] - q.vy[2], q.vy[0] - q.vy[3]]);
    (ex, ey, ex * ex + ey * ey)
}

/// The squared distances from the point (x, y) to the four edges of `q`, one lane an edge, as `closest_on_segment`
/// and `length_squared` give them: t = ((p - a).(b - a)) / |b - a|^2 clamped to [0, 1] as `f32::clamp` does (`pmax`
/// and `pmin` are its two compares and selects), the point a + (b - a) t.
#[inline(always)]
fn quad_distances(x: f32, y: f32, q: &Quad, ex: F4, ey: F4, span: F4) -> F4 {
    let (zero, one) = (F4::splat(0.0), F4::splat(1.0));
    let (dx, dy) = (F4::splat(x) - q.x, F4::splat(y) - q.y);
    let t = (dx * ex + dy * ey) / span;
    let t = t.pmax(zero).pmin(one);
    // A zero-length edge is its first vertex (t = 0); four distinct corners never have one.
    let t = F4::select(zero.lt(span), t, zero);
    let (ox, oy) = (F4::splat(x) - (q.x + ex * t), F4::splat(y) - (q.y + ey * t));
    ox * ox + oy * oy
}

/// `closest` of two quads: the 32 squared distances in lanes, then the first least one in `closest`'s order (B's
/// vertices against A's edges, then A's against B's), which is the one its strict `<` scan keeps; the winner's points
/// and id are computed again by `closest_on_segment`, so they are the scalar's bits.
fn closest_quads(a: &Quad, b: &Quad) -> (f32, V2, V2, u32) {
    let (ax, ay, aspan) = quad_edges(a);
    let (bx, by, bspan) = quad_edges(b);
    let mut d = [F4::splat(0.0); 8];
    for i in 0..4 {
        d[i] = quad_distances(b.vx[i], b.vy[i], a, ax, ay, aspan);
        d[4 + i] = quad_distances(a.vx[i], a.vy[i], b, bx, by, bspan);
    }
    // The least of the 32, then the first place it stands in (row, lane) order, all by compares and selects.
    let mut low = d[0];
    for row in &d[1..] {
        low = low.pmin(*row);
    }
    let (least, _) = first_least(low);
    let mut hits = 0u32;
    for (k, row) in d.iter().enumerate() {
        hits |= row.le(F4::splat(least)).bits() << (4 * k);
    }
    let first = hits.trailing_zeros() as usize;
    let at = (first / 4, first % 4);
    let (k, s) = at;
    if k < 4 {
        let (p, q) = a.edge(s);
        let (on_a, t) = closest_on_segment(b.vertex(k), p, q);
        (crate::math::sqrt(least), on_a, b.vertex(k), pair_id(feature(4, s, t), k as u32))
    } else {
        let (p, q) = b.edge(s);
        let (on_b, t) = closest_on_segment(a.vertex(k - 4), p, q);
        (crate::math::sqrt(least), a.vertex(k - 4), on_b, pair_id((k - 4) as u32, feature(4, s, t)))
    }
}

/// The manifold of `a` at `xa` and `b` at `xb`, keeping points whose separation is at most `speculative`.
pub fn collide(a: &Core, xa: Xf, b: &Core, xb: Xf, speculative: f32) -> Manifold {
    collide_coherent(a, xa, b, xb, speculative, None)
}

/// Whether a manifold's points were clipped from B's face (`Some(true)`), from A's (`Some(false)`), or neither.
pub fn reference_flip(m: &Manifold) -> Option<bool> {
    let id = m.points[0].id;
    if m.count == 0 || id & (1 << 30) != 0 { None } else { Some(id >> 31 != 0) }
}

/// As `collide`, given `last`, the previous manifold's `reference_flip`: while the two faces separate within
/// FACE_HYSTERESIS of each other, the last reference face is kept.
pub fn collide_coherent(a: &Core, xa: Xf, b: &Core, xb: Xf, speculative: f32, last: Option<bool>) -> Manifold {
    // Work in A's frame. Two four-cornered polygons (boxes) take the lane path, which gives the same bits.
    if a.count == 4 && b.count == 4 {
        let (pa, pb) = (place_quad(a, Xf::IDENTITY), place_quad(b, xa.inverse_mul(xb)));
        let faces = (best_face_quads(&pa, &pb), best_face_quads(&pb, &pa));
        return decide(&pa, &pb, faces, a.radius, b.radius, xa, speculative, last, closest_quads);
    }
    let (pa, pb) = (place(a, Xf::IDENTITY), place(b, xa.inverse_mul(xb)));
    let faces = (best_face(&pa, &pb), best_face(&pb, &pa));
    decide(&pa, &pb, faces, a.radius, b.radius, xa, speculative, last, closest)
}

/// The manifold from the best faces `faces` of the placed cores `pa` and `pb` (A's frame), with `closest` measuring
/// them when they are apart, back in world space.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn decide<P: Poly>(
    pa: &P,
    pb: &P,
    (face_a, face_b): ((f32, usize), (f32, usize)),
    a_radius: f32,
    b_radius: f32,
    xa: Xf,
    speculative: f32,
    last: Option<bool>,
    closest: fn(&P, &P) -> (f32, V2, V2, u32),
) -> Manifold {
    let mut manifold = Manifold::default();
    let radii = a_radius + b_radius;
    let face = face_a.0.max(face_b.0);
    if face - radii > speculative {
        return manifold;
    }
    // The reference face: A's unless B's separates clearly more, so a resting pair keeps one choice; within the
    // hysteresis the last step's choice stands.
    let fresh = face_b.0 > face_a.0 + FACE_TOLERANCE;
    let mut flip = match last {
        Some(f) if (face_b.0 - face_a.0).abs() <= FACE_HYSTERESIS => f,
        _ => fresh,
    };
    if face > 0.0 || face_a.1 == usize::MAX && face_b.1 == usize::MAX {
        // Apart (or two circles): the exact distance decides.
        let (distance, on_a, on_b, id) = closest(pa, pb);
        if distance - radii > speculative {
            return manifold;
        }
        // The face's two points stand only when the face is the closest feature: its separation is the distance, and
        // its clipped points reach it (a vertex just past the end of a short face passes the first test alone). When
        // the kept face fails and the fresh choice is the other face, that one is tried before the single point.
        let mut face_is_closest = false;
        for choice in [flip, fresh] {
            let reference = if choice { face_b } else { face_a };
            let (owner, other, owner_radius, other_radius) =
                if choice { (pb, pa, b_radius, a_radius) } else { (pa, pb, a_radius, b_radius) };
            face_is_closest = reference.1 != usize::MAX && reference.0 >= distance - FACE_TOLERANCE;
            if face_is_closest {
                clip(&mut manifold, owner, other, reference.1, choice, owner_radius, other_radius, speculative);
                let least = manifold.points[..manifold.count].iter().map(|p| p.separation).fold(f32::INFINITY, f32::min);
                face_is_closest = least <= distance - radii + FACE_TOLERANCE;
                if !face_is_closest {
                    manifold = Manifold::default();
                }
            }
            flip = choice;
            if face_is_closest || choice == fresh {
                break;
            }
        }
        let reference = if flip { face_b } else { face_a };
        if !face_is_closest {
            let normal = if distance > 0.0 {
                on_b.sub(on_a).scale(1.0 / distance)
            } else if reference.1 != usize::MAX {
                if flip { pb.normal(reference.1).neg() } else { pa.normal(reference.1) }
            } else {
                v2(0.0, 1.0)
            };
            let surface_a = on_a.add(normal.scale(a_radius));
            let surface_b = on_b.sub(normal.scale(b_radius));
            manifold.normal = xa.q.apply(normal);
            manifold.points[0] = ManifoldPoint { point: xa.apply(surface_a.lerp(surface_b, 0.5)), separation: distance - radii, id };
            manifold.count = 1;
            return manifold;
        }
    } else {
        let reference = if flip { face_b } else { face_a };
        let (owner, other, owner_radius, other_radius) = if flip { (pb, pa, b_radius, a_radius) } else { (pa, pb, a_radius, b_radius) };
        clip(&mut manifold, owner, other, reference.1, flip, owner_radius, other_radius, speculative);
    }
    // Back to world space; the normal always runs from A to B.
    manifold.normal = xa.q.apply(manifold.normal);
    for i in 0..manifold.count {
        manifold.points[i].point = xa.apply(manifold.points[i].point);
    }
    manifold
}

/// Clips the incident feature of `other` to the side planes of `owner`'s edge `edge`, in A's frame.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clip(m: &mut Manifold, owner: &impl Poly, other: &impl Poly, edge: usize, flip: bool, owner_radius: f32, other_radius: f32, speculative: f32) {
    let n = owner.normal(edge);
    let (r1, r2) = owner.edge(edge);
    // The incident edge: the face of `other` most against the reference normal; a circle's one point.
    let (mut points, mut ends, mut incident) = ([V2::ZERO; 2], [0usize; 2], 0usize);
    let count;
    if other.edges() == 0 {
        points[0] = other.vertex(0);
        count = 1;
    } else {
        incident = other.incident(n);
        let (i1, i2) = other.edge(incident);
        points = [i1, i2];
        ends = [0, 1];
        count = 2;
        // Clip to the side planes: t.(x - r1) >= 0 and t.(x - r2) <= 0.
        let (t, _) = r2.sub(r1).normalize();
        for (side, origin, sign) in [(0usize, r1, 1.0f32), (1, r2, -1.0)] {
            let d0 = sign * t.dot(points[0].sub(origin));
            let d1 = sign * t.dot(points[1].sub(origin));
            if d0 < 0.0 && d1 < 0.0 {
                return;
            }
            if d0 < 0.0 || d1 < 0.0 {
                let cut = points[0].lerp(points[1], d0 / (d0 - d1));
                let k = if d0 < 0.0 { 0 } else { 1 };
                points[k] = cut;
                // A clipped end keeps the id of the incident end it stands in for: the same contact as the reference
                // face's side moves, so its impulse carries over (ids stay 0 and 1, unique).
                let _ = side;
            }
        }
    }
    let normal = if flip { n.neg() } else { n };
    m.normal = normal;
    m.count = 0;
    for k in 0..count {
        let p = points[k];
        let depth = n.dot(p.sub(r1));
        let separation = depth - owner_radius - other_radius;
        if separation > speculative {
            continue;
        }
        // Midway between the owner's surface (p projected on the face, out by its radius) and the other's.
        let point = p.add(n.scale(0.5 * (owner_radius - depth - other_radius)));
        let id = clip_id(flip, edge, incident, ends[k]);
        m.points[m.count] = ManifoldPoint { point, separation, id };
        m.count += 1;
    }
}

