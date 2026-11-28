// A body removed between two steps leaves its colliders' pairs for the next step to drop, and those pairs name no body on its
// side. Every call that walks the pairs of the collider it touched must pass them by (KB-PHYS-RETIREDPAIR1): waking row NONE
// read and wrote past the body rows, an access violation natively and a write to the word before the column in Wasm.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{World, NONE};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn block(w: &mut World, at: V3) -> (u32, u32) {
    let body = w.add_body(DYNAMIC).unwrap();
    let collider = w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    (body, collider)
}

/// Two boxes resting on each other and a third on the pile, stepped until they touch; returns the world, the bodies and the
/// middle box's collider.
fn pile() -> (World, [u32; 3], u32) {
    let mut w = World::new(8, 8).unwrap();
    w.header_mut().gravity = [0.0, -9.81, 0.0];
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [5.0, 0.5, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, floor as usize, v3(0.0, -0.5, 0.0));
    let (low, _) = block(&mut w, v3(0.0, 0.5, 0.0));
    let (middle, collider) = block(&mut w, v3(0.0, 1.5, 0.0));
    let (high, _) = block(&mut w, v3(0.0, 2.5, 0.0));
    for _ in 0..30 {
        w.step(DT);
    }
    let touching = (0..w.header().solving as usize).filter(|&i| {
        let (a, b) = w.pair_bodies(w.uu(SOLVE_PAIRS, i));
        a == middle as usize || b == middle as usize
    });
    assert_eq!(touching.count(), 2, "the middle box touches the one under it and the one on it");
    (w, [low, middle, high], collider)
}

fn finite(w: &World, body: u32) -> bool {
    let (p, v) = (w.v(POSITION_X, body as usize), w.v(LINEAR_X, body as usize));
    [p.x, p.y, p.z, v.x, v.y, v.z].iter().all(|x| x.is_finite())
}

#[test]
fn a_collider_is_touched_after_the_body_it_rested_on_was_removed() {
    let (mut w, [low, middle, high], collider) = pile();
    assert!(w.remove_body(low));
    // The pair with the removed box is still on the middle box's list, naming no body on that side.
    let mut pair = w.uu(COLLIDER_PAIRS, collider as usize);
    let mut retired = 0;
    while pair != NONE {
        let (a, b) = w.pair_bodies(pair);
        retired += (a == NONE as usize || b == NONE as usize) as u32;
        pair = w.next_pair(pair, collider);
    }
    assert_eq!(retired, 1, "one pair of the middle box waits for the step to drop it");
    w.touch_collider(collider);
    w.wake_touching_pairs(collider);
    for _ in 0..60 {
        w.step(DT);
    }
    assert!(w.body_alive(middle) && w.body_alive(high) && finite(&w, middle) && finite(&w, high));
    // With the box under it gone the middle box fell onto the floor and the top one came with it.
    let (y, top) = (w.v(POSITION_X, middle as usize).y, w.v(POSITION_X, high as usize).y);
    assert!((y - 0.5).abs() < 0.02 && (top - 1.5).abs() < 0.02, "middle at {y}, top at {top}");
}

#[test]
fn a_collider_changes_kind_and_its_body_leaves_and_returns_after_a_neighbour_was_removed() {
    let (mut w, [low, middle, high], collider) = pile();
    assert!(w.remove_body(low));
    // A sensor and back: the touches of the collider end, the removed neighbour's among them.
    w.set_collider_state(collider, 1);
    w.set_collider_state(collider, 0);
    w.set_body_enabled(middle, false);
    w.set_body_enabled(middle, true);
    for _ in 0..60 {
        w.step(DT);
    }
    assert!(w.body_alive(middle) && w.body_alive(high) && finite(&w, middle) && finite(&w, high));
    let (y, top) = (w.v(POSITION_X, middle as usize).y, w.v(POSITION_X, high as usize).y);
    assert!((y - 0.5).abs() < 0.02 && (top - 1.5).abs() < 0.02, "middle at {y}, top at {top}");
}
