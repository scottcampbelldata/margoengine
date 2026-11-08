// Scene queries: rays against every shape, and the filter that picks which colliders a query sees.
//
// A convex shape gives the ray an interval [enter, leave] with a normal at each end: the ball and capsule from their
// quadratics, the box by slabs (Williams, Barrus, Morley and Shirley 2005, "An Efficient and Robust Ray-Box Intersection
// Algorithm", JGT 10(1), the reciprocal's sign deciding the order so a direction of -0 still works), a hull by the
// half-spaces of its faces, the same slab rule over the face planes. A ray that starts inside a solid shape hits at 0
// with no normal; one that starts inside a hollow shape (`solid` false) hits where it leaves, the normal turned to face
// the ray, as Rapier's do (checked through its npm API, outputs only).
//
// Triangles by Moller and Trumbore 1997 ("Fast, Minimum Storage Ray/Triangle Intersection", JGT 2(1)), two-sided, the
// normal facing the ray; a mesh by its tree, a node skipped when its box is beyond the nearest hit so far. A height field
// and a voxel grid are walked cell by cell in the order the ray crosses them (Amanatides and Woo 1987, "A Fast Voxel
// Traversal Algorithm for Ray Tracing", Eurographics): the next boundary on each axis, the nearest taken, so the first
// cell with a hit holds the nearest one. A height field's columns need not be evenly spaced, so each boundary is read
// from its vertex instead of stepping by a fixed width.
use crate::bvh::STACK;
use crate::events::groups_meet;
use crate::hull::Poly;
use crate::layout::*;
use crate::math::*;
use crate::voxel::CELL_FILLED;
use crate::world::{NONE, World};

/// Which colliders a query sees, as Rapier's `QueryFilter`: flag bits, packed interaction groups and two rows to leave out.
#[derive(Clone, Copy)]
pub struct Filter {
    pub flags: u32,
    pub groups: u32,
    pub collider: u32,
    pub body: u32,
}

pub const EXCLUDE_FIXED: u32 = 1;
pub const EXCLUDE_KINEMATIC: u32 = 2;
pub const EXCLUDE_DYNAMIC: u32 = 4;
pub const EXCLUDE_SENSORS: u32 = 8;
pub const EXCLUDE_SOLIDS: u32 = 16;
pub const ONLY_DYNAMIC: u32 = 32;
pub const ONLY_KINEMATIC: u32 = 64;
pub const ONLY_FIXED: u32 = 128;

/// A ray's hit: how far along it, and the surface normal there (zero for a start inside a solid shape).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct RayHit {
    pub t: f32,
    pub normal: V3,
}

const ZERO: V3 = V3 { x: 0.0, y: 0.0, z: 0.0 };

/// What a convex interval gives a ray from 0 to `max`: its entry, or for a start inside, 0 (solid) or its exit.
#[inline(always)]
fn interval_hit(enter: f32, enter_n: V3, leave: f32, leave_n: V3, max: f32, solid: bool) -> Option<RayHit> {
    if enter > leave || leave < 0.0 {
        return None;
    }
    if enter <= 0.0 {
        if solid {
            return Some(RayHit { t: 0.0, normal: ZERO });
        }
        return if leave <= max { Some(RayHit { t: leave, normal: leave_n.scale(-1.0) }) } else { None };
    }
    if enter <= max { Some(RayHit { t: enter, normal: enter_n }) } else { None }
}

/// The two roots of a t^2 - 2 b t + c = 0 for a ray against a round surface, where `f` is the origin less the centre
/// (in the plane of the surface's section for a cylinder) and `d` the direction there, in the forms of Haines, Gunther
/// and Akenine-Moller 2019 (Ray Tracing Gems ch. 7): the discriminant from the centre's distance to the line, which
/// subtracts before it squares, and the far root of the stable quadratic of Press et al. with the near one from the
/// product of the roots. None when the line misses.
#[inline(always)]
fn round_roots(f: V3, d: V3, r: f32) -> Option<(f32, f32)> {
    let a = d.dot(d);
    if a == 0.0 {
        return None;
    }
    let b = -f.dot(d);
    let foot = f.add(d.scale(b / a));
    let disc = r * r - foot.dot(foot);
    if disc < 0.0 {
        return None;
    }
    let c = f.dot(f) - r * r;
    let q = b + if b > 0.0 { sqrt(a * disc) } else { -sqrt(a * disc) };
    if q == 0.0 {
        return Some((0.0, 0.0));
    }
    let (t0, t1) = (c / q, q / a);
    Some(if t0 <= t1 { (t0, t1) } else { (t1, t0) })
}

/// The interval of a ray from `o` along `d` through a ball of radius `r` at `c`, with the normals at its ends.
#[inline(always)]
fn ball_interval(o: V3, d: V3, c: V3, r: f32) -> Option<(f32, V3, f32, V3)> {
    let (t0, t1) = round_roots(o.sub(c), d, r)?;
    let normal = |t: f32| o.add(d.scale(t)).sub(c).scale(1.0 / r);
    Some((t0, normal(t0), t1, normal(t1)))
}

/// A ray against a ball of radius `r` at the origin.
pub fn ray_ball(o: V3, d: V3, r: f32, max: f32, solid: bool) -> Option<RayHit> {
    let (t0, n0, t1, n1) = ball_interval(o, d, ZERO, r)?;
    interval_hit(t0, n0, t1, n1, max, solid)
}

/// A ray against a capsule along y, half height `h` between its ball centres, radius `r`: the union of the side
/// cylinder between the centres and the two end balls, which along a line is one interval since the capsule is convex.
pub fn ray_capsule(o: V3, d: V3, h: f32, r: f32, max: f32, solid: bool) -> Option<RayHit> {
    let (mut enter, mut enter_n, mut leave, mut leave_n) = (f32::INFINITY, ZERO, f32::NEG_INFINITY, ZERO);
    let mut take = |t0: f32, n0: V3, t1: f32, n1: V3| {
        if t0 > t1 {
            return;
        }
        if t0 < enter {
            enter = t0;
            enter_n = n0;
        }
        if t1 > leave {
            leave = t1;
            leave_n = n1;
        }
    };
    for end in [h, -h] {
        if let Some((t0, n0, t1, n1)) = ball_interval(o, d, v3(0.0, end, 0.0), r) {
            take(t0, n0, t1, n1);
        }
    }
    // The side: x and z inside the radius, y between the centres.
    let (flat_o, flat_d) = (v3(o.x, 0.0, o.z), v3(d.x, 0.0, d.z));
    let side = if flat_d.dot(flat_d) == 0.0 {
        if flat_o.dot(flat_o) <= r * r { Some((f32::NEG_INFINITY, f32::INFINITY)) } else { None }
    } else {
        round_roots(flat_o, flat_d, r)
    };
    let span = if d.y == 0.0 {
        if o.y >= -h && o.y <= h { Some((f32::NEG_INFINITY, f32::INFINITY)) } else { None }
    } else {
        let inv = 1.0 / d.y;
        let (s0, s1) = ((-h - o.y) * inv, (h - o.y) * inv);
        Some(if inv >= 0.0 { (s0, s1) } else { (s1, s0) })
    };
    if let (Some((c0, c1)), Some((s0, s1))) = (side, span) {
        let (t0, t1) = (if c0 > s0 { c0 } else { s0 }, if c1 < s1 { c1 } else { s1 });
        // An end of the clipped side on a flat end lies inside that end's ball, which already gave an end as far out.
        let radial = |t: f32| {
            let p = o.add(d.scale(t));
            v3(p.x / r, 0.0, p.z / r)
        };
        if t0 <= t1 {
            take(t0, if c0 >= s0 { radial(t0) } else { ZERO }, t1, if c1 <= s1 { radial(t1) } else { ZERO });
        }
    }
    if enter == f32::INFINITY {
        return None;
    }
    interval_hit(enter, enter_n, leave, leave_n, max, solid)
}

/// A ray against a cylinder along y of radius `r` and half height `h`: the slab between the caps met with the infinite
/// side cylinder, one interval as the cylinder is convex.
pub fn ray_cylinder(o: V3, d: V3, r: f32, h: f32, max: f32, solid: bool) -> Option<RayHit> {
    let up = v3(0.0, 1.0, 0.0);
    let (mut enter, mut enter_n, mut leave, mut leave_n) = (f32::NEG_INFINITY, ZERO, f32::INFINITY, ZERO);
    if d.y == 0.0 {
        if o.y < -h || o.y > h {
            return None;
        }
    } else {
        let inv = 1.0 / d.y;
        let (s0, s1) = ((-h - o.y) * inv, (h - o.y) * inv);
        (enter, enter_n, leave, leave_n) = if inv >= 0.0 { (s0, up.scale(-1.0), s1, up) } else { (s1, up, s0, up.scale(-1.0)) };
    }
    let (flat_o, flat_d) = (v3(o.x, 0.0, o.z), v3(d.x, 0.0, d.z));
    if flat_d.dot(flat_d) == 0.0 {
        if flat_o.dot(flat_o) > r * r {
            return None;
        }
    } else {
        let (c0, c1) = round_roots(flat_o, flat_d, r)?;
        let radial = |t: f32| {
            let p = o.add(d.scale(t));
            v3(p.x / r, 0.0, p.z / r)
        };
        if c0 > enter {
            (enter, enter_n) = (c0, radial(c0));
        }
        if c1 < leave {
            (leave, leave_n) = (c1, radial(c1));
        }
    }
    interval_hit(enter, enter_n, leave, leave_n, max, solid)
}

/// A ray against a cone along y, apex at y = `h`, base disk of radius `r` at y = -h: the half-space above the base met with
/// the solid nappe x^2 + z^2 <= k^2 (h - y)^2, h - y >= 0, k = r / 2h. Along the ray the nappe's quadratic is
/// a t^2 + 2 b t + c <= 0; where a > 0 the set between the roots lies on one nappe, where a < 0 the two outer half-lines lie
/// on the two nappes, and the sign of h - y along the ray picks this one.
pub fn ray_cone(o: V3, d: V3, r: f32, h: f32, max: f32, solid: bool) -> Option<RayHit> {
    // From a far start the quadratic's terms grow with the distance squared and cancel. Solving from the point of the
    // line nearest the cone's centre keeps them at the cone's own size (Haines, Gunther and Akenine-Moller 2019, Ray
    // Tracing Gems ch. 7); the shift is added back to both ends.
    let dd = d.dot(d);
    let shift = if dd > 0.0 { -o.dot(d) / dd } else { 0.0 };
    let (enter, enter_n, leave, leave_n) = cone_interval(o.add(d.scale(shift)), d, r, h)?;
    interval_hit(enter + shift, enter_n, leave + shift, leave_n, max, solid)
}

/// The interval of the line from `o` along `d` through the cone of `ray_cone`, with the normals at its ends.
#[inline(always)]
fn cone_interval(o: V3, d: V3, r: f32, h: f32) -> Option<(f32, V3, f32, V3)> {
    let up = v3(0.0, 1.0, 0.0);
    let (mut enter, mut enter_n, mut leave, mut leave_n) = (f32::NEG_INFINITY, ZERO, f32::INFINITY, ZERO);
    if d.y == 0.0 {
        if o.y < -h {
            return None;
        }
    } else {
        let t = (-h - o.y) / d.y;
        if d.y > 0.0 {
            (enter, enter_n) = (t, up.scale(-1.0));
        } else {
            (leave, leave_n) = (t, up.scale(-1.0));
        }
    }
    // The nappe's side of the apex: h - y >= 0, a half-line of the ray (or all of it, or none, along a level ray).
    let w0 = h - o.y;
    let (mut low, mut high) = (f32::NEG_INFINITY, f32::INFINITY);
    if d.y == 0.0 {
        if w0 < 0.0 {
            return None;
        }
    } else if d.y > 0.0 {
        high = w0 / d.y;
    } else {
        low = w0 / d.y;
    }
    let k2 = (r / (2.0 * h)) * (r / (2.0 * h));
    let a = d.x * d.x + d.z * d.z - k2 * d.y * d.y;
    let b = o.x * d.x + o.z * d.z + k2 * w0 * d.y;
    let c = o.x * o.x + o.z * o.z - k2 * w0 * w0;
    // The ray's interval inside the double cone that lies on the nappe's side.
    let (n0, n1) = if a == 0.0 {
        if b == 0.0 {
            if c > 0.0 {
                return None;
            }
            (f32::NEG_INFINITY, f32::INFINITY)
        } else if b > 0.0 {
            (f32::NEG_INFINITY, -c / (2.0 * b))
        } else {
            (-c / (2.0 * b), f32::INFINITY)
        }
    } else {
        let disc = b * b - a * c;
        if disc < 0.0 {
            if a > 0.0 {
                return None;
            }
            (f32::NEG_INFINITY, f32::INFINITY)
        } else {
            let q = -b - if b >= 0.0 { sqrt(disc) } else { -sqrt(disc) };
            let (t0, t1) = if q == 0.0 { (0.0, 0.0) } else { (q / a, c / q) };
            let (t0, t1) = if t0 <= t1 { (t0, t1) } else { (t1, t0) };
            if a > 0.0 {
                (t0, t1)
            } else if d.y > 0.0 {
                // Rising, the ray leaves the nappe's side at `high`: the lower half-line.
                (f32::NEG_INFINITY, t0)
            } else {
                (t1, f32::INFINITY)
            }
        }
    };
    let (n0, n1) = (n0.max(low), n1.min(high));
    if n0 > n1 {
        return None;
    }
    let side = |t: f32| {
        let p = o.add(d.scale(t));
        let n = v3(p.x, k2 * (h - p.y), p.z);
        let l = n.dot(n);
        if l > 0.0 { n.scale(1.0 / sqrt(l)) } else { up }
    };
    if n0 > enter {
        (enter, enter_n) = (n0, side(n0));
    }
    if n1 < leave {
        (leave, leave_n) = (n1, side(n1));
    }
    Some((enter, enter_n, leave, leave_n))
}

/// A ray against a cylinder or cone with a border, through the GJK ray cast of `cast_convex`, its direction made unit and
/// its distances scaled back. From inside a hollow one, the cast runs back from beyond the far side to find the exit. The
/// normal is read in closed form, from the core's point nearest the hit (the profile projection): GJK's own direction is
/// held only to the square root of its relative stop, a few 1e-4 on a curve.
fn ray_rounded(o: V3, d: V3, shape: crate::revolve::Revolved, border: f32, max: f32, solid: bool) -> Option<RayHit> {
    use crate::cast::{CastOptions, Solid, cast_convex};
    let l = sqrt(d.dot(d));
    if l == 0.0 {
        return None;
    }
    let r = d.scale(1.0 / l);
    let target = Solid::Revolved { shape, border, pose: crate::sat::Pose { p: ZERO, q: Q::IDENTITY } };
    let point = |p: V3| Solid::Round { p, q: p, r: 0.0 };
    let options = |max: f32| CastOptions { max, target: 0.0, stop: true, geometry: true };
    // The surface's outward normal at a point on it: from the core's nearest point, a border away.
    let outward = |p: V3, fallback: V3| {
        let n = p.sub(shape.project(p, 0.0).0);
        let squared = n.dot(n);
        if squared > 0.0 { n.scale(1.0 / sqrt(squared)) } else { fallback }
    };
    let hit = cast_convex(&point(o), &target, r, &options(max * l))?;
    if !hit.started {
        return Some(RayHit { t: hit.t / l, normal: outward(o.add(r.scale(hit.t)), hit.normal) });
    }
    if solid {
        return Some(RayHit { t: 0.0, normal: ZERO });
    }
    let beyond = sqrt(o.dot(o)) + 2.0 * shape.reach(border);
    let back = cast_convex(&point(o.add(r.scale(beyond))), &target, r.scale(-1.0), &options(beyond))?;
    let t = (beyond - back.t) / l;
    if t <= max { Some(RayHit { t, normal: outward(o.add(d.scale(t)), back.normal).scale(-1.0) }) } else { None }
}

/// A ray against a box of half extents `h` centred at the origin, by slabs.
pub fn ray_box(o: V3, d: V3, h: V3, max: f32, solid: bool) -> Option<RayHit> {
    let (os, ds, hs) = ([o.x, o.y, o.z], [d.x, d.y, d.z], [h.x, h.y, h.z]);
    let (mut enter, mut enter_axis, mut leave, mut leave_axis) = (f32::NEG_INFINITY, 3, f32::INFINITY, 3);
    for k in 0..3 {
        if ds[k] == 0.0 {
            if os[k] < -hs[k] || os[k] > hs[k] {
                return None;
            }
            continue;
        }
        let inv = 1.0 / ds[k];
        let (near, far) = if inv >= 0.0 { (-hs[k], hs[k]) } else { (hs[k], -hs[k]) };
        let (t0, t1) = ((near - os[k]) * inv, (far - os[k]) * inv);
        if t0 > enter {
            enter = t0;
            enter_axis = k;
        }
        if t1 < leave {
            leave = t1;
            leave_axis = k;
        }
    }
    let axis_normal = |k: usize, sign: f32| {
        if k == 3 {
            return ZERO;
        }
        let mut n = [0.0f32; 3];
        n[k] = if ds[k] > 0.0 { sign } else { -sign };
        v3(n[0], n[1], n[2])
    };
    interval_hit(enter, axis_normal(enter_axis, -1.0), leave, axis_normal(leave_axis, 1.0), max, solid)
}

/// A ray against a convex polyhedron, by the half-spaces of its faces.
pub fn ray_poly(poly: &Poly, o: V3, d: V3, max: f32, solid: bool) -> Option<RayHit> {
    let (mut enter, mut enter_n, mut leave, mut leave_n) = (f32::NEG_INFINITY, ZERO, f32::INFINITY, ZERO);
    for f in 0..poly.faces {
        let n = poly.normal(f);
        let (along, room) = (n.dot(d), poly.plane(f) - n.dot(o));
        if along == 0.0 {
            if room < 0.0 {
                return None;
            }
            continue;
        }
        let t = room / along;
        if along < 0.0 {
            if t > enter {
                enter = t;
                enter_n = n;
            }
        } else if t < leave {
            leave = t;
            leave_n = n;
        }
    }
    interval_hit(enter, enter_n, leave, leave_n, max, solid)
}

/// A ray against a triangle, either side, from 0 to `max`: the distance and the unit normal facing the ray.
pub fn ray_triangle(o: V3, d: V3, [a, b, c]: [V3; 3], max: f32) -> Option<RayHit> {
    let (e1, e2) = (b.sub(a), c.sub(a));
    let p = d.cross(e2);
    let det = e1.dot(p);
    if det == 0.0 {
        return None;
    }
    let inv = 1.0 / det;
    let s = o.sub(a);
    let u = s.dot(p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(e1);
    let v = d.dot(q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = e2.dot(q) * inv;
    if !(t >= 0.0 && t <= max) {
        return None;
    }
    let n = e1.cross(e2);
    let n = n.scale(1.0 / sqrt(n.dot(n)));
    Some(RayHit { t, normal: if n.dot(d) > 0.0 { n.scale(-1.0) } else { n } })
}

/// The span of a ray inside the box from `low` to `high`, clipped to 0..`max`, and the axis it enters by (3 when it
/// starts inside).
fn box_span(o: V3, d: V3, low: V3, high: V3, max: f32) -> Option<(f32, f32, usize)> {
    let (os, ds, lo, hi) = ([o.x, o.y, o.z], [d.x, d.y, d.z], [low.x, low.y, low.z], [high.x, high.y, high.z]);
    let (mut enter, mut axis, mut leave) = (0.0f32, 3, max);
    for k in 0..3 {
        if ds[k] == 0.0 {
            if os[k] < lo[k] || os[k] > hi[k] {
                return None;
            }
            continue;
        }
        let inv = 1.0 / ds[k];
        let (near, far) = if inv >= 0.0 { (lo[k], hi[k]) } else { (hi[k], lo[k]) };
        let (t0, t1) = ((near - os[k]) * inv, (far - os[k]) * inv);
        if t0 > enter {
            enter = t0;
            axis = k;
        }
        if t1 < leave {
            leave = t1;
        }
    }
    if enter <= leave { Some((enter, leave, axis)) } else { None }
}

impl World {
    /// True when a query with `filter` sees collider `c` (a collider of a body, not a compound's child).
    pub fn query_sees(&self, c: usize, filter: &Filter) -> bool {
        let flags = self.uu(COLLIDER_FLAGS, c);
        let body = self.uu(COLLIDER_BODY, c);
        if flags & COLLIDER_OFF != 0 || c as u32 == filter.collider || body == filter.body {
            return false;
        }
        let f = filter.flags;
        let sensor = flags & COLLIDER_SENSOR != 0;
        if (sensor && f & EXCLUDE_SENSORS != 0) || (!sensor && f & EXCLUDE_SOLIDS != 0) {
            return false;
        }
        let kind = self.uu(FLAGS, body as usize) & KIND;
        let (fixed, dynamic) = (kind == FIXED, kind == DYNAMIC);
        let kinematic = !fixed && !dynamic;
        let excluded = (fixed && f & EXCLUDE_FIXED != 0) || (kinematic && f & EXCLUDE_KINEMATIC != 0) || (dynamic && f & EXCLUDE_DYNAMIC != 0);
        let only = f & (ONLY_DYNAMIC | ONLY_KINEMATIC | ONLY_FIXED);
        let allowed = only == 0 || (dynamic && f & ONLY_DYNAMIC != 0) || (kinematic && f & ONLY_KINEMATIC != 0) || (fixed && f & ONLY_FIXED != 0);
        !excluded && allowed && groups_meet(filter.groups, self.uu(COLLIDER_GROUPS, c))
    }

    /// Calls `visit` with each collider a query with `filter` sees, body by body in row order, until it returns false.
    pub fn each_queried(&self, filter: &Filter, visit: &mut dyn FnMut(usize) -> bool) {
        for body in 0..self.header().rows as usize {
            let flags = self.uu(FLAGS, body);
            if flags & ALIVE == 0 || flags & DISABLED != 0 {
                continue;
            }
            let mut c = self.uu(FIRST_COLLIDER, body);
            while c != NONE {
                if self.query_sees(c as usize, filter) && !visit(c as usize) {
                    return;
                }
                c = self.uu(COLLIDER_NEXT, c as usize);
            }
        }
    }

    /// A world-space ray from `origin` along the unit `dir` against collider `c`, from 0 to `max`.
    pub fn ray_collider(&self, c: usize, origin: V3, dir: V3, max: f32, solid: bool) -> Option<RayHit> {
        let shape = self.uu(COLLIDER_SHAPE, c);
        if shape == SHAPE_COMPOUND {
            let mut best: Option<RayHit> = None;
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != NONE {
                let limit = best.map_or(max, |hit| hit.t);
                if let Some(hit) = self.ray_collider(child as usize, origin, dir, limit, solid)
                    && best.is_none_or(|b| hit.t < b.t)
                {
                    best = Some(hit);
                }
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return best;
        }
        let pose = self.collider_pose(c);
        let (o, d) = (pose.unapply(origin), pose.q.unrotate(dir));
        let size = self.v(COLLIDER_A, c);
        let hit = match shape {
            SHAPE_BALL => ray_ball(o, d, size.x, max, solid),
            SHAPE_BOX => ray_box(o, d, size, max, solid),
            SHAPE_CAPSULE => ray_capsule(o, d, size.y, size.x, max, solid),
            SHAPE_CYLINDER | SHAPE_CONE if size.z > 0.0 => {
                ray_rounded(o, d, crate::revolve::Revolved { cone: shape == SHAPE_CONE, r: size.x, h: size.y }, size.z, max, solid)
            }
            SHAPE_CYLINDER => ray_cylinder(o, d, size.x, size.y, max, solid),
            SHAPE_CONE => ray_cone(o, d, size.x, size.y, max, solid),
            SHAPE_HULL => ray_poly(&self.hull_poly(self.uu(COLLIDER_HULL, c) as usize), o, d, max, solid),
            SHAPE_TRIMESH => {
                let mesh = self.uu(COLLIDER_HULL, c) as usize;
                if self.is_voxels(mesh) {
                    self.ray_voxels(mesh, o, d, max, solid)
                } else if self.uu(MESH_COLUMNS, mesh) != 0 {
                    self.ray_grid(mesh, o, d, max)
                } else {
                    self.ray_mesh(mesh, o, d, max)
                }
            }
            _ => None,
        }?;
        Some(RayHit { t: hit.t, normal: pose.q.rotate(hit.normal) })
    }

    /// A ray in a triangle mesh's frame against its triangles, through its tree.
    fn ray_mesh(&self, mesh: usize, o: V3, d: V3, max: f32) -> Option<RayHit> {
        let (t0, n0) = (self.uu(MESH_FIRST_TRIANGLE, mesh) as usize, self.uu(MESH_FIRST_NODE, mesh) as usize);
        if self.uu(MESH_NODES, mesh) == 0 {
            return None;
        }
        let mut best: Option<RayHit> = None;
        let mut stack = [0u32; STACK + 1];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = n0 + stack[top] as usize;
            let limit = best.map_or(max, |hit| hit.t);
            if box_span(o, d, self.v(NODE_MIN_X, node), self.v(NODE_MAX_X, node), limit).is_none() {
                continue;
            }
            let (first, count) = (self.uu(NODE_FIRST, node), self.uu(NODE_COUNT, node));
            if count == 0 {
                stack[top] = first + 1;
                stack[top + 1] = first;
                top += 2;
                continue;
            }
            for place in first..first + count {
                let triangle = self.uu(TRIANGLE_ORDER, t0 + place as usize);
                let limit = best.map_or(max, |hit| hit.t);
                if let Some(hit) = ray_triangle(o, d, self.mesh_triangle(mesh, triangle), limit)
                    && best.is_none_or(|b| hit.t < b.t)
                {
                    best = Some(hit);
                }
            }
        }
        best
    }

    /// A ray in a height field's frame, cell by cell along x and z in the order it crosses them.
    fn ray_grid(&self, mesh: usize, o: V3, d: V3, max: f32) -> Option<RayHit> {
        let columns = self.uu(MESH_COLUMNS, mesh);
        let rows = self.uu(MESH_VERTICES, mesh) / (columns + 1) - 1;
        let (v0, stride) = (self.uu(MESH_FIRST_VERTEX, mesh) as usize, rows as usize + 1);
        let x = |c: u32| self.s(MESH_VERTEX_X, v0 + stride * c as usize);
        let z = |r: u32| self.s(MESH_VERTEX_Z, v0 + r as usize);
        let (center, half) = (self.v(MESH_BOX_X, mesh), self.v(MESH_HALF_X, mesh));
        let (mut t, leave, _) = box_span(o, d, center.sub(half), center.add(half), max)?;
        // The cell holding the point where the walk starts, along one axis: the last boundary at or before it, or the
        // last before it when the ray runs back.
        let start = |count: u32, at: &dyn Fn(u32) -> f32, p: f32, back: bool| {
            let (mut a, mut b) = (0u32, count - 1);
            while a < b {
                let m = a + (b - a).div_ceil(2);
                if at(m) < p || (!back && at(m) == p) { a = m } else { b = m - 1 }
            }
            a
        };
        let p = o.add(d.scale(t));
        let (mut c, mut r) = (start(columns, &x, p.x, d.x < 0.0), start(rows, &z, p.z, d.z < 0.0));
        loop {
            let cell = 2 * (r + rows * c);
            let mut best: Option<RayHit> = None;
            for triangle in [cell, cell + 1] {
                let limit = best.map_or(max, |hit| hit.t);
                if let Some(hit) = ray_triangle(o, d, self.mesh_triangle(mesh, triangle), limit)
                    && best.is_none_or(|b| hit.t < b.t)
                {
                    best = Some(hit);
                }
            }
            if best.is_some() {
                return best;
            }
            // The next boundary across x and across z; the nearer is crossed.
            let tx = if d.x > 0.0 && c + 1 < columns {
                (x(c + 1) - o.x) / d.x
            } else if d.x < 0.0 && c > 0 {
                (x(c) - o.x) / d.x
            } else {
                f32::INFINITY
            };
            let tz = if d.z > 0.0 && r + 1 < rows {
                (z(r + 1) - o.z) / d.z
            } else if d.z < 0.0 && r > 0 {
                (z(r) - o.z) / d.z
            } else {
                f32::INFINITY
            };
            t = if tx < tz { tx } else { tz };
            if t > leave {
                return None;
            }
            if tx < tz {
                c = if d.x > 0.0 { c + 1 } else { c - 1 };
            } else {
                r = if d.z > 0.0 { r + 1 } else { r - 1 };
            }
        }
    }

    /// A ray in a voxel grid's frame, cell by cell in the order it crosses them; a filled cell is solid.
    fn ray_voxels(&self, mesh: usize, o: V3, d: V3, max: f32, solid: bool) -> Option<RayHit> {
        let size = self.v(VOXEL_SIZE_X, mesh);
        let min = [self.uu(VOXEL_MIN_X, mesh) as i32, self.uu(VOXEL_MIN_Y, mesh) as i32, self.uu(VOXEL_MIN_Z, mesh) as i32];
        let dims = [self.uu(VOXEL_DIM_X, mesh), self.uu(VOXEL_DIM_Y, mesh), self.uu(VOXEL_DIM_Z, mesh)];
        let (s, os, ds) = ([size.x, size.y, size.z], [o.x, o.y, o.z], [d.x, d.y, d.z]);
        let low = v3(min[0] as f32 * s[0], min[1] as f32 * s[1], min[2] as f32 * s[2]);
        let high = v3((min[0] + dims[0] as i32) as f32 * s[0], (min[1] + dims[1] as i32) as f32 * s[1], (min[2] + dims[2] as i32) as f32 * s[2]);
        let (mut t, leave, mut axis) = box_span(o, d, low, high, max)?;
        let p = o.add(d.scale(t));
        let ps = [p.x, p.y, p.z];
        let mut cell = [0i64; 3];
        for k in 0..3 {
            let f = ps[k] / s[k] - min[k] as f32;
            let i = f as i64;
            let mut i = if (i as f32) > f { i - 1 } else { i };
            // A start on a boundary running back belongs to the cell behind it.
            if ds[k] < 0.0 && i as f32 == f {
                i -= 1;
            }
            cell[k] = i.clamp(0, dims[k] as i64 - 1);
        }
        let face = |k: usize, sign: f32| {
            let mut n = [0.0f32; 3];
            n[k] = if ds[k] > 0.0 { sign } else { -sign };
            v3(n[0], n[1], n[2])
        };
        let filled = |cell: [i64; 3]| {
            let index = cell[0] as u32 + dims[0] * (cell[1] as u32 + dims[1] * cell[2] as u32);
            self.cell_byte(mesh, index) & CELL_FILLED != 0
        };
        let inside = filled(cell) && axis == 3;
        if inside && solid {
            return Some(RayHit { t: 0.0, normal: ZERO });
        }
        loop {
            let full = filled(cell);
            if full && !inside {
                return Some(RayHit { t, normal: if axis == 3 { ZERO } else { face(axis, -1.0) } });
            }
            if !full && inside {
                // A hollow start leaves the filled cells here, the normal facing the ray, as a hollow box's.
                return Some(RayHit { t, normal: face(axis, -1.0) });
            }
            let mut next = (f32::INFINITY, 3);
            for k in 0..3 {
                if ds[k] == 0.0 {
                    continue;
                }
                let bound = (min[k] as i64 + cell[k] + if ds[k] > 0.0 { 1 } else { 0 }) as f32 * s[k];
                let tk = (bound - os[k]) / ds[k];
                if tk < next.0 {
                    next = (tk, k);
                }
            }
            let (tk, k) = next;
            if k == 3 || tk > leave {
                return None;
            }
            cell[k] += if ds[k] > 0.0 { 1 } else { -1 };
            if cell[k] < 0 || cell[k] >= dims[k] as i64 {
                // Out of the grid: a hollow start still in filled cells leaves here.
                return if inside { Some(RayHit { t: tk, normal: face(k, -1.0) }) } else { None };
            }
            t = tk;
            axis = k;
        }
    }

    /// The nearest hit of a world ray among the colliders `filter` lets through: the collider, distance and normal.
    pub fn cast_ray(&self, origin: V3, dir: V3, max: f32, solid: bool, filter: &Filter) -> Option<(u32, RayHit)> {
        let mut best: Option<(u32, RayHit)> = None;
        self.each_queried(filter, &mut |c| {
            let limit = best.map_or(max, |(_, hit)| hit.t);
            if let Some(hit) = self.ray_collider(c, origin, dir, limit, solid)
                && best.is_none_or(|(_, b)| hit.t < b.t)
            {
                best = Some((c as u32, hit));
            }
            true
        });
        best
    }
}
