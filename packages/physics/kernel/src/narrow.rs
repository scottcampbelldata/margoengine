// The narrow phase: for each pair the broad phase found near, one manifold, a set of points that share a normal. One-shot,
// as Gregorius 2015 sets out: find the touching features, then clip one face against the side planes of the other, so a
// box resting on a box has all its points from the first frame, with no artificial torque while they gather.
use crate::broad::MARGIN;
use crate::hull::{BoxData, Poly, box_poly};
use crate::layout::*;
use crate::math::*;
use crate::sat::{Feature, Pose, closest_on_segments, sat};
use crate::world::World;

/// A clipped polygon's most vertices: a largest face, plus one for each side plane of another.
const CLIP: usize = 2 * MAX_FACE_EDGES as usize;

// A point's id says which features made it, so that it can be recognised in the next step. The top bit is set when B
// holds the reference face; then a kind, then two small numbers.
const ID_FLIP: u32 = 1 << 31;
const ID_CLIPPED: u32 = 1 << 30;
const ID_EDGES: u32 = 1 << 29;

/// One point of a manifold, in world space: the point on each surface and the gap along the normal.
#[derive(Clone, Copy, Debug)]
pub struct Point {
    pub on_a: V3,
    pub on_b: V3,
    pub separation: f32,
    pub id: u32,
}

/// Points that share a normal, which runs from A to B.
#[derive(Clone, Copy, Debug)]
pub struct Manifold {
    pub normal: V3,
    pub count: usize,
    pub points: [Point; MANIFOLD],
}

impl Manifold {
    pub fn new() -> Self {
        let zero = v3(0.0, 0.0, 0.0);
        Self { normal: zero, count: 0, points: [Point { on_a: zero, on_b: zero, separation: 0.0, id: 0 }; MANIFOLD] }
    }
}

impl Default for Manifold {
    fn default() -> Self {
        Self::new()
    }
}

/// A vertex of the polygon being clipped: where it is, its id, and the edge leaving it.
#[derive(Clone, Copy)]
struct ClipVertex {
    p: V3,
    id: u32,
    edge: u32,
}

/// An edge that runs along a side plane after clipping, marked so that a later cut names it apart from a polygon edge.
const ALONG_PLANE: u32 = 1 << 8;

/// Clips `input` against the plane `normal . x <= offset`, by Sutherland and Hodgman, and returns how many vertices are left.
fn clip(input: &[ClipVertex], output: &mut [ClipVertex; CLIP], normal: V3, offset: f32, plane: u32) -> usize {
    let mut count = 0;
    let mut previous = input[input.len() - 1];
    let mut distance_previous = normal.dot(previous.p) - offset;
    for &vertex in input {
        let distance = normal.dot(vertex.p) - offset;
        if (distance_previous <= 0.0) != (distance <= 0.0) && count < CLIP {
            let t = distance_previous / (distance_previous - distance);
            let p = previous.p.add(vertex.p.sub(previous.p).scale(t));
            let id = ID_CLIPPED | (plane << 16) | previous.edge;
            // Going in, the rest of the old edge leaves this point; going out, the new edge runs along the plane.
            let edge = if distance <= 0.0 { previous.edge } else { ALONG_PLANE | plane };
            output[count] = ClipVertex { p, id, edge };
            count += 1;
        }
        if distance <= 0.0 && count < CLIP {
            output[count] = vertex;
            count += 1;
        }
        previous = vertex;
        distance_previous = distance;
    }
    count
}

/// Keeps the deepest points. Job 5 of the batch replaces this with the reduction by area.
fn keep_deepest(points: &mut [Point], count: usize, out: &mut Manifold) {
    let kept = if count < MANIFOLD { count } else { MANIFOLD };
    for i in 0..kept {
        let mut best = i;
        for j in i + 1..count {
            if points[j].separation < points[best].separation {
                best = j;
            }
        }
        points.swap(i, best);
        out.points[i] = points[i];
    }
    out.count = kept;
}

/// A face contact (Gregorius 2015): the face of `reference` is the reference face, the most anti-parallel face of
/// `incident` is clipped against its side planes, points below `limit` stay and move onto the reference face. Results are
/// in `reference`'s frame, with the normal from `reference` to `incident` and `on_a` on the reference.
fn face_contact(reference: &Poly, incident: &Poly, rel: Pose, face: usize, limit: f32, out: &mut Manifold) {
    let n = reference.normal(face);
    let offset = reference.plane(face);
    let local = rel.q.unrotate(n);
    let (mut chosen, mut lowest) = (0, f32::INFINITY);
    for f in 0..incident.faces {
        let along = incident.normal(f).dot(local);
        if along < lowest {
            lowest = along;
            chosen = f;
        }
    }
    let zero = ClipVertex { p: v3(0.0, 0.0, 0.0), id: 0, edge: 0 };
    let mut first = [zero; CLIP];
    let mut second = [zero; CLIP];
    let mut count = 0;
    let start = incident.first(chosen);
    let mut e = start;
    loop {
        let vertex = incident.origin(e);
        first[count] = ClipVertex { p: rel.apply(incident.vertex(vertex)), id: vertex as u32, edge: count as u32 };
        count += 1;
        e = incident.next(e);
        if e == start {
            break;
        }
    }
    let start = reference.first(face);
    let mut e = start;
    let mut plane = 0;
    loop {
        let next = reference.next(e);
        let (a, b) = (reference.vertex(reference.origin(e)), reference.vertex(reference.origin(next)));
        // Faces run counter-clockwise from outside, so edge x normal points out of the face.
        let side = b.sub(a).cross(n);
        let length = sqrt(side.dot(side));
        let side = side.scale(1.0 / length);
        count = if plane & 1 == 0 {
            clip(&first[..count], &mut second, side, side.dot(a), plane)
        } else {
            clip(&second[..count], &mut first, side, side.dot(a), plane)
        };
        plane += 1;
        e = next;
        if e == start || count == 0 {
            break;
        }
    }
    let polygon = if plane & 1 == 0 { &first } else { &second };
    let mut points = [Point { on_a: n, on_b: n, separation: 0.0, id: 0 }; CLIP];
    let mut kept = 0;
    for vertex in polygon.iter().take(count) {
        let separation = n.dot(vertex.p) - offset;
        if separation <= limit {
            points[kept] = Point { on_a: vertex.p.sub(n.scale(separation)), on_b: vertex.p, separation, id: vertex.id };
            kept += 1;
        }
    }
    out.normal = n;
    keep_deepest(&mut points, kept, out);
}

/// A manifold between two polyhedra, in world space. `pose_a` and `pose_b` are the shapes' frames.
pub fn collide_polys(a: &Poly, pose_a: Pose, b: &Poly, pose_b: Pose, limit: f32, out: &mut Manifold) {
    out.count = 0;
    let rel = pose_a.relative(pose_b);
    let Some((feature, separation)) = sat(a, b, rel, limit) else { return };
    match feature {
        Feature::FaceA(f) => {
            face_contact(a, b, rel, f, limit, out);
            out.normal = pose_a.q.rotate(out.normal);
            for point in out.points.iter_mut().take(out.count) {
                point.on_a = pose_a.apply(point.on_a);
                point.on_b = pose_a.apply(point.on_b);
            }
        }
        Feature::FaceB(f) => {
            face_contact(b, a, rel.inverse(), f, limit, out);
            // The reference is B, so the normal turns round and the two surfaces swap.
            out.normal = pose_b.q.rotate(out.normal).scale(-1.0);
            for point in out.points.iter_mut().take(out.count) {
                let (on_a, on_b) = (pose_b.apply(point.on_b), pose_b.apply(point.on_a));
                *point = Point { on_a, on_b, separation: point.separation, id: point.id | ID_FLIP };
            }
        }
        Feature::Edges(ea, eb, axis) => {
            let (pa, qa) = (a.vertex(a.origin(ea)), a.vertex(a.origin(a.next(ea))));
            let (pb, qb) = (rel.apply(b.vertex(b.origin(eb))), rel.apply(b.vertex(b.origin(b.next(eb)))));
            let (s, t) = closest_on_segments(pa, qa, pb, qb);
            let on_a = pa.add(qa.sub(pa).scale(s));
            let on_b = pb.add(qb.sub(pb).scale(t));
            out.normal = pose_a.q.rotate(axis);
            out.points[0] =
                Point { on_a: pose_a.apply(on_a), on_b: pose_a.apply(on_b), separation, id: ID_EDGES | ((ea as u32 & 0x3FFF) << 14) | (eb as u32 & 0x3FFF) };
            out.count = 1;
        }
    }
}

impl World {
    /// A collider's frame in world space.
    #[inline(always)]
    pub fn collider_pose(&self, c: usize) -> Pose {
        let at = self.uu(COLLIDER_BODY, c) as usize;
        let rotation = self.q(ROTATION_X, at);
        Pose { p: self.v(POSITION_X, at).add(rotation.rotate(self.v(COLLIDER_X, c))), q: rotation.mul(self.q(COLLIDER_ROTATION_X, c)) }
    }

    /// A box or hull collider as a polyhedron; a box keeps its numbers in `data`.
    #[inline(always)]
    fn poly(&self, c: usize, data: &mut BoxData) -> Poly {
        match self.uu(COLLIDER_SHAPE, c) {
            SHAPE_HULL => self.hull_poly(self.uu(COLLIDER_HULL, c) as usize),
            _ => box_poly(self.v(COLLIDER_A, c), data),
        }
    }

    /// How far apart two colliders may be and still touch before the step ends: the margin, what each can move in the
    /// step, and gravity's pull. Anything closer gets contact points now, so detection once a step serves every substep
    /// (Macklin et al. 2019).
    fn contact_limit(&self, a: usize, b: usize, dt: f32) -> f32 {
        let g = self.header().gravity;
        let pull = sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) * dt * dt;
        let mut limit = MARGIN + 2.0 * pull;
        for c in [a, b] {
            let at = self.uu(COLLIDER_BODY, c) as usize;
            let (linear, angular) = (self.v(LINEAR_X, at), self.v(ANGULAR_X, at));
            let rim = self.collider_reach(c);
            limit += (sqrt(linear.dot(linear)) + sqrt(angular.dot(angular)) * rim) * dt;
        }
        limit
    }

    /// The farthest a collider's surface lies from its body's centre of mass.
    fn collider_reach(&self, c: usize) -> f32 {
        let at = self.uu(COLLIDER_BODY, c) as usize;
        let offset = self.v(COLLIDER_X, c).sub(self.v(LOCAL_CENTER_X, at));
        let (x, y, z) = (self.s(COLLIDER_A, c), self.s(COLLIDER_B, c), self.s(COLLIDER_C, c));
        let radius = match self.uu(COLLIDER_SHAPE, c) {
            SHAPE_BALL => x,
            SHAPE_BOX => sqrt(x * x + y * y + z * z),
            SHAPE_HULL => {
                let hull = self.uu(COLLIDER_HULL, c) as usize;
                let center = self.v(HULL_CENTER_X, hull);
                self.s(HULL_RADIUS, hull) + sqrt(center.dot(center))
            }
            _ => x + y,
        };
        sqrt(offset.dot(offset)) + radius
    }

    /// One manifold between two colliders.
    pub fn collide(&self, a: usize, b: usize, limit: f32, out: &mut Manifold) {
        out.count = 0;
        let (shape_a, shape_b) = (self.uu(COLLIDER_SHAPE, a), self.uu(COLLIDER_SHAPE, b));
        let polyhedral = |shape: u32| shape == SHAPE_BOX || shape == SHAPE_HULL;
        if polyhedral(shape_a) && polyhedral(shape_b) {
            let (mut data_a, mut data_b) = (BoxData::new(), BoxData::new());
            let (poly_a, poly_b) = (self.poly(a, &mut data_a), self.poly(b, &mut data_b));
            collide_polys(&poly_a, self.collider_pose(a), &poly_b, self.collider_pose(b), limit, out);
        }
    }

    /// Writes a manifold into a pair's rows, with anchors from each body's centre of mass in each body's frame.
    fn store_manifold(&mut self, row: usize, a: usize, b: usize, manifold: &Manifold) {
        self.set_u(PAIR_CONTACTS, row, manifold.count as u32);
        self.set_v(PAIR_NORMAL_X, row, manifold.normal);
        let (rotation_a, rotation_b) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
        let center_a = self.v(POSITION_X, a).add(rotation_a.rotate(self.v(LOCAL_CENTER_X, a)));
        let center_b = self.v(POSITION_X, b).add(rotation_b.rotate(self.v(LOCAL_CENTER_X, b)));
        for (k, point) in manifold.points.iter().enumerate().take(manifold.count) {
            let at = row * MANIFOLD + k;
            self.set_v(CONTACT_ANCHOR_A_X, at, rotation_a.unrotate(point.on_a.sub(center_a)));
            self.set_v(CONTACT_ANCHOR_B_X, at, rotation_b.unrotate(point.on_b.sub(center_b)));
            self.set_s(CONTACT_SEPARATION, at, point.separation);
            self.set_u(CONTACT_ID, at, point.id);
            self.set_v(CONTACT_X, at, point.on_a.add(point.on_b).scale(0.5));
        }
    }

    /// Finds the manifold of every pair with an awake body. A pair of two sleepers keeps the one it has.
    pub fn narrow_phase(&mut self, dt: f32) {
        let mut manifold = Manifold::new();
        for i in 0..self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i) as usize;
            let (a, b) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            let (body_a, body_b) = (self.uu(COLLIDER_BODY, a) as usize, self.uu(COLLIDER_BODY, b) as usize);
            // Scripted bodies pass through each other: nothing can push them.
            if self.flags(body_a) & KIND != DYNAMIC && self.flags(body_b) & KIND != DYNAMIC {
                self.set_u(PAIR_CONTACTS, row, 0);
                continue;
            }
            let limit = self.contact_limit(a, b, dt);
            self.collide(a, b, limit, &mut manifold);
            self.store_manifold(row, body_a, body_b, &manifold);
        }
    }
}
