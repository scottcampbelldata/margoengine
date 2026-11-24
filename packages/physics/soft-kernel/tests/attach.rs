// A particle pinned to a rigid body: pulled to its anchor, the body pulled back with an equal and opposite impulse.
mod common;
use margoengine_soft_kernel::World;

/// One particle of one kilogram at x = 1 and a body of mass `body_mass` at the origin, the anchor at the body's centre.
fn linked(body_mass: f32) -> World {
    let mut w = World::new();
    w.reserve(1, 0, 1, 1);
    w.reserve_attachments(1);
    w.particles = 1;
    w.bodies = 1;
    w.colliders = 1;
    w.attachments = 1;
    w.gravity_scale[0] = 0.0;
    w.x[0] = 1.0;
    w.w[0] = 1.0;
    w.radius[0] = 0.01;
    w.wm[0] = if body_mass > 0.0 { 1.0 / body_mass } else { 0.0 };
    w.at_row[0] = 1;
    w
}

#[test]
fn the_pull_and_the_reaction_are_equal_and_opposite() {
    let mut w = linked(10.0);
    let h = 1.0 / 480.0;
    w.begin(1.0 / 60.0);
    w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
    w.apply_contacts(h, h);
    // The particle took 1 / (1 + 0.1) of the way; the body got the particle's momentum change, the other way.
    let share = 1.0 / 1.1;
    assert!((w.x[0] - (1.0 - share)).abs() < 1e-5, "the particle moved by its share: {}", w.x[0]);
    let momentum_particle = (w.x[0] - 1.0) / h;
    assert!((w.jx[0] + momentum_particle).abs() < 1e-3 * momentum_particle.abs(), "{} against {}", w.jx[0], momentum_particle);
    assert!(w.jx[0] > 0.0, "the body is pulled toward the particle");
}

#[test]
fn a_body_that_does_not_move_holds_the_particle_at_the_anchor() {
    let mut w = linked(0.0);
    let h = 1.0 / 480.0;
    for _ in 0..60 {
        w.begin(1.0 / 60.0);
        for piece in 0..8 {
            w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
            w.apply_contacts(h, h * (piece + 1) as f32);
            w.substep_post(h);
        }
        w.finish();
    }
    assert!(w.x[0].abs() < 1e-5, "the particle sits at the anchor: {}", w.x[0]);
}

#[test]
fn an_anchor_off_the_centre_turns_the_body() {
    let mut w = linked(10.0);
    // A unit inertia about every axis, and the anchor one metre along y from the centre: the pull along x torques about z.
    w.iixx[0] = 1.0;
    w.iiyy[0] = 1.0;
    w.iizz[0] = 1.0;
    w.at_ry[0] = 1.0;
    w.y[0] = 1.0;
    let h = 1.0 / 480.0;
    w.begin(1.0 / 60.0);
    w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
    w.apply_contacts(h, h);
    assert!(w.kz[0] != 0.0 && w.kx[0].abs() < 1e-6 && w.ky[0].abs() < 1e-6, "torque about z only: {} {} {}", w.kx[0], w.ky[0], w.kz[0]);
}
