// The broad phase against brute force: every step of random moving scenes, every pair the boxes say and no other.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};
use std::collections::BTreeSet;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

struct Random(u32);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    /// A float in [low, high).
    fn range(&mut self, low: f32, high: f32) -> f32 {
        low + (high - low) * (self.next() >> 8) as f32 / 16_777_216.0
    }
}

/// Every invariant the broad phase promises: sorted lists, true ranks, and exactly the pairs of the boxes in the lists.
fn check(w: &World) {
    let header = w.header();
    let in_broad: Vec<usize> =
        (0..header.collider_rows as usize).filter(|&c| w.uu(COLLIDER_STATE, c) & IN_BROAD != 0).collect();
    assert_eq!(header.endpoints as usize, in_broad.len() * 2);
    for axis in 0..3 {
        for at in 0..header.endpoints as usize {
            let id = w.uu(ENDPOINT_ID_X + axis, at);
            let c = (id >> 1) as usize;
            assert_eq!(w.uu(RANK_MIN_X + axis + 3 * (id & 1) as usize, c), at as u32, "rank of end {id}, axis {axis}");
            assert_eq!(w.s(ENDPOINT_VALUE_X + axis, at), w.s(FAT_MIN_X + axis + 3 * (id & 1) as usize, c));
            if at > 0 {
                let (before, before_id) = (w.s(ENDPOINT_VALUE_X + axis, at - 1), w.uu(ENDPOINT_ID_X + axis, at - 1));
                let value = w.s(ENDPOINT_VALUE_X + axis, at);
                assert!(before < value || (before == value && (before_id & 1 == 0 || id & 1 == 1)), "order at {at}, axis {axis}");
            }
        }
    }
    let mut expected = BTreeSet::new();
    for (i, &a) in in_broad.iter().enumerate() {
        for &b in &in_broad[i + 1..] {
            let (body_a, body_b) = (w.uu(COLLIDER_BODY, a) as usize, w.uu(COLLIDER_BODY, b) as usize);
            let fixed = w.flags(body_a) & KIND == FIXED && w.flags(body_b) & KIND == FIXED;
            if body_a != body_b && !fixed && w.boxes_overlap(a, b) {
                expected.insert((a as u32, b as u32));
            }
        }
    }
    let mut found = BTreeSet::new();
    for row in 0..header.pair_rows {
        let a = w.uu(PAIR_A, row as usize);
        if a != NONE {
            let b = w.uu(PAIR_B, row as usize);
            assert!(a < b);
            assert_eq!(w.find_pair(b, a), row);
            assert!(found.insert((a, b)), "pair {a} {b} twice");
        }
    }
    assert_eq!(found, expected);
    assert_eq!(header.pairs as usize, found.len());
    // Each collider's list holds exactly its pairs.
    let mut seen = 0;
    for &c in &in_broad {
        let mut row = w.uu(COLLIDER_PAIRS, c);
        let mut previous = NONE;
        while row != NONE {
            let at = row as usize;
            let side_a = w.uu(PAIR_A, at) == c as u32;
            assert!(side_a || w.uu(PAIR_B, at) == c as u32);
            assert_eq!(w.uu(if side_a { PAIR_PREVIOUS_A } else { PAIR_PREVIOUS_B }, at), previous);
            previous = row;
            row = w.next_pair(row, c as u32);
            seen += 1;
        }
    }
    assert_eq!(seen, found.len() * 2);
}

fn random_collider(w: &mut World, r: &mut Random, body: u32) -> u32 {
    let kind = r.next() % 3;
    let (shape, size) = match kind {
        0 => (SHAPE_BALL, [r.range(0.1, 0.6), 0.0, 0.0]),
        1 => (SHAPE_BOX, [r.range(0.1, 0.6), r.range(0.1, 0.6), r.range(0.1, 0.6)]),
        _ => (SHAPE_CAPSULE, [r.range(0.1, 0.4), r.range(0.1, 0.6), 0.0]),
    };
    let turn = Q::from_rotation_vector(v3(r.range(-2.0, 2.0), r.range(-2.0, 2.0), r.range(-2.0, 2.0)));
    let place = [r.range(-0.5, 0.5), r.range(-0.5, 0.5), r.range(-0.5, 0.5)];
    w.add_collider(body, shape, size, place, [turn.x, turn.y, turn.z, turn.w], 1.0).unwrap()
}

fn random_body(w: &mut World, r: &mut Random, kind: u32, size: f32) -> u32 {
    let body = w.add_body(kind).unwrap();
    let at = body as usize;
    w.set_v(POSITION_X, at, v3(r.range(-size, size), r.range(-size, size), r.range(-size, size)));
    w.set_v(LINEAR_X, at, v3(r.range(-8.0, 8.0), r.range(-8.0, 8.0), r.range(-8.0, 8.0)));
    w.set_v(ANGULAR_X, at, v3(r.range(-6.0, 6.0), r.range(-6.0, 6.0), r.range(-6.0, 6.0)));
    for _ in 0..1 + r.next() % 3 {
        random_collider(w, r, body);
    }
    body
}

/// Keeps a body inside a cube by turning it back, as a stand-in for contacts.
fn bounce(w: &mut World, at: usize, size: f32) {
    let (position, mut velocity) = (w.v(POSITION_X, at), w.v(LINEAR_X, at));
    if position.x.abs() > size {
        velocity.x = -position.x.signum() * velocity.x.abs();
    }
    if position.y.abs() > size {
        velocity.y = -position.y.signum() * velocity.y.abs();
    }
    if position.z.abs() > size {
        velocity.z = -position.z.signum() * velocity.z.abs();
    }
    w.set_v(LINEAR_X, at, velocity);
}

/// Bodies come and go while the rest move; returns a trace that any two equal runs must share.
fn churn(bodies: u32, colliders: u32, seed: u32, steps: u32, checked: bool) -> Vec<(u32, u32, u32)> {
    let mut w = World::new(bodies, colliders).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let mut r = Random(seed);
    let size = 6.0;
    let mut alive: Vec<u32> = vec![];
    for i in 0..60 {
        let kind = if i % 7 == 0 { FIXED } else { DYNAMIC };
        w.reserve(w.header().rows + 1, w.header().collider_rows + 4);
        alive.push(random_body(&mut w, &mut r, kind, size));
    }
    let mut trace = vec![];
    for step in 0..steps {
        for &body in &alive {
            bounce(&mut w, body as usize, size);
        }
        match r.next() % 8 {
            0 if alive.len() > 10 => {
                let body = alive.swap_remove((r.next() as usize) % alive.len());
                assert!(w.remove_body(body));
            }
            1 => {
                w.reserve(w.header().rows + 1, w.header().collider_rows + 4);
                let kind = if r.next() % 4 == 0 { KINEMATIC_VELOCITY } else { DYNAMIC };
                alive.push(random_body(&mut w, &mut r, kind, size));
            }
            2 => {
                // A batch at once takes the sort and sweep with many new ends.
                for _ in 0..8 {
                    w.reserve(w.header().rows + 1, w.header().collider_rows + 4);
                    alive.push(random_body(&mut w, &mut r, DYNAMIC, size));
                }
            }
            3 => {
                let body = alive[(r.next() as usize) % alive.len()] as usize;
                let collider = w.uu(FIRST_COLLIDER, body);
                if collider != NONE {
                    assert!(w.remove_collider(collider));
                }
            }
            4 => {
                // A teleport moves a body far in one step: the walk crosses most of each list.
                let body = alive[(r.next() as usize) % alive.len()];
                let at = body as usize;
                w.set_v(POSITION_X, at, v3(r.range(-size, size), r.range(-size, size), r.range(-size, size)));
                w.touch_body(body);
            }
            _ => {}
        }
        w.step(1.0 / 60.0);
        if checked {
            check(&w);
        }
        assert_eq!(w.header().failed, 0);
        trace.push((step, w.header().pairs, w.header().pair_rows));
    }
    trace
}

#[test]
fn the_pairs_are_what_brute_force_finds_on_every_step_of_random_scenes() {
    for seed in [1, 2, 3, 7, 12345] {
        let trace = churn(8, 8, seed, 300, true);
        assert!(trace.iter().any(|&(_, pairs, _)| pairs > 30), "the scene must be dense enough to prove anything: {:?}", trace.last());
    }
}

#[test]
fn results_do_not_depend_on_capacity() {
    assert_eq!(churn(1, 1, 99, 200, false), churn(4000, 9000, 99, 200, false));
}

#[test]
fn tight_boxes_that_overlap_are_always_a_pair() {
    // A ball's shape is its box, so overlap of the true shapes can be checked directly.
    let mut w = World::new(64, 64).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let mut r = Random(5);
    let mut balls = vec![];
    for _ in 0..64 {
        let body = w.add_body(DYNAMIC).unwrap();
        let radius = r.range(0.2, 0.5);
        w.add_collider(body, SHAPE_BALL, [radius, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
        w.set_v(POSITION_X, body as usize, v3(r.range(-4.0, 4.0), r.range(-4.0, 4.0), r.range(-4.0, 4.0)));
        w.set_v(LINEAR_X, body as usize, v3(r.range(-9.0, 9.0), r.range(-9.0, 9.0), r.range(-9.0, 9.0)));
        balls.push((body as usize, radius));
    }
    for _ in 0..240 {
        for &(body, _) in &balls {
            bounce(&mut w, body, 4.0);
        }
        w.step(1.0 / 60.0);
        for (i, &(a, radius_a)) in balls.iter().enumerate() {
            for &(b, radius_b) in &balls[i + 1..] {
                let d = w.v(POSITION_X, a).sub(w.v(POSITION_X, b));
                if d.dot(d) <= (radius_a + radius_b) * (radius_a + radius_b) {
                    assert_ne!(w.find_pair(a as u32, b as u32), NONE);
                }
            }
        }
    }
}

#[test]
fn the_box_reaches_as_far_as_the_step_goes() {
    // 100 m/s covers 1.67 m in a step: the wall must be a pair before the ball arrives, with no margin to help.
    let mut w = World::new(2, 2).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let wall = w.add_body(FIXED).unwrap();
    let wall_collider = w.add_collider(wall, SHAPE_BOX, [0.05, 5.0, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, wall as usize, v3(1.5, 0.0, 0.0));
    let ball = w.add_body(DYNAMIC).unwrap();
    let collider = w.add_collider(ball, SHAPE_BALL, [0.1, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(LINEAR_X, ball as usize, v3(100.0, 0.0, 0.0));
    w.step(1.0 / 60.0);
    assert_ne!(w.find_pair(collider, wall_collider), NONE);
    // Falling counts too: a gravity of 100 pulls 0.0278 m in a step from rest, past a gap under the margins.
    let mut w = World::new(2, 2).unwrap();
    w.header_mut().gravity = [0.0, -3600.0, 0.0];
    let floor = w.add_body(FIXED).unwrap();
    let floor_collider = w.add_collider(floor, SHAPE_BOX, [5.0, 0.05, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    let ball = w.add_body(DYNAMIC).unwrap();
    let collider = w.add_collider(ball, SHAPE_BALL, [0.1, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, ball as usize, v3(0.0, 1.0, 0.0));
    w.step(1.0 / 60.0);
    assert_ne!(w.find_pair(collider, floor_collider), NONE, "the fall of a dt^2 = 1 m reaches the floor");
}

#[test]
fn a_turning_body_sweeps_its_far_end() {
    // A long arm about a centre far from its collider: the spin alone reaches the wall.
    let mut w = World::new(2, 3).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let wall = w.add_body(FIXED).unwrap();
    let wall_collider = w.add_collider(wall, SHAPE_BOX, [0.05, 5.0, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, wall as usize, v3(3.0, 0.0, 0.0));
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1000.0).unwrap();
    let tip = w.add_collider(body, SHAPE_BALL, [0.1, 0.0, 0.0], [0.0, 2.0, 0.0], IDENTITY, 1.0).unwrap();
    w.set_v(ANGULAR_X, body as usize, v3(0.0, 0.0, -120.0));
    w.step(1.0 / 60.0);
    assert_ne!(w.find_pair(tip, wall_collider), NONE);
}

#[test]
fn a_box_fits_again_after_a_burst_of_speed() {
    let mut w = World::new(1, 1).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let body = w.add_body(DYNAMIC).unwrap() as usize;
    let c = w.add_collider(body as u32, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap() as usize;
    w.set_v(LINEAR_X, body, v3(600.0, 0.0, 0.0));
    w.step(1.0 / 60.0);
    let wide = w.s(FAT_MAX_X, c) - w.s(FAT_MIN_X, c);
    assert!(wide > 10.0);
    w.set_v(LINEAR_X, body, v3(0.0, 0.0, 0.0));
    w.step(1.0 / 60.0);
    let narrow = w.s(FAT_MAX_X, c) - w.s(FAT_MIN_X, c);
    assert!(narrow < 1.5, "{narrow}");
}

#[test]
fn a_still_body_moves_no_end_and_a_slow_one_moves_them_rarely() {
    let mut w = World::new(2, 2).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let body = w.add_body(DYNAMIC).unwrap() as usize;
    let c = w.add_collider(body as u32, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap() as usize;
    w.step(1.0 / 60.0);
    let start = w.s(FAT_MIN_X, c);
    for _ in 0..100 {
        w.step(1.0 / 60.0);
    }
    assert_eq!(w.s(FAT_MIN_X, c), start);
    w.set_v(LINEAR_X, body, v3(0.6, 0.0, 0.0)); // 0.01 m a step, against a margin of 0.04 m each side
    let mut moves = 0;
    let mut last = w.s(FAT_MIN_X, c);
    for _ in 0..100 {
        w.step(1.0 / 60.0);
        if w.s(FAT_MIN_X, c) != last {
            moves += 1;
            last = w.s(FAT_MIN_X, c);
        }
    }
    assert!((1..=30).contains(&moves), "{moves} moves in 100 steps");
}

#[test]
fn many_overlapping_colliders_grow_the_pairs_and_keep_them() {
    let mut w = World::new(300, 300).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    for _ in 0..300 {
        let body = w.add_body(DYNAMIC).unwrap();
        w.add_collider(body, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    }
    w.step(1.0 / 60.0);
    assert_eq!(w.header().pairs, 300 * 299 / 2);
    assert_eq!(w.header().failed, 0);
    assert!(w.header().layout > 0);
    check(&w);
}

#[test]
fn a_removed_collider_leaves_with_its_pairs_and_its_row_comes_back_after_a_step() {
    let mut w = World::new(3, 3).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let (a, b) = (w.add_body(DYNAMIC).unwrap(), w.add_body(DYNAMIC).unwrap());
    let first = w.add_collider(a, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    let second = w.add_collider(b, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.step(1.0 / 60.0);
    assert_eq!(w.header().pairs, 1);
    assert!(w.remove_collider(second));
    w.step(1.0 / 60.0);
    assert_eq!(w.header().pairs, 0);
    assert_eq!(w.header().free_collider, second);
    assert_eq!(w.add_collider(b, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0), Some(second));
    w.step(1.0 / 60.0);
    assert_ne!(w.find_pair(first, second), NONE);
    // Added and removed between two steps: it never joins, and its row is still freed.
    let third = w.add_collider(b, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    assert!(w.remove_collider(third));
    w.step(1.0 / 60.0);
    check(&w);
    assert_eq!(w.header().free_collider, third);
}

#[test]
fn colliders_of_one_body_and_of_two_fixed_bodies_are_no_pair() {
    let mut w = World::new(3, 4).unwrap();
    let (a, b) = (w.add_body(DYNAMIC).unwrap(), w.add_body(FIXED).unwrap());
    let c = w.add_body(FIXED).unwrap();
    w.add_collider(a, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.add_collider(a, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.add_collider(b, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.add_collider(c, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.step(1.0 / 60.0);
    assert_eq!(w.header().pairs, 4);
}

#[test]
fn a_fixed_body_written_by_hand_is_seen_after_touch() {
    let mut w = World::new(2, 2).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let (a, b) = (w.add_body(DYNAMIC).unwrap(), w.add_body(FIXED).unwrap());
    let c = w.add_collider(a, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    let d = w.add_collider(b, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, b as usize, v3(50.0, 0.0, 0.0));
    w.step(1.0 / 60.0);
    assert_eq!(w.find_pair(c, d), NONE);
    w.set_v(POSITION_X, b as usize, v3(0.5, 0.0, 0.0));
    w.step(1.0 / 60.0);
    assert_eq!(w.find_pair(c, d), NONE, "nothing told the kernel");
    w.touch_body(b);
    w.step(1.0 / 60.0);
    assert_ne!(w.find_pair(c, d), NONE);
}

#[test]
fn growth_keeps_the_broad_phase_as_it_was() {
    let mut w = World::new(16, 24).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let mut r = Random(77);
    for _ in 0..8 {
        random_body(&mut w, &mut r, DYNAMIC, 1.0);
    }
    w.step(1.0 / 60.0);
    let pairs = w.header().pairs;
    w.reserve(5000, 5000);
    check(&w);
    assert_eq!(w.header().pairs, pairs);
    w.step(1.0 / 60.0);
    check(&w);
}
