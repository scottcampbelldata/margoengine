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
