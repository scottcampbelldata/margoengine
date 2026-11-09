use margoengine_physics2d_kernel::{
    error::PhysicsError,
    joint::{JointDef, JointKind, Motor},
    manifold::collide,
    math::{Rot, V2, Xf, v2},
    shape::Core,
    world::{BodyDef, ShapeDef, World, bounds_of},
    smooth::collide_smooth,
};

#[test]
fn nonfinite_body_creation_does_not_publish_a_body() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut world = World::default();
        // This assertion also compiles against the former infallible API and fails on main.
        let _ = world.create_body(&BodyDef { position: v2(bad, 0.0), ..BodyDef::default() });
        assert!(world.bodies.is_empty(), "an invalid position must be rejected before publication");
    }
}

#[test]
fn positive_mass_and_inertia_underflow_do_not_take_the_zero_area_fallback() {
    let box_ = Core::rect(0.1, 0.1, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let circle = Core::circle(V2::ZERO, 1.0e-10).unwrap();
    let capsule = Core::capsule(v2(-0.1, 0.0), v2(0.1, 0.0), 1.0e-10).unwrap();
    for (core, density) in [(box_, f32::from_bits(1)), (circle, 1.0e-18), (capsule, f32::from_bits(1))] {
        let mut world = World::default();
        let body = world.create_body(&BodyDef::default()).unwrap();
        let before = format!("{:?}", world.bodies[body as usize]);
        assert_eq!(world.create_shape(body, core, &ShapeDef { density, ..Default::default() }), Err(PhysicsError::ArithmeticOverflow));
        assert!(world.shapes.is_empty());
        assert_eq!(format!("{:?}", world.bodies[body as usize]), before);
    }
    // Exact zero area and zero density retain their documented unit-mass/no-turning fallback.
    for (core, density) in [(box_, 0.0), (circle, 0.0), (Core::circle(V2::ZERO, 0.0).unwrap(), 1.0), (Core::segment(v2(-0.1, 0.0), v2(0.1, 0.0)).unwrap(), f32::from_bits(1))] {
        let mut world = World::default();
        let body = world.create_body(&BodyDef::default()).unwrap();
        world.create_shape(body, core, &ShapeDef { density, ..Default::default() }).unwrap();
        assert_eq!((world.bodies[0].mass, world.bodies[0].inv_inertia), (1.0, 0.0));
    }
}

fn pair_world() -> World {
    let mut world = World::default();
    let core = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    for x in [0.0, 0.75] {
        let body = world.create_body(&BodyDef { position: v2(x, 0.0), ..Default::default() }).unwrap();
        world.create_shape(body, core, &ShapeDef::default()).unwrap();
    }
    world
}

fn overflow_contact(lanes: bool, density: f32, velocity: V2, height: f32) -> World {
    use margoengine_physics2d_kernel::world::{Kind, Settings};
    let mut world = World::new(Settings { gravity: V2::ZERO, substeps: 1, contact_lanes: lanes, ..Default::default() });
    let ground = world.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, -0.5), ..Default::default() }).unwrap();
    let box_ = world.create_body(&BodyDef { position: v2(0.0, height), linear_velocity: velocity, fixed_rotation: true, ..Default::default() }).unwrap();
    world.create_shape(ground, Core::rect(5.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { friction: 0.0, ..Default::default() }).unwrap();
    let result = world.create_shape(box_, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density, friction: 0.0, ..Default::default() });
    // Keep the world available even when representability validation refuses the shape.
    if density == f32::MAX { assert_eq!(result, Err(PhysicsError::ArithmeticOverflow)); } else { result.unwrap(); }
    world
}

#[test]
fn overflow_case_effective_reciprocal_is_refused_before_scalar_friction_can_panic() {
    let dt = 1.0 / 240.0;
    for lanes in [false, true] {
        let mut world = overflow_contact(lanes, f32::MAX, v2(1.0, -1.0), 0.5 + 1.5 * dt);
        // On the former implementation the speculative row's relaxing impulse became infinity, then
        // zero-friction times infinity produced invalid clamp bounds and panicked here.
        world.step(dt).unwrap();
        assert_eq!(world.shapes.len(), 1, "unrepresentable reciprocal must reject the dynamic shape");
    }
}

#[test]
fn overflow_case_finite_material_geometric_mean_remains_finite() {
    for lanes in [false, true] {
        for (a, b) in [(1.0e20, 1.0e20), (f32::MAX, f32::MAX), (f32::MAX, 1.234_567), (2.0e19, 3.0e19)] {
            let mut world = pair_world();
            world.settings.contact_lanes = lanes;
            world.settings.gravity = V2::ZERO;
            world.shapes[0].friction = a;
            world.shapes[1].friction = b;
            world.step(1.0 / 240.0).unwrap();
        }
    }
}

#[test]
fn overflow_case_finite_closing_speed_returns_an_error_instead_of_panicking() {
    for lanes in [false, true] {
        let mut world = overflow_contact(lanes, 10.0, v2(1.0, -f32::MAX), 0.499);
        assert_eq!(world.shapes.len(), 2);
        assert_eq!(world.step(1.0 / 240.0), Err(PhysicsError::ArithmeticOverflow));
    }
}

#[test]
fn mutable_inverse_metrics_are_checked_before_any_solver_reciprocal() {
    for field in 0..2 {
        let mut world = pair_world();
        let tiny = 1.0 / f32::MAX;
        assert!(!(1.0 / tiny).is_finite());
        if field == 0 { world.bodies[0].inv_mass = tiny; } else { world.bodies[0].inv_inertia = tiny; }
        let before = format!("{:?}", world.bodies[0]);
        assert_eq!(world.step(1.0 / 240.0), Err(PhysicsError::ArithmeticOverflow));
        assert_eq!(world.steps, 0);
        assert_eq!(world.create_shape(0, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef::default()), Err(PhysicsError::ArithmeticOverflow));
        assert_eq!(format!("{:?}", world.bodies[0]), before);
        assert_eq!(world.shapes.len(), 2);
    }
}

#[test]
fn duplicate_shape_ids_are_refused_by_the_linear_graph_witness() {
    let mut world = pair_world();
    world.bodies[0].shapes.push(0);
    assert_eq!(world.step(1.0 / 240.0), Err(PhysicsError::InvalidHandle));
    assert_eq!(world.steps, 0);
}

#[test]
fn negative_used_normal_impulses_are_refused_and_unused_cache_slots_are_ignored() {
    for lanes in [false, true] {
        let mut world = pair_world();
        world.settings.contact_lanes = lanes;
        world.step(1.0 / 240.0).unwrap();
        world.contacts[0].normal_impulse[0] = -1.0;
        assert_eq!(world.step(1.0 / 240.0), Err(PhysicsError::InvalidParameter));
        assert_eq!(world.steps, 1);
        let mut world = World::default();
        world.settings.contact_lanes = lanes;
        for x in [0.0, 1.5] {
            let body = world.create_body(&BodyDef { position: v2(x, 0.0), ..Default::default() }).unwrap();
            world.create_shape(body, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef::default()).unwrap();
        }
        world.step(1.0 / 240.0).unwrap();
        assert_eq!(world.contacts[0].manifold.count, 1);
        world.contacts[0].normal_impulse[1] = -1.0;
        world.step(1.0 / 240.0).unwrap();
    }
}

#[test]
fn mass_update_stages_the_rounded_origin_before_publishing_any_body_fields() {
    let mut world = World::default();
    let body = world.create_body(&BodyDef::default()).unwrap();
    world.bodies[0].xf.p = V2::ZERO;
    world.bodies[0].exact_center = [-(f32::MAX as f64), 0.0];
    world.bodies[0].local_center = v2(f32::MAX, 0.0);
    world.bodies[0].center = v2(-f32::MAX, 0.0);
    let before = format!("{:?}", world.bodies[0]);
    let core = Core::circle(v2(f32::MAX, 0.0), 1.0).unwrap();
    let density = 1.0 / margoengine_physics2d_kernel::math::PI;
    assert_eq!(margoengine_physics2d_kernel::mass::mass_of(&core, density).mass, 1.0);
    assert_eq!(world.create_shape(body, core, &ShapeDef { density, ..Default::default() }), Err(PhysicsError::ArithmeticOverflow));
    assert!(world.shapes.is_empty());
    assert_eq!(format!("{:?}", world.bodies[0]), before);
}

#[test]
fn negative_recovery_bounds_are_refused_before_contact_or_joint_clamping() {
    for joint_cap in [false, true] {
        let mut world = pair_world();
        if joint_cap { world.settings.joint_max_push = -1.0; } else { world.settings.contact_max_push = -1.0; }
        assert_eq!(world.step(1.0 / 240.0), Err(PhysicsError::InvalidParameter));
        assert_eq!(world.steps, 0);
    }
}

#[test]
fn a_late_chain_error_preserves_body_shapes_ids_and_broad_state() {
    let (mut world, mut control) = (pair_world(), pair_world());
    let body = format!("{:?}", world.bodies[0]);
    let shapes = format!("{:?}", world.shapes);
    assert_eq!(world.create_chain(0, &[V2::ZERO, v2(1.0, 0.0), v2(f32::MAX, 0.0)], false, &ShapeDef::default()), Err(PhysicsError::ArithmeticOverflow));
    assert_eq!(format!("{:?}", world.bodies[0]), body);
    assert_eq!(format!("{:?}", world.shapes), shapes);
    world.step(1.0 / 60.0).unwrap();
    control.step(1.0 / 60.0).unwrap();
    assert_eq!(format!("{:?}", world.contacts), format!("{:?}", control.contacts));
    assert_eq!(format!("{:?}", world.bodies), format!("{:?}", control.bodies));
    let core = Core::circle(V2::ZERO, 0.1).unwrap();
    assert_eq!(world.create_shape(0, core, &ShapeDef::default()).unwrap(), 2);
}

#[test]
fn mutable_shape_graph_and_old_contact_counts_are_checked_before_indexing() {
    for asleep in [false, true] {
        let mut world = pair_world();
        world.step(1.0 / 60.0).unwrap();
        assert!(!world.contacts.is_empty());
        for body in &mut world.bodies { body.awake = !asleep; }
        world.contacts[0].manifold.count = 3;
        let steps = world.steps;
        assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::InvalidParameter));
        assert_eq!(world.steps, steps);
    }
    for count in [0, 9, usize::MAX] {
        let mut world = pair_world();
        world.shapes[0].core.count = count;
        let before = format!("{:?}", world.bodies[0]);
        assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::InvalidCore));
        assert_eq!(world.create_shape(0, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef::default()), Err(PhysicsError::InvalidCore));
        assert_eq!(world.shapes.len(), 2);
        assert_eq!(format!("{:?}", world.bodies[0]), before);
    }
    let mut world = pair_world();
    world.bodies[0].shapes[0] = u32::MAX;
    let before = format!("{:?}", world.bodies[0]);
    assert_eq!(world.create_shape(0, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef::default()), Err(PhysicsError::InvalidHandle));
    assert_eq!(world.shapes.len(), 2);
    assert_eq!(format!("{:?}", world.bodies[0]), before);
    assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::InvalidHandle));
    let mut world = pair_world();
    world.step(1.0 / 60.0).unwrap();
    world.contacts[0].a = u32::MAX;
    assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::InvalidHandle));
    // Even when the public vectors agree after removal, a stale private broad proxy must not index past them.
    let mut world = pair_world();
    world.shapes.pop();
    world.bodies[1].shapes.clear();
    assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::InvalidHandle));
}

#[test]
fn nonfinite_sleep_timers_and_contact_impulses_are_refused_before_stepping() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut world = pair_world();
        world.bodies[0].sleep_time = bad;
        assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::NotFinite));
        assert_eq!(world.steps, 0);
        let mut world = pair_world();
        world.step(1.0 / 60.0).unwrap();
        world.contacts[0].normal_impulse[0] = bad;
        assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::NotFinite));
        assert_eq!(world.steps, 1);
    }
}

fn rope(a: u32, b: u32) -> JointDef {
    JointDef { kind: JointKind::Rope { length: 1.0 }, a, b, anchor_a: V2::ZERO, anchor_b: V2::ZERO, collide: false }
}

#[test]
fn public_body_handles_and_mutable_joint_handles_return_coded_errors() {
    let mut world = pair_world();
    assert_eq!(world.wake(u32::MAX), Err(PhysicsError::InvalidHandle));
    assert_eq!(world.angle(u32::MAX), Err(PhysicsError::InvalidHandle));
    assert_eq!(world.create_joint(&rope(0, u32::MAX)), Err(PhysicsError::InvalidHandle));
    assert!(world.joints.is_empty());
    world.create_joint(&rope(0, 1)).unwrap();
    world.joints[0].def.a = u32::MAX;
    assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::InvalidHandle));
}

#[test]
fn joint_numbers_and_cached_impulses_are_checked_with_the_unbounded_motor_sentinel_retained() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut defs = Vec::new();
        let mut def = rope(0, 1); def.anchor_a.x = bad; defs.push(def);
        let mut def = rope(0, 1); def.anchor_b.y = bad; defs.push(def);
        for kind in [
            JointKind::Rope { length: bad },
            JointKind::Spring { rest_length: bad, stiffness: 1.0, damping: 1.0 },
            JointKind::Spring { rest_length: 1.0, stiffness: bad, damping: 1.0 },
            JointKind::Spring { rest_length: 1.0, stiffness: 1.0, damping: bad },
            JointKind::Fixed { angle_a: Rot { c: bad, s: 0.0 }, angle_b: Rot::IDENTITY },
            JointKind::Prismatic { axis: v2(bad, 0.0), limits: None, motor: None },
            JointKind::Revolute { limits: Some((bad, 1.0)), motor: None },
        ] { defs.push(JointDef { kind, ..rope(0, 1) }); }
        for field in 0..5 {
            if field == 4 && bad == f32::INFINITY { continue; }
            let mut motor = Motor::velocity(0.0, 1.0);
            match field { 0 => motor.target_position = bad, 1 => motor.target_velocity = bad, 2 => motor.stiffness = bad, 3 => motor.damping = bad, _ => motor.max_force = bad }
            defs.push(JointDef { kind: JointKind::Revolute { limits: None, motor: Some(motor) }, ..rope(0, 1) });
        }
        for def in defs {
            let mut world = pair_world();
            assert_eq!(world.create_joint(&def), Err(PhysicsError::NotFinite));
            assert!(world.joints.is_empty());
        }
        let mut world = pair_world();
        world.create_joint(&rope(0, 1)).unwrap();
        world.joints[0].lock[0] = bad;
        assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::NotFinite));
    }
    let mut world = pair_world();
    world.create_joint(&JointDef { kind: JointKind::Revolute { limits: None, motor: Some(Motor::velocity(0.0, 1.0)) }, ..rope(0, 1) }).unwrap();
    world.step(1.0 / 60.0).unwrap();
    let mut motor = Motor::velocity(0.0, 1.0); motor.max_force = -1.0;
    assert_eq!(world.create_joint(&JointDef { kind: JointKind::Revolute { limits: None, motor: Some(motor) }, ..rope(0, 1) }), Err(PhysicsError::InvalidParameter));
}

#[test]
fn finite_smooth_ghost_and_mean_overflow_returns_a_coded_error() {
    let segment = Core::segment(v2(-0.5, 0.0), v2(0.5, 0.0)).unwrap();
    let circle = Core::circle(V2::ZERO, 0.2).unwrap();
    let pose = Xf { p: v2(0.6, 0.1), ..Xf::IDENTITY };
    assert!(collide(&segment, Xf::IDENTITY, &circle, pose, 0.02).unwrap().count > 0);
    assert_eq!(collide_smooth(&segment, [None, Some(v2(f32::MAX, f32::MAX))], Xf::IDENTITY, &circle, pose, 0.02), Err(PhysicsError::ArithmeticOverflow));
    let mut collapsed_segment = segment;
    collapsed_segment.vertices[..2].fill(v2(f32::MAX, 0.0));
    let mut collapsed_box = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    collapsed_box.vertices[..4].fill(v2(f32::MAX, 0.0));
    assert!(collide(&collapsed_segment, Xf::IDENTITY, &collapsed_box, Xf::IDENTITY, 0.02).unwrap().count > 0);
    assert_eq!(collide_smooth(&collapsed_segment, [None; 2], Xf::IDENTITY, &collapsed_box, Xf::IDENTITY, 0.02), Err(PhysicsError::ArithmeticOverflow));
    let mut large_normal = Core::segment(V2::ZERO, v2(1.0, 0.0)).unwrap();
    large_normal.normals[0] = v2(f32::MAX, 0.0);
    large_normal.normals[1] = v2(-f32::MAX, 0.0);
    let box_ = Core::rect(1.5, 0.5, v2(1.5, 0.0), 1.0, 0.0, 0.0).unwrap();
    assert!(collide(&large_normal, Xf::IDENTITY, &box_, Xf::IDENTITY, 0.02).unwrap().count > 0);
    assert_eq!(collide_smooth(&large_normal, [None; 2], Xf::IDENTITY, &box_, Xf::IDENTITY, 0.02), Err(PhysicsError::ArithmeticOverflow));
}

#[test]
fn invalid_density_does_not_publish_a_shape_or_nonfinite_centre() {
    for density in [f32::INFINITY, f32::from_bits(1)] {
        let mut world = World::default();
        let _ = world.create_body(&BodyDef::default());
        let core = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
        let _ = world.create_shape(0, core, &ShapeDef { density, ..ShapeDef::default() });
        assert!(world.shapes.is_empty(), "unrepresentable mass must not be published");
        assert!(world.bodies[0].exact_center.into_iter().all(f64::is_finite));
    }
}

#[test]
fn body_input_errors_are_coded_and_leave_ids_available() {
    for field in 0..10 {
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut world = World::default();
            let mut def = BodyDef::default();
            match field {
                0 => def.position.x = bad,
                1 => def.position.y = bad,
                2 => def.rotation.c = bad,
                3 => def.rotation.s = bad,
                4 => def.linear_velocity.x = bad,
                5 => def.linear_velocity.y = bad,
                6 => def.angular_velocity = bad,
                7 => def.linear_damping = bad,
                8 => def.angular_damping = bad,
                _ => def.gravity_scale = bad,
            }
            let error = world.create_body(&def).unwrap_err();
            assert_eq!(error, PhysicsError::NotFinite);
            assert_eq!(error.code(), "PHYSICS2D_NOT_FINITE");
            assert!(error.to_string().contains(error.help()));
            assert!(world.bodies.is_empty());
            assert_eq!(world.create_body(&BodyDef::default()).unwrap(), 0);
        }
    }
}

#[test]
fn shape_mass_overflow_or_underflow_is_rejected_without_publishing_state() {
    for density in [f32::INFINITY, f32::NAN, f32::from_bits(1)] {
        let mut world = World::default();
        let body = world.create_body(&BodyDef::default()).unwrap();
        let core = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
        let before = world.bodies[body as usize].clone();
        let error = world.create_shape(body, core, &ShapeDef { density, ..ShapeDef::default() }).unwrap_err();
        assert_eq!(error, if density.is_finite() { PhysicsError::ArithmeticOverflow } else { PhysicsError::NotFinite });
        assert!(world.shapes.is_empty());
        let after = &world.bodies[body as usize];
        assert!(after.shapes.is_empty());
        assert_eq!((after.mass, after.inv_mass, after.inertia, after.inv_inertia), (before.mass, before.inv_mass, before.inertia, before.inv_inertia));
        assert_eq!(after.exact_center, before.exact_center);
        assert_eq!(after.local_center, before.local_center);
        assert_eq!(world.create_shape(body, core, &ShapeDef::default()).unwrap(), 0);
        world.step(1.0 / 60.0).unwrap();
        assert!(world.bodies[0].exact_center.into_iter().all(f64::is_finite));
    }
}

#[test]
fn invalid_mutable_body_state_and_timestep_are_refused_before_stepping() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut world = World::default();
        let id = world.create_body(&BodyDef::default()).unwrap();
        assert_eq!(world.step(bad), Err(PhysicsError::NotFinite));
        assert_eq!(world.steps, 0);
        world.bodies[id as usize].xf.p.x = bad;
        assert_eq!(world.step(1.0 / 60.0), Err(PhysicsError::NotFinite));
        assert_eq!(world.steps, 0);
    }
}

#[test]
fn bounds_reject_invalid_public_core_counts_and_nonfinite_poses() {
    let core = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    for count in [0, 9, usize::MAX] {
        let mut bad = core;
        bad.count = count;
        assert_eq!(bounds_of(&bad, Xf::IDENTITY), Err(PhysicsError::InvalidCore));
    }
    assert_eq!(bounds_of(&core, Xf { p: v2(f32::NAN, 0.0), q: Rot::IDENTITY }), Err(PhysicsError::NotFinite));
}
