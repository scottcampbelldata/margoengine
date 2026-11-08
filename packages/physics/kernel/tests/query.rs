// Rays: closed forms on the convex shapes, and each walk (mesh tree, height field cells, voxel cells, compound
// children, the world's filter) against a brute force over every triangle, cell or collider on random rays.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::query::*;
use margoengine_physics_kernel::voxel::CELL_FILLED;
use margoengine_physics_kernel::world::{NONE, World};

const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const ALL: Filter = Filter { flags: 0, groups: u32::MAX, collider: NONE, body: NONE };

/// A small deterministic generator (xorshift32) so the random scenes are the same on every run.
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.next()
    }
    fn unit(&mut self) -> V3 {
        loop {
            let v = v3(self.range(-1.0, 1.0), self.range(-1.0, 1.0), self.range(-1.0, 1.0));
            let l = v.dot(v);
            if l > 1e-4 && l <= 1.0 {
                return v.scale(1.0 / sqrt(l));
            }
        }
    }
}

fn close(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol * (1.0 + a.abs().max(b.abs()))
}

fn near_v(a: V3, b: V3, tol: f32) -> bool {
    close(a.x, b.x, tol) && close(a.y, b.y, tol) && close(a.z, b.z, tol)
}

fn world() -> World {
    World::new(64, 256).unwrap()
}

fn fixed(w: &mut World, at: V3, q: Q) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.set_pose(body, at, q, false);
    body
}

#[test]
fn a_ball_is_hit_where_the_quadratic_says() {
    let (x, y) = (v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0));
    assert_eq!(ray_ball(v3(-5.0, 0.0, 0.0), x, 1.0, 100.0, true), Some(RayHit { t: 4.0, normal: v3(-1.0, 0.0, 0.0) }));
    // A graze touches once; a ray that points away or stops short misses.
    let graze = ray_ball(v3(-5.0, 1.0, 0.0), x, 1.0, 100.0, true).unwrap();
    assert!(close(graze.t, 5.0, 1e-6) && near_v(graze.normal, y, 1e-6));
    assert_eq!(ray_ball(v3(5.0, 0.0, 0.0), x, 1.0, 100.0, true), None);
    assert_eq!(ray_ball(v3(-5.0, 0.0, 0.0), x, 1.0, 3.9, true), None);
    // Inside: a solid ball is hit at 0 with no normal; a hollow one where the ray leaves, the normal facing the ray.
    assert_eq!(ray_ball(v3(0.2, 0.0, 0.0), x, 1.0, 100.0, true), Some(RayHit { t: 0.0, normal: v3(0.0, 0.0, 0.0) }));
    let out = ray_ball(v3(0.2, 0.0, 0.0), x, 1.0, 100.0, false).unwrap();
    assert!(close(out.t, 0.8, 1e-6) && near_v(out.normal, v3(-1.0, 0.0, 0.0), 1e-6));
}

#[test]
fn a_box_is_hit_by_its_slabs_even_along_minus_zero() {
    let h = v3(1.0, 2.0, 3.0);
    assert_eq!(ray_box(v3(-5.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), h, 100.0, true), Some(RayHit { t: 4.0, normal: v3(-1.0, 0.0, 0.0) }));
    assert_eq!(ray_box(v3(0.0, 0.0, 9.0), v3(-0.0, -0.0, -1.0), h, 100.0, true), Some(RayHit { t: 6.0, normal: v3(0.0, 0.0, 1.0) }));
    assert_eq!(ray_box(v3(-5.0, 2.5, 0.0), v3(1.0, 0.0, 0.0), h, 100.0, true), None);
    assert_eq!(ray_box(v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), h, 100.0, true), Some(RayHit { t: 0.0, normal: v3(0.0, 0.0, 0.0) }));
    assert_eq!(ray_box(v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), h, 100.0, false), Some(RayHit { t: 2.0, normal: v3(0.0, -1.0, 0.0) }));
}

#[test]
fn a_capsule_is_hit_on_its_side_and_its_ends() {
    let (h, r) = (1.0, 0.5);
    let side = ray_capsule(v3(-5.0, 0.3, 0.0), v3(1.0, 0.0, 0.0), h, r, 100.0, true).unwrap();
    assert!(close(side.t, 4.5, 1e-6) && near_v(side.normal, v3(-1.0, 0.0, 0.0), 1e-6));
    let top = ray_capsule(v3(0.0, 5.0, 0.0), v3(0.0, -1.0, 0.0), h, r, 100.0, true).unwrap();
    assert!(close(top.t, 3.5, 1e-6) && near_v(top.normal, v3(0.0, 1.0, 0.0), 1e-6));
    let along = ray_capsule(v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), h, r, 100.0, false).unwrap();
    assert!(close(along.t, 1.5, 1e-6) && near_v(along.normal, v3(0.0, -1.0, 0.0), 1e-6));
    // Against the brute force of its parts: the nearest entry of the two balls and the clipped side.
    let mut rng = Rng(7);
    for _ in 0..4000 {
        let o = v3(rng.range(-3.0, 3.0), rng.range(-3.0, 3.0), rng.range(-3.0, 3.0));
        let d = rng.unit();
        let hit = ray_capsule(o, d, h, r, 100.0, true);
        // Sample the segment of the ray finely: the first sample inside the capsule bounds the hit from above.
        let inside = |p: V3| {
            let y = p.y.clamp(-h, h);
            let q = p.sub(v3(0.0, y, 0.0));
            q.dot(q) <= r * r
        };
        let mut first = None;
        for i in 0..=20000 {
            let t = i as f32 * 0.0005;
            if inside(o.add(d.scale(t))) {
                first = Some(t);
                break;
            }
        }
        match (hit, first) {
            (Some(hit), Some(t)) => assert!(hit.t <= t + 1e-4 && hit.t >= t - 0.0006, "{o:?} {d:?}: {} vs {t}", hit.t),
            (None, None) => {}
            (Some(hit), None) => assert!(hit.t > 9.99 || inside(o.add(d.scale(hit.t))), "{o:?} {d:?}: hit {} not on the capsule", hit.t),
            (None, Some(t)) => panic!("{o:?} {d:?}: missed, but {t} is inside"),
        }
    }
}

/// A box of half extents `h` as hull rows.
fn box_hull(w: &mut World, h: V3) -> i32 {
    let mut vertices = vec![];
    for i in 0..8 {
        vertices.push([if i & 1 != 0 { h.x } else { -h.x }, if i & 2 != 0 { h.y } else { -h.y }, if i & 4 != 0 { h.z } else { -h.z }]);
    }
    let faces: [&[u32]; 6] = [&[1, 3, 7, 5], &[0, 4, 6, 2], &[2, 6, 7, 3], &[0, 1, 5, 4], &[4, 5, 7, 6], &[0, 2, 3, 1]];
    w.add_hull(&vertices, &faces)
}

#[test]
fn a_hull_is_hit_as_the_box_it_is() {
    let mut w = world();
    let h = v3(0.7, 0.4, 1.1);
    let hull = box_hull(&mut w, h);
    assert!(hull >= 0);
    let poly = w.hull_poly(hull as usize);
    let mut rng = Rng(11);
    for _ in 0..4000 {
        let o = v3(rng.range(-3.0, 3.0), rng.range(-3.0, 3.0), rng.range(-3.0, 3.0));
        let d = rng.unit();
        for solid in [true, false] {
            let (a, b) = (ray_poly(&poly, o, d, 100.0, solid), ray_box(o, d, h, 100.0, solid));
            match (a, b) {
                (Some(a), Some(b)) => assert!(close(a.t, b.t, 1e-5) && near_v(a.normal, b.normal, 1e-5), "{o:?} {d:?}: {a:?} vs {b:?}"),
                (None, None) => {}
                _ => panic!("{o:?} {d:?}: {a:?} vs {b:?}"),
            }
        }
    }
}

/// A bumpy mesh of `n` by `n` squares as triangle rows, and its triangles.
fn bumpy(w: &mut World, n: u32) -> (i32, Vec<[V3; 3]>) {
    let mut vertices = vec![];
    for j in 0..=n {
        for i in 0..=n {
            let (x, z) = (i as f32 - n as f32 / 2.0, j as f32 - n as f32 / 2.0);
            vertices.push(v3(x, 0.3 * ((i * 7 + j * 3) % 5) as f32, z));
        }
    }
    let mut triangles = vec![];
    for j in 0..n {
        for i in 0..n {
            let a = i + (n + 1) * j;
            triangles.push([a, a + 1, a + n + 1]);
            triangles.push([a + 1, a + n + 2, a + n + 1]);
        }
    }
    assert!(w.begin_mesh(vertices.len() as u32, triangles.len() as u32));
    let [_, v0, t0, _, _] = w.header().mesh_rows;
    for (i, &p) in vertices.iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 as usize + i, p);
    }
    for (i, tri) in triangles.iter().enumerate() {
        let at = t0 as usize + i;
        w.set_u(TRIANGLE_A, at, tri[0]);
        w.set_u(TRIANGLE_B, at, tri[1]);
        w.set_u(TRIANGLE_C, at, tri[2]);
        for k in 0..3 {
            w.set_u(TRIANGLE_ACROSS_0 + k, at, NONE);
        }
    }
    let row = w.end_mesh(vertices.len() as u32, triangles.len() as u32, 0);
    let corners = triangles.iter().map(|t| [vertices[t[0] as usize], vertices[t[1] as usize], vertices[t[2] as usize]]).collect();
    (row, corners)
}

fn nearest(o: V3, d: V3, triangles: &[[V3; 3]], max: f32) -> Option<RayHit> {
    let mut best: Option<RayHit> = None;
    for &t in triangles {
        if let Some(hit) = ray_triangle(o, d, t, max)
            && best.is_none_or(|b| hit.t < b.t)
        {
            best = Some(hit);
        }
    }
    best
}

fn same(a: Option<RayHit>, b: Option<RayHit>, what: &str) {
    match (a, b) {
        (Some(a), Some(b)) => assert!(close(a.t, b.t, 1e-5), "{what}: {a:?} vs {b:?}"),
        (None, None) => {}
        _ => panic!("{what}: {a:?} vs {b:?}"),
    }
}

#[test]
fn a_mesh_ray_through_its_tree_finds_the_brute_force_hit() {
    let mut w = world();
    let (mesh, triangles) = bumpy(&mut w, 24);
    assert!(mesh >= 0);
    let q = Q::from_rotation_vector(v3(0.3, -0.5, 0.2));
    let at = v3(1.0, -2.0, 0.5);
    let body = fixed(&mut w, at, q);
    let c = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize;
    let mut rng = Rng(3);
    let mut hits = 0;
    for _ in 0..3000 {
        let o = v3(rng.range(-15.0, 15.0), rng.range(-6.0, 6.0), rng.range(-15.0, 15.0));
        let d = rng.unit();
        let got = w.ray_collider(c, o, d, 40.0, true);
        let local = nearest(q.unrotate(o.sub(at)), q.unrotate(d), &triangles, 40.0);
        same(got, local, "mesh");
        if let (Some(g), Some(l)) = (got, local) {
            assert!(near_v(g.normal, q.rotate(l.normal), 1e-4) && g.normal.dot(d) <= 0.0);
            hits += 1;
        }
    }
    assert!(hits > 300, "too few hits to mean anything: {hits}");
}

#[test]
fn a_height_field_ray_walks_its_cells_to_the_brute_force_hit() {
    let mut w = world();
    let (rows, columns) = (9u32, 13u32);
    // Uneven spacing: columns and rows need only rise.
    let x = |c: u32| c as f32 + 0.04 * (c * c) as f32 - 7.0;
    let z = |r: u32| 1.3 * r as f32 - 5.0;
    let height = |r: u32, c: u32| 0.4 * ((r * 5 + c * 3) % 7) as f32 - 1.0;
    let mut vertices = vec![v3(0.0, 0.0, 0.0); ((rows + 1) * (columns + 1)) as usize];
    for c in 0..=columns {
        for r in 0..=rows {
            vertices[(r + (rows + 1) * c) as usize] = v3(x(c), height(r, c), z(r));
        }
    }
    assert!(w.begin_mesh(vertices.len() as u32, 0));
    let v0 = w.header().mesh_rows[1] as usize;
    for (i, &p) in vertices.iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 + i, p);
    }
    let mesh = w.end_grid(rows, columns, 0);
    assert!(mesh >= 0);
    let mut triangles = vec![];
    let at = |r: u32, c: u32| vertices[(r + (rows + 1) * c) as usize];
    for c in 0..columns {
        for r in 0..rows {
            triangles.push([at(r, c), at(r + 1, c), at(r, c + 1)]);
            triangles.push([at(r + 1, c), at(r + 1, c + 1), at(r, c + 1)]);
        }
    }
    let body = fixed(&mut w, v3(0.0, 0.0, 0.0), Q::IDENTITY);
    let c = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize;
    let mut rng = Rng(5);
    let mut hits = 0;
    for k in 0..4000 {
        let o = v3(rng.range(-12.0, 12.0), rng.range(-4.0, 4.0), rng.range(-10.0, 10.0));
        // Some rays straight down, along an axis, and from a cell boundary.
        let d = match k % 5 {
            0 => v3(0.0, -1.0, 0.0),
            1 => v3(-1.0, 0.0, 0.0),
            _ => rng.unit(),
        };
        let o = if k % 7 == 0 { v3(x(k % columns), o.y, z(k % rows)) } else { o };
        let got = w.ray_collider(c, o, d, 30.0, true);
        same(got, nearest(o, d, &triangles, 30.0), &format!("height field {o:?} {d:?}"));
        hits += got.is_some() as u32;
    }
    assert!(hits > 400, "too few hits to mean anything: {hits}");
}

#[test]
fn a_voxel_ray_walks_its_cells_to_the_brute_force_hit() {
    let mut w = world();
    let (dims, min, size) = ([6u32, 4, 5], [-3i32, -1, -2], v3(0.5, 0.8, 0.6));
    let mut rng = Rng(9);
    let mut filled = vec![];
    assert!(w.begin_voxels(dims[0] * dims[1] * dims[2]));
    let first = w.header().mesh_rows[4] as usize;
    for index in 0..dims[0] * dims[1] * dims[2] {
        if rng.next() < 0.35 {
            let at = first + (index >> 2) as usize;
            w.set_u(VOXEL_WORD, at, w.uu(VOXEL_WORD, at) | CELL_FILLED << (8 * (index & 3)));
            let cell = [index % dims[0], (index / dims[0]) % dims[1], index / (dims[0] * dims[1])];
            filled.push(v3(
                (min[0] + cell[0] as i32) as f32 * size.x + 0.5 * size.x,
                (min[1] + cell[1] as i32) as f32 * size.y + 0.5 * size.y,
                (min[2] + cell[2] as i32) as f32 * size.z + 0.5 * size.z,
            ));
        }
    }
    let mesh = w.end_voxels(min, dims, size);
    assert!(mesh >= 0);
    let body = fixed(&mut w, v3(0.0, 0.0, 0.0), Q::IDENTITY);
    let c = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize;
    let half = size.scale(0.5);
    let mut hits = 0;
    for _ in 0..4000 {
        let o = v3(rng.range(-3.0, 3.0), rng.range(-2.0, 3.0), rng.range(-3.0, 3.0));
        let d = rng.unit();
        let got = w.ray_collider(c, o, d, 20.0, true);
        // Brute force: the nearest of every filled cell as a box; a start inside any is a hit at 0.
        let mut best: Option<RayHit> = None;
        for &center in &filled {
            if let Some(hit) = ray_box(o.sub(center), d, half, 20.0, true)
                && best.is_none_or(|b| hit.t < b.t)
            {
                best = Some(hit);
            }
        }
        same(got, best, &format!("voxels {o:?} {d:?}"));
        if let (Some(g), Some(b)) = (got, best)
            && b.t > 1e-3
        {
            // A face shared by two filled cells is never hit, so the normal is the one face's.
            assert!(near_v(g.normal, b.normal, 1e-5), "voxels {o:?} {d:?}: {g:?} vs {b:?}");
        }
        hits += got.is_some() as u32;
    }
    assert!(hits > 400, "too few hits to mean anything: {hits}");
}

#[test]
fn a_compound_is_hit_on_its_nearest_child_and_the_filter_picks_colliders() {
    let mut w = world();
    let body = fixed(&mut w, v3(0.0, 0.0, 0.0), Q::IDENTITY);
    let compound = w.add_collider(body, SHAPE_COMPOUND, [0.0; 3], [0.0; 3], ID, 1.0).unwrap();
    w.add_compound_part(compound, SHAPE_BALL, [0.5, 0.0, 0.0], [-2.0, 0.0, 0.0], ID).unwrap();
    w.add_compound_part(compound, SHAPE_BOX, [0.5, 0.5, 0.5], [2.0, 0.0, 0.0], ID).unwrap();
    let hit = w.ray_collider(compound as usize, v3(-10.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), 100.0, true).unwrap();
    assert!(close(hit.t, 7.5, 1e-6));
    let back = w.ray_collider(compound as usize, v3(10.0, 0.0, 0.0), v3(-1.0, 0.0, 0.0), 100.0, true).unwrap();
    assert!(close(back.t, 7.5, 1e-6) && near_v(back.normal, v3(1.0, 0.0, 0.0), 1e-6));
    // A dynamic sensor ball behind a fixed box on the same line; the world ray takes the nearest one it may see.
    let dynamic = w.add_body(DYNAMIC).unwrap();
    w.set_pose(dynamic, v3(-5.0, 0.0, 0.0), Q::IDENTITY, false);
    let sensor = w.add_collider(dynamic, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    w.set_u(COLLIDER_FLAGS, sensor as usize, COLLIDER_SENSOR);
    let ray = |w: &World, flags: u32| w.cast_ray(v3(-10.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), 100.0, true, &Filter { flags, ..ALL }).map(|(c, hit)| (c, hit.t));
    assert_eq!(ray(&w, 0), Some((sensor, 4.5)));
    assert_eq!(ray(&w, EXCLUDE_SENSORS), Some((compound, 7.5)));
    assert_eq!(ray(&w, EXCLUDE_DYNAMIC), Some((compound, 7.5)));
    assert_eq!(ray(&w, ONLY_DYNAMIC), Some((sensor, 4.5)));
    assert_eq!(ray(&w, ONLY_KINEMATIC), None);
    assert_eq!(ray(&w, EXCLUDE_SOLIDS), Some((sensor, 4.5)));
    assert_eq!(ray(&w, EXCLUDE_FIXED | EXCLUDE_SENSORS), None);
    let excluded = |w: &World, filter: Filter| w.cast_ray(v3(-10.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), 100.0, true, &filter).map(|(c, _)| c);
    assert_eq!(excluded(&w, Filter { body: dynamic, ..ALL }), Some(compound));
    assert_eq!(excluded(&w, Filter { collider: sensor, ..ALL }), Some(compound));
    // Groups: membership in the top 16 bits, filter in the low 16, both ways.
    w.set_u(COLLIDER_GROUPS, sensor as usize, (2 << 16) | 0xffff);
    assert_eq!(excluded(&w, Filter { groups: (1 << 16) | 1, ..ALL }), Some(compound));
    assert_eq!(excluded(&w, Filter { groups: (1 << 16) | 2, ..ALL }), Some(sensor));
    w.set_u(COLLIDER_FLAGS, sensor as usize, COLLIDER_SENSOR | COLLIDER_OFF);
    assert_eq!(excluded(&w, ALL), Some(compound));
}

#[test]
fn a_voxel_ray_from_a_cell_face_counts_as_inside_the_cell_it_runs_into() {
    // Cell 0 filled, cell 1 empty; a ray from the face between them back into cell 0 starts on its surface, which a
    // convex shape counts as inside: a solid start is a hit at 0, a hollow one where it leaves cell 0.
    let mut w = world();
    assert!(w.begin_voxels(2));
    let first = w.header().mesh_rows[4] as usize;
    w.set_u(VOXEL_WORD, first, CELL_FILLED);
    let mesh = w.end_voxels([0, 0, 0], [2, 1, 1], v3(1.0, 1.0, 1.0));
    let body = fixed(&mut w, v3(0.0, 0.0, 0.0), Q::IDENTITY);
    let c = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize;
    let (o, back) = (v3(1.0, 0.5, 0.5), v3(-1.0, 0.0, 0.0));
    assert_eq!(w.ray_collider(c, o, back, 10.0, true), Some(RayHit { t: 0.0, normal: v3(0.0, 0.0, 0.0) }));
    assert_eq!(w.ray_collider(c, o, back, 10.0, false), Some(RayHit { t: 1.0, normal: v3(1.0, 0.0, 0.0) }));
    // The same as a box of that cell does.
    assert_eq!(ray_box(o.sub(v3(0.5, 0.5, 0.5)), back, v3(0.5, 0.5, 0.5), 10.0, false), Some(RayHit { t: 1.0, normal: v3(1.0, 0.0, 0.0) }));
}

#[test]
fn a_far_or_grazing_ray_meets_a_ball_and_a_capsule_to_float_precision() {
    // The textbook quadratic squares before it subtracts and loses a small ball far away (Haines et al. 2019 miss a
    // unit ball at 4,100 radii); the distance from the centre to the line keeps it. Checked against f64.
    let reference = |o: V3, d: V3, r: f64| {
        let (o, d) = ([o.x as f64, o.y as f64, o.z as f64], [d.x as f64, d.y as f64, d.z as f64]);
        let b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
        let a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        let c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
        let disc = b * b - a * c;
        if disc < 0.0 { None } else { Some((-b - disc.sqrt()) / a) }
    };
    let hit = ray_ball(v3(-4100.0, 0.5, 0.0), v3(1.0, 0.0, 0.0), 1.0, 1e9, true).expect("the far ball");
    assert!((hit.t as f64 - (4100.0 - 0.75f64.sqrt())).abs() < 1e-3, "{}", hit.t);
    let mut rng = Rng(21);
    for _ in 0..4000 {
        let far = rng.range(5.0, 3000.0);
        let d = rng.unit();
        // Aim at a point inside the ball, near its rim, from `far` away.
        let aim = rng.unit().scale(rng.range(0.9, 0.9999));
        let o = aim.sub(d.scale(far));
        let (got, want) = (ray_ball(o, d, 1.0, 1e9, true), reference(o, d, 1.0));
        let (got, want) = (got.expect("aimed inside, so a hit"), want.unwrap());
        assert!((got.t as f64 - want).abs() <= 2e-6 * far as f64 + 1e-5, "far {far}: {} against {want}", got.t);
        // The capsule's side is the same circle in its section.
        let flat = |v: V3| v3(v.x, 0.0, v.z);
        if flat(d).dot(flat(d)) > 0.25
            && let Some(side) = ray_capsule(v3(o.x, 0.0, o.z), d, 1e6, 1.0, 1e9, true)
            && let Some(want) = reference(flat(o), flat(d), 1.0)
        {
            assert!((side.t as f64 - want).abs() <= 2e-6 * far as f64 + 1e-5, "side, far {far}: {} against {want}", side.t);
        }
    }
}
