// Continuous collision: a fast body is stopped by a thin wall it would pass between two steps, a body at rest is not
// pinned by it, and the same scene without the flag shows the tunnelling the flag prevents.
use margoengine_physics2d_kernel::math::{Rot, V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn wall_and_bullet(ccd: bool, speed: f32, shape: Core) -> (World, u32) {
    let mut w = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
    let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(10.0, 0.0), ..Default::default() }).unwrap();
    w.create_shape(wall, Core::rect(0.05, 5.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let b = w.create_body(&BodyDef { position: v2(0.0, 0.0), linear_velocity: v2(speed, 0.0), ccd, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(b, shape, &ShapeDef { restitution: 0.0, friction: 0.0, ..Default::default() }).unwrap();
    (w, b)
}

fn run(w: &mut World, steps: usize) {
    for _ in 0..steps {
        w.step(DT).unwrap();
    }
}

#[test]
fn without_ccd_a_fast_ball_tunnels_and_with_it_the_wall_holds() {
    let ball = Core::circle(V2::ZERO, 0.25).unwrap();
    let (mut free, b) = wall_and_bullet(false, 300.0, ball);
    run(&mut free, 20);
    assert!(free.bodies[b as usize].xf.p.x > 12.0, "control: it tunnels, x {}", free.bodies[b as usize].xf.p.x);
    let (mut held, b) = wall_and_bullet(true, 300.0, ball);
    run(&mut held, 20);
    let x = held.bodies[b as usize].xf.p.x;
    assert!(x < 10.0 - 0.05, "stopped at the wall, x {x}");
    assert!(x > 9.0, "and not pushed back far, x {x}");
}

#[test]
fn a_fast_box_and_a_fast_capsule_are_stopped_too() {
    for core in [Core::rect(0.3, 0.2, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), Core::capsule(v2(0.0, -0.3), v2(0.0, 0.3), 0.15).unwrap()] {
        let (mut w, b) = wall_and_bullet(true, 250.0, core);
        run(&mut w, 20);
        assert!(w.bodies[b as usize].xf.p.x < 10.0, "x {}", w.bodies[b as usize].xf.p.x);
    }
}

#[test]
fn a_turning_box_does_not_pass_through_the_wall_either() {
    let stick = Core::rect(0.4, 0.1, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let (mut w, b) = wall_and_bullet(true, 150.0, stick);
    w.bodies[b as usize].angular_velocity = 3.0;
    run(&mut w, 20);
    assert!(w.bodies[b as usize].xf.p.x < 10.0, "x {}", w.bodies[b as usize].xf.p.x);
}

#[test]
fn a_body_resting_on_the_floor_is_not_pinned_by_ccd() {
    let mut w = World::default();
    let floor = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(floor, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let b = w.create_body(&BodyDef { position: v2(0.0, 3.0), ccd: true, ..Default::default() }).unwrap();
    w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    run(&mut w, 120);
    assert!((w.bodies[b as usize].xf.p.y - 0.5).abs() < 0.02, "rests on the floor: {}", w.bodies[b as usize].xf.p.y);
    // Pushed along the floor, it slides: ccd does not hold it where it touches.
    w.set_velocity(b, v2(5.0, 0.0), 0.0).unwrap();
    run(&mut w, 30);
    assert!(w.bodies[b as usize].xf.p.x > 1.0);
}

#[test]
fn a_sensor_and_a_filtered_wall_do_not_stop_it() {
    let (mut w, b) = wall_and_bullet(true, 300.0, Core::circle(V2::ZERO, 0.25).unwrap());
    w.shapes[0].sensor = true;
    run(&mut w, 20);
    assert!(w.bodies[b as usize].xf.p.x > 12.0);
    let (mut w, b) = wall_and_bullet(true, 300.0, Core::circle(V2::ZERO, 0.25).unwrap());
    w.shapes[0].groups = 0x0001_0001;
    w.shapes[1].groups = 0x0002_0002;
    run(&mut w, 20);
    assert!(w.bodies[b as usize].xf.p.x > 12.0);
    let _ = Rot::IDENTITY;
}

/// A fast ball meets a thin plate that is a dynamic body (not fixed): the ball stops at the plate and the plate is
/// pushed on, where without the flag the ball passes through it between two steps.
#[test]
fn a_fast_ball_stops_at_a_thin_dynamic_plate_and_pushes_it() {
    let run = |ccd: bool| {
        let mut w = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
        let plate = w.create_body(&BodyDef { position: v2(10.0, 0.0), can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(plate, Core::rect(0.05, 3.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 20.0, friction: 0.0, ..Default::default() }).unwrap();
        let ball = w.create_body(&BodyDef { linear_velocity: v2(300.0, 0.0), ccd, can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(ball, Core::circle(V2::ZERO, 0.25).unwrap(), &ShapeDef { restitution: 0.0, friction: 0.0, ..Default::default() }).unwrap();
        let mut stopped_at = f32::MAX;
        for _ in 0..30 {
            w.step(DT).unwrap();
            if w.bodies[ball as usize].xf.p.x > w.bodies[plate as usize].xf.p.x {
                stopped_at = f32::MIN;
            }
        }
        (stopped_at, w.bodies[ball as usize].xf.p.x, w.bodies[plate as usize].xf.p.x)
    };
    let (_, ball_x, plate_x) = run(false);
    assert!(ball_x > plate_x, "control: the ball passes the plate, ball {ball_x}, plate {plate_x}");
    let (passed, ball_x, plate_x) = run(true);
    assert!(passed == f32::MAX, "the ball never gets past the plate: ball {ball_x}, plate {plate_x}");
    assert!(plate_x > 10.5, "and the plate is pushed on by it: {plate_x}");
}

/// A soft CCD distance makes a fast body's contacts reach a step ahead: the solver stops it at a wall it would pass in one
/// step, with no sweep and no time of impact.
#[test]
fn a_soft_ccd_distance_stops_a_fast_ball_at_a_thick_wall() {
    let run = |reach: f32| {
        let mut w = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
        let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(10.0, 0.0), ..Default::default() }).unwrap();
        w.create_shape(wall, Core::rect(0.4, 5.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let ball = w.create_body(&BodyDef { linear_velocity: v2(300.0, 0.0), can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(ball, Core::circle(V2::ZERO, 0.25).unwrap(), &ShapeDef { restitution: 0.0, friction: 0.0, ..Default::default() }).unwrap();
        w.set_soft_ccd(ball, reach).unwrap();
        for _ in 0..20 {
            w.step(DT).unwrap();
        }
        w.bodies[ball as usize].xf.p.x
    };
    assert!(run(0.0) > 11.0, "control: it passes a 0.8 m wall at 5 m a step");
    let x = run(6.0);
    assert!(x < 9.7, "held in front of the wall: {x}");
}

/// A thin bar spinning fast, carried at a thin wall: it turns several times over in one step, so the pose between the steps' ends does
/// not say how far it swept. With CCD it is stopped by the wall, and the wall, which cannot give it energy, leaves it no more than it had.
fn spinning_bar(ccd: bool, spin: f32) -> (World, u32, f32) {
    let mut w = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
    let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(3.0, 0.0), ..Default::default() }).unwrap();
    w.create_shape(wall, Core::rect(0.05, 5.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let b = w
        .create_body(&BodyDef { position: v2(0.0, 0.0), linear_velocity: v2(5.0, 0.0), angular_velocity: spin, ccd, can_sleep: false, ..Default::default() })
        .unwrap();
    w.create_shape(b, Core::rect(1.0, 0.02, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 1.0, restitution: 0.0, friction: 0.0, ..Default::default() }).unwrap();
    let body = &w.bodies[b as usize];
    let energy = 0.5 * body.mass * body.linear_velocity.length_squared() + 0.5 * body.inertia * spin * spin;
    (w, b, energy)
}

#[test]
fn a_bar_spinning_many_turns_a_step_is_stopped_by_a_thin_wall_and_gains_no_energy() {
    for spin in [100.0, 400.0, 2000.0] {
        let (mut w, b, start) = spinning_bar(true, spin);
        for step in 0..90 {
            w.step(DT).unwrap();
            let body = &w.bodies[b as usize];
            assert!(body.xf.p.x < 3.0 - 0.05, "spin {spin} step {step}: the bar's centre went through the wall, x {}", body.xf.p.x);
            let energy = 0.5 * body.mass * body.linear_velocity.length_squared() + 0.5 * body.inertia * body.angular_velocity * body.angular_velocity;
            assert!(energy <= start * 1.001, "spin {spin} step {step}: energy {energy} grew past {start}");
        }
    }
}

/// The same bar turning in place with its tips through a thin wall from the first step: a wall that cannot move gives it nothing, so
/// what it holds, in turning and in moving, never grows past what it began with (Rapier 2D loses most of it to its spin cap; here none is
/// thrown away but the impacts' own loss).
#[test]
fn a_bar_spinning_through_a_wall_never_holds_more_energy_than_it_began_with() {
    for (spin, ccd) in [(100.0, true), (100.0, false), (400.0, true), (400.0, false), (2000.0, true)] {
        let mut w = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
        let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.9, 0.0), ..Default::default() }).unwrap();
        w.create_shape(wall, Core::rect(0.01, 3.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let b = w.create_body(&BodyDef { angular_velocity: spin, ccd, can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(b, Core::rect(1.0, 0.02, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 1.0, ..Default::default() }).unwrap();
        let start = {
            let body = &w.bodies[b as usize];
            0.5 * body.inertia * spin * spin
        };
        for step in 0..120 {
            w.step(DT).unwrap();
            let body = &w.bodies[b as usize];
            let energy = 0.5 * body.mass * body.linear_velocity.length_squared() + 0.5 * body.inertia * body.angular_velocity * body.angular_velocity;
            assert!(energy <= start * 1.001, "spin {spin} ccd {ccd} step {step}: energy {energy} against {start}");
        }
    }
}
