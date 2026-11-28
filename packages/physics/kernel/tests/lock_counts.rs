//! Work counts of the lock projection (feature `counts`, native only), one test in its own binary so no other test's joints
//! add to the counts.
#![cfg(feature = "counts")]
use margoengine_physics_kernel::joints::LOCK_STEPS;
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;
use std::sync::atomic::Ordering::Relaxed;

const DT: f32 = 1.0 / 60.0;

fn point(w: &mut World, at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    let row = body as usize;
    w.set_s(INVERSE_MASS, row, 1.0);
    w.set_v(INERTIA_X, row, v3(0.1, 0.1, 0.1));
    w.set_v(INVERSE_INERTIA_X, row, v3(10.0, 10.0, 10.0));
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, row, w.flags(row) & !CAN_SLEEP);
    body
}

fn spherical(w: &mut World, a: u32, b: u32, on_a: V3, on_b: V3) -> u32 {
    let joint = w.add_joint(a, b, JOINT_LOCK * 7).unwrap();
    w.set_v(JOINT_ANCHOR_A_X, joint as usize, on_a);
    w.set_v(JOINT_ANCHOR_B_X, joint as usize, on_b);
    joint
}

/// The projection's iterates and path steps over `steps` steps of a world.
fn counted(w: &mut World, steps: usize) -> (u64, u64) {
    let before = [LOCK_STEPS[0].load(Relaxed), LOCK_STEPS[1].load(Relaxed)];
    for _ in 0..steps {
        w.step(DT);
    }
    (LOCK_STEPS[0].load(Relaxed) - before[0], LOCK_STEPS[1].load(Relaxed) - before[1])
}

#[test]
fn a_grid_s_loops_take_no_projection_iterate_and_a_chain_takes_a_few() {
    // KB-PHYS-LOCKGRIDSLOW1: a grid's joints are in loops, so its paths are loose and close their share of a gap a pass, as
    // before the end-pose projection. Projected, the share they took an iterate never read closed: a 30 by 30 grid ran all 24
    // iterates of both stages every substep, about 400 iterates (each a refresh of every joint) and 150,000 path steps a step,
    // 58 times slower. A grid of 12 by 12 hung from a bar: no iterate at all.
    let mut w = World::new(256, 512).unwrap();
    let top = w.add_body(FIXED).unwrap();
    let size = 12;
    let mut bodies = vec![];
    for y in 0..size {
        for x in 0..size {
            let body = point(&mut w, v3(x as f32, -(y as f32), 0.0));
            bodies.push(body);
            if y == 0 {
                spherical(&mut w, top, body, v3(x as f32, 0.0, 0.0), v3(0.0, 0.0, 0.0));
            } else {
                spherical(&mut w, bodies[((y - 1) * size + x) as usize], body, v3(0.0, -0.5, 0.0), v3(0.0, 0.5, 0.0));
            }
            if x > 0 {
                spherical(&mut w, bodies[(y * size + x - 1) as usize], body, v3(0.5, 0.0, 0.0), v3(-0.5, 0.0, 0.0));
            }
        }
    }
    let (iterates, paths) = counted(&mut w, 30);
    assert!(iterates == 0 && paths == 0, "a grid took {iterates} projection iterates and {paths} path steps in 30 steps");
    // A chain of 10 hinged balls swinging from a pivot is one exact path: it is projected, a few iterates a stage.
    let mut w = World::new(16, 16).unwrap();
    let pivot = w.add_body(FIXED).unwrap();
    let mut above = pivot;
    for i in 0..10 {
        let body = point(&mut w, v3(0.1 * (i + 1) as f32, 0.0, 0.0));
        let on_a = if above == pivot { v3(0.0, 0.0, 0.0) } else { v3(0.05, 0.0, 0.0) };
        spherical(&mut w, above, body, on_a, v3(-0.05, 0.0, 0.0));
        above = body;
    }
    let (iterates, paths) = counted(&mut w, 30);
    let stages = 30 * 2 * 8;
    assert!(iterates > 0 && paths == iterates, "a chain took {iterates} iterates and {paths} path steps");
    assert!(iterates <= 4 * stages, "a chain took {iterates} iterates in {stages} stages");
    println!("chain: {iterates} iterates in {stages} stages");
}
