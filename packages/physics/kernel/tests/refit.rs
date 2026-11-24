// A deformable mesh follows its moved vertices by a refit: every node touched once and no rebuild, and what the tree
// answers after it is what a fresh build over the same vertices answers.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::query::*;
use margoengine_physics_kernel::world::{NONE, World};
use std::collections::HashMap;

const ALL: Filter = Filter { flags: 0, groups: u32::MAX, collider: NONE, body: NONE };

const DT: f32 = 1.0 / 60.0;

/// The triangle across each edge, by corner positions, as JS finds it: an edge shared by more than two is open.
fn across(vertices: &[V3], triangles: &[[u32; 3]]) -> Vec<[u32; 3]> {
    let key = |i: u32| {
        let p = vertices[i as usize];
        (p.x.to_bits(), p.y.to_bits(), p.z.to_bits())
    };
    let mut edges: HashMap<_, Vec<(usize, usize)>> = HashMap::new();
    for (t, tri) in triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (key(tri[k]), key(tri[(k + 1) % 3]));
            edges.entry(if a < b { (a, b) } else { (b, a) }).or_default().push((t, k));
        }
    }
    let mut out = vec![[NONE; 3]; triangles.len()];
    for list in edges.values() {
        if list.len() == 2 {
            out[list[0].0][list[0].1] = list[1].0 as u32;
            out[list[1].0][list[1].1] = list[0].0 as u32;
        }
    }
    out
}

fn add_mesh(w: &mut World, vertices: &[V3], triangles: &[[u32; 3]], flags: u32) -> i32 {
    assert!(w.begin_mesh(vertices.len() as u32, triangles.len() as u32));
    let [_, v0, t0, _, _] = w.header().mesh_rows;
    for (i, &p) in vertices.iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 as usize + i, p);
    }
    let links = across(vertices, triangles);
    for (i, tri) in triangles.iter().enumerate() {
        let at = t0 as usize + i;
        w.set_u(TRIANGLE_A, at, tri[0]);
        w.set_u(TRIANGLE_B, at, tri[1]);
        w.set_u(TRIANGLE_C, at, tri[2]);
        for k in 0..3 {
            w.set_u(TRIANGLE_ACROSS_0 + k, at, links[i][k]);
        }
    }
    w.end_mesh(vertices.len() as u32, triangles.len() as u32, flags)
}

/// A flat grid of `n` by `n` squares of `size` metres on y = 0, each split in two, centred on the origin.
fn grid(n: u32, size: f32, height: impl Fn(f32, f32) -> f32) -> (Vec<V3>, Vec<[u32; 3]>) {
    let mut vertices = Vec::new();
    let half = n as f32 * size / 2.0;
    for j in 0..=n {
        for i in 0..=n {
            let (x, z) = (i as f32 * size - half, j as f32 * size - half);
            vertices.push(v3(x, height(x, z), z));
        }
    }
    let mut triangles = Vec::new();
    let at = |i: u32, j: u32| j * (n + 1) + i;
    for j in 0..n {
        for i in 0..n {
            // Counter-clockwise seen from above.
            triangles.push([at(i, j), at(i, j + 1), at(i + 1, j)]);
            triangles.push([at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)]);
        }
    }
    (vertices, triangles)
}


fn ground(w: &mut World, mesh: i32) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], [0.0, 0.0, 0.0, 1.0], 0.0).unwrap()
}

fn wave(x: f32, z: f32, t: f32) -> f32 {
    0.4 * (x * 1.3 + t).sin() * (z * 0.9 - 0.5 * t).cos()
}

fn moved(vertices: &[V3], t: f32) -> Vec<V3> {
    vertices.iter().map(|p| v3(p.x, wave(p.x, p.z, t), p.z)).collect()
}

fn write_vertices(w: &mut World, mesh: i32, to: &[V3]) -> f32 {
    let v0 = w.uu(MESH_FIRST_VERTEX, mesh as usize) as usize;
    let mut farthest = 0.0f32;
    for (i, &p) in to.iter().enumerate() {
        let before = w.v(MESH_VERTEX_X, v0 + i);
        farthest = farthest.max(sqrt(p.sub(before).dot(p.sub(before))));
        w.set_v(MESH_VERTEX_X, v0 + i, p);
    }
    farthest
}

#[test]
fn a_refit_touches_every_node_once_and_never_rebuilds() {
    let (flat, triangles) = grid(12, 0.5, |_, _| 0.0);
    let mut w = World::new(8, 8).unwrap();
    let mesh = add_mesh(&mut w, &flat, &triangles, MESH_DEFORMABLE);
    assert!(mesh >= 0);
    let m = mesh as usize;
    let (nodes, first_node) = (w.uu(MESH_NODES, m), w.uu(MESH_FIRST_NODE, m));
    let rows = w.header().mesh_rows;
    let order: Vec<u32> = (0..triangles.len()).map(|t| w.uu(TRIANGLE_ORDER, w.uu(MESH_FIRST_TRIANGLE, m) as usize + t)).collect();
    let links: Vec<(u32, u32)> = (0..nodes as usize).map(|n| (w.uu(NODE_FIRST, first_node as usize + n), w.uu(NODE_COUNT, first_node as usize + n))).collect();
    for step in 1..=3 {
        let to = moved(&flat, step as f32 * 0.4);
        let farthest = write_vertices(&mut w, mesh, &to);
        // One visit a node: the count it reports is the mesh's node count, whatever the motion.
        assert_eq!(w.refit_mesh(m, farthest), nodes as i32);
    }
    // The topology, the order of triangles and the rows are what the build made: nothing was rebuilt.
    assert_eq!(w.header().mesh_rows, rows);
    assert_eq!(w.uu(MESH_NODES, m), nodes);
    for (t, &id) in order.iter().enumerate() {
        assert_eq!(w.uu(TRIANGLE_ORDER, w.uu(MESH_FIRST_TRIANGLE, m) as usize + t), id);
    }
    for (n, &(first, count)) in links.iter().enumerate() {
        assert_eq!((w.uu(NODE_FIRST, first_node as usize + n), w.uu(NODE_COUNT, first_node as usize + n)), (first, count));
    }
    // Every leaf box is exactly the box of its triangles; every inner box the union of its children's.
    let v0 = w.uu(MESH_FIRST_VERTEX, m) as usize;
    let t0 = w.uu(MESH_FIRST_TRIANGLE, m) as usize;
    for n in 0..nodes as usize {
        let at = first_node as usize + n;
        let (lo, hi) = (w.v(NODE_MIN_X, at), w.v(NODE_MAX_X, at));
        let (first, count) = links[n];
        let mut want = (v3(f32::INFINITY, f32::INFINITY, f32::INFINITY), v3(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY));
        if count > 0 {
            for k in first..first + count {
                for c in w.triangle_corners(v0, t0 + w.uu(TRIANGLE_ORDER, t0 + k as usize) as usize) {
                    want = (want.0.min(c), want.1.max(c));
                }
            }
        } else {
            for child in [first, first + 1] {
                want = (want.0.min(w.v(NODE_MIN_X, first_node as usize + child as usize)), want.1.max(w.v(NODE_MAX_X, first_node as usize + child as usize)));
            }
        }
        assert!(lo == want.0 && hi == want.1, "node {n}");
    }
}

#[test]
fn queries_after_a_refit_match_a_fresh_build() {
    let (flat, triangles) = grid(14, 0.4, |_, _| 0.0);
    let mut deformed = World::new(8, 8).unwrap();
    let mesh = add_mesh(&mut deformed, &flat, &triangles, MESH_DEFORMABLE);
    let collider = ground(&mut deformed, mesh);
    let mut state = 12345u32;
    let mut random = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state >> 8) as f32 / (1u32 << 24) as f32
    };
    for step in 1..=4 {
        let to = moved(&flat, step as f32 * 0.7);
        let farthest = write_vertices(&mut deformed, mesh, &to);
        assert!(deformed.refit_mesh(deformed.uu(COLLIDER_HULL, collider as usize) as usize, farthest) > 0);
        let mut fresh = World::new(8, 8).unwrap();
        let fresh_mesh = add_mesh(&mut fresh, &to, &triangles, 0);
        ground(&mut fresh, fresh_mesh);
        for _ in 0..200 {
            let origin = v3(random() * 4.0 - 2.0, 2.0, random() * 4.0 - 2.0);
            let dir = v3(random() * 0.4 - 0.2, -1.0, random() * 0.4 - 0.2);
            let length = sqrt(dir.dot(dir));
            let dir = dir.scale(1.0 / length);
            let a = deformed.cast_ray(origin, dir, 10.0, true, &ALL).map(|(_, hit)| hit.t);
            let b = fresh.cast_ray(origin, dir, 10.0, true, &ALL).map(|(_, hit)| hit.t);
            match (a, b) {
                (Some(x), Some(y)) => assert!((x - y).abs() < 1e-4, "{x} vs {y}"),
                (None, None) => {}
                other => panic!("ray disagrees {other:?}"),
            }
        }
    }
}
