// The threads of a woven sheet are held exactly, loops and all (Goldenthal et al. 2007, fast projection): a sheet of warp and
// weft pinned at its corners stays within the strain its threads are held to (0.1 percent) whatever the iterations, the
// substeps and the load at its middle, a thousand times its particles' mass included (KB-SOFT-LOOPSTRETCH1: the sweep alone
// left it 3 percent stretched at one to one and 24 to 170 percent at a thousand to one).
mod common;
use margoengine_soft_kernel::{SHEET, World};

/// An `n` by `n` sheet of 10 cm threads in the xz plane, pinned at its corners, particles of `light` kilograms and the middle
/// one `heavy`.
fn sheet(n: usize, light: f32, heavy: f32) -> World {
    let edges = 2 * n * (n - 1);
    let mut w = World::new();
    w.reserve(n * n, edges, 1, 0);
    w.particles = n * n;
    w.edges = edges;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    for i in 0..n {
        for j in 0..n {
            let p = i * n + j;
            w.x[p] = j as f32 * 0.1;
            w.z[p] = i as f32 * 0.1;
            w.w[p] = 1.0 / light;
            w.radius[p] = 0.01;
        }
    }
    for p in [0, n - 1, (n - 1) * n, n * n - 1] {
        w.w[p] = 0.0;
    }
    w.w[(n / 2) * n + n / 2] = 1.0 / heavy;
    let mut e = 0;
    for i in 0..n {
        for j in 0..n {
            let p = i * n + j;
            for q in [if j + 1 < n { p + 1 } else { usize::MAX }, if i + 1 < n { p + n } else { usize::MAX }] {
                if q != usize::MAX {
                    (w.ea[e], w.eb[e], w.rest[e], w.eflags[e]) = (p as u32, q as u32, 0.1, SHEET);
                    e += 1;
                }
            }
        }
    }
    w
}

/// The largest strain of any thread.
fn strain(w: &World) -> f32 {
    let mut most = 0.0f32;
    for e in 0..w.edges {
        let (a, b) = (w.ea[e] as usize, w.eb[e] as usize);
        let l = ((w.x[a] - w.x[b]).powi(2) + (w.y[a] - w.y[b]).powi(2) + (w.z[a] - w.z[b]).powi(2)).sqrt();
        most = most.max(l / w.rest[e] - 1.0);
    }
    most
}

#[test]
fn a_sheet_of_threads_stays_within_its_strain_under_any_load_and_setting() {
    for (light, heavy) in [(1.0f32, 1.0f32), (1.0, 1000.0)] {
        for (substeps, iterations) in [(8u32, 4u32), (4, 1)] {
            let mut w = sheet(12, light, heavy);
            let mut most = 0.0f32;
            for _ in 0..60 {
                w.step(1.0 / 60.0, substeps, iterations, common::G);
                most = most.max(strain(&w));
            }
            // The tolerance, and what an f32 length of 10 cm can hold besides.
            assert!(
                most <= 1e-3 + 1e-6,
                "mass ratio {} at {substeps} substeps and {iterations} iterations stretches a thread by {most}",
                heavy / light
            );
        }
    }
}

/// The largest distance between two sheets' particles.
fn apart(a: &World, b: &World) -> f32 {
    let mut most = 0.0f32;
    for p in 0..a.particles {
        most = most.max(((a.x[p] - b.x[p]).powi(2) + (a.y[p] - b.y[p]).powi(2) + (a.z[p] - b.z[p]).powi(2)).sqrt());
    }
    most
}

/// After `steps`: how far a sheet stepped with the rows' Levenberg-Marquardt damping ends from one stepped without, how far
/// an undamped one ends from an undamped one with one coordinate nudged by one unit in the last place, and the largest
/// strain any of them took.
fn damped_undamped_and_nudged(light: f32, heavy: f32, steps: usize) -> (f32, f32, f32) {
    let (mut damped, mut undamped, mut nudged) = (sheet(12, light, heavy), sheet(12, light, heavy), sheet(12, light, heavy));
    undamped.rg.damping = 0.0;
    nudged.rg.damping = 0.0;
    nudged.x[13] = f32::from_bits(nudged.x[13].to_bits() + 1);
    let mut most = 0.0f32;
    for _ in 0..steps {
        for w in [&mut damped, &mut undamped, &mut nudged] {
            w.step(1.0 / 60.0, 8, 4, common::G);
            most = most.max(strain(w));
        }
    }
    (apart(&damped, &undamped), apart(&nudged, &undamped), most)
}

#[test]
fn the_damping_of_the_rows_changes_no_well_posed_answer_beyond_rounding() {
    // A sheet of threads with no diagonals has no redundant row, so each step's system has one answer. The damping fades
    // with the violation, so the last Newton steps are undamped and land on that answer either way: one step from the same
    // state ends on the same bits. Over more steps, a sheet with no shear stiffness picks its sag among shapes that cost
    // nothing, so differences grow: a single coordinate nudged by f32 rounding grows to centimetres within ten steps. The
    // damping moves the sheet no further than that rounding does (within twice it, or the solve's tolerance of 0.1 mm), at
    // one to one and at a thousand to one.
    for (light, heavy) in [(1.0f32, 1.0f32), (1.0, 1000.0)] {
        let (damping, _, most) = damped_undamped_and_nudged(light, heavy, 1);
        assert_eq!(damping, 0.0, "mass ratio {}: one step lands on the same answer", heavy / light);
        assert!(most <= 1e-3 + 1e-6, "mass ratio {}: a thread stretched {most}", heavy / light);
        for steps in [5, 10, 60] {
            let (damping, rounding, most) = damped_undamped_and_nudged(light, heavy, steps);
            assert!(most <= 1e-3 + 1e-6, "mass ratio {}: a thread stretched {most}", heavy / light);
            assert!(
                damping <= (2.0 * rounding).max(1e-4),
                "mass ratio {} after {steps} steps: the damping moved the sheet {damping} m, rounding {rounding} m",
                heavy / light
            );
        }
    }
}
