// Cylinders and cones, plain and with a border: mass against Rapier's closed forms and a numeric integral, rays and point
// projections against brute force, contacts that hold a cap, a side line or a point, and bodies that come to rest where
// the shape says.
use margoengine_physics_kernel::cast::Solid;
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::narrow::Manifold;
use margoengine_physics_kernel::query::{ray_cone, ray_cylinder};
use margoengine_physics_kernel::revolve::{Revolved, revolved_mass};
use margoengine_physics_kernel::sat::Pose;
use margoengine_physics_kernel::smooth::collide_solids;
use margoengine_physics_kernel::world::World;

const DT: f32 = 1.0 / 60.0;
const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
/// A quarter turn about Z: local Y along world -X.
const ON_SIDE: [f32; 4] = [0.0, 0.0, 0.707_106_8, 0.707_106_8];

const CYLINDER: Revolved = Revolved { cone: false, r: 0.5, h: 1.0 };
const CONE: Revolved = Revolved { cone: true, r: 0.5, h: 1.0 };

/// A small deterministic generator, so a failure repeats.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    fn range(&mut self, low: f32, high: f32) -> f32 {
        low + (high - low) * self.next()
    }
    fn unit(&mut self) -> V3 {
        loop {
            let v = v3(self.range(-1.0, 1.0), self.range(-1.0, 1.0), self.range(-1.0, 1.0));
            let l = v.dot(v);
            if l > 0.01 && l <= 1.0 {
                return v.scale(1.0 / sqrt(l));
            }
        }
    }
}

/// Distance from a profile point to the core's profile (0 inside), in f64.
fn profile_distance(shape: Revolved, rho: f64, y: f64) -> f64 {
    let (r, h) = (shape.r as f64, shape.h as f64);
    let segment = |a: (f64, f64), b: (f64, f64)| {
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let t = (((rho - a.0) * ex + (y - a.1) * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
        let (dx, dy) = (rho - a.0 - ex * t, y - a.1 - ey * t);
        (dx * dx + dy * dy).sqrt()
    };
    let inside = if shape.cone { y >= -h && y <= h && rho <= r * (h - y) / (2.0 * h) } else { y.abs() <= h && rho <= r };
    if inside {
        return 0.0;
    }
    if shape.cone {
        segment((0.0, h), (r, -h)).min(segment((r, -h), (0.0, -h)))
    } else {
        segment((0.0, h), (r, h)).min(segment((r, h), (r, -h))).min(segment((r, -h), (0.0, -h)))
    }
}

/// Mass, centre height and moments of a solid of revolution by the midpoint rule on a fine grid of its profile.
fn integrated(shape: Revolved, b: f64, density: f64) -> (f64, f64, f64, f64) {
    let n = 2400;
    let (top, side) = (shape.h as f64 + b, shape.r as f64 + b);
    let (dr, dy) = (side / n as f64, 2.0 * top / n as f64);
    let (mut m0, mut m1, mut m3, mut m12) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..n {
        let rho = (i as f64 + 0.5) * dr;
        for j in 0..n {
            let y = -top + (j as f64 + 0.5) * dy;
            if profile_distance(shape, rho, y) <= b {
                let a = dr * dy;
                m0 += rho * a;
                m1 += rho * y * a;
                m3 += rho * rho * rho * a;
                m12 += rho * y * y * a;
            }
        }
    }
    let ring = 2.0 * std::f64::consts::PI * density;
    let mass = ring * m0;
    let center = m1 / m0;
    (mass, center, ring * (0.5 * m3 + m12) - mass * center * center, ring * m3)
}

#[test]
fn plain_cylinders_and_cones_weigh_what_rapier_gives() {
    // Rapier 0.21 through its npm API, radius 0.5, half height 1, density 2 (outputs only).
    let (mass, center, moments) = revolved_mass(CYLINDER, 0.0, 2.0);
    assert!((mass - 3.141_593).abs() < 2e-6, "{mass}");
    assert_eq!(center, 0.0);
    assert!((moments.x - 1.243_547).abs() < 2e-6 && (moments.y - 0.392_699).abs() < 2e-6, "{moments:?}");
    let (mass, center, moments) = revolved_mass(CONE, 0.0, 2.0);
    assert!((mass - 1.047_198).abs() < 2e-6, "{mass}");
    assert!((center + 0.5).abs() < 1e-6, "{center}");
    assert!((moments.x - 0.196_35).abs() < 2e-6 && (moments.y - 0.078_54).abs() < 2e-6, "{moments:?}");
}

#[test]
fn a_border_adds_its_volume_as_a_numeric_integral_finds_it() {
    for shape in [CYLINDER, CONE, Revolved { cone: true, r: 2.0, h: 0.2 }, Revolved { cone: false, r: 0.1, h: 2.0 }] {
        for b in [0.0f32, 0.05, 0.3] {
            let (mass, center, moments) = revolved_mass(shape, b, 1.5);
            let (m, c, across, along) = integrated(shape, b as f64, 1.5);
            let close = |a: f32, e: f64, what: &str| {
                assert!(((a as f64) - e).abs() <= 2e-3 * e.abs().max(1e-3), "{shape:?} border {b} {what}: {a} against {e}");
            };
            close(mass, m, "mass");
            assert!(((center as f64) - c).abs() < 2e-3 * (shape.h as f64 + b as f64), "{shape:?} border {b} centre {center} against {c}");
            close(moments.x, across, "across");
            close(moments.y, along, "along");
        }
    }
}

/// Where a ray from `o` along `d` first enters the solid, by fine steps then bisection on the inside test.
fn brute_ray(shape: Revolved, b: f32, o: V3, d: V3, max: f32) -> Option<f32> {
    let inside = |t: f32| {
        let p = o.add(d.scale(t));
        profile_distance(shape, ((p.x * p.x + p.z * p.z) as f64).sqrt(), p.y as f64) <= b as f64
    };
    let steps = 20_000;
    let mut last = 0.0;
    for k in 1..=steps {
        let t = max * k as f32 / steps as f32;
        if inside(t) {
            let (mut low, mut high) = (last, t);
            for _ in 0..40 {
                let mid = 0.5 * (low + high);
                if inside(mid) { high = mid } else { low = mid }
            }
            return Some(high);
        }
        last = t;
    }
    None
}

#[test]
fn rays_hit_cylinders_and_cones_where_brute_force_does() {
    let mut rng = Rng(7);
    let (mut hits, mut misses) = (0, 0);
    for shape in [CYLINDER, CONE] {
        for b in [0.0f32, 0.1] {
            let mut w = World::new(2, 2).unwrap();
            let body = w.add_body(FIXED).unwrap();
            let kind = if shape.cone { SHAPE_CONE } else { SHAPE_CYLINDER };
            let c = w.add_collider(body, kind, [shape.r, shape.h, b], [0.0; 3], ID, 1.0).unwrap() as usize;
            for _ in 0..400 {
                let o = rng.unit().scale(3.0);
                let aim = v3(rng.range(-0.7, 0.7), rng.range(-1.2, 1.2), rng.range(-0.7, 0.7));
                let d = aim.sub(o);
                let d = d.scale(1.0 / sqrt(d.dot(d)));
                let expect = brute_ray(shape, b, o, d, 6.0);
                let got = if b == 0.0 {
                    if shape.cone { ray_cone(o, d, shape.r, shape.h, 6.0, true) } else { ray_cylinder(o, d, shape.r, shape.h, 6.0, true) }
                } else {
                    w.ray_collider(c, o, d, 6.0, true)
                };
                assert_eq!(got.is_some(), expect.is_some(), "{shape:?} border {b} from {o:?} along {d:?}: {got:?} against {expect:?}");
                if let (Some(hit), Some(t)) = (got, expect) {
                    assert!((hit.t - t).abs() < 2e-4, "{shape:?} border {b}: {} against {t}", hit.t);
                    // The normal is the surface's: a step back along it leaves the solid, a step in enters it.
                    let at = o.add(d.scale(hit.t));
                    let outside = |p: V3| profile_distance(shape, ((p.x * p.x + p.z * p.z) as f64).sqrt(), p.y as f64) > b as f64;
                    assert!(outside(at.add(hit.normal.scale(1e-3))) && !outside(at.sub(hit.normal.scale(1e-3))), "{shape:?} normal {:?}", hit.normal);
                    hits += 1;
                } else {
                    misses += 1;
                }
                // Through the kernel's dispatch too.
                if let Some(hit) = w.ray_collider(c, o, d, 6.0, true)
                    && let Some(t) = expect
                {
                    assert!((hit.t - t).abs() < 2e-4);
                }
            }
        }
    }
    assert!(hits > 400 && misses > 100, "{hits} hits, {misses} misses");
}

#[test]
fn a_ray_from_inside_hits_at_zero_or_where_it_leaves() {
    for (shape, b) in [(CYLINDER, 0.0f32), (CONE, 0.0), (CYLINDER, 0.1), (CONE, 0.1)] {
        let mut w = World::new(2, 2).unwrap();
        let body = w.add_body(FIXED).unwrap();
        let kind = if shape.cone { SHAPE_CONE } else { SHAPE_CYLINDER };
        let c = w.add_collider(body, kind, [shape.r, shape.h, b], [0.0; 3], ID, 1.0).unwrap() as usize;
        let o = v3(0.0, -0.5, 0.0);
        assert_eq!(w.ray_collider(c, o, v3(1.0, 0.0, 0.0), 10.0, true).unwrap().t, 0.0);
        let out = w.ray_collider(c, o, v3(1.0, 0.0, 0.0), 10.0, false).unwrap();
        // At y = -0.5 a cone of radius 0.5 and half height 1 is 0.375 wide.
        let side = if b > 0.0 { brute_leave(shape, b, o) } else if shape.cone { 0.375 } else { 0.5 };
        assert!((out.t - side).abs() < 2e-4, "{shape:?} border {b}: left at {} not {side}", out.t);
        assert!(out.normal.x < -0.9, "faces the ray: {:?}", out.normal);
    }
}

/// The first time a line meets the sharp cone (x^2 + z^2 <= k^2 (h - y)^2, y <= h, y >= -h), worked in f64 from the
/// same f32 inputs: the reference for a ray from far away, which an f32 solve from the ray's own start loses to
/// cancellation.
fn exact_cone_entry(shape: Revolved, o: V3, d: V3) -> Option<f64> {
    let (ox, oy, oz, dx, dy, dz) = (o.x as f64, o.y as f64, o.z as f64, d.x as f64, d.y as f64, d.z as f64);
    let (r, h) = (shape.r as f64, shape.h as f64);
    let k2 = (r / (2.0 * h)) * (r / (2.0 * h));
    let w0 = h - oy;
    let a = dx * dx + dz * dz - k2 * dy * dy;
    let b = ox * dx + oz * dz + k2 * w0 * dy;
    let c = ox * ox + oz * oz - k2 * w0 * w0;
    let disc = b * b - a * c;
    if a <= 0.0 || disc < 0.0 {
        return None;
    }
    let (t0, t1) = ((-b - disc.sqrt()) / a, (-b + disc.sqrt()) / a);
    // Only rays that cross the side between the base and the apex are drawn, so the side's entry is the touch.
    let y0 = oy + dy * t0;
    if y0 < -h || y0 > h || t1 <= t0 {
        return None;
    }
    Some(t0)
}

#[test]
fn a_ray_from_far_away_meets_a_sharp_cone_to_the_rounding_of_its_length() {
    // Regression: the cone's quadratic, solved from a start 20 to 400 lengths away, cancelled to 15 ulp of the distance.
    let mut rng = Rng(11);
    let mut w = World::new(2, 2).unwrap();
    let body = w.add_body(FIXED).unwrap();
    let c = w.add_collider(body, SHAPE_CONE, [CONE.r, CONE.h, 0.0], [0.0; 3], ID, 1.0).unwrap() as usize;
    let mut checked = 0;
    let mut worst = 0.0f64;
    for _ in 0..2000 {
        // Aim at a point on the side, from far off in a direction that keeps the ray shallower than the side.
        let y = rng.range(-0.8, 0.8);
        let angle = rng.range(0.0, 6.283_185);
        let rho = 0.25 * (CONE.h - y);
        let aim = v3(rho * angle.cos(), y, rho * angle.sin());
        let out = v3(angle.cos(), rng.range(-0.6, 0.6), angle.sin());
        let o = aim.add(out.scale(rng.range(20.0, 400.0)));
        let d = aim.sub(o);
        let d = d.scale(1.0 / sqrt(d.dot(d)));
        let Some(exact) = exact_cone_entry(CONE, o, d) else { continue };
        for hit in [ray_cone(o, d, CONE.r, CONE.h, 1000.0, true), w.ray_collider(c, o, d, 1000.0, true)] {
            let hit = hit.expect("the ray crosses the side");
            let error = (hit.t as f64 - exact).abs() / exact;
            worst = worst.max(error);
            // Four units in the last place of the distance.
            assert!(error < 4.0 * f32::EPSILON as f64, "from {o:?} along {d:?}: {} against {exact}", hit.t);
        }
        checked += 1;
    }
    assert!(checked > 1000, "{checked} rays checked");
    eprintln!("worst relative error {worst:e}");
}

/// Where a ray from inside along +X leaves, by bisection.
fn brute_leave(shape: Revolved, b: f32, o: V3) -> f32 {
    let (mut low, mut high) = (0.0f64, 5.0f64);
    for _ in 0..60 {
        let mid = 0.5 * (low + high);
        if profile_distance(shape, (o.x as f64 + mid).abs(), o.y as f64) <= b as f64 { low = mid } else { high = mid }
    }
    low as f32
}

#[test]
fn points_project_onto_cylinders_and_cones_as_brute_force_finds() {
    let mut rng = Rng(11);
    for shape in [CYLINDER, CONE] {
        for b in [0.0f32, 0.2] {
            let mut w = World::new(2, 2).unwrap();
            let body = w.add_body(FIXED).unwrap();
            let kind = if shape.cone { SHAPE_CONE } else { SHAPE_CYLINDER };
            let turn = Q::from_rotation_vector(v3(0.3, -0.2, 0.5));
            let at = v3(0.5, 1.0, -0.25);
            let c = w.add_collider(body, kind, [shape.r, shape.h, b], [at.x, at.y, at.z], [turn.x, turn.y, turn.z, turn.w], 1.0).unwrap() as usize;
            for _ in 0..300 {
                let local = v3(rng.range(-1.5, 1.5), rng.range(-2.0, 2.0), rng.range(-1.5, 1.5));
                let p = at.add(turn.rotate(local));
                let got = w.project_collider(c, p, false).unwrap();
                let back = turn.unrotate(got.point.sub(at));
                let rho = ((back.x * back.x + back.z * back.z) as f64).sqrt();
                let on = profile_distance(shape, rho, back.y as f64);
                assert!((on - b as f64).abs() < 1e-4, "{shape:?} border {b}: the projection is {on} off the core, not {b}");
                let distance = sqrt(got.point.sub(p).dot(got.point.sub(p)));
                let from_core = profile_distance(shape, ((local.x * local.x + local.z * local.z) as f64).sqrt(), local.y as f64);
                assert_eq!(got.inside, from_core <= b as f64, "{shape:?} border {b} at {local:?}");
                if !got.inside {
                    assert!((distance as f64 - (from_core - b as f64)).abs() < 1e-4, "{shape:?}: {distance} against {}", from_core - b as f64);
                }
                if got.inside {
                    assert_eq!(w.project_collider(c, p, true).unwrap().point, p);
                }
            }
        }
    }
}

fn solid(shape: Revolved, b: f32, p: V3, q: Q) -> Solid {
    Solid::Revolved { shape, border: b, pose: Pose { p, q } }
}

fn floor() -> (margoengine_physics_kernel::hull::BoxData, V3) {
    (margoengine_physics_kernel::hull::BoxData::new(), v3(3.0, 0.5, 3.0))
}

#[test]
fn a_cylinder_on_a_floor_touches_with_its_cap_rim_or_side() {
    let (mut data, half) = floor();
    let ground = Solid::Poly { poly: margoengine_physics_kernel::hull::box_poly(half, &mut data), pose: Pose { p: v3(0.0, -0.5, 0.0), q: Q::IDENTITY } };
    let mut m = Manifold::new();
    // Upright, 1 cm in: four points on the rim, every one 1 cm deep, normal straight up.
    collide_solids(&ground, &solid(CYLINDER, 0.0, v3(0.2, 0.99, 0.1), Q::IDENTITY), 0.04, &mut m);
    assert_eq!(m.count, 4);
    assert!(m.normal.sub(v3(0.0, 1.0, 0.0)).dot(m.normal.sub(v3(0.0, 1.0, 0.0))) < 1e-12, "{:?}", m.normal);
    for p in &m.points[..4] {
        assert!((p.separation + 0.01).abs() < 1e-5, "{}", p.separation);
        let rim = p.on_b.sub(v3(0.2, 0.0, 0.1));
        assert!((sqrt(rim.x * rim.x + rim.z * rim.z) - 0.5).abs() < 1e-5, "on the rim: {:?}", p.on_b);
        assert!(p.on_a.y.abs() < 1e-6, "on the floor: {:?}", p.on_a);
    }
    // With a border of 0.1 the same pose is 11 cm in.
    collide_solids(&ground, &solid(CYLINDER, 0.1, v3(0.2, 0.99, 0.1), Q::IDENTITY), 0.04, &mut m);
    assert_eq!(m.count, 4);
    assert!((m.points[0].separation + 0.11).abs() < 1e-5);
    // On its side: two points at the ends of the side line.
    let side = Q::from_rotation_vector(v3(0.0, 0.0, HALF_PI));
    collide_solids(&ground, &solid(CYLINDER, 0.0, v3(0.0, 0.495, 0.0), side), 0.04, &mut m);
    assert_eq!(m.count, 2);
    for p in &m.points[..2] {
        assert!((p.separation + 0.005).abs() < 1e-5 && (p.on_b.x.abs() - 1.0).abs() < 1e-5, "{p:?}");
    }
    // Tipped onto its rim: one point.
    let tipped = Q::from_rotation_vector(v3(0.0, 0.0, 0.4));
    let low = tipped.rotate(v3(0.5, -1.0, 0.0)).y.min(tipped.rotate(v3(-0.5, -1.0, 0.0)).y);
    collide_solids(&ground, &solid(CYLINDER, 0.0, v3(0.0, -low - 0.002, 0.0), tipped), 0.04, &mut m);
    assert_eq!(m.count, 1);
    assert!((m.points[0].separation + 0.002).abs() < 1e-5, "{}", m.points[0].separation);
}

#[test]
fn a_cone_touches_with_its_base_side_line_or_apex() {
    let (mut data, half) = floor();
    let ground = Solid::Poly { poly: margoengine_physics_kernel::hull::box_poly(half, &mut data), pose: Pose { p: v3(0.0, -0.5, 0.0), q: Q::IDENTITY } };
    let mut m = Manifold::new();
    collide_solids(&ground, &solid(CONE, 0.0, v3(0.0, 0.99, 0.0), Q::IDENTITY), 0.04, &mut m);
    assert_eq!(m.count, 4, "the base");
    // Lying on its side line: the side's slope is atan(r / 2h) off the axis.
    let lean = HALF_PI + atan2(0.5, 2.0);
    let q = Q::from_rotation_vector(v3(0.0, 0.0, lean));
    let apex = q.rotate(v3(0.0, 1.0, 0.0));
    collide_solids(&ground, &solid(CONE, 0.0, v3(0.0, -apex.y - 0.003, 0.0), q), 0.04, &mut m);
    assert_eq!(m.count, 2, "the side line");
    for p in &m.points[..2] {
        assert!((p.separation + 0.003).abs() < 2e-5, "{}", p.separation);
    }
    // Upside down on its apex: one point.
    let flip = Q::from_rotation_vector(v3(PI, 0.0, 0.0));
    collide_solids(&ground, &solid(CONE, 0.0, v3(0.0, 0.998, 0.0), flip), 0.04, &mut m);
    assert_eq!(m.count, 1);
    assert!((m.points[0].separation + 0.002).abs() < 1e-5);
}

#[test]
fn two_cylinders_stacked_and_side_by_side() {
    let mut m = Manifold::new();
    collide_solids(&solid(CYLINDER, 0.0, v3(0.0, 0.0, 0.0), Q::IDENTITY), &solid(CYLINDER, 0.0, v3(0.1, 1.995, 0.0), Q::IDENTITY), 0.04, &mut m);
    assert_eq!(m.count, 4, "cap on cap");
    assert!((m.points[0].separation + 0.005).abs() < 1e-5);
    let side = Q::from_rotation_vector(v3(0.0, 0.0, HALF_PI));
    collide_solids(&solid(CYLINDER, 0.0, v3(0.0, 0.0, 0.0), side), &solid(CYLINDER, 0.0, v3(0.3, 0.998, 0.0), side), 0.04, &mut m);
    assert_eq!(m.count, 2, "side along side");
    for p in &m.points[..2] {
        assert!((p.separation + 0.002).abs() < 1e-4, "{}", p.separation);
    }
    // A ball on the cap, and one against the side.
    let ball = Solid::Round { p: v3(0.2, 1.29, 0.0), q: v3(0.2, 1.29, 0.0), r: 0.3 };
    collide_solids(&solid(CYLINDER, 0.0, v3(0.0, 0.0, 0.0), Q::IDENTITY), &ball, 0.04, &mut m);
    assert_eq!(m.count, 1);
    assert!((m.points[0].separation + 0.01).abs() < 1e-5 && (m.normal.y - 1.0).abs() < 1e-6);
    let ball = Solid::Round { p: v3(0.79, 0.3, 0.0), q: v3(0.79, 0.3, 0.0), r: 0.3 };
    collide_solids(&solid(CYLINDER, 0.0, v3(0.0, 0.0, 0.0), Q::IDENTITY), &ball, 0.04, &mut m);
    assert_eq!(m.count, 1);
    assert!((m.points[0].separation + 0.01).abs() < 1e-5 && (m.normal.x - 1.0).abs() < 1e-5, "{:?}", m.points[0]);
}

fn drop(kind: u32, size: [f32; 3], at: V3, rotation: [f32; 4]) -> (World, u32) {
    let mut w = World::new(4, 4).unwrap();
    let ground = w.add_body(FIXED).unwrap();
    w.add_collider(ground, SHAPE_BOX, [10.0, 0.5, 10.0], [0.0, -0.5, 0.0], ID, 0.0).unwrap();
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, kind, size, [0.0; 3], rotation, 1.0).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    (w, body)
}

#[test]
fn cylinders_and_cones_come_to_rest_where_their_shape_says() {
    // (shape, size, start, turn, rest height of the body's origin, what stays still)
    let lean = HALF_PI + atan2(0.5, 2.0);
    let cone_side = Q::from_rotation_vector(v3(0.0, 0.0, lean));
    let side_height = -cone_side.rotate(v3(0.0, 1.0, 0.0)).y;
    let cases: [(u32, [f32; 3], [f32; 4], f32); 6] = [
        (SHAPE_CYLINDER, [0.5, 1.0, 0.0], ID, 1.0),
        (SHAPE_CYLINDER, [0.5, 1.0, 0.1], ID, 1.1),
        (SHAPE_CYLINDER, [0.5, 1.0, 0.0], ON_SIDE, 0.5),
        (SHAPE_CONE, [0.5, 1.0, 0.0], ID, 1.0),
        (SHAPE_CONE, [0.5, 1.0, 0.05], ID, 1.05),
        (SHAPE_CONE, [0.5, 1.0, 0.0], [cone_side.x, cone_side.y, cone_side.z, cone_side.w], side_height),
    ];
    for (kind, size, rotation, rest) in cases {
        let (mut w, body) = drop(kind, size, v3(0.0, rest + 0.05, 0.0), rotation);
        for _ in 0..240 {
            w.step(DT);
        }
        let at = body as usize;
        // The collider's origin, as its body's centre of mass is not there for a cone.
        let origin = w.v(POSITION_X, at);
        let (v, spin) = (w.v(LINEAR_X, at), w.v(ANGULAR_X, at));
        println!("{kind} {size:?}: origin y {}, speed {:e}, spin {:e}", origin.y, sqrt(v.dot(v)), sqrt(spin.dot(spin)));
        assert!((origin.y - rest).abs() < 0.01, "{kind} {size:?} rests at {} not {rest}", origin.y);
        assert!(sqrt(v.dot(v)) < 1e-3 && sqrt(spin.dot(spin)) < 1e-2, "{kind} {size:?} still moves");
        let q = w.q(ROTATION_X, at);
        assert!(q.w.abs() > 0.999, "{kind} {size:?} turned: {q:?}");
    }
}

#[test]
fn a_cylinder_part_weighs_what_a_cylinder_collider_weighs() {
    let mut w = World::new(4, 8).unwrap();
    let one = w.add_body(DYNAMIC).unwrap();
    let c = w.add_collider(one, SHAPE_COMPOUND, [0.0; 3], [0.0; 3], ID, 1.0).unwrap();
    w.add_compound_part(c, SHAPE_CYLINDER, [0.4, 0.6, 0.05], [0.0, 1.0, 0.0], ID).unwrap();
    w.add_compound_part(c, SHAPE_CONE, [0.3, 0.5, 0.0], [1.0, 0.0, 0.0], ON_SIDE).unwrap();
    let two = w.add_body(DYNAMIC).unwrap();
    w.add_collider(two, SHAPE_CYLINDER, [0.4, 0.6, 0.05], [0.0, 1.0, 0.0], ID, 1.0).unwrap();
    w.add_collider(two, SHAPE_CONE, [0.3, 0.5, 0.0], [1.0, 0.0, 0.0], ON_SIDE, 1.0).unwrap();
    for column in [INVERSE_MASS, LOCAL_CENTER_X, LOCAL_CENTER_Y, LOCAL_CENTER_Z, INERTIA_X, INERTIA_Y, INERTIA_Z] {
        assert_eq!(w.s(column, one as usize).to_bits(), w.s(column, two as usize).to_bits(), "column {column}");
    }
    // The quarter turn takes the cone's local -Y, where its centre of mass lies, to +X.
    let center = w.v(LOCAL_CENTER_X, two as usize);
    assert!(center.x > 0.0 && center.y > 0.0, "{center:?}");
}
