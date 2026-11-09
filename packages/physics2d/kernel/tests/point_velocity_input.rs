use margoengine_physics2d_kernel::{
    error::PhysicsError,
    math::{V2, v2},
    shape::Core,
    world::{BodyDef, Kind, Settings, ShapeDef, World},
};

#[test]
fn unrepresentable_contact_point_velocity_cannot_become_zero_response() {
    for radius in [1.0e9, 1.0e10] {
        for lanes in [false, true] {
            let mut world = World::new(Settings { gravity: V2::ZERO, substeps: 1, contact_lanes: lanes, sleep: false, ..Default::default() });
            let ground = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
            let floor = Core::rect(1.0e10, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap();
            world.create_shape(ground, floor, &ShapeDef { friction: 0.0, ..Default::default() }).unwrap();
            let body = world.create_body(&BodyDef { position: v2(0.0, radius), linear_velocity: v2(0.0, -1.0), angular_velocity: 1.0e30, ..Default::default() }).unwrap();
            world.create_shape(body, Core::circle(V2::ZERO, radius).unwrap(), &ShapeDef { density: 1.0e-40, friction: 0.0, restitution: 0.0 }).unwrap();
            assert!(world.bodies[body as usize].inv_mass.is_finite());
            assert!(world.bodies[body as usize].inv_inertia.is_finite());
            assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::ArithmeticOverflow), "radius={radius}, lanes={lanes}");
            assert!(world.contacts.iter().any(|c| c.manifold.count == 1), "must exercise the actual circle/floor contact");
        }
    }
}
