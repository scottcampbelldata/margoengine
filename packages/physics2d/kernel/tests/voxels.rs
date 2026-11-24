// A grid of solid cells answers queries by cell: points, rays, overlaps, casts and projections meet the cells themselves.
use margoengine_physics2d_kernel::math::{Rot, V2, Xf, v2};
use margoengine_physics2d_kernel::query::QueryFilter;
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::voxel::Grid;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() < 1.0e-4
}

/// A U of 5 by 3 one-metre cells with its top left corner at (0, 0): rows grow along y.
fn cup() -> Grid {
    let rows = [[1, 0, 0, 0, 1], [1, 0, 0, 0, 1], [1, 1, 1, 1, 1]];
    let mut bits = vec![0u32; 1];
    for (r, row) in rows.iter().enumerate() {
        for (c, &v) in row.iter().enumerate() {
            bits[0] |= v << (r * 5 + c);
        }
    }
    Grid::new(5, 3, v2(1.0, 1.0), V2::ZERO, &bits).unwrap()
}

fn world_with(grid: Grid, at: V2) -> (World, u32) {
    let mut w = World::default();
    let b = w.create_body(&BodyDef { kind: Kind::Static, position: at, ..Default::default() }).unwrap();
    let s = w.create_voxels(b, grid, &ShapeDef::default()).unwrap();
    (w, s)
}

#[test]
fn a_point_is_inside_when_its_cell_is_filled() {
    let (mut w, s) = world_with(cup(), v2(10.0, 20.0));
    let f = QueryFilter::default();
    assert_eq!(w.point_query(v2(10.5, 20.5), &f).unwrap(), [s], "the left wall");
    assert_eq!(w.point_query(v2(12.5, 22.5), &f).unwrap(), [s], "the floor row");
    assert!(w.point_query(v2(12.5, 21.5), &f).unwrap().is_empty(), "in the cup");
    assert!(w.point_query(v2(9.9, 20.5), &f).unwrap().is_empty(), "outside the grid");
    assert!(w.point_query(v2(12.5, 23.1), &f).unwrap().is_empty());
}

#[test]
fn rays_walk_the_cells() {
    let (mut w, s) = world_with(cup(), v2(10.0, 20.0));
    let f = QueryFilter::default();
    // Down the cup: the floor row's top at y 22.
    let h = w.ray_cast(v2(12.5, 0.0), v2(0.0, 1.0), 100.0, true, &f).unwrap().unwrap();
    assert!(h.shape == s && near(h.t, 22.0) && near(h.normal.y, -1.0), "{h:?}");
    // From the left, above the floor: the wall's left face.
    let h = w.ray_cast(v2(0.0, 20.5), v2(1.0, 0.0), 100.0, true, &f).unwrap().unwrap();
    assert!(near(h.t, 10.0) && near(h.normal.x, -1.0), "{h:?}");
    // From inside the cup sideways: the right wall's inner face.
    let h = w.ray_cast(v2(12.5, 20.5), v2(1.0, 0.0), 100.0, true, &f).unwrap().unwrap();
    assert!(near(h.t, 1.5) && near(h.normal.x, -1.0), "{h:?}");
    // Diagonal into the left wall's top.
    let d = v2(1.0, 1.0).normalize().0;
    let h = w.ray_cast(v2(8.0, 18.0), d, 100.0, true, &f).unwrap().unwrap();
    assert!(near(h.t, 2.0 * 2f32.sqrt()), "{h:?}");
    // Misses: over the top, and too short.
    assert!(w.ray_cast(v2(0.0, 19.0), v2(1.0, 0.0), 100.0, true, &f).unwrap().is_none());
    assert!(w.ray_cast(v2(0.0, 20.5), v2(1.0, 0.0), 5.0, true, &f).unwrap().is_none());
    // Inside a filled cell: solid hits at 0, hollow gives the exit.
    let h = w.ray_cast(v2(10.5, 20.5), v2(1.0, 0.0), 100.0, true, &f).unwrap().unwrap();
    assert_eq!(h.t, 0.0);
    let h = w.ray_cast(v2(10.5, 20.5), v2(1.0, 0.0), 100.0, false, &f).unwrap().unwrap();
    assert!(near(h.t, 0.5) && near(h.normal.x, 1.0), "{h:?}");
}

#[test]
fn shapes_overlap_and_cast_against_cells() {
    let (mut w, s) = world_with(cup(), v2(0.0, 0.0));
    let f = QueryFilter::default();
    let ball = Core::circle(V2::ZERO, 0.4).unwrap();
    let at = |x, y| Xf { p: v2(x, y), q: Rot::IDENTITY };
    assert_eq!(w.shape_overlap(&ball, at(2.5, 2.5), &f).unwrap(), [s], "on the floor row");
    assert!(w.shape_overlap(&ball, at(2.5, 1.0), &f).unwrap().is_empty(), "in the cup");
    assert_eq!(w.shape_overlap(&ball, at(0.5, 0.5), &f).unwrap(), [s]);
    let hit = w.shape_cast(&ball, at(2.5, -3.0), v2(0.0, 1.0), 20.0, &f).unwrap().unwrap();
    assert!(hit.shape == s && (hit.t - (2.0 - 0.4 + 3.0)).abs() < 2e-3, "falls into the cup onto the floor: {hit:?}");
    let hit = w.shape_cast(&ball, at(-3.0, 0.5), v2(1.0, 0.0), 20.0, &f).unwrap().unwrap();
    assert!((hit.t - (3.0 - 0.4)).abs() < 2e-3, "{hit:?}");
    assert!(w.shape_cast(&ball, at(2.5, -3.0), v2(0.0, -1.0), 20.0, &f).unwrap().is_none());
    // Projection: a point in the cup is nearest the floor; one inside a cell is inside.
    let p = w.project_point(v2(2.5, 1.5), &f).unwrap().unwrap();
    assert!(!p.inside && near(p.point.y, 2.0) && near(p.distance, 0.5), "{p:?}");
    let p = w.project_point(v2(0.5, 0.5), &f).unwrap().unwrap();
    assert!(p.inside && p.distance == 0.0);
}

#[test]
fn a_grid_touches_nothing_weighs_nothing_and_survives_a_snapshot() {
    let (mut w, s) = world_with(cup(), v2(0.0, 0.0));
    let ball = w.create_body(&BodyDef { position: v2(2.5, -2.0), ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.4).unwrap(), &ShapeDef::default()).unwrap();
    for _ in 0..120 {
        w.step(1.0 / 60.0).unwrap();
    }
    assert!(w.bodies[ball as usize].xf.p.y < -5.0, "the ball falls through a grid with no outlines");
    assert_eq!(w.bodies[0].mass, 0.0);
    let r = World::from_snapshot(&w.snapshot()).unwrap();
    assert_eq!(r.shapes[s as usize].grid, w.shapes[s as usize].grid);
    assert!(Grid::new(0, 3, v2(1.0, 1.0), V2::ZERO, &[0]).is_none());
    assert!(Grid::new(2, 2, v2(0.0, 1.0), V2::ZERO, &[0]).is_none());
    assert!(w.create_voxels(0, Grid::new(2, 2, v2(1.0, 1.0), V2::ZERO, &[0]).unwrap(), &ShapeDef::default()).is_err(), "no cell is filled");
}
