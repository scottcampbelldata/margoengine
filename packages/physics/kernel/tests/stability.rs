// Scenes the joints must survive. Nothing here asks for a good answer to a bad scene, only for one that stays in the numbers:
// finite, and no faster than the scene's own motion carries a body. Each test failed before the fix it is named for.
use margoengine_physics_kernel::integrate::RANGE;
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const DT: f32 = 1.0 / 60.0;
const LINEAR: u32 = JOINT_LOCK * 7;
const TURNS: u32 = JOINT_LOCK * (7 << 3);
const HINGE: u32 = LINEAR | JOINT_LOCK * (6 << 3);
const SLIDER: u32 = JOINT_LOCK * 6 | TURNS;

fn point(w: &mut World, at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    let row = body as usize;
    w.set_s(INVERSE_MASS, row, 1.0);
    w.set_v(INERTIA_X, row, v3(0.4, 0.4, 0.4));
    w.set_v(INVERSE_INERTIA_X, row, v3(2.5, 2.5, 2.5));
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, row, w.flags(row) & !CAN_SLEEP);
    body
}
fn joint(w: &mut World, a: u32, b: u32, flags: u32, on_a: V3, on_b: V3) -> u32 {
    let joint = w.add_joint(a, b, flags).unwrap();
    w.set_v(JOINT_ANCHOR_A_X, joint as usize, on_a);
    w.set_v(JOINT_ANCHOR_B_X, joint as usize, on_b);
    joint
}
fn speed(w: &World, body: u32) -> f32 {
    let v = w.v(LINEAR_X, body as usize);
    sqrt(v.dot(v))
}
fn no_gravity(w: &mut World) {
    w.header_mut().gravity = [0.0, 0.0, 0.0];
}

#[test]
fn a_body_held_by_more_locks_than_it_has_freedoms_stays_put() {
    // Ten lock rows on six freedoms, one end still and one spinning. The rows depend on each other, and what a chain of
    // eliminations leaves of the second joint's block is rounding: it used to be inverted, for 18,904,462 m/s.
    let mut w = World::new(4, 4).unwrap();
    no_gravity(&mut w);
    let wall = w.add_body(FIXED).unwrap();
    let spinner = w.add_body(KINEMATIC_VELOCITY).unwrap();
    w.set_pose(spinner, v3(3.0, 1.0, 0.0), Q::IDENTITY, false);
    w.set_v(ANGULAR_X, spinner as usize, v3(1.0, 2.0, 3.0));
    let held = point(&mut w, v3(1.0, 0.0, 0.0));
    joint(&mut w, wall, held, SLIDER, v3(0.3, -0.2, 0.1), v3(-0.5, 0.25, 0.0));
    joint(&mut w, held, spinner, SLIDER, v3(0.4, 0.7, -0.2), v3(0.1, 0.0, 0.6));
    let mut top = 0.0f32;
    for _ in 0..600 {
        w.step(DT);
        top = top.max(speed(&w, held));
    }
    println!("held twice: top speed {top:.3} m/s");
    assert!(top < 20.0, "reached {top} m/s");
}

#[test]
fn a_body_on_a_spinning_hub_keeps_its_radius() {
    // A push capped at a fixed speed lost to the error the turning rows open each substep, r (h w)^2 / 2, so from 8 rad/s at 100 m
    // the gap and the speed grew exponentially, on one joint with nothing else in the scene.
    for (substeps, spin, radius) in [(8u32, 8.0f32, 100.0f32), (1, 8.0, 30.0), (8, 77.0, 10.0)] {
        for flags in [LINEAR, LINEAR | TURNS] {
            let mut w = World::new(4, 4).unwrap();
            no_gravity(&mut w);
            w.header_mut().substeps = substeps;
            let hub = w.add_body(KINEMATIC_VELOCITY).unwrap();
            w.set_v(ANGULAR_X, hub as usize, v3(0.0, spin, 0.0));
            let body = point(&mut w, v3(radius, 0.0, 0.0));
            w.set_v(LINEAR_X, body as usize, v3(0.0, 0.0, -spin * radius));
            w.set_v(ANGULAR_X, body as usize, v3(0.0, spin, 0.0));
            joint(&mut w, hub, body, flags, v3(radius, 0.0, 0.0), v3(0.0, 0.0, 0.0));
            let mut far = 0.0f32;
            for _ in 0..1200 {
                w.step(DT);
                let p = w.v(POSITION_X, body as usize);
                far = far.max(sqrt(p.dot(p)));
            }
            println!("{substeps} substeps, {spin} rad/s at {radius} m: as far as {far:.3} m");
            // One substep's chord: r (sec(h w) - 1) with h w = 0.13, and a little.
            assert!(far < radius * 1.02, "drifted to {far} m");
        }
    }
}

#[test]
fn a_taut_chain_between_two_walls_stays_calm() {
    // Links pulled straight and a centimetre too short: at that pose K is singular (Baraff 1996, footnote 5), and just off it
    // the exact solve asks speeds of one over the angle. A push used to reach 27,000 m/s on a chain nothing moves.
    for links in [2usize, 3, 6] {
        for sag in [0.0f32, 1e-4, 0.01] {
            let mut w = World::new(16, 16).unwrap();
            let left = w.add_body(FIXED).unwrap();
            let right = w.add_body(FIXED).unwrap();
            w.set_pose(right, v3(2.0 * links as f32 + 0.01, 0.0, 0.0), Q::IDENTITY, false);
            let (end, near) = (v3(1.0, 0.0, 0.0), v3(-1.0, 0.0, 0.0));
            let (mut last, mut on_last) = (left, v3(0.0, 0.0, 0.0));
            let mut bodies = Vec::new();
            for i in 0..links {
                let middle = (i as f32 + 0.5) / links as f32 * 2.0 - 1.0;
                let body = point(&mut w, v3(2.0 * i as f32 + 1.0, sag * (1.0 - middle.max(-middle)), 0.0));
                joint(&mut w, last, body, LINEAR, on_last, near);
                (last, on_last) = (body, end);
                bodies.push(body);
            }
            joint(&mut w, last, right, LINEAR, on_last, v3(0.0, 0.0, 0.0));
            let mut top = 0.0f32;
            for _ in 0..1200 {
                w.step(DT);
                for &body in &bodies {
                    top = top.max(speed(&w, body));
                }
            }
            println!("{links} links, sag {sag}: top speed {top:.3} m/s");
            assert!(top < 20.0, "reached {top} m/s");
        }
    }
}

#[test]
fn a_small_gap_closes_in_one_push() {
    // Nothing is near a singular pose here, so nothing may cut the push: a bound in speed alone cut this one to .58 of the gap,
    // as a gap across three rows is longer than any one row's ask, and did so on every substep of a plain pendulum.
    let mut w = World::new(4, 4).unwrap();
    no_gravity(&mut w);
    w.header_mut().substeps = 1;
    let wall = w.add_body(FIXED).unwrap();
    let body = point(&mut w, v3(0.5, 0.0, 0.0));
    let gap = 1e-3;
    joint(&mut w, wall, body, LINEAR, v3(gap, gap, gap), v3(-0.5, 0.0, 0.0));
    w.step(DT);
    let p = w.v(POSITION_X, body as usize);
    let turned = w.q(ROTATION_X, body as usize).rotate(v3(-0.5, 0.0, 0.0));
    let open = p.add(turned).sub(v3(gap, gap, gap));
    let left = sqrt(open.dot(open));
    println!("gap left after a push: {left:.8} m of {:.8} m", gap * 1.7320508);
    assert!(left < gap * 0.01, "left {left} m");
}

#[test]
fn a_stretched_joint_does_not_jump_a_body_past_a_wall() {
    // Pairs are found once a step, so a push that closes six metres in a substep lands past a wall nothing told it about. Capped,
    // the wall gets its say. It does not get the last word: a lock is exact and a contact is a capped spring, so a joint stretched
    // through a wall drags its body through at about 1.5 m/s (docs/limits.md).
    let mut w = World::new(8, 8).unwrap();
    no_gravity(&mut w);
    let wall = w.add_body(FIXED).unwrap();
    w.add_collider(wall, SHAPE_BOX, [1.0, 2.0, 2.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], 0.0).unwrap();
    let anchor = w.add_body(FIXED).unwrap();
    w.set_pose(anchor, v3(4.0, 0.0, 0.0), Q::IDENTITY, false);
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, [0.25, 0.25, 0.25], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], 1.0).unwrap();
    w.set_pose(body, v3(-2.0, 0.0, 0.0), Q::IDENTITY, false);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    joint(&mut w, anchor, body, LINEAR, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0));
    for _ in 0..30 {
        w.step(DT);
    }
    let x = w.v(POSITION_X, body as usize).x;
    println!("pulled at a wall: at x = {x:.4} after half a second");
    assert!(x < -0.5, "reached {x}");
}

/// A random web of every kind of joint, as the replay scene makes: the fastest any body went in `steps` and the fastest any
/// spun, each not a number once a value stopped being one.
fn web(seed: u32, steps: u32) -> (f32, f32) {
    let mut state = seed;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    let mut w = World::new(64, 64).unwrap();
    let mut rows = Vec::new();
    for _ in 0..48 {
        let kind = [DYNAMIC, DYNAMIC, DYNAMIC, DYNAMIC, DYNAMIC, FIXED, KINEMATIC_POSITION, KINEMATIC_VELOCITY][(next() % 8) as usize];
        let body = w.add_body(kind).unwrap();
        let size = 0.25 + (next() % 8) as f32 / 8.0;
        let density = if kind == DYNAMIC { (1 + next() % 8) as f32 } else { 0.0 };
        w.add_collider(body, SHAPE_BOX, [size, size, size], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], density).unwrap();
        let mut value = || ((next() % 2049) as i32 - 1024) as f32 / 256.0;
        let at = v3(value() * 2.0, value() * 2.0, value() * 2.0);
        w.set_v(POSITION_X, body as usize, at);
        w.set_v(TARGET_X, body as usize, at);
        if kind != FIXED && kind != KINEMATIC_POSITION {
            let (x, y, z) = (value(), value(), value());
            w.set_v(LINEAR_X, body as usize, v3(x, y, z));
            w.set_v(ANGULAR_X, body as usize, v3(x * 2.0, y * 2.0, z * 2.0));
        }
        w.touch_body(body);
        rows.push(body);
    }
    for i in 0..24usize {
        let a = rows[(next() % 48) as usize];
        let b = rows[(next() % 48) as usize];
        if a == b {
            continue;
        }
        let flags = [LINEAR, HINGE, JOINT_LOCK * 6 | TURNS, LINEAR | TURNS][i % 4];
        let flags = if i % 4 == 1 { flags | JOINT_LIMIT << 3 } else { flags };
        let on_a = v3(((next() % 2049) as i32 - 1024) as f32 / 1024.0, ((next() % 2049) as i32 - 1024) as f32 / 1024.0, 0.0);
        let row = joint(&mut w, a, b, flags, on_a, v3(0.0, 0.0, 0.0)) as usize;
        if i % 4 == 1 {
            w.set_s(JOINT_MIN_3, row, -1.0);
            w.set_s(JOINT_MAX_3, row, 1.0);
        }
    }
    w.header_mut().substeps = 1;
    let (mut top, mut spin) = (0.0f32, 0.0f32);
    for i in 0..steps {
        for &row in &rows {
            let at = row as usize;
            let p = w.v(POSITION_X, at);
            let out = |x: f32| x > 16.0 || x < -16.0;
            if out(p.x) || out(p.y) || out(p.z) {
                w.set_v(POSITION_X, at, v3(p.x / 4.0, p.y / 4.0, p.z / 4.0));
                w.set_v(LINEAR_X, at, v3(0.0, 0.0, 0.0));
                w.touch_body(row);
            }
            if w.flags(at) & KIND == KINEMATIC_POSITION {
                let p = w.v(POSITION_X, at);
                w.set_v(TARGET_X, at, v3(p.x + 0.0625, p.y, p.z));
                let turning = i % 64 < 32;
                w.set_s(TARGET_ROTATION_Y, at, if turning { 0.6 } else { 0.0 });
                w.set_s(TARGET_ROTATION_W, at, if turning { 0.8 } else { 1.0 });
            }
        }
        w.step(DT);
        for &row in &rows {
            let s = speed(&w, row);
            if !(s <= top) {
                top = s;
            }
            let o = w.v(ANGULAR_X, row as usize);
            let o = sqrt(o.dot(o));
            if !(o <= spin) {
                spin = o;
            }
        }
    }
    (top, spin)
}

#[test]
fn a_web_of_joints_stays_in_the_numbers() {
    // Joints between bodies metres apart, with fixed ends, spinning ends and closed loops, none of it satisfiable. A body fixed
    // to a kinematic turn of 1.29 rad a step at 30 m has a true speed of 2,300 m/s. What the joints remembered used to run
    // this to not a number on most seeds.
    let mut worst = 0.0f32;
    for seed in 1..=60 {
        let (top, _) = web(seed, 2000);
        assert!(top < 1e5, "seed {seed} reached {top} m/s");
        worst = worst.max(top);
    }
    println!("fastest in the webs: {worst:.0} m/s");
}

#[test]
fn a_cut_push_still_takes_back_the_speed_along_the_locks() {
    // Seed 45, step 1986: a hinge's limit stops a turn about an anchor 24 m off, which only the locks can carry, so it gives
    // its body 7,500 rad/s that the path solve after it takes back. The pushing pass cut its whole path solve to nothing, that
    // taking back included, and handed a neighbour 457,390 rad/s; contacts passed it on and a body landed 1,100 m from its
    // joints. The scene's own motion, a kinematic turn of 77 rad/s at up to 30 m, carries an anchor at 2,300 m/s, which
    // turns an arm of 0.125 m at no more than about 18,400 rad/s. Before the fix the web reached 162,278 rad/s.
    let (top, spin) = web(45, 2000);
    println!("web 45: fastest {top:.0} m/s, top spin {spin:.0} rad/s");
    assert!(spin < 18_400.0, "a body spun at {spin} rad/s");
}

#[test]
fn a_bead_on_a_spinning_rail_is_refused_before_it_leaves_the_numbers() {
    // r'' = w^2 r on a frictionless rail: the true path is exponential, so it does reach the end of f32. That is the scene, not
    // the solver, and no answer is right, so the world says so: the last state is a true one and the next step does nothing.
    let mut w = World::new(4, 4).unwrap();
    no_gravity(&mut w);
    let hub = w.add_body(KINEMATIC_VELOCITY).unwrap();
    w.set_v(ANGULAR_X, hub as usize, v3(0.0, 8.0, 0.0));
    let bead = point(&mut w, v3(0.0, 0.0, 0.0));
    w.set_v(ANGULAR_X, bead as usize, v3(0.0, 8.0, 0.0));
    joint(&mut w, hub, bead, SLIDER, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0));
    w.set_v(POSITION_X, bead as usize, v3(1.0, 0.0, 0.0));
    let mut steps = 0;
    while w.header().lost == NONE {
        w.step(DT);
        steps += 1;
        assert!(steps < 5000, "the bead never left");
        let p = w.v(POSITION_X, bead as usize);
        assert!(p.x == p.x && p.y == p.y && p.z == p.z, "a position stopped being a number");
    }
    assert_eq!(w.header().lost, bead);
    println!("left the range after {steps} steps");
    let (p, taken) = (w.v(POSITION_X, bead as usize), w.header().steps);
    assert!(p.dot(p) < RANGE * RANGE * 4.0);
    w.step(DT);
    assert_eq!(w.header().steps, taken, "a step ran after the refusal");
}
