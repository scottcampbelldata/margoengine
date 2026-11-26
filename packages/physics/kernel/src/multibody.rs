// Multibody joints: a tree of bodies held to reduced coordinates, the way an articulated body is held in Featherstone's
// algorithms (Featherstone, Rigid Body Dynamics Algorithms, 2008, chapters 6 to 9), written here with the maximal
// coordinates the rest of the kernel keeps and projected onto the joint space each substep.
//
// A link's twist u_i (its centre's speed and its turn) follows its parent's through the joint: u_i = P_i u_parent + S_i qd_i,
// P the transport of a twist from one centre to the next and S_i the free axes of the joint. The contact and joint passes of a
// substep push the links apart in full space; what a joint tree would have done with those impulses is their projection onto
// the joint space in the metric of the masses, the least change of kinetic energy that keeps every joint closed:
//
//   minimise the sum over links of 1/2 (u_i - v_i)^T M_i (u_i - v_i), v_i the speeds the passes left.
//
// Its normal equations are Featherstone's joint-space inertia matrix system H qd = J^T M v (2008, section 6.2), and for a tree
// they are solved without ever forming H, by dynamic programming over the tree: each link's cost, a quadratic in its own
// twist, gains from its children their cost with the joint speeds minimised out (the articulated-body inertia A - A S D^-1 S^T A,
// Featherstone 2008, section 7.2, here for impulses and so with no bias force), and a pass from the root recovers the speeds. Cost
// O(links) with 6 by 6 matrices, as the articulated-body algorithm has, so a chain of hundreds of links costs what a chain of
// ten does a link. Each link keeps its working numbers in the scratch rows of its joint, which every joint already has and which
// the next substep's joint pass writes again, so the memory grows with the world's joints and a tree has no size of its own.
// Positions are held the same way: after the poses move, a link that stands more than DRIFT from where its parent and its
// joint's free axes place it is put back (forward kinematics).
//
// Determinism: only + - * / sqrt in doubles and f32, in a fixed order.
use crate::layout::*;
use crate::math::*;
use crate::world::{NONE, World};

/// How far a link may stand from where its joints place it, in metres and radians, before the pose is put back. The joint rows
/// keep every joint that closely themselves; the pose pass is for what they leave under a heavy load or on a branch.
pub const DRIFT: f32 = 1e-3;
const TURN: f32 = 6.283_185_5;

type D3 = [f64; 3];
type M6 = [[f64; 6]; 6];
type V6 = [f64; 6];
#[inline(always)]
fn d3(v: V3) -> D3 {
    [v.x as f64, v.y as f64, v.z as f64]
}
#[inline(always)]
fn sub(a: D3, b: D3) -> D3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline(always)]
fn cross(a: D3, b: D3) -> D3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// A free axis of a joint, as the twist it gives the link beyond it.
#[derive(Clone, Copy)]
struct Axis {
    angular: bool,
    axis: D3,
    point: D3,
}
const NO_AXIS: Axis = Axis { angular: false, axis: [0.0; 3], point: [0.0; 3] };
const UNIT: [V3; 3] = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];

// Where a link keeps its numbers, in doubles from the start of its joint's scratch: its subtree's inertia A, the right side r, the
// joint's axes S (a column a row of six), the inverse of D = S^T A S, the count of axes, and the twist the pass found.
const A_AT: usize = 0;
const R_AT: usize = 36;
const S_AT: usize = 42;
const DINV_AT: usize = 78;
const K_AT: usize = 114;
const U_AT: usize = 115;

/// The transport of a twist at a centre to one at a centre `r` further on: v + w x r, w.
fn transport(r: D3) -> M6 {
    let mut p = [[0.0; 6]; 6];
    for k in 0..6 {
        p[k][k] = 1.0;
    }
    // v_new = v + w x r = v - [r]x w
    p[0][4] = r[2];
    p[0][5] = -r[1];
    p[1][3] = -r[2];
    p[1][5] = r[0];
    p[2][3] = r[1];
    p[2][4] = -r[0];
    p
}
fn mul6(a: &M6, b: &M6) -> M6 {
    let mut c = [[0.0; 6]; 6];
    for i in 0..6 {
        for k in 0..6 {
            let x = a[i][k];
            if x != 0.0 {
                for j in 0..6 {
                    c[i][j] += x * b[k][j];
                }
            }
        }
    }
    c
}
fn transposed(a: &M6) -> M6 {
    let mut t = [[0.0; 6]; 6];
    for i in 0..6 {
        for j in 0..6 {
            t[j][i] = a[i][j];
        }
    }
    t
}
fn apply6(a: &M6, v: &V6) -> V6 {
    let mut o = [0.0; 6];
    for i in 0..6 {
        for j in 0..6 {
            o[i] += a[i][j] * v[j];
        }
    }
    o
}
/// The inverse of the leading `n` by `n` of a symmetric positive semi-definite matrix plus a whisper on its diagonal, so a
/// direction that carries no mass inverts to something large and is multiplied by a zero right side. Gauss-Jordan without
/// pivoting, which is stable for a positive definite matrix.
fn inverse(mut a: M6, n: usize, whisper: f64) -> M6 {
    let mut out = [[0.0; 6]; 6];
    for i in 0..n {
        out[i][i] = 1.0;
        a[i][i] += whisper;
    }
    for p in 0..n {
        let pivot = 1.0 / a[p][p];
        for j in 0..n {
            a[p][j] *= pivot;
            out[p][j] *= pivot;
        }
        for i in 0..n {
            if i != p {
                let f = a[i][p];
                if f != 0.0 {
                    for j in 0..n {
                        a[i][j] -= f * a[p][j];
                        out[i][j] -= f * out[p][j];
                    }
                }
            }
        }
    }
    out
}
fn whisper_of(a: &M6, n: usize) -> f64 {
    let mut biggest = 0.0f64;
    for i in 0..n {
        if a[i][i] > biggest {
            biggest = a[i][i];
        }
    }
    if biggest * 1e-12 > 1e-18 { biggest * 1e-12 } else { 1e-18 }
}

impl World {
    /// Checks the tree rooted at `root` and writes each link's place before it (MB_PREV); the last link, or None when a joint
    /// of the tree is gone, broken or not the one that holds its link to its parent.
    fn mb_check(&mut self, root: usize) -> Option<usize> {
        let (mut at, mut before, mut guard) = (root as u32, NONE, 0u32);
        while at != NONE {
            let row = at as usize;
            if row != root {
                let joint = self.uu(MB_JOINT, row);
                if joint == NONE {
                    return None;
                }
                let flags = self.uu(JOINT_FLAGS, joint as usize);
                if flags & JOINT_ALIVE == 0 || flags & JOINT_IDLE != 0 || self.uu(JOINT_A, joint as usize) != self.uu(MB_PARENT, row) {
                    return None;
                }
            }
            self.set_u(MB_PREV, row, before);
            before = at;
            at = self.uu(MB_NEXT, row);
            guard += 1;
            if guard > self.header().rows {
                return None;
            }
        }
        if before == NONE { None } else { Some(before as usize) }
    }

    /// Calls `each` once with the root of every multibody that has a body awake.
    fn mb_roots(&mut self, mut each: impl FnMut(&mut World, usize)) {
        let call = self.window.mb_call.wrapping_add(1);
        self.window.mb_call = call;
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            if self.uu(MB_ROLE, at) == 0 {
                continue;
            }
            let root = self.uu(MB_ROOT, at) as usize;
            if self.uu(MB_STAMP, root) == call {
                continue;
            }
            self.set_u(MB_STAMP, root, call);
            each(self, root);
        }
    }

    /// Puts every awake link of a multibody whose root does not move into one island. A tree with a moving root is one island
    /// already, its joints uniting each link with its parent; under a fixed or kinematic root the joints unite nothing across
    /// the root, so each branch was an island of its own, and each island's walks (`mb_roots`) reached the root and then every
    /// branch: one island's substeps projected and placed another's links. Branches under a root that does not move do not
    /// move each other, so one island for the tree changes no physics, and each tree is walked by the island that holds it.
    pub fn unite_multibodies(&mut self) {
        let stamp = self.header().mb_calls.wrapping_add(1);
        self.header_mut().mb_calls = stamp;
        for i in 0..self.header().awake as usize {
            let body = self.uu(AWAKE, i) as usize;
            if self.uu(MB_ROLE, body) == 0 || self.flags(body) & KIND != DYNAMIC {
                continue;
            }
            let root = self.uu(MB_ROOT, body) as usize;
            if (self.flags(root) & KIND == DYNAMIC && self.is_awake(root)) || self.uu(MB_STAMP, root) == stamp {
                continue;
            }
            self.set_u(MB_STAMP, root, stamp);
            let (mut first, mut at, mut guard) = (NONE, self.uu(MB_NEXT, root), 0u32);
            while at != NONE && guard <= self.header().rows {
                let link = at as usize;
                if self.flags(link) & KIND == DYNAMIC && self.is_awake(link) {
                    if first == NONE {
                        first = at;
                    } else {
                        self.unite(first, at);
                    }
                }
                at = self.uu(MB_NEXT, link);
                guard += 1;
            }
        }
    }

    /// Projects the speeds of every awake multibody onto its joint space. See the head of this file.
    pub fn project_multibodies(&mut self) {
        self.mb_roots(|w, root| w.project_tree(root));
    }

    /// Puts every awake multibody's links back where their joints place them.
    pub fn fk_multibodies(&mut self, h: f32) {
        self.mb_roots(|w, root| w.fk_tree(root, h));
    }

    /// True when the axis stands at one of its limits and its speed runs into it.
    fn at_limit(&self, joint: usize, flags: u32, axis: usize, value: f32, rate: f32) -> bool {
        if flags & (JOINT_LIMIT << axis) == 0 {
            return false;
        }
        let (low, high) = (self.s(JOINT_MIN_0 + axis, joint), self.s(JOINT_MAX_0 + axis, joint));
        (value <= low + DRIFT && rate < 0.0) || (value >= high - DRIFT && rate > 0.0)
    }

    /// The free axes of the joint that holds `body` to `parent`, less any a limit holds the speed of at zero.
    fn joint_axes(&self, joint: usize, body: usize, parent: usize) -> ([Axis; 6], usize) {
        let mut axes = [NO_AXIS; 6];
        let mut n = 0;
        let flags = self.uu(JOINT_FLAGS, joint);
        let rotation = self.pose_rotation(parent);
        let frame = rotation.mul(self.q(JOINT_FRAME_A_X, joint));
        let point = self.pose_position(parent).add(rotation.rotate(self.v(JOINT_ANCHOR_A_X, joint)));
        let (center_b, center_p) = (self.pose_center(body), self.pose_center(parent));
        let anchor_b = self.pose_position(body).add(self.pose_rotation(body).rotate(self.v(JOINT_ANCHOR_B_X, joint)));
        let along = self
            .v(LINEAR_X, body)
            .add(self.v(ANGULAR_X, body).cross(anchor_b.sub(center_b)))
            .sub(self.v(LINEAR_X, parent).add(self.v(ANGULAR_X, parent).cross(point.sub(center_p))));
        let spin = self.v(ANGULAR_X, body).sub(self.v(ANGULAR_X, parent));
        let gap = anchor_b.sub(point);
        let free_turns = (0..3).filter(|k| flags & (JOINT_LOCK << (3 + k)) == 0).count();
        for k in 0..3 {
            if flags & (JOINT_LOCK << k) == 0 {
                let axis = frame.rotate(UNIT[k]);
                // A limit the joint stands at and moves into is a wall: its speed along the axis is held at zero.
                if !self.at_limit(joint, flags, k, gap.dot(axis), along.dot(axis)) {
                    axes[n] = Axis { angular: false, axis: d3(axis), point: d3(point) };
                    n += 1;
                }
            }
        }
        for k in 0..3 {
            if flags & (JOINT_LOCK << (3 + k)) == 0 {
                let axis = frame.rotate(UNIT[k]);
                if !(free_turns == 1 && self.at_limit(joint, flags, 3 + k, self.s(JOINT_ANGLE, joint), spin.dot(axis))) {
                    axes[n] = Axis { angular: true, axis: d3(axis), point: d3(point) };
                    n += 1;
                }
            }
        }
        (axes, n)
    }

    /// A link's mass matrix in world axes, zero for a body that does not move.
    fn mass6(&self, body: usize) -> M6 {
        let mut m = [[0.0; 6]; 6];
        let inverse = self.s(INVERSE_MASS, body);
        if !(inverse > 0.0) || self.flags(body) & KIND != DYNAMIC {
            return m;
        }
        let mass = 1.0 / inverse as f64;
        let frame = self.pose_rotation(body).mul(self.q(INERTIA_FRAME_X, body));
        let principal = d3(self.v(INERTIA_X, body));
        for k in 0..3 {
            m[k][k] = mass;
            let e = frame.unrotate(UNIT[k]);
            let col = d3(frame.rotate(v3(e.x * principal[0] as f32, e.y * principal[1] as f32, e.z * principal[2] as f32)));
            // The columns of R diag(I) R^T in doubles, from the f32 rotation of each unit vector.
            for j in 0..3 {
                m[3 + j][3 + k] = col[j];
            }
        }
        m
    }

    fn project_tree(&mut self, root: usize) {
        let Some(last) = self.mb_check(root) else { return };
        let root_moves = self.flags(root) & KIND == DYNAMIC;
        let twist_of = |w: &World, b: usize| -> V6 {
            let (l, a) = (d3(w.v(LINEAR_X, b)), d3(w.v(ANGULAR_X, b)));
            [l[0], l[1], l[2], a[0], a[1], a[2]]
        };
        // Each link's own cost: its mass matrix and mass matrix times the speed the passes left it.
        let mut a0 = self.mass6(root);
        let mut r0 = apply6(&a0, &twist_of(self, root));
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let b = at as usize;
            let joint = self.uu(MB_JOINT, b) as usize;
            let (m, d) = (self.mass6(b), self.doubles(joint));
            let r = apply6(&m, &twist_of(self, b));
            unsafe {
                for i in 0..6 {
                    for j in 0..6 {
                        *d.add(A_AT + 6 * i + j) = m[i][j];
                    }
                    *d.add(R_AT + i) = r[i];
                }
            }
            at = self.uu(MB_NEXT, b);
        }
        // From the last link to the first, each hands its subtree's cost, its joint minimised out, to its parent.
        let mut at = last as u32;
        while at as usize != root {
            let b = at as usize;
            let (joint, parent) = (self.uu(MB_JOINT, b) as usize, self.uu(MB_PARENT, b) as usize);
            let d = self.doubles(joint);
            let (mut a, mut r) = ([[0.0; 6]; 6], [0.0; 6]);
            unsafe {
                for i in 0..6 {
                    for j in 0..6 {
                        a[i][j] = *d.add(A_AT + 6 * i + j);
                    }
                    r[i] = *d.add(R_AT + i);
                }
            }
            let (axes, k) = self.joint_axes(joint, b, parent);
            let center = d3(self.pose_center(b));
            let mut s = [[0.0; 6]; 6];
            for c in 0..k {
                let ax = axes[c];
                let (lin, ang) = if ax.angular { (cross(ax.axis, sub(center, ax.point)), ax.axis) } else { (ax.axis, [0.0; 3]) };
                for i in 0..3 {
                    s[c][i] = lin[i];
                    s[c][3 + i] = ang[i];
                }
            }
            // A S, S^T A S and S^T r, S a list of k rows of six.
            let (mut a_s, mut dm, mut s_r) = ([[0.0; 6]; 6], [[0.0; 6]; 6], [0.0; 6]);
            for c in 0..k {
                a_s[c] = apply6(&a, &s[c]);
                for i in 0..6 {
                    s_r[c] += s[c][i] * r[i];
                }
            }
            for c in 0..k {
                for e in 0..k {
                    for i in 0..6 {
                        dm[c][e] += s[c][i] * a_s[e][i];
                    }
                }
            }
            let dinv = if k > 0 { inverse(dm, k, whisper_of(&dm, k)) } else { [[0.0; 6]; 6] };
            let (mut hat_a, mut hat_r) = (a, r);
            for c in 0..k {
                for e in 0..k {
                    let f = dinv[c][e];
                    for i in 0..6 {
                        for j in 0..6 {
                            hat_a[i][j] -= a_s[c][i] * f * a_s[e][j];
                        }
                    }
                    for i in 0..6 {
                        hat_r[i] -= a_s[c][i] * f * s_r[e];
                    }
                }
            }
            unsafe {
                for c in 0..6 {
                    for i in 0..6 {
                        *d.add(S_AT + 6 * c + i) = s[c][i];
                        *d.add(DINV_AT + 6 * c + i) = dinv[c][i];
                    }
                }
                *d.add(K_AT) = k as f64;
            }
            let p = transport(sub(center, d3(self.pose_center(parent))));
            let (pt, back) = (transposed(&p), mul6(&mul6(&transposed(&p), &hat_a), &p));
            let up = apply6(&pt, &hat_r);
            if parent == root {
                for i in 0..6 {
                    r0[i] += up[i];
                    for j in 0..6 {
                        a0[i][j] += back[i][j];
                    }
                }
            } else {
                let dp = self.doubles(self.uu(MB_JOINT, parent) as usize);
                unsafe {
                    for i in 0..6 {
                        *dp.add(R_AT + i) += up[i];
                        for j in 0..6 {
                            *dp.add(A_AT + 6 * i + j) += back[i][j];
                        }
                    }
                }
            }
            at = self.uu(MB_PREV, b);
        }
        // The root's twist: free when it moves, as it stands when it does not.
        let u0 = if root_moves {
            let inv = inverse(a0, 6, whisper_of(&a0, 6));
            apply6(&inv, &r0)
        } else {
            twist_of(self, root)
        };
        if root_moves && self.s(INVERSE_MASS, root) > 0.0 {
            self.set_v(LINEAR_X, root, v3(u0[0] as f32, u0[1] as f32, u0[2] as f32));
            self.set_v(ANGULAR_X, root, v3(u0[3] as f32, u0[4] as f32, u0[5] as f32));
        }
        // From the root out: each link's joint speeds from what its parent's twist leaves, and its own twist.
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let b = at as usize;
            let (joint, parent) = (self.uu(MB_JOINT, b) as usize, self.uu(MB_PARENT, b) as usize);
            let d = self.doubles(joint);
            let up = if parent == root {
                u0
            } else {
                let dp = self.doubles(self.uu(MB_JOINT, parent) as usize);
                let mut u = [0.0; 6];
                for i in 0..6 {
                    u[i] = unsafe { *dp.add(U_AT + i) };
                }
                u
            };
            let p = transport(sub(d3(self.pose_center(b)), d3(self.pose_center(parent))));
            let moved = apply6(&p, &up);
            let k = unsafe { *d.add(K_AT) } as usize;
            let mut u = moved;
            if k > 0 {
                let (mut a, mut r, mut s, mut dinv) = ([[0.0; 6]; 6], [0.0; 6], [[0.0; 6]; 6], [[0.0; 6]; 6]);
                unsafe {
                    for i in 0..6 {
                        for j in 0..6 {
                            a[i][j] = *d.add(A_AT + 6 * i + j);
                            s[i][j] = *d.add(S_AT + 6 * i + j);
                            dinv[i][j] = *d.add(DINV_AT + 6 * i + j);
                        }
                        r[i] = *d.add(R_AT + i);
                    }
                }
                let a_moved = apply6(&a, &moved);
                let mut rhs = [0.0; 6];
                for c in 0..k {
                    for i in 0..6 {
                        rhs[c] += s[c][i] * (r[i] - a_moved[i]);
                    }
                }
                for c in 0..k {
                    let mut q = 0.0;
                    for e in 0..k {
                        q += dinv[c][e] * rhs[e];
                    }
                    for i in 0..6 {
                        u[i] += s[c][i] * q;
                    }
                }
            }
            unsafe {
                for i in 0..6 {
                    *d.add(U_AT + i) = u[i];
                }
            }
            if self.s(INVERSE_MASS, b) > 0.0 && self.flags(b) & KIND == DYNAMIC {
                self.set_v(LINEAR_X, b, v3(u[0] as f32, u[1] as f32, u[2] as f32));
                self.set_v(ANGULAR_X, b, v3(u[3] as f32, u[4] as f32, u[5] as f32));
            }
            at = self.uu(MB_NEXT, b);
        }
    }

    fn fk_tree(&mut self, root: usize, h: f32) {
        if self.mb_check(root).is_none() {
            return;
        }
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let body = at as usize;
            at = self.uu(MB_NEXT, body);
            if self.flags(body) & KIND != DYNAMIC {
                continue;
            }
            let p_row = self.uu(MB_PARENT, body) as usize;
            let joint = self.uu(MB_JOINT, body) as usize;
            let flags = self.uu(JOINT_FLAGS, joint);
            let (rp, pp) = (self.pose_rotation(p_row), self.pose_position(p_row));
            let frame_a = rp.mul(self.q(JOINT_FRAME_A_X, joint));
            let (rc, frame_b) = (self.pose_rotation(body), self.q(JOINT_FRAME_B_X, joint));
            // The turn of frame B in frame A, cut to what the joint's angular axes allow.
            let mut rel = frame_a.conjugate().mul(rc.mul(frame_b));
            if rel.w < 0.0 {
                rel = Q { x: -rel.x, y: -rel.y, z: -rel.z, w: -rel.w };
            }
            let free = |k: usize| flags & (JOINT_LOCK << (3 + k)) == 0;
            let free_count = free(0) as u32 + free(1) as u32 + free(2) as u32;
            let rel = if free_count == 0 {
                Q::IDENTITY
            } else if free_count == 1 {
                let k = if free(0) { 0 } else if free(1) { 1 } else { 2 };
                let part = [rel.x, rel.y, rel.z][k];
                let size = sqrt(part * part + rel.w * rel.w);
                let twist = if size > 1e-12 {
                    let (s, c) = (part / size, rel.w / size);
                    Q { x: if k == 0 { s } else { 0.0 }, y: if k == 1 { s } else { 0.0 }, z: if k == 2 { s } else { 0.0 }, w: c }
                } else {
                    Q::IDENTITY
                };
                if flags & (JOINT_LIMIT << (3 + k)) != 0 {
                    // The angle counted past a whole turn, as the joint's rows read it, held inside its limits.
                    let raw = 2.0 * atan2([twist.x, twist.y, twist.z][k], twist.w);
                    let turns = (self.s(JOINT_ANGLE, joint) - raw) * (1.0 / TURN);
                    let turns = (if turns < 0.0 { turns - 0.5 } else { turns + 0.5 }) as i32 as f32;
                    let angle = raw + turns * TURN;
                    let (low, high) = (self.s(JOINT_MIN_0 + 3 + k, joint), self.s(JOINT_MAX_0 + 3 + k, joint));
                    if angle < low || angle > high {
                        let held = if angle < low { low } else { high };
                        let mut vector = [0.0f32; 3];
                        vector[k] = held;
                        Q::from_rotation_vector(v3(vector[0], vector[1], vector[2]))
                    } else {
                        twist
                    }
                } else {
                    twist
                }
            } else {
                rel
            };
            let turned = frame_a.mul(rel).mul(frame_b.conjugate()).normalized();
            let anchor_a = pp.add(rp.rotate(self.v(JOINT_ANCHOR_A_X, joint)));
            let arm = turned.rotate(self.v(JOINT_ANCHOR_B_X, joint));
            let gap = self.pose_position(body).add(arm).sub(anchor_a);
            let mut target = anchor_a;
            for k in 0..3 {
                if flags & (JOINT_LOCK << k) == 0 {
                    let axis = frame_a.rotate(UNIT[k]);
                    let mut slide = axis.dot(gap);
                    if flags & (JOINT_LIMIT << k) != 0 {
                        let (low, high) = (self.s(JOINT_MIN_0 + k, joint), self.s(JOINT_MAX_0 + k, joint));
                        slide = if slide < low { low } else if slide > high { high } else { slide };
                    }
                    target = target.add(axis.scale(slide));
                }
            }
            let position = target.sub(arm);
            let center = position.add(turned.rotate(self.v(LOCAL_CENTER_X, body)));
            // The position correction is also a speed (SHAKE with RATTLE, Andersen 1983): what the joint has to take back to close
            // the step's second-order error leaves as a speed along the constraint, which the projection that follows removes, so
            // the pose is exact and the energy stays where the plain solver keeps it.
            let moved = center.sub(self.pose_center(body)).scale(1.0 / h);
            let turn = turned.mul(rc.conjugate()).to_rotation_vector().scale(1.0 / h);
            // Within the slack of the joint rows nothing is touched: a position correction that small is the second-order step
            // of the integrator itself, and making it every substep takes energy the rows' own RATTLE stages keep.
            if sqrt(moved.dot(moved)) * h < DRIFT && sqrt(turn.dot(turn)) * h < DRIFT {
                continue;
            }
            self.set_v(LINEAR_X, body, self.v(LINEAR_X, body).add(moved));
            self.set_v(ANGULAR_X, body, self.v(ANGULAR_X, body).add(turn));
            self.set_q(ROTATION_X, body, turned);
            self.set_v(POSITION_X, body, position);
            self.set_v(CENTER_X, body, center);
        }
    }
}
