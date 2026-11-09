use margoengine_physics2d_kernel::{
    error::PhysicsError,
    math::{V2, v2},
    shape::Core,
    world::{BodyDef, Settings, ShapeDef, World},
};

#[test]
fn finite_individual_inverse_masses_cannot_hide_an_overflowing_pair_metric() {
    for lanes in [false, true] {
        let mut world = World::new(Settings { gravity: V2::ZERO, substeps: 1, contact_lanes: lanes, ..Default::default() });
        let core = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
        for sign in [-1.0, 1.0] {
            let id = world.create_body(&BodyDef { position: v2(sign * 0.505, 0.0), linear_velocity: v2(-sign, 0.0), fixed_rotation: true, ..Default::default() }).unwrap();
            world.create_shape(id, core, &ShapeDef { density: 4.0e-39, ..Default::default() }).unwrap();
            assert!(world.bodies[id as usize].inv_mass.is_finite());
        }
        assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::ArithmeticOverflow), "lanes={lanes}");
    }
}
