// A half space: closed forms for rays, projection, casts and overlap, and bodies that rest on it.
use margoengine_physics_kernel::cast::{CastOptions, Shape};
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn close(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol * (1.0 + a.abs().max(b.abs()))
}

/// A fixed body at `at` holding a half space of normal `normal`.
fn plane(w: &mut World, at: V3, normal: [f32; 3]) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    w.add_collider(body, SHAPE_HALFSPACE, normal, [0.0; 3], ID, 0.0).unwrap()
}

fn ball_shape(r: f32) -> Shape {
    Shape { kind: SHAPE_BALL, size: v3(r, 0.0, 0.0), hull: 0, border: 0.0 }
}

#[test]
fn rays_meet_the_plane_where_the_algebra_says() {
    let mut w = World::new(8, 8).unwrap();
    let c = plane(&mut w, v3(0.0, 1.0, 0.0), [0.0, 1.0, 0.0]);
    w.step(DT);
    let down = w.ray_collider(c as usize, v3(3.0, 5.0, 2.0), v3(0.0, -1.0, 0.0), 100.0, true).unwrap();
    assert!(close(down.t, 4.0, 1e-5) && close(down.normal.y, 1.0, 1e-6), "{} {:?}", down.t, down.normal);
    // Slanted: 4 up, 4 across.
    let slant = w.ray_collider(c as usize, v3(0.0, 5.0, 0.0), v3(1.0, -1.0, 0.0).scale(1.0 / sqrt(2.0)), 100.0, true).unwrap();
    assert!(close(slant.t, 4.0 * sqrt(2.0), 1e-5));
    assert!(w.ray_collider(c as usize, v3(0.0, 5.0, 0.0), v3(0.0, 1.0, 0.0), 100.0, true).is_none(), "away");
    assert!(w.ray_collider(c as usize, v3(0.0, 5.0, 0.0), v3(1.0, 0.0, 0.0), 100.0, true).is_none(), "parallel");
    assert!(w.ray_collider(c as usize, v3(0.0, 5.0, 0.0), v3(0.0, -1.0, 0.0), 3.0, true).is_none(), "short");
    // From inside: a solid hit at 0 with no normal; a hollow one leaves through the plane, the normal facing the ray.
    let inside = w.ray_collider(c as usize, v3(0.0, -2.0, 0.0), v3(0.0, 1.0, 0.0), 100.0, true).unwrap();
    assert!(inside.t == 0.0 && inside.normal.dot(inside.normal) == 0.0);
    let leaving = w.ray_collider(c as usize, v3(0.0, -2.0, 0.0), v3(0.0, 1.0, 0.0), 100.0, false).unwrap();
    assert!(close(leaving.t, 3.0, 1e-5) && close(leaving.normal.y, -1.0, 1e-6));
}

#[test]
fn a_point_projects_to_the_plane_and_is_inside_below_it() {
    let mut w = World::new(8, 8).unwrap();
    let c = plane(&mut w, v3(0.0, 1.0, 0.0), [0.0, 1.0, 0.0]);
    w.step(DT);
    let above = w.project_collider(c as usize, v3(3.0, 4.0, 5.0), true).unwrap();
    assert!(!above.inside && close(above.point.y, 1.0, 1e-6) && close(above.point.x, 3.0, 1e-6) && close(above.point.z, 5.0, 1e-6));
    let below = w.project_collider(c as usize, v3(3.0, -4.0, 5.0), true).unwrap();
    assert!(below.inside && close(below.point.y, -4.0, 1e-6), "a solid point inside projects to itself");
    let surface = w.project_collider(c as usize, v3(3.0, -4.0, 5.0), false).unwrap();
    assert!(surface.inside && close(surface.point.y, 1.0, 1e-6));
}

#[test]
fn a_ball_cast_stops_a_radius_above_the_plane() {
    let mut w = World::new(8, 8).unwrap();
    let c = plane(&mut w, v3(0.0, 0.0, 0.0), [0.0, 1.0, 0.0]);
    w.step(DT);
    let options = CastOptions { max: 100.0, target: 0.0, stop: true, geometry: true };
    let hit = w.cast_collider(c as usize, ball_shape(0.5), margoengine_physics_kernel::sat::Pose { p: v3(1.0, 5.0, 0.0), q: Q::IDENTITY }, v3(0.0, -1.0, 0.0), &options).unwrap();
    assert!(close(hit.t, 4.5, 1e-5) && !hit.started && close(hit.normal.y, 1.0, 1e-6), "{} {:?}", hit.t, hit.normal);
    assert!(close(hit.on_target.y, 0.0, 1e-5) && close(hit.on_query.y, 0.0, 1e-5));
    let short = CastOptions { target: 0.25, ..options };
    let stopped = w.cast_collider(c as usize, ball_shape(0.5), margoengine_physics_kernel::sat::Pose { p: v3(1.0, 5.0, 0.0), q: Q::IDENTITY }, v3(0.0, -1.0, 0.0), &short).unwrap();
    assert!(close(stopped.t, 4.25, 1e-5));
    let started = w.cast_collider(c as usize, ball_shape(0.5), margoengine_physics_kernel::sat::Pose { p: v3(0.0, 0.2, 0.0), q: Q::IDENTITY }, v3(0.0, -1.0, 0.0), &options).unwrap();
    assert!(started.started && started.t == 0.0);
    assert!(w.cast_collider(c as usize, ball_shape(0.5), margoengine_physics_kernel::sat::Pose { p: v3(1.0, 5.0, 0.0), q: Q::IDENTITY }, v3(0.0, 1.0, 0.0), &options).is_none());
}

#[test]
fn bodies_rest_on_a_half_space_whatever_their_shape() {
    let mut w = World::new(16, 16).unwrap();
    plane(&mut w, v3(0.0, 0.0, 0.0), [0.0, 1.0, 0.0]);
    let mut rest = |shape: u32, size: [f32; 3], y: f32| {
        let body = w.add_body(DYNAMIC).unwrap();
        w.add_collider(body, shape, size, [0.0; 3], ID, 1000.0).unwrap();
        w.set_v(POSITION_X, body as usize, v3(0.0, y, 0.0));
        w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
        body
    };
    let ball = rest(SHAPE_BALL, [0.4, 0.0, 0.0], 2.0);
    let cube = rest(SHAPE_BOX, [0.5, 0.5, 0.5], 4.0);
    for body in [ball, cube] {
        w.set_v(POSITION_X, body as usize, w.v(POSITION_X, body as usize).add(v3(body as f32 * 3.0, 0.0, 0.0)));
    }
    for _ in 0..300 {
        w.step(DT);
    }
    let (yb, yc) = (w.v(POSITION_X, ball as usize).y, w.v(POSITION_X, cube as usize).y);
    assert!(close(yb, 0.4, 5e-3), "ball {yb}");
    assert!(close(yc, 0.5, 5e-3), "cube {yc}");
}

#[test]
fn a_tilted_plane_holds_a_box_that_friction_can_hold() {
    // A plane tilted 20 degrees about z (normal up and toward -x); friction 0.5 holds a slope of up to atan(0.5) = 26.6.
    let mut w = World::new(8, 8).unwrap();
    let a: f32 = 20f32.to_radians();
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_HALFSPACE, [-a.sin(), a.cos(), 0.0], [0.0; 3], ID, 0.0).unwrap();
    let crate_body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(crate_body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], ID, 100.0).unwrap();
    // Resting on the surface, turned to lie along it.
    let q = Q { x: 0.0, y: 0.0, z: (a / 2.0).sin(), w: (a / 2.0).cos() };
    w.set_v(POSITION_X, crate_body as usize, v3(-a.sin() * 0.505, a.cos() * 0.505, 0.0));
    w.set_q(ROTATION_X, crate_body as usize, q);
    w.set_u(FLAGS, crate_body as usize, w.flags(crate_body as usize) & !CAN_SLEEP);
    for _ in 0..240 {
        w.step(DT);
    }
    let p = w.v(POSITION_X, crate_body as usize);
    assert!(sqrt((p.x + a.sin() * 0.5).powi(2) + (p.y - a.cos() * 0.5).powi(2)) < 0.02, "slid to {p:?}");
}
