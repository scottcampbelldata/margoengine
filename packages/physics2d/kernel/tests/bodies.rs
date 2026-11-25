// Body controls: velocities, impulses at a point, persistent forces and torques, dominance, fixed rotation and the
// position-driven kinematic body.
use margoengine_physics2d_kernel::math::{Rot, V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn space() -> World {
    World::new(Settings { gravity: V2::ZERO, ..Default::default() })
}

fn crate_(world: &mut World, x: f32, y: f32) -> u32 {
    let b = world.create_body(&BodyDef { position: v2(x, y), ..Default::default() }).unwrap();
    world.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    b
}

#[test]
fn an_impulse_through_the_centre_gives_v_equals_j_over_m() {
    let mut w = space();
    let b = crate_(&mut w, 0.0, 0.0);
    let m = w.bodies[b as usize].mass;
    w.apply_impulse(b, v2(3.0, -1.0), None).unwrap();
    let v = w.bodies[b as usize].linear_velocity;
    assert!((v.x - 3.0 / m).abs() < 1e-6 && (v.y + 1.0 / m).abs() < 1e-6);
    assert_eq!(w.bodies[b as usize].angular_velocity, 0.0);
}

#[test]
fn an_impulse_off_centre_spins_the_body() {
    let mut w = space();
    let b = crate_(&mut w, 0.0, 0.0);
    let i = w.bodies[b as usize].inertia;
    w.apply_impulse(b, v2(0.0, 2.0), Some(v2(0.5, 0.0))).unwrap();
    // torque = r x j = 0.5 * 2
    assert!((w.bodies[b as usize].angular_velocity - 1.0 / i).abs() < 1e-5);
    w.apply_torque_impulse(b, -1.0).unwrap();
    assert!(w.bodies[b as usize].angular_velocity.abs() < 1e-5);
}

#[test]
fn a_force_acts_every_step_until_reset() {
    let mut w = space();
    let b = crate_(&mut w, 0.0, 0.0);
    let m = w.bodies[b as usize].mass;
    w.add_force(b, v2(10.0, 0.0), 0.0).unwrap();
    for _ in 0..60 {
        w.step(DT).unwrap();
    }
    // a = F/m for one second.
    let v = w.bodies[b as usize].linear_velocity.x;
    assert!((v - 10.0 / m).abs() < 0.02, "{v} against {}", 10.0 / m);
    w.reset_forces(b).unwrap();
    for _ in 0..30 {
        w.step(DT).unwrap();
    }
    assert!((w.bodies[b as usize].linear_velocity.x - v).abs() < 0.02);
    w.add_force(b, V2::ZERO, 2.0).unwrap();
    for _ in 0..60 {
        w.step(DT).unwrap();
    }
    let i = w.bodies[b as usize].inertia;
    assert!((w.bodies[b as usize].angular_velocity - 2.0 / i).abs() < 0.02);
}

#[test]
fn a_dominant_body_is_not_pushed_by_a_lighter_one() {
    // A light crate flies into a heavy one: with equal dominance the heavy one moves a little; when the light one
    // dominates, it plows through as if the heavy one were immovable, and the heavy one is thrown.
    let outcome = |dominance_light: i8, dominance_heavy: i8| {
        let mut w = space();
        let light = w.create_body(&BodyDef { position: v2(-3.0, 0.0), linear_velocity: v2(5.0, 0.0), dominance: dominance_light, can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(light, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 1.0, friction: 0.0, ..Default::default() }).unwrap();
        let heavy = w.create_body(&BodyDef { position: v2(0.0, 0.0), dominance: dominance_heavy, can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(heavy, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 100.0, friction: 0.0, ..Default::default() }).unwrap();
        for _ in 0..60 {
            w.step(DT).unwrap();
        }
        (w.bodies[light as usize].linear_velocity.x, w.bodies[heavy as usize].linear_velocity.x)
    };
    let (light_v, heavy_v) = outcome(0, 0);
    // Inelastic: 5 kg m/s shared by 101 kg.
    assert!((light_v - 5.0 / 101.0).abs() < 2e-3 && (heavy_v - 5.0 / 101.0).abs() < 2e-3, "{light_v} {heavy_v}");
    let (light_v, heavy_v) = outcome(1, 0);
    assert!(light_v > 4.9 && heavy_v > 4.9, "the dominant light crate keeps its speed: {light_v} {heavy_v}");
    let (light_v, heavy_v) = outcome(0, 1);
    assert!(heavy_v.abs() < 1e-4 && light_v.abs() < 1e-3, "the dominant heavy one stays: {light_v} {heavy_v}");
}

#[test]
fn a_fixed_rotation_body_does_not_turn_and_can_be_freed() {
    let mut w = World::default();
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(ground, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let b = crate_(&mut w, 0.0, 0.52);
    w.set_fixed_rotation(b, true).unwrap();
    assert_eq!(w.bodies[b as usize].inv_inertia, 0.0);
    w.apply_impulse(b, v2(0.0, 0.0), Some(v2(0.4, 0.0))).unwrap();
    w.apply_impulse(b, v2(1.0, 0.0), Some(v2(0.0, 0.5))).unwrap();
    for _ in 0..30 {
        w.step(DT).unwrap();
    }
    assert!(w.angle(b).unwrap().abs() < 1e-6);
    w.set_fixed_rotation(b, false).unwrap();
    assert!(w.bodies[b as usize].inv_inertia > 0.0);
}

#[test]
fn a_kinematic_body_driven_by_position_arrives_exactly_and_pushes_what_is_in_its_way() {
    let mut w = space();
    let k = w.create_body(&BodyDef { kind: Kind::Kinematic, position: v2(-2.0, 0.0), ..Default::default() }).unwrap();
    w.create_shape(k, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let ball = w.create_body(&BodyDef { position: v2(0.0, 0.0), ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef { friction: 0.0, ..Default::default() }).unwrap();
    for step in 1..=90 {
        let x = -2.0 + 3.0 * step as f32 * DT; // 3 m/s
        w.set_next_kinematic(k, v2(x, 0.0), Rot::IDENTITY).unwrap();
        w.step(DT).unwrap();
        assert!((w.bodies[k as usize].xf.p.x - x).abs() < 1e-5, "step {step}");
    }
    assert!(w.bodies[ball as usize].xf.p.x > 1.5, "pushed along: {}", w.bodies[ball as usize].xf.p.x);
    // With no new target it stops, and sleeps.
    for _ in 0..90 {
        w.step(DT).unwrap();
    }
    assert!(w.bodies[k as usize].linear_velocity.length() == 0.0);
    assert!(w.set_next_kinematic(ball, V2::ZERO, Rot::IDENTITY).is_err());
}

#[test]
fn set_velocity_wakes_a_sleeping_body() {
    let mut w = space();
    let b = crate_(&mut w, 0.0, 0.0);
    for _ in 0..120 {
        w.step(DT).unwrap();
    }
    assert!(!w.bodies[b as usize].awake);
    w.set_velocity(b, v2(1.0, 0.0), 0.5).unwrap();
    assert!(w.bodies[b as usize].awake);
    w.step(DT).unwrap();
    assert!(w.bodies[b as usize].xf.p.x > 0.0);
}

#[test]
fn an_added_solid_joins_the_shapes_by_the_parallel_axis_theorem() {
    let mut w = space();
    let b = crate_(&mut w, 0.0, 0.0);
    let (m, i) = (w.bodies[b as usize].mass, w.bodies[b as usize].inertia);
    // 3 kg at (2, 0) with inertia 0.5 about its own centre: the centre moves to 3 * 2 / (m + 3), and the inertia is the sum of each
    // part's own and its mass times the squared distance of its centre from the combined one.
    w.set_additional_mass_properties(b, 3.0, v2(2.0, 0.0), 0.5).unwrap();
    let body = &w.bodies[b as usize];
    let cx = 6.0 / (m + 3.0);
    assert!((body.mass - (m + 3.0)).abs() < 1e-5);
    assert!((body.local_center.x - cx).abs() < 1e-5 && body.local_center.y.abs() < 1e-6);
    let expected = i + m * cx * cx + 0.5 + 3.0 * (2.0 - cx) * (2.0 - cx);
    assert!((body.inertia - expected).abs() < 1e-4, "{} against {}", body.inertia, expected);
    w.set_additional_mass_properties(b, 0.0, v2(0.0, 0.0), 0.0).unwrap();
    assert!((w.bodies[b as usize].mass - m).abs() < 1e-6 && w.bodies[b as usize].local_center.x.abs() < 1e-6);
    assert!(w.set_additional_mass_properties(b, -1.0, v2(0.0, 0.0), 0.0).is_err());
    assert!(w.set_additional_mass_properties(b, 1.0, v2(f32::NAN, 0.0), 0.0).is_err());
}
