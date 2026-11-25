// A contact that needs a light body to turn far within one piece of a step: the turn is a rotation (Mueller, Macklin,
// Chentanez, Jeschke and Kim 2020, equations 8 and 9), taken in full, so the body keeps its shape and the contact closes.
use margoengine_soft_kernel::*;

/// A rod one metre long along x through the origin, 10 g, so its tip is easy to turn; a 100 kg particle pressed `depth` into a
/// flat face on the rod's tip that faces up.
fn rod_under_a_particle(depth: f32) -> World {
    let mut w = World::new();
    w.reserve(1, 0, 1, 1);
    w.particles = 1;
    w.bodies = 1;
    w.colliders = 1;
    w.w[0] = 0.01;
    w.radius[0] = 0.01;
    w.x[0] = 0.5;
    w.y[0] = 0.01 - depth;
    w.qw[0] = 1.0;
    let (mass, length) = (0.01f32, 1.0f32);
    w.wm[0] = 1.0 / mass;
    // A thin rod: no inertia about its own axis to speak of, m l^2 / 12 about the others.
    let across = mass * length * length / 12.0;
    w.iixx[0] = 1.0 / (mass * 1e-6);
    w.iiyy[0] = 1.0 / across;
    w.iizz[0] = 1.0 / across;
    w.kc[0] = 1;
    w.kpx[0] = 0.5;
    w.kny[0] = 1.0;
    w.kf[0] = 0.0;
    // A face (flat), whose plane turns with the rod.
    w.kr[0] = -1.0;
    w
}

fn length(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

#[test]
fn a_contact_that_needs_a_large_turn_is_closed_by_a_rotation() {
    let h = 1.0 / 480.0;
    let mut w = rod_under_a_particle(0.2);
    w.begin(1.0 / 60.0);
    w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
    for _ in 0..8 {
        w.apply_contacts(h, h);
    }
    let turn = [w.tqx[0], w.tqy[0], w.tqz[0], w.tqw[0]];
    let dm = [w.dmx[0], w.dmy[0], w.dmz[0]];
    let surface = w.surface_at(0, [0.5, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0; 3], -1.0, h, [0.0; 3], [0.0, 0.0, 0.0, 1.0], dm, turn);
    let (_, _, gap) = surface.meet([w.x[0], w.y[0], w.z[0]]);
    // The tip stays half a metre from the centre: a rotation, however far it turned.
    let tip = [surface.at[0] - dm[0], surface.at[1] - dm[1], surface.at[2] - dm[2]];
    assert!((length(tip) - 0.5).abs() < 1e-5, "the rod keeps its length: the tip is {} from the centre", length(tip));
    // It turned past a tenth of a radian in the piece (the bound the linearised turn needed), about -z: the particle pushes the
    // tip down.
    let angle = 2.0 * (turn[0] * turn[0] + turn[1] * turn[1] + turn[2] * turn[2]).sqrt().atan2(turn[3].abs());
    assert!(angle > 0.1, "the rod turned by {angle} rad, more than a linearised turn may");
    assert!(turn[2] < 0.0 && turn[0] == 0.0 && turn[1] == 0.0, "about -z, pushing the tip down: {turn:?}");
    // And the contact is closed: the particle is out of the tip in its new place.
    let d = gap - w.radius[0];
    assert!(d > -2e-3, "the contact is closed within the passes of one piece: {d}");
}

#[test]
fn the_angular_velocity_follows_the_rotation_made() {
    let h = 1.0 / 480.0;
    let mut w = rod_under_a_particle(0.2);
    w.begin(1.0 / 60.0);
    w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
    for _ in 0..8 {
        w.apply_contacts(h, h);
    }
    let turn = [w.tqx[0], w.tqy[0], w.tqz[0], w.tqw[0]];
    // The contact is let go before the piece ends, so the velocity pass does not change the speed the turn gives.
    w.kc[0] = NONE;
    w.substep_post(h);
    // Twice the vector part of the turn over the piece (Mueller et al. 2020, algorithm 2), and the turn is cleared for the next.
    for (v, q) in [(w.avx[0], turn[0]), (w.avy[0], turn[1]), (w.avz[0], turn[2])] {
        assert!((v - 2.0 * q / h).abs() <= 1e-4 * (1.0 + v.abs()), "angular velocity {v} against {}", 2.0 * q / h);
    }
    assert_eq!([w.tqx[0], w.tqy[0], w.tqz[0], w.tqw[0]], [0.0, 0.0, 0.0, 1.0]);
}
