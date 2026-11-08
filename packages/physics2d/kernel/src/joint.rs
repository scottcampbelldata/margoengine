// 2D joints on the soft step (Catto, "Solver2D", 2024; soft constraints, Catto, "Soft Constraints", GDC 2011): each
// substep the biased pass pulls positional error out through a spring at `joint_hertz` and `joint_damping`, and the
// relaxing pass solves the same rows rigidly with no bias, as contacts do. Rows are built from the current poses at every
// pass, so a joint's arms turn with its bodies within the step.
//
// The joints are the ones physics2d names (`packages/physics2d/src/joint.ts`): revolute (a shared point, optional
// angle limits and motor), prismatic (a line in A's frame the anchors stay on, the relative angle held, optional limits
// and motor along the line), fixed (a shared point and a relative angle), rope (a distance at most `length`) and spring
// (a distance spring of stiffness k and damping c). Derivations of the row Jacobians: the time derivative of each
// position error (Erin Catto, "Modeling and Solving Constraints", GDC 2009; Witkin, "Constrained Dynamics", SIGGRAPH
// 1999 course notes).
//
// Locks, the rows a joint holds at zero (the point, a weld's angle, a slider's perpendicular and angle), are solved
// whole along paths. Along a path of joints, K = J M^-1 J^T is block tridiagonal (Baraff, "Linear-Time Dynamics using
// Lagrange Multipliers", SIGGRAPH 1996), so block elimination solves every lock of the path exactly in one sweep, in
// time linear in its length. Gauss-Seidel moves a load one joint a pass, so a light chain under a heavy end stretches. A
// path is a run of joints whose dynamic bodies each carry at most two locked joints; a static or kinematic body ends a
// path, as its infinite mass couples nothing, and a body with three or more (a branch, the joint grid's every node) ends
// every path through it, as do rings (the joint that would close one). Those joints are solved by block Gauss-Seidel,
// one joint's locks at a time: in the 30 by 30 grid, long paths snaking through the mesh fought the cross joints and
// left 8.7 mm gaps where joint-by-joint blocks leave 3.96. Every lock is warm started.
//
// The exact sweep alone does not hold a chain under a heavy load: the 1000:1 chain of 50 still flew to 69 times its
// length. The cause is the geometric stiffness of a taut joint, a stiff mode the substep cannot follow (see `stiffen`),
// and the cure is that paper's implicit diagonal: with it the chain stretches 0.55 percent. Neither alone does it: the
// stiffness with Gauss-Seidel locks left 63 times (tests/joints.rs).
//
// Limits and the rope are one-sided rows treated like contact rows: an open gap is a speculative row that lets the
// bodies close it within the substep, a closed one is soft in the biased pass and rigid in the relaxing one, and the
// impulse keeps one sign. A motor is a force F = k (target - x) + c (target speed - x'), taken implicitly: with
// s = h (h k + c) and m the row's effective mass, the substep impulse is m s / (m + s) (-(h k / s) e + (h c / s) v_t - x'),
// e = x - target, which is the soft row form with mass scale s / (m + s) and impulse scale m / (m + s), clamped to the
// motor's most force times h. A spring joint is the same with no target. Angles come from the bodies' rotation pairs by
// the kernel's own arc tangent (math.rs), built from + - * / and sqrt only, so the step stays deterministic; a revolute
// limit reads the relative angle from -pi to pi, so limits lie within that range.
use alloc::vec::Vec;

use crate::math::{Rot, V2, atan2, v2};
use crate::solver::{Soft, soft};
use crate::world::{Body, World};

/// A motor on a revolute angle or a prismatic line: F = stiffness (target - x) + damping (target speed - x').
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motor {
    pub target_position: f32,
    pub target_velocity: f32,
    pub stiffness: f32,
    pub damping: f32,
    /// The most force (prismatic) or torque (revolute); infinity for no bound.
    pub max_force: f32,
}

impl Motor {
    /// A velocity motor, physics2d's `{ targetVelocity, factor }`.
    pub fn velocity(target: f32, factor: f32) -> Motor {
        Motor { target_position: 0.0, target_velocity: target, stiffness: 0.0, damping: factor, max_force: f32::INFINITY }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum JointKind {
    Revolute { limits: Option<(f32, f32)>, motor: Option<Motor> },
    /// `axis` in A's frame.
    Prismatic { axis: V2, limits: Option<(f32, f32)>, motor: Option<Motor> },
    /// B's frame turned by `angle_b` sits on A's frame turned by `angle_a` (each a rotation pair).
    Fixed { angle_a: Rot, angle_b: Rot },
    Rope { length: f32 },
    Spring { rest_length: f32, stiffness: f32, damping: f32 },
}

#[derive(Clone, Copy, Debug)]
pub struct JointDef {
    pub kind: JointKind,
    pub a: u32,
    pub b: u32,
    /// Anchors in each body's frame (from the body's origin).
    pub anchor_a: V2,
    pub anchor_b: V2,
    /// Whether the two bodies' shapes still collide.
    pub collide: bool,
}

/// A joint and the impulses it has given this substep (and, for rows that are warm started, kept for the next).
#[derive(Clone, Copy, Debug)]
pub struct Joint {
    pub def: JointDef,
    /// The locked rows, in the order `locks` gives them: the point's x and y, then a weld's angle; a slider's
    /// perpendicular and angle.
    pub lock: [f32; 3],
    /// The one-sided rows: a revolute's angle limits, a slider's line limits; a rope's pull is `upper`.
    pub lower: f32,
    pub upper: f32,
    /// The motor (revolute angle, slider line) or a spring joint's impulse.
    pub motor: f32,
}

impl Joint {
    pub fn new(def: JointDef) -> Joint {
        Joint { def, lock: [0.0; 3], lower: 0.0, upper: 0.0, motor: 0.0 }
    }
}

/// A body as the joint solver sees it.
#[derive(Clone, Copy)]
pub struct Side {
    pub inv_mass: f32,
    pub inv_i: f32,
    pub v: V2,
    pub w: f32,
    pub q: Rot,
    /// From the centre of mass to the anchor, world axes.
    pub r: V2,
}

impl Side {
    fn of(body: &Body, inv_i: f32, anchor: V2) -> Side {
        let dynamic = body.is_dynamic();
        Side {
            inv_mass: if dynamic { body.inv_mass } else { 0.0 },
            inv_i: if dynamic { inv_i } else { 0.0 },
            v: body.linear_velocity,
            w: body.angular_velocity,
            q: body.xf.q,
            r: body.xf.q.apply(anchor.sub(body.local_center)),
        }
    }
}

/// The two sides' relative place: B's centre of mass less A's, rounded once from doubles.
pub struct Pair {
    pub a: Side,
    pub b: Side,
    pub offset: V2,
}

/// The terms of one pass.
#[derive(Clone, Copy)]
pub struct Pass {
    pub h: f32,
    pub inv_h: f32,
    pub biased: bool,
    pub spring: Soft,
    pub max_push: f32,
}

/// One scalar row: the speed along it is lin . (vb - va) + ang_b wb - ang_a wa.
#[derive(Clone, Copy)]
pub(crate) struct Row {
    lin: V2,
    ang_a: f32,
    ang_b: f32,
}

impl Pair {
    fn of(world: &World, inv_i: &[f32], def: &JointDef) -> Pair {
        let (ba, bb) = (&world.bodies[def.a as usize], &world.bodies[def.b as usize]);
        Pair {
            a: Side::of(ba, inv_i[def.a as usize], def.anchor_a),
            b: Side::of(bb, inv_i[def.b as usize], def.anchor_b),
            offset: bb.center_from(ba.exact_center),
        }
    }
    fn store(&self, world: &mut World, def: &JointDef) {
        for (id, s) in [(def.a, self.a), (def.b, self.b)] {
            let body = &mut world.bodies[id as usize];
            if body.is_dynamic() {
                body.linear_velocity = s.v;
                body.angular_velocity = s.w;
            }
        }
    }
    #[inline]
    fn separation(&self) -> V2 {
        self.offset.add(self.b.r).sub(self.a.r)
    }
    #[inline]
    fn speed(&self, row: Row) -> f32 {
        row.lin.dot(self.b.v.sub(self.a.v)) + row.ang_b * self.b.w - row.ang_a * self.a.w
    }
    #[inline]
    fn push(&mut self, row: Row, impulse: f32) {
        self.a.v = self.a.v.sub(row.lin.scale(impulse * self.a.inv_mass));
        self.a.w -= row.ang_a * impulse * self.a.inv_i;
        self.b.v = self.b.v.add(row.lin.scale(impulse * self.b.inv_mass));
        self.b.w += row.ang_b * impulse * self.b.inv_i;
    }
    /// B's angle relative to A's turned by `reference`, from -pi to pi.
    #[inline]
    fn relative_angle(&self, reference: Rot) -> f32 {
        let r = self.a.q.inverse_mul(self.b.q).mul(Rot { c: reference.c, s: -reference.s });
        atan2(r.s, r.c)
    }
    /// A row along `u` between the two anchors.
    #[inline]
    fn along(&self, u: V2) -> Row {
        Row { lin: u, ang_a: self.a.r.cross(u), ang_b: self.b.r.cross(u) }
    }
    /// The row of the line coordinate u . d, with u fixed in A's frame: A's arm runs to B's anchor.
    #[inline]
    fn line(&self, u: V2, d: V2) -> Row {
        Row { lin: u, ang_a: d.add(self.a.r).cross(u), ang_b: self.b.r.cross(u) }
    }
}

const ANGLE: Row = Row { lin: V2::ZERO, ang_a: 1.0, ang_b: 1.0 };

impl Row {
    #[inline]
    fn neg(self) -> Row {
        Row { lin: self.lin.neg(), ang_a: -self.ang_a, ang_b: -self.ang_b }
    }
}

/// The locked rows of a joint at its current pose and the error each holds at zero; `point` when the first two are a
/// point's x and y, whose bias is capped as one vector.
pub(crate) struct Locks {
    n: usize,
    rows: [Row; 3],
    error: [f32; 3],
    point: bool,
}

fn locks(def: &JointDef, pair: &Pair) -> Locks {
    let none = Row { lin: V2::ZERO, ang_a: 0.0, ang_b: 0.0 };
    let point = |pair: &Pair| {
        let c = pair.separation();
        (pair.along(v2(1.0, 0.0)), pair.along(v2(0.0, 1.0)), c)
    };
    match def.kind {
        JointKind::Revolute { .. } => {
            let (x, y, c) = point(pair);
            Locks { n: 2, rows: [x, y, none], error: [c.x, c.y, 0.0], point: true }
        }
        JointKind::Fixed { angle_a, angle_b } => {
            // A's frame turned by angle_a meets B's turned by angle_b: B relative to A is angle_a less angle_b.
            let reference = angle_a.mul(Rot { c: angle_b.c, s: -angle_b.s });
            let (x, y, c) = point(pair);
            Locks { n: 3, rows: [x, y, ANGLE], error: [c.x, c.y, pair.relative_angle(reference)], point: true }
        }
        JointKind::Prismatic { axis, .. } => {
            let u = pair.a.q.apply(axis);
            let d = pair.separation();
            let p = u.left();
            Locks { n: 2, rows: [pair.line(p, d), ANGLE, none], error: [p.dot(d), pair.relative_angle(Rot::IDENTITY), 0.0], point: false }
        }
        JointKind::Rope { .. } | JointKind::Spring { .. } => Locks { n: 0, rows: [none; 3], error: [0.0; 3], point: false },
    }
}

/// Whether a joint of this kind has locked rows.
#[inline]
fn locked(kind: &JointKind) -> bool {
    !matches!(kind, JointKind::Rope { .. } | JointKind::Spring { .. })
}

/// The speed each lock should reach: 0 relaxing, minus the spring's pull biased, a point's pull capped as a vector.
fn lock_bias(l: &Locks, pass: &Pass) -> [f32; 3] {
    let mut bias = [0.0; 3];
    if !pass.biased {
        return bias;
    }
    let rate = pass.spring.bias_rate;
    let mut start = 0;
    if l.point {
        let (dir, length) = v2(l.error[0], l.error[1]).normalize();
        let b = dir.scale((rate * length).min(pass.max_push));
        bias[0] = b.x;
        bias[1] = b.y;
        start = 2;
    }
    for k in start..l.n {
        bias[k] = (rate * l.error[k]).clamp(-pass.max_push, pass.max_push);
    }
    bias
}

/// The soft scales of a force spring of stiffness `k` and damping `c` on a row of effective mass `mass`.
#[inline]
fn force_spring(k: f32, c: f32, mass: f32, h: f32) -> Option<(f32, f32, f32)> {
    let s = h * (h * k + c);
    if !(s > 0.0) || !(mass > 0.0) {
        return None;
    }
    // (mass scale, impulse scale, bias per unit error)
    Some((s / (mass + s), mass / (mass + s), h * k / s))
}

/// A limit or motor row as it acts with its joint's locks held: each impulse along `row` comes with the lock impulses
/// -g that keep the locks where they were, g = K_ll^-1 K_l,row, so its effective mass is that of the Schur complement
/// k = K_row,row - K_row,l g and its speed is the row's less g of the locks'. Alone on the free body the locks would take
/// most of each impulse back in their own solve, and one pass a substep would not settle it: a pendulum's angle limit
/// let the swing through by 69 mrad.
struct Coupled {
    row: Row,
    locks: [Row; 3],
    n: usize,
    g: [f32; 3],
    k: f32,
}

impl Pair {
    #[inline]
    fn product(&self, x: Row, y: Row) -> f64 {
        ((self.a.inv_mass + self.b.inv_mass) * x.lin.dot(y.lin) + self.a.inv_i * x.ang_a * y.ang_a + self.b.inv_i * x.ang_b * y.ang_b) as f64
    }
}

impl Coupled {
    fn new(pair: &Pair, row: Row, l: &Locks) -> Coupled {
        let mut kll = [[0.0f64; 3]; 3];
        let mut klr = [0.0f64; 3];
        for r in 0..l.n {
            for c in 0..l.n {
                kll[r][c] = pair.product(l.rows[r], l.rows[c]);
            }
            klr[r] = pair.product(l.rows[r], row);
        }
        let g = mul_v(&invert(&kll, l.n), &klr, l.n);
        let mut k = pair.product(row, row);
        for r in 0..l.n {
            k -= klr[r] * g[r];
        }
        Coupled { row, locks: l.rows, n: l.n, g: [g[0] as f32, g[1] as f32, g[2] as f32], k: k as f32 }
    }
    #[inline]
    fn speed(&self, pair: &Pair) -> f32 {
        let mut v = pair.speed(self.row);
        for r in 0..self.n {
            v -= self.g[r] * pair.speed(self.locks[r]);
        }
        v
    }
    #[inline]
    fn push(&self, pair: &mut Pair, impulse: f32, lock: &mut [f32; 3]) {
        pair.push(self.row, impulse);
        for r in 0..self.n {
            pair.push(self.locks[r], -self.g[r] * impulse);
            lock[r] -= self.g[r] * impulse;
        }
    }
}

/// A one-sided row whose error `gap` must stay at or above 0, pushing only one way.
#[inline]
fn inequality(pair: &mut Pair, row: &Coupled, gap: f32, impulse: &mut f32, lock: &mut [f32; 3], pass: &Pass) {
    let k = row.k;
    if !(k > 0.0) {
        return;
    }
    let mass = 1.0 / k;
    let v = row.speed(pair);
    let (bias, ms, is) = if gap > 0.0 {
        (gap * pass.inv_h, 1.0, 0.0)
    } else if pass.biased {
        ((pass.spring.bias_rate * gap).max(-pass.max_push), pass.spring.mass_scale, pass.spring.impulse_scale)
    } else {
        (0.0, 1.0, 0.0)
    };
    let total = (*impulse - ms * mass * (v + bias) - is * *impulse).max(0.0);
    let delta = total - *impulse;
    *impulse = total;
    row.push(pair, delta, lock);
}

/// A motor or spring row: x is the row's coordinate (angle or length), `m` its aims.
#[inline]
fn motor_row(pair: &mut Pair, row: &Coupled, x: f32, m: &Motor, impulse: &mut f32, lock: &mut [f32; 3], h: f32) {
    let k = row.k;
    if !(k > 0.0) {
        return;
    }
    let mass = 1.0 / k;
    let Some((ms, is, per_error)) = force_spring(m.stiffness, m.damping, mass, h) else {
        return;
    };
    let s = h * (h * m.stiffness + m.damping);
    let bias = per_error * (x - m.target_position) - h * m.damping * m.target_velocity / s;
    let v = row.speed(pair);
    let most = m.max_force * h;
    let total = (*impulse - ms * mass * (v + bias) - is * *impulse).clamp(-most, most);
    let delta = total - *impulse;
    *impulse = total;
    row.push(pair, delta, lock);
}

/// Pushes every one-sided row and motor of a joint by what it holds: its warm start.
fn warm_start_rows(joint: &Joint, pair: &mut Pair) {
    match joint.def.kind {
        JointKind::Revolute { .. } => pair.push(ANGLE, joint.lower - joint.upper + joint.motor),
        JointKind::Prismatic { axis, .. } => {
            let u = pair.a.q.apply(axis);
            let d = pair.separation();
            pair.push(pair.line(u, d), joint.lower - joint.upper + joint.motor);
        }
        JointKind::Fixed { .. } => {}
        JointKind::Rope { .. } => {
            let (u, _) = pair.separation().normalize();
            pair.push(pair.along(u), -joint.upper);
        }
        JointKind::Spring { .. } => {
            let (u, _) = pair.separation().normalize();
            pair.push(pair.along(u), joint.motor);
        }
    }
}

/// One pass over a joint's motor, limits, rope or spring: everything but its locks, each row coupled to the locks.
fn solve_rows(joint: &mut Joint, pair: &mut Pair, pass: &Pass) {
    let free = Locks { n: 0, rows: [ANGLE; 3], error: [0.0; 3], point: false };
    let mut lock = joint.lock;
    match joint.def.kind {
        JointKind::Revolute { limits, motor } => {
            if let Some(m) = motor {
                let row = Coupled::new(pair, ANGLE, &locks(&joint.def, pair));
                let x = pair.relative_angle(Rot::IDENTITY);
                motor_row(pair, &row, x, &m, &mut joint.motor, &mut lock, pass.h);
            }
            if let Some((lo, hi)) = limits {
                let l = locks(&joint.def, pair);
                let x = pair.relative_angle(Rot::IDENTITY);
                inequality(pair, &Coupled::new(pair, ANGLE, &l), x - lo, &mut joint.lower, &mut lock, pass);
                inequality(pair, &Coupled::new(pair, ANGLE.neg(), &l), hi - x, &mut joint.upper, &mut lock, pass);
            }
        }
        JointKind::Prismatic { axis, limits, motor } => {
            let u = pair.a.q.apply(axis);
            if let Some(m) = motor {
                let d = pair.separation();
                let row = Coupled::new(pair, pair.line(u, d), &locks(&joint.def, pair));
                motor_row(pair, &row, u.dot(d), &m, &mut joint.motor, &mut lock, pass.h);
            }
            if let Some((lo, hi)) = limits {
                let d = pair.separation();
                let (row, l) = (pair.line(u, d), locks(&joint.def, pair));
                inequality(pair, &Coupled::new(pair, row, &l), u.dot(d) - lo, &mut joint.lower, &mut lock, pass);
                inequality(pair, &Coupled::new(pair, row.neg(), &l), hi - u.dot(d), &mut joint.upper, &mut lock, pass);
            }
        }
        JointKind::Fixed { .. } => {}
        JointKind::Rope { length } => {
            let (u, distance) = pair.separation().normalize();
            if distance > 0.0 {
                // Pulls only: the impulse along -u is at least 0.
                let row = Coupled::new(pair, pair.along(u.neg()), &free);
                inequality(pair, &row, length - distance, &mut joint.upper, &mut lock, pass);
            }
        }
        JointKind::Spring { rest_length, stiffness, damping } => {
            let (u, distance) = pair.separation().normalize();
            if distance > 0.0 {
                let m = Motor { target_position: rest_length, target_velocity: 0.0, stiffness, damping, max_force: f32::INFINITY };
                let row = Coupled::new(pair, pair.along(u), &free);
                motor_row(pair, &row, distance, &m, &mut joint.motor, &mut lock, pass.h);
            }
        }
    }
    joint.lock = lock;
}

/// The joint spring at substep `h`: `hertz` held to a quarter of the substep rate.
pub fn joint_spring(hertz: f32, damping: f32, h: f32) -> Soft {
    soft(hertz.min(0.25 / h), damping, h)
}

// ---- Paths ----

type M3 = [[f64; 3]; 3];

/// The joints split into paths for the exact sweep (see the header), rebuilt each step.
#[derive(Default)]
pub struct Paths {
    /// Joint indices, path after path, each in order along its path.
    order: Vec<u32>,
    /// Where each path starts in `order`, and one past the last.
    starts: Vec<u32>,
    /// Per joint: in a path.
    in_path: Vec<bool>,
    /// Per body: up to two path joints, u32::MAX for none; and the union find parent.
    links: Vec<[u32; 2]>,
    parent: Vec<u32>,
    degree: Vec<u8>,
    /// Scratch of the sweep, per joint of a path.
    rows: Vec<Locks>,
    rhs: Vec<[f64; 3]>,
    inverse: Vec<M3>,
    w: Vec<M3>,
    x: Vec<[f64; 3]>,
    /// Per body: the inverse inertia the joints solve with, the body's own raised by its geometric stiffness.
    inv_i: Vec<f32>,
    /// Paths built and joints in them, for the tests.
    pub count: u32,
    pub joints: u32,
}

#[inline]
fn active(world: &World, def: &JointDef) -> bool {
    let (ba, bb) = (&world.bodies[def.a as usize], &world.bodies[def.b as usize]);
    def.a != def.b && ((ba.is_dynamic() && ba.awake) || (bb.is_dynamic() && bb.awake))
}

fn find(parent: &mut [u32], mut x: u32) -> u32 {
    while parent[x as usize] != x {
        let up = parent[parent[x as usize] as usize];
        parent[x as usize] = up;
        x = up;
    }
    x
}

/// The other path joint at `body`, if `body` is dynamic and has one besides `joint`.
#[inline]
fn next_at(links: &[[u32; 2]], world: &World, body: u32, joint: u32) -> Option<u32> {
    if !world.bodies[body as usize].is_dynamic() {
        return None;
    }
    let [x, y] = links[body as usize];
    let other = if x == joint { y } else if y == joint { x } else { u32::MAX };
    (other != u32::MAX).then_some(other)
}

#[inline]
fn far(def: &JointDef, body: u32) -> u32 {
    if def.a == body { def.b } else { def.a }
}

/// Splits the active joints with locks into paths.
pub(crate) fn build_paths(world: &World, paths: &mut Paths) {
    let (nb, nj) = (world.bodies.len(), world.joints.len());
    paths.order.clear();
    paths.starts.clear();
    paths.in_path.clear();
    paths.in_path.resize(nj, false);
    paths.links.clear();
    paths.links.resize(nb, [u32::MAX; 2]);
    paths.parent.clear();
    paths.parent.extend(0..nb as u32);
    // How many locked joints each body has: a body with more than two is a branch and ends every path through it.
    paths.degree.clear();
    paths.degree.resize(nb, 0);
    for joint in &world.joints {
        let def = &joint.def;
        if locked(&def.kind) && active(world, def) {
            paths.degree[def.a as usize] = paths.degree[def.a as usize].saturating_add(1);
            paths.degree[def.b as usize] = paths.degree[def.b as usize].saturating_add(1);
        }
    }
    for (j, joint) in world.joints.iter().enumerate() {
        let def = &joint.def;
        if !locked(&def.kind) || !active(world, def) {
            continue;
        }
        let (da, db) = (world.bodies[def.a as usize].is_dynamic(), world.bodies[def.b as usize].is_dynamic());
        let branch = |body: u32| paths.degree[body as usize] > 2;
        if (da && branch(def.a)) || (db && branch(def.b)) {
            continue;
        }
        if da && db {
            let (ra, rb) = (find(&mut paths.parent, def.a), find(&mut paths.parent, def.b));
            if ra == rb {
                continue;
            }
            paths.parent[ra as usize] = rb;
        }
        for (dynamic, body) in [(da, def.a), (db, def.b)] {
            if dynamic {
                let slot = &mut paths.links[body as usize];
                if slot[0] == u32::MAX { slot[0] = j as u32 } else { slot[1] = j as u32 }
            }
        }
        paths.in_path[j] = true;
    }
    // Walk each path from one end.
    let mut seen = core::mem::take(&mut paths.in_path);
    let marks: Vec<bool> = seen.clone();
    for j in 0..nj as u32 {
        if !seen[j as usize] {
            continue;
        }
        let (mut cur, mut at) = (j, world.joints[j as usize].def.a);
        while let Some(n) = next_at(&paths.links, world, at, cur) {
            at = far(&world.joints[n as usize].def, at);
            cur = n;
        }
        paths.starts.push(paths.order.len() as u32);
        let mut body = far(&world.joints[cur as usize].def, at);
        loop {
            seen[cur as usize] = false;
            paths.order.push(cur);
            match next_at(&paths.links, world, body, cur) {
                Some(n) => {
                    body = far(&world.joints[n as usize].def, body);
                    cur = n;
                }
                None => break,
            }
        }
    }
    paths.count = paths.starts.len() as u32;
    paths.joints = paths.order.len() as u32;
    paths.starts.push(paths.order.len() as u32);
    paths.in_path = marks;
}

/// The coupling block K_ij = J_i M^-1 J_j^T of two joints through the body they share.
fn coupling(world: &World, inv_i: &[f32], di: &JointDef, li: &Locks, dj: &JointDef, lj: &Locks, body: u32) -> M3 {
    let mut k = [[0.0f64; 3]; 3];
    let b = &world.bodies[body as usize];
    if !b.is_dynamic() {
        return k;
    }
    let (m, i) = (b.inv_mass as f64, inv_i[body as usize] as f64);
    // A body is a joint's A (sign -1, its ang_a) or its B (sign +1, ang_b).
    let side = |d: &JointDef, row: &Row| if d.b == body { (1.0f64, row.ang_b as f64) } else { (-1.0f64, row.ang_a as f64) };
    for r in 0..li.n {
        let (si, ai) = side(di, &li.rows[r]);
        for c in 0..lj.n {
            let (sj, aj) = side(dj, &lj.rows[c]);
            let lin = li.rows[r].lin.x as f64 * lj.rows[c].lin.x as f64 + li.rows[r].lin.y as f64 * lj.rows[c].lin.y as f64;
            k[r][c] = si * sj * (m * lin + i * ai * aj);
        }
    }
    k
}

/// A joint's own block K_ii.
fn own(world: &World, inv_i: &[f32], def: &JointDef, l: &Locks) -> M3 {
    let mut k = coupling(world, inv_i, def, l, def, l, def.a);
    if def.b != def.a {
        let kb = coupling(world, inv_i, def, l, def, l, def.b);
        for r in 0..3 {
            for c in 0..3 {
                k[r][c] += kb[r][c];
            }
        }
    }
    k
}

/// The inverse of a symmetric block of size n by Cholesky; a pivot under an f32 epsilon of its diagonal marks a row that
/// depends on the others, and that row is dropped (its part of the inverse is zero).
fn invert(k: &M3, n: usize) -> M3 {
    let mut l = [[0.0f64; 3]; 3];
    let mut dropped = [false; 3];
    for c in 0..n {
        let mut d = k[c][c];
        for p in 0..c {
            d -= l[c][p] * l[c][p];
        }
        if !(d > f32::EPSILON as f64 * k[c][c]) {
            dropped[c] = true;
            continue;
        }
        let root = crate::math::sqrt64(d);
        l[c][c] = root;
        for r in c + 1..n {
            let mut s = k[r][c];
            for p in 0..c {
                s -= l[r][p] * l[c][p];
            }
            l[r][c] = s / root;
        }
    }
    let mut inv = [[0.0f64; 3]; 3];
    for col in 0..n {
        // Solve L L^T x = e_col, skipping dropped rows.
        let mut y = [0.0f64; 3];
        for r in 0..n {
            if dropped[r] {
                continue;
            }
            let mut s = if r == col { 1.0 } else { 0.0 };
            for p in 0..r {
                s -= l[r][p] * y[p];
            }
            y[r] = s / l[r][r];
        }
        for r in (0..n).rev() {
            if dropped[r] {
                continue;
            }
            let mut s = y[r];
            for p in r + 1..n {
                s -= l[p][r] * inv[p][col];
            }
            inv[r][col] = s / l[r][r];
        }
    }
    inv
}

#[inline]
fn mul_v(m: &M3, x: &[f64; 3], n: usize) -> [f64; 3] {
    let mut y = [0.0; 3];
    for r in 0..n {
        for c in 0..n {
            y[r] += m[r][c] * x[c];
        }
    }
    y
}

/// The right side of a joint's locks: the speed along each plus its bias.
fn lock_rhs(pair: &Pair, l: &Locks, pass: &Pass) -> [f64; 3] {
    let bias = lock_bias(l, pass);
    let mut rhs = [0.0; 3];
    for k in 0..l.n {
        rhs[k] = (pair.speed(l.rows[k]) + bias[k]) as f64;
    }
    rhs
}

/// Applies a joint's lock impulses `delta` to its bodies in the world.
fn apply_locks(world: &mut World, inv_i: &[f32], def: &JointDef, l: &Locks, delta: &[f32; 3]) {
    for (id, sign) in [(def.a, -1.0f32), (def.b, 1.0f32)] {
        let body = &mut world.bodies[id as usize];
        if !body.is_dynamic() {
            continue;
        }
        let (mut dv, mut dw) = (V2::ZERO, 0.0f32);
        for k in 0..l.n {
            let row = &l.rows[k];
            dv = dv.add(row.lin.scale(sign * delta[k]));
            dw += sign * delta[k] * if id == def.b { row.ang_b } else { row.ang_a };
        }
        body.linear_velocity = body.linear_velocity.add(dv.scale(body.inv_mass));
        body.angular_velocity += inv_i[id as usize] * dw;
    }
}

/// The impulse change of a lock block from the solution x of K x = rhs: soft in the biased pass, rigid relaxing.
#[inline]
fn lock_delta(x: &[f64; 3], held: &[f32; 3], n: usize, pass: &Pass) -> [f32; 3] {
    let mut d = [0.0f32; 3];
    for k in 0..n {
        d[k] = if pass.biased { -pass.spring.mass_scale * x[k] as f32 - pass.spring.impulse_scale * held[k] } else { -(x[k] as f32) };
    }
    d
}

/// Warm starts every active joint: one-sided rows, motors and springs always, locks only off the paths. A path's locks
/// start each substep from nothing.
pub(crate) fn warm_start(world: &mut World, paths: &mut Paths, h: f32, geometric: bool) {
    stiffen(world, paths, h, geometric);
    for i in 0..world.joints.len() {
        let def = world.joints[i].def;
        if !active(world, &def) {
            continue;
        }
        let mut pair = Pair::of(world, &paths.inv_i, &def);
        warm_start_rows(&world.joints[i], &mut pair);
        pair.store(world, &def);
        if locked(&def.kind) {
            let pair = Pair::of(world, &paths.inv_i, &def);
            let l = locks(&def, &pair);
            let held = world.joints[i].lock;
            apply_locks(world, &paths.inv_i, &def, &l, &held);
        }
    }
}

/// The inverse inertia each body's joints solve with this substep (`Settings::joint_geometric_stiffness`, on by
/// default). A taut point joint pulling with force F at an arm r
/// stiffens its body's turning by |F| |r| (the second derivative of the point's place in the angle is -R r, scaled by the
/// joint's force: the geometric stiffness). Under a heavy load that is a stiff mode, the zigzag of a taut chain, whose
/// frequency outruns the substep: 1000:1 at 50 links, r 0.05, sqrt(2 F r / I) = 890 rad/s, so omega h = 3.7 at 4
/// substeps, past the 2 an explicit step survives. Following Andrews, Teichmann and Kry, "Geometric Stiffness for
/// Real-time Constrained Multibody Dynamics" (Computer Graphics Forum 36(2), 2017), the stiffness is taken implicitly
/// in its diagonal form, I' = I + h^2 sum |F| |r|, with F from the joint's impulse of the substep before. It damps that
/// mode alone: a loose joint carries no force, and it moves a pendulum's period by 0.007 percent (tests/joints.rs).
fn stiffen(world: &World, paths: &mut Paths, h: f32, geometric: bool) {
    paths.inv_i.clear();
    paths.inv_i.extend(world.bodies.iter().map(|b| b.inertia));
    if geometric {
        for joint in &world.joints {
            let def = &joint.def;
            if !locked(&def.kind) || !active(world, def) {
                continue;
            }
            // The point's impulse over the substep, times h: h^2 |F| = h |impulse|.
            let pull = h * v2(joint.lock[0], joint.lock[1]).length();
            if matches!(def.kind, JointKind::Prismatic { .. }) {
                continue;
            }
            for (id, anchor) in [(def.a, def.anchor_a), (def.b, def.anchor_b)] {
                let body = &world.bodies[id as usize];
                if body.is_dynamic() {
                    paths.inv_i[id as usize] += pull * anchor.sub(body.local_center).length();
                }
            }
        }
    }
    for (inv, body) in paths.inv_i.iter_mut().zip(&world.bodies) {
        *inv = if body.inv_inertia > 0.0 { 1.0 / (1.0 / body.inv_inertia + (*inv - body.inertia)) } else { 0.0 };
    }
}

/// One pass over every active joint: rows and motors by Gauss-Seidel, then the locks off the paths one joint at a time,
/// then each path's locks exactly.
pub(crate) fn solve(world: &mut World, paths: &mut Paths, pass: &Pass) {
    for i in 0..world.joints.len() {
        let def = world.joints[i].def;
        if !active(world, &def) {
            continue;
        }
        let mut pair = Pair::of(world, &paths.inv_i, &def);
        let mut joint = world.joints[i];
        solve_rows(&mut joint, &mut pair, pass);
        pair.store(world, &def);
        if locked(&def.kind) && !paths.in_path[i] {
            let pair = Pair::of(world, &paths.inv_i, &def);
            let l = locks(&def, &pair);
            let inv = invert(&own(world, &paths.inv_i, &def, &l), l.n);
            let x = mul_v(&inv, &lock_rhs(&pair, &l, pass), l.n);
            let d = lock_delta(&x, &joint.lock, l.n, pass);
            apply_locks(world, &paths.inv_i, &def, &l, &d);
            for k in 0..l.n {
                joint.lock[k] += d[k];
            }
        }
        world.joints[i] = joint;
    }
    for p in 0..paths.count as usize {
        let (s, e) = (paths.starts[p] as usize, paths.starts[p + 1] as usize);
        sweep(world, paths, s, e, pass);
    }
}

/// The exact solve of one path's locks: block LDL^T of the block tridiagonal K, forward and back.
fn sweep(world: &mut World, paths: &mut Paths, s: usize, e: usize, pass: &Pass) {
    let n = e - s;
    paths.rows.clear();
    paths.rhs.clear();
    paths.inverse.clear();
    paths.w.clear();
    paths.x.clear();
    for k in 0..n {
        let def = world.joints[paths.order[s + k] as usize].def;
        let pair = Pair::of(world, &paths.inv_i, &def);
        let l = locks(&def, &pair);
        paths.rhs.push(lock_rhs(&pair, &l, pass));
        paths.rows.push(l);
    }
    // Forward: D_k = K_kk - C_k W_k with C_k = K_{k,k-1} and W_k = D_{k-1}^-1 C_k^T; y_k = r_k - W_k^T y_{k-1}.
    for k in 0..n {
        let def = world.joints[paths.order[s + k] as usize].def;
        let mut d = own(world, &paths.inv_i, &def, &paths.rows[k]);
        let nk = paths.rows[k].n;
        let mut w = [[0.0f64; 3]; 3];
        if k > 0 {
            let prev = world.joints[paths.order[s + k - 1] as usize].def;
            let shared = if def.a == prev.a || def.a == prev.b { def.a } else { def.b };
            let np = paths.rows[k - 1].n;
            // C (nk by np).
            let c = coupling(world, &paths.inv_i, &def, &paths.rows[k], &prev, &paths.rows[k - 1], shared);
            let inv = &paths.inverse[k - 1];
            // W = D_{k-1}^-1 C^T (np by nk).
            for r in 0..np {
                for col in 0..nk {
                    let mut sum = 0.0;
                    for t in 0..np {
                        sum += inv[r][t] * c[col][t];
                    }
                    w[r][col] = sum;
                }
            }
            for r in 0..nk {
                for col in 0..nk {
                    let mut sum = 0.0;
                    for t in 0..np {
                        sum += c[r][t] * w[t][col];
                    }
                    d[r][col] -= sum;
                }
            }
            let y_prev = paths.rhs[k - 1];
            for col in 0..nk {
                let mut sum = 0.0;
                for t in 0..np {
                    sum += w[t][col] * y_prev[t];
                }
                paths.rhs[k][col] -= sum;
            }
        }
        paths.inverse.push(invert(&d, nk));
        paths.w.push(w);
    }
    // Back: x_last = D^-1 y; x_k = D_k^-1 y_k - W_{k+1} x_{k+1}.
    paths.x.resize(n, [0.0; 3]);
    for k in (0..n).rev() {
        let nk = paths.rows[k].n;
        let mut x = mul_v(&paths.inverse[k], &paths.rhs[k], nk);
        if k + 1 < n {
            let (w, next) = (&paths.w[k + 1], paths.x[k + 1]);
            let nn = paths.rows[k + 1].n;
            for r in 0..nk {
                for t in 0..nn {
                    x[r] -= w[r][t] * next[t];
                }
            }
        }
        paths.x[k] = x;
    }
    for k in 0..n {
        let j = paths.order[s + k] as usize;
        let def = world.joints[j].def;
        let l = &paths.rows[k];
        let d = lock_delta(&paths.x[k], &world.joints[j].lock, l.n, pass);
        apply_locks(world, &paths.inv_i, &def, l, &d);
        for t in 0..l.n {
            world.joints[j].lock[t] += d[t];
        }
    }
}
