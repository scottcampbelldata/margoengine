// A body taken out of the simulation: it keeps its pose and velocity, moves and wakes nothing, touches nothing, is found by no
// query, and its joints rest; put back, it goes on with the velocity it had.
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::query::QueryFilter;
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn world() -> World {
    World::new(Settings { gravity: v2(0.0, -10.0), ..Default::default() })
}

fn ball(w: &mut World, at: V2, kind: Kind) -> u32 {
    let b = w.create_body(&BodyDef { kind, position: at, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef { density: 1.0, ..Default::default() }).unwrap();
    b
}

#[test]
fn a_disabled_body_keeps_its_pose_and_velocity_and_resumes_when_enabled() {
    let mut w = world();
    let b = ball(&mut w, v2(0.0, 10.0), Kind::Dynamic);
    w.bodies[b as usize].linear_velocity = v2(2.0, 0.0);
    w.set_body_enabled(b, false).unwrap();
    for _ in 0..30 {
        w.step(DT).unwrap();
    }
    let body = &w.bodies[b as usize];
    assert_eq!((body.xf.p.x, body.xf.p.y), (0.0, 10.0), "it did not fall or drift");
    assert_eq!((body.linear_velocity.x, body.linear_velocity.y), (2.0, 0.0), "and its velocity is as it was");
    w.set_body_enabled(b, true).unwrap();
    w.step(DT).unwrap();
    assert!(w.bodies[b as usize].xf.p.x > 0.03, "enabled, it moves on at 2 m/s: {}", w.bodies[b as usize].xf.p.x);
}

#[test]
fn nothing_touches_a_disabled_body_and_no_query_finds_it() {
    let mut w = world();
    let floor = ball(&mut w, v2(0.0, 0.0), Kind::Static);
    let dropped = ball(&mut w, v2(0.0, 3.0), Kind::Dynamic);
    w.set_body_enabled(floor, false).unwrap();
    for _ in 0..90 {
        w.step(DT).unwrap();
    }
    assert!(w.bodies[dropped as usize].xf.p.y < -1.0, "a ball falls through a disabled one: {}", w.bodies[dropped as usize].xf.p.y);
    let hits = w.ray_cast_all(v2(-5.0, 0.0), v2(1.0, 0.0), 10.0, true, &QueryFilter::default()).unwrap();
    assert!(hits.is_empty(), "no ray meets it");
    w.set_body_enabled(floor, true).unwrap();
    let hits = w.ray_cast_all(v2(-5.0, 0.0), v2(1.0, 0.0), 10.0, true, &QueryFilter::default()).unwrap();
    assert_eq!(hits.len(), 1, "enabled, the ray meets it again");
}

#[test]
fn a_joint_to_a_disabled_body_rests() {
    let mut w = world();
    let anchor = ball(&mut w, v2(0.0, 5.0), Kind::Static);
    let swing = ball(&mut w, v2(1.5, 5.0), Kind::Dynamic);
    let joint = JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a: anchor, b: swing, anchor_a: v2(0.0, 0.0), anchor_b: v2(-1.5, 0.0), collide: false };
    w.create_joint(&joint).unwrap();
    w.set_body_enabled(anchor, false).unwrap();
    for _ in 0..60 {
        w.step(DT).unwrap();
    }
    // Held by the hinge it would have swung down on a circle of 1.5 m; with the joint at rest it falls straight: 5 m/s^2 * 1 s^2.
    let p = w.bodies[swing as usize].xf.p;
    assert!((p.x - 1.5).abs() < 1e-4 && p.y < 5.0 - 4.0, "it falls free: {} {}", p.x, p.y);
}
