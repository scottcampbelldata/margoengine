// Generic joints: any mix of the x lock, the y lock and the angle lock of a plane joint, in a frame the joint carries.
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{Rot, V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn rig(kind: JointKind, velocity: V2, spin: f32) -> (World, u32) {
    let mut w = World::default();
    let anchor = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, 5.0), ..Default::default() }).unwrap();
    let body = w.create_body(&BodyDef { position: v2(0.0, 5.0), linear_velocity: velocity, angular_velocity: spin, can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(body, Core::rect(0.5, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { friction: 0.0, ..Default::default() }).unwrap();
    w.create_joint(&JointDef { kind, a: anchor, b: body, anchor_a: V2::ZERO, anchor_b: V2::ZERO, collide: false }).unwrap();
    (w, body)
}

fn run(w: &mut World, steps: usize) {
    for _ in 0..steps {
        w.step(DT).unwrap();
    }
}

const ID: Rot = Rot::IDENTITY;

#[test]
fn locking_only_y_is_a_pin_slot_along_x() {
    let (mut w, b) = rig(JointKind::Generic { lock_x: false, lock_y: true, lock_angle: false, frame_a: ID, frame_b: ID }, v2(3.0, 0.0), 2.0);
    run(&mut w, 120);
    let body = &w.bodies[b as usize];
    assert!((body.xf.p.y - 5.0).abs() < 0.005, "held on its slot: y {}", body.xf.p.y);
    assert!(body.xf.p.x > 5.0, "slides along it: x {}", body.xf.p.x);
    assert!(w.angle(b).unwrap().abs() > 0.5 || body.angular_velocity.abs() > 0.5, "and turns freely");
}

#[test]
fn locking_only_x_is_a_slot_along_y_and_a_frame_turns_the_axis() {
    let (mut w, b) = rig(JointKind::Generic { lock_x: true, lock_y: false, lock_angle: false, frame_a: ID, frame_b: ID }, V2::ZERO, 0.0);
    run(&mut w, 120);
    let body = &w.bodies[b as usize];
    assert!(body.xf.p.x.abs() < 0.005, "x held: {}", body.xf.p.x);
    assert!(body.xf.p.y < 0.0, "falls along the slot: y {}", body.xf.p.y);
    // The same x lock in a frame turned a quarter turn holds y instead and lets x slide.
    let quarter = Rot::from_pair(0.0, 1.0);
    let (mut w, b) = rig(JointKind::Generic { lock_x: true, lock_y: false, lock_angle: false, frame_a: quarter, frame_b: ID }, v2(2.0, 0.0), 0.0);
    run(&mut w, 60);
    let body = &w.bodies[b as usize];
    assert!((body.xf.p.y - 5.0).abs() < 0.005 && body.xf.p.x > 1.0, "{:?}", body.xf.p);
}

#[test]
fn locking_x_and_y_is_a_pin_and_adding_the_angle_is_a_weld() {
    let (mut w, b) = rig(JointKind::Generic { lock_x: true, lock_y: true, lock_angle: false, frame_a: ID, frame_b: ID }, V2::ZERO, 3.0);
    run(&mut w, 120);
    assert!((w.bodies[b as usize].xf.p.sub(v2(0.0, 5.0))).length() < 0.005, "pinned in place");
    assert!(w.bodies[b as usize].angular_velocity.abs() > 1.0, "and spinning");
    let (mut w, b) = rig(JointKind::Generic { lock_x: true, lock_y: true, lock_angle: true, frame_a: ID, frame_b: ID }, V2::ZERO, 3.0);
    run(&mut w, 120);
    assert!(w.angle(b).unwrap().abs() < 0.01, "welded: angle {}", w.angle(b).unwrap());
    assert!((w.bodies[b as usize].xf.p.sub(v2(0.0, 5.0))).length() < 0.005);
}

#[test]
fn locking_only_the_angle_holds_the_turn_and_lets_the_body_fall() {
    let (mut w, b) = rig(JointKind::Generic { lock_x: false, lock_y: false, lock_angle: true, frame_a: ID, frame_b: ID }, V2::ZERO, 4.0);
    run(&mut w, 90);
    assert!(w.angle(b).unwrap().abs() < 0.01, "angle {}", w.angle(b).unwrap());
    assert!(w.bodies[b as usize].xf.p.y < 0.0, "free to fall");
}

#[test]
fn a_snapshot_keeps_a_generic_joint() {
    let (w, _) = rig(JointKind::Generic { lock_x: true, lock_y: false, lock_angle: true, frame_a: Rot::from_pair(0.0, 1.0), frame_b: ID }, V2::ZERO, 0.0);
    let r = World::from_snapshot(&w.snapshot()).unwrap();
    assert_eq!(format!("{:?}", r.joints[0].def.kind), format!("{:?}", w.joints[0].def.kind));
}
