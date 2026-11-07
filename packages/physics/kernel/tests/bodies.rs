// Rows and mass: the free list hands rows back in a replayable order, and each solid's mass and inertia match a numeric
// integral of its density, an independent route to the same number, or a closed form the code does not use.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::mass::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

fn close(got: f32, want: f64, relative: f64) {
    assert!((got as f64 - want).abs() <= relative * want.abs(), "{got} against {want}");
}

#[test]
fn freed_rows_come_back_last_in_first_out_with_nothing_left_in_them() {
    let mut w = World::new(4, 4).unwrap();
    let (a, b, c) = (w.add_body(DYNAMIC).unwrap(), w.add_body(DYNAMIC).unwrap(), w.add_body(DYNAMIC).unwrap());
    assert_eq!((a, b, c), (0, 1, 2));
    w.set_v(LINEAR_X, 1, v3(1.0, 2.0, 3.0));
    w.set_v(FORCE_X, 1, v3(1.0, 2.0, 3.0));
    assert!(w.remove_body(b));
    assert!(w.remove_body(a));
    assert!(!w.remove_body(a), "a second remove is refused");
    assert!(!w.remove_body(99));
    assert_eq!(unsafe { *w.u(GENERATION).add(1) }, 1);
    assert_eq!(w.add_body(FIXED), Some(0));
    assert_eq!(w.add_body(DYNAMIC), Some(1));
    assert_eq!(w.v(LINEAR_X, 1), v3(0.0, 0.0, 0.0), "a reused row starts clean");
    assert_eq!(w.v(FORCE_X, 1), v3(0.0, 0.0, 0.0));
    assert_eq!(w.q(ROTATION_X, 1), Q::IDENTITY);
    assert_eq!(unsafe { *w.u(GENERATION).add(1) }, 1, "the generation stays counted");
    assert_eq!(w.add_body(DYNAMIC), Some(3));
    assert_eq!(w.add_body(DYNAMIC), None, "full");
    assert!(w.reserve(5, 4));
    assert_eq!(w.add_body(DYNAMIC), Some(4));
}

#[test]
fn a_removed_body_is_skipped_by_the_step_and_its_colliders_are_freed() {
    let mut w = World::new(4, 4).unwrap();
    let b = w.add_body(DYNAMIC).unwrap();
    let c = w.add_collider(b, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    assert!(w.remove_body(b));
    w.set_v(LINEAR_X, b as usize, v3(1.0, 0.0, 0.0));
    w.step(1.0);
    assert_eq!(w.v(POSITION_X, b as usize), v3(0.0, 0.0, 0.0));
    assert!(!w.remove_collider(c), "gone with its body");
    let next = w.add_body(DYNAMIC).unwrap();
    assert_eq!(w.add_collider(next, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0), Some(c), "row reused");
    assert_eq!(unsafe { *w.u(COLLIDER_GENERATION).add(c as usize) }, 1);
}

/// Mass and moments about the centre by a midpoint sum over a grid: an inside test is all it knows about the shape.
fn integrate(bound: [f64; 3], inside: impl Fn(f64, f64, f64) -> bool) -> (f64, [f64; 3]) {
    let n = 200;
    let d = [2.0 * bound[0] / n as f64, 2.0 * bound[1] / n as f64, 2.0 * bound[2] / n as f64];
    let cell = d[0] * d[1] * d[2];
    let (mut mass, mut moments) = (0.0, [0.0; 3]);
    for i in 0..n {
        let x = -bound[0] + (i as f64 + 0.5) * d[0];
        for j in 0..n {
            let y = -bound[1] + (j as f64 + 0.5) * d[1];
            for k in 0..n {
                let z = -bound[2] + (k as f64 + 0.5) * d[2];
                if inside(x, y, z) {
                    mass += cell;
                    moments[0] += cell * (y * y + z * z);
                    moments[1] += cell * (x * x + z * z);
                    moments[2] += cell * (x * x + y * y);
                }
            }
        }
    }
    (mass, moments)
}

#[test]
fn the_three_solids_match_a_numeric_integral_of_their_shape() {
    // A grid of 200 cells a side puts the edge of a curved solid within a cell: about 1 percent of the volume at most.
    let tolerance = 0.01;
    let solid = solid_box(v3(0.5, 1.0, 1.5), 2.0);
    close(solid.mass, 12.0, 1e-6);
    close(solid.moments.x, 12.0 / 3.0 * (1.0 + 2.25), 1e-6);
    let (m, i) = integrate([0.5, 1.0, 1.5], |_, _, _| true);
    close(solid.mass, 2.0 * m, tolerance);
    close(solid.moments.y, 2.0 * i[1], tolerance);

    let solid = solid_ball(0.7, 3.0);
    let (m, i) = integrate([0.7; 3], |x, y, z| x * x + y * y + z * z <= 0.49);
    close(solid.mass, 3.0 * m, tolerance);
    close(solid.moments.z, 3.0 * i[2], tolerance);

    let (r, a) = (0.4f64, 0.9f64);
    let solid = solid_capsule(r as f32, a as f32, 1.5);
    let (m, i) = integrate([r, a + r, r], |x, y, z| {
        let d = (y.abs() - a).max(0.0);
        x * x + z * z + d * d <= r * r
    });
    close(solid.mass, 1.5 * m, tolerance);
    close(solid.moments.x, 1.5 * i[0], tolerance);
    close(solid.moments.y, 1.5 * i[1], tolerance);
    close(solid.moments.z, 1.5 * i[2], tolerance);
}

#[test]
fn a_capsule_of_no_length_is_a_ball_and_one_of_no_radius_has_no_mass() {
    let (capsule, ball) = (solid_capsule(1.3, 0.0, 2.0), solid_ball(1.3, 2.0));
    assert_eq!(capsule.mass, ball.mass);
    close(capsule.moments.x, ball.moments.x as f64, 1e-6);
    assert_eq!(solid_capsule(0.0, 2.0, 1.0).mass, 0.0);
}

fn inverse(w: &World, at: usize) -> f64 {
    1.0 / w.s(INVERSE_MASS, at) as f64
}

#[test]
fn two_balls_make_a_dumbbell_with_the_parallel_axis_inertia() {
    let mut w = World::new(1, 4).unwrap();
    let b = w.add_body(DYNAMIC).unwrap();
    w.add_collider(b, SHAPE_BALL, [0.5, 0.0, 0.0], [-2.0, 1.0, 0.0], IDENTITY, 1.0).unwrap();
    w.add_collider(b, SHAPE_BALL, [0.5, 0.0, 0.0], [2.0, 1.0, 0.0], IDENTITY, 1.0).unwrap();
    let ball = solid_ball(0.5, 1.0);
    let at = b as usize;
    close(w.s(INVERSE_MASS, at), 1.0 / (2.0 * ball.mass as f64), 1e-6);
    assert_eq!(w.v(LOCAL_CENTER_X, at), v3(0.0, 1.0, 0.0));
    let along = 2.0 * ball.moments.x as f64;
    let across = along + 2.0 * ball.mass as f64 * 4.0;
    let i = w.v(INERTIA_X, at);
    close(i.x, along, 1e-6);
    close(i.y, across, 1e-6);
    close(i.z, across, 1e-6);
    assert_eq!(w.q(INERTIA_FRAME_X, at), Q::IDENTITY);
}

#[test]
fn a_tilted_collider_turns_the_principal_frame_with_it() {
    let mut w = World::new(1, 2).unwrap();
    let b = w.add_body(DYNAMIC).unwrap();
    let turn = Q::from_rotation_vector(v3(0.3, -0.5, 0.8));
    w.add_collider(b, SHAPE_BOX, [0.5, 1.0, 2.0], [0.0; 3], [turn.x, turn.y, turn.z, turn.w], 1.0).unwrap();
    let solid = solid_box(v3(0.5, 1.0, 2.0), 1.0);
    let at = b as usize;
    let frame = w.q(INERTIA_FRAME_X, at);
    let moments = w.v(INERTIA_X, at);
    // The world inertia applied to any vector agrees between the two descriptions.
    for v in [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.3, -0.7, 0.2)] {
        let a = frame.rotate(moments.mul(frame.unrotate(v)));
        let b = turn.rotate(solid.moments.mul(turn.unrotate(v)));
        let d = a.sub(b);
        assert!(d.dot(d).sqrt() < 2e-5 * solid.moments.x, "{a:?} against {b:?}");
    }
}

#[test]
fn removing_a_collider_or_adding_mass_recomputes_the_body() {
    let mut w = World::new(1, 2).unwrap();
    let b = w.add_body(DYNAMIC).unwrap();
    let at = b as usize;
    let small = w.add_collider(b, SHAPE_BOX, [1.0, 1.0, 1.0], [3.0, 0.0, 0.0], IDENTITY, 1.0).unwrap();
    let big = w.add_collider(b, SHAPE_BOX, [1.0, 1.0, 1.0], [-3.0, 0.0, 0.0], IDENTITY, 3.0).unwrap();
    close(w.v(LOCAL_CENTER_X, at).x, -1.5, 1e-6);
    assert!(w.remove_collider(small));
    assert_eq!(w.v(LOCAL_CENTER_X, at).x, -3.0);
    close(inverse(&w, at) as f32, 24.0, 1e-6);
    let moment = w.v(INERTIA_X, at).x as f64;
    w.set_s(ADDITIONAL_MASS, at, 24.0);
    w.update_mass(b);
    close(inverse(&w, at) as f32, 48.0, 1e-6);
    close(w.v(INERTIA_X, at).x, 2.0 * moment, 1e-6);
    assert!(w.remove_collider(big));
    assert!(!w.remove_collider(big));
    close(inverse(&w, at) as f32, 24.0, 1e-6);
    assert_eq!(w.v(INVERSE_INERTIA_X, at), v3(0.0, 0.0, 0.0), "no colliders: nothing to turn");
    assert_eq!(unsafe { *w.u(FIRST_COLLIDER).add(at) }, NONE);
}

#[test]
fn a_dynamic_body_with_no_mass_does_not_fall() {
    let mut w = World::new(1, 1).unwrap();
    let b = w.add_body(DYNAMIC).unwrap() as usize;
    w.step(1.0);
    assert_eq!(w.v(POSITION_X, b), v3(0.0, 0.0, 0.0));
}
