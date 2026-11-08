// Triangle meshes: the tree finds what brute force finds, edges sort into the right classes, the ghost rule keeps shapes
// sliding over inner edges, and a mesh pair's parts come and go with the triangles a shape touches. A height field meets
// shapes as the same triangles held as rows do.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::mesh::*;
use margoengine_physics_kernel::world::{NONE, World};
use std::collections::HashMap;

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
    let [_, v0, t0, _] = w.header().mesh_rows;
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

fn dynamic(w: &mut World, shape: u32, size: [f32; 3], at: V3) -> (u32, u32) {
    turned(w, shape, size, at, [0.0, 0.0, 0.0, 1.0])
}

fn turned(w: &mut World, shape: u32, size: [f32; 3], at: V3, rotation: [f32; 4]) -> (u32, u32) {
    let body = w.add_body(DYNAMIC).unwrap();
    let collider = w.add_collider(body, shape, size, [0.0; 3], rotation, 1.0).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    (body, collider)
}

/// Rows that are parts of a mesh pair now.
fn parts(w: &World) -> usize {
    (0..w.header().pair_rows as usize).filter(|&r| w.uu(PAIR_A, r) != NONE && w.uu(PAIR_FLAGS, r) & PAIR_IS_PART != 0).count()
}

#[test]
fn edges_sort_into_convex_concave_flat_and_open() {
    let mut w = World::new(4, 4).unwrap();
    // A ridge along z (convex from above), a valley (concave), and a flat pair; each two triangles share one edge.
    let ridge = [v3(-1.0, 0.0, 0.0), v3(0.0, 0.5, 1.0), v3(0.0, 0.5, -1.0), v3(1.0, 0.0, 0.0)];
    let valley = [v3(-1.0, 0.5, 0.0), v3(0.0, 0.0, 1.0), v3(0.0, 0.0, -1.0), v3(1.0, 0.5, 0.0)];
    let flat = [v3(-1.0, 0.0, 0.0), v3(0.0, 0.0, 1.0), v3(0.0, 0.0, -1.0), v3(1.0, 0.0, 0.0)];
    let triangles = [[0, 1, 2], [2, 1, 3]];
    for (vertices, class) in [(ridge, EDGE_CONVEX), (valley, EDGE_CONCAVE), (flat, EDGE_FLAT)] {
        let mesh = add_mesh(&mut w, &vertices, &triangles, MESH_FIX_EDGES);
        assert!(mesh >= 0);
        let t0 = w.uu(MESH_FIRST_TRIANGLE, mesh as usize) as usize;
        // Edge 1 of the first triangle (corner 1 to 2) is the shared one; the rest are open.
        assert_eq!(w.uu(TRIANGLE_EDGES, t0), class << 2, "first triangle");
        assert_eq!(w.uu(TRIANGLE_EDGES, t0 + 1), class, "second triangle");
    }
}

#[test]
fn a_mesh_with_bad_rows_is_refused() {
    let mut w = World::new(4, 4).unwrap();
    let vertices = [v3(0.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), v3(0.0, 0.0, 1.0)];
    assert!(w.begin_mesh(3, 1));
    let [_, v0, t0, _] = w.header().mesh_rows;
    for (i, &p) in vertices.iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 as usize + i, p);
    }
    for (column, value) in [(TRIANGLE_A, 0), (TRIANGLE_B, 1), (TRIANGLE_C, 3), (TRIANGLE_ACROSS_0, NONE), (TRIANGLE_ACROSS_1, NONE), (TRIANGLE_ACROSS_2, NONE)] {
        w.set_u(column, t0 as usize, value);
    }
    assert_eq!(w.end_mesh(3, 1, 0), MESH_BAD_INDEX);
    w.set_u(TRIANGLE_C, t0 as usize, 2);
    w.set_u(TRIANGLE_ACROSS_1, t0 as usize, 0);
    assert_eq!(w.end_mesh(3, 1, 0), MESH_BAD_ACROSS, "a triangle across from itself");
    assert_eq!(add_mesh(&mut w, &[v3(0.0, f32::NAN, 0.0), vertices[1], vertices[2]], &[[0, 1, 2]], 0), MESH_NOT_FINITE);
    assert_eq!(add_mesh(&mut w, &vertices, &[], 0), MESH_EMPTY);
    assert_eq!(add_mesh(&mut w, &vertices, &[[0, 2, 1]], 0), 0, "a refusal leaves the row free");
}

#[test]
fn the_ghost_rule_stands_snaps_and_skips_as_the_edges_say() {
    let corners = [v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 1.0), v3(1.0, 0.0, 0.0)];
    let up = v3(0.0, 1.0, 0.0);
    // Edge 2 runs from (1, 0, 0) back to the origin, along -x: its outward side is -z.
    let leaning = v3(0.0, 0.8, -0.6);
    let all = |class: u32| class | class << 2 | class << 4;
    assert_eq!(ghost_verdict(up, corners, up, all(EDGE_FLAT), [up; 3]), Verdict::Stand, "the face normal always stands");
    assert_eq!(ghost_verdict(leaning, corners, up, all(EDGE_FLAT), [up; 3]), Verdict::Snap, "a flat edge has no normal of its own");
    assert_eq!(ghost_verdict(leaning, corners, up, all(EDGE_CONCAVE), [up; 3]), Verdict::Snap);
    assert_eq!(ghost_verdict(leaning, corners, up, all(EDGE_OPEN), [up; 3]), Verdict::Stand, "an open edge is a real edge");
    // A convex edge whose neighbour slopes down at 45 degrees: 37 degrees off vertical is within the arc, 60 is past it.
    let slope = v3(0.0, 0.707_106_8, -0.707_106_8);
    assert_eq!(ghost_verdict(leaning, corners, up, all(EDGE_CONVEX), [slope; 3]), Verdict::Stand);
    assert_eq!(ghost_verdict(v3(0.0, 0.5, -0.866), corners, up, all(EDGE_CONVEX), [slope; 3]), Verdict::Skip);
    // From the back the same edge is concave.
    assert_eq!(ghost_verdict(v3(0.0, -0.8, -0.6), corners, up, all(EDGE_CONVEX), [slope; 3]), Verdict::Snap);
}

/// Slides a body across the grid at `speed` along x with no friction, and returns the variance of its x speed and the
/// largest of its y speed and spin over the run, after it has settled.
fn slide(shape: u32, size: [f32; 3], rest: f32, rotation: [f32; 4], flags: u32) -> (f32, f32, f32) {
    let (vertices, triangles) = grid(20, 1.0, |_, _| 0.0);
    slide_with(shape, size, rest, rotation, |w| add_mesh(w, &vertices, &triangles, flags))
}

/// `slide` on the ground `make` adds.
fn slide_with(shape: u32, size: [f32; 3], rest: f32, rotation: [f32; 4], make: impl Fn(&mut World) -> i32) -> (f32, f32, f32) {
    let mut w = World::new(4, 4).unwrap();
    let mesh = make(&mut w);
    let floor = ground(&mut w, mesh);
    w.set_s(COLLIDER_FRICTION, floor as usize, 0.0);
    let (body, collider) = turned(&mut w, shape, size, v3(-7.0, rest, 0.3), rotation);
    w.set_s(COLLIDER_FRICTION, collider as usize, 0.0);
    for _ in 0..30 {
        w.step(DT);
    }
    w.set_v(LINEAR_X, body as usize, v3(4.0, 0.0, 0.0));
    let (mut speeds, mut lift, mut spin) = (Vec::new(), 0.0f32, 0.0f32);
    for _ in 0..180 {
        w.step(DT);
        let (v, a) = (w.v(LINEAR_X, body as usize), w.v(ANGULAR_X, body as usize));
        speeds.push(v.x);
        lift = lift.max(v.y.abs());
        spin = spin.max(sqrt(a.dot(a)));
    }
    let mean = speeds.iter().sum::<f32>() / speeds.len() as f32;
    let variance = speeds.iter().map(|s| (s - mean) * (s - mean)).sum::<f32>() / speeds.len() as f32;
    (variance, lift, spin)
}

#[test]
fn a_ball_crosses_a_flat_mesh_with_its_speed_steady() {
    let (variance, lift, spin) = slide(SHAPE_BALL, [0.5, 0.0, 0.0], 0.5, [0.0, 0.0, 0.0, 1.0], MESH_FIX_EDGES);
    println!("ball: variance {variance:e}, lift {lift:e}, spin {spin:e}");
    assert!(variance < 1e-4, "speed variance {variance}");
    assert!(lift < 1e-2, "lift {lift}");
}

#[test]
fn a_box_slides_over_inner_edges_without_catching() {
    let (variance, lift, spin) = slide(SHAPE_BOX, [0.4, 0.25, 0.3], 0.25, [0.0, 0.0, 0.0, 1.0], MESH_FIX_EDGES);
    println!("box: variance {variance:e}, lift {lift:e}, spin {spin:e}");
    let (loose, loose_lift, loose_spin) = slide(SHAPE_BOX, [0.4, 0.25, 0.3], 0.25, [0.0, 0.0, 0.0, 1.0], 0);
    println!("box without the rule: variance {loose:e}, lift {loose_lift:e}, spin {loose_spin:e}");
    assert!(loose > 1e-2, "without the rule the box catches on the inner edges, which is what this test watches for");
    assert!(variance < 1e-4, "speed variance {variance}");
    assert!(lift < 1e-2, "lift {lift}");
    assert!(spin < 1e-2, "spin {spin}");
}

#[test]
fn a_capsule_slides_over_inner_edges_without_catching() {
    let (variance, lift, _) = slide(SHAPE_CAPSULE, [0.3, 0.4, 0.0], 0.3, [0.0, 0.0, 0.707_106_8, 0.707_106_8], MESH_FIX_EDGES);
    println!("capsule: variance {variance:e}, lift {lift:e}");
    assert!(variance < 1e-4, "speed variance {variance}");
    assert!(lift < 1e-2, "lift {lift}");
}

#[test]
fn a_box_in_a_corner_keeps_the_floor_and_the_wall() {
    // A floor and a wall at x = 1 meeting in a concave edge; gravity pulls the box down and into the wall.
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [5.0, -9.81, 0.0];
    let vertices = [v3(-3.0, 0.0, -3.0), v3(-3.0, 0.0, 3.0), v3(1.0, 0.0, -3.0), v3(1.0, 0.0, 3.0), v3(1.0, 4.0, -3.0), v3(1.0, 4.0, 3.0)];
    // Floor seen from above, wall seen from -x.
    let triangles = [[0, 1, 2], [2, 1, 3], [2, 3, 4], [4, 3, 5]];
    let mesh = add_mesh(&mut w, &vertices, &triangles, MESH_FIX_EDGES);
    ground(&mut w, mesh);
    let (body, _) = dynamic(&mut w, SHAPE_BOX, [0.5, 0.5, 0.5], v3(0.2, 0.7, 0.0));
    for _ in 0..240 {
        w.step(DT);
    }
    let p = w.v(POSITION_X, body as usize);
    let v = w.v(LINEAR_X, body as usize);
    println!("corner: {p:?}, speed {v:?}, parts {}", parts(&w));
    assert!((p.x - 0.5).abs() < 0.01 && (p.y - 0.5).abs() < 0.01, "rests at {p:?}");
    assert!(sqrt(v.dot(v)) < 0.01, "still moving at {v:?}");
    assert!(parts(&w) >= 2, "one part for the floor and one for the wall");
}

#[test]
fn parts_go_when_the_shape_leaves() {
    let mut w = World::new(4, 4).unwrap();
    let (vertices, triangles) = grid(4, 1.0, |_, _| 0.0);
    let mesh = add_mesh(&mut w, &vertices, &triangles, MESH_FIX_EDGES);
    ground(&mut w, mesh);
    let (body, _) = dynamic(&mut w, SHAPE_BOX, [0.6, 0.25, 0.6], v3(0.1, 0.25, 0.1));
    for _ in 0..30 {
        w.step(DT);
    }
    let touching = parts(&w);
    assert!(touching >= 2, "a box over several triangles has a part for each, found {touching}");
    // Lifted a little above the surface: within the fat box, so the pair stays, but no triangle touches.
    w.set_pose(body, v3(0.1, 1.5, 0.1), Q::IDENTITY, false);
    w.set_v(LINEAR_X, body as usize, v3(0.0, 0.0, 0.0));
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    w.step(DT);
    assert_eq!(parts(&w), 0, "parts with no points are freed");
    // Taken far away: the pair goes, and a pair row is reused.
    w.set_pose(body, v3(100.0, 0.0, 0.0), Q::IDENTITY, false);
    w.step(DT);
    assert_eq!(parts(&w), 0);
    assert_eq!(w.header().pairs, 0);
}

#[test]
fn a_box_rests_on_a_bumpy_mesh_as_on_brute_force() {
    // The tree's triangles against every triangle: the same parts with the same points.
    let bumps = |x: f32, z: f32| 0.05 * ((x * 1.7) as i32 % 3) as f32 + 0.03 * ((z * 2.3) as i32 % 2) as f32;
    let (vertices, triangles) = grid(12, 0.5, bumps);
    let mut seed = 99u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed % 10_000) as f32 / 10_000.0
    };
    for _ in 0..12 {
        let at = v3(next() * 4.0 - 2.0, 0.3 + next() * 0.1, next() * 4.0 - 2.0);
        let points = |w: &World| {
            let mut out: Vec<(u32, u32)> = (0..w.header().pair_rows as usize)
                .filter(|&r| w.uu(PAIR_A, r) != NONE && w.uu(PAIR_FLAGS, r) & PAIR_IS_PART != 0)
                .map(|r| (w.uu(PAIR_PART, r), w.uu(PAIR_CONTACTS, r)))
                .collect();
            out.sort();
            out
        };
        let mut tree = World::new(4, 4).unwrap();
        let mesh = add_mesh(&mut tree, &vertices, &triangles, 0);
        ground(&mut tree, mesh);
        dynamic(&mut tree, SHAPE_BOX, [0.4, 0.3, 0.35], at);
        tree.step(DT);
        // One mesh per triangle: no tree to cull with.
        let mut brute = World::new(4, 1024).unwrap();
        let fixed = brute.add_body(FIXED).unwrap();
        for tri in &triangles {
            let corners = [vertices[tri[0] as usize], vertices[tri[1] as usize], vertices[tri[2] as usize]];
            let mesh = add_mesh(&mut brute, &corners, &[[0, 1, 2]], 0);
            brute.add_collider(fixed, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], [0.0, 0.0, 0.0, 1.0], 0.0).unwrap();
        }
        dynamic(&mut brute, SHAPE_BOX, [0.4, 0.3, 0.35], at);
        brute.step(DT);
        let total = |list: &[(u32, u32)]| list.iter().map(|p| p.1).sum::<u32>();
        let (found, all) = (points(&tree), points(&brute));
        assert_eq!(found.len(), all.len(), "parts at {at:?}");
        assert_eq!(total(&found), total(&all), "points at {at:?}");
    }
}

/// A height field of `rows` by `columns` cells of `size` metres centred on the origin, heights from `height(row,
/// column)`, written as `end_grid` reads it: vertex r + (rows + 1) c at row r (along z) and column c (along x).
fn height_points(rows: u32, columns: u32, size: f32, height: &impl Fn(u32, u32) -> f32) -> Vec<V3> {
    let mut vertices = vec![v3(0.0, 0.0, 0.0); ((rows + 1) * (columns + 1)) as usize];
    for c in 0..=columns {
        for r in 0..=rows {
            let (x, z) = (c as f32 * size - columns as f32 * size / 2.0, r as f32 * size - rows as f32 * size / 2.0);
            vertices[(r + (rows + 1) * c) as usize] = v3(x, height(r, c), z);
        }
    }
    vertices
}

fn add_grid(w: &mut World, rows: u32, columns: u32, vertices: &[V3], flags: u32) -> i32 {
    assert!(w.begin_mesh(vertices.len() as u32, 0));
    let v0 = w.header().mesh_rows[1] as usize;
    for (i, &p) in vertices.iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 + i, p);
    }
    w.end_grid(rows, columns, flags)
}

/// The same cells as triangle rows, in the height field's order: cell r + rows c is triangles 2 (r + rows c) and the
/// next, split from (r + 1, c) to (r, c + 1).
fn height_triangles(rows: u32, columns: u32) -> Vec<[u32; 3]> {
    let at = |r: u32, c: u32| r + (rows + 1) * c;
    let mut triangles = Vec::new();
    for c in 0..columns {
        for r in 0..rows {
            triangles.push([at(r, c), at(r + 1, c), at(r, c + 1)]);
            triangles.push([at(r + 1, c), at(r + 1, c + 1), at(r, c + 1)]);
        }
    }
    triangles
}

/// Finds pairs and points without moving anything.
fn detect(w: &mut World) {
    w.broad_update(DT);
    w.narrow_phase(DT);
}

fn bumpy(r: u32, c: u32) -> f32 {
    0.11 * ((r * 7 + c * 3) % 5) as f32 - 0.07 * ((r * c) % 3) as f32
}

#[test]
fn a_height_field_has_the_triangles_and_neighbours_of_its_cells() {
    let (rows, columns) = (5, 7);
    let vertices = height_points(rows, columns, 0.5, &bumpy);
    let triangles = height_triangles(rows, columns);
    let links = across(&vertices, &triangles);
    let mut w = World::new(4, 4).unwrap();
    let mesh = add_grid(&mut w, rows, columns, &vertices, MESH_FIX_EDGES) as usize;
    assert_eq!(w.uu(MESH_COLUMNS, mesh), columns);
    for (t, tri) in triangles.iter().enumerate() {
        let corners = w.mesh_triangle(mesh, t as u32);
        assert_eq!(corners, [vertices[tri[0] as usize], vertices[tri[1] as usize], vertices[tri[2] as usize]], "triangle {t}");
        let n = corners[1].sub(corners[0]).cross(corners[2].sub(corners[0]));
        assert!(n.y > 0.0, "triangle {t} faces up");
        for k in 0..3 {
            assert_eq!(w.mesh_across(mesh, t as u32, k), links[t][k], "triangle {t} edge {k}: the one across by corner positions");
        }
    }
}

#[test]
fn a_height_field_meets_shapes_as_the_same_triangles_do() {
    // The grid's cells against the same triangles as rows with a tree: the same parts with the same points, bit for bit.
    let (rows, columns) = (8, 10);
    let vertices = height_points(rows, columns, 0.5, &bumpy);
    let triangles = height_triangles(rows, columns);
    let mut seed = 7u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed % 10_000) as f32 / 10_000.0
    };
    let shapes = [(SHAPE_BOX, [0.4, 0.3, 0.35]), (SHAPE_BALL, [0.3, 0.0, 0.0]), (SHAPE_CAPSULE, [0.2, 0.3, 0.0])];
    let mut touched = 0;
    for flags in [0, MESH_FIX_EDGES] {
        for n in 0..24 {
            let (shape, size) = shapes[n % 3];
            // Some over the edge of the grid, where cells run out.
            let at = v3(next() * 6.0 - 3.0, 0.2 + next() * 0.3, next() * 5.0 - 2.5);
            let turn = Q::from_rotation_vector(v3(0.6, 0.0, 0.8).scale(next() * 3.0));
            let contacts = |w: &World| {
                let mut out: Vec<(u32, u32, Vec<u32>)> = (0..w.header().pair_rows as usize)
                    .filter(|&r| w.uu(PAIR_A, r) != NONE && w.uu(PAIR_FLAGS, r) & PAIR_IS_PART != 0)
                    .map(|r| {
                        let count = w.uu(PAIR_CONTACTS, r);
                        let depths = (0..count as usize).map(|k| w.s(CONTACT_SEPARATION, r * MANIFOLD + k).to_bits()).collect();
                        (w.uu(PAIR_PART, r), count, depths)
                    })
                    .collect();
                out.sort();
                out
            };
            let mut grid = World::new(4, 4).unwrap();
            let field = add_grid(&mut grid, rows, columns, &vertices, flags);
            assert!(field >= 0);
            ground(&mut grid, field);
            let (body, _) = dynamic(&mut grid, shape, size, at);
            grid.set_pose(body, at, turn, false);
            detect(&mut grid);
            let mut tree = World::new(4, 4).unwrap();
            let mesh = add_mesh(&mut tree, &vertices, &triangles, flags);
            ground(&mut tree, mesh);
            let (body, _) = dynamic(&mut tree, shape, size, at);
            tree.set_pose(body, at, turn, false);
            detect(&mut tree);
            let found = contacts(&grid);
            touched += found.len();
            assert_eq!(found, contacts(&tree), "shape {shape} at {at:?}, flags {flags}");
        }
    }
    assert!(touched > 40, "most drops touch some triangles ({touched} parts)");
}

#[test]
fn a_height_field_that_is_not_a_grid_is_refused() {
    let mut w = World::new(4, 4).unwrap();
    let good = height_points(2, 3, 1.0, &|_, _| 0.0);
    assert_eq!(add_grid(&mut w, 0, 3, &good[..4], 0), MESH_EMPTY);
    let mut bad = good.clone();
    bad[(1 + 3) as usize].x += 0.25;
    assert_eq!(add_grid(&mut w, 2, 3, &bad, 0), MESH_BAD_GRID, "a column at two x");
    let mut bad = good.clone();
    for r in 0..3 {
        bad[(r + 3 * 2) as usize].x = bad[(r + 3) as usize].x;
    }
    assert_eq!(add_grid(&mut w, 2, 3, &bad, 0), MESH_BAD_GRID, "two columns at one x");
    let mut bad = good.clone();
    bad[5].y = f32::NAN;
    assert_eq!(add_grid(&mut w, 2, 3, &bad, 0), MESH_NOT_FINITE);
    assert!(add_grid(&mut w, 2, 3, &good, 0) >= 0, "and the good one is taken after the refusals");
}

/// Slides a body over a flat height field of 20 by 20 cells of a metre, as `slide` does on a mesh.
fn slide_on_field(shape: u32, size: [f32; 3], rest: f32, rotation: [f32; 4], flags: u32) -> (f32, f32, f32) {
    slide_with(shape, size, rest, rotation, |w| add_grid(w, 20, 20, &height_points(20, 20, 1.0, &|_, _| 0.0), flags))
}

#[test]
fn a_ball_and_a_box_cross_a_flat_height_field_with_their_speed_steady() {
    let (variance, lift, _) = slide_on_field(SHAPE_BALL, [0.5, 0.0, 0.0], 0.5, [0.0, 0.0, 0.0, 1.0], MESH_FIX_EDGES);
    println!("ball on a field: variance {variance:e}, lift {lift:e}");
    assert!(variance < 1e-4, "speed variance {variance}");
    assert!(lift < 1e-2, "lift {lift}");
    let (variance, lift, spin) = slide_on_field(SHAPE_BOX, [0.4, 0.25, 0.3], 0.25, [0.0, 0.0, 0.0, 1.0], MESH_FIX_EDGES);
    let (loose, _, _) = slide_on_field(SHAPE_BOX, [0.4, 0.25, 0.3], 0.25, [0.0, 0.0, 0.0, 1.0], 0);
    println!("box on a field: variance {variance:e}, lift {lift:e}, spin {spin:e}; without the rule {loose:e}");
    assert!(loose > 1e-2, "without the rule the box catches on the inner edges, which is what this test watches for");
    assert!(variance < 1e-4 && lift < 1e-2 && spin < 1e-2, "variance {variance}, lift {lift}, spin {spin}");
}

#[test]
fn a_shape_beside_a_height_field_touches_no_cell() {
    let mut w = World::new(4, 4).unwrap();
    let field = add_grid(&mut w, 4, 4, &height_points(4, 4, 1.0, &|_, _| 0.0), 0);
    ground(&mut w, field);
    // Within the field's fat box (2 m round, 0.04 m margin) but past its last column: no cell, no part.
    let (body, _) = dynamic(&mut w, SHAPE_BALL, [0.2, 0.0, 0.0], v3(2.23, 0.1, 0.0));
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    w.step(DT);
    assert_eq!(parts(&w), 0);
    // Over the last cell: it touches.
    w.set_pose(body, v3(1.9, 0.15, 0.0), Q::IDENTITY, false);
    w.step(DT);
    assert!(parts(&w) >= 1);
}
