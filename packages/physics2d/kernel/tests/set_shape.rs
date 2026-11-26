// Changing a shape's outline after it is made (Rapier's `setShape`): the body's mass, its rest on the floor, the queries that
// meet it and the contacts it keeps all follow the new outline, and a chain's segment or a voxel grid is refused.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::query::QueryFilter;
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

#[test]
fn a_box_made_a_ball_rests_on_the_floor_at_the_ball_s_radius_with_the_ball_s_mass() {
    let mut w = World::new(Settings { gravity: v2(0.0, -9.81), ..Default::default() });
    let floor = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(floor, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let b = w.create_body(&BodyDef { position: v2(0.0, 0.25), can_sleep: false, ..Default::default() }).unwrap();
    let s = w.create_shape(b, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 2.0, ..Default::default() }).unwrap();
    for _ in 0..60 {
        w.step(DT).unwrap();
    }
    assert!((w.bodies[b as usize].xf.p.y - 0.25).abs() < 0.02, "the box rests at its half height");
    // A ball of radius 0.6: mass rho pi r^2, and it comes to rest with its centre at the radius.
    w.set_shape_core(s, Core::circle(V2::ZERO, 0.6).unwrap()).unwrap();
    let mass = 2.0 * core::f32::consts::PI * 0.36;
    assert!((w.bodies[b as usize].mass - mass).abs() < 1e-4 * mass, "mass {} against {mass}", w.bodies[b as usize].mass);
    for _ in 0..120 {
        w.step(DT).unwrap();
    }
    let y = w.bodies[b as usize].xf.p.y;
    assert!((y - 0.6).abs() < 0.02, "the ball rests at its radius, y {y}");
    // A ray along the floor from the side meets the ball's outline, not the box's.
    let hit = w.ray_cast(v2(-3.0, 0.6), v2(1.0, 0.0), 10.0, true, &QueryFilter::default()).unwrap().expect("the ray meets the ball");
    assert!((hit.t - (3.0 - 0.6)).abs() < 1e-3, "t {}", hit.t);
}

#[test]
fn a_chain_segment_or_a_dead_shape_is_refused_and_left_as_it_was() {
    let mut w = World::default();
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let chain = w.create_chain(ground, &[v2(-1.0, 0.0), v2(0.0, 0.0), v2(1.0, 0.0)], false, &ShapeDef::default()).unwrap();
    assert!(w.set_shape_core(chain[0], Core::circle(V2::ZERO, 0.5).unwrap()).is_err());
    let b = w.create_body(&BodyDef::default()).unwrap();
    let s = w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    w.remove_shape(s).unwrap();
    assert!(w.set_shape_core(s, Core::circle(V2::ZERO, 0.5).unwrap()).is_err());
}
