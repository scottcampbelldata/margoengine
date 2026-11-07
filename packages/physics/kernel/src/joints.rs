// Joints. One six-axis joint serves every kind: each axis along or about frame A is locked, limited, driven by a motor, or
// free. A hinge is a joint with one free turning axis. Each substep:
//
//   integrate velocities; rows; warm start; settling passes; one pushing pass; integrate poses; rows; relaxing pass.
//
// Locks are rigid. Along a path of joints J M^-1 J^T is block tridiagonal, the sparsity Baraff 1996 uses, so block Cholesky
// solves a path exactly in one sweep: Gauss-Seidel moves a load one joint a pass, so a light chain under a heavy end would
// stretch for seconds. A path nothing leans on closes its whole error in the pushing pass and takes the speed of that push
// back out in the relaxing pass, on rows from the new pose: the two stages of RATTLE (Andersen 1983, in Hairer's notes,
// section V.5), which is why a pendulum keeps its period. Where a branch or a ring ends a path, paths meet by block
// Gauss-Seidel and close joint_loose_share of the error a substep: a full push fights its neighbours' pushes.
//
// The pushing pass is the only one that carries a position bias, and it is the only one the warm start does not remember.
// Remembering it makes a mode the passes have not settled a triple integrator, error from speed from impulse, whose one
// feedback is the error itself, and that grows at any share (the derivation is in docs/clean-room.md, row PK24). A soft
// row has its own way out, the gamma term below, which is why contacts can remember everything.
//
// Memory is only a guess, and the solve's own measure says when it is a bad one. A pass over the rows descends
// f(p) = 1/2 p^T K p + p^T J v, the energy an impulse p adds, with K = J M^-1 J^T, and the memory m stands at f(m) where a cold
// start stands at 0. A load that is right has its minimum at 1. An impact is no load: a limit that caught a swing holds the
// swing's whole impulse, and handing that back returns the swing. Rows that ask the impossible hold more still, in directions
// J^T m nearly cancels, which nothing corrects as they move nothing: once the rows turn that is a kick, the kick turns the
// rows faster, and speeds run away. So a warm start that would add more than one push's energy to its island is taken only as
// far as f's minimum along m, and the rest is forgotten. That is what the search limits, and only the memory: the passes
// still solve the rows, so a limit that forgets starts its substep cold. On the proof scenes it acts once per catch of a
// stop and nowhere else, and each figure in tests/joints.rs reads the same with it off. No paper does this: the search is
// the exact minimum of a quadratic along a line, the rule Buss 2009 uses for its Jacobian transpose step, and its use on a
// warm start is ours.
//
// Rows can depend on each other: a body held by more locks than it has freedoms, or a chain pulled straight. The factors drop
// such a row, as Baraff 1996 says K is singular there, and that takes a test that can see it: K in doubles from the f32
// rows, the largest pivot first, as a pivot taken in order can leave a Schur complement of any size (Higham 1990, section 2),
// and a stop once what is left is under the rounding of the rows themselves, his test (4.3).
//
// Close to such a pose the rows are not dependent yet, and the exact solve needs speeds of 1 / angle to close what they ask.
// A push is a Gauss-Newton step, and there its first order model holds only for a small turn: Buss and Kim 2005's two links
// pulled nearly straight, the same pose as an arm reaching for what it cannot reach. Their section 4 bounds such a step by
// gamma = min(1, N / M) gamma_max, N what is asked and M what the parts would each move, which M far over N shows cancelling.
// Here N is what a path asks, M the fastest any of its bodies would go at its centre plus its arm, gamma_max is TURN, and in a
// substep a body's turn may rise by no more than gamma, nor its centre by more than gamma of its arm, which turns a row as a
// spin does. A rise, as a push that takes back a limit's kick slows its body and has nothing to cut. Only the pushing pass is
// cut, so speeds stay exact, and what is cut stays in the error for the next substep. They damp each singular direction
// apart; a path has no decomposition, so the whole push is cut, and the useful part of it waits too, which is the cost they
// name for a plain clamp. TURN is measured: at pi / 4, the paper's value, a taut chain reaches 39 m/s, and at 0.1 it starts
// to cut the chain of fifty. At 0.2 it cuts nothing in tests/joints.rs, a turn whose rows are out by 2 percent of their arm.
//
// A lock's position bias is capped too, at joint_max_push and what the turning carries its anchors. Pairs are found once a
// step, over the motion the step expects, so a body a push moved further than that would land past what should stop it, as in
// a_stretched_joint_does_not_jump_a_body_past_a_wall. A gap that wide takes more substeps to close, which on the proof
// scenes means 5 rows of 6,960 in the limb, and the figures do not move. It is Buss and Kim's ClampMag, and the turning term
// is their D_max,i = d_i + D_max: a cap under what the end moves anyway loses to it, as rows that turn open r (h w)^2 / 2 a
// substep, which r w h covers up to a turn of 2 radians.
//
// A limit stops and starts, so it is a row of its own, in two halves. Up to its edge it is rigid, and a gap still open lets
// the axis close it within this substep and no more, so it stops a swing dead and holds any load. Past its edge it pushes as
// a contact does, a spring and damper in implicit form (Catto 2011) with the contact's frequency, so a limit and a floor
// that cannot both hold come to rest instead of trading a rigid push for ever. Its stiffness is per unit of effective mass:
// a wrist pushes out as fast as a thigh. Being soft it remembers all it gives, as a contact does. Its row is the Schur
// complement of the joint's own locks: on the free body alone the locks would take most of each impulse back, the passes would
// not settle that in a substep, and what the warm start then remembered sent a rod off its stop at a quarter of its speed.
//
// A motor or spring is a force, so it is a soft row and is not relaxed: gamma = 1 / (h (c + h k)), bias = h k gamma C, and
//
//   impulse = -(Cdot + bias + gamma impulse_so_far) / (K + gamma)
//
// which is implicit Euler of the spring (Catto 2011), stable at any stiffness. In the acceleration model k and c are
// taken per unit of effective mass, so a motor moves a light limb and a heavy one alike.
//
// Measures follow Muller et al. 2020: a hinge's axes are kept aligned by a1 x a2 (their Eq 20), its angle read with a target
// or limit along that axis (Eq 21, Algorithm 3). That form holds near half a turn, where the vector part of a quaternion
// no longer tells rotations apart.
use crate::layout::*;
use crate::math::*;
use crate::solver::{Moving, Soft};
use crate::world::{NONE, World};

const AXES: [V3; 3] = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];
const TAU: f32 = 2.0 * PI;
/// Anchors closer than this have no line between them.
const COINCIDENT: f32 = 1e-6;
/// A swing's sine under this has no direction to read, and cos^2(swing / 2) under this leaves the twist undefined.
const NO_SWING: f32 = 1e-6;
const NO_TWIST: f32 = 1e-4;
/// A pivot under this part of its row's size is rounding: the rows are f32. Higham 1990's stop (4.3) with a tolerance of the
/// data's unit roundoff, on a matrix scaled to a unit diagonal, as linear and turning rows do not share a unit.
const DEPENDENT: f64 = f32::EPSILON as f64;
/// The most a push turns a body in one substep where nothing cancels, in radians: Buss and Kim 2005's gamma max. See the head
/// of this file for why it is not theirs.
const TURN: f32 = 0.2;

/// What a pass over the joints is for. See the head of this file.
#[derive(Clone, Copy, PartialEq)]
pub enum Pass {
    /// Velocity only, remembered.
    Settle,
    /// With the position bias, not remembered.
    Push,
    /// After the poses move: velocity only, remembered, motors left alone.
    Relax,
}

/// One constraint row: how speed along it reads from the two bodies, Cdot = d . (vB - vA) + tb . wB - ta . wA.
#[repr(C)]
#[derive(Clone, Copy)]
struct Row {
    d: V3,
    ta: V3,
    tb: V3,
}

impl Row {
    #[inline(always)]
    fn speed(&self, a: &Moving, b: &Moving) -> f32 {
        self.d.dot(b.linear.sub(a.linear)) + self.tb.dot(b.angular) - self.ta.dot(a.angular)
    }
    /// J M^-1 J^T between this row and `o`.
    #[inline(always)]
    fn give(&self, o: &Row, a: &Moving, b: &Moving) -> f32 {
        self.d.mul(o.d).dot(a.mass.add(b.mass)) + self.ta.dot(a.inertia.mul(o.ta)) + self.tb.dot(b.inertia.mul(o.tb))
    }
    /// `give` in doubles, for the factors: a row that depends on others shows only under the rounding of f32.
    #[inline]
    fn give_exactly(&self, o: &Row, a: &Moving, b: &Moving) -> f64 {
        scaled(self.d, o.d, a.mass) + scaled(self.d, o.d, b.mass) + a.inertia.between(self.ta, o.ta) + b.inertia.between(self.tb, o.tb)
    }
    #[inline(always)]
    fn push(&self, a: &mut Moving, b: &mut Moving, p: f32) {
        a.linear = a.linear.sub(a.mass.mul(self.d).scale(p));
        a.angular = a.angular.sub(a.inertia.mul(self.ta).scale(p));
        b.linear = b.linear.add(b.mass.mul(self.d).scale(p));
        b.angular = b.angular.add(b.inertia.mul(self.tb).scale(p));
    }
}

/// a . (m b) in doubles, for m a diagonal.
#[inline(always)]
fn scaled(a: V3, b: V3, m: V3) -> f64 {
    a.x as f64 * b.x as f64 * m.x as f64 + a.y as f64 * b.y as f64 * m.y as f64 + a.z as f64 * b.z as f64 * m.z as f64
}

/// A joint as it stands at the start of a substep, kept in its JOINT_SCRATCH rows.
#[repr(C)]
#[derive(Clone, Copy)]
struct View {
    rows: [Row; 6],
    /// What each axis measures.
    at: [f32; 6],
    /// How long the arm on each body is.
    arms: [f32; 2],
}

/// Doubles at the words of JOINT_SCRATCH after the view: a joint's inverse block, its link to the joint before, its right
/// side, then its impulses, and for each limit how its locks lean on it and what it moves with them holding. A joint that
/// leads its island's warm start adds what that is worth, what it is worth once applied, and the mass it was worked out on.
const LINK: usize = 36;
const RIGHT: usize = 72;
const LEAN: usize = 78;
const EASE: usize = 114;
const WORTH: usize = 120;

/// How many lock rows, and their axes.
#[inline]
fn lock_rows(flags: u32) -> (usize, [usize; 6]) {
    let (mut count, mut rows) = (0, [0; 6]);
    for k in 0..6 {
        if flags & (JOINT_LOCK << k) != 0 {
            rows[count] = k;
            count += 1;
        }
    }
    (count, rows)
}

/// The inverse of the leading `m` by `m` of a symmetric positive semi-definite matrix, by Gauss-Jordan on the row with the most
/// left of its `size`, the diagonal it started from: complete pivoting on the scaled matrix, which Higham 1990 proves stable for
/// a rank this small. A row with less than DEPENDENT of it left depends on the others, and carries no impulse.
fn invert(k: &mut [[f64; 6]; 6], m: usize, size: &[f64; 6]) -> [[f64; 6]; 6] {
    let mut inverse = [[0.0; 6]; 6];
    let mut taken = [false; 6];
    for p in 0..m {
        inverse[p][p] = 1.0;
    }
    for _ in 0..m {
        let (mut p, mut most) = (m, DEPENDENT);
        for r in 0..m {
            if !taken[r] && k[r][r] > most * size[r] {
                p = r;
                most = k[r][r] / size[r];
            }
        }
        if p == m {
            break;
        }
        taken[p] = true;
        let scale = 1.0 / k[p][p];
        for c in 0..m {
            k[p][c] *= scale;
            inverse[p][c] *= scale;
        }
        for r in 0..m {
            let factor = k[r][p];
            if r != p && factor != 0.0 {
                for c in 0..m {
                    k[r][c] -= factor * k[p][c];
                    inverse[r][c] -= factor * inverse[p][c];
                }
            }
        }
    }
    for p in 0..m {
        if !taken[p] {
            for c in 0..m {
                inverse[p][c] = 0.0;
                inverse[c][p] = 0.0;
            }
        }
    }
    inverse
}

impl World {
    /// True when a joint between these two bodies keeps them from colliding.
    pub fn joined(&self, a: usize, b: usize) -> bool {
        let mut joint = self.uu(FIRST_JOINT, a);
        while joint != NONE {
            let row = joint as usize;
            let on_a = self.uu(JOINT_A, row) as usize == a;
            let other = self.uu(if on_a { JOINT_B } else { JOINT_A }, row) as usize;
            if other == b && self.uu(JOINT_FLAGS, row) & JOINT_CONTACTS == 0 {
                return true;
            }
            joint = self.uu(if on_a { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
        }
        false
    }

    /// A new joint between two live bodies with these flags, or None when they are one body, one is gone, or memory is out.
    /// Its frames start as the identity and everything else as zero: the caller writes the columns it wants.
    pub fn add_joint(&mut self, a: u32, b: u32, flags: u32) -> Option<u32> {
        if a == b || !self.body_alive(a) || !self.body_alive(b) {
            return None;
        }
        let header = self.header();
        let (free, rows, capacity) = (header.free_joint, header.joint_rows, header.capacity[Rows::Joint as usize]);
        let row = if free != NONE {
            self.header_mut().free_joint = self.uu(JOINT_NEXT_A, free as usize);
            free
        } else {
            if rows == capacity && !self.grow_joints() {
                return None;
            }
            self.header_mut().joint_rows = rows + 1;
            rows
        };
        let at = row as usize;
        self.clear_row(Rows::Joint, at, COLUMNS);
        self.set_u(JOINT_A, at, a);
        self.set_u(JOINT_B, at, b);
        self.set_u(JOINT_FLAGS, at, flags | JOINT_ALIVE);
        self.set_s(JOINT_FRAME_A_W, at, 1.0);
        self.set_s(JOINT_FRAME_B_W, at, 1.0);
        self.set_u(JOINT_NEXT_A, at, self.uu(FIRST_JOINT, a as usize));
        self.set_u(FIRST_JOINT, a as usize, row);
        self.set_u(JOINT_NEXT_B, at, self.uu(FIRST_JOINT, b as usize));
        self.set_u(FIRST_JOINT, b as usize, row);
        self.wake(a);
        self.wake(b);
        Some(row)
    }

    pub fn grow_joints(&mut self) -> bool {
        let capacity = self.header().capacity;
        let rows = capacity[Rows::Joint as usize];
        if rows >= MAX_JOINTS {
            return false;
        }
        let more = if rows < 16 { 16 } else { rows * 2 };
        let mut next = capacity;
        next[Rows::Joint as usize] = more;
        next[Rows::JointList as usize] = more;
        next[Rows::JointScratch as usize] = more * JOINT_WORDS;
        self.grow(next)
    }

    /// Takes a joint out of one body's chain.
    fn unchain(&mut self, body: usize, joint: u32) {
        let next = |w: &World, row: usize, body: usize| if w.uu(JOINT_A, row) as usize == body { JOINT_NEXT_A } else { JOINT_NEXT_B };
        let after = self.uu(next(self, joint as usize, body), joint as usize);
        if self.uu(FIRST_JOINT, body) == joint {
            self.set_u(FIRST_JOINT, body, after);
            return;
        }
        let mut row = self.uu(FIRST_JOINT, body) as usize;
        loop {
            let column = next(self, row, body);
            let following = self.uu(column, row);
            if following == joint {
                self.set_u(column, row, after);
                return;
            }
            row = following as usize;
        }
    }

    /// Frees a joint, and wakes its bodies, as they may have hung from it. False when the row holds no joint.
    pub fn remove_joint(&mut self, joint: u32) -> bool {
        if joint >= self.header().joint_rows || self.uu(JOINT_FLAGS, joint as usize) & JOINT_ALIVE == 0 {
            return false;
        }
        let at = joint as usize;
        let (a, b) = (self.uu(JOINT_A, at), self.uu(JOINT_B, at));
        self.wake(a);
        self.wake(b);
        self.unchain(a as usize, joint);
        self.unchain(b as usize, joint);
        self.set_u(JOINT_FLAGS, at, 0);
        self.set_u(JOINT_NEXT_A, at, self.header().free_joint);
        self.header_mut().free_joint = joint;
        true
    }

    /// Frees every joint of a body that is leaving.
    pub fn remove_joints_of(&mut self, body: u32) {
        loop {
            let joint = self.uu(FIRST_JOINT, body as usize);
            if joint == NONE {
                return;
            }
            self.remove_joint(joint);
        }
    }

    /// Sets both frames so that frame X runs along `axis`, a direction in each body's own frame: the shortest arc from X
    /// (Dobrowolski 2015, Proposition 2: the spinor n(v + w) n(v) takes v to w). Here for `sqrt`.
    pub fn set_joint_axis(&mut self, joint: u32, axis: V3) {
        let size = sqrt(axis.dot(axis));
        let w = axis.scale(1.0 / size);
        let q = if w.x < -1.0 + 1e-6 {
            // Half a turn: about any line across X.
            Q { x: 0.0, y: 1.0, z: 0.0, w: 0.0 }
        } else {
            Q { x: 0.0, y: -w.z, z: w.y, w: 1.0 + w.x }.normalized()
        };
        self.set_q(JOINT_FRAME_A_X, joint as usize, q);
        self.set_q(JOINT_FRAME_B_X, joint as usize, q);
    }

    /// Wakes what a moving body is joined to.
    pub fn wake_across_joints(&mut self) {
        for row in 0..self.header().joint_rows as usize {
            if self.uu(JOINT_FLAGS, row) & (JOINT_ALIVE | JOINT_OFF) != JOINT_ALIVE {
                continue;
            }
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (sleeping_a, sleeping_b) = (self.flags(a) & SLEEPING != 0, self.flags(b) & SLEEPING != 0);
            if sleeping_a && !sleeping_b && self.disturbs(b) {
                self.wake(a as u32);
            } else if sleeping_b && !sleeping_a && self.disturbs(a) {
                self.wake(b as u32);
            }
        }
    }

    /// Joined bodies are one island; a moving scripted body keeps what it holds awake, as a touch does.
    pub fn unite_joints(&mut self) {
        for row in 0..self.header().joint_rows as usize {
            if self.uu(JOINT_FLAGS, row) & (JOINT_ALIVE | JOINT_OFF) != JOINT_ALIVE {
                continue;
            }
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (kind_a, kind_b) = (self.flags(a) & KIND, self.flags(b) & KIND);
            let awake = self.is_awake(a) && self.is_awake(b);
            if kind_a == DYNAMIC && kind_b == DYNAMIC && awake {
                self.unite(a as u32, b as u32);
            } else if kind_b == DYNAMIC && self.moving_kinematic(a) {
                self.set_s(SLEEP_TIME, b, 0.0);
            } else if kind_a == DYNAMIC && self.moving_kinematic(b) {
                self.set_s(SLEEP_TIME, a, 0.0);
            }
        }
    }

    /// True when a body that can move holds three locking joints or more, so no path runs through it.
    fn branches(&self, body: usize) -> bool {
        if !self.is_awake(body) || self.flags(body) & KIND != DYNAMIC {
            return false;
        }
        let (mut count, mut at) = (0, self.uu(FIRST_JOINT, body));
        while at != NONE {
            let row = at as usize;
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_LOCK * 63) != 0 && flags & JOINT_OFF == 0 {
                count += 1;
            }
            at = self.uu(if self.uu(JOINT_A, row) as usize == body { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
        }
        count > 2
    }

    /// The other locking joint on `body`, when it joins exactly two and can move; NONE otherwise.
    fn linked(&self, joint: u32, body: usize) -> u32 {
        if !self.is_awake(body) || self.flags(body) & KIND != DYNAMIC {
            return NONE;
        }
        let (mut other, mut count) = (NONE, 0);
        let mut at = self.uu(FIRST_JOINT, body);
        while at != NONE {
            let row = at as usize;
            if self.uu(JOINT_FLAGS, row) & (JOINT_LOCK * 63) != 0 {
                count += 1;
                if at != joint {
                    other = at;
                }
            }
            at = self.uu(if self.uu(JOINT_A, row) as usize == body { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
        }
        if count == 2 { other } else { NONE }
    }

    #[inline(always)]
    fn other_body(&self, joint: usize, body: usize) -> usize {
        let a = self.uu(JOINT_A, joint) as usize;
        if a == body { self.uu(JOINT_B, joint) as usize } else { a }
    }

    /// Lists a joint, after the one before if `via` joins them.
    fn list_joint(&mut self, joint: u32, via: u32, solving: &mut usize, stamp: u32) {
        self.set_u(SOLVE_JOINTS, *solving, joint);
        self.set_u(SOLVE_VIA, *solving, via);
        self.set_u(JOINT_SEEN, joint as usize, stamp);
        *solving += 1;
    }

    /// Follows a path of locking joints from `first`, leaving by `going`. A ring stops short of its first joint: a path's
    /// joints touch only their neighbours, so its matrix is block tridiagonal.
    fn walk_path(&mut self, first: u32, mut going: usize, solving: &mut usize, stamp: u32) {
        let start = self.other_body(first as usize, going);
        let from = *solving;
        self.list_joint(first, NONE, solving, stamp);
        let mut at = first;
        let mut exact = !self.branches(start);
        loop {
            let next = self.linked(at, going);
            if next == NONE {
                exact = exact && !self.branches(going);
                break;
            }
            if self.uu(JOINT_SEEN, next as usize) == stamp {
                exact = false;
                break;
            }
            let far = self.other_body(next as usize, going);
            if far == start {
                self.list_joint(next, NONE, solving, stamp);
                exact = false;
                break;
            }
            self.list_joint(next, going as u32, solving, stamp);
            going = far;
            at = next;
        }
        // Only a path that nothing else leans on is solved exactly. Elsewhere a full push fights its neighbours' pushes.
        let share = if exact { self.header().joint_share } else { self.header().joint_loose_share };
        for i in from..*solving {
            self.set_s(SOLVE_SHARE, i, share);
        }
    }

    /// Once a step: lists the joints with a body awake, in paths, and gives their impulses the length of this substep.
    pub fn prepare_joints(&mut self) {
        let ratio = self.header().substep_ratio;
        let stamp = self.header().steps + 1;
        let rows = self.header().joint_rows as usize;
        let live = |w: &World, row: usize| {
            w.uu(JOINT_FLAGS, row) & (JOINT_ALIVE | JOINT_OFF) == JOINT_ALIVE && (w.is_awake(w.uu(JOINT_A, row) as usize) || w.is_awake(w.uu(JOINT_B, row) as usize))
        };
        for row in 0..rows {
            if !live(self, row) {
                continue;
            }
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            for body in [a, b] {
                if !self.is_awake(body) {
                    self.solver_mass(body);
                }
            }
            if ratio != 1.0 {
                for k in 0..6 {
                    self.set_s(JOINT_IMPULSE_0 + k, row, self.s(JOINT_IMPULSE_0 + k, row) * ratio);
                    self.set_s(JOINT_MOTOR_0 + k, row, self.s(JOINT_MOTOR_0 + k, row) * ratio);
                }
            }
        }
        let mut solving = 0;
        // Paths with an end first, then rings, then joints with nothing locked.
        for row in 0..rows {
            if live(self, row) && self.uu(JOINT_SEEN, row) != stamp && self.uu(JOINT_FLAGS, row) & (JOINT_LOCK * 63) != 0 {
                let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
                if self.linked(row as u32, a) == NONE {
                    self.walk_path(row as u32, b, &mut solving, stamp);
                } else if self.linked(row as u32, b) == NONE {
                    self.walk_path(row as u32, a, &mut solving, stamp);
                }
            }
        }
        for row in 0..rows {
            if live(self, row) && self.uu(JOINT_SEEN, row) != stamp {
                if self.uu(JOINT_FLAGS, row) & (JOINT_LOCK * 63) != 0 {
                    self.walk_path(row as u32, self.uu(JOINT_B, row) as usize, &mut solving, stamp);
                } else {
                    self.set_s(SOLVE_SHARE, solving, self.header().joint_loose_share);
                    self.list_joint(row as u32, NONE, &mut solving, stamp);
                }
            }
        }
        self.header_mut().joint_solving = solving as u32;
        // The first joint listed on each island keeps its sums for the warm start.
        let moves = |w: &World, body: usize| w.flags(body) & KIND == DYNAMIC && w.is_awake(body);
        for i in 0..solving {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            for body in [self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize] {
                if moves(self, body) {
                    self.set_u(ISLAND_LEAD, self.uu(ISLAND_ID, body) as usize, NONE);
                }
            }
        }
        for i in 0..solving {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let body = if moves(self, a) { a } else { b };
            let mut lead = NONE;
            if moves(self, body) {
                let island = self.uu(ISLAND_ID, body) as usize;
                lead = self.uu(ISLAND_LEAD, island);
                if lead == NONE {
                    lead = row as u32;
                    self.set_u(ISLAND_LEAD, island, lead);
                }
            }
            self.set_u(SOLVE_LEAD, i, lead);
        }
    }

    #[inline(always)]
    fn view(&self, row: usize) -> View {
        unsafe { *(self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize) as *const View) }
    }
    /// The doubles of a joint's scratch.
    #[inline(always)]
    fn doubles(&self, row: usize) -> *mut f64 {
        unsafe { self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize + 64) as *mut f64 }
    }

    /// The rows and measures of a joint from where its bodies are now.
    fn joint_view(&mut self, row: usize) -> View {
        let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
        let flags = self.uu(JOINT_FLAGS, row);
        let (rotation_a, rotation_b) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
        let arm_a = rotation_a.rotate(self.v(JOINT_ANCHOR_A_X, row).sub(self.v(LOCAL_CENTER_X, a)));
        let arm_b = rotation_b.rotate(self.v(JOINT_ANCHOR_B_X, row).sub(self.v(LOCAL_CENTER_X, b)));
        let gap = self.v(CENTER_X, b).add(arm_b).sub(self.v(CENTER_X, a).add(arm_a));
        let (frame_a, frame_b) = (rotation_a.mul(self.q(JOINT_FRAME_A_X, row)), rotation_b.mul(self.q(JOINT_FRAME_B_X, row)));
        let axes = [frame_a.rotate(AXES[0]), frame_a.rotate(AXES[1]), frame_a.rotate(AXES[2])];

        // Along an axis the arm on A runs to the anchor on B, so an axis that turns with A is measured right (a prismatic).
        let reach = arm_a.add(gap);
        let mut rows = [Row { d: AXES[0], ta: AXES[0], tb: AXES[0] }; 6];
        let mut at = [0.0; 6];
        for k in 0..3 {
            rows[k] = Row { d: axes[k], ta: reach.cross(axes[k]), tb: arm_b.cross(axes[k]) };
            at[k] = axes[k].dot(gap);
            rows[3 + k] = Row { d: v3(0.0, 0.0, 0.0), ta: axes[k], tb: axes[k] };
        }
        if flags & JOINT_DISTANCE != 0 {
            let size = sqrt(gap.dot(gap));
            let line = if size > COINCIDENT { gap.scale(1.0 / size) } else { axes[0] };
            rows[0] = Row { d: line, ta: arm_a.cross(line), tb: arm_b.cross(line) };
            at[0] = size;
        }

        // Rotation of frame B in frame A, the short way round.
        let mut q = frame_a.conjugate().mul(frame_b);
        if q.w < 0.0 {
            q = Q { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
        }
        let locked = flags / (JOINT_LOCK << 3) & 7;
        let free = 3 - (locked & 1) - (locked >> 1 & 1) - (locked >> 2 & 1);
        if free == 0 {
            at[3] = 2.0 * q.x;
            at[4] = 2.0 * q.y;
            at[5] = 2.0 * q.z;
        } else if free == 1 {
            let k = if locked & 1 == 0 {
                0
            } else if locked & 2 == 0 {
                1
            } else {
                2
            };
            let off = axes[k].cross(frame_b.rotate(AXES[k]));
            for i in 0..3 {
                at[3 + i] = off.dot(axes[i]);
            }
            let raw = 2.0 * atan2([q.x, q.y, q.z][k], q.w);
            // The whole turns to the angle it last read, so a hinge can count past one.
            let turns = (self.s(JOINT_ANGLE, row) - raw) * (1.0 / TAU);
            let turns = (if turns < 0.0 { turns - 0.5 } else { turns + 0.5 }) as i32 as f32;
            let angle = raw + turns * TAU;
            self.set_s(JOINT_ANGLE, row, angle);
            at[3 + k] = angle;
        } else {
            let turn = q.to_rotation_vector();
            at[3] = turn.x;
            at[4] = turn.y;
            at[5] = turn.z;
        }
        if flags & JOINT_CONE != 0 {
            self.cone_rows(row, axes, frame_a, frame_b, q, &mut rows, &mut at);
        }
        View { rows, at, arms: [sqrt(arm_a.dot(arm_a)), sqrt(arm_b.dot(arm_b))] }
    }

    /// A cone's two rows. Frame B's turn in frame A splits into a twist about X and a swing that takes X to where frame B's X
    /// points (Dobrowolski 2015), so q = swing twist and the twist's angle is 2 atan2(q.x, q.w). Twist's rate is the relative
    /// spin along the bisector over cos(swing / 2), as d theta = (a1 + a2) . w / (2 (x^2 + w^2)). The swing stays inside an
    /// ellipse of its rotation vector, (r_y / limit_y)^2 + (r_z / limit_z)^2 <= 1: its row runs along the gradient, and what
    /// it measures is the first-order distance past the edge, negative inside. The limit in rows does the rest.
    #[allow(clippy::too_many_arguments)]
    fn cone_rows(&self, row: usize, axes: [V3; 3], frame_a: Q, frame_b: Q, q: Q, rows: &mut [Row; 6], at: &mut [f32; 6]) {
        let (a1, a2) = (axes[0], frame_b.rotate(AXES[0]));
        let bisector = a1.add(a2).scale(1.0 / (2.0 * (q.x * q.x + q.w * q.w).max(NO_TWIST)));
        rows[3] = Row { d: v3(0.0, 0.0, 0.0), ta: bisector, tb: bisector };
        at[3] = 2.0 * atan2(q.x, q.w);
        let across = frame_a.unrotate(a2);
        let sine = sqrt(across.y * across.y + across.z * across.z);
        if sine < NO_SWING && across.x > 0.0 {
            // Dead centre: inside any limit, along any line.
            at[4] = -1.0;
            return;
        }
        let swing = atan2(sine, across.x);
        // Straight back the line is lost too: any line across will do, and the row turns the axis out of it.
        let (y, z) = if sine < NO_SWING { (0.0, swing) } else { (-across.z * swing / sine, across.y * swing / sine) };
        let (limit_y, limit_z) = (self.s(JOINT_MIN_5, row), self.s(JOINT_MAX_5, row));
        let (over_y, over_z) = (y / (limit_y * limit_y), z / (limit_z * limit_z));
        let size = sqrt(over_y * over_y + over_z * over_z);
        let (line_y, line_z) = (over_y / size, over_z / size);
        let line = axes[1].scale(line_y).add(axes[2].scale(line_z));
        rows[4] = Row { d: v3(0.0, 0.0, 0.0), ta: line, tb: line };
        at[4] = (y * over_y + z * over_z - 1.0) / (2.0 * size);
    }

    /// Each substep, before the solve: every joint's rows from the bodies' poses, and the factors of each path: block
    /// Cholesky of its block tridiagonal matrix J M^-1 J^T, which solves the locks of a chain exactly in one sweep. Gauss-Seidel
    /// moves a load only one joint a pass, so a light chain under a heavy end would stretch for seconds before it held.
    pub fn refresh_joints(&mut self) {
        for i in 0..self.header().joint_solving as usize {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.joint_view(row);
            unsafe { *(self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize) as *mut View) = view };
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (body_a, body_b) = (self.moving(a), self.moving(b));
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let mut k = [[0.0f64; 6]; 6];
            for r in 0..m {
                for s in 0..m {
                    k[r][s] = view.rows[axes[r]].give_exactly(&view.rows[axes[s]], &body_a, &body_b);
                }
            }
            let mut size = [0.0f64; 6];
            for r in 0..m {
                size[r] = k[r][r];
            }
            let via = self.uu(SOLVE_VIA, i);
            let doubles = self.doubles(row);
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_LIMIT * 63) != 0 {
                // What each limit moves with the joint's own locks holding: the Schur complement of its locks in the block.
                let own = invert(&mut k.clone(), m, &size);
                for q in 0..6 {
                    if flags & (JOINT_LIMIT << q) == 0 {
                        continue;
                    }
                    let mut across = [0.0f64; 6];
                    for r in 0..m {
                        across[r] = view.rows[axes[r]].give_exactly(&view.rows[q], &body_a, &body_b);
                    }
                    let mut ease = view.rows[q].give_exactly(&view.rows[q], &body_a, &body_b);
                    for r in 0..m {
                        let mut lean = 0.0;
                        for s in 0..m {
                            lean += own[r][s] * across[s];
                        }
                        unsafe { *doubles.add(LEAN + q * 6 + r) = lean };
                        ease -= lean * across[r];
                    }
                    unsafe { *doubles.add(EASE + q) = ease };
                }
            }
            if via != NONE {
                let before = self.uu(SOLVE_JOINTS, i - 1) as usize;
                let (n, axes_before) = lock_rows(self.uu(JOINT_FLAGS, before));
                let view_before = self.view(before);
                let body = self.moving(via as usize);
                // Each joint's row as it reads on the body they share.
                let side = |w: &World, joint: usize, row: &Row| {
                    if w.uu(JOINT_B, joint) == via { (row.d, row.tb) } else { (row.d.scale(-1.0), row.ta.scale(-1.0)) }
                };
                let mut link = [[0.0f64; 6]; 6];
                for r in 0..n {
                    let (linear, turn) = side(self, before, &view_before.rows[axes_before[r]]);
                    for s in 0..m {
                        let (other, other_turn) = side(self, row, &view.rows[axes[s]]);
                        link[r][s] = scaled(linear, other, body.mass) + body.inertia.between(turn, other_turn);
                    }
                }
                // L = B^T D^-1 of the joint before, and K -= L B.
                let inverse = self.doubles(before);
                for s in 0..m {
                    for r in 0..n {
                        let mut sum = 0.0;
                        for c in 0..n {
                            sum += link[c][s] * unsafe { *inverse.add(r * 6 + c) };
                        }
                        unsafe { *doubles.add(LINK + s * 6 + r) = sum };
                    }
                }
                for s in 0..m {
                    for t in 0..m {
                        let mut sum = 0.0;
                        for r in 0..n {
                            sum += unsafe { *doubles.add(LINK + s * 6 + r) } * link[r][t];
                        }
                        k[s][t] -= sum;
                    }
                }
            }
            let inverse = invert(&mut k, m, &size);
            for r in 0..m {
                for s in 0..m {
                    unsafe { *doubles.add(r * 6 + s) = inverse[r][s] };
                }
            }
        }
    }

    /// Each substep: the impulses the joints carry, before anything is solved. Motors first: they are forces, and what the
    /// rest is worth is judged with them applied. See the head of this file.
    pub fn warm_start_joints(&mut self) {
        let solving = self.header().joint_solving as usize;
        self.carry(JOINT_MOTOR_0);
        for i in 0..solving {
            let lead = self.uu(SOLVE_LEAD, i);
            if lead != NONE {
                let worth = self.doubles(lead as usize);
                unsafe {
                    *worth.add(WORTH) = 0.0;
                    *worth.add(WORTH + 1) = 0.0;
                    *worth.add(WORTH + 2) = 0.0;
                }
            }
        }
        self.tally_memory(WORTH);
        self.carry(JOINT_IMPULSE_0);
        self.tally_memory(WORTH + 1);
        let most = self.header().joint_max_push as f64;
        for i in 0..solving {
            let lead = self.uu(SOLVE_LEAD, i);
            if lead == NONE {
                continue;
            }
            let worth = self.doubles(lead as usize);
            // f(a) = before a + (after - before) a^2 / 2, as what the memory did to its own rows is p^T K p.
            let (before, after, mass) = unsafe { (*worth.add(WORTH), *worth.add(WORTH + 1), *worth.add(WORTH + 2)) };
            let curve = after - before;
            if !(before + 0.5 * curve > 0.5 * mass * most * most) {
                continue;
            }
            let keep = if before < 0.0 { (-before / curve) as f32 } else { 0.0 };
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            for k in 0..6 {
                let carried = self.s(JOINT_IMPULSE_0 + k, row);
                if carried != 0.0 {
                    view.rows[k].push(&mut body_a, &mut body_b, (keep - 1.0) * carried);
                    self.set_s(JOINT_IMPULSE_0 + k, row, carried * keep);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// Adds to each island's sum at `slot` what its memory reads against the bodies' speeds now.
    fn tally_memory(&mut self, slot: usize) {
        for i in 0..self.header().joint_solving as usize {
            let lead = self.uu(SOLVE_LEAD, i);
            if lead == NONE {
                continue;
            }
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (body_a, body_b) = (self.moving(a), self.moving(b));
            let mut sum = 0.0f64;
            for k in 0..6 {
                let carried = self.s(JOINT_IMPULSE_0 + k, row);
                if carried != 0.0 {
                    sum += carried as f64 * view.rows[k].speed(&body_a, &body_b) as f64;
                }
            }
            let worth = self.doubles(lead as usize);
            unsafe { *worth.add(slot) += sum };
            if slot == WORTH {
                for body in [a, b] {
                    let inverse = self.s(INVERSE_MASS, body);
                    if self.flags(body) & KIND == DYNAMIC && inverse > 0.0 {
                        unsafe { *worth.add(WORTH + 2) += 1.0 / inverse as f64 };
                    }
                }
            }
        }
    }

    /// Applies the impulses in six columns from `column`.
    fn carry(&mut self, column: usize) {
        for i in 0..self.header().joint_solving as usize {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            for k in 0..6 {
                let impulse = self.s(column + k, row);
                if impulse != 0.0 {
                    view.rows[k].push(&mut body_a, &mut body_b, impulse);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// One pass over the joints.
    /// A path joins only when its island asks for at least `least` extra passes and fewer than `below` (see `step`).
    pub fn solve_joints(&mut self, h: f32, stiffness: Soft, pass: Pass, least: u32, below: u32) {
        let most = self.header().joint_max_push;
        let solving = self.header().joint_solving as usize;
        let mut first = 0;
        while first < solving {
            let mut last = first;
            while last + 1 < solving && self.uu(SOLVE_VIA, last + 1) != NONE {
                last += 1;
            }
            if least > 0 || below != u32::MAX {
                // A path's joints are one island's: joints join the islands of their bodies.
                let row = self.uu(SOLVE_JOINTS, first) as usize;
                let extra = self.extra_of(self.uu(JOINT_A, row) as usize).max(self.extra_of(self.uu(JOINT_B, row) as usize));
                if extra < least || extra >= below {
                    first = last + 1;
                    continue;
                }
            }
            let rate = self.s(SOLVE_SHARE, first) / h;
            for i in first..=last {
                let row = self.uu(SOLVE_JOINTS, i) as usize;
                let flags = self.uu(JOINT_FLAGS, row);
                if flags & (JOINT_LIMIT * 63 | JOINT_MOTOR_ON * 63) != 0 {
                    self.soft_rows(row, flags, h, stiffness, most, pass);
                }
            }
            self.solve_path(first, last, rate, most, h, pass);
            first = last + 1;
        }
    }

    /// A joint's motors and limits, one row at a time: they stop and start, which a factored path cannot.
    fn soft_rows(&mut self, row: usize, flags: u32, h: f32, stiffness: Soft, most: f32, pass: Pass) {
        let view = self.view(row);
        let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
        let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
        if pass != Pass::Relax {
            for k in 0..6 {
                if flags & (JOINT_MOTOR_ON << k) != 0 {
                    self.motor_row(row, k, flags & (JOINT_MOTOR_FORCE << k) != 0, &view.rows[k], view.at[k], h, &mut body_a, &mut body_b);
                }
            }
        }
        for k in 0..6 {
            if flags & (JOINT_LIMIT << k) != 0 {
                self.limit_row(row, k, &view, h, stiffness, most, pass, &mut body_a, &mut body_b);
            }
        }
        self.settle(a, &body_a);
        self.settle(b, &body_b);
    }

    /// Solves the locks of the path from list place `first` to `last` exactly: forward, then back, then the impulses.
    fn solve_path(&mut self, first: usize, last: usize, rate: f32, most: f32, h: f32, pass: Pass) {
        let mut asked = 0.0f32;
        for i in first..=last {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            let (body_a, body_b) = (self.moving(self.uu(JOINT_A, row) as usize), self.moving(self.uu(JOINT_B, row) as usize));
            let doubles = self.doubles(row);
            let before = if i > first { self.doubles(self.uu(SOLVE_JOINTS, i - 1) as usize) } else { doubles };
            let n = if i > first { lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, i - 1) as usize)).0 } else { 0 };
            // The arms and not the gap, or a wide gap would raise its own cap. See the head of this file.
            let most = most + view.arms[0] * sqrt(body_a.angular.dot(body_a.angular)) + view.arms[1] * sqrt(body_b.angular.dot(body_b.angular));
            let lever = view.arms[0] + view.arms[1];
            let mut largest = 0.0f32;
            for r in 0..m {
                let k = axes[r];
                let bias = if pass == Pass::Push { rate * view.at[k] } else { 0.0 };
                let bias = if bias > most {
                    most
                } else if bias < -most {
                    -most
                } else {
                    bias
                };
                let ask = view.rows[k].speed(&body_a, &body_b) + bias;
                let size = if ask < 0.0 { -ask } else { ask };
                let size = if k < 3 { size } else { size * lever };
                if size > largest {
                    largest = size;
                }
                let mut right = -ask as f64;
                for c in 0..n {
                    right -= unsafe { *doubles.add(LINK + r * 6 + c) * *before.add(RIGHT + c) };
                }
                unsafe { *doubles.add(RIGHT + r) = right };
            }
            asked += largest;
        }
        let mut next = [0.0f64; 6];
        for i in (first..=last).rev() {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let m = lock_rows(self.uu(JOINT_FLAGS, row)).0;
            let doubles = self.doubles(row);
            let mut x = [0.0f64; 6];
            for r in 0..m {
                let mut sum = 0.0;
                for c in 0..m {
                    sum += unsafe { *doubles.add(r * 6 + c) * *doubles.add(RIGHT + c) };
                }
                if i < last {
                    let after = self.uu(SOLVE_JOINTS, i + 1) as usize;
                    let (p, _) = lock_rows(self.uu(JOINT_FLAGS, after));
                    let link = self.doubles(after);
                    for c in 0..p {
                        sum -= unsafe { *link.add(LINK + c * 6 + r) } * next[c];
                    }
                }
                x[r] = sum;
            }
            for r in 0..m {
                unsafe { *doubles.add(RIGHT + r) = x[r] };
            }
            next = x;
        }
        let share = if pass == Pass::Push { self.push_share(first, last, asked, h) } else { 1.0 };
        for i in (first..=last).rev() {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            let doubles = self.doubles(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            for r in 0..m {
                let k = axes[r];
                let p = unsafe { *doubles.add(RIGHT + r) } as f32 * share;
                view.rows[k].push(&mut body_a, &mut body_b, p);
                if pass != Pass::Push {
                    self.set_s(JOINT_IMPULSE_0 + k, row, self.s(JOINT_IMPULSE_0 + k, row) + p);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// What a joint's impulses, kept in RIGHT, would add to each of its bodies, with the arm on each.
    fn gains(&self, row: usize) -> [(V3, V3, f32); 2] {
        let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
        let view = self.view(row);
        let doubles = self.doubles(row);
        let (mut body_a, mut body_b) = (self.moving(self.uu(JOINT_A, row) as usize), self.moving(self.uu(JOINT_B, row) as usize));
        let still = v3(0.0, 0.0, 0.0);
        (body_a.linear, body_a.angular, body_b.linear, body_b.angular) = (still, still, still, still);
        for r in 0..m {
            view.rows[axes[r]].push(&mut body_a, &mut body_b, unsafe { *doubles.add(RIGHT + r) } as f32);
        }
        [(body_a.linear, body_a.angular, view.arms[0]), (body_b.linear, body_b.angular, view.arms[1])]
    }

    /// How much of a path's push to take. See the head of this file. A body between two joints gains from both.
    fn push_share(&self, first: usize, last: usize, asked: f32, h: f32) -> f32 {
        let (mut top, mut turn) = (0.0f32, 0.0f32);
        let mut carried = (v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), 0.0f32);
        for i in first..=last {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let gains = self.gains(row);
            let from = if i > first { self.uu(SOLVE_VIA, i) } else { NONE };
            let onward = if i < last { self.uu(SOLVE_VIA, i + 1) } else { NONE };
            for (gain, body) in gains.iter().zip([self.uu(JOINT_A, row), self.uu(JOINT_B, row)]) {
                if body == onward {
                    carried = *gain;
                } else {
                    let whole = if body == from { (gain.0.add(carried.0), gain.1.add(carried.1), gain.2.max(carried.2)) } else { *gain };
                    let spin = sqrt(whole.1.dot(whole.1));
                    top = top.max(sqrt(whole.0.dot(whole.0)) + whole.2 * spin);
                    let now = self.v(ANGULAR_X, body as usize);
                    let then = now.add(whole.1);
                    turn = turn.max(sqrt(then.dot(then)) - sqrt(now.dot(now)));
                    if whole.2 > 0.0 {
                        let now = self.v(LINEAR_X, body as usize);
                        let then = now.add(whole.0);
                        turn = turn.max((sqrt(then.dot(then)) - sqrt(now.dot(now))) / whole.2);
                    }
                }
            }
        }
        let room = if top > asked { TURN * asked / top } else { TURN };
        if h * turn > room { room / (h * turn) } else { 1.0 }
    }

    /// A motor on one axis: a soft row toward its target and target speed, capped at its most force over this substep.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn motor_row(&mut self, row: usize, k: usize, force: bool, axis: &Row, at: f32, h: f32, a: &mut Moving, b: &mut Moving) {
        let give = axis.give(axis, a, b);
        if !(give > 0.0) {
            return;
        }
        let scale = if force { 1.0 } else { 1.0 / give };
        let (stiffness, damping) = (self.s(JOINT_STIFFNESS_0 + k, row) * scale, self.s(JOINT_DAMPING_0 + k, row) * scale);
        let softness = h * (damping + h * stiffness);
        if !(softness > 0.0) {
            return;
        }
        let gamma = 1.0 / softness;
        let bias = (at - self.s(JOINT_TARGET_0 + k, row)) * h * stiffness * gamma;
        let held = self.s(JOINT_MOTOR_0 + k, row);
        let speed = axis.speed(a, b) - self.s(JOINT_SPEED_0 + k, row);
        let total = held - (speed + bias + gamma * held) / (give + gamma);
        let cap = h * self.s(JOINT_CAP_0 + k, row);
        let total = if total > cap {
            cap
        } else if total < -cap {
            -cap
        } else {
            total
        };
        axis.push(a, b, total - held);
        self.set_s(JOINT_MOTOR_0 + k, row, total);
    }

    /// A limit on one axis, against its nearer end: a one-way row, rigid up to its edge and soft past it. It reads the speed
    /// its joint's locks leave it and moves what they let it move, and the path solve that follows adds their share.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn limit_row(&mut self, row: usize, k: usize, view: &View, h: f32, stiffness: Soft, most: f32, pass: Pass, a: &mut Moving, b: &mut Moving) {
        let (axis, at) = (&view.rows[k], view.at[k]);
        let doubles = self.doubles(row);
        let give = unsafe { *doubles.add(EASE + k) } as f32;
        if !(give > 0.0) {
            return;
        }
        let (low, high) = (self.s(JOINT_MIN_0 + k, row), self.s(JOINT_MAX_0 + k, row));
        // +1 pushes up from the lower end, -1 down from the upper one.
        let (side, gap) = if at - low < high - at { (1.0, at - low) } else { (-1.0, high - at) };
        let carried = self.s(JOINT_IMPULSE_0 + k, row) * side;
        let pressed = if carried > 0.0 { carried } else { 0.0 };
        let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
        let mut along = axis.speed(a, b) as f64;
        for r in 0..m {
            along -= unsafe { *doubles.add(LEAN + k * 6 + r) } * view.rows[axes[r]].speed(a, b) as f64;
        }
        let speed = along as f32 * side;
        let (bias, mass_scale, impulse_scale) = if gap > 0.0 {
            (gap / h, 1.0, 0.0)
        } else if pass == Pass::Push {
            let push = stiffness.bias_rate * gap;
            (if push > -most { push } else { -most }, stiffness.mass_scale, stiffness.impulse_scale)
        } else {
            (0.0, 1.0, 0.0)
        };
        let total = pressed - mass_scale * (speed + bias) / give - impulse_scale * pressed;
        let total = if total > 0.0 { total } else { 0.0 };
        // A relaxing pass only takes back, as for a contact.
        let total = if pass == Pass::Relax && gap > 0.0 && total > pressed { pressed } else { total };
        axis.push(a, b, (total - carried) * side);
        self.set_s(JOINT_IMPULSE_0 + k, row, total * side);
    }
}
