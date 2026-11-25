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

/// A bar turning just under a whole turn a step, whose tip crosses a small block between the pose the step begins at and the one it ends at.
/// The end rotation reads as a small turn the other way, so a bound taken from it, and a sweep along the short arc to it, miss the block
/// altogether; the unwrapped turn of the step, which is what the bar swept, does not. The block sits half way between the poses the
/// substeps pass through, so no contact of theirs holds the bar either.
fn bar_and_block(ccd: bool) -> (World, u32) {
    let mut w = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
    let (c, s) = (0.76f32.cos(), 0.76f32.sin());
    let block = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.9 * c, 0.9 * s), ..Default::default() }).unwrap();
    w.create_shape(block, Core::rect(0.05, 0.05, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    // Four substeps turn it through 4 atan(spin dt / 4) = 6.07 rad, 2 pi less 0.21.
    let b = w.create_body(&BodyDef { angular_velocity: 4560.0, ccd, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(b, Core::rect(1.0, 0.02, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 1.0, ..Default::default() }).unwrap();
    (w, b)
}

fn angle_of(w: &World, b: u32) -> f32 {
    let q = w.bodies[b as usize].xf.q;
    margoengine_physics2d_kernel::math::atan2(q.s, q.c)
}

#[test]
fn a_bar_turning_just_under_a_whole_turn_a_step_is_caught_by_a_block_its_tip_crosses() {
    // Without CCD nothing holds it: it ends the step 0.21 rad the other way, a tip having passed through the block.
    let (mut w, b) = bar_and_block(false);
    w.step(DT).unwrap();
    assert!((angle_of(&w, b) + 0.21).abs() < 0.01, "the bar ends its step at {}", angle_of(&w, b));
    // With it the bar is set back to where its tip first touches the block: the block spans angles 0.76 +- 0.1 or so at the radii the tip
    // and the bar's length reach, so the touch comes between 0.55 and 0.8 rad, long before the end rotation (-0.21) the short arc ends at.
    let (mut w, b) = bar_and_block(true);
    w.step(DT).unwrap();
    let angle = angle_of(&w, b);
    assert!(angle > 0.55 && angle < 0.8, "the bar was held at the block, not carried on to {angle}");
}

#[test]
fn a_rotation_by_any_angle_matches_sine_and_cosine() {
    use margoengine_physics2d_kernel::math::Rot;
    for angle in [0.0f32, 1.0e-4, 0.1, 0.7, 1.5, 3.0, -2.2, 6.0, 6.28, 12.5, -40.0, 75.1, 300.0] {
        let q = Rot::from_angle(angle);
        let (c, s) = ((angle as f64).cos(), (angle as f64).sin());
        // Each squaring back up carries the float32 rounding of the one before it along, so the error grows with the angle (measured: 1.7e-5 at
        // 300 rad, 3e-6 at 75, 8e-7 at 6): the bound is 2e-7 per radian, the rounding of one rotation taken once for each radian.
        let bound = 2.0e-7 * (1.0 + angle.abs() as f64);
        assert!((q.c as f64 - c).abs() < bound && (q.s as f64 - s).abs() < bound, "angle {angle}: ({}, {}) against ({c}, {s})", q.c, q.s);
    }
    let q = Rot::from_angle(f32::NAN);
    assert_eq!((q.c, q.s), (1.0, 0.0));
}

/// A ball fired along a corridor between two thin walls, 5.9 m apart inside, at 1000 m/s: a step takes it 16.67 m, three times along the
/// corridor and back, with `substeps` impacts handled.
fn corridor(substeps: u32, restitution: f32) -> (World, u32) {
    let mut w = World::new(Settings { gravity: V2::ZERO, max_ccd_substeps: substeps, ..Default::default() });
    for x in [-3.0f32, 3.0] {
        let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(x, 0.0), ..Default::default() }).unwrap();
        w.create_shape(wall, Core::rect(0.05, 5.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution, friction: 0.0, ..Default::default() }).unwrap();
    }
    let ball = w.create_body(&BodyDef { linear_velocity: v2(1000.0, 0.0), ccd: true, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef { restitution, friction: 0.0, ..Default::default() }).unwrap();
    (w, ball)
}

#[test]
fn more_ccd_substeps_carry_a_ball_on_after_each_impact_between_two_walls() {
    // The ball's centre travels between -2.85 and 2.85 (the walls' faces at +-2.95 less its radius), 5.7 m a leg, from 0 going right, 16.667
    // m in the step: 2.85 to the first wall, 5.7 to the second, 5.7 back to the first, then 2.417 of the way left again from it, at 0.433.
    // Each impact turns the ball round up to the time-of-impact target (5 mm) before the wall, so it loses up to twice that a leg.
    let target = 0.005f32;
    for (substeps, x, vx) in [
        (0u32, 16.667f32, 1000.0f32), // CCD off: it goes through both walls
        (1, 2.85, 1000.0),            // the first stops it where it touches, with its velocity: the next step's contact answers it
        (2, -2.85, -1000.0),          // one impact answered, the second stops it at the far wall
        (3, 2.85, 1000.0),
        (4, 0.433, -1000.0),          // three answered, and the fourth sweep meets nothing
        (9, 0.433, -1000.0),          // more than it needs changes nothing
    ] {
        let (mut w, b) = corridor(substeps, 1.0);
        w.step(DT).unwrap();
        let body = &w.bodies[b as usize];
        let legs = substeps.min(4).saturating_sub(1) as f32;
        let bound = if substeps == 0 { 0.02 } else { 2.0 * target * (1.0 + legs) };
        assert!((body.xf.p.x - x).abs() <= bound, "{substeps} substeps: the ball is at {} not {x} (bound {bound})", body.xf.p.x);
        assert!((body.linear_velocity.x - vx).abs() < 1.0, "{substeps} substeps: its velocity is {} not {vx}", body.linear_velocity.x);
        assert!(body.linear_velocity.y.abs() < 1.0e-3, "{substeps} substeps: it picked up a sideways speed {}", body.linear_velocity.y);
    }
}

#[test]
fn each_ccd_impact_leaves_the_speed_the_restitution_says() {
    // Half restitution: a ball at 1000 m/s leaves the first wall at 500 and, after a 5.7 m leg, hits the second at 500 and leaves at 250.
    let (mut w, b) = corridor(3, 0.5);
    w.step(DT).unwrap();
    let v = w.bodies[b as usize].linear_velocity.x;
    assert!((v - 250.0).abs() < 0.5, "two impacts at restitution 0.5 leave 250 m/s: {v}");
}

#[test]
fn a_ccd_impact_gives_the_wall_friction_and_the_ball_its_coulomb_tangential_speed() {
    // A ball at (1000, 300) m/s into a wall: normal speed 1000 reverses at half restitution to -500, and friction of 0.05 takes
    // mu vn = 0.05 * 1000 = 50 m/s off the 300 sliding along it, as the contact solver's friction does (it is held to the impulse that
    // stops the approach; the bounce that follows has none): the pair slides, sticking would take 100.
    let mut w = World::new(Settings { gravity: V2::ZERO, max_ccd_substeps: 2, ..Default::default() });
    let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(3.0, 0.0), ..Default::default() }).unwrap();
    w.create_shape(wall, Core::rect(0.05, 50.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution: 0.5, friction: 0.05, ..Default::default() }).unwrap();
    let ball = w.create_body(&BodyDef { linear_velocity: v2(1000.0, 300.0), ccd: true, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef { restitution: 0.5, friction: 0.05, ..Default::default() }).unwrap();
    w.step(DT).unwrap();
    let v = w.bodies[ball as usize].linear_velocity;
    assert!((v.x + 500.0).abs() < 0.5, "normal speed {}", v.x);
    assert!((v.y - 250.0).abs() < 0.5, "tangential speed {}", v.y);
}

#[test]
fn a_ccd_impact_with_a_dynamic_body_conserves_momentum_and_gives_it_the_elastic_speeds() {
    // A 1 kg ball at 300 m/s (5 m a step, so it reaches the plate 3 m ahead) meets a plate of 3 kg standing still: elastic, the ball leaves at (1 - 3) / 4 * 300 = -150 and the plate at 2 / 4 * 300 = 150.
    let mut w = World::new(Settings { gravity: V2::ZERO, max_ccd_substeps: 2, ..Default::default() });
    let plate = w.create_body(&BodyDef { position: v2(3.0, 0.0), can_sleep: false, ..Default::default() }).unwrap();
    // The plate's area is 0.1 x 6 = 0.6 m2: a density of 5 is 3 kg.
    w.create_shape(plate, Core::rect(0.05, 3.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 5.0, restitution: 1.0, friction: 0.0, ..Default::default() }).unwrap();
    let ball = w.create_body(&BodyDef { linear_velocity: v2(300.0, 0.0), ccd: true, can_sleep: false, ..Default::default() }).unwrap();
    // A disc of radius r has area pi r^2: radius 0.5642 m is 1 m2 and so 1 kg at density 1.
    w.create_shape(ball, Core::circle(V2::ZERO, 0.564_189_6).unwrap(), &ShapeDef { restitution: 1.0, friction: 0.0, ..Default::default() }).unwrap();
    let (m_ball, m_plate) = (w.bodies[ball as usize].mass, w.bodies[plate as usize].mass);
    assert!((m_ball - 1.0).abs() < 1e-3 && (m_plate - 3.0).abs() < 1e-3, "masses {m_ball} and {m_plate}");
    w.step(DT).unwrap();
    let (vb, vp) = (w.bodies[ball as usize].linear_velocity.x, w.bodies[plate as usize].linear_velocity.x);
    assert!((vb + 150.0).abs() < 0.5 && (vp - 150.0).abs() < 0.5, "ball {vb}, plate {vp}");
    assert!((m_ball * vb + m_plate * vp - 300.0).abs() < 0.5, "momentum {}", m_ball * vb + m_plate * vp);
}


/// A ball at `(20, 6)` m/s into a wall, with friction 0.3 and restitution 0.5: where its velocity and spin are after the step. With
/// `ccd` it starts 0.15 m from the wall and the sweep answers the impact; without, 0.01 m from it, so the contact solver has it from the start.
fn impact(ccd: bool) -> (V2, f32) {
    let mut w = World::new(Settings { gravity: V2::ZERO, max_ccd_substeps: 2, ..Default::default() });
    let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(3.0, 0.0), ..Default::default() }).unwrap();
    w.create_shape(wall, Core::rect(0.05, 50.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution: 0.5, friction: 0.3, ..Default::default() }).unwrap();
    let x = if ccd { 2.70 } else { 2.84 };
    let ball = w.create_body(&BodyDef { position: v2(x, 0.0), linear_velocity: v2(20.0, 6.0), ccd, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef { restitution: 0.5, friction: 0.3, ..Default::default() }).unwrap();
    w.step(DT).unwrap();
    let b = &w.bodies[ball as usize];
    (b.linear_velocity, b.angular_velocity)
}

#[test]
fn a_ccd_impact_leaves_the_velocity_and_spin_the_contact_solver_gives_the_same_pair() {
    let (swept, swept_spin) = impact(true);
    let (solved, solved_spin) = impact(false);
    // The normal speed is the restitution times the approach for both: -0.5 * 20.
    assert!((swept.x + 10.0).abs() < 1.0e-3 && (solved.x + 10.0).abs() < 1.0e-3, "normal speeds {} and {}", swept.x, solved.x);
    // The tangential speed and the spin come from the friction at the contact point, which both put midway between the two surfaces, so
    // a distance rho r from the ball's centre with rho = 1 + (half the gap) / r, the gap at most 0.01 for the solver (the ball starts that
    // near) and at most the time-of-impact target, 0.005, for the sweep. The 6 m/s that slide is gripped completely (mu * 20 = 6 is more than
    // the 6 / (1 + 2 rho^2) the grip needs), so by the impulse that takes the slide out of a disc (inertia m r^2 / 2): the speed falls by
    // 6 / (1 + 2 rho^2) and the spin is -2 rho 6 / (r (1 + 2 rho^2)).
    let (slow_speed, slow_spin) = speed_and_spin(1.0);
    let (fast_speed, fast_spin) = speed_and_spin(1.05);
    for (name, v, w) in [("swept", swept.y, swept_spin), ("solved", solved.y, solved_spin)] {
        assert!(v >= slow_speed - 1.0e-3 && v <= fast_speed + 1.0e-3, "{name} tangential speed {v} outside {slow_speed} to {fast_speed}");
        assert!(w >= slow_spin - 1.0e-2 && w <= fast_spin + 1.0e-2, "{name} spin {w} outside {slow_spin} to {fast_spin}");
    }
}

/// The tangential speed and the spin a ball of radius 0.1 has after gripping a 6 m/s slide at a contact point rho radii from its centre.
fn speed_and_spin(rho: f32) -> (f32, f32) {
    (6.0 - 6.0 / (1.0 + 2.0 * rho * rho), -2.0 * rho * 6.0 / (0.1 * (1.0 + 2.0 * rho * rho)))
}

/// A ball dropped at 300 m/s onto a floor 1.9 m below it with `substeps` impacts allowed, in gravity of 10 m/s^2 and with a restitution of `e`.
fn dropped_ball(e: f32, gravity_scale: f32) -> (World, u32) {
    let mut w = World::new(Settings { gravity: v2(0.0, -10.0), max_ccd_substeps: 2, ..Default::default() });
    let floor = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, -0.5), ..Default::default() }).unwrap();
    w.create_shape(floor, Core::rect(10.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution: e, friction: 0.0, ..Default::default() }).unwrap();
    let ball = w.create_body(&BodyDef { position: v2(0.0, 2.0), linear_velocity: v2(0.0, -300.0), gravity_scale, ccd: true, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef { restitution: e, friction: 0.0, ..Default::default() }).unwrap();
    (w, ball)
}

#[test]
fn after_an_impact_the_ball_goes_on_under_gravity_along_the_closed_form_arc() {
    for scale in [1.0f32, 0.5] {
        let g = 10.0 * scale as f64;
        let (mut w, b) = dropped_ball(0.5, scale);
        w.step(DT).unwrap();
        // The ball's underside meets the floor's top when its centre is 0.1 up: 1.9 m down at 300 m/s under g, after t; it leaves at half its
        // speed and flies the rest of the step.
        let dt = DT as f64;
        let t = (-300.0 + (300.0f64 * 300.0 + 2.0 * g * 1.9).sqrt()) / g;
        let up = 0.5 * (300.0 + g * t);
        let rest = dt - t;
        let (y, vy) = (0.1 + up * rest - 0.5 * g * rest * rest, up - g * rest);
        let body = &w.bodies[b as usize];
        // The step's own integration is semi-implicit over its 4 substeps, which puts the ball g dt^2 / 8 (0.35 mm at g = 10) ahead of the exact
        // arc the closed form follows; the sweep's gap is spent before the collision, so nothing else is left.
        let bound = 0.125 * g * dt * dt + 1.0e-5;
        assert!((body.xf.p.y as f64 - y).abs() < bound, "gravity scale {scale}: the ball is at {} not {y}", body.xf.p.y);
        assert!((body.linear_velocity.y as f64 - vy).abs() < 1.0e-3, "gravity scale {scale}: its velocity is {} not {vy}", body.linear_velocity.y);
    }
}

#[test]
fn each_answered_ccd_impact_is_a_touch_and_a_contact_force_like_any_contact() {
    use margoengine_physics2d_kernel::world::EventKind;
    let mut w = World::new(Settings { gravity: V2::ZERO, max_ccd_substeps: 3, ..Default::default() });
    let mut walls = Vec::new();
    for x in [-3.0f32, 3.0] {
        let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(x, 0.0), ..Default::default() }).unwrap();
        walls.push(w.create_shape(wall, Core::rect(0.05, 5.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution: 0.5, friction: 0.0, events: 3, ..Default::default() }).unwrap());
    }
    let ball = w.create_body(&BodyDef { linear_velocity: v2(1000.0, 0.0), ccd: true, can_sleep: false, ..Default::default() }).unwrap();
    let shape = w.create_shape(ball, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef { restitution: 0.5, friction: 0.0, events: 3, ..Default::default() }).unwrap();
    let mass = w.bodies[ball as usize].mass;
    w.step(DT).unwrap();
    // Three impacts allowed: the first at the right wall, the second at the left one (both answered), the third sweep is the last and meets nothing.
    let pairs = [(walls[1].min(shape), walls[1].max(shape)), (walls[0].min(shape), walls[0].max(shape))];
    let seen: Vec<_> = w.events.iter().map(|e| (e.kind, e.a, e.b)).collect();
    let expected: Vec<_> = pairs.iter().flat_map(|&(a, b)| [(EventKind::Started, a, b), (EventKind::Stopped, a, b)]).collect();
    assert_eq!(seen, expected, "each answered impact is a touch that began and ended");
    // The impulse of the first is the mass times (1 + e) times the approach, 1000 m/s; of the second, the speed that is left, 500.
    assert_eq!(w.force_events.len(), 2);
    for (event, approach) in w.force_events.iter().zip([1000.0f32, 500.0]) {
        let expected = mass * 1.5 * approach / DT;
        assert!((event.force - expected).abs() < 0.01 * expected, "force {} against {expected}", event.force);
    }
}

#[test]
fn the_kinetic_energy_never_rises_across_the_impacts_of_a_step_and_each_answered_impact_keeps_the_restitution_squared() {
    for e in [1.0f32, 0.5, 0.0] {
        let mut last = f32::INFINITY;
        for substeps in 1..=6u32 {
            let (mut w, b) = corridor(substeps, e);
            let m = w.bodies[b as usize].mass;
            let energy = |w: &World| 0.5 * m * w.bodies[b as usize].linear_velocity.length_squared();
            let before = energy(&w);
            w.step(DT).unwrap();
            let after = energy(&w);
            assert!(after <= before * (1.0 + 1.0e-5), "restitution {e}, {substeps} impacts: the energy rose from {before} to {after}");
            assert!(after <= last * (1.0 + 1.0e-5), "restitution {e}: more impacts allowed left more energy ({after} over {last})");
            last = after;
            // Each impact answered leaves e^2 of the energy: after k of them, e^(2k) of it, a whole k, and none answered at one impact (it stops the ball where it touches).
            if substeps == 1 {
                assert!((after / before - 1.0).abs() < 1.0e-5, "the first impact stops the ball with its velocity: {after} of {before}");
            } else if e == 1.0 {
                assert!((after / before - 1.0).abs() < 1.0e-4, "elastic impacts keep the energy: {after} of {before}");
            } else if e == 0.5 {
                let k = (after / before).ln() / (e * e).ln();
                assert!((k - k.round()).abs() < 1.0e-3 && k.round() >= 1.0, "{substeps} impacts at restitution {e} leave e^(2k) of the energy for a whole k: k = {k}");
            } else {
                assert!(after < 1.0e-6 * before, "restitution 0 leaves nothing: {after}");
            }
        }
    }
}

/// A one-way platform: solid for a body above it, open to one below. The hook gives the direction the platform's contacts must have a
/// positive part along, which depends on which of the pair is first (the normal runs from the first to the second).
struct Platform {
    shape: u32,
}

impl margoengine_physics2d_kernel::world::Hook for Platform {
    fn filter(&mut self, _: u32, _: u32) -> bool {
        true
    }
    fn contact(&mut self, change: &mut margoengine_physics2d_kernel::world::ContactMod) {
        change.one_way = Some(if change.a == self.shape { v2(0.0, 1.0) } else { v2(0.0, -1.0) });
    }
}

/// A fast ball at a one-way platform at y = 0, from `y` going at `vy`, with `substeps` impacts allowed and restitution 1 on both.
fn one_way(y: f32, vy: f32, substeps: u32) -> (World, u32) {
    use margoengine_physics2d_kernel::world::HOOK_CONTACT;
    let mut w = World::new(Settings { gravity: V2::ZERO, max_ccd_substeps: substeps, ..Default::default() });
    let platform = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let shape = w.create_shape(platform, Core::rect(3.0, 0.05, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution: 1.0, friction: 0.0, hooks: HOOK_CONTACT, ..Default::default() }).unwrap();
    w.hook = Some(Box::new(Platform { shape }));
    let ball = w.create_body(&BodyDef { position: v2(0.0, y), linear_velocity: v2(0.0, vy), ccd: true, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef { restitution: 1.0, friction: 0.0, hooks: HOOK_CONTACT, ..Default::default() }).unwrap();
    (w, ball)
}

#[test]
fn a_fast_ball_goes_through_a_one_way_platform_from_below_and_bounces_off_it_from_above() {
    for substeps in [1u32, 2] {
        // From below, 300 m/s up: through, whatever the number of impacts, with nothing taken from its speed.
        let (mut w, b) = one_way(-2.0, 300.0, substeps);
        w.step(DT).unwrap();
        let body = &w.bodies[b as usize];
        assert!((body.xf.p.y - 3.0).abs() < 1.0e-3 && (body.linear_velocity.y - 300.0).abs() < 1.0e-3, "{substeps} impacts, from below: y {} vy {}", body.xf.p.y, body.linear_velocity.y);
        assert!(w.events.is_empty() && w.force_events.is_empty());
    }
    // From above, 300 m/s down with two impacts: down to the platform's top (0.05) plus the ball's radius, 1.85 m of the 5, then back up for the other 3.15.
    let (mut w, b) = one_way(2.0, -300.0, 2);
    w.step(DT).unwrap();
    let body = &w.bodies[b as usize];
    assert!((body.xf.p.y - 3.3).abs() < 1.0e-3 && (body.linear_velocity.y - 300.0).abs() < 1.0e-3, "from above: y {} vy {}", body.xf.p.y, body.linear_velocity.y);
    // With one impact allowed it is stopped on the platform's top, as it always was.
    let (mut w, b) = one_way(2.0, -300.0, 1);
    w.step(DT).unwrap();
    assert!((w.bodies[b as usize].xf.p.y - 0.15).abs() < 0.01, "stopped on top: {}", w.bodies[b as usize].xf.p.y);
}

/// A ball at 300 m/s, 5 m a step, 2.4 m from a thin wall at x = 3 (its face at 2.95, the ball's radius 0.1): where the step leaves it.
fn stopped_ball(settings: Settings) -> f32 {
    let mut w = World::new(Settings { gravity: V2::ZERO, ..settings });
    let wall = w.create_body(&BodyDef { kind: Kind::Static, position: v2(3.0, 0.0), ..Default::default() }).unwrap();
    w.create_shape(wall, Core::rect(0.05, 5.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let ball = w.create_body(&BodyDef { position: v2(0.6, 0.0), linear_velocity: v2(300.0, 0.0), ccd: true, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef { restitution: 0.0, friction: 0.0, ..Default::default() }).unwrap();
    w.step(DT).unwrap();
    w.bodies[ball as usize].xf.p.x
}

#[test]
fn the_tolerance_sets_how_close_the_sweep_stops_to_the_wall() {
    // The wall's face is at 2.95: the ball's centre is 0.1 short of it when they touch. The sweep stops within the tolerance of that.
    let touch = 2.85f32;
    for tolerance in [0.002f32, 0.005, 0.02, 0.05] {
        let x = stopped_ball(Settings { ccd_tolerance: tolerance, ..Default::default() });
        let gap = touch - x;
        assert!(gap >= -1.0e-4 && gap <= tolerance + 1.0e-4, "tolerance {tolerance}: stopped {gap} from touching");
        // It aims half the tolerance short and stops at the first advance within the tolerance of it: not further than the tolerance.
        assert!(gap >= 0.0 || tolerance < 0.003, "tolerance {tolerance}: stopped past the touch ({gap})");
    }
    let (fine, coarse) = (stopped_ball(Settings { ccd_tolerance: 0.002, ..Default::default() }), stopped_ball(Settings { ccd_tolerance: 0.05, ..Default::default() }));
    assert!(fine > coarse + 0.01, "a coarser tolerance stops farther from the wall: {fine} against {coarse}");
}

#[test]
fn few_advances_and_a_long_least_advance_stop_the_ball_short_of_the_wall_and_never_through_it() {
    // With the defaults it reaches the wall (the ball's centre 2.85).
    assert!((stopped_ball(Settings::default()) - 2.85).abs() < 0.01);
    // No advances: the time reached is the start, before any touch: the ball is held where it began.
    assert!((stopped_ball(Settings { ccd_max_advances: 0, ..Default::default() }) - 0.6).abs() < 1.0e-4);
    // One advance aims half the tolerance short of the wall: from 2.25 m away, closing 300 m/s at the straight line's speed, the first advance lands
    // at the touch and finds it, so one is enough here and two give the same.
    let one = stopped_ball(Settings { ccd_max_advances: 1, ..Default::default() });
    assert!(one <= 2.85 + 1.0e-4 && one > 0.6, "one advance: {one}");
    // A least advance longer than the step: the first advance is not worth taking, and the ball stays where the sweep started.
    assert!((stopped_ball(Settings { min_ccd_dt: 1.0, ..Default::default() }) - 0.6).abs() < 1.0e-4);
    // One shorter than the advances it needs changes nothing.
    assert!((stopped_ball(Settings { min_ccd_dt: 1.0e-9, ..Default::default() }) - 2.85).abs() < 0.01);
}
