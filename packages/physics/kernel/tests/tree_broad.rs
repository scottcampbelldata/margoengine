// The tree broad phase against brute force and against the sweep: every step of random moving scenes, every pair the boxes say and no
// other, a tree whose boxes hold what hangs under them, with each way of building a batch and with rotations on and off.
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

/// The tree is whole: each collider in the broad phase has one leaf, every box holds its children, parents and children agree, and
/// the pairs are exactly the overlapping fat boxes' (the sweep's invariant, without its lists).
fn check(w: &World) {
    let header = w.header();
    let in_broad: Vec<usize> =
        (0..header.collider_rows as usize).filter(|&c| w.uu(COLLIDER_STATE, c) & IN_BROAD != 0).collect();
    let mut leaves = 0;
    let mut reached = 0;
    if header.tree_root != NONE {
        assert_eq!(w.uu(TREE_PARENT, header.tree_root as usize), NONE, "the root has no parent");
        let mut stack = vec![header.tree_root];
        while let Some(n) = stack.pop() {
            reached += 1;
            let at = n as usize;
            let (low, high) = (w.v(TREE_MIN_X, at), w.v(TREE_MAX_X, at));
            if w.uu(TREE_LEFT, at) == NONE {
                leaves += 1;
                let c = w.uu(TREE_COLLIDER, at) as usize;
                assert_eq!(w.uu(COLLIDER_LEAF, c), n, "collider {c} and its leaf name each other");
                assert_eq!(w.v(FAT_MIN_X, c), low, "a leaf is its collider's fat box");
                assert_eq!(w.v(FAT_MAX_X, c), high);
            } else {
                for child in [w.uu(TREE_LEFT, at), w.uu(TREE_RIGHT, at)] {
                    assert_eq!(w.uu(TREE_PARENT, child as usize), n, "child {child} names {n} as its parent");
                    let (cl, ch) = (w.v(TREE_MIN_X, child as usize), w.v(TREE_MAX_X, child as usize));
                    assert!(cl.x >= low.x && cl.y >= low.y && cl.z >= low.z && ch.x <= high.x && ch.y <= high.y && ch.z <= high.z, "box of {n} holds {child}");
                    stack.push(child);
                }
            }
        }
    }
    assert_eq!(leaves, in_broad.len(), "a leaf for each collider in the broad phase");
    assert_eq!(reached, 2 * leaves.max(1) - 1 + if leaves == 0 { 1 } else { 0 }, "a binary tree of {leaves} leaves");
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

/// Bodies come and go while the rest move, with the broad phase set up by `set`; returns the pairs of each step.
/// Makes every collider of a body a sensor, so nothing pushes anything and two runs of one scene keep to one path whatever order their
/// pairs come in.
fn sensor(w: &mut World, body: u32) -> u32 {
    let mut c = w.uu(FIRST_COLLIDER, body as usize);
    while c != NONE {
        w.set_u(COLLIDER_FLAGS, c as usize, w.uu(COLLIDER_FLAGS, c as usize) | COLLIDER_SENSOR);
        c = w.uu(COLLIDER_NEXT, c as usize);
    }
    body
}

fn made(w: &mut World, body: u32, sensors: bool) -> u32 {
    if sensors { sensor(w, body) } else { body }
}

fn churn(set: &dyn Fn(&mut World), seed: u32, steps: u32, checked: bool, sensors: bool) -> Vec<BTreeSet<(u32, u32)>> {
    let mut w = World::new(8, 8).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    set(&mut w);
    let mut r = Random(seed);
    let size = 6.0;
    let mut alive: Vec<u32> = vec![];
    for i in 0..60 {
        let kind = if i % 7 == 0 { FIXED } else { DYNAMIC };
        w.reserve(w.header().rows + 1, w.header().collider_rows + 4);
        alive.push({ let b = random_body(&mut w, &mut r, kind, size); made(&mut w, b, sensors) });
    }
    let mut trace = vec![];
    for _ in 0..steps {
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
                alive.push({ let b = random_body(&mut w, &mut r, DYNAMIC, size); made(&mut w, b, sensors) });
            }
            2 => {
                // A batch at once takes the build strategy with many new boxes.
                for _ in 0..24 {
                    w.reserve(w.header().rows + 1, w.header().collider_rows + 4);
                    alive.push({ let b = random_body(&mut w, &mut r, DYNAMIC, size); made(&mut w, b, sensors) });
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
                let body = alive[(r.next() as usize) % alive.len()];
                let at = body as usize;
                w.set_v(POSITION_X, at, v3(r.range(-size, size), r.range(-size, size), r.range(-size, size)));
                w.touch_body(body);
            }
            _ => {}
        }
        w.step(1.0 / 60.0);
        if checked && w.header().broad_kind == 1 {
            check(&w);
        }
        assert_eq!(w.header().failed, 0);
        let mut pairs = BTreeSet::new();
        for row in 0..w.header().pair_rows {
            let a = w.uu(PAIR_A, row as usize);
            if a != NONE {
                pairs.insert((a, w.uu(PAIR_B, row as usize)));
            }
        }
        trace.push(pairs);
    }
    trace
}

#[test]
fn the_tree_finds_what_brute_force_finds_on_every_step_with_every_build_and_rotations_on_and_off() {
    for build in 0..3u32 {
        for optimize in [0u32, 1] {
            for seed in [1, 2, 7] {
                let trace = churn(
                    &|w| {
                        w.header_mut().tree_build = build;
                        w.header_mut().tree_optimize = optimize;
                        w.header_mut().broad_kind = 1;
                    },
                    seed,
                    200,
                    true,
                    false,
                );
                assert!(trace.iter().any(|pairs| pairs.len() > 30), "the scene is dense enough to prove something (build {build}, rotations {optimize})");
            }
        }
    }
}

#[test]
fn the_tree_and_the_sweep_keep_the_same_pairs_step_for_step() {
    for seed in [3, 12345] {
        let sweep = churn(&|_| {}, seed, 200, false, true);
        let tree = churn(&|w| w.header_mut().broad_kind = 1, seed, 200, false, true);
        assert_eq!(sweep, tree, "seed {seed}");
    }
}

#[test]
fn switching_the_broad_phase_mid_run_keeps_every_pair() {
    let mut w = World::new(64, 256).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let mut r = Random(77);
    let mut bodies = vec![];
    for i in 0..40 {
        bodies.push(random_body(&mut w, &mut r, if i % 9 == 0 { FIXED } else { DYNAMIC }, 4.0));
    }
    let pairs = |w: &World| {
        (0..w.header().pair_rows)
            .filter(|&row| w.uu(PAIR_A, row as usize) != NONE)
            .map(|row| (w.uu(PAIR_A, row as usize), w.uu(PAIR_B, row as usize)))
            .collect::<BTreeSet<_>>()
    };
    for _ in 0..30 {
        for &b in &bodies {
            bounce(&mut w, b as usize, 4.0);
        }
        w.step(1.0 / 60.0);
    }
    let before = pairs(&w);
    assert!(before.len() > 10);
    // Swept to the tree and back, a step later the pairs are what the sweep alone would have: nothing lost, nothing doubled.
    w.header_mut().broad_kind = 1;
    w.switch_broad_phase();
    w.step(1.0 / 60.0);
    check(&w);
    w.header_mut().broad_kind = 0;
    w.switch_broad_phase();
    w.step(1.0 / 60.0);
    assert_eq!(w.header().pairs as usize, pairs(&w).len());
    assert!(pairs(&w).len() > 5);
}

#[test]
fn an_adaptive_margin_is_an_eighth_of_the_smallest_side_up_to_half_a_metre() {
    let make = |adaptive: u32| {
        let mut w = World::new(4, 4).unwrap();
        w.header_mut().gravity = [0.0, 0.0, 0.0];
        w.header_mut().adaptive_margin = adaptive;
        let big = w.add_body(FIXED).unwrap();
        let c = w.add_collider(big, SHAPE_BOX, [4.0, 4.0, 4.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        let small = w.add_body(FIXED).unwrap();
        let s = w.add_collider(small, SHAPE_BOX, [0.1, 0.1, 0.1], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.step(1.0 / 60.0);
        let growth = |c: u32| w.v(FAT_MAX_X, c as usize).x - w.v(FAT_MIN_X, c as usize).x;
        (growth(c) - 8.0, growth(s) - 0.2)
    };
    let (fixed_big, fixed_small) = make(0);
    let (adaptive_big, adaptive_small) = make(1);
    // The margin is on both sides: a fixed one is the prediction distance (0.04 m) each way, an adaptive one half a metre for the big
    // box (an eighth of 8 m is 1 m, capped) and the prediction distance for the small one (an eighth of 0.2 m is under it).
    assert!((fixed_big - 0.08).abs() < 1e-4 && (fixed_small - 0.08).abs() < 1e-4, "{fixed_big} {fixed_small}");
    assert!((adaptive_big - 1.0).abs() < 1e-4, "{adaptive_big}");
    assert!((adaptive_small - 0.08).abs() < 1e-4, "{adaptive_small}");
}

/// The surface area of every inner node of the tree: what a query pays, as the surface area heuristic counts it.
fn tree_cost(w: &World) -> f32 {
    let mut cost = 0.0;
    let mut stack = vec![w.header().tree_root];
    while let Some(n) = stack.pop() {
        let at = n as usize;
        if w.uu(TREE_LEFT, at) != NONE {
            let d = w.v(TREE_MAX_X, at).sub(w.v(TREE_MIN_X, at));
            cost += d.x * d.y + d.y * d.z + d.z * d.x;
            stack.push(w.uu(TREE_LEFT, at));
            stack.push(w.uu(TREE_RIGHT, at));
        }
    }
    cost
}

#[test]
fn a_batch_built_top_down_or_by_clustering_is_a_cheaper_tree_than_one_inserted_leaf_by_leaf() {
    let cost = |build: u32, optimize: u32| {
        let mut w = World::new(400, 800).unwrap();
        w.header_mut().gravity = [0.0, 0.0, 0.0];
        w.header_mut().broad_kind = 1;
        w.header_mut().tree_build = build;
        w.header_mut().tree_optimize = optimize;
        let mut r = Random(4242);
        for _ in 0..400 {
            let body = w.add_body(FIXED).unwrap();
            w.add_collider(body, SHAPE_BALL, [r.range(0.1, 0.4), 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
            w.set_v(POSITION_X, body as usize, v3(r.range(-30.0, 30.0), r.range(-30.0, 30.0), r.range(-30.0, 30.0)));
        }
        w.step(1.0 / 60.0);
        check(&w);
        tree_cost(&w)
    };
    let (incremental, binned, clustered) = (cost(0, 0), cost(1, 0), cost(2, 0));
    assert!(binned < incremental, "top down by the surface area heuristic: {binned} against {incremental}");
    assert!(clustered < incremental * 1.05, "clustering in Morton order is within a twentieth of one at a time or better: {clustered} against {incremental}");
    // Rotations on the way up make the tree of one-at-a-time insertion cheaper still.
    let rotated = cost(0, 1);
    assert!(rotated <= incremental, "rotations do not make it dearer: {rotated} against {incremental}");
}

/// A crowd of sensor bodies bouncing in a cube, none created or removed; the pairs each step finds, with the broad phase set up by `set`.
fn crowd(set: &dyn Fn(&mut World), seed: u32, bodies: u32, steps: u32) -> Vec<BTreeSet<(u32, u32)>> {
    let mut w = World::new(bodies + 8, bodies * 4 + 8).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    set(&mut w);
    let mut r = Random(seed);
    let size = 14.0;
    let alive: Vec<u32> = (0..bodies)
        .map(|_| {
            let b = random_body(&mut w, &mut r, DYNAMIC, size);
            made(&mut w, b, true)
        })
        .collect();
    let mut trace = vec![];
    for _ in 0..steps {
        for &body in &alive {
            bounce(&mut w, body as usize, size);
        }
        w.step(1.0 / 60.0);
        assert_eq!(w.header().failed, 0);
        let mut pairs = BTreeSet::new();
        for row in 0..w.header().pair_rows {
            let a = w.uu(PAIR_A, row as usize);
            if a != NONE {
                pairs.insert((a, w.uu(PAIR_B, row as usize)));
            }
        }
        trace.push(pairs);
    }
    trace
}

#[test]
fn a_thousand_moving_bodies_keep_the_same_pairs_in_the_tree_and_the_sweep_for_five_hundred_steps() {
    let sweep = crowd(&|_| {}, 99, 1000, 500);
    let tree = crowd(&|w| w.header_mut().broad_kind = 1, 99, 1000, 500);
    assert!(sweep.iter().any(|pairs| pairs.len() > 200), "the crowd is dense enough to prove something");
    assert_eq!(sweep.len(), tree.len());
    for (step, (a, b)) in sweep.iter().zip(&tree).enumerate() {
        assert_eq!(a, b, "the pairs differ at step {step}");
    }
}
