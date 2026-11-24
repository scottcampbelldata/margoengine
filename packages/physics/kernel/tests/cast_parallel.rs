// A shape sliding along a surface it does not touch is no hit, whatever the world's contact margin.
use margoengine_physics_kernel::cast::*;
use margoengine_physics_kernel::hull::{BoxData, box_poly};
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::sat::Pose;

#[test]
fn a_ball_two_centimetres_above_a_box_sliding_along_it_misses() {
    let mut data = BoxData::new();
    let floor = Solid::Poly { poly: box_poly(v3(20.0, 0.5, 20.0), &mut data), pose: Pose { p: v3(0.0, -0.5, 0.0), q: Q::IDENTITY } };
    let ball = |y: f32| Solid::Round { p: v3(0.0, y, 0.0), q: v3(0.0, y, 0.0), r: 0.5 };
    for gap in [0.005f32, 0.02, 0.05, 0.2] {
        let o = CastOptions { max: 10.0, target: 0.0, stop: true, geometry: true };
        let hit = cast_convex(&ball(0.5 + gap), &floor, v3(1.0, 0.0, 0.0), &o);
        assert!(hit.is_none(), "gap {gap}: {hit:?}");
    }
}

#[test]
fn the_size_of_the_other_shape_does_not_widen_what_counts_as_touching() {
    // A floor a kilometre wide: the stop of the search is relative to the shapes' size, which once made every gap under a
    // few centimetres a touch.
    let mut data = BoxData::new();
    let floor = Solid::Poly { poly: box_poly(v3(1000.0, 0.5, 1000.0), &mut data), pose: Pose { p: v3(0.0, -0.5, 0.0), q: Q::IDENTITY } };
    let ball = |y: f32| Solid::Round { p: v3(3.0, y, 4.0), q: v3(3.0, y, 4.0), r: 0.5 };
    let along = CastOptions { max: 50.0, target: 0.0, stop: true, geometry: true };
    for gap in [0.01f32, 0.02, 0.1] {
        assert!(cast_convex(&ball(0.5 + gap), &floor, v3(0.8, 0.0, 0.6), &along).is_none(), "gap {gap}");
    }
    // A ball in the floor is a hit at the start; one above it moving down hits where the gap says.
    let inside = cast_convex(&ball(0.4), &floor, v3(1.0, 0.0, 0.0), &along).expect("overlap is a hit");
    assert!(inside.started && inside.t == 0.0);
    let down = CastOptions { max: 50.0, target: 0.0, stop: true, geometry: true };
    let landing = cast_convex(&ball(0.8), &floor, v3(0.0, -1.0, 0.0), &down).expect("the ball falls onto the floor");
    assert!((landing.t - 0.3).abs() < 1e-4 && !landing.started, "{landing:?}");
}
