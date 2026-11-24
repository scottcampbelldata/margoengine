// A half space: everything on one side of a plane through the collider's origin, Rapier's `HalfSpace`. The collider's A, B,
// C hold the plane's unit normal in the collider's frame, pointing out of the solid. It has no volume and no mass.
//
// Rays, point projection, shape casts and overlaps are closed forms. Contacts meet a convex collider through a box laid
// under it for that pair: its top face is the plane, and it reaches under and around the other shape far enough that
// nothing the other shape does in a step can leave it, so the numbers stay as small as the other shape's and the
// manifolds are the box's.
use crate::cast::{Cast, CastOptions, Projection, Solid, bounds};
use crate::gjk::Convex;
use crate::hull::{BoxData, box_poly};
use crate::layout::*;
use crate::math::*;
use crate::narrow::Manifold;
use crate::query::RayHit;
use crate::sat::Pose;
use crate::smooth::collide_solids;
use crate::world::World;

const ZERO: V3 = V3 { x: 0.0, y: 0.0, z: 0.0 };

/// The turn that takes +Y to the unit vector `n`.
fn up_to(n: V3) -> Q {
    if n.y < -0.999_999 {
        return Q { x: 1.0, y: 0.0, z: 0.0, w: 0.0 };
    }
    // Y x n, with the half angle's cosine in w: the shortest turn.
    Q { x: n.z, y: 0.0, z: -n.x, w: 1.0 + n.y }.normalized()
}

impl World {
    /// A half space collider's plane in world space: a point on it and the unit normal out of the solid.
    pub(crate) fn plane_of(&self, c: usize) -> (V3, V3) {
        let frame = self.collider_pose(c);
        (frame.p, frame.q.rotate(self.v(COLLIDER_A, c)))
    }

    /// One manifold between a half space and another collider, as `collide`: from `a` to `b`.
    pub(crate) fn collide_halfspace(&self, a: usize, b: usize, limit: f32, out: &mut Manifold) {
        out.count = 0;
        let (a_is_plane, plane, other) = if self.uu(COLLIDER_SHAPE, a) == SHAPE_HALFSPACE { (true, a, b) } else { (false, b, a) };
        if self.uu(COLLIDER_SHAPE, other) == SHAPE_HALFSPACE {
            return;
        }
        let mut other_data = BoxData::new();
        let Some(solid) = self.solid(self.shape_of(other), self.collider_pose(other), &mut other_data) else { return };
        let (low, high) = bounds(&solid);
        let (center, reach) = (low.add(high).scale(0.5), sqrt(high.sub(low).dot(high.sub(low))) * 0.5);
        let (point, n) = self.plane_of(plane);
        let height = n.dot(center.sub(point));
        // A box whose top face is the plane, wider than the shape and deeper than it can sink.
        let wide = reach + limit + 1.0;
        let deep = height.abs() + reach + limit + 1.0;
        let foot = center.sub(n.scale(height));
        let pose = Pose { p: foot.sub(n.scale(deep)), q: up_to(n) };
        let mut data = BoxData::new();
        let ground = Solid::Poly { poly: box_poly(v3(wide, deep, wide), &mut data), pose };
        if a_is_plane {
            collide_solids(&ground, &solid, limit, out);
        } else {
            collide_solids(&solid, &ground, limit, out);
        }
    }

    /// A ray, in the collider's frame, against a half space.
    pub(crate) fn ray_halfspace(&self, c: usize, o: V3, d: V3, max: f32, solid: bool) -> Option<RayHit> {
        let n = self.v(COLLIDER_A, c);
        let (height, closing) = (n.dot(o), -n.dot(d));
        if height <= 0.0 {
            if solid {
                return Some(RayHit { t: 0.0, normal: ZERO });
            }
            // Leaving: the plane is ahead when the ray points out of the solid.
            if closing >= 0.0 {
                return None;
            }
            let t = height / closing;
            return if t <= max { Some(RayHit { t, normal: n.scale(-1.0) }) } else { None };
        }
        if closing <= 0.0 {
            return None;
        }
        let t = height / closing;
        if t <= max { Some(RayHit { t, normal: n }) } else { None }
    }

    /// The point of a half space nearest `p` (world space).
    pub(crate) fn project_halfspace(&self, c: usize, p: V3, solid: bool) -> Projection {
        let (point, n) = self.plane_of(c);
        let height = n.dot(p.sub(point));
        if height <= 0.0 && solid {
            return Projection { point: p, inside: true };
        }
        Projection { point: p.sub(n.scale(height)), inside: height <= 0.0 }
    }

    /// The first touch of a query shape at `pose` moving along unit `r` with a half space.
    pub(crate) fn cast_halfspace(&self, c: usize, query: &Solid, r: V3, o: &CastOptions) -> Option<Cast> {
        let (point, n) = self.plane_of(c);
        // The query's point nearest the plane, and its height above it less the distance the cast stops short.
        let low = query.support(n.scale(-1.0));
        let height = n.dot(low.sub(point)) - o.target;
        let on_target = |on_query: V3| on_query.sub(n.scale(n.dot(on_query.sub(point))));
        if height <= 0.0 {
            // A start in contact: the cast is already there. One that moves out of it is no hit unless it stops at any start.
            if !o.stop && n.dot(r) >= 0.0 {
                return None;
            }
            let geometry = o.geometry;
            return Some(Cast { t: 0.0, normal: if geometry { n } else { ZERO }, on_query: if geometry { low } else { ZERO }, on_target: if geometry { on_target(low) } else { ZERO }, started: true });
        }
        let closing = -n.dot(r);
        if closing <= 0.0 {
            return None;
        }
        let t = height / closing;
        if t > o.max {
            return None;
        }
        let at = low.add(r.scale(t));
        Some(Cast { t, normal: n, on_query: at, on_target: on_target(at), started: false })
    }

    /// True when a query shape overlaps a half space.
    pub(crate) fn overlaps_halfspace(&self, c: usize, query: &Solid) -> bool {
        let (point, n) = self.plane_of(c);
        n.dot(query.support(n.scale(-1.0)).sub(point)) <= 0.0
    }

    /// A half space's box in the broad phase: a slab when its plane faces along an axis, else the whole world.
    pub(crate) fn halfspace_reach(&self, c: usize) -> (V3, V3) {
        const BIG: f32 = 1.0e6;
        let (point, n) = self.plane_of(c);
        let (mut low, mut high) = (v3(-BIG, -BIG, -BIG), v3(BIG, BIG, BIG));
        let (nn, p) = ([n.x, n.y, n.z], [point.x, point.y, point.z]);
        let (mut l, mut h) = ([low.x, low.y, low.z], [high.x, high.y, high.z]);
        for k in 0..3 {
            if nn[k] > 0.999_999 {
                h[k] = p[k];
            } else if nn[k] < -0.999_999 {
                l[k] = p[k];
            }
        }
        low = v3(l[0], l[1], l[2]);
        high = v3(h[0], h[1], h[2]);
        (low, high)
    }
}
