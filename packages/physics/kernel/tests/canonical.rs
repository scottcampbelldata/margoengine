// What a step does follows the world, not the order its lists were filled in: the awake list is put in body order and the
// active pairs in the order of their colliders and parts at the start of every step and again after the island build's
// wake-ups, so islands are numbered by their lowest body and solved in row and collider order. Two worlds with the same rows
// whose bodies woke in different orders step to the same bits, and so does a third restored from a snapshot of one mid-run.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn dynamic(w: &mut World, shape: u32, size: [f32; 3], at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, shape, size, [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    body
}

/// Stacks, a pile of balls, a chain from a beam and spinning blocks, with the same rows every time.
fn scene() -> World {
    let mut w = World::new(256, 256).unwrap();
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [60.0, 0.5, 60.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, floor as usize, v3(0.0, -0.5, 0.0));
    for stack in 0..5 {
        for level in 0..5 {
            dynamic(&mut w, SHAPE_BOX, [0.5; 3], v3(stack as f32 * 1.6 - 4.0, 0.5 + level as f32 * 1.01, 0.0));
        }
    }
    for i in 0..30 {
        dynamic(&mut w, SHAPE_BALL, [0.25, 0.0, 0.0], v3(-3.0 + (i % 6) as f32 * 0.55, 3.0 + (i / 6) as f32 * 0.55, 3.0));
    }
    let beam = w.add_body(FIXED).unwrap();
    w.add_collider(beam, SHAPE_BOX, [5.0, 0.1, 0.1], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, beam as usize, v3(0.0, 7.0, -3.0));
    let mut above = beam;
    for link in 0..6 {
        let body = dynamic(&mut w, SHAPE_BALL, [0.2, 0.0, 0.0], v3(0.1 * link as f32, 6.5 - link as f32, -3.0));
        let joint = w.add_joint(above, body, 7).unwrap();
        w.set_s(JOINT_ANCHOR_A_Y, joint as usize, if link == 0 { -0.1 } else { -0.5 });
        w.set_s(JOINT_ANCHOR_B_Y, joint as usize, 0.5);
        above = body;
    }
    for i in 0..6 {
        let spinner = dynamic(&mut w, SHAPE_BOX, [0.3, 0.2, 0.4], v3(-6.0 + i as f32 * 1.2, 1.5, -6.0));
        w.set_v(ANGULAR_X, spinner as usize, v3(3.0 * i as f32, 15.0, 1.0));
    }
    w
}

/// Every body's pose and speeds, as bits.
fn bodies(w: &World) -> Vec<u32> {
    let mut out = Vec::new();
    for row in 0..w.header().rows as usize {
        for v in [w.v(POSITION_X, row), w.v(LINEAR_X, row), w.v(ANGULAR_X, row)] {
            out.extend([v.x.to_bits(), v.y.to_bits(), v.z.to_bits()]);
        }
        let q = w.q(ROTATION_X, row);
        out.extend([q.x.to_bits(), q.y.to_bits(), q.z.to_bits(), q.w.to_bits()]);
    }
    out
}

/// The awake list taken apart and put back in an order shuffled by `seed`, as if the bodies had woken in that order.
fn shuffle_awake(w: &mut World, seed: u32) {
    let mut list: Vec<u32> = (0..w.header().awake as usize).map(|i| w.uu(AWAKE, i)).collect();
    let mut state = seed;
    for i in (1..list.len()).rev() {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        list.swap(i, state as usize % (i + 1));
    }
    for &body in &list {
        w.unlist_awake(body);
    }
    for &body in &list {
        w.list_awake(body);
    }
}

#[test]
fn bodies_woken_in_any_order_and_a_restored_snapshot_step_to_the_same_bits_for_600_steps() {
    let mut first = scene();
    let mut others: Vec<World> = [0x9E37_79B9u32, 0x85EB_CA6B, 0xC2B2_AE35].into_iter().map(|seed| {
        let mut w = scene();
        shuffle_awake(&mut w, seed);
        w
    }).collect();
    let mut restored: Option<World> = None;
    for step in 0..600 {
        first.step(DT);
        for (k, w) in others.iter_mut().enumerate() {
            // Wake orders keep changing: a shuffle every 50 steps.
            if step % 50 == 25 {
                shuffle_awake(w, 0x2545_F491 ^ (step as u32 * 7 + k as u32));
            }
            w.step(DT);
            assert!(bodies(w) == bodies(&first), "wake order {k}: the bodies differ after step {step}");
        }
        if step == 300 {
            // A snapshot is the world's block: copied into a world of the same rows, it steps on alike.
            let bytes = first.header().bytes as usize;
            let mut copy = World::new(256, 256).unwrap();
            assert!(copy.arena.ensure(bytes));
            unsafe { core::ptr::copy_nonoverlapping(first.arena.base, copy.arena.base, bytes) };
            restored = Some(copy);
        }
        if let Some(copy) = restored.as_mut().filter(|_| step > 300) {
            copy.step(DT);
            assert!(bodies(copy) == bodies(&first), "restored: the bodies differ after step {step}");
            assert_eq!(copy.hash(), first.hash(), "restored: the state differs after step {step}");
        }
    }
}
