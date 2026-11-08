// Voxel grids: cells rest and weigh as boxes, edits open and grow the grid in place, and a body slides across the seams
// of one grid and of two coupled grids without catching, while two grids left uncoupled catch at their border, as
// Rapier's do (seen from outside, packages/physics/tests/collider.test.js on the root entry).
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::voxel::*;
use margoengine_physics_kernel::world::World;

const DT: f32 = 1.0 / 60.0;
const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

/// A grid of `cells` (grid coordinates), each `size`, as a mesh row.
fn grid(w: &mut World, cells: &[[i32; 3]], size: V3) -> u32 {
    let (mut low, mut high) = ([i32::MAX; 3], [i32::MIN; 3]);
    for c in cells {
        for k in 0..3 {
            low[k] = low[k].min(c[k]);
            high[k] = high[k].max(c[k]);
        }
    }
    let dims = [(high[0] - low[0] + 1) as u32, (high[1] - low[1] + 1) as u32, (high[2] - low[2] + 1) as u32];
    assert!(w.begin_voxels(dims[0] * dims[1] * dims[2]));
    let first = w.header().mesh_rows[4] as usize;
    for c in cells {
        let index = (c[0] - low[0]) as u32 + dims[0] * ((c[1] - low[1]) as u32 + dims[1] * (c[2] - low[2]) as u32);
        let at = first + (index >> 2) as usize;
        w.set_u(VOXEL_WORD, at, w.uu(VOXEL_WORD, at) | CELL_FILLED << (8 * (index & 3)));
    }
    let row = w.end_voxels(low, dims, size);
    assert!(row >= 0, "grid refused: {row}");
    row as u32
}

/// A square of `n` by `n` cells at y = 0.
fn slab(n: i32) -> Vec<[i32; 3]> {
    let mut out = vec![];
    for x in 0..n {
        for z in 0..n {
            out.push([x, 0, z]);
        }
    }
    out
}

fn fixed_grid(w: &mut World, cells: &[[i32; 3]], at: V3) -> u32 {
    let mesh = grid(w, cells, v3(1.0, 1.0, 1.0));
    let body = w.add_body(FIXED).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap()
}

fn crate_at(w: &mut World, at: V3, half: f32, friction: f32) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    let c = w.add_collider(body, SHAPE_BOX, [half, half, half], [0.0; 3], ID, 1.0).unwrap();
    w.set_s(COLLIDER_FRICTION, c as usize, friction);
    body
}

#[test]
fn the_rule_snaps_only_normals_that_lean_toward_a_filled_neighbour() {
    // Top exposed, the neighbour at -x filled.
    let byte = CELL_FILLED | 2 << 1 | 2 << 3 | 2 << 4 | 2 << 5 | 2 << 0;
    let byte = byte & !(2 << 2);
    assert_eq!(voxel_verdict(v3(0.0, 1.0, 0.0), byte), Some((false, 2)));
    assert_eq!(voxel_verdict(v3(-0.6, 0.8, 0.0), byte), Some((true, 2)), "leans over the flat seam: snapped to the top");
    assert_eq!(voxel_verdict(v3(0.0, -1.0, 0.0), byte), Some((true, 2)), "from below the top: only the top pushes");
    // A step: the +x face is exposed too, so a normal leaning there stands.
    let step = byte & !(2 << 0);
    assert_eq!(voxel_verdict(v3(0.6, 0.8, 0.0), step), Some((false, 2)));
    assert_eq!(voxel_verdict(v3(1.0, 0.0, 0.0), step), Some((false, 0)));
    assert_eq!(voxel_verdict(v3(0.0, 1.0, 0.0), CELL_FILLED | 0x7e), None, "a buried cell gives nothing");
}

#[test]
fn a_box_rests_on_the_top_of_the_cells() {
    let mut w = World::new(4, 8).unwrap();
    fixed_grid(&mut w, &slab(4), v3(0.0, 0.0, 0.0));
    let body = crate_at(&mut w, v3(2.0, 2.0, 2.0), 0.5, 0.5);
    for _ in 0..240 {
        w.step(DT);
    }
    let y = w.s(POSITION_Y, body as usize);
    assert!((y - 1.5).abs() < 0.02, "rests at {y}");
}

/// Slides a frictionless box at 3 m/s from x = 1 over cells from x = 0 to 8 at z = 2 and gives its lowest speed and its
/// height range.
fn slide(w: &mut World) -> (f32, f32, f32) {
    let body = crate_at(w, v3(1.0, 1.3, 2.5), 0.3, 0.0);
    w.set_v(LINEAR_X, body as usize, v3(3.0, 0.0, 0.0));
    let (mut slowest, mut low, mut high) = (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY);
    for _ in 0..90 {
        w.step(DT);
        let y = w.s(POSITION_Y, body as usize);
        slowest = slowest.min(w.s(LINEAR_X, body as usize));
        low = low.min(y);
        high = high.max(y);
    }
    (slowest, low, high)
}

#[test]
fn a_box_slides_across_the_seams_of_one_grid_without_catching() {
    let mut w = World::new(4, 8).unwrap();
    let c = fixed_grid(&mut w, &slab(8), v3(0.0, 0.0, 0.0));
    w.set_s(COLLIDER_FRICTION, c as usize, 0.0);
    let (slowest, low, high) = slide(&mut w);
    assert!(slowest > 2.99, "caught on a seam: down to {slowest} m/s");
    assert!(low > 1.28 && high < 1.31, "height from {low} to {high}");
}

#[test]
fn cylinders_and_cones_slide_across_the_seams_without_catching() {
    // The top of the slab is at y = 1; each shape stands on it, its origin at its half height (plus a border).
    for (shape, size, rest) in [(SHAPE_CYLINDER, [0.3, 0.3, 0.0], 1.3), (SHAPE_CYLINDER, [0.3, 0.3, 0.05], 1.35), (SHAPE_CONE, [0.4, 0.3, 0.0], 1.3)] {
        let mut w = World::new(4, 8).unwrap();
        let c = fixed_grid(&mut w, &slab(8), v3(0.0, 0.0, 0.0));
        w.set_s(COLLIDER_FRICTION, c as usize, 0.0);
        let body = w.add_body(DYNAMIC).unwrap();
        w.set_pose(body, v3(1.0, rest, 2.5), Q::IDENTITY, false);
        w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
        let own = w.add_collider(body, shape, size, [0.0; 3], ID, 1.0).unwrap();
        w.set_s(COLLIDER_FRICTION, own as usize, 0.0);
        w.set_v(LINEAR_X, body as usize, v3(3.0, 0.0, 0.0));
        let (mut slowest, mut low, mut high) = (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY);
        for _ in 0..90 {
            w.step(DT);
            let y = w.s(POSITION_Y, body as usize);
            slowest = slowest.min(w.s(LINEAR_X, body as usize));
            low = low.min(y);
            high = high.max(y);
        }
        assert!(slowest > 2.99, "{shape} {size:?} caught on a seam: down to {slowest} m/s");
        assert!(low > rest - 0.02 && high < rest + 0.01, "{shape} {size:?} height from {low} to {high}");
    }
}

#[test]
fn coupled_grids_have_no_seam_and_uncoupled_ones_catch_as_on_rapier() {
    for coupled in [true, false] {
        let mut w = World::new(4, 8).unwrap();
        let a = fixed_grid(&mut w, &slab(4), v3(0.0, 0.0, 0.0));
        let b = fixed_grid(&mut w, &slab(4), v3(4.0, 0.0, 0.0));
        for c in [a, b] {
            w.set_s(COLLIDER_FRICTION, c as usize, 0.0);
        }
        if coupled {
            assert_eq!(w.combine_voxels(a, b, [4, 0, 0]), 1);
            // An edit on the border away from the path, told to the neighbour.
            assert_eq!(w.set_voxel(a, [3, 0, 0], false), 1);
            assert_eq!(w.propagate_voxel(a, b, [3, 0, 0], [4, 0, 0]), 1);
        }
        let (slowest, low, high) = slide(&mut w);
        if coupled {
            assert!(slowest > 2.99, "caught on the coupled seam: down to {slowest} m/s");
            assert!(low > 1.28 && high < 1.31, "height from {low} to {high}");
        } else {
            assert!(slowest < 2.5, "an uncoupled border is a step's side face, as on Rapier: {slowest} m/s");
        }
    }
}

#[test]
fn propagate_writes_the_neighbour_border_cell() {
    let mut w = World::new(4, 8).unwrap();
    let a = fixed_grid(&mut w, &slab(4), v3(0.0, 0.0, 0.0));
    let b = fixed_grid(&mut w, &slab(4), v3(4.0, 0.0, 0.0));
    let mb = w.uu(COLLIDER_HULL, b as usize) as usize;
    w.combine_voxels(a, b, [4, 0, 0]);
    // b's cell (0, 0, 2) sees a's (3, 0, 2) across its -x face.
    let index = 4 * 2;
    assert!(w.cell_byte(mb, index) & (2 << 1) != 0);
    w.set_voxel(a, [3, 0, 2], false);
    assert!(w.cell_byte(mb, index) & (2 << 1) != 0, "b is not told until propagate");
    w.propagate_voxel(a, b, [3, 0, 2], [4, 0, 0]);
    assert!(w.cell_byte(mb, index) & (2 << 1) == 0);
    assert!(w.cell_byte(mb, 4) & (2 << 1) != 0, "the cell beside it keeps its neighbour");
}

#[test]
fn set_voxel_opens_a_hole_and_grows_the_grid_in_place() {
    let mut w = World::new(4, 8).unwrap();
    let ground = fixed_grid(&mut w, &[[0, 0, 0], [1, 0, 0], [2, 0, 0]], v3(0.0, 0.0, 0.0));
    let body = crate_at(&mut w, v3(1.5, 2.0, 0.5), 0.25, 0.5);
    for _ in 0..180 {
        w.step(DT);
    }
    assert!((w.s(POSITION_Y, body as usize) - 1.25).abs() < 0.02);
    assert_eq!(w.set_voxel(ground, [1, 0, 0], false), 1);
    for _ in 0..60 {
        w.step(DT);
    }
    assert!(w.s(POSITION_Y, body as usize) < 0.5, "fell through the hole");
    // A cell outside the grid grows it; a box dropped there rests on it.
    assert_eq!(w.set_voxel(ground, [5, 0, 0], true), 1);
    let other = crate_at(&mut w, v3(5.5, 2.0, 0.5), 0.25, 0.5);
    for _ in 0..180 {
        w.step(DT);
    }
    let y = w.s(POSITION_Y, other as usize);
    assert!((y - 1.25).abs() < 0.02, "rests on the grown cell at {y}");
    assert_eq!(w.set_voxel(ground, [-9, 0, 0], false), 1, "emptying a cell outside changes nothing");
}

#[test]
fn a_grid_weighs_what_one_box_of_its_cells_weighs() {
    let mut w = World::new(4, 8).unwrap();
    let mesh = grid(&mut w, &[[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], v3(0.5, 0.5, 0.5));
    let one = w.add_body(DYNAMIC).unwrap();
    let c = w.add_collider(one, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 2.0).unwrap();
    let other = w.add_body(DYNAMIC).unwrap();
    w.add_collider(other, SHAPE_BOX, [0.5, 0.25, 0.5], [0.5, 0.25, 0.5], ID, 2.0).unwrap();
    assert!((1.0 / w.s(INVERSE_MASS, one as usize) - 1.0).abs() < 1e-6, "4 cells of 1/8 m^3 at 2 kg/m^3");
    for column in [LOCAL_CENTER_X, LOCAL_CENTER_Y, LOCAL_CENTER_Z, INERTIA_X, INERTIA_Y, INERTIA_Z] {
        let (got, want) = (w.s(column, one as usize), w.s(column, other as usize));
        assert!((got - want).abs() < 1e-6, "column {column}: {got} against {want}");
    }
    // An emptied cell takes its mass away at once.
    w.set_voxel(c, [1, 0, 1], false);
    assert!((1.0 / w.s(INVERSE_MASS, one as usize) - 0.75).abs() < 1e-6);
    let center = w.v(LOCAL_CENTER_X, one as usize);
    // Cell centres 0.25, 0.75 and 0.25 along x and z.
    assert!((center.x - 5.0 / 12.0).abs() < 1e-6 && (center.z - 5.0 / 12.0).abs() < 1e-6, "centre {center:?}");
}

#[test]
fn a_grid_rests_on_a_grid() {
    let mut w = World::new(4, 8).unwrap();
    fixed_grid(&mut w, &slab(4), v3(0.0, 0.0, 0.0));
    let mesh = grid(&mut w, &[[0, 0, 0], [1, 0, 0]], v3(1.0, 1.0, 1.0));
    let body = w.add_body(DYNAMIC).unwrap();
    w.set_pose(body, v3(1.0, 3.0, 1.0), Q::IDENTITY, false);
    w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    for _ in 0..240 {
        w.step(DT);
    }
    let y = w.s(POSITION_Y, body as usize);
    assert!((y - 1.0).abs() < 0.02, "the grid's bottom rests on the top at {y}");
}

#[test]
fn a_grid_falls_through_a_mesh_as_on_rapier() {
    let mut w = World::new(4, 8).unwrap();
    assert!(w.begin_mesh(3, 1));
    let [_, v0, t0, _, _] = w.header().mesh_rows;
    for (i, p) in [v3(-5.0, 0.0, -5.0), v3(-5.0, 0.0, 5.0), v3(5.0, 0.0, 0.0)].into_iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 as usize + i, p);
    }
    for (k, column) in [TRIANGLE_A, TRIANGLE_B, TRIANGLE_C].into_iter().enumerate() {
        w.set_u(column, t0 as usize, k as u32);
        w.set_u(TRIANGLE_ACROSS_0 + k, t0 as usize, margoengine_physics_kernel::world::NONE);
    }
    let tri = w.end_mesh(3, 1, 0);
    let ground = w.add_body(FIXED).unwrap();
    w.add_collider(ground, SHAPE_TRIMESH, [tri as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap();
    let mesh = grid(&mut w, &[[0, 0, 0]], v3(1.0, 1.0, 1.0));
    let body = w.add_body(DYNAMIC).unwrap();
    w.set_pose(body, v3(-1.0, 1.0, -0.5), Q::IDENTITY, false);
    w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    for _ in 0..60 {
        w.step(DT);
    }
    assert!(w.s(POSITION_Y, body as usize) < -1.0);
}

#[test]
fn a_ball_rolls_across_the_cells_without_a_bump() {
    let mut w = World::new(4, 8).unwrap();
    fixed_grid(&mut w, &slab(16), v3(0.0, 0.0, 0.0));
    let body = w.add_body(DYNAMIC).unwrap();
    w.set_pose(body, v3(1.0, 1.5, 2.5), Q::IDENTITY, false);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    w.add_collider(body, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    w.set_v(LINEAR_X, body as usize, v3(5.0, 0.0, 0.0));
    let mut high = f32::NEG_INFINITY;
    for _ in 0..120 {
        w.step(DT);
        high = high.max(w.s(POSITION_Y, body as usize));
    }
    assert!(high < 1.501, "bumped up to {high}");
    assert!(w.s(POSITION_X, body as usize) > 7.0);
}

#[test]
fn refusals() {
    let mut w = World::new(4, 8).unwrap();
    assert!(w.begin_voxels(1));
    assert_eq!(w.end_voxels([0; 3], [1, 1, 1], v3(1.0, 0.0, 1.0)), VOXELS_BAD_GRID);
    assert_eq!(w.end_voxels([0; 3], [0, 1, 1], v3(1.0, 1.0, 1.0)), VOXELS_BAD_GRID);
    assert_eq!(w.end_voxels([0; 3], [8, 8, 8], v3(1.0, 1.0, 1.0)), VOXELS_BAD_GRID, "more cells than were made room for");
    let body = w.add_body(FIXED).unwrap();
    let ball = w.add_collider(body, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap();
    assert_eq!(w.set_voxel(ball, [0; 3], true), VOXELS_NOT_VOXELS);
    assert_eq!(w.combine_voxels(ball, ball, [0; 3]), VOXELS_NOT_VOXELS);
}
