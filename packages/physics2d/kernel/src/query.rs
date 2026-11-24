// Scene queries of the 2D world: rays, points, shapes placed in the world and shapes slid along a line. A query asks
// the broad phase for the shapes whose boxes it touches, then tests each one exactly, with the shape's own pose.
//
// A ray meets a core (convex hull grown by a radius, shape.rs) at the offset edges and the arcs of its rounded corners;
// a point is inside when its distance to the core is at most 0; two shapes overlap when their closest points are at
// most 0 apart (the manifold's separation, manifold.rs). A shape cast is conservative advancement on the distance
// between two convex sets that one of them slides: that distance is a convex function of the slide, so the tangent at
// the current distance, d / (v . n) along the closest normal n, never passes the first touch (Newton's method on a convex
// function; the bound is given in Gilbert, Johnson and Keerthi, "A fast procedure for computing the distance between
// complex objects in three-dimensional space", IEEE Journal on Robotics and Automation 4(2), 1988, and the use for
// continuous collision in Mirtich, "Impulse-based dynamic simulation of rigid body systems", PhD thesis, 1996).
use alloc::vec::Vec;
use margoengine_physics_kernel_common::broad::Bounds;

use crate::error::PhysicsError;
use crate::manifold::collide;
use crate::math::{V2, Xf, sqrt};
use crate::shape::{Core, LINEAR_SLOP};
use crate::world::{Kind, World, groups_meet};

/// `QueryFilter::flags` bits: leave out shapes of these kinds.
pub const EXCLUDE_SENSORS: u8 = 1;
pub const EXCLUDE_FIXED: u8 = 2;
pub const EXCLUDE_KINEMATIC: u8 = 4;
pub const EXCLUDE_DYNAMIC: u8 = 8;
/// No shape and no body.
pub const NONE: u32 = u32::MAX;

/// Which shapes a query may report.
#[derive(Clone, Copy, Debug)]
pub struct QueryFilter {
    /// The query's group word, laid out as a shape's `groups`: only shapes it meets are reported.
    pub groups: u32,
    pub flags: u8,
    /// A shape and a body to leave out, `NONE` for none.
    pub exclude_shape: u32,
    pub exclude_body: u32,
}

impl Default for QueryFilter {
    fn default() -> Self {
        QueryFilter { groups: u32::MAX, flags: 0, exclude_shape: NONE, exclude_body: NONE }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct RayHit {
    pub shape: u32,
    /// Distance along the ray (its direction is a unit vector).
    pub t: f32,
    /// The surface normal at the hit, pointing against the ray; the reverse of the ray for a ray that starts inside.
    pub normal: V2,
}

/// A shape slid into another.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CastHit {
    pub shape: u32,
    /// Distance slid; 0 when the shapes overlap from the start.
    pub t: f32,
    /// The closest points at the hit on the slid shape and on the one it met, and the unit normal from the first to the
    /// second.
    pub point_a: V2,
    pub point_b: V2,
    pub normal: V2,
}

/// The distance from `p` to the core's surface, negative inside; exact outside, and the greatest face distance (a bound
/// that is 0 on the surface) inside a polygon.
pub fn core_distance(core: &Core, p: V2) -> f32 {
    if core.count == 1 {
        return p.sub(core.vertices[0]).length() - core.radius;
    }
    if core.count >= 3 {
        let mut inside = f32::NEG_INFINITY;
        for i in 0..core.count {
            inside = inside.max(core.normals[i].dot(p.sub(core.vertices[i])));
        }
        if inside <= 0.0 {
            return inside - core.radius;
        }
    }
    let mut least = f32::INFINITY;
    for i in 0..core.count.min(if core.count == 2 { 1 } else { core.count }) {
        let (a, b) = core.edge(i);
        let ab = b.sub(a);
        let span = ab.length_squared();
        let t = if span > 0.0 { (p.sub(a).dot(ab) / span).clamp(0.0, 1.0) } else { 0.0 };
        least = least.min(p.sub(a.add(ab.scale(t))).length());
    }
    least - core.radius
}

/// The first entry (or, from inside a core that is not solid, the exit) of the ray `o + t d` within `max`, with the
/// unit direction `d` and everything in the core's frame.
pub fn ray_core(core: &Core, o: V2, d: V2, max: f32, solid: bool) -> Option<(f32, V2)> {
    let inside = core_distance(core, o) <= 0.0;
    if inside && solid {
        return Some((0.0, d.neg()));
    }
    let mut enter: Option<(f32, V2)> = None;
    let mut exit: Option<(f32, V2)> = None;
    let mut keep = |t: f32, n: V2, entering: bool| {
        if t < 0.0 || !t.is_finite() {
            return;
        }
        let slot = if entering { &mut enter } else { &mut exit };
        if slot.is_none_or(|(least, _)| t < least) {
            *slot = Some((t, n));
        }
    };
    for i in 0..core.edges() {
        let n = core.normals[i];
        let nd = n.dot(d);
        if nd == 0.0 {
            continue;
        }
        let (a, b) = core.edge(i);
        let t = (n.dot(a) + core.radius - n.dot(o)) / nd;
        let p = o.add(d.scale(t));
        let e = b.sub(a);
        let span = e.length_squared();
        if span <= 0.0 {
            continue;
        }
        let s = p.sub(a).dot(e) / span;
        if (0.0..=1.0).contains(&s) {
            keep(t, n, nd < 0.0);
        }
    }
    if core.radius > 0.0 {
        let r = core.radius;
        for i in 0..core.count {
            let v = core.vertices[i];
            let m = o.sub(v);
            let b = m.dot(d);
            let disc = b * b - (m.dot(m) - r * r);
            if disc < 0.0 {
                continue;
            }
            let root = sqrt(disc);
            for (t, entering) in [(-b - root, true), (-b + root, false)] {
                let n = o.add(d.scale(t)).sub(v).scale(1.0 / r);
                // Only the arc between the two offset edges that meet at the vertex is on the surface.
                if core.count > 1 {
                    let e_in = core.normals[(i + core.count - 1) % core.count].left();
                    let e_out = core.normals[i].left();
                    if n.dot(e_in) < 0.0 || n.dot(e_out) > 0.0 {
                        continue;
                    }
                }
                keep(t, n, entering && n.dot(d) <= 0.0 || !entering && n.dot(d) > 0.0);
            }
        }
    }
    let hit = if inside { exit } else { enter }?;
    (hit.0 <= max).then_some(hit)
}

impl World {
    /// Gives the broad phase every body's current box, so a query sees a body that was moved since the last step.
    fn query_boxes(&mut self, bounds: &Bounds<2>, out: &mut Vec<u32>) {
        self.broad.query(bounds, out);
    }

    fn accepts(&self, shape: u32, filter: &QueryFilter) -> bool {
        let s = &self.shapes[shape as usize];
        if shape == filter.exclude_shape || s.body == filter.exclude_body || !groups_meet(filter.groups, s.groups) {
            return false;
        }
        if s.sensor && filter.flags & EXCLUDE_SENSORS != 0 {
            return false;
        }
        let bit = match self.bodies[s.body as usize].kind {
            Kind::Static => EXCLUDE_FIXED,
            Kind::Kinematic => EXCLUDE_KINEMATIC,
            Kind::Dynamic => EXCLUDE_DYNAMIC,
        };
        filter.flags & bit == 0
    }

    /// Every shape the ray `origin + t direction` meets within `max`, nearest first (ties by shape id). `direction` must
    /// be a unit vector. With `solid`, a ray that starts inside a shape meets it at 0; without, it meets the exit.
    pub fn ray_cast_all(&mut self, origin: V2, direction: V2, max: f32, solid: bool, filter: &QueryFilter) -> Result<Vec<RayHit>, PhysicsError> {
        if ![origin.x, origin.y, direction.x, direction.y, max].into_iter().all(f32::is_finite) {
            return Err(PhysicsError::NotFinite);
        }
        if max < 0.0 || (direction.length() - 1.0).abs() > 1.0e-3 {
            return Err(PhysicsError::InvalidParameter);
        }
        let end = origin.add(direction.scale(max));
        let bounds = Bounds { min: [origin.x.min(end.x), origin.y.min(end.y)], max: [origin.x.max(end.x), origin.y.max(end.y)] };
        let mut found = Vec::new();
        self.query_boxes(&bounds, &mut found);
        let mut hits = Vec::new();
        for id in found {
            if !self.accepts(id, filter) {
                continue;
            }
            let shape = &self.shapes[id as usize];
            let xf = self.bodies[shape.body as usize].xf;
            let (o, d) = (xf.apply_inverse(origin), xf.q.apply_inverse(direction));
            if let Some((t, n)) = ray_core(&shape.core, o, d, max, solid) {
                hits.push(RayHit { shape: id, t, normal: xf.q.apply(n) });
            }
        }
        hits.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.shape.cmp(&b.shape)));
        Ok(hits)
    }

    /// The nearest hit of `ray_cast_all`.
    pub fn ray_cast(&mut self, origin: V2, direction: V2, max: f32, solid: bool, filter: &QueryFilter) -> Result<Option<RayHit>, PhysicsError> {
        Ok(self.ray_cast_all(origin, direction, max, solid, filter)?.first().copied())
    }

    /// The shapes that contain `point`, by shape id.
    pub fn point_query(&mut self, point: V2, filter: &QueryFilter) -> Result<Vec<u32>, PhysicsError> {
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err(PhysicsError::NotFinite);
        }
        let mut found = Vec::new();
        self.query_boxes(&Bounds { min: [point.x, point.y], max: [point.x, point.y] }, &mut found);
        found.retain(|&id| {
            self.accepts(id, filter) && {
                let shape = &self.shapes[id as usize];
                core_distance(&shape.core, self.bodies[shape.body as usize].xf.apply_inverse(point)) <= 0.0
            }
        });
        Ok(found)
    }

    /// The shapes `core` at `xf` overlaps, by shape id.
    pub fn shape_overlap(&mut self, core: &Core, xf: Xf, filter: &QueryFilter) -> Result<Vec<u32>, PhysicsError> {
        let bounds = crate::world::bounds_of(core, xf)?;
        let mut found = Vec::new();
        self.query_boxes(&bounds, &mut found);
        let mut out = Vec::new();
        for id in found {
            if !self.accepts(id, filter) {
                continue;
            }
            let shape = &self.shapes[id as usize];
            let m = collide(core, xf, &shape.core, self.bodies[shape.body as usize].xf, 0.0)?;
            if m.points[..m.count].iter().any(|p| p.separation <= 0.0) {
                out.push(id);
            }
        }
        Ok(out)
    }

    /// Every shape `core`, slid from `xf` along the unit `direction` for at most `max`, meets, nearest first. A shape
    /// already overlapping is met at 0.
    pub fn shape_cast_all(&mut self, core: &Core, xf: Xf, direction: V2, max: f32, filter: &QueryFilter) -> Result<Vec<CastHit>, PhysicsError> {
        if ![direction.x, direction.y, max].into_iter().all(f32::is_finite) {
            return Err(PhysicsError::NotFinite);
        }
        if max < 0.0 || (direction.length() - 1.0).abs() > 1.0e-3 {
            return Err(PhysicsError::InvalidParameter);
        }
        let start = crate::world::bounds_of(core, xf)?;
        let shift = direction.scale(max);
        let bounds = Bounds {
            min: [start.min[0].min(start.min[0] + shift.x), start.min[1].min(start.min[1] + shift.y)],
            max: [start.max[0].max(start.max[0] + shift.x), start.max[1].max(start.max[1] + shift.y)],
        };
        let mut found = Vec::new();
        self.query_boxes(&bounds, &mut found);
        let tolerance = 0.1 * LINEAR_SLOP;
        let mut hits = Vec::new();
        'shapes: for id in found {
            if !self.accepts(id, filter) {
                continue;
            }
            let shape = &self.shapes[id as usize];
            let target = self.bodies[shape.body as usize].xf;
            let mut t = 0.0f32;
            for _ in 0..64 {
                let at = Xf { p: xf.p.add(direction.scale(t)), q: xf.q };
                let m = collide(core, at, &shape.core, target, 1.0e4)?;
                let Some(nearest) = m.points[..m.count].iter().copied().reduce(|a, b| if b.separation < a.separation { b } else { a }) else {
                    continue 'shapes;
                };
                let gap = nearest.separation;
                if gap <= tolerance {
                    let half = m.normal.scale(0.5 * gap);
                    // `point` lies midway between the surfaces: take the surface points either side of it.
                    hits.push(CastHit { shape: id, t, point_a: nearest.point.sub(half), point_b: nearest.point.add(half), normal: m.normal });
                    continue 'shapes;
                }
                let closing = direction.dot(m.normal);
                if closing <= 0.0 {
                    continue 'shapes;
                }
                t += gap / closing;
                if t > max {
                    continue 'shapes;
                }
            }
        }
        hits.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.shape.cmp(&b.shape)));
        Ok(hits)
    }

    pub fn shape_cast(&mut self, core: &Core, xf: Xf, direction: V2, max: f32, filter: &QueryFilter) -> Result<Option<CastHit>, PhysicsError> {
        Ok(self.shape_cast_all(core, xf, direction, max, filter)?.first().copied())
    }
}
