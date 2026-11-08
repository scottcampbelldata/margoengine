// The narrow phase: for each pair the broad phase found near, one manifold, a set of points that share a normal. One-shot,
// as Gregorius 2015 sets out: find the touching features, then clip one face against the side planes of the other, so a
// box resting on a box has all its points from the first frame, with no artificial torque while they gather.
use crate::broad::MARGIN;
use crate::events::groups_meet;
use crate::gjk::{Posed, Segment, epa, gjk};
use crate::hull::{BoxData, Poly, box_poly};
use crate::layout::*;
use crate::math::*;
use crate::sat::{Feature, Pose, closest_on_segments, sat_coherent};
use crate::world::World;
use core::mem::MaybeUninit;

/// A clipped polygon's most vertices: a largest face, plus one for each side plane of another.
const CLIP: usize = 2 * MAX_FACE_EDGES as usize;

// A point's id says which features made it, so that it can be recognised in the next step. The top bit is set when B
// holds the reference face; then a kind, then two small numbers.
const ID_FLIP: u32 = 1 << 31;
const ID_CLIPPED: u32 = 1 << 30;
const ID_EDGES: u32 = 1 << 29;
// Round shapes: one point, or the two ends of what a capsule shares with a face or another capsule.
pub(crate) const ID_END: u32 = 1 << 28;
/// A capsule lies along a face or another capsule when the cosine between the normals is past this, about 2.6 degrees.
const PARALLEL: f32 = 0.999;
/// Centres closer than this have no direction between them.
const COINCIDENT: f32 = 1e-6;

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
    /// What the pair held last step, for the coherence of this one: its point ids, how many, and the feature that won.
    pub held: [u32; MANIFOLD],
    pub held_count: usize,
    pub feature: u32,
}

impl Manifold {
    pub fn new() -> Self {
        let zero = v3(0.0, 0.0, 0.0);
        Self { normal: zero, count: 0, points: [Point { on_a: zero, on_b: zero, separation: 0.0, id: 0 }; MANIFOLD], held: [0; MANIFOLD], held_count: 0, feature: 0 }
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

/// Room for a clipped polygon. Left unwritten, as a face may hold 256 edges and a cleared buffer would cost every contact the
/// largest face's worth of stores; only the first `count` are ever read.
type Buffer<T> = [MaybeUninit<T>; CLIP];

/// The first `count` entries of a buffer, which the caller wrote.
#[inline(always)]
fn written<T>(buffer: &Buffer<T>, count: usize) -> &[T] {
    debug_assert!(count <= CLIP);
    unsafe { core::slice::from_raw_parts(buffer.as_ptr() as *const T, count) }
}

/// Clips `input` against the plane `normal . x <= offset`, by Sutherland and Hodgman, and returns how many vertices are left.
fn clip(input: &[ClipVertex], output: &mut Buffer<ClipVertex>, normal: V3, offset: f32, plane: u32) -> usize {
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
            output[count] = MaybeUninit::new(ClipVertex { p, id, edge });
            count += 1;
        }
        if distance <= 0.0 && count < CLIP {
            output[count] = MaybeUninit::new(vertex);
            count += 1;
        }
        previous = vertex;
        distance_previous = distance;
    }
    count
}

/// How much better than a point the pair held last step a new one must score, as a fraction: a tiny turn must not swap a
/// point for its neighbour, or the solver loses what the point carried and the stack shakes.
const STICK: f32 = 0.05;
/// The same for depth, in metres.
const STICK_DEPTH: f32 = 1e-3;

/// Four of the points, spanning the largest area they can, by the iteration of Gregorius 2015: the deepest point, so
/// nothing about to tunnel is dropped, then the point farthest from it, then the largest triangle on that edge, then the
/// point adding the most area outside the triangle, which is a product and a sign rather than a distance. The points lie
/// on one plane with this `normal`. Gregorius takes the third point by signed area alone; here it is by size, with the
/// edge turned to suit, so a set lying wholly on one side of the edge is served as well. `held` are last step's ids.
pub fn reduce(points: &[Point], count: usize, normal: V3, held: &[u32], out: &mut Manifold) {
    if count <= MANIFOLD {
        out.points[..count].copy_from_slice(&points[..count]);
        out.count = count;
        return;
    }
    let is_held = |i: usize| held.iter().any(|&id| id & !ID_FLIP == points[i].id & !ID_FLIP);
    let favour = |i: usize, score: f32| if is_held(i) { score * (1.0 + STICK) } else { score };
    let (mut a, mut deepest) = (0, f32::INFINITY);
    for i in 0..count {
        let depth = points[i].separation - if is_held(i) { STICK_DEPTH } else { 0.0 };
        if depth < deepest {
            deepest = depth;
            a = i;
        }
    }
    let at = |i: usize| points[i].on_a;
    let (mut b, mut farthest) = (a, -1.0);
    for i in 0..count {
        let between = at(i).sub(at(a));
        let score = favour(i, between.dot(between));
        if i != a && score > farthest {
            farthest = score;
            b = i;
        }
    }
    // Twice the signed area of a triangle, seen from the normal's side.
    let area = |x: usize, y: usize, z: usize| at(y).sub(at(x)).cross(at(z).sub(at(x))).dot(normal);
    let (mut c, mut largest) = (a, -1.0);
    for i in 0..count {
        let score = favour(i, area(a, b, i).abs());
        if i != a && i != b && score > largest {
            largest = score;
            c = i;
        }
    }
    if area(a, b, c) < 0.0 {
        core::mem::swap(&mut a, &mut b);
    }
    let (mut d, mut added) = (count, 0.0);
    for i in 0..count {
        if i == a || i == b || i == c {
            continue;
        }
        let (ab, bc, ca) = (area(a, b, i), area(b, c, i), area(c, a, i));
        let outside = if ab < bc { ab } else { bc };
        let outside = if outside < ca { outside } else { ca };
        let score = favour(i, -outside);
        if outside < 0.0 && score > added {
            added = score;
            d = i;
        }
    }
    out.points[0] = points[a];
    out.points[1] = points[b];
    out.points[2] = points[c];
    out.count = 3;
    if d < count {
        out.points[3] = points[d];
        out.count = 4;
    }
}

/// A face contact (Gregorius 2015): the face of `reference` is the reference face, the most anti-parallel face of
/// `incident` is clipped against its side planes, points below `limit` stay and move onto the reference face. Results are
/// in `reference`'s frame, with the normal from `reference` to `incident` and `on_a` on the reference.
pub(crate) fn face_contact(reference: &Poly, incident: &Poly, rel: Pose, face: usize, limit: f32, out: &mut Manifold) {
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
    let mut first: Buffer<ClipVertex> = [const { MaybeUninit::uninit() }; CLIP];
    let mut second: Buffer<ClipVertex> = [const { MaybeUninit::uninit() }; CLIP];
    let mut count = 0;
    let start = incident.first(chosen);
    let mut e = start;
    loop {
        let vertex = incident.origin(e);
        first[count] = MaybeUninit::new(ClipVertex { p: rel.apply(incident.vertex(vertex)), id: vertex as u32, edge: count as u32 });
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
            clip(written(&first, count), &mut second, side, side.dot(a), plane)
        } else {
            clip(written(&second, count), &mut first, side, side.dot(a), plane)
        };
        plane += 1;
        e = next;
        if e == start || count == 0 {
            break;
        }
    }
    let polygon = written(if plane & 1 == 0 { &first } else { &second }, count);
    let mut points: Buffer<Point> = [const { MaybeUninit::uninit() }; CLIP];
    let mut kept = 0;
    for vertex in polygon {
        let separation = n.dot(vertex.p) - offset;
        if separation <= limit {
            points[kept] = MaybeUninit::new(Point { on_a: vertex.p.sub(n.scale(separation)), on_b: vertex.p, separation, id: vertex.id });
            kept += 1;
        }
    }
    out.normal = n;
    let held = out.held;
    reduce(written(&points, kept), kept, n, &held[..out.held_count], out);
}

/// A manifold between two polyhedra, in world space. `pose_a` and `pose_b` are the shapes' frames.
pub fn collide_polys(a: &Poly, pose_a: Pose, b: &Poly, pose_b: Pose, limit: f32, out: &mut Manifold) {
    out.count = 0;
    let rel = pose_a.relative(pose_b);
    let Some((feature, separation)) = sat_coherent(a, b, rel, limit, Feature::from_code(out.feature)) else { return };
    out.feature = feature.code();
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

/// A round shape: a ball is a point with a radius, a capsule a segment with one (Gregorius 2015), in world space.
#[derive(Clone, Copy)]
pub(crate) struct Round {
    pub p: V3,
    pub q: V3,
    pub radius: f32,
}

/// Any unit vector square to `v`.
fn square_to(v: V3) -> V3 {
    let a = v.abs();
    let axis = if a.x <= a.y && a.x <= a.z {
        v3(1.0, 0.0, 0.0)
    } else if a.y <= a.z {
        v3(0.0, 1.0, 0.0)
    } else {
        v3(0.0, 0.0, 1.0)
    };
    let c = v.cross(axis);
    let squared = c.dot(c);
    if squared > 0.0 { c.scale(1.0 / sqrt(squared)) } else { v3(0.0, 1.0, 0.0) }
}

/// Two round shapes: the closest points of their cores, with a sphere around each. Two capsules lying side by side get
/// two points, the first core clipped against the ends of the second, or they would spin on one (Gregorius 2015).
fn collide_rounds(a: Round, b: Round, limit: f32, out: &mut Manifold) {
    out.count = 0;
    let (s, t) = closest_on_segments(a.p, a.q, b.p, b.q);
    let (axis_a, axis_b) = (a.q.sub(a.p), b.q.sub(b.p));
    let (on_a, on_b) = (a.p.add(axis_a.scale(s)), b.p.add(axis_b.scale(t)));
    let between = on_b.sub(on_a);
    let distance = sqrt(between.dot(between));
    let radii = a.radius + b.radius;
    if distance - radii > limit {
        return;
    }
    let normal = if distance > COINCIDENT {
        between.scale(1.0 / distance)
    } else {
        // Cores that meet: across both when they cross, else any way square to the one there is, else up.
        let c = axis_a.cross(axis_b);
        if c.dot(c) > 1e-10 {
            c.scale(1.0 / sqrt(c.dot(c)))
        } else if axis_a.dot(axis_a) > 0.0 {
            square_to(axis_a)
        } else if axis_b.dot(axis_b) > 0.0 {
            square_to(axis_b)
        } else {
            v3(0.0, 1.0, 0.0)
        }
    };
    out.normal = normal;
    let (length_a, length_b) = (axis_a.dot(axis_a), axis_b.dot(axis_b));
    if length_a > 0.0 && length_b > 0.0 {
        let cosine = axis_a.dot(axis_b);
        if cosine * cosine > PARALLEL * PARALLEL * length_a * length_b {
            // Where B's core lies along A's.
            let along = |x: V3| x.sub(a.p).dot(axis_a) / length_a;
            let (low, high) = (along(b.p), along(b.q));
            let (low, high) = if low < high { (low, high) } else { (high, low) };
            let (low, high) = (if low < 0.0 { 0.0 } else { low }, if high > 1.0 { 1.0 } else { high });
            if high > low {
                let mut count = 0;
                for (end, at) in [low, high].iter().enumerate() {
                    let on_core = a.p.add(axis_a.scale(*at));
                    let t = on_core.sub(b.p).dot(axis_b) / length_b;
                    let t = if t < 0.0 { 0.0 } else if t > 1.0 { 1.0 } else { t };
                    let across = b.p.add(axis_b.scale(t));
                    let separation = across.sub(on_core).dot(normal) - radii;
                    if separation <= limit {
                        let on_a = on_core.add(normal.scale(a.radius));
                        let on_b = across.sub(normal.scale(b.radius));
                        out.points[count] = Point { on_a, on_b, separation, id: ID_END | end as u32 };
                        count += 1;
                    }
                }
                out.count = count;
                if count > 0 {
                    return;
                }
            }
        }
    }
    out.points[0] = Point { on_a: on_a.add(normal.scale(a.radius)), on_b: on_b.sub(normal.scale(b.radius)), separation: distance - radii, id: 0 };
    out.count = 1;
}

/// A round shape and a polyhedron. The core goes to GJK: shallow, its distance to the polyhedron gives the point; deep,
/// with the core inside, the expanding polytope gives the way out (Gregorius 2015 uses a SAT there; this kernel takes the
/// plan's route, which also serves shapes with no faces). Normal from the round shape to the polyhedron, in world space.
pub(crate) fn collide_round_poly(round: Round, poly: &Poly, pose: Pose, limit: f32, out: &mut Manifold) {
    out.count = 0;
    let core = Segment { p: pose.unapply(round.p), q: pose.unapply(round.q) };
    let posed = Posed { shape: poly, pose: Pose { p: v3(0.0, 0.0, 0.0), q: Q::IDENTITY } };
    let first = core.p.sub(poly.center);
    let found = gjk(&core, &posed, first, limit + round.radius);
    if found.apart {
        return;
    }
    let (normal, on_core, on_poly, gap);
    if !found.overlap && found.distance > COINCIDENT {
        let between = found.on_b.sub(found.on_a);
        normal = between.scale(1.0 / found.distance);
        on_core = found.on_a;
        on_poly = found.on_b;
        gap = found.distance;
    } else {
        let Some(way_out) = epa(&core, &posed, &found) else { return };
        normal = way_out.normal;
        on_core = way_out.on_a;
        on_poly = way_out.on_b;
        gap = -way_out.depth;
    }
    let separation = gap - round.radius;
    if separation > limit {
        return;
    }
    out.normal = pose.q.rotate(normal);
    if core.p != core.q && edge_on_face(&core, poly, normal, round.radius, limit, pose, out) {
        return;
    }
    let surface = on_core.add(normal.scale(round.radius));
    out.points[0] = Point { on_a: pose.apply(surface), on_b: pose.apply(on_poly), separation, id: 0 };
    out.count = 1;
}

/// When a capsule lies against a face, its core clipped against the face's side planes gives two points at once
/// (Gregorius 2015, slides 76 to 78). All in the polyhedron's frame until the points go out. False when no face faces it.
fn edge_on_face(core: &Segment, poly: &Poly, normal: V3, radius: f32, limit: f32, pose: Pose, out: &mut Manifold) -> bool {
    let (mut face, mut best) = (0, PARALLEL);
    let mut found = false;
    for f in 0..poly.faces {
        let along = -poly.normal(f).dot(normal);
        if along > best {
            best = along;
            face = f;
            found = true;
        }
    }
    if !found {
        return false;
    }
    let n = poly.normal(face);
    let (mut p, mut q) = (core.p, core.q);
    let start = poly.first(face);
    let mut e = start;
    loop {
        let next = poly.next(e);
        let (a, b) = (poly.vertex(poly.origin(e)), poly.vertex(poly.origin(next)));
        let side = b.sub(a).cross(n);
        let (dp, dq) = (side.dot(p.sub(a)), side.dot(q.sub(a)));
        if dp > 0.0 && dq > 0.0 {
            return false;
        }
        if dp > 0.0 {
            p = p.add(q.sub(p).scale(dp / (dp - dq)));
        } else if dq > 0.0 {
            q = q.add(p.sub(q).scale(dq / (dq - dp)));
        }
        e = next;
        if e == start {
            break;
        }
    }
    let offset = poly.plane(face);
    let mut count = 0;
    for (end, at) in [p, q].iter().enumerate() {
        let height = n.dot(*at) - offset;
        let separation = height - radius;
        if separation <= limit {
            let on_face = at.sub(n.scale(height));
            let surface = at.sub(n.scale(radius));
            out.points[count] = Point { on_a: pose.apply(surface), on_b: pose.apply(on_face), separation, id: ID_END | end as u32 };
            count += 1;
        }
    }
    out.count = count;
    out.normal = pose.q.rotate(n.scale(-1.0));
    count > 0
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
    pub(crate) fn poly_of(&self, c: usize, data: &mut BoxData) -> Poly {
        self.poly(c, data)
    }

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
    #[inline(always)]
    pub(crate) fn contact_limit_of(&self, a: usize, b: usize, dt: f32) -> f32 {
        self.contact_limit(a, b, dt)
    }

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

    /// The farthest a collider's surface lies from its body's centre of mass, for the CCD pass.
    pub(crate) fn collider_reach_of(&self, c: usize) -> f32 {
        self.collider_reach(c)
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
            SHAPE_TRIMESH => {
                let mesh = self.uu(COLLIDER_HULL, c) as usize;
                let center = self.v(MESH_BOX_X, mesh);
                self.s(MESH_RADIUS, mesh) + sqrt(center.dot(center))
            }
            _ => x + y,
        };
        sqrt(offset.dot(offset)) + radius
    }

    /// A ball or capsule collider in world space.
    #[inline(always)]
    pub(crate) fn round_of(&self, c: usize) -> Round {
        self.round(c)
    }

    #[inline(always)]
    fn round(&self, c: usize) -> Round {
        let pose = self.collider_pose(c);
        let radius = self.s(COLLIDER_A, c);
        if self.uu(COLLIDER_SHAPE, c) == SHAPE_BALL {
            return Round { p: pose.p, q: pose.p, radius };
        }
        let along = pose.q.rotate(v3(0.0, self.s(COLLIDER_B, c), 0.0));
        Round { p: pose.p.sub(along), q: pose.p.add(along), radius }
    }

    /// One manifold between two colliders, from `a` to `b`.
    pub fn collide(&self, a: usize, b: usize, limit: f32, out: &mut Manifold) {
        out.count = 0;
        let (shape_a, shape_b) = (self.uu(COLLIDER_SHAPE, a), self.uu(COLLIDER_SHAPE, b));
        let polyhedral = |shape: u32| shape == SHAPE_BOX || shape == SHAPE_HULL;
        let (mut data_a, mut data_b) = (BoxData::new(), BoxData::new());
        match (polyhedral(shape_a), polyhedral(shape_b)) {
            (true, true) => {
                let (poly_a, poly_b) = (self.poly(a, &mut data_a), self.poly(b, &mut data_b));
                collide_polys(&poly_a, self.collider_pose(a), &poly_b, self.collider_pose(b), limit, out);
            }
            (false, true) => {
                let poly = self.poly(b, &mut data_b);
                collide_round_poly(self.round(a), &poly, self.collider_pose(b), limit, out);
            }
            (true, false) => {
                let poly = self.poly(a, &mut data_a);
                collide_round_poly(self.round(b), &poly, self.collider_pose(a), limit, out);
                // That found the normal from B to A.
                out.normal = out.normal.scale(-1.0);
                for point in out.points.iter_mut().take(out.count) {
                    core::mem::swap(&mut point.on_a, &mut point.on_b);
                }
            }
            (false, false) => collide_rounds(self.round(a), self.round(b), limit, out),
        }
    }

    /// Finds the manifold of every pair with an awake body. A pair of two sleepers keeps the one it has.
    pub fn narrow_phase(&mut self, dt: f32) {
        let mut manifold = Manifold::new();
        let h = dt / self.header().substeps as f32;
        let before = self.header().contact_substep;
        let ratio = if before > 0.0 { h / before } else { 1.0 };
        self.header_mut().contact_substep = h;
        self.header_mut().substep_ratio = ratio;
        for i in 0..self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i) as usize;
            let flags = self.uu(PAIR_FLAGS, row) & !PAIR_OVERLAP;
            // A part is its mesh pair's to fill.
            if flags & PAIR_IS_PART != 0 {
                continue;
            }
            let (a, b) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            let (body_a, body_b) = (self.uu(COLLIDER_BODY, a) as usize, self.uu(COLLIDER_BODY, b) as usize);
            let meshed = self.uu(COLLIDER_SHAPE, a) == SHAPE_TRIMESH || self.uu(COLLIDER_SHAPE, b) == SHAPE_TRIMESH;
            let compound = self.has_compound(a, b);
            let sensor = (self.uu(COLLIDER_FLAGS, a) | self.uu(COLLIDER_FLAGS, b)) & COLLIDER_SENSOR != 0;
            // Scripted bodies pass through each other: nothing can push them. A sensor still sees them.
            let scripted = self.flags(body_a) & KIND != DYNAMIC && self.flags(body_b) & KIND != DYNAMIC;
            if scripted && !sensor || !self.may_touch(a, b, body_a, body_b) {
                self.set_u(PAIR_FLAGS, row, flags);
                self.drop_contacts(row, body_a, body_b);
                continue;
            }
            // A pair nothing solves needs to know only that it overlaps.
            if sensor || !groups_meet(self.uu(COLLIDER_SOLVER_GROUPS, a), self.uu(COLLIDER_SOLVER_GROUPS, b)) {
                manifold.held_count = 0;
                manifold.feature = 0;
                let overlaps = if compound {
                    self.compound_overlaps(a, b)
                } else if meshed {
                    self.mesh_overlaps(a, b)
                } else {
                    self.collide(a, b, 0.0, &mut manifold);
                    manifold.points[..manifold.count].iter().any(|point| point.separation <= 0.0)
                };
                self.set_u(PAIR_FLAGS, row, if overlaps { flags | PAIR_OVERLAP } else { flags });
                self.drop_contacts(row, body_a, body_b);
                continue;
            }
            self.set_u(PAIR_FLAGS, row, flags);
            if compound {
                self.compound_pair(row, a, b, dt, ratio);
                continue;
            }
            let limit = self.contact_limit(a, b, dt);
            if meshed {
                self.mesh_pair(row, a, b, limit, ratio);
                continue;
            }
            manifold.held_count = self.uu(PAIR_CONTACTS, row) as usize;
            for k in 0..manifold.held_count {
                manifold.held[k] = self.uu(CONTACT_ID, row * MANIFOLD + k);
            }
            manifold.feature = self.uu(PAIR_FEATURE, row);
            self.collide(a, b, limit, &mut manifold);
            self.set_u(PAIR_FEATURE, row, if manifold.count > 0 { manifold.feature } else { 0 });
            if manifold.count == 0 {
                self.drop_contacts(row, body_a, body_b);
            }
            self.store_manifold(row, body_a, body_b, &manifold, ratio);
        }
        self.sweep_parts();
    }
}
