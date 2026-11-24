// Cloth that meets itself and other cloth (src/collide.rs): sheets of particles and edges, one pinned and one falling onto it,
// do not pass through each other however fast they fall, and a sheet dropped over a sphere does not intersect itself.
mod common;
use common::*;
use std::sync::Mutex;

/// The cloth search keeps its state in the module, one world to a Wasm instance, so tests that use it take turns.
static TURN: Mutex<()> = Mutex::new(());
use margoengine_soft_kernel::collide;
use margoengine_soft_kernel::*;

struct Sheet {
    first: usize,
    n: usize,
}

/// A square grid of `n` by `n` squares of `size` metres in the plane y = `y`, centred on (cx, cz), its edges (structure and shear)
/// stiff, appended to `w`'s rows from `first`. Returns its triangles.
fn sheet(w: &mut World, first: usize, edge_first: usize, n: usize, size: f32, y: f32, centre: (f32, f32), pinned: bool) -> (Sheet, Vec<u32>, usize) {
    let width = n + 1;
    for j in 0..width {
        for i in 0..width {
            let k = first + j * width + i;
            w.x[k] = centre.0 + (i as f32 - n as f32 / 2.0) * size;
            w.y[k] = y;
            w.z[k] = centre.1 + (j as f32 - n as f32 / 2.0) * size;
            w.w[k] = if pinned { 0.0 } else { 1.0 / 0.02 };
            w.radius[k] = 0.0;
        }
    }
    let at = |i: usize, j: usize| (first + j * width + i) as u32;
    let mut triangles = Vec::new();
    let mut e = edge_first;
    let mut edge = |w: &mut World, a: u32, b: u32| {
        w.ea[e] = a;
        w.eb[e] = b;
        let (dx, dy, dz) = (w.x[a as usize] - w.x[b as usize], w.y[a as usize] - w.y[b as usize], w.z[a as usize] - w.z[b as usize]);
        w.rest[e] = (dx * dx + dy * dy + dz * dz).sqrt();
        w.omega[e] = 0.0;
        w.zeta[e] = 0.0;
        e += 1;
    };
    for j in 0..n {
        for i in 0..n {
            triangles.extend([at(i, j), at(i, j + 1), at(i + 1, j)]);
            triangles.extend([at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)]);
        }
    }
    for j in 0..width {
        for i in 0..width {
            if i < n {
                edge(w, at(i, j), at(i + 1, j));
            }
            if j < n {
                edge(w, at(i, j), at(i, j + 1));
            }
            if i < n && j < n {
                edge(w, at(i, j), at(i + 1, j + 1));
                edge(w, at(i + 1, j), at(i, j + 1));
            }
        }
    }
    (Sheet { first, n: width * width }, triangles, e)
}

fn two_sheets(speed: f32) -> (World, Sheet, Sheet, Vec<u32>) {
    // A, 8 by 8 squares of 10 cm, pinned; B, 6 by 6, wholly over it.
    let (n, m) = (8usize, 6usize);
    let (per, per_m) = ((n + 1) * (n + 1), (m + 1) * (m + 1));
    let edges = (4 * n * n + 2 * n) + (4 * m * m + 2 * m);
    let mut w = World::new();
    w.reserve(per + per_m, edges, 1, 0);
    w.particles = per + per_m;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    let (low, mut tri, e) = sheet(&mut w, 0, 0, n, 0.1, 0.0, (0.0, 0.0), true);
    let (high, upper, e) = sheet(&mut w, per, e, m, 0.1, 0.4, (0.013, 0.021), false);
    w.edges = e;
    tri.extend(upper);
    for k in per..per + per_m {
        w.vy[k] = -speed;
    }
    (w, low, high, tri)
}

#[test]
fn a_sheet_dropped_on_a_pinned_sheet_comes_to_rest_on_it_and_not_through_it() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let (mut w, _low, high, tri) = two_sheets(0.0);
    collide::configure(&tri, 0.01);
    run(&mut w, 2.0, 1.0 / 60.0, 8, 6);
    assert!(!collide::overflowed(), "the contacts fit");
    let lowest = (high.first..high.first + high.n).map(|k| w.y[k]).fold(f32::MAX, f32::min);
    assert!(lowest > 0.005, "the sheet rests on the thickness: its lowest particle is at {lowest}");
    let highest = (high.first..high.first + high.n).map(|k| w.y[k]).fold(f32::MIN, f32::max);
    assert!(highest < 0.1, "and has not bounced away: {highest}");
}

#[test]
fn a_sheet_falling_at_great_speed_is_stopped_by_the_one_below_it() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    // 200 m/s: 3.3 m in one step of 1/60 s, a hundred sheet thicknesses a substep.
    let (mut w, _low, high, tri) = two_sheets(200.0);
    collide::configure(&tri, 0.01);
    run(&mut w, 0.05, 1.0 / 60.0, 8, 6);
    let lowest = (high.first..high.first + high.n).map(|k| w.y[k]).fold(f32::MAX, f32::min);
    assert!(lowest > -0.001, "it did not pass through: lowest particle {lowest}");
    // Without the search it does.
    collide::configure(&tri, 0.0);
    let (mut w2, _, high2, _) = two_sheets(200.0);
    run(&mut w2, 0.05, 1.0 / 60.0, 8, 6);
    let through = (high2.first..high2.first + high2.n).map(|k| w2.y[k]).fold(f32::MAX, f32::min);
    assert!(through < -1.0, "the same fall with the search off goes through: {through}");
}

#[test]
fn two_crossing_strips_meet_edge_against_edge() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    // A strip along x pinned at y = 0, a strip along z falling on it: no vertex of one is near the other until their edges cross.
    let mut w = World::new();
    w.reserve(8, 10, 1, 0);
    w.particles = 8;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    let corners = [[-2.0, 0.0, -0.05], [2.0, 0.0, -0.05], [2.0, 0.0, 0.05], [-2.0, 0.0, 0.05], [-0.05, 0.4, -2.0], [0.05, 0.4, -2.0], [0.05, 0.4, 2.0], [-0.05, 0.4, 2.0]];
    for (i, c) in corners.iter().enumerate() {
        w.x[i] = c[0];
        w.y[i] = c[1];
        w.z[i] = c[2];
        w.w[i] = if i < 4 { 0.0 } else { 1.0 / 0.05 };
    }
    let mut e = 0;
    for (a, b) in [(4u32, 5u32), (5, 6), (6, 7), (7, 4), (4, 6), (0, 1), (1, 2), (2, 3), (3, 0), (0, 2)] {
        w.ea[e] = a;
        w.eb[e] = b;
        let (dx, dy, dz) = (w.x[a as usize] - w.x[b as usize], w.y[a as usize] - w.y[b as usize], w.z[a as usize] - w.z[b as usize]);
        w.rest[e] = (dx * dx + dy * dy + dz * dz).sqrt();
        e += 1;
    }
    w.edges = e;
    collide::configure(&[0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7], 0.01);
    for k in 4..8 {
        w.vy[k] = -30.0;
    }
    let mut edge_pairs = 0;
    for _ in 0..6 {
        w.step(1.0 / 60.0, 8, 6, G);
        edge_pairs += collide::contacts().iter().filter(|c| c.kind == margoengine_physics_kernel_common::cloth::EDGE_EDGE).count();
    }
    let lowest = (4..8).map(|k| w.y[k]).fold(f32::MAX, f32::min);
    // The strip is held up by its edge on the other strip: no vertex of it can reach the plane while their edges cross.
    let middle = 0.5 * (w.y[4] + w.y[6]);
    assert!(middle > 0.0, "the strip's middle ({middle}) is above the pinned strip, not through it; lowest vertex {lowest}");
    assert!(edge_pairs > 0, "the strips met edge against edge");
}

fn settle_over_sphere(thickness: f32) -> (usize, Vec<u32>, Vec<f32>) {
    // 20 by 20 squares of 5 cm, a metre across, over a sphere of radius 0.35 whose top is 0.1 m below: the sheet wraps down its
    // sides, bunching at the edges, where it meets itself.
    let n = 20;
    let per = (n + 1) * (n + 1);
    let edges = 4 * n * n + 2 * n;
    let mut w = World::new();
    w.reserve(per, edges, 1, 1);
    w.particles = per;
    w.bodies = 1;
    w.colliders = 1;
    w.gravity_scale[0] = 1.0;
    w.linear_damping[0] = 1.0;
    let (_sheet, tri, e) = sheet(&mut w, 0, 0, n, 0.05, 0.45, (0.0, 0.0), false);
    w.edges = e;
    w.c_kind[0] = SPHERE;
    w.sx[0] = 0.35;
    w.qw[0] = 1.0;
    w.friction[0] = 0.5;
    collide::configure(&tri, thickness);
    for k in 0..per {
        w.radius[k] = 0.004;
    }
    run(&mut w, 2.5, 1.0 / 60.0, 8, 4);
    for k in 0..per {
        let d = (w.x[k].powi(2) + w.y[k].powi(2) + w.z[k].powi(2)).sqrt();
        assert!(d > 0.35 - 0.01, "particle {k} is inside the sphere: {d}");
    }
    (per, tri, (0..per).flat_map(|k| [w.x[k], w.y[k], w.z[k]]).collect())
}

/// The pairs of the settled cloth closer than `thickness`.
fn close_pairs(per: usize, tri: &[u32], positions: &[f32], thickness: f32) -> usize {
    let (mut boxes, mut order, mut parent) = (vec![0.0f32; 6 * tri.len() / 3], vec![0u32; tri.len() / 3], vec![0u32; per]);
    let mut out = vec![collide::Contact::EMPTY; 1 << 15];
    let found = margoengine_physics_kernel_common::cloth::find_contacts(
        positions,
        positions,
        tri,
        thickness,
        &mut margoengine_physics_kernel_common::cloth::Scratch { boxes: &mut boxes, order: &mut order, parent: &mut parent },
        &mut out,
    );
    assert!(!found.overflow);
    found.count
}

#[test]
fn a_sheet_dropped_over_a_sphere_does_not_cut_through_itself() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let (per, tri, positions) = settle_over_sphere(0.008);
    assert_eq!(close_pairs(per, &tri, &positions, 0.003), 0, "the settled cloth has pairs closer than 3 mm");
    // The same fall with the search off leaves cloth closer than that, so the check can fail.
    let (per, tri, positions) = settle_over_sphere(0.0);
    assert!(close_pairs(per, &tri, &positions, 0.003) > 0, "without the search the cloth does touch itself");
}

/// A sheet of 6 by 6 squares on a pinned sheet of 8 by 8, both tilted by `angle` about z, the upper 1.2 cm over the lower and
/// 10 cm up the slope. Returns how far, along the slope, the upper sheet's centre has gone after `seconds` (down is negative).
fn slide_on_a_slope(angle: f32, friction: f32, seconds: f32) -> f32 {
    let (n, m) = (8usize, 6usize);
    let (per, per_m) = ((n + 1) * (n + 1), (m + 1) * (m + 1));
    let edges = (4 * n * n + 2 * n) + (4 * m * m + 2 * m);
    let mut w = World::new();
    w.reserve(per + per_m, edges, 1, 0);
    w.particles = per + per_m;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    let (_low, mut tri, e) = sheet(&mut w, 0, 0, n, 0.1, 0.0, (0.0, 0.0), true);
    let (high, upper, e) = sheet(&mut w, per, e, m, 0.1, 0.012, (0.1, 0.0), false);
    w.edges = e;
    tri.extend(upper);
    // Tilt everything about the z axis through the origin, so the slope rises towards +x.
    let (s, c) = angle.sin_cos();
    for k in 0..per + per_m {
        let (x, y) = (w.x[k], w.y[k]);
        w.x[k] = x * c - y * s;
        w.y[k] = x * s + y * c;
    }
    collide::configure(&tri, 0.01);
    collide::set_friction(friction);
    let centre = |w: &World| {
        let n = high.n as f32;
        (0..high.n).fold((0.0, 0.0), |(x, y), k| (x + w.x[high.first + k] / n, y + w.y[high.first + k] / n))
    };
    let start = centre(&w);
    run(&mut w, seconds, 1.0 / 60.0, 8, 6);
    let end = centre(&w);
    (end.0 - start.0) * c + (end.1 - start.1) * s
}

#[test]
fn a_cloth_on_a_tilted_cloth_holds_below_the_friction_angle_and_slides_above_it() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    // Coulomb: a body on a slope holds when tan(angle) is under the coefficient: 0.5 holds up to 26.6 degrees.
    let below = slide_on_a_slope(15f32.to_radians(), 0.5, 1.0);
    assert!(below.abs() < 0.01, "at 15 degrees with friction 0.5 it stays: moved {below}");
    let above = slide_on_a_slope(35f32.to_radians(), 0.5, 0.5);
    assert!(above < -0.1, "at 35 degrees it slides: moved {above}");
    // The friction is what holds it: with none, the gentle slope lets it go.
    let free = slide_on_a_slope(15f32.to_radians(), 0.0, 0.5);
    assert!(free < -0.1, "at 15 degrees without friction it slides: moved {free}");
    // And a rougher cloth holds the steeper slope: tan(35 degrees) = 0.70 against a coefficient of 0.9.
    let rough = slide_on_a_slope(35f32.to_radians(), 0.9, 1.0);
    assert!(rough.abs() < 0.02, "at 35 degrees with friction 0.9 it stays: moved {rough}");
}
