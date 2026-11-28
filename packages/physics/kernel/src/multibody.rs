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
/// JOINT_ELASTIC's bit for a pin: a joint from a link of a tree to a body outside it, whose anchors the tree's spring solve
/// holds together as a stiff implicit spring (`add_pins`), so a chain pinned at both ends holds under its springs' load.
pub const JOINT_PIN: u32 = 1 << 6;
/// JOINT_ELASTIC's bit for a pin that gives way along its link's own +Y axis as a spring of JOINT_STIFFNESS_1 (N/m) and
/// JOINT_DAMPING_1 (N s/m): the half link a rod's pinned end stands for, which stretches as the rest of the rod does.
pub const JOINT_PIN_ALONG: u32 = 1 << 7;
/// A pin's stiffness over a substep, in its link's own mass: h^2 k = PIN_STIFFNESS m. Its gap under a load F is then
/// F h^2 / (PIN_STIFFNESS m): a millionth of how far F moves the link alone in a substep, and the tree's matrices still hold
/// it, a ratio of 10^6 in doubles of 16 digits.
const PIN_STIFFNESS: f64 = 1e6;
/// How much stiffer across a pin that gives is than its give along (`pin_spring`).
const PIN_GIVE: f64 = 1e3;
/// The share of a pin's tension stiffness across its link taken into a substep's backward Euler solve: all of it, as a pin's
/// half link is a small part of a rod (it raised an ordinary rod's damping ratio by 6e-4 at 60 steps a second).
const TENSION_SHARE: f64 = 1.0;

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
    /// The joint's axis this is, 0 to 2 sliding along frame A's axes, 3 to 5 turning about them.
    dof: usize,
}
const NO_AXIS: Axis = Axis { angular: false, axis: [0.0; 3], point: [0.0; 3], dof: 0 };
const UNIT: [V3; 3] = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];

// Where a link keeps its numbers, in doubles from the start of its joint's scratch: its subtree's inertia A, the right side r, the
// joint's axes S (a column a row of six), the inverse of D = S^T A S, the count of axes, and the twist the pass found. A joint
// with a rotor on any free axis keeps, past the count, which of its six axes the free ones are: K_AT holds k + 8 mask, mask
// bit j set for axis j, so the pass from the root can find each one's armature again.
const A_AT: usize = 0;
const R_AT: usize = 36;
const S_AT: usize = 42;
const DINV_AT: usize = 78;
const K_AT: usize = 114;
const U_AT: usize = 115;
/// Each free axis's implicit spring term g (see `tree_springs`), six doubles after the twist.
const G_AT: usize = 121;
/// A link's twist before `spring_tree` and the twist its springs' projection gave it.
const V_AT: usize = 127;
const W_AT: usize = 133;

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
/// The velocity of a point `arm` from a body's centre as three rows of a twist (v, w): v + w x r = v - [r]x w.
fn point_jacobian(arm: D3) -> [[f64; 6]; 3] {
    let mut jac = [[0.0f64; 6]; 3];
    for i in 0..3 {
        jac[i][i] = 1.0;
    }
    jac[0][4] = arm[2];
    jac[0][5] = -arm[1];
    jac[1][3] = -arm[2];
    jac[1][5] = arm[0];
    jac[2][3] = arm[1];
    jac[2][4] = -arm[0];
    jac
}

/// Makes the leading `n` by `n` of `a` symmetric, each pair of entries their mean. The articulated inertias of a tree are
/// symmetric, and the pass from the last link to the first (A - A S D^-1 S^T A, then P^T A P) keeps a symmetric matrix symmetric
/// but grows any asymmetry rounding leaves: about 3.5 times a link in a chain of 24 slender links, so the rotational block of
/// the links near the root became as asymmetric as it was large, D = S^T A S no longer the matrix of the least change of
/// energy, and the projection put energy in (a chain of 24 or more links falling under gravity ran away within two seconds).
/// Kept symmetric at every link, the pass is the Schur complement of a symmetric positive definite matrix, which is stable.
fn symmetric(a: &mut M6, n: usize) {
    for i in 0..n {
        for j in i + 1..n {
            let mean = 0.5 * (a[i][j] + a[j][i]);
            a[i][j] = mean;
            a[j][i] = mean;
        }
    }
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
        self.mb_roots(|w, root| w.project_tree(root, 0.0, false));
    }

    /// Steps the implicit springs of every awake tree that has any (`tree_springs`), over the substep of `h` seconds about to
    /// move the poses: the projection with each spring's backward Euler term, on the speeds the substep's forces and pushing
    /// passes left, so the poses move by the speeds the springs give, as backward Euler moves them. Run where it is, after
    /// the pushing passes and before the poses move; at the end of the substep, after the next substep's gravity was still to
    /// come, a cantilever's springs met gravity one substep late and the rod stood 28 % too stiff at 4 substeps.
    pub fn spring_multibodies(&mut self, h: f32) {
        self.mb_roots(|w, root| {
            if w.uu(MB_HELD, root) == 2 {
                w.spring_tree(root, h);
            }
        });
    }

    /// Gives a tree's links what its implicit springs change of their speeds, and nothing else: the projection with the springs
    /// less the projection without them, both of the speeds the pushing passes left. Projecting those speeds outright would
    /// also take out what the joint rows push to close their gaps before the poses move, and a cantilever's joints then opened
    /// and its tip crept down, 5 % in 40 s. Both projections are linear in the speeds with the same articulated inertias, so
    /// the difference is the springs' own answer in the joint space.
    fn spring_tree(&mut self, root: usize, h: f32) {
        let twist_of = |w: &World, b: usize| -> V6 {
            let (l, a) = (d3(w.v(LINEAR_X, b)), d3(w.v(ANGULAR_X, b)));
            [l[0], l[1], l[2], a[0], a[1], a[2]]
        };
        let set = |w: &mut World, b: usize, u: &V6| {
            w.set_v(LINEAR_X, b, v3(u[0] as f32, u[1] as f32, u[2] as f32));
            w.set_v(ANGULAR_X, b, v3(u[3] as f32, u[4] as f32, u[5] as f32));
        };
        let root_start = twist_of(self, root);
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let b = at as usize;
            let (d, v) = (self.doubles(self.uu(MB_JOINT, b) as usize), twist_of(self, b));
            for i in 0..6 {
                unsafe { *d.add(V_AT + i) = v[i] };
            }
            at = self.uu(MB_NEXT, b);
        }
        self.project_tree(root, h, true);
        let root_sprung = twist_of(self, root);
        set(self, root, &root_start);
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let b = at as usize;
            let d = self.doubles(self.uu(MB_JOINT, b) as usize);
            let mut v = [0.0; 6];
            for i in 0..6 {
                unsafe {
                    *d.add(W_AT + i) = *d.add(U_AT + i);
                    v[i] = *d.add(V_AT + i);
                }
            }
            set(self, b, &v);
            at = self.uu(MB_NEXT, b);
        }
        self.project_tree(root, h, false);
        if self.flags(root) & KIND == DYNAMIC && self.s(INVERSE_MASS, root) > 0.0 {
            let plain = twist_of(self, root);
            let mut u = [0.0; 6];
            for i in 0..6 {
                u[i] = root_start[i] + root_sprung[i] - plain[i];
            }
            set(self, root, &u);
            self.react_pins(root, h as f64, &root_sprung);
        }
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let b = at as usize;
            let d = self.doubles(self.uu(MB_JOINT, b) as usize);
            if self.s(INVERSE_MASS, b) > 0.0 && self.flags(b) & KIND == DYNAMIC {
                let mut u = [0.0; 6];
                let mut sprung = [0.0; 6];
                for i in 0..6 {
                    sprung[i] = unsafe { *d.add(W_AT + i) };
                    u[i] = unsafe { *d.add(V_AT + i) } + sprung[i] - unsafe { *d.add(U_AT + i) };
                }
                set(self, b, &u);
                self.react_pins(b, h as f64, &sprung);
            }
            at = self.uu(MB_NEXT, b);
        }
    }

    /// Finds, at the start of a substep's passes, which awake trees hold (MB_HELD): the joint passes leave a held tree's implicit
    /// springs to its projection, and what such a motor carried before the tree held it is dropped, as the tree's springs keep
    /// no impulse of the passes' to warm start from.
    pub fn hold_multibodies(&mut self) {
        self.mb_roots(|w, root| {
            let held = w.mb_check(root).is_some();
            w.set_u(MB_HELD, root, held as u32);
            if !held {
                return;
            }
            let (mut at, mut any) = (w.uu(MB_NEXT, root), false);
            while at != NONE {
                let joint = w.uu(MB_JOINT, at as usize) as usize;
                let springs = w.tree_springs(joint);
                for k in 0..6 {
                    if springs & (1 << k) != 0 {
                        w.set_s(JOINT_MOTOR_0 + k, joint, 0.0);
                    }
                }
                any |= springs != 0 || w.drags(at as usize) || w.pinned(at as usize);
                at = w.uu(MB_NEXT, at as usize);
            }
            any |= w.drags(root) || w.pinned(root);
            // 2: the tree holds and has springs or drag for `spring_multibodies` to step.
            if any {
                w.set_u(MB_HELD, root, 2);
            }
        });
    }

    /// Calls `each(joint, other)` for every live pin of `body` (JOINT_PIN) whose other body is outside `body`'s tree.
    fn each_pin(&self, body: usize, mut each: impl FnMut(&World, usize, usize)) {
        let (mut joint, mut guard) = (self.uu(FIRST_JOINT, body), 0u32);
        let root = self.uu(MB_ROOT, body);
        while joint != NONE && guard <= self.header().joint_rows {
            let row = joint as usize;
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let other = if a == body { b } else { a };
            let flags = self.uu(JOINT_FLAGS, row);
            let inside = self.uu(MB_ROLE, other) != 0 && self.uu(MB_ROOT, other) == root;
            if self.uu(JOINT_ELASTIC, row) & JOINT_PIN != 0 && flags & JOINT_ALIVE != 0 && flags & JOINT_IDLE == 0 && !inside {
                each(self, row, other);
            }
            joint = if a == body { self.uu(JOINT_NEXT_A, row) } else { self.uu(JOINT_NEXT_B, row) };
            guard += 1;
        }
    }

    /// A pin's anchors on `body` and on `other`, the velocity of the other's anchor and the arm of `body`'s from its centre.
    fn pin_geometry(&self, joint: usize, body: usize, other: usize) -> (D3, D3, D3) {
        let on_a = self.uu(JOINT_A, joint) as usize == body;
        let (mine, theirs) = if on_a { (JOINT_ANCHOR_A_X, JOINT_ANCHOR_B_X) } else { (JOINT_ANCHOR_B_X, JOINT_ANCHOR_A_X) };
        let here = self.pose_position(body).add(self.pose_rotation(body).rotate(self.v(mine, joint)));
        let there = self.pose_position(other).add(self.pose_rotation(other).rotate(self.v(theirs, joint)));
        let moving = self.flags(other) & KIND != FIXED;
        let speed = if moving {
            self.v(LINEAR_X, other).add(self.v(ANGULAR_X, other).cross(there.sub(self.pose_center(other))))
        } else {
            v3(0.0, 0.0, 0.0)
        };
        (sub(d3(here), d3(there)), d3(speed), sub(d3(here), d3(self.pose_center(body))))
    }

    /// The pull a pin that gives along its link carries, its spring's k (t . gap) along -t; none for a stiff pin, whose pull
    /// is its gap's correction, not a load.
    fn pin_tension(&self, joint: usize, body: usize, gap: D3) -> D3 {
        if self.uu(JOINT_ELASTIC, joint) & JOINT_PIN_ALONG == 0 {
            return [0.0; 3];
        }
        let t = d3(self.pose_rotation(body).rotate(UNIT[1]));
        let k = self.s(JOINT_STIFFNESS_1, joint) as f64;
        let along = k * (t[0] * gap[0] + t[1] * gap[1] + t[2] * gap[2]);
        [-along * t[0], -along * t[1], -along * t[2]]
    }

    /// The tension's stiffness across the links of a tree, into each link's own cost: a joint whose spring along the links
    /// (its linY, the rod's stretch) carries a tension T gives each of its two links a stiffness T (l / 2) (I - t t^T) on its
    /// turn, l / 2 the link's half length to the joint and t its own axis, taken into the substep's backward Euler solve. A taut
    /// string's energy is (T / 2) sum l theta^2 over its links' turns, so each link carries T l, half from each end (a pin
    /// gives its end half, `add_pins`). Without it the tension's pull across a link was held explicitly, through the pins'
    /// reach along the tree, and a cable whose tension dwarfs its bending stiffness zig-zagged apart at a coarse step: at
    /// 48 kN on 0.29 kg links of 0.165 m, about 2,000 rad/s (Tournier, Nesme, Gilles and Faure, "Stable constrained dynamics",
    /// ACM TOG 34(4) 2015: the geometric stiffness of a constraint's force; KB-PHYS-RODSTRING1).
    fn add_tension_stiffness(&mut self, root: usize, h: f64, a0: &mut M6, r0: &mut V6) {
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let b = at as usize;
            let joint = self.uu(MB_JOINT, b) as usize;
            let parent = self.uu(MB_PARENT, b) as usize;
            if self.tree_springs(joint) & 2 != 0 {
                let measure = self.joint_measure(joint);
                let tension = self.s(JOINT_STIFFNESS_1, joint) as f64 * (measure[1] as f64 - self.s(JOINT_TARGET_1, joint) as f64);
                if tension > 0.0 {
                    let on_a = self.uu(JOINT_A, joint) as usize == b;
                    let (mine, theirs) = if on_a { (JOINT_ANCHOR_A_X, JOINT_ANCHOR_B_X) } else { (JOINT_ANCHOR_B_X, JOINT_ANCHOR_A_X) };
                    for (link, anchor) in [(b, mine), (parent, theirs)] {
                        if self.flags(link) & KIND != DYNAMIC {
                            continue;
                        }
                        let reach = {
                            let v = self.v(anchor, joint);
                            sqrt(v.x * v.x + v.y * v.y + v.z * v.z) as f64
                        };
                        let t = d3(self.pose_rotation(link).rotate(UNIT[1]));
                        // Taken in by the share of the link's turning stiffness the tension is, rho / (1 + rho) with rho its
                        // pull's T l / 2 over the joint's bending spring: a rod its bending holds keeps the tension explicit and
                        // undamped (the bending springs are in the solve already); a cable its tension holds takes it in.
                        let bend = if self.tree_springs(joint) & 8 != 0 { self.s(JOINT_STIFFNESS_3, joint) as f64 } else { 0.0 };
                        let rho = tension * reach / bend.max(1e-30);
                        let k = rho / (1.0 + rho) * h * h * tension * reach;
                        let add = |m: &mut M6, _r: &mut V6| {
                            for i in 0..3 {
                                for j in 0..3 {
                                    let unit = if i == j { 1.0 } else { 0.0 };
                                    let kij = k * (unit - t[i] * t[j]);
                                    m[3 + i][3 + j] += kij;
                                }
                            }
                        };
                        if link == root {
                            add(a0, r0);
                        } else {
                            let d = self.doubles(self.uu(MB_JOINT, link) as usize);
                            let (mut m, mut r) = ([[0.0f64; 6]; 6], [0.0f64; 6]);
                            unsafe {
                                for i in 0..6 {
                                    for j in 0..6 {
                                        m[i][j] = *d.add(A_AT + 6 * i + j);
                                    }
                                    r[i] = *d.add(R_AT + i);
                                }
                            }
                            add(&mut m, &mut r);
                            unsafe {
                                for i in 0..6 {
                                    for j in 0..6 {
                                        *d.add(A_AT + 6 * i + j) = m[i][j];
                                    }
                                    *d.add(R_AT + i) = r[i];
                                }
                            }
                        }
                    }
                }
            }
            at = self.uu(MB_NEXT, b);
        }
    }

    /// A link's own cost with its pins over a substep of `h`: each a zero-length spring of h^2 k = PIN_STIFFNESS m between its
    /// anchors, backward Euler, the other anchor moving as it moves now: h^2 k J^T J on the mass matrix and
    /// J^T (h^2 k v_other - h k gap) on the right side, J the anchor's velocity from the link's twist.
    fn add_pins(&self, body: usize, h: f64, m: &mut M6, r: &mut V6) {
        self.each_pin(body, |w, joint, other| {
            let (gap, speed, arm) = w.pin_geometry(joint, body, other);
            let (c, pull) = w.pin_terms(joint, body, other, h, gap);
            let jac = point_jacobian(arm);
            // C J, then J^T C J and J^T (C v_other - pull).
            let mut cj = [[0.0f64; 6]; 3];
            for i in 0..3 {
                for k in 0..3 {
                    for j in 0..6 {
                        cj[i][j] += c[i][k] * jac[k][j];
                    }
                }
            }
            for a in 0..6 {
                for b in a..6 {
                    let mut sum = 0.0;
                    for i in 0..3 {
                        sum += jac[i][a] * cj[i][b];
                    }
                    m[a][b] += sum;
                    if b != a {
                        m[b][a] += sum;
                    }
                }
                for i in 0..3 {
                    let mut cv = 0.0;
                    for k in 0..3 {
                        cv += c[i][k] * speed[k];
                    }
                    r[a] += jac[i][a] * (cv - pull[i]);
                }
            }
            // The pin's pull turns with the link: a force F at the arm r gives the moment r x F, and a turn d theta of the link
            // changes it by [F]x [r]x d theta. Its symmetric part, a stiffness (F . r) I - (r F^T + F r^T) / 2 on the link's turn,
            // is the tension's stiffness across a taut rod (Tournier, Nesme, Gilles and Faure 2015's geometric stiffness),
            // taken into the backward Euler solve as h^2 of it where the pin pulls the link outward (F . r > 0; pushed, it
            // would lower the stiffness, and a chain's links buckle by their own springs). Held explicitly, a cable whose
            // tension dwarfs its bending stiffness rang at T a / I a link, past what a coarse step holds (KB-PHYS-RODSTRING1).
            let force = w.pin_tension(joint, body, gap);
            let reach = force[0] * arm[0] + force[1] * arm[1] + force[2] * arm[2];
            if reach > 0.0 {
                for i in 0..3 {
                    for j in 0..3 {
                        let unit = if i == j { reach } else { 0.0 };
                        let k = TENSION_SHARE * h * h * (unit - 0.5 * (arm[i] * force[j] + force[i] * arm[j]));
                        m[3 + i][3 + j] += k;
                    }
                }
            }
        });
    }

    /// A pin's matrix over a substep, C = h^2 k_pin (I - t t^T) + (h d + h^2 k) t t^T, and its pull from the gap,
    /// h k_pin (I - t t^T) gap + h k (t . gap) t: stiff across, and along the link's own +Y axis t the pin's spring of
    /// JOINT_STIFFNESS_1 and JOINT_DAMPING_1 when it has JOINT_PIN_ALONG, else stiff that way too. h^2 k_pin is
    /// PIN_STIFFNESS times the link's mass.
    ///
    /// A pin to a dynamic body is a spring between two bodies, and that body answers its impulse within the same step. With
    /// P = C (v_other' - v_p') - pull the impulse on the link and v_other' = v_other - W P, W the other body's mobility at its
    /// anchor (its inverse mass, and its inverse inertia through the arm), P = A^-1 C (v_other - v_p') - A^-1 pull with
    /// A = I + C W: the same spring as to a body that cannot move, with C and pull taken through A^-1. Treated as moving at its
    /// speed instead, a light body on a stiff pin took the whole spring back explicitly and was thrown off (a 2 kg weight on a
    /// rope's end went 19 m up in 3 s). A body still or fixed has W = 0 and keeps C and pull as they are.
    fn pin_terms(&self, joint: usize, body: usize, other: usize, h: f64, gap: D3) -> ([[f64; 3]; 3], D3) {
        let (c, pull) = self.pin_spring(joint, body, h, gap);
        if self.flags(other) & KIND != DYNAMIC {
            return (c, pull);
        }
        let on_a = self.uu(JOINT_A, joint) as usize == other;
        let theirs = if on_a { JOINT_ANCHOR_A_X } else { JOINT_ANCHOR_B_X };
        let there = self.pose_position(other).add(self.pose_rotation(other).rotate(self.v(theirs, joint)));
        let arm = there.sub(self.pose_center(other));
        let frame = self.pose_rotation(other).mul(self.q(INERTIA_FRAME_X, other));
        let (inverse_mass, inverse_inertia) = (self.s(INVERSE_MASS, other) as f64, self.v(INVERSE_INERTIA_X, other));
        // W e_j: the anchor's change of velocity for a unit impulse e_j there, m^-1 e_j + (I^-1 (r x e_j)) x r.
        let mut w_ = [[0.0f64; 3]; 3];
        for j in 0..3 {
            let mut e = [0.0f32; 3];
            e[j] = 1.0;
            let unit = v3(e[0], e[1], e[2]);
            let turn = crate::integrate::apply_inverse_inertia(inverse_inertia, frame, arm.cross(unit)).cross(arm);
            let column = [turn.x as f64, turn.y as f64, turn.z as f64];
            for i in 0..3 {
                w_[i][j] = column[i] + if i == j { inverse_mass } else { 0.0 };
            }
        }
        let mut a = [[0.0f64; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                a[i][j] = if i == j { 1.0 } else { 0.0 };
                for k in 0..3 {
                    a[i][j] += c[i][k] * w_[k][j];
                }
            }
        }
        let inverse = invert3(a);
        let (mut c_out, mut pull_out) = ([[0.0f64; 3]; 3], [0.0f64; 3]);
        for i in 0..3 {
            for j in 0..3 {
                for k in 0..3 {
                    c_out[i][j] += inverse[i][k] * c[k][j];
                }
                pull_out[i] += inverse[i][j] * pull[j];
            }
        }
        (c_out, pull_out)
    }

    /// The pin's spring to an anchor that moves as it moves now: its stiffness C over the substep and its pull C gap / h.
    fn pin_spring(&self, joint: usize, body: usize, h: f64, gap: D3) -> ([[f64; 3]; 3], D3) {
        let mut stiff = PIN_STIFFNESS / self.s(INVERSE_MASS, body) as f64;
        if self.uu(JOINT_ELASTIC, joint) & JOINT_PIN_ALONG != 0 {
            // A pin that gives holds across at PIN_GIVE times its give's stiffness, not at a stiffness that grows as 1 / h^2:
            // at 2,400 steps a second that made a rounding gap of 3e-8 m a pull of 10^6 N on a link, whose turn with the link
            // the solve holds explicitly, and a stretched rod's end blew up (KB-PHYS-RODSTRING1). Across it still gives a
            // thousandth of what its half link stretches under the same load.
            stiff = stiff.min(PIN_GIVE * self.s(JOINT_STIFFNESS_1, joint) as f64 * h * h);
        }
        let (mut c, mut pull) = ([[0.0f64; 3]; 3], [0.0f64; 3]);
        if self.uu(JOINT_ELASTIC, joint) & JOINT_PIN_ALONG == 0 {
            for i in 0..3 {
                c[i][i] = stiff;
                pull[i] = stiff / h * gap[i];
            }
            return (c, pull);
        }
        let t = d3(self.pose_rotation(body).rotate(UNIT[1]));
        let (k, d) = (self.s(JOINT_STIFFNESS_1, joint) as f64, self.s(JOINT_DAMPING_1, joint) as f64);
        let along = h * d + h * h * k;
        let gap_along = t[0] * gap[0] + t[1] * gap[1] + t[2] * gap[2];
        for i in 0..3 {
            for j in 0..3 {
                let unit = if i == j { 1.0 } else { 0.0 };
                c[i][j] = stiff * (unit - t[i] * t[j]) + along * t[i] * t[j];
            }
            pull[i] = stiff / h * (gap[i] - gap_along * t[i]) + h * k * gap_along * t[i];
        }
        (c, pull)
    }

    /// Gives each pin's other body what its pin pulled on the link with, the other way: the impulse -(C (v_p - v_other) + pull)
    /// the link took in the solve with the springs (`pin_terms`), `twist` its speeds there.
    fn react_pins(&mut self, body: usize, h: f64, twist: &V6) {
        let mut pushes: [(usize, D3, D3); 4] = [(usize::MAX, [0.0; 3], [0.0; 3]); 4];
        let mut count = 0;
        self.each_pin(body, |w, joint, other| {
            if w.flags(other) & KIND != DYNAMIC || count == pushes.len() {
                return;
            }
            let (gap, speed, arm) = w.pin_geometry(joint, body, other);
            let (c, pull) = w.pin_terms(joint, body, other, h, gap);
            let jac = point_jacobian(arm);
            let mut slip = [0.0; 3];
            for i in 0..3 {
                for a in 0..6 {
                    slip[i] += jac[i][a] * twist[a];
                }
                slip[i] -= speed[i];
            }
            let mut on_link = [0.0; 3];
            for i in 0..3 {
                let mut cs = 0.0;
                for k in 0..3 {
                    cs += c[i][k] * slip[k];
                }
                on_link[i] = -(cs + pull[i]);
            }
            let there = sub(d3(w.pose_center(body)), [0.0; 3]);
            let point = [there[0] + arm[0] - gap[0], there[1] + arm[1] - gap[1], there[2] + arm[2] - gap[2]];
            pushes[count] = (other, [-on_link[0], -on_link[1], -on_link[2]], point);
            count += 1;
        });
        for &(other, impulse, point) in pushes.iter().take(count) {
            let imp = v3(impulse[0] as f32, impulse[1] as f32, impulse[2] as f32);
            let arm = v3(point[0] as f32, point[1] as f32, point[2] as f32).sub(self.pose_center(other));
            let frame = self.pose_rotation(other).mul(self.q(INERTIA_FRAME_X, other));
            let turn = crate::integrate::apply_inverse_inertia(self.v(INVERSE_INERTIA_X, other), frame, arm.cross(imp));
            self.set_v(LINEAR_X, other, self.v(LINEAR_X, other).add(imp.scale(self.s(INVERSE_MASS, other))));
            self.set_v(ANGULAR_X, other, self.v(ANGULAR_X, other).add(turn));
        }
    }

    /// True when a body moves and has a pin to a body outside its tree.
    fn pinned(&self, body: usize) -> bool {
        let mut any = false;
        if self.flags(body) & KIND == DYNAMIC {
            self.each_pin(body, |_, _, _| any = true);
        }
        any
    }

    /// True when a body moves and has drag toward a flow (DRAG_ACROSS, DRAG_ALONG).
    fn drags(&self, body: usize) -> bool {
        self.flags(body) & KIND == DYNAMIC && (self.s(DRAG_ACROSS, body) > 0.0 || self.s(DRAG_ALONG, body) > 0.0)
    }

    /// A link's own cost with its drag toward the flow over a substep of `h`: the drag at its point p, c (u_f - v_p) with
    /// v_p = v + w x r, backward Euler, adds h J^T C J to the link's mass matrix and h J^T C u_f to its right side, J = [I, -[r]x]
    /// the point's velocity from the link's twist and C = c_across (I - t t^T) + c_along t t^T on the link's axis t.
    fn add_drag(&self, body: usize, h: f64, m: &mut M6, r: &mut V6) {
        let (across, along) = (self.s(DRAG_ACROSS, body) as f64, self.s(DRAG_ALONG, body) as f64);
        let rotation = self.pose_rotation(body);
        let t = d3(rotation.rotate(UNIT[1]));
        let point = self.pose_position(body).add(rotation.rotate(self.v(DRAG_AT_X, body)));
        let arm = sub(d3(point), d3(self.pose_center(body)));
        let flow = d3(self.v(FLOW_X, body));
        let mut c = [[0.0f64; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                let unit = if i == j { 1.0 } else { 0.0 };
                c[i][j] = across * (unit - t[i] * t[j]) + along * t[i] * t[j];
            }
        }
        let jac = point_jacobian(arm);
        // C J and C u_f, then J^T of each.
        let mut cj = [[0.0f64; 6]; 3];
        let mut cu = [0.0f64; 3];
        for i in 0..3 {
            for k in 0..3 {
                for j in 0..6 {
                    cj[i][j] += c[i][k] * jac[k][j];
                }
                cu[i] += c[i][k] * flow[k];
            }
        }
        for a in 0..6 {
            for b in a..6 {
                let mut sum = 0.0;
                for i in 0..3 {
                    sum += jac[i][a] * cj[i][b];
                }
                m[a][b] += h * sum;
                if b != a {
                    m[b][a] += h * sum;
                }
            }
            let mut sum = 0.0;
            for i in 0..3 {
                sum += jac[i][a] * cu[i];
            }
            r[a] += h * sum;
        }
    }

    /// The axes (bit k for axis k) of `joint` whose motors its multibody's tree holds as implicit springs this substep: those it
    /// marks JOINT_ELASTIC with a force-model motor, no cap and no limit, while it is the joint of a link of a tree that holds.
    /// Each is a spring and damper on the joint's own coordinate, taken into the tree's direct solve of its joint space as
    /// backward Euler (`project_tree`), so a stiff chain of them is stable at any stiffness and any number of links, where the
    /// joint passes, one joint at a time, are not (a rod of 16 links at a bending stiffness of 7.7 N m^2 ran away).
    pub(crate) fn tree_springs(&self, joint: usize) -> u32 {
        let elastic = self.uu(JOINT_ELASTIC, joint);
        if elastic == 0 {
            return 0;
        }
        let b = self.uu(JOINT_B, joint) as usize;
        if self.uu(MB_ROLE, b) != 2 || self.uu(MB_JOINT, b) as usize != joint || self.uu(MB_HELD, self.uu(MB_ROOT, b) as usize) == 0 {
            return 0;
        }
        let flags = self.uu(JOINT_FLAGS, joint);
        let mut held = 0;
        for k in 0..6 {
            let on = flags & (JOINT_MOTOR_ON << k) != 0 && flags & (JOINT_MOTOR_FORCE << k) != 0 && flags & (JOINT_LIMIT << k) == 0;
            if elastic & (1 << k) != 0 && on && self.s(JOINT_CAP_0 + k, joint) == f32::INFINITY {
                held |= 1 << k;
            }
        }
        held
    }

    /// Puts every awake multibody's links back where their joints place them; true when it moved any.
    pub fn fk_multibodies(&mut self, h: f32) -> bool {
        let mut moved = false;
        self.mb_roots(|w, root| moved |= w.fk_tree(root, h));
        moved
    }

    /// Reads the speed of every rotor of an awake multibody from its links, before the step lands the impulses given since the
    /// last one: a rotor is held by its joint, not pushed by what pushes a link, so those impulses are resisted by its inertia
    /// too. Each projection carries the speeds on from there.
    pub fn spin_rotors(&mut self) {
        for slot in 0..self.header().awake as usize {
            let body = self.uu(AWAKE, slot) as usize;
            if self.uu(MB_ROLE, body) == 0 || self.uu(MB_ROOT, body) as usize == body {
                continue;
            }
            let joint = self.uu(MB_JOINT, body);
            if joint == NONE || !self.has_rotor(joint as usize) {
                continue;
            }
            let (joint, parent) = (joint as usize, self.uu(MB_PARENT, body) as usize);
            let rotation = self.pose_rotation(parent);
            let frame = rotation.mul(self.q(JOINT_FRAME_A_X, joint));
            let point = self.pose_position(parent).add(rotation.rotate(self.v(JOINT_ANCHOR_A_X, joint)));
            // The centres from the poses: a body set somewhere between steps has its centre found again only as the step begins.
            let center = |w: &World, b: usize| w.pose_position(b).add(w.pose_rotation(b).rotate(w.v(LOCAL_CENTER_X, b)));
            let (center_b, center_p) = (center(self, body), center(self, parent));
            let anchor_b = self.pose_position(body).add(self.pose_rotation(body).rotate(self.v(JOINT_ANCHOR_B_X, joint)));
            let along = self
                .v(LINEAR_X, body)
                .add(self.v(ANGULAR_X, body).cross(anchor_b.sub(center_b)))
                .sub(self.v(LINEAR_X, parent).add(self.v(ANGULAR_X, parent).cross(point.sub(center_p))));
            let spin = self.v(ANGULAR_X, body).sub(self.v(ANGULAR_X, parent));
            for k in 0..3 {
                let axis = frame.rotate(UNIT[k]);
                self.set_s(JOINT_ROTOR_0 + k, joint, along.dot(axis));
                self.set_s(JOINT_ROTOR_0 + 3 + k, joint, spin.dot(axis));
            }
        }
    }

    /// True when any axis of the joint carries a rotor.
    fn has_rotor(&self, joint: usize) -> bool {
        (0..6).any(|j| self.s(JOINT_ARMATURE_0 + j, joint) > 0.0)
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
                    axes[n] = Axis { angular: false, axis: d3(axis), point: d3(point), dof: k };
                    n += 1;
                }
            }
        }
        for k in 0..3 {
            if flags & (JOINT_LOCK << (3 + k)) == 0 {
                let axis = frame.rotate(UNIT[k]);
                if !(free_turns == 1 && self.at_limit(joint, flags, 3 + k, self.s(JOINT_ANGLE, joint), spin.dot(axis))) {
                    axes[n] = Axis { angular: true, axis: d3(axis), point: d3(point), dof: 3 + k };
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
        // R diag(I) R^T in doubles from the principal axes in the world, R's columns, each entry once and mirrored, so the
        // matrix is symmetric to the last bit (see `symmetric`).
        let axes = [d3(frame.rotate(UNIT[0])), d3(frame.rotate(UNIT[1])), d3(frame.rotate(UNIT[2]))];
        for j in 0..3 {
            m[j][j] = mass;
            for k in j..3 {
                let mut sum = 0.0;
                for i in 0..3 {
                    sum += axes[i][j] * principal[i] * axes[i][k];
                }
                m[3 + j][3 + k] = sum;
                m[3 + k][3 + j] = sum;
            }
        }
        m
    }

    fn project_tree(&mut self, root: usize, h: f32, with_springs: bool) {
        let Some(last) = self.mb_check(root) else { return };
        let root_moves = self.flags(root) & KIND == DYNAMIC;
        let twist_of = |w: &World, b: usize| -> V6 {
            let (l, a) = (d3(w.v(LINEAR_X, b)), d3(w.v(ANGULAR_X, b)));
            [l[0], l[1], l[2], a[0], a[1], a[2]]
        };
        // Each link's own cost: its mass matrix and mass matrix times the speed the passes left it.
        let mut a0 = self.mass6(root);
        let mut r0 = apply6(&a0, &twist_of(self, root));
        if with_springs && self.flags(root) & KIND == DYNAMIC {
            if self.drags(root) {
                self.add_drag(root, h as f64, &mut a0, &mut r0);
            }
            self.add_pins(root, h as f64, &mut a0, &mut r0);
        }
        let mut at = self.uu(MB_NEXT, root);
        while at != NONE {
            let b = at as usize;
            let joint = self.uu(MB_JOINT, b) as usize;
            let (mut m, d) = (self.mass6(b), self.doubles(joint));
            let mut r = apply6(&m, &twist_of(self, b));
            if with_springs && self.flags(b) & KIND == DYNAMIC {
                if self.drags(b) {
                    self.add_drag(b, h as f64, &mut m, &mut r);
                }
                self.add_pins(b, h as f64, &mut m, &mut r);
            }
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
        if with_springs {
            self.add_tension_stiffness(root, h as f64, &mut a0, &mut r0);
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
            // The joint's implicit springs: on axis c, the impulse -h (stiffness (theta + h qd - target) + damping (qd - speed)),
            // backward Euler, adds h damping + h^2 stiffness to D and takes g = h (stiffness (theta - target) - damping speed)
            // from the right side, here and in the pass out (Featherstone 2008, section 7.2, with a joint's spring as a term of
            // its own coordinate; Deul et al. 2018, a rod's bending and twisting as such springs, solved directly on the tree).
            let springs = if with_springs { self.tree_springs(joint) } else { 0 };
            let mut g = [0.0f64; 6];
            if springs != 0 {
                let at = self.joint_measure(joint);
                let hd = h as f64;
                for c in 0..k {
                    let dof = axes[c].dof;
                    if springs & (1 << dof) == 0 {
                        continue;
                    }
                    let (stiffness, damping) = (self.s(JOINT_STIFFNESS_0 + dof, joint) as f64, self.s(JOINT_DAMPING_0 + dof, joint) as f64);
                    let (target, speed) = (self.s(JOINT_TARGET_0 + dof, joint) as f64, self.s(JOINT_SPEED_0 + dof, joint) as f64);
                    dm[c][c] += hd * damping + hd * hd * stiffness;
                    g[c] = hd * (stiffness * (at[dof] as f64 - target) - damping * speed);
                    s_r[c] -= g[c];
                }
            }
            // A rotor on a free axis adds its inertia to the axis's diagonal and its momentum, at the speed it kept, to the right
            // side: the cost of the joint speed qd gains 1/2 a (qd - rotor)^2 (Featherstone 2008, section 9.7).
            let mut mask = 0usize;
            if self.has_rotor(joint) {
                for c in 0..k {
                    let j = axes[c].dof;
                    mask |= 1 << j;
                    let a = self.s(JOINT_ARMATURE_0 + j, joint) as f64;
                    if a > 0.0 {
                        dm[c][c] += a;
                        s_r[c] += a * self.s(JOINT_ROTOR_0 + j, joint) as f64;
                    }
                }
            }
            symmetric(&mut dm, k);
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
                *d.add(K_AT) = (k + 8 * mask) as f64;
                for c in 0..6 {
                    *d.add(G_AT + c) = g[c];
                }
            }
            let p = transport(sub(center, d3(self.pose_center(parent))));
            symmetric(&mut hat_a, 6);
            let (pt, mut back) = (transposed(&p), mul6(&mul6(&transposed(&p), &hat_a), &p));
            symmetric(&mut back, 6);
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
            let code = unsafe { *d.add(K_AT) } as usize;
            let (k, mask) = (code % 8, code / 8);
            let mut u = moved;
            let (mut slots, mut speeds) = ([0usize; 6], [0.0f64; 6]);
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
                    rhs[c] -= unsafe { *d.add(G_AT + c) };
                }
                // The rotors' momentum, axis by axis in the order the free axes were listed.
                if mask != 0 {
                    let mut c = 0;
                    for j in 0..6 {
                        if mask & (1 << j) != 0 {
                            slots[c] = j;
                            rhs[c] += self.s(JOINT_ARMATURE_0 + j, joint) as f64 * self.s(JOINT_ROTOR_0 + j, joint) as f64;
                            c += 1;
                        }
                    }
                }
                for c in 0..k {
                    let mut q = 0.0;
                    for e in 0..k {
                        q += dinv[c][e] * rhs[e];
                    }
                    speeds[c] = q;
                    for i in 0..6 {
                        u[i] += s[c][i] * q;
                    }
                }
            }
            // Each rotor turns on at its axis's new speed; one held at a limit stops with it.
            if self.has_rotor(joint) {
                for j in 0..6 {
                    self.set_s(JOINT_ROTOR_0 + j, joint, 0.0);
                }
                for c in 0..k {
                    self.set_s(JOINT_ROTOR_0 + slots[c], joint, speeds[c] as f32);
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

    fn fk_tree(&mut self, root: usize, h: f32) -> bool {
        if self.mb_check(root).is_none() {
            return false;
        }
        let mut moved_any = false;
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
            moved_any = true;
        }
        moved_any
    }
}

/// The inverse of a 3 by 3 matrix by its adjugate; A = I + C W is a positive definite C times a positive semidefinite W plus
/// I, whose determinant is at least 1.
fn invert3(a: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let cof = |r0: usize, r1: usize, c0: usize, c1: usize| a[r0][c0] * a[r1][c1] - a[r0][c1] * a[r1][c0];
    let adj = [
        [cof(1, 2, 1, 2), -cof(0, 2, 1, 2), cof(0, 1, 1, 2)],
        [-cof(1, 2, 0, 2), cof(0, 2, 0, 2), -cof(0, 1, 0, 2)],
        [cof(1, 2, 0, 1), -cof(0, 2, 0, 1), cof(0, 1, 0, 1)],
    ];
    let det = a[0][0] * adj[0][0] + a[0][1] * adj[1][0] + a[0][2] * adj[2][0];
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = adj[i][j] / det;
        }
    }
    out
}
