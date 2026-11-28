// Measured bending (bend.rs): each triangle's curvature tensor from Bergou et al.'s hinge vectors stores a plate's
// B/2 (k11^2 + 2 k12^2 + k22^2) per area: a cylinder along either thread and a saddle take exactly that over the triangles
// that see their bend, a flat sheet nothing, the warp's rigidity along the warp and the weft's across; the exact solve keeps
// the momentum and lowers the energy; the vertex block solve reaches the same place.
mod common;
use margoengine_soft_kernel::World;
use margoengine_soft_kernel::bend::{BEND_BLOCK, BEND_NONE};

/// A flat n by n sheet of spacing `d` in the xy plane, each cell split along its (i, j)-(i+1, j+1) diagonal, the warp along x,
/// with one bending element a triangle of rigidity `warp` along x and `weft` along y. No edges.
fn sheet(n: usize, d: f32, warp: f32, weft: f32) -> World {
    let mut w = World::new();
    w.reserve(n * n, 0, 1, 0);
    w.particles = n * n;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    let id = |i: usize, j: usize| (i * n + j) as u32;
    for i in 0..n {
        for j in 0..n {
            let k = i * n + j;
            w.x[k] = i as f32 * d;
            w.y[k] = j as f32 * d;
            w.w[k] = 1.0;
            w.radius[k] = 0.01;
        }
    }
    let mut triangles = Vec::new();
    for i in 0..n - 1 {
        for j in 0..n - 1 {
            triangles.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
            triangles.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
        }
    }
    let length = |w: &World, p: u32, q: u32| {
        let (p, q) = (p as usize, q as usize);
        ((w.x[p] - w.x[q]).powi(2) + (w.y[p] - w.y[q]).powi(2) + (w.z[p] - w.z[q]).powi(2)).sqrt()
    };
    // The far corner across each edge of each triangle.
    let across = |a: u32, b: u32, own: usize| {
        for (t, tri) in triangles.iter().enumerate() {
            if t == own {
                continue;
            }
            for k in 0..3 {
                let (p, q) = (tri[k], tri[(k + 1) % 3]);
                if (p == a && q == b) || (p == b && q == a) {
                    return tri[(k + 2) % 3];
                }
            }
        }
        BEND_NONE
    };
    w.reserve_bends(triangles.len());
    for (s, t) in triangles.iter().enumerate() {
        let far = [across(t[0], t[1], s), across(t[1], t[2], s), across(t[2], t[0], s)];
        let sides = [length(&w, t[0], t[1]), length(&w, t[1], t[2]), length(&w, t[2], t[0])];
        let mut spokes = [0.0f32; 6];
        for k in 0..3 {
            if far[k] != BEND_NONE {
                spokes[2 * k] = length(&w, t[k], far[k]);
                spokes[2 * k + 1] = length(&w, t[(k + 1) % 3], far[k]);
            }
        }
        // The side along x (the warp), if the triangle has one.
        let warp_side = (0..3).find(|&k| (w.y[t[k] as usize] - w.y[t[(k + 1) % 3] as usize]).abs() < 1e-9).map_or(3, |k| k as u32);
        w.set_bend(s, *t, far, sides, spokes, warp_side, warp, weft, 0);
    }
    w
}

/// Lifts the flat sheet by `f(x, y)` out of its plane.
fn lift(w: &mut World, f: impl Fn(f32, f32) -> f32) {
    for k in 0..w.particles {
        w.z[k] = f(w.x[k], w.y[k]);
    }
}

#[test]
fn a_flat_sheet_stores_no_bending_energy() {
    let w = sheet(9, 0.1, 1e-5, 2e-5);
    assert!(w.bend_energy() < 1e-15, "flat energy {}", w.bend_energy());
}

#[test]
fn a_cylinder_and_a_saddle_store_the_plates_bending_energy_with_no_poisson_coupling() {
    // A plate of rigidities B11 (along the warp), B22 (across) and no Poisson coupling stores B11/2 k11^2 + B22/2 k22^2 per
    // area. Out of plane by w(x, y) the curvature is w's Hessian. Each triangle of a grid sees the bend along x through its
    // side along y and the bend along y through its side along x, so it holds the curvature exactly; the triangles at the
    // sheet's border along a bend, whose side across it is a free edge, hold none: a cylinder along x is held over all but
    // one column of triangles, a saddle (a cylinder each way) over all but one column and one row. The saddle is where a
    // model of the mean curvature fails: k11 + k22 = 0 there, and such a model holds it at nothing.
    let (n, d, k) = (11usize, 0.05f32, 0.4f32);
    let (warp, weft) = (2e-5f64, 3e-5f64);
    let mut w = sheet(n, d, warp as f32, weft as f32);
    let area = ((n - 1) as f64 * d as f64).powi(2);
    let held = 1.0 - 1.0 / (n - 1) as f64;
    lift(&mut w, |x, _| 0.5 * k * x * x);
    let along = 0.5 * warp * (k as f64).powi(2) * area * held;
    assert!((w.bend_energy() / along - 1.0).abs() < 1e-4, "cylinder along the warp: {} against {along}", w.bend_energy());
    lift(&mut w, |_, y| 0.5 * k * y * y);
    let across = 0.5 * weft * (k as f64).powi(2) * area * held;
    assert!((w.bend_energy() / across - 1.0).abs() < 1e-4, "cylinder across: {} against {across}", w.bend_energy());
    lift(&mut w, |x, y| 0.5 * k * (x * x - y * y));
    assert!(((w.bend_energy() / (along + across)) - 1.0).abs() < 1e-4, "saddle: {} against {}", w.bend_energy(), along + across);
}

#[test]
fn the_exact_solve_keeps_the_momentum_and_lowers_the_bending_energy() {
    // No gravity, no edges: a sheet bent and let go unbends under its elements alone. Each element's move sums to no
    // momentum (its coefficients sum to zero), so what is left is the rounding of positions held in f32: each rounded move
    // of a coordinate under 1 m is off by at most 2^-25 m, independently, so their sum stays within three standard
    // deviations, 3 sqrt(N) 2^-25 / sqrt(3) / h over the N rounded moves, at 1 kg a particle. The energy never comes back above where it started.
    let n = 9;
    let mut w = sheet(n, 0.125, 0.5, 0.5);
    lift(&mut w, |x, _| 0.8 * x * x);
    let before = w.bend_energy();
    let (substeps, h) = (8.0f64, 1.0 / 480.0);
    w.step(1.0 / 60.0, 8, 1, [0.0, 0.0, 0.0]);
    // Per piece: the prediction moves every coordinate, and each Newton step of the solve (a linear set of rows is met in
    // one, and a second confirms it) every coordinate again.
    let moves = substeps * 3.0 * 3.0 * w.particles as f64;
    let bound = 3.0 * moves.sqrt() * 2f64.powi(-25) / 3f64.sqrt() / h;
    let (mut p, mut speed) = ([0.0f64; 3], 0.0f64);
    for k in 0..w.particles {
        p[0] += w.vx[k] as f64;
        p[1] += w.vy[k] as f64;
        p[2] += w.vz[k] as f64;
        speed += ((w.vx[k] as f64).powi(2) + (w.vy[k] as f64).powi(2) + (w.vz[k] as f64).powi(2)).sqrt();
    }
    assert!(speed > 100.0 * bound, "the sheet moves: {speed} N s");
    for a in 0..3 {
        assert!(p[a].abs() < bound, "momentum {p:?} against {bound}");
    }
    // Implicit Euler takes energy out and puts none in: the bending energy never exceeds what the sheet was let go with.
    for _ in 0..29 {
        w.step(1.0 / 60.0, 8, 1, [0.0, 0.0, 0.0]);
        assert!(w.bend_energy() < before, "energy {} from {before}", w.bend_energy());
    }
}

#[test]
fn the_vertex_block_solve_unbends_a_sheet_as_the_exact_solve_does() {
    // No gravity: a sheet with stretch springs along its triangles' edges, bent and let go. The exact solve meets each
    // piece's implicit Euler step of bending plus springs; the vertex block passes converge on the same step, pass by pass,
    // so with enough passes the two take the sheet to the same place.
    let run = |block: bool| {
        let n = 7;
        let mut w = sheet(n, 0.05, 2e-4, 2e-4);
        let mut pairs = Vec::new();
        for i in 0..n {
            for j in 0..n {
                let k = (i * n + j) as u32;
                if i + 1 < n {
                    pairs.push((k, k + n as u32));
                }
                if j + 1 < n {
                    pairs.push((k, k + 1));
                }
                if i + 1 < n && j + 1 < n {
                    pairs.push((k, k + n as u32 + 1));
                }
            }
        }
        w.reserve(w.particles, pairs.len(), 1, 0);
        w.edges = pairs.len();
        for (e, (a, b)) in pairs.iter().enumerate() {
            let (a, b) = (*a as usize, *b as usize);
            w.ea[e] = a as u32;
            w.eb[e] = b as u32;
            w.rest[e] = ((w.x[a] - w.x[b]).powi(2) + (w.y[a] - w.y[b]).powi(2)).sqrt();
            // A stiffness of 50 N/m, a soft fabric thread's order.
            w.omega[e] = 50.0;
            w.zeta[e] = 0.0;
            w.eflags[e] = margoengine_soft_kernel::STIFFNESS | if block { margoengine_soft_kernel::BLOCK } else { 0 };
        }
        if block {
            for s in 0..w.bends {
                w.bd_flag[s] = BEND_BLOCK;
            }
        }
        lift(&mut w, |x, _| 2.0 * x * x);
        for _ in 0..6 {
            w.step(1.0 / 60.0, 8, 60, [0.0, 0.0, 0.0]);
        }
        (0..w.particles).map(|k| [w.x[k], w.y[k], w.z[k]]).collect::<Vec<[f32; 3]>>()
    };
    let (exact, block) = (run(false), run(true));
    let mut most = 0.0f32;
    for k in 0..exact.len() {
        for a in 0..3 {
            most = most.max((exact[k][a] - block[k][a]).abs());
        }
    }
    assert!(most < 1e-3, "the two solves end {most} m apart");
}
