// Compound colliders: convex children welded into one collider. A compound's pair holds no points itself; each child
// that touches has a part, as a triangle of a mesh pair does (mesh.rs), so events, touching and contact force speak for
// the one collider while every child keeps its own manifold and warm start. Children are culled by their own fat boxes,
// written by the broad phase each step the body moves (broad.rs, `reach_fitting`).
use crate::layout::*;
use crate::narrow::Manifold;
use crate::world::{NONE, World};

impl World {
    /// True when either side of a pair is a compound.
    #[inline(always)]
    pub fn has_compound(&self, a: usize, b: usize) -> bool {
        self.uu(COLLIDER_SHAPE, a) == SHAPE_COMPOUND || self.uu(COLLIDER_SHAPE, b) == SHAPE_COMPOUND
    }

    /// The rows one side of a compound pair brings: a compound's first child, or the collider itself; and whether the
    /// side is a compound.
    #[inline(always)]
    fn side(&self, c: usize) -> (u32, bool) {
        if self.uu(COLLIDER_SHAPE, c) == SHAPE_COMPOUND { (self.uu(COLLIDER_HULL, c), true) } else { (c as u32, false) }
    }

    /// The narrow phase of a pair with a compound in it: a part for each child, or pair of children, or child and triangle,
    /// that touches, kept from one step to the next by what it names. Each child's contact limit is its own.
    pub fn compound_pair(&mut self, row: usize, a: usize, b: usize, dt: f32, ratio: f32) {
        let bodies = (self.uu(COLLIDER_BODY, a) as usize, self.uu(COLLIDER_BODY, b) as usize);
        let meshed = self.uu(COLLIDER_SHAPE, a) == SHAPE_TRIMESH || self.uu(COLLIDER_SHAPE, b) == SHAPE_TRIMESH;
        let mut manifold = Manifold::new();
        if meshed {
            let (mesh_collider, compound, compound_is_a) = self.mesh_of(a, b);
            let mut child = self.uu(COLLIDER_HULL, compound);
            while child != NONE {
                let at = child as usize;
                if self.boxes_overlap(at, mesh_collider) {
                    let limit = self.contact_limit_of(at, mesh_collider, dt);
                    if !self.mesh_walk(row, mesh_collider, (at, compound_is_a, child), limit, ratio, bodies) {
                        return;
                    }
                }
                child = self.uu(COLLIDER_NEXT, at);
            }
            self.drop_unseen(row, bodies);
            return;
        }
        let ((first_a, compound_a), (first_b, compound_b)) = (self.side(a), self.side(b));
        let mut ca = first_a;
        while ca != NONE {
            let mut cb = first_b;
            while cb != NONE {
                let (x, y) = (ca as usize, cb as usize);
                if self.boxes_overlap(x, y) {
                    // A part names B's child, or A's when B is no compound; PAIR_SUB names A's child of two compounds.
                    let key = match (compound_a, compound_b) {
                        (true, true) => (cb, ca),
                        (true, false) => (ca, NONE),
                        _ => (cb, NONE),
                    };
                    let limit = self.contact_limit_of(x, y, dt);
                    if !self.touch_part(row, key, ratio, bodies, &mut manifold, |w, m| w.collide(x, y, limit, m)) {
                        return;
                    }
                }
                cb = if compound_b { self.uu(COLLIDER_NEXT, y) } else { NONE };
            }
            ca = if compound_a { self.uu(COLLIDER_NEXT, ca as usize) } else { NONE };
        }
        self.drop_unseen(row, bodies);
    }

    /// True when a child of a compound pair overlaps the other side, for a pair that only needs to know.
    pub fn compound_overlaps(&self, a: usize, b: usize) -> bool {
        let mut manifold = Manifold::new();
        if self.uu(COLLIDER_SHAPE, a) == SHAPE_TRIMESH || self.uu(COLLIDER_SHAPE, b) == SHAPE_TRIMESH {
            let (mesh_collider, compound, compound_is_a) = self.mesh_of(a, b);
            let mut child = self.uu(COLLIDER_HULL, compound);
            while child != NONE {
                let at = child as usize;
                if self.boxes_overlap(at, mesh_collider) && self.mesh_overlaps_with(mesh_collider, at, compound_is_a) {
                    return true;
                }
                child = self.uu(COLLIDER_NEXT, at);
            }
            return false;
        }
        let ((first_a, compound_a), (first_b, compound_b)) = (self.side(a), self.side(b));
        let mut ca = first_a;
        while ca != NONE {
            let mut cb = first_b;
            while cb != NONE {
                let (x, y) = (ca as usize, cb as usize);
                if self.boxes_overlap(x, y) {
                    manifold.held_count = 0;
                    manifold.feature = 0;
                    self.collide(x, y, 0.0, &mut manifold);
                    if manifold.points[..manifold.count].iter().any(|point| point.separation <= 0.0) {
                        return true;
                    }
                }
                cb = if compound_b { self.uu(COLLIDER_NEXT, y) } else { NONE };
            }
            ca = if compound_a { self.uu(COLLIDER_NEXT, ca as usize) } else { NONE };
        }
        false
    }
}
