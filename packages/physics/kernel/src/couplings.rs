// Mechanisms that tie the motion of two bodies together without a joint between them: a gear, a rack and pinion and a pulley.
// Each is one row of the solve, a speed Cdot = sum of (a direction times a body's linear or angular speed) that must stay zero,
// solved in every substep next to the joint pass with the sequential impulses the joints and contacts use: the impulse a row
// has given is carried from one substep to the next (the warm start), a biased pass shares out the error the row has built up, and
// a soft row takes the form of Catto, "Soft Constraints", GDC 2011 (a frequency and a damping ratio). The error of a gear and a rack
// follows from the row's own speed, one substep at a time; a pulley reads the length of its rope from the poses. Baraff, "Linear-Time
// Dynamics using Lagrange Multipliers", SIGGRAPH 1996, is the form of a row between two bodies' coordinates. The table is a fixed one
// in the header, so a snapshot carries it.
use crate::layout::*;
use crate::math::*;
use crate::solver::Moving;
use crate::world::{NONE, World};

/// Most couplings a world holds.
pub const MAX_COUPLINGS: u32 = 1 << 20;

/// What a coupling is.
pub const GEAR: u32 = 1;
pub const RACK_AND_PINION: u32 = 2;
pub const PULLEY: u32 = 3;
/// Two anchors that keep a distance within a range: `ratio` is the least, `total` the greatest (0 for no greatest).
pub const DISTANCE: u32 = 4;
/// A body held to a curve fixed on another: a Catmull-Rom spline through up to `PATH_POINTS` points (in A's frame), with a motor along it.
pub const PATH: u32 = 5;
/// Most points of a path.
pub const PATH_POINTS: usize = 16;

/// One coupling: bodies `a` and `b`, directions in their own frames, and the row's memory. A free slot has kind 0.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Coupling {
    pub kind: u32,
    pub a: u32,
    pub b: u32,
    /// A gear turns about `axis_a` of A and `axis_b` of B; a rack and pinion about `axis_a` of the pinion A and along `axis_b` of the rack B.
    pub axis_a: [f32; 3],
    pub axis_b: [f32; 3],
    /// A pulley's rope ties at `anchor_a` of A and `anchor_b` of B (their own frames) and runs over `ground_a` and `ground_b` (world).
    pub anchor_a: [f32; 3],
    pub anchor_b: [f32; 3],
    pub ground_a: [f32; 3],
    pub ground_b: [f32; 3],
    /// A gear's ratio, a pinion's radius, a pulley's ratio of the second length to the first.
    pub ratio: f32,
    /// The rope's length sum a pulley keeps.
    pub total: f32,
    /// Soft constraint: a frequency in hertz (0 is rigid) and a damping ratio; the share of the error a rigid row closes a step.
    pub hertz: f32,
    pub zeta: f32,
    pub correction: f32,
    /// The error of the combination, and the impulse the row has given.
    pub error: f32,
    pub impulse: f32,
    /// A path: its points in A's frame and how many there are, the impulses of its two normal rows beside `impulse` (the motor's),
    /// and the motor's speed along the path and the most force it may use (0 for no motor).
    pub points: [[f32; 3]; PATH_POINTS],
    pub count: u32,
    pub impulse_n1: f32,
    pub impulse_n2: f32,
    pub motor_speed: f32,
    pub motor_force: f32,
}

impl Coupling {
    pub const NONE: Coupling = Coupling {
        kind: 0,
        a: NONE,
        b: NONE,
        axis_a: [0.0; 3],
        axis_b: [0.0; 3],
        anchor_a: [0.0; 3],
        anchor_b: [0.0; 3],
        ground_a: [0.0; 3],
        ground_b: [0.0; 3],
        ratio: 1.0,
        total: 0.0,
        hertz: 0.0,
        zeta: 1.0,
        correction: 0.2,
        error: 0.0,
        impulse: 0.0,
        points: [[0.0; 3]; PATH_POINTS],
        count: 0,
        impulse_n1: 0.0,
        impulse_n2: 0.0,
        motor_speed: 0.0,
        motor_force: 0.0,
    };
}

fn vec(a: [f32; 3]) -> V3 {
    v3(a[0], a[1], a[2])
}

/// The row of a coupling as the solve sees it: what a unit impulse does to each body's speed and how the combination's speed reads.
struct Row {
    /// Linear direction and arm of each end (a pulley), or zero.
    la: V3,
    lb: V3,
    ra: V3,
    rb: V3,
    /// Angular axis of each end (a gear, a pinion), already scaled by its weight in the row.
    ta: V3,
    tb: V3,
    /// Linear direction of the rack.
    db: V3,
}

impl World {
    /// The coupling in a slot.
    #[inline]
    fn coupling(&self, slot: usize) -> Coupling {
        unsafe { *(self.f(COUPLINGS).add(slot * COUPLING_WORDS as usize) as *const Coupling) }
    }

    #[inline]
    fn put_coupling(&mut self, slot: usize, c: Coupling) {
        unsafe { *(self.f(COUPLINGS).add(slot * COUPLING_WORDS as usize) as *mut Coupling) = c };
    }

    /// Makes room for more couplings.
    pub fn grow_couplings(&mut self) -> bool {
        let capacity = self.header().capacity;
        let slots = capacity[Rows::Coupling as usize] / COUPLING_WORDS;
        if slots >= MAX_COUPLINGS {
            return false;
        }
        let mut next = capacity;
        next[Rows::Coupling as usize] = (if slots < 16 { 16 } else { slots * 2 }) * COUPLING_WORDS;
        self.grow(next)
    }

    /// Adds a coupling between two live bodies; its slot, or None when they are one body, one is gone, the kind is not one, or
    /// memory is out.
    pub fn add_coupling(&mut self, kind: u32, a: u32, b: u32) -> Option<usize> {
        if a == b || !self.body_alive(a) || !self.body_alive(b) || !(GEAR..=PATH).contains(&kind) {
            return None;
        }
        let used = self.header().coupling_rows as usize;
        let slot = match (0..used).find(|&k| self.coupling(k).kind == 0) {
            Some(free) => free,
            None => {
                if used as u32 >= self.header().capacity[Rows::Coupling as usize] / COUPLING_WORDS && !self.grow_couplings() {
                    return None;
                }
                self.header_mut().coupling_rows = used as u32 + 1;
                used
            }
        };
        self.put_coupling(slot, Coupling { kind, a, b, ..Coupling::NONE });
        self.wake(a);
        self.wake(b);
        Some(slot)
    }

    /// Writes one of a coupling's parameters: the slot's fields by index (see `coupling_set` in api.rs).
    pub fn set_coupling(&mut self, slot: usize, field: u32, value: [f32; 3]) {
        if slot >= self.header().coupling_rows as usize {
            return;
        }
        let mut c = self.coupling(slot);
        match field {
            0 => c.axis_a = value,
            1 => c.axis_b = value,
            2 => c.anchor_a = value,
            3 => c.anchor_b = value,
            4 => c.ground_a = value,
            5 => c.ground_b = value,
            6 => c.ratio = value[0],
            7 => c.total = value[0],
            8 => {
                c.hertz = value[0];
                c.zeta = value[1];
                c.correction = value[2];
            }
            9 => {
                if (c.count as usize) < PATH_POINTS {
                    c.points[c.count as usize] = value;
                    c.count += 1;
                }
            }
            10 => {
                c.motor_speed = value[0];
                c.motor_force = value[1];
            }
            _ => {}
        }
        c.impulse = 0.0;
        c.impulse_n1 = 0.0;
        c.impulse_n2 = 0.0;
        self.put_coupling(slot, c);
    }

    pub fn remove_coupling(&mut self, slot: usize) -> bool {
        if slot < self.header().coupling_rows as usize && self.coupling(slot).kind != 0 {
            self.put_coupling(slot, Coupling::NONE);
            return true;
        }
        false
    }

    pub fn coupling_error(&self, slot: usize) -> f32 {
        if slot < self.header().coupling_rows as usize { self.coupling(slot).error } else { 0.0 }
    }

    pub fn coupling_impulse(&self, slot: usize) -> f32 {
        if slot < self.header().coupling_rows as usize { self.coupling(slot).impulse } else { 0.0 }
    }

    /// Whether a coupling's two bodies are both there.
    fn coupling_live(&self, c: &Coupling) -> bool {
        c.kind != 0 && self.body_alive(c.a) && self.body_alive(c.b)
    }

    /// Wakes what a moving body is coupled to, as `wake_across_joints` does for joints.
    pub fn wake_across_couplings(&mut self) {
        for k in 0..self.header().coupling_rows as usize {
            let c = self.coupling(k);
            if !self.coupling_live(&c) {
                continue;
            }
            let (a, b) = (c.a as usize, c.b as usize);
            let (sleeping_a, sleeping_b) = (self.flags(a) & SLEEPING != 0, self.flags(b) & SLEEPING != 0);
            if sleeping_a && !sleeping_b && self.disturbs(b) {
                self.wake(c.a);
            } else if sleeping_b && !sleeping_a && self.disturbs(a) {
                self.wake(c.b);
            }
        }
    }

    /// Coupled bodies are one island, as joined ones are: they sleep together and are woken together.
    pub fn unite_couplings(&mut self) {
        for k in 0..self.header().coupling_rows as usize {
            let c = self.coupling(k);
            if !self.coupling_live(&c) {
                continue;
            }
            let (a, b) = (c.a as usize, c.b as usize);
            let (kind_a, kind_b) = (self.flags(a) & KIND, self.flags(b) & KIND);
            let awake = self.is_awake(a) && self.is_awake(b);
            if kind_a == DYNAMIC && kind_b == DYNAMIC && awake {
                self.unite(c.a, c.b);
            } else if kind_b == DYNAMIC && self.moving_kinematic(a) {
                self.set_s(SLEEP_TIME, b, 0.0);
            } else if kind_a == DYNAMIC && self.moving_kinematic(b) {
                self.set_s(SLEEP_TIME, a, 0.0);
            }
        }
    }

    /// Lays out the row of a coupling at the poses the bodies have now.
    fn coupling_row(&self, c: &Coupling) -> (Row, f32) {
        let (a, b) = (c.a as usize, c.b as usize);
        let (qa, qb) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
        let zero = v3(0.0, 0.0, 0.0);
        let mut row = Row { la: zero, lb: zero, ra: zero, rb: zero, ta: zero, tb: zero, db: zero };
        match c.kind {
            GEAR => {
                row.ta = qa.rotate(vec(c.axis_a));
                row.tb = qb.rotate(vec(c.axis_b)).scale(c.ratio);
                (row, 0.0)
            }
            RACK_AND_PINION => {
                row.ta = qa.rotate(vec(c.axis_a)).scale(c.ratio);
                row.db = qb.rotate(vec(c.axis_b));
                (row, 0.0)
            }
            DISTANCE => {
                let pa = self.v(POSITION_X, a).add(qa.rotate(vec(c.anchor_a)));
                let pb = self.v(POSITION_X, b).add(qb.rotate(vec(c.anchor_b)));
                let d = pb.sub(pa);
                let length = sqrt(d.dot(d));
                row.la = if length > 1e-9 { d.scale(1.0 / length) } else { v3(1.0, 0.0, 0.0) };
                row.ra = pa.sub(self.v(CENTER_X, a));
                row.rb = pb.sub(self.v(CENTER_X, b));
                // The distance from the nearest end of the range (positive past the greatest, negative short of the least), and the length.
                let past = if c.total > 0.0 && length > c.total {
                    length - c.total
                } else if length < c.ratio {
                    length - c.ratio
                } else {
                    0.0
                };
                row.lb = v3(length, 0.0, 0.0);
                (row, past)
            }
            _ => {
                let pa = self.v(POSITION_X, a).add(qa.rotate(vec(c.anchor_a)));
                let pb = self.v(POSITION_X, b).add(qb.rotate(vec(c.anchor_b)));
                let (da, db) = (pa.sub(vec(c.ground_a)), pb.sub(vec(c.ground_b)));
                let (la, lb) = (sqrt(da.dot(da)), sqrt(db.dot(db)));
                row.la = if la > 1e-9 { da.scale(1.0 / la) } else { v3(0.0, -1.0, 0.0) };
                row.lb = if lb > 1e-9 { db.scale(1.0 / lb) } else { v3(0.0, -1.0, 0.0) };
                row.ra = pa.sub(self.v(CENTER_X, a));
                row.rb = pb.sub(self.v(CENTER_X, b));
                (row, la + c.ratio * lb - c.total)
            }
        }
    }

    /// The speed of a row from two bodies' motion, and the inverse mass it meets.
    fn coupling_speed(c: &Coupling, row: &Row, a: &Moving, b: &Moving) -> (f32, f32) {
        match c.kind {
            GEAR => (row.ta.dot(a.angular) + row.tb.dot(b.angular), row.ta.dot(a.inertia.mul(row.ta)) + row.tb.dot(b.inertia.mul(row.tb))),
            RACK_AND_PINION => (
                row.ta.dot(a.angular) + row.db.dot(b.linear),
                row.ta.dot(a.inertia.mul(row.ta)) + row.db.mul(row.db).dot(b.mass),
            ),
            DISTANCE => {
                let speed = row.la.dot(b.at(row.rb).sub(a.at(row.ra)));
                (speed, a.give(row.la, row.ra) + b.give(row.la, row.rb))
            }
            _ => {
                let speed = row.la.dot(a.at(row.ra)) + c.ratio * row.lb.dot(b.at(row.rb));
                (speed, a.give(row.la, row.ra) + c.ratio * c.ratio * b.give(row.lb, row.rb))
            }
        }
    }

    /// Gives a body the push of an impulse `p` along a row.
    fn coupling_push(c: &Coupling, row: &Row, a: &mut Moving, b: &mut Moving, p: f32) {
        match c.kind {
            GEAR => {
                a.angular = a.angular.add(a.inertia.mul(row.ta).scale(p));
                b.angular = b.angular.add(b.inertia.mul(row.tb).scale(p));
            }
            RACK_AND_PINION => {
                a.angular = a.angular.add(a.inertia.mul(row.ta).scale(p));
                b.linear = b.linear.add(b.mass.mul(row.db).scale(p));
            }
            DISTANCE => {
                a.push(row.la.scale(-p), row.ra);
                b.push(row.la.scale(p), row.rb);
            }
            _ => {
                a.push(row.la.scale(p), row.ra);
                b.push(row.lb.scale(p * c.ratio), row.rb);
            }
        }
    }

    /// Gives every coupling the impulse it carries, at the start of a substep.
    pub fn warm_start_couplings(&mut self) {
        for k in 0..self.header().coupling_rows as usize {
            let c = self.coupling(k);
            if c.kind == PATH {
                self.warm_curve(k);
                continue;
            }
            if !self.coupling_live(&c) || c.impulse == 0.0 {
                continue;
            }
            let (row, _) = self.coupling_row(&c);
            let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
            Self::coupling_push(&c, &row, &mut a, &mut b, c.impulse);
            self.settle(c.a as usize, &a);
            self.settle(c.b as usize, &b);
        }
    }

    /// One pass over the couplings; `bias` is the pass that also closes the error.
    pub fn solve_couplings(&mut self, h: f32, bias: bool) {
        for k in 0..self.header().coupling_rows as usize {
            let c = self.coupling(k);
            if !self.coupling_live(&c) {
                continue;
            }
            if c.kind == PATH {
                self.solve_curve(k, h, bias);
                continue;
            }
            let (row, rope) = self.coupling_row(&c);
            let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
            let (speed, inverse) = Self::coupling_speed(&c, &row, &a, &b);
            if !(inverse > 0.0) {
                continue;
            }
            let error = if c.kind == PULLEY || c.kind == DISTANCE { rope } else { c.error };
            // A soft row gives by its stiffness, a rigid one closes a share of its error in the biased pass.
            let (beta, gamma) = if c.hertz > 0.0 {
                let mass = 1.0 / inverse;
                let omega = 2.0 * core::f32::consts::PI * c.hertz;
                let d = 2.0 * mass * c.zeta * omega;
                let spring = mass * omega * omega;
                (spring / (d + h * spring), 1.0 / (h * (d + h * spring)))
            } else {
                (if bias { c.correction / h } else { 0.0 }, 0.0)
            };
            let mut change = -(speed + beta * error + gamma * c.impulse) / (inverse + gamma);
            // A rope pulls and does not push, and a slack one does nothing.
            if c.kind == PULLEY {
                let wanted = c.impulse + change;
                let kept = if wanted > 0.0 || error + speed * h < -1e-5 { 0.0 } else { wanted };
                change = kept - c.impulse;
            }
            // A distance joint pushes or pulls only where its range ends: apart at the least, together at the greatest.
            if c.kind == DISTANCE {
                let length = row.lb.x;
                let (high, low) = (c.total > 0.0 && length + speed * h > c.total, length + speed * h < c.ratio);
                let wanted = c.impulse + change;
                let kept = if high { wanted.min(0.0) } else if low { wanted.max(0.0) } else { 0.0 };
                change = kept - c.impulse;
            }
            if change == 0.0 {
                continue;
            }
            Self::coupling_push(&c, &row, &mut a, &mut b, change);
            self.settle(c.a as usize, &a);
            self.settle(c.b as usize, &b);
            let mut kept = self.coupling(k);
            kept.impulse = c.impulse + change;
            self.put_coupling(k, kept);
        }
    }

    /// After a substep's poses: the error a gear and a rack have built up follows from the speed they ended with.
    pub fn track_couplings(&mut self, h: f32) {
        for k in 0..self.header().coupling_rows as usize {
            let c = self.coupling(k);
            if !self.coupling_live(&c) || c.kind == PULLEY || c.kind == DISTANCE || c.kind == PATH {
                continue;
            }
            let (row, _) = self.coupling_row(&c);
            let (a, b) = (self.moving(c.a as usize), self.moving(c.b as usize));
            let (speed, _) = Self::coupling_speed(&c, &row, &a, &b);
            let mut kept = self.coupling(k);
            kept.error = c.error + speed * h;
            self.put_coupling(k, kept);
        }
    }
}

/// A point of a Catmull-Rom span (the uniform spline through `p1` and `p2`, with `p0` and `p3` as neighbours) and its derivative.
fn spline(p0: V3, p1: V3, p2: V3, p3: V3, t: f32) -> (V3, V3) {
    let (t2, t3) = (t * t, t * t * t);
    let a = p1.scale(2.0);
    let b = p2.sub(p0);
    let c = p0.scale(2.0).sub(p1.scale(5.0)).add(p2.scale(4.0)).sub(p3);
    let d = p3.sub(p0).add(p1.sub(p2).scale(3.0));
    let point = a.add(b.scale(t)).add(c.scale(t2)).add(d.scale(t3)).scale(0.5);
    let slope = b.add(c.scale(2.0 * t)).add(d.scale(3.0 * t2)).scale(0.5);
    (point, slope)
}

/// What a path row needs: the nearest point of the curve to the follower's anchor, the curve's direction there, two directions
/// across it, and the arms from each body's centre.
struct PathState {
    on: V3,
    tangent: V3,
    n1: V3,
    n2: V3,
    ra: V3,
    rb: V3,
    error: V3,
}

impl World {
    fn path_state(&self, c: &Coupling) -> Option<PathState> {
        let n = c.count as usize;
        if n < 2 {
            return None;
        }
        let (a, b) = (c.a as usize, c.b as usize);
        let (qa, qb) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
        let (pa, pb) = (self.v(POSITION_X, a), self.v(POSITION_X, b));
        let at = |i: usize| pa.add(qa.rotate(vec(c.points[i.min(n - 1)])));
        let anchor = pb.add(qb.rotate(vec(c.anchor_b)));
        // Sixteen samples a span, then two Newton steps on the nearest.
        let (mut best, mut span, mut at_t) = (f32::MAX, 0usize, 0.0f32);
        for i in 0..n - 1 {
            let (p0, p1, p2, p3) = (at(i.saturating_sub(1)), at(i), at(i + 1), at(i + 2));
            for k in 0..=16 {
                let t = k as f32 / 16.0;
                let d = spline(p0, p1, p2, p3, t).0.sub(anchor);
                let l = d.dot(d);
                if l < best {
                    best = l;
                    span = i;
                    at_t = t;
                }
            }
        }
        let (p0, p1, p2, p3) = (at(span.saturating_sub(1)), at(span), at(span + 1), at(span + 2));
        for _ in 0..2 {
            let (point, slope) = spline(p0, p1, p2, p3, at_t);
            let denom = slope.dot(slope);
            if denom > 1e-12 {
                let next = at_t - point.sub(anchor).dot(slope) / denom;
                at_t = if next < 0.0 { 0.0 } else if next > 1.0 { 1.0 } else { next };
            }
        }
        let (on, slope) = spline(p0, p1, p2, p3, at_t);
        let length = sqrt(slope.dot(slope));
        let tangent = if length > 1e-9 { slope.scale(1.0 / length) } else { v3(1.0, 0.0, 0.0) };
        // The two directions across the curve: from the world axis least along it.
        let axis = if tangent.x.abs() < 0.6 {
            v3(1.0, 0.0, 0.0)
        } else if tangent.y.abs() < 0.6 {
            v3(0.0, 1.0, 0.0)
        } else {
            v3(0.0, 0.0, 1.0)
        };
        let n1 = tangent.cross(axis);
        let n1 = n1.scale(1.0 / sqrt(n1.dot(n1)));
        let n2 = tangent.cross(n1);
        Some(PathState { on, tangent, n1, n2, ra: on.sub(self.v(CENTER_X, a)), rb: anchor.sub(self.v(CENTER_X, b)), error: anchor.sub(on) })
    }

    fn warm_curve(&mut self, k: usize) {
        let c = self.coupling(k);
        if !self.coupling_live(&c) || (c.impulse == 0.0 && c.impulse_n1 == 0.0 && c.impulse_n2 == 0.0) {
            return;
        }
        let Some(s) = self.path_state(&c) else { return };
        let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
        for (d, p) in [(s.n1, c.impulse_n1), (s.n2, c.impulse_n2), (s.tangent, c.impulse)] {
            a.push(d.scale(-p), s.ra);
            b.push(d.scale(p), s.rb);
        }
        self.settle(c.a as usize, &a);
        self.settle(c.b as usize, &b);
    }

    /// One pass over a path: the follower's anchor is held on the curve by two rows across it, and a motor along it drives it.
    fn solve_curve(&mut self, k: usize, h: f32, bias: bool) {
        let mut c = self.coupling(k);
        let Some(s) = self.path_state(&c) else { return };
        let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
        let speed_of = |a: &Moving, b: &Moving, d: V3| d.dot(b.at(s.rb).sub(a.at(s.ra)));
        for row in 0..3 {
            let (d, held) = match row {
                0 => (s.n1, c.impulse_n1),
                1 => (s.n2, c.impulse_n2),
                _ => (s.tangent, c.impulse),
            };
            if row == 2 && !(c.motor_force > 0.0) {
                continue;
            }
            let inverse = a.give(d, s.ra) + b.give(d, s.rb);
            if !(inverse > 0.0) {
                continue;
            }
            let speed = speed_of(&a, &b, d);
            let (beta, gamma) = if row < 2 && c.hertz > 0.0 {
                let mass = 1.0 / inverse;
                let omega = 2.0 * core::f32::consts::PI * c.hertz;
                let damping = 2.0 * mass * c.zeta * omega;
                let spring = mass * omega * omega;
                (spring / (damping + h * spring), 1.0 / (h * (damping + h * spring)))
            } else {
                (if bias && row < 2 { c.correction / h } else { 0.0 }, 0.0)
            };
            let error = if row == 0 { s.error.dot(s.n1) } else if row == 1 { s.error.dot(s.n2) } else { 0.0 };
            let target = if row == 2 { c.motor_speed } else { 0.0 };
            let mut change = -(speed - target + beta * error + gamma * held) / (inverse + gamma);
            if row == 2 {
                let cap = c.motor_force * h;
                let wanted = held + change;
                let kept = if wanted > cap { cap } else if wanted < -cap { -cap } else { wanted };
                change = kept - held;
            }
            a.push(d.scale(-change), s.ra);
            b.push(d.scale(change), s.rb);
            match row {
                0 => c.impulse_n1 += change,
                1 => c.impulse_n2 += change,
                _ => c.impulse += change,
            }
        }
        self.settle(c.a as usize, &a);
        self.settle(c.b as usize, &b);
        self.put_coupling(k, c);
        let _ = s.on;
    }
}
