use margoengine_physics2d_kernel::{
    error::PhysicsError,
    math::{Rot, V2},
    shape::Core,
    world::{BodyDef, Kind, Settings, ShapeDef, World},
};

#[test]
fn nonzero_finite_rotation_pairs_keep_their_direction_across_the_f32_range() {
    for (c, s) in [
        (1.0e30_f32, 1.0e30_f32),
        (f32::MAX, -f32::MAX),
        (0.0, f32::from_bits(1)),
        (1.0e-30, -1.0e-30),
        (1.0e-20, 2.0e-20),
    ] {
        let q = Rot::from_pair(c, s);
        let length = ((c as f64) * (c as f64) + (s as f64) * (s as f64)).sqrt();
        assert!(q.c.is_finite() && q.s.is_finite());
        assert!((q.c as f64 - c as f64 / length).abs() < 3.0e-7, "{c} {s}: {q:?}");
        assert!((q.s as f64 - s as f64 / length).abs() < 3.0e-7, "{c} {s}: {q:?}");
        assert!((q.c * q.c + q.s * q.s - 1.0).abs() < 4.0e-7);
    }
    assert_eq!(Rot::from_pair(0.0, -0.0), Rot::IDENTITY);
}

#[test]
fn large_finite_angular_velocity_does_not_publish_a_zero_rotation() {
    for kind in [Kind::Dynamic, Kind::Kinematic] {
        for lanes in [false, true] {
            let mut world = World::new(Settings { gravity: V2::ZERO, substeps: 1, contact_lanes: lanes, ..Default::default() });
            let id = world.create_body(&BodyDef { kind, angular_velocity: 1.0e30, ..Default::default() }).unwrap();
            world.create_shape(id, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
            world.step(1.0 / 60.0).unwrap();
            let q = world.bodies[id as usize].xf.q;
            assert!((q.c * q.c + q.s * q.s - 1.0).abs() < 4.0e-7, "{kind:?}, lanes={lanes}: {q:?}");
        }
    }
}

#[test]
fn nonfinite_rotation_integration_is_a_checked_arithmetic_error() {
    let mut world = World::new(Settings { gravity: V2::ZERO, substeps: 1, ..Default::default() });
    let id = world.create_body(&BodyDef { angular_velocity: 1.0e30, ..Default::default() }).unwrap();
    world.create_shape(id, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    assert_eq!(world.step(1.0e30), Err(PhysicsError::ArithmeticOverflow));
}

#[test]
fn a_mutated_zero_body_rotation_is_refused_before_publication_or_step() {
    let mut world = World::default();
    let id = world.create_body(&BodyDef::default()).unwrap();
    world.bodies[id as usize].xf.q = Rot { c: 0.0, s: -0.0 };
    assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::InvalidParameter));
    assert_eq!(world.steps, 0);
    assert_eq!(world.wake(id), Err(PhysicsError::InvalidParameter));
    assert_eq!(world.angle(id), Err(PhysicsError::InvalidParameter));
    assert_eq!(world.create_shape(id, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()), Err(PhysicsError::InvalidParameter));
    assert!(world.shapes.is_empty());
}
