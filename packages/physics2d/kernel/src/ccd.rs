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
// 2 pi minus a little as a little the other way and would let a fast spinner's tip pass through a thin wall unseen. A pair that already touches at the step's start is swept against the
// gap it began with, stopped only where it closes by more than the contact solver takes out in a step: a resting or sliding body
// is not pinned at time 0, but a long body that swings its length into the face it touches is (KB-PHYSICS2D-CCD-SPIN1).
//
// With `Settings::max_ccd_substeps` above 1 an impact before the last is answered as the contact solver answers a contact: the normal
// impulse that stops the approach, friction along the contact held to the grip that impulse gives, then the restitution impulse, from the
// same impulse-based law (Mirtich 1996), shared by the two bodies' masses and inertias; the body then goes on with what leaves for the rest
// of the step, under gravity, its forces and its damping. The pair's solver groups, a one-sided chain and the world's `modifyContact`
// hook decide whether the impact pushes, as they do for a solved contact. Rapier's documentation names the setting (`maxCcdSubsteps`, the
// most substeps the solver performs for continuous collision, default 1) and says no more; this follows that sentence and the sources
// above only.
use alloc::vec::Vec;
use margoengine_physics_kernel_common::broad::Bounds;

use crate::error::PhysicsError;
use crate::manifold::collide;
use crate::math::{Rot, V2, Xf, v2};
use crate::shape::LINEAR_SLOP;
use crate::world::{
    ContactMod, EVENT_COLLISION, EVENT_CONTACT_FORCE, Event, EventKind, ForceEvent, HOOK_CONTACT, Kind, SPECULATIVE, World, bounds_of, groups_meet, pair_allowed,
};


/// How far a pair that already touches when a step begins may close past its starting gap before the sweep stops it, m: the
/// penetration the contact solver takes out in a step (four times the linear slop), so resting and sliding contacts, whose gap
/// barely moves, are left to it.
const TOUCHING_ALLOWANCE: f32 = 4.0 * LINEAR_SLOP;

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
        let (min_dt, tolerance, max_advances) = (self.settings.min_ccd_dt, self.settings.ccd_tolerance, self.settings.ccd_max_advances as usize);
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
                let (extent, shapes) = (body.extent, body.shapes.clone());
                let travel = shift.length() + turn.abs() * extent;
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
                let bulge = (turn * turn * 0.125).min(1.0) * extent;
                // Shapes the sweep goes through because the pair would not push (solver groups, a one-sided chain's back, a hook's answer).
                let mut skip: Vec<u32> = Vec::new();
                let found = 'search: loop {
                let mut earliest = 1.0f32;
                let mut best: Option<Impact> = None;
                for &mine in &shapes {
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
                        swept.min = [swept.min[0].min(cx + shift.x.min(0.0) - extent), swept.min[1].min(cy + shift.y.min(0.0) - extent)];
                        swept.max = [swept.max[0].max(cx + shift.x.max(0.0) + extent), swept.max[1].max(cy + shift.y.max(0.0) + extent)];
                    }
                    self.broad.query(&swept, &mut candidates);
                    crate::world::tick(&mut self.timing, 12, &mut inner);
                    for &other in &candidates {
                        let s = &self.shapes[other as usize];
                        let ob = &self.bodies[s.body as usize];
                        if s.dead || s.body == start.body || s.sensor || skip.contains(&other) {
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
                        // One with no points is out of reach.
                        if !first.is_finite() {
                            continue;
                        }
                        // A pair apart at the start is swept to its touch. A pair already touching is swept too, but to where its gap has
                        // closed by more than `TOUCHING_ALLOWANCE` past the gap it began with: a body resting on or sliding along a face
                        // keeps that gap and is not stopped (it must not be pinned at time 0), while one whose turn drives its length into
                        // the face is caught where it would go through, which the contact solver, seeing only the closest points at the
                        // step's start, cannot do (KB-PHYSICS2D-CCD-SPIN1).
                        let floor = if first <= 2.0 * LINEAR_SLOP { first - TOUCHING_ALLOWANCE } else { 0.0 };
                        let gap_at = |t: f32| -> Result<f32, PhysicsError> { Ok(gap_at(t)? - floor) };
                        let first = first - floor;
                        let (mut t, mut gap, mut found) = (0.0f32, first, None);
                        // No advances at all: the time reached is the step's start, before any touch.
                        if max_advances == 0 {
                            found = Some(0.0);
                        }
                        for i in 0..max_advances {
                            let advance = (gap - 0.5 * tolerance) / together;
                            // An advance shorter than the least time worth taking stops the body at the time reached, before any touch.
                            if advance * (1.0 - tau0) * dt < min_dt {
                                found = Some(t);
                                break;
                            }
                            t += advance;
                            if t >= earliest {
                                break;
                            }
                            gap = gap_at(t)?;
                            // Out of advances while still closing: stop at the safe time reached rather than tunnel.
                            if gap <= tolerance || i + 1 == max_advances {
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
                let Some(impact) = best else { break 'search None };
                match self.answer_impact(&impact, pose(earliest), tau_of(earliest))? {
                    // The pair would not push: the sweep goes through it and looks for the next.
                    None => skip.push(impact.shape),
                    Some(law) => break 'search Some((impact, earliest, law)),
                }
                };
                let Some((impact, t, law)) = found else { break };
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
                let rest = dt * (1.0 - hit_tau);
                let (touch_tau, touch_center, touch_q) = self.respond_to_impact(start.body, &impact, &law, pose(t), hit_tau, origin, shift.scale(t), rest, dt, &mut moved)?;
                tau0 = touch_tau;
                origin = touch_center;
                q0 = touch_q;
            }
            crate::world::tick(&mut self.timing, 14, &mut inner);
        }
        Ok(())
    }

    /// Whether an impact pushes, and how. A pair whose solver groups do not meet, the back of a one-sided chain, and a pair a hook's
    /// `modifyContact` makes inactive (or a one-way platform's closed side) are gone through, as the contact solver would go through
    /// them; otherwise the pair's restitution and friction, the shapes' or the hook's, and a conveyor's surface speed.
    fn answer_impact(&mut self, impact: &Impact, mine: Xf, tau: f32) -> Result<Option<Law>, PhysicsError> {
        let (sa, sb) = (&self.shapes[impact.own as usize], &self.shapes[impact.shape as usize]);
        if sa.sensor || sb.sensor || !groups_meet(sa.solver_groups, sb.solver_groups) {
            return Ok(None);
        }
        let (one_sided, side, asks) = (sb.one_sided, sb.core.normals[0], (sa.hooks | sb.hooks) & HOOK_CONTACT != 0);
        let mut law = Law { restitution: sa.restitution.max(sb.restitution), friction: crate::solver::sqrt_product(sa.friction, sb.friction), tangent_speed: 0.0 };
        let other = impact.path.at(tau);
        let m = touch(&impact.core, mine, &sb.core, other)?;
        if m.count == 0 {
            return Ok(None);
        }
        let n = m.normal;
        // A one-sided chain is solid on the side its segments' right-hand normals point to; `n` runs from this body to the chain.
        if one_sided && other.q.apply(side).dot(n.neg()) < 0.0 {
            return Ok(None);
        }
        if asks {
            if let Some(mut hook) = self.hook.take() {
                // The hook sees the pair in shape id order with the normal from the first to the second, as the contact solver's.
                let (a, b, normal) = if impact.own < impact.shape { (impact.own, impact.shape, n) } else { (impact.shape, impact.own, n.neg()) };
                let mut change = ContactMod { a, b, normal, points: m.count, solver_active: true, friction: None, restitution: None, one_way: None, tangent_speed: 0.0 };
                hook.contact(&mut change);
                self.hook = Some(hook);
                if !change.solver_active || change.one_way.is_some_and(|way| normal.dot(way) <= 0.0) {
                    return Ok(None);
                }
                if let Some(f) = change.friction.filter(|f| f.is_finite() && *f >= 0.0) {
                    law.friction = f;
                }
                if let Some(r) = change.restitution.filter(|r| r.is_finite() && *r >= 0.0) {
                    law.restitution = r;
                }
                if change.tangent_speed.is_finite() {
                    law.tangent_speed = change.tangent_speed;
                }
            }
        }
        Ok(Some(law))
    }

    /// The acceleration a dynamic body is under when the step is not solving it: gravity and its scale, and the forces and torques set on it.
    fn free_acceleration(&self, id: u32) -> (V2, f32) {
        let b = &self.bodies[id as usize];
        if b.kind != Kind::Dynamic {
            return (V2::ZERO, 0.0);
        }
        (self.settings.gravity.scale(b.gravity_scale).add(b.force.scale(b.inv_mass)), b.inv_inertia * b.torque)
    }

    /// Takes off the velocity the rest of the step (`rest` seconds) gave a body, one integrator step of it: gravity, forces and damping.
    fn velocity_at_impact(&mut self, id: u32, rest: f32) {
        let (a, alpha) = self.free_acceleration(id);
        let b = &mut self.bodies[id as usize];
        if b.kind != Kind::Dynamic {
            return;
        }
        b.linear_velocity = b.linear_velocity.scale(1.0 + rest * b.linear_damping).sub(a.scale(rest));
        b.angular_velocity = b.angular_velocity * (1.0 + rest * b.angular_damping) - alpha * rest;
    }

    /// Carries a body from its pose at an impact through the `rest` seconds of the step left, under gravity, its forces and its damping.
    fn carry_on(&mut self, id: u32, rest: f32) {
        let (a, alpha) = self.free_acceleration(id);
        let b = &mut self.bodies[id as usize];
        if b.kind != Kind::Dynamic {
            return;
        }
        let (v, w) = (b.linear_velocity, b.angular_velocity);
        let step = v.scale(rest).add(a.scale(0.5 * rest * rest));
        b.exact_center = [b.exact_center[0] + step.x as f64, b.exact_center[1] + step.y as f64];
        b.xf.q = at(b.xf.q, w * rest + 0.5 * alpha * rest * rest, 1.0);
        b.linear_velocity = v.add(a.scale(rest)).scale(1.0 / (1.0 + rest * b.linear_damping));
        b.angular_velocity = (w + alpha * rest) / (1.0 + rest * b.angular_damping);
        b.round_pose();
    }

    /// The collision of body `id` with the shape it met (and of the body that shape is on, when it moves), answered as the contact solver
    /// answers a contact: a normal impulse that stops the approach, friction along the contact within the pair's coefficient times that
    /// impulse (toward a conveyor's surface speed when a hook set one), then, when the approach was faster than the world's restitution
    /// threshold, the impulse that leaves the pair at the restitution times the approach. Each body then goes on for the `rest` seconds of
    /// the step left. The sweep stops the body up to the time-of-impact target short of the surface; the time the approach would take to close
    /// that gap is spent before the collision, so the arc leaves from where the surfaces meet. Returns when, and where, that was.
    /// `mine` is this body's shape at the impact, `origin` where the sweep's relative positions are measured from and
    /// `centre` this body's centre relative to it. The impact is reported as a touch that began and ended, and its impulse as a contact force.
    fn respond_to_impact(
        &mut self,
        id: u32,
        impact: &Impact,
        law: &Law,
        mine: Xf,
        tau: f32,
        origin: [f64; 2],
        centre: V2,
        rest: f32,
        dt: f32,
        moved: &mut Vec<(u32, f32, [f64; 2], Rot)>,
    ) -> Result<(f32, [f64; 2], Rot), PhysicsError> {
        let other_body = self.shapes[impact.shape as usize].body;
        let other = impact.path.at(tau);
        let m = touch(&impact.core, mine, &self.shapes[impact.shape as usize].core, other)?;
        let moves = impact.path.moves;
        // The velocities the two bodies had when they met, not those the step ended with.
        self.velocity_at_impact(id, rest);
        if moves {
            self.velocity_at_impact(other_body, rest);
        }
        let mut total = 0.0f32;
        let mut rest = rest;
        let mut lost = 0.0f32;
        if m.count > 0 {
            let n = m.normal;
            let point = m.points[..m.count].iter().fold(V2::ZERO, |sum, p| sum.add(p.point)).scale(1.0 / m.count as f32);
            let b = &self.bodies[other_body as usize];
            let other_centre = if moves { impact.path.centre(tau) } else { v2((b.exact_center[0] - origin[0]) as f32, (b.exact_center[1] - origin[1]) as f32) };
            let (ra, rb) = (point.sub(centre), point.sub(other_centre));
            let (ima, iia, imb, iib) = (self.bodies[id as usize].inv_mass, self.bodies[id as usize].inv_inertia, b.inv_mass, b.inv_inertia);
            let cross = |w: f32, r: V2| v2(-w * r.y, w * r.x);
            let relative = |world: &World| {
                let (a, b) = (&world.bodies[id as usize], &world.bodies[other_body as usize]);
                b.linear_velocity.add(cross(b.angular_velocity, rb)).sub(a.linear_velocity.add(cross(a.angular_velocity, ra)))
            };
            let effective = |dir: V2| {
                let (ca, cb) = (ra.cross(dir), rb.cross(dir));
                ima + imb + iia * ca * ca + iib * cb * cb
            };
            let apply = |world: &mut World, impulse: V2| {
                let a = &mut world.bodies[id as usize];
                a.linear_velocity = a.linear_velocity.sub(impulse.scale(a.inv_mass));
                a.angular_velocity -= a.inv_inertia * ra.cross(impulse);
                let b = &mut world.bodies[other_body as usize];
                if b.kind == Kind::Dynamic {
                    b.linear_velocity = b.linear_velocity.add(impulse.scale(b.inv_mass));
                    b.angular_velocity += b.inv_inertia * rb.cross(impulse);
                }
            };
            let approach = relative(self).dot(n);
            let kn = effective(n);
            if approach < 0.0 && kn > 0.0 {
                // Close what is left of the gap at the speed of the approach, then collide.
                let gap = m.points[..m.count].iter().fold(f32::INFINITY, |least, p| least.min(p.separation)).max(0.0);
                lost = (gap / -approach).min(rest);
                if lost > 0.0 {
                    for body in [Some(id), moves.then_some(other_body)].into_iter().flatten() {
                        let b = &mut self.bodies[body as usize];
                        b.exact_center = [b.exact_center[0] + (b.linear_velocity.x * lost) as f64, b.exact_center[1] + (b.linear_velocity.y * lost) as f64];
                        b.xf.q = at(b.xf.q, b.angular_velocity * lost, 1.0);
                        b.round_pose();
                    }
                    rest -= lost;
                }
                // Stop the approach.
                let stop = -approach / kn;
                apply(self, n.scale(stop));
                total += stop;
                // Friction, within what that impulse lets the pair grip.
                let tangent = n.right();
                let kt = effective(tangent);
                if kt > 0.0 {
                    let grip = law.friction * stop;
                    let slide = relative(self).dot(tangent) - law.tangent_speed;
                    let jt = (-slide / kt).max(-grip).min(grip);
                    apply(self, tangent.scale(jt));
                }
                // Bounce, when it came in fast enough: the normal speed leaves at the restitution times the approach.
                if -approach > self.settings.restitution_threshold && law.restitution > 0.0 {
                    let bounce = (-(relative(self).dot(n) + law.restitution * approach) / kn).max(-stop);
                    apply(self, n.scale(bounce));
                    total += bounce;
                }
                self.report_impact(impact.own, impact.shape, n, total, dt);
            }
        }
        // Where the two are as they collide, for what the sweep goes on from.
        let touch_tau = tau + lost / dt;
        let (here, turned_to) = (self.bodies[id as usize].exact_center, self.bodies[id as usize].xf.q);
        note(moved, id, touch_tau, here, turned_to);
        if moves {
            let b = &self.bodies[other_body as usize];
            let (c, q) = (b.exact_center, b.xf.q);
            note(moved, other_body, touch_tau, c, q);
        }
        self.carry_on(id, rest);
        if moves {
            self.carry_on(other_body, rest);
        }
        Ok((touch_tau, here, turned_to))
    }

    /// Reports an answered impact: a touch that began and ended in the step for shapes that ask for collision events, and its impulse as a
    /// contact force for those that ask for force events, with the thresholds the solver's contacts use.
    fn report_impact(&mut self, own: u32, other: u32, normal: V2, impulse: f32, dt: f32) {
        let (a, b, normal) = if own < other { (own, other, normal) } else { (other, own, normal.neg()) };
        let (sa, sb) = (&self.shapes[a as usize], &self.shapes[b as usize]);
        let events = sa.events | sb.events;
        if events & EVENT_COLLISION != 0 {
            self.events.push(Event { kind: EventKind::Started, a, b, sensor: false });
            self.events.push(Event { kind: EventKind::Stopped, a, b, sensor: false });
        }
        if events & EVENT_CONTACT_FORCE != 0 {
            let force = impulse / dt;
            let threshold = if sa.events & EVENT_CONTACT_FORCE != 0 { sa.force_threshold } else { 0.0 }.max(if sb.events & EVENT_CONTACT_FORCE != 0 { sb.force_threshold } else { 0.0 });
            if force > threshold {
                self.force_events.push(ForceEvent { a, b, force, normal });
            }
        }
    }
}

/// The manifold of two shapes with every point kept, however far apart. One copy of the collision code serves the sweep's gap search and the
/// answer to an impact, which would otherwise each carry its own.
#[inline(never)]
fn touch(a: &crate::shape::Core, xa: Xf, b: &crate::shape::Core, xb: Xf) -> Result<crate::manifold::Manifold, PhysicsError> {
    collide(a, xa, b, xb, 1.0e4)
}

/// What an impact does when it pushes: the pair's restitution and friction (the shapes', or a hook's) and a conveyor's surface speed.
#[derive(Clone, Copy)]
struct Law {
    restitution: f32,
    friction: f32,
    tangent_speed: f32,
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
