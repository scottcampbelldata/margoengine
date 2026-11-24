// Continuous collision detection. A body with `ccd` set that travels farther in a step than the contact margin can
// reach would otherwise pass through a thin wall between two steps. After the solve, each such body's centre and turn
// are swept from where the step began to where it ended against the shapes it could tunnel through (those of static
// and kinematic bodies, sensors excluded), and the earliest touch sets the body back to that time of impact. Its
// velocity is kept, so the next step's contact takes the speed out.
//
// The time of impact is found by conservative advancement (Mirtich, "Impulse-based dynamic simulation of rigid body
// systems", PhD thesis, UC Berkeley, 1996; the same bound Erin Catto uses in "Continuous Collision", GDC 2013): the
// distance between two shapes cannot close faster than the most the pair's points move, here the centre's travel plus the
// turn times the farthest point of the shape from its centre, so advancing time by gap over that speed never passes
// the first touch. The pose between the two ends is the centre moved in a straight line and the rotation by normalised
// linear interpolation along the short arc. A pair that already touches at the step's start is left to the contact
// solver: a resting body must not be pinned at time 0.
use alloc::vec::Vec;
use margoengine_physics_kernel_common::broad::Bounds;

use crate::error::PhysicsError;
use crate::manifold::collide;
use crate::math::{Rot, Xf, v2};
use crate::shape::LINEAR_SLOP;
use crate::world::{Kind, SPECULATIVE, World, bounds_of, pair_allowed};

/// The gap at which a time of impact stops: the shapes rest within the linear slop of each other.
const TARGET: f32 = LINEAR_SLOP;
const MAX_ITERATIONS: usize = 32;

/// Where a body was when the step began: its centre of mass (in doubles) and rotation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Start {
    pub body: u32,
    pub center: [f64; 2],
    pub q: Rot,
}

/// Normalised linear interpolation along the short arc.
fn blend(a: Rot, b: Rot, t: f32) -> Rot {
    let flip = if a.c * b.c + a.s * b.s < 0.0 { -1.0 } else { 1.0 };
    Rot::from_pair(a.c + t * (flip * b.c - a.c), a.s + t * (flip * b.s - a.s))
}

impl World {
    /// The awake bodies that ask for continuous collision, with their pose now: taken before the solve.
    pub(crate) fn ccd_starts(&self) -> Vec<Start> {
        let mut starts = Vec::new();
        for (id, body) in self.bodies.iter().enumerate() {
            if body.ccd && body.kind == Kind::Dynamic && body.awake && !body.shapes.is_empty() {
                starts.push(Start { body: id as u32, center: body.exact_center, q: body.xf.q });
            }
        }
        starts
    }

    /// Sets each body in `starts` back to its earliest time of impact, when it has one.
    pub(crate) fn solve_ccd(&mut self, starts: &[Start]) -> Result<(), PhysicsError> {
        let mut candidates = Vec::new();
        for start in starts {
            let body = &self.bodies[start.body as usize];
            let (end_center, end_q, local_center) = (body.exact_center, body.xf.q, body.local_center);
            let shift = v2((end_center[0] - start.center[0]) as f32, (end_center[1] - start.center[1]) as f32);
            let turn = {
                let r = start.q.inverse_mul(end_q);
                crate::math::atan2(r.s, r.c).abs()
            };
            let travel = shift.length() + turn * body.extent;
            if !(travel > 2.0 * SPECULATIVE) {
                continue;
            }
            // All positions are relative to the starting centre, so the sweep does not lose precision far from the origin.
            let pose = |t: f32| -> Xf {
                let q = blend(start.q, end_q, t);
                Xf { p: shift.scale(t).sub(q.apply(local_center)), q }
            };
            let (cx, cy) = (start.center[0] as f32, start.center[1] as f32);
            let mut earliest = 1.0f32;
            for &mine in &body.shapes.clone() {
                let own = &self.shapes[mine as usize];
                if own.sensor {
                    continue;
                }
                let (core, own_bits) = (own.core, own.clone());
                let (b0, b1) = (bounds_of(&core, pose(0.0))?, bounds_of(&core, pose(1.0))?);
                let swept = Bounds {
                    min: [b0.min[0].min(b1.min[0]) + cx, b0.min[1].min(b1.min[1]) + cy],
                    max: [b0.max[0].max(b1.max[0]) + cx, b0.max[1].max(b1.max[1]) + cy],
                };
                self.broad.query(&swept, &mut candidates);
                for &other in &candidates {
                    let s = &self.shapes[other as usize];
                    let ob = &self.bodies[s.body as usize];
                    if s.dead || s.body == start.body || s.sensor || ob.kind == Kind::Dynamic {
                        continue;
                    }
                    if !pair_allowed(&own_bits, Kind::Dynamic, s, ob.kind) {
                        continue;
                    }
                    let (a, b) = (start.body, s.body);
                    if self.joints.iter().any(|j| !j.def.collide && (j.def.a, j.def.b) == (a, b) || !j.def.collide && (j.def.a, j.def.b) == (b, a)) {
                        continue;
                    }
                    let origin = ob.exact_origin();
                    let target = Xf { p: v2((origin[0] - start.center[0]) as f32, (origin[1] - start.center[1]) as f32), q: ob.xf.q };
                    let gap_at = |t: f32| -> Result<f32, PhysicsError> {
                        let m = collide(&core, pose(t), &s.core, target, 1.0e4)?;
                        Ok(m.points[..m.count].iter().fold(f32::INFINITY, |least, p| least.min(p.separation)))
                    };
                    let first = gap_at(0.0)?;
                    // A pair already touching at the start belongs to the contact solver; one with no points is out of reach.
                    if !first.is_finite() || first <= 2.0 * LINEAR_SLOP {
                        continue;
                    }
                    let (mut t, mut gap, mut found) = (0.0f32, first, None);
                    for i in 0..MAX_ITERATIONS {
                        t += (gap - 0.5 * TARGET) / travel;
                        if t >= earliest {
                            break;
                        }
                        gap = gap_at(t)?;
                        // Out of iterations while still closing: stop at the safe time reached rather than tunnel.
                        if gap <= TARGET || i + 1 == MAX_ITERATIONS {
                            found = Some(t);
                            break;
                        }
                    }
                    if let Some(t) = found {
                        earliest = t;
                    }
                }
            }
            if earliest < 1.0 {
                let body = &mut self.bodies[start.body as usize];
                body.exact_center = [start.center[0] + (shift.x * earliest) as f64, start.center[1] + (shift.y * earliest) as f64];
                body.xf.q = blend(start.q, end_q, earliest);
                body.round_pose();
            }
        }
        Ok(())
    }
}
