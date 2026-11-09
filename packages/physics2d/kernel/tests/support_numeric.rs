//! Derived normal operators must remain in the finite monotone domain even for speculative/hard rows.
use margoengine_physics2d_kernel::{
    error::PhysicsError,
    math::{V2, v2},
    shape::Core,
    world::{BodyDef, Settings, ShapeDef, World},
};

#[test]
fn a_nonfinite_contact_diagonal_cannot_be_hidden_by_zero_reciprocal_mass() {
    for lanes in [false, true] {
        let mut w = World::new(Settings {
            gravity: V2::ZERO,
            substeps: 1,
            contact_lanes: lanes,
            sleep: false,
            ..Default::default()
        });
        for (y, vy) in [(-0.505, 1.0), (0.505, -1.0)] {
            let id = w
                .create_body(&BodyDef {
                    position: v2(0.0, y),
                    linear_velocity: v2(0.0, vy),
                    fixed_rotation: true,
                    ..Default::default()
                })
                .unwrap();
            w.create_shape(
                id,
                Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(),
                &ShapeDef {
                    density: 4e-39,
                    friction: 0.0,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        assert!(w.bodies.iter().all(|b| b.inv_mass.is_finite()));
        assert!((w.bodies[0].inv_mass + w.bodies[1].inv_mass).is_infinite());
        assert_eq!(w.step(1.0 / 60.0), Err(PhysicsError::ArithmeticOverflow));
        assert!(
            w.contacts.iter().any(|c| c.manifold.count == 2),
            "must exercise the open two-point row"
        );
    }
}
