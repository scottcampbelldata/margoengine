// The grid finds exactly the points within a radius that brute force finds, visits them in a fixed order, and refuses what
// it cannot hold.
use margoengine_physics_kernel_common::neighbours::{GridError, NeighbourGrid, Storage};

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
    // Wider than 2^32 - 1 cells along an axis: refused, whatever the storage. A billion cells a side is held sparsely.
    assert_eq!(grid.build(&[[0.0; 3], [1.0e10, 0.0, 0.0]], 1.0), Err(GridError::TooManyCells));
    assert_eq!(grid.build(&[[0.0; 3], [0.0, 0.0, 5.0e9]], 1.0), Err(GridError::TooManyCells));
    assert!(grid.build(&[[0.0; 3], [1.0e9, 1.0e9, 1.0e9]], 1.0).is_ok());
    assert!(grid.is_sparse());
    // A thousand cells a side is a billion dense cells, which two points hold sparsely.
    assert!(grid.build(&[[0.0; 3], [1000.0, 1000.0, 1000.0]], 1.0).is_ok());
    assert!(grid.is_sparse());
    assert_eq!(grid.build_with(&[[0.0; 3], [1000.0, 1000.0, 1000.0]], 1.0, Storage::Dense), Err(GridError::TooManyCells));
    assert!(grid.build(&[[0.0; 3], [100.0, 100.0, 100.0]], 1.0).is_ok());
}

#[test]
fn sparse_and_dense_storage_give_the_same_candidates_in_the_same_order() {
    for (n, spread, cell) in [(0usize, 10.0f32, 1.0f32), (1, 10.0, 1.0), (700, 10.0, 1.0), (1500, 40.0, 1.5), (400, 600.0, 2.0)] {
        let pts = points(n, spread, 21);
        let (mut dense, mut sparse) = (NeighbourGrid::default(), NeighbourGrid::default());
        if dense.build_with(&pts, cell, Storage::Dense).is_err() {
            continue; // too many cells for dense: nothing to compare against
        }
        sparse.build_with(&pts, cell, Storage::Sparse).unwrap();
        assert!(sparse.is_sparse() && !dense.is_sparse());
        assert_eq!(dense.dims(), sparse.dims());
        assert_eq!(dense.len(), sparse.len());
        for reach in [1u32, 2] {
            for p in pts.iter().take(200).chain([[0.0, 0.0, 0.0], [spread, spread, spread]].iter()) {
                let (mut a, mut b) = (vec![], vec![]);
                dense.candidates(*p, reach, |id| a.push(id));
                sparse.candidates(*p, reach, |id| b.push(id));
                assert_eq!(a, b, "n {n} reach {reach}");
            }
        }
    }
}

#[test]
fn auto_storage_is_sparse_exactly_when_the_counters_cost_more_than_the_keys() {
    // A dense cell costs a 4-byte counter, a sparse one at most a 16-byte key and a 4-byte start: 3 points are dense up to
    // 15 cells, sparse beyond.
    let mut grid = NeighbourGrid::default();
    grid.build(&[[0.0; 3], [1.5, 0.0, 0.0], [0.0, 1.5, 0.0]], 1.0).unwrap(); // 2 x 2 x 1 = 4 cells
    assert!(!grid.is_sparse());
    grid.build(&[[0.0; 3], [2.5, 0.0, 0.0], [0.0, 4.5, 0.0]], 1.0).unwrap(); // 3 x 5 x 1 = 15 cells
    assert!(!grid.is_sparse());
    grid.build(&[[0.0; 3], [1.5, 0.0, 0.0], [0.0, 7.5, 0.0]], 1.0).unwrap(); // 2 x 8 x 1 = 16 cells
    assert!(grid.is_sparse());
}

#[test]
fn a_far_flung_sparse_set_finds_its_close_pairs() {
    // Two clusters a hundred thousand cells apart: dense is impossible, sparse still finds each cluster's pairs.
    let mut pts = points(50, 3.0, 5);
    for p in points(50, 3.0, 6) {
        pts.push([p[0] + 100000.0, p[1] - 50000.0, p[2] + 70000.0]);
    }
    let mut grid = NeighbourGrid::default();
    grid.build(&pts, 1.0).unwrap();
    assert!(grid.is_sparse());
    for (i, p) in pts.iter().enumerate() {
        let mut seen = vec![];
        grid.candidates(*p, 1, |id| seen.push(id));
        let truth: Vec<u32> = (0..pts.len() as u32)
            .filter(|&j| (0..3).map(|k| (p[k] - pts[j as usize][k]).powi(2)).sum::<f32>() <= 1.0)
            .collect();
        for j in &truth {
            assert!(seen.contains(j), "point {i} misses {j}");
        }
        assert!(seen.iter().all(|&j| (j < 50) == (i < 50)), "a candidate from the other cluster");
    }
}

#[test]
fn a_domain_of_more_than_two_to_the_twenty_six_cells_is_held_sparsely_and_finds_what_brute_force_finds() {
    // 3,000 points spread over a cube 800 cells a side, half a billion cells (2^26 is 67 million): no dense grid could hold it.
    let pts = points(3000, 800.0, 77);
    let mut grid = NeighbourGrid::default();
    grid.build(&pts, 1.0).unwrap();
    assert!(grid.is_sparse());
    let d = grid.dims();
    assert!(d[0] as u64 * d[1] as u64 * d[2] as u64 > 1 << 26, "{d:?}");
    // Sparse cells hold at most a point each here, so the ids it keeps are every point, once.
    assert_eq!(grid.len(), pts.len());
    let mut checked = 0;
    for p in pts.iter().step_by(7) {
        let mut seen = vec![];
        grid.candidates(*p, 1, |id| seen.push(id));
        let mut found: Vec<u32> = seen
            .iter()
            .copied()
            .filter(|&j| (0..3).map(|k| (p[k] - pts[j as usize][k]).powi(2)).sum::<f32>() <= 1.0)
            .collect();
        let truth: Vec<u32> = (0..pts.len() as u32)
            .filter(|&j| (0..3).map(|k| (p[k] - pts[j as usize][k]).powi(2)).sum::<f32>() <= 1.0)
            .collect();
        found.sort_unstable();
        assert_eq!(found, truth);
        // Asked twice, the same candidates in the same order.
        let mut again = vec![];
        grid.candidates(*p, 1, |id| again.push(id));
        assert_eq!(seen, again);
        checked += 1;
    }
    assert!(checked > 400);
}
