// The contact solver against what mechanics says. Each proof runs with sleeping on and with it off, as sleeping can hide a
// body that would not have stayed. All on the world's defaults: 8 substeps, 2 passes, 120 Hz.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::solver::soft;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn world(bodies: u32) -> World {
    World::new(bodies, bodies).unwrap()
}
fn floor(w: &mut World) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [50.0, 0.5, 50.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, body as usize, v3(0.0, -0.5, 0.0));
    body
}
fn no_sleep(w: &mut World, body: u32) {
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
}
fn block(w: &mut World, half: [f32; 3], at: V3, density: f32, sleep: bool) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, half, [0.0; 3], IDENTITY, density).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    if !sleep {
        no_sleep(w, body);
    }
    body
}
fn ball(w: &mut World, at: V3, sleep: bool) -> (u32, u32) {
    let body = w.add_body(DYNAMIC).unwrap();
    let collider = w.add_collider(body, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    if !sleep {
        no_sleep(w, body);
    }
    (body, collider)
}
fn size(v: V3) -> f32 {
    v.dot(v).sqrt()
}
/// The deepest overlap the points found at the start of the last step.
fn deepest(w: &World) -> f32 {
    let mut most = 0.0f32;
    for row in 0..w.header().pair_rows as usize {
        if w.uu(PAIR_A, row) != NONE {
            for k in 0..w.uu(PAIR_CONTACTS, row) as usize {
                most = most.min(w.s(CONTACT_SEPARATION, row * MANIFOLD + k));
            }
        }
    }
    -most
}
/// Gravity turned by a slope of this tangent, in place of turning the floor: the floor stays a plain box.
fn slope(w: &mut World, tangent: f32) {
    let c = 1.0 / (1.0 + tangent * tangent).sqrt();
    w.header_mut().gravity = [9.81 * tangent * c, -9.81 * c, 0.0];
}

#[test]
fn the_soft_coefficients_are_the_implicit_spring_of_their_definition() {
    // An implicit step of x'' = -k x - c x' with k = w^2 and c = 2 zeta w, at unit mass from rest at x: the new velocity is
    // v' = -h k x / (1 + h c + h^2 k), by hand. The solver's impulse from rest must be that velocity.
    let (hertz, zeta, h) = (30.0f64, 0.7f64, 1.0f64 / 240.0);
    let omega = 2.0 * std::f64::consts::PI * hertz;
    let (k, c) = (omega * omega, 2.0 * zeta * omega);
    let x = -0.01;
    let expected = -h * k * x / (1.0 + h * c + h * h * k);
    let s = soft(hertz as f32, zeta as f32, h as f32);
    let got = -(s.mass_scale as f64) * (s.bias_rate as f64 * x);
    assert!((got - expected).abs() < 1e-6, "{got} {expected}");
}

#[test]
fn a_box_at_rest_does_not_drift_in_ten_seconds() {
    for sleep in [true, false] {
        let mut w = world(2);
        floor(&mut w);
        let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0, sleep);
        // A box set down at rest is under the threshold from its first step, so its first window of 0.5 s is enough: energy
        // that rises only by rounding must not start a second one (`NOISE` in island.rs; without it this sleeps at 60).
        for _ in 0..30 {
            w.step(DT);
        }
        assert_eq!(w.flags(body as usize) & SLEEPING != 0, sleep, "asleep when its first window ends, and only if it may");
        for _ in 0..30 {
            w.step(DT);
        }
        let settled = w.v(POSITION_X, body as usize);
        for _ in 0..600 {
            w.step(DT);
        }
        let drift = size(w.v(POSITION_X, body as usize).sub(settled));
        // Asleep it is exactly still; awake the solver's rounding moves it under a micrometre, and that is the bound.
        if sleep {
            assert_eq!(drift, 0.0);
            assert!(w.flags(body as usize) & SLEEPING != 0);
        } else {
            assert!(drift < 1e-6, "{drift}");
        }
        assert!(deepest(&w) < 0.0003);
    }
}

#[test]
fn a_pyramid_of_twenty_rows_stands_for_thirty_seconds_under_a_millimetre() {
    // 210 one-metre cubes of density 1, a row's cubes 5 cm apart, each row set on the one below.
    for sleep in [true, false] {
        let rows = 20;
        let mut w = world(rows * (rows + 1) / 2 + 1);
        floor(&mut w);
        let mut bodies = vec![];
        for row in 0..rows {
            for i in 0..rows - row {
                let x = (i as f32 - (rows - row - 1) as f32 * 0.5) * 1.05;
                let at = v3(x, 0.5 + row as f32, 0.0);
                bodies.push((block(&mut w, [0.5, 0.5, 0.5], at, 1.0, sleep), at));
            }
        }
        let mut worst = 0.0f32;
        for _ in 0..1800 {
            w.step(DT);
            worst = worst.max(deepest(&w));
        }
        let moved = bodies.iter().fold(0.0f32, |m, &(b, at)| m.max(size(w.v(POSITION_X, b as usize).sub(at))));
        assert!(worst < 0.001, "sleep {sleep}: deepest {worst}");
        assert!(moved < 0.01, "sleep {sleep}: moved {moved}");
        assert_eq!(w.header().awake == 0, sleep, "it must fall asleep exactly when it may");
    }
}

#[test]
fn a_heavy_box_stands_on_a_light_one() {
    // The light box is a metre cube of density 1 on the floor; the sag is the load over the contact's stiffness, which
    // follows the light box's mass (Catto 2011), so it grows with the ratio. The 1:1000 row also holds the manifold's turning
    // first point: solved from a fixed first point, the heavy box walks 3.3 mm in x and 3.8 mm in z.
    for sleep in [true, false] {
        for (ratio, sag) in [(1.0f32, 0.001f32), (100.0, 0.006), (1000.0, 0.05)] {
            let mut w = world(4);
            floor(&mut w);
            let light = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0, sleep);
            let heavy = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 1.5, 0.0), ratio, sleep);
            for _ in 0..1200 {
                w.step(DT);
            }
            let top = w.v(POSITION_X, heavy as usize);
            assert!(top.y > 1.5 - sag && top.y < 1.5, "1:{ratio}: {top:?}");
            assert!(top.x.abs() < 1e-3 && top.z.abs() < 1e-3, "1:{ratio}: {top:?}");
            let bottom = w.v(POSITION_X, light as usize);
            assert!(bottom.x.abs() < 1e-3 && bottom.z.abs() < 1e-3, "1:{ratio}: {bottom:?}");
        }
    }
}

#[test]
fn a_ball_rolls_down_a_slope_at_five_sevenths_of_g_sin_t() {
    // A solid ball that rolls without slipping: a = 5/7 g sin t, which takes friction 2/7 tan t of the normal force.
    for sleep in [true, false] {
        for tangent in [0.1f32, 0.3, 0.5] {
            let mut w = world(2);
            floor(&mut w);
            slope(&mut w, tangent);
            let (body, _) = ball(&mut w, v3(0.0, 0.5, 0.0), sleep);
            for _ in 0..30 {
                w.step(DT);
            }
            // Measured 0.35 percent of the speed by 2.5 s, from the soft friction spring, not from the cone: the
            // speed and the rim must stay that close.
            let slip = |w: &World| w.v(LINEAR_X, body as usize).x + w.v(ANGULAR_X, body as usize).z * 0.5;
            let (before, slipped) = (w.v(LINEAR_X, body as usize).x, slip(&w));
            for _ in 0..120 {
                w.step(DT);
            }
            let after = w.v(LINEAR_X, body as usize).x;
            let ratio = (after - before) / 2.0 / (5.0 / 7.0 * w.header().gravity[0]);
            assert!((ratio - 1.0).abs() < 0.002, "{ratio}");
            assert!((slip(&w) - slipped).abs() < 0.005 * after, "slip went from {slipped} to {}", slip(&w));
        }
    }
}

#[test]
fn a_block_slides_only_above_tan_t_equal_to_mu() {
    // Both surfaces take the default mu of 0.5. Below it the block must hold its place with sleeping off, not creep; above
    // it the acceleration is g cos t (tan t - mu).
    for sleep in [true, false] {
        for tangent in [0.1f32, 0.3, 0.45, 0.49, 0.51, 0.55, 0.6] {
            let mut w = world(2);
            floor(&mut w);
            slope(&mut w, tangent);
            let body = block(&mut w, [0.5, 0.25, 0.5], v3(0.0, 0.25, 0.0), 1.0, sleep);
            for _ in 0..300 {
                w.step(DT);
            }
            let (x, v) = (w.v(POSITION_X, body as usize).x, w.v(LINEAR_X, body as usize).x);
            for _ in 0..300 {
                w.step(DT);
            }
            let (moved, gained) = (w.v(POSITION_X, body as usize).x - x, w.v(LINEAR_X, body as usize).x - v);
            if tangent < 0.5 {
                assert!(moved.abs() < 1e-6, "tan {tangent}: crept {moved}");
            } else {
                let c = 1.0 / (1.0 + tangent * tangent).sqrt();
                let expected = 9.81 * c * (tangent - 0.5);
                assert!((gained / 5.0 - expected).abs() < 0.002, "tan {tangent}: {} against {expected}", gained / 5.0);
            }
        }
    }
}

#[test]
fn a_block_slides_at_its_rate_from_release() {
    // Measured from 0.5 s to 2.5 s after release, as the harness does, for a cube and a flat block: a = g cos t (tan t - mu).
    // The relaxing pass once took friction's cone from the normal the soft pass left, short of the load by its impulse scale,
    // and the cube ran up to 0.008 m/s2 fast.
    for half_y in [0.5f32, 0.25] {
        for tangent in [0.51f32, 0.55, 0.6, 0.7, 0.85, 1.0] {
            let mut w = world(2);
            floor(&mut w);
            slope(&mut w, tangent);
            let body = block(&mut w, [0.5, half_y, 0.5], v3(0.0, half_y, 0.0), 1.0, false);
            for _ in 0..30 {
                w.step(DT);
            }
            let v = w.v(LINEAR_X, body as usize).x;
            for _ in 0..120 {
                w.step(DT);
            }
            let c = 1.0 / (1.0 + tangent * tangent).sqrt();
            let expected = 9.81 * c * (tangent - 0.5);
            let got = (w.v(LINEAR_X, body as usize).x - v) / 2.0;
            assert!((got - expected).abs() < 0.002, "half height {half_y}, tan {tangent}: {got} against {expected}");
        }
    }
}

#[test]
fn a_cube_dropped_flat_lands_flat() {
    // A unit cube falls flat onto the floor with no bounce: it must land and stay as it fell, not turned and not moved
    // sideways. From one sweep over its four points the first took the whole strike: from 8 m it spun at 0.64 rad/s, slid
    // at 0.34 m/s and came to rest 2.6 cm off, turned 1.7 degrees.
    for height in [0.5f32, 2.0, 8.0] {
        let mut w = world(2);
        floor(&mut w);
        let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5 + height, 0.0), 1.0, false);
        let (mut spin, mut side, mut up) = (0.0f32, 0.0f32, 0.0f32);
        for _ in 0..240 {
            w.step(DT);
            let (v, o) = (w.v(LINEAR_X, body as usize), w.v(ANGULAR_X, body as usize));
            spin = spin.max(size(o));
            side = side.max((v.x * v.x + v.z * v.z).sqrt());
            up = up.max(v.y);
        }
        let (p, q) = (w.v(POSITION_X, body as usize), w.q(ROTATION_X, body as usize));
        assert!(spin < 1e-3 && side < 1e-3 && up < 1e-3, "from {height} m: spin {spin}, sideways {side}, up {up}");
        assert!(p.x.abs() < 1e-5 && p.z.abs() < 1e-5, "from {height} m: rests at {p:?}");
        assert!(q.x.abs() < 1e-5 && q.y.abs() < 1e-5 && q.z.abs() < 1e-5, "from {height} m: turned {q:?}");
    }
}

#[test]
fn a_ball_bounces_to_e_squared_of_its_drop() {
    for sleep in [true, false] {
        for e in [0.25f32, 0.5, 0.75, 1.0] {
            let mut w = world(2);
            floor(&mut w);
            let (body, collider) = ball(&mut w, v3(0.0, 2.5, 0.0), sleep);
            w.set_s(COLLIDER_RESTITUTION, collider as usize, e);
            w.set_u(COLLIDER_COMBINE, collider as usize, COMBINE_MAX << 2);
            let (mut top, mut rising) = (0.0f32, false);
            for _ in 0..300 {
                w.step(DT);
                let (y, v) = (w.v(POSITION_X, body as usize).y, w.v(LINEAR_X, body as usize).y);
                rising |= v > 0.0;
                if rising {
                    top = top.max(y);
                    if v < 0.0 {
                        break;
                    }
                }
            }
            let expected = 2.0 * e * e;
            assert!((top - 0.5 - expected).abs() < 0.005, "e {e}: {} against {expected}", top - 0.5);
        }
    }
}

#[test]
fn with_no_bounce_a_dropped_ball_stays_down() {
    let mut w = world(2);
    floor(&mut w);
    let (body, _) = ball(&mut w, v3(0.0, 2.5, 0.0), false);
    let mut highest = 0.0f32;
    for i in 0..200 {
        w.step(DT);
        if i > 50 {
            highest = highest.max(w.v(LINEAR_X, body as usize).y);
        }
    }
    assert!(highest < 1e-3, "{highest}");
}

#[test]
fn a_pair_mixes_its_surfaces_by_the_higher_rule() {
    let mix = |a: (f32, u32), b: (f32, u32)| {
        let mut w = world(2);
        let fixed = w.add_body(FIXED).unwrap();
        let first = w.add_collider(fixed, SHAPE_BOX, [5.0, 0.5, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_v(POSITION_X, fixed as usize, v3(0.0, -0.5, 0.0));
        let (_, second) = ball(&mut w, v3(0.0, 0.5, 0.0), true);
        for (c, (value, rule)) in [(first, a), (second, b)] {
            w.set_s(COLLIDER_FRICTION, c as usize, value);
            w.set_u(COLLIDER_COMBINE, c as usize, rule);
        }
        w.step(DT);
        w.s(PAIR_FRICTION, 0)
    };
    assert!((mix((0.2, COMBINE_AVERAGE), (0.6, COMBINE_AVERAGE)) - 0.4).abs() < 1e-6);
    assert_eq!(mix((0.2, COMBINE_MIN), (0.6, COMBINE_AVERAGE)), 0.2);
    assert_eq!(mix((0.5, COMBINE_MIN), (0.5, COMBINE_MULTIPLY)), 0.25);
    assert_eq!(mix((0.2, COMBINE_MULTIPLY), (0.6, COMBINE_MAX)), 0.6);
}

#[test]
fn a_fast_ball_stops_on_the_floor_without_passing_through() {
    let mut w = world(2);
    floor(&mut w);
    let (body, _) = ball(&mut w, v3(0.0, 3.0, 0.0), false);
    w.set_v(LINEAR_X, body as usize, v3(0.0, -50.0, 0.0));
    for _ in 0..120 {
        w.step(DT);
        assert!(w.v(POSITION_X, body as usize).y > 0.45, "{:?}", w.v(POSITION_X, body as usize));
    }
    assert!((w.v(POSITION_X, body as usize).y - 0.5).abs() < 0.001);
}

#[test]
fn a_locked_axis_takes_no_contact_impulse() {
    // Locked along Y over a floor it overlaps: nothing may lift it, and its effective mass there must not divide by zero.
    let mut w = world(2);
    floor(&mut w);
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.45, 0.0), 1.0, false);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) | (LOCK_LINEAR_X << 1) | LOCK_ANGULAR);
    for _ in 0..60 {
        w.step(DT);
    }
    let at = w.v(POSITION_X, body as usize);
    assert_eq!(at.y, 0.45);
    assert!(at.x.is_finite() && at.z.is_finite());
}

#[test]
fn a_moving_platform_carries_what_stands_on_it() {
    // A scripted platform at 1 m/s: friction must bring the box up to it and hold it there.
    let mut w = world(2);
    let platform = w.add_body(KINEMATIC_VELOCITY).unwrap();
    w.add_collider(platform, SHAPE_BOX, [20.0, 0.5, 20.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, platform as usize, v3(0.0, -0.5, 0.0));
    w.set_v(LINEAR_X, platform as usize, v3(1.0, 0.0, 0.0));
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0, false);
    for _ in 0..300 {
        w.step(DT);
    }
    assert!((w.v(LINEAR_X, body as usize).x - 1.0).abs() < 1e-3, "{:?}", w.v(LINEAR_X, body as usize));
    assert_eq!(w.v(LINEAR_X, platform as usize).x, 1.0, "nothing pushes a scripted body");
}

#[test]
fn two_bodies_meeting_keep_their_momentum() {
    let mut w = world(2);
    w.header_mut().gravity = [0.0; 3];
    let (a, _) = ball(&mut w, v3(-2.0, 0.0, 0.0), false);
    let (b, _) = ball(&mut w, v3(2.0, 0.0, 0.0), false);
    w.set_v(LINEAR_X, a as usize, v3(3.0, 0.0, 0.0));
    w.set_v(LINEAR_X, b as usize, v3(-1.0, 0.0, 0.0));
    for _ in 0..120 {
        w.step(DT);
    }
    let total = w.v(LINEAR_X, a as usize).add(w.v(LINEAR_X, b as usize));
    assert!((total.x - 2.0).abs() < 1e-4, "{total:?}");
}

#[test]
fn the_same_scene_runs_the_same_twice() {
    let run = || {
        let mut w = world(32);
        floor(&mut w);
        for i in 0..20 {
            block(&mut w, [0.5, 0.5, 0.5], v3((i % 3) as f32 * 0.3, 0.5 + i as f32 * 1.1, (i % 2) as f32 * 0.2), 1.0, true);
        }
        for _ in 0..300 {
            w.step(DT);
        }
        w.hash()
    };
    assert_eq!(run(), run());
}
