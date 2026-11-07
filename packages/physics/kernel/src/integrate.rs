// One step: impulses once, then per substep the velocity update and the pose update. The contact and joint passes of the
// solver go between those two. Forces stay in their columns and reach every substep; impulses land once, before the
// first. Both are the kernel's contract, from Margo's ragdoll findings: a force given as an impulse before the first pass
// lets one pass's friction take a whole step's kick.
use crate::layout::*;
use crate::math::*;
use crate::solver::soft;
use crate::world::World;

/// World change from a world torque-like vector: I^-1 v, worked in the principal frame `frame`.
#[inline(always)]
pub fn apply_inverse_inertia(inverse: V3, frame: Q, v: V3) -> V3 {
    frame.rotate(inverse.mul(frame.unrotate(v)))
}

/// One implicit-midpoint step of Euler's equations `I w' + w x I w = 0` in the principal frame, by Newton's method.
/// The midpoint keeps kinetic energy and the size of angular momentum, as both are quadratic in w; implicit Euler with one
/// Newton step (Catto 2015) bleeds them, and the explicit step gains energy without bound. Two Newton steps reach f32
/// rounding at ordinary rates. A step may not raise the energy: at spin rates where Newton has not converged the
/// result is scaled back to the energy it started with, which the exact step would hold anyway.
#[inline]
pub fn gyroscopic(inertia: V3, w1: V3, h: f32) -> V3 {
    let start = w1.dot(inertia.mul(w1));
    let half = 0.5 * h;
    let ex = v3(inertia.x, 0.0, 0.0);
    let ey = v3(0.0, inertia.y, 0.0);
    let ez = v3(0.0, 0.0, inertia.z);
    let mut w = w1;
    for _ in 0..2 {
        let m = w.add(w1).scale(0.5);
        let im = inertia.mul(m);
        let f = inertia.mul(w.sub(w1)).add(m.cross(im).scale(h));
        // J = I + h/2 ([m]x I - [I m]x); column k is I e_k + h/2 (m x I e_k - I m x e_k).
        let a = ex.add(m.cross(ex).sub(im.cross(v3(1.0, 0.0, 0.0))).scale(half));
        let b = ey.add(m.cross(ey).sub(im.cross(v3(0.0, 1.0, 0.0))).scale(half));
        let c = ez.add(m.cross(ez).sub(im.cross(v3(0.0, 0.0, 1.0))).scale(half));
        match solve3(a, b, c, f) {
            Some(step) => w = w.sub(step),
            None => break,
        }
    }
    let end = w.dot(inertia.mul(w));
    if end > start { w.scale(sqrt(start / end)) } else { w }
}

impl World {
    #[inline(always)]
    pub fn v(&self, x: usize, at: usize) -> V3 {
        unsafe { v3(*self.f(x).add(at), *self.f(x + 1).add(at), *self.f(x + 2).add(at)) }
    }
    #[inline(always)]
    pub fn set_v(&mut self, x: usize, at: usize, v: V3) {
        unsafe {
            *self.f(x).add(at) = v.x;
            *self.f(x + 1).add(at) = v.y;
            *self.f(x + 2).add(at) = v.z;
        }
    }
    #[inline(always)]
    pub fn q(&self, x: usize, at: usize) -> Q {
        unsafe { Q { x: *self.f(x).add(at), y: *self.f(x + 1).add(at), z: *self.f(x + 2).add(at), w: *self.f(x + 3).add(at) } }
    }
    #[inline(always)]
    pub fn set_q(&mut self, x: usize, at: usize, q: Q) {
        unsafe {
            *self.f(x).add(at) = q.x;
            *self.f(x + 1).add(at) = q.y;
            *self.f(x + 2).add(at) = q.z;
            *self.f(x + 3).add(at) = q.w;
        }
    }
    #[inline(always)]
    pub fn s(&self, column: usize, at: usize) -> f32 {
        self.in_rows(column, at);
        unsafe { *self.f(column).add(at) }
    }
    #[inline(always)]
    pub fn set_s(&mut self, column: usize, at: usize, value: f32) {
        self.in_rows(column, at);
        unsafe { *self.f(column).add(at) = value }
    }
    #[inline(always)]
    pub fn flags(&self, at: usize) -> u32 {
        self.in_rows(FLAGS, at);
        unsafe { *self.u(FLAGS).add(at) }
    }

    /// Puts a body at a pose by hand. The step starts from it, interpolation holds it, and a kinematicPosition body stays
    /// there until given a target. The rotation is normalised here, as `sqrt` belongs to the kernel. A sleeper stays asleep
    /// unless `wake`, and its centre moves with it, so a later wake carries on from the new pose.
    pub fn set_pose(&mut self, body: u32, position: V3, rotation: Q, wake: bool) {
        if !self.body_alive(body) {
            return;
        }
        if wake {
            self.wake(body);
        }
        let at = body as usize;
        let rotation = rotation.normalized();
        for (x, r) in [(POSITION_X, ROTATION_X), (PREVIOUS_X, PREVIOUS_ROTATION_X), (TARGET_X, TARGET_ROTATION_X)] {
            self.set_v(x, at, position);
            self.set_q(r, at, rotation);
        }
        self.set_v(CENTER_X, at, position.add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
        self.mark_moved(body);
    }

    /// The pose a kinematicPosition body reaches at the end of the next step.
    pub fn set_target(&mut self, body: u32, position: V3, rotation: Q) {
        if self.body_alive(body) {
            self.set_v(TARGET_X, body as usize, position);
            self.set_q(TARGET_ROTATION_X, body as usize, rotation.normalized());
        }
    }

    /// Advances the world by `dt` in `substeps` equal pieces. Pairs are found once a step, over the motion the whole step
    /// is expected to make.
    pub fn step(&mut self, dt: f32) {
        let substeps = self.header().substeps;
        let h = dt / substeps as f32;
        self.begin_step(dt);
        self.broad_update(dt);
        self.narrow_phase(dt);
        self.update_islands(dt);
        self.prepare_contacts();
        // A soft constraint stiffer than a quarter of the substep rate shakes a pile the passes cannot settle (measured).
        let (hertz, damping) = (self.header().contact_hertz, self.header().contact_damping);
        let hertz = if hertz * h > 0.25 { 0.25 / h } else { hertz };
        let stiffness = soft(hertz, damping, h);
        for substep in 0..substeps {
            self.integrate_velocities(h);
            self.warm_start();
            for _ in 0..self.header().iterations {
                self.solve_contacts(h, stiffness, true, substep as usize);
            }
            self.integrate_poses(h, substep + 1 == substeps);
            self.solve_contacts(h, stiffness, false, substep as usize);
            self.solve_impacts();
        }
        self.header_mut().steps += 1;
    }

    /// Keeps the pose the step starts from, finds each centre of mass, lands impulses, works out kinematic velocities.
    fn begin_step(&mut self, dt: f32) {
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            let kind = self.flags(at) & KIND;
            let position = self.v(POSITION_X, at);
            let rotation = self.q(ROTATION_X, at);
            self.set_v(PREVIOUS_X, at, position);
            self.set_q(PREVIOUS_ROTATION_X, at, rotation);
            self.set_v(CENTER_X, at, position.add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
            if kind == DYNAMIC {
                let frame = rotation.mul(self.q(INERTIA_FRAME_X, at));
                let turn = apply_inverse_inertia(self.v(INVERSE_INERTIA_X, at), frame, self.v(ANGULAR_IMPULSE_X, at));
                let linear = self.v(LINEAR_X, at).add(self.v(IMPULSE_X, at).scale(self.s(INVERSE_MASS, at)));
                self.set_v(LINEAR_X, at, linear);
                self.set_v(ANGULAR_X, at, self.v(ANGULAR_X, at).add(turn));
                self.set_v(IMPULSE_X, at, v3(0.0, 0.0, 0.0));
                self.set_v(ANGULAR_IMPULSE_X, at, v3(0.0, 0.0, 0.0));
            } else if kind == KINEMATIC_POSITION {
                let inverse = 1.0 / dt;
                self.set_v(LINEAR_X, at, self.v(TARGET_X, at).sub(position).scale(inverse));
                let turn = self.q(TARGET_ROTATION_X, at).mul(rotation.conjugate());
                self.set_v(ANGULAR_X, at, turn.to_rotation_vector().scale(inverse));
            }
        }
    }

    /// Semi-implicit Euler's velocity half: gravity and forces, the gyroscopic term, then damping and locks.
    fn integrate_velocities(&mut self, h: f32) {
        let gravity = self.header().gravity;
        let gravity = v3(gravity[0], gravity[1], gravity[2]);
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            let flags = self.flags(at);
            if flags & KIND != DYNAMIC {
                continue;
            }
            let inverse_mass = self.s(INVERSE_MASS, at);
            let mut linear = self.v(LINEAR_X, at);
            // A dynamic body with no mass yet has nothing for gravity to act on.
            if inverse_mass > 0.0 {
                linear = linear.add(gravity.scale(self.s(GRAVITY_SCALE, at) * h));
                linear = linear.add(self.v(FORCE_X, at).scale(inverse_mass * h));
            }

            let frame = self.q(ROTATION_X, at).mul(self.q(INERTIA_FRAME_X, at));
            let turn = apply_inverse_inertia(self.v(INVERSE_INERTIA_X, at), frame, self.v(TORQUE_X, at));
            let mut angular = self.v(ANGULAR_X, at).add(turn.scale(h));
            let inertia = self.v(INERTIA_X, at);
            if flags & LOCK_ANGULAR == 0 && (inertia.x != inertia.y || inertia.y != inertia.z) {
                angular = frame.rotate(gyroscopic(inertia, frame.unrotate(angular), h));
            }
            // Implicit Euler of v' = -c v: the factor stays in (0, 1] for any c and h.
            linear = linear.scale(1.0 / (1.0 + h * self.s(LINEAR_DAMPING, at)));
            angular = angular.scale(1.0 / (1.0 + h * self.s(ANGULAR_DAMPING, at)));
            if flags & LOCK_LINEAR != 0 {
                linear = lock(linear, flags / LOCK_LINEAR_X);
            }
            if flags & LOCK_ANGULAR != 0 {
                angular = lock(angular, flags / LOCK_ANGULAR_X);
            }
            self.set_v(LINEAR_X, at, linear);
            self.set_v(ANGULAR_X, at, angular);
        }
    }

    /// Semi-implicit Euler's position half, with the velocities just updated, so the velocity a body reports is the one
    /// that moved it. A kinematicPosition body lands exactly on its target on the last substep.
    fn integrate_poses(&mut self, h: f32, last: bool) {
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            let kind = self.flags(at) & KIND;
            if last && kind == KINEMATIC_POSITION {
                let rotation = self.q(TARGET_ROTATION_X, at);
                let position = self.v(TARGET_X, at);
                self.set_q(ROTATION_X, at, rotation);
                self.set_v(POSITION_X, at, position);
                self.set_v(CENTER_X, at, position.add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
                continue;
            }
            let center = self.v(CENTER_X, at).add(self.v(LINEAR_X, at).scale(h));
            let turn = Q::from_rotation_vector(self.v(ANGULAR_X, at).scale(h));
            let rotation = turn.mul(self.q(ROTATION_X, at)).normalized();
            self.set_v(CENTER_X, at, center);
            self.set_q(ROTATION_X, at, rotation);
            self.set_v(POSITION_X, at, center.sub(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
        }
    }
}

/// Zeroes the components whose bit is set, bits 0 to 2 for X, Y, Z.
#[inline(always)]
pub fn lock(v: V3, bits: u32) -> V3 {
    v3(
        if bits & 1 != 0 { 0.0 } else { v.x },
        if bits & 2 != 0 { 0.0 } else { v.y },
        if bits & 4 != 0 { 0.0 } else { v.z },
    )
}
