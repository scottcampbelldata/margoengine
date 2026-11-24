// Gears, a rack and pinion and a pulley as rows of the solve: the ratio held, the rope length held, the Atwood acceleration, and a
// replay that gives the same bits.
use margoengine_physics_kernel::couplings::*;
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const DT: f32 = 1.0 / 60.0;
const LOCK_LINEAR_ROWS: u32 = JOINT_LOCK * 7;

fn point(w: &mut World, at: V3, mass: f32, inertia: f32) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    let row = body as usize;
    w.set_s(INVERSE_MASS, row, 1.0 / mass);
    w.set_v(INERTIA_X, row, v3(inertia, inertia, inertia));
    w.set_v(INVERSE_INERTIA_X, row, v3(1.0 / inertia, 1.0 / inertia, 1.0 / inertia));
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, row, w.flags(row) & !CAN_SLEEP);
    body
}
/// A body hinged about z to a fixed body at the same place.
fn wheel(w: &mut World, at: V3, mass: f32, inertia: f32) -> u32 {
    let post = w.add_body(FIXED).unwrap();
    w.set_pose(post, at, Q::IDENTITY, false);
    let body = point(w, at, mass, inertia);
    let joint = w.add_joint(post, body, LOCK_LINEAR_ROWS | JOINT_LOCK * (6 << 3)).unwrap();
    w.set_joint_axis(joint, v3(0.0, 0.0, 1.0));
    body
}
fn run(w: &mut World, steps: u32) {
    for _ in 0..steps {
        w.step(DT);
    }
}

#[test]
fn a_gear_holds_its_ratio_rigid_and_soft() {
    for hertz in [0.0f32, 30.0] {
        let mut w = World::new(8, 8).unwrap();
        w.header_mut().gravity = [0.0; 3];
        let a = wheel(&mut w, v3(0.0, 0.0, 0.0), 2.0, 0.2);
        let b = wheel(&mut w, v3(1.0, 0.0, 0.0), 5.0, 0.5);
        let gear = w.add_coupling(GEAR, a, b).unwrap();
        w.set_coupling(gear, 0, [0.0, 0.0, 1.0]);
        w.set_coupling(gear, 1, [0.0, 0.0, 1.0]);
        w.set_coupling(gear, 6, [2.0, 0.0, 0.0]);
        w.set_coupling(gear, 8, [hertz, 1.0, 0.2]);
        w.set_v(ANGULAR_X, a as usize, v3(0.0, 0.0, 2.0));
        run(&mut w, 120);
        let (wa, wb) = (w.v(ANGULAR_X, a as usize).z, w.v(ANGULAR_X, b as usize).z);
        assert!((wa + 2.0 * wb).abs() < 0.05, "omega_a + 2 omega_b = {} at {hertz} Hz", wa + 2.0 * wb);
        assert!(wb < -0.1, "the second gear turns the other way: {wb}");
    }
}

#[test]
fn a_rack_and_pinion_moves_the_rack_a_radius_a_radian() {
    let mut w = World::new(8, 8).unwrap();
    w.header_mut().gravity = [0.0; 3];
    let pinion = wheel(&mut w, v3(0.0, 0.0, 0.0), 2.0, 0.2);
    let rail = w.add_body(FIXED).unwrap();
    w.set_pose(rail, v3(0.0, -1.0, 0.0), Q::IDENTITY, false);
    let rack = point(&mut w, v3(0.0, -1.0, 0.0), 1.0, 0.1);
    let slide = w.add_joint(rail, rack, JOINT_LOCK * 6 | JOINT_LOCK * (7 << 3)).unwrap();
    w.set_joint_axis(slide, v3(1.0, 0.0, 0.0));
    let joint = w.add_coupling(RACK_AND_PINION, pinion, rack).unwrap();
    w.set_coupling(joint, 0, [0.0, 0.0, 1.0]);
    w.set_coupling(joint, 1, [1.0, 0.0, 0.0]);
    w.set_coupling(joint, 6, [0.5, 0.0, 0.0]);
    w.set_v(ANGULAR_X, pinion as usize, v3(0.0, 0.0, 4.0));
    run(&mut w, 60);
    let (turn, slide) = (w.v(ANGULAR_X, pinion as usize).z, w.v(LINEAR_X, rack as usize).x);
    assert!((0.5 * turn + slide).abs() < 0.03, "r omega + v = {}", 0.5 * turn + slide);
    assert!(slide < -0.2);
}

fn atwood(heavy: f32, light: f32, steps: u32) -> (f32, f32, f32) {
    let mut w = World::new(8, 8).unwrap();
    let a = point(&mut w, v3(-1.0, 0.0, 0.0), heavy, 0.1);
    let b = point(&mut w, v3(1.0, 0.0, 0.0), light, 0.1);
    let rope = w.add_coupling(PULLEY, a, b).unwrap();
    w.set_coupling(rope, 4, [-1.0, 3.0, 0.0]);
    w.set_coupling(rope, 5, [1.0, 3.0, 0.0]);
    w.set_coupling(rope, 6, [1.0, 0.0, 0.0]);
    w.set_coupling(rope, 7, [6.0, 0.0, 0.0]);
    run(&mut w, steps);
    (w.v(POSITION_X, a as usize).y, w.v(POSITION_X, b as usize).y, w.v(LINEAR_X, a as usize).y)
}

#[test]
fn a_pulley_follows_an_atwood_machine_to_one_percent_whatever_the_masses() {
    for (heavy, light) in [(3.0f32, 1.0f32), (1.5, 1.0), (10.0, 9.0)] {
        let (ya, yb, va) = atwood(heavy, light, 30);
        let a = (heavy - light) / (heavy + light) * 9.81;
        let fall = 0.5 * a * 0.25;
        assert!((-ya - fall).abs() < 0.01 * fall, "{heavy}:{light} falls {} against {fall}", -ya);
        assert!((yb + ya).abs() < 0.002, "the other rises as far: {yb} against {}", -ya);
        assert!((-va - a * 0.5).abs() < 0.02 * a * 0.5 + 0.005, "{heavy}:{light} speed {} against {}", -va, a * 0.5);
    }
}

#[test]
fn a_pulley_rope_goes_slack_and_a_replay_gives_the_same_bits() {
    let (ya, _, _) = atwood(1.0, 1.0, 10);
    assert!(ya.abs() < 1e-3, "equal masses stay where they are: {ya}");
    let first = atwood(3.0, 1.0, 45);
    let second = atwood(3.0, 1.0, 45);
    assert_eq!((first.0.to_bits(), first.1.to_bits(), first.2.to_bits()), (second.0.to_bits(), second.1.to_bits(), second.2.to_bits()));
}

fn hang(start: V3, speed: V3, least: f32, most: f32, hertz: f32, steps: u32) -> (f32, V3) {
    let mut w = World::new(8, 8).unwrap();
    let post = w.add_body(FIXED).unwrap();
    w.set_pose(post, v3(0.0, 0.0, 0.0), Q::IDENTITY, false);
    let body = point(&mut w, start, 2.0, 0.1);
    w.set_v(LINEAR_X, body as usize, speed);
    let range = w.add_coupling(DISTANCE, post, body).unwrap();
    w.set_coupling(range, 6, [least, 0.0, 0.0]);
    w.set_coupling(range, 7, [most, 0.0, 0.0]);
    w.set_coupling(range, 8, [hertz, 1.0, 0.2]);
    run(&mut w, steps);
    let p = w.v(POSITION_X, body as usize);
    (sqrt(p.dot(p)), p)
}

#[test]
fn a_distance_range_stops_a_body_at_its_greatest_and_its_least() {
    // Falling from half a metre below the post on a rope of 1 m: it comes to rest a metre below, and goes no further.
    let (length, p) = hang(v3(0.0, -0.5, 0.0), v3(0.0, 0.0, 0.0), 0.0, 1.0, 0.0, 180);
    assert!((length - 1.0).abs() < 0.01, "hangs a metre down: {length}");
    assert!(p.y < -0.98);
    // Slack inside the range: a body between 0.5 and 2 m falls freely there (a quarter of a second drops it 0.31 m).
    let (length, _) = hang(v3(0.0, -1.0, 0.0), v3(0.0, 0.0, 0.0), 0.5, 2.0, 0.0, 15);
    assert!((length - (1.0 + 0.5 * 9.81 * 0.0625)).abs() < 0.03, "free inside the range: {length}");
    // Thrown at the post it stops at the least distance, as a strut would.
    let (length, _) = hang(v3(0.0, 2.0, 0.0), v3(0.0, -6.0, 0.0), 1.0, 0.0, 0.0, 60);
    assert!(length > 0.97, "it cannot come nearer than the least: {length}");
    // A soft limit gives a little, but holds.
    let (length, _) = hang(v3(0.0, -0.5, 0.0), v3(0.0, 0.0, 0.0), 0.0, 1.0, 8.0, 240);
    assert!(length > 1.0 && length < 1.25, "a soft range stretches a little and holds: {length}");
}
