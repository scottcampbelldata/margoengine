// A rigid body against the faces and particles of a soft body: the push on the body and on what it meets lie on one line, so a
// contact gives the body no turn the soft body does not take back (Mueller et al. 2007, the point and triangle constraint; Shinar,
// Schroeder and Fedkiw 2008 for the reaction shared by the triangle's nodes), and the body's inertia turns with it.
use margoengine_soft_kernel::*;

/// One body row: a ball of `mass` and `radius` centred at `centre`, and room for `particles` particles.
fn ball(particles: usize, mass: f32, radius: f32, centre: [f32; 3]) -> World {
    let mut w = World::new();
    w.reserve(particles, 0, 1, 1);
    w.particles = particles;
    w.bodies = 1;
    w.colliders = 1;
    w.qw[0] = 1.0;
    w.wm[0] = 1.0 / mass;
    let inertia = 0.4 * mass * radius * radius;
    w.iixx[0] = 1.0 / inertia;
    w.iiyy[0] = 1.0 / inertia;
    w.iizz[0] = 1.0 / inertia;
    (w.mx[0], w.my[0], w.mz[0]) = (centre[0], centre[1], centre[2]);
    (w.m0x[0], w.m0y[0], w.m0z[0]) = (centre[0], centre[1], centre[2]);
    w
}

fn momentum(w: &World) -> [f32; 3] {
    let mut p = [0.0f32; 3];
    for i in 0..w.particles {
        if w.w[i] > 0.0 {
            p[0] += (w.x[i] - w.px[i]) / w.w[i];
            p[1] += (w.y[i] - w.py[i]) / w.w[i];
            p[2] += (w.z[i] - w.pz[i]) / w.w[i];
        }
    }
    // The body's share: its move times its mass.
    p[0] += w.dmx[0] / w.wm[0];
    p[1] += w.dmy[0] / w.wm[0];
    p[2] += w.dmz[0] / w.wm[0];
    p
}

#[test]
fn a_ball_pressed_into_a_triangle_is_pushed_out_along_the_triangles_normal_with_no_spin() {
    // A 1 cm ball sunk 4 mm into the thickness of a triangle of three 10 g particles, off its middle: the triangle's point under the
    // ball and the ball move apart along the triangle's normal by their inverse masses, the gap closes in one solve, momentum is
    // kept and the ball takes no turn (the push goes through its centre).
    let thickness = 0.01;
    let mut w = ball(3, 0.02, 0.01, [0.02, thickness + 0.01 - 0.004, 0.01]);
    for (i, p) in [[-0.05f32, 0.0, -0.05], [0.05, 0.0, -0.05], [0.0, 0.0, 0.06]].iter().enumerate() {
        (w.x[i], w.y[i], w.z[i]) = (p[0], p[1], p[2]);
        w.w[i] = 100.0;
        w.radius[i] = thickness;
    }
    w.reserve_faces(1);
    w.faces = 1;
    (w.fc_a[0], w.fc_b[0], w.fc_c[0]) = (0, 1, 2);
    (w.fc_wa[0], w.fc_wb[0], w.fc_wc[0]) = (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0);
    w.fc_row[0] = 1;
    // Found at the ball's lowest point, the normal out of the ball (down, toward the triangle); round, its radius.
    (w.fc_px[0], w.fc_py[0], w.fc_pz[0]) = (0.02, thickness - 0.004, 0.01);
    (w.fc_nx[0], w.fc_ny[0], w.fc_nz[0]) = (0.0, -1.0, 0.0);
    w.fc_k[0] = 0.01;
    w.fc_r[0] = thickness;
    w.begin(1.0 / 60.0);
    let h = 1.0 / 480.0;
    w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
    w.apply_faces(h, h);
    // The sheet's height under the ball (its corners only move up and down), by the weights of the point there.
    let (bx, bz) = (0.02f32, 0.01f32);
    let det = (w.z[1] - w.z[2]) * (w.x[0] - w.x[2]) + (w.x[2] - w.x[1]) * (w.z[0] - w.z[2]);
    let u = ((w.z[1] - w.z[2]) * (bx - w.x[2]) + (w.x[2] - w.x[1]) * (bz - w.z[2])) / det;
    let v = ((w.z[2] - w.z[0]) * (bx - w.x[2]) + (w.x[0] - w.x[2]) * (bz - w.z[2])) / det;
    let under = u * w.y[0] + v * w.y[1] + (1.0 - u - v) * w.y[2];
    let gap = (w.my[0] + w.dmy[0] - 0.01) - under;
    // One solve with the normal of the moment: the sheet tilts a little as its corners move by their weights.
    assert!((gap - thickness).abs() < 1e-4, "the gap is the thickness again: {gap}");
    let p = momentum(&w);
    for v in p {
        assert!(v.abs() < 1e-6, "momentum is kept: {p:?}");
    }
    assert_eq!([w.tqx[0], w.tqy[0], w.tqz[0]], [0.0, 0.0, 0.0], "the ball takes no turn");
    assert!(w.dmx[0] == 0.0 && w.dmz[0] == 0.0 && w.dmy[0] > 0.0, "the ball is pushed straight up");
}

#[test]
fn a_rod_whose_contact_slid_round_it_takes_no_spin_about_its_axis() {
    // A thin rod along z, its inertia about its own axis tiny, met by a particle that has slid round it since the contact was found
    // at its bottom: the push goes from the rod's axis to the particle, so it gives no turn about the axis (a point fixed in the
    // rod would push it round).
    let (r, mass) = (0.005f32, 0.016f32);
    let mut w = ball(1, mass, r, [0.0, 0.0, 0.0]);
    w.iixx[0] = 1.0 / (mass * 0.25 / 12.0);
    w.iiyy[0] = 1.0 / (mass * 0.25 / 12.0);
    w.iizz[0] = 1.0 / (0.5 * mass * r * r);
    let (along, sunk) = (0.6f32, 0.001f32);
    // The particle is a radius plus `sunk` short of touching, along a line 0.6 rad round from the bottom.
    let pr = 0.004;
    let reach = r + pr - sunk;
    (w.x[0], w.y[0], w.z[0]) = (reach * along.sin(), -reach * along.cos(), 0.0);
    w.w[0] = 10.0;
    w.radius[0] = pr;
    w.kc[0] = 1;
    (w.kpx[0], w.kpy[0], w.kpz[0]) = (0.0, -r, 0.0);
    (w.knx[0], w.kny[0], w.knz[0]) = (0.0, -1.0, 0.0);
    w.kr[0] = r;
    w.begin(1.0 / 60.0);
    let h = 1.0 / 480.0;
    w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
    w.apply_contacts(h, h);
    assert!(w.tqz[0].abs() < 1e-7, "no turn about the axis: {}", w.tqz[0]);
    let out = (w.x[0] * w.x[0] + w.y[0] * w.y[0]).sqrt();
    assert!(out > reach, "the particle was pushed away from the axis: {out}");
}

#[test]
fn a_bodys_inertia_turns_with_it() {
    // A rod along z (tiny inertia about z) turned a quarter about x lies along y: a moment about y turns it fast, about z slowly.
    let mut w = ball(0, 1.0, 0.1, [0.0, 0.0, 0.0]);
    (w.iixx[0], w.iiyy[0], w.iizz[0]) = (1.0, 1.0, 1000.0);
    w.begin(1.0 / 60.0);
    let half = 0.5f32.sqrt();
    (w.sqx[0], w.sqy[0], w.sqz[0], w.sqw[0]) = (half, 0.0, 0.0, half);
    let (_, about_y, _) = w.inverse_inertia(0, 0.0, 1.0, 0.0);
    let (_, _, about_z) = w.inverse_inertia(0, 0.0, 0.0, 1.0);
    assert!((about_y - 1000.0).abs() < 1e-2, "about its own axis, now y: {about_y}");
    assert!((about_z - 1.0).abs() < 1e-4, "across it, now z: {about_z}");
}

#[test]
fn a_bead_pressed_deeper_than_its_radius_takes_no_spin() {
    // A 1 cm bead whose contact with a particle was found at its bottom, the particle now 1.4 cm inside its surface and a little
    // off the line through its centre (deeper than its radius): the push runs from the bead's centre to the particle, so it gives
    // no turn, in the positions or in the velocity pass (the lever at the particle's own surface, inside the bead past its centre,
    // pointed the wrong way and spun a bead up to 2,000 rad/s).
    let (r, mass) = (0.01f32, 0.0017f32);
    let mut w = ball(1, mass, r, [0.0, 0.0, 0.0]);
    (w.x[0], w.y[0], w.z[0]) = (0.002, 0.004, 0.001);
    (w.px[0], w.py[0], w.pz[0]) = (0.002, 0.004, 0.001);
    w.w[0] = 1.0;
    w.radius[0] = 0.01;
    w.kc[0] = 1;
    (w.kpx[0], w.kpy[0], w.kpz[0]) = (0.0, r, 0.0);
    (w.knx[0], w.kny[0], w.knz[0]) = (0.0, 1.0, 0.0);
    w.kf[0] = 0.5;
    w.kr[0] = r;
    w.begin(1.0 / 60.0);
    let h = 1.0 / 480.0;
    w.substep_pre(h, 1, [0.0, 0.0, 0.0]);
    for _ in 0..4 {
        w.apply_contacts(h, h);
    }
    let turn = [w.tqx[0], w.tqy[0], w.tqz[0]];
    for v in turn {
        assert!(v.abs() < 1e-6, "no turn from the push: {turn:?}");
    }
    w.substep_post(h);
    let spin = [w.avx[0], w.avy[0], w.avz[0]];
    for v in spin {
        assert!(v.abs() < 1e-3, "no spin after the piece: {spin:?}");
    }
}
