// Rigid edges and body links are solved exactly: the stretch of a chain under a load is the same whatever the iterations
// and substeps, and as the closed form says (none) at any mass ratio.
mod common;
use margoengine_soft_kernel::World;

/// A vertical chain of `n` edges of a metre each from y = 0 downward, pinned at the top, particles of `light` kilograms and the
/// last one `heavy`; every edge rigid.
fn chain(n: usize, light: f32, heavy: f32) -> World {
    let mut w = World::new();
    w.reserve(n + 1, n, 1, 0);
    w.particles = n + 1;
    w.edges = n;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    for i in 0..=n {
        w.y[i] = -(i as f32);
        w.w[i] = if i == 0 { 0.0 } else if i == n { 1.0 / heavy } else { 1.0 / light };
        w.radius[i] = 0.01;
    }
    for e in 0..n {
        w.ea[e] = e as u32;
        w.eb[e] = e as u32 + 1;
        w.rest[e] = 1.0;
    }
    w
}

/// How far past its length the hanging chain stretches after a second, in metres.
fn stretch(n: usize, light: f32, heavy: f32, substeps: u32, iterations: u32) -> f32 {
    let mut w = chain(n, light, heavy);
    for _ in 0..60 {
        w.step(1.0 / 60.0, substeps, iterations, common::G);
    }
    -w.y[n] - n as f32
}

#[test]
fn a_heavy_load_on_a_light_chain_stretches_it_by_nothing_at_any_setting() {
    for (light, heavy) in [(0.01, 0.01), (0.01, 16.0), (0.01, 160.0)] {
        for (substeps, iterations) in [(4, 1), (8, 2), (16, 8), (1, 1)] {
            let s = stretch(20, light, heavy, substeps, iterations);
            assert!(s.abs() < 1e-3, "mass ratio {} at {substeps} substeps and {iterations} iterations stretches by {s}", heavy / light);
        }
    }
}

#[test]
fn the_answer_does_not_depend_on_the_settings() {
    let reference = stretch(20, 0.01, 16.0, 8, 2);
    for (substeps, iterations) in [(1, 1), (2, 3), (4, 1), (16, 16)] {
        let s = stretch(20, 0.01, 16.0, substeps, iterations);
        assert!((s - reference).abs() < 5e-4, "{substeps} substeps, {iterations} iterations: {s} against {reference}");
    }
}

/// The chain of `n` edges ending at a particle attached to a body of `body_mass` kilograms whose anchor is that particle's
/// place; the body falls under gravity and moves with the velocity the chain leaves it, as a host that integrates it would.
fn hang(n: usize, light: f32, body_mass: f32, substeps: u32, iterations: u32) -> (f32, f32) {
    let mut w = chain(n, light, light);
    w.reserve(n + 1, n, 1, 1);
    w.reserve_attachments(1);
    w.colliders = 1;
    w.attachments = 1;
    w.at_p[0] = n as u32;
    w.at_row[0] = 1;
    w.wm[0] = 1.0 / body_mass;
    w.gs[0] = 1.0;
    w.my[0] = -(n as f32);
    let h = 1.0 / 60.0 / substeps as f32;
    for _ in 0..180 {
        w.begin(1.0 / 60.0);
        for _ in 0..substeps {
            w.substep_pre(h, iterations, common::G);
            w.substep_post(h);
        }
        w.finish();
    }
    (-w.y[n] - n as f32, w.my[0] + n as f32)
}

#[test]
fn a_body_hung_on_a_chain_stretches_it_by_nothing_whatever_the_settings() {
    for body in [1.0, 16.0, 160.0] {
        for (substeps, iterations) in [(8, 2), (4, 1), (16, 8)] {
            let (stretch, sag) = hang(20, 0.01, body, substeps, iterations);
            assert!(stretch.abs() < 2e-3, "{body} kg, {substeps} substeps, {iterations} iterations: stretch {stretch}");
            assert!(sag.abs() < 5e-3, "{body} kg, {substeps} substeps: the body sags {sag} from the chain's end");
        }
    }
}

/// Two free particles of one kilogram joined by one rigid edge of rest length 1, tension only when asked, `gap` apart.
fn pair(tension: bool, gap: f32) -> World {
    let mut w = World::new();
    w.reserve(2, 1, 1, 0);
    w.particles = 2;
    w.edges = 1;
    w.bodies = 1;
    w.x[1] = gap;
    w.w[0] = 1.0;
    w.w[1] = 1.0;
    w.radius[0] = 0.01;
    w.radius[1] = 0.01;
    w.ea[0] = 0;
    w.eb[0] = 1;
    w.rest[0] = 1.0;
    if tension {
        w.eflags[0] = margoengine_soft_kernel::TENSION;
    }
    w
}

#[test]
fn a_tension_only_edge_does_not_push_and_pulls_when_taut() {
    for (gap, tension, expect) in [(0.5f32, false, 1.0f32), (0.5, true, 0.5), (1.5, true, 1.0), (1.5, false, 1.0)] {
        let mut w = pair(tension, gap);
        for _ in 0..60 {
            w.step(1.0 / 60.0, 8, 2, [0.0, 0.0, 0.0]);
        }
        let d = (w.x[1] - w.x[0]).abs();
        assert!((d - expect).abs() < 1e-3, "gap {gap}, tension only {tension}: {d} against {expect}");
    }
}
