// Collision groups, sensors, active collision types, solver groups and the events of a step: the pairs that began or
// stopped touching and the contacts that pushed past a force threshold.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{
    ACTIVE_ALL, ACTIVE_KINEMATIC_FIXED, BodyDef, EVENT_COLLISION, EVENT_CONTACT_FORCE, EventKind, Kind, ShapeDef, World,
    groups_meet,
};

const DT: f32 = 1.0 / 60.0;

fn floor(world: &mut World, def: &ShapeDef) -> u32 {
    let body = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    world.create_shape(body, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), def).unwrap();
    body
}

fn ball(world: &mut World, y: f32, def: &ShapeDef) -> (u32, u32) {
    let body = world.create_body(&BodyDef { position: v2(0.0, y), ..Default::default() }).unwrap();
    let shape = world.create_shape(body, Core::circle(V2::ZERO, 0.5).unwrap(), def).unwrap();
    (body, shape)
}

fn run(world: &mut World, steps: usize) -> Vec<(usize, EventKind, u32, u32, bool)> {
    let mut log = Vec::new();
    for step in 0..steps {
        world.step(DT).unwrap();
        for e in &world.events {
            log.push((step, e.kind, e.a, e.b, e.sensor));
        }
    }
    log
}

#[test]
fn groups_meet_needs_both_directions() {
    assert!(groups_meet(0x0001_0001, 0x0001_0001));
    assert!(!groups_meet(0x0001_0002, 0x0001_0002));
    // A is in group 0 and looks at group 1; B is in group 1 but looks at group 1 only.
    assert!(!groups_meet(0x0001_0002, 0x0002_0002));
    assert!(groups_meet(0x0001_0002, 0x0002_0001));
    assert!(groups_meet(u32::MAX, u32::MAX));
}

#[test]
fn collision_groups_let_a_ball_fall_through_a_floor_it_ignores() {
    let mut world = World::default();
    floor(&mut world, &ShapeDef { groups: 0x0001_0001, ..Default::default() });
    let (b, _) = ball(&mut world, 3.0, &ShapeDef { groups: 0x0002_0002, ..Default::default() });
    run(&mut world, 120);
    assert!(world.bodies[b as usize].xf.p.y < -2.0, "fell through to {}", world.bodies[b as usize].xf.p.y);
    let mut world = World::default();
    floor(&mut world, &ShapeDef::default());
    let (b, _) = ball(&mut world, 3.0, &ShapeDef::default());
    run(&mut world, 120);
    assert!((world.bodies[b as usize].xf.p.y - 0.5).abs() < 0.05);
}

#[test]
fn contact_events_start_once_and_stop_once() {
    let mut world = World::default();
    let events = ShapeDef { events: EVENT_COLLISION, ..Default::default() };
    floor(&mut world, &ShapeDef::default());
    let (b, shape) = ball(&mut world, 1.5, &events);
    let log = run(&mut world, 60);
    let started: Vec<_> = log.iter().filter(|e| e.1 == EventKind::Started).collect();
    assert_eq!(started.len(), 1, "{log:?}");
    assert!(!started[0].4);
    assert!(started[0].2 == 0 && started[0].3 == shape || started[0].2 == shape);
    assert!(!log.iter().any(|e| e.1 == EventKind::Stopped));
    // Throw it up: the contact ends once.
    world.bodies[b as usize].linear_velocity = v2(0.0, 8.0);
    world.wake(b).unwrap();
    let log = run(&mut world, 30);
    assert_eq!(log.iter().filter(|e| e.1 == EventKind::Stopped).count(), 1, "{log:?}");
}

#[test]
fn no_events_unless_a_shape_asks_for_them() {
    let mut world = World::default();
    floor(&mut world, &ShapeDef::default());
    ball(&mut world, 1.5, &ShapeDef::default());
    assert!(run(&mut world, 60).is_empty());
}

#[test]
fn a_sensor_reports_an_overlap_and_pushes_nothing() {
    let mut world = World::default();
    let zone = world.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, 0.0), ..Default::default() }).unwrap();
    world
        .create_shape(zone, Core::rect(2.0, 1.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { sensor: true, events: EVENT_COLLISION, ..Default::default() })
        .unwrap();
    let (b, _) = ball(&mut world, 4.0, &ShapeDef::default());
    let log = run(&mut world, 120);
    let started = log.iter().filter(|e| e.1 == EventKind::Started).count();
    let stopped = log.iter().filter(|e| e.1 == EventKind::Stopped).count();
    assert_eq!((started, stopped), (1, 1), "{log:?}");
    assert!(log.iter().all(|e| e.4));
    assert!(world.bodies[b as usize].xf.p.y < -3.0, "the ball fell straight through the sensor");
}

#[test]
fn a_moving_kinematic_sensor_sees_a_fixed_body_only_with_all_active_types() {
    for (types, seen) in [(ShapeDef::default().active_types, false), (ACTIVE_KINEMATIC_FIXED | ACTIVE_ALL, true)] {
        let mut world = World::default();
        let wall = world.create_body(&BodyDef { kind: Kind::Static, position: v2(3.0, 0.0), ..Default::default() }).unwrap();
        world.create_shape(wall, Core::rect(0.5, 2.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { active_types: types, ..Default::default() }).unwrap();
        let k = world.create_body(&BodyDef { kind: Kind::Kinematic, linear_velocity: v2(2.0, 0.0), ..Default::default() }).unwrap();
        world
            .create_shape(k, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef { sensor: true, events: EVENT_COLLISION, active_types: types, ..Default::default() })
            .unwrap();
        let log = run(&mut world, 120);
        assert_eq!(log.iter().any(|e| e.1 == EventKind::Started), seen, "{types} {log:?}");
    }
}

#[test]
fn solver_groups_that_do_not_meet_report_contact_but_push_nothing() {
    let mut world = World::default();
    floor(&mut world, &ShapeDef { solver_groups: 0x0001_0001, ..Default::default() });
    let (b, _) = ball(&mut world, 2.0, &ShapeDef { solver_groups: 0x0002_0002, events: EVENT_COLLISION, ..Default::default() });
    let log = run(&mut world, 90);
    assert!(log.iter().any(|e| e.1 == EventKind::Started && !e.4), "{log:?}");
    assert!(world.bodies[b as usize].xf.p.y < -0.5, "it should sink through: {}", world.bodies[b as usize].xf.p.y);
}

#[test]
fn contact_force_events_fire_above_the_threshold() {
    let mut world = World::default();
    floor(&mut world, &ShapeDef::default());
    ball(&mut world, 1.0, &ShapeDef { events: EVENT_CONTACT_FORCE, force_threshold: 20.0, ..Default::default() });
    let mut peak = 0.0f32;
    for _ in 0..90 {
        world.step(DT).unwrap();
        for e in &world.force_events {
            peak = peak.max(e.force);
            assert!(e.force > 20.0 && e.normal.length() > 0.99);
        }
    }
    assert!(peak > 20.0, "the landing pushes hard: {peak}");
    // At rest the force is the ball's weight, well under the threshold.
    world.step(DT).unwrap();
    assert!(world.force_events.is_empty());
}

#[test]
fn two_worlds_built_alike_report_alike() {
    let build = || {
        let mut world = World::default();
        floor(&mut world, &ShapeDef { events: EVENT_COLLISION, ..Default::default() });
        for i in 0..6 {
            ball(&mut world, 1.0 + i as f32 * 1.2, &ShapeDef { events: EVENT_COLLISION, ..Default::default() });
        }
        run(&mut world, 200)
    };
    assert_eq!(build(), build());
}
