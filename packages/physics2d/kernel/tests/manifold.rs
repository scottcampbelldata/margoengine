// Manifolds against independent answers: the distance between two shapes from dense samples of their core outlines,
// and the overlap depth checked by moving one shape out along the normal by the reported depth.
use margoengine_physics2d_kernel::manifold::{collide, collide_coherent, reference_flip};
use margoengine_physics2d_kernel::math::{Rot, V2, Xf, v2};
use margoengine_physics2d_kernel::shape::Core;

struct Random(u64);
impl Random {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}

fn shape(random: &mut Random) -> Core {
    match (random.next() * 5.0) as usize {
        0 => Core::circle(v2(random.range(-0.2, 0.2), random.range(-0.2, 0.2)), random.range(0.1, 0.6)).unwrap(),
        1 => Core::capsule(v2(-random.range(0.2, 0.8), 0.0), v2(random.range(0.2, 0.8), random.range(-0.3, 0.3)), random.range(0.05, 0.4)).unwrap(),
        2 => Core::segment(v2(-random.range(0.3, 1.0), random.range(-0.2, 0.2)), v2(random.range(0.3, 1.0), random.range(-0.2, 0.2))).unwrap(),
        k => loop {
            let points: Vec<V2> = (0..6).map(|_| v2(random.range(-0.7, 0.7), random.range(-0.7, 0.7))).collect();
            if let Ok(core) = Core::polygon(&points, if k == 3 { 0.0 } else { random.range(0.02, 0.3) }) {
                break core;
            }
        },
    }
}

fn pose(random: &mut Random, spread: f32) -> Xf {
    let angle = random.range(-3.1, 3.1);
    Xf { p: v2(random.range(-spread, spread), random.range(-spread, spread)), q: Rot::from_pair(angle.cos(), angle.sin()) }
}

/// Points along the core's outline (the point of a circle, the segment of a capsule), in world space.
fn outline(core: &Core, xf: Xf) -> Vec<V2> {
    let mut points = Vec::new();
    let segments = match core.count { 1 => 0, 2 => 1, n => n };
    if segments == 0 {
        points.push(xf.apply(core.vertices[0]));
    }
    for i in 0..segments {
        let (a, b) = (core.vertices[i], core.vertices[(i + 1) % core.count]);
        for k in 0..=600 {
            points.push(xf.apply(a.lerp(b, k as f32 / 600.0)));
        }
    }
    points
}

/// The sampled distance between the shapes' surfaces: outline to outline less both radii.
fn sampled_gap(a: &Core, xa: Xf, b: &Core, xb: Xf) -> f32 {
    let (pa, pb) = (outline(a, xa), outline(b, xb));
    let mut best = f32::INFINITY;
    for p in &pa {
        for q in &pb {
            best = best.min(p.sub(*q).length_squared());
        }
    }
    best.sqrt() - a.radius - b.radius
}

fn moved(xf: Xf, by: V2) -> Xf {
    Xf { p: xf.p.add(by), q: xf.q }
}

#[test]
fn every_pair_of_shapes_reports_the_gap_or_the_depth_that_separates_them() {
    let mut random = Random(3);
    let (mut apart, mut overlapping) = (0, 0);
    for _ in 0..4000 {
        let (a, b) = (shape(&mut random), shape(&mut random));
        let (xa, xb) = (pose(&mut random, 0.3), pose(&mut random, 1.2));
        let m = collide(&a, xa, &b, xb, 0.5);
        if m.count == 0 {
            assert!(sampled_gap(&a, xa, &b, xb) > 0.5 - 2e-3, "a pair within reach has no points");
            continue;
        }
        assert!((m.normal.length() - 1.0).abs() < 1e-5);
        let least = m.points[..m.count].iter().map(|p| p.separation).fold(f32::INFINITY, f32::min);
        if least > 0.0 {
            apart += 1;
            let gap = sampled_gap(&a, xa, &b, xb);
            assert!((least - gap).abs() < 3e-3, "reported gap {least} against sampled {gap}
{a:?}
{xa:?}
{b:?}
{xb:?}
{m:?}");
        } else {
            overlapping += 1;
            // Moving B out along the normal by the depth, plus 1 cm, must leave it 1 cm apart.
            let out = moved(xb, m.normal.scale(-least + 0.01));
            let gap = sampled_gap(&a, xa, &b, out);
            assert!((gap - 0.01).abs() < 3e-3, "depth {least}: moved out the shapes stand {gap} apart");
        }
    }
    assert!(apart > 100 && overlapping > 100, "{apart} apart, {overlapping} overlapping");
}

#[test]
fn a_box_on_a_box_has_two_points_whose_ids_hold_while_it_slides() {
    let ground = Core::rect(5.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let crate_ = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let at = |x: f32, y: f32| Xf { p: v2(x, y), q: Rot::IDENTITY };
    let m = collide(&ground, at(0.0, 0.0), &crate_, at(0.3, 1.0 - 0.002), 0.02);
    assert_eq!(m.count, 2);
    assert!((m.normal.y - 1.0).abs() < 1e-6 && m.normal.x == 0.0);
    for p in &m.points {
        assert!((p.separation + 0.002).abs() < 1e-6, "{}", p.separation);
        assert!((p.point.y - 0.499).abs() < 1e-5);
    }
    let later = collide(&ground, at(0.0, 0.0), &crate_, at(0.31, 1.0 - 0.0021), 0.02);
    assert_eq!([m.points[0].id, m.points[1].id], [later.points[0].id, later.points[1].id]);
    // Apart by 1 cm the points are speculative; apart by more than the margin there are none.
    assert_eq!(collide(&ground, at(0.0, 0.0), &crate_, at(0.3, 1.01), 0.02).count, 2);
    assert_eq!(collide(&ground, at(0.0, 0.0), &crate_, at(0.3, 1.03), 0.02).count, 0);
}

#[test]
fn rounded_corners_meet_at_one_point_and_a_lying_capsule_at_two() {
    let rounded = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).map(|c| Core { radius: 0.1, ..c }).unwrap();
    // Corner to corner along the diagonal: one point on the line between the corners.
    let m = collide(&rounded, Xf::IDENTITY, &rounded, Xf { p: v2(1.25, 1.25), q: Rot::IDENTITY }, 0.5);
    assert_eq!(m.count, 1);
    let diagonal = std::f32::consts::FRAC_1_SQRT_2;
    assert!((m.normal.x - diagonal).abs() < 1e-5 && (m.normal.y - diagonal).abs() < 1e-5);
    assert!((m.points[0].separation - (0.25 * 2f32.sqrt() - 0.2)).abs() < 1e-5);
    // A capsule lying on a box, tilted a little: both ends.
    let ground = Core::rect(5.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let capsule = Core::capsule(v2(-1.0, 0.0), v2(1.0, 0.0), 0.25).unwrap();
    let tilt = 0.002f32;
    let m = collide(&ground, Xf::IDENTITY, &capsule, Xf { p: v2(0.0, 0.749), q: Rot::from_pair(1.0, tilt) }, 0.05);
    assert_eq!(m.count, 2);
    assert!(m.points[0].separation < 0.0 || m.points[1].separation < 0.0);
}

#[test]
fn a_box_rocking_on_a_box_keeps_its_point_ids_through_level() {
    // A unit box resting 2 mm into a unit box below, tilting from -0.01 to 0.01 rad, each manifold built from the last:
    // as it passes level the two faces' separations cross, and the reference face, with it every id, must not change
    // (each point would lose its warm start), nor may a clipped end be renamed.
    let below = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let above = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let rest = Xf { p: v2(0.0, 0.0), q: Rot::IDENTITY };
    let mut last = None;
    let mut previous: Option<[u32; 2]> = None;
    for step in 0..=400 {
        let angle = -0.01 + 0.02 * step as f32 / 400.0;
        let xf = Xf { p: v2(0.1, 1.0 - 0.002), q: Rot::from_pair(angle.cos(), angle.sin()) };
        let m = collide_coherent(&below, rest, &above, xf, 0.02, last);
        assert_eq!(m.count, 2, "step {step}");
        let ids = [m.points[0].id, m.points[1].id];
        if let Some(old) = previous {
            for id in ids {
                assert!(old.contains(&id), "step {step}, angle {angle}: id {id:#x} is not among the last {old:x?}");
            }
        }
        previous = Some(ids);
        last = reference_flip(&m);
    }
}
