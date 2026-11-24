// The internal edges of a compound, Rapier's `CompoundFlags::FIX_INTERNAL_EDGES`: a compound made of convex parts that meet face to
// face (the cuts of a convex decomposition) is one solid, but each part collides alone, so a shape sliding over the join feels the
// edge of the part it is on: the normal of a contact on that edge leans towards the cut, and a ball catches on a ledge the union
// does not have. Two fixes, both from the same reading of the parts' faces (Catto 2020, "Ghost Collisions", box2d.org, for the rule
// that a normal outside the surface's own cone is the face's; Ericson 2005, "Real-Time Collision Detection", 5.3.4 and 5.4 for the
// plane and polygon tests):
//
// - A face of a part that another part covers, opposite and in the same plane and wholly (every corner of it inside the other's face), is a cut: it is inside the
//   union, and a contact on it, with the cut's normal, is dropped.
// - An edge between an outline face and a cut, where another part's face goes on in the outline's plane across the edge, is a
//   flat edge of the union: a contact on it whose normal is anything but the outline face's is clamped to that normal.
//
// Parts that are hulls are read; a part that is not (a box or a ball) is outline all round.
use crate::hull::Poly;
use crate::layout::*;
use crate::math::*;
use crate::narrow::Manifold;
use crate::sat::Pose;
use crate::world::{NONE, World};

/// Most corners of a face read; a larger face is outline.
const CORNERS: usize = 64;

/// A face's corners in the compound's frame, and the face's normal and plane there; None for a face with too many corners.
fn face_in(poly: &Poly, f: usize, pose: Pose) -> Option<([V3; CORNERS], usize, V3, f32)> {
    let mut corners = [v3(0.0, 0.0, 0.0); CORNERS];
    let (first, mut e, mut n) = (poly.first(f), poly.first(f), 0usize);
    loop {
        if n == CORNERS {
            return None;
        }
        corners[n] = pose.apply(poly.vertex(poly.origin(e)));
        n += 1;
        e = poly.next(e);
        if e == first {
            break;
        }
    }
    let normal = pose.q.rotate(poly.normal(f));
    Some((corners, n, normal, normal.dot(corners[0])))
}

/// Whether `point` lies in the convex face `corners` (with the plane's `normal`), within `eps` of its edges.
fn within(corners: &[V3], normal: V3, point: V3, eps: f32) -> bool {
    for i in 0..corners.len() {
        let (from, to) = (corners[i], corners[(i + 1) % corners.len()]);
        let out = to.sub(from).cross(normal);
        let l = sqrt(out.dot(out));
        if l > 0.0 && point.sub(from).dot(out) / l > eps {
            return false;
        }
    }
    true
}

/// The distance from `p` to the segment `a` to `b`.
fn segment_distance(p: V3, a: V3, b: V3) -> f32 {
    let ab = b.sub(a);
    let length = ab.dot(ab);
    let t = if length > 0.0 { (p.sub(a).dot(ab) / length).clamp(0.0, 1.0) } else { 0.0 };
    let d = p.sub(a.add(ab.scale(t)));
    sqrt(d.dot(d))
}

impl World {
    /// Reads the hull children of `compound` against each other and marks their cuts and the flat edges beside them. Returns how
    /// many cut faces it found. Each hull must belong to this compound alone: a hull shared with another collider takes the marks
    /// too.
    pub fn fix_compound_cuts(&mut self, compound: u32) -> u32 {
        if compound >= self.header().collider_rows || self.uu(COLLIDER_SHAPE, compound as usize) != SHAPE_COMPOUND {
            return 0;
        }
        let mut cuts = 0;
        let mut a = self.uu(COLLIDER_HULL, compound as usize);
        while a != NONE {
            let ca = a as usize;
            a = self.uu(COLLIDER_NEXT, ca);
            if self.uu(COLLIDER_SHAPE, ca) != SHAPE_HULL {
                continue;
            }
            let (hull_a, pose_a) = (self.uu(COLLIDER_HULL, ca) as usize, Pose { p: self.v(COLLIDER_X, ca), q: self.q(COLLIDER_ROTATION_X, ca) });
            let poly_a = self.hull_poly(hull_a);
            let eps = 1e-4 * (1.0 + self.s(HULL_RADIUS, hull_a));
            let f0 = self.uu(HULL_FIRST_FACE, hull_a) as usize;
            let e0 = self.uu(HULL_FIRST_EDGE, hull_a) as usize;
            // The cut faces of this part.
            for f in 0..poly_a.faces {
                let Some((corners_f, count_f, normal_f, plane_f)) = face_in(&poly_a, f, pose_a) else { continue };
                if self.covered(compound, ca, &corners_f[..count_f], normal_f, plane_f, eps) {
                    self.set_u(FACE_CUT, f0 + f, 1);
                    cuts += 1;
                }
            }
            // The flat edges beside them: an outline face g, its twin a cut, and some part's face h in g's plane holding the edge.
            for e in 0..poly_a.edges {
                let (g, t) = (poly_a.face(e), poly_a.twin(e));
                if t >= poly_a.edges || self.uu(FACE_CUT, f0 + g) != 0 || self.uu(FACE_CUT, f0 + poly_a.face(t)) == 0 {
                    continue;
                }
                let Some((_, _, normal_g, plane_g)) = face_in(&poly_a, g, pose_a) else { continue };
                let (p, q) = (pose_a.apply(poly_a.vertex(poly_a.origin(e))), pose_a.apply(poly_a.vertex(poly_a.origin(poly_a.next(e)))));
                let middle = p.add(q).scale(0.5);
                if self.continues(compound, ca, normal_g, plane_g, middle, eps) {
                    self.set_u(EDGE_SNAP, e0 + e, 1);
                }
            }
            let flags = self.uu(COLLIDER_FLAGS, ca);
            self.set_u(COLLIDER_FLAGS, ca, flags | COLLIDER_CUTS);
        }
        cuts
    }

    /// Whether some other hull child of `compound` has a face against this one, opposite and in the same plane, holding all of it.
    fn covered(&self, compound: u32, own: usize, corners: &[V3], normal: V3, plane: f32, eps: f32) -> bool {
        let mut b = self.uu(COLLIDER_HULL, compound as usize);
        while b != NONE {
            let cb = b as usize;
            b = self.uu(COLLIDER_NEXT, cb);
            if cb == own || self.uu(COLLIDER_SHAPE, cb) != SHAPE_HULL {
                continue;
            }
            let poly = self.hull_poly(self.uu(COLLIDER_HULL, cb) as usize);
            let pose = Pose { p: self.v(COLLIDER_X, cb), q: self.q(COLLIDER_ROTATION_X, cb) };
            for g in 0..poly.faces {
                let Some((other, count, n, d)) = face_in(&poly, g, pose) else { continue };
                if n.dot(normal) < -0.9999 && (d + plane).abs() <= eps && corners.iter().all(|c| within(&other[..count], n, *c, eps)) {
                    return true;
                }
            }
        }
        false
    }

    /// Whether some other hull child of `compound` has a face in the plane (`normal`, `plane`) the same way round that holds `point`.
    fn continues(&self, compound: u32, own: usize, normal: V3, plane: f32, point: V3, eps: f32) -> bool {
        let mut b = self.uu(COLLIDER_HULL, compound as usize);
        while b != NONE {
            let cb = b as usize;
            b = self.uu(COLLIDER_NEXT, cb);
            if cb == own || self.uu(COLLIDER_SHAPE, cb) != SHAPE_HULL {
                continue;
            }
            let poly = self.hull_poly(self.uu(COLLIDER_HULL, cb) as usize);
            let pose = Pose { p: self.v(COLLIDER_X, cb), q: self.q(COLLIDER_ROTATION_X, cb) };
            for h in 0..poly.faces {
                let Some((corners, count, n, d)) = face_in(&poly, h, pose) else { continue };
                if n.dot(normal) > 0.9999 && (d - plane).abs() <= eps && within(&corners[..count], n, point, eps) {
                    return true;
                }
            }
        }
        false
    }

    /// Mends a manifold of two colliders, either a part of a compound with its cuts read (`fix_compound_cuts`): drops the points
    /// on a cut face with the cut's normal, and clamps the normal to the outline's where a point is on a flat edge of the union.
    pub(crate) fn fix_cut_contacts(&self, a: usize, b: usize, m: &mut Manifold) {
        // A flat edge: the outline's normal (world, outward from the part), which side the part is, and a point on its plane.
        let mut flat: Option<(V3, usize, V3)> = None;
        let mut gone = [false; MANIFOLD];
        for (side, collider) in [(0usize, a), (1usize, b)] {
            if self.uu(COLLIDER_FLAGS, collider) & COLLIDER_CUTS == 0 {
                continue;
            }
            let hull = self.uu(COLLIDER_HULL, collider) as usize;
            let poly = self.hull_poly(hull);
            let pose = self.collider_pose(collider);
            let out = if side == 0 { m.normal } else { m.normal.scale(-1.0) };
            let local_normal = pose.q.unrotate(out);
            let tolerance = 1e-3 * (1.0 + self.s(HULL_RADIUS, hull));
            let (f0, e0) = (self.uu(HULL_FIRST_FACE, hull) as usize, self.uu(HULL_FIRST_EDGE, hull) as usize);
            for k in 0..m.count {
                let world = if side == 0 { m.points[k].on_a } else { m.points[k].on_b };
                let p = pose.unapply(world);
                for f in 0..poly.faces {
                    if self.uu(FACE_CUT, f0 + f) != 0 && (poly.normal(f).dot(p) - poly.plane(f)).abs() <= tolerance && poly.normal(f).dot(local_normal) >= 0.999 {
                        gone[k] = true;
                    }
                }
                if flat.is_none() {
                    for e in 0..poly.edges {
                        if self.uu(EDGE_SNAP, e0 + e) == 0 {
                            continue;
                        }
                        let (from, to) = (poly.vertex(poly.origin(e)), poly.vertex(poly.origin(poly.next(e))));
                        let outline = poly.normal(poly.face(e));
                        // On the edge, and its normal leaning off the outline's, towards the cut.
                        if segment_distance(p, from, to) <= tolerance && local_normal.dot(outline) < 0.9999 && local_normal.dot(outline) > 0.0 {
                            flat = Some((pose.q.rotate(outline), side, world));
                            break;
                        }
                    }
                }
            }
        }
        if let Some((out, side, edge)) = flat {
            // The other shape's points, moved to the outline's plane along its normal: the contact is with the outline, not the edge.
            let (own, other) = if side == 0 { (a, b) } else { (b, a) };
            m.normal = if side == 0 { out } else { out.scale(-1.0) };
            let mut data = crate::hull::BoxData::new();
            let deepest = self.solid(self.shape_of(other), self.collider_pose(other), &mut data).map(|solid| crate::gjk::Convex::support(&solid, out.scale(-1.0)));
            let single = m.count == 1;
            for point in m.points.iter_mut().take(m.count) {
                let theirs = match (single, deepest) {
                    (true, Some(support)) => support,
                    _ => if side == 0 { point.on_b } else { point.on_a },
                };
                let gap = theirs.sub(edge).dot(out);
                let on_plane = theirs.sub(out.scale(gap));
                if side == 0 {
                    (point.on_a, point.on_b) = (on_plane, theirs);
                } else {
                    (point.on_b, point.on_a) = (on_plane, theirs);
                }
                point.separation = gap;
            }
            let _ = own;
        }
        let mut kept = 0;
        for k in 0..m.count {
            if !gone[k] {
                m.points[kept] = m.points[k];
                kept += 1;
            }
        }
        m.count = kept;
    }
}
