// Reducing a manifold to four points (Gregorius 2015), and keeping the same four while nothing much changes.
use margoengine_physics_kernel::hull::{BoxData, box_poly};
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::narrow::{Manifold, Point, reduce};
use margoengine_physics_kernel::sat::{Feature, Pose, sat, sat_coherent};
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const UP: V3 = v3(0.0, 1.0, 0.0);

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
}

fn point(x: f32, z: f32, separation: f32, id: u32) -> Point {
    let p = v3(x, 0.0, z);
    Point { on_a: p, on_b: p, separation, id }
}

/// The area of the convex hull of a few points in the XZ plane, by gift wrapping.
fn hull_area(points: &[Point]) -> f32 {
    let at: Vec<(f32, f32)> = points.iter().map(|p| (p.on_a.x, p.on_a.z)).collect();
    let start = (0..at.len()).min_by(|&i, &j| at[i].partial_cmp(&at[j]).unwrap()).unwrap();
    let (mut ring, mut current) = (vec![], start);
    loop {
        ring.push(current);
        let mut next = (current + 1) % at.len();
        for i in 0..at.len() {
            let (ax, az) = (at[next].0 - at[current].0, at[next].1 - at[current].1);
            let (bx, bz) = (at[i].0 - at[current].0, at[i].1 - at[current].1);
            if ax * bz - az * bx < 0.0 {
                next = i;
            }
        }
        current = next;
        if current == start || ring.len() > at.len() {
            break;
        }
    }
    let mut twice = 0.0;
    for k in 0..ring.len() {
        let (p, q) = (at[ring[k]], at[ring[(k + 1) % ring.len()]]);
        twice += p.0 * q.1 - p.1 * q.0;
    }
    twice.abs() * 0.5
}

/// The best four of a set that hold `must`, by trying them all.
fn best_area(points: &[Point], must: u32) -> f32 {
    let mut best = 0.0f32;
    let n = points.len();
    for a in 0..n {
        for b in a + 1..n {
            for c in b + 1..n {
                for d in c + 1..n {
                    let four = [points[a], points[b], points[c], points[d]];
                    if four.iter().any(|p| p.id == must) {
                        best = best.max(hull_area(&four));
                    }
                }
            }
        }
    }
    best
}

#[test]
fn four_points_or_fewer_pass_through() {
    let points = [point(0.0, 0.0, 0.0, 1), point(1.0, 0.0, 0.0, 2), point(0.0, 1.0, 0.0, 3)];
    let mut out = Manifold::new();
    reduce(&points, 3, UP, &[], &mut out);
    assert_eq!(out.count, 3);
    assert_eq!(out.points[2].id, 3);
}

#[test]
fn a_square_with_points_along_its_sides_keeps_its_corners() {
    let mut points = vec![];
    for (i, (x, z)) in [(-1.0, -1.0), (0.0, -1.0), (1.0, -1.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (-1.0, 1.0), (-1.0, 0.0), (0.2, 0.1)].iter().enumerate() {
        points.push(point(*x, *z, -0.01, i as u32));
    }
    let mut out = Manifold::new();
    reduce(&points, points.len(), UP, &[], &mut out);
    assert_eq!(out.count, 4);
    let mut ids: Vec<u32> = out.points.iter().map(|p| p.id).collect();
    ids.sort();
    assert_eq!(ids, [0, 2, 4, 6]);
}

#[test]
fn the_deepest_point_always_stays_and_the_area_is_near_the_best_of_all_fours() {
    let mut r = Random(99);
    let (mut worst, mut sum) = (1.0f32, 0.0f64);
    for _ in 0..3000 {
        let n = 5 + (r.next() % 6) as usize;
        let points: Vec<Point> = (0..n).map(|i| point(r.range(-1.0, 1.0), r.range(-1.0, 1.0), r.range(-0.1, 0.0), i as u32)).collect();
        let mut out = Manifold::new();
        reduce(&points, n, UP, &[], &mut out);
        let deepest = points.iter().min_by(|p, q| p.separation.partial_cmp(&q.separation).unwrap()).unwrap();
        assert!(out.points[..out.count].iter().any(|p| p.id == deepest.id));
        let ids: Vec<u32> = out.points[..out.count].iter().map(|p| p.id).collect();
        for (i, id) in ids.iter().enumerate() {
            assert!(!ids[..i].contains(id), "a point twice");
        }
        let ratio = hull_area(&out.points[..out.count]) / best_area(&points, deepest.id);
        worst = worst.min(ratio);
        sum += ratio as f64;
    }
    println!("area ratio: worst {worst}, mean {}", sum / 3000.0);
    // Measured 0.711 and 0.9915 on this stream, the deepest point being a must for both sides of the ratio.
    assert!(worst > 0.7 && sum / 3000.0 > 0.99, "{worst}");
}

#[test]
fn a_point_inside_the_triangle_adds_nothing_and_coincident_points_give_no_nan() {
    let points = [point(-1.0, -1.0, -0.2, 0), point(1.0, -1.0, 0.0, 1), point(0.0, 1.0, 0.0, 2), point(0.0, -0.2, 0.0, 3), point(0.1, -0.2, 0.0, 4)];
    let mut out = Manifold::new();
    reduce(&points, 5, UP, &[], &mut out);
    assert_eq!(out.count, 3);
    let same = [point(0.5, 0.5, 0.0, 0); 6];
    reduce(&same, 6, UP, &[], &mut out);
    assert!(out.count >= 3);
}

/// An eight-sided prism on a floor gives eight clipped points.
fn prism_scene() -> (World, u32) {
    let mut w = World::new(2, 2).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let ring = [(1.0, 0.0), (0.7071068, 0.7071068), (0.0, 1.0), (-0.7071068, 0.7071068), (-1.0, 0.0), (-0.7071068, -0.7071068), (0.0, -1.0), (0.7071068, -0.7071068)];
    let mut vertices = vec![];
    for level in [0.0f32, 0.5] {
        vertices.extend(ring.iter().map(|&(c, s)| [c, level, s]));
    }
    let bottom: Vec<u32> = (0..8).collect();
    let top: Vec<u32> = (8..16).rev().collect();
    let sides: Vec<[u32; 4]> = (0..8).map(|k| [k, k + 8, (k + 1) % 8 + 8, (k + 1) % 8]).collect();
    let mut faces: Vec<&[u32]> = vec![&bottom, &top];
    faces.extend(sides.iter().map(|side| &side[..]));
    let hull = w.add_hull(&vertices, &faces);
    assert!(hull >= 0);
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [5.0, 0.5, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, floor as usize, v3(0.0, -0.5, 0.0));
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_HULL, [hull as f32, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    (w, body)
}

fn ids(w: &World) -> Vec<u32> {
    let mut out: Vec<u32> = (0..w.uu(PAIR_CONTACTS, 0) as usize).map(|k| w.uu(CONTACT_ID, k)).collect();
    out.sort();
    out
}

#[test]
fn tiny_turns_keep_the_same_four_points() {
    let (mut w, body) = prism_scene();
    w.set_pose(body, v3(0.0, -0.005, 0.0), Q::IDENTITY, true);
    w.step(1.0 / 60.0);
    assert_eq!(w.uu(PAIR_CONTACTS, 0), 4);
    let first = ids(&w);
    let mut r = Random(5);
    for i in 0..2000 {
        // A leaning of a few tenths of a milliradian each way, and a small slide: resting contact's noise.
        let q = Q { x: r.range(-2e-4, 2e-4), y: r.range(-2e-4, 2e-4), z: r.range(-2e-4, 2e-4), w: 1.0 };
        w.set_pose(body, v3(r.range(-2e-4, 2e-4), -0.005, r.range(-2e-4, 2e-4)), q, true);
        w.set_v(LINEAR_X, body as usize, v3(0.0, 0.0, 0.0));
        w.step(1.0 / 60.0);
        assert_eq!(ids(&w), first, "turn {i}");
    }
}

#[test]
fn with_no_memory_the_same_noise_changes_the_points() {
    // The proof the memory is doing the work: forgetting each step, the same jitter swaps points.
    let (mut w, body) = prism_scene();
    w.set_pose(body, v3(0.0, -0.005, 0.0), Q::IDENTITY, true);
    w.step(1.0 / 60.0);
    let first = ids(&w);
    let mut r = Random(5);
    let mut changed = 0;
    for _ in 0..2000 {
        let q = Q { x: r.range(-2e-4, 2e-4), y: r.range(-2e-4, 2e-4), z: r.range(-2e-4, 2e-4), w: 1.0 };
        w.set_pose(body, v3(r.range(-2e-4, 2e-4), -0.005, r.range(-2e-4, 2e-4)), q, true);
        w.set_v(LINEAR_X, body as usize, v3(0.0, 0.0, 0.0));
        w.set_u(PAIR_CONTACTS, 0, 0);
        w.step(1.0 / 60.0);
        changed += (ids(&w) != first) as u32;
    }
    assert!(changed > 100, "{changed}");
}

#[test]
fn a_real_turn_still_moves_the_points() {
    // The memory is a bias, not a lock: lean the prism onto one side and the deep points must win.
    let (mut w, body) = prism_scene();
    w.set_pose(body, v3(0.0, -0.005, 0.0), Q::IDENTITY, true);
    w.step(1.0 / 60.0);
    let first = ids(&w);
    // Down towards the corner between two of the held four, by 8 mm: past what the memory forgives.
    w.set_pose(body, v3(0.0, -0.005, 0.0), Q { x: 0.003, y: 0.0, z: -0.003, w: 1.0 }, true);
    w.set_v(LINEAR_X, body as usize, v3(0.0, 0.0, 0.0));
    w.step(1.0 / 60.0);
    assert_ne!(ids(&w), first);
    let deepest = (0..w.uu(PAIR_CONTACTS, 0) as usize).map(|k| w.s(CONTACT_SEPARATION, k)).fold(0.0f32, f32::min);
    assert!(deepest < -0.01, "{deepest}");
}

#[test]
fn a_tie_between_faces_stays_with_last_steps_face() {
    let (mut data_a, mut data_b) = (BoxData::new(), BoxData::new());
    let a = box_poly(v3(1.0, 1.0, 1.0), &mut data_a);
    let b = box_poly(v3(1.0, 1.0, 1.0), &mut data_b);
    // B sits on A, tilted just enough for B's face to read 1.5 mm deeper or shallower than A's.
    let s = 0.0012f32;
    let rel = Pose { p: v3(0.0, 1.998, 0.0), q: Q { x: 0.0, y: 0.0, z: s, w: 1.0 }.normalized() };
    let (fresh, _) = sat(&a, &b, rel, 0.1).unwrap();
    let (fa, fb) = match fresh {
        Feature::FaceA(_) => (fresh, None),
        Feature::FaceB(f) => (fresh, Some(f)),
        _ => panic!("a face must win"),
    };
    let _ = (fa, fb);
    // Whichever face wins from nothing, the other, held from last step and within the bias, stays.
    for f in 0..6 {
        let held = Feature::FaceB(f);
        let (feature, _) = sat_coherent(&a, &b, rel, 0.1, Some(held)).unwrap();
        if feature == held {
            return;
        }
    }
    panic!("no face of B was held");
}

#[test]
fn a_held_face_that_has_gone_loses_to_the_real_one() {
    let (mut data_a, mut data_b) = (BoxData::new(), BoxData::new());
    let a = box_poly(v3(1.0, 1.0, 1.0), &mut data_a);
    let b = box_poly(v3(1.0, 1.0, 1.0), &mut data_b);
    let rel = Pose { p: v3(1.9, 0.0, 0.0), q: Q::IDENTITY };
    let (expected, _) = sat(&a, &b, rel, 0.1).unwrap();
    // Last step's face pointed up, nowhere near: it is far past the bias.
    for f in 0..6 {
        let up = a.normal(f).y > 0.5;
        if up {
            assert_eq!(sat_coherent(&a, &b, rel, 0.1, Some(Feature::FaceA(f))).unwrap().0, expected);
        }
    }
}

#[test]
fn a_feature_survives_its_number() {
    for feature in [Feature::FaceA(0), Feature::FaceA(5), Feature::FaceB(63)] {
        assert_eq!(Feature::from_code(feature.code()), Some(feature));
    }
    assert!(matches!(Feature::from_code(Feature::Edges(3, 4, v3(1.0, 0.0, 0.0)).code()), Some(Feature::Edges(..))));
    assert_eq!(Feature::from_code(0), None);
}
