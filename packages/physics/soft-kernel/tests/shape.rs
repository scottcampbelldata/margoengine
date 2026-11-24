// Shape matching: a rigid body keeps its shape through spin and landing, a soft one rings at its spring's frequency and
// settles, and it replays bit for bit.
mod common;
use margoengine_soft_kernel::World;

const CUBE: [[f32; 3]; 8] = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5],
];

/// A unit cube of eight particles of one kilogram, held by shape matching alone.
fn cube(at: [f32; 3], omega: f32, zeta: f32) -> World {
    let mut w = World::new();
    w.reserve(8, 0, 1, 0);
    w.particles = 8;
    w.bodies = 1;
    w.gravity_scale[0] = 1.0;
    for (i, p) in CUBE.iter().enumerate() {
        w.x[i] = at[0] + p[0];
        w.y[i] = at[1] + p[1];
        w.z[i] = at[2] + p[2];
        w.w[i] = 1.0;
        w.sw[i] = 1.0;
        w.rx[i] = p[0];
        w.ry[i] = p[1];
        w.rz[i] = p[2];
        w.radius[i] = 0.02;
    }
    w.b_on[0] = 1;
    w.b_first[0] = 0;
    w.b_count[0] = 8;
    w.b_omega[0] = omega;
    w.b_zeta[0] = zeta;
    w
}

fn spread(w: &World) -> f32 {
    // The largest difference between a pair distance and its rest value.
    let mut worst = 0.0f32;
    for i in 0..8 {
        for j in i + 1..8 {
            let rest = ((CUBE[i][0] - CUBE[j][0]).powi(2) + (CUBE[i][1] - CUBE[j][1]).powi(2) + (CUBE[i][2] - CUBE[j][2]).powi(2)).sqrt();
            let now = ((w.x[i] - w.x[j]).powi(2) + (w.y[i] - w.y[j]).powi(2) + (w.z[i] - w.z[j]).powi(2)).sqrt();
            worst = worst.max((now - rest).abs());
        }
    }
    worst
}

#[test]
fn a_rigid_body_keeps_its_shape_through_a_spin_and_flies_ballistically() {
    let mut w = cube([0.0, 10.0, 0.0], 0.0, 1.0);
    // Spin about a tilted axis at 3 rad/s and move sideways at 2 m/s.
    let spin = [1.0f32, 2.0, 0.5];
    for i in 0..8 {
        let r = CUBE[i];
        w.vx[i] = 2.0 + spin[1] * r[2] - spin[2] * r[1];
        w.vy[i] = spin[2] * r[0] - spin[0] * r[2];
        w.vz[i] = spin[0] * r[1] - spin[1] * r[0];
    }
    let t = 0.5f32;
    for _ in 0..30 {
        w.step(1.0 / 60.0, 8, 2, common::G);
    }
    assert!(spread(&w) < 2e-3, "shape drifts by {}", spread(&w));
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..8 {
        cx += w.x[i] / 8.0;
        cy += w.y[i] / 8.0;
    }
    assert!((cx - 2.0 * t).abs() < 0.01, "centre x {cx}");
    assert!((cy - (10.0 - 0.5 * 9.81 * t * t)).abs() < 0.02, "centre y {cy}");
}

#[test]
fn a_soft_body_rings_at_its_natural_frequency_and_settles() {
    let hz = 4.0f32;
    let mut w = cube([0.0, 0.0, 0.0], hz * 2.0 * core::f32::consts::PI, 0.05);
    w.gravity_scale[0] = 0.0;
    // Pull one corner out by 0.2 and let go.
    w.x[7] += 0.2;
    w.px[7] = w.x[7];
    let mut peaks = Vec::new();
    let mut series = Vec::new();
    for _ in 0..360 {
        w.step(1.0 / 60.0, 8, 4, common::G);
        series.push(spread(&w));
    }
    for k in 1..series.len() - 1 {
        if series[k] > series[k - 1] && series[k] >= series[k + 1] && series[k] > 1e-3 {
            peaks.push(k);
        }
    }
    assert!(peaks.len() >= 3, "it rings: {peaks:?}");
    // Spread measures the size of the deformation, which peaks twice per cycle of the corner's motion.
    let period = (peaks[2] - peaks[0]) as f32 / 60.0 / 2.0 * 2.0;
    assert!((period - 1.0 / hz).abs() < 0.04, "period {period} against {}", 1.0 / hz);
    assert!(series[series.len() - 1] < 0.35 * series[0], "it settles: {} from {}", series[series.len() - 1], series[0]);
}

#[test]
fn a_rigid_body_lands_on_a_floor_and_keeps_its_shape() {
    let mut w = cube([0.0, 2.0, 0.0], 0.0, 1.0);
    w.reserve(8, 0, 1, 1);
    w.colliders = 1;
    w.c_kind[0] = 3;
    w.sy[0] = 1.0;
    w.qw[0] = 1.0;
    w.friction[0] = 0.5;
    for _ in 0..180 {
        w.step(1.0 / 60.0, 8, 4, common::G);
    }
    assert!(spread(&w) < 5e-3, "shape drifts by {}", spread(&w));
    let mut lowest = f32::MAX;
    for i in 0..8 {
        lowest = lowest.min(w.y[i]);
    }
    assert!((lowest - 0.02).abs() < 0.02, "it rests on the floor: {lowest}");
}

#[test]
fn shape_matching_replays_bit_for_bit() {
    let run = || {
        let mut w = cube([0.0, 3.0, 0.0], 40.0, 0.3);
        w.vx[3] = 1.0;
        for _ in 0..120 {
            w.step(1.0 / 60.0, 8, 2, common::G);
        }
        w.hash()
    };
    assert_eq!(run(), run());
}
