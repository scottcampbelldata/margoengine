// Volumetric soft bodies: tetrahedra with stable Neo-Hookean or co-rotated elasticity, plasticity, tearing, and shape-matching clusters,
// against the closed forms they must reproduce.
mod common;
use common::*;
use margoengine_soft_kernel::*;

/// Lame parameters from Young's modulus and Poisson's ratio.
fn lame(e: f32, nu: f32) -> (f32, f32) {
    (e / (2.0 * (1.0 + nu)), e * nu / ((1.0 + nu) * (1.0 - 2.0 * nu)))
}

/// A box of `nx` by `ny` by `nz` cubes of side `cell`, each cut into six tetrahedra around a diagonal (Kuhn's triangulation, which
/// matches across cube faces), from the corner at the origin. Particles weigh `density` times the volume they carry.
fn bar(nx: usize, ny: usize, nz: usize, cell: f32, density: f32, e: f32, nu: f32, model: u32) -> World {
    let mut w = World::new();
    let (px, py, pz) = (nx + 1, ny + 1, nz + 1);
    let id = |i: usize, j: usize, k: usize| (i * py + j) * pz + k;
    let tets = nx * ny * nz * 6;
    w.reserve(px * py * pz, 0, 1, 0);
    w.fem_reserve(tets, 0, 0);
    w.particles = px * py * pz;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    for i in 0..px {
        for j in 0..py {
            for k in 0..pz {
                let p = id(i, j, k);
                w.x[p] = i as f32 * cell;
                w.y[p] = j as f32 * cell;
                w.z[p] = k as f32 * cell;
                w.radius[p] = 0.0;
            }
        }
    }
    let (mu, lambda) = lame(e, nu);
    let mut mass = vec![0.0f32; px * py * pz];
    let mut t = 0;
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                // The six paths from corner (0,0,0) to (1,1,1) along edges of the cube.
                let c = |a: usize, b: usize, c: usize| id(i + a, j + b, k + c);
                let paths: [[(usize, usize, usize); 4]; 6] = [
                    [(0, 0, 0), (1, 0, 0), (1, 1, 0), (1, 1, 1)],
                    [(0, 0, 0), (1, 0, 0), (1, 0, 1), (1, 1, 1)],
                    [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 1, 1)],
                    [(0, 0, 0), (0, 1, 0), (0, 1, 1), (1, 1, 1)],
                    [(0, 0, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1)],
                    [(0, 0, 0), (0, 0, 1), (0, 1, 1), (1, 1, 1)],
                ];
                for path in paths {
                    let p: Vec<usize> = path.iter().map(|&(a, b, cc)| c(a, b, cc)).collect();
                    w.set_tet(t, [p[0] as u32, p[1] as u32, p[2] as u32, p[3] as u32], mu, lambda, model);
                    let v = w.fem.vol0[t];
                    for &q in &p {
                        mass[q] += density * v / 4.0;
                    }
                    t += 1;
                }
            }
        }
    }
    for p in 0..px * py * pz {
        w.w[p] = 1.0 / mass[p];
    }
    w
}

fn volume(w: &World) -> f32 {
    let mut total = 0.0;
    for t in 0..w.fem.count {
        let [a, b, c, d] = [0, 1, 2, 3].map(|k| w.fem.p[k][t] as usize);
        let e = |q: usize| [w.x[q] - w.x[a], w.y[q] - w.y[a], w.z[q] - w.z[a]];
        let (u, v, s) = (e(b), e(c), e(d));
        total += (u[0] * (v[1] * s[2] - v[2] * s[1]) - u[1] * (v[0] * s[2] - v[2] * s[0]) + u[2] * (v[0] * s[1] - v[1] * s[0])) / 6.0;
    }
    total
}

/// Pins the particles of the plane x = 0.
fn clamp(w: &mut World) {
    for p in 0..w.particles {
        if w.x[p] < 1e-6 {
            w.w[p] = 0.0;
        }
    }
}

/// The free-end sag of a uniformly loaded cantilever of length 1 and a 0.25 square section, after it settles.
fn cantilever_sag(cells: usize, substeps: u32, iterations: u32, model: u32) -> f32 {
    let cell = 0.25 / (cells / 4) as f32;
    let mut w = bar(cells, cells / 4, cells / 4, cell, 1000.0, 3.0e6, 0.3, model);
    clamp(&mut w);
    w.linear_damping[0] = 4.0;
    w.fem.damping = 20.0;
    let far: Vec<usize> = (0..w.particles).filter(|&p| w.x[p] > 0.999).collect();
    run(&mut w, 6.0, 1.0 / 60.0, substeps, iterations);
    // The far plane's particles began at heights from 0 to 0.25, a mean of 0.125.
    0.125 - far.iter().map(|&p| w.y[p]).sum::<f32>() / far.len() as f32
}

/// A uniformly loaded cantilever of length L, section A and second moment I sags at its free end by rho g A L^4 / (8 E I)
/// (Euler-Bernoulli; Gere and Goodno, Mechanics of Materials), a little more with the shear of a beam this stocky (Timoshenko).
/// Linear tetrahedra lock when coarse, so a mesh of 8 by 2 cells reads stiff, 55 percent of the formula, and the sag converges up to it
/// as the mesh is refined: 12 by 3 reads 88 percent, 16 by 4 reads 99 (not run here, it takes 18 s).
#[test]
fn a_cantilever_sags_by_the_euler_bernoulli_deflection() {
    let (side, e, rho) = (0.25f32, 3.0e6f32, 1000.0f32);
    let expected = rho * 9.81 * side * side / (8.0 * e * (side.powi(4) / 12.0));
    let coarse = cantilever_sag(8, 20, 20, 0);
    let fine = cantilever_sag(12, 40, 20, 0);
    assert!(coarse > 0.45 * expected && coarse < fine, "a coarse mesh locks: {coarse} against {fine}");
    assert!(fine > 0.8 * expected && fine < 1.05 * expected, "tip sag {fine} against Euler-Bernoulli {expected}");
    // The co-rotated model, the same load: within a fifth of the Neo-Hookean one on the coarse mesh, since both are Hooke's law at small strain.
    let corotated = cantilever_sag(8, 20, 20, 1);
    assert!((corotated - coarse).abs() < 0.2 * coarse, "co-rotated {corotated} against Neo-Hookean {coarse}");
}

/// A near-incompressible rubber keeps its volume under a large stretch; a compressible one does not. Two layers of a bar are pinned at
/// one end and pulled to 1.3 times the length at the other.
#[test]
fn a_nearly_incompressible_bar_keeps_its_volume_when_stretched() {
    let stretched = |nu: f32| {
        let mut w = bar(6, 2, 2, 0.1, 1000.0, 5.0e4, nu, 0);
        let v0 = volume(&w);
        let length = 0.6;
        let mut ends = vec![];
        for p in 0..w.particles {
            if w.x[p] < 1e-6 {
                w.w[p] = 0.0;
            } else if w.x[p] > length - 1e-4 {
                w.w[p] = 0.0;
                ends.push(p);
            }
        }
        w.gravity_scale[0] = 0.0;
        w.linear_damping[0] = 6.0;
        w.fem.damping = 20.0;
        for step in 0..300 {
            let t = (step as f32 / 120.0).min(1.0);
            for &p in &ends {
                w.x[p] = length * (1.0 + 0.3 * t);
            }
            w.step(1.0 / 60.0, 20, 6, [0.0; 3]);
        }
        volume(&w) / v0
    };
    let rubber = stretched(0.49);
    let foam = stretched(0.05);
    assert!((rubber - 1.0).abs() < 0.03, "nu 0.49 volume ratio {rubber}");
    assert!(foam > 1.1, "nu 0.05 volume ratio {foam}: the foam grows by about the strain it takes");
}

/// Past its yield strain a plastic cantilever keeps a set when the load goes; an elastic one comes back.
#[test]
fn a_plastic_cantilever_keeps_a_set_after_its_load_goes() {
    let after = |yield_strain: f32| {
        let mut w = bar(8, 2, 2, 0.125, 1000.0, 3.0e6, 0.3, 0);
        clamp(&mut w);
        w.linear_damping[0] = 4.0;
        w.fem.damping = 20.0;
        let far: Vec<usize> = (0..w.particles).filter(|&p| w.x[p] > 0.999).collect();
        let tip = |w: &World| 0.125 - far.iter().map(|&p| w.y[p]).sum::<f32>() / far.len() as f32;
        for t in 0..w.fem.count {
            w.fem.yield_strain[t] = yield_strain;
            w.fem.creep[t] = 0.0;
        }
        // Loaded under a gravity five times as strong, then released to none, and settled.
        for _ in 0..240 {
            w.step(1.0 / 60.0, 20, 8, [0.0, -49.05, 0.0]);
        }
        let loaded = tip(&w);
        for _ in 0..360 {
            w.step(1.0 / 60.0, 20, 8, [0.0, 0.0, 0.0]);
        }
        (loaded, tip(&w))
    };
    let (loaded, rest) = after(0.0);
    assert!(loaded > 0.1, "the beam sags {loaded}");
    assert!(rest.abs() < 0.05 * loaded, "an elastic beam returns: {rest} of {loaded}");
    let (loaded, set) = after(0.02);
    assert!(loaded > 0.1 && set > 0.3 * loaded, "a plastic beam keeps {set} of its {loaded}");
}

/// A bar stretched past its tear strain loses tetrahedra across its section and falls in two; one stretched less holds.
#[test]
fn a_bar_tears_at_its_strain_threshold_and_holds_below_it() {
    let pulled = |stretch: f32| {
        let mut w = bar(6, 1, 1, 0.1, 1000.0, 5.0e4, 0.3, 0);
        for t in 0..w.fem.count {
            w.fem.tear[t] = 0.6;
        }
        let length = 0.6;
        let mut ends = vec![];
        for p in 0..w.particles {
            if w.x[p] < 1e-6 {
                w.w[p] = 0.0;
            } else if w.x[p] > length - 1e-4 {
                w.w[p] = 0.0;
                ends.push(p);
            }
        }
        w.gravity_scale[0] = 0.0;
        w.linear_damping[0] = 4.0;
        // The far end is drawn out over a second and held.
        for step in 0..180 {
            let t = (step as f32 / 60.0).min(1.0);
            for &p in &ends {
                w.x[p] = length * (1.0 + (stretch - 1.0) * t);
            }
            w.step(1.0 / 60.0, 20, 4, [0.0; 3]);
        }
        w.fem.torn
    };
    let (held, torn) = (pulled(1.3), pulled(2.2));
    assert_eq!(held, 0, "a 30 percent stretch holds");
    assert!(torn > 0, "a 120 percent stretch tears ({torn})");
}

/// Two runs of the same scene give the same bits.
#[test]
fn a_tetrahedral_body_replays_bit_for_bit() {
    let hash = || {
        let mut w = bar(4, 2, 2, 0.125, 1000.0, 2.0e4, 0.35, 1);
        clamp(&mut w);
        for t in 0..w.fem.count {
            w.fem.yield_strain[t] = 0.05;
            w.fem.tear[t] = 3.0;
        }
        run(&mut w, 2.0, 1.0 / 60.0, 8, 2);
        w.hash()
    };
    assert_eq!(hash(), hash());
}

/// A cluster keeps its shape under any rigid turn: a blob spun about its centre stays the blob it was, and a squashed one springs back.
#[test]
fn a_cluster_turns_freely_and_springs_back() {
    let mut w = World::new();
    let n = 27;
    w.reserve(n, 0, 1, 0);
    w.fem_reserve(0, 1, n);
    w.particles = n;
    w.bodies = 1;
    let mut at = 0;
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                w.x[at] = i as f32 * 0.1;
                w.y[at] = j as f32 * 0.1 + 1.0;
                w.z[at] = k as f32 * 0.1;
                w.w[at] = 1.0;
                at += 1;
            }
        }
    }
    let members: Vec<u32> = (0..n as u32).collect();
    w.set_cluster(0, &members, 200.0);
    let rest: Vec<[f32; 3]> = (0..n).map(|p| [w.x[p], w.y[p], w.z[p]]).collect();
    // A spin about the vertical through the centre: every particle starts with its tangential speed.
    let (cx, cz) = (0.1, 0.1);
    for p in 0..n {
        let (dx, dz) = (w.x[p] - cx, w.z[p] - cz);
        w.vx[p] = -dz * 6.0;
        w.vz[p] = dx * 6.0;
    }
    for _ in 0..240 {
        w.step(1.0 / 60.0, 20, 2, [0.0, 0.0, 0.0]);
    }
    // Distances between particles are those of the rest shape: the blob turned and did not deform.
    let mut worst = 0.0f32;
    for a in 0..n {
        for b in (a + 1)..n {
            let d = |x: &dyn Fn(usize) -> [f32; 3]| {
                let (p, q) = (x(a), x(b));
                ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
            };
            let now = d(&|i| [w.x[i], w.y[i], w.z[i]]);
            let was = d(&|i| rest[i]);
            worst = worst.max((now - was).abs());
        }
    }
    assert!(worst < 0.02, "a spinning cluster changed a distance by {worst}");
    // Squashed to half its height at rest, it springs back.
    let mut s = World::new();
    s.reserve(n, 0, 1, 0);
    s.fem_reserve(0, 1, n);
    s.particles = n;
    s.bodies = 1;
    for p in 0..n {
        s.x[p] = rest[p][0];
        s.y[p] = rest[p][1];
        s.z[p] = rest[p][2];
        s.w[p] = 1.0;
    }
    s.set_cluster(0, &members, 200.0);
    for p in 0..n {
        s.y[p] = 1.0 + (s.y[p] - 1.0) * 0.5;
    }
    s.linear_damping[0] = 2.0;
    for _ in 0..240 {
        s.step(1.0 / 60.0, 20, 2, [0.0, 0.0, 0.0]);
    }
    let height = (0..n).map(|p| s.y[p]).fold(f32::MIN, f32::max) - (0..n).map(|p| s.y[p]).fold(f32::MAX, f32::min);
    assert!((height - 0.2).abs() < 0.02, "a squashed cluster springs back to {height}");
}
