// Multibody joints: a tree of bodies held to reduced coordinates, the way an articulated body is held in Featherstone's
// algorithms (Featherstone, Rigid Body Dynamics Algorithms, 2008, chapters 6 to 9), written here with the maximal
// coordinates the rest of the kernel keeps and projected onto the joint space each substep.
//
// A tree of links has the generalised velocity qd: the root's six speeds when the root moves, and the free axes of each joint.
// A link's twist is linear in it, v_i = b_i + J_i qd, with b_i what a root that does not move carries along. The contact
// and joint passes of a substep push the links apart in full space; what a joint tree would have done with those impulses is
// their projection onto the joint space in the metric of the masses, the least change of kinetic energy that keeps every joint
// closed. That is the minimiser of 1/2 (v - b - J qd)^T M (v - b - J qd), so with H = J^T M J, the joint-space inertia matrix
// that Featherstone's composite rigid body algorithm builds (2008, section 6.2),
//
//   H qd = J^T M (v - b),
//
// solved here by Cholesky in doubles. The same result comes from applying the impulses through the articulated-body
// inertias (Featherstone 2008, section 7.2; Baraff 1996 for the maximal-coordinate view); this form costs O(links dof^2) and
// needs no spatial algebra, which suits trees of a few dozen links. Positions are held the same way: after the poses
// move, every link is put back where its parent and its joint's free axes place it (forward kinematics), so a tree cannot
// drift open however many substeps it takes, as one held by constraint impulses alone can.
//
// Determinism: only + - * / sqrt in doubles and f32, in a fixed order.
use crate::layout::*;
use crate::math::*;
use crate::world::{NONE, World};

/// Most links of a tree, and most generalised speeds it can hold.
pub const MAX_LINKS: usize = 40;
pub const MAX_DOF: usize = 64;

/// How far a link may stand from where its joints place it, in metres and radians, before the pose is put back. The joint rows
/// keep every joint that closely themselves; the pose pass is for what they leave under a heavy load or on a branch.
pub const DRIFT: f32 = 1e-3;
const TURN: f32 = 6.283_185_5;

type D3 = [f64; 3];
#[inline(always)]
fn d3(v: V3) -> D3 {
    [v.x as f64, v.y as f64, v.z as f64]
}
#[inline(always)]
fn sub(a: D3, b: D3) -> D3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline(always)]
fn dot(a: D3, b: D3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline(always)]
fn cross(a: D3, b: D3) -> D3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[derive(Clone, Copy)]
struct Dof {
    angular: bool,
    axis: D3,
    point: D3,
    /// The link whose joint owns this speed; the root for its own six.
    owner: usize,
}

const NO_DOF: Dof = Dof { angular: false, axis: [0.0; 3], point: [0.0; 3], owner: 0 };
const UNIT: [V3; 3] = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];

impl World {
    /// The links of the tree rooted at `root`, parents first; 0 when the chain is longer than the tree can hold.
    fn mb_chain(&self, root: usize, rows: &mut [usize; MAX_LINKS]) -> usize {
        let (mut count, mut at) = (0, root as u32);
        while at != NONE {
            if count == MAX_LINKS {
                return 0;
            }
            rows[count] = at as usize;
            count += 1;
            at = self.uu(MB_NEXT, at as usize);
        }
        count
    }

    /// Calls `each` once with the root of every multibody that has a body awake.
    fn mb_roots(&mut self, mut each: impl FnMut(&mut World, usize)) {
        let call = self.header().mb_calls.wrapping_add(1);
        self.header_mut().mb_calls = call;
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
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

    /// Projects the speeds of every awake multibody onto its joint space. See the head of this file.
    pub fn project_multibodies(&mut self) {
        self.mb_roots(|w, root| w.project_tree(root));
    }

    /// Puts every awake multibody's links back where their joints place them.
    pub fn fk_multibodies(&mut self, h: f32) {
        self.mb_roots(|w, root| w.fk_tree(root, h));
    }

    fn tree_ok(&self, rows: &[usize; MAX_LINKS], count: usize) -> bool {
        if count == 0 {
            return false;
        }
        for i in 1..count {
            let joint = self.uu(MB_JOINT, rows[i]);
            if joint == NONE {
                return false;
            }
            let flags = self.uu(JOINT_FLAGS, joint as usize);
            if flags & JOINT_ALIVE == 0 || flags & JOINT_IDLE != 0 || self.uu(JOINT_A, joint as usize) != self.uu(MB_PARENT, rows[i]) {
                return false;
            }
        }
        true
    }

    fn mb_parent_index(&self, rows: &[usize; MAX_LINKS], i: usize) -> usize {
        let parent = self.uu(MB_PARENT, rows[i]) as usize;
        let mut j = 0;
        while j < i && rows[j] != parent {
            j += 1;
        }
        j
    }

    /// True when the axis stands at one of its limits and its speed runs into it.
    fn at_limit(&self, joint: usize, flags: u32, axis: usize, value: f32, rate: f32) -> bool {
        if flags & (JOINT_LIMIT << axis) == 0 {
            return false;
        }
        let (low, high) = (self.s(JOINT_MIN_0 + axis, joint), self.s(JOINT_MAX_0 + axis, joint));
        (value <= low + DRIFT && rate < 0.0) || (value >= high - DRIFT && rate > 0.0)
    }

    fn project_tree(&mut self, root: usize) {
        let mut rows = [0usize; MAX_LINKS];
        let count = self.mb_chain(root, &mut rows);
        if !self.tree_ok(&rows, count) {
            return;
        }
        let mut dofs = [NO_DOF; MAX_DOF];
        let mut n = 0;
        let mut anc = [0u64; MAX_LINKS];
        anc[0] = 1;
        let root_center = d3(self.v(CENTER_X, root));
        let root_moves = self.flags(root) & KIND == DYNAMIC;
        if root_moves {
            for k in 0..3 {
                dofs[n] = Dof { angular: false, axis: d3(UNIT[k]), point: root_center, owner: 0 };
                n += 1;
            }
            for k in 0..3 {
                dofs[n] = Dof { angular: true, axis: d3(UNIT[k]), point: root_center, owner: 0 };
                n += 1;
            }
        }
        for i in 1..count {
            let (body, parent) = (rows[i], self.mb_parent_index(&rows, i));
            anc[i] = anc[parent] | (1u64 << i);
            let joint = self.uu(MB_JOINT, body) as usize;
            let flags = self.uu(JOINT_FLAGS, joint);
            let p_row = rows[parent];
            let rotation = self.q(ROTATION_X, p_row);
            let frame = rotation.mul(self.q(JOINT_FRAME_A_X, joint));
            let point = d3(self.v(POSITION_X, p_row).add(rotation.rotate(self.v(JOINT_ANCHOR_A_X, joint))));
            let (c_row, p_center) = (body, self.v(CENTER_X, p_row));
            let center_c = self.v(CENTER_X, c_row);
            let anchor_b = self.v(POSITION_X, c_row).add(self.q(ROTATION_X, c_row).rotate(self.v(JOINT_ANCHOR_B_X, joint)));
            let anchor_a = self.v(POSITION_X, p_row).add(rotation.rotate(self.v(JOINT_ANCHOR_A_X, joint)));
            let along = self
                .v(LINEAR_X, c_row)
                .add(self.v(ANGULAR_X, c_row).cross(anchor_b.sub(center_c)))
                .sub(self.v(LINEAR_X, p_row).add(self.v(ANGULAR_X, p_row).cross(anchor_a.sub(p_center))));
            let spin = self.v(ANGULAR_X, c_row).sub(self.v(ANGULAR_X, p_row));
            let gap = anchor_b.sub(anchor_a);
            let free_turns = (0..3).filter(|k| flags & (JOINT_LOCK << (3 + k)) == 0).count();
            for k in 0..3 {
                if flags & (JOINT_LOCK << k) == 0 {
                    let axis = frame.rotate(UNIT[k]);
                    // A limit the joint stands at and moves into is a wall: its speed along the axis is held at zero.
                    if self.at_limit(joint, flags, k, gap.dot(axis), along.dot(axis)) {
                        continue;
                    }
                    if n == MAX_DOF {
                        return;
                    }
                    dofs[n] = Dof { angular: false, axis: d3(axis), point, owner: i };
                    n += 1;
                }
            }
            for k in 0..3 {
                if flags & (JOINT_LOCK << (3 + k)) == 0 {
                    let axis = frame.rotate(UNIT[k]);
                    if free_turns == 1 && self.at_limit(joint, flags, 3 + k, self.s(JOINT_ANGLE, joint), spin.dot(axis)) {
                        continue;
                    }
                    if n == MAX_DOF {
                        return;
                    }
                    dofs[n] = Dof { angular: true, axis: d3(axis), point, owner: i };
                    n += 1;
                }
            }
        }
        if n == 0 {
            return;
        }
        // What a root that does not move carries each link along with.
        let (root_v, root_w) = (d3(self.v(LINEAR_X, root)), d3(self.v(ANGULAR_X, root)));
        let mut h = [[0.0f64; MAX_DOF]; MAX_DOF];
        let mut r = [0.0f64; MAX_DOF];
        // The columns of each link: linear and angular part of every speed that reaches it.
        let mut col_l = [[0.0f64; 3]; MAX_DOF];
        let mut col_a = [[0.0f64; 3]; MAX_DOF];
        let mut reach = [0usize; MAX_DOF];
        let mut twist = [[[0.0f64; 3]; 2]; MAX_LINKS];
        for i in 0..count {
            let body = rows[i];
            let center = d3(self.v(CENTER_X, body));
            let base_l = if root_moves { [0.0; 3] } else { let c = cross(root_w, sub(center, root_center)); [root_v[0] + c[0], root_v[1] + c[1], root_v[2] + c[2]] };
            let base_a = if root_moves { [0.0; 3] } else { root_w };
            twist[i] = [base_l, base_a];
            let inverse = self.s(INVERSE_MASS, body);
            if !(inverse > 0.0) || self.flags(body) & KIND != DYNAMIC {
                continue;
            }
            let mass = 1.0 / inverse as f64;
            let frame = self.q(ROTATION_X, body).mul(self.q(INERTIA_FRAME_X, body));
            let principal = d3(self.v(INERTIA_X, body));
            let world_inertia = |x: D3| -> D3 {
                let local = d3(frame.unrotate(v3(x[0] as f32, x[1] as f32, x[2] as f32)));
                let scaled = [local[0] * principal[0], local[1] * principal[1], local[2] * principal[2]];
                d3(frame.rotate(v3(scaled[0] as f32, scaled[1] as f32, scaled[2] as f32)))
            };
            let dv = sub(d3(self.v(LINEAR_X, body)), base_l);
            let dw = sub(d3(self.v(ANGULAR_X, body)), base_a);
            let i_dw = world_inertia(dw);
            let mut reached = 0;
            for d in 0..n {
                if anc[i] >> dofs[d].owner & 1 == 0 {
                    continue;
                }
                let dof = dofs[d];
                if dof.angular {
                    col_a[reached] = dof.axis;
                    col_l[reached] = cross(dof.axis, sub(center, dof.point));
                } else {
                    col_a[reached] = [0.0; 3];
                    col_l[reached] = dof.axis;
                }
                reach[reached] = d;
                reached += 1;
            }
            for a in 0..reached {
                let m_l = [mass * col_l[a][0], mass * col_l[a][1], mass * col_l[a][2]];
                let m_a = world_inertia(col_a[a]);
                r[reach[a]] += dot(m_l, dv) + dot(col_a[a], i_dw);
                for b in a..reached {
                    h[reach[a]][reach[b]] += dot(m_l, col_l[b]) + dot(m_a, col_a[b]);
                }
            }
        }
        // Cholesky of H plus a whisper on the diagonal, so a dof that carries no mass solves to zero.
        let mut biggest = 0.0f64;
        for a in 0..n {
            if h[a][a] > biggest {
                biggest = h[a][a];
            }
        }
        let whisper = if biggest * 1e-12 > 1e-18 { biggest * 1e-12 } else { 1e-18 };
        for a in 0..n {
            for b in 0..a {
                h[a][b] = h[b][a];
            }
        }
        for j in 0..n {
            let mut pivot = h[j][j] + whisper;
            for k in 0..j {
                pivot -= h[j][k] * h[j][k];
            }
            let pivot = if pivot > whisper { sqrt64(pivot) } else { sqrt64(whisper) };
            h[j][j] = pivot;
            for i in j + 1..n {
                let mut sum = h[i][j];
                for k in 0..j {
                    sum -= h[i][k] * h[j][k];
                }
                h[i][j] = sum / pivot;
            }
        }
        let mut qd = [0.0f64; MAX_DOF];
        for i in 0..n {
            let mut sum = r[i];
            for k in 0..i {
                sum -= h[i][k] * qd[k];
            }
            qd[i] = sum / h[i][i];
        }
        for i in (0..n).rev() {
            let mut sum = qd[i];
            for k in i + 1..n {
                sum -= h[k][i] * qd[k];
            }
            qd[i] = sum / h[i][i];
        }
        for i in 0..count {
            let body = rows[i];
            if !(self.s(INVERSE_MASS, body) > 0.0) || self.flags(body) & KIND != DYNAMIC {
                continue;
            }
            let center = d3(self.v(CENTER_X, body));
            let (mut lin, mut ang) = (twist[i][0], twist[i][1]);
            for d in 0..n {
                if anc[i] >> dofs[d].owner & 1 == 0 {
                    continue;
                }
                let dof = dofs[d];
                if dof.angular {
                    let l = cross(dof.axis, sub(center, dof.point));
                    for k in 0..3 {
                        ang[k] += dof.axis[k] * qd[d];
                        lin[k] += l[k] * qd[d];
                    }
                } else {
                    for k in 0..3 {
                        lin[k] += dof.axis[k] * qd[d];
                    }
                }
            }
            self.set_v(LINEAR_X, body, v3(lin[0] as f32, lin[1] as f32, lin[2] as f32));
            self.set_v(ANGULAR_X, body, v3(ang[0] as f32, ang[1] as f32, ang[2] as f32));
        }
    }

    fn fk_tree(&mut self, root: usize, h: f32) {
        let mut rows = [0usize; MAX_LINKS];
        let count = self.mb_chain(root, &mut rows);
        if !self.tree_ok(&rows, count) {
            return;
        }
        for i in 1..count {
            let (body, parent) = (rows[i], self.mb_parent_index(&rows, i));
            if self.flags(body) & KIND != DYNAMIC {
                continue;
            }
            let p_row = rows[parent];
            let joint = self.uu(MB_JOINT, body) as usize;
            let flags = self.uu(JOINT_FLAGS, joint);
            let (rp, pp) = (self.q(ROTATION_X, p_row), self.v(POSITION_X, p_row));
            let frame_a = rp.mul(self.q(JOINT_FRAME_A_X, joint));
            let (rc, frame_b) = (self.q(ROTATION_X, body), self.q(JOINT_FRAME_B_X, joint));
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
            let gap = self.v(POSITION_X, body).add(arm).sub(anchor_a);
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
            let moved = center.sub(self.v(CENTER_X, body)).scale(1.0 / h);
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
