// Locality: an island that steps at a finer level of substeps (tilt.rs, `island_level`) changes nothing of another island.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const DT: f32 = 1.0 / 60.0;
const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

/// A box dropped on a floor, and with `spinner` a bar far off turning 400 rad/s with its tips through a wall of its own: the box's
/// position, rotation and speeds as bits after `steps`, and the finest level the bar's island stepped at.
fn the_box(spinner: bool, steps: usize) -> (Vec<u32>, u32) {
    let mut w = World::new(8, 8).unwrap();
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [4.0, 0.5, 4.0], [0.0; 3], ID, 0.0).unwrap();
    w.set_pose(floor, v3(0.0, -0.5, 0.0), Q::IDENTITY, false);
    let held = w.add_body(DYNAMIC).unwrap();
    w.add_collider(held, SHAPE_BOX, [0.3, 0.3, 0.3], [0.0; 3], ID, 1.0).unwrap();
    w.set_pose(held, v3(0.0, 1.0, 0.0), Q { x: 0.12, y: 0.0, z: 0.16, w: 0.979_795_9 }, false);
    w.set_u(FLAGS, held as usize, w.flags(held as usize) & !CAN_SLEEP);
    let mut bar = None;
    if spinner {
        let wall = w.add_body(FIXED).unwrap();
        w.add_collider(wall, SHAPE_BOX, [0.01, 2.0, 2.0], [0.0; 3], ID, 0.0).unwrap();
        w.set_pose(wall, v3(40.9, 10.0, 0.0), Q::IDENTITY, false);
        let b = w.add_body(DYNAMIC).unwrap();
        w.add_collider(b, SHAPE_BOX, [1.0, 0.02, 0.02], [0.0; 3], ID, 1000.0).unwrap();
        w.set_pose(b, v3(40.0, 10.0, 0.0), Q::IDENTITY, false);
        w.set_u(FLAGS, b as usize, w.flags(b as usize) & !CAN_SLEEP);
        w.set_s(GRAVITY_SCALE, b as usize, 0.0);
        w.set_v(ANGULAR_X, b as usize, v3(0.0, 0.0, 400.0));
        bar = Some(b);
    }
    let mut finest = 0;
    for _ in 0..steps {
        w.step(DT);
        if let Some(b) = bar {
            finest = finest.max(w.uu(SUBSTEP_LEVEL, b as usize));
        }
    }
    let at = held as usize;
    let (p, q, v, a) = (w.v(POSITION_X, at), w.q(ROTATION_X, at), w.v(LINEAR_X, at), w.v(ANGULAR_X, at));
    let bits = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, a.x, a.y, a.z].iter().map(|f| f.to_bits()).collect();
    (bits, finest)
}

#[test]
fn an_island_on_a_finer_level_leaves_the_others_as_they_were() {
    // The bar turns 6.7 rad a step, so its island steps at a finer level than the world's; the box lands, tips and settles on the
    // world's own substeps, to the bit, whether the bar is there or not.
    let (alone, _) = the_box(false, 240);
    let (beside, finest) = the_box(true, 240);
    assert!(finest > 0, "the bar's island never left the world's substeps");
    assert_eq!(alone, beside, "the box moved differently beside an island on level {finest}");
}
