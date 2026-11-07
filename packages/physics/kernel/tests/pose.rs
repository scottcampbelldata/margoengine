// Poses and targets written by hand, and how they meet sleep and the broad phase.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const ONE: Q = Q { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };
const DT: f32 = 1.0 / 60.0;

fn ball(w: &mut World, kind: u32, offset: [f32; 3]) -> u32 {
    let body = w.add_body(kind).unwrap();
    w.add_collider(body, SHAPE_BALL, [0.5, 0.0, 0.0], offset, IDENTITY, 1.0).unwrap();
    body
}
fn free_world() -> World {
    let mut w = World::new(8, 8).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    w
}
fn asleep(w: &World, body: u32) -> bool {
    w.flags(body as usize) & SLEEPING != 0
}

#[test]
fn a_pose_is_normalised_and_holds_every_column_that_starts_a_step() {
    let mut w = free_world();
    let body = ball(&mut w, DYNAMIC, [0.0, 1.0, 0.0]);
    let at = body as usize;
    w.set_pose(body, v3(1.0, 2.0, 3.0), Q { x: 0.0, y: 0.0, z: 3.0, w: 4.0 }, true);
    let rotation = w.q(ROTATION_X, at);
    assert_eq!((rotation.z, rotation.w), (0.6, 0.8));
    for (x, r) in [(PREVIOUS_X, PREVIOUS_ROTATION_X), (TARGET_X, TARGET_ROTATION_X)] {
        assert_eq!(w.v(x, at), w.v(POSITION_X, at));
        assert_eq!(w.q(r, at), rotation);
    }
    let center = w.v(CENTER_X, at);
    let expected = v3(1.0, 2.0, 3.0).add(rotation.rotate(w.v(LOCAL_CENTER_X, at)));
    assert_eq!(center, expected);
}

#[test]
fn a_dead_row_takes_no_pose_and_no_target() {
    let mut w = free_world();
    let body = ball(&mut w, DYNAMIC, [0.0; 3]);
    w.remove_body(body);
    w.set_pose(body, v3(1.0, 0.0, 0.0), ONE, true);
    w.set_target(body, v3(1.0, 0.0, 0.0), ONE);
    assert_eq!(w.s(POSITION_X, body as usize), 0.0);
    assert_eq!(w.s(TARGET_X, body as usize), 0.0);
    w.set_pose(99, v3(1.0, 0.0, 0.0), ONE, true);
}

#[test]
fn a_kinematic_body_stays_where_a_pose_put_it_until_it_has_a_target() {
    let mut w = free_world();
    let body = ball(&mut w, KINEMATIC_POSITION, [0.0; 3]);
    let at = body as usize;
    w.set_pose(body, v3(5.0, 0.0, 0.0), ONE, true);
    w.step(DT);
    assert_eq!(w.v(POSITION_X, at), v3(5.0, 0.0, 0.0));
    assert_eq!(w.v(LINEAR_X, at), v3(0.0, 0.0, 0.0));
    w.set_target(body, v3(6.0, 0.0, 0.0), Q { x: 0.0, y: 0.0, z: 0.0, w: 2.0 });
    w.step(DT);
    assert_eq!(w.v(POSITION_X, at), v3(6.0, 0.0, 0.0));
    assert_eq!(w.q(ROTATION_X, at), ONE);
}

#[test]
fn a_sleeper_moved_without_waking_keeps_sleeping_and_is_found_at_its_new_place() {
    let mut w = free_world();
    let sleeper = ball(&mut w, DYNAMIC, [0.0, 1.0, 0.0]);
    w.request_sleep(sleeper);
    w.step(DT);
    assert!(asleep(&w, sleeper));
    let other = ball(&mut w, FIXED, [0.0; 3]);
    w.set_pose(other, v3(50.0, 0.0, 0.0), ONE, true);
    w.step(DT);
    assert_eq!(w.header().pairs, 0);
    w.set_pose(sleeper, v3(50.0, 0.0, 0.0), ONE, false);
    w.step(DT);
    assert!(asleep(&w, sleeper));
    assert_eq!(w.header().pairs, 1);
}

#[test]
fn a_body_that_wakes_a_moved_sleeper_inside_a_step_finds_it_at_its_new_place() {
    // Waking from a touch happens after the step has found its centres of mass, so the sleeper's must already be right.
    let mut w = free_world();
    let sleeper = ball(&mut w, DYNAMIC, [0.0, 1.0, 0.0]);
    w.request_sleep(sleeper);
    w.step(DT);
    w.set_pose(sleeper, v3(50.0, 0.0, 0.0), ONE, false);
    let moving = ball(&mut w, DYNAMIC, [0.0; 3]);
    w.set_pose(moving, v3(50.0, 0.5, 0.0), ONE, true);
    w.set_v(LINEAR_X, moving as usize, v3(0.0, 0.25, 0.0));
    w.step(DT);
    assert!(!asleep(&w, sleeper));
    // The overlap now pushes it a little down; before contacts it stayed put. Its old place, far off, is what must not return.
    let at = w.v(POSITION_X, sleeper as usize);
    assert!(at.x == 50.0 && at.z == 0.0 && at.y.abs() < 0.1, "{at:?}");
}
