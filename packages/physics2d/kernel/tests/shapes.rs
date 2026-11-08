// Shapes and mass of the 2D kernel against independent answers: closed forms, and a fine grid over the shape for
// rounded polygons and capsules, which shares no code with the exact sums of mass.rs.
use margoengine_physics2d_kernel::mass::mass_of;
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::{Core, MAX_VERTICES, ShapeError, WELD};

struct Random(u64);
impl Random {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
}

fn distance_to_core(core: &Core, p: V2) -> f32 {
    // Inside a polygon core: 0. Otherwise the distance to the nearest edge (or the point, or the segment).
    if core.count >= 3 && (0..core.count).all(|i| core.normals[i].dot(p.sub(core.vertices[i])) <= 0.0) {
        return 0.0;
    }
    let mut best = f32::INFINITY;
    let segments = if core.count <= 2 { 1 } else { core.count };
    for i in 0..segments {
        let (a, b) = (core.vertices[i], core.vertices[(i + 1) % core.count]);
        let ab = b.sub(a);
        let t = if ab.length_squared() > 0.0 { (p.sub(a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) } else { 0.0 };
        best = best.min(p.sub(a.add(ab.scale(t))).length());
    }
    best
}

/// Area, centre and inertia about the centre, by summing cells of a grid `cells` wide over the shape's box.
fn grid_mass(core: &Core, cells: usize) -> (f64, (f64, f64), f64) {
    let (mut lo, mut hi) = (v2(f32::INFINITY, f32::INFINITY), v2(f32::NEG_INFINITY, f32::NEG_INFINITY));
    for i in 0..core.count {
        let v = core.vertices[i];
        lo = v2(lo.x.min(v.x), lo.y.min(v.y));
        hi = v2(hi.x.max(v.x), hi.y.max(v.y));
    }
    let r = core.radius;
    let (lo, hi) = (v2(lo.x - r, lo.y - r), v2(hi.x + r, hi.y + r));
    let h = ((hi.x - lo.x).max(hi.y - lo.y) / cells as f32) as f64;
    let (mut area, mut fx, mut fy, mut second) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (nx, ny) = (((hi.x - lo.x) as f64 / h).ceil() as usize, ((hi.y - lo.y) as f64 / h).ceil() as usize);
    for i in 0..nx {
        for j in 0..ny {
            let (x, y) = (lo.x as f64 + (i as f64 + 0.5) * h, lo.y as f64 + (j as f64 + 0.5) * h);
            if distance_to_core(core, v2(x as f32, y as f32)) <= r {
                area += h * h;
                fx += h * h * x;
                fy += h * h * y;
                second += h * h * (x * x + y * y) + h * h * h * h / 6.0;
            }
        }
    }
    let (cx, cy) = (fx / area, fy / area);
    (area, (cx, cy), second - area * (cx * cx + cy * cy))
}

fn close(a: f64, b: f64, relative: f64, what: &str) {
    assert!((a - b).abs() <= relative * b.abs().max(1e-6), "{what}: {a} against {b}");
}

#[test]
fn a_box_and_a_circle_weigh_their_closed_forms() {
    let core = Core::rect(1.0, 0.5, v2(0.0, 0.0), 1.0, 0.0, 0.0).unwrap();
    let m = mass_of(&core, 3.0);
    close(m.mass as f64, 6.0, 1e-6, "box mass");
    close(m.inertia as f64, 6.0 * (4.0 + 1.0) / 12.0, 1e-6, "box inertia");
    let circle = Core::circle(v2(1.0, 2.0), 0.5).unwrap();
    let m = mass_of(&circle, 2.0);
    close(m.mass as f64, 2.0 * std::f64::consts::PI * 0.25, 1e-6, "disc mass");
    close(m.inertia as f64, 0.5 * m.mass as f64 * 0.25, 1e-6, "disc inertia");
    assert_eq!(m.center, v2(1.0, 2.0));
}

#[test]
fn rounded_polygons_and_capsules_weigh_what_a_fine_grid_gives() {
    let mut random = Random(7);
    for round in 0..12 {
        let core = if round % 3 == 0 {
            let a = v2(random.next() * 2.0 - 1.0, random.next() * 2.0 - 1.0);
            Core::capsule(a, a.add(v2(random.next() * 2.0 + 0.2, random.next() - 0.5)), 0.1 + random.next() * 0.5).unwrap()
        } else {
            let mut points = [V2::ZERO; 6];
            for p in points.iter_mut() {
                *p = v2(random.next() * 2.0 - 1.0, random.next() * 2.0 - 1.0);
            }
            match Core::polygon(&points, if round % 3 == 1 { 0.0 } else { 0.05 + random.next() * 0.4 }) {
                Ok(core) => core,
                Err(_) => continue,
            }
        };
        let exact = mass_of(&core, 1.0);
        let (area, center, inertia) = grid_mass(&core, 1500);
        close(exact.mass as f64, area, 2e-3, "area");
        assert!((exact.center.x as f64 - center.0).abs() < 2e-3 && (exact.center.y as f64 - center.1).abs() < 2e-3, "centre");
        close(exact.inertia as f64, inertia, 3e-3, "inertia");
    }
}

#[test]
fn a_polygon_is_the_counter_clockwise_hull_of_its_points_with_welds_and_lines_dropped() {
    let mut random = Random(11);
    for _ in 0..200 {
        let n = 3 + (random.next() * 30.0) as usize;
        let points: Vec<V2> = (0..n).map(|_| v2(random.next() * 4.0 - 2.0, random.next() * 4.0 - 2.0)).collect();
        match Core::polygon(&points, 0.0) {
            Ok(core) => {
                assert!(core.count >= 3 && core.count <= MAX_VERTICES);
                for i in 0..core.count {
                    let (a, b, c) = (core.vertices[i], core.vertices[(i + 1) % core.count], core.vertices[(i + 2) % core.count]);
                    assert!(b.sub(a).cross(c.sub(b)) > 0.0, "turns left at every corner");
                    assert!((core.normals[i].length() - 1.0).abs() < 1e-6);
                    for p in &points {
                        assert!(core.normals[i].dot(p.sub(a)) <= WELD, "every point inside every edge");
                    }
                }
            }
            Err(error) => assert_eq!(error, ShapeError::TooManyVertices, "{n} random points"),
        }
    }
    // A square with a doubled corner, a point on an edge and one welded to a corner is the square.
    let square = [v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0), v2(0.5, 0.0), v2(1.0, 1.0), v2(0.001, 1.0)];
    assert_eq!(Core::polygon(&square, 0.0).unwrap().count, 4);
    assert_eq!(Core::polygon(&[v2(0.0, 0.0), v2(1.0, 0.0), v2(2.0, 0.0)], 0.0), Err(ShapeError::Degenerate));
    assert_eq!(Core::polygon(&[v2(0.0, 0.0), v2(1.0, f32::NAN), v2(2.0, 1.0)], 0.0), Err(ShapeError::NotFinite));
    let octagon: Vec<V2> = (0..9).map(|i| { let a = i as f32 * 0.698; v2(a.cos(), a.sin()) }).collect();
    assert_eq!(Core::polygon(&octagon, 0.0), Err(ShapeError::TooManyVertices));
    assert_eq!(Core::capsule(v2(1.0, 1.0), v2(1.0, 1.001), 0.5).unwrap().count, 1, "ends that weld make a circle");
}
