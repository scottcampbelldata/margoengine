#![allow(dead_code)]
use margoengine_soft_kernel::World;

pub const G: [f32; 3] = [0.0, -9.81, 0.0];

/// A line of `n + 1` particles from `a` to `b` joined by `n` edges, the ends pinned when asked. Returns the world.
pub fn rope(n: usize, a: [f32; 3], b: [f32; 3], length: f32, pin_ends: bool, omega: f32, zeta: f32, mass: f32) -> World {
    let mut w = World::new();
    w.reserve(n + 1, n, 1, 0);
    w.particles = n + 1;
    w.edges = n;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    for i in 0..=n {
        let t = i as f32 / n as f32;
        w.x[i] = a[0] + (b[0] - a[0]) * t;
        w.y[i] = a[1] + (b[1] - a[1]) * t;
        w.z[i] = a[2] + (b[2] - a[2]) * t;
        w.w[i] = if pin_ends && (i == 0 || i == n) { 0.0 } else { (n as f32 + 1.0) / mass };
        w.radius[i] = 0.01;
    }
    for e in 0..n {
        w.ea[e] = e as u32;
        w.eb[e] = e as u32 + 1;
        w.rest[e] = length / n as f32;
        w.omega[e] = omega;
        w.zeta[e] = zeta;
    }
    w
}

pub fn run(w: &mut World, seconds: f32, dt: f32, substeps: u32, iterations: u32) {
    for _ in 0..(seconds / dt) as usize {
        w.step(dt, substeps, iterations, G);
    }
}

/// The catenary parameter `a` of a chain of length `length` hanging between two points `span` apart at one height:
/// length = 2 a sinh(span / 2a), found by bisection in doubles.
pub fn catenary_a(length: f64, span: f64) -> f64 {
    let (mut lo, mut hi) = (span * 0.01, span * 1e4);
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if 2.0 * mid * (span / (2.0 * mid)).sinh() > length { lo = mid } else { hi = mid }
    }
    0.5 * (lo + hi)
}
