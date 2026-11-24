mod common;
use common::*;
use margoengine_soft_kernel::*;

/// A chain pinned at both ends hangs as a catenary: depth at the middle is a (cosh(span / 2a) - 1) (Lamb, "Statics").
#[test]
fn a_rope_hangs_as_a_catenary() {
    let (n, span, length) = (40usize, 4.0f32, 5.0f32);
    let mut w = rope(n, [0.0, 0.0, 0.0], [span, 0.0, 0.0], length, true, 0.0, 0.0, 2.0);
    w.linear_damping[0] = 3.0;
    run(&mut w, 8.0, 1.0 / 60.0, 20, 4);
    let a = catenary_a(length as f64, span as f64);
    let depth = a * ((span as f64 / (2.0 * a)).cosh() - 1.0);
    let mid = w.y[n / 2];
    assert!((-mid as f64 - depth).abs() < 0.02 * depth, "sag {} against the catenary's {depth}", -mid);
    // The whole curve, not only the middle.
    for i in 0..=n {
        let x = w.x[i] as f64 - span as f64 / 2.0;
        let y = a * ((x / a).cosh() - (span as f64 / (2.0 * a)).cosh());
        assert!((w.y[i] as f64 - y).abs() < 0.03, "particle {i}: y {} against {y}", w.y[i]);
    }
    // Hard edges keep their length to a fraction of a percent.
    for e in 0..n {
        let (a, b) = (w.ea[e] as usize, w.eb[e] as usize);
        let len = ((w.x[a] - w.x[b]).powi(2) + (w.y[a] - w.y[b]).powi(2) + (w.z[a] - w.z[b]).powi(2)).sqrt();
        assert!((len - w.rest[e]).abs() < 0.01 * w.rest[e], "edge {e}: {len} against {}", w.rest[e]);
    }
}

/// A pendulum of hard edges only loses energy: kinetic plus potential never rises above where it began.
#[test]
fn a_swinging_rope_never_gains_energy() {
    let n = 20;
    let mut w = rope(n, [0.0, 0.0, 0.0], [2.0, 0.0, 0.0], 2.0, false, 0.0, 0.0, 1.0);
    w.w[0] = 0.0;
    let energy = |w: &World| -> f32 {
        (0..=w.particles - 1)
            .map(|i| {
                let m = if w.w[i] > 0.0 { 1.0 / w.w[i] } else { 0.0 };
                0.5 * m * (w.vx[i].powi(2) + w.vy[i].powi(2) + w.vz[i].powi(2)) + m * 9.81 * w.y[i]
            })
            .sum()
    };
    let start = energy(&w);
    let mut worst = f32::MIN;
    for _ in 0..600 {
        w.step(1.0 / 60.0, 20, 2, G);
        worst = worst.max(energy(&w));
    }
    assert!(worst <= start + 0.01 * start.abs().max(1.0), "energy rose from {start} to {worst}");
    assert!(energy(&w) < start, "and some was lost");
}

/// A particle on a soft edge to a pinned one oscillates at the edge's natural frequency, whatever the particle's mass.
#[test]
fn a_soft_edge_oscillates_at_its_natural_frequency() {
    for mass in [0.1f32, 1.0, 25.0] {
        let f = 2.0f32;
        let omega = 2.0 * std::f32::consts::PI * f;
        let mut w = rope(1, [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], 1.0, false, omega, 0.0, mass);
        w.w[0] = 0.0;
        w.w[1] = 1.0 / mass;
        w.y[1] = -1.2;
        w.px[1] = w.x[1];
        w.rest[0] = 1.0;
        // No gravity: the edge alone pulls the particle to rest at 1 m, from 1.2 m.
        let dt = 1.0 / 240.0;
        let mut crossings = Vec::new();
        let mut last = w.y[1] + 1.0;
        for step in 0..(3.0 / dt) as usize {
            w.step(dt, 4, 1, [0.0, 0.0, 0.0]);
            let now = w.y[1] + 1.0;
            if last < 0.0 && now >= 0.0 {
                crossings.push(step as f32 * dt);
            }
            last = now;
        }
        assert!(crossings.len() >= 4, "mass {mass}: {} upward crossings", crossings.len());
        let period = (crossings[crossings.len() - 1] - crossings[0]) / (crossings.len() - 1) as f32;
        assert!((period * f - 1.0).abs() < 0.04, "mass {mass}: period {period} s against {}", 1.0 / f);
    }
}

/// The same scene run twice gives the same bits.
#[test]
fn a_step_is_bit_for_bit_the_same() {
    let build = || {
        let mut w = rope(30, [0.0, 0.0, 0.0], [3.0, 1.0, 0.5], 3.4, true, 80.0, 0.3, 1.0);
        run(&mut w, 2.0, 1.0 / 60.0, 8, 2);
        w
    };
    assert_eq!(build().hash(), build().hash());
}
