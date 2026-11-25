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
use crate::math::{V2, Xf, sqrt, v2};
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
    /// The distance between the shapes at the hit: the cast's target distance when it stopped short, below 0 for shapes overlapping.
    pub gap: f32,
}

/// What a shape cast stops for (Rapier's `ShapeCastOptions`; its maximum time of impact is the cast's `max`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CastOptions {
    /// The cast meets a shape when the distance between the two falls to this much (0 or more, default 0: when they touch).
    pub target_distance: f32,
    /// Shapes overlapping at the start are met at 0 (default); off, a pair that overlaps and is moving apart is not a hit at all.
    pub stop_at_penetration: bool,
}

impl Default for CastOptions {
    fn default() -> Self {
        CastOptions { target_distance: 0.0, stop_at_penetration: true }
    }
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

/// The first touch of `core` slid from `xf` along the unit `direction` for at most `max` with `target` at `target_xf`.
fn cast_against(core: &Core, xf: Xf, direction: V2, max: f32, target: &Core, target_xf: Xf, options: &CastOptions) -> Result<Option<CastHit>, PhysicsError> {
    let tolerance = 0.1 * LINEAR_SLOP;
    // A touch: the shapes this close or closer.
    let reach = options.target_distance + tolerance;
    let mut t = 0.0f32;
    for step in 0..64 {
        let at = Xf { p: xf.p.add(direction.scale(t)), q: xf.q };
        let m = collide(core, at, target, target_xf, 1.0e4)?;
        let Some(nearest) = m.points[..m.count].iter().copied().reduce(|a, b| if b.separation < a.separation { b } else { a }) else {
            return Ok(None);
        };
        let gap = nearest.separation;
        let closing = direction.dot(m.normal);
        let overlapping = gap < -tolerance;
        // Overlapping at the start and moving apart: not a hit when the cast does not stop at penetration.
        if step == 0 && overlapping && !options.stop_at_penetration && closing <= 1.0e-6 {
            return Ok(None);
        }
        // Touching and not closing (sliding along a face, or moving away) is not a hit: the distance of convex shapes
        // cannot fall from there. Overlapping deeper than the tolerance is.
        if gap <= reach && (closing > 1.0e-6 || overlapping) {
            let half = m.normal.scale(0.5 * gap);
            // `point` lies midway between the surfaces: take the surface points either side of it.
            return Ok(Some(CastHit { shape: 0, t, point_a: nearest.point.sub(half), point_b: nearest.point.add(half), normal: m.normal, gap }));
        }
        if closing <= 0.0 {
            return Ok(None);
        }
        t += (gap - options.target_distance) / closing;
        if t > max {
            return Ok(None);
        }
    }
    Ok(None)
}

/// The closest point of `core` to `p` (in the core's frame) and whether `p` is inside it.
pub fn project_core(core: &Core, p: V2) -> (V2, bool) {
    let r = core.radius;
    if core.count == 1 {
        let (dir, d) = p.sub(core.vertices[0]).normalize();
        let on = core.vertices[0].add(dir.scale(r));
        return if d <= r { (p, true) } else { (on, false) };
    }
    if core.count >= 3 {
        let mut inside = f32::NEG_INFINITY;
        for i in 0..core.count {
            inside = inside.max(core.normals[i].dot(p.sub(core.vertices[i])));
        }
        if inside <= 0.0 {
            return (p, true);
        }
    }
    // The nearest point of the core's boundary, then out by the radius along the way from it to `p`.
    let mut best = (f32::INFINITY, core.vertices[0]);
    for i in 0..core.count.min(if core.count == 2 { 1 } else { core.count }) {
        let (a, b) = core.edge(i);
        let ab = b.sub(a);
        let span = ab.length_squared();
        let t = if span > 0.0 { (p.sub(a).dot(ab) / span).clamp(0.0, 1.0) } else { 0.0 };
        let q = a.add(ab.scale(t));
        let d = p.sub(q).length_squared();
        if d < best.0 {
            best = (d, q);
        }
    }
    let (dir, d) = p.sub(best.1).normalize();
    if d <= r { (p, true) } else { (best.1.add(dir.scale(r)), false) }
}

/// For a point `p` inside `core` (within its radius), the nearest point of its surface: out along the way from the nearest point of the
/// core's own boundary to `p` by the radius, or, with no radius, on that boundary; a point on the boundary goes out along its edge's normal.
pub fn surface_core(core: &Core, p: V2) -> V2 {
    let r = core.radius;
    if core.count == 1 {
        let (dir, d) = p.sub(core.vertices[0]).normalize();
        let dir = if d > 0.0 { dir } else { v2(1.0, 0.0) };
        return core.vertices[0].add(dir.scale(r));
    }
    // The nearest point of the polygon's (or segment's) boundary and its edge.
    let mut best = (f32::INFINITY, core.vertices[0], 0usize);
    for i in 0..core.count.min(if core.count == 2 { 1 } else { core.count }) {
        let (a, b) = core.edge(i);
        let ab = b.sub(a);
        let span = ab.length_squared();
        let t = if span > 0.0 { (p.sub(a).dot(ab) / span).max(0.0).min(1.0) } else { 0.0 };
        let q = a.add(ab.scale(t));
        let d = p.sub(q).length_squared();
        if d < best.0 {
            best = (d, q, i);
        }
    }
    let (dir, d) = p.sub(best.1).normalize();
    let (a, b) = core.edge(best.2);
    // Outside the polygon proper (or beside a segment) the way out is from the boundary point to `p`; inside it, or on the boundary, it
    // is the edge's outward normal.
    let outside = core.count < 3 || (0..core.count).any(|i| core.normals[i].dot(p.sub(core.vertices[i])) > 0.0);
    let way = if outside && d > 0.0 {
        dir
    } else if core.count >= 3 {
        core.normals[best.2]
    } else {
        // A segment: a point on it leaves along its normal.
        let (n, _) = b.sub(a).normalize();
        n.left()
    };
    best.1.add(way.scale(r))
}

/// The nearest point of a grid's surface (the boundary of the filled cells together) to `q`, a point inside a filled cell.
fn surface_grid(grid: &crate::voxel::Grid, q: V2) -> V2 {
    let mut best = (f32::INFINITY, q);
    for (c, r) in grid.filled_cells() {
        let (lo, hi) = (v2(grid.origin.x + c as f32 * grid.cell.x, grid.origin.y + r as f32 * grid.cell.y), v2(grid.origin.x + (c + 1) as f32 * grid.cell.x, grid.origin.y + (r + 1) as f32 * grid.cell.y));
        // The four sides, each a boundary of the union when the cell across it is empty.
        for (dc, dr, a, b) in [(-1, 0, lo, v2(lo.x, hi.y)), (1, 0, v2(hi.x, lo.y), hi), (0, -1, lo, v2(hi.x, lo.y)), (0, 1, v2(lo.x, hi.y), hi)] {
            if grid.is_filled(c + dc, r + dr) {
                continue;
            }
            let ab = b.sub(a);
            let t = (q.sub(a).dot(ab) / ab.length_squared()).max(0.0).min(1.0);
            let on = a.add(ab.scale(t));
            let d = q.sub(on).length_squared();
            if d < best.0 {
                best = (d, on);
            }
        }
    }
    best.1
}

/// The closest point of a shape to a query point.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Projection {
    pub shape: u32,
    pub point: V2,
    /// The query point is inside the shape (then `point` is the query point).
    pub inside: bool,
    pub distance: f32,
}

impl World {
    /// Every shape the filter accepts with its closest point to `point`, nearest first (ties by shape id): the closest
    /// point, whether `point` is inside it, and the distance (0 inside).
    pub fn project_point_all(&mut self, point: V2, filter: &QueryFilter) -> Result<Vec<Projection>, PhysicsError> {
        self.project_point_all_with(point, true, filter)
    }

    /// `project_point_all`, with `solid` choosing what a point inside a shape projects to: itself (solid, distance 0), or the nearest point of the
    /// shape's surface (not solid, `inside` still true and the distance to that point).
    pub fn project_point_all_with(&mut self, point: V2, solid: bool, filter: &QueryFilter) -> Result<Vec<Projection>, PhysicsError> {
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err(PhysicsError::NotFinite);
        }
        let mut all = Vec::new();
        for id in 0..self.shapes.len() as u32 {
            if self.shapes[id as usize].dead || !self.accepts(id, filter) {
                continue;
            }
            let shape = &self.shapes[id as usize];
            let xf = self.bodies[shape.body as usize].xf;
            let q = xf.apply_inverse(point);
            let (local, inside) = match &shape.grid {
                Some(grid) if grid.contains(q) => (q, true),
                Some(grid) => {
                    // The nearest point of the nearest filled cell.
                    let mut best = (f32::INFINITY, q);
                    for (c, r) in grid.filled_cells() {
                        let (p, _) = project_core(&grid.cell_core(c, r), q);
                        let d = q.sub(p).length_squared();
                        if d < best.0 {
                            best = (d, p);
                        }
                    }
                    (best.1, false)
                }
                None => project_core(&shape.core, q),
            };
            let local = if inside && !solid {
                match &shape.grid {
                    Some(grid) => surface_grid(grid, q),
                    None => surface_core(&shape.core, q),
                }
            } else {
                local
            };
            let world = if inside && solid { point } else { xf.apply(local) };
            let distance = if inside && solid { 0.0 } else { point.sub(world).length() };
            all.push(Projection { shape: id, point: world, inside, distance });
        }
        all.sort_by(|a, b| a.distance.total_cmp(&b.distance).then(a.shape.cmp(&b.shape)));
        Ok(all)
    }

    /// The nearest of `project_point_all`.
    pub fn project_point(&mut self, point: V2, filter: &QueryFilter) -> Result<Option<Projection>, PhysicsError> {
        Ok(self.project_point_all(point, filter)?.first().copied())
    }

    /// The shapes whose bounds meet the box from `min` to `max`.
    pub fn aabb_query(&mut self, min: V2, max: V2, filter: &QueryFilter) -> Result<Vec<u32>, PhysicsError> {
        if ![min.x, min.y, max.x, max.y].into_iter().all(f32::is_finite) {
            return Err(PhysicsError::NotFinite);
        }
        let query = Bounds { min: [min.x.min(max.x), min.y.min(max.y)], max: [min.x.max(max.x), min.y.max(max.y)] };
        let mut found = Vec::new();
        self.query_boxes(&query, &mut found);
        let mut out = Vec::new();
        for id in found {
            if !self.accepts(id, filter) {
                continue;
            }
            let shape = &self.shapes[id as usize];
            if crate::world::bounds_of(&shape.core, self.bodies[shape.body as usize].xf)?.overlaps(&query) {
                out.push(id);
            }
        }
        Ok(out)
    }

    /// Gives the broad phase every body's current box, so a query sees a body that was moved since the last step.
    fn query_boxes(&mut self, bounds: &Bounds<2>, out: &mut Vec<u32>) {
        self.broad.query(bounds, out);
    }

    fn accepts(&self, shape: u32, filter: &QueryFilter) -> bool {
        let s = &self.shapes[shape as usize];
        if !self.bodies[s.body as usize].enabled || shape == filter.exclude_shape || s.body == filter.exclude_body || !groups_meet(filter.groups, s.groups) {
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
            let found = match &shape.grid {
                Some(grid) => grid.ray(o, d, max, solid),
                None => ray_core(&shape.core, o, d, max, solid),
            };
            if let Some((t, n)) = found {
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
                let local = self.bodies[shape.body as usize].xf.apply_inverse(point);
                match &shape.grid {
                    Some(grid) => grid.contains(local),
                    None => core_distance(&shape.core, local) <= 0.0,
                }
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
            let target = self.bodies[shape.body as usize].xf;
            let touching = |other: &Core| -> Result<bool, PhysicsError> {
                let m = collide(core, xf, other, target, 0.0)?;
                Ok(m.points[..m.count].iter().any(|p| p.separation <= 0.0))
            };
            let hit = match &shape.grid {
                Some(grid) => {
                    // The query box in the grid's frame, then each filled cell it reaches.
                    let local = Xf::inverse_mul(target, xf);
                    let b = crate::world::bounds_of(core, local)?;
                    let mut any = false;
                    for (c, r) in grid.cells_in(v2(b.min[0], b.min[1]), v2(b.max[0], b.max[1])) {
                        if touching(&grid.cell_core(c, r))? {
                            any = true;
                            break;
                        }
                    }
                    any
                }
                None => touching(&shape.core)?,
            };
            if hit {
                out.push(id);
            }
        }
        Ok(out)
    }

    /// Every shape `core`, slid from `xf` along the unit `direction` for at most `max`, meets, nearest first. A shape
    /// already overlapping is met at 0.
    pub fn shape_cast_all(&mut self, core: &Core, xf: Xf, direction: V2, max: f32, filter: &QueryFilter) -> Result<Vec<CastHit>, PhysicsError> {
        self.shape_cast_all_with(core, xf, direction, max, &CastOptions::default(), filter)
    }

    /// `shape_cast_all` with a target distance and the choice of stopping at a penetration (`CastOptions`).
    pub fn shape_cast_all_with(&mut self, core: &Core, xf: Xf, direction: V2, max: f32, options: &CastOptions, filter: &QueryFilter) -> Result<Vec<CastHit>, PhysicsError> {
        if ![direction.x, direction.y, max, options.target_distance].into_iter().all(f32::is_finite) {
            return Err(PhysicsError::NotFinite);
        }
        if options.target_distance < 0.0 {
            return Err(PhysicsError::InvalidParameter);
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
        let mut hits = Vec::new();
        for id in found {
            if !self.accepts(id, filter) {
                continue;
            }
            let shape = &self.shapes[id as usize];
            let target = self.bodies[shape.body as usize].xf;
            let mut best: Option<CastHit> = None;
            let mut consider = |hit: Option<CastHit>| {
                if let Some(h) = hit {
                    if best.is_none_or(|b| h.t < b.t) {
                        best = Some(CastHit { shape: id, ..h });
                    }
                }
            };
            match &shape.grid {
                Some(grid) => {
                    // The swept box in the grid's frame, then each filled cell it reaches as a box.
                    let (mut lo, mut hi) = (v2(f32::MAX, f32::MAX), v2(f32::MIN, f32::MIN));
                    for (x, y) in [(bounds.min[0], bounds.min[1]), (bounds.max[0], bounds.min[1]), (bounds.max[0], bounds.max[1]), (bounds.min[0], bounds.max[1])] {
                        let p = target.apply_inverse(v2(x, y));
                        lo = v2(lo.x.min(p.x), lo.y.min(p.y));
                        hi = v2(hi.x.max(p.x), hi.y.max(p.y));
                    }
                    for (c, r) in grid.cells_in(lo, hi) {
                        consider(cast_against(core, xf, direction, max, &grid.cell_core(c, r), target, options)?);
                    }
                }
                None => consider(cast_against(core, xf, direction, max, &shape.core, target, options)?),
            }
            if let Some(h) = best {
                hits.push(h);
            }
        }
        hits.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.shape.cmp(&b.shape)));
        Ok(hits)
    }

    pub fn shape_cast(&mut self, core: &Core, xf: Xf, direction: V2, max: f32, filter: &QueryFilter) -> Result<Option<CastHit>, PhysicsError> {
        Ok(self.shape_cast_all(core, xf, direction, max, filter)?.first().copied())
    }
}
