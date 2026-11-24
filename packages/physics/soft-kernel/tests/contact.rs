mod common;
use common::*;
use margoengine_soft_kernel::*;

fn one_particle(mass: f32, y: f32, radius: f32) -> World {
    let mut w = World::new();
    w.reserve(1, 0, 1, 1);
    w.particles = 1;
    w.bodies = 1;
    w.colliders = 1;
    w.gravity_scale[0] = 1.0;
    w.w[0] = 1.0 / mass;
    w.y[0] = y;
    w.radius[0] = radius;
    w.qw[0] = 1.0;
    w
}

fn floor(w: &mut World, friction: f32) {
    w.c_kind[0] = HALF_SPACE;
    w.sy[0] = 1.0;
    w.friction[0] = friction;
}

/// A particle on a floor rests a radius above it, and the floor's body is pushed down with the particle's weight.
#[test]
fn a_particle_rests_on_a_half_space_and_loads_its_body_with_its_weight() {
    let (mass, radius, dt) = (2.0f32, 0.05f32, 1.0 / 60.0);
    let mut w = one_particle(mass, 0.5, radius);
    floor(&mut w, 0.5);
    for _ in 0..240 {
        w.step(dt, 8, 1, G);
    }
    assert!((w.y[0] - radius).abs() < 1e-3, "rests at {}", w.y[0]);
    w.step(dt, 8, 1, G);
    let weight = mass * 9.81 * dt;
    assert!((w.jy[0] + weight).abs() < 0.05 * weight, "impulse {} against {}", w.jy[0], -weight);
    assert!(w.jx[0].abs() < 1e-4 && w.jz[0].abs() < 1e-4);
}

/// On a slope a particle stays while the slope is under the friction angle, and slides past it.
#[test]
fn friction_holds_a_particle_on_a_slope_up_to_its_angle() {
    for (angle, mu, holds) in [(0.3f32, 0.5f32, true), (0.6, 0.5, false)] {
        let mut w = one_particle(1.0, 0.0, 0.05);
        // The plane tilts about z, its normal leaning toward -x.
        let (s, c) = ((angle / 2.0).sin(), (angle / 2.0).cos());
        w.qz[0] = s;
        w.qw[0] = c;
        floor(&mut w, mu);
        // Start on the surface, a radius out.
        w.x[0] = 0.0;
        w.y[0] = 0.05 / angle.cos();
        for _ in 0..180 {
            w.step(1.0 / 60.0, 8, 1, G);
        }
        let moved = (w.x[0].powi(2) + w.y[0].powi(2)).sqrt();
        if holds {
            assert!(moved < 0.2, "slope {angle}: slid {moved}");
        } else {
            assert!(moved > 1.0, "slope {angle}: only {moved}");
        }
    }
}

/// Every collider kind pushes a particle to its radius off the surface.
#[test]
fn spheres_boxes_and_capsules_keep_a_particle_outside() {
    let kinds = [(SPHERE, [1.0, 0.0, 0.0]), (BOX, [1.0, 1.0, 1.0]), (CAPSULE, [0.5, 1.0, 0.0])];
    for (kind, size) in kinds {
        let mut w = one_particle(1.0, 2.0, 0.1);
        w.c_kind[0] = kind;
        w.qw[0] = 1.0;
        (w.sx[0], w.sy[0], w.sz[0]) = (size[0], size[1], size[2]);
        w.friction[0] = 0.0;
        w.x[0] = 0.0;
        w.y[0] = 0.3;
        // Inside the shape at the start: the substep pushes it out along the shortest way.
        w.step(1.0 / 60.0, 4, 1, [0.0, 0.0, 0.0]);
        let (d, ..) = (0.0, 0);
        let _ = d;
        let r = (w.x[0].powi(2) + w.y[0].powi(2) + w.z[0].powi(2)).sqrt();
        assert!(r > 0.4, "kind {kind}: still at {r}");
    }
}

/// A pinned particle follows its kinematic target over a step and ends on it.
#[test]
fn a_pinned_particle_follows_its_target() {
    let mut w = one_particle(1.0, 0.0, 0.05);
    w.w[0] = 0.0;
    w.colliders = 0;
    w.pflags[0] = PINNED | TARGETED;
    w.tx[0] = 1.0;
    w.ty[0] = 2.0;
    w.step(1.0 / 60.0, 5, 1, G);
    assert_eq!((w.x[0], w.y[0]), (1.0, 2.0));
}

#[test]
fn a_contact_found_by_the_host_pushes_a_particle_out_and_loads_its_body() {
    // The host finds a surface at y = 0 under a particle that fell 5 mm into it, and says so through the staged step.
    let mut w = World::new();
    w.reserve(1, 0, 1, 1);
    w.particles = 1;
    w.bodies = 1;
    w.colliders = 1;
    w.gravity_scale[0] = 1.0;
    w.x[0] = 0.0;
    w.y[0] = 0.025 - 0.005;
    w.w[0] = 1.0;
    w.radius[0] = 0.025;
    let h = 1.0 / 480.0;
    w.begin(1.0 / 60.0);
    w.substep_pre(h, 1, [0.0, -9.81, 0.0]);
    let depth = 0.025 - w.y[0];
    w.kc[0] = 1;
    w.kny[0] = 1.0;
    w.kd[0] = depth;
    w.apply_contacts(h);
    w.substep_post(h);
    w.finish();
    assert!((w.y[0] - 0.025).abs() < 1e-6, "the particle sits on the surface: {}", w.y[0]);
    assert!(w.jy[0] < 0.0, "the body feels it push down: {}", w.jy[0]);
    assert_eq!(w.kc[0], 0, "the contact is spent");
}
