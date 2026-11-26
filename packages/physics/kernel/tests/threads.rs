// Islands solved on threads give the bits of one thread (docs/physics-framework.md, section 7, rule 7): a step is
// `step_begin`, then `solve_island` for each island on any thread's view of the world, then `step_end`. Each scene runs one
// thread at a time (`World::step`) and with its islands split over 1, 2, 4 and 8 threads, and the state hashes are compared
// after every step.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

/// The world, shared by the threads of one step: each makes a view of its own (`thread_view`) and solves only its islands.
struct Shared(*const World);
unsafe impl Sync for Shared {}
unsafe impl Send for Shared {}

/// One step with the islands split over `threads` threads in fixed runs of island numbers, the same runs whatever thread
/// takes them first.
fn step_on(w: &mut World, threads: usize) {
    let Some(times) = w.step_begin(DT) else { return };
    let islands = w.header().islands as usize;
    if w.island_major && islands > 0 {
        let run = islands.div_ceil(threads);
        let shared = Shared(w as *const World);
        std::thread::scope(|scope| {
            for t in 0..threads {
                let shared = &shared;
                scope.spawn(move || {
                    // SAFETY: the world does nothing else while the islands solve, and islands share no row a solve writes.
                    let mut view = unsafe { &*shared.0 }.thread_view();
                    for group in (t * run)..((t + 1) * run).min(islands) {
                        view.solve_island(group, DT);
                    }
                });
            }
        });
    }
    w.step_end(DT, times);
}

fn floor(w: &mut World) {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [60.0, 0.5, 60.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, body as usize, v3(0.0, -0.5, 0.0));
}
fn dynamic(w: &mut World, shape: u32, size: [f32; 3], at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, shape, size, [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    body
}

/// Stacks, a pile of balls, joint chains hung from a beam and from a sweeping kinematic platform, a kinematic platform under
/// two stacks, and spinning blocks: many islands of every kind, waking, sleeping and meeting.
fn scene(w: &mut World) {
    floor(w);
    for stack in 0..6 {
        for level in 0..5 {
            dynamic(w, SHAPE_BOX, [0.5; 3], v3(stack as f32 * 3.0 - 8.0, 0.5 + level as f32 * 1.01, -6.0));
        }
    }
    for i in 0..24 {
        dynamic(w, SHAPE_BALL, [0.25, 0.0, 0.0], v3(-4.0 + (i % 6) as f32 * 0.6, 3.0 + (i / 6) as f32 * 0.6, 4.0));
    }
    let beam = w.add_body(FIXED).unwrap();
    w.add_collider(beam, SHAPE_BOX, [20.0, 0.1, 0.1], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, beam as usize, v3(0.0, 9.0, 8.0));
    let sweeper = w.add_body(KINEMATIC_VELOCITY).unwrap();
    w.add_collider(sweeper, SHAPE_BOX, [0.3, 0.1, 0.3], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, sweeper as usize, v3(15.0, 9.0, 8.0));
    w.set_v(LINEAR_X, sweeper as usize, v3(-1.0, 0.0, 0.2));
    w.set_v(ANGULAR_X, sweeper as usize, v3(0.0, 0.3, 0.0));
    for chain in 0..5 {
        let mut above = if chain < 4 { beam } else { sweeper };
        let x = if chain < 4 { -9.0 + chain as f32 * 6.0 } else { 15.0 };
        for link in 0..5 {
            let body = dynamic(w, SHAPE_BALL, [0.2, 0.0, 0.0], v3(x + 0.1 * link as f32, 8.5 - link as f32, 8.0));
            let joint = w.add_joint(above, body, 7).unwrap();
            w.set_s(JOINT_ANCHOR_A_Y, joint as usize, if link == 0 { -0.1 } else { -0.5 });
            w.set_s(JOINT_ANCHOR_B_Y, joint as usize, 0.5);
            above = body;
        }
    }
    let lift = w.add_body(KINEMATIC_POSITION).unwrap();
    w.add_collider(lift, SHAPE_BOX, [3.0, 0.25, 1.5], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, lift as usize, v3(10.0, 0.25, 0.0));
    w.set_v(TARGET_X, lift as usize, v3(10.4, 0.6, 0.0));
    for stack in 0..2 {
        for level in 0..3 {
            dynamic(w, SHAPE_BOX, [0.4; 3], v3(8.5 + stack as f32 * 2.5, 0.9 + level as f32 * 0.81, 0.0));
        }
    }
    // A kinematic body on a smooth path (SMOOTH_PATH) under a stack: its chords are read at each island's stages.
    let smooth = w.add_body(KINEMATIC_POSITION).unwrap();
    w.add_collider(smooth, SHAPE_BOX, [1.5, 0.25, 1.5], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, smooth as usize, v3(-14.0, 0.25, 6.0));
    w.set_v(TARGET_X, smooth as usize, v3(-13.6, 0.5, 6.0));
    w.set_v(TARGET_LINEAR_X, smooth as usize, v3(3.0, 0.0, 0.5));
    w.set_u(FLAGS, smooth as usize, w.flags(smooth as usize) | SMOOTH_PATH);
    for level in 0..3 {
        dynamic(w, SHAPE_BOX, [0.4; 3], v3(-14.0, 0.9 + level as f32 * 0.81, 6.0));
    }
    for i in 0..6 {
        let spinner = dynamic(w, SHAPE_BOX, [0.3, 0.2, 0.4], v3(-10.0 + i as f32 * 1.5, 2.0, 0.0));
        w.set_v(ANGULAR_X, spinner as usize, v3(3.0 * i as f32, 20.0, 1.0));
    }
}

#[test]
fn islands_on_one_two_four_and_eight_threads_give_the_bits_of_one() {
    let mut serial = World::new(256, 256).unwrap();
    scene(&mut serial);
    let mut worlds: Vec<(usize, World)> = [1usize, 2, 4, 8]
        .into_iter()
        .map(|threads| {
            let mut w = World::new(256, 256).unwrap();
            scene(&mut w);
            (threads, w)
        })
        .collect();
    let mut most = 0;
    for step in 0..300 {
        serial.step(DT);
        most = most.max(serial.header().islands);
        for (threads, w) in worlds.iter_mut() {
            step_on(w, *threads);
            assert_eq!(w.hash(), serial.hash(), "{threads} threads: the state differs after step {step}");
        }
    }
    // The proof means something only if the steps had islands to share out.
    assert!(most >= 8, "at most {most} islands in a step");
    println!("up to {most} islands a step");
}
