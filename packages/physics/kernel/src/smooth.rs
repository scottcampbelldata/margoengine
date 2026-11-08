// Contacts of a cylinder or cone, with or without a border, against any convex shape: GJK on the cores for the normal
// when they are apart, the expanding polytope when they overlap, then the parts of each core farthest along that normal
// (a face, a segment or a point), clipped against each other as Gregorius 2015 clips a face, so a cylinder standing on a
// floor has its points on the rim from the first frame. This is the polygonal feature view of van den Bergen ("Collision
// Detection in Interactive 3D Environments", 2003): a smooth shape is read through its support function, and where its
// support is a flat face or a straight line, that face or line is clipped. A cap disk is clipped as the polygon of its
// `CAP_SIDES` rim points. A border radius is a margin about the core (van den Bergen 2003 again): the cores meet, and
// each point moves out along the normal by its side's border.
use crate::cast::{Solid, core};
use crate::gjk::{epa, gjk};
use crate::layout::MAX_FACE_EDGES;
use crate::math::*;
use crate::narrow::{ID_END, Manifold, Point, reduce};
use crate::revolve::{CAP_SIDES, PARALLEL, Part, SQUARE};

/// Most corners a face part holds: a hull's largest face.
const CORNERS: usize = MAX_FACE_EDGES as usize;
/// Most points a clip leaves: the incident part's corners plus one for each side plane of the reference.
const CLIPPED: usize = 2 * CORNERS;
/// Centres closer than this have no direction between them.
const COINCIDENT: f32 = 1e-6;
// A point's id: the top bit set when B holds the reference face, a bit for a point a side plane cut, then the side plane
// and the incident corner it came from.
const ID_FLIP: u32 = 1 << 31;
const ID_CUT: u32 = 1 << 30;

/// What of a core lies farthest along a direction, in world space.
enum Feature {
    Point(V3),
    Segment(V3, V3),
    /// A flat face: its outward normal and its corners in order.
    Face(V3, usize),
}

/// A face's corners, filled by `feature`.
type Corners = [V3; CORNERS];

/// The part of core `s` farthest along unit `d`. A face's corners go to `corners`.
fn feature(s: &Solid, d: V3, corners: &mut Corners) -> Feature {
    match *s {
        Solid::Round { p, q, .. } => {
            let axis = q.sub(p);
            let l = sqrt(axis.dot(axis));
            if l == 0.0 {
                return Feature::Point(p);
            }
            let c = axis.dot(d) / l;
            if c.abs() <= SQUARE { Feature::Segment(p, q) } else { Feature::Point(if c > 0.0 { q } else { p }) }
        }
        Solid::Poly { poly, pose } => {
            let local = pose.q.unrotate(d);
            let (mut face, mut best) = (0, f32::NEG_INFINITY);
            for f in 0..poly.faces {
                let along = poly.normal(f).dot(local);
                if along > best {
                    (face, best) = (f, along);
                }
            }
            if best >= PARALLEL {
                let (start, mut e, mut count) = (poly.first(face), poly.first(face), 0);
                loop {
                    if count < CORNERS {
                        corners[count] = pose.apply(poly.vertex(poly.origin(e)));
                        count += 1;
                    }
                    e = poly.next(e);
                    if e == start {
                        break;
                    }
                }
                return Feature::Face(pose.q.rotate(poly.normal(face)), count);
            }
            let (mut top, mut most) = (0, f32::NEG_INFINITY);
            for v in 0..poly.vertices {
                let along = poly.vertex(v).dot(local);
                if along > most {
                    (top, most) = (v, along);
                }
            }
            let at = poly.vertex(top);
            let (mut other, mut least) = (None, SQUARE);
            for e in 0..poly.edges {
                if poly.origin(e) != top {
                    continue;
                }
                let to = poly.vertex(poly.origin(poly.next(e)));
                let edge = to.sub(at);
                let l = sqrt(edge.dot(edge));
                if l > 0.0 && (edge.dot(local) / l).abs() <= least {
                    least = (edge.dot(local) / l).abs();
                    other = Some(to);
                }
            }
            match other {
                Some(to) => Feature::Segment(pose.apply(at), pose.apply(to)),
                None => Feature::Point(pose.apply(at)),
            }
        }
        Solid::Triangle([a, b, c]) => {
            let n = b.sub(a).cross(c.sub(a));
            let l = sqrt(n.dot(n));
            if l > 0.0 {
                let n = n.scale(1.0 / l);
                let along = n.dot(d);
                if along >= PARALLEL || along <= -PARALLEL {
                    let (n, order) = if along > 0.0 { (n, [a, b, c]) } else { (n.scale(-1.0), [a, c, b]) };
                    corners[..3].copy_from_slice(&order);
                    return Feature::Face(n, 3);
                }
            }
            let ends = [a, b, c];
            let top = if a.dot(d) >= b.dot(d) && a.dot(d) >= c.dot(d) {
                0
            } else if b.dot(d) >= c.dot(d) {
                1
            } else {
                2
            };
            let (mut other, mut least) = (None, SQUARE);
            for k in [1, 2] {
                let to = ends[(top + k) % 3];
                let edge = to.sub(ends[top]);
                let l = sqrt(edge.dot(edge));
                if l > 0.0 && (edge.dot(d) / l).abs() <= least {
                    least = (edge.dot(d) / l).abs();
                    other = Some(to);
                }
            }
            match other {
                Some(to) => Feature::Segment(ends[top], to),
                None => Feature::Point(ends[top]),
            }
        }
        Solid::Revolved { shape, pose, .. } => match shape.part(pose.q.unrotate(d)) {
            Part::Point(p) => Feature::Point(pose.apply(p)),
            Part::Segment(p, q) => Feature::Segment(pose.apply(p), pose.apply(q)),
            Part::Disk { y, up } => {
                for (k, corner) in corners.iter_mut().take(CAP_SIDES).enumerate() {
                    // Counterclockwise about the outward normal: reversed for the bottom cap.
                    let at = if up { k } else { (CAP_SIDES - k) % CAP_SIDES };
                    *corner = pose.apply(shape.cap_corner(y, at));
                }
                Feature::Face(pose.q.rotate(v3(0.0, if up { 1.0 } else { -1.0 }, 0.0)), CAP_SIDES)
            }
        },
    }
}

/// A point inside a solid's core, for GJK's first guess.
fn inner(s: &Solid) -> V3 {
    match *s {
        Solid::Round { p, q, .. } => p.add(q).scale(0.5),
        Solid::Poly { poly, pose } => pose.apply(poly.center),
        Solid::Triangle([a, b, c]) => a.add(b).add(c).scale(1.0 / 3.0),
        Solid::Revolved { pose, .. } => pose.p,
    }
}

/// One manifold between solids `a` and `b`, normal from A to B; `out.held` holds last step's ids.
pub fn collide_solids(a: &Solid, b: &Solid, limit: f32, out: &mut Manifold) {
    out.count = 0;
    let ((core_a, ra), (core_b, rb)) = (core(a), core(b));
    let radii = ra + rb;
    let found = gjk(&core_a, &core_b, inner(&core_a).sub(inner(&core_b)), limit + radii);
    if found.apart {
        return;
    }
    let (normal, on_a, on_b, gap) = if !found.overlap && found.distance > COINCIDENT {
        (found.v.scale(-1.0 / found.distance), found.on_a, found.on_b, found.distance)
    } else {
        let Some(way_out) = epa(&core_a, &core_b, &found) else { return };
        (way_out.normal, way_out.on_a, way_out.on_b, -way_out.depth)
    };
    let separation = gap - radii;
    if separation > limit {
        return;
    }
    clip_along(&core_a, ra, &core_b, rb, normal, limit, out);
    if out.count == 0 {
        out.normal = normal;
        out.points[0] = Point { on_a: on_a.add(normal.scale(ra)), on_b: on_b.sub(normal.scale(rb)), separation, id: 0 };
        out.count = 1;
    }
}

/// The points of cores `a` and `b` (borders `ra`, `rb`) along unit `normal` from A to B, from the parts of each farthest
/// toward the other: a face clipped against a face, segment or point, or two segments lying along each other. No points
/// when neither part is a face and the segments cross, or none is left within `limit`.
pub fn clip_along(a: &Solid, ra: f32, b: &Solid, rb: f32, normal: V3, limit: f32, out: &mut Manifold) {
    out.count = 0;
    let (mut corners_a, mut corners_b) = ([v3(0.0, 0.0, 0.0); CORNERS], [v3(0.0, 0.0, 0.0); CORNERS]);
    let fa = feature(a, normal, &mut corners_a);
    let fb = feature(b, normal.scale(-1.0), &mut corners_b);
    let radii = ra + rb;
    // Which face is the reference: the one that faces the normal more squarely, A on a tie.
    let a_refers = match (&fa, &fb) {
        (Feature::Face(na, _), Feature::Face(nb, _)) => na.dot(normal) >= -nb.dot(normal),
        (Feature::Face(..), _) => true,
        (_, Feature::Face(..)) => false,
        (Feature::Segment(p, q), Feature::Segment(s, t)) => {
            segments((*p, *q), (*s, *t), normal, radii, (ra, rb), limit, out);
            return;
        }
        _ => return,
    };
    let (reference, reference_corners, incident_corners) = if a_refers { (&fa, &corners_a, &mut corners_b) } else { (&fb, &corners_b, &mut corners_a) };
    let Feature::Face(face_normal, sides) = *reference else { return };
    // The manifold's normal is the reference face's, turned to run from A to B. The incident part is read again along it:
    // a side line read along a normal a hair off the face's lies a hair round the side, and its points would turn a
    // cylinder lying on a floor, which then rolls away.
    let m = if a_refers { face_normal } else { face_normal.scale(-1.0) };
    let incident = &if a_refers { feature(b, m.scale(-1.0), incident_corners) } else { feature(a, m, incident_corners) };
    let mut points = [(v3(0.0, 0.0, 0.0), 0u32); CLIPPED];
    let mut spare = [(v3(0.0, 0.0, 0.0), 0u32); CLIPPED];
    let mut count = match *incident {
        Feature::Point(p) => {
            points[0] = (p, 0);
            1
        }
        Feature::Segment(p, q) => {
            points[0] = (p, ID_END);
            points[1] = (q, ID_END | 1);
            2
        }
        Feature::Face(_, n) => {
            for k in 0..n {
                points[k] = (incident_corners[k], k as u32);
            }
            n
        }
    };
    let closed = count > 2;
    let middle = reference_corners[..sides].iter().fold(v3(0.0, 0.0, 0.0), |sum, &c| sum.add(c)).scale(1.0 / sides as f32);
    for k in 0..sides {
        let (p, q) = (reference_corners[k], reference_corners[(k + 1) % sides]);
        let mut side = q.sub(p).cross(face_normal);
        if side.dot(middle.sub(p)) > 0.0 {
            side = side.scale(-1.0);
        }
        count = clip(&points[..count], &mut spare, side, side.dot(p), k as u32, closed);
        points[..count].copy_from_slice(&spare[..count]);
        if count == 0 {
            return;
        }
    }
    let origin = reference_corners[0];
    let mut found = [Point { on_a: v3(0.0, 0.0, 0.0), on_b: v3(0.0, 0.0, 0.0), separation: 0.0, id: 0 }; CLIPPED];
    let mut kept = 0;
    for &(x, id) in &points[..count] {
        let (depth, point) = if a_refers {
            let depth = x.sub(origin).dot(m);
            (depth, Point { on_a: x.sub(m.scale(depth - ra)), on_b: x.sub(m.scale(rb)), separation: depth - radii, id })
        } else {
            let depth = origin.sub(x).dot(m);
            (depth, Point { on_a: x.add(m.scale(ra)), on_b: x.add(m.scale(depth - rb)), separation: depth - radii, id: id | ID_FLIP })
        };
        if depth - radii <= limit {
            found[kept] = point;
            kept += 1;
        }
    }
    let (held, held_count) = (out.held, out.held_count);
    reduce(&found[..kept], kept, m, &held[..held_count], out);
    out.normal = m;
}

/// Clips points (a closed polygon when `closed`, else a segment or a point) to the side `side . x <= offset`, Sutherland
/// and Hodgman's step. A cut point's id names the side plane and the corner the cut edge leaves.
fn clip(input: &[(V3, u32)], output: &mut [(V3, u32); CLIPPED], side: V3, offset: f32, plane: u32, closed: bool) -> usize {
    let n = input.len();
    let mut count = 0;
    let edges = if closed { n } else { n - 1 };
    if n == 1 {
        if side.dot(input[0].0) <= offset {
            output[0] = input[0];
            return 1;
        }
        return 0;
    }
    for k in 0..n {
        let (p, id) = input[k];
        let inside = side.dot(p) - offset <= 0.0;
        if inside && count < CLIPPED {
            output[count] = (p, id);
            count += 1;
        }
        if k < edges {
            let (q, _) = input[(k + 1) % n];
            let (dp, dq) = (side.dot(p) - offset, side.dot(q) - offset);
            if (dp <= 0.0) != (dq <= 0.0) && count < CLIPPED {
                let t = dp / (dp - dq);
                output[count] = (p.add(q.sub(p).scale(t)), ID_CUT | (plane << 16) | (id & 0xffff));
                count += 1;
            }
        }
    }
    count
}

/// Two segments of cores `ra` and `rb` apart: when they lie along each other, the overlap of B's on A's gives two points,
/// as two capsules side by side (Gregorius 2015).
fn segments((p, q): (V3, V3), (s, t): (V3, V3), normal: V3, radii: f32, (ra, rb): (f32, f32), limit: f32, out: &mut Manifold) {
    let (axis_a, axis_b) = (q.sub(p), t.sub(s));
    let (la, lb) = (axis_a.dot(axis_a), axis_b.dot(axis_b));
    let cosine = axis_a.dot(axis_b);
    if la == 0.0 || lb == 0.0 || cosine * cosine <= PARALLEL * PARALLEL * la * lb {
        return;
    }
    let along = |x: V3| x.sub(p).dot(axis_a) / la;
    let (low, high) = (along(s), along(t));
    let (low, high) = if low < high { (low, high) } else { (high, low) };
    let (low, high) = (low.max(0.0), high.min(1.0));
    if high <= low {
        return;
    }
    let mut count = 0;
    for (end, at) in [low, high].iter().enumerate() {
        let on_core = p.add(axis_a.scale(*at));
        let u = (on_core.sub(s).dot(axis_b) / lb).clamp(0.0, 1.0);
        let across = s.add(axis_b.scale(u));
        let separation = across.sub(on_core).dot(normal) - radii;
        if separation <= limit {
            out.points[count] = Point { on_a: on_core.add(normal.scale(ra)), on_b: across.sub(normal.scale(rb)), separation, id: ID_END | end as u32 };
            count += 1;
        }
    }
    out.count = count;
    out.normal = normal;
}
