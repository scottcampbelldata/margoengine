// The contact solver: soft constraints with substeps and relaxation, the scheme Catto calls Soft Step (Solver2D, 2024;
// soft constraints from Catto 2011, substeps from Macklin et al. 2019). Contacts are found once a step; everything below
// runs each substep over those same points, with the gap worked out again from the bodies' new poses.
//
//   integrate velocities; warm start; solve with bias; integrate poses; relax; restitution.
//
// The biased solve pushes shapes apart through a soft constraint, a spring and damper in implicit form with this frequency
// and damping ratio: omega = 2 pi hertz, a1 = 2 zeta + omega h, a2 = h omega a1, a3 = 1 / (1 + a2), and then
//
//   impulse = -(a2 a3) m (v + (omega / a1) s) - a3 impulse_so_far
//
// Relaxing solves again with no bias and does not move the poses, so the speed the push added leaves the velocities and
// stacks do not hop. A gap still open is a speculative point: it lets the bodies close it within this substep and no more.
//
// Friction comes first, from the normal impulse so far, in a circular cone: the tangent impulse is one vector, cut back to
// mu times the normal impulse. It is anchored: `drift` holds how far the two surfaces have slid since the point last
// stuck, and the biased solve pulls that back, so a block on a slope holds its place instead of creeping (the sticky
// anchors of Solver2D's TGS_Sticky). Muller et al. 2020 hold static friction by position too, but cancel one substep's slip
// and let go when the multiplier passes the cone; here the slip adds up and is pulled back by a soft constraint of the same
// form as the normal. A cone that saturates keeps the anchor at its edge: the drift scales by the same cut, so a sliding
// block pulls it along and one that stops holds from there.
//
// The first point of a manifold turns each substep, as within a substep the first point sees the whole load: from a fixed
// first point a heavy box on a light one walks (`a_heavy_box_stands_on_a_light_one`).
//
// Restitution follows Muller et al. 2020: a point struck in this substep notes its approach speed, and after relaxing is
// solved to -e times that speed. Slower than two substeps of gravity is rest, not a bounce.
use crate::contact::tangent_of;
use crate::integrate::apply_inverse_inertia;
use crate::layout::*;
use crate::math::*;
use crate::world::World;

/// 2 pi as the nearest f32.
const TAU: f32 = 6.283_185_5;

/// Scales of one soft constraint at one substep length.
#[derive(Clone, Copy)]
pub struct Soft {
    pub bias_rate: f32,
    pub mass_scale: f32,
    pub impulse_scale: f32,
}

/// The coefficients of a soft constraint (Catto 2011, in the form of Solver2D).
#[inline]
pub fn soft(hertz: f32, zeta: f32, h: f32) -> Soft {
    let omega = TAU * hertz;
    let a1 = 2.0 * zeta + omega * h;
    let a2 = h * omega * a1;
    let a3 = 1.0 / (1.0 + a2);
    Soft { bias_rate: omega / a1, mass_scale: a2 * a3, impulse_scale: a3 }
}

/// A symmetric 3 by 3 matrix: the world inverse inertia, with any locked axes zeroed in its rows and columns.
#[derive(Clone, Copy)]
pub struct Sym {
    xx: f32,
    xy: f32,
    xz: f32,
    yy: f32,
    yz: f32,
    zz: f32,
}

impl Sym {
    #[inline(always)]
    pub fn mul(&self, v: V3) -> V3 {
        v3(self.xx * v.x + self.xy * v.y + self.xz * v.z, self.xy * v.x + self.yy * v.y + self.yz * v.z, self.xz * v.x + self.yz * v.y + self.zz * v.z)
    }
}

impl Sym {
    /// a . (this b) in doubles.
    #[inline]
    pub fn between(&self, a: V3, b: V3) -> f64 {
        let (ax, ay, az, bx, by, bz) = (a.x as f64, a.y as f64, a.z as f64, b.x as f64, b.y as f64, b.z as f64);
        let (xx, xy, xz, yy, yz, zz) = (self.xx as f64, self.xy as f64, self.xz as f64, self.yy as f64, self.yz as f64, self.zz as f64);
        ax * (xx * bx + xy * by + xz * bz) + ay * (xy * bx + yy * by + yz * bz) + az * (xz * bx + yz * by + zz * bz)
    }
}

/// What the solver needs of a body, held while it works on a pair.
#[derive(Clone, Copy)]
pub struct Moving {
    pub mass: V3,
    pub inertia: Sym,
    pub linear: V3,
    pub angular: V3,
}

impl Moving {
    /// The change of an impulse `p` at the arm `r`.
    #[inline(always)]
    fn push(&mut self, p: V3, r: V3) {
        self.linear = self.linear.add(self.mass.mul(p));
        self.angular = self.angular.add(self.inertia.mul(r.cross(p)));
    }
    /// How much a unit impulse along `d` at `r` changes the speed there along `d`.
    #[inline(always)]
    fn give(&self, d: V3, r: V3) -> f32 {
        let turn = r.cross(d);
        d.mul(d).dot(self.mass) + turn.dot(self.inertia.mul(turn))
    }
    #[inline(always)]
    fn at(&self, r: V3) -> V3 {
        self.linear.add(self.angular.cross(r))
    }
}

impl World {
    #[inline(always)]
    pub fn moving(&self, at: usize) -> Moving {
        Moving {
            mass: self.v(SOLVE_MASS_X, at),
            inertia: Sym {
                xx: self.s(SOLVE_INERTIA_XX, at),
                xy: self.s(SOLVE_INERTIA_XY, at),
                xz: self.s(SOLVE_INERTIA_XZ, at),
                yy: self.s(SOLVE_INERTIA_YY, at),
                yz: self.s(SOLVE_INERTIA_YZ, at),
                zz: self.s(SOLVE_INERTIA_ZZ, at),
            },
            linear: self.v(LINEAR_X, at),
            angular: self.v(ANGULAR_X, at),
        }
    }

    #[inline(always)]
    pub fn settle(&mut self, at: usize, body: &Moving) {
        self.set_v(LINEAR_X, at, body.linear);
        self.set_v(ANGULAR_X, at, body.angular);
    }

    /// Writes what the solver knows of a body: nothing moves one that is not an awake dynamic body, and locks hold.
    pub fn solver_mass(&mut self, at: usize) {
        let flags = self.flags(at);
        let rotation = self.q(ROTATION_X, at);
        self.set_v(CENTER_X, at, self.v(POSITION_X, at).add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
        let (mut mass, mut inertia) = (v3(0.0, 0.0, 0.0), Sym { xx: 0.0, xy: 0.0, xz: 0.0, yy: 0.0, yz: 0.0, zz: 0.0 });
        if flags & KIND == DYNAMIC && flags & SLEEPING == 0 {
            let m = self.s(INVERSE_MASS, at);
            let free = |bit: u32| if flags & bit != 0 { 0.0 } else { 1.0 };
            mass = v3(m * free(LOCK_LINEAR_X), m * free(LOCK_LINEAR_X << 1), m * free(LOCK_LINEAR_X << 2));
            let frame = rotation.mul(self.q(INERTIA_FRAME_X, at));
            let inverse = self.v(INVERSE_INERTIA_X, at);
            let (x, y, z) = (
                apply_inverse_inertia(inverse, frame, v3(1.0, 0.0, 0.0)),
                apply_inverse_inertia(inverse, frame, v3(0.0, 1.0, 0.0)),
                apply_inverse_inertia(inverse, frame, v3(0.0, 0.0, 1.0)),
            );
            let (fx, fy, fz) = (free(LOCK_ANGULAR_X), free(LOCK_ANGULAR_X << 1), free(LOCK_ANGULAR_X << 2));
            inertia = Sym { xx: x.x * fx, xy: x.y * fx * fy, xz: x.z * fx * fz, yy: y.y * fy, yz: y.z * fy * fz, zz: z.z * fz };
        }
        self.set_v(SOLVE_MASS_X, at, mass);
        self.set_s(SOLVE_INERTIA_XX, at, inertia.xx);
        self.set_s(SOLVE_INERTIA_XY, at, inertia.xy);
        self.set_s(SOLVE_INERTIA_XZ, at, inertia.xz);
        self.set_s(SOLVE_INERTIA_YY, at, inertia.yy);
        self.set_s(SOLVE_INERTIA_YZ, at, inertia.yz);
        self.set_s(SOLVE_INERTIA_ZZ, at, inertia.zz);
    }

    /// Mixes one property of two colliders: a pair takes the higher rule of its two, Max over Multiply over Min over Average.
    fn combine(a: f32, b: f32, rule: u32) -> f32 {
        match rule {
            COMBINE_MAX => {
                if a > b {
                    a
                } else {
                    b
                }
            }
            COMBINE_MULTIPLY => a * b,
            COMBINE_MIN => {
                if a < b {
                    a
                } else {
                    b
                }
            }
            _ => 0.5 * (a + b),
        }
    }

    /// Once a step, before the substeps: lists the pairs to solve, and works out their arms, their effective masses and
    /// their friction and bounce. The arms and masses hold for the step.
    pub fn prepare_contacts(&mut self) {
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            self.solver_mass(at);
        }
        let mut solving = 0;
        for i in 0..self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i) as usize;
            let count = self.uu(PAIR_CONTACTS, row) as usize;
            if count == 0 {
                continue;
            }
            let (a, b) = self.pair_bodies(row as u32);
            for body in [a, b] {
                if self.uu(AWAKE_SLOT, body) == crate::world::NONE {
                    self.solver_mass(body);
                }
            }
            let (first, second) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            let (rules_a, rules_b) = (self.uu(COLLIDER_COMBINE, first), self.uu(COLLIDER_COMBINE, second));
            let higher = |x: u32, y: u32| if x > y { x } else { y };
            let friction = Self::combine(self.s(COLLIDER_FRICTION, first), self.s(COLLIDER_FRICTION, second), higher(rules_a & 3, rules_b & 3));
            let bounce = Self::combine(self.s(COLLIDER_RESTITUTION, first), self.s(COLLIDER_RESTITUTION, second), higher(rules_a >> 2 & 3, rules_b >> 2 & 3));
            self.set_s(PAIR_FRICTION, row, friction);
            self.set_s(PAIR_RESTITUTION, row, bounce);
            let normal = self.v(PAIR_NORMAL_X, row);
            let tangent = tangent_of(normal);
            let other = normal.cross(tangent);
            self.set_v(PAIR_TANGENT_X, row, tangent);
            let (rotation_a, rotation_b) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
            let (body_a, body_b) = (self.moving(a), self.moving(b));
            for k in 0..count {
                let at = row * MANIFOLD + k;
                let (arm_a, arm_b) = (rotation_a.rotate(self.v(CONTACT_ANCHOR_A_X, at)), rotation_b.rotate(self.v(CONTACT_ANCHOR_B_X, at)));
                self.set_v(CONTACT_ARM_A_X, at, arm_a);
                self.set_v(CONTACT_ARM_B_X, at, arm_b);
                let mass = |d: V3| {
                    let give = body_a.give(d, arm_a) + body_b.give(d, arm_b);
                    if give > 0.0 { 1.0 / give } else { 0.0 }
                };
                self.set_s(CONTACT_NORMAL_MASS, at, mass(normal));
                self.set_s(CONTACT_TANGENT_MASS, at, mass(tangent));
                self.set_s(CONTACT_OTHER_MASS, at, mass(other));
            }
            self.set_u(SOLVE_PAIRS, solving, row as u32);
            solving += 1;
        }
        self.header_mut().solving = solving as u32;
    }

    /// Each substep: the impulses the points carry, before anything is solved.
    pub fn warm_start(&mut self) {
        for i in 0..self.header().solving as usize {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            let normal = self.v(PAIR_NORMAL_X, row);
            for k in 0..self.uu(PAIR_CONTACTS, row) as usize {
                let at = row * MANIFOLD + k;
                let impulse = normal.scale(self.s(CONTACT_NORMAL_IMPULSE, at)).add(self.v(CONTACT_TANGENT_X, at));
                body_a.push(impulse.scale(-1.0), self.v(CONTACT_ARM_A_X, at));
                body_b.push(impulse, self.v(CONTACT_ARM_B_X, at));
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// One pass over the points. `biased`: the soft pass, which pushes; otherwise the relaxing one, which takes the push's
    /// speed back out and tallies the drift.
    pub fn solve_contacts(&mut self, h: f32, step: Soft, biased: bool, turn: usize) {
        let max_push = self.header().contact_max_push;
        let slop = self.header().contact_slop;
        let threshold = self.bounce_speed(h);
        let mut impacts = self.header().impacts as usize;
        for i in 0..self.header().solving as usize {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            let (center_a, center_b) = (self.v(CENTER_X, a), self.v(CENTER_X, b));
            let (rotation_a, rotation_b) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
            let normal = self.v(PAIR_NORMAL_X, row);
            let tangent = self.v(PAIR_TANGENT_X, row);
            let other = normal.cross(tangent);
            let friction = self.s(PAIR_FRICTION, row);
            let bounce = self.s(PAIR_RESTITUTION, row);
            let count = self.uu(PAIR_CONTACTS, row) as usize;
            for k in 0..count {
                let at = row * MANIFOLD + (k + turn) % count;
                let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));

                // Friction, from the normal impulse so far.
                let pressed = self.s(CONTACT_NORMAL_IMPULSE, at);
                let mut held = self.v(CONTACT_TANGENT_X, at);
                let mut drift = self.v(CONTACT_DRIFT_X, at);
                let relative = body_b.at(arm_b).sub(body_a.at(arm_a));
                let slide = relative.sub(normal.scale(relative.dot(normal)));
                let (mass_scale, impulse_scale, target) = if biased {
                    (step.mass_scale, step.impulse_scale, slide.add(drift.scale(step.bias_rate)))
                } else {
                    drift = drift.add(slide.scale(h));
                    (1.0, 0.0, slide)
                };
                let along = -self.s(CONTACT_TANGENT_MASS, at) * mass_scale * target.dot(tangent) - impulse_scale * held.dot(tangent);
                let across = -self.s(CONTACT_OTHER_MASS, at) * mass_scale * target.dot(other) - impulse_scale * held.dot(other);
                let mut next = held.add(tangent.scale(along)).add(other.scale(across));
                let most = friction * pressed;
                let squared = next.dot(next);
                if squared > most * most {
                    let cut = most / sqrt(squared);
                    next = next.scale(cut);
                    // Only the last word counts: within a substep the first point of a manifold sees the whole load. The
                    // anchor comes along, to where the cone holds it.
                    if !biased {
                        drift = drift.scale(cut);
                    }
                }
                let applied = next.sub(held);
                held = next;
                body_a.push(applied.scale(-1.0), arm_a);
                body_b.push(applied, arm_b);
                self.set_v(CONTACT_TANGENT_X, at, held);
                self.set_v(CONTACT_DRIFT_X, at, drift);
            }
            for k in 0..count {
                let at = row * MANIFOLD + (k + turn) % count;
                let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
                let pressed = self.s(CONTACT_NORMAL_IMPULSE, at);
                // The normal: the gap from where the bodies are now.
                let on_a = center_a.add(rotation_a.rotate(self.v(CONTACT_ANCHOR_A_X, at)));
                let on_b = center_b.add(rotation_b.rotate(self.v(CONTACT_ANCHOR_B_X, at)));
                let gap = on_b.sub(on_a).dot(normal);
                let speed = body_b.at(arm_b).sub(body_a.at(arm_a)).dot(normal);
                let (bias, mass_scale, impulse_scale) = if gap > 0.0 {
                    (gap / h, 1.0, 0.0)
                } else if biased {
                    let depth = gap + slop;
                    let depth = if depth < 0.0 { depth } else { 0.0 };
                    let push = step.bias_rate * depth;
                    (if push > -max_push { push } else { -max_push }, step.mass_scale, step.impulse_scale)
                } else {
                    (0.0, 1.0, 0.0)
                };
                let change = -self.s(CONTACT_NORMAL_MASS, at) * mass_scale * (speed + bias) - impulse_scale * pressed;
                let total = pressed + change;
                let total = if total > 0.0 { total } else { 0.0 };
                // A relaxing pass only takes back. A gap still open is met by the next biased pass, which is where a strike
                // is noticed; acting here would slow the body first and hide it.
                let total = if !biased && gap > 0.0 && total > pressed { pressed } else { total };
                let applied = normal.scale(total - pressed);
                self.set_s(CONTACT_NORMAL_IMPULSE, at, total);
                body_a.push(applied.scale(-1.0), arm_a);
                body_b.push(applied, arm_b);
                if biased && bounce > 0.0 && pressed == 0.0 && total > 0.0 && speed < -threshold {
                    self.set_s(CONTACT_APPROACH, at, speed);
                    self.set_u(IMPACTS, impacts, at as u32);
                    impacts += 1;
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
        self.header_mut().impacts = impacts as u32;
    }

    /// Speed under which a contact is rest: two substeps of gravity.
    fn bounce_speed(&self, h: f32) -> f32 {
        let g = self.header().gravity;
        2.0 * sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) * h
    }

    /// Sends the points struck in this substep off at their restitution, after relaxing took the push back out.
    pub fn solve_impacts(&mut self) {
        for i in 0..self.header().impacts as usize {
            let at = self.uu(IMPACTS, i) as usize;
            let row = at / MANIFOLD;
            let (a, b) = self.pair_bodies(row as u32);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            let normal = self.v(PAIR_NORMAL_X, row);
            let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
            let speed = body_b.at(arm_b).sub(body_a.at(arm_a)).dot(normal);
            let wanted = -self.s(PAIR_RESTITUTION, row) * self.s(CONTACT_APPROACH, at);
            let pressed = self.s(CONTACT_NORMAL_IMPULSE, at);
            let total = pressed + self.s(CONTACT_NORMAL_MASS, at) * (wanted - speed);
            let total = if total > 0.0 { total } else { 0.0 };
            let applied = normal.scale(total - pressed);
            self.set_s(CONTACT_NORMAL_IMPULSE, at, total);
            body_a.push(applied.scale(-1.0), arm_a);
            body_b.push(applied, arm_b);
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
        self.header_mut().impacts = 0;
    }
}
