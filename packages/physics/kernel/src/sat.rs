// The separating axis test between two convex polyhedra, as Gregorius 2015 recaps it: the possible axes are the face
// normals of each and the crosses of their edges. A face query takes the support point of the other hull against each
// plane; an edge query takes a plane through an edge, with its normal pointing away from the first hull. The largest
// separation names the axis of least penetration and the features that touch.
//
// An edge pair matters only when it makes a face of the Minkowski difference, which is when the arcs its faces' normals
// draw on the unit sphere cross, the second pair of normals negated. That test costs a few products and spares each
// other pair a projection. Gregorius 2013, which the 2015 talk points to for it, could not be fetched: the test is written
// from that definition.
use crate::hull::Poly;
use crate::math::*;

/// A pose: `apply` takes a point from this frame to its parent's.
#[derive(Clone, Copy, Debug)]
pub struct Pose {
    pub p: V3,
    pub q: Q,
}

impl Pose {
    #[inline(always)]
    pub fn apply(self, v: V3) -> V3 {
        self.p.add(self.q.rotate(v))
    }
    #[inline(always)]
    pub fn unapply(self, v: V3) -> V3 {
        self.q.unrotate(v.sub(self.p))
    }
    /// `other`, given in the parent's frame, seen from this frame.
    #[inline(always)]
    pub fn relative(self, other: Pose) -> Pose {
        Pose { p: self.unapply(other.p), q: self.q.conjugate().mul(other.q) }
    }
    #[inline(always)]
    pub fn inverse(self) -> Pose {
        let q = self.q.conjugate();
        Pose { p: q.rotate(self.p).scale(-1.0), q }
    }
}

/// What realises the largest separation.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Feature {
    FaceA(usize),
    FaceB(usize),
    /// Half-edges of A and B, and the axis in A's frame, pointing from A to B.
    Edges(usize, usize, V3),
}

/// How much a face must lose by before an edge pair or B's face replaces it, in metres. Often several axes tie; contact
/// points stay coherent when the same kind of feature wins each time (Gregorius 2015).
const FACE_BIAS: f32 = 1e-3;
/// Edges closer to parallel than this sine squared give no axis: their faces' normals cover the case.
const PARALLEL: f32 = 1e-6;

/// The face of `a` that lies farthest from `b`, and how far. `rel` is `b` in `a`'s frame.
fn query_faces(a: &Poly, b: &Poly, rel: Pose) -> (usize, f32) {
    let (mut best, mut most) = (0, f32::NEG_INFINITY);
    for f in 0..a.faces {
        let n = a.normal(f);
        let local = rel.q.unrotate(n);
        let support = b.support(local.scale(-1.0));
        let distance = n.dot(rel.p) + local.dot(support) - a.plane(f);
        if distance > most {
            most = distance;
            best = f;
        }
    }
    (best, most)
}

/// True when the arc from `a` to `b` crosses the arc from `c` to `d` on the unit sphere. `bxa` and `dxc` are the normals of
/// the arcs' planes. The ends of each arc lie on opposite sides of the other's plane, and on the same side of the sphere.
#[inline(always)]
fn arcs_cross(a: V3, b: V3, c: V3, d: V3, bxa: V3, dxc: V3) -> bool {
    let (cba, dba, adc, bdc) = (c.dot(bxa), d.dot(bxa), a.dot(dxc), b.dot(dxc));
    cba * dba < 0.0 && adc * bdc < 0.0 && cba * bdc > 0.0
}

/// The edge pair with the largest separation, in `a`'s frame. None when no pair makes a Minkowski face.
fn query_edges(a: &Poly, b: &Poly, rel: Pose) -> Option<(usize, usize, V3, f32)> {
    let mut best = None;
    let mut most = f32::NEG_INFINITY;
    for eb in 0..b.edges {
        let tb = b.twin(eb);
        if tb < eb {
            continue;
        }
        let (pb, qb) = (rel.apply(b.vertex(b.origin(eb))), rel.apply(b.vertex(b.origin(b.next(eb)))));
        let direction_b = qb.sub(pb);
        // Normals of B's faces, negated: the Minkowski difference holds B turned inside out.
        let c = rel.q.rotate(b.normal(b.face(eb))).scale(-1.0);
        let d = rel.q.rotate(b.normal(b.face(tb))).scale(-1.0);
        let dxc = d.cross(c);
        for ea in 0..a.edges {
            let ta = a.twin(ea);
            if ta < ea {
                continue;
            }
            let (na, nb) = (a.normal(a.face(ea)), a.normal(a.face(ta)));
            let bxa = nb.cross(na);
            if !arcs_cross(na, nb, c, d, bxa, dxc) {
                continue;
            }
            let (pa, qa) = (a.vertex(a.origin(ea)), a.vertex(a.origin(a.next(ea))));
            let direction_a = qa.sub(pa);
            let axis = direction_a.cross(direction_b);
            let squared = axis.dot(axis);
            if !(squared > PARALLEL * direction_a.dot(direction_a) * direction_b.dot(direction_b)) {
                continue;
            }
            let mut n = axis.scale(1.0 / sqrt(squared));
            if n.dot(pa.sub(a.center)) < 0.0 {
                n = n.scale(-1.0);
            }
            let distance = n.dot(pb.sub(pa));
            if distance > most {
                most = distance;
                best = Some((ea, eb, n, distance));
            }
        }
    }
    best
}

/// The separating axis test. `rel` is `b` in `a`'s frame. None when some axis separates the two by more than `limit`.
/// Otherwise the feature with the largest separation, which is negative when the shapes overlap.
pub fn sat(a: &Poly, b: &Poly, rel: Pose, limit: f32) -> Option<(Feature, f32)> {
    let (face_a, separation_a) = query_faces(a, b, rel);
    if separation_a > limit {
        return None;
    }
    let inverse = rel.inverse();
    let (face_b, separation_b) = query_faces(b, a, inverse);
    if separation_b > limit {
        return None;
    }
    let (face, face_separation) =
        if separation_b > separation_a + FACE_BIAS { (Feature::FaceB(face_b), separation_b) } else { (Feature::FaceA(face_a), separation_a) };
    if let Some((ea, eb, axis, separation)) = query_edges(a, b, rel) {
        if separation > limit {
            return None;
        }
        if separation > face_separation + FACE_BIAS {
            return Some((Feature::Edges(ea, eb, axis), separation));
        }
    }
    Some((face, face_separation))
}

/// The closest points of two segments as parameters on each, from setting both partial derivatives of the squared distance
/// to zero and clamping in turn. Parallel segments take the first segment's middle of what they share.
pub fn closest_on_segments(p1: V3, q1: V3, p2: V3, q2: V3) -> (f32, f32) {
    let (d1, d2, r) = (q1.sub(p1), q2.sub(p2), p1.sub(p2));
    let (a, e, f) = (d1.dot(d1), d2.dot(d2), d2.dot(r));
    let clamp = |x: f32| if x < 0.0 { 0.0 } else if x > 1.0 { 1.0 } else { x };
    if a <= 1e-12 && e <= 1e-12 {
        return (0.0, 0.0);
    }
    if a <= 1e-12 {
        return (0.0, clamp(f / e));
    }
    let c = d1.dot(r);
    if e <= 1e-12 {
        return (clamp(-c / a), 0.0);
    }
    let b = d1.dot(d2);
    let denominator = a * e - b * b;
    let mut s = if denominator > 1e-7 * a * e { clamp((b * f - c * e) / denominator) } else { 0.5 };
    let mut t = (b * s + f) / e;
    if t < 0.0 {
        t = 0.0;
        s = clamp(-c / a);
    } else if t > 1.0 {
        t = 1.0;
        s = clamp((b - c) / a);
    }
    (s, t)
}
