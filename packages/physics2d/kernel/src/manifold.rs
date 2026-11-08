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

impl Placed {
    fn edge(&self, i: usize) -> (V2, V2) {
        (self.vertices[i], self.vertices[(i + 1) % self.count])
    }
    /// The segment of feature `i` for distance tests: the point itself for a circle, the one segment of a capsule.
    fn segments(&self) -> usize {
        match self.count {
            1 | 2 => 1,
            n => n,
        }
    }
}

/// The face of `a` with the largest separation from the core `b`: (separation, edge); (-inf, none) with no faces.
fn best_face(a: &Placed, b: &Placed) -> (f32, usize) {
    let mut best = (f32::NEG_INFINITY, usize::MAX);
    for i in 0..a.edges {
        let (n, v) = (a.normals[i], a.vertices[i]);
        let mut least = f32::INFINITY;
        for j in 0..b.count {
            least = least.min(n.dot(b.vertices[j].sub(v)));
        }
        if least > best.0 {
            best = (least, i);
        }
    }
    best
}

/// The closest points of two cores that do not overlap: (distance, point on a, point on b, id).
fn closest(a: &Placed, b: &Placed) -> (f32, V2, V2, u32) {
    let mut best = (f32::INFINITY, V2::ZERO, V2::ZERO, 0);
    let feature = |count: usize, segment: usize, t: f32| -> u32 {
        // A vertex is its index; an edge is 0x800 plus its index; a circle's point is vertex 0.
        if count == 1 || t <= 0.0 {
            segment as u32
        } else if t >= 1.0 {
            ((segment + 1) % count) as u32
        } else {
            0x800 | segment as u32
        }
    };
    for i in 0..b.count {
        for s in 0..a.segments() {
            let (p, q) = a.edge(s);
            let (on_a, t) = closest_on_segment(b.vertices[i], p, q);
            let d = b.vertices[i].sub(on_a).length_squared();
            if d < best.0 {
                best = (d, on_a, b.vertices[i], pair_id(feature(a.count, s, t), i as u32));
            }
        }
    }
    for i in 0..a.count {
        for s in 0..b.segments() {
            let (p, q) = b.edge(s);
            let (on_b, t) = closest_on_segment(a.vertices[i], p, q);
            let d = a.vertices[i].sub(on_b).length_squared();
            if d < best.0 {
                best = (d, a.vertices[i], on_b, pair_id(i as u32, feature(b.count, s, t)));
            }
        }
    }
    (crate::math::sqrt(best.0), best.1, best.2, best.3)
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
    let mut manifold = Manifold::default();
    // Work in A's frame.
    let pa = place(a, Xf::IDENTITY);
    let pb = place(b, xa.inverse_mul(xb));
    let radii = a.radius + b.radius;
    let face_a = best_face(&pa, &pb);
    let face_b = best_face(&pb, &pa);
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
        let (distance, on_a, on_b, id) = closest(&pa, &pb);
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
                if choice { (&pb, &pa, b.radius, a.radius) } else { (&pa, &pb, a.radius, b.radius) };
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
                if flip { pb.normals[reference.1].neg() } else { pa.normals[reference.1] }
            } else {
                v2(0.0, 1.0)
            };
            let surface_a = on_a.add(normal.scale(a.radius));
            let surface_b = on_b.sub(normal.scale(b.radius));
            manifold.normal = xa.q.apply(normal);
            manifold.points[0] = ManifoldPoint { point: xa.apply(surface_a.lerp(surface_b, 0.5)), separation: distance - radii, id };
            manifold.count = 1;
            return manifold;
        }
    } else {
        let reference = if flip { face_b } else { face_a };
        let (owner, other, owner_radius, other_radius) =
            if flip { (&pb, &pa, b.radius, a.radius) } else { (&pa, &pb, a.radius, b.radius) };
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
pub(crate) fn clip(m: &mut Manifold, owner: &Placed, other: &Placed, edge: usize, flip: bool, owner_radius: f32, other_radius: f32, speculative: f32) {
    let n = owner.normals[edge];
    let (r1, r2) = owner.edge(edge);
    // The incident edge: the face of `other` most against the reference normal; a circle's one point.
    let (mut points, mut ends, mut incident) = ([V2::ZERO; 2], [0usize; 2], 0usize);
    let count;
    if other.edges == 0 {
        points[0] = other.vertices[0];
        count = 1;
    } else {
        let mut least = f32::INFINITY;
        for j in 0..other.edges {
            let d = other.normals[j].dot(n);
            if d < least {
                least = d;
                incident = j;
            }
        }
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
