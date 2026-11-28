// Couplings held to their closed forms over long runs: a rack and a gear against the exact ratio wherever they stand
// (KB-PHYS-COUPLINGDRIFT1), and a follower held by a point off its centre to a path on a turning body, a cam and a screw,
// against the exact cam-follower kinematics (KB-PHYS-PATHMOVINGBASE1). The driver is a position-driven body turned 2 degrees
// a 60 Hz step, whose angle is known exactly; nothing has gravity, friction or load.
use margoengine_physics_kernel::couplings::*;
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const DT: f32 = 1.0 / 60.0;
const TAU: f64 = core::f64::consts::TAU;
const STEP: f64 = 2.0 * core::f64::consts::PI / 180.0;
const LOCK_LINEAR_ROWS: u32 = JOINT_LOCK * 7;
const LOCK_TURNS: u32 = JOINT_LOCK * (7 << 3);

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

fn fixed(w: &mut World, at: V3) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    body
}

/// A slide along `axis` from a fixed body to `body`: two sliding locks across it and all three turning ones.
fn slide(w: &mut World, ground: u32, body: u32, axis: V3) {
    let joint = w.add_joint(ground, body, JOINT_LOCK * 6 | LOCK_TURNS).unwrap();
    w.set_joint_axis(joint, axis);
}

/// A position-driven body about z at `at`, and a function that turns it to an angle for the next step.
fn driver(w: &mut World, at: V3) -> u32 {
    let body = w.add_body(KINEMATIC_POSITION).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    body
}

fn turn_to(w: &mut World, body: u32, at: V3, angle: f64) {
    // The angle is reduced in doubles: as an f32 a hundred turns is 6e-5 rad coarse.
    let reduced = angle.rem_euclid(TAU);
    w.set_target(body, at, Q::from_rotation_vector(v3(0.0, 0.0, reduced as f32)));
}

/// A body's turn about z from its start, counted past one turn by the last reading.
fn angle_z(w: &World, body: u32, last: f64) -> f64 {
    let q = w.q(ROTATION_X, body as usize);
    let raw = 2.0 * (q.z as f64).atan2(q.w as f64);
    raw + ((last - raw) / TAU).round() * TAU
}

#[test]
fn a_rack_keeps_the_exact_ratio_for_a_hundred_turns_wherever_it_stands() {
    let radius = 0.348 / TAU;
    for z0 in [0.0f32, 0.5, 5.0, 50.0] {
        let mut w = World::new(8, 8).unwrap();
        w.header_mut().gravity = [0.0; 3];
        let centre = v3(0.0, 0.0, 0.0);
        let pinion = driver(&mut w, centre);
        let ground = fixed(&mut w, v3(0.0, 0.0, z0));
        let rack = point(&mut w, v3(0.0, 0.0, z0), 1.0, 1e-3);
        slide(&mut w, ground, rack, v3(0.0, 0.0, 1.0));
        let thread = w.add_coupling(RACK_AND_PINION, pinion, rack).unwrap();
        w.set_coupling(thread, 0, [0.0, 0.0, 1.0]);
        w.set_coupling(thread, 1, [0.0, 0.0, -1.0]);
        w.set_coupling(thread, 6, [radius as f32, 0.0, 0.0]);
        let mut worst = 0.0f64;
        for k in 1..=18_000u32 {
            let angle = STEP * k as f64;
            turn_to(&mut w, pinion, centre, angle);
            w.step(DT);
            // The rack climbs a radius a radian: z - z0 = r angle, read in doubles from the f32 pose.
            let gap = (w.v(POSITION_X, rack as usize).z as f64 - z0 as f64 - radius * angle).abs();
            worst = worst.max(gap);
        }
        // The rack travels 34.8 m, and its f32 position reads no finer than the float spacing where it ends (3.8 um at 35 m,
        // 7.6 um at 85 m): the bar is two of those, plus 1 um. Summing the row's speed missed it by 2.7 cm from the origin.
        let far = z0 + (radius * STEP * 18_000.0) as f32;
        let spacing = (f32::from_bits(far.to_bits() + 1) - far) as f64;
        assert!(worst < 2.0 * spacing + 1e-6, "rack from z {z0}: {worst:e} m from the exact travel over 100 turns");
        println!("rack from z {z0}: worst {worst:.3e} m over 100 turns");
    }
}

#[test]
fn a_gear_keeps_the_exact_ratio_for_a_hundred_turns_wherever_it_stands() {
    for x0 in [1.0f32, 50.0, 500.0] {
        let mut w = World::new(8, 8).unwrap();
        w.header_mut().gravity = [0.0; 3];
        let centre = v3(x0 - 1.0, 0.0, 0.0);
        let input = driver(&mut w, centre);
        let at = v3(x0, 0.0, 0.0);
        let post = fixed(&mut w, at);
        let wheel = point(&mut w, at, 3.0, 0.02);
        let hinge = w.add_joint(post, wheel, LOCK_LINEAR_ROWS | JOINT_LOCK * (6 << 3)).unwrap();
        w.set_joint_axis(hinge, v3(0.0, 0.0, 1.0));
        let gear = w.add_coupling(GEAR, input, wheel).unwrap();
        w.set_coupling(gear, 0, [0.0, 0.0, 1.0]);
        w.set_coupling(gear, 1, [0.0, 0.0, 1.0]);
        // The wheel turns the other way at a third of the speed: angle_a + 3 angle_b = 0.
        w.set_coupling(gear, 6, [3.0, 0.0, 0.0]);
        let (mut worst, mut last) = (0.0f64, 0.0f64);
        for k in 1..=18_000u32 {
            let angle = STEP * k as f64;
            turn_to(&mut w, input, centre, angle);
            w.step(DT);
            last = angle_z(&w, wheel, last);
            worst = worst.max((last + angle / 3.0).abs());
        }
        assert!(worst < 1e-6, "gear at x {x0}: {worst:e} rad from the exact ratio over 100 turns");
        println!("gear at x {x0}: worst {worst:.3e} rad over 100 turns");
    }
}

/// A follower on a slide along `axis` from a fixed body, held by the point `anchor` (off its centre) to a closed path of
/// `points` in a turning body's frame, run `turns` turns; returns the worst gap from `exact(angle)` along the slide.
#[allow(clippy::too_many_arguments)]
fn follow(points: &[[f32; 3]], closed: bool, start: V3, anchor: V3, axis: V3, inertia: f32, correction: f32, turns: u32, exact: &dyn Fn(f64) -> f64) -> f64 {
    let mut w = World::new(8, 8).unwrap();
    w.header_mut().gravity = [0.0; 3];
    let centre = v3(0.0, 0.0, 0.0);
    let cam = driver(&mut w, centre);
    let ground = fixed(&mut w, start);
    let follower = point(&mut w, start, 1.0, inertia);
    slide(&mut w, ground, follower, axis);
    let path = w.add_coupling(PATH, cam, follower).unwrap();
    if closed {
        w.set_coupling(path, 11, [1.0, 0.0, 0.0]);
    }
    for p in points {
        w.set_coupling(path, 9, *p);
    }
    w.set_coupling(path, 3, [anchor.x, anchor.y, anchor.z]);
    w.set_coupling(path, 8, [0.0, 1.0, correction]);
    let mut worst = 0.0f64;
    for k in 1..=(180 * turns) {
        let angle = STEP * k as f64;
        turn_to(&mut w, cam, centre, angle);
        w.step(DT);
        let p = w.v(POSITION_X, follower as usize);
        let along = p.x as f64 * axis.x as f64 + p.y as f64 * axis.y as f64 + p.z as f64 * axis.z as f64;
        let gap = (along - exact(angle)).abs();
        assert!(gap < 0.01, "the follower left the path at step {k}: {gap} m");
        worst = worst.max(gap);
    }
    worst
}

#[test]
fn a_follower_on_a_turning_cam_tracks_the_exact_cam_follower_kinematics_for_fifty_turns() {
    // A groove of radius 0.3 + 0.04 cos(3 phi) in the cam's frame, 720 points round; the follower slides along x, held by a
    // point 0.2 m off its centre, and its inertia is small, so each push on the point mostly turns it about its slide.
    let (base, lift, lobes) = (0.3f64, 0.04f64, 3.0f64);
    let groove = |phi: f64| base + lift * (lobes * phi).cos();
    let points: Vec<[f32; 3]> = (0..720)
        .map(|i| {
            let phi = i as f64 * TAU / 720.0;
            [(groove(phi) * phi.cos()) as f32, (groove(phi) * phi.sin()) as f32, 0.0]
        })
        .collect();
    let start = v3(groove(0.0) as f32, 0.0, 0.2);
    // The rows are speeds read at a substep's start, so the follower's own acceleration a leaves a h^2 / 2 a substep across
    // the groove, which the row closes a share c of: a steady lag of a h^2 / (2 c), the same at the fiftieth turn as the first.
    let omega = STEP / DT as f64;
    let accel = lift * lobes * lobes * omega * omega;
    let h = DT as f64 / 8.0;
    for correction in [0.2f32, 1.0] {
        let worst = follow(&points, true, start, v3(0.0, 0.0, -0.2), v3(1.0, 0.0, 0.0), 1e-3, correction, 50, &|angle| groove(-angle));
        let lag = accel * h * h / (2.0 * correction as f64);
        println!("cam follower at a share of {correction}: worst {worst:.3e} m over 50 turns, a h^2 / 2c = {lag:.3e}");
        assert!(worst < 1.1 * lag + 1e-6, "cam follower at {correction}: {worst:e} m from rho(-alpha), past a h^2 / 2c = {lag:e}");
    }
}

#[test]
fn a_screw_on_a_turning_shaft_carries_its_follower_a_pitch_a_turn_with_the_point_a_metre_out() {
    let (pitch, radius) = (0.348f64, 1.0f64);
    // A helix in the shaft's frame, 128 points a turn over 24 turns, centred on the follower's start.
    let points: Vec<[f32; 3]> = (0..=128 * 24)
        .map(|i| {
            let phi = (i as f64 / 128.0 - 12.0) * TAU;
            [(radius * phi.cos()) as f32, (radius * phi.sin()) as f32, (pitch * phi / TAU) as f32]
        })
        .collect();
    // The follower's centre is on the axis and its point is 1 m out: before the fix the path ran away within a quarter turn.
    let worst = follow(&points, false, v3(0.0, 0.0, 0.0), v3(radius as f32, 0.0, 0.0), v3(0.0, 0.0, 1.0), 0.01, 0.2, 10, &|angle| -pitch * angle / TAU);
    println!("screw follower: worst {worst:.3e} m over 10 turns");
    assert!(worst < 2e-6, "screw follower {worst:e} m from - pitch alpha / 2 pi");
}
