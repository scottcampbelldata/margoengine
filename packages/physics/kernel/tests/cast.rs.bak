// Shape casts, point projections and overlaps: the GJK ray cast against closed forms and against a bisection of the GJK
// distance along the cast (the distance from a point moving on a line to a convex set is convex in time), and each walk
// (mesh tree, height field cells, voxel cells, compound children) against a brute force over every triangle or cell.
use margoengine_physics_kernel::cast::*;
use margoengine_physics_kernel::gjk::gjk;
use margoengine_physics_kernel::hull::{BoxData, box_poly};
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::query::Filter;
use margoengine_physics_kernel::sat::Pose;
use margoengine_physics_kernel::voxel::CELL_FILLED;
use margoengine_physics_kernel::world::{NONE, World};

const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const ALL: Filter = Filter { flags: 0, groups: u32::MAX, collider: NONE, body: NONE };
const ZERO: V3 = V3 { x: 0.0, y: 0.0, z: 0.0 };
const PLAIN: CastOptions = CastOptions { max: 50.0, target: 0.0, stop: true, geometry: true };

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
    fn turn(&mut self) -> Q {
        Q::from_rotation_vector(v3(self.range(-3.0, 3.0), self.range(-3.0, 3.0), self.range(-3.0, 3.0)))
    }
}

fn len(v: V3) -> f32 {
    sqrt(v.dot(v))
}

fn world() -> World {
    World::new(64, 256).unwrap()
}

fn fixed(w: &mut World, at: V3, q: Q) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.set_pose(body, at, q, false);
    body
}

fn moved(s: &Solid, by: V3) -> Solid {
    match *s {
        Solid::Round { p, q, r } => Solid::Round { p: p.add(by), q: q.add(by), r },
        Solid::Poly { poly, pose } => Solid::Poly { poly, pose: Pose { p: pose.p.add(by), q: pose.q } },
        Solid::Triangle([a, b, c]) => Solid::Triangle([a.add(by), b.add(by), c.add(by)]),
        Solid::Revolved { shape, border, pose } => Solid::Revolved { shape, border, pose: Pose { p: pose.p.add(by), q: pose.q } },
    }
}

fn distance(a: &Solid, b: &Solid) -> f32 {
    let d = gjk(a, b, ZERO, f32::INFINITY);
    if d.overlap { 0.0 } else { d.distance }
}

/// The first time `a` moving along `r` comes within `margin` of `b`: a golden-section search for the nearest approach,
/// then halving down to the first time inside the margin.
fn brute(a: &Solid, b: &Solid, r: V3, max: f32, margin: f32) -> Option<f32> {
    let at = |t: f32| distance(&moved(a, r.scale(t)), b);
    if at(0.0) <= margin {
        return Some(0.0);
    }
    let (mut lo, mut hi) = (0.0f32, max);
    let g = 0.618_034f32;
    for _ in 0..80 {
        let (m1, m2) = (hi - g * (hi - lo), lo + g * (hi - lo));
        if at(m1) < at(m2) { hi = m2 } else { lo = m1 }
    }
    if at(lo) > margin + 1e-5 {
        return None;
    }
    let (mut a0, mut b0) = (0.0f32, lo);
    for _ in 0..60 {
        let m = 0.5 * (a0 + b0);
        if at(m) <= margin { b0 = m } else { a0 = m }
    }
    Some(b0)
}

/// A random convex shape near the origin: a ball, a capsule, or a box (its numbers kept in `data`).
fn random_solid(rng: &mut Rng, data: &mut BoxData, at: V3) -> Solid {
    let q = rng.turn();
    match (rng.next() * 3.0) as u32 {
        0 => Solid::Round { p: at, q: at, r: rng.range(0.2, 1.0) },
        1 => {
            let along = q.rotate(v3(0.0, rng.range(0.1, 1.0), 0.0));
            Solid::Round { p: at.sub(along), q: at.add(along), r: rng.range(0.1, 0.6) }
        }
        _ => Solid::Poly { poly: box_poly(v3(rng.range(0.1, 1.0), rng.range(0.1, 1.0), rng.range(0.1, 1.0)), data), pose: Pose { p: at, q } },
    }
}

#[test]
fn a_ball_cast_at_a_ball_stops_where_the_sum_of_radii_says() {
    let (a, b) = (Solid::Round { p: v3(-5.0, 0.3, 0.0), q: v3(-5.0, 0.3, 0.0), r: 0.5 }, Solid::Round { p: ZERO, q: ZERO, r: 1.0 });
    let hit = cast_convex(&a, &b, v3(1.0, 0.0, 0.0), &PLAIN).unwrap();
    // Touch when the centres are 1.5 apart: x = -sqrt(1.5^2 - 0.3^2).
    let x = -sqrt(1.5 * 1.5 - 0.09);
    assert!((hit.t - (5.0 + x)).abs() < 1e-4, "{hit:?}");
    let n = v3(x, 0.3, 0.0).scale(1.0 / 1.5);
    assert!(len(hit.normal.sub(n)) < 1e-3 && len(hit.on_target.sub(n)) < 1e-3 && len(hit.on_query.sub(n)) < 1e-3, "{hit:?}");
    // A miss, a cast pointing away, and a cast too short.
    assert!(cast_convex(&a, &b, v3(0.0, 1.0, 0.0), &PLAIN).is_none());
    assert!(cast_convex(&a, &b, v3(-1.0, 0.0, 0.0), &PLAIN).is_none());
    assert!(cast_convex(&a, &b, v3(1.0, 0.0, 0.0), &CastOptions { max: 3.0, ..PLAIN }).is_none());
}

#[test]
fn a_box_cast_at_a_box_stops_on_the_face_and_short_by_the_target_distance() {
    let mut data = (BoxData::new(), BoxData::new());
    let a = Solid::Poly { poly: box_poly(v3(0.5, 0.5, 0.5), &mut data.0), pose: Pose { p: v3(0.0, 4.0, 0.0), q: Q::IDENTITY } };
    let b = Solid::Poly { poly: box_poly(v3(2.0, 1.0, 2.0), &mut data.1), pose: Pose { p: ZERO, q: Q::IDENTITY } };
    let down = v3(0.0, -1.0, 0.0);
    let hit = cast_convex(&a, &b, down, &PLAIN).unwrap();
    assert!((hit.t - 2.5).abs() < 1e-5 && len(hit.normal.sub(v3(0.0, 1.0, 0.0))) < 1e-5, "{hit:?}");
    assert!((hit.on_target.y - 1.0).abs() < 1e-5 && (hit.on_query.y - 1.0).abs() < 1e-5, "{hit:?}");
    let short = cast_convex(&a, &b, down, &CastOptions { target: 0.25, ..PLAIN }).unwrap();
    assert!((short.t - 2.25).abs() < 1e-4 && (short.on_query.y - short.on_target.y - 0.25).abs() < 1e-4, "{short:?}");
}

#[test]
fn random_convex_casts_meet_the_bisected_distance() {
    let mut rng = Rng(21);
    let mut hits = 0;
    for k in 0..1500 {
        let (mut da, mut db) = (BoxData::new(), BoxData::new());
        let start = v3(rng.range(-4.0, 4.0), rng.range(-4.0, 4.0), rng.range(-4.0, 4.0));
        let a = random_solid(&mut rng, &mut da, start);
        let b = random_solid(&mut rng, &mut db, ZERO);
        // A third aimed at the target, so most of those hit.
        let r = if k % 3 == 0 { ZERO.sub(start) } else { rng.unit() };
        let r = r.scale(1.0 / len(r));
        let margin = if k % 4 == 0 { 0.3 } else { 0.0 };
        let got = cast_convex(&a, &b, r, &CastOptions { max: 12.0, target: margin, ..PLAIN });
        let want = brute(&a, &b, r, 12.0, margin);
        match (got, want) {
            (Some(g), Some(w)) => {
                // GJK's distance is an upper bound that can stall a few 1e-5 above the truth near a touch, which shifts the bisected
                // time by up to 1e-3 where the cast comes in at a slant; the touch itself is held to 1e-4 below.
                assert!((g.t - w).abs() < 2e-3 * (1.0 + w), "case {k}: {g:?} against {w}");
                // GJK's distance is an upper bound that stalls up to about 1e-4 above a touch; the touching points
                // themselves must then sit the margin apart.
                let gap = distance(&moved(&a, r.scale(g.t)), &b);
                let apart = len(g.on_query.sub(g.on_target));
                assert!(gap <= margin + 1e-4 || (apart - margin).abs() < 1e-5, "case {k}: {gap} apart at the touch: {g:?}");
                if !g.started {
                    // The touching points sit `margin` apart, the normal is a unit one facing the cast.
                    assert!((len(g.on_query.sub(g.on_target)) - margin).abs() < 5e-3, "case {k}: {g:?}");
                    assert!((len(g.normal) - 1.0).abs() < 1e-4 && g.normal.dot(r) <= 1e-4, "case {k}: {g:?}");
                }
                hits += 1;
            }
            (None, None) => {}
            (g, w) => {
                // A graze: the nearest approach sits within rounding of the margin.
                let near = brute(&a, &b, r, 12.0, margin + 1e-3).is_some() && brute(&a, &b, r, 12.0, (margin - 1e-3).max(0.0)).is_none();
                assert!(near, "case {k}: {g:?} against {w:?}");
            }
        }
    }
    assert!(hits > 400, "too few hits to mean anything: {hits}");
}

/// A cylinder or cone of random size, half of them with a border.
fn random_revolved(rng: &mut Rng, at: V3) -> Solid {
    let shape = margoengine_physics_kernel::revolve::Revolved { cone: rng.next() < 0.5, r: rng.range(0.1, 1.0), h: rng.range(0.1, 1.0) };
    let border = if rng.next() < 0.5 { rng.range(0.02, 0.3) } else { 0.0 };
    Solid::Revolved { shape, border, pose: Pose { p: at, q: rng.turn() } }
}

#[test]
fn random_casts_with_cylinders_and_cones_meet_the_bisected_distance() {
    let mut rng = Rng(33);
    let mut hits = 0;
    for k in 0..1500 {
        let mut da = BoxData::new();
        let start = v3(rng.range(-4.0, 4.0), rng.range(-4.0, 4.0), rng.range(-4.0, 4.0));
        let a = if k % 2 == 0 { random_revolved(&mut rng, start) } else { random_solid(&mut rng, &mut da, start) };
        let b = random_revolved(&mut rng, ZERO);
        let r = if k % 3 == 0 { ZERO.sub(start) } else { rng.unit() };
        let r = r.scale(1.0 / len(r));
        let margin = if k % 4 == 0 { 0.3 } else { 0.0 };
        let got = cast_convex(&a, &b, r, &CastOptions { max: 12.0, target: margin, ..PLAIN });
        let want = brute(&a, &b, r, 12.0, margin);
        match (got, want) {
            (Some(g), Some(w)) => {
                assert!((g.t - w).abs() < 2e-3 * (1.0 + w), "case {k}: {g:?} against {w}");
                let gap = distance(&moved(&a, r.scale(g.t)), &b);
                let apart = len(g.on_query.sub(g.on_target));
                assert!(gap <= margin + 1e-4 || (apart - margin).abs() < 1e-5, "case {k}: {gap} apart at the touch: {g:?}");
                if !g.started {
                    assert!((len(g.on_query.sub(g.on_target)) - margin).abs() < 5e-3, "case {k}: {g:?}");
                    assert!((len(g.normal) - 1.0).abs() < 1e-4 && g.normal.dot(r) <= 1e-4, "case {k}: {g:?}");
                }
                hits += 1;
            }
            (None, None) => {}
            (g, w) => {
                let near = brute(&a, &b, r, 12.0, margin + 1e-3).is_some() && brute(&a, &b, r, 12.0, (margin - 1e-3).max(0.0)).is_none();
                assert!(near, "case {k}: {g:?} against {w:?}");
            }
        }
    }
    assert!(hits > 400, "too few hits to mean anything: {hits}");
}

#[test]
fn a_start_in_contact_hits_at_zero_unless_it_leaves_and_stop_is_off() {
    let (a, b) = (Solid::Round { p: v3(0.0, 1.2, 0.0), q: v3(0.0, 1.2, 0.0), r: 0.5 }, Solid::Round { p: ZERO, q: ZERO, r: 1.0 });
    let (up, down) = (v3(0.0, 1.0, 0.0), v3(0.0, -1.0, 0.0));
    let hit = cast_convex(&a, &b, up, &PLAIN).unwrap();
    assert!(hit.started && hit.t == 0.0 && len(hit.normal.sub(up)) < 1e-3, "{hit:?}");
    assert!(cast_convex(&a, &b, up, &CastOptions { stop: false, ..PLAIN }).is_none());
    let into = cast_convex(&a, &b, down, &CastOptions { stop: false, ..PLAIN }).unwrap();
    assert!(into.started && len(into.normal.sub(up)) < 1e-3, "{into:?}");
    // Without the geometry the normal and points stay zero.
    let bare = cast_convex(&a, &b, down, &CastOptions { geometry: false, ..PLAIN }).unwrap();
    assert!(bare.started && bare.normal == ZERO && bare.on_query == ZERO && bare.on_target == ZERO);
}

/// A bumpy mesh of `n` by `n` squares, and its triangles.
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
    (row, triangles.iter().map(|t| [vertices[t[0] as usize], vertices[t[1] as usize], vertices[t[2] as usize]]).collect())
}

fn height_field(w: &mut World) -> (i32, Vec<[V3; 3]>) {
    let (rows, columns) = (9u32, 13u32);
    let x = |c: u32| c as f32 + 0.04 * (c * c) as f32 - 7.0;
    let z = |r: u32| 1.3 * r as f32 - 5.0;
    let height = |r: u32, c: u32| 0.4 * ((r * 5 + c * 3) % 7) as f32 - 1.0;
    let mut vertices = vec![ZERO; ((rows + 1) * (columns + 1)) as usize];
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
    let at = |r: u32, c: u32| vertices[(r + (rows + 1) * c) as usize];
    let mut triangles = vec![];
    for c in 0..columns {
        for r in 0..rows {
            triangles.push([at(r, c), at(r + 1, c), at(r, c + 1)]);
            triangles.push([at(r + 1, c), at(r + 1, c + 1), at(r, c + 1)]);
        }
    }
    (mesh, triangles)
}

/// A random voxel grid and the centres of its filled cells.
fn voxels(w: &mut World, rng: &mut Rng, size: V3) -> (i32, Vec<V3>) {
    let (dims, min) = ([6u32, 4, 5], [-3i32, -1, -2]);
    let mut filled = vec![];
    assert!(w.begin_voxels(dims[0] * dims[1] * dims[2]));
    let first = w.header().mesh_rows[4] as usize;
    for index in 0..dims[0] * dims[1] * dims[2] {
        if rng.next() < 0.35 {
            let at = first + (index >> 2) as usize;
            w.set_u(VOXEL_WORD, at, w.uu(VOXEL_WORD, at) | CELL_FILLED << (8 * (index & 3)));
            let cell = [index % dims[0], (index / dims[0]) % dims[1], index / (dims[0] * dims[1])];
            filled.push(v3(
                ((min[0] + cell[0] as i32) as f32 + 0.5) * size.x,
                ((min[1] + cell[1] as i32) as f32 + 0.5) * size.y,
                ((min[2] + cell[2] as i32) as f32 + 0.5) * size.z,
            ));
        }
    }
    (w.end_voxels(min, dims, size), filled)
}

/// The nearest cast of `query` among `targets`, the brute force a walk must match.
fn nearest_cast(query: &Solid, targets: &[Solid], r: V3, o: &CastOptions) -> Option<Cast> {
    let mut best: Option<Cast> = None;
    for t in targets {
        if let Some(hit) = cast_convex(query, t, r, o)
            && best.is_none_or(|b| hit.t < b.t)
        {
            best = Some(hit);
        }
    }
    best
}

fn same_t(a: Option<Cast>, b: Option<Cast>, what: &str) {
    match (a, b) {
        (Some(a), Some(b)) => assert!((a.t - b.t).abs() <= 1e-4 * (1.0 + b.t), "{what}: {a:?} vs {b:?}"),
        (None, None) => {}
        _ => panic!("{what}: {a:?} vs {b:?}"),
    }
}

/// Casts of every query kind at a collider made of `targets`, the world's walk against the brute force.
fn walks(w: &World, c: usize, frame: Pose, targets: &[Solid], seed: u32, spread: f32) -> u32 {
    let mut rng = Rng(seed);
    let mut hits = 0;
    for k in 0..900 {
        let o = v3(rng.range(-spread, spread), rng.range(-4.0, 5.0), rng.range(-spread, spread));
        let r = if k % 4 == 0 { frame.q.rotate(v3(0.0, -1.0, 0.0)) } else { rng.unit() };
        let q = rng.turn();
        let shape = match k % 3 {
            0 => Shape { kind: SHAPE_BALL, size: v3(0.4, 0.0, 0.0), hull: 0 },
            1 => Shape { kind: SHAPE_CAPSULE, size: v3(0.25, 0.5, 0.0), hull: 0 },
            _ => Shape { kind: SHAPE_BOX, size: v3(0.3, 0.5, 0.2), hull: 0 },
        };
        let o2 = CastOptions { max: 20.0, target: if k % 5 == 0 { 0.1 } else { 0.0 }, ..PLAIN };
        let got = w.cast_collider(c, shape, Pose { p: o, q }, r, &o2);
        let mut data = BoxData::new();
        let local = w.solid(shape, frame.relative(Pose { p: o, q }), &mut data).unwrap();
        let want = nearest_cast(&local, targets, frame.q.unrotate(r), &o2);
        same_t(got, want, &format!("case {k}"));
        hits += got.is_some() as u32;
    }
    hits
}

#[test]
fn a_mesh_cast_through_its_tree_finds_the_brute_force_touch() {
    let mut w = world();
    let (mesh, triangles) = bumpy(&mut w, 16);
    let frame = Pose { p: v3(1.0, -2.0, 0.5), q: Q::from_rotation_vector(v3(0.3, -0.5, 0.2)) };
    let body = fixed(&mut w, frame.p, frame.q);
    let c = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize;
    let targets: Vec<Solid> = triangles.iter().map(|&t| Solid::Triangle(t)).collect();
    let hits = walks(&w, c, frame, &targets, 3, 9.0);
    assert!(hits > 250, "too few hits to mean anything: {hits}");
}

#[test]
fn a_height_field_cast_over_its_cells_finds_the_brute_force_touch() {
    let mut w = world();
    let (mesh, triangles) = height_field(&mut w);
    let body = fixed(&mut w, ZERO, Q::IDENTITY);
    let c = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize;
    let targets: Vec<Solid> = triangles.iter().map(|&t| Solid::Triangle(t)).collect();
    let hits = walks(&w, c, Pose { p: ZERO, q: Q::IDENTITY }, &targets, 5, 9.0);
    assert!(hits > 250, "too few hits to mean anything: {hits}");
}

#[test]
fn a_voxel_cast_over_its_cells_finds_the_brute_force_touch() {
    let mut w = world();
    let size = v3(0.5, 0.8, 0.6);
    let (mesh, filled) = voxels(&mut w, &mut Rng(9), size);
    let body = fixed(&mut w, ZERO, Q::IDENTITY);
    let c = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize;
    let mut data = BoxData::new();
    let poly = box_poly(size.scale(0.5), &mut data);
    let targets: Vec<Solid> = filled.iter().map(|&p| Solid::Poly { poly, pose: Pose { p, q: Q::IDENTITY } }).collect();
    let hits = walks(&w, c, Pose { p: ZERO, q: Q::IDENTITY }, &targets, 7, 3.0);
    assert!(hits > 250, "too few hits to mean anything: {hits}");
}

#[test]
fn points_project_onto_each_convex_shape_in_closed_form() {
    let mut rng = Rng(31);
    let mut data = BoxData::new();
    let h = v3(0.7, 0.4, 1.1);
    let pose = Pose { p: v3(0.5, -0.2, 0.3), q: rng.turn() };
    let boxed = Solid::Poly { poly: box_poly(h, &mut data), pose };
    let capsule = Solid::Round { p: v3(0.0, -0.6, 0.0), q: v3(0.0, 0.6, 0.0), r: 0.4 };
    for _ in 0..3000 {
        let p = v3(rng.range(-3.0, 3.0), rng.range(-3.0, 3.0), rng.range(-3.0, 3.0));
        // The box: clamp outside; inside, the nearest face.
        let local = pose.unapply(p);
        let clamped = local.max(h.scale(-1.0)).min(h);
        let inside = clamped == local;
        let hollow = project_convex(&boxed, p, false);
        assert_eq!(hollow.inside, inside);
        let want = if inside {
            let gaps = [h.x - local.x.abs(), h.y - local.y.abs(), h.z - local.z.abs()];
            let k = if gaps[0] <= gaps[1] && gaps[0] <= gaps[2] { 0 } else if gaps[1] <= gaps[2] { 1 } else { 2 };
            let mut q = [local.x, local.y, local.z];
            let hv = [h.x, h.y, h.z];
            q[k] = if q[k] < 0.0 { -hv[k] } else { hv[k] };
            pose.apply(v3(q[0], q[1], q[2]))
        } else {
            pose.apply(clamped)
        };
        assert!(len(hollow.point.sub(want)) < 1e-4, "box {p:?}: {hollow:?} against {want:?}");
        let solid = project_convex(&boxed, p, true);
        assert!(if inside { solid.point == p } else { len(solid.point.sub(want)) < 1e-4 });
        // The capsule: the nearest point of the segment, pushed out by the radius.
        let core = v3(0.0, p.y.clamp(-0.6, 0.6), 0.0);
        let want = core.add(p.sub(core).scale(0.4 / len(p.sub(core))));
        let got = project_convex(&capsule, p, false);
        assert!(len(got.point.sub(want)) < 1e-5 && got.inside == (len(p.sub(core)) <= 0.4), "capsule {p:?}: {got:?}");
    }
}

#[test]
fn points_project_onto_meshes_grids_and_voxels_as_the_brute_force_does() {
    let mut w = world();
    let (mesh, triangles) = bumpy(&mut w, 12);
    let (field, field_triangles) = height_field(&mut w);
    let size = v3(0.5, 0.8, 0.6);
    let (grid, filled) = voxels(&mut w, &mut Rng(9), size);
    let frame = Pose { p: v3(0.5, 1.0, -0.5), q: Q::from_rotation_vector(v3(0.2, 0.4, -0.1)) };
    let mut rows = vec![];
    for (row, at) in [(mesh, frame), (field, Pose { p: ZERO, q: Q::IDENTITY }), (grid, Pose { p: ZERO, q: Q::IDENTITY })] {
        let body = fixed(&mut w, at.p, at.q);
        rows.push(w.add_collider(body, SHAPE_TRIMESH, [row as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap() as usize);
    }
    let mut rng = Rng(41);
    let half = size.scale(0.5);
    for k in 0..1500 {
        let p = v3(rng.range(-6.0, 6.0), rng.range(-3.0, 3.0), rng.range(-6.0, 6.0));
        for (i, tris) in [(0, &triangles), (1, &field_triangles)] {
            let at = if i == 0 { frame } else { Pose { p: ZERO, q: Q::IDENTITY } };
            let got = w.project_collider(rows[i], p, true).unwrap();
            let mut best = f32::INFINITY;
            for &t in tris.iter() {
                let q = project_convex(&Solid::Triangle(t), at.unapply(p), false).point;
                best = best.min(len(q.sub(at.unapply(p))));
            }
            assert!(!got.inside && (len(got.point.sub(p)) - best).abs() < 1e-4, "case {k} mesh {i}: {got:?} against {best}");
        }
        // Voxels: inside a filled cell, solid gives the point, hollow the nearest point outside every filled cell.
        let p = v3(rng.range(-2.5, 2.5), rng.range(-1.5, 2.5), rng.range(-2.0, 2.5));
        let holds = filled.iter().any(|c| { let d = p.sub(*c).abs(); d.x <= half.x && d.y <= half.y && d.z <= half.z });
        let solid = w.project_collider(rows[2], p, true).unwrap();
        assert_eq!(solid.inside, holds, "case {k} voxels {p:?}");
        let hollow = w.project_collider(rows[2], p, false).unwrap();
        if holds {
            assert!(solid.point == p);
            let q = hollow.point;
            let on_edge = filled.iter().all(|c| { let d = q.sub(*c).abs(); d.x >= half.x - 1e-5 || d.y >= half.y - 1e-5 || d.z >= half.z - 1e-5 });
            assert!(on_edge, "case {k}: {hollow:?} is inside a filled cell");
        } else {
            let best = filled.iter().map(|c| len(p.sub(p.max(c.sub(half)).min(c.add(half))))).fold(f32::INFINITY, f32::min);
            assert!((len(hollow.point.sub(p)) - best).abs() < 1e-5, "case {k} voxels {p:?}: {hollow:?} against {best}");
        }
    }
}

#[test]
fn the_world_picks_the_nearest_collider_and_overlaps_follow_gjk() {
    let mut w = world();
    let a = fixed(&mut w, v3(-3.0, 0.0, 0.0), Q::IDENTITY);
    let ball = w.add_collider(a, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    let b = fixed(&mut w, v3(3.0, 0.0, 0.0), Q::from_rotation_vector(v3(0.0, 0.7, 0.0)));
    let cube = w.add_collider(b, SHAPE_BOX, [1.0, 1.0, 1.0], [0.0; 3], ID, 1.0).unwrap();
    let probe = Shape { kind: SHAPE_BALL, size: v3(0.5, 0.0, 0.0), hull: 0 };
    let from = Pose { p: v3(0.0, 0.0, 0.0), q: Q::IDENTITY };
    let (c, hit) = w.cast_shape(probe, from, v3(-1.0, 0.0, 0.0), &PLAIN, &ALL).unwrap();
    assert!(c == ball && (hit.t - 1.5).abs() < 1e-4, "{c} {hit:?}");
    let leave_ball = Filter { collider: ball, ..ALL };
    assert_eq!(w.cast_shape(probe, from, v3(-1.0, 0.0, 0.0), &PLAIN, &leave_ball).map(|h| h.0), None);
    assert_eq!(w.cast_shape(probe, from, v3(1.0, 0.0, 0.0), &PLAIN, &ALL).map(|h| h.0), Some(cube));
    let (c, p) = w.project_point(v3(-0.5, 0.0, 0.0), true, &ALL).unwrap();
    assert!(c == ball && len(p.point.sub(v3(-2.0, 0.0, 0.0))) < 1e-5 && !p.inside);
    assert!(w.holds_point(ball as usize, v3(-3.5, 0.2, 0.0)) && !w.holds_point(cube as usize, v3(-3.5, 0.2, 0.0)));
    let mut rng = Rng(51);
    for _ in 0..2000 {
        let pose = Pose { p: v3(rng.range(-6.0, 6.0), rng.range(-2.5, 2.5), rng.range(-2.5, 2.5)), q: rng.turn() };
        let shape = Shape { kind: SHAPE_CAPSULE, size: v3(0.3, 0.6, 0.0), hull: 0 };
        let mut d = (BoxData::new(), BoxData::new());
        let query = w.solid(shape, pose, &mut d.0).unwrap();
        for (c, target) in [(ball, Solid::Round { p: v3(-3.0, 0.0, 0.0), q: v3(-3.0, 0.0, 0.0), r: 1.0 }), (cube, Solid::Poly { poly: box_poly(v3(1.0, 1.0, 1.0), &mut d.1), pose: w.collider_pose(cube as usize) })] {
            let gap = distance(&query, &target);
            if gap > 1e-4 || gap == 0.0 {
                assert_eq!(w.overlaps(c as usize, shape, pose), gap == 0.0, "{pose:?}");
            }
        }
    }
}
