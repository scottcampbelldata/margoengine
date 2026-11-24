// Removing shapes, bodies and joints: what they leave behind in the broad phase, the contacts and the events, and that
// slots are reused and a churning world stays deterministic.
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::query::QueryFilter;
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, EVENT_COLLISION, EventKind, Kind, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn floor(world: &mut World) -> (u32, u32) {
    let body = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let shape = world
        .create_shape(body, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef { events: EVENT_COLLISION, ..Default::default() })
        .unwrap();
    (body, shape)
}

fn ball(world: &mut World, x: f32, y: f32) -> (u32, u32) {
    let body = world.create_body(&BodyDef { position: v2(x, y), ..Default::default() }).unwrap();
    let shape = world.create_shape(body, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef { events: EVENT_COLLISION, ..Default::default() }).unwrap();
    (body, shape)
}

#[test]
fn removing_the_floor_wakes_a_sleeping_ball_and_it_falls() {
    let mut world = World::default();
    let (_, floor_shape) = floor(&mut world);
    let (ball_body, _) = ball(&mut world, 0.0, 1.0);
    for _ in 0..240 {
        world.step(DT).unwrap();
    }
    assert!(!world.bodies[ball_body as usize].awake, "the ball sleeps on the floor");
    world.remove_shape(floor_shape).unwrap();
    let mut stopped = 0;
    for step in 0..120 {
        world.step(DT).unwrap();
        if step == 0 {
            assert!(world.bodies[ball_body as usize].awake);
        }
        stopped += world.events.iter().filter(|e| e.kind == EventKind::Stopped).count();
    }
    assert_eq!(stopped, 1);
    assert!(world.bodies[ball_body as usize].xf.p.y < -3.0);
    assert!(world.remove_shape(floor_shape).is_err(), "a removed shape is gone");
}

#[test]
fn a_removed_shape_leaves_the_queries_and_its_body_loses_the_mass() {
    let mut world = World::default();
    let body = world.create_body(&BodyDef::default()).unwrap();
    let a = world.create_shape(body, Core::circle(v2(-1.0, 0.0), 0.5).unwrap(), &ShapeDef::default()).unwrap();
    let b = world.create_shape(body, Core::circle(v2(1.0, 0.0), 0.5).unwrap(), &ShapeDef::default()).unwrap();
    let both = world.bodies[body as usize].mass;
    assert!(world.point_query(v2(-1.0, 0.0), &QueryFilter::default()).unwrap() == [a]);
    world.remove_shape(a).unwrap();
    assert!(world.point_query(v2(-1.0, 0.0), &QueryFilter::default()).unwrap().is_empty());
    assert!((world.bodies[body as usize].mass - both / 2.0).abs() < 1e-4);
    assert!((world.bodies[body as usize].local_center.x - 1.0).abs() < 1e-5);
    // The freed slot is the next shape's.
    let c = world.create_shape(body, Core::circle(v2(0.0, 3.0), 0.5).unwrap(), &ShapeDef::default()).unwrap();
    assert_eq!(c, a);
    assert_ne!(c, b);
    world.step(DT).unwrap();
}

#[test]
fn removing_a_body_takes_its_shapes_and_joints_and_frees_the_slot() {
    let mut world = World::default();
    let anchor = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let (b1, s1) = ball(&mut world, 0.0, -2.0);
    let (b2, _) = ball(&mut world, 0.0, -4.0);
    let j1 = world.create_joint(&JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a: anchor, b: b1, anchor_a: v2(0.0, 0.0), anchor_b: v2(0.0, 2.0), collide: false }).unwrap();
    let j2 = world.create_joint(&JointDef { kind: JointKind::Rope { length: 2.0 }, a: b1, b: b2, anchor_a: V2::ZERO, anchor_b: V2::ZERO, collide: false }).unwrap();
    let j3 = world.create_joint(&JointDef { kind: JointKind::Rope { length: 3.0 }, a: anchor, b: b2, anchor_a: V2::ZERO, anchor_b: V2::ZERO, collide: false }).unwrap();
    world.remove_body(b1).unwrap();
    assert!(world.shapes[s1 as usize].dead);
    assert!(world.joint_index(j1).is_none() && world.joint_index(j2).is_none());
    let index = world.joint_index(j3).unwrap();
    assert_eq!(world.joints[index].def.b, b2, "the surviving joint is still its own");
    world.step(DT).unwrap();
    let (reused, _) = ball(&mut world, 5.0, 5.0);
    assert_eq!(reused, b1, "the slot is reused");
    assert!(world.remove_body(anchor).is_ok());
    assert!(world.remove_body(anchor).is_err());
    assert!(world.create_shape(anchor, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef::default()).is_err());
    for _ in 0..30 {
        world.step(DT).unwrap();
    }
}

#[test]
fn a_world_that_adds_and_removes_every_step_stays_deterministic() {
    let run = || {
        let mut world = World::default();
        floor(&mut world);
        let mut live: Vec<u32> = Vec::new();
        let mut log = Vec::new();
        for step in 0..300u32 {
            if step % 3 == 0 {
                live.push(ball(&mut world, (step % 7) as f32 * 0.9 - 3.0, 3.0 + (step % 5) as f32).0);
            }
            if step % 5 == 4 && !live.is_empty() {
                let victim = live.remove((step as usize * 7) % live.len());
                world.remove_body(victim).unwrap();
            }
            world.step(DT).unwrap();
            log.push(world.events.iter().map(|e| (e.kind == EventKind::Started, e.a, e.b)).collect::<Vec<_>>());
        }
        let bits: Vec<u32> = live.iter().flat_map(|&b| [world.bodies[b as usize].xf.p.x.to_bits(), world.bodies[b as usize].xf.p.y.to_bits()]).collect();
        (bits, log, world.bodies.len(), world.shapes.len())
    };
    let (a, b) = (run(), run());
    assert_eq!(a, b);
    // The slots stayed few: 100 balls were made but at most a handful lived at once.
    assert!(a.2 < 60, "bodies {}", a.2);
}
