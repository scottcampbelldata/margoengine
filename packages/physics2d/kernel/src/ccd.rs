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
// the first touch. The pose between the two ends is the centre moved in a straight line and the rotation turned through the
// angle the step turned it, spin times the step: the whole of it, not the short arc to the end rotation, which reads a turn of
// 2 pi minus a little as a little the other way and would let a fast spinner's tip pass through a thin wall unseen. A pair that already touches at the step's start is left to the contact
// solver: a resting body must not be pinned at time 0.
//
// With `Settings::max_ccd_substeps` above 1 an impact before the last is answered as a rigid collision at the mean of the touch points: the
// impulse of Newton's restitution along the normal and of Coulomb friction along the contact, from the same impulse-based law
// (Mirtich 1996), shared by the two bodies' masses and inertias; the body then goes on with what leaves for the rest of the step. Rapier's
// documentation names the setting (`maxCcdSubsteps`, the most substeps the solver performs for continuous collision, default 1) and says
// no more; this follows that sentence and the sources above only.
use alloc::vec::Vec;
use margoengine_physics_kernel_common::broad::Bounds;

use crate::error::PhysicsError;
use crate::manifold::collide;
use crate::math::{Rot, V2, Xf, v2};
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
    /// Whether the body asks for continuous collision; the others are recorded because a body that does may meet them.
    pub ccd: bool,
}

/// The signed angle a body turned through in a step: the angle from `q0` to `q1`, with whole turns added to land nearest `spin_step`,
/// the angular velocity times the step. The two rotations alone give it only up to whole turns.
fn turned(q0: Rot, q1: Rot, spin_step: f32) -> f32 {
    let r = q0.inverse_mul(q1);
    let raw = crate::math::atan2(r.s, r.c);
    let turns = (spin_step - raw) / core::f32::consts::TAU;
    let whole = if turns >= 0.0 { (turns + 0.5) as i32 } else { -((-turns + 0.5) as i32) };
    raw + whole as f32 * core::f32::consts::TAU
}

/// `q0` turned through `fraction` of `turn`.
fn at(q0: Rot, turn: f32, fraction: f32) -> Rot {
    q0.mul(Rot::from_angle(turn * fraction))
}

impl World {
    /// The awake bodies that ask for continuous collision, with their pose now: taken before the solve.
    pub(crate) fn ccd_starts(&self) -> Vec<Start> {
        let mut starts = Vec::new();
        if !self.bodies.iter().any(|b| b.ccd && b.kind == Kind::Dynamic && b.awake && !b.shapes.is_empty()) {
            return starts;
        }
        // Every awake dynamic body, not only those that ask: a body that does may meet one that moves too.
        for (id, body) in self.bodies.iter().enumerate() {
            if body.kind == Kind::Dynamic && body.awake && !body.shapes.is_empty() {
                starts.push(Start { body: id as u32, center: body.exact_center, q: body.xf.q, ccd: body.ccd });
            }
        }
        starts
    }

    /// Sets each body in `starts` back to its earliest time of impact, when it has one. With `Settings::max_ccd_substeps` above 1 a
    /// body that meets something is not left there: the touch gives it the impulse of a collision (restitution and friction of the pair),
    /// and it goes on with the velocity that leaves for the rest of the step, up to that many impacts; the last stops it where it
    /// touches, as the first does with one.
    pub(crate) fn solve_ccd(&mut self, starts: &[Start], dt: f32) -> Result<(), PhysicsError> {
        let limit = self.settings.max_ccd_substeps;
        if limit == 0 {
            return Ok(());
        }
        let mut candidates = Vec::new();
        let mut inner = crate::world::now();
        // Bodies an impact has moved: the fraction of the step they were set to, and their centre of mass and rotation there. A body
        // not listed is where `starts` says it began.
        let mut moved: Vec<(u32, f32, [f64; 2], Rot)> = Vec::new();
        for start in starts.iter().filter(|s| s.ccd) {
            let (mut tau0, mut origin, mut q0) = match moved.iter().find(|m| m.0 == start.body) {
                Some(&(_, tau, c, q)) => (tau, c, q),
                None => (0.0f32, start.center, start.q),
            };
            for sub in 0..limit {
                let body = &self.bodies[start.body as usize];
                let (end_center, end_q, local_center) = (body.exact_center, body.xf.q, body.local_center);
                let shift = v2((end_center[0] - origin[0]) as f32, (end_center[1] - origin[1]) as f32);
                let turn = turned(q0, end_q, body.angular_velocity * dt * (1.0 - tau0));
                let travel = shift.length() + turn.abs() * body.extent;
                if !(travel > 2.0 * SPECULATIVE) {
                    break;
                }
                // The step's fraction at a time t of this sweep, which runs from `tau0` to the step's end.
                let tau_of = |t: f32| tau0 + t * (1.0 - tau0);
                // All positions are relative to the sweep's starting centre, so it does not lose precision far from the origin.
                let pose = |t: f32| -> Xf {
                    let q = at(q0, turn, t);
                    Xf { p: shift.scale(t).sub(q.apply(local_center)), q }
                };
                let (cx, cy) = (origin[0] as f32, origin[1] as f32);
                // A point turning through `turn` about the centre leaves the box of its two ends by at most extent (1 - cos(turn / 2)) <=
                // extent turn^2 / 8, the sagitta of its arc (the chord between the ends is inside the box).
                let whole_circle = turn.abs() >= core::f32::consts::PI;
                let bulge = (turn * turn * 0.125).min(1.0) * body.extent;
                let mut earliest = 1.0f32;
                let mut best: Option<Impact> = None;
                for &mine in &body.shapes.clone() {
                    let own = &self.shapes[mine as usize];
                    if own.sensor {
                        continue;
                    }
                    let (core, own_bits) = (own.core, own.clone());
                    let (b0, b1) = (bounds_of(&core, pose(0.0))?, bounds_of(&core, pose(1.0))?);
                    let mut swept = Bounds {
                        min: [b0.min[0].min(b1.min[0]) - bulge + cx, b0.min[1].min(b1.min[1]) - bulge + cy],
                        max: [b0.max[0].max(b1.max[0]) + bulge + cx, b0.max[1].max(b1.max[1]) + bulge + cy],
                    };
                    if whole_circle {
                        // Half a turn or more: the shape's points go round the centre, so its path fills the disc of its extent about it.
                        swept.min = [swept.min[0].min(cx + shift.x.min(0.0) - body.extent), swept.min[1].min(cy + shift.y.min(0.0) - body.extent)];
                        swept.max = [swept.max[0].max(cx + shift.x.max(0.0) + body.extent), swept.max[1].max(cy + shift.y.max(0.0) + body.extent)];
                    }
                    self.broad.query(&swept, &mut candidates);
                    crate::world::tick(&mut self.timing, 12, &mut inner);
                    for &other in &candidates {
                        let s = &self.shapes[other as usize];
                        let ob = &self.bodies[s.body as usize];
                        if s.dead || s.body == start.body || s.sensor {
                            continue;
                        }
                        if !pair_allowed(&own_bits, Kind::Dynamic, s, ob.kind) {
                            continue;
                        }
                        let (a, b) = (start.body, s.body);
                        if self.joints.iter().any(|j| !j.def.collide && (j.def.a, j.def.b) == (a, b) || !j.def.collide && (j.def.a, j.def.b) == (b, a)) {
                            continue;
                        }
                        // The other body's pose at a time: a fixed or kinematic one at its end pose, a dynamic one on its way from where
                        // the step found it, or an impact left it (a body that did not move is both ends).
                        let moves = ob.kind == Kind::Dynamic;
                        let (o_start, o_q0, o_tau) = if !moves {
                            (ob.exact_center, ob.xf.q, 0.0)
                        } else if let Some(&(_, tau, c, q)) = moved.iter().find(|m| m.0 == s.body) {
                            (c, q, tau)
                        } else {
                            let (c, q) = starts.iter().find(|x| x.body == s.body).map_or((ob.exact_center, ob.xf.q), |x| (x.center, x.q));
                            (c, q, 0.0)
                        };
                        let rel = |c: [f64; 2]| [(c[0] - origin[0]) as f32, (c[1] - origin[1]) as f32];
                        let (c0, c1) = if moves { (rel(o_start), rel(ob.exact_center)) } else { (rel(ob.exact_center), rel(ob.exact_center)) };
                        let (o_q0, o_q1) = if moves { (o_q0, ob.xf.q) } else { (ob.xf.q, ob.xf.q) };
                        let path = Path {
                            moves,
                            tau0: o_tau,
                            c0,
                            c1,
                            q0: o_q0,
                            turn: if moves { turned(o_q0, o_q1, ob.angular_velocity * dt * (1.0 - o_tau)) } else { 0.0 },
                            local_center: if moves { ob.local_center } else { V2::ZERO },
                            fixed: Xf { p: v2(rel(ob.exact_origin())[0], rel(ob.exact_origin())[1]), q: ob.xf.q },
                        };
                        let other_travel = if moves && o_tau < 1.0 {
                            (v2(c1[0] - c0[0], c1[1] - c0[1]).length() + path.turn.abs() * ob.extent) * ((1.0 - tau0) / (1.0 - o_tau))
                        } else {
                            0.0
                        };
                        let together = travel + other_travel;
                        let gap_at = |t: f32| -> Result<f32, PhysicsError> {
                            let m = touch(&core, pose(t), &s.core, path.at(tau_of(t)))?;
                            Ok(m.points[..m.count].iter().fold(f32::INFINITY, |least, p| least.min(p.separation)))
                        };
                        let first = gap_at(0.0)?;
                        // A pair already touching at the start belongs to the contact solver; one with no points is out of reach.
                        if !first.is_finite() || first <= 2.0 * LINEAR_SLOP {
                            continue;
                        }
                        let (mut t, mut gap, mut found) = (0.0f32, first, None);
                        for i in 0..MAX_ITERATIONS {
                            t += (gap - 0.5 * TARGET) / together;
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
                            best = Some(Impact { core, own: mine, shape: other, path });
                        }
                    }
                }
                crate::world::tick(&mut self.timing, 13, &mut inner);
                let Some(impact) = best else { break };
                let t = earliest;
                let hit_tau = tau_of(t);
                // The pose of this body at the impact.
                let hit_center = [origin[0] + (shift.x * t) as f64, origin[1] + (shift.y * t) as f64];
                let hit_q = at(q0, turn, t);
                let last = sub + 1 == limit;
                // Where the other body is at the impact, when it moves: it is put back there, so the two touch where they met and do not overlap.
                let partner = impact.path.moves.then_some(self.shapes[impact.shape as usize].body);
                if let Some(other) = partner {
                    let at_hit = impact.path.at(hit_tau);
                    let c = impact.path.centre(hit_tau);
                    let o = &mut self.bodies[other as usize];
                    o.exact_center = [origin[0] + c.x as f64, origin[1] + c.y as f64];
                    o.xf.q = at_hit.q;
                    o.round_pose();
                    note(&mut moved, other, hit_tau, o.exact_center, o.xf.q);
                }
                {
                    let body = &mut self.bodies[start.body as usize];
                    body.exact_center = hit_center;
                    body.xf.q = hit_q;
                    body.round_pose();
                }
                note(&mut moved, start.body, hit_tau, hit_center, hit_q);
                if last {
                    break;
                }
                // Not the last impact: the touch is a collision, and each body goes on for the rest of the step with what it leaves.
                self.collide_at_impact(start.body, &impact, pose(t), hit_tau, origin, shift.scale(t))?;
                let rest = dt * (1.0 - hit_tau);
                for id in [Some(start.body), partner].into_iter().flatten() {
                    let b = &mut self.bodies[id as usize];
                    b.exact_center = [b.exact_center[0] + (b.linear_velocity.x * rest) as f64, b.exact_center[1] + (b.linear_velocity.y * rest) as f64];
                    b.xf.q = at(b.xf.q, b.angular_velocity * rest, 1.0);
                    b.round_pose();
                }
                tau0 = hit_tau;
                origin = hit_center;
                q0 = hit_q;
            }
            crate::world::tick(&mut self.timing, 14, &mut inner);
        }
        Ok(())
    }

    /// The collision of body `id` with the shape it met (and its body `partner` when that moves): one impulse along the contact normal that
    /// leaves the pair with the restitution of its shapes when it approached faster than the world's restitution threshold, and one
    /// along the contact that stops sliding as far as the pair's friction allows. `mine` is this body's shape at its pose at the impact
    /// and `origin` where the sweep's relative positions are measured from; `centre` is this body's centre relative to it.
    fn collide_at_impact(&mut self, id: u32, impact: &Impact, mine: Xf, tau: f32, origin: [f64; 2], centre: V2) -> Result<(), PhysicsError> {
        let m = touch(&impact.core, mine, &self.shapes[impact.shape as usize].core, impact.path.at(tau))?;
        if m.count == 0 {
            return Ok(());
        }
        let n = m.normal;
        let point = m.points[..m.count].iter().fold(V2::ZERO, |sum, p| sum.add(p.point)).scale(1.0 / m.count as f32);
        let (other_body, other_shape) = (self.shapes[impact.shape as usize].body, impact.shape);
        let (a, b) = (&self.bodies[id as usize], &self.bodies[other_body as usize]);
        let other_centre = if impact.path.moves {
            impact.path.centre(tau)
        } else {
            v2((b.exact_center[0] - origin[0]) as f32, (b.exact_center[1] - origin[1]) as f32)
        };
        let (ra, rb) = (point.sub(centre), point.sub(other_centre));
        let cross = |w: f32, r: V2| v2(-w * r.y, w * r.x);
        let (va, vb) = (a.linear_velocity.add(cross(a.angular_velocity, ra)), b.linear_velocity.add(cross(b.angular_velocity, rb)));
        let approach = vb.sub(va).dot(n);
        // Separating or sliding at the touch: nothing to answer.
        if !(approach < 0.0) {
            return Ok(());
        }
        let (ima, iia, imb, iib) = (a.inv_mass, a.inv_inertia, b.inv_mass, b.inv_inertia);
        let (sa, sb) = (&self.shapes[impact.own as usize], &self.shapes[other_shape as usize]);
        let friction = crate::solver::sqrt_product(sa.friction, sb.friction);
        let bounce = if -approach > self.settings.restitution_threshold { sa.restitution.max(sb.restitution) } else { 0.0 };
        let effective = |dir: V2| {
            let (ca, cb) = (ra.cross(dir), rb.cross(dir));
            ima + imb + iia * ca * ca + iib * cb * cb
        };
        let kn = effective(n);
        if !(kn > 0.0) {
            return Ok(());
        }
        let jn = -(1.0 + bounce) * approach / kn;
        let apply = |world: &mut World, impulse: V2| {
            let (ba, bb) = (id, other_body);
            let a = &mut world.bodies[ba as usize];
            a.linear_velocity = a.linear_velocity.sub(impulse.scale(a.inv_mass));
            a.angular_velocity -= a.inv_inertia * ra.cross(impulse);
            let b = &mut world.bodies[bb as usize];
            if b.kind == Kind::Dynamic {
                b.linear_velocity = b.linear_velocity.add(impulse.scale(b.inv_mass));
                b.angular_velocity += b.inv_inertia * rb.cross(impulse);
            }
        };
        apply(self, n.scale(jn));
        // Friction: stop the sliding at the point, within what the normal impulse lets the pair grip.
        let (a, b) = (&self.bodies[id as usize], &self.bodies[other_body as usize]);
        let (va, vb) = (a.linear_velocity.add(cross(a.angular_velocity, ra)), b.linear_velocity.add(cross(b.angular_velocity, rb)));
        let tangent = v2(-n.y, n.x);
        let slide = vb.sub(va).dot(tangent);
        let kt = effective(tangent);
        if kt > 0.0 {
            let grip = friction * jn;
            let jt = (-slide / kt).max(-grip).min(grip);
            apply(self, tangent.scale(jt));
        }
        Ok(())
    }
}

/// The manifold of two shapes with every point kept, however far apart. One copy of the collision code serves the sweep's gap search and the
/// answer to an impact, which would otherwise each carry its own.
#[inline(never)]
fn touch(a: &crate::shape::Core, xa: Xf, b: &crate::shape::Core, xb: Xf) -> Result<crate::manifold::Manifold, PhysicsError> {
    collide(a, xa, b, xb, 1.0e4)
}

/// A body whose pose along the sweep is known at any time: a dynamic one moves from where the step (or an impact) put it to where it
/// ended, a fixed or kinematic one stands at its end pose. Positions are relative to the sweep's origin.
#[derive(Clone, Copy)]
struct Path {
    moves: bool,
    /// The fraction of the step the path starts at, its centre of mass there and at the step's end, and its rotation and turn.
    tau0: f32,
    c0: [f32; 2],
    c1: [f32; 2],
    q0: Rot,
    turn: f32,
    local_center: V2,
    fixed: Xf,
}

impl Path {
    /// The pose of the body's origin at a fraction of the step.
    fn at(&self, tau: f32) -> Xf {
        if !self.moves {
            return self.fixed;
        }
        let s = self.fraction(tau);
        let q = at(self.q0, self.turn, s);
        Xf { p: self.centre(tau).sub(q.apply(self.local_center)), q }
    }
    /// The body's centre of mass at a fraction of the step.
    fn centre(&self, tau: f32) -> V2 {
        let s = self.fraction(tau);
        v2(self.c0[0] + (self.c1[0] - self.c0[0]) * s, self.c0[1] + (self.c1[1] - self.c0[1]) * s)
    }
    fn fraction(&self, tau: f32) -> f32 {
        if self.tau0 == 0.0 { tau } else { ((tau - self.tau0) / (1.0 - self.tau0)).max(0.0).min(1.0) }
    }
}

/// The earliest touch a sweep found: this body's shape, the other shape and how its body moves.
struct Impact {
    core: crate::shape::Core,
    /// This body's shape and the other one.
    own: u32,
    shape: u32,
    path: Path,
}

/// Records where a body was put and when, replacing what was recorded.
fn note(moved: &mut Vec<(u32, f32, [f64; 2], Rot)>, body: u32, tau: f32, center: [f64; 2], q: Rot) {
    match moved.iter_mut().find(|m| m.0 == body) {
        Some(entry) => *entry = (body, tau, center, q),
        None => moved.push((body, tau, center, q)),
    }
}
