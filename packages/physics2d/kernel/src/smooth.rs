// Polylines without ghost collisions (Catto, "Ghost Collisions", 2020, on chains whose segments know their neighbours'
// vertices). A polyline is a chain of segment shapes; each inner segment keeps the far vertex of the segment before it
// and of the one after it, its ghosts. A shape sliding along a flat chain otherwise meets the next segment's end vertex
// edge on, a contact whose normal points back along the chain, and catches on the seam.
//
// The rule here follows from the Voronoi regions of the chain as one surface (Ericson, "Real-Time Collision Detection",
// 2005, section 5.1, closest features and their regions). The segment's manifold is built as usual. Its normal is kept
// when it is the face normal of the side the other shape is on. A normal tilted toward an end belongs to that end's
// vertex region only if the chain turns away from the shape there (a convex corner) and the normal does not point into
// the neighbour's face region; past the neighbour's face it is the neighbour's contact, and this segment drops it. At a
// flat or concave corner the vertex has no region of its own on that side, so the contact is the face's: the other
// shape's incident feature is clipped to this segment's side planes along the face normal, and what lies past the end
// is left to the neighbour. A segment with no ghost at an end is a real end and keeps its vertex contacts.
use crate::error::PhysicsError;
use crate::manifold::{Manifold, clip, collide_trusted, place, validate_collision_core, validate_collision_pose};
use crate::math::{V2, Xf};
use crate::shape::{Core, LINEAR_SLOP};

/// How far a ghost may sit off the segment's line, as a fraction of its distance, and still be a flat corner.
const FLAT: f32 = 1e-3;
/// A normal this close to the face normal is the face's.
const FACE_COS: f32 = 1.0 - 1e-5;

/// The manifold of the segment `segment` at `xa`, with ghost vertices `ghosts` (before its first vertex and after its
/// second, in the segment's frame, `None` at a real end), and `b` at `xb`.
pub fn collide_smooth(segment: &Core, ghosts: [Option<V2>; 2], xa: Xf, b: &Core, xb: Xf, speculative: f32) -> Result<Manifold, PhysicsError> {
    validate_collision_core(segment)?;
    validate_collision_core(b)?;
    validate_collision_pose(xa)?;
    validate_collision_pose(xb)?;
    if !speculative.is_finite() { return Err(PhysicsError::NotFinite); }
    collide_smooth_trusted(segment, ghosts, xa, b, xb, speculative)
}

pub(crate) fn collide_smooth_trusted(segment: &Core, ghosts: [Option<V2>; 2], xa: Xf, b: &Core, xb: Xf, speculative: f32) -> Result<Manifold, PhysicsError> {
    if ghosts.into_iter().flatten().any(|v| !v.x.is_finite() || !v.y.is_finite()) { return Err(PhysicsError::NotFinite); }
    let manifold = collide_trusted(segment, xa, b, xb, speculative)?;
    if manifold.count == 0 || segment.count != 2 {
        return Ok(manifold);
    }
    let (v1, v2) = (segment.vertices[0], segment.vertices[1]);
    let other = place(b, xa.inverse_mul(xb));
    // The side the other shape is on, by its vertex mean; on the line, by the manifold's normal.
    let mut mean = V2::ZERO;
    for i in 0..other.count {
        mean = mean.add(other.vertices[i]);
    }
    let mean = mean.scale(1.0 / other.count as f32);
    if !mean.x.is_finite() || !mean.y.is_finite() { return Err(PhysicsError::ArithmeticOverflow); }
    let normal = xa.q.apply_inverse(manifold.normal);
    let front = segment.normals[0];
    let height = front.dot(mean.sub(v1));
    if !height.is_finite() { return Err(PhysicsError::ArithmeticOverflow); }
    let side = if height > 0.0 || (height == 0.0 && normal.dot(front) >= 0.0) { 0 } else { 1 };
    let face = segment.normals[side];
    if normal.dot(face) >= FACE_COS {
        return Ok(manifold);
    }
    let along = v2_dir(v1, v2);
    let (corner, ghost) = if normal.dot(along) < 0.0 { (v1, ghosts[0]) } else { (v2, ghosts[1]) };
    let Some(ghost) = ghost else {
        return Ok(manifold);
    };
    let reach = ghost.sub(corner);
    let length = reach.length();
    let turn = face.dot(reach);
    if !reach.x.is_finite() || !reach.y.is_finite() || !length.is_finite() || !turn.is_finite() { return Err(PhysicsError::ArithmeticOverflow); }
    if turn < -FLAT * length {
        // Convex: the vertex has a region between the two face normals; past the neighbour's face it is not ours.
        if normal.dot(reach) > 0.0 { Ok(Manifold::default()) } else { Ok(manifold) }
    } else {
        // Flat or concave: the face's contact, clipped to this segment.
        let mut out = Manifold::default();
        let owner = place(segment, Xf::IDENTITY);
        clip(&mut out, &owner, &other, side, false, segment.radius, b.radius, speculative)?;
        if b.count == 1 {
            // A circle's one point is not clipped by `clip`: past either end it is the neighbour's.
            let span = v2.sub(v1).length();
            let t = along.dot(out.points[0].point.sub(v1));
            if out.count == 1 && !(0.0..=span).contains(&t) {
                out.count = 0;
            }
        }
        out.normal = xa.q.apply(out.normal);
        for i in 0..out.count {
            out.points[i].point = xa.apply(out.points[i].point);
        }
        if !out.normal.x.is_finite() || !out.normal.y.is_finite() || out.points[..out.count].iter().any(|p| !p.point.x.is_finite() || !p.point.y.is_finite() || !p.separation.is_finite()) { return Err(PhysicsError::ArithmeticOverflow); }
        Ok(out)
    }
}

#[inline]
fn v2_dir(a: V2, b: V2) -> V2 {
    b.sub(a).normalize().0
}

/// Below this a chain's points are one point.
pub const CHAIN_WELD: f32 = 0.5 * LINEAR_SLOP;
