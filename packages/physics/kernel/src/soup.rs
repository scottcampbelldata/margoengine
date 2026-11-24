// A mesh, height field or voxel grid as a query shape: its triangles or cells, each cast or overlapped against a collider as
// a shape of its own, the nearest touch winning (Rapier's `castShape` and `intersectionsWithShape` take any shape).
use crate::cast::{Cast, CastOptions, Shape, Solid, cast_convex, nearer};
use crate::gjk::gjk;
use crate::hull::BoxData;
use crate::layout::*;
use crate::math::*;
use crate::sat::Pose;
use crate::world::World;

const ZERO: V3 = V3 { x: 0.0, y: 0.0, z: 0.0 };

/// A solid seen through `pose`: the solid is given in the frame `pose` places in its parent's.
pub(crate) fn placed(s: &Solid, pose: Pose) -> Solid {
    let compose = |inner: Pose| Pose { p: pose.apply(inner.p), q: pose.q.mul(inner.q) };
    match *s {
        Solid::Round { p, q, r } => Solid::Round { p: pose.apply(p), q: pose.apply(q), r },
        Solid::Poly { poly, pose: inner } => Solid::Poly { poly, pose: compose(inner) },
        Solid::RoundPoly { poly, pose: inner, border } => Solid::RoundPoly { poly, pose: compose(inner), border },
        Solid::Triangle([a, b, c]) => Solid::Triangle([pose.apply(a), pose.apply(b), pose.apply(c)]),
        Solid::RoundTriangle([a, b, c], border) => Solid::RoundTriangle([pose.apply(a), pose.apply(b), pose.apply(c)], border),
        Solid::Revolved { shape, border, pose: inner } => Solid::Revolved { shape, border, pose: compose(inner) },
    }
}

impl World {
    /// Whether a query shape is a mesh, height field or voxel grid of more than one triangle: cast piece by piece.
    pub(crate) fn is_soup(&self, shape: Shape) -> bool {
        shape.kind == SHAPE_TRIMESH && shape.hull < self.header().mesh_rows[0] && !self.is_one_triangle(shape.hull as usize)
    }

    /// Whether a query shape can be asked about: a convex shape, or a soup.
    pub fn query_valid(&self, shape: Shape, pose: Pose) -> bool {
        let normal = shape.size.dot(shape.size);
        self.is_soup(shape)
            || (shape.kind == SHAPE_HALFSPACE && normal > 0.99 && normal < 1.01)
            || self.solid(shape, pose, &mut BoxData::new()).is_some()
    }

    /// Each piece of a soup query shape, in the world, until `visit` returns false.
    fn each_soup_piece(&self, mesh: usize, pose: Pose, visit: &mut dyn FnMut(Solid) -> bool) {
        let everything = v3(1.0e9, 1.0e9, 1.0e9);
        self.each_part(mesh, (everything.scale(-1.0), everything), &|_, _| true, &mut |part| visit(placed(&part, pose)));
    }

    /// The first touch of a soup moving along unit `r` with collider `c`: the nearest of its pieces'.
    pub(crate) fn cast_soup(&self, c: usize, mesh: usize, pose: Pose, r: V3, o: &CastOptions) -> Option<Cast> {
        let mut best: Option<Cast> = None;
        self.each_soup_piece(mesh, pose, &mut |piece| {
            let limit = CastOptions { max: best.map_or(o.max, |b| b.t), ..*o };
            best = nearer(best, self.cast_solid(c, &piece, r, &limit));
            true
        });
        best
    }

    /// True when a soup overlaps collider `c`.
    pub(crate) fn overlaps_soup(&self, c: usize, mesh: usize, pose: Pose) -> bool {
        let mut found = false;
        self.each_soup_piece(mesh, pose, &mut |piece| {
            found = self.overlaps_solid(c, &piece);
            !found
        });
        found
    }

    /// `cast_solid`, for the crate.
    pub(crate) fn cast_solid_pub(&self, c: usize, query: &Solid, r: V3, o: &CastOptions) -> Option<Cast> {
        self.cast_solid(c, query, r, o)
    }

    /// The first touch of a convex solid, in the world, moving along unit `r` with collider `c`.
    fn cast_solid(&self, c: usize, query: &Solid, r: V3, o: &CastOptions) -> Option<Cast> {
        let kind = self.uu(COLLIDER_SHAPE, c);
        if kind == SHAPE_COMPOUND {
            let mut best: Option<Cast> = None;
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != crate::world::NONE {
                let limit = CastOptions { max: best.map_or(o.max, |b| b.t), ..*o };
                best = nearer(best, self.cast_solid(child as usize, query, r, &limit));
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return best;
        }
        if kind == SHAPE_HALFSPACE {
            return self.cast_halfspace(c, query, r, o);
        }
        let frame = self.collider_pose(c);
        if kind != SHAPE_TRIMESH || self.is_round_triangle(c) {
            let mut data = BoxData::new();
            let target = self.solid(self.shape_of(c), frame, &mut data)?;
            return cast_convex(query, &target, r, o);
        }
        // A mesh meets no mesh: a soup against a mesh, height field or voxel grid casts the pieces in the target's frame.
        let inside = placed(query, frame.inverse());
        let hit = self.cast_triangles(self.uu(COLLIDER_HULL, c) as usize, &inside, frame.q.unrotate(r), o)?;
        let normal = frame.q.rotate(hit.normal);
        let (on_query, on_target) = if hit.started && !o.geometry { (ZERO, ZERO) } else { (frame.apply(hit.on_query), frame.apply(hit.on_target)) };
        Some(Cast { normal, on_query, on_target, ..hit })
    }

    /// True when a convex solid, in the world, overlaps collider `c`.
    fn overlaps_solid(&self, c: usize, query: &Solid) -> bool {
        let kind = self.uu(COLLIDER_SHAPE, c);
        if kind == SHAPE_COMPOUND {
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != crate::world::NONE {
                if self.overlaps_solid(child as usize, query) {
                    return true;
                }
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return false;
        }
        if kind == SHAPE_HALFSPACE {
            return self.overlaps_halfspace(c, query);
        }
        let frame = self.collider_pose(c);
        if kind != SHAPE_TRIMESH || self.is_round_triangle(c) {
            let mut data = BoxData::new();
            let Some(target) = self.solid(self.shape_of(c), frame, &mut data) else { return false };
            return gjk(query, &target, ZERO, 0.0).overlap;
        }
        let inside = placed(query, frame.inverse());
        let (low, high) = crate::cast::bounds(&inside);
        let mut found = false;
        let meets_box = |a: V3, b: V3| !(a.x > high.x || a.y > high.y || a.z > high.z || b.x < low.x || b.y < low.y || b.z < low.z);
        self.each_part(self.uu(COLLIDER_HULL, c) as usize, (low, high), &meets_box, &mut |target| {
            found = gjk(&inside, &target, ZERO, 0.0).overlap;
            !found
        });
        found
    }
}
