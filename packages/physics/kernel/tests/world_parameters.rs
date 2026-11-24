// Parameters of the solver and the continuous-collision sweep that Rapier's integration parameters have: where friction is solved,
// how many relaxing passes a substep makes, and how a sweep stops. Each switch is proved against the physics it must keep (a
// block holds on a slope below tan t = mu and slides above it) and against the default it must leave bit for bit.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn floor(w: &mut World) {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [50.0, 0.5, 50.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, body as usize, v3(0.0, -0.5, 0.0));
}

fn block(w: &mut World, at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, [0.5, 0.25, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    body
}

/// A block on a floor under gravity turned by a slope of this tangent: how far it crept in the second 5 s, and what it gained in speed.
fn on_slope(tangent: f32, set: impl Fn(&mut World)) -> (f32, f32) {
    let mut w = World::new(2, 2).unwrap();
    floor(&mut w);
    let c = 1.0 / (1.0 + tangent * tangent).sqrt();
    w.header_mut().gravity = [9.81 * tangent * c, -9.81 * c, 0.0];
    set(&mut w);
    let body = block(&mut w, v3(0.0, 0.25, 0.0));
    for _ in 0..300 {
        w.step(DT);
    }
    let (x, v) = (w.v(POSITION_X, body as usize).x, w.v(LINEAR_X, body as usize).x);
    for _ in 0..300 {
        w.step(DT);
    }
    (w.v(POSITION_X, body as usize).x - x, (w.v(LINEAR_X, body as usize).x - v) / 5.0)
}

fn holds_and_slides(set: impl Fn(&mut World) + Copy, label: &str) {
    for tangent in [0.1f32, 0.3, 0.45] {
        let (moved, _) = on_slope(tangent, set);
        assert!(moved.abs() < 1e-5, "{label}: tan {tangent} crept {moved}");
    }
    for tangent in [0.55f32, 0.6] {
        let (_, gained) = on_slope(tangent, set);
        let c = 1.0 / (1.0 + tangent * tangent).sqrt();
        let expected = 9.81 * c * (tangent - 0.5);
        assert!((gained - expected).abs() < 0.01, "{label}: tan {tangent} slid at {gained} against {expected}");
    }
}

#[test]
fn friction_solved_only_in_the_relaxing_pass_holds_and_slides_as_friction_does() {
    holds_and_slides(|w| w.header_mut().friction_in_bias = 0, "friction only in the relaxing pass");
}

#[test]
fn with_no_relaxing_pass_friction_is_solved_in_the_pushing_one() {
    holds_and_slides(
        |w| {
            let h = w.header_mut();
            h.stabilization = 0;
            h.friction_in_bias = 0;
        },
        "no relaxing pass",
    );
}

#[test]
fn a_stabilization_count_of_the_default_is_the_default_bit_for_bit_and_more_passes_still_hold() {
    let run = |set: &dyn Fn(&mut World)| {
        let mut w = World::new(10, 10).unwrap();
        floor(&mut w);
        set(&mut w);
        // A column of six boxes dropped a little apart: the passes have something to settle.
        let bodies: Vec<u32> = (0..6).map(|k| block(&mut w, v3(0.02 * k as f32, 0.5 + 0.9 * k as f32, 0.0))).collect();
        for _ in 0..30 {
            w.step(DT);
        }
        bodies
            .iter()
            .flat_map(|&b| {
                let p = w.v(POSITION_X, b as usize);
                [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]
            })
            .collect::<Vec<u32>>()
    };
    let default = run(&|_| {});
    let passes = World::new(1, 1).unwrap().header().iterations;
    assert_eq!(run(&|w| w.header_mut().stabilization = passes), default, "as many relaxing passes as pushing ones is the default");
    assert_ne!(run(&|w| w.header_mut().stabilization = passes + 3), default, "a different count is a different solve");
    // Any count keeps the stack standing.
    for count in [0u32, 1, 4] {
        let mut w = World::new(4, 4).unwrap();
        floor(&mut w);
        w.header_mut().stabilization = count;
        block(&mut w, v3(0.0, 0.25, 0.0));
        let top = block(&mut w, v3(0.0, 0.8, 0.0));
        for _ in 0..300 {
            w.step(DT);
        }
        let y = w.v(POSITION_X, top as usize).y;
        assert!((y - 0.75).abs() < 0.01, "{count} relaxing passes: the top box rests at {y}");
    }
    assert_ne!(NONE, 0);
}

/// A ball shot at a thin wall: where its centre ends the step.
fn shot(set: impl Fn(&mut World)) -> f32 {
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0; 3];
    let wall = w.add_body(FIXED).unwrap();
    w.add_collider(wall, SHAPE_BOX, [0.01, 6.0, 6.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(wall, v3(10.0, 0.0, 0.0), Q::IDENTITY, false);
    let ball = w.add_body(DYNAMIC).unwrap();
    w.add_collider(ball, SHAPE_BALL, [0.05, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_u(FLAGS, ball as usize, w.flags(ball as usize) | CCD);
    w.set_pose(ball, v3(6.0, 0.0, 0.0), Q::IDENTITY, true);
    w.update_mass(ball);
    w.set_v(LINEAR_X, ball as usize, v3(300.0, 0.0, 0.0));
    set(&mut w);
    w.step(DT);
    w.v(POSITION_X, ball as usize).x
}

#[test]
fn the_sweep_stops_where_the_touch_distance_and_the_time_floor_say() {
    // The wall's face is at 9.99 and the ball's radius 0.05: touching is a centre at 9.94.
    let near = shot(|_| {});
    assert!(near <= 9.94 + 1e-5 && near >= 9.94 - 1.5e-3, "the default stops within a millimetre: {near}");
    let wide = shot(|w| w.header_mut().ccd_touch = 0.05);
    assert!(wide <= 9.94 - 0.02 && wide >= 9.94 - 0.06, "a touch of 5 cm stops about that far short: {wide}");
    // An advance shorter than the time floor is not taken: the sweep gives up at the time it reached, which is before any touch.
    let whole = shot(|w| w.header_mut().ccd_min_dt = 1.0 / 60.0);
    assert_eq!(whole, 6.0, "a floor of a whole step takes no advance: the body is put back where the step began");
    let fine = shot(|w| w.header_mut().ccd_min_dt = 1e-9);
    assert_eq!(fine.to_bits(), near.to_bits(), "a floor under every advance is no floor");
    // Two advances are not enough to reach a touch: the time reached is still before it.
    let one = shot(|w| w.header_mut().ccd_advances = 1);
    assert_eq!(one.to_bits(), near.to_bits(), "one advance reaches a wall straight ahead");
    let nothing = shot(|w| w.header_mut().ccd_advances = 0);
    assert_eq!(nothing, 6.0, "no advance at all puts the body back where the step began");
}

#[test]
fn the_simplified_friction_model_holds_and_slides_as_friction_does() {
    holds_and_slides(|w| w.header_mut().friction_model = 1, "simplified friction");
}

/// A box spun about its up axis on a floor: how long it takes to stop, and its speed after a second.
fn spin_down(model: u32) -> (usize, f32) {
    let mut w = World::new(2, 2).unwrap();
    floor(&mut w);
    w.header_mut().friction_model = model;
    let body = block(&mut w, v3(0.0, 0.24, 0.0));
    w.set_v(ANGULAR_X, body as usize, v3(0.0, 6.0, 0.0));
    let mut after_second = 0.0;
    for step in 0..600 {
        w.step(DT);
        if step == 59 {
            after_second = w.v(ANGULAR_X, body as usize).y;
        }
        if w.v(ANGULAR_X, body as usize).y.abs() < 0.01 {
            return (step, after_second);
        }
    }
    (600, after_second)
}

#[test]
fn the_simplified_model_stops_a_spinning_box_with_the_twist_of_its_patch() {
    // A 1 x 0.5 x 1 box spun at 6 rad/s about the vertical: friction at the four corners of the face on the floor stops it at a
    // torque of mu m g times the mean distance of the corners from the centre. The twist limit of the simplified model sums the
    // same loads times the same distances, so it stops the box in about the same time.
    let (coulomb, c_after) = spin_down(0);
    let (simplified, s_after) = spin_down(1);
    assert!(coulomb < 600 && simplified < 600, "both stop it: {coulomb} and {simplified} steps");
    assert!((simplified as f32 - coulomb as f32).abs() <= 0.25 * coulomb as f32, "{simplified} steps against {coulomb}");
    assert!((s_after - c_after).abs() < 0.8, "after a second: {s_after} against {c_after}");
}

#[test]
fn a_tall_stack_stands_under_every_friction_setting() {
    for (model, in_bias, count) in [(0u32, 1u32, NONE), (1, 1, NONE), (0, 0, NONE), (1, 0, NONE), (0, 1, 1), (1, 0, 3)] {
        let mut w = World::new(10, 10).unwrap();
        floor(&mut w);
        let h = w.header_mut();
        (h.friction_model, h.friction_in_bias, h.stabilization) = (model, in_bias, count);
        let bodies: Vec<u32> = (0..8).map(|k| block(&mut w, v3(0.0, 0.25 + 0.5 * k as f32, 0.0))).collect();
        for _ in 0..300 {
            w.step(DT);
        }
        for (k, &b) in bodies.iter().enumerate() {
            let p = w.v(POSITION_X, b as usize);
            assert!(p.x.abs() < 0.01 && p.z.abs() < 0.01 && (p.y - (0.25 + 0.5 * k as f32)).abs() < 0.03, "model {model}, in bias {in_bias}, count {count:?}: box {k} at {} {} {}", p.x, p.y, p.z);
        }
    }
}

#[test]
fn a_body_that_leaves_the_numbers_stops_the_world_or_is_quarantined_by_choice() {
    let build = |quarantine: u32| {
        let mut w = World::new(4, 4).unwrap();
        floor(&mut w);
        w.header_mut().quarantine = quarantine;
        let wild = block(&mut w, v3(5.0, 1.0, 0.0));
        let calm = block(&mut w, v3(0.0, 0.25, 0.0));
        w.set_v(LINEAR_X, wild as usize, v3(1e20, 0.0, 0.0));
        (w, wild, calm)
    };
    let (mut stopped, wild, _) = build(0);
    stopped.step(DT);
    assert_eq!(stopped.header().lost, wild, "by default the world stops and names the body");
    let (mut w, wild, calm) = build(1);
    for _ in 0..60 {
        w.step(DT);
    }
    assert_eq!(w.header().lost, NONE, "with quarantine on the world does not stop");
    assert_eq!(w.header().quarantined, 1, "one body was taken out");
    assert_ne!(w.flags(wild as usize) & (QUARANTINED | DISABLED), 0);
    assert_eq!(w.v(LINEAR_X, wild as usize), v3(0.0, 0.0, 0.0), "at rest");
    let p = w.v(POSITION_X, wild as usize);
    assert!(p.x == 5.0 && p.y == 1.0, "back at the pose the step began from: {} {} {}", p.x, p.y, p.z);
    let y = w.v(POSITION_X, calm as usize).y;
    assert!((y - 0.25).abs() < 0.01, "the other body rests on the floor: {y}");
    let before = w.header().steps;
    w.step(DT);
    assert_eq!(w.header().steps, before + 1, "and the world steps on");
}
