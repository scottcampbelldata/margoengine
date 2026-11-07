// Motion without contact against closed forms. Bounds come from the method's own error terms plus f32 rounding, never
// from a measured error. Rounding: each add leaves at most half a unit in the last place of the running value.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;
use std::f64::consts::{PI, TAU};

const EPS: f64 = 1.0 / 16_777_216.0; // half an f32 ulp at 1.0

fn dynamic(world: &mut World, inverse_mass: f32, moments: [f32; 3]) -> usize {
    let at = world.add_body(DYNAMIC).unwrap() as usize;
    unsafe {
        *world.f(INVERSE_MASS).add(at) = inverse_mass;
        for k in 0..3 {
            *world.f(INERTIA_X + k).add(at) = moments[k];
            *world.f(INVERSE_INERTIA_X + k).add(at) = 1.0 / moments[k];
        }
    }
    at
}
fn world(g: [f32; 3], substeps: u32) -> World {
    let mut w = World::new(16).unwrap();
    w.header_mut().gravity = g;
    w.header_mut().substeps = substeps;
    w
}
/// The change of angle from `from` to `to`, the short way.
fn unwrap(from: f64, to: f64) -> f64 {
    let mut d = to - from;
    while d > PI {
        d -= TAU;
    }
    while d < -PI {
        d += TAU;
    }
    d
}

#[test]
fn free_fall_follows_the_closed_form_and_the_method_s_own_term() {
    // Semi-implicit Euler gives y = y0 + v0 t - g t^2 / 2 - g h t / 2 exactly: the last term is the method's, so the
    // error against the continuous parabola is g h t / 2, and it halves when h does.
    let g = 9.81f64;
    let (y0, v0) = (100.0f64, 3.0f64);
    let mut errors = vec![];
    for substeps in [1u32, 2, 4, 8] {
        let mut w = world([0.0, -9.81, 0.0], substeps);
        let b = dynamic(&mut w, 1.0, [1.0; 3]);
        w.set_v(POSITION_X, b, v3(0.0, y0 as f32, 0.0));
        w.set_v(LINEAR_X, b, v3(0.0, v0 as f32, 0.0));
        let steps = 240;
        for _ in 0..steps {
            w.step(1.0 / 60.0);
        }
        let t = steps as f64 / 60.0;
        let h = 1.0 / 60.0 / substeps as f64;
        let y = w.v(POSITION_X, b).y as f64;
        let v = w.v(LINEAR_X, b).y as f64;
        let n = steps as f64 * substeps as f64;
        let rounding = n * EPS * 256.0; // |y| and |v| stay under 256
        assert!((y - (y0 + v0 * t - 0.5 * g * t * t - 0.5 * g * h * t)).abs() <= rounding, "substeps {substeps}: y {y}");
        assert!((v - (v0 - g * t)).abs() <= rounding, "substeps {substeps}: v {v}");
        errors.push((y - (y0 + v0 * t - 0.5 * g * t * t)).abs());
    }
    for pair in errors.windows(2) {
        assert!(pair[1] < pair[0] * 0.55, "error must halve with h: {errors:?}");
    }
}

#[test]
fn a_projectile_lands_where_the_range_formula_says() {
    // Launched at 30 degrees from the ground plane; range v^2 sin(2a) / g. Stepping stops at the first y <= 0.
    let (speed, g) = (20.0f64, 9.81f64);
    let angle = 30f64.to_radians();
    let (vx, vy) = (speed * angle.cos(), speed * angle.sin());
    let mut w = world([0.0, -9.81, 0.0], 4);
    let b = dynamic(&mut w, 1.0, [1.0; 3]);
    w.set_v(LINEAR_X, b, v3(vx as f32, vy as f32, 0.0));
    let mut time = 0.0f64;
    let h = 1.0 / 240.0;
    loop {
        w.step(1.0 / 60.0);
        time += 1.0 / 60.0;
        if w.v(POSITION_X, b).y <= 0.0 {
            break;
        }
    }
    let p = w.v(POSITION_X, b);
    // The crossing lies within one step of the landing, and the method's term g h t / 2 lowers the arc: the landing
    // comes early by about that height over the vertical speed.
    let flight = 2.0 * vy / g;
    let early = 0.5 * g * h * flight / vy;
    assert!((p.x as f64 - speed * speed * (2.0 * angle).sin() / g).abs() <= (1.0 / 60.0 + early) * vx, "x {}", p.x);
    assert!((time - flight).abs() <= 1.0 / 60.0 + early, "time {time}");
    assert_eq!(p.z, 0.0);
}

#[test]
fn damping_decays_by_the_implicit_factor_and_towards_the_exponential() {
    let (c, v0) = (2.0f64, 10.0f64);
    for substeps in [1u32, 4, 16] {
        let mut w = world([0.0; 3], substeps);
        let b = dynamic(&mut w, 1.0, [1.0; 3]);
        unsafe { *w.f(LINEAR_DAMPING).add(b) = c as f32 };
        w.set_v(LINEAR_X, b, v3(v0 as f32, 0.0, 0.0));
        for _ in 0..60 {
            w.step(1.0 / 60.0);
        }
        let h = 1.0 / 60.0 / substeps as f64;
        let n = 60.0 * substeps as f64;
        let v = w.v(LINEAR_X, b).x as f64;
        let exact = v0 * (1.0 + h * c).powf(-n);
        assert!((v - exact).abs() <= n * 4.0 * EPS * v0, "substeps {substeps}: {v} against {exact}");
        // ln (1 + hc)^-n = -ct + c^2 h t / 2 - ..., so the ratio to e^-ct is e^(c^2 h t / 2) at first order; t = 1.
        let bound = v0 * (-c).exp() * ((0.5 * c * c * h).exp() - 1.0);
        assert!((v - v0 * (-c).exp()).abs() <= bound + n * 4.0 * EPS * v0, "substeps {substeps}: {v}");
    }
}

#[test]
fn a_force_reaches_every_substep_and_an_impulse_lands_once() {
    // A constant force gives the same velocity at any substep count: a sum over substeps of h F / m, not one kick.
    for substeps in [1u32, 2, 4, 8, 16] {
        let mut w = world([0.0; 3], substeps);
        let b = dynamic(&mut w, 0.5, [1.0; 3]);
        w.set_v(FORCE_X, b, v3(6.0, 0.0, 0.0));
        w.set_v(IMPULSE_X, b, v3(0.0, 4.0, 0.0));
        w.step(1.0 / 60.0);
        let v = w.v(LINEAR_X, b);
        assert!((v.x as f64 - 6.0 * 0.5 / 60.0).abs() < 1e-6, "force at {substeps}: {}", v.x);
        assert_eq!(v.y, 2.0, "an impulse lands once at {substeps} substeps");
        assert_eq!(w.v(IMPULSE_X, b).y, 0.0, "and is gone");
        assert_eq!(w.v(FORCE_X, b).x, 6.0, "the force stays");
        w.step(1.0 / 60.0);
        assert_eq!(w.v(LINEAR_X, b).y, 2.0);
        assert!((w.v(LINEAR_X, b).x as f64 - 2.0 * 6.0 * 0.5 / 60.0).abs() < 2e-6);
    }
}

#[test]
fn an_impulse_moves_the_body_for_the_whole_step() {
    // Landing before the first substep, the impulse's velocity carries the body the whole step.
    let mut w = world([0.0; 3], 4);
    let b = dynamic(&mut w, 1.0, [1.0; 3]);
    w.set_v(IMPULSE_X, b, v3(6.0, 0.0, 0.0));
    w.step(0.5);
    assert_eq!(w.v(POSITION_X, b).x, 3.0);
}

#[test]
fn a_torque_turns_at_tau_over_i_about_a_principal_axis() {
    let mut w = world([0.0; 3], 4);
    let b = dynamic(&mut w, 1.0, [2.0, 4.0, 8.0]);
    w.set_v(TORQUE_X, b, v3(0.0, 2.0, 0.0));
    for _ in 0..60 {
        w.step(1.0 / 60.0);
    }
    let omega = w.v(ANGULAR_X, b);
    assert!((omega.y as f64 - 0.5).abs() < 1e-5, "{omega:?}");
    assert!(omega.x.abs() < 1e-5 && omega.z.abs() < 1e-5, "{omega:?}");
}

#[test]
fn the_reported_velocity_is_the_one_that_moved_the_body() {
    // A first-order quaternion update would turn by 2 atan(w h / 2), under w h. Here 30 rad/s at h = 1/60 for 2 s.
    let mut w = world([0.0; 3], 1);
    let b = dynamic(&mut w, 1.0, [1.0; 3]);
    w.set_v(ANGULAR_X, b, v3(0.0, 0.0, 30.0));
    let mut angle = 0.0f64;
    for _ in 0..120 {
        let before = w.q(ROTATION_X, b);
        w.step(1.0 / 60.0);
        let turn = w.q(ROTATION_X, b).mul(before.conjugate());
        angle += 2.0 * (turn.z as f64).atan2(turn.w as f64);
    }
    assert!((angle - 60.0).abs() < 120.0 * 16.0 * EPS, "{angle}");
}

#[test]
fn a_rotation_vector_round_trips_at_any_size() {
    for angle in [1e-6f32, 0.1, 0.9, 1.0, 1.5, 3.0] {
        let r = v3(0.6, 0.0, 0.8).scale(angle);
        let q = Q::from_rotation_vector(r);
        assert!((q.w as f64 - (angle as f64 / 2.0).cos()).abs() < 1e-6, "{angle}: {q:?}");
        let back = q.to_rotation_vector();
        let error = back.sub(r);
        assert!(error.dot(error).sqrt() < 2e-6 * (1.0 + angle), "{angle}: {back:?}");
    }
    // Above one radian the turn is halved first: many turns land on the right fraction.
    let q = Q::from_rotation_vector(v3(0.0, 0.0, 20.0));
    assert!((q.w as f64 - 10f64.cos()).abs() < 1e-5, "{q:?}");
}

/// The body's symmetry axis in world space, for a body whose third principal axis is the body's Z.
fn axis(w: &World, b: usize) -> V3 {
    w.q(ROTATION_X, b).rotate(v3(0.0, 0.0, 1.0))
}

#[test]
fn a_free_symmetric_top_precesses_at_the_closed_form_rate() {
    // Torque free, I1 = I2: the symmetry axis cones around the fixed angular momentum at |L| / I1, and in the body the
    // angular velocity turns at (I3 - I1) / I1 * w3 (Euler's equations). The midpoint's frequency is (2 / h) atan(h W / 2),
    // low by (h W)^2 / 12 of itself, and the pose turns by the exact exponential, so the bound is those terms plus the
    // fixed offset of the first sample over the run. Energy holds to rounding.
    let (i1, i3) = (1.0f64, 2.0f64);
    let (wt, w3) = (1.0f64, 10.0f64);
    let substeps = 4u32;
    let mut w = world([0.0; 3], substeps);
    let b = dynamic(&mut w, 1.0, [i1 as f32, i1 as f32, i3 as f32]);
    w.set_v(ANGULAR_X, b, v3(wt as f32, 0.0, w3 as f32));
    let l = ((i1 * wt).powi(2) + (i3 * w3).powi(2)).sqrt();
    let rate = l / i1;
    let h = 1.0 / 60.0 / substeps as f64;
    let body_rate = (i3 - i1) / i1 * w3;
    let ln = v3((i1 * wt / l) as f32, 0.0, (i3 * w3 / l) as f32);
    let e1 = v3(ln.z, 0.0, -ln.x);
    let e2 = ln.cross(e1);
    let (mut phase, mut last) = (0.0f64, None::<f64>);
    let steps = 600;
    let e0 = 0.5 * (i1 * wt * wt + i3 * w3 * w3);
    let mut energy_error = 0.0f64;
    for _ in 0..steps {
        w.step(1.0 / 60.0);
        let a = axis(&w, b);
        let now = (a.dot(e2) as f64).atan2(a.dot(e1) as f64);
        if let Some(previous) = last {
            phase += unwrap(previous, now);
        }
        last = Some(now);
        let body = w.q(ROTATION_X, b).unrotate(w.v(ANGULAR_X, b));
        let e = 0.5 * (i1 * ((body.x as f64).powi(2) + (body.y as f64).powi(2)) + i3 * (body.z as f64).powi(2));
        energy_error = energy_error.max((e - e0).abs() / e0);
    }
    let elapsed = (steps - 1) as f64 / 60.0;
    let measured = phase / elapsed;
    let bound = rate * (h * body_rate).powi(2) / 12.0 + 2.0 * (h * rate) / elapsed;
    assert!((measured - rate).abs() <= bound, "rate {measured} against {rate}, bound {bound}");
    assert!(energy_error <= steps as f64 * substeps as f64 * 8.0 * EPS, "energy moved by {energy_error}");
}

/// Precession rate of a heavy top at step `h`, one substep per step.
fn heavy_top(i1: f64, i3: f64, mgl: f64, tilt: f64, spin: f64, p: f64, h: f64, time: f64) -> f64 {
    let mut w = world([0.0; 3], 1);
    let b = dynamic(&mut w, 1.0, [i1 as f32, i1 as f32, i3 as f32]);
    // Body Z is the axis: turn Z onto (sin a, cos a, 0).
    let start = v3(tilt.sin() as f32, tilt.cos() as f32, 0.0);
    let z = v3(0.0, 0.0, 1.0);
    let c = z.cross(start);
    w.set_q(ROTATION_X, b, Q { x: c.x, y: c.y, z: c.z, w: 1.0 + z.dot(start) }.normalized());
    w.set_v(ANGULAR_X, b, v3(0.0, p as f32, 0.0).add(start.scale((spin - p * tilt.cos()) as f32)));
    let steps = (time / h) as usize;
    let (mut phase, mut last) = (0.0f64, None::<f64>);
    for _ in 0..steps {
        // Gravity pulls down at the centre of mass: torque about the tip is l axis x (-m g Y).
        let torque = axis(&w, b).cross(v3(0.0, -1.0, 0.0)).scale(mgl as f32);
        w.set_v(TORQUE_X, b, torque);
        w.step(h as f32);
        let a = axis(&w, b);
        let now = (-(a.z as f64)).atan2(a.x as f64);
        if let Some(previous) = last {
            phase += unwrap(previous, now);
        }
        last = Some(now);
    }
    phase / ((steps - 1) as f64 * h)
}

#[test]
fn a_heavy_top_precesses_at_the_lagrange_rate() {
    // A top on a fixed tip is a free body with moments about the tip and the torque of its weight: its centre of mass
    // does not enter. Steady precession at tilt a satisfies I1 p^2 cos a - I3 s p + m g l = 0, s the spin about the axis
    // (the slow root). Three errors bound the rate over a run of T seconds. The body sees the torque turn at the spin
    // rate, so a step of h gets it wrong by the midpoint's (h s)^2 / 12 and the held torque's (h s)^2 / 24 of the rate; a
    // sixth covers both. The velocity is a half step off the pose, a nutation of h tau / (2 L) radians whose end offset
    // counts at most twice over T. And each step's velocity passes through 16 roundings at most (two frame changes and
    // the Newton steps), which move the axis by that angle over sin a per step of h: the state is f32, so this term grows
    // as h falls.
    let (i1, i3, mgl) = (3.0f64, 1.0f64, 4.0f64);
    let tilt = 30f64.to_radians();
    let (spin, time) = (40.0f64, 4.0f64);
    let p = (i3 * spin - ((i3 * spin).powi(2) - 4.0 * i1 * mgl * tilt.cos()).sqrt()) / (2.0 * i1 * tilt.cos());
    let (torque, momentum) = (mgl * tilt.sin(), i3 * spin);
    for h in [1.0 / 120.0, 1.0 / 240.0, 1.0 / 480.0f64] {
        let discrete = p * (h * spin).powi(2) / 6.0;
        let bound = discrete + 2.0 * (h * torque / (2.0 * momentum)) / (time * tilt.sin()) + 16.0 * EPS / (h * tilt.sin());
        let error = (heavy_top(i1, i3, mgl, tilt, spin, p, h, time) - p).abs();
        assert!(error <= bound, "at h {h}: error {error}, bound {bound}, rate {p}");
    }
}

#[test]
fn energy_holds_on_a_tumbling_box_and_no_spin_rate_can_blow_up() {
    // Dzhanibekov's flip: a turn about the middle axis tumbles. Energy holds; an explicit step would gain it.
    let mut w = world([0.0; 3], 4);
    let b = dynamic(&mut w, 1.0, [1.0, 2.0, 3.0]);
    w.set_v(ANGULAR_X, b, v3(0.01, 5.0, 0.01));
    let energy = |w: &World| {
        let o = w.q(ROTATION_X, b).unrotate(w.v(ANGULAR_X, b));
        0.5 * ((o.x as f64).powi(2) + 2.0 * (o.y as f64).powi(2) + 3.0 * (o.z as f64).powi(2))
    };
    let start = energy(&w);
    let mut flips = 0;
    let mut sign = 1.0f32;
    for _ in 0..1200 {
        w.step(1.0 / 60.0);
        let o = w.q(ROTATION_X, b).unrotate(w.v(ANGULAR_X, b));
        if o.y * sign < 0.0 {
            sign = -sign;
            flips += 1;
        }
    }
    assert!(flips >= 2, "the body tumbles: {flips}");
    assert!((energy(&w) - start).abs() <= 4800.0 * 8.0 * EPS * start, "{} from {start}", energy(&w));
    // Thin rod, absurd rate, h far past Newton's reach: finite, and energy never rises past rounding.
    let mut w = world([0.0; 3], 1);
    let b = dynamic(&mut w, 1.0, [10.0, 10.0, 0.01]);
    w.set_v(ANGULAR_X, b, v3(3000.0, 500.0, 2000.0));
    let top = 0.5 * (10.0 * 3000f64.powi(2) + 10.0 * 500f64.powi(2) + 0.01 * 2000f64.powi(2));
    for _ in 0..2000 {
        w.step(1.0 / 30.0);
        let o = w.q(ROTATION_X, b).unrotate(w.v(ANGULAR_X, b));
        let e = 0.5 * (10.0 * (o.x as f64).powi(2) + 10.0 * (o.y as f64).powi(2) + 0.01 * (o.z as f64).powi(2));
        assert!(e.is_finite() && e <= top * 1.001, "{e}");
    }
}

#[test]
fn locks_hold_a_body_on_its_world_axes() {
    let mut w = world([0.0, -9.81, 0.0], 4);
    let b = dynamic(&mut w, 1.0, [1.0, 2.0, 3.0]);
    unsafe { *w.u(FLAGS).add(b) |= LOCK_LINEAR_X * 2 | LOCK_ANGULAR_X * 5 };
    w.set_v(LINEAR_X, b, v3(1.0, 5.0, 0.0));
    w.set_v(TORQUE_X, b, v3(1.0, 1.0, 1.0));
    for _ in 0..60 {
        w.step(1.0 / 60.0);
    }
    let (p, o) = (w.v(POSITION_X, b), w.v(ANGULAR_X, b));
    assert_eq!(p.y, 0.0, "Y locked against gravity");
    assert!(p.x > 0.9);
    assert_eq!((o.x, o.z), (0.0, 0.0));
    assert!(o.y > 0.4);
}

#[test]
fn a_kinematic_position_body_lands_on_its_target_and_reports_what_moved_it() {
    let mut w = world([0.0, -9.81, 0.0], 4);
    let b = w.add_body(KINEMATIC_POSITION).unwrap() as usize;
    let target = v3(1.0, 2.0, 3.0);
    let turn = Q::from_rotation_vector(v3(0.0, 0.3, 0.0));
    w.set_v(TARGET_X, b, target);
    w.set_q(TARGET_ROTATION_X, b, turn);
    w.step(0.5);
    assert_eq!(w.v(POSITION_X, b), target);
    assert_eq!(w.q(ROTATION_X, b), turn);
    assert_eq!(w.v(LINEAR_X, b), v3(2.0, 4.0, 6.0));
    assert!((w.v(ANGULAR_X, b).y - 0.6).abs() < 1e-6);
    w.step(0.5);
    assert_eq!(w.v(POSITION_X, b), target);
    assert_eq!(w.v(LINEAR_X, b), v3(0.0, 0.0, 0.0));
}

#[test]
fn a_kinematic_velocity_body_ignores_forces_and_a_fixed_one_never_moves() {
    let mut w = world([0.0, -9.81, 0.0], 4);
    let k = w.add_body(KINEMATIC_VELOCITY).unwrap() as usize;
    let f = w.add_body(FIXED).unwrap() as usize;
    w.set_v(LINEAR_X, k, v3(1.0, 0.0, 0.0));
    w.set_v(FORCE_X, k, v3(100.0, 0.0, 0.0));
    w.set_v(LINEAR_X, f, v3(1.0, 0.0, 0.0));
    w.step(1.0);
    assert_eq!(w.v(POSITION_X, k), v3(1.0, 0.0, 0.0));
    assert_eq!(w.v(LINEAR_X, k), v3(1.0, 0.0, 0.0));
    assert_eq!(w.v(POSITION_X, f), v3(0.0, 0.0, 0.0));
}

#[test]
fn a_centre_of_mass_off_the_origin_turns_about_itself() {
    let mut w = world([0.0; 3], 4);
    let b = dynamic(&mut w, 1.0, [1.0; 3]);
    w.set_v(LOCAL_CENTER_X, b, v3(1.0, 0.0, 0.0));
    w.set_v(ANGULAR_X, b, v3(0.0, 0.0, std::f32::consts::PI));
    w.step(1.0); // half a turn
    let p = w.v(POSITION_X, b);
    assert!((p.x - 2.0).abs() < 2e-6 && p.y.abs() < 2e-6, "{p:?}");
    assert!((w.v(CENTER_X, b).x - 1.0).abs() < 1e-6);
}
