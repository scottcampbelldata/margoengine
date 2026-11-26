// Moving a shape on its body after it is made (Rapier's `setTranslationWrtParent` and `setRotationWrtParent`): queries,
// the centre of mass and a chain's segments follow the move; a voxel grid is refused and left as it was.
use margoengine_physics2d_kernel::math::{Rot, V2, Xf, v2};
use margoengine_physics2d_kernel::query::QueryFilter;
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

fn ray_down(w: &mut World, x: f32) -> Option<f32> {
    w.ray_cast(v2(x, 5.0), v2(0.0, -1.0), 20.0, true, &QueryFilter::default()).unwrap().map(|h| 5.0 - h.t)
}

#[test]
fn a_box_moved_and_turned_on_its_body_is_met_where_it_went_and_carries_the_centre_of_mass() {
    let mut w = World::default();
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let s = w.create_shape(ground, Core::rect(1.0, 0.1, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    assert!((ray_down(&mut w, 0.0).unwrap() - 0.1).abs() < 1e-5);
    // Two metres along x: the old place is empty and the new one is met at the box's top.
    w.move_shape(s, Xf { p: v2(2.0, 0.0), q: Rot::IDENTITY }).unwrap();
    assert!(ray_down(&mut w, 0.0).is_none(), "the old place is empty");
    assert!((ray_down(&mut w, 2.0).unwrap() - 0.1).abs() < 1e-5);
    // Moved back, then a quarter turn about the body's origin: the 2 m by 0.2 m bar now stands, its top 1 m up over x = 0.
    w.move_shape(s, Xf { p: v2(-2.0, 0.0), q: Rot::IDENTITY }).unwrap();
    w.move_shape(s, Xf { p: V2::ZERO, q: Rot::from_angle(core::f32::consts::FRAC_PI_2) }).unwrap();
    assert!((ray_down(&mut w, 0.0).unwrap() - 1.0).abs() < 1e-5, "the bar stands");
    assert!(ray_down(&mut w, 0.5).is_none(), "and is 0.2 m wide");

    // A dynamic body's centre of mass follows its one shape.
    let b = w.create_body(&BodyDef { position: v2(10.0, 10.0), ..Default::default() }).unwrap();
    let t = w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    w.move_shape(t, Xf { p: v2(0.3, -0.4), q: Rot::IDENTITY }).unwrap();
    let c = w.bodies[b as usize].local_center;
    assert!((c.x - 0.3).abs() < 1e-6 && (c.y + 0.4).abs() < 1e-6, "centre of mass {c:?}");
}

#[test]
fn a_chain_moves_whole_with_its_neighbours_and_a_voxel_grid_or_a_bad_move_is_refused() {
    let mut w = World::default();
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let chain = w.create_chain(ground, &[v2(-2.0, 0.0), v2(0.0, 0.0), v2(2.0, 0.0)], false, &ShapeDef::default()).unwrap();
    for &s in &chain {
        w.move_shape(s, Xf { p: v2(0.0, 1.0), q: Rot::IDENTITY }).unwrap();
    }
    assert!((ray_down(&mut w, -1.0).unwrap() - 1.0).abs() < 1e-5 && (ray_down(&mut w, 1.0).unwrap() - 1.0).abs() < 1e-5);
    let ghost = w.shapes[chain[0] as usize].ghosts[1].unwrap();
    assert!((ghost.y - 1.0).abs() < 1e-6, "the neighbour's far vertex moved with it: {ghost:?}");
    let bits = [1u32];
    let grid = margoengine_physics2d_kernel::voxel::Grid::new(1, 1, v2(1.0, 1.0), V2::ZERO, &bits).unwrap();
    let v = w.create_voxels(ground, grid, &ShapeDef::default()).unwrap();
    assert!(w.move_shape(v, Xf { p: v2(1.0, 0.0), q: Rot::IDENTITY }).is_err());
    assert!(w.move_shape(chain[0], Xf { p: v2(f32::NAN, 0.0), q: Rot::IDENTITY }).is_err());
}
