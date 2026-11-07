// GJK with Signed Volumes and the expanding polytope, against a brute force in doubles and against the separating axis test,
// and the manifolds of round shapes against closed forms.
use margoengine_physics_kernel::gjk::*;
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
    fn point(&mut self, size: f32) -> V3 {
        v3(self.range(-size, size), self.range(-size, size), self.range(-size, size))
    }
    fn turn(&mut self) -> Q {
        Q { x: self.range(-1.0, 1.0), y: self.range(-1.0, 1.0), z: self.range(-1.0, 1.0), w: self.range(-1.0, 1.0) }.normalized()
    }
}

type D3 = [f64; 3];
fn d(v: V3) -> D3 {
    [v.x as f64, v.y as f64, v.z as f64]
}
fn sub(a: D3, b: D3) -> D3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: D3, b: D3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: D3, b: D3) -> D3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn lerp(a: D3, b: D3, t: f64) -> D3 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// Squared distance from the origin to a segment.
fn to_segment(a: D3, b: D3) -> f64 {
    let t = sub(b, a);
    let length = dot(t, t);
    let u = if length > 0.0 { (-dot(a, t) / length).clamp(0.0, 1.0) } else { 0.0 };
    let p = lerp(a, b, u);
    dot(p, p)
}
/// Squared distance from the origin to a triangle: its sides, or its plane when the foot lands inside.
fn to_triangle(a: D3, b: D3, c: D3) -> f64 {
    let mut best = to_segment(a, b).min(to_segment(b, c)).min(to_segment(c, a));
    let n = cross(sub(b, a), sub(c, a));
    let squared = dot(n, n);
    if squared > 0.0 {
        let h = dot(a, n) / squared;
        let foot = [n[0] * h, n[1] * h, n[2] * h];
        let inside = |p: D3, q: D3| dot(cross(sub(q, p), sub(foot, p)), n) >= 0.0;
        if inside(a, b) && inside(b, c) && inside(c, a) {
            best = best.min(dot(foot, foot));
        }
    }
    best
}
/// Squared distance from the origin to a tetrahedron, zero inside.
fn to_tetrahedron(s: [D3; 4]) -> f64 {
    let side = |a: D3, b: D3, c: D3, other: D3| {
        let n = cross(sub(b, a), sub(c, a));
        dot(n, sub(other, a)) * dot(n, sub([0.0; 3], a)) >= 0.0
    };
    if side(s[0], s[1], s[2], s[3]) && side(s[0], s[1], s[3], s[2]) && side(s[0], s[2], s[3], s[1]) && side(s[1], s[2], s[3], s[0]) {
        return 0.0;
    }
    to_triangle(s[0], s[1], s[2]).min(to_triangle(s[0], s[1], s[3])).min(to_triangle(s[0], s[2], s[3])).min(to_triangle(s[1], s[2], s[3]))
}

#[test]
fn signed_volumes_finds_the_closest_point_of_any_simplex() {
    let mut random = Random(0x51D);
    for round in 0..200_000 {
        let spread = [0.01, 1.0, 100.0][round % 3];
        let s = [random.point(spread), random.point(spread), random.point(spread), random.point(spread)];
        let count = 1 + (round / 3) % 4;
        let closest = signed_volumes(&s, count);
        let mut sum = 0.0;
        for i in 0..closest.count {
            assert!(closest.lambda[i] >= 0.0 && closest.lambda[i] <= 1.0 + 1e-5, "round {round}: {:?}", closest.lambda);
            sum += closest.lambda[i];
        }
        assert!((sum - 1.0).abs() < 1e-4, "round {round}: {:?}", closest);
        let expected = match count {
            1 => dot(d(s[0]), d(s[0])),
            2 => to_segment(d(s[0]), d(s[1])),
            3 => to_triangle(d(s[0]), d(s[1]), d(s[2])),
            _ => to_tetrahedron([d(s[0]), d(s[1]), d(s[2]), d(s[3])]),
        };
        let scale = spread as f64 * spread as f64;
        assert!((closest.squared as f64 - expected).abs() < 2e-4 * scale + 2e-4 * expected, "round {round}: {} against {expected}", closest.squared);
    }
}

#[test]
fn degenerate_simplices_give_numbers_not_nan() {
    let flat = v3(1.0, 0.0, 0.0);
    let cases: [[V3; 4]; 5] = [
        [flat, flat, flat, flat],
        [v3(1.0, 1.0, 0.0), v3(1.0 + 1e-7, 1.0, 0.0), v3(1.0, 1.0 + 1e-7, 0.0), v3(1.0, 1.0, 1e-7)],
        [v3(-1.0, 1.0, 0.0), v3(1.0, 1.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.5, 1.0, 0.0)],
        [v3(0.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), v3(2.0, 0.0, 0.0), v3(3.0, 0.0, 0.0)],
        [v3(1e-30, 0.0, 0.0), v3(0.0, 1e-30, 0.0), v3(0.0, 0.0, 1e-30), v3(1e-30, 1e-30, 1e-30)],
    ];
    for s in cases {
        for count in 1..=4 {
            let closest = signed_volumes(&s, count);
            assert!(closest.squared.is_finite(), "{s:?} {count}");
            assert!(closest.count >= 1);
        }
    }
    // A needle a nanometre wide on the way past the origin: the answer stays on it.
    let needle = [v3(-1.0, 0.5, 0.0), v3(1.0, 0.5, 1e-9), v3(1.0, 0.5, -1e-9), v3(0.0, 0.0, 0.0)];
    let closest = signed_volumes(&needle, 3);
    assert!((closest.squared - 0.25).abs() < 1e-5, "{closest:?}");
}

/// Squared distance between two polyhedra, from every pair of triangle and edge, in doubles.
fn brute_distance(a: &Poly, pa: Pose, b: &Poly, pb: Pose) -> f64 {
    let triangles = |poly: &Poly, pose: Pose| {
        let mut out = Vec::new();
        for f in 0..poly.faces {
            let start = poly.first(f);
            let first = d(pose.apply(poly.vertex(poly.origin(start))));
            let mut e = poly.next(start);
            while poly.next(e) != start {
                out.push([first, d(pose.apply(poly.vertex(poly.origin(e)))), d(pose.apply(poly.vertex(poly.origin(poly.next(e)))))]);
                e = poly.next(e);
            }
        }
        out
    };
    let segment_segment = |p1: D3, q1: D3, p2: D3, q2: D3| {
        let (d1, d2, r) = (sub(q1, p1), sub(q2, p2), sub(p1, p2));
        let (a, e, f, c, b) = (dot(d1, d1), dot(d2, d2), dot(d2, r), dot(d1, r), dot(d1, d2));
        let denominator = a * e - b * b;
        let mut s = if denominator > 1e-14 { ((b * f - c * e) / denominator).clamp(0.0, 1.0) } else { 0.0 };
        let mut t = (b * s + f) / e;
        if t < 0.0 {
            t = 0.0;
            s = (-c / a).clamp(0.0, 1.0);
        } else if t > 1.0 {
            t = 1.0;
            s = ((b - c) / a).clamp(0.0, 1.0);
        }
        let g = sub(lerp(p1, q1, s), lerp(p2, q2, t));
        dot(g, g)
    };
    let (ta, tb) = (triangles(a, pa), triangles(b, pb));
    let mut best = f64::INFINITY;
    for x in &ta {
        for y in &tb {
            for i in 0..3 {
                for j in 0..3 {
                    best = best.min(segment_segment(x[i], x[(i + 1) % 3], y[j], y[(j + 1) % 3]));
                }
                let (p, q) = (x[i], y[i]);
                best = best.min(to_triangle(sub(y[0], p), sub(y[1], p), sub(y[2], p)));
                best = best.min(to_triangle(sub(x[0], q), sub(x[1], q), sub(x[2], q)));
            }
        }
    }
    best
}

fn shapes(w: &mut World) -> [usize; 2] {
    let octa = w.add_hull(
        &[[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]],
        &[&[0, 2, 4], &[2, 1, 4], &[1, 3, 4], &[3, 0, 4], &[2, 0, 5], &[1, 2, 5], &[3, 1, 5], &[0, 3, 5]],
    ) as usize;
    let tetra = w.add_hull(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], &[&[0, 2, 1], &[0, 1, 3], &[0, 3, 2], &[1, 2, 3]]) as usize;
    [octa, tetra]
}

#[test]
fn gjk_matches_a_brute_force_in_doubles_and_epa_matches_the_separating_axis_test() {
    let mut w = World::new(4, 4).unwrap();
    let [octa, tetra] = shapes(&mut w);
    let mut data = BoxData::new();
    let list = [w.hull_poly(octa), w.hull_poly(tetra), box_poly(v3(0.7, 0.4, 1.1), &mut data)];
    let mut random = Random(0xABCD);
    let (mut apart, mut deep, mut worst_depth) = (0, 0, 0.0f32);
    for round in 0..6000 {
        let (a, b) = (list[round % 3], list[(round / 3) % 3]);
        let pa = Pose { p: v3(0.0, 0.0, 0.0), q: Q::IDENTITY };
        let pb = Pose { p: random.point(2.0), q: random.turn() };
        let (posed_a, posed_b) = (Posed { shape: &a, pose: pa }, Posed { shape: &b, pose: pb });
        let found = gjk(&posed_a, &posed_b, v3(1.0, 0.0, 0.0), f32::INFINITY);
        let rel = pa.relative(pb);
        let separated = sat(&a, &b, rel, 0.0).is_none();
        if separated {
            apart += 1;
            assert!(!found.overlap, "round {round}: gjk overlap, sat apart");
            let expected = brute_distance(&a, pa, &b, pb).sqrt();
            assert!((found.distance as f64 - expected).abs() < 2e-5 * (1.0 + expected), "round {round}: {} against {expected}", found.distance);
            let gap = found.on_b.sub(found.on_a);
            assert!((gap.dot(gap).sqrt() - found.distance).abs() < 1e-4, "round {round}: the witnesses sit a distance apart");
        } else if found.overlap {
            deep += 1;
            let (_, separation) = sat(&a, &b, rel, 0.0).unwrap();
            let way_out = epa(&posed_a, &posed_b, &found).expect("a solid overlap");
            let n = way_out.normal;
            assert!((n.dot(n) - 1.0).abs() < 1e-4);
            let error = (way_out.depth + separation).abs();
            worst_depth = worst_depth.max(error);
            assert!(error < 2e-3, "round {round}: epa {} against sat {}", way_out.depth, -separation);
            // Moved out by the depth along the normal, B touches A.
            let moved = Pose { p: pb.p.add(n.scale(way_out.depth + 1e-3)), q: pb.q };
            assert!(sat(&a, &b, pa.relative(moved), 0.0).is_none(), "round {round}: still inside after the way out");
        }
    }
    assert!(apart > 1000 && deep > 1000, "{apart} apart, {deep} deep");
    println!("largest epa against sat: {worst_depth}");
}

#[test]
fn a_descent_stops_early_when_the_shapes_are_past_the_limit() {
    let mut data = BoxData::new();
    let poly = box_poly(v3(1.0, 1.0, 1.0), &mut data);
    let posed = Posed { shape: &poly, pose: Pose { p: v3(0.0, 0.0, 0.0), q: Q::IDENTITY } };
    let far = Segment { p: v3(10.0, 0.0, 0.0), q: v3(10.0, 0.0, 0.0) };
    assert!(gjk(&far, &posed, v3(1.0, 0.0, 0.0), 1.0).apart);
    let found = gjk(&far, &posed, v3(1.0, 0.0, 0.0), 100.0);
    assert!(!found.apart && (found.distance - 9.0).abs() < 1e-5);
}

fn world_with(a: (u32, [f32; 3], V3, Q), b: (u32, [f32; 3], V3, Q)) -> (World, usize, usize) {
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let mut colliders = [0; 2];
    for (i, (shape, size, position, rotation)) in [a, b].into_iter().enumerate() {
        let body = w.add_body(DYNAMIC).unwrap();
        colliders[i] = w.add_collider(body, shape, size, [0.0; 3], IDENTITY, 1.0).unwrap() as usize;
        w.set_v(POSITION_X, body as usize, position);
        w.set_q(ROTATION_X, body as usize, rotation);
    }
    (w, colliders[0], colliders[1])
}

fn manifold(a: (u32, [f32; 3], V3, Q), b: (u32, [f32; 3], V3, Q)) -> Manifold {
    let (w, x, y) = world_with(a, b);
    let mut m = Manifold::new();
    w.collide(x, y, 0.04, &mut m);
    m
}
const I: Q = Q::IDENTITY;
fn near(a: V3, b: V3) -> bool {
    a.sub(b).dot(a.sub(b)) < 1e-9
}

#[test]
fn balls_touch_at_the_middle_of_their_surfaces() {
    let m = manifold((SHAPE_BALL, [1.0, 0.0, 0.0], v3(0.0, 0.0, 0.0), I), (SHAPE_BALL, [0.5, 0.0, 0.0], v3(1.4, 0.0, 0.0), I));
    assert_eq!(m.count, 1);
    assert_eq!(m.normal, v3(1.0, 0.0, 0.0));
    assert!((m.points[0].separation + 0.1).abs() < 1e-6);
    assert!(near(m.points[0].on_a, v3(1.0, 0.0, 0.0)));
    assert!(near(m.points[0].on_b, v3(0.9, 0.0, 0.0)));
    // Coincident centres have no direction: up, as Gregorius 2015 suggests.
    let m = manifold((SHAPE_BALL, [1.0, 0.0, 0.0], v3(0.0, 0.0, 0.0), I), (SHAPE_BALL, [1.0, 0.0, 0.0], v3(0.0, 0.0, 0.0), I));
    assert_eq!((m.count, m.normal), (1, v3(0.0, 1.0, 0.0)));
    assert!((m.points[0].separation + 2.0).abs() < 1e-6);
    // Past the limit there is nothing, within it a point with a gap.
    assert_eq!(manifold((SHAPE_BALL, [1.0, 0.0, 0.0], v3(0.0, 0.0, 0.0), I), (SHAPE_BALL, [1.0, 0.0, 0.0], v3(2.05, 0.0, 0.0), I)).count, 0);
    let m = manifold((SHAPE_BALL, [1.0, 0.0, 0.0], v3(0.0, 0.0, 0.0), I), (SHAPE_BALL, [1.0, 0.0, 0.0], v3(2.03, 0.0, 0.0), I));
    assert_eq!(m.count, 1);
    assert!((m.points[0].separation - 0.03).abs() < 1e-5);
}

#[test]
fn a_ball_meets_a_capsule_along_its_core() {
    let m = manifold((SHAPE_BALL, [0.5, 0.0, 0.0], v3(0.9, 0.3, 0.0), I), (SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.0, 0.0, 0.0), I));
    assert_eq!(m.count, 1);
    assert!(near(m.normal, v3(-1.0, 0.0, 0.0)));
    assert!((m.points[0].separation + 0.1).abs() < 1e-5);
    // Past its end the closest point is the cap's centre.
    let m = manifold((SHAPE_BALL, [0.5, 0.0, 0.0], v3(0.0, 1.9, 0.0), I), (SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.0, 0.0, 0.0), I));
    assert!(near(m.normal, v3(0.0, -1.0, 0.0)));
    assert!((m.points[0].separation + 0.1).abs() < 1e-5);
    // A ball's centre on the core: square to it.
    let m = manifold((SHAPE_BALL, [0.5, 0.0, 0.0], v3(0.0, 0.2, 0.0), I), (SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.0, 0.0, 0.0), I));
    assert_eq!(m.count, 1);
    assert!(m.normal.y.abs() < 1e-6 && (m.normal.dot(m.normal) - 1.0).abs() < 1e-5);
}

#[test]
fn capsules_cross_at_one_point_and_lie_side_by_side_on_two() {
    let across = Q::from_rotation_vector(v3(std::f32::consts::FRAC_PI_2, 0.0, 0.0));
    let m = manifold((SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.0, 0.0, 0.0), I), (SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.9, 0.0, 0.0), across));
    assert_eq!(m.count, 1);
    assert!(near(m.normal, v3(1.0, 0.0, 0.0)));
    assert!((m.points[0].separation + 0.1).abs() < 1e-5);
    let m = manifold((SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.0, 0.0, 0.0), I), (SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.9, 0.5, 0.0), I));
    assert_eq!(m.count, 2, "side by side, on what the cores share");
    let heights: Vec<f32> = m.points.iter().take(2).map(|p| p.on_a.y).collect();
    assert!((heights[0] + 0.5).abs() < 1e-5 && (heights[1] - 1.0).abs() < 1e-5, "{heights:?}");
    assert!(m.points[0].id != m.points[1].id);
    // Crossing cores that meet: the normal is across both.
    let m = manifold((SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.0, 0.0, 0.0), I), (SHAPE_CAPSULE, [0.5, 1.0, 0.0], v3(0.0, 0.0, 0.0), across));
    assert_eq!(m.count, 1);
    assert!((m.normal.x.abs() - 1.0).abs() < 1e-5);
}

#[test]
fn a_ball_on_a_box_gets_the_closed_forms_shallow_and_deep() {
    let box_at = (SHAPE_BOX, [2.0, 1.0, 2.0], v3(0.0, 0.0, 0.0), I);
    // Over a face.
    let m = manifold(box_at, (SHAPE_BALL, [0.5, 0.0, 0.0], v3(0.3, 1.4, 0.2), I));
    assert_eq!(m.count, 1);
    assert!(near(m.normal, v3(0.0, 1.0, 0.0)), "{:?}", m.normal);
    assert!((m.points[0].separation + 0.1).abs() < 1e-5);
    assert!(near(m.points[0].on_a, v3(0.3, 1.0, 0.2)));
    assert!(near(m.points[0].on_b, v3(0.3, 0.9, 0.2)));
    // Off a corner the normal points from the corner.
    let m = manifold(box_at, (SHAPE_BALL, [0.5, 0.0, 0.0], v3(2.2, 1.2, 2.2), I));
    let n = 1.0 / 12.0f32.sqrt() * 2.0;
    assert!(near(m.normal, v3(n * 0.5 * 1.0, n * 0.5, n * 0.5).scale(1.0 / (3.0 * (n * 0.5) * (n * 0.5)).sqrt())), "{:?}", m.normal);
    assert!((m.points[0].separation - (0.12f32.sqrt() - 0.5)).abs() < 1e-5);
    // Centre inside: out by the nearest face, at the depth to its surface plus the radius.
    let m = manifold(box_at, (SHAPE_BALL, [0.5, 0.0, 0.0], v3(0.1, 0.8, 0.0), I));
    assert_eq!(m.count, 1);
    assert!(near(m.normal, v3(0.0, 1.0, 0.0)), "{:?}", m.normal);
    assert!((m.points[0].separation + 0.7).abs() < 1e-4, "{}", m.points[0].separation);
    // With the ball first the normal turns round and the two surfaces swap.
    let m = manifold((SHAPE_BALL, [0.5, 0.0, 0.0], v3(0.3, 1.4, 0.2), I), box_at);
    assert!(near(m.normal, v3(0.0, -1.0, 0.0)), "{:?}", m.normal);
    assert!(near(m.points[0].on_a, v3(0.3, 0.9, 0.2)));
    assert!(near(m.points[0].on_b, v3(0.3, 1.0, 0.2)));
}

#[test]
fn a_capsule_lying_on_a_box_has_two_points_and_a_tilted_one_only_what_reaches() {
    let down = Q::from_rotation_vector(v3(0.0, 0.0, std::f32::consts::FRAC_PI_2));
    let floor = (SHAPE_BOX, [5.0, 1.0, 5.0], v3(0.0, 0.0, 0.0), I);
    let m = manifold(floor, (SHAPE_CAPSULE, [0.25, 1.0, 0.0], v3(0.0, 1.2, 0.0), down));
    assert_eq!(m.count, 2);
    assert!(near(m.normal, v3(0.0, 1.0, 0.0)), "{:?}", m.normal);
    for point in m.points.iter().take(2) {
        assert!((point.separation + 0.05).abs() < 1e-5, "{}", point.separation);
        assert!((point.on_a.y - 1.0).abs() < 1e-5);
        assert!((point.on_b.y - 0.95).abs() < 1e-5);
    }
    // Clipped at the box's edge.
    let m = manifold(floor, (SHAPE_CAPSULE, [0.25, 1.0, 0.0], v3(5.0, 1.2, 0.0), down));
    assert_eq!(m.count, 2);
    let highest = m.points.iter().take(2).map(|p| p.on_a.x).fold(f32::MIN, f32::max);
    assert!((highest - 5.0).abs() < 1e-4, "{highest}");
    // A capsule stood on end touches at one point.
    let m = manifold(floor, (SHAPE_CAPSULE, [0.25, 1.0, 0.0], v3(0.0, 2.2, 0.0), I));
    assert_eq!(m.count, 1);
    assert!((m.points[0].separation + 0.05).abs() < 1e-5);
    // Tilted, the high end stays out of reach.
    let tilt = Q::from_rotation_vector(v3(0.0, 0.0, 1.2));
    let low_end = tilt.rotate(v3(0.0, 1.0, 0.0)).y.abs();
    let m = manifold(floor, (SHAPE_CAPSULE, [0.25, 1.0, 0.0], v3(0.0, 1.2 + low_end, 0.0), tilt));
    assert_eq!(m.count, 1, "{m:?}");
    assert!((m.points[0].separation + 0.05).abs() < 1e-4, "{}", m.points[0].separation);
}

#[test]
fn a_ball_on_a_hull_and_inside_it() {
    let mut w = World::new(4, 4).unwrap();
    let [octa, _] = shapes(&mut w);
    let solid = w.add_body(FIXED).unwrap();
    let hull = w.add_collider(solid, SHAPE_HULL, [octa as f32, 0.0, 0.0], [0.0; 3], IDENTITY, 0.0).unwrap() as usize;
    let body = w.add_body(DYNAMIC).unwrap();
    let ball = w.add_collider(body, SHAPE_BALL, [0.2, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap() as usize;
    let n = v3(1.0, 1.0, 1.0).scale(1.0 / 3.0f32.sqrt());
    let face = 1.0 / 3.0f32.sqrt();
    w.set_v(POSITION_X, body as usize, n.scale(face + 0.15));
    let mut m = Manifold::new();
    w.collide(hull, ball, 0.04, &mut m);
    assert_eq!(m.count, 1);
    assert!(near(m.normal, n), "{:?}", m.normal);
    assert!((m.points[0].separation + 0.05).abs() < 1e-5);
    w.set_v(POSITION_X, body as usize, n.scale(face - 0.1));
    w.collide(hull, ball, 0.04, &mut m);
    assert_eq!(m.count, 1);
    assert!(near(m.normal, n), "{:?}", m.normal);
    assert!((m.points[0].separation + 0.3).abs() < 1e-4, "{}", m.points[0].separation);
}

#[test]
fn only_touching_pairs_join_an_island() {
    // Fat boxes overlap, shapes do not: corners of two balls near along a diagonal.
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let (a, b) = (w.add_body(DYNAMIC).unwrap(), w.add_body(DYNAMIC).unwrap());
    w.add_collider(a, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.add_collider(b, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, b as usize, v3(1.6, 1.6, 0.0));
    w.touch_body(b);
    w.step(1.0 / 60.0);
    assert_eq!(w.header().pairs, 1, "near");
    assert_eq!(w.header().islands, 2, "not touching");
    w.set_v(POSITION_X, b as usize, v3(1.3, 1.3, 0.0));
    w.touch_body(b);
    w.step(1.0 / 60.0);
    assert_eq!(w.header().islands, 1);
}

#[test]
fn a_round_shape_with_its_core_on_the_surface_of_a_box_still_touches_it() {
    // The core sits exactly on a face, an edge or a corner, so the origin lies on the surface of the difference and nothing
    // lies beyond the triangle GJK ends on. A sensor sliding through a box at 0.1 m a step lost its overlap there.
    let half = [0.5, 1.0, 1.0];
    for sign in [-1.0, 1.0] {
        for (axis, at) in [(0, v3(0.5 * sign, 0.0, 0.0)), (1, v3(0.0, sign, 0.0)), (2, v3(0.0, 0.0, sign))] {
            let m = manifold((SHAPE_BOX, half, v3(0.0, 0.0, 0.0), I), (SHAPE_BALL, [0.3, 0.0, 0.0], at, I));
            assert_eq!(m.count, 1, "a ball on face {axis} {sign}");
            assert!((m.points[0].separation + 0.3).abs() < 1e-5, "{}", m.points[0].separation);
            let along = [m.normal.x, m.normal.y, m.normal.z];
            assert!((along[axis] - sign).abs() < 1e-5, "out of the face: {along:?}");
        }
        let at = v3(0.5 * sign, 0.0, 0.0);
        let m = manifold((SHAPE_BOX, half, v3(0.0, 0.0, 0.0), I), (SHAPE_CAPSULE, [0.3, 0.4, 0.0], at, I));
        assert!(m.count >= 1, "a capsule on a face {sign}");
        assert!((m.points[0].separation + 0.3).abs() < 1e-5, "{}", m.points[0].separation);
        assert!((m.normal.x - sign).abs() < 1e-5, "out of the face: {:?}", m.normal);
    }
    // A hair inside or outside the face, where a solid from both sides of the triangle turned a face inward and read 0.45 m.
    for step in -16..=16 {
        let x = 0.5 + step as f32 * 6e-8;
        let m = manifold((SHAPE_BOX, half, v3(0.0, 0.0, 0.0), I), (SHAPE_CAPSULE, [0.3, 0.4, 0.0], v3(x, 0.0, 0.0), I));
        assert!(m.count >= 1, "a capsule at {x}");
        assert!((m.points[0].separation + 0.3).abs() < 2e-5, "at {x}: {}", m.points[0].separation);
        assert!((m.normal.x - 1.0).abs() < 1e-5, "at {x}: {:?}", m.normal);
    }
    for at in [v3(0.5, 1.0, 0.0), v3(0.5, 0.0, 1.0), v3(0.5, 1.0, 1.0), v3(-0.5, -1.0, -1.0)] {
        let m = manifold((SHAPE_BOX, half, v3(0.0, 0.0, 0.0), I), (SHAPE_BALL, [0.3, 0.0, 0.0], at, I));
        assert_eq!(m.count, 1, "a ball on {at:?}");
        assert!((m.points[0].separation + 0.3).abs() < 1e-5, "{}", m.points[0].separation);
    }
}
