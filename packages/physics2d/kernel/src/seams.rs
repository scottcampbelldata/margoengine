// The seams of a mesh of polygons, Rapier's `TriMeshFlags::FIX_INTERNAL_EDGES` in 2D: the triangles of a trimesh (or any
// polygons of one body that meet edge to edge) are one solid, but each collides alone, so a shape sliding over the join
// meets the edge the next triangle shares with this one, a contact whose normal points back along the surface, and catches.
//
// The rule follows from the Voronoi regions of the union (Ericson, "Real-Time Collision Detection", 2005, sections 5.1 and
// 5.2.7, closest features and their regions; Catto, "Ghost Collisions", box2d.org, 2020, for a normal outside the surface's
// own cone being the face's). An edge two polygons share is a cut: it is inside the union and owns no region. A vertex on
// the union's outline owns the region between its two outline normals when the outline turns convex there; at a flat or
// concave vertex it owns none. A contact whose normal lies in no region the polygon has (its outline faces, and the regions of
// its outline vertices) is moved to the outline feature of the polygon, facing the contact's side, nearest the other shape's
// deepest point, taking that
// feature's normal (at a vertex, of its two the one nearer the contact's): the plane through the feature with that normal,
// and each point's depth measured from it on the other shape's side. A polygon wholly inside the union, with no outline at all, keeps no
// contact; its neighbours answer.
use alloc::vec::Vec;

use crate::error::PhysicsError;
use crate::manifold::Manifold;
use crate::math::{V2, Xf};
use crate::shape::{Core, MAX_VERTICES};

/// A normal this close to a face normal is that face's.
const FACE_COS: f32 = 1.0 - 1e-5;
/// Features this close (metres) to the deepest point are equally near; the one whose normal leans most like the contact's wins.
const NEAR: f32 = 1e-6;

/// What one polygon of a seamed mesh knows of the union, in its body's frame.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Seams {
    /// Bit k set: edge k (vertex k to k + 1) is shared with another polygon.
    pub cut: u8,
    /// For each vertex on the union's outline with one outline edge in and one out: the outward normals of the edge that
    /// ends there and the edge that starts there, and whether the outline turns convex (the region between them is the
    /// vertex's). `None` inside the union, or where more than two outline edges meet.
    pub corner: [Option<(V2, V2, bool)>; MAX_VERTICES],
}

fn key(v: V2) -> (u32, u32) {
    // -0 and 0 are one position.
    ((v.x + 0.0).to_bits(), (v.y + 0.0).to_bits())
}

/// The seams of polygons `cores` (one body's frame), matched by exact vertex positions: an edge another polygon has too, in
/// either direction, is a cut. Every core must be a sharp polygon (no radius) of at least three vertices.
pub fn find_seams(cores: &[Core]) -> Result<Vec<Seams>, PhysicsError> {
    if cores.iter().any(|c| c.count < 3 || c.radius != 0.0) {
        return Err(PhysicsError::InvalidParameter);
    }
    let edge = |c: &Core, k: usize| (key(c.vertices[k]), key(c.vertices[(k + 1) % c.count]));
    // Edges by their ends, either way round; sorted so equal ones are neighbours.
    let mut all: Vec<((u32, u32), (u32, u32), usize, usize)> = Vec::new();
    for (i, c) in cores.iter().enumerate() {
        for k in 0..c.count {
            let (a, b) = edge(c, k);
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            all.push((lo, hi, i, k));
        }
    }
    all.sort_unstable();
    let mut seams = alloc::vec![Seams::default(); cores.len()];
    let mut at = 0;
    while at < all.len() {
        let mut end = at + 1;
        while end < all.len() && (all[end].0, all[end].1) == (all[at].0, all[at].1) {
            end += 1;
        }
        if end - at > 1 {
            for &(_, _, i, k) in &all[at..end] {
                seams[i].cut |= 1 << k;
            }
        }
        at = end;
    }
    // The outline: every edge that is not a cut, with its outward normal, by the positions of its ends.
    let mut outline: Vec<((u32, u32), (u32, u32), V2)> = Vec::new();
    for (i, c) in cores.iter().enumerate() {
        for k in 0..c.count {
            if seams[i].cut & (1 << k) == 0 {
                let (a, b) = edge(c, k);
                outline.push((a, b, c.normals[k]));
            }
        }
    }
    for (i, c) in cores.iter().enumerate() {
        for k in 0..c.count {
            let p = key(c.vertices[k]);
            let ins: Vec<V2> = outline.iter().filter(|e| e.1 == p).map(|e| e.2).collect();
            let outs: Vec<V2> = outline.iter().filter(|e| e.0 == p).map(|e| e.2).collect();
            if ins.len() == 1 && outs.len() == 1 {
                // Walking the outline with the solid on the left, a left turn (n_in to n_out counterclockwise) is convex.
                let convex = ins[0].cross(outs[0]) > 0.0;
                seams[i].corner[k] = Some((ins[0], outs[0], convex));
            }
        }
    }
    Ok(seams)
}

/// Whether unit `n` lies in the counterclockwise arc from `from` to `to` (shorter than a half turn).
fn within(n: V2, from: V2, to: V2) -> bool {
    from.cross(n) >= 0.0 && n.cross(to) >= 0.0
}

/// Moves `manifold` (normal from A to B, in the contact frame) onto the normals polygon `core` with `seams` owns, the polygon at
/// `x`; `is_a` says whether it is shape A of the pair, and `other_radius` is the other shape's rounding (a circle's radius), whose
/// surface point is taken again along the new normal. Returns whether the manifold changed.
pub fn fit_to_seams(manifold: &mut Manifold, core: &Core, seams: &Seams, x: Xf, is_a: bool, other_radius: f32) -> bool {
    if manifold.count == 0 {
        return false;
    }
    let sign = if is_a { 1.0 } else { -1.0 };
    let out = x.q.apply_inverse(manifold.normal.scale(sign));
    let n = core.count;
    let face = (0..n).find(|&k| out.dot(core.normals[k]) > FACE_COS);
    let allowed = match face {
        Some(k) => seams.cut & (1 << k) == 0,
        None => {
            // The vertex whose region the normal points into: between the normals of the edges before and after it.
            let k = (0..n).find(|&k| within(out, core.normals[(k + n - 1) % n], core.normals[k])).unwrap_or(0);
            match seams.corner[k] {
                Some((from, to, convex)) => convex && within(out, from, to),
                None => seams.cut & (1 << k) == 0 && seams.cut & (1 << ((k + n - 1) % n)) == 0,
            }
        }
    };
    if allowed {
        return false;
    }
    // The outline feature of the polygon nearest the other shape's deepest point (an outline edge, or an outline vertex with
    // its two normals) among those whose normal faces the contact's, and of its normals the one nearest the contact's.
    let deepest = (0..manifold.count).min_by(|&i, &j| manifold.points[i].separation.total_cmp(&manifold.points[j].separation)).unwrap_or(0);
    let deep = manifold.points[deepest];
    let probe = x.apply_inverse(deep.point.add(manifold.normal.scale(sign * deep.separation * 0.5)));
    // A feature facing away from the contact (its normal against the contact's) is only taken when none faces it.
    let mut best: Option<(bool, f32, f32, V2, V2)> = None;
    let mut consider = |distance: f32, normal: V2, at: V2| {
        let lean = out.dot(normal);
        let facing = lean > 0.0;
        let better = match best {
            None => true,
            Some((was_facing, d, l, _, _)) => {
                (facing && !was_facing) || (facing == was_facing && (distance < d - NEAR || (distance <= d + NEAR && lean > l)))
            }
        };
        if better {
            best = Some((facing, distance, lean, normal, at));
        }
    };
    for k in 0..n {
        let (a, b) = (core.vertices[k], core.vertices[(k + 1) % n]);
        if seams.cut & (1 << k) == 0 {
            let along = b.sub(a);
            let t = (probe.sub(a).dot(along) / along.dot(along)).clamp(0.0, 1.0);
            consider(probe.sub(a.add(along.scale(t))).length(), core.normals[k], a);
        }
        if let Some((from, to, _)) = seams.corner[k] {
            let distance = probe.sub(a).length();
            consider(distance, from, a);
            consider(distance, to, a);
        }
    }
    let Some((_, _, _, normal, at)) = best else {
        manifold.count = 0;
        return true;
    };
    let (normal, at) = (x.q.apply(normal), x.apply(at));
    let old = manifold.normal.scale(sign);
    for point in &mut manifold.points[..manifold.count] {
        // The other shape's point: its core's point, then its surface again along the new normal, measured from the plane.
        let core_point = point.point.add(old.scale(point.separation * 0.5 + other_radius));
        let other = core_point.sub(normal.scale(other_radius));
        let depth = other.sub(at).dot(normal);
        point.separation = depth;
        point.point = other.sub(normal.scale(depth * 0.5));
    }
    manifold.normal = normal.scale(sign);
    true
}
