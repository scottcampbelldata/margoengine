// Contact forces against what mechanics says, on the world's defaults: 8 substeps, 2 passes, 60 Hz steps.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;
const G: f64 = 9.81;

fn world(bodies: u32) -> World {
    World::new(bodies, bodies).unwrap()
}
fn floor(w: &mut World) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [50.0, 0.5, 50.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, body as usize, v3(0.0, -0.5, 0.0));
    body
}
fn block(w: &mut World, half: [f32; 3], at: V3, density: f32) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, half, [0.0; 3], IDENTITY, density).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    body
}
/// The normal impulse between two bodies in the last step.
fn force(w: &World, a: u32, b: u32) -> f64 {
    let mut sum = 0.0;
    for i in 0..w.header().solving as usize {
        let row = w.uu(SOLVE_PAIRS, i);
        let (one, other) = w.pair_bodies(row);
        if (one, other) == (a as usize, b as usize) || (one, other) == (b as usize, a as usize) {
            sum += w.s(PAIR_FORCE, row as usize) as f64;
        }
    }
    sum
}

#[test]
fn a_resting_stack_presses_with_the_weight_above_each_contact() {
    let mut w = world(4);
    let ground = floor(&mut w);
    let (lower, upper) = (block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 2.0), block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 1.5, 0.0), 1.0));
    for _ in 0..120 {
        w.step(DT);
    }
    // A cubic metre each: the upper block is 1 kg, the lower 2 kg.
    let (over, under) = (force(&w, lower, upper) / DT as f64, force(&w, ground, lower) / DT as f64);
    println!("stack forces: {over:.4} and {under:.4} N of {:.4} and {:.4}", G, 3.0 * G);
    assert!((over / G - 1.0).abs() < 1e-3, "{over}");
    assert!((under / (3.0 * G) - 1.0).abs() < 1e-3, "{under}");
}

#[test]
fn a_landing_gives_the_impulse_that_stops_it() {
    // A block dropped onto the floor with no bounce. Momentum: every impulse the floor gives adds to what gravity takes, so
    // from the drop to rest the floor's impulses add up to m g t.
    let mut w = world(4);
    let ground = floor(&mut w);
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 2.5, 0.0), 1.0);
    let (mut sum, mut peak) = (0.0f64, 0.0f64);
    let steps = 120;
    for _ in 0..steps {
        w.step(DT);
        let impulse = force(&w, ground, body);
        sum += impulse;
        peak = peak.max(impulse);
    }
    let want = G * steps as f64 * DT as f64;
    let speed = w.v(LINEAR_X, body as usize).y as f64;
    println!("landing: impulses add to {sum:.5} of {want:.5}, largest {peak:.4}, speed left {speed:.6}");
    assert!((sum / want - 1.0).abs() < 1e-3, "{sum} against {want}");
    // The speed at the floor is sqrt(2 g 2), 6.26 m/s; the first step of contact stops most of it.
    assert!(peak > 5.0, "{peak}");
}

#[test]
fn a_pair_without_contact_gives_nothing() {
    let mut w = world(4);
    let ground = floor(&mut w);
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 5.0, 0.0), 1.0);
    w.step(DT);
    assert_eq!(force(&w, ground, body), 0.0);
}
