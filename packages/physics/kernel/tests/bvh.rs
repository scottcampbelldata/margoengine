// The binned SAH tree (Wald 2007) against brute force: every box query finds exactly the triangles whose bounds overlap it.
use margoengine_physics_kernel::bvh::{Nodes, Prims, build, overlaps, LEAF, MEDIAN_DEPTH};
use margoengine_physics_kernel::math::*;

struct Stream(u32);
impl Stream {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    fn unit(&mut self) -> f32 {
        (self.next() % 100_001) as f32 / 100_000.0
    }
}

struct Boxes(Vec<(V3, V3)>);
impl Prims for Boxes {
    fn bounds(&self, prim: u32) -> (V3, V3) {
        self.0[prim as usize]
    }
}

#[derive(Default)]
struct Tree {
    nodes: Vec<(V3, V3, u32, u32)>,
}
impl Nodes for Tree {
    fn set(&mut self, node: u32, min: V3, max: V3, first: u32, count: u32) {
        let at = node as usize;
        if self.nodes.len() <= at {
            self.nodes.resize(at + 1, (v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), u32::MAX, u32::MAX));
        }
        self.nodes[at] = (min, max, first, count);
    }
}

fn triangle_bounds(a: V3, b: V3, c: V3) -> (V3, V3) {
    (v3(a.x.min(b.x).min(c.x), a.y.min(b.y).min(c.y), a.z.min(b.z).min(c.z)), v3(a.x.max(b.x).max(c.x), a.y.max(b.y).max(c.y), a.z.max(b.z).max(c.z)))
}

fn random_triangles(seed: u32, n: usize, spread: f32, size: f32) -> Boxes {
    let mut r = Stream(seed);
    let mut out = Vec::new();
    for _ in 0..n {
        let o = v3(r.unit() * spread, r.unit() * spread * 0.2, r.unit() * spread);
        let p = |r: &mut Stream| o.add(v3(r.unit() * size, r.unit() * size, r.unit() * size));
        let (a, b, c) = (p(&mut r), p(&mut r), p(&mut r));
        out.push(triangle_bounds(a, b, c));
    }
    Boxes(out)
}

fn inside(lo: V3, hi: V3, in_lo: V3, in_hi: V3) -> bool {
    in_lo.x >= lo.x && in_lo.y >= lo.y && in_lo.z >= lo.z && in_hi.x <= hi.x && in_hi.y <= hi.y && in_hi.z <= hi.z
}

/// Checks the tree's shape and returns its depth.
fn check(prims: &Boxes, ids: &[u32], tree: &Tree, used: u32) -> usize {
    let n = ids.len();
    assert!(used as usize <= 2 * n - 1, "{used} nodes for {n} triangles");
    let mut sorted = ids.to_vec();
    sorted.sort();
    assert!(sorted.iter().enumerate().all(|(i, &id)| id == i as u32), "the ids stay a permutation");
    let mut seen = vec![0u32; n];
    let mut depth = 0;
    let mut stack = vec![(0u32, 1usize)];
    while let Some((node, d)) = stack.pop() {
        depth = depth.max(d);
        let (lo, hi, first, count) = tree.nodes[node as usize];
        if count == 0 {
            for child in [first, first + 1] {
                let (clo, chi, _, _) = tree.nodes[child as usize];
                assert!(inside(lo, hi, clo, chi), "a child box lies in its parent's");
                stack.push((child, d + 1));
            }
        } else {
            for &id in &ids[first as usize..(first + count) as usize] {
                let (plo, phi) = prims.bounds(id);
                assert!(inside(lo, hi, plo, phi), "a leaf box holds its triangles");
                seen[id as usize] += 1;
            }
        }
    }
    assert!(seen.iter().all(|&s| s == 1), "every triangle is in exactly one leaf");
    depth
}

fn query(prims: &Boxes, ids: &[u32], tree: &Tree, lo: V3, hi: V3) -> Vec<u32> {
    let mut found = Vec::new();
    overlaps(lo, hi, |n| (tree.nodes[n as usize].0, tree.nodes[n as usize].1), |n| (tree.nodes[n as usize].2, tree.nodes[n as usize].3), ids, |id| {
        let (plo, phi) = prims.bounds(id);
        if !(plo.x > hi.x || plo.y > hi.y || plo.z > hi.z || phi.x < lo.x || phi.y < lo.y || phi.z < lo.z) {
            found.push(id);
        }
        true
    });
    found.sort();
    found
}

#[test]
fn box_queries_find_what_brute_force_finds_on_random_meshes() {
    for (seed, n, spread, size) in [(7u32, 1usize, 10.0f32, 1.0f32), (11, 2, 10.0, 1.0), (13, 3, 10.0, 1.0), (17, 1000, 50.0, 1.0), (19, 5000, 20.0, 3.0), (23, 777, 1.0, 0.01)] {
        let prims = random_triangles(seed, n, spread, size);
        let mut ids: Vec<u32> = (0..n as u32).collect();
        let mut tree = Tree::default();
        let used = build(&prims, &mut ids, &mut vec![0; prims.0.len()], &mut tree);
        check(&prims, &ids, &tree, used);
        let mut r = Stream(seed ^ 0x9e37);
        for _ in 0..200 {
            let lo = v3(r.unit() * spread, r.unit() * spread * 0.2, r.unit() * spread);
            let hi = lo.add(v3(r.unit() * spread * 0.1, r.unit() * spread * 0.1, r.unit() * spread * 0.1));
            let want: Vec<u32> = (0..n as u32)
                .filter(|&id| {
                    let (plo, phi) = prims.bounds(id);
                    !(plo.x > hi.x || plo.y > hi.y || plo.z > hi.z || phi.x < lo.x || phi.y < lo.y || phi.z < lo.z)
                })
                .collect();
            assert_eq!(query(&prims, &ids, &tree, lo, hi), want, "seed {seed}");
        }
    }
}

#[test]
fn a_flat_grid_gives_a_balanced_tree_with_small_leaves() {
    // 128 x 128 cells of two triangles each, the floor of the sliding test.
    let mut boxes = Vec::new();
    for i in 0..128 {
        for j in 0..128 {
            let (x, z) = (i as f32, j as f32);
            boxes.push(triangle_bounds(v3(x, 0.0, z), v3(x + 1.0, 0.0, z), v3(x, 0.0, z + 1.0)));
            boxes.push(triangle_bounds(v3(x + 1.0, 0.0, z), v3(x + 1.0, 0.0, z + 1.0), v3(x, 0.0, z + 1.0)));
        }
    }
    let prims = Boxes(boxes);
    let n = prims.0.len();
    let mut ids: Vec<u32> = (0..n as u32).collect();
    let mut tree = Tree::default();
    let used = build(&prims, &mut ids, &mut vec![0; prims.0.len()], &mut tree);
    let depth = check(&prims, &ids, &tree, used);
    // A perfect tree of leaves of LEAF triangles has depth log2(n / LEAF) + 1 = 15.
    assert!(depth <= 18, "depth {depth}");
    let leaves = tree.nodes[..used as usize].iter().filter(|node| node.3 != 0);
    assert!(leaves.clone().all(|node| node.3 <= 4 * LEAF));
}

#[test]
fn duplicates_and_a_sliver_chain_keep_the_depth_bounded() {
    // 4,000 copies of one triangle: no centroid width, halved by count.
    let one = triangle_bounds(v3(0.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), v3(0.0, 0.0, 1.0));
    let prims = Boxes(vec![one; 4000]);
    let mut ids: Vec<u32> = (0..4000).collect();
    let mut tree = Tree::default();
    let used = build(&prims, &mut ids, &mut vec![0; prims.0.len()], &mut tree);
    let depth = check(&prims, &ids, &tree, used);
    assert!(depth <= 14, "depth {depth}");
    // Centroids at 2^-i: every cut peels off one triangle, the case that needs the depth cap.
    let chain: Vec<(V3, V3)> = (0..120).map(|i| { let x = (0.5f32).powi(i); (v3(x, 0.0, 0.0), v3(x, 1.0, 1.0)) }).collect();
    let prims = Boxes(chain);
    let mut ids: Vec<u32> = (0..120).collect();
    let mut tree = Tree::default();
    let used = build(&prims, &mut ids, &mut vec![0; prims.0.len()], &mut tree);
    let depth = check(&prims, &ids, &tree, used);
    assert!(depth <= MEDIAN_DEPTH + 33, "depth {depth}");
}
