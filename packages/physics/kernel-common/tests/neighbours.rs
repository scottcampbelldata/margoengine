// The grid finds exactly the points within a radius that brute force finds, visits them in a fixed order, and refuses what
// it cannot hold.
use margoengine_physics_kernel_common::neighbours::{GridError, NeighbourGrid};

fn stream(seed: u64) -> impl FnMut() -> f32 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((s >> 40) as f32) / (1u64 << 24) as f32
    }
}

fn points(n: usize, spread: f32, seed: u64) -> Vec<[f32; 3]> {
    let mut u = stream(seed);
    (0..n).map(|_| [(u() - 0.5) * spread, (u() - 0.5) * spread, (u() - 0.5) * spread]).collect()
}

#[test]
fn every_point_within_the_radius_is_a_candidate_and_none_is_twice() {
    for (n, spread, radius) in [(0usize, 10.0f32, 1.0f32), (1, 10.0, 1.0), (500, 10.0, 1.0), (2000, 30.0, 2.5), (800, 3.0, 1.0)] {
        let pts = points(n, spread, 7);
        let mut grid = NeighbourGrid::default();
        grid.build(&pts, radius).unwrap();
        assert_eq!(grid.len(), n);
        for (i, p) in pts.iter().enumerate().take(300) {
            let mut seen = vec![];
            grid.candidates(*p, 1, |id| seen.push(id));
            let mut sorted = seen.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), seen.len(), "point {i}: a candidate came twice");
            let within = |q: &[f32; 3]| (0..3).map(|k| (p[k] - q[k]) * (p[k] - q[k])).sum::<f32>() <= radius * radius;
            let truth: Vec<u32> = (0..n as u32).filter(|&j| within(&pts[j as usize])).collect();
            for j in &truth {
                assert!(seen.contains(j), "point {i} misses its neighbour {j}");
            }
        }
    }
}

#[test]
fn the_order_of_the_candidates_is_a_function_of_the_positions_alone() {
    let pts = points(1500, 12.0, 11);
    let (mut a, mut b) = (NeighbourGrid::default(), NeighbourGrid::default());
    a.build(&pts, 1.0).unwrap();
    // Built again in another grid object (and over a stale one): the same sequence.
    b.build(&points(10, 100.0, 3), 5.0).unwrap();
    b.build(&pts, 1.0).unwrap();
    for p in pts.iter().take(100) {
        let (mut x, mut y) = (vec![], vec![]);
        a.candidates(*p, 1, |id| x.push(id));
        b.candidates(*p, 1, |id| y.push(id));
        assert_eq!(x, y);
    }
}

#[test]
fn refuses_what_it_cannot_hold() {
    let mut grid = NeighbourGrid::default();
    assert_eq!(grid.build(&[[0.0; 3]], 0.0), Err(GridError::NotFinite));
    assert_eq!(grid.build(&[[0.0; 3]], f32::NAN), Err(GridError::NotFinite));
    assert_eq!(grid.build(&[[f32::NAN, 0.0, 0.0]], 1.0), Err(GridError::NotFinite));
    assert_eq!(grid.build(&[[0.0; 3], [1.0e9, 1.0e9, 1.0e9]], 1.0), Err(GridError::TooManyCells));
    assert_eq!(grid.build(&[[0.0; 3], [1000.0, 1000.0, 1000.0]], 1.0), Err(GridError::TooManyCells));
    assert!(grid.build(&[[0.0; 3], [100.0, 100.0, 100.0]], 1.0).is_ok());
}
