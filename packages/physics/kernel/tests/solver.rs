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

/// The harness pyramid at 4 substeps of one pass, `rows` rows of metre cubes touching side by side, 30 s: the fastest box at
/// the end, the farthest any box moved, and the step the world fell asleep at.
fn one_pass_pile(rows: usize, sleep: bool) -> (f32, f32, Option<usize>) {
    let mut w = world((rows * (rows + 1) / 2 + 1) as u32);
    w.header_mut().substeps = 4;
    w.header_mut().iterations = 1;
    floor(&mut w);
    let mut bodies = vec![];
    for row in 0..rows {
        for i in 0..rows - row {
            let at = v3(i as f32 - (rows - row - 1) as f32 * 0.5, 0.5 + row as f32, 0.0);
            bodies.push((block(&mut w, [0.5, 0.5, 0.5], at, 1.0, sleep), at));
        }
    }
    let mut asleep = None;
    for step in 0..1800 {
        w.step(DT);
        if asleep.is_none() && w.header().awake == 0 {
            asleep = Some(step);
        }
    }
    let fastest = bodies.iter().fold(0.0f32, |m, &(b, _)| m.max(size(w.v(LINEAR_X, b as usize))));
    let moved = bodies.iter().fold(0.0f32, |m, &(b, at)| m.max(size(w.v(POSITION_X, b as usize).sub(at))));
    (fastest, moved, asleep)
}

#[test]
fn a_pyramid_settles_at_one_pass_a_substep() {
    // 210 cubes. With every contact at a quarter of the substep rate one pass a substep left this pile rocking for good: its
    // fastest box at 0.278 m/s after 30 s with sleeping off, its top walked 0.27 m, and it never slept. A contact between two
    // movable bodies now takes the eighth of the rate unless a heavy one rests on a light one (`CHAIN_LOAD`).
    for sleep in [true, false] {
        let (fastest, moved, asleep) = one_pass_pile(20, sleep);
        assert!(fastest < 1e-3 && moved < 0.04, "sleep {sleep}: fastest {fastest} m/s at 30 s, moved {moved} m");
        if sleep {
            assert!(asleep.is_some_and(|s| s < 300), "asleep at step {asleep:?}");
        }
    }
}

#[test]
fn a_pyramid_of_thirty_rows_settles_at_one_pass_a_substep() {
    // 465 cubes, whose bottom pairs carry about 40 times a cube's weight: still under `CHAIN_LOAD`, so the whole pile takes the
    // eighth-rate spring and settles.
    for sleep in [true, false] {
        let (fastest, moved, asleep) = one_pass_pile(30, sleep);
        assert!(fastest < 1e-3 && moved < 0.1, "sleep {sleep}: fastest {fastest} m/s at 30 s, moved {moved} m");
        if sleep {
            assert!(asleep.is_some_and(|s| s < 300), "asleep at step {asleep:?}");
        }
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
fn a_ball_rolls_from_rest_at_five_sevenths_of_g_sin_t_on_thirty_degrees() {
    // The point of a turning ball is where the ball meets the floor, not a point fixed in the ball: fixed in the ball it rose
    // r (1 - cos a) after a turn of a, read as an open gap from step 15, and the ball ran 1.0033 of 5/7 g sin t over its
    // first second at 30 degrees, 1.0021 over two (the bar is 0.2 percent).
    for (substeps, iterations) in [(8u32, 2u32), (4, 1)] {
        for tangent in [0.3f32, 0.57735, 0.7] {
            let mut w = world(2);
            w.header_mut().substeps = substeps;
            w.header_mut().iterations = iterations;
            floor(&mut w);
            slope(&mut w, tangent);
            let (body, _) = ball(&mut w, v3(0.0, 0.5, 0.0), false);
            let rolled = 5.0 / 7.0 * w.header().gravity[0];
            for (steps, seconds) in [(60, 1.0f32), (60, 2.0)] {
                for _ in 0..steps {
                    w.step(DT);
                }
                let ratio = w.v(LINEAR_X, body as usize).x / (rolled * seconds);
                assert!((ratio - 1.0).abs() < 0.002, "{substeps} x {iterations}, tan t {tangent}, {seconds} s: {ratio}");
            }
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
fn a_cube_released_on_a_slope_below_tan_t_equal_to_mu_holds_from_its_first_second() {
    // Inside the slop a point sank at a speed that followed its load, the downhill points three times the uphill ones, so the
    // cube tilted and its centre moved 2e-5 to 3.8e-5 m between 0.5 s and 2.5 s (the harness bar is 1e-6).
    for (substeps, iterations) in [(8u32, 2u32), (4, 1)] {
        for tangent in [0.36f32, 0.42, 0.47, 0.49] {
            let mut w = world(2);
            w.header_mut().substeps = substeps;
            w.header_mut().iterations = iterations;
            floor(&mut w);
            slope(&mut w, tangent);
            let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0, false);
            for _ in 0..30 {
                w.step(DT);
            }
            let x = w.v(POSITION_X, body as usize).x;
            for _ in 0..120 {
                w.step(DT);
            }
            let moved = w.v(POSITION_X, body as usize).x - x;
            assert!(moved.abs() < 1e-6, "{substeps} x {iterations}, tan {tangent}: moved {moved}");
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
fn a_strike_passes_down_a_spaced_row_of_balls_and_makes_no_energy() {
    // Elastic balls of equal mass 2 mm apart: the struck ball stops and the next takes its speed, one pair at a time. A
    // strike noted inside the pushing pass bounced off both pairs of the middle ball and left -0.5, 0.5 and 1 (KB-PHYS-BOUNCECHAIN1).
    for gap in [0.002f32, 0.02] {
        let mut w = world(3);
        w.header_mut().gravity = [0.0, 0.0, 0.0];
        let balls: Vec<u32> = (0..3)
            .map(|i| {
                let (body, collider) = ball(&mut w, v3(i as f32 * (1.0 + gap) - if i == 0 { 0.05 } else { 0.0 }, 0.0, 0.0), false);
                w.set_s(COLLIDER_RESTITUTION, collider as usize, 1.0);
                w.set_s(COLLIDER_FRICTION, collider as usize, 0.0);
                w.set_u(COLLIDER_COMBINE, collider as usize, COMBINE_MAX << 2);
                body
            })
            .collect();
        w.set_v(LINEAR_X, balls[0] as usize, v3(1.0, 0.0, 0.0));
        for _ in 0..240 {
            w.step(DT);
        }
        let v: Vec<f32> = balls.iter().map(|&b| w.v(LINEAR_X, b as usize).x).collect();
        assert!(v[0].abs() < 1e-3 && v[1].abs() < 1e-3 && (v[2] - 1.0).abs() < 1e-3, "gap {gap}: {v:?}");
        assert!(v.iter().map(|x| x * x).sum::<f32>() <= 1.0 + 1e-5, "gap {gap}: energy grew, {v:?}");
    }
}

#[test]
fn a_ball_bounces_to_e_squared_at_four_substeps_of_one_pass() {
    // The cost of Rapier's and Box2D v3's defaults. A strike is seen while the gap is still open, and the speed of that moment
    // is short of the speed at the surface by what gravity adds over the gap: from 1 m at e 0.5 the first peak was 0.2432 m.
    for (height, e) in [(1.0f32, 0.5f32), (2.0, 0.5), (1.0, 0.75), (2.0, 0.25)] {
        let mut w = world(2);
        w.header_mut().substeps = 4;
        w.header_mut().iterations = 1;
        floor(&mut w);
        let (body, collider) = ball(&mut w, v3(0.0, 0.5 + height, 0.0), false);
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
        let expected = height * e * e;
        assert!((top - 0.5 - expected).abs() < 0.005, "from {height} m at e {e}: {} against {expected}", top - 0.5);
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
            w.set_u(COLLIDER_COMBINE, c as usize, combine_bits(rule, COMBINE_AVERAGE));
        }
        w.step(DT);
        w.s(PAIR_FRICTION, 0)
    };
    assert!((mix((0.2, COMBINE_AVERAGE), (0.6, COMBINE_AVERAGE)) - 0.4).abs() < 1e-6);
    assert_eq!(mix((0.2, COMBINE_MIN), (0.6, COMBINE_AVERAGE)), 0.2);
    assert_eq!(mix((0.5, COMBINE_MIN), (0.5, COMBINE_MULTIPLY)), 0.25);
    assert_eq!(mix((0.2, COMBINE_MULTIPLY), (0.6, COMBINE_MAX)), 0.6);
    // The two newer rules sit above the others, and read as Rapier's docs write them.
    assert!((mix((0.3, COMBINE_CLAMPED_SUM), (0.4, COMBINE_MAX)) - 0.7).abs() < 1e-6, "clamped sum wins over max: 0.3 + 0.4");
    assert_eq!(mix((0.8, COMBINE_CLAMPED_SUM), (0.7, COMBINE_AVERAGE)), 1.0, "and the sum stops at 1");
    assert!((mix((0.2, COMBINE_GEOMETRIC_MEAN), (0.8, COMBINE_CLAMPED_SUM)) - 0.4).abs() < 1e-6, "the geometric mean wins over clamped sum: sqrt(0.16)");
    assert_eq!(mix((0.0, COMBINE_GEOMETRIC_MEAN), (0.9, COMBINE_AVERAGE)), 0.0, "a zero on either side gives zero");
    assert_eq!(combine_bits(COMBINE_MAX, COMBINE_MULTIPLY), 3 | (2 << 2));
    assert_eq!((friction_rule(combine_bits(COMBINE_GEOMETRIC_MEAN, COMBINE_CLAMPED_SUM)), restitution_rule(combine_bits(COMBINE_GEOMETRIC_MEAN, COMBINE_CLAMPED_SUM))), (COMBINE_GEOMETRIC_MEAN, COMBINE_CLAMPED_SUM));
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

/// The pile of `one_pass_pile`, sleeping off, under gravity `g` and with the block solver if `block`: its fastest box at the end of
/// each of `windows`, in seconds.
fn pile_over_time(rows: usize, g: f32, block: bool, windows: &[u32]) -> Vec<f32> {
    let mut w = world((rows * (rows + 1) / 2 + 1) as u32);
    w.header_mut().substeps = 4;
    w.header_mut().iterations = 1;
    w.header_mut().gravity = [0.0, -g, 0.0];
    w.header_mut().block_solver = block as u32;
    floor(&mut w);
    let mut bodies = vec![];
    for row in 0..rows {
        for i in 0..rows - row {
            let at = v3(i as f32 - (rows - row - 1) as f32 * 0.5, 0.5 + row as f32, 0.0);
            bodies.push(block_at(&mut w, at));
        }
    }
    let mut fastest = vec![];
    let mut step = 0;
    for &end in windows {
        while step < end * 60 {
            w.step(DT);
            step += 1;
        }
        fastest.push(bodies.iter().fold(0.0f32, |m, &b| m.max(size(w.v(LINEAR_X, b as usize)))));
    }
    fastest
}
fn block_at(w: &mut World, at: V3) -> u32 {
    block(w, [0.5, 0.5, 0.5], at, 1.0, false)
}

/// A pile at rest stays at rest: its fastest box under 1 mm/s at 30, 60 and 90 s and no faster at 90 than a quarter over what it
/// was at 30, so a slow growth shows long before it would leave the bound. Before an island took substeps fine enough to hold
/// its tipping modes (tilt.rs), the 30-row pile crept at 5.6 mm/s at 30 s under 9.80665 m/s^2 while it rested at 9.81, and the
/// 26- and 28-row piles crept at both (KB-PHYS-PILECREEP1).
fn holds_still(rows: usize, g: f32, block: bool) {
    let fastest = pile_over_time(rows, g, block, &[30, 60, 90]);
    println!("{rows} rows, g {g}, block {block}: fastest {fastest:?} m/s at 30, 60 and 90 s");
    for (k, &f) in fastest.iter().enumerate() {
        assert!(f < 1e-3, "{rows} rows, g {g}, block {block}: {f} m/s at {} s", 30 * (k + 1));
        assert!(f <= 1.25 * fastest[0], "{rows} rows, g {g}, block {block}: {f} m/s at {} s grew from {} at 30 s", 30 * (k + 1), fastest[0]);
    }
}

#[test]
fn a_pile_of_twenty_rows_holds_still_for_ninety_seconds() {
    for g in [9.81, 9.80665] {
        holds_still(20, g, false);
    }
}

#[test]
fn a_pile_of_thirty_rows_holds_still_for_ninety_seconds_at_either_gravity() {
    holds_still(30, 9.80665, false);
}

#[test]
fn a_pile_of_thirty_rows_holds_still_for_ninety_seconds_at_the_old_gravity() {
    holds_still(30, 9.81, false);
}

#[test]
fn the_block_solver_holds_a_pile_of_thirty_rows_still_for_ninety_seconds() {
    // At one pass a substep the exact block solve once let the apex box's z velocity grow from 0.003 m/s at 30 s to 0.07 at 60
    // and 150 by 90 (KB-PHYS-BLOCK1).
    holds_still(30, 9.80665, true);
}

#[test]
fn a_plate_rides_a_deck_turning_about_an_axis_far_away() {
    // A deck 140 m long pitching 4 degrees at 9 s about an axis through its middle, driven to its pose each step, and a plate
    // resting on it 60 m from the axis with friction of 0.5, five times what the pitch asks of it (0.1), for 36 s at the
    // world's 8 substeps. The slide was tallied from the speeds at the step's levers, which miss how the turning deck
    // carries the plate's anchor round (its w^2 r, always the same way): the plate slid 4 mm a pitch, 1.4 cm in 36 s. Tallied
    // as the move of each anchor's material points, it rides. (Over minutes a deck driven to its pose at one speed a step still makes the plate slip at each
    // step's change of speed, KB-PHYS-KINJUMP1, which a smooth path ends.)
    let mut w = world(4);
    let deck = w.add_body(KINEMATIC_POSITION).unwrap();
    w.add_collider(deck, SHAPE_BOX, [70.0, 0.5, 8.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    // The deck's middle 60 m along x, the plate at the origin: 60 m from the axis, where its pose rounds to nothing that
    // matters (KB-PHYS-POSEROUND1 is rounding far out, not this).
    w.set_v(POSITION_X, deck as usize, v3(60.0, -0.5, 0.0));
    let plate = block(&mut w, [0.12, 0.01, 0.12], v3(0.0, 0.01, 0.0), 600.0, false);
    let (amplitude, omega) = (4.0f64.to_radians(), 2.0 * std::f64::consts::PI / 9.0);
    // The deck's pose: turned by theta about z through (0, -0.5, 0)... its centre, so the centre stays put.
    let pose = |t: f64| {
        let theta = amplitude * (omega * t).sin();
        Q { x: 0.0, y: 0.0, z: (theta / 2.0).sin() as f32, w: (theta / 2.0).cos() as f32 }
    };
    // Start the plate with the deck's motion at its place: theta' r across.
    let spin = amplitude * omega;
    w.set_v(ANGULAR_X, plate as usize, v3(0.0, 0.0, spin as f32));
    w.set_v(LINEAR_X, plate as usize, v3(0.0, (-60.0 * spin) as f32, 0.0));
    let local = |w: &World| {
        let q = w.q(ROTATION_X, deck as usize);
        q.conjugate().rotate(w.v(POSITION_X, plate as usize).sub(w.v(POSITION_X, deck as usize)))
    };
    let start = local(&w);
    let mut worst = 0.0f32;
    for i in 1..=(36 * 60) {
        w.set_q(TARGET_ROTATION_X, deck as usize, pose(i as f64 / 60.0));
        w.set_v(TARGET_X, deck as usize, v3(60.0, -0.5, 0.0));
        w.step(DT);
        let d = local(&w).sub(start);
        worst = worst.max((d.x * d.x + d.z * d.z).sqrt());
    }
    // Held, the plate keeps to its contacts' softness, a part of a millimetre, where it slid 1.4 cm.
    assert!(worst < 1e-3, "the plate slid {worst} m on the deck");
    println!("the plate stayed within {worst:e} m of its place, 60 m from the pitch axis");
}

#[test]
fn a_plate_rides_a_deck_on_a_smooth_path_for_minutes_at_any_substeps() {
    // The pitching deck of `a_plate_rides_a_deck_turning_about_an_axis_far_away`, given the spin it is to reach each target
    // with (SMOOTH_PATH): it moves along the cubic of its poses and spins, so its speed changes through the step and not at
    // its start. Driven to its pose at one speed a step, the plate slipped 3.6 mm in six minutes at 8 substeps
    // (KB-PHYS-KINJUMP1); on the smooth path it holds at 8 and 16. (From 32 substeps it still slips: KB-PHYS-FINECONE1.)
    for substeps in [8u32, 16] {
        let mut w = world(4);
        w.header_mut().substeps = substeps;
        let deck = w.add_body(KINEMATIC_POSITION).unwrap();
        w.add_collider(deck, SHAPE_BOX, [70.0, 0.5, 8.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_v(POSITION_X, deck as usize, v3(60.0, -0.5, 0.0));
        w.set_u(FLAGS, deck as usize, w.flags(deck as usize) | SMOOTH_PATH);
        let plate = block(&mut w, [0.12, 0.01, 0.12], v3(0.0, 0.01, 0.0), 600.0, false);
        let (amplitude, omega) = (4.0f64.to_radians(), 2.0 * std::f64::consts::PI / 9.0);
        let spin = |t: f64| (amplitude * omega * (omega * t).cos()) as f32;
        let pose = |t: f64| {
            let theta = amplitude * (omega * t).sin();
            Q { x: 0.0, y: 0.0, z: (theta / 2.0).sin() as f32, w: (theta / 2.0).cos() as f32 }
        };
        w.set_v(START_ANGULAR_X, deck as usize, v3(0.0, 0.0, spin(0.0)));
        w.set_v(ANGULAR_X, plate as usize, v3(0.0, 0.0, spin(0.0)));
        w.set_v(LINEAR_X, plate as usize, v3(0.0, -60.0 * spin(0.0), 0.0));
        let local = |w: &World| {
            let q = w.q(ROTATION_X, deck as usize);
            q.conjugate().rotate(w.v(POSITION_X, plate as usize).sub(w.v(POSITION_X, deck as usize)))
        };
        let start = local(&w);
        let mut worst = 0.0f32;
        for i in 1..=(360 * 60) {
            let t = i as f64 / 60.0;
            w.set_q(TARGET_ROTATION_X, deck as usize, pose(t));
            w.set_v(TARGET_X, deck as usize, v3(60.0, -0.5, 0.0));
            w.set_v(TARGET_ANGULAR_X, deck as usize, v3(0.0, 0.0, spin(t)));
            w.step(DT);
            let d = local(&w).sub(start);
            worst = worst.max((d.x * d.x + d.z * d.z).sqrt());
        }
        assert!(worst < 1e-3, "{substeps} substeps: the plate slid {worst} m on the deck in six minutes");
        println!("{substeps} substeps: the plate stayed within {worst:e} m over six minutes");
    }
}

#[test]
fn a_kinematic_body_on_a_smooth_path_lands_on_its_targets_and_moves_through_the_step_at_its_chords() {
    // Targets 1 m apart a step with speeds of 0 and 120 m/s at the ends (a start and a stop of a 60 m/s mean): its chords
    // over the substeps sum to the move, the first slow and the last fast, and it lands on each target exactly.
    let mut w = world(2);
    w.header_mut().substeps = 8;
    let body = w.add_body(KINEMATIC_POSITION).unwrap();
    w.add_collider(body, SHAPE_BALL, [0.1, 0.0, 0.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_u(FLAGS, body as usize, w.flags(body as usize) | SMOOTH_PATH);
    w.set_v(TARGET_X, body as usize, v3(1.0, 0.0, 0.0));
    w.set_v(TARGET_LINEAR_X, body as usize, v3(120.0, 0.0, 0.0));
    w.step(DT);
    assert_eq!(w.v(POSITION_X, body as usize), v3(1.0, 0.0, 0.0));
    assert_eq!(w.v(START_LINEAR_X, body as usize), v3(120.0, 0.0, 0.0), "the next step begins at the speed it arrived with");
    // The chords of that step, read back with the step's pose as its start: a cubic from rest to 120 m/s over 1 m.
    w.set_v(PREVIOUS_X, body as usize, v3(0.0, 0.0, 0.0));
    w.set_v(START_LINEAR_X, body as usize, v3(0.0, 0.0, 0.0));
    let h = DT / 8.0;
    let (mut sum, mut speeds) = (0.0f32, [0.0f32; 8]);
    for s in 0..8u32 {
        let (v, _) = w.smooth_velocity(body as usize, s, 8);
        speeds[s as usize] = v.x;
        sum += v.x * h;
    }
    assert!((sum - 1.0).abs() < 1e-5, "the chords move it {sum} m");
    assert!(speeds[0] < speeds[7] && speeds.windows(2).all(|p| p[0] <= p[1] + 1e-3), "{speeds:?}");
}

#[test]
fn a_smooth_path_spins_each_substep_by_the_turn_its_poses_make_when_its_axis_swings() {
    // Spun about z at the step's start and about x at its end, through a half radian about x: the path's rotation vector swings
    // through the step, and the turn its poses make over a substep, exp(b) exp(a)^-1, is not b - a (rotations do not
    // commute). The spin is the Baker-Campbell-Hausdorff series to third order, so what is left is fourth order,
    // under |a|^2 |b - a| / 12, and the rounding of the poses' quaternions, a few ten millionths of a radian. The plain
    // b - a misses by the cross term (a x b) / 2, ten to a hundred times that.
    let mut w = world(2);
    w.header_mut().substeps = 8;
    w.header_mut().step_dt = DT;
    let body = w.add_body(KINEMATIC_POSITION).unwrap() as usize;
    w.add_collider(body as u32, SHAPE_BOX, [1.0, 1.0, 1.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_u(FLAGS, body, w.flags(body) | SMOOTH_PATH);
    let (spin_start, spin_end, half) = (v3(0.0, 0.0, 30.0), v3(30.0, 0.0, 0.0), 0.25f32);
    w.set_v(START_ANGULAR_X, body, spin_start);
    w.set_v(TARGET_ANGULAR_X, body, spin_end);
    w.set_q(TARGET_ROTATION_X, body, Q { x: half.sin(), y: 0.0, z: 0.0, w: half.cos() });
    let turn = v3(2.0 * half, 0.0, 0.0);
    // The path's rotation vector at a share t of the step, in doubles' worth of care: the Hermite cubic of the step's turn.
    let path = |t: f32| turn.scale(t * t * (3.0 - 2.0 * t)).add(spin_start.scale(t * (t * t - 2.0 * t + 1.0) * DT)).add(spin_end.scale(t * t * (t - 1.0) * DT));
    let h = DT / 8.0;
    for s in 1..7u32 {
        let (_, _, before) = w.kinematic_pose(body, s - 1, 8);
        let (_, _, after) = w.kinematic_pose(body, s, 8);
        let mut r = after.mul(before.conjugate());
        if r.w < 0.0 {
            r = Q { x: -r.x, y: -r.y, z: -r.z, w: -r.w };
        }
        let made = r.to_rotation_vector();
        let (a, b) = (path(s as f32 / 8.0), path((s + 1) as f32 / 8.0));
        let bound = a.dot(a) * size(b.sub(a)) / 12.0 + 1e-6;
        let spun = w.smooth_velocity(body, s, 8).1.scale(h);
        assert!(size(made.sub(spun)) < bound, "substep {s}: spun {spun:?}, the poses turned {made:?}, bound {bound}");
        assert!(size(made.sub(b.sub(a))) > 10.0 * size(made.sub(spun)), "substep {s}: b - a would have done as well");
    }
}

#[test]
fn a_resting_depth_is_continuous_in_the_load_inside_and_past_the_slop() {
    // A 5 cm ball on a box, 60 Hz contacts, 3 mm of slop: whatever g, it rests at the slop plus the soft spring's give,
    // g / omega^2 (Catto 2011), wherever it settles. The rigid row inside the slop closed to the slop alone, so a ball that
    // settled a rounding short of it stayed there with no give: at 9.80665 and 9.82 it rested 6.9e-5 m higher than at 9.81,
    // a jump the load's fifth digit made (KB-PHYS-RESTDEPTH1). The bound is the small scene's of next-parameters.test.js,
    // 1e-7 m: the soft step's float32 rounding at this size (KB-PHYS-SOFTGIVE1), seven hundred times under the jump.
    let rest = |g: f32, from: f32| {
        let mut w = world(2);
        let fixed = w.add_body(FIXED).unwrap();
        w.add_collider(fixed, SHAPE_BOX, [2.0, 0.05, 2.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_v(POSITION_X, fixed as usize, v3(0.0, -0.05, 0.0));
        let body = w.add_body(DYNAMIC).unwrap();
        w.add_collider(body, SHAPE_BALL, [0.05, 0.0, 0.0], [0.0; 3], IDENTITY, 1000.0).unwrap();
        w.set_v(POSITION_X, body as usize, v3(0.0, from, 0.0));
        no_sleep(&mut w, body);
        let header = w.header_mut();
        (header.gravity, header.contact_hertz, header.contact_slop) = ([0.0, -g, 0.0], 60.0, 0.003);
        for _ in 0..900 {
            w.step(DT);
        }
        0.05 - w.v(POSITION_X, body as usize).y - 0.003
    };
    let omega = 2.0 * std::f32::consts::PI * 60.0;
    for g in [2.0f32, 9.8, 9.80665, 9.81, 9.82, 9.9, 20.0] {
        // Dropped from 1 cm, set down inside the slop, and set down past it.
        for from in [0.06f32, 0.0475, 0.04698] {
            let (past, give) = (rest(g, from), g / (omega * omega));
            assert!((past - give).abs() < 1e-7, "g {g} from {from}: rests {past:e} past the slop, the give is {give:e}");
        }
    }
}

#[test]
fn a_plate_held_near_its_friction_rides_a_deck_pitching_far_from_it() {
    // The smooth-path pitching deck of `a_plate_rides_a_deck_on_a_smooth_path_for_minutes_at_any_substeps`, the plate 60 m
    // from the axis, with friction 0.138: 1.3 times the most the pitch asks of it (its tilt, the turn's w^2 r and the swing
    // of its load, about 0.106). Its friction took one sweep over the four corners, whose shares came out uneven, so the
    // busiest corner met its own cone while the plate held 30 percent inside its own, and its anchor alone was cut; anchors
    // cut one corner at a time pushed against each other, and the plate slid 2.2 mm in 36 s (KB-PHYS-CONECUT1). With the
    // sweeps run until they settle it keeps to its contacts' softness, as at friction 0.5.
    let mut w = world(4);
    let deck = w.add_body(KINEMATIC_POSITION).unwrap();
    let floor = w.add_collider(deck, SHAPE_BOX, [70.0, 0.5, 8.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, deck as usize, v3(60.0, -0.5, 0.0));
    w.set_u(FLAGS, deck as usize, w.flags(deck as usize) | SMOOTH_PATH);
    let plate = w.add_body(DYNAMIC).unwrap();
    let top = w.add_collider(plate, SHAPE_BOX, [0.12, 0.01, 0.12], [0.0; 3], IDENTITY, 600.0).unwrap();
    w.set_v(POSITION_X, plate as usize, v3(0.0, 0.01, 0.0));
    no_sleep(&mut w, plate);
    for c in [floor, top] {
        w.set_s(COLLIDER_FRICTION, c as usize, 0.138);
    }
    let (amplitude, omega) = (4.0f64.to_radians(), 2.0 * std::f64::consts::PI / 9.0);
    let angle = |t: f64| amplitude * (omega * t + 1.0).sin();
    let spin = |t: f64| (amplitude * omega * (omega * t + 1.0).cos()) as f32;
    let pose = |t: f64| Q { x: 0.0, y: 0.0, z: (angle(t) / 2.0).sin() as f32, w: (angle(t) / 2.0).cos() as f32 };
    w.set_q(ROTATION_X, deck as usize, pose(0.0));
    w.set_v(START_ANGULAR_X, deck as usize, v3(0.0, 0.0, spin(0.0)));
    w.set_v(ANGULAR_X, deck as usize, v3(0.0, 0.0, spin(0.0)));
    // The plate starts on the deck at its place and speed: turned with it about the axis, moving at w across the 60 m arm.
    let (c, s) = (angle(0.0).cos() as f32, angle(0.0).sin() as f32);
    let arm = v3(-60.0 * c - 0.51 * s, -60.0 * s + 0.51 * c, 0.0);
    w.set_v(POSITION_X, plate as usize, v3(60.0, -0.5, 0.0).add(arm));
    w.set_q(ROTATION_X, plate as usize, pose(0.0));
    w.set_v(ANGULAR_X, plate as usize, v3(0.0, 0.0, spin(0.0)));
    w.set_v(LINEAR_X, plate as usize, v3(-spin(0.0) * arm.y, spin(0.0) * arm.x, 0.0));
    let local = |w: &World| {
        let q = w.q(ROTATION_X, deck as usize);
        q.conjugate().rotate(w.v(POSITION_X, plate as usize).sub(w.v(POSITION_X, deck as usize)))
    };
    let start = local(&w);
    let mut worst = 0.0f32;
    for i in 1..=(36 * 60) {
        let t = i as f64 / 60.0;
        w.set_q(TARGET_ROTATION_X, deck as usize, pose(t));
        w.set_v(TARGET_X, deck as usize, v3(60.0, -0.5, 0.0));
        w.set_v(TARGET_ANGULAR_X, deck as usize, v3(0.0, 0.0, spin(t)));
        w.step(DT);
        let d = local(&w).sub(start);
        worst = worst.max((d.x * d.x + d.z * d.z).sqrt());
    }
    assert!(worst < 1e-4, "the plate slid {worst} m on the deck at 1.3 times its friction demand");
    println!("the plate stayed within {worst:e} m of its place at 1.3 times its friction demand");
}
