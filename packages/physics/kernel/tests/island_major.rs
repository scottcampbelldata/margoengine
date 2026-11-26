// A step solved island by island gives the bits of one solved phase by phase: islands share no body a solve changes, and the
// kinematic bodies are read at the pose of the substep an island is at. Each scene runs both ways and the state hashes are
// compared every step (the hash leaves out only the order a step solved in).
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn floor(w: &mut World) {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [60.0, 0.5, 60.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, body as usize, v3(0.0, -0.5, 0.0));
}
fn block(w: &mut World, at: V3, half: f32) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, [half; 3], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    body
}
fn ball(w: &mut World, at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BALL, [0.25, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    body
}

/// Runs `build` twice, phase by phase and island by island, and asserts the state hash is the same after every step.
fn same(steps: usize, build: impl Fn(&mut World)) {
    let (mut a, mut b) = (World::new(64, 64).unwrap(), World::new(64, 64).unwrap());
    a.island_major = false;
    b.island_major = true;
    build(&mut a);
    build(&mut b);
    for step in 0..steps {
        a.step(DT);
        b.step(DT);
        assert_eq!(a.hash(), b.hash(), "the state differs after step {step}");
    }
}

#[test]
fn separate_stacks_and_a_pile_fall_and_rest_the_same() {
    same(240, |w| {
        floor(w);
        for stack in 0..4 {
            for level in 0..4 {
                block(w, v3(stack as f32 * 4.0, 0.5 + level as f32 * 1.01, 0.0), 0.5);
            }
        }
        for i in 0..6 {
            ball(w, v3(-6.0 + (i % 3) as f32 * 0.4, 3.0 + (i / 3) as f32, 1.0));
        }
    });
}

#[test]
fn a_kinematic_platform_touching_two_islands_is_read_at_the_pose_of_each_substep() {
    // A platform that slides and turns under two stacks that sit on it, each its own island, the platform in neither: both
    // islands read it at every substep, and the state matches the phase by phase solve to the bit.
    for kind in [KINEMATIC_VELOCITY, KINEMATIC_POSITION] {
        same(180, |w| {
            floor(w);
            let platform = w.add_body(kind).unwrap();
            w.add_collider(platform, SHAPE_BOX, [4.0, 0.25, 1.0], [0.0; 3], IDENTITY, 0.0).unwrap();
            w.set_v(POSITION_X, platform as usize, v3(0.0, 0.75, 0.0));
            w.set_v(TARGET_X, platform as usize, v3(0.0, 0.75, 0.0));
            if kind == KINEMATIC_VELOCITY {
                w.set_v(LINEAR_X, platform as usize, v3(0.5, 0.0, 0.0));
                w.set_v(ANGULAR_X, platform as usize, v3(0.0, 0.2, 0.0));
            }
            for x in [-2.5f32, 2.5] {
                for level in 0..2 {
                    block(w, v3(x, 1.5 + level as f32 * 1.01, 0.0), 0.5);
                }
            }
        });
    }
}

#[test]
fn a_moving_kinematic_platform_is_followed_to_the_bit_across_the_substeps() {
    // The pose read at stage k is the pose the phase by phase step has after k substeps, for both kinematic kinds.
    for kind in [KINEMATIC_VELOCITY, KINEMATIC_POSITION] {
        let mut w = World::new(2, 2).unwrap();
        let platform = w.add_body(kind).unwrap();
        w.add_collider(platform, SHAPE_BOX, [1.0, 0.25, 1.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_v(POSITION_X, platform as usize, v3(0.0, 1.0, 0.0));
        w.set_v(TARGET_X, platform as usize, v3(0.7, 1.0, 0.1));
        w.set_q(TARGET_ROTATION_X, platform as usize, Q { x: 0.0, y: 0.3, z: 0.0, w: 0.9539392 });
        if kind == KINEMATIC_VELOCITY {
            w.set_v(LINEAR_X, platform as usize, v3(0.4, 0.0, 0.1));
            w.set_v(ANGULAR_X, platform as usize, v3(0.1, 0.5, 0.0));
        }
        w.touch_body(platform);
        let substeps = w.header().substeps;
        w.header_mut().step_dt = DT;
        w.begin_step(DT);
        let h = DT / substeps as f32;
        let at = platform as usize;
        let staged: Vec<_> = (0..=substeps)
            .map(|stage| {
                w.window.kin = Some(stage);
                (w.pose_position(at), w.pose_center(at), w.pose_rotation(at))
            })
            .collect();
        w.window.kin = None;
        let same = |a: V3, b: V3| a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits() && a.z.to_bits() == b.z.to_bits();
        for stage in 0..substeps as usize {
            let (p, c, q) = staged[stage];
            assert!(same(p, w.v(POSITION_X, at)) && same(c, w.v(CENTER_X, at)), "kind {kind}, stage {stage}");
            let r = w.q(ROTATION_X, at);
            assert_eq!([q.x.to_bits(), q.y.to_bits(), q.z.to_bits(), q.w.to_bits()], [r.x.to_bits(), r.y.to_bits(), r.z.to_bits(), r.w.to_bits()]);
            w.integrate_pose(at, h, stage as u32, substeps);
        }
        let (p, c, q) = staged[substeps as usize];
        assert!(same(p, w.v(POSITION_X, at)) && same(c, w.v(CENTER_X, at)), "kind {kind}, last stage");
        let r = w.q(ROTATION_X, at);
        assert_eq!([q.x.to_bits(), q.y.to_bits(), q.z.to_bits(), q.w.to_bits()], [r.x.to_bits(), r.y.to_bits(), r.z.to_bits(), r.w.to_bits()]);
    }
}

#[test]
fn joint_chains_and_a_hinged_kinematic_arm_solve_the_same_island_by_island() {
    use margoengine_physics_kernel::joints::*;
    // Three chains of five links hung from a fixed beam, a chain hung from a platform that sweeps, a chain on the floor under a
    // ball that drops on it, and a body hinged to nothing but the world: every kind of path the islands hold.
    same(240, |w| {
        floor(w);
        let beam = w.add_body(FIXED).unwrap();
        w.add_collider(beam, SHAPE_BOX, [20.0, 0.1, 0.1], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_v(POSITION_X, beam as usize, v3(0.0, 8.0, 0.0));
        let platform = w.add_body(KINEMATIC_VELOCITY).unwrap();
        w.add_collider(platform, SHAPE_BOX, [0.3, 0.1, 0.3], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_v(POSITION_X, platform as usize, v3(15.0, 8.0, 0.0));
        w.set_v(LINEAR_X, platform as usize, v3(-1.0, 0.0, 0.2));
        w.set_v(ANGULAR_X, platform as usize, v3(0.0, 0.3, 0.0));
        for chain in 0..4 {
            let mut above = if chain < 3 { beam } else { platform };
            let x = if chain < 3 { -6.0 + chain as f32 * 6.0 } else { 15.0 };
            for link in 0..5 {
                let body = w.add_body(DYNAMIC).unwrap();
                w.add_collider(body, SHAPE_BALL, [0.2, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
                w.set_v(POSITION_X, body as usize, v3(x + 0.1 * link as f32, 7.5 - link as f32, 0.0));
                let joint = w.add_joint(above, body, 7).unwrap();
                w.set_s(JOINT_ANCHOR_A_Y, joint as usize, if link == 0 { -0.1 } else { -0.5 });
                w.set_s(JOINT_ANCHOR_B_Y, joint as usize, 0.5);
                above = body;
            }
        }
        for i in 0..3 {
            ball(w, v3(-6.0 + i as f32 * 6.0, 14.0, 0.0));
        }
    });
}

#[test]
fn gears_and_distance_ranges_between_islands_solve_the_same_island_by_island() {
    use margoengine_physics_kernel::couplings::{DISTANCE, GEAR};
    same(120, |w| {
        floor(w);
        for island in 0..4 {
            let a = ball(w, v3(island as f32 * 6.0, 4.0, 0.0));
            let b = ball(w, v3(island as f32 * 6.0 + 1.5, 5.0, 0.0));
            w.set_v(ANGULAR_X, a as usize, v3(0.0, 0.0, 3.0));
            w.set_v(LINEAR_X, b as usize, v3(0.3, 0.0, 0.0));
            let kind = if island % 2 == 0 { DISTANCE } else { GEAR };
            let c = w.add_coupling(kind, a, b).unwrap();
            if kind == DISTANCE {
                w.set_coupling(c, 0, [0.5, 2.0, 0.0]);
            }
        }
    });
}
