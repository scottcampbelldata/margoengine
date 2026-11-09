use margoengine_physics2d_kernel::{
    error::PhysicsError,
    joint::{JointDef, JointKind, Motor},
    math::{Rot, V2, v2},
    shape::Core,
    solver,
    world::{Body, BodyDef, Kind, Settings, ShapeDef, World},
};

const DT: f32 = 1.0 / 60.0;

fn touching_world(lanes: bool) -> World {
    let mut world = World::new(Settings {
        sleep: false,
        contact_lanes: lanes,
        ..Default::default()
    });
    for (kind, position, width) in [
        (Kind::Static, v2(0.0, -0.5), 10.0),
        (Kind::Dynamic, v2(0.0, 0.5), 0.5),
    ] {
        let body = world.create_body(&BodyDef { kind, position, ..Default::default() }).unwrap();
        world.create_shape(body, Core::rect(width, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    }
    world.step(DT).unwrap();
    assert_eq!(world.contacts.len(), 1);
    assert_eq!(world.contacts[0].manifold.count, 2);
    world
}

fn state(world: &World) -> String {
    format!("{:?}{:?}{:?}{:?}{:?}{:?}{}", world.bodies, world.shapes, world.contacts, world.joints, world.counts, world.settings, world.steps)
}

#[test]
fn public_solver_refuses_out_of_range_manifold_count() {
    for lanes in [false, true] {
        let mut world = touching_world(lanes);
        world.contacts[0].manifold.count = 3;
        let before = state(&world);
        assert_eq!(solver::solve(&mut world, DT), Err(PhysicsError::InvalidParameter));
        assert_eq!(state(&world), before, "preflight must precede physics mutation");
    }
}

#[test]
fn public_solver_checks_the_same_mutable_body_shape_and_contact_inputs() {
    type Case = (&'static str, fn(&mut World), PhysicsError);
    let cases: &[Case] = &[
        ("body pose", |w| w.bodies[1].xf.p.x = f32::NAN, PhysicsError::NotFinite),
        ("body velocity", |w| w.bodies[1].linear_velocity.y = f32::INFINITY, PhysicsError::NotFinite),
        ("sleep cache", |w| w.bodies[1].sleep_time = f32::NAN, PhysicsError::NotFinite),
        ("zero rotation", |w| w.bodies[1].xf.q = Rot { c: 0.0, s: 0.0 }, PhysicsError::InvalidParameter),
        ("negative inverse mass", |w| w.bodies[1].inv_mass = -1.0, PhysicsError::InvalidParameter),
        ("unrepresentable reciprocal", |w| w.bodies[1].inv_mass = f32::from_bits(1), PhysicsError::ArithmeticOverflow),
        ("shape handle", |w| w.bodies[1].shapes[0] = u32::MAX, PhysicsError::InvalidHandle),
        ("duplicate shape", |w| w.bodies[1].shapes.push(1), PhysicsError::InvalidHandle),
        ("unlisted shape", |w| w.bodies[1].shapes.clear(), PhysicsError::InvalidHandle),
        ("shape owner", |w| w.shapes[1].body = 0, PhysicsError::InvalidHandle),
        ("core count", |w| w.shapes[1].core.count = 0, PhysicsError::InvalidCore),
        ("core coordinate", |w| w.shapes[1].core.vertices[0].x = f32::NAN, PhysicsError::NotFinite),
        ("material", |w| w.shapes[1].friction = -1.0, PhysicsError::InvalidParameter),
        ("contact handle", |w| w.contacts[0].a = u32::MAX, PhysicsError::InvalidHandle),
        ("contact normal", |w| w.contacts[0].manifold.normal.y = f32::NAN, PhysicsError::NotFinite),
        ("contact point", |w| w.contacts[0].manifold.points[0].point.x = f32::INFINITY, PhysicsError::NotFinite),
        ("contact separation", |w| w.contacts[0].manifold.points[0].separation = f32::NAN, PhysicsError::NotFinite),
        ("normal cache", |w| w.contacts[0].normal_impulse[0] = f32::NAN, PhysicsError::NotFinite),
        ("negative normal cache", |w| w.contacts[0].normal_impulse[0] = -1.0, PhysicsError::InvalidParameter),
        ("tangent cache", |w| w.contacts[0].tangent_impulse[0] = f32::NAN, PhysicsError::NotFinite),
    ];
    for lanes in [false, true] {
        for &(name, mutate, expected) in cases {
            let mut world = touching_world(lanes);
            mutate(&mut world);
            let before = state(&world);
            assert_eq!(solver::solve(&mut world, DT), Err(expected), "{name}, lanes={lanes}");
            assert_eq!(state(&world), before, "{name}, lanes={lanes}");
        }
    }
}

fn joint_world(lanes: bool) -> World {
    let mut world = touching_world(lanes);
    world.create_joint(&JointDef {
        a: 0,
        b: 1,
        anchor_a: v2(0.0, 0.5),
        anchor_b: v2(0.0, -0.5),
        collide: true,
        kind: JointKind::Revolute { limits: None, motor: None },
    }).unwrap();
    world
}

#[test]
fn public_solver_checks_joint_handles_parameters_and_caches() {
    type Case = (&'static str, fn(&mut World), PhysicsError);
    let cases: &[Case] = &[
        ("handle", |w| w.joints[0].def.b = u32::MAX, PhysicsError::InvalidHandle),
        ("anchor", |w| w.joints[0].def.anchor_a.x = f32::NAN, PhysicsError::NotFinite),
        ("lock cache", |w| w.joints[0].lock[0] = f32::INFINITY, PhysicsError::NotFinite),
        ("motor cache", |w| w.joints[0].motor = f32::NAN, PhysicsError::NotFinite),
        ("limits", |w| w.joints[0].def.kind = JointKind::Revolute { limits: Some((1.0, -1.0)), motor: None }, PhysicsError::InvalidParameter),
        ("motor", |w| w.joints[0].def.kind = JointKind::Revolute { limits: None, motor: Some(Motor { max_force: -1.0, ..Motor::velocity(0.0, 1.0) }) }, PhysicsError::InvalidParameter),
        ("prismatic axis", |w| w.joints[0].def.kind = JointKind::Prismatic { axis: V2::ZERO, limits: None, motor: None }, PhysicsError::Degenerate),
        ("fixed rotation", |w| w.joints[0].def.kind = JointKind::Fixed { angle_a: Rot { c: f32::NAN, s: 0.0 }, angle_b: Rot::IDENTITY }, PhysicsError::NotFinite),
        ("rope length", |w| w.joints[0].def.kind = JointKind::Rope { length: -1.0 }, PhysicsError::InvalidParameter),
        ("spring", |w| w.joints[0].def.kind = JointKind::Spring { rest_length: 1.0, stiffness: f32::INFINITY, damping: 0.0 }, PhysicsError::NotFinite),
    ];
    for lanes in [false, true] {
        for &(name, mutate, expected) in cases {
            let mut world = joint_world(lanes);
            mutate(&mut world);
            let before = state(&world);
            assert_eq!(solver::solve(&mut world, DT), Err(expected), "{name}, lanes={lanes}");
            assert_eq!(state(&world), before, "{name}, lanes={lanes}");
        }
        let mut world = joint_world(lanes);
        world.joints[0].def.kind = JointKind::Revolute { limits: None, motor: Some(Motor::velocity(0.0, 1.0)) };
        solver::solve(&mut world, DT).unwrap();
    }
}

#[test]
fn public_solver_preserves_entry_specific_dt_policy_and_preflight_order() {
    for dt in [0.0, -0.0, -1.0] {
        let mut world = touching_world(false);
        let before = state(&world);
        assert_eq!(world.step(dt), Ok(()));
        assert_eq!(state(&world), before);
        assert_eq!(solver::solve(&mut world, dt), Err(PhysicsError::ArithmeticOverflow));
        assert_eq!(state(&world), before);
        world.contacts[0].manifold.count = 3;
        assert_eq!(world.step(dt), Err(PhysicsError::InvalidParameter));
        assert_eq!(solver::solve(&mut world, dt), Err(PhysicsError::InvalidParameter));
    }
    for dt in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut world = touching_world(false);
        world.contacts[0].manifold.count = 3;
        assert_eq!(world.step(dt), Err(PhysicsError::NotFinite));
        assert_eq!(solver::solve(&mut world, dt), Err(PhysicsError::NotFinite));
    }
    for mutate in [
        (|w: &mut World| w.settings.contact_max_push = -1.0) as fn(&mut World),
        |w: &mut World| w.settings.joint_max_push = -1.0,
    ] {
        let mut world = touching_world(false);
        mutate(&mut world);
        world.contacts[0].a = u32::MAX;
        assert_eq!(solver::solve(&mut world, DT), Err(PhysicsError::InvalidParameter));
    }
}

#[test]
fn public_solver_can_recover_after_repaired_input_without_partial_solve() {
    for lanes in [false, true] {
        let mut repaired = touching_world(lanes);
        let mut control = touching_world(lanes);
        repaired.contacts[0].manifold.count = 3;
        assert_eq!(solver::solve(&mut repaired, DT), Err(PhysicsError::InvalidParameter));
        repaired.contacts[0].manifold.count = 2;
        repaired.bodies[1].shapes.push(1);
        assert_eq!(solver::solve(&mut repaired, DT), Err(PhysicsError::InvalidHandle));
        repaired.bodies[1].shapes.pop();
        for _ in 0..4 {
            solver::solve(&mut repaired, DT).unwrap();
            solver::solve(&mut control, DT).unwrap();
            assert_eq!(state(&repaired), state(&control), "lanes={lanes}");
        }
    }
}

fn body_bits(body: &Body) -> Vec<u64> {
    [body.xf.p.x, body.xf.p.y, body.xf.q.c, body.xf.q.s,
        body.center.x, body.center.y, body.local_center.x, body.local_center.y,
        body.linear_velocity.x, body.linear_velocity.y, body.angular_velocity,
        body.sleep_time].into_iter().map(|x| x.to_bits() as u64)
        .chain(body.exact_center.map(f64::to_bits)).collect()
}

fn free_world(lanes: bool) -> World {
    let mut world = World::new(Settings { sleep: false, contact_lanes: lanes, ..Default::default() });
    for x in [-4.0, 4.0] {
        let body = world.create_body(&BodyDef {
            position: v2(x, 3.0), linear_velocity: v2(0.125, -0.25), angular_velocity: 0.5,
            linear_damping: 0.1, angular_damping: 0.2, can_sleep: false, ..Default::default()
        }).unwrap();
        world.create_shape(body, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    }
    world
}

#[test]
fn valid_public_solve_matches_world_integration_without_contact_refresh_or_sleep() {
    // Direct solve consumes the current contact list; World::step additionally refreshes it and manages sleep.
    // Separated, sleepless bodies isolate the common solver while retaining nonzero gravity, rotation and damping.
    for lanes in [false, true] {
        let mut direct = free_world(lanes);
        let mut stepped = free_world(lanes);
        for _ in 0..12 {
            solver::solve(&mut direct, DT).unwrap();
            stepped.step(DT).unwrap();
            for (a, b) in direct.bodies.iter().zip(&stepped.bodies) {
                assert_eq!(body_bits(a), body_bits(b), "lanes={lanes}");
            }
            assert!(stepped.contacts.is_empty());
        }
    }
}

#[test]
fn public_solver_reports_finite_input_integration_overflow() {
    for lanes in [false, true] {
        for direct in [false, true] {
            let mut world = World::new(Settings {
                gravity: v2(0.0, f32::MAX), sleep: false, contact_lanes: lanes, ..Default::default()
            });
            world.create_body(&BodyDef::default()).unwrap();
            let result = if direct { solver::solve(&mut world, 4.0) } else { world.step(4.0) };
            assert_eq!(result, Err(PhysicsError::ArithmeticOverflow), "direct={direct}, lanes={lanes}");
        }
    }
}
