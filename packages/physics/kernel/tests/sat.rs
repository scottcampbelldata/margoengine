// Polyhedra and their manifolds, against closed forms and against a brute force over every axis.
use margoengine_physics_kernel::hull::*;
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::narrow::*;
use margoengine_physics_kernel::sat::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

struct Random(u32);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    fn range(&mut self, low: f32, high: f32) -> f32 {
        low + (high - low) * (self.next() >> 8) as f32 / 16_777_216.0
    }
    fn turn(&mut self) -> Q {
        Q { x: self.range(-1.0, 1.0), y: self.range(-1.0, 1.0), z: self.range(-1.0, 1.0), w: self.range(-1.0, 1.0) }.normalized()
    }
}

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose { p: v3(x, y, z), q: Q::IDENTITY }
}
fn turn_y(degrees: f32) -> Q {
    Q::from_rotation_vector(v3(0.0, degrees.to_radians(), 0.0))
}

const CUBE: [[f32; 3]; 8] = [
    [-1.0, -1.0, -1.0],
    [1.0, -1.0, -1.0],
    [-1.0, 1.0, -1.0],
    [1.0, 1.0, -1.0],
    [-1.0, -1.0, 1.0],
    [1.0, -1.0, 1.0],
    [-1.0, 1.0, 1.0],
    [1.0, 1.0, 1.0],
];
const CUBE_FACES: [&[u32]; 6] = [&[1, 3, 7, 5], &[0, 4, 6, 2], &[2, 6, 7, 3], &[0, 1, 5, 4], &[4, 5, 7, 6], &[0, 2, 3, 1]];
const TETRA: [[f32; 3]; 4] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
const TETRA_FACES: [&[u32]; 4] = [&[0, 2, 1], &[0, 1, 3], &[0, 3, 2], &[1, 2, 3]];
const OCTA: [[f32; 3]; 6] = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];
const OCTA_FACES: [&[u32]; 8] =
    [&[0, 2, 4], &[2, 1, 4], &[1, 3, 4], &[3, 0, 4], &[2, 0, 5], &[1, 2, 5], &[3, 1, 5], &[0, 3, 5]];

#[test]
fn every_box_edge_has_a_twin_on_another_face() {
    let mut data = BoxData::new();
    let poly = box_poly(v3(1.0, 2.0, 3.0), &mut data);
    for e in 0..poly.edges {
        let t = poly.twin(e);
        assert_eq!(poly.twin(t), e);
        assert_ne!(poly.face(t), poly.face(e));
        assert_eq!(poly.origin(t), poly.origin(poly.next(e)));
    }
    for f in 0..6 {
        let n = poly.normal(f);
        let e = poly.first(f);
        let (a, b, c) = (poly.vertex(poly.origin(e)), poly.vertex(poly.origin(poly.next(e))), poly.vertex(poly.origin(poly.next(poly.next(e)))));
        assert!(b.sub(a).cross(c.sub(b)).dot(n) > 0.0, "face {f} runs counter-clockwise");
        assert_eq!(n.dot(a), poly.plane(f));
    }
}

#[test]
fn a_hull_builds_its_topology_and_mass() {
    let mut w = World::new(4, 4).unwrap();
    let cube = w.add_hull(&CUBE, &CUBE_FACES);
    assert_eq!(cube, 0);
    let poly = w.hull_poly(0);
    assert_eq!((poly.vertices, poly.edges, poly.faces), (8, 24, 6));
    for e in 0..24 {
        assert_eq!(poly.twin(poly.twin(e)), e);
        assert_eq!(poly.origin(poly.twin(e)), poly.origin(poly.next(e)));
    }
    assert!((w.s(HULL_VOLUME, 0) - 8.0).abs() < 1e-5);
    let center = w.v(HULL_CENTER_X, 0);
    assert!(center.dot(center) < 1e-12);
    // A solid cube of side 2 and density 1: m (b^2 + c^2) / 3 = 8 * 2 / 3.
    let moments = w.v(HULL_MOMENT_X, 0);
    for m in [moments.x, moments.y, moments.z] {
        assert!((m - 16.0 / 3.0).abs() < 1e-4, "{m}");
    }
    assert!((w.s(HULL_RADIUS, 0) - 3.0f32.sqrt()).abs() < 1e-5);
    // The corner tetrahedron: volume 1/6, centroid at 1/4, and from its corner integral x^2 = 1/60, integral x y = 1/120.
    let tetra = w.add_hull(&TETRA, &TETRA_FACES) as usize;
    assert_eq!(tetra, 1);
    assert!((w.s(HULL_VOLUME, tetra) - 1.0 / 6.0).abs() < 1e-6);
    let center = w.v(HULL_CENTER_X, tetra);
    assert!(center.sub(v3(0.25, 0.25, 0.25)).dot(center.sub(v3(0.25, 0.25, 0.25))) < 1e-10);
    let (xx, xy) = (1.0 / 60.0 - 1.0 / 6.0 / 16.0, 1.0 / 120.0 - 1.0 / 6.0 / 16.0f32);
    let (diagonal, off) = (2.0 * xx, -xy);
    let moments = w.v(HULL_MOMENT_X, tetra);
    let mut sorted = [moments.x, moments.y, moments.z];
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // Eigenvalues of the matrix with `diagonal` and `off`: diagonal + 2 off once and diagonal - off twice.
    for (found, expected) in sorted.iter().zip([diagonal - off, diagonal - off, diagonal + 2.0 * off]) {
        assert!((found - expected).abs() < 1e-5, "{found} against {expected}");
    }
}

#[test]
fn a_body_of_a_hull_has_the_box_mass_and_its_centre_of_mass() {
    let mut w = World::new(4, 4).unwrap();
    let hull = w.add_hull(&CUBE, &CUBE_FACES) as f32;
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_HULL, [hull, 0.0, 0.0], [1.0, 2.0, 3.0], IDENTITY, 2.0).unwrap();
    let boxed = w.add_body(DYNAMIC).unwrap();
    w.add_collider(boxed, SHAPE_BOX, [1.0, 1.0, 1.0], [1.0, 2.0, 3.0], IDENTITY, 2.0).unwrap();
    assert!((w.s(INVERSE_MASS, body as usize) - w.s(INVERSE_MASS, boxed as usize)).abs() < 1e-6);
    let center = w.v(LOCAL_CENTER_X, body as usize).sub(v3(1.0, 2.0, 3.0));
    assert!(center.dot(center) < 1e-10);
    let (a, b) = (w.v(INERTIA_X, body as usize), w.v(INERTIA_X, boxed as usize));
    assert!(a.sub(b).dot(a.sub(b)) < 1e-6, "{a:?} {b:?}");
    // The hull's own centroid counts: a tetrahedron's is not at its origin.
    let tetra = w.add_hull(&TETRA, &TETRA_FACES) as f32;
    let corner = w.add_body(DYNAMIC).unwrap();
    w.add_collider(corner, SHAPE_HULL, [tetra, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    let center = w.v(LOCAL_CENTER_X, corner as usize);
    assert!((center.x - 0.25).abs() < 1e-6);
}

#[test]
fn a_bad_hull_is_refused_and_leaves_nothing_behind() {
    let mut w = World::new(4, 4).unwrap();
    assert_eq!(w.add_hull(&CUBE[..3], &[&[0, 1, 2]]), HULL_TOO_SMALL);
    // One face missing.
    assert_eq!(w.add_hull(&CUBE, &CUBE_FACES[..5]), HULL_NOT_CLOSED);
    // A vertex index that does not exist.
    let faces: [&[u32]; 6] = [&[1, 3, 7, 9], CUBE_FACES[1], CUBE_FACES[2], CUBE_FACES[3], CUBE_FACES[4], CUBE_FACES[5]];
    assert_eq!(w.add_hull(&CUBE, &faces), HULL_BAD_INDEX);
    // A corner pushed off its face's plane.
    let mut bent = CUBE;
    bent[7] = [1.2, 1.0, 1.0];
    assert_eq!(w.add_hull(&bent, &CUBE_FACES), HULL_NOT_PLANAR);
    // One face turned inside out.
    let faces: [&[u32]; 6] = [&[5, 7, 3, 1], CUBE_FACES[1], CUBE_FACES[2], CUBE_FACES[3], CUBE_FACES[4], CUBE_FACES[5]];
    assert_ne!(w.add_hull(&CUBE, &faces), 0);
    // A dent: an octahedron with one tip pushed through.
    let mut dented = OCTA;
    dented[4] = [0.0, 0.0, -0.5];
    assert!(w.add_hull(&dented, &OCTA_FACES) < 0);
    // The cube's top split in two: Gregorius 2015 says such a mesh loses points, so it must be merged first.
    let split: [&[u32]; 7] = [CUBE_FACES[0], CUBE_FACES[1], &[2, 6, 7], &[2, 7, 3], CUBE_FACES[3], CUBE_FACES[4], CUBE_FACES[5]];
    assert_eq!(w.add_hull(&CUBE, &split), HULL_COPLANAR_FACES);
    // A face too large for the clipper: a prism of 65 sides, its circle drawn by exact rotations.
    let mut ring = Vec::new();
    for i in 0..65 {
        let turn = Q::from_rotation_vector(v3(0.0, i as f32 * 2.0 * std::f32::consts::PI / 65.0, 0.0));
        let v = turn.rotate(v3(1.0, 0.0, 0.0));
        ring.push([v.x, 1.0, v.z]);
        ring.push([v.x, -1.0, v.z]);
    }
    let top: Vec<u32> = (0..65).rev().map(|i| i * 2).collect();
    let bottom: Vec<u32> = (0..65).map(|i| i * 2 + 1).collect();
    let mut sides = Vec::new();
    for i in 0..65u32 {
        let j = (i + 1) % 65;
        sides.push(vec![i * 2, i * 2 + 1, j * 2 + 1, j * 2]);
    }
    let mut faces: Vec<&[u32]> = vec![&top, &bottom];
    faces.extend(sides.iter().map(|side| side.as_slice()));
    assert_eq!(w.add_hull(&ring, &faces), HULL_FACE_TOO_LARGE);
    assert_eq!(w.header().hull_rows[0], 0);
    assert_eq!(w.add_hull(&CUBE, &CUBE_FACES), 0, "a refused hull leaves its rows free");
}

#[test]
fn a_box_resting_on_a_box_has_all_four_corners_at_once() {
    let (mut da, mut db) = (BoxData::new(), BoxData::new());
    let (a, b) = (box_poly(v3(2.0, 0.5, 2.0), &mut da), box_poly(v3(1.0, 0.5, 1.0), &mut db));
    let mut m = Manifold::new();
    collide_polys(&a, pose(0.0, 0.0, 0.0), &b, pose(0.25, 0.99, -0.25), 0.04, &mut m);
    assert_eq!(m.count, 4);
    assert_eq!(m.normal, v3(0.0, 1.0, 0.0));
    let mut corners: Vec<(i32, i32)> = Vec::new();
    for point in &m.points {
        assert!((point.separation + 0.01).abs() < 1e-6);
        assert!((point.on_a.y - 0.5).abs() < 1e-6, "on the reference face");
        assert!((point.on_b.y - 0.49).abs() < 1e-6);
        corners.push(((point.on_b.x * 4.0) as i32, (point.on_b.z * 4.0) as i32));
    }
    corners.sort();
    assert_eq!(corners, [(-3, -5), (-3, 3), (5, -5), (5, 3)]);
}

#[test]
fn the_normal_runs_from_a_to_b_whichever_holds_the_reference_face() {
    let (mut da, mut db) = (BoxData::new(), BoxData::new());
    let (a, b) = (box_poly(v3(1.0, 1.0, 1.0), &mut da), box_poly(v3(1.0, 1.0, 1.0), &mut db));
    let (mut below, mut above) = (Manifold::new(), Manifold::new());
    collide_polys(&a, pose(0.0, 0.0, 0.0), &b, pose(0.0, 1.9, 0.0), 0.04, &mut below);
    collide_polys(&a, pose(0.0, 1.9, 0.0), &b, pose(0.0, 0.0, 0.0), 0.04, &mut above);
    assert_eq!(below.normal, v3(0.0, 1.0, 0.0));
    assert_eq!(above.normal, v3(0.0, -1.0, 0.0));
    // B's face wins only by more than the bias, so a small tilted B on a big A flips the reference to B's face.
    let (mut dc, mut dd) = (BoxData::new(), BoxData::new());
    let (c, d) = (box_poly(v3(1.0, 1.0, 1.0), &mut dc), box_poly(v3(3.0, 0.2, 3.0), &mut dd));
    let tilt = Pose { p: v3(0.0, 1.2, 0.0), q: Q::from_rotation_vector(v3(0.0, 0.0, 0.3)) };
    let mut flipped = Manifold::new();
    collide_polys(&c, pose(0.0, 0.0, 0.0), &d, tilt, 0.04, &mut flipped);
    assert!(flipped.count >= 1);
    assert!(flipped.points[0].id & (1 << 31) != 0, "reference face on B");
    let n = tilt.q.rotate(v3(0.0, 1.0, 0.0));
    assert!(flipped.normal.sub(n).dot(flipped.normal.sub(n)) < 1e-10, "{:?}", flipped.normal);
    for point in flipped.points.iter().take(flipped.count) {
        // on_a lies on A's corner, and on_b on B's lower face, one separation further along the normal.
        let gap = point.on_b.sub(point.on_a).dot(flipped.normal);
        assert!((gap - point.separation).abs() < 1e-5, "{gap} {}", point.separation);
        assert!(point.separation < 0.0);
    }
}

#[test]
fn a_turned_box_is_clipped_to_the_points_inside_the_face() {
    let (mut da, mut db) = (BoxData::new(), BoxData::new());
    let (a, b) = (box_poly(v3(1.0, 1.0, 1.0), &mut da), box_poly(v3(1.0, 1.0, 1.0), &mut db));
    let over = Pose { p: v3(0.0, 1.99, 0.0), q: turn_y(45.0) };
    let mut m = Manifold::new();
    collide_polys(&a, pose(0.0, 0.0, 0.0), &b, over, 0.04, &mut m);
    assert_eq!(m.count, 4, "eight clipped corners, the manifold's four kept");
    for point in m.points.iter() {
        assert!(point.on_a.x.abs() <= 1.0 + 1e-5 && point.on_a.z.abs() <= 1.0 + 1e-5, "{:?}", point.on_a);
    }
}

#[test]
fn crossed_edges_make_one_point_between_them() {
    // Two boxes turned so that one ridge lies across the other: a roof on a roof, 90 degrees apart.
    let (mut da, mut db) = (BoxData::new(), BoxData::new());
    let (a, b) = (box_poly(v3(1.0, 1.0, 1.0), &mut da), box_poly(v3(1.0, 1.0, 1.0), &mut db));
    let roof = Q::from_rotation_vector(v3(0.0, 0.0, std::f32::consts::FRAC_PI_4));
    let lower = Pose { p: v3(0.0, 0.0, 0.0), q: roof };
    let flipped = Q::from_rotation_vector(v3(std::f32::consts::FRAC_PI_4, 0.0, 0.0));
    let height = 2.0 * 2.0f32.sqrt() - 0.05;
    let upper = Pose { p: v3(0.0, height, 0.0), q: flipped };
    let mut m = Manifold::new();
    collide_polys(&a, lower, &b, upper, 0.04, &mut m);
    assert_eq!(m.count, 1);
    let point = m.points[0];
    assert!((point.separation + 0.05).abs() < 1e-4, "{}", point.separation);
    assert!(m.normal.sub(v3(0.0, 1.0, 0.0)).dot(m.normal.sub(v3(0.0, 1.0, 0.0))) < 1e-8, "{:?}", m.normal);
    assert!(point.on_a.x.abs() < 1e-4 && point.on_a.z.abs() < 1e-4, "{:?}", point.on_a);
    assert!((point.on_a.y - 2.0f32.sqrt()).abs() < 1e-4);
    assert!(point.id & (1 << 29) != 0);
}

/// Every candidate axis, the whole shape projected: what `sat` must agree with, or its pruning lost an axis.
fn brute_separation(a: &Poly, b: &Poly, rel: Pose) -> f32 {
    let project = |poly: &Poly, pose: Pose, axis: V3| {
        let (mut low, mut high) = (f32::INFINITY, f32::NEG_INFINITY);
        for i in 0..poly.vertices {
            let along = pose.apply(poly.vertex(i)).dot(axis);
            low = low.min(along);
            high = high.max(along);
        }
        (low, high)
    };
    let origin = Pose { p: v3(0.0, 0.0, 0.0), q: Q::IDENTITY };
    let mut axes = Vec::new();
    for f in 0..a.faces {
        axes.push(a.normal(f));
    }
    for f in 0..b.faces {
        axes.push(rel.q.rotate(b.normal(f)));
    }
    for ea in 0..a.edges {
        for eb in 0..b.edges {
            let da = a.vertex(a.origin(a.next(ea))).sub(a.vertex(a.origin(ea)));
            let db = rel.q.rotate(b.vertex(b.origin(b.next(eb))).sub(b.vertex(b.origin(eb))));
            let c = da.cross(db);
            let squared = c.dot(c);
            if squared > 1e-6 * da.dot(da) * db.dot(db) {
                axes.push(c.scale(1.0 / squared.sqrt()));
            }
        }
    }
    let mut most = f32::NEG_INFINITY;
    for axis in axes {
        let (low_a, high_a) = project(a, origin, axis);
        let (low_b, high_b) = project(b, rel, axis);
        most = most.max((low_b - high_a).max(low_a - high_b));
    }
    most
}

#[test]
fn the_pruned_test_agrees_with_every_axis_on_random_poses() {
    let mut w = World::new(4, 4).unwrap();
    let tetra = w.add_hull(&TETRA, &TETRA_FACES) as usize;
    let octa = w.add_hull(&OCTA, &OCTA_FACES) as usize;
    let cube = w.add_hull(&CUBE, &CUBE_FACES) as usize;
    let mut random = Random(0xC0FFEE);
    let mut data = BoxData::new();
    let boxy = box_poly(v3(0.7, 0.4, 1.1), &mut data);
    let shapes = [w.hull_poly(tetra), w.hull_poly(octa), w.hull_poly(cube), boxy];
    let (mut touching, mut edges) = (0, 0);
    for round in 0..20_000 {
        let (a, b) = (shapes[round % 4], shapes[(round / 4) % 4]);
        let rel = Pose { p: v3(random.range(-2.0, 2.0), random.range(-2.0, 2.0), random.range(-2.0, 2.0)), q: random.turn() };
        let expected = brute_separation(&a, &b, rel);
        match sat(&a, &b, rel, 0.04) {
            None => assert!(expected > 0.04 - 1e-4, "round {round}: sat separated, brute {expected}"),
            Some((feature, found)) => {
                touching += 1;
                if matches!(feature, Feature::Edges(..)) {
                    edges += 1;
                }
                if expected <= 0.0 {
                    // The bias may keep a face that loses by up to a millimetre.
                    assert!((found - expected).abs() < 2.5e-3, "round {round}: {found} against {expected}");
                } else {
                    assert!(found <= expected + 1e-4, "round {round}: {found} above the true largest {expected}");
                }
            }
        }
    }
    assert!(touching > 2000 && edges > 200, "{touching} touching, {edges} on edges");
}

#[test]
fn a_hull_cube_gives_a_box_the_same_manifold() {
    let mut w = World::new(4, 4).unwrap();
    let cube = w.add_hull(&CUBE, &CUBE_FACES) as usize;
    let hull = w.hull_poly(cube);
    let (mut da, mut db) = (BoxData::new(), BoxData::new());
    let (a, b) = (box_poly(v3(1.0, 1.0, 1.0), &mut da), box_poly(v3(1.0, 1.0, 1.0), &mut db));
    let mut random = Random(77);
    for _ in 0..2000 {
        let (pa, pb) = (pose(0.0, 0.0, 0.0), Pose { p: v3(random.range(-2.2, 2.2), random.range(-2.2, 2.2), random.range(-2.2, 2.2)), q: random.turn() });
        let (mut boxes, mut mixed) = (Manifold::new(), Manifold::new());
        collide_polys(&a, pa, &b, pb, 0.04, &mut boxes);
        collide_polys(&hull, pa, &b, pb, 0.04, &mut mixed);
        assert_eq!(boxes.count, mixed.count);
        for (p, q) in boxes.points.iter().zip(mixed.points.iter()).take(boxes.count) {
            assert!((p.separation - q.separation).abs() < 1e-4);
        }
    }
}

#[test]
fn points_keep_their_ids_under_a_small_move() {
    let (mut da, mut db) = (BoxData::new(), BoxData::new());
    let (a, b) = (box_poly(v3(2.0, 0.5, 2.0), &mut da), box_poly(v3(1.0, 0.5, 1.0), &mut db));
    let ids = |x: f32, y: f32| {
        let mut m = Manifold::new();
        collide_polys(&a, pose(0.0, 0.0, 0.0), &b, pose(x, y, 0.0), 0.04, &mut m);
        let mut ids: Vec<u32> = m.points.iter().take(m.count).map(|p| p.id).collect();
        ids.sort();
        ids
    };
    assert_eq!(ids(0.0, 0.99), ids(0.002, 0.985));
    // Half over the edge, a clipped point keeps its id too.
    assert_eq!(ids(1.5, 0.99), ids(1.502, 0.985));
    assert_eq!(ids(1.5, 0.99).iter().filter(|id| **id & (1 << 30) != 0).count(), 2);
}

#[test]
fn a_step_writes_the_manifold_into_the_pair_with_anchors_on_each_surface() {
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [5.0, 0.5, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    let top = w.add_body(DYNAMIC).unwrap();
    w.add_collider(top, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0, 0.0, 0.0], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, top as usize, v3(0.0, 0.99, 0.0));
    w.touch_body(top);
    w.step(1.0 / 60.0);
    assert_eq!(w.header().pairs, 1);
    let row = 0;
    assert_eq!(w.uu(PAIR_CONTACTS, row), 4);
    assert_eq!(w.v(PAIR_NORMAL_X, row), v3(0.0, 1.0, 0.0));
    for k in 0..4 {
        let at = row * MANIFOLD + k;
        assert!((w.s(CONTACT_SEPARATION, at) + 0.01).abs() < 1e-5);
        assert!((w.v(CONTACT_ANCHOR_B_X, at).y + 0.5).abs() < 1e-5, "the top's bottom face, from its centre");
        assert!((w.v(CONTACT_ANCHOR_A_X, at).y - 0.5).abs() < 1e-5, "the floor's top face");
        assert!((w.v(CONTACT_X, at).y - 0.495).abs() < 1e-5);
    }
    // Apart by more than the limit, the pair stays near but holds no points.
    w.set_v(POSITION_X, top as usize, v3(0.0, 1.06, 0.0));
    w.touch_body(top);
    w.step(1.0 / 60.0);
    assert_eq!(w.uu(PAIR_CONTACTS, row), 0);
}
