// One step: impulses once, then per substep the velocity update and the pose update. The contact and joint passes of the
// solver go between those two. Forces stay in their columns and reach every substep; impulses land once, before the
// first. Both are the kernel's contract, from Margo's ragdoll findings: a force given as an impulse before the first pass
// lets one pass's friction take a whole step's kick.
use crate::joints::Pass;
use crate::layout::*;
use crate::math::*;
use crate::solver::{Soft, soft};
use crate::world::{NONE, Window, World};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Milliseconds on a clock that only goes forward; it times the phases of a step and nothing reads it back into one.
    fn clock() -> f64;
}
#[cfg(target_arch = "wasm32")]
#[inline(always)]
pub(crate) fn now() -> f64 {
    unsafe { clock() }
}
#[cfg(not(target_arch = "wasm32"))]
#[inline(always)]
pub(crate) fn now() -> f64 {
    0.0
}
/// What `World::timing` holds: the whole step, then the phases in order. Begin is the start of the step (impulses land,
/// kinematic targets are read); Solver is the contact and joint rows and every substep; Events lists what pairs began or
/// ended touching.
pub const PHASES: [&str; 15] = [
    "step", "begin", "broad", "narrow", "islands", "solver", "ccd", "events", "assembly", "resolution", "update", "writeback", "ccdBroad",
    "ccdToi", "ccdSolver",
];

/// The clock readings a step carries from `step_begin` to `step_end`.
#[derive(Clone, Copy)]
pub struct StepTimes {
    begun: f64,
    stamp: f64,
}

/// Adds the time since `since` to a slot of the timings and starts the next stretch there: the finer timers of the solver and
/// the sweep, which are sums over the substeps and the bodies.
#[inline(always)]
pub(crate) fn tick(world: &mut World, slot: usize, since: &mut f64) {
    let at = now();
    world.timing[slot] += (at - *since) as f32;
    *since = at;
}

/// A position or speed past this leaves a step nothing to work with: their squares and the rows built from them reach the
/// end of f32 within the step. A true path can get here, as a bead on a spinning rail flies out exponentially, so a step
/// refuses it. Nothing bends the value.
pub const RANGE: f32 = 1e15;

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

    /// The pose a kinematicPosition body reaches at the end of the next step; the body wakes.
    pub fn set_target(&mut self, body: u32, position: V3, rotation: Q) {
        if self.body_alive(body) {
            self.set_v(TARGET_X, body as usize, position);
            self.set_q(TARGET_ROTATION_X, body as usize, rotation.normalized());
            // A target wakes the body, as on Rapier.
            self.wake(body);
        }
    }

    /// Advances the world by `dt` in `substeps` equal pieces. Pairs are found once a step, over the motion the whole step
    /// is expected to make. The same as `step_begin`, `solve_island` for every island and `step_end`, which is how threads
    /// share a step: the islands solve on views of the world (`thread_view`), each on its own state alone.
    pub fn step(&mut self, dt: f32) {
        let Some(times) = self.step_begin(dt) else { return };
        if self.island_major {
            for group in 0..self.header().islands as usize {
                self.solve_island(group, dt);
            }
        }
        self.step_end(dt, times);
    }

    /// The step up to its islands' solves: the broad and narrow phases, the islands, the rows, and each island's level of
    /// substeps and multibody stamps (`plan_islands`). None when the world was lost and does not step.
    pub fn step_begin(&mut self, dt: f32) -> Option<StepTimes> {
        if self.header().lost != NONE {
            return None;
        }
        let substeps = self.header().substeps;
        self.header_mut().step_dt = dt;
        let begun = now();
        let mut stamp = begun;
        // Closes a phase: the time since the last stamp, in milliseconds, goes in its slot.
        let mut lap = |world: &mut World, phase: usize| {
            let at = now();
            world.timing[phase] = (at - stamp) as f32;
            stamp = at;
        };
        for sub in 8..self.timing.len() {
            self.timing[sub] = 0.0;
        }
        self.canonical_lists();
        self.spin_rotors();
        self.begin_step(dt);
        lap(self, 1);
        self.broad_update(dt);
        lap(self, 2);
        self.narrow_phase(dt);
        lap(self, 3);
        self.update_islands(dt);
        lap(self, 4);
        let mut inner = now();
        self.prepare_contacts();
        self.prepare_joints();
        self.order_couplings_by_island();
        tick(self, 8, &mut inner);
        if self.island_major {
            self.plan_islands(dt, substeps);
        }
        Some(StepTimes { begun, stamp })
    }

    /// Each island's level of substeps (`island_level`, from its own state alone) and the first multibody stamp of its walks,
    /// in island order, into ISLAND_LEVEL and ISLAND_STAMP: what lets the islands solve at once, in any order, to the bits of
    /// one after another.
    fn plan_islands(&mut self, dt: f32, substeps: u32) {
        let adaptive = self.header().adaptive_substeps != 0;
        for group in 0..self.header().islands as usize {
            self.window = self.group_window(group);
            // An island a body asks extra substeps of steps at the world's plus the most any of them asks (Rapier's
            // `additional_solver_iterations`), and its adaptive level cuts that count finer.
            let base = substeps.saturating_add(self.uu(ISLAND_SUBSTEPS, group));
            let level = if adaptive { self.island_level(dt, base) } else { 0 };
            self.set_u(ISLAND_LEVEL, group, level);
            self.claim_stamps(base << level);
            self.set_u(ISLAND_STAMP, group, self.window.mb_call);
        }
    }

    /// Island `group` of the step `step_begin` began, through all its substeps at its planned level. Islands share no body a
    /// solve changes, so any number of them may solve at once, each on its own view of the world. The kinematic bodies'
    /// columns keep the pose the step began at while the islands solve, and each substep reads them through the stage it is at.
    pub fn solve_island(&mut self, group: usize, dt: f32) {
        let mut inner = now();
        self.window = self.group_window(group);
        let level = self.uu(ISLAND_LEVEL, group);
        let extra = self.uu(ISLAND_SUBSTEPS, group);
        let count = self.header().substeps.saturating_add(extra) << level;
        let hi = dt / count as f32;
        self.window.substeps = count;
        self.window.mb_call = self.uu(ISLAND_STAMP, group);
        self.rescale_warm(level, extra);
        let (raw, damping) = (self.header().contact_hertz, self.header().contact_damping);
        let stiffness = soft(if raw * hi > 0.25 { 0.25 / hi } else { raw }, damping, hi);
        self.run_substeps(hi, count, stiffness, &mut inner, true);
        self.keep_level(level, extra);
    }

    /// The step after its islands: what no island holds, the kinematic bodies' moves, joint breaking, continuous collision
    /// and the events.
    pub fn step_end(&mut self, dt: f32, times: StepTimes) {
        let substeps = self.header().substeps;
        let h = dt / substeps as f32;
        let mut inner = now();
        // A soft constraint stiffer than a quarter of the substep rate shakes a pile the passes cannot settle (measured).
        let (hertz, damping) = (self.header().contact_hertz, self.header().contact_damping);
        let hertz = if hertz * h > 0.25 { 0.25 / h } else { hertz };
        let stiffness = soft(hertz, damping, h);
        if self.island_major {
            // What no island holds (a pair or a joint of bodies that cannot move), at the world's substeps.
            self.window = self.group_window(self.header().islands as usize);
            self.window.substeps = substeps;
            self.claim_stamps(substeps);
            self.rescale_warm(0, 0);
            self.run_substeps(h, substeps, stiffness, &mut inner, true);
            self.keep_level(0, 0);
            self.window = self.whole_window();
            self.integrate_kinematics(h, substeps);
        } else {
            // All islands at once, at the world's substeps plus the most any island asks for.
            let extra = (0..self.header().islands as usize).map(|g| self.uu(ISLAND_SUBSTEPS, g)).max().unwrap_or(0);
            let count = substeps.saturating_add(extra);
            self.window = self.whole_window();
            self.claim_stamps(count);
            if extra == 0 {
                self.run_substeps(h, substeps, stiffness, &mut inner, false);
            } else {
                let hc = dt / count as f32;
                let hertz = self.header().contact_hertz;
                let stiffness = soft(if hertz * hc > 0.25 { 0.25 / hc } else { hertz }, damping, hc);
                self.run_substeps(hc, count, stiffness, &mut inner, false);
            }
            // The extra this step took, for the break loads and a later island-by-island step's warm start; levels untouched.
            let (column, start, end) = self.window.bodies;
            for i in start..end {
                let at = self.uu(column, i) as usize;
                self.set_u(SUBSTEP_EXTRA, at, extra);
            }
        }
        let mut stamp = times.stamp;
        let mut lap = |world: &mut World, phase: usize| {
            let at = now();
            world.timing[phase] = (at - stamp) as f32;
            stamp = at;
        };
        self.break_joints(h);
        tick(self, 11, &mut inner);
        lap(self, 5);
        if self.header().ccd_substeps > 0 {
            self.ccd_pass();
        }
        lap(self, 6);
        self.gather_events();
        self.land_meshes();
        lap(self, 7);
        self.timing[0] = (stamp - times.begun) as f32;
        self.header_mut().steps += 1;
        self.check_range();
    }

    /// The substeps of a step over the lists in `self.window`: the whole world, or one island. `staged` has the kinematic bodies
    /// read at the pose of the substep's stage (see `Window`), and leaves moving them to `integrate_kinematics`.
    fn run_substeps(&mut self, h: f32, substeps: u32, stiffness: Soft, inner: &mut f64, staged: bool) {
        for substep in 0..substeps {
            self.window.substep = substep;
            if staged {
                self.window.kin = Some(substep);
            }
            self.integrate_velocities(h);
            tick(self, 10, inner);
            self.hold_multibodies();
            self.refresh_joints();
            self.note_approach();
            self.warm_start();
            self.warm_start_joints();
            self.warm_start_couplings();
            // An island that asks for e extra passes takes the last iterations + e of iterations + most, so it runs as a world of
            // iterations + e would and the pushing pass stays the last for all. `least` is the fewest extra passes a row's
            // island must ask for to join a pass.
            let (passes, most) = (self.header().iterations, self.header().extra_passes);
            // Only a settling pass teaches the warm start what a joint carries.
            if passes < 2 {
                self.solve_joints(h, stiffness, Pass::Settle, 0, 2 - passes);
            }
            // Any u32 is a valid count, as on Rapier: the sum saturates instead of wrapping to a few passes.
            let all = passes.saturating_add(most);
            // How many relaxing passes follow: as many as pushing ones unless the world sets a count (Rapier's
            // `num_internal_stabilization_iterations`).
            let relaxes = match self.header().stabilization {
                NONE => all.max(1),
                set => set,
            };
            for pass in 1..=all {
                let least = most.saturating_add(1).saturating_sub(pass);
                self.solve_joints(h, stiffness, if pass == all { Pass::Push } else { Pass::Settle }, least, u32::MAX);
                self.solve_couplings(h, pass == all);
                // With no relaxing pass the last pushing one is the last word, and friction is always solved in it.
                self.solve_contacts(h, stiffness, true, substep as usize, least, relaxes == 0 && pass == all);
            }
            self.spring_multibodies(h);
            self.clamp_speeds();
            tick(self, 9, inner);
            self.integrate_poses(h, substep, substeps);
            if staged {
                self.window.kin = Some(substep + 1);
            }
            self.refresh_turned_contacts();
            self.track_couplings(h);
            self.fk_multibodies(h);
            self.tally_drift(h);
            self.refresh_joints();
            tick(self, 10, inner);
            // As many relaxing passes as pushing ones: one pass does not take the anchors' push back out of a deep pile, and
            // what it leaves is speed no force gave (a pyramid of 14 rows or more rocks for good). An island with e extra
            // passes relaxes iterations + e times, at least once, so it still runs as a world of iterations + e would: it takes
            // the last of them, and `least` is the fewest extra passes that ask for a pass `need` from the end.
            for pass in 1..=relaxes {
                let need = relaxes - (pass - 1);
                // A count the world sets is every island's, with no gate by its extra passes.
                let least = if need <= 1 || self.header().stabilization != NONE { 0 } else { need.saturating_sub(passes) };
                self.solve_joints(h, stiffness, Pass::Relax, least, u32::MAX);
                self.solve_contacts(h, stiffness, false, substep as usize, least, pass == relaxes);
            }
            self.solve_impacts();
            self.project_multibodies();
            self.clamp_speeds();
            tick(self, 9, inner);
        }
        if staged {
            self.window.kin = None;
        }
    }

    /// The window on one group of the step's lists: island `group`'s runs of pairs, joints and couplings and its bodies, or, for the
    /// group after the last island, what no island holds (a pair or a joint of bodies that cannot move), with no bodies.
    pub fn group_window(&self, group: usize) -> Window {
        let h = self.header();
        let islands = h.islands as usize;
        let run = |start: usize, count: usize| (start, start + count);
        if group < islands {
            let (first, count) = (self.uu(ISLAND_START, group) as usize, self.uu(ISLAND_COUNT, group) as usize);
            Window {
                bodies: (ISLAND_BODIES, first, first + count),
                pairs: run(self.uu(ISLAND_PAIR_START, group) as usize, self.uu(ISLAND_PAIR_COUNT, group) as usize),
                joints: run(self.uu(ISLAND_JOINT_START, group) as usize, self.uu(ISLAND_JOINT_COUNT, group) as usize),
                couplings: run(self.uu(ISLAND_COUPLING_START, group) as usize, self.uu(ISLAND_COUPLING_COUNT, group) as usize),
                kin: None,
                substeps: 0,
                impacts: 0,
                mb_call: 0,
                substep: 0,
            }
        } else {
            let end = |start: usize, count: usize| start + count;
            let last = islands.wrapping_sub(1);
            let after = |s: usize, c: usize, total: usize| if islands == 0 { 0 } else { end(self.uu(s, last) as usize, self.uu(c, last) as usize) }.min(total);
            Window {
                bodies: (ISLAND_BODIES, 0, 0),
                pairs: (after(ISLAND_PAIR_START, ISLAND_PAIR_COUNT, h.solving as usize), h.solving as usize),
                joints: (after(ISLAND_JOINT_START, ISLAND_JOINT_COUNT, h.joint_solving as usize), h.joint_solving as usize),
                couplings: (after(ISLAND_COUPLING_START, ISLAND_COUPLING_COUNT, h.coupling_rows as usize), h.coupling_rows as usize),
                kin: None,
                substeps: 0,
                impacts: 0,
                mb_call: 0,
                substep: 0,
            }
        }
    }

    /// A body's velocity and spin over substep `substep`: its columns' (`linear`, `angular`), or for a kinematicPosition body on
    /// a smooth path, its chord over that substep (`smooth_velocity`).
    #[inline(always)]
    pub fn kinematic_velocity(&self, at: usize, substep: u32, substeps: u32, linear: V3, angular: V3) -> (V3, V3) {
        if self.flags(at) & (KIND | SMOOTH_PATH) == KINEMATIC_POSITION | SMOOTH_PATH {
            self.smooth_velocity(at, substep, substeps)
        } else {
            (linear, angular)
        }
    }

    /// A kinematicPosition body's chord velocity and spin over substep `substep` of its step, on the cubic Hermite path from its
    /// pose at the step's start (PREVIOUS) at the speeds it began with (START_LINEAR, START_ANGULAR) to its target at the speeds
    /// it is to reach it with (TARGET_LINEAR, TARGET_ANGULAR). With tau the step's share gone and dt the step, the path from
    /// its start is D h01(tau) + dt (v0 h10(tau) + v1 h11(tau)), h01 = 3 tau^2 - 2 tau^3, h10 = tau^3 - 2 tau^2 + tau,
    /// h11 = tau^3 - tau^2, D the move to the target; the turn the same on the rotation vector of the step's turn. Its speed
    /// changes through the step and is the same across a step's end, so a prop riding it takes its acceleration through the
    /// step and not all in the step's first substep (KB-PHYS-KINJUMP1).
    ///
    /// The spin is the turn the poses of `kinematic_pose` make over the substep, exp(b) exp(a)^-1 for the path's rotation
    /// vectors a and b at the substep's ends, and the velocity is its centre's. Where the spin's axis swings through a step (a
    /// deck that rolls and pitches at once), that turn is not b - a: rotations do not commute, and the rest is the Baker,
    /// Campbell and Hausdorff series, b - a + (a x b) / 2 + (a + b) x (a x b) / 12 to third order (the bracket of rotation
    /// vectors is their cross product). Spun at b - a, a prop's friction followed a deck that went elsewhere: a block 57 m
    /// aft on a rolling, pitching deck slid 1.4 mm in 36 s, where the same loads on a still floor moved it 0.02 mm. The
    /// series is taken in place of the turn read off the two poses' quaternions, whose f32 rounding is a ten millionth of a
    /// radian, 6 microns at 60 m every substep.
    pub fn smooth_velocity(&self, at: usize, substep: u32, substeps: u32) -> (V3, V3) {
        let dt = self.header().step_dt;
        let h = dt / substeps as f32;
        let n = substeps as f32;
        let (a, b) = (substep as f32 / n, (substep + 1) as f32 / n);
        let basis = |t: f32| (t * t * (3.0 - 2.0 * t), t * (t * t - 2.0 * t + 1.0), t * t * (t - 1.0));
        let ((pa, sa, ea), (pb, sb, eb)) = (basis(a), basis(b));
        let (dp, ds, de) = (pb - pa, (sb - sa) * dt, (eb - ea) * dt);
        let along = |d: V3, v0: V3, v1: V3| d.scale(dp).add(v0.scale(ds)).add(v1.scale(de));
        let moved = self.v(TARGET_X, at).sub(self.v(PREVIOUS_X, at));
        let mut turn = self.q(TARGET_ROTATION_X, at).mul(self.q(PREVIOUS_ROTATION_X, at).conjugate());
        if turn.w < 0.0 {
            turn = Q { x: -turn.x, y: -turn.y, z: -turn.z, w: -turn.w };
        }
        let turn = turn.to_rotation_vector();
        let (spin_start, spin_end) = (self.v(START_ANGULAR_X, at), self.v(TARGET_ANGULAR_X, at));
        // The rotation vector at the substep's start, and its change over the substep.
        let from = turn.scale(pa).add(spin_start.scale(sa * dt)).add(spin_end.scale(ea * dt));
        let step = along(turn, spin_start, spin_end);
        let bend = from.cross(step);
        let spun = step.add(bend.scale(0.5)).add(from.add(from).add(step).cross(bend).scale(1.0 / 12.0));
        let mut shift = along(moved, self.v(START_LINEAR_X, at), self.v(TARGET_LINEAR_X, at));
        // The centre off the body's origin is carried round by the substep's turn as well.
        let local = self.v(LOCAL_CENTER_X, at);
        if local.dot(local) > 0.0 {
            let arm = self.kinematic_pose(at, substep, substeps).2.rotate(local);
            shift = shift.add(spun.cross(arm).sub(spun.cross(spun.cross(arm)).scale(0.5)));
        }
        (shift.scale(1.0 / h), spun.scale(1.0 / h))
    }

    /// A kinematicPosition body's pose at the end of substep `substep` of its step, from its pose at the step's start
    /// (PREVIOUS) along its path: the straight move and turn toward its target, or on a smooth path (SMOOTH_PATH) the cubic of
    /// `smooth_velocity`, its turn as the rotation vector so far applied to the start in one product. Built up substep by
    /// substep instead, the f32 products of its turns drifted from its target by a few millionths of a radian over 64
    /// substeps, and its snap onto the target at the step's end moved a deck point 60 m out by 0.4 mm in one substep, which
    /// no friction on it can hold (`a_plate_rides_a_deck_on_a_smooth_path_for_minutes_at_any_substeps`).
    pub fn kinematic_pose(&self, at: usize, substep: u32, substeps: u32) -> (V3, V3, Q) {
        let local = self.v(LOCAL_CENTER_X, at);
        if substep + 1 >= substeps {
            let (position, rotation) = (self.v(TARGET_X, at), self.q(TARGET_ROTATION_X, at));
            return (position, position.add(rotation.rotate(local)), rotation);
        }
        let t = (substep + 1) as f32 / substeps as f32;
        let (start, start_rotation) = (self.v(PREVIOUS_X, at), self.q(PREVIOUS_ROTATION_X, at));
        let moved = self.v(TARGET_X, at).sub(start);
        let mut turn = self.q(TARGET_ROTATION_X, at).mul(start_rotation.conjugate());
        if turn.w < 0.0 {
            turn = Q { x: -turn.x, y: -turn.y, z: -turn.z, w: -turn.w };
        }
        let turn = turn.to_rotation_vector();
        let (shift, spun) = if self.flags(at) & SMOOTH_PATH != 0 {
            let dt = self.header().step_dt;
            let (p, sv, ev) = (t * t * (3.0 - 2.0 * t), t * (t * t - 2.0 * t + 1.0) * dt, t * t * (t - 1.0) * dt);
            (
                moved.scale(p).add(self.v(START_LINEAR_X, at).scale(sv)).add(self.v(TARGET_LINEAR_X, at).scale(ev)),
                turn.scale(p).add(self.v(START_ANGULAR_X, at).scale(sv)).add(self.v(TARGET_ANGULAR_X, at).scale(ev)),
            )
        } else {
            (moved.scale(t), turn.scale(t))
        };
        let rotation = Q::from_rotation_vector(spun).mul(start_rotation).normalized();
        let position = start.add(shift);
        (position, position.add(rotation.rotate(local)), rotation)
    }

    /// The pose of a kinematic body at the stage of the substep being solved (`Window::kin`): what `integrate_poses` has made of
    /// it after that many substeps from the pose the step began at, worked out here with the same arithmetic in the same order,
    /// and written nowhere. A body that is not kinematic and awake, or a solve with no stage, gives None.
    fn staged_pose(&self, at: usize) -> Option<(V3, V3, Q)> {
        let stage = self.window.kin?;
        let kind = self.flags(at) & KIND;
        if stage == 0 || (kind != KINEMATIC_POSITION && kind != KINEMATIC_VELOCITY) || !self.is_awake(at) {
            return None;
        }
        let substeps = if self.window.substeps > 0 { self.window.substeps } else { self.header().substeps };
        if kind == KINEMATIC_POSITION {
            return Some(self.kinematic_pose(at, stage - 1, substeps));
        }
        let h = self.header().step_dt / substeps as f32;
        let (linear, angular, local) = (self.v(LINEAR_X, at), self.v(ANGULAR_X, at), self.v(LOCAL_CENTER_X, at));
        let (mut position, mut center, mut rotation) = (self.v(POSITION_X, at), self.v(CENTER_X, at), self.q(ROTATION_X, at));
        for step in 1..=stage {
            if step == substeps && kind == KINEMATIC_POSITION {
                rotation = self.q(TARGET_ROTATION_X, at);
                position = self.v(TARGET_X, at);
                center = position.add(rotation.rotate(local));
                continue;
            }
            let (linear, angular) = self.kinematic_velocity(at, step - 1, substeps, linear, angular);
            center = center.add(linear.scale(h));
            let turn = Q::from_rotation_vector(angular.scale(h));
            rotation = turn.mul(rotation).normalized();
            position = center.sub(rotation.rotate(local));
        }
        Some((position, center, rotation))
    }

    /// A body's rotation, centre of mass and origin as the solve reads them: the columns, but for a kinematic body at a stage.
    #[inline(always)]
    pub fn pose_rotation(&self, at: usize) -> Q {
        if self.window.kin.is_none() { return self.q(ROTATION_X, at); }
        self.staged_pose(at).map_or_else(|| self.q(ROTATION_X, at), |pose| pose.2)
    }
    #[inline(always)]
    pub fn pose_center(&self, at: usize) -> V3 {
        if self.window.kin.is_none() { return self.v(CENTER_X, at); }
        self.staged_pose(at).map_or_else(|| self.v(CENTER_X, at), |pose| pose.1)
    }
    #[inline(always)]
    pub fn pose_position(&self, at: usize) -> V3 {
        if self.window.kin.is_none() { return self.v(POSITION_X, at); }
        self.staged_pose(at).map_or_else(|| self.v(POSITION_X, at), |pose| pose.0)
    }

    /// After the islands have solved with the kinematic bodies read at their stages: moves every awake kinematic body through the
    /// substeps, as `integrate_poses` does in a step that solves phase by phase.
    fn integrate_kinematics(&mut self, h: f32, substeps: u32) {
        for substep in 0..substeps {
            self.window.substep = substep;
            for slot in 0..self.header().awake as usize {
                let at = self.uu(AWAKE, slot) as usize;
                if self.flags(at) & KIND != DYNAMIC {
                    self.integrate_pose(at, h, substep, substeps);
                }
            }
        }
    }

    /// Finds what touches what without moving anything: the broad and narrow phases and the events they give, as Rapier's collision
    /// pipeline (and a physics step of no time) does. No velocity changes, no pose changes, nothing falls asleep; a pair that begins
    /// or ends touching gives its event as in a step. The impulses and targets waiting for the next step stay waiting.
    pub fn detect(&mut self) {
        if self.header().lost != NONE {
            return;
        }
        self.header_mut().step_dt = 0.0;
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            let (position, rotation) = (self.v(POSITION_X, at), self.q(ROTATION_X, at));
            self.set_v(CENTER_X, at, position.add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
        }
        self.broad_update(0.0);
        self.narrow_phase(0.0);
        self.gather_events();
    }

    /// Notes the first awake body past RANGE, or not a number at all. With quarantine on, each such body is taken out of the world
    /// instead (QUARANTINED and DISABLED, at rest, at the pose the step began from when that is in range, else the origin) and the
    /// world steps on; a step's numbers that reached other bodies through a contact leave them out of range too, and they follow.
    pub fn check_range(&mut self) {
        let quarantine = self.header().quarantine != 0;
        loop {
            let mut bad = NONE as usize;
            'scan: for slot in 0..self.header().awake as usize {
                let at = self.uu(AWAKE, slot) as usize;
                if self.flags(at) & DISABLED != 0 {
                    continue;
                }
                for v in [self.v(POSITION_X, at), self.v(LINEAR_X, at), self.v(ANGULAR_X, at)] {
                    for x in [v.x, v.y, v.z] {
                        if !(x < RANGE && x > -RANGE) {
                            bad = at;
                            break 'scan;
                        }
                    }
                }
            }
            if bad == NONE as usize {
                return;
            }
            if !quarantine {
                self.header_mut().lost = bad as u32;
                return;
            }
            let before = self.v(PREVIOUS_X, bad);
            let finite = [before.x, before.y, before.z].iter().all(|x| *x < RANGE && *x > -RANGE);
            let rest = if finite { before } else { v3(0.0, 0.0, 0.0) };
            let still = self.q(PREVIOUS_ROTATION_X, bad);
            let turn = if still.x.is_finite() && still.y.is_finite() && still.z.is_finite() && still.w.is_finite() { still } else { Q::IDENTITY };
            self.set_v(LINEAR_X, bad, v3(0.0, 0.0, 0.0));
            self.set_v(ANGULAR_X, bad, v3(0.0, 0.0, 0.0));
            self.set_pose(bad as u32, rest, turn, false);
            self.set_body_enabled(bad as u32, false);
            self.set_u(FLAGS, bad, self.flags(bad) | QUARANTINED);
            self.header_mut().quarantined += 1;
        }
    }

    /// Keeps the pose the step starts from, finds each centre of mass, lands impulses, works out kinematic velocities.
    pub fn begin_step(&mut self, dt: f32) {
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            let kind = self.flags(at) & KIND;
            let position = self.v(POSITION_X, at);
            let rotation = self.q(ROTATION_X, at);
            // A dynamic body whose pose was pushed in the last step is not at rest, though its velocity is.
            if kind == DYNAMIC && self.flags(at) & (CAN_SLEEP | ASKED_TO_SLEEP) == CAN_SLEEP {
                let (limit, energy) = (self.s(SLEEP_LIMIT, at), self.pose_energy(at, dt));
                if energy > if limit > 0.0 { limit } else { self.header().sleep_energy } {
                    self.set_s(SLEEP_TIME, at, 0.0);
                }
            }
            self.set_v(PREVIOUS_X, at, position);
            self.set_q(PREVIOUS_ROTATION_X, at, rotation);
            self.set_s(TURNED, at, 0.0);
            self.set_v(CENTER_X, at, position.add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
            if kind == DYNAMIC {
                let frame = rotation.mul(self.q(INERTIA_FRAME_X, at));
                let angular_locks = (self.flags(at) & LOCK_ANGULAR) / LOCK_ANGULAR_X;
                let impulse = lock(self.v(ANGULAR_IMPULSE_X, at), angular_locks);
                let turn = apply_inverse_inertia(self.v(INVERSE_INERTIA_X, at), frame, impulse);
                let linear = self.v(LINEAR_X, at).add(self.v(IMPULSE_X, at).scale(self.s(INVERSE_MASS, at)));
                self.set_v(LINEAR_X, at, linear);
                self.set_v(ANGULAR_X, at, self.v(ANGULAR_X, at).add(turn));
                self.set_v(IMPULSE_X, at, v3(0.0, 0.0, 0.0));
                self.set_v(ANGULAR_IMPULSE_X, at, v3(0.0, 0.0, 0.0));
            } else if kind == KINEMATIC_POSITION {
                let inverse = 1.0 / dt;
                self.set_v(LINEAR_X, at, self.v(TARGET_X, at).sub(position).scale(inverse));
                // A target equal to the pose is no turn. The product with the conjugate leaves rounding of about 1e-15 there,
                // and a body that turns that little would count as moving and keep what rests on it awake for ever.
                let target = self.q(TARGET_ROTATION_X, at);
                let still = target.x == rotation.x && target.y == rotation.y && target.z == rotation.z && target.w == rotation.w;
                let turn = if still { v3(0.0, 0.0, 0.0) } else { target.mul(rotation.conjugate()).to_rotation_vector() };
                self.set_v(ANGULAR_X, at, turn.scale(inverse));
            }
        }
    }

    /// Semi-implicit Euler's velocity half: gravity and forces, the gyroscopic term, then damping and locks.
    pub fn integrate_velocities(&mut self, h: f32) {
        let gravity = self.header().gravity;
        let gravity = v3(gravity[0], gravity[1], gravity[2]);
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
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
            let angular_locks = (flags & LOCK_ANGULAR) / LOCK_ANGULAR_X;
            let torque = lock(self.v(TORQUE_X, at), angular_locks);
            let turn = apply_inverse_inertia(self.v(INVERSE_INERTIA_X, at), frame, torque);
            let mut angular = self.v(ANGULAR_X, at).add(turn.scale(h));
            let inertia = self.v(INERTIA_X, at);
            if flags & (LOCK_ANGULAR | NO_GYROSCOPIC) == 0 && (inertia.x != inertia.y || inertia.y != inertia.z) {
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

    /// Cuts the speed of each awake dynamic body to its cap, keeping the direction; a cap of zero is none. The cut is a
    /// scale by cap over speed, so only the length changes.
    pub fn clamp_speeds(&mut self) {
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            if self.flags(at) & KIND != DYNAMIC {
                continue;
            }
            for (velocity, cap) in [(LINEAR_X, MAX_LINEAR), (ANGULAR_X, MAX_ANGULAR)] {
                let mut cap = self.s(cap, at);
                let world = self.header().max_linear_speed;
                if velocity == LINEAR_X && world > 0.0 && (cap <= 0.0 || world < cap) {
                    cap = world;
                }
                if cap > 0.0 {
                    let v = self.v(velocity, at);
                    let speed = sqrt(v.dot(v));
                    if speed > cap {
                        self.set_v(velocity, at, v.scale(cap / speed));
                    }
                }
            }
        }
    }

    /// Semi-implicit Euler's position half, with the velocities just updated, so the velocity a body reports is the one
    /// that moved it. A kinematicPosition body lands exactly on its target on the last substep.
    pub fn integrate_poses(&mut self, h: f32, substep: u32, substeps: u32) {
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            self.integrate_pose(at, h, substep, substeps);
        }
    }

    /// One body's pose after a substep's velocities.
    #[inline(always)]
    pub fn integrate_pose(&mut self, at: usize, h: f32, substep: u32, substeps: u32) {
        let last = substep + 1 == substeps;
        let kind = self.flags(at) & KIND;
        if kind == KINEMATIC_POSITION && !last {
            // On its path from the step's start, not built up from the substeps before (`kinematic_pose`).
            let (position, center, rotation) = self.kinematic_pose(at, substep, substeps);
            let turn = rotation.mul(self.q(ROTATION_X, at).conjugate());
            self.set_s(TURNED, at, self.s(TURNED, at) + 2.0 * sqrt(turn.x * turn.x + turn.y * turn.y + turn.z * turn.z));
            self.set_q(ROTATION_X, at, rotation);
            self.set_v(POSITION_X, at, position);
            self.set_v(CENTER_X, at, center);
            return;
        }
        if last && kind == KINEMATIC_POSITION {
            let rotation = self.q(TARGET_ROTATION_X, at);
            let position = self.v(TARGET_X, at);
            self.set_q(ROTATION_X, at, rotation);
            self.set_v(POSITION_X, at, position);
            self.set_v(CENTER_X, at, position.add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
            // A smooth path begins the next step at the speeds it reached this target with.
            if self.flags(at) & SMOOTH_PATH != 0 {
                self.set_v(START_LINEAR_X, at, self.v(TARGET_LINEAR_X, at));
                self.set_v(START_ANGULAR_X, at, self.v(TARGET_ANGULAR_X, at));
            }
            return;
        }
        let (linear, angular) = self.kinematic_velocity(at, substep, substeps, self.v(LINEAR_X, at), self.v(ANGULAR_X, at));
        let center = self.v(CENTER_X, at).add(linear.scale(h));
        let spin = angular.scale(h);
        self.set_s(TURNED, at, self.s(TURNED, at) + sqrt(spin.dot(spin)));
        let turn = Q::from_rotation_vector(spin);
        let rotation = turn.mul(self.q(ROTATION_X, at)).normalized();
        self.set_v(CENTER_X, at, center);
        self.set_q(ROTATION_X, at, rotation);
        self.set_v(POSITION_X, at, center.sub(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
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
