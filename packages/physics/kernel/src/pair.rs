// Questions about two colliders, on demand: do they overlap, what contact points do they make within a prediction
// distance, how far apart are they and where are the nearest points; and the tight box of one. These do not touch the
// world's pairs, so they work for any two colliders, touching or not, as Rapier's `contactPair`, `intersectionPair` and
// `distance` do.
use crate::cast::{Solid, bounds, touch};
use crate::gjk::gjk;
use crate::hull::BoxData;
use crate::layout::*;
use crate::math::*;
use crate::narrow::Manifold;
use crate::smooth::collide_solids;
use crate::world::{NONE, World};

const ZERO: V3 = V3 { x: 0.0, y: 0.0, z: 0.0 };

impl World {
    /// The box of a collider's shape at its body's pose, with no margin and no reach for motion.
    pub fn collider_box(&self, c: usize) -> (V3, V3) {
        if self.uu(COLLIDER_SHAPE, c) != SHAPE_COMPOUND {
            return self.reach(c, 0.0);
        }
        let mut child = self.uu(COLLIDER_HULL, c);
        if child == NONE {
            let p = self.collider_pose(c).p;
            return (p, p);
        }
        let (mut low, mut high) = self.reach(child as usize, 0.0);
        while child != NONE {
            let (lo, hi) = self.reach(child as usize, 0.0);
            low = low.min(lo);
            high = high.max(hi);
            child = self.uu(COLLIDER_NEXT, child as usize);
        }
        (low, high)
    }

    /// Whether two colliders overlap now, whatever their pair says.
    pub fn pair_intersects(&self, a: usize, b: usize) -> bool {
        let (shape_a, shape_b) = (self.meshy_shape(a), self.meshy_shape(b));
        if shape_a == SHAPE_HALFSPACE && shape_b == SHAPE_HALFSPACE {
            return false;
        }
        if shape_a == SHAPE_COMPOUND || shape_b == SHAPE_COMPOUND {
            return self.compound_overlaps(a, b);
        }
        if shape_a == SHAPE_TRIMESH || shape_b == SHAPE_TRIMESH {
            return shape_a != SHAPE_HALFSPACE && shape_b != SHAPE_HALFSPACE && self.mesh_overlaps(a, b);
        }
        let mut manifold = Manifold::new();
        self.collide(a, b, 0.0, &mut manifold);
        manifold.points[..manifold.count].iter().any(|point| point.separation <= 0.0)
    }

    /// Calls `visit` with each manifold of two colliders within `prediction` of touching: one for a pair of convex
    /// colliders, one for each pair of children of a compound, one for each triangle or cell of a mesh near the other
    /// collider. Normals run from `a` to `b`.
    pub fn pair_contacts(&self, a: usize, b: usize, prediction: f32, visit: &mut dyn FnMut(&Manifold)) {
        let (shape_a, shape_b) = (self.meshy_shape(a), self.meshy_shape(b));
        if shape_a == SHAPE_COMPOUND || shape_b == SHAPE_COMPOUND {
            let ((first_a, compound_a), (first_b, compound_b)) = (self.side(a), self.side(b));
            let mut ca = first_a;
            while ca != NONE {
                let mut cb = first_b;
                while cb != NONE {
                    self.pair_contacts(ca as usize, cb as usize, prediction, visit);
                    cb = if compound_b { self.uu(COLLIDER_NEXT, cb as usize) } else { NONE };
                }
                ca = if compound_a { self.uu(COLLIDER_NEXT, ca as usize) } else { NONE };
            }
            return;
        }
        if shape_a == SHAPE_TRIMESH || shape_b == SHAPE_TRIMESH {
            if shape_a == SHAPE_TRIMESH && shape_b == SHAPE_TRIMESH || shape_a == SHAPE_HALFSPACE || shape_b == SHAPE_HALFSPACE {
                return;
            }
            let (mesh_collider, other, other_is_a) = self.mesh_of(a, b);
            let frame = self.collider_pose(mesh_collider);
            let mut data = BoxData::new();
            let Some(solid) = self.solid(self.shape_of(other), frame.relative(self.collider_pose(other)), &mut data) else { return };
            let (low, high) = bounds(&solid);
            let grow = v3(prediction, prediction, prediction);
            let mut manifold = Manifold::new();
            self.each_part(self.uu(COLLIDER_HULL, mesh_collider) as usize, (low.sub(grow), high.add(grow)), &|lo, hi| {
                !(lo.x > high.x + prediction || lo.y > high.y + prediction || lo.z > high.z + prediction || hi.x < low.x - prediction || hi.y < low.y - prediction || hi.z < low.z - prediction)
            }, &mut |part| {
                // In the mesh's frame, the normal runs from the triangle to the other shape.
                collide_solids(&part, &solid, prediction, &mut manifold);
                if manifold.count > 0 {
                    let mut world = Manifold::new();
                    world.count = manifold.count;
                    world.normal = frame.q.rotate(manifold.normal);
                    for k in 0..manifold.count {
                        let p = manifold.points[k];
                        world.points[k] = crate::narrow::Point { on_a: frame.apply(p.on_a), on_b: frame.apply(p.on_b), separation: p.separation, id: p.id };
                    }
                    if other_is_a {
                        world.normal = world.normal.scale(-1.0);
                        for point in world.points.iter_mut().take(world.count) {
                            core::mem::swap(&mut point.on_a, &mut point.on_b);
                        }
                    }
                    visit(&world);
                }
                true
            });
            return;
        }
        let mut manifold = Manifold::new();
        self.collide(a, b, prediction, &mut manifold);
        if manifold.count > 0 {
            visit(&manifold);
        }
    }

    /// The distance between two colliders and the nearest point on each, 0 when they overlap; None when either holds
    /// nothing a distance can be read from (a half space against a mesh, say).
    pub fn pair_distance(&self, a: usize, b: usize) -> Option<(f32, V3, V3)> {
        let (shape_a, shape_b) = (self.meshy_shape(a), self.meshy_shape(b));
        if shape_a == SHAPE_COMPOUND || shape_b == SHAPE_COMPOUND {
            let ((first_a, compound_a), (first_b, compound_b)) = (self.side(a), self.side(b));
            let mut best: Option<(f32, V3, V3)> = None;
            let mut ca = first_a;
            while ca != NONE {
                let mut cb = first_b;
                while cb != NONE {
                    if let Some(found) = self.pair_distance(ca as usize, cb as usize)
                        && best.is_none_or(|(d, _, _)| found.0 < d)
                    {
                        best = Some(found);
                    }
                    cb = if compound_b { self.uu(COLLIDER_NEXT, cb as usize) } else { NONE };
                }
                ca = if compound_a { self.uu(COLLIDER_NEXT, ca as usize) } else { NONE };
            }
            return best;
        }
        if shape_a == SHAPE_HALFSPACE || shape_b == SHAPE_HALFSPACE {
            if shape_a == shape_b || shape_a == SHAPE_TRIMESH || shape_b == SHAPE_TRIMESH {
                return None;
            }
            let (plane, other, plane_is_a) = if shape_a == SHAPE_HALFSPACE { (a, b, true) } else { (b, a, false) };
            let mut data = BoxData::new();
            let solid = self.solid(self.shape_of(other), self.collider_pose(other), &mut data)?;
            let (point, n) = self.plane_of(plane);
            let low = crate::gjk::Convex::support(&solid, n.scale(-1.0));
            let height = n.dot(low.sub(point));
            let on_plane = low.sub(n.scale(height));
            let (distance, on_other, on_half) = if height <= 0.0 { (0.0, low, low) } else { (height, low, on_plane) };
            return Some(if plane_is_a { (distance, on_half, on_other) } else { (distance, on_other, on_half) });
        }
        if shape_a == SHAPE_TRIMESH || shape_b == SHAPE_TRIMESH {
            if shape_a == shape_b {
                return None;
            }
            let (mesh_collider, other, other_is_a) = self.mesh_of(a, b);
            let frame = self.collider_pose(mesh_collider);
            let mut data = BoxData::new();
            let solid = self.solid(self.shape_of(other), frame.relative(self.collider_pose(other)), &mut data)?;
            let mut best: Option<(f32, V3, V3)> = None;
            let everything = v3(1.0e9, 1.0e9, 1.0e9);
            self.each_part(self.uu(COLLIDER_HULL, mesh_collider) as usize, (everything.scale(-1.0), everything), &|_, _| true, &mut |part| {
                let found = Self::solid_distance(&part, &solid);
                if best.is_none_or(|(d, _, _)| found.0 < d) {
                    best = Some(found);
                }
                true
            });
            // The solid is B in `solid_distance`; the mesh collider is the pair's A unless the other is.
            return best.map(|(d, on_mesh, on_other)| {
                let (on_mesh, on_other) = (frame.apply(on_mesh), frame.apply(on_other));
                if other_is_a { (d, on_other, on_mesh) } else { (d, on_mesh, on_other) }
            });
        }
        let (mut data_a, mut data_b) = (BoxData::new(), BoxData::new());
        let sa = self.solid(self.shape_of(a), self.collider_pose(a), &mut data_a)?;
        let sb = self.solid(self.shape_of(b), self.collider_pose(b), &mut data_b)?;
        Some(Self::solid_distance(&sa, &sb))
    }

    /// The distance between two solids, 0 when they overlap, and the nearest point on each.
    fn solid_distance(a: &Solid, b: &Solid) -> (f32, V3, V3) {
        let (_, on_a, on_b) = touch(a, b);
        if gjk(a, b, ZERO, 0.0).overlap {
            return (0.0, on_a, on_b);
        }
        let d = on_b.sub(on_a);
        (sqrt(d.dot(d)), on_a, on_b)
    }
}

impl World {
    /// A collider's shape as the pair queries see it: a round triangle is a convex shape, not a mesh.
    fn meshy_shape(&self, c: usize) -> u32 {
        let shape = self.uu(COLLIDER_SHAPE, c);
        if shape == SHAPE_TRIMESH && self.is_round_triangle(c) { SHAPE_HULL } else { shape }
    }
}
