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
use crate::solver::Moving;
use crate::world::{NONE, World};

const AXES: [V3; 3] = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];
const TAU: f32 = 2.0 * PI;
/// Anchors closer than this have no line between them.
const COINCIDENT: f32 = 1e-6;

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
    #[inline(always)]
    fn push(&self, a: &mut Moving, b: &mut Moving, p: f32) {
        a.linear = a.linear.sub(a.mass.mul(self.d).scale(p));
        a.angular = a.angular.sub(a.inertia.mul(self.ta).scale(p));
        b.linear = b.linear.add(b.mass.mul(self.d).scale(p));
        b.angular = b.angular.add(b.inertia.mul(self.tb).scale(p));
    }
}

/// A joint as it stands at the start of a substep, kept in its JOINT_SCRATCH rows.
#[repr(C)]
#[derive(Clone, Copy)]
struct View {
    rows: [Row; 6],
    /// What each axis measures.
    at: [f32; 6],
}

/// Doubles at the words of JOINT_SCRATCH after the view: a joint's inverse block, its link to the joint before, its right
/// side, and what the pushing pass gave each limit.
const LINK: usize = 36;
const RIGHT: usize = 72;
const PUSHED: usize = 78;

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

/// The inverse of the leading `m` by `m` of a symmetric matrix, by Gauss-Jordan without pivoting, as a sum of positive
/// semi-definite terms has none to find. A row that depends on the others carries no impulse.
fn invert(k: &mut [[f64; 6]; 6], m: usize) -> [[f64; 6]; 6] {
    let mut inverse = [[0.0; 6]; 6];
    let mut size = [0.0; 6];
    for p in 0..m {
        inverse[p][p] = 1.0;
        size[p] = k[p][p];
    }
    let mut dropped = [false; 6];
    for p in 0..m {
        let pivot = k[p][p];
        if !(pivot > size[p] * 1e-12) {
            dropped[p] = true;
            continue;
        }
        let scale = 1.0 / pivot;
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
        if dropped[p] {
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
            if self.uu(JOINT_FLAGS, row) & JOINT_ALIVE == 0 {
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
            if self.uu(JOINT_FLAGS, row) & JOINT_ALIVE == 0 {
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
            if self.uu(JOINT_FLAGS, row) & (JOINT_LOCK * 63) != 0 {
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
            w.uu(JOINT_FLAGS, row) & JOINT_ALIVE != 0 && (w.is_awake(w.uu(JOINT_A, row) as usize) || w.is_awake(w.uu(JOINT_B, row) as usize))
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
        View { rows, at }
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
                    k[r][s] = view.rows[axes[r]].give(&view.rows[axes[s]], &body_a, &body_b) as f64;
                }
            }
            let via = self.uu(SOLVE_VIA, i);
            let doubles = self.doubles(row);
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
                        link[r][s] = (linear.mul(other).dot(body.mass) + turn.dot(body.inertia.mul(other_turn))) as f64;
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
            let inverse = invert(&mut k, m);
            for r in 0..m {
                for s in 0..m {
                    unsafe { *doubles.add(r * 6 + s) = inverse[r][s] };
                }
            }
        }
    }

    /// Each substep: the impulses the joints carry, before anything is solved.
    pub fn warm_start_joints(&mut self) {
        for i in 0..self.header().joint_solving as usize {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            for k in 0..6 {
                let impulse = self.s(JOINT_IMPULSE_0 + k, row) + self.s(JOINT_MOTOR_0 + k, row);
                if impulse != 0.0 {
                    view.rows[k].push(&mut body_a, &mut body_b, impulse);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// One pass over the joints.
    pub fn solve_joints(&mut self, h: f32, pass: Pass) {
        let most = self.header().joint_max_push;
        let solving = self.header().joint_solving as usize;
        let mut first = 0;
        while first < solving {
            let mut last = first;
            while last + 1 < solving && self.uu(SOLVE_VIA, last + 1) != NONE {
                last += 1;
            }
            let rate = self.s(SOLVE_SHARE, first) / h;
            for i in first..=last {
                let row = self.uu(SOLVE_JOINTS, i) as usize;
                let flags = self.uu(JOINT_FLAGS, row);
                if flags & (JOINT_LIMIT * 63 | JOINT_MOTOR_ON * 63) != 0 {
                    self.soft_rows(row, flags, h, rate, most, pass);
                }
            }
            self.solve_path(first, last, rate, most, pass);
            first = last + 1;
        }
    }

    /// A joint's motors and limits, one row at a time: they stop and start, which a factored path cannot.
    fn soft_rows(&mut self, row: usize, flags: u32, h: f32, rate: f32, most: f32, pass: Pass) {
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
                self.limit_row(row, k, &view.rows[k], view.at[k], h, rate, most, pass, &mut body_a, &mut body_b);
            }
        }
        self.settle(a, &body_a);
        self.settle(b, &body_b);
    }

    /// Solves the locks of the path from list place `first` to `last` exactly: forward, then back, then the impulses.
    fn solve_path(&mut self, first: usize, last: usize, rate: f32, most: f32, pass: Pass) {
        for i in first..=last {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            let (body_a, body_b) = (self.moving(self.uu(JOINT_A, row) as usize), self.moving(self.uu(JOINT_B, row) as usize));
            let doubles = self.doubles(row);
            let before = if i > first { self.doubles(self.uu(SOLVE_JOINTS, i - 1) as usize) } else { doubles };
            let n = if i > first { lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, i - 1) as usize)).0 } else { 0 };
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
                let mut right = -(view.rows[k].speed(&body_a, &body_b) + bias) as f64;
                for c in 0..n {
                    right -= unsafe { *doubles.add(LINK + r * 6 + c) * *before.add(RIGHT + c) };
                }
                unsafe { *doubles.add(RIGHT + r) = right };
            }
        }
        let mut next = [0.0f64; 6];
        for i in (first..=last).rev() {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            let doubles = self.doubles(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
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
                let k = axes[r];
                let p = x[r] as f32;
                view.rows[k].push(&mut body_a, &mut body_b, p);
                if pass != Pass::Push {
                    self.set_s(JOINT_IMPULSE_0 + k, row, self.s(JOINT_IMPULSE_0 + k, row) + p);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
            next = x;
        }
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

    /// A limit on one axis, against its nearer end: a one-way rigid row. A gap still open lets the axis close it within
    /// this substep and no more, as a speculative contact does. What the row has given this substep is what it remembers
    /// plus what the pushing pass gave, so the relaxing pass can take a push back though nothing remembers it.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn limit_row(&mut self, row: usize, k: usize, axis: &Row, at: f32, h: f32, rate: f32, most: f32, pass: Pass, a: &mut Moving, b: &mut Moving) {
        let give = axis.give(axis, a, b);
        if !(give > 0.0) {
            return;
        }
        let (low, high) = (self.s(JOINT_MIN_0 + k, row), self.s(JOINT_MAX_0 + k, row));
        // +1 pushes up from the lower end, -1 down from the upper one.
        let (side, gap) = if at - low < high - at { (1.0, at - low) } else { (-1.0, high - at) };
        let pushed = if pass == Pass::Relax { side * unsafe { *self.doubles(row).add(PUSHED + k) as f32 } } else { 0.0 };
        let carried = self.s(JOINT_IMPULSE_0 + k, row) * side;
        let given = carried + pushed;
        let pressed = if given > 0.0 { given } else { 0.0 };
        let speed = axis.speed(a, b) * side;
        let bias = if gap > 0.0 {
            gap / h
        } else if pass == Pass::Push {
            let push = rate * gap;
            if push > -most { push } else { -most }
        } else {
            0.0
        };
        let total = pressed - (speed + bias) / give;
        let total = if total > 0.0 { total } else { 0.0 };
        // A relaxing pass only takes back, as for a contact.
        let total = if pass == Pass::Relax && gap > 0.0 && total > pressed { pressed } else { total };
        axis.push(a, b, (total - given) * side);
        if pass == Pass::Push {
            unsafe { *self.doubles(row).add(PUSHED + k) = ((total - given) * side) as f64 };
        } else {
            let kept = total - pushed;
            self.set_s(JOINT_IMPULSE_0 + k, row, if kept > 0.0 { kept * side } else { 0.0 });
        }
    }
}
