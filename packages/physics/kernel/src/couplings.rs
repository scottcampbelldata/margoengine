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
pub const MAX_COUPLINGS: usize = 64;

/// What a coupling is.
pub const GEAR: u32 = 1;
pub const RACK_AND_PINION: u32 = 2;
pub const PULLEY: u32 = 3;
/// Two anchors that keep a distance within a range: `ratio` is the least, `total` the greatest (0 for no greatest).
pub const DISTANCE: u32 = 4;

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
    /// Adds a coupling between two live bodies; its slot, or None when they are one body, one is gone, or the table is full.
    pub fn add_coupling(&mut self, kind: u32, a: u32, b: u32) -> Option<usize> {
        if a == b || !self.body_alive(a) || !self.body_alive(b) || !(GEAR..=DISTANCE).contains(&kind) {
            return None;
        }
        let slot = (0..MAX_COUPLINGS).find(|&k| self.header().couplings[k].kind == 0)?;
        self.header_mut().couplings[slot] = Coupling { kind, a, b, ..Coupling::NONE };
        self.wake(a);
        self.wake(b);
        Some(slot)
    }

    /// Writes one of a coupling's parameters: the slot's fields by index (see `COUPLING_FIELDS`).
    pub fn set_coupling(&mut self, slot: usize, field: u32, value: [f32; 3]) {
        let Some(c) = self.header_mut().couplings.get_mut(slot) else { return };
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
            _ => {}
        }
        c.impulse = 0.0;
    }

    pub fn remove_coupling(&mut self, slot: usize) -> bool {
        match self.header_mut().couplings.get_mut(slot) {
            Some(c) if c.kind != 0 => {
                *c = Coupling::NONE;
                true
            }
            _ => false,
        }
    }

    pub fn coupling_error(&self, slot: usize) -> f32 {
        self.header().couplings.get(slot).map_or(0.0, |c| c.error)
    }

    pub fn coupling_impulse(&self, slot: usize) -> f32 {
        self.header().couplings.get(slot).map_or(0.0, |c| c.impulse)
    }

    /// Whether a coupling's two bodies are both there.
    fn coupling_live(&self, c: &Coupling) -> bool {
        c.kind != 0 && self.body_alive(c.a) && self.body_alive(c.b)
    }

    /// Wakes the other body of a coupling whose one body is awake, before the islands are made, so the pair sleeps and wakes as one.
    pub fn wake_couplings(&mut self) {
        for k in 0..MAX_COUPLINGS {
            let c = self.header().couplings[k];
            if !self.coupling_live(&c) {
                continue;
            }
            let (a_asleep, b_asleep) = (self.flags(c.a as usize) & SLEEPING != 0, self.flags(c.b as usize) & SLEEPING != 0);
            if a_asleep != b_asleep {
                self.wake(if a_asleep { c.a } else { c.b });
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
        for k in 0..MAX_COUPLINGS {
            let c = self.header().couplings[k];
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
        for k in 0..MAX_COUPLINGS {
            let c = self.header().couplings[k];
            if !self.coupling_live(&c) {
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
            self.header_mut().couplings[k].impulse = c.impulse + change;
        }
    }

    /// After a substep's poses: the error a gear and a rack have built up follows from the speed they ended with.
    pub fn track_couplings(&mut self, h: f32) {
        for k in 0..MAX_COUPLINGS {
            let c = self.header().couplings[k];
            if !self.coupling_live(&c) || c.kind == PULLEY || c.kind == DISTANCE {
                continue;
            }
            let (row, _) = self.coupling_row(&c);
            let (a, b) = (self.moving(c.a as usize), self.moving(c.b as usize));
            let (speed, _) = Self::coupling_speed(&c, &row, &a, &b);
            self.header_mut().couplings[k].error = c.error + speed * h;
        }
    }
}
