// Volume preservation of a closed surface: a squeezed one gets its volume back, an inflated one reaches the target, and the
// step replays bit for bit.
mod common;
use margoengine_soft_kernel::World;

/// A unit octahedron: six particles of one kilogram on the axes and eight outward triangles, with `target` times its volume.
fn octahedron(target: f32) -> World {
    let mut w = World::new();
    w.reserve(6, 0, 1, 0);
    w.particles = 6;
    w.bodies = 1;
    let axes = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];
    for (i, p) in axes.iter().enumerate() {
        w.x[i] = p[0];
        w.y[i] = p[1];
        w.z[i] = p[2];
        w.w[i] = 1.0;
        w.radius[i] = 0.05;
    }
    // Outward faces: +x with +y with +z, and so on, wound counter-clockwise seen from outside.
    let tris: [[u32; 3]; 8] = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
    w.vtri.resize(24);
    for (t, tri) in tris.iter().enumerate() {
        for k in 0..3 {
            w.vtri[3 * t + k] = tri[k];
        }
    }
    w.b_first[0] = 0;
    w.b_count[0] = 6;
    w.vb_on[0] = 1;
    w.vb_first[0] = 0;
    w.vb_count[0] = 8;
    let v0 = w.surface_volume(0);
    assert!((v0 - 4.0 / 3.0).abs() < 1e-5, "the octahedron's volume: {v0}");
    w.vb_target[0] = v0 * target;
    w
}

#[test]
fn an_inflated_surface_reaches_its_target_volume() {
    let mut w = octahedron(2.0);
    for _ in 0..30 {
        w.step(1.0 / 60.0, 8, 2, [0.0, 0.0, 0.0]);
    }
    let v = w.surface_volume(0);
    assert!((v - 8.0 / 3.0).abs() < 8.0 / 3.0 * 0.005, "volume {v} against {}", 8.0 / 3.0);
}

#[test]
fn a_squeezed_surface_gets_its_volume_back_and_stays_centred() {
    let mut w = octahedron(1.0);
    // Squash it flat along y by pulling the two poles in.
    w.y[2] = 0.3;
    w.y[3] = -0.3;
    for _ in 0..30 {
        w.step(1.0 / 60.0, 8, 2, [0.0, 0.0, 0.0]);
    }
    let v = w.surface_volume(0);
    assert!((v - 4.0 / 3.0).abs() < 4.0 / 3.0 * 0.005, "volume {v}");
    let cy = (0..6).map(|i| w.y[i]).sum::<f32>() / 6.0;
    assert!(cy.abs() < 1e-4, "the centre stays: {cy}");
}

#[test]
fn volume_preservation_replays_bit_for_bit() {
    let run = || {
        let mut w = octahedron(1.5);
        w.vx[0] = 0.5;
        for _ in 0..60 {
            w.step(1.0 / 60.0, 8, 2, common::G);
        }
        w.hash()
    };
    assert_eq!(run(), run());
}

/// Only the apex moves. The sealed tetrahedron then has the affine volume y/6.
fn gas_tetrahedron(origin: f32, gas: f32, ambient: f32) -> World {
    let mut w = World::new();
    w.reserve(4, 0, 1, 0);
    w.particles = 4;
    w.bodies = 1;
    let corners = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]];
    for (i, corner) in corners.into_iter().enumerate() {
        w.x[i] = origin + corner[0];
        w.y[i] = origin + corner[1];
        w.z[i] = origin + corner[2];
    }
    w.w[3] = 1.0;
    w.b_count[0] = 4;
    w.vtri.resize(12);
    for (i, v) in [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2].into_iter().enumerate() {
        w.vtri[i] = v;
    }
    w.vb_on[0] = 2;
    w.vb_count[0] = 4;
    w.vb_target[0] = gas;
    w.vb_ambient[0] = ambient;
    w
}

#[test]
fn a_pinned_tetrahedron_matches_the_implicit_gas_equation_in_both_pressure_directions() {
    let dt = 1.0f32 / 60.0f32;
    for (gas, ambient) in [(4_000.0, 12_000.0), (4_000.0, 48_000.0), (4_000.0, 0.0)] {
        let mut w = gas_tetrahedron(0.0, gas, ambient);
        w.step(dt, 1, 1, [0.0; 3]);
        let apex = f64::from(w.y[3]);
        let force = (6.0 * f64::from(gas) / apex - f64::from(ambient)) / 6.0;
        let expected = 1.0 + f64::from(dt) * f64::from(dt) * force;
        let error = (apex - expected).abs();
        // Initial volume and W are exact apart from rounding the 1/6 gradient to f32. The output rounds once.
        let tol = 16.0 * f64::from(f32::EPSILON) * expected.abs().max(1.0);
        assert!(error < tol, "implicit apex {apex}, reference {expected}, error {error}");
        assert_eq!(w.x[3], 0.0);
        assert_eq!(w.z[3], 0.0);
    }
}

#[test]
fn gas_volume_is_unchanged_by_a_large_global_translation() {
    let local = gas_tetrahedron(0.0, 4_000.0, 12_000.0);
    let far = gas_tetrahedron(262_144.0, 4_000.0, 12_000.0);
    assert_eq!(local.surface_volume(0), 1.0 / 6.0);
    assert_eq!(far.surface_volume(0), local.surface_volume(0));
}
