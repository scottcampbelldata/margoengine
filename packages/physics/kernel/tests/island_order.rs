// The pairs a step solves are listed in runs, one run an island, with each run's start and length noted (the order of the
// island-major solve). The order moves no body: the replay fixture's state hashes are what they were before it.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

#[test]
fn each_islands_pairs_are_listed_together_in_the_order_they_were_found() {
    let mut w = World::new(32, 32).unwrap();
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [50.0, 0.5, 50.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, floor as usize, v3(0.0, -0.5, 0.0));
    // Five stacks of three boxes in a row, apart from each other: five islands, each with a pair against the floor and two
    // between its boxes. The stacks are made level by level so the pairs are found interleaved across the islands.
    for level in 0..3 {
        for stack in 0..5 {
            let body = w.add_body(DYNAMIC).unwrap();
            w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
            w.set_v(POSITION_X, body as usize, v3(stack as f32 * 3.0, 0.5 + level as f32, 0.0));
        }
    }
    for _ in 0..30 {
        w.step(1.0 / 60.0);
    }
    let islands = w.header().islands as usize;
    let solving = w.header().solving as usize;
    assert_eq!(islands, 5);
    assert_eq!(solving, 15);
    let mut seen = 0;
    for island in 0..islands {
        let (start, count) = (w.uu(ISLAND_PAIR_START, island) as usize, w.uu(ISLAND_PAIR_COUNT, island) as usize);
        assert_eq!(count, 3, "island {island}");
        assert_eq!(start, seen, "the runs follow each other");
        for i in start..start + count {
            let (a, b) = w.pair_bodies(w.uu(SOLVE_PAIRS, i));
            let owner = [a, b].into_iter().find(|&body| w.flags(body) & KIND == DYNAMIC).unwrap();
            assert_eq!(w.uu(ISLAND_ID, owner) as usize, island, "pair {i} sits in its island's run");
        }
        seen += count;
    }
    assert_eq!(seen, solving);
    assert_ne!(w.uu(SOLVE_PAIRS, 0), NONE);
}

#[test]
fn each_islands_joints_are_listed_together_with_their_paths_whole() {
    let mut w = World::new(32, 32).unwrap();
    // Four chains of four bodies in the air, apart from each other and made link by link, so the joints are found interleaved
    // across the islands. Each chain is one path of three joints.
    let mut chains = vec![Vec::new(); 4];
    for link in 0..4 {
        for chain in 0..4 {
            let body = w.add_body(DYNAMIC).unwrap();
            w.add_collider(body, SHAPE_BALL, [0.2, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
            w.set_v(POSITION_X, body as usize, v3(chain as f32 * 10.0 + link as f32 * 0.5, 5.0, 0.0));
            chains[chain].push(body);
        }
    }
    for link in 0..3 {
        for chain in &chains {
            w.add_joint(chain[link], chain[link + 1], 7).unwrap();
        }
    }
    for _ in 0..5 {
        w.step(1.0 / 60.0);
    }
    let (islands, solving) = (w.header().islands as usize, w.header().joint_solving as usize);
    assert_eq!((islands, solving), (4, 12));
    let mut seen = 0;
    for island in 0..islands {
        let (start, count) = (w.uu(ISLAND_JOINT_START, island) as usize, w.uu(ISLAND_JOINT_COUNT, island) as usize);
        assert_eq!((start, count), (seen, 3), "island {island}");
        let mut roots = 0;
        for i in start..start + count {
            let row = w.uu(SOLVE_JOINTS, i) as usize;
            assert_eq!(w.uu(ISLAND_ID, w.uu(JOINT_A, row) as usize) as usize, island, "joint {i} sits in its island's run");
            roots += (w.uu(SOLVE_VIA, i) == NONE) as usize;
        }
        // A chain is one path, so each run holds one joint that goes on through no body: the path is whole.
        assert_eq!(roots, 1, "island {island} holds one whole path");
        assert_eq!(w.uu(SOLVE_VIA, start), NONE, "and it starts the run");
        seen += count;
    }
    assert_eq!(seen, solving);
}

#[test]
fn each_islands_couplings_are_listed_together_in_slot_order() {
    use margoengine_physics_kernel::couplings::DISTANCE;
    let mut w = World::new(32, 32).unwrap();
    let mut pairs = Vec::new();
    for _ in 0..2 {
        pairs.push([0, 1].map(|_| w.add_body(DYNAMIC).unwrap()));
    }
    // Two islands of two bodies, made so the couplings are made one island after another and listed interleaved.
    for (n, pair) in pairs.iter().enumerate() {
        for (k, &body) in pair.iter().enumerate() {
            w.add_collider(body, SHAPE_BALL, [0.2, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
            w.set_v(POSITION_X, body as usize, v3(n as f32 * 10.0 + k as f32, 5.0, 0.0));
        }
    }
    for _ in 0..2 {
        for pair in &pairs {
            w.add_coupling(DISTANCE, pair[0], pair[1]).unwrap();
        }
    }
    for _ in 0..3 {
        w.step(1.0 / 60.0);
    }
    let rows = w.header().coupling_rows as usize;
    assert_eq!(rows, 4);
    let mut seen = 0;
    for island in 0..w.header().islands as usize {
        let (start, count) = (w.uu(ISLAND_COUPLING_START, island) as usize, w.uu(ISLAND_COUPLING_COUNT, island) as usize);
        assert_eq!((start, count), (seen, 2), "island {island}");
        let slots: Vec<u32> = (start..start + count).map(|i| w.uu(COUPLING_ORDER, i)).collect();
        assert!(slots[0] < slots[1], "slot order within the run: {slots:?}");
        seen += count;
    }
    assert_eq!(seen, rows);
}

#[test]
fn two_doors_hinged_to_one_wall_are_two_paths_in_two_islands() {
    // A path stops at a body that is not dynamic, so the wall joins nothing: each door is an island of its own with a path of
    // one joint, and the two paths are in different runs.
    let mut w = World::new(8, 8).unwrap();
    let wall = w.add_body(FIXED).unwrap();
    w.add_collider(wall, SHAPE_BOX, [0.2, 3.0, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    for z in [-2.0f32, 2.0] {
        let door = w.add_body(DYNAMIC).unwrap();
        w.add_collider(door, SHAPE_BOX, [0.1, 1.0, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
        w.set_v(POSITION_X, door as usize, v3(0.5, 0.0, z));
        w.add_joint(wall, door, 7).unwrap();
    }
    for _ in 0..3 {
        w.step(1.0 / 60.0);
    }
    assert_eq!(w.header().islands, 2);
    assert_eq!(w.header().joint_solving, 2);
    for island in 0..2 {
        assert_eq!((w.uu(ISLAND_JOINT_START, island), w.uu(ISLAND_JOINT_COUNT, island)), (island as u32, 1));
    }
    assert!((0..2).all(|i| w.uu(SOLVE_VIA, i) == NONE), "no joint goes on through the wall");
}
