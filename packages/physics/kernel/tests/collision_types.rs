// Which kinds of body pair a collider takes part in (ActiveCollisionTypes): by default dynamic with anything, and nothing
// between two bodies that cannot move; a flipped bit adds or removes that kind of pair.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn body_with_box(w: &mut World, kind: u32, at: V3) -> (u32, u32) {
    let body = w.add_body(kind).unwrap();
    let collider = w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    (body, collider)
}

/// Whether the one pair of the world says it touches after a step.
fn touching(w: &mut World) -> bool {
    w.header_mut().gravity = [0.0; 3];
    w.step(DT);
    (0..w.header().pair_rows as usize).any(|row| w.uu(PAIR_FLAGS, row) & PAIR_TOUCHING != 0)
}

#[test]
fn two_kinematic_bodies_pass_through_each_other_by_default() {
    let mut w = World::new(4, 4).unwrap();
    body_with_box(&mut w, KINEMATIC_POSITION, v3(0.0, 0.0, 0.0));
    body_with_box(&mut w, KINEMATIC_POSITION, v3(0.5, 0.0, 0.0));
    assert!(!touching(&mut w));
}

#[test]
fn both_colliders_must_want_a_kind_of_pair_for_it_to_touch() {
    let mut w = World::new(4, 4).unwrap();
    let (_, a) = body_with_box(&mut w, KINEMATIC_POSITION, v3(0.0, 0.0, 0.0));
    let (_, b) = body_with_box(&mut w, KINEMATIC_POSITION, v3(0.5, 0.0, 0.0));
    // Kinematic with kinematic is the fourth bit.
    w.set_collider_state(a, 8 << COLLIDER_TYPES_SHIFT);
    assert!(!touching(&mut w), "only one side wants it");
    w.set_collider_state(b, 8 << COLLIDER_TYPES_SHIFT);
    assert!(touching(&mut w), "both want it");
}

#[test]
fn two_fixed_bodies_touch_once_both_colliders_want_it() {
    let mut w = World::new(4, 4).unwrap();
    let (_, a) = body_with_box(&mut w, FIXED, v3(0.0, 0.0, 0.0));
    let (_, b) = body_with_box(&mut w, FIXED, v3(0.5, 0.0, 0.0));
    w.set_collider_state(a, 32 << COLLIDER_TYPES_SHIFT);
    w.set_collider_state(b, 32 << COLLIDER_TYPES_SHIFT);
    assert!(touching(&mut w));
}

#[test]
fn dropping_the_dynamic_with_fixed_bit_lets_a_box_fall_through_the_floor() {
    let mut w = World::new(4, 4).unwrap();
    let (_, floor) = body_with_box(&mut w, FIXED, v3(0.0, 0.0, 0.0));
    let (falling, _) = body_with_box(&mut w, DYNAMIC, v3(0.0, 0.9, 0.0));
    w.set_collider_state(floor, 4 << COLLIDER_TYPES_SHIFT); // flips dynamic with fixed off
    assert!(!touching(&mut w));
    let _ = falling;
}
