// Joints against what mechanics says, on the world's defaults: 8 substeps, 2 passes, 60 Hz steps.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;
const G: f64 = 9.81;
const LOCK_LINEAR_ROWS: u32 = JOINT_LOCK * 7;
const LOCK_TURNS: u32 = JOINT_LOCK * (7 << 3);

fn world(bodies: u32) -> World {
    World::new(bodies, bodies).unwrap()
}
fn anchor(w: &mut World) -> u32 {
    w.add_body(FIXED).unwrap()
}
fn place(w: &mut World, body: u32, at: V3) {
    w.set_pose(body, at, Q::IDENTITY, false);
}
/// A dynamic body of this mass, with no collider, and a sphere's inertia about its centre.
fn point(w: &mut World, at: V3, mass: f32, inertia: f32) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    let row = body as usize;
    w.set_s(INVERSE_MASS, row, 1.0 / mass);
    w.set_v(INERTIA_X, row, v3(inertia, inertia, inertia));
    w.set_v(INVERSE_INERTIA_X, row, v3(1.0 / inertia, 1.0 / inertia, 1.0 / inertia));
    place(w, body, at);
    w.set_u(FLAGS, row, w.flags(row) & !CAN_SLEEP);
    body
}
fn set_anchor(w: &mut World, joint: u32, on_a: V3, on_b: V3) {
    w.set_v(JOINT_ANCHOR_A_X, joint as usize, on_a);
    w.set_v(JOINT_ANCHOR_B_X, joint as usize, on_b);
}
fn spherical(w: &mut World, a: u32, b: u32, on_a: V3, on_b: V3) -> u32 {
    let joint = w.add_joint(a, b, LOCK_LINEAR_ROWS).unwrap();
    set_anchor(w, joint, on_a, on_b);
    joint
}
fn revolute(w: &mut World, a: u32, b: u32, on_a: V3, on_b: V3, axis: V3) -> u32 {
    let joint = w.add_joint(a, b, LOCK_LINEAR_ROWS | JOINT_LOCK * (6 << 3)).unwrap();
    set_anchor(w, joint, on_a, on_b);
    w.set_joint_axis(joint, axis);
    joint
}
fn prismatic(w: &mut World, a: u32, b: u32, axis: V3) -> u32 {
    let joint = w.add_joint(a, b, JOINT_LOCK * 6 | LOCK_TURNS).unwrap();
    w.set_joint_axis(joint, axis);
    joint
}
fn set_motor(w: &mut World, joint: u32, k: usize, target: f32, speed: f32, stiffness: f32, damping: f32) {
    let row = joint as usize;
    w.set_u(JOINT_FLAGS, row, w.uu(JOINT_FLAGS, row) | JOINT_MOTOR_ON << k);
    w.set_s(JOINT_TARGET_0 + k, row, target);
    w.set_s(JOINT_SPEED_0 + k, row, speed);
    w.set_s(JOINT_STIFFNESS_0 + k, row, stiffness);
    w.set_s(JOINT_DAMPING_0 + k, row, damping);
    w.set_s(JOINT_CAP_0 + k, row, f32::INFINITY);
}
fn set_limit(w: &mut World, joint: u32, k: usize, low: f32, high: f32) {
    let row = joint as usize;
    w.set_u(JOINT_FLAGS, row, w.uu(JOINT_FLAGS, row) | JOINT_LIMIT << k);
    w.set_s(JOINT_MIN_0 + k, row, low);
    w.set_s(JOINT_MAX_0 + k, row, high);
}
fn run(w: &mut World, steps: u32) {
    for _ in 0..steps {
        w.step(DT);
    }
}

/// The complete elliptic integral K(k) by the arithmetic-geometric mean: pi / (2 agm(1, sqrt(1 - k^2))).
fn elliptic_k(k: f64) -> f64 {
    let (mut a, mut b) = (1.0, (1.0 - k * k).sqrt());
    for _ in 0..30 {
        (a, b) = ((a + b) / 2.0, (a * b).sqrt());
    }
    std::f64::consts::PI / (2.0 * a)
}

/// The time between the first two upward crossings of the bob through the bottom, with a pendulum of length `length`.
fn measured_period(w: &mut World, bob: u32, steps: u32) -> f64 {
    let mut crossings = vec![];
    let mut last = w.v(POSITION_X, bob as usize).x as f64;
    for step in 1..=steps {
        w.step(DT);
        let x = w.v(POSITION_X, bob as usize).x as f64;
        if last < 0.0 && x >= 0.0 {
            crossings.push(DT as f64 * (step as f64 - 1.0 + (-last) / (x - last)));
        }
        last = x;
    }
    assert!(crossings.len() >= 3, "only {} crossings", crossings.len());
    (crossings[crossings.len() - 1] - crossings[0]) / (crossings.len() - 1) as f64
}

#[test]
fn atan2_is_the_real_angle_in_every_quadrant() {
    for i in -360..=360 {
        let angle = i as f64 * std::f64::consts::PI / 360.0;
        let (y, x) = (angle.sin() as f32, angle.cos() as f32);
        let got = atan2(y, x) as f64;
        let want = (y as f64).atan2(x as f64);
        assert!((got - want).abs() < 4e-7, "{angle}: {got} against {want}");
    }
    assert_eq!(atan2(0.0, 0.0), 0.0);
}

#[test]
fn a_swung_bob_keeps_the_period_of_the_elliptic_closed_form() {
    // A bob on a light rod. The physical pendulum's length is I / (m L), and T = 4 sqrt(L / g) K(sin(theta / 2)).
    for (degrees, joint_kind) in [(10.0f64, 0), (90.0, 0), (150.0, 0), (90.0, 1)] {
        let mut w = world(4);
            let pivot = anchor(&mut w);
        place(&mut w, pivot, v3(0.0, 2.0, 0.0));
        let theta = degrees.to_radians();
        let length = 1.5f64;
        let (mass, inertia) = (2.0f32, 0.01f32);
        let at = v3((length * theta.sin()) as f32, 2.0 - (length * theta.cos()) as f32, 0.0);
        let bob = point(&mut w, at, mass, inertia);
        // Anchored at the bob's centre plus the rod: a spherical joint holds the point the bob swings about.
        let rod = v3(0.0, length as f32, 0.0);
        let turned = Q { x: 0.0, y: 0.0, z: (theta / 2.0).sin() as f32, w: (theta / 2.0).cos() as f32 };
        w.set_pose(bob, at, turned, false);
        if joint_kind == 0 {
            spherical(&mut w, pivot, bob, v3(0.0, 0.0, 0.0), rod);
        } else {
            revolute(&mut w, pivot, bob, v3(0.0, 0.0, 0.0), rod, v3(0.0, 0.0, 1.0));
        }
        let pivot_inertia = inertia as f64 + mass as f64 * length * length;
        let equivalent = pivot_inertia / (mass as f64 * length);
        let want = 4.0 * (equivalent / G).sqrt() * elliptic_k((theta / 2.0).sin());
        let got = measured_period(&mut w, bob, (want * 6.0 * 60.0) as u32);
        let error = (got - want).abs() / want;
        println!("{degrees} degrees kind {joint_kind}: {got:.5} s against {want:.5} s, {:.3}%", error * 100.0);
        assert!(error < 0.0002, "{degrees} degrees: {got} s against {want} s");
    }
}

fn double_pendulum_energy(w: &World, bodies: [u32; 2], mass: f32, inertia: f32) -> f64 {
    let mut energy = 0.0;
    for body in bodies {
        let row = body as usize;
        let (v, omega) = (w.v(LINEAR_X, row), w.v(ANGULAR_X, row));
        energy += 0.5 * mass as f64 * v.dot(v) as f64 + 0.5 * inertia as f64 * omega.dot(omega) as f64 + mass as f64 * G * w.v(POSITION_X, row).y as f64;
    }
    energy
}

#[test]
fn a_double_pendulum_keeps_its_energy() {
    // Chaotic, so the path is no oracle; energy is. Two rods from level: a joint can only lose energy to the solver.
    let (mass, inertia, half) = (1.0f32, 1.0 / 12.0, 0.5f32);
    let mut w = world(4);
    let pivot = anchor(&mut w);
    let turned = Q { x: 0.0, y: 0.0, z: -(std::f32::consts::FRAC_PI_4).sin(), w: (std::f32::consts::FRAC_PI_4).cos() };
    let first = point(&mut w, v3(half, 0.0, 0.0), mass, inertia);
    let second = point(&mut w, v3(3.0 * half, 0.0, 0.0), mass, inertia);
    w.set_pose(first, v3(half, 0.0, 0.0), turned, false);
    w.set_pose(second, v3(3.0 * half, 0.0, 0.0), turned, false);
    let axis = v3(0.0, 0.0, 1.0);
    revolute(&mut w, pivot, first, v3(0.0, 0.0, 0.0), v3(0.0, -half, 0.0), axis);
    revolute(&mut w, first, second, v3(0.0, half, 0.0), v3(0.0, -half, 0.0), axis);
    let start = double_pendulum_energy(&w, [first, second], mass, inertia);
    let (mut highest, mut lowest) = (start, start);
    for step in 0..1200 {
        w.step(DT);
        let energy = double_pendulum_energy(&w, [first, second], mass, inertia);
        highest = highest.max(energy);
        lowest = lowest.min(energy);
        if step % 300 == 299 {
            println!("{:.0} s: {energy:.4} J (start {start:.4})", (step + 1) as f32 * DT);
        }
    }
    let scale = mass as f64 * G * 4.0 * half as f64;
    println!("highest {:+.4} lowest {:+.4} of {scale:.3} J", highest - start, lowest - start);
    assert!(highest - start < 0.005 * scale, "gained {} J", highest - start);
    assert!(start - lowest < 0.005 * scale, "lost {} J", start - lowest);
}

#[test]
fn a_chain_of_fifty_holds_a_thousand_to_one_end_mass() {
    let links = 50u32;
    let (mass, inertia, half) = (1.0f32, 0.01f32, 0.1f32);
    let mut w = world(64);
    let top = anchor(&mut w);
    let mut bodies = vec![];
    let mut above = top;
    let mut on_above = v3(0.0, 0.0, 0.0);
    for i in 0..links {
        let last = i + 1 == links;
        let y = -((2 * i + 1) as f32) * half;
        let body = if last { point(&mut w, v3(0.0, y, 0.0), 1000.0 * mass, 1000.0 * inertia) } else { point(&mut w, v3(0.0, y, 0.0), mass, inertia) };
        spherical(&mut w, above, body, on_above, v3(0.0, half, 0.0));
        above = body;
        on_above = v3(0.0, -half, 0.0);
        bodies.push(body);
    }
    let full = 2.0 * half * links as f32;
    let end = |w: &World| {
        let v = w.v(POSITION_X, *bodies.last().unwrap() as usize);
        (sqrt(v.dot(v)) + half - full, sqrt(w.v(LINEAR_X, *bodies.last().unwrap() as usize).dot(w.v(LINEAR_X, *bodies.last().unwrap() as usize))))
    };
    let mut worst = 0.0f32;
    for step in 0..600 {
        w.step(DT);
        let (stretch, speed) = end(&w);
        worst = worst.max(stretch);
        if step % 100 == 99 {
            println!("{:.1} s: stretch {stretch:.5} m, speed {speed:.5}", (step + 1) as f32 * DT);
        }
    }
    println!("worst stretch {worst:.5} m of {full} m");
    assert!(worst < 1e-4 * full, "stretched {worst} m");
    // Sideways kick: the swing keeps the chain's length.
    let bottom = *bodies.last().unwrap() as usize;
    w.set_v(LINEAR_X, bottom, v3(3.0, 0.0, 0.0));
    let mut worst = 0.0f32;
    for _ in 0..600 {
        w.step(DT);
        worst = worst.max(end(&w).0);
    }
    println!("swinging: worst stretch {worst:.5} m");
    assert!(worst < 1e-4 * full, "stretched {worst} m in the swing");
}

#[test]
fn a_hinge_motor_reaches_its_target_and_stops_at_its_limit() {
    let mut w = world(4);
    let base = anchor(&mut w);
    let arm = point(&mut w, v3(0.0, 0.0, 0.0), 1.0, 0.1);
    w.set_s(GRAVITY_SCALE, arm as usize, 0.0);
    let hinge = revolute(&mut w, base, arm, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0));
    // A target past the limit: the motor pushes, the limit holds.
    set_motor(&mut w, hinge, 3, 1.0, 0.0, 1000.0, 50.0);
    set_limit(&mut w, hinge, 3, -0.5, 0.5);
    run(&mut w, 120);
    let angle = w.s(JOINT_ANGLE, hinge as usize);
    assert!((angle - 0.5).abs() < 0.02, "stopped at {angle}");
}

#[test]
fn a_velocity_motor_reaches_its_speed() {
    let mut w = world(4);
    let base = anchor(&mut w);
    let arm = point(&mut w, v3(0.0, 0.0, 0.0), 1.0, 0.1);
    w.set_s(GRAVITY_SCALE, arm as usize, 0.0);
    let hinge = revolute(&mut w, base, arm, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0));
    set_motor(&mut w, hinge, 3, 0.0, 2.0, 0.0, 10.0);
    run(&mut w, 120);
    let spin = w.v(ANGULAR_X, arm as usize).y;
    assert!((spin - 2.0).abs() < 0.01, "spins at {spin}");
    // Past half a turn, the angle counts on.
    run(&mut w, 240);
    let angle = w.s(JOINT_ANGLE, hinge as usize);
    assert!(angle > 2.0 * 5.0, "angle {angle}");
}

#[test]
fn a_motor_cap_limits_its_torque() {
    let mut w = world(4);
    let base = anchor(&mut w);
    let arm = point(&mut w, v3(0.0, 0.0, 0.0), 1.0, 0.5);
    w.set_s(GRAVITY_SCALE, arm as usize, 0.0);
    let hinge = revolute(&mut w, base, arm, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0));
    set_motor(&mut w, hinge, 3, 0.0, 100.0, 0.0, 1000.0);
    w.set_s(JOINT_CAP_0 + 3, hinge as usize, 2.0);
    run(&mut w, 60);
    // Two newton metres on 0.5 kg m^2 for a second.
    let spin = w.v(ANGULAR_X, arm as usize).y;
    assert!((spin - 4.0).abs() < 0.01, "spins at {spin}");
}

#[test]
fn a_prismatic_keeps_its_line_and_limits() {
    let mut w = world(4);
    let base = anchor(&mut w);
    let slider = point(&mut w, v3(0.0, 0.0, 0.0), 1.0, 0.1);
    let joint = prismatic(&mut w, base, slider, v3(0.0, 1.0, 0.0));
    set_limit(&mut w, joint, 0, -1.0, 0.5);
    run(&mut w, 240);
    let at = w.v(POSITION_X, slider as usize);
    assert!((at.y + 1.0).abs() < 0.01, "rests at {}", at.y);
    assert!(at.x.abs() < 1e-3 && at.z.abs() < 1e-3, "left the line: {at:?}");
    // Pushed sideways, it stays on the line.
    w.set_v(LINEAR_X, slider as usize, v3(5.0, 0.0, 0.0));
    w.set_v(ANGULAR_X, slider as usize, v3(3.0, 1.0, 2.0));
    run(&mut w, 60);
    let at = w.v(POSITION_X, slider as usize);
    assert!(at.x.abs() < 1e-3, "left the line: {at:?}");
    let q = w.q(ROTATION_X, slider as usize);
    assert!(q.w > 0.9999, "turned: {q:?}");
}

#[test]
fn a_prismatic_motor_holds_a_load_at_its_spring_point() {
    let mut w = world(4);
    let base = anchor(&mut w);
    let slider = point(&mut w, v3(0.0, 0.0, 0.0), 2.0, 0.1);
    let joint = prismatic(&mut w, base, slider, v3(0.0, 1.0, 0.0));
    // A force model spring: 2 kg at k = 500 sags m g / k below the target.
    set_motor(&mut w, joint, 0, 0.0, 0.0, 500.0, 60.0);
    w.set_u(JOINT_FLAGS, joint as usize, w.uu(JOINT_FLAGS, joint as usize) | JOINT_MOTOR_FORCE);
    run(&mut w, 600);
    let y = w.v(POSITION_X, slider as usize).y as f64;
    let want = -2.0 * G / 500.0;
    assert!((y - want).abs() < 1e-3, "rests at {y}, want {want}");
}

#[test]
fn a_fixed_joint_holds_a_heavy_body_rigid() {
    let mut w = world(4);
    let base = anchor(&mut w);
    let held = point(&mut w, v3(1.0, 0.0, 0.0), 1000.0, 100.0);
    let joint = w.add_joint(base, held, LOCK_LINEAR_ROWS | LOCK_TURNS).unwrap();
    set_anchor(&mut w, joint, v3(0.0, 0.0, 0.0), v3(-1.0, 0.0, 0.0));
    run(&mut w, 300);
    let at = w.v(POSITION_X, held as usize);
    assert!(at.sub(v3(1.0, 0.0, 0.0)).dot(at.sub(v3(1.0, 0.0, 0.0))) < 1e-6, "drooped to {at:?}");
}

#[test]
fn bodies_a_joint_holds_do_not_collide_unless_asked() {
    for contacts in [false, true] {
        let mut w = world(4);
        let a = w.add_body(DYNAMIC).unwrap();
        w.add_collider(a, SHAPE_BOX, [0.5; 3], [0.0; 3], IDENTITY, 1.0).unwrap();
        let b = w.add_body(DYNAMIC).unwrap();
        w.add_collider(b, SHAPE_BOX, [0.5; 3], [0.0; 3], IDENTITY, 1.0).unwrap();
        w.header_mut().gravity = [0.0; 3];
        w.set_pose(b, v3(0.3, 0.0, 0.0), Q::IDENTITY, false);
        let flags = if contacts { JOINT_CONTACTS } else { 0 };
        w.add_joint(a, b, flags).unwrap();
        run(&mut w, 30);
        let apart = w.v(POSITION_X, b as usize).x - w.v(POSITION_X, a as usize).x;
        if contacts {
            assert!(apart > 0.9, "the pair stayed inside each other: {apart}");
        } else {
            assert!((apart - 0.3).abs() < 1e-5, "the pair moved: {apart}");
        }
    }
}

#[test]
fn removing_a_body_removes_its_joints_and_the_rows_come_back() {
    let mut w = world(8);
    let base = anchor(&mut w);
    let one = point(&mut w, v3(0.0, -1.0, 0.0), 1.0, 0.1);
    let two = point(&mut w, v3(0.0, -2.0, 0.0), 1.0, 0.1);
    let first = spherical(&mut w, base, one, v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0));
    let second = spherical(&mut w, one, two, v3(0.0, -0.5, 0.0), v3(0.0, 0.5, 0.0));
    run(&mut w, 10);
    assert!(w.remove_body(one));
    assert_eq!(w.uu(JOINT_FLAGS, first as usize), 0);
    assert_eq!(w.uu(JOINT_FLAGS, second as usize), 0);
    assert_eq!(w.uu(FIRST_JOINT, base as usize), NONE);
    assert_eq!(w.uu(FIRST_JOINT, two as usize), NONE);
    // Freed rows come back last in, first out.
    let three = point(&mut w, v3(0.0, -3.0, 0.0), 1.0, 0.1);
    let again = spherical(&mut w, base, three, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0));
    assert!(again == first || again == second);
    assert!(!w.remove_joint(99));
    assert!(w.remove_joint(again));
    assert!(!w.remove_joint(again), "a row removed twice");
    run(&mut w, 10);
}

#[test]
fn joined_bodies_sleep_as_one_island_and_a_touch_wakes_them() {
    let mut w = world(8);
    let base = anchor(&mut w);
    let one = w.add_body(DYNAMIC).unwrap();
    w.add_collider(one, SHAPE_BALL, [0.1, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    place(&mut w, one, v3(0.0, -0.5, 0.0));
    let two = w.add_body(DYNAMIC).unwrap();
    w.add_collider(two, SHAPE_BALL, [0.1, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    place(&mut w, two, v3(0.0, -1.0, 0.0));
    spherical(&mut w, base, one, v3(0.0, 0.0, 0.0), v3(0.0, 0.5, 0.0));
    spherical(&mut w, one, two, v3(0.0, -0.25, 0.0), v3(0.0, 0.25, 0.0));
    run(&mut w, 120);
    assert_eq!(w.header().awake, 0, "the chain never slept");
    assert!(w.flags(one as usize) & SLEEPING != 0 && w.flags(two as usize) & SLEEPING != 0);
    w.wake(two);
    assert_eq!(w.header().awake, 2, "a ring of two");
    run(&mut w, 1);
    assert_eq!(w.header().islands, 1, "two joined bodies are one island");
}

#[test]
fn a_joint_keeps_its_impulses_in_the_hash_and_replays_bit_for_bit() {
    let scene = || {
        let mut w = world(8);
        let base = anchor(&mut w);
        let one = point(&mut w, v3(0.7, -0.7, 0.0), 1.0, 0.1);
        let two = point(&mut w, v3(1.4, -1.4, 0.0), 1.0, 0.1);
        spherical(&mut w, base, one, v3(0.0, 0.0, 0.0), v3(-0.7, 0.7, 0.0));
        revolute(&mut w, one, two, v3(0.35, -0.35, 0.0), v3(-0.35, 0.35, 0.0), v3(0.0, 0.0, 1.0));
        run(&mut w, 200);
        w.hash()
    };
    assert_eq!(scene(), scene());
}

/// How far any joint's anchors lie apart.
fn worst_gap(w: &World, joints: &[u32]) -> f32 {
    let mut worst = 0.0f32;
    for &joint in joints {
        let row = joint as usize;
        let (a, b) = (w.uu(JOINT_A, row) as usize, w.uu(JOINT_B, row) as usize);
        let on = |body: usize, anchor: V3| w.v(POSITION_X, body).add(w.q(ROTATION_X, body).rotate(anchor));
        let gap = on(b, w.v(JOINT_ANCHOR_B_X, row)).sub(on(a, w.v(JOINT_ANCHOR_A_X, row)));
        worst = worst.max(sqrt(gap.dot(gap)));
    }
    worst
}

/// The tree below, its hub started `shift` along X, and the widest any joint opened in 10 s.
fn tree_gap(shift: f32) -> f32 {
    // A hub joins four arms, so no path runs through it and the arms settle against each other pass by pass.
    let mut w = world(64);
    let top = anchor(&mut w);
    let hub = point(&mut w, v3(shift, -1.0, 0.0), 100.0, 10.0);
    let mut joints = vec![spherical(&mut w, top, hub, v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0))];
    for arm in 0..3 {
        let side = v3([1.0, -1.0, 0.0][arm], 0.0, [0.0, 0.0, 1.0][arm]);
        let mut above = hub;
        let mut on_above = side.scale(0.5);
        for link in 0..8 {
            let at = v3(shift, -1.0, 0.0).add(side.scale(0.5 + 0.5 * link as f32 + 0.25));
            let body = point(&mut w, at, 1.0, 0.02);
            joints.push(spherical(&mut w, above, body, on_above, side.scale(-0.25)));
            above = body;
            on_above = side.scale(0.25);
        }
    }
    let mut worst = 0.0f32;
    for _ in 0..600 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
    }
    worst
}

#[test]
fn a_branching_tree_with_a_heavy_hub_holds_together() {
    let worst = tree_gap(0.0);
    println!("tree: worst anchor gap {worst:.5} m");
    assert!(worst < 0.02, "a joint opened by {worst} m");
}

#[test]
fn the_tree_holds_from_any_start_a_rounding_away() {
    // The widest gap is the peak of a swing that rounding steers: batch 125 saw it move from 6.66 to 7.25 mm when only how K
    // is factored changed, and a micrometre's shift of the hub moves it as far. So the bound must hold for every start.
    for shift in [1e-6f32, -1e-6, 1e-5, -1e-5, 1e-4, -1e-4, 3e-4, -3e-4] {
        let worst = tree_gap(shift);
        println!("tree, hub shifted {shift}: worst anchor gap {worst:.5} m");
        assert!(worst < 0.02, "shifted {shift}, a joint opened by {worst} m");
    }
}

#[test]
fn a_closed_ring_and_a_grid_of_links_stay_together() {
    // Loops: a ring stops one joint short of a path, and a grid is all branches.
    let mut w = world(128);
    let (bodies, joints) = grid(&mut w, 8);
    let mut worst = 0.0f32;
    for _ in 0..600 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
    }
    println!("grid: worst anchor gap {worst:.5} m");
    assert!(worst < 0.02, "a joint opened by {worst} m");
    let moving = bodies.iter().map(|&b| { let v = w.v(LINEAR_X, b as usize); sqrt(v.dot(v)) }).fold(0.0f32, f32::max);
    println!("grid: fastest body after 10 s {moving:.4} m/s");
    assert!(moving < 0.5, "still moving at {moving} m/s");

    let mut w = world(16);
    let mut ring = vec![];
    for i in 0..6 {
        let angle = i as f32 * PI / 3.0;
        let (s, c) = (sinish(angle), cosish(angle));
        ring.push(point(&mut w, v3(c, s, 0.0), 1.0, 0.1));
    }
    let mut joints = vec![];
    for i in 0..6 {
        let (a, b) = (ring[i], ring[(i + 1) % 6]);
        let middle = w.v(POSITION_X, a as usize).add(w.v(POSITION_X, b as usize)).scale(0.5);
        let on_a = middle.sub(w.v(POSITION_X, a as usize));
        let on_b = middle.sub(w.v(POSITION_X, b as usize));
        joints.push(spherical(&mut w, a, b, on_a, on_b));
    }
    w.header_mut().gravity = [0.0; 3];
    w.set_v(ANGULAR_X, ring[0] as usize, v3(0.0, 0.0, 20.0));
    let mut worst = 0.0f32;
    for _ in 0..300 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
    }
    println!("ring: worst anchor gap {worst:.5} m");
    assert!(worst < 0.02, "a joint opened by {worst} m");
}

/// The largest impulse any joint remembers.
fn most_impulse(w: &World, joints: &[u32]) -> f32 {
    let mut most = 0.0f32;
    for &joint in joints {
        for k in 0..6 {
            most = most.max(w.s(JOINT_IMPULSE_0 + k, joint as usize).abs());
        }
    }
    most
}

/// A grid of `size` by `size` unit bodies, each joined to its neighbours halfway, its top row pinned at the bodies' centres.
fn grid(w: &mut World, size: i32) -> (Vec<u32>, Vec<u32>) {
    let top = anchor(w);
    let mut bodies = vec![];
    let mut joints = vec![];
    for y in 0..size {
        for x in 0..size {
            let body = point(w, v3(x as f32, -(y as f32), 0.0), 1.0, 0.1);
            bodies.push(body);
            if y == 0 {
                joints.push(spherical(w, top, body, v3(x as f32, 0.0, 0.0), v3(0.0, 0.0, 0.0)));
            } else {
                let above = bodies[((y - 1) * size + x) as usize];
                joints.push(spherical(w, above, body, v3(0.0, -0.5, 0.0), v3(0.0, 0.5, 0.0)));
            }
            if x > 0 {
                let left = bodies[(y * size + x - 1) as usize];
                joints.push(spherical(w, left, body, v3(0.5, 0.0, 0.0), v3(-0.5, 0.0, 0.0)));
            }
        }
    }
    (bodies, joints)
}

#[test]
fn a_grid_carries_its_weight_and_no_more() {
    // The rows of a grid depend on each other (360 rows, rank 311 at 8 by 8) and the passes do not settle it in a substep.
    // What the joints remember must still come to the weight of a column: 8 kg over a substep at the top pin.
    let mut w = world(128);
    let (_, joints) = grid(&mut w, 8);
    let h = (DT / 8.0) as f64;
    let weight = 8.0 * G * h;
    let mut most = 0.0f32;
    for step in 0..600 {
        w.step(DT);
        if step >= 60 {
            most = most.max(most_impulse(&w, &joints));
        }
    }
    println!("grid: most impulse after a second {most:.5} N s, a column weighs {weight:.5} N s");
    assert!((most as f64 - weight).abs() < 0.05 * weight, "{most} N s against {weight}");
}

#[test]
fn a_bigger_grid_stays_together_too() {
    // The slowest mode of the passes slows as a grid grows, so a rule that holds at 8 by 8 by luck breaks here.
    let mut w = world(1024);
    let (bodies, joints) = grid(&mut w, 30);
    let mut worst = 0.0f32;
    for _ in 0..300 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
    }
    let moving = bodies.iter().map(|&b| { let v = w.v(LINEAR_X, b as usize); sqrt(v.dot(v)) }).fold(0.0f32, f32::max);
    println!("grid of 30: worst anchor gap {worst:.5} m, fastest body {moving:.5} m/s");
    assert!(worst < 0.02, "a joint opened by {worst} m");
    assert!(moving < 0.5, "still moving at {moving} m/s");
}

#[test]
fn links_pinned_straight_between_two_walls_hold() {
    // Baraff 1996, footnote 5: a straight chain fixed at both ends is the case where J M^-1 J^T is singular. Rigid links in
    // a line cannot sag without opening a joint, so the load has nowhere to go.
    let mut w = world(8);
    let wall = anchor(&mut w);
    let links: Vec<u32> = (0..3).map(|i| point(&mut w, v3(0.5 + i as f32, 0.0, 0.0), 1.0, 0.1)).collect();
    let (on_left, on_right) = (v3(-0.5, 0.0, 0.0), v3(0.5, 0.0, 0.0));
    let joints = vec![
        spherical(&mut w, wall, links[0], v3(0.0, 0.0, 0.0), on_left),
        spherical(&mut w, links[0], links[1], on_right, on_left),
        spherical(&mut w, links[1], links[2], on_right, on_left),
        spherical(&mut w, links[2], wall, on_right, v3(3.0, 0.0, 0.0)),
    ];
    let (mut worst, mut most) = (0.0f32, 0.0f32);
    for _ in 0..600 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
        most = most.max(most_impulse(&w, &joints));
    }
    let sag = -w.v(POSITION_X, links[1] as usize).y;
    println!("straight links: worst gap {worst:.5} m, sag {sag:.5} m, most impulse {most:.4} N s");
    assert!(worst < 0.02, "a joint opened by {worst} m");
}

#[test]
fn a_parallelogram_swings_as_its_closed_form_says() {
    // Two equal cranks and a coupler: a loop with one degree of freedom. The coupler stays level and moves on a circle, so
    // the energy is that of one pendulum of length (2 I + M L^2) / ((m + M) L), I each crank's inertia about its pivot.
    let (length, span) = (1.0f64, 2.0f64);
    let (mass, inertia, coupler, coupler_inertia) = (1.0f32, 0.05f32, 2.0f32, 0.5f32);
    let theta = 60f64.to_radians();
    let (s, c) = (theta.sin(), theta.cos());
    let mut w = world(8);
    let ground = anchor(&mut w);
    let turned = Q { x: 0.0, y: 0.0, z: (theta / 2.0).sin() as f32, w: (theta / 2.0).cos() as f32 };
    let half = length / 2.0;
    let left_at = v3((half * s) as f32, -(half * c) as f32, 0.0);
    let right_at = v3((span + half * s) as f32, -(half * c) as f32, 0.0);
    let left = point(&mut w, left_at, mass, inertia);
    let right = point(&mut w, right_at, mass, inertia);
    w.set_pose(left, left_at, turned, false);
    w.set_pose(right, right_at, turned, false);
    let bar_at = v3((span / 2.0 + length * s) as f32, -(length * c) as f32, 0.0);
    let bar = point(&mut w, bar_at, coupler, coupler_inertia);
    let axis = v3(0.0, 0.0, 1.0);
    let (up, down) = (v3(0.0, half as f32, 0.0), v3(0.0, -half as f32, 0.0));
    let side = v3((span / 2.0) as f32, 0.0, 0.0);
    let joints = vec![
        revolute(&mut w, ground, left, v3(0.0, 0.0, 0.0), up, axis),
        revolute(&mut w, ground, right, v3(span as f32, 0.0, 0.0), up, axis),
        revolute(&mut w, left, bar, down, side.scale(-1.0), axis),
        revolute(&mut w, right, bar, down, side, axis),
    ];
    let pivot = inertia as f64 + mass as f64 * half * half;
    let equivalent = (2.0 * pivot + coupler as f64 * length * length) / ((mass as f64 + coupler as f64) * length);
    let want = 4.0 * (equivalent / G).sqrt() * elliptic_k((theta / 2.0).sin());
    let (mut worst, mut last, mut crossings, mut tilt) = (0.0f32, w.v(POSITION_X, bar as usize).x as f64 - span / 2.0, vec![], 0.0f32);
    for step in 1..=(want * 6.0 * 60.0) as u32 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
        let q = w.q(ROTATION_X, bar as usize);
        tilt = tilt.max(q.z.abs());
        let x = w.v(POSITION_X, bar as usize).x as f64 - span / 2.0;
        if last < 0.0 && x >= 0.0 {
            crossings.push(DT as f64 * (step as f64 - 1.0 + (-last) / (x - last)));
        }
        last = x;
    }
    let got = (crossings[crossings.len() - 1] - crossings[0]) / (crossings.len() - 1) as f64;
    let error = (got - want).abs() / want;
    println!("parallelogram: {got:.5} s against {want:.5} s, {:.3}%, worst gap {worst:.5} m, tilt {tilt:.5}", error * 100.0);
    assert!(worst < 0.02, "a joint opened by {worst} m");
    assert!(tilt < 0.01, "the coupler turned by {tilt}");
    assert!(error < 0.002, "{got} s against {want} s");
}

#[test]
fn a_chain_held_straight_by_its_limits_stays_up() {
    // A cantilever of hinges, every one against its stop: the limits carry the whole moment, one row each, and the passes
    // do not settle them in a substep. Remembering the push flung this chain up and over the wall. At twelve links the rows
    // still droop (docs/limits.md): one row at a time cannot carry a moment that long.
    let links = 6;
    let mut w = world(32);
    let wall = anchor(&mut w);
    let (mut above, mut on_above) = (wall, v3(0.0, 0.0, 0.0));
    let mut joints = vec![];
    let mut bodies = vec![];
    let (right, left) = (v3(0.25, 0.0, 0.0), v3(-0.25, 0.0, 0.0));
    for i in 0..links {
        let body = point(&mut w, v3(0.25 + 0.5 * i as f32, 0.0, 0.0), 1.0, 0.02);
        let joint = revolute(&mut w, above, body, on_above, left, v3(0.0, 0.0, 1.0));
        set_limit(&mut w, joint, 3, 0.0, 1.0);
        joints.push(joint);
        bodies.push(body);
        (above, on_above) = (body, right);
    }
    let (mut worst, mut fastest) = (0.0f32, 0.0f32);
    for step in 0..600 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
        if step >= 300 {
            for &b in &bodies {
                let v = w.v(LINEAR_X, b as usize);
                fastest = fastest.max(sqrt(v.dot(v)));
            }
        }
    }
    let tip = w.v(POSITION_X, *bodies.last().unwrap() as usize);
    println!("cantilever: tip at {:.4} {:.4}, worst gap {worst:.5} m, fastest after 5 s {fastest:.5} m/s", tip.x, tip.y);
    assert!(worst < 0.02, "a joint opened by {worst} m");
    assert!(fastest < 0.1, "still moving at {fastest} m/s");
    assert!(tip.y.abs() < 0.05 && tip.x > 2.7, "the tip went to {tip:?}");
}

#[test]
fn one_pass_a_substep_still_holds_a_grid() {
    let mut w = world(128);
    w.header_mut().iterations = 1;
    let (_, joints) = grid(&mut w, 8);
    let mut worst = 0.0f32;
    for _ in 0..300 {
        w.step(DT);
        worst = worst.max(worst_gap(&w, &joints));
    }
    println!("one pass: worst anchor gap {worst:.5} m");
    assert!(worst < 0.02, "a joint opened by {worst} m");
}

/// A ball joint with a cone: swing limits about frame Y and Z, a twist range about frame X, and frame X along `axis`.
fn cone(w: &mut World, a: u32, b: u32, on_a: V3, on_b: V3, axis: V3, swing: (f32, f32), twist: (f32, f32)) -> u32 {
    let joint = w.add_joint(a, b, LOCK_LINEAR_ROWS | JOINT_CONE | JOINT_LIMIT << 3 | JOINT_LIMIT << 4).unwrap();
    set_anchor(w, joint, on_a, on_b);
    w.set_joint_axis(joint, axis);
    let row = joint as usize;
    w.set_s(JOINT_MIN_3, row, twist.0);
    w.set_s(JOINT_MAX_3, row, twist.1);
    w.set_s(JOINT_MIN_4, row, f32::NEG_INFINITY);
    w.set_s(JOINT_MIN_5, row, swing.0);
    w.set_s(JOINT_MAX_5, row, swing.1);
    joint
}

/// A rod of one metre hanging from a fixed point along `tilt`, a unit vector, its bob at the far end.
fn rod_on_a_cone(w: &mut World, swing: (f32, f32), twist: (f32, f32)) -> (u32, u32) {
    let top = anchor(w);
    let rod = point(w, v3(0.0, -0.5, 0.0), 1.0, 0.1);
    let joint = cone(w, top, rod, v3(0.0, 0.0, 0.0), v3(0.0, 0.5, 0.0), v3(0.0, -1.0, 0.0), swing, twist);
    (rod, joint)
}

/// How far a rod from the origin has swung from straight down, in radians.
fn swung(w: &World, rod: u32) -> (f64, f64) {
    let v = w.q(ROTATION_X, rod as usize).rotate(v3(0.0, -1.0, 0.0));
    let (x, y, z) = (v.x as f64, v.y as f64, v.z as f64);
    ((x * x + z * z).sqrt().atan2(-y), x.atan2(z))
}

#[test]
fn a_cone_stops_a_swing_at_its_edge() {
    // Thrown out along each direction, a rod comes to rest on the circle of the cone, wherever it hits.
    for (x, z) in [(1.0f32, 0.0f32), (0.0, 1.0), (0.6, 0.8), (-0.8, 0.6)] {
        let mut w = world(4);
        w.header_mut().gravity = [0.0; 3];
        let (rod, _) = rod_on_a_cone(&mut w, (0.5, 0.5), (-1.0, 1.0));
        w.set_v(LINEAR_X, rod as usize, v3(3.0 * x, 0.0, 3.0 * z));
        w.set_v(ANGULAR_X, rod as usize, v3(-6.0 * z, 0.0, 6.0 * x));
        let mut most = 0.0f64;
        for _ in 0..240 {
            w.step(DT);
            most = most.max(swung(&w, rod).0);
        }
        println!("cone at {x} {z}: most {most:.4}, ends at {:.4}", swung(&w, rod).0);
        assert!(most < 0.51, "swung to {most} past 0.5");
        assert!(most > 0.49, "stopped short at {most}");
        assert!((swung(&w, rod).0 - 0.5).abs() < 0.001, "came off the edge to {}", swung(&w, rod).0);
    }
}

#[test]
fn a_cone_of_two_limits_is_an_ellipse() {
    // Limits of 0.3 about frame Y and 0.8 about frame Z. With frame X down, the swing that lies along frame Z's turn moves
    // the tip along frame Y, and the edge of the ellipse is reached at each limit along its own axis.
    for (kick, limit) in [(v3(0.0, 0.0, 6.0), 0.8f64), (v3(6.0, 0.0, 0.0), 0.3)] {
        let mut w = world(4);
        w.header_mut().gravity = [0.0; 3];
        let (rod, joint) = rod_on_a_cone(&mut w, (0.3, 0.8), (-1.0, 1.0));
        let frame = w.q(JOINT_FRAME_A_X, joint as usize);
        println!("frame Y {:?} Z {:?}", frame.rotate(v3(0.0, 1.0, 0.0)), frame.rotate(v3(0.0, 0.0, 1.0)));
        w.set_v(ANGULAR_X, rod as usize, kick);
        w.set_v(LINEAR_X, rod as usize, kick.cross(v3(0.0, -0.5, 0.0)));
        let mut most = 0.0f64;
        for _ in 0..240 {
            w.step(DT);
            most = most.max(swung(&w, rod).0);
        }
        println!("ellipse: most {most:.4} against {limit}");
        assert!((most - limit).abs() < 0.01, "swung to {most}, limit {limit}");
    }
}

#[test]
fn a_cone_limits_twist_with_or_without_a_swing() {
    // Spun about its own length, straight or tilted inside its cone, the rod stops at the twist limit.
    for tilt in [0.0f32, 0.45] {
        let mut w = world(4);
        w.header_mut().gravity = [0.0; 3];
        let (rod, joint) = rod_on_a_cone(&mut w, (0.5, 0.5), (-0.4, 0.4));
        let turned = Q { x: 0.0, y: 0.0, z: sinish(tilt / 2.0), w: cosish(tilt / 2.0) };
        w.set_pose(rod, turned.rotate(v3(0.0, -0.5, 0.0)), turned, false);
        w.set_v(ANGULAR_X, rod as usize, turned.rotate(v3(0.0, -4.0, 0.0)));
        run(&mut w, 120);
        let frame_a = w.q(JOINT_FRAME_A_X, joint as usize);
        let frame_b = w.q(ROTATION_X, rod as usize).mul(w.q(JOINT_FRAME_B_X, joint as usize));
        let q = frame_a.conjugate().mul(frame_b);
        let twist = 2.0 * atan2(q.x, q.w);
        let spin = w.v(ANGULAR_X, rod as usize);
        println!("tilt {tilt}: twist stops at {twist:.4}, spin {:.5}", sqrt(spin.dot(spin)));
        assert!((twist.abs() - 0.4).abs() < 0.002, "twisted to {twist}");
        // Tilted, the stop takes only the spin along the bisector, and the rest swings on: the rod is free to.
        assert!(tilt > 0.0 || sqrt(spin.dot(spin)) < 0.01, "still spinning");
    }
}

#[test]
fn a_hinge_stops_dead_on_its_limit() {
    // A rod thrown round a hinge at its end, into a stop. The limit's row must see the hinge's locks: alone it moves the free
    // body, the locks take most of that back, and what the warm start then remembers sent the rod off the stop at a quarter
    // of its speed.
    let mut w = world(4);
    w.header_mut().gravity = [0.0; 3];
    let top = anchor(&mut w);
    let rod = point(&mut w, v3(0.5, 0.0, 0.0), 1.0, 0.1);
    let joint = revolute(&mut w, top, rod, v3(0.0, 0.0, 0.0), v3(-0.5, 0.0, 0.0), v3(0.0, 0.0, 1.0));
    set_limit(&mut w, joint, 3, -0.5, 0.5);
    w.set_v(ANGULAR_X, rod as usize, v3(0.0, 0.0, 6.0));
    w.set_v(LINEAR_X, rod as usize, v3(0.0, 3.0, 0.0));
    run(&mut w, 30);
    let turn = |w: &World| {
        let q = w.q(ROTATION_X, rod as usize);
        2.0 * atan2(q.z, q.w)
    };
    let (angle, spin) = (turn(&w), w.v(ANGULAR_X, rod as usize).z);
    println!("hinge stop: at {angle:.5}, spin {spin:.5}");
    assert!((angle - 0.5).abs() < 1e-3, "the rod is at {angle}");
    assert!(spin.abs() < 1e-3, "the rod left the stop at {spin} rad/s");
}

/// How far frame X of a joint's body B stands from the middle of its cone on body A, in radians.
fn off_centre(w: &World, a: u32, b: u32, centre: V3) -> f64 {
    let (from, to) = (w.q(ROTATION_X, a as usize).rotate(centre), w.q(ROTATION_X, b as usize).rotate(v3(1.0, 0.0, 0.0)));
    let (from, to) = ([from.x as f64, from.y as f64, from.z as f64], [to.x as f64, to.y as f64, to.z as f64]);
    (from[0] * to[0] + from[1] * to[1] + from[2] * to[2]).clamp(-1.0, 1.0).acos()
}

#[test]
fn a_light_link_holds_a_heavy_one_on_its_cones() {
    // A wall, a link of a hundredth of the mass, and a full link at its end, each joint a cone of 0.2: the light link's limit
    // carries the heavy one, and how well must not depend on the light link's own inertia.
    for (mass, inertia) in [(1.0f32, 0.1f32), (0.01, 0.001)] {
        let mut w = world(4);
        let wall = anchor(&mut w);
        let light = point(&mut w, v3(0.25, 0.0, 0.0), mass, inertia);
        let heavy = point(&mut w, v3(0.75, 0.0, 0.0), 1.0, 0.1);
        let along = v3(1.0, 0.0, 0.0);
        cone(&mut w, wall, light, v3(0.0, 0.0, 0.0), v3(-0.25, 0.0, 0.0), along, (0.2, 0.2), (-0.3, 0.3));
        cone(&mut w, light, heavy, v3(0.25, 0.0, 0.0), v3(-0.25, 0.0, 0.0), along, (0.2, 0.2), (-0.3, 0.3));
        run(&mut w, 600);
        let (near, far) = (off_centre(&w, wall, light, along), off_centre(&w, light, heavy, along));
        let v = w.v(LINEAR_X, heavy as usize);
        println!("light link {mass}: off centre {near:.4} and {far:.4}, end speed {:.5}", sqrt(v.dot(v)));
        assert!(near < 0.21 && far < 0.21, "the cones gave way to {near} and {far}");
    }
}

#[test]
fn a_limb_a_floor_holds_past_its_cone_rests() {
    // docs/known-bugs.md, "A limp ragdoll keeps moving": a heavy body on a floor with a limb whose two cones point down through
    // the floor, so the cones and the floor cannot both hold. Everything must come to rest, and the push out of a limit must not
    // depend on the limb: a hand of a hundredth of the density rests as a full one does.
    for density in [300.0f32, 3.0] {
        let mut w = world(16);
        let floor = w.add_body(FIXED).unwrap();
        w.add_collider(floor, SHAPE_BOX, [20.0, 0.5, 20.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        place(&mut w, floor, v3(0.0, -0.5, 0.0));
        let torso = w.add_body(DYNAMIC).unwrap();
        w.add_collider(torso, SHAPE_BOX, [0.5, 0.15, 0.3], [0.0; 3], IDENTITY, 500.0).unwrap();
        place(&mut w, torso, v3(0.0, 0.15, 0.0));
        let upper = w.add_body(DYNAMIC).unwrap();
        w.add_collider(upper, SHAPE_BOX, [0.25, 0.05, 0.05], [0.0; 3], IDENTITY, 300.0).unwrap();
        place(&mut w, upper, v3(0.75, 0.05, 0.0));
        let hand = w.add_body(DYNAMIC).unwrap();
        w.add_collider(hand, SHAPE_BOX, [0.1, 0.03, 0.05], [0.0; 3], IDENTITY, density).unwrap();
        place(&mut w, hand, v3(1.1, 0.03, 0.0));
        // Both cones point 40 degrees below the line of the limb, and allow 20.
        let down = v3(cosish(0.7), -sinish(0.7), 0.0);
        let straight = Q { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };
        let shoulder = cone(&mut w, torso, upper, v3(0.5, -0.1, 0.0), v3(-0.25, 0.0, 0.0), down, (0.35, 0.35), (-0.3, 0.3));
        w.set_q(JOINT_FRAME_B_X, shoulder as usize, straight);
        let wrist = cone(&mut w, upper, hand, v3(0.25, -0.02, 0.0), v3(-0.1, 0.0, 0.0), down, (0.35, 0.35), (-0.3, 0.3));
        w.set_q(JOINT_FRAME_B_X, wrist as usize, straight);
        let mut fastest = 0.0f32;
        for step in 0..600 {
            w.step(DT);
            if step >= 300 {
                for b in [torso, upper, hand] {
                    let v = w.v(LINEAR_X, b as usize);
                    fastest = fastest.max(sqrt(v.dot(v)));
                }
            }
        }
        let (past_shoulder, past_wrist) = (off_centre(&w, torso, upper, down) - 0.35, off_centre(&w, upper, hand, down) - 0.35);
        println!("limb, hand density {density}: fastest after 5 s {fastest:.5} m/s, past the limit {past_shoulder:.3} and {past_wrist:.3} rad");
        assert!(fastest < 0.1, "still moving at {fastest} m/s");
        assert!(past_wrist < 0.6, "the wrist stands {past_wrist} rad past its cone");
    }
}

fn sinish(angle: f32) -> f32 {
    (angle as f64).sin() as f32
}
fn cosish(angle: f32) -> f32 {
    (angle as f64).cos() as f32
}

#[test]
fn a_door_on_a_hinge_falls_onto_a_floor_and_rests() {
    // A contact and a joint on one body: the two must settle together.
    let mut w = world(4);
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [5.0, 0.5, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    place(&mut w, floor, v3(0.0, -0.5, 0.0));
    let door = w.add_body(DYNAMIC).unwrap();
    w.add_collider(door, SHAPE_BOX, [1.0, 0.05, 0.5], [0.0; 3], IDENTITY, 100.0).unwrap();
    let hinge_at = v3(0.0, 0.05, 0.0);
    let turned = Q { x: 0.0, y: 0.0, z: 0.25f32.sin(), w: 0.25f32.cos() };
    w.set_pose(door, hinge_at.add(turned.rotate(v3(1.0, 0.0, 0.0))), turned, false);
    let hold = w.add_body(FIXED).unwrap();
    place(&mut w, hold, hinge_at);
    revolute(&mut w, hold, door, v3(0.0, 0.0, 0.0), v3(-1.0, 0.0, 0.0), v3(0.0, 0.0, 1.0));
    run(&mut w, 240);
    let row = door as usize;
    assert!(w.flags(row) & SLEEPING != 0, "the door never rested");
    let at = w.v(POSITION_X, row);
    assert!((at.y - 0.05).abs() < 0.01, "the door lies at {at:?}");
}

fn rotation_motor(w: &mut World, joint: u32, target: Q, stiffness: f32, damping: f32, cap: f32) {
    let row = joint as usize;
    w.set_q(JOINT_FRAME_A_X, row, target);
    for k in 3..6 {
        set_motor(w, joint, k, 0.0, 0.0, stiffness, damping);
        w.set_u(JOINT_FLAGS, row, w.uu(JOINT_FLAGS, row) | JOINT_MOTOR_FORCE << k);
        w.set_s(JOINT_CAP_0 + k, row, cap);
    }
}
fn angle_between(a: Q, b: Q) -> f64 {
    let dot = (a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w).abs() as f64;
    2.0 * dot.min(1.0).acos()
}

#[test]
fn a_rotation_motor_is_critically_damped_at_its_gains() {
    // A rod out along X on a ball joint, turned 1 rad about Z toward its target: one degree of freedom, inertia I + m d^2.
    // Implicit Euler of a critically damped spring scales each root by r = 1 / (1 + w h), so after n substeps
    // x = x0 (1 + n (1 - r)) r^n.
    let mut w = world(4);
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let pivot = anchor(&mut w);
    let (mass, inertia, reach) = (2.0f32, 0.04f32, 0.5f32);
    let rod = point(&mut w, v3(reach, 0.0, 0.0), mass, inertia);
    let joint = spherical(&mut w, pivot, rod, v3(0.0, 0.0, 0.0), v3(-reach, 0.0, 0.0));
    let about_joint = (inertia + mass * reach * reach) as f64;
    let frequency = 2.0 * std::f64::consts::PI * 2.0;
    let target = Q { x: 0.0, y: 0.0, z: 0.5f32.sin(), w: 0.5f32.cos() };
    rotation_motor(&mut w, joint, target, (about_joint * frequency * frequency) as f32, (2.0 * about_joint * frequency) as f32, f32::INFINITY);
    let h = DT as f64 / 8.0;
    let r = 1.0 / (1.0 + frequency * h);
    let mut done = 0;
    for steps in [10u32, 19, 30] {
        run(&mut w, steps - done);
        done = steps;
        let n = steps as f64 * 8.0;
        let want = (1.0 + n * (1.0 - r)) * r.powf(n);
        let got = angle_between(w.q(ROTATION_X, rod as usize), target);
        println!("rotation motor after {steps} steps: {got:.5} of closed form {want:.5}");
        assert!((got - want).abs() < 0.004, "{got} against {want}");
    }
}

#[test]
fn a_rotation_motor_turns_a_rod_about_a_slanted_line_to_its_target() {
    let mut w = world(4);
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let pivot = anchor(&mut w);
    let rod = point(&mut w, v3(0.5, 0.0, 0.0), 2.0, 0.04);
    let joint = spherical(&mut w, pivot, rod, v3(0.0, 0.0, 0.0), v3(-0.5, 0.0, 0.0));
    let target = Q { x: 0.6 * 0.5f32.sin(), y: 0.0, z: 0.8 * 0.5f32.sin(), w: 0.5f32.cos() };
    rotation_motor(&mut w, joint, target, 400.0, 40.0, f32::INFINITY);
    run(&mut w, 60);
    let off = angle_between(w.q(ROTATION_X, rod as usize), target);
    println!("slanted rotation motor after 1 s: {off:.6}");
    assert!(off < 1e-3, "{off}");
}

#[test]
fn a_rotation_motor_cap_is_a_torque_about_the_joint() {
    // A rod of 2 kg straight out: the torque of its weight about the joint is 9.81 N m.
    for (cap, holds) in [(12.0f32, true), (7.0, false)] {
        let mut w = world(4);
        let pivot = anchor(&mut w);
        let rod = point(&mut w, v3(0.5, 0.0, 0.0), 2.0, 0.17);
        let joint = spherical(&mut w, pivot, rod, v3(0.0, 0.0, 0.0), v3(-0.5, 0.0, 0.0));
        rotation_motor(&mut w, joint, Q::IDENTITY, 4000.0, 400.0, cap);
        let mut most: f64 = 0.0;
        for _ in 0..120 {
            w.step(DT);
            most = most.max(angle_between(w.q(ROTATION_X, rod as usize), Q::IDENTITY));
        }
        println!("cap {cap}: turned {most:.4}");
        assert_eq!(most < 0.05, holds, "cap {cap} turned {most}");
        assert_eq!(most > 0.5, !holds, "cap {cap} turned {most}");
    }
}

fn rope(w: &mut World, a: u32, b: u32, on_a: V3, on_b: V3, length: f32) -> u32 {
    let joint = w.add_joint(a, b, JOINT_DISTANCE).unwrap();
    set_anchor(w, joint, on_a, on_b);
    set_limit(w, joint, 0, f32::NEG_INFINITY, length);
    joint
}
fn spring(w: &mut World, a: u32, b: u32, rest: f32, stiffness: f32, damping: f32) -> u32 {
    let joint = w.add_joint(a, b, JOINT_DISTANCE).unwrap();
    set_motor(w, joint, 0, rest, 0.0, stiffness, damping);
    w.set_u(JOINT_FLAGS, joint as usize, w.uu(JOINT_FLAGS, joint as usize) | JOINT_MOTOR_FORCE);
    joint
}

#[test]
fn a_rope_is_slack_inside_its_length_and_holds_at_it() {
    let mut w = world(4);
    let hook = anchor(&mut w);
    place(&mut w, hook, v3(0.0, 10.0, 0.0));
    let weight = point(&mut w, v3(0.5, 10.0, 0.0), 1.0, 0.01);
    rope(&mut w, hook, weight, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), 2.0);
    // Free fall until the rope comes taut: y = 10 - g t^2 / 2 with the bob inside the circle.
    run(&mut w, 15);
    let t = 0.25f64;
    let fell = 10.0 - w.v(POSITION_X, weight as usize).y as f64;
    assert!((fell - G * t * t / 2.0).abs() < 0.01, "slack: {fell}");
    let mut farthest: f32 = 0.0;
    for _ in 0..600 {
        w.step(DT);
        let at = w.v(POSITION_X, weight as usize).sub(v3(0.0, 10.0, 0.0));
        farthest = farthest.max(sqrt(at.dot(at)));
    }
    println!("rope: farthest {farthest:.6}");
    assert!(farthest < 2.002, "{farthest}");
}

#[test]
fn a_taut_rope_swings_with_the_period_of_the_elliptic_closed_form() {
    // A swing under 90 degrees keeps a rope taut, so it is a pendulum of the rope's length.
    let mut w = world(4);
    let hook = anchor(&mut w);
    place(&mut w, hook, v3(0.0, 2.0, 0.0));
    let (length, theta) = (1.5f64, 60f64.to_radians());
    let bob = point(&mut w, v3((length * theta.sin()) as f32, 2.0 - (length * theta.cos()) as f32, 0.0), 2.0, 0.01);
    rope(&mut w, hook, bob, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), length as f32);
    let got = measured_period(&mut w, bob, 900);
    let want = 4.0 * (length / G).sqrt() * elliptic_k((theta / 2.0).sin());
    println!("rope period {got:.5} of {want:.5}");
    assert!((got / want - 1.0).abs() < 1e-3, "{got} against {want}");
}

#[test]
fn a_rope_carries_a_heavy_load_on_a_light_one() {
    let mut w = world(4);
    let hook = anchor(&mut w);
    place(&mut w, hook, v3(0.0, 10.0, 0.0));
    let light = point(&mut w, v3(0.0, 9.0, 0.0), 1.0, 0.01);
    let heavy = point(&mut w, v3(0.0, 8.0, 0.0), 1000.0, 10.0);
    rope(&mut w, hook, light, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), 1.0);
    rope(&mut w, light, heavy, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), 1.0);
    // Limits are one row at a time, so the load rests a little long (docs/limits.md); it has to rest, and stay.
    run(&mut w, 300);
    let drop = 10.0 - w.v(POSITION_X, heavy as usize).y;
    run(&mut w, 600);
    let later = 10.0 - w.v(POSITION_X, heavy as usize).y;
    println!("heavy on rope: {drop:.5}, then {later:.5}");
    assert!((drop - 2.0).abs() < 0.04, "{drop}");
    assert!((later - drop).abs() < 1e-3, "{drop} then {later}");
}

#[test]
fn a_spring_keeps_the_frequency_and_decay_of_implicit_euler() {
    // No load, no damping: x'' = -w^2 x. Implicit Euler keeps the frequency to second order and scales the amplitude by
    // 1 / sqrt(1 + (w h)^2) a substep.
    let mut w = world(4);
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let hook = anchor(&mut w);
    let (mass, stiffness) = (2.0f32, 50.0f32);
    let weight = point(&mut w, v3(1.5, 0.0, 0.0), mass, 0.01);
    spring(&mut w, hook, weight, 1.0, stiffness, 0.0);
    let frequency = (stiffness as f64 / mass as f64).sqrt();
    let (mut crossings, mut last) = (vec![], 0.5f64);
    let mut high = 0.0f64;
    for step in 1..=600 {
        w.step(DT);
        let x = w.v(POSITION_X, weight as usize).x as f64 - 1.0;
        if last < 0.0 && x >= 0.0 {
            crossings.push(DT as f64 * (step as f64 - 1.0 + (-last) / (x - last)));
        }
        if step > 540 {
            high = high.max(x.abs());
        }
        last = x;
    }
    let period = (crossings[crossings.len() - 1] - crossings[0]) / (crossings.len() - 1) as f64;
    let want = 2.0 * std::f64::consts::PI / frequency;
    let wh = frequency * DT as f64 / 8.0;
    let decay = 0.5 * (1.0 + wh * wh).powf(-0.5 * 8.0 * 570.0);
    println!("spring period {period:.5} of {want:.5}, amplitude {high:.5} of {decay:.5}");
    assert!((period / want - 1.0).abs() < 1e-3, "{period}");
    assert!((high / decay - 1.0).abs() < 0.03, "{high} against {decay}");
}

#[test]
fn a_spring_settles_at_its_rest_length_plus_the_static_stretch() {
    let mut w = world(4);
    let hook = anchor(&mut w);
    place(&mut w, hook, v3(0.0, 10.0, 0.0));
    let weight = point(&mut w, v3(0.0, 9.0, 0.0), 2.0, 0.01);
    spring(&mut w, hook, weight, 1.0, 50.0, 5.0);
    run(&mut w, 600);
    let stretch = 10.0 - w.v(POSITION_X, weight as usize).y as f64;
    let want = 1.0 + 2.0 * G / 50.0;
    println!("spring stretch {stretch:.5} of {want:.5}");
    assert!((stretch - want).abs() < 1e-3, "{stretch}");
}
