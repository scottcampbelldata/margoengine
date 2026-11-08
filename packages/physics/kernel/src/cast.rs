// Shape casts, point projections and shape overlaps on every shape, the queries that come after rays.
//
// A cast moves a convex query shape along a line until it first touches a collider. As van den Bergen shows ("Ray Casting
// against General Convex Objects with Application to Continuous Collision Detection", 2004, his Algorithm 3), that is a ray
// from the origin against the configuration space obstacle B - A, read only through support points: each support point's
// plane either moves the ray's lower bound up to it (the support plane's normal becomes the hit normal) or proves a miss,
// while a GJK simplex on the points kept so far closes in on the current point of the ray. The closest point of a simplex
// comes from the Signed Volumes sub-algorithm of Montanari, Petrinic and Barbieri (ACM TOG 2017) that `gjk` uses. The loop
// ends at his termination rule, |v|^2 <= tol max |x - p|^2 over the simplex, tol 1e-6, an order of magnitude above the
// f32 machine epsilon as he advises. A target distance grows the obstacle by a ball of that radius (a Minkowski sum, read
// through its support point, his section 3), so the cast stops that far short of touching.
//
// A cast that starts touching hits at 0; its normal and witnesses come from the GJK closest points, or from the expanding
// polytope when the shapes overlap. With `stop` false a start whose way out the cast already follows is not a hit, Rapier's
// `stop_at_penetration` (its documented behaviour, outputs checked through its npm API).
//
// A triangle mesh, height field or voxel grid is cast against triangle by triangle or cell by cell, only those that the
// query's box swept along the cast can reach: the mesh tree by a ray against each node's box grown by the query's half
// extents (the swept box meets the node exactly when that ray does), the grids over the cells under the swept box.
//
// A point projects in closed form onto a ball or capsule; onto a box, hull or triangle by region (a plane's foot inside
// its face, else the nearest edge point; inside a polyhedron the nearest face plane holds the nearest boundary point); and
// onto a voxel grid as the nearest filled cell, or from inside, the nearest empty cell or grid side. An overlap is a GJK
// descent that ends with the origin inside.
use core::cell::Cell;
use crate::bvh::STACK;
use crate::gjk::{Convex, epa, gjk, signed_volumes};
use crate::hull::{BoxData, Poly, box_poly};
use crate::layout::*;
use crate::math::*;
use crate::sat::Pose;
use crate::voxel::CELL_FILLED;
use crate::world::{NONE, World};

const ZERO: V3 = V3 { x: 0.0, y: 0.0, z: 0.0 };

/// A convex shape in one frame: a segment or point grown by a radius, a polyhedron at a pose, or a triangle.
#[derive(Clone, Copy)]
pub enum Solid {
    Round { p: V3, q: V3, r: f32 },
    Poly { poly: Poly, pose: Pose },
    Triangle([V3; 3]),
}

impl Convex for Solid {
    #[inline]
    fn support(&self, d: V3) -> V3 {
        match *self {
            Solid::Round { p, q, r } => {
                let core = if q.dot(d) > p.dot(d) { q } else { p };
                let l = d.dot(d);
                if l > 0.0 { core.add(d.scale(r / sqrt(l))) } else { core }
            }
            Solid::Poly { poly, pose } => pose.apply(poly.support(pose.q.unrotate(d))),
            Solid::Triangle([a, b, c]) => {
                let (da, db, dc) = (a.dot(d), b.dot(d), c.dot(d));
                if da >= db && da >= dc {
                    a
                } else if db >= dc {
                    b
                } else {
                    c
                }
            }
        }
    }
}

/// A query shape: a collider shape kind (ball, box, capsule or hull), its numbers as a collider's, and a hull's row.
#[derive(Clone, Copy)]
pub struct Shape {
    pub kind: u32,
    pub size: V3,
    pub hull: u32,
}

/// A cast's first touch: how far along, the unit normal outward from the collider hit, and the touching points, all in
/// the frame the cast was asked in. `started` is a touch at the start.
#[derive(Clone, Copy, Debug)]
pub struct Cast {
    pub t: f32,
    pub normal: V3,
    pub on_query: V3,
    pub on_target: V3,
    pub started: bool,
}

/// How far a cast goes and what a start in contact means: Rapier's `ShapeCastOptions`.
#[derive(Clone, Copy)]
pub struct CastOptions {
    pub max: f32,
    pub target: f32,
    pub stop: bool,
    pub geometry: bool,
}

/// The closest point of a collider to a point: on its surface, or the point itself when inside a solid shape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projection {
    pub point: V3,
    pub inside: bool,
}

const TOLERANCE: f32 = 1e-6;
const ITERATIONS: usize = 64;

/// The first touch of `a` moving along unit `r` with still `b` (one frame), within `max`, stopping `margin` short:
/// van den Bergen 2004, Algorithm 3. None for a miss.
pub fn cast(a: &impl Convex, b: &impl Convex, r: V3, max: f32, margin: f32) -> Option<Cast> {
    let support = |v: V3| {
        let (on_b, on_a) = (b.support(v), a.support(v.scale(-1.0)));
        let l = v.dot(v);
        let grow = if margin > 0.0 && l > 0.0 { v.scale(margin / sqrt(l)) } else { ZERO };
        (on_b.sub(on_a).add(grow), on_b, on_a)
    };
    let (mut lambda, mut x, mut n) = (0.0f32, ZERO, ZERO);
    let (mut ys, mut bs, mut az) = ([ZERO; 4], [ZERO; 4], [ZERO; 4]);
    let mut weights = [1.0f32, 0.0, 0.0, 0.0];
    let mut count = 0;
    let mut v = x.sub(support(r.scale(-1.0)).0);
    for _ in 0..ITERATIONS {
        let (p, on_b, on_a) = support(v);
        let w = x.sub(p);
        let vw = v.dot(w);
        if vw > 0.0 {
            let vr = v.dot(r);
            if vr >= 0.0 {
                return None;
            }
            lambda -= vw / vr;
            if lambda > max {
                return None;
            }
            x = r.scale(lambda);
            n = v;
        }
        // A support point already in the simplex adds nothing (it comes back once the ray has moved).
        if !ys.iter().take(count).any(|&y| y == p) {
            ys[count] = p;
            bs[count] = on_b;
            az[count] = on_a;
            count += 1;
        }
        let mut points = [ZERO; 4];
        for i in 0..count {
            points[i] = x.sub(ys[i]);
        }
        let closest = signed_volumes(&points, count);
        let mut next = ZERO;
        for i in 0..closest.count {
            next = next.add(points[closest.places[i]].scale(closest.lambda[i]));
        }
        let kept = |s: &[V3; 4]| [s[closest.places[0]], s[closest.places[1]], s[closest.places[2]], s[closest.places[3]]];
        (ys, bs, az) = (kept(&ys), kept(&bs), kept(&az));
        count = closest.count;
        weights = closest.lambda;
        v = next;
        let mut largest = 0.0f32;
        for y in ys.iter().take(count) {
            let e = x.sub(*y);
            largest = largest.max(e.dot(e));
        }
        if count == 4 || v.dot(v) <= TOLERANCE * largest {
            break;
        }
    }
    let (mut on_b, mut on_a) = (ZERO, ZERO);
    for i in 0..count {
        on_b = on_b.add(bs[i].scale(weights[i]));
        on_a = on_a.add(az[i].scale(weights[i]));
    }
    let l = n.dot(n);
    let normal = if l > 0.0 { n.scale(1.0 / sqrt(l)) } else { ZERO };
    Some(Cast { t: lambda, normal, on_query: on_a.add(x), on_target: on_b, started: lambda == 0.0 })
}

/// A solid moved by `by`.
fn shifted(s: &Solid, by: V3) -> Solid {
    match *s {
        Solid::Round { p, q, r } => Solid::Round { p: p.add(by), q: q.add(by), r },
        Solid::Poly { poly, pose } => Solid::Poly { poly, pose: Pose { p: pose.p.add(by), q: pose.q } },
        Solid::Triangle([a, b, c]) => Solid::Triangle([a.add(by), b.add(by), c.add(by)]),
    }
}

/// A solid without its radius, and the radius: a ball's centre, a capsule's segment.
pub(crate) fn core(s: &Solid) -> (Solid, f32) {
    match *s {
        Solid::Round { p, q, r } => (Solid::Round { p, q, r: 0.0 }, r),
        other => (other, 0.0),
    }
}

/// The closest points of two solids and the unit normal from B to A, or for an overlap the way out. The radii come off
/// first, so two round shapes apart at their cores meet in closed form (the core points pushed out by the radii) and only
/// cores that overlap need the expanding polytope.
fn touch(a: &Solid, b: &Solid) -> (V3, V3, V3) {
    let ((core_a, ra), (core_b, rb)) = (core(a), core(b));
    let d = gjk(&core_a, &core_b, ZERO, f32::INFINITY);
    if !d.overlap && d.distance > 0.0 {
        let n = d.on_a.sub(d.on_b).scale(1.0 / d.distance);
        return (n, d.on_a.sub(n.scale(ra)), d.on_b.add(n.scale(rb)));
    }
    let d = gjk(a, b, ZERO, f32::INFINITY);
    match epa(a, b, &d) {
        Some(p) => (p.normal.scale(-1.0), p.on_a, p.on_b),
        None => (ZERO, d.on_a, d.on_b),
    }
}

/// Sharpens a cast's hit by van den Bergen's Algorithm 1 (his section 2), the exact closest point from a full GJK
/// descent: the f32 simplex of Algorithm 3 stops within about 1e-3 of the shapes' size, and these steps, each to where
/// the plane of the closest points says the touch is, take it to the distance GJK resolves. None when the cast turns out
/// to pass by.
fn sharpen(a: &Solid, b: &Solid, r: V3, max: f32, margin: f32, mut hit: Cast) -> Option<Cast> {
    for _ in 0..SHARPEN {
        let d = gjk(&shifted(a, r.scale(hit.t)), b, ZERO, f32::INFINITY);
        (hit.on_query, hit.on_target) = (d.on_a, d.on_b);
        let between = d.on_a.sub(d.on_b);
        let length = sqrt(between.dot(between));
        if d.overlap || !(length > 0.0) {
            break;
        }
        // GJK's distance bounds the gap from above, so a step by it could pass the touch. The gap between support planes
        // along any normal bounds it from below, and a step by that rejects only what the paper's planes reject. Near a
        // touch the closest points' difference is mostly rounding, so other normals are tried too and the largest bound
        // wins: the one kept from a wider gap, the one between round cores (a radius apart, so well read), and each face
        // normal of a polyhedron or triangle, which is exact when a face is what touches (the separating axes of
        // Gregorius 2015).
        let fresh = between.scale(1.0 / length);
        let moved = shifted(a, r.scale(hit.t));
        let bound = |n: V3| moved.support(n.scale(-1.0)).dot(n) - b.support(n).dot(n) - margin;
        let (mut n, mut gap) = (fresh, bound(fresh));
        let mut consider = |m: V3| {
            let g = bound(m);
            if g > gap {
                (n, gap) = (m, g);
            }
        };
        if hit.normal != ZERO {
            consider(hit.normal);
        }
        let ((core_a, ra), (core_b, rb)) = (core(&moved), core(b));
        if ra > 0.0 || rb > 0.0 {
            let c = gjk(&core_a, &core_b, ZERO, f32::INFINITY);
            if !c.overlap && c.distance > 0.0 {
                consider(c.on_a.sub(c.on_b).scale(1.0 / c.distance));
            }
        }
        for (s, sign) in [(b, 1.0f32), (&moved, -1.0)] {
            match *s {
                Solid::Poly { poly, pose } => {
                    for f in 0..poly.faces {
                        consider(pose.q.rotate(poly.normal(f)).scale(sign));
                    }
                }
                Solid::Triangle([p, q, t]) => {
                    let m = q.sub(p).cross(t.sub(p));
                    let l = m.dot(m);
                    if l > 0.0 {
                        let m = m.scale(1.0 / sqrt(l));
                        consider(m);
                        consider(m.scale(-1.0));
                    }
                }
                Solid::Round { .. } => {}
            }
        }
        if length > NORMAL_GAP {
            hit.normal = fresh;
        }
        if gap <= GAP {
            break;
        }
        let closing = -n.dot(r);
        if closing <= 0.0 {
            // Passing by, unless the gap is too small for its normal to say so.
            if length > NORMAL_GAP {
                return None;
            }
            break;
        }
        hit.t += gap / closing;
        if hit.t > max {
            return None;
        }
    }
    // A round shape's touch is read between the cores, which stay a radius apart, so its normal is exact.
    if matches!(a, Solid::Round { .. }) || matches!(b, Solid::Round { .. }) {
        (hit.normal, hit.on_query, hit.on_target) = touch(&shifted(a, r.scale(hit.t)), b);
    }
    Some(hit)
}

/// Steps of `sharpen`, and the gap it stops at: a few f32 roundings of a shape a metre across.
const SHARPEN: usize = 8;
const GAP: f32 = 1e-6;
const NORMAL_GAP: f32 = 1e-4;

/// A cast between two convex shapes with Rapier's options for a start in contact.
pub fn cast_convex(a: &Solid, b: &Solid, r: V3, o: &CastOptions) -> Option<Cast> {
    let hit = cast(a, b, r, o.max, o.target)?;
    if !hit.started {
        return sharpen(a, b, r, o.max, o.target, hit);
    }
    if o.stop && !o.geometry {
        return Some(Cast { normal: ZERO, on_query: ZERO, on_target: ZERO, ..hit });
    }
    let (normal, on_query, on_target) = touch(a, b);
    // Already on the way out: not a hit unless the cast stops at any start in contact.
    if !o.stop && normal.dot(r) >= 0.0 {
        return None;
    }
    Some(if o.geometry { Cast { t: 0.0, normal, on_query, on_target, started: true } } else { Cast { normal: ZERO, on_query: ZERO, on_target: ZERO, ..hit } })
}

/// The point of a convex shape closest to `p`, with `solid` deciding what a point inside gets.
pub fn project_convex(s: &Solid, p: V3, solid: bool) -> Projection {
    match *s {
        Solid::Round { p: a, q: b, r } => {
            let ab = b.sub(a);
            let l = ab.dot(ab);
            let t = if l > 0.0 { (p.sub(a).dot(ab) / l).clamp(0.0, 1.0) } else { 0.0 };
            let core = a.add(ab.scale(t));
            let d = p.sub(core);
            let dl = d.dot(d);
            let inside = dl <= r * r;
            if inside && solid {
                return Projection { point: p, inside };
            }
            // From the core itself any way square to the segment is nearest.
            let way = if dl > 0.0 {
                d.scale(1.0 / sqrt(dl))
            } else if ab.x.abs() < 0.9 * sqrt(l) || l == 0.0 {
                let s = v3(1.0, 0.0, 0.0).sub(ab.scale(if l > 0.0 { ab.x / l } else { 0.0 }));
                s.scale(1.0 / sqrt(s.dot(s)))
            } else {
                let s = v3(0.0, 1.0, 0.0).sub(ab.scale(ab.y / l));
                s.scale(1.0 / sqrt(s.dot(s)))
            };
            Projection { point: core.add(way.scale(r)), inside }
        }
        Solid::Poly { poly, pose } => {
            let local = pose.unapply(p);
            let (mut most, mut face) = (f32::NEG_INFINITY, 0);
            for f in 0..poly.faces {
                let s = poly.normal(f).dot(local) - poly.plane(f);
                if s > most {
                    (most, face) = (s, f);
                }
            }
            if most <= 0.0 {
                if solid {
                    return Projection { point: p, inside: true };
                }
                return Projection { point: pose.apply(local.sub(poly.normal(face).scale(most))), inside: true };
            }
            Projection { point: pose.apply(poly_closest(&poly, local)), inside: false }
        }
        Solid::Triangle(t) => Projection { point: triangle_closest(t, p), inside: false },
    }
}

/// The point of a triangle nearest `p`, by region as `poly_closest`: the plane's foot when it falls inside, otherwise the
/// nearest point of the three edges.
fn triangle_closest([a, b, c]: [V3; 3], p: V3) -> V3 {
    let n = b.sub(a).cross(c.sub(a));
    let l = n.dot(n);
    let mut best = (f32::INFINITY, a);
    let corners = [a, b, c];
    let mut inside = l > 0.0;
    let foot = if l > 0.0 { p.sub(n.scale(n.dot(p.sub(a)) / l)) } else { p };
    for k in 0..3 {
        let (u, v) = (corners[k], corners[(k + 1) % 3]);
        inside &= v.sub(u).cross(foot.sub(u)).dot(n) >= 0.0;
        let uv = v.sub(u);
        let along = uv.dot(uv);
        let t = if along > 0.0 { (p.sub(u).dot(uv) / along).clamp(0.0, 1.0) } else { 0.0 };
        let q = u.add(uv.scale(t));
        let d = q.sub(p).dot(q.sub(p));
        if d < best.0 {
            best = (d, q);
        }
    }
    if inside { foot } else { best.1 }
}

/// The point of a polyhedron nearest a point outside it, exactly, by region: a plane's foot that falls inside its face,
/// seen from above that face's plane, is the nearest point (the prism over a face of a convex polyhedron is that face's
/// region); failing that, the nearest point of the edges. Comparing squared distances cannot settle it, as a slide of
/// 5e-4 along the surface changes the square of a 4 m distance by less than its rounding; nor can GJK's stop at a
/// relative gap of 1e-6, which leaves the point up to the root of that off along the surface.
fn poly_closest(poly: &Poly, p: V3) -> V3 {
    let (mut best, mut near) = (f32::INFINITY, ZERO);
    let mut offer = |q: V3| {
        let d = q.sub(p).dot(q.sub(p));
        if d < best {
            (best, near) = (d, q);
        }
    };
    for f in 0..poly.faces {
        let n = poly.normal(f);
        let above = n.dot(p) - poly.plane(f);
        let foot = p.sub(n.scale(above));
        let (first, mut e) = (poly.first(f), poly.first(f));
        let (mut inside, mut sign) = (true, 0.0f32);
        loop {
            let next = poly.next(e);
            let (a, b) = (poly.vertex(poly.origin(e)), poly.vertex(poly.origin(next)));
            let side = b.sub(a).cross(foot.sub(a)).dot(n);
            if sign == 0.0 {
                sign = side;
            } else if side * sign < 0.0 {
                inside = false;
            }
            let ab = b.sub(a);
            let t = (p.sub(a).dot(ab) / ab.dot(ab)).clamp(0.0, 1.0);
            offer(a.add(ab.scale(t)));
            e = next;
            if e == first {
                break;
            }
        }
        if inside && above > 0.0 {
            return foot;
        }
    }
    near
}

/// The box that holds a convex shape, from its six axis support points.
pub(crate) fn bounds(s: &impl Convex) -> (V3, V3) {
    let (x, y, z) = (v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0));
    let high = v3(s.support(x).x, s.support(y).y, s.support(z).z);
    let low = v3(s.support(x.scale(-1.0)).x, s.support(y.scale(-1.0)).y, s.support(z.scale(-1.0)).z);
    (low, high)
}

/// The entry and exit of a ray against a box, from 0 to `max`; a start inside enters at 0.
fn span(o: V3, d: V3, low: V3, high: V3, max: f32) -> Option<(f32, f32)> {
    let (os, ds, lo, hi) = ([o.x, o.y, o.z], [d.x, d.y, d.z], [low.x, low.y, low.z], [high.x, high.y, high.z]);
    let (mut enter, mut leave) = (0.0f32, max);
    for k in 0..3 {
        if ds[k] == 0.0 {
            if os[k] < lo[k] || os[k] > hi[k] {
                return None;
            }
            continue;
        }
        let inv = 1.0 / ds[k];
        let (near, far) = if inv >= 0.0 { (lo[k], hi[k]) } else { (hi[k], lo[k]) };
        enter = enter.max((near - os[k]) * inv);
        leave = leave.min((far - os[k]) * inv);
    }
    if enter <= leave { Some((enter, leave)) } else { None }
}

/// The squared distance from a point to a box.
fn box_squared(p: V3, low: V3, high: V3) -> f32 {
    let d = p.sub(p.max(low).min(high));
    d.dot(d)
}

/// The largest whole number at or below `f`, for the finite values a cell index needs.
fn floor(f: f32) -> i64 {
    let i = f as i64;
    if (i as f32) > f { i - 1 } else { i }
}

fn nearer(best: Option<Cast>, hit: Option<Cast>) -> Option<Cast> {
    match (best, hit) {
        (Some(b), Some(h)) if h.t < b.t => Some(h),
        (None, h) => h,
        (b, _) => b,
    }
}

impl World {
    /// A query shape at `pose` as a solid; a box keeps its numbers in `data`. None for a kind a query shape cannot be.
    pub fn solid(&self, shape: Shape, pose: Pose, data: &mut BoxData) -> Option<Solid> {
        Some(match shape.kind {
            SHAPE_BALL => Solid::Round { p: pose.p, q: pose.p, r: shape.size.x },
            SHAPE_CAPSULE => {
                let along = pose.q.rotate(v3(0.0, shape.size.y, 0.0));
                Solid::Round { p: pose.p.sub(along), q: pose.p.add(along), r: shape.size.x }
            }
            SHAPE_BOX => Solid::Poly { poly: box_poly(shape.size, data), pose },
            SHAPE_HULL if shape.hull < self.header().hull_rows[0] => Solid::Poly { poly: self.hull_poly(shape.hull as usize), pose },
            _ => return None,
        })
    }

    pub(crate) fn shape_of(&self, c: usize) -> Shape {
        Shape { kind: self.uu(COLLIDER_SHAPE, c), size: self.v(COLLIDER_A, c), hull: self.uu(COLLIDER_HULL, c) }
    }

    /// The first touch of a query shape at `pose` moving along unit `r` (world space) with collider `c`.
    pub fn cast_collider(&self, c: usize, shape: Shape, pose: Pose, r: V3, o: &CastOptions) -> Option<Cast> {
        let kind = self.uu(COLLIDER_SHAPE, c);
        if kind == SHAPE_COMPOUND {
            let mut best: Option<Cast> = None;
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != NONE {
                let limit = CastOptions { max: best.map_or(o.max, |b| b.t), ..*o };
                best = nearer(best, self.cast_collider(child as usize, shape, pose, r, &limit));
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return best;
        }
        let frame = self.collider_pose(c);
        let (mut query_data, mut target_data) = (BoxData::new(), BoxData::new());
        if kind != SHAPE_TRIMESH {
            let query = self.solid(shape, pose, &mut query_data)?;
            let target = self.solid(self.shape_of(c), frame, &mut target_data)?;
            return cast_convex(&query, &target, r, o);
        }
        let query = self.solid(shape, frame.relative(pose), &mut query_data)?;
        let hit = self.cast_triangles(self.uu(COLLIDER_HULL, c) as usize, &query, frame.q.unrotate(r), o)?;
        let normal = frame.q.rotate(hit.normal);
        let (on_query, on_target) = if hit.started && !o.geometry { (ZERO, ZERO) } else { (frame.apply(hit.on_query), frame.apply(hit.on_target)) };
        Some(Cast { normal, on_query, on_target, ..hit })
    }

    /// A cast in a mesh's, height field's or voxel grid's frame against the triangles or cells it can reach.
    fn cast_triangles(&self, mesh: usize, query: &Solid, r: V3, o: &CastOptions) -> Option<Cast> {
        let (low, high) = bounds(query);
        let grow = v3(o.target, o.target, o.target);
        let (center, half) = (low.add(high).scale(0.5), high.sub(low).scale(0.5).add(grow));
        let (box_low, box_high) = self.mesh_bounds(mesh);
        let (t0, t1) = span(center, r, box_low.sub(half), box_high.add(half), o.max)?;
        let reach = (low.min(low.add(r.scale(t0))).min(low.add(r.scale(t1))).sub(grow), high.max(high.add(r.scale(t0))).max(high.add(r.scale(t1))).add(grow));
        let limit = Cell::new(o.max);
        let mut best: Option<Cast> = None;
        self.each_part(mesh, reach, &|lo, hi| span(center, r, lo.sub(half), hi.add(half), limit.get()).is_some(), &mut |target| {
            best = nearer(best, cast_convex(query, &target, r, &CastOptions { max: limit.get(), ..*o }));
            if let Some(b) = best {
                limit.set(b.t);
            }
            true
        });
        best
    }

    /// Calls `visit` with each part of mesh, height field or voxel grid `mesh` that may meet the box `reach` in its frame,
    /// until it returns false: the filled voxel cells and the height field triangles under the box, and the triangles in
    /// the leaves of the mesh tree whose node boxes `node` lets through.
    pub(crate) fn each_part(&self, mesh: usize, (low, high): (V3, V3), node: &dyn Fn(V3, V3) -> bool, visit: &mut dyn FnMut(Solid) -> bool) {
        if self.is_voxels(mesh) {
            let mut data = BoxData::new();
            let poly = box_poly(self.v(VOXEL_SIZE_X, mesh).scale(0.5), &mut data);
            let mut going = true;
            self.each_cell(mesh, (low, high), &mut |index, at| {
                if going && self.cell_byte(mesh, index) & CELL_FILLED != 0 {
                    going = visit(Solid::Poly { poly, pose: Pose { p: at, q: Q::IDENTITY } });
                }
            });
            return;
        }
        if let Some((rows, columns)) = self.grid_size(mesh) {
            let Some([r0, r1, c0, c1]) = self.grid_cells(mesh, rows, columns, low, high) else { return };
            for c in c0..=c1 {
                for r in r0..=r1 {
                    if self.cell_reaches(mesh, rows, r, c, low.y, high.y) {
                        let cell = 2 * (r + rows * c);
                        if !visit(Solid::Triangle(self.mesh_triangle(mesh, cell))) || !visit(Solid::Triangle(self.mesh_triangle(mesh, cell + 1))) {
                            return;
                        }
                    }
                }
            }
            return;
        }
        if self.uu(MESH_NODES, mesh) == 0 {
            return;
        }
        let (t0, n0) = (self.uu(MESH_FIRST_TRIANGLE, mesh) as usize, self.uu(MESH_FIRST_NODE, mesh) as usize);
        let mut stack = [0u32; STACK + 1];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let at = n0 + stack[top] as usize;
            if !node(self.v(NODE_MIN_X, at), self.v(NODE_MAX_X, at)) {
                continue;
            }
            let (first, count) = (self.uu(NODE_FIRST, at), self.uu(NODE_COUNT, at));
            if count == 0 {
                stack[top] = first + 1;
                stack[top + 1] = first;
                top += 2;
                continue;
            }
            for place in first..first + count {
                if !visit(Solid::Triangle(self.mesh_triangle(mesh, self.uu(TRIANGLE_ORDER, t0 + place as usize)))) {
                    return;
                }
            }
        }
    }

    /// The box a mesh, height field or voxel grid fills, in its frame.
    fn mesh_bounds(&self, mesh: usize) -> (V3, V3) {
        let (c, h) = (self.v(MESH_BOX_X, mesh), self.v(MESH_HALF_X, mesh));
        (c.sub(h), c.add(h))
    }

    /// Calls `visit` with the index and centre of each voxel cell, filled or not, that meets the box `reach`.
    fn each_cell(&self, mesh: usize, (low, high): (V3, V3), visit: &mut dyn FnMut(u32, V3)) {
        let s = self.v(VOXEL_SIZE_X, mesh);
        let min = [self.uu(VOXEL_MIN_X, mesh) as i32, self.uu(VOXEL_MIN_Y, mesh) as i32, self.uu(VOXEL_MIN_Z, mesh) as i32];
        let dims = [self.uu(VOXEL_DIM_X, mesh), self.uu(VOXEL_DIM_Y, mesh), self.uu(VOXEL_DIM_Z, mesh)];
        let (lo, hi, ss) = ([low.x, low.y, low.z], [high.x, high.y, high.z], [s.x, s.y, s.z]);
        let mut range = [(0u32, 0u32); 3];
        for k in 0..3 {
            let a = floor(lo[k] / ss[k]) - min[k] as i64;
            let b = floor(hi[k] / ss[k]) - min[k] as i64;
            if b < 0 || a >= dims[k] as i64 {
                return;
            }
            range[k] = (a.max(0) as u32, b.min(dims[k] as i64 - 1) as u32);
        }
        for z in range[2].0..=range[2].1 {
            for y in range[1].0..=range[1].1 {
                for x in range[0].0..=range[0].1 {
                    let at = v3((min[0] + x as i32) as f32 + 0.5, (min[1] + y as i32) as f32 + 0.5, (min[2] + z as i32) as f32 + 0.5).mul(s);
                    visit(x + dims[0] * (y + dims[1] * z), at);
                }
            }
        }
    }

    /// The nearest first touch of a query shape cast from `pose` along unit `r` among the colliders `filter` lets
    /// through.
    pub fn cast_shape(&self, shape: Shape, pose: Pose, r: V3, o: &CastOptions, filter: &crate::query::Filter) -> Option<(u32, Cast)> {
        let mut best: Option<(u32, Cast)> = None;
        self.each_queried(filter, &mut |c| {
            let limit = CastOptions { max: best.map_or(o.max, |(_, b)| b.t), ..*o };
            if let Some(hit) = self.cast_collider(c, shape, pose, r, &limit)
                && best.is_none_or(|(_, b)| hit.t < b.t)
            {
                best = Some((c as u32, hit));
            }
            true
        });
        best
    }

    /// The point of collider `c` closest to `p` (world space).
    pub fn project_collider(&self, c: usize, p: V3, solid: bool) -> Option<Projection> {
        let kind = self.uu(COLLIDER_SHAPE, c);
        if kind == SHAPE_COMPOUND {
            let mut best: Option<(f32, Projection)> = None;
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != NONE {
                if let Some(hit) = self.project_collider(child as usize, p, solid) {
                    let d = if hit.inside && solid { 0.0 } else { hit.point.sub(p).dot(hit.point.sub(p)) };
                    // Inside any child is inside the compound.
                    let rank = if hit.inside { -1.0 / (1.0 + d) } else { d };
                    if best.is_none_or(|(b, _)| rank < b) {
                        best = Some((rank, hit));
                    }
                }
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return best.map(|(_, hit)| hit);
        }
        let frame = self.collider_pose(c);
        let mut data = BoxData::new();
        if kind != SHAPE_TRIMESH {
            return Some(project_convex(&self.solid(self.shape_of(c), frame, &mut data)?, p, solid));
        }
        let hit = self.project_triangles(self.uu(COLLIDER_HULL, c) as usize, frame.unapply(p), solid)?;
        Some(Projection { point: frame.apply(hit.point), inside: hit.inside })
    }

    /// A point in a mesh's, height field's or voxel grid's frame onto its triangles or filled cells.
    fn project_triangles(&self, mesh: usize, p: V3, solid: bool) -> Option<Projection> {
        let mut best: Option<(f32, V3)> = None;
        let offer = |best: &mut Option<(f32, V3)>, q: V3| {
            let d = q.sub(p).dot(q.sub(p));
            if best.is_none_or(|(b, _)| d < b) {
                *best = Some((d, q));
            }
        };
        if self.is_voxels(mesh) {
            let s = self.v(VOXEL_SIZE_X, mesh).scale(0.5);
            let (low, high) = self.mesh_bounds(mesh);
            let mut inside = false;
            self.each_cell(mesh, (p, p), &mut |index, _| inside |= self.cell_byte(mesh, index) & CELL_FILLED != 0);
            if inside && solid {
                return Some(Projection { point: p, inside });
            }
            // From inside, the nearest point that is not in a filled cell: an empty cell or a side of the grid.
            self.each_cell(mesh, (low, high), &mut |index, at| {
                if (self.cell_byte(mesh, index) & CELL_FILLED != 0) != inside {
                    offer(&mut best, p.max(at.sub(s)).min(at.add(s)));
                }
            });
            if inside {
                for (k, (a, b)) in [(low.x, high.x), (low.y, high.y), (low.z, high.z)].into_iter().enumerate() {
                    for side in [a, b] {
                        let mut q = [p.x, p.y, p.z];
                        q[k] = side;
                        offer(&mut best, v3(q[0], q[1], q[2]));
                    }
                }
            }
            return best.map(|(_, point)| Projection { point, inside });
        }
        let best = Cell::new(best);
        let nearer_than_best = |low: V3, high: V3| best.get().is_none_or(|(b, _)| box_squared(p, low, high) < b);
        self.each_part(mesh, self.mesh_bounds(mesh), &nearer_than_best, &mut |target| {
            if let Solid::Triangle([a, b, c]) = target
                && nearer_than_best(a.min(b).min(c), a.max(b).max(c))
            {
                let mut kept = best.get();
                offer(&mut kept, triangle_closest([a, b, c], p));
                best.set(kept);
            }
            true
        });
        best.get().map(|(_, point)| Projection { point, inside: false })
    }

    /// The point of any collider `filter` lets through nearest to `p`: the collider and its projection. A point inside
    /// a solid collider projects to itself and wins.
    pub fn project_point(&self, p: V3, solid: bool, filter: &crate::query::Filter) -> Option<(u32, Projection)> {
        let mut best: Option<(u32, f32, Projection)> = None;
        self.each_queried(filter, &mut |c| {
            if let Some(hit) = self.project_collider(c, p, solid) {
                let d = if hit.inside && solid { -1.0 } else { hit.point.sub(p).dot(hit.point.sub(p)) };
                if best.is_none_or(|(_, b, _)| d < b) {
                    best = Some((c as u32, d, hit));
                }
            }
            true
        });
        best.map(|(c, _, hit)| (c, hit))
    }

    /// True when collider `c` holds `p`.
    pub fn holds_point(&self, c: usize, p: V3) -> bool {
        self.project_collider(c, p, true).is_some_and(|hit| hit.inside)
    }

    /// True when a query shape at `pose` overlaps collider `c`.
    pub fn overlaps(&self, c: usize, shape: Shape, pose: Pose) -> bool {
        let kind = self.uu(COLLIDER_SHAPE, c);
        if kind == SHAPE_COMPOUND {
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != NONE {
                if self.overlaps(child as usize, shape, pose) {
                    return true;
                }
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return false;
        }
        let frame = self.collider_pose(c);
        let (mut query_data, mut target_data) = (BoxData::new(), BoxData::new());
        let meets = |a: &Solid, b: &Solid| gjk(a, b, ZERO, 0.0).overlap;
        if kind != SHAPE_TRIMESH {
            let (Some(query), Some(target)) = (self.solid(shape, pose, &mut query_data), self.solid(self.shape_of(c), frame, &mut target_data)) else { return false };
            return meets(&query, &target);
        }
        let Some(query) = self.solid(shape, frame.relative(pose), &mut query_data) else { return false };
        let (low, high) = bounds(&query);
        let mut found = false;
        let meets_box = |a: V3, b: V3| !(a.x > high.x || a.y > high.y || a.z > high.z || b.x < low.x || b.y < low.y || b.z < low.z);
        self.each_part(self.uu(COLLIDER_HULL, c) as usize, (low, high), &meets_box, &mut |target| {
            found = meets(&query, &target);
            !found
        });
        found
    }
}
