// Continuous collision for the bodies that ask for it, Rapier's `ccd_enabled`.
//
// Speculative contacts (narrow.rs, `contact_limit`) already give every body contact points as far ahead as it can move in
// a step, from the closest features at the step's start. A fast thin body can still pass what those features miss: a wall
// whose nearest feature at the start is not the one it meets, a corner, a turn. A body with CCD on is therefore checked
// after the step: when it moved further than its thinnest piece is thick (only then can it pass through anything), each
// of its convex pieces is swept from the pose the step started at to the pose it ended at, against every collider whose
// fat box meets the box of its path, and the body is put back to the first time any piece touches, its velocity kept,
// so the next step's contacts meet the surface it would have passed.
//
// The sweep is conservative advancement (Mirtich, PhD thesis, 1996; as set out by Catto, "Continuous Collision", GDC
// 2013): along the path where each body's centre of mass moves on a line and the body turns at a constant rate between
// its two poses, a point of a piece moves at most the centre's displacement plus the turn's angle times the piece's reach
// from the centre. So the gap along any fixed axis falls no faster than the relative displacement along it plus both
// angle-times-reach terms, and time can advance by the gap over that bound without passing a touch. The gap is a lower
// bound, the largest of the support-plane gaps along the GJK closest points' axis and the axis kept from the last step
// (the same bound `cast::sharpen` uses), never GJK's own distance, which can sit above a touch. The advance stops within
// TOUCH of the surface, or after STEPS, at a time that is still before any touch: CCD can lose time, never tunnel.
use crate::cast::{Solid, bounds, core};
use crate::gjk::{Convex, Distance, epa, gjk};
use crate::hull::BoxData;
use crate::layout::*;
use crate::math::*;
use crate::revolve::Revolved;
use crate::sat::Pose;
use crate::world::{NONE, World};

/// How close the sweep brings a piece before it stops, and its most advances a pair.
const TOUCH: f32 = 1e-3;
const STEPS: usize = 64;

/// A body's motion over the step: the centre of mass from `c0` to `c1`, the turn `turn` (a rotation vector) from `q0`.
#[derive(Clone, Copy)]
struct Motion {
    c0: V3,
    c1: V3,
    q0: Q,
    q1: Q,
    turn: V3,
    local: V3,
}

impl Motion {
    /// The body's pose at time `s` of the step, 0 to 1.
    fn at(&self, s: f32) -> Pose {
        let q = if s >= 1.0 { self.q1 } else { Q::from_rotation_vector(self.turn.scale(s)).mul(self.q0) };
        let c = if s >= 1.0 { self.c1 } else { self.c0.add(self.c1.sub(self.c0).scale(s)) };
        Pose { p: c.sub(q.rotate(self.local)), q }
    }
    fn angle(&self) -> f32 {
        sqrt(self.turn.dot(self.turn))
    }
    /// The same motion over the rest of the step from time `t`, its time running 0 to 1 again. Turns about one axis add,
    /// so the turn left is the turn times 1 - t.
    fn from(&self, t: f32) -> Motion {
        if t <= 0.0 {
            return *self;
        }
        let pose = self.at(t);
        Motion { c0: pose.apply(self.local), q0: pose.q, turn: self.turn.scale(1.0 - t), ..*self }
    }
    /// A body that stays at `pose`.
    fn still(pose: Pose, local: V3) -> Motion {
        let c = pose.apply(local);
        Motion { c0: c, c1: c, q0: pose.q, q1: pose.q, turn: v3(0.0, 0.0, 0.0), local }
    }
    fn moves(&self) -> bool {
        self.c0 != self.c1 || self.turn != v3(0.0, 0.0, 0.0)
    }
}

impl World {
    fn motion(&self, at: usize) -> Motion {
        let local = self.v(LOCAL_CENTER_X, at);
        let (q0, q1) = (self.q(PREVIOUS_ROTATION_X, at), self.q(ROTATION_X, at));
        let (c0, c1) = (self.v(PREVIOUS_X, at).add(q0.rotate(local)), self.v(POSITION_X, at).add(q1.rotate(local)));
        Motion { c0, c1, q0, q1, turn: q1.mul(q0.conjugate()).to_rotation_vector(), local }
    }

    /// The motion of a body the sweep meets: a fixed or sleeping body did not move this step, whatever its last step did.
    fn motion_of_other(&self, at: usize) -> Motion {
        let flags = self.flags(at);
        if flags & KIND == FIXED || flags & SLEEPING != 0 {
            let local = self.v(LOCAL_CENTER_X, at);
            let (p, q) = (self.v(POSITION_X, at), self.q(ROTATION_X, at));
            let c = p.add(q.rotate(local));
            return Motion { c0: c, c1: c, q0: q, q1: q, turn: v3(0.0, 0.0, 0.0), local };
        }
        self.motion(at)
    }

    /// Calls `visit` with each convex piece of collider `c`: itself, or a compound's children.
    fn each_piece(&self, c: usize, visit: &mut dyn FnMut(usize)) {
        if self.uu(COLLIDER_SHAPE, c) == SHAPE_COMPOUND {
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != NONE {
                visit(child as usize);
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
        } else {
            visit(c);
        }
    }

    /// How thick a convex piece is: the least distance from its centre to its surface. Zero for a mesh, which is no piece.
    fn thickness(&self, c: usize) -> f32 {
        let size = self.v(COLLIDER_A, c);
        match self.uu(COLLIDER_SHAPE, c) {
            SHAPE_BALL | SHAPE_CAPSULE => size.x,
            SHAPE_BOX => size.x.min(size.y).min(size.z),
            SHAPE_CYLINDER | SHAPE_CONE => Revolved { cone: self.uu(COLLIDER_SHAPE, c) == SHAPE_CONE, r: size.x, h: size.y }.thickness(size.z),
            SHAPE_HULL => {
                let hull = self.uu(COLLIDER_HULL, c) as usize;
                let (poly, center) = (self.hull_poly(hull), self.v(HULL_CENTER_X, hull));
                (0..poly.faces).fold(f32::INFINITY, |least, f| least.min(poly.plane(f) - poly.normal(f).dot(center)))
            }
            _ => 0.0,
        }
    }

    /// The pose of piece `c` when its body is at `body`.
    fn piece_pose(&self, c: usize, body: Pose) -> Pose {
        Pose { p: body.apply(self.v(COLLIDER_X, c)), q: body.q.mul(self.q(COLLIDER_ROTATION_X, c)) }
    }

    /// After the step's substeps: puts each awake CCD body that moved further than it is thick back to its first touch,
    /// and marks which ones were checked (CCD_ACTIVE, Rapier's `is_ccd_active`).
    pub fn ccd_pass(&mut self) {
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            let flags = self.flags(at);
            if flags & CCD == 0 {
                continue;
            }
            let motion = self.motion(at);
            let (mut thin, mut reach) = (f32::INFINITY, 0.0f32);
            let mut c = self.uu(FIRST_COLLIDER, at);
            while c != NONE {
                if self.uu(COLLIDER_FLAGS, c as usize) & (COLLIDER_SENSOR | COLLIDER_OFF) == 0 {
                    self.each_piece(c as usize, &mut |piece| {
                        thin = thin.min(self.thickness(piece));
                        reach = reach.max(self.collider_reach_of(piece));
                    });
                }
                c = self.uu(COLLIDER_NEXT, c as usize);
            }
            let moved = sqrt(motion.c1.sub(motion.c0).dot(motion.c1.sub(motion.c0))) + motion.angle() * reach;
            let active = flags & KIND == DYNAMIC && thin.is_finite() && moved > thin;
            self.set_u(FLAGS, at, if active { flags | CCD_ACTIVE } else { flags & !CCD_ACTIVE });
            if !active {
                continue;
            }
            // What the body can reach this step: a box about its centre's path, grown by its farthest surface point. Any
            // collider whose fat box (broad.rs) meets it is swept against: the step's pairs were found from the speed the
            // step began with, and a knock from another body in the step can carry it past them.
            let grow = v3(reach, reach, reach);
            let path = (motion.c0.min(motion.c1).sub(grow), motion.c0.max(motion.c1).add(grow));
            let (first, hit) = self.first_touch(at, &motion, path, 0.0, false);
            if first >= 1.0 {
                continue;
            }
            let mut pose = motion.at(first);
            if let Some(carried) = self.ride(hit, first, pose) {
                pose = carried;
            } else {
                // Stopped on what does not carry it, the body stays there for the rest of the step, and a body that
                // moves on may still come at it, a wall pushed through a pile of bullets: the first that can carry it and
                // does come at it carries it from its touch.
                let still = Motion::still(pose, motion.local);
                let (rest, by) = self.first_touch(at, &still, (still.c0.sub(grow), still.c0.add(grow)), first, true);
                if rest < 1.0 {
                    if let Some(carried) = self.ride(by, first + rest * (1.0 - first), pose) {
                        pose = carried;
                    }
                }
            }
            self.set_v(POSITION_X, at, pose.p);
            self.set_q(ROTATION_X, at, pose.q);
            self.set_v(CENTER_X, at, pose.apply(motion.local));
        }
    }

    /// The first time, 0 to 1, that body `at` moving by `mine` touches a collider whose fat box meets `reach`, every
    /// other body moving by its motion over the step from time `from` on, and the body touched (NONE for none). With
    /// `carriers`, only the bodies that can carry it (`ride`).
    fn first_touch(&self, at: usize, mine: &Motion, (low, high): (V3, V3), from: f32, carriers: bool) -> (f32, usize) {
        let (mut first, mut hit) = (1.0f32, NONE as usize);
        for body in 0..self.header().rows as usize {
            let flags = self.uu(FLAGS, body);
            if body == at || flags & ALIVE == 0 || flags & DISABLED != 0 || carriers && !self.carries(body) {
                continue;
            }
            let mut other = self.uu(FIRST_COLLIDER, body);
            while other != NONE {
                let o = other as usize;
                let (a, b) = (self.v(FAT_MIN_X, o), self.v(FAT_MAX_X, o));
                if a.x <= high.x && low.x <= b.x && a.y <= high.y && low.y <= b.y && a.z <= high.z && low.z <= b.z {
                    let theirs = self.motion_of_other(body).from(from);
                    let mut c = self.uu(FIRST_COLLIDER, at);
                    while c != NONE {
                        let own = c as usize;
                        if self.uu(COLLIDER_FLAGS, own) & (COLLIDER_SENSOR | COLLIDER_OFF) == 0 && self.solid_pair(own, o) && self.may_touch(own, o, at, body) {
                            self.each_piece(own, &mut |piece| {
                                let t = self.sweep_piece(piece, mine, o, &theirs, first);
                                if t < first {
                                    (first, hit) = (t, body);
                                }
                            });
                        }
                        c = self.uu(COLLIDER_NEXT, own);
                    }
                }
                other = self.uu(COLLIDER_NEXT, o);
            }
        }
        (first, hit)
    }

    /// Where a body put back to `pose` at time `t` of the step, on body `hit`, ends the step when `hit` carries it: when
    /// `hit` moves, and its end pose is settled, not another CCD body's that its own sweep may still take back. Left at
    /// its touch, the body would end the step inside one that moves on, past its middle when that moves faster than the
    /// body is thick, and be pushed out on the far side; riding with it for the rest of the step, it ends as it touched.
    fn ride(&self, hit: usize, t: f32, pose: Pose) -> Option<Pose> {
        if hit == NONE as usize || !self.carries(hit) {
            return None;
        }
        let theirs = self.motion_of_other(hit);
        let (then, end) = (theirs.at(t), theirs.at(1.0));
        let carried = then.relative(pose);
        Some(Pose { p: end.apply(carried.p), q: end.q.mul(carried.q) })
    }

    /// Whether body `at` can carry a body it touches (`ride`): it moved this step, and its end pose is settled, not another
    /// CCD body's that its own sweep may still take back.
    fn carries(&self, at: usize) -> bool {
        self.flags(at) & (KIND | CCD) != DYNAMIC | CCD && self.motion_of_other(at).moves()
    }

    /// Whether two colliders push each other: neither is a sensor and their solver groups meet.
    fn solid_pair(&self, a: usize, b: usize) -> bool {
        (self.uu(COLLIDER_FLAGS, a) | self.uu(COLLIDER_FLAGS, b)) & COLLIDER_SENSOR == 0
            && crate::events::groups_meet(self.uu(COLLIDER_SOLVER_GROUPS, a), self.uu(COLLIDER_SOLVER_GROUPS, b))
    }
    /// How far a turn about its body's centre of mass can move a collider's surface: its reach less a ball's or capsule's
    /// radius, or a cylinder's or cone's border, since a round shape's support along any axis is its core's plus the
    /// radius, whatever the turn.
    fn turning_reach(&self, c: usize) -> f32 {
        let round = match self.uu(COLLIDER_SHAPE, c) {
            SHAPE_BALL | SHAPE_CAPSULE => self.s(COLLIDER_A, c),
            SHAPE_CYLINDER | SHAPE_CONE => self.s(COLLIDER_C, c),
            _ => 0.0,
        };
        self.collider_reach_of(c) - round
    }

    /// The first time, from 0 to `until`, that piece `c` moving by `mine` touches collider `other` moving by `theirs`, or
    /// `until` when it does not before then. A part already in contact at the start is held to its depth there (`gap`).
    fn sweep_piece(&self, c: usize, mine: &Motion, other: usize, theirs: &Motion, until: f32) -> f32 {
        let (reach_c, reach_o) = (self.turning_reach(c), self.turning_reach(other));
        let shift = mine.c1.sub(mine.c0).sub(theirs.c1.sub(theirs.c0));
        let turning = mine.angle() * reach_c + theirs.angle() * reach_o;
        let far = turning + sqrt(shift.dot(shift));
        let start = (self.piece_pose(c, mine.at(0.0)), theirs.at(0.0));
        // The deepest the sweep lets the piece sink into a part it touches: half its thickness, so its middle never
        // reaches a surface, however thin the surface is.
        let floor = -0.5 * self.thickness(c);
        let mut s = 0.0f32;
        let mut kept = v3(0.0, 0.0, 0.0);
        for _ in 0..STEPS {
            let now = (self.piece_pose(c, mine.at(s)), theirs.at(s));
            let Some((gap, n)) = self.gap(c, other, now, start, (kept, far, shift, floor)) else {
                return until;
            };
            if gap <= TOUCH {
                return s;
            }
            kept = n;
            // n points from the other collider to the piece; closing is how fast the gap along n can fall.
            let closing = -shift.dot(n) + turning;
            if closing <= 0.0 {
                return until;
            }
            // Aimed half the touch short, so the advance ends within TOUCH and not on the surface, where rounding can read
            // the two as overlapping.
            s += (gap - 0.5 * TOUCH) / closing;
            if s >= until {
                return until;
            }
        }
        // Out of advances: every one kept short of a touch, so the time reached is still before it.
        s
    }

    /// A lower bound on how far piece `c` is from touching collider `other`, with the piece at `now.0` and the other's
    /// body at `now.1`, and the unit world axis from the other to the piece it was read along; None when no part of `other`
    /// lies within `far`, the most the pair can close in the step. The bound is the least over the other's parts.
    ///
    /// A part apart from the piece at the sweep's `start` gives its gap: the largest support-plane gap along the GJK
    /// closest points' axis and `kept`, the axis of the last advance, never GJK's own distance, which can sit above a
    /// touch; an overlap read later is a touch. A part already in contact at the start (within TOUCH, or overlapping) is
    /// the contacts' to push out, and must not be read as a touch at time 0, which would put the body back to the step's
    /// start every step: frozen on a floor it slides along, or left behind by a wall that carries it. It is held instead
    /// along the axis it was in contact on at the start (GJK's closest points' axis, or EPA's way out): its support-plane
    /// gap there may fall to `floor`, half the piece's thickness deep, a depth fixed so steps cannot add up: a body pressed
    /// into a surface by a crowd behind it does not creep through it a little each step. So a body that turns or presses
    /// into a surface it touches stops before its middle reaches it, as one that comes from afar stops at the touch. A part
    /// already that deep at the start is the contacts' alone while the pair's motion `shift` along the axis takes the
    /// piece out of it, and holds the body at the start while it goes on in.
    fn gap(&self, c: usize, other: usize, now: (Pose, Pose), start: (Pose, Pose), (kept, far, shift, floor): (V3, f32, V3, f32)) -> Option<(f32, V3)> {
        let mut best: Option<(f32, V3)> = None;
        // One part, `target` against the piece now and `target0` at the start, each in a frame turned by `frame` from the
        // world's.
        let mut offer = |piece: &Solid, target: &Solid, frame: Q, piece0: &Solid, target0: &Solid, frame0: Q| {
            let bound = |p: &Solid, t: &Solid, n: V3| p.support(n.scale(-1.0)).dot(n) - t.support(n).dot(n);
            let at_start = gjk(piece0, target0, v3(0.0, 0.0, 0.0), f32::INFINITY);
            let between = at_start.v;
            let length = at_start.distance;
            let apart = !at_start.overlap && length > TOUCH && bound(piece0, target0, between.scale(1.0 / length)) > TOUCH;
            let held = if apart {
                None
            } else {
                match contact_axis(piece0, target0, &at_start) {
                    Some(axis) => Some(axis),
                    // No axis to hold it along (shapes that only touch on a set too thin to read one from): the contacts
                    // have it.
                    None => return,
                }
            };
            let (gap, axis) = match held {
                Some(axis0) => {
                    let world = frame0.rotate(axis0);
                    if bound(piece0, target0, axis0) - floor <= TOUCH {
                        if shift.dot(world) >= 0.0 {
                            return;
                        }
                        (0.0, world)
                    } else {
                        (bound(piece, target, frame.unrotate(world)) - floor, world)
                    }
                }
                None => {
                    let d = gjk(piece, target, v3(0.0, 0.0, 0.0), f32::INFINITY);
                    if d.overlap {
                        (0.0, kept)
                    } else {
                        let between = d.v;
                        let length = d.distance;
                        let (mut gap, mut axis) = (-1.0f32, v3(0.0, 0.0, 0.0));
                        if length > 0.0 {
                            let fresh = between.scale(1.0 / length);
                            (gap, axis) = (bound(piece, target, fresh), frame.rotate(fresh));
                        }
                        let local = frame.unrotate(kept);
                        if kept != v3(0.0, 0.0, 0.0) && bound(piece, target, local) > gap {
                            (gap, axis) = (bound(piece, target, local), kept);
                        }
                        (gap, axis)
                    }
                }
            };
            if best.is_none_or(|(b, _)| gap < b) {
                best = Some((gap, axis));
            }
        };
        let (mut data, mut data0) = (BoxData::new(), BoxData::new());
        let shape = self.uu(COLLIDER_SHAPE, other);
        if shape != SHAPE_TRIMESH {
            let query = self.solid(self.shape_of(c), now.0, &mut data)?;
            let query0 = self.solid(self.shape_of(c), start.0, &mut data0)?;
            let (mut target_data, mut target_data0) = (BoxData::new(), BoxData::new());
            let mut each = |o: usize| {
                let target = self.solid(self.shape_of(o), self.piece_pose(o, now.1), &mut target_data);
                let target0 = self.solid(self.shape_of(o), self.piece_pose(o, start.1), &mut target_data0);
                if let (Some(target), Some(target0)) = (target, target0) {
                    offer(&query, &target, Q::IDENTITY, &query0, &target0, Q::IDENTITY);
                }
            };
            self.each_piece(other, &mut each);
            return best;
        }
        // A mesh, height field or voxel grid: the piece in its frame, now and at the start, against the parts within `far`
        // of it now. A part is fixed in the mesh's frame, so it is the same part at the start.
        let (frame, frame0) = (self.piece_pose(other, now.1), self.piece_pose(other, start.1));
        let piece = self.solid(self.shape_of(c), frame.relative(now.0), &mut data)?;
        let piece0 = self.solid(self.shape_of(c), frame0.relative(start.0), &mut data0)?;
        let (low, high) = bounds(&piece);
        let grow = v3(far, far, far);
        let (low, high) = (low.sub(grow), high.add(grow));
        let meets = |a: V3, b: V3| !(a.x > high.x || a.y > high.y || a.z > high.z || b.x < low.x || b.y < low.y || b.z < low.z);
        self.each_part(self.uu(COLLIDER_HULL, other) as usize, (low, high), &meets, &mut |target| {
            offer(&piece, &target, frame.q, &piece0, &target, frame0.q);
            true
        });
        // Parts farther than `far` from the piece cannot be reached in the step.
        best
    }
}

/// The axis a piece is in contact with a part along, from the part to the piece, for `gap` to hold it on: of the GJK
/// closest points' axis, EPA's way out of an overlap, the axis between round cores and each face normal of either solid,
/// the one with the largest support-plane gap, which is the separating axis test's (Gregorius 2015). Near a touch the
/// closest points' difference is mostly rounding, and its axis, a little off a big floor's normal, reads the floor's far
/// corner. None when no axis can be read.
fn contact_axis(piece: &Solid, target: &Solid, at_start: &Distance) -> Option<V3> {
    let bound = |n: V3| piece.support(n.scale(-1.0)).dot(n) - target.support(n).dot(n);
    let mut best: Option<(V3, f32)> = None;
    let mut consider = |n: V3| {
        let g = bound(n);
        if best.is_none_or(|(_, b)| g > b) {
            best = Some((n, g));
        }
    };
    let (between, length) = (at_start.v, at_start.distance);
    if !at_start.overlap && length > 0.0 {
        consider(between.scale(1.0 / length));
    }
    if at_start.overlap {
        // EPA's normal is from the piece to the part.
        if let Some(out) = epa(piece, target, at_start) {
            consider(out.normal.scale(-1.0));
        }
    }
    let ((core_p, rp), (core_t, rt)) = (core(piece), core(target));
    if rp > 0.0 || rt > 0.0 {
        let d = gjk(&core_p, &core_t, v3(0.0, 0.0, 0.0), f32::INFINITY);
        if !d.overlap && d.distance > 0.0 {
            consider(d.v.scale(1.0 / d.distance));
        }
    }
    for (s, sign) in [(target, 1.0f32), (piece, -1.0)] {
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
            Solid::Revolved { pose, .. } => {
                let axis = pose.q.rotate(v3(0.0, 1.0, 0.0));
                consider(axis.scale(sign));
                consider(axis.scale(-sign));
            }
            Solid::Round { .. } => {}
        }
    }
    best.map(|(n, _)| n)
}
