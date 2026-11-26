// A shape's mass set rather than found from its density (Rapier's collider `setMass` and `setMassProperties`): a set mass
// keeps the outline's centre and scales its inertia, and holds when the outline changes; given properties are taken as
// they are; density mode goes back; a snapshot keeps the mode; bad values are refused and leave the shape as it was.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, MassMode, ShapeDef, World};

#[test]
fn a_set_mass_scales_the_outline_and_holds_through_a_new_outline_and_a_snapshot() {
    let mut w = World::default();
    let b = w.create_body(&BodyDef::default()).unwrap();
    // A 1 m square at 2 kg/m^2: 2 kg, inertia m (a^2 + b^2) / 12 = 1/3.
    let s = w.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 2.0, ..Default::default() }).unwrap();
    assert!((w.bodies[b as usize].mass - 2.0).abs() < 1e-6);
    w.set_shape_mass(s, MassMode::Mass(5.0)).unwrap();
    let body = &w.bodies[b as usize];
    assert!((body.mass - 5.0).abs() < 1e-6 && (body.inertia - 5.0 / 6.0).abs() < 1e-5, "mass {} inertia {}", body.mass, body.inertia);
    // A new outline keeps the set mass: a disc of radius 1 at 5 kg, inertia m r^2 / 2.
    w.set_shape_core(s, Core::circle(V2::ZERO, 1.0).unwrap()).unwrap();
    assert!((w.bodies[b as usize].mass - 5.0).abs() < 1e-6 && (w.bodies[b as usize].inertia - 2.5).abs() < 1e-5);
    // And a snapshot keeps the mode.
    let bytes = w.snapshot();
    let back = World::from_snapshot(&bytes).unwrap();
    assert_eq!(back.shapes[s as usize].mass_mode, MassMode::Mass(5.0));
    // Given properties are taken as given: 3 kg at (0.5, 0) with 0.25 kg m^2 about it.
    w.set_shape_mass(s, MassMode::Props { mass: 3.0, center: v2(0.5, 0.0), inertia: 0.25 }).unwrap();
    let body = &w.bodies[b as usize];
    assert!((body.mass - 3.0).abs() < 1e-6 && (body.local_center.x - 0.5).abs() < 1e-6 && (body.inertia - 0.25).abs() < 1e-6);
    let (data, area) = w.shape_mass(s).unwrap();
    assert!((data.mass - 3.0).abs() < 1e-6 && (area - core::f32::consts::PI).abs() < 1e-4);
    // Back to density: the disc at 2 kg/m^2.
    w.set_shape_mass(s, MassMode::Density).unwrap();
    assert!((w.bodies[b as usize].mass - 2.0 * core::f32::consts::PI).abs() < 1e-4);
}

#[test]
fn a_negative_or_non_finite_mass_is_refused_and_the_shape_left_as_it_was() {
    let mut w = World::default();
    let b = w.create_body(&BodyDef::default()).unwrap();
    let s = w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    let before = w.bodies[b as usize].mass;
    for mode in [MassMode::Mass(-1.0), MassMode::Mass(f32::NAN), MassMode::Props { mass: 1.0, center: V2::ZERO, inertia: -1.0 }, MassMode::Props { mass: 1.0, center: v2(f32::INFINITY, 0.0), inertia: 1.0 }] {
        assert!(w.set_shape_mass(s, mode).is_err(), "{mode:?}");
        assert_eq!(w.shapes[s as usize].mass_mode, MassMode::Density);
        assert_eq!(w.bodies[b as usize].mass, before);
    }
}
