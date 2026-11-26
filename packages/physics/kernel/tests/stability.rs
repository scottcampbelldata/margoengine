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
/// A dynamic body's energy: its motion and its height in the world's gravity.
fn energy(w: &World, body: usize) -> f64 {
    if w.flags(body) & KIND != DYNAMIC {
        return 0.0;
    }
    let mass = 1.0 / w.s(INVERSE_MASS, body) as f64;
    let (v, spin) = (w.v(LINEAR_X, body), w.v(ANGULAR_X, body));
    let local = w.q(ROTATION_X, body).mul(w.q(INERTIA_FRAME_X, body)).conjugate().rotate(spin);
    let turning = w.s(INERTIA_X, body) as f64 * (local.x as f64).powi(2)
        + w.s(INERTIA_Y, body) as f64 * (local.y as f64).powi(2)
        + w.s(INERTIA_Z, body) as f64 * (local.z as f64).powi(2);
    let g = w.header().gravity;
    let p = w.v(POSITION_X, body);
    let height = -(g[0] as f64 * p.x as f64 + g[1] as f64 * p.y as f64 + g[2] as f64 * p.z as f64) * w.s(GRAVITY_SCALE, body) as f64;
    0.5 * mass * v.dot(v) as f64 + 0.5 * turning + mass * height
}
/// What kinematic bodies have done on the bodies they are solved against, in joules, over this thread's steps.
fn driven() -> f64 {
    margoengine_physics_kernel::solver::DRIVEN.with(|d| d.get())
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

/// A random web of every kind of joint, as the replay scene makes: the fastest any body went in `steps`, the fastest any
/// spun and the widest any joint stood open after a step, across its slide for a slider, each not a number once a value
/// stopped being one.
fn web(seed: u32, steps: u32) -> (f32, f32, f32) {
    let run = web_run(seed, steps, 1, None);
    (run.top, run.spin, run.open)
}

/// What one run of `web_run` saw.
struct Web {
    top: f32,
    spin: f32,
    open: f32,
    /// The most the bodies' energy stood above what they started with, the test's own moves and the kinematic bodies' work
    /// gave them, in joules: energy no force in the scene made.
    gain: f64,
    /// The kinematic bodies' work over the run, in joules.
    work: f64,
    /// The most any dynamic body's speed stood against the most the ledger lets it have, sqrt(2 K / m) for its own mass m: K is
    /// the energy the bodies started with, plus the test's own moves and the kinematic bodies' work so far (and the ledger's
    /// 1e-6 of that work for rounding), less the bodies' height energy now, all of which one body could at most hold as motion.
    /// At most 1 when the ledger holds.
    share: f64,
}

/// `web` at `substeps`, keeping only some of its bodies and the joints between them when `keep` names them: the bodies by
/// index, the joints by the order the scene makes them. The rest are left out of the run, far off and still.
fn web_run(seed: u32, steps: u32, substeps: u32, keep: Option<(&[u32], &[usize])>) -> Web {
    let mut state = seed;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    let mut w = World::new(64, 64).unwrap();
    let (mut rows, mut joints) = (Vec::new(), Vec::new());
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
    let mut created = 0usize;
    for i in 0..24usize {
        let a = rows[(next() % 48) as usize];
        let b = rows[(next() % 48) as usize];
        if a == b {
            continue;
        }
        let flags = [LINEAR, HINGE, JOINT_LOCK * 6 | TURNS, LINEAR | TURNS][i % 4];
        let flags = if i % 4 == 1 { flags | JOINT_LIMIT << 3 } else { flags };
        let on_a = v3(((next() % 2049) as i32 - 1024) as f32 / 1024.0, ((next() % 2049) as i32 - 1024) as f32 / 1024.0, 0.0);
        created += 1;
        if keep.is_some_and(|(_, joints)| !joints.contains(&(created - 1))) {
            continue;
        }
        let row = joint(&mut w, a, b, flags, on_a, v3(0.0, 0.0, 0.0)) as usize;
        joints.push(row);
        if i % 4 == 1 {
            w.set_s(JOINT_MIN_3, row, -1.0);
            w.set_s(JOINT_MAX_3, row, 1.0);
        }
    }
    w.header_mut().substeps = substeps;
    if let Some((bodies, _)) = keep {
        for &row in &rows {
            if !bodies.contains(&row) {
                w.set_v(POSITION_X, row as usize, v3(1000.0 + 10.0 * row as f32, 1000.0, 0.0));
                w.set_v(TARGET_X, row as usize, v3(1000.0 + 10.0 * row as f32, 1000.0, 0.0));
                w.set_v(LINEAR_X, row as usize, v3(0.0, 0.0, 0.0));
                w.set_v(ANGULAR_X, row as usize, v3(0.0, 0.0, 0.0));
                w.touch_body(row);
            }
        }
        rows.retain(|r| bodies.contains(r));
    }
    let (mut top, mut spin, mut open) = (0.0f32, 0.0f32, 0.0f32);
    // The energy ledger: what the bodies hold, less what the test's own moves and the kinematic bodies gave them.
    let total = |w: &World| rows.iter().map(|&r| energy(w, r as usize)).sum::<f64>();
    let (start, work) = (total(&w), driven());
    let (mut moved, mut gain, mut share) = (0.0f64, 0.0f64, 0.0f64);
    let heights = |w: &World| {
        rows.iter()
            .map(|&r| {
                let at = r as usize;
                if w.flags(at) & KIND != DYNAMIC {
                    return 0.0;
                }
                let (g, p) = (w.header().gravity, w.v(POSITION_X, at));
                let height = -(g[0] as f64 * p.x as f64 + g[1] as f64 * p.y as f64 + g[2] as f64 * p.z as f64) * w.s(GRAVITY_SCALE, at) as f64;
                height / w.s(INVERSE_MASS, at) as f64
            })
            .sum::<f64>()
    };
    for i in 0..steps {
        for &row in &rows {
            let at = row as usize;
            let p = w.v(POSITION_X, at);
            let out = |x: f32| x > 16.0 || x < -16.0;
            if out(p.x) || out(p.y) || out(p.z) {
                let before = energy(&w, at);
                w.set_v(POSITION_X, at, v3(p.x / 4.0, p.y / 4.0, p.z / 4.0));
                w.set_v(LINEAR_X, at, v3(0.0, 0.0, 0.0));
                w.touch_body(row);
                moved += energy(&w, at) - before;
            }
            if w.flags(at) & KIND == KINEMATIC_POSITION {
                let p = w.v(POSITION_X, at);
                w.set_v(TARGET_X, at, v3(p.x + 0.0625, p.y, p.z));
                let turning = i % 64 < 32;
                w.set_s(TARGET_ROTATION_Y, at, if turning { 0.6 } else { 0.0 });
                w.set_s(TARGET_ROTATION_W, at, if turning { 0.8 } else { 1.0 });
            }
        }
        let started: Vec<V3> = (0..64).map(|b| w.v(POSITION_X, b)).collect();
        w.step(DT);
        gain = gain.max(total(&w) - start - moved - (driven() - work));
        let given = driven() - work;
        let motion = start + moved + given * (1.0 + 1e-6) - heights(&w);
        for &row in &rows {
            let at = row as usize;
            if w.flags(at) & KIND != DYNAMIC {
                continue;
            }
            let most = (2.0 * motion.max(0.0) * w.s(INVERSE_MASS, at) as f64).sqrt();
            let s = speed(&w, row) as f64;
            share = share.max(if most > 0.0 { s / most } else if s > 0.0 { f64::INFINITY } else { 0.0 });
        }
        for &row in &joints {
            let (a, b) = (w.uu(JOINT_A, row) as usize, w.uu(JOINT_B, row) as usize);
            let on = |body: usize, anchor: V3| w.v(POSITION_X, body).add(w.q(ROTATION_X, body).rotate(anchor));
            let mut gap = on(b, w.v(JOINT_ANCHOR_B_X, row)).sub(on(a, w.v(JOINT_ANCHOR_A_X, row)));
            if w.uu(JOINT_FLAGS, row) & JOINT_LOCK == 0 {
                let slide = w.q(ROTATION_X, a).rotate(v3(1.0, 0.0, 0.0));
                gap = gap.sub(slide.scale(slide.dot(gap)));
            }
            // Less what the two bodies travelled this step: a gap measured after the step stands on where the step took them,
            // which is outside the cube for a body the scene's turns flung.
            let travel = |body: usize| {
                let d = w.v(POSITION_X, body).sub(started[body]);
                sqrt(d.dot(d))
            };
            let gap = sqrt(gap.dot(gap)) - travel(a) - travel(b);
            if !(gap <= open) {
                open = gap;
            }
        }
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
    Web { top, spin, open, gain, work: driven() - work, share }
}

/// A kinematic body that turns 1.287 rad in one step, then holds, with a dynamic box held by `flags` from `r` m out along its
/// x axis. Returns the box's speed at the end of the turning step.
fn snapped(flags: u32, r: f32, substeps: u32) -> f32 {
    let mut w = World::new(4, 4).unwrap();
    no_gravity(&mut w);
    w.header_mut().substeps = substeps;
    let turner = w.add_body(KINEMATIC_POSITION).unwrap();
    w.add_collider(turner, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], [0.0, 0.0, 0.0, 1.0], 0.0).unwrap();
    let held = w.add_body(DYNAMIC).unwrap();
    w.add_collider(held, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], [0.0, 0.0, 0.0, 1.0], 1.0).unwrap();
    w.set_pose(held, v3(r, 0.0, 0.0), Q::IDENTITY, false);
    joint(&mut w, turner, held, flags, v3(r, 0.0, 0.0), v3(0.0, 0.0, 0.0));
    w.step(DT);
    // A quarter turn's 0.6 and 0.8: 2 asin(0.6) = 1.287 rad about y in one step.
    w.set_s(TARGET_ROTATION_Y, turner as usize, 0.6);
    w.set_s(TARGET_ROTATION_W, turner as usize, 0.8);
    w.step(DT);
    speed(&w, held)
}

#[test]
fn a_joint_does_not_turn_its_drift_into_speed() {
    // A body held at its anchor moves with the anchor and no faster: w r, with w = 1.287 rad over a step. A locked row that
    // measured its turn to the anchor on B and not to its own fed the gap the turn opens back as speed, w x gap, and the
    // body left at 1.63 times its anchor's speed with one substep, 2.3 times a step later.
    let w = 1.287_002_2 / DT;
    for (name, flags) in [("spherical", LINEAR), ("revolute", HINGE), ("fixed", LINEAR | TURNS)] {
        for r in [1.0f32, 4.0, 16.0] {
            for n in [1u32, 8, 32, 128] {
                let s = snapped(flags, r, n);
                assert!((s - w * r).abs() < 1e-3 * w * r, "{name} at {r} m, {n} substeps: {s} m/s, its anchor {} m/s", w * r);
            }
        }
    }
    // A slider is a bead on a turning rod: r = r0 cosh(w t), so it ends the turn at r0 w sqrt(cosh 2 w t). That is work the
    // turning body does, and the solve may only come short of it as its substeps grow coarse.
    let theta = w * DT;
    let bead = |r: f32| r * w * sqrt((2.0 * theta).cosh());
    for r in [1.0f32, 4.0, 16.0] {
        for (n, least) in [(1u32, 0.6f32), (8, 0.97), (32, 0.995), (128, 0.998)] {
            let s = snapped(SLIDER, r, n);
            assert!(s <= bead(r) * 1.001 && s >= bead(r) * least, "slider at {r} m, {n} substeps: {s} m/s, a bead {} m/s", bead(r));
        }
    }
}

#[test]
fn a_web_of_joints_stays_in_the_numbers() {
    // Joints between bodies metres apart, with fixed ends, spinning ends and closed loops, none of it satisfiable. A body fixed
    // to a kinematic turn of 1.29 rad a step at 30 m has a true speed of 2,300 m/s, and one on a slider more: a bead on a rail
    // runs out exponentially (a_bead_on_a_spinning_rail_is_refused_before_it_leaves_the_numbers), and one held where two rails
    // cross runs out faster still as they close on parallel (a_web_of_joints_gains_no_more_than_its_kinematic_bodies_give_it).
    // What the joints remembered used to run this to not a number on most seeds, and none may gain energy its kinematic
    // bodies did not give it. So the speeds are those the kinematic bodies' work gives, which has no bound of its own: seed 1's
    // drivers do 1.7e12 J of work on its sliders, and a body runs out to 172 km/s (this test bounded the speed at 1e5 m/s, a
    // figure with no derivation, until the solve order became the world's own and seed 1 took that path). What a step can work
    // with is bounded: every speed stays a number under the range a step refuses past (RANGE). And the ledger bounds each body:
    // no body moves faster than sqrt(2 K / m), K the energy the scene and its kinematic bodies have given the bodies so far,
    // less their height energy (`Web::share`), as no body holds more motion than all of them were given.
    let (mut worst, mut widest, mut nearest) = (0.0f32, 0.0f32, 0.0f64);
    for seed in 1..=60 {
        let run = web_run(seed, 2000, 1, None);
        assert!(run.top < RANGE, "seed {seed} reached {} m/s", run.top);
        assert!(run.gain <= 1e-6 * run.work, "seed {seed} gained {} J over the {} J its kinematic bodies did", run.gain, run.work);
        assert!(run.share <= 1.0, "seed {seed}: a body ran at {} times the speed the energy given lets it have", run.share);
        nearest = nearest.max(run.share);
        worst = worst.max(run.top);
        widest = widest.max(run.open);
    }
    println!("fastest in the webs: {worst:.0} m/s, widest joint: {widest:.2} m, nearest the energy bound: {nearest:.3}");
}

#[test]
fn a_web_of_joints_gains_no_more_than_its_kinematic_bodies_give_it() {
    // Seed 1's knot: bodies 11 and 30 on sliders from a kinematicVelocity body and from a kinematicPosition body that turns
    // 1.287 rad in a step, with a spherical joint between them. Held where the two rails cross, with one turning, the pair
    // runs out along them faster each substep as they close on parallel, 1.5 times a substep at 8 substeps and 1.2 million
    // m/s at 128 with the sweeps (430,000 with the block solve). That is the geometry and not the solve: each relaxing pass that sped the pair up took more work from the
    // turning body than the energy it added (2.3e8 J of kinetic energy for 3.6e8 J of work at the fastest step). The energy
    // counts the motion, the height and the test's own moves back into its cube, and the work is every joint and contact
    // impulse a kinematic body hands on, at the point it hands it on, a joint's position bias included: its push and the
    // relaxing pass's taking back of it are both the kinematic body's impulses, so a push taken back nets nothing and one left
    // behind shows as a gain. (Counting the taking back alone made the ledger depend on the kinematic body's speed, and with
    // the block solver it read 3.4 MJ of web seed 17's work in one step as a gain, against the 73 kJ the bodies gained.) The bound is loose: a kinematic body's catch is inelastic and its work counts in full, three times the energy a
    // box keeps in a_joint_does_not_turn_its_drift_into_speed, which is where the tight figures are.
    for substeps in [1, 8, 32, 128] {
        let run = web_run(1, 2000, substeps, Some((&[11, 30, 47, 21], &[0, 18, 21])));
        println!("{substeps} substeps: fastest {:.0} m/s, {:.3e} J over the kinematic bodies' {:.3e} J", run.top, run.gain, run.work);
        assert!(run.work > 0.0 && run.gain <= 1e-6 * run.work, "{substeps} substeps: {} J over the kinematic bodies' {} J", run.gain, run.work);
    }
}

#[test]
fn a_path_with_more_locks_than_freedoms_drops_the_row_that_depends() {
    // Seed 1: a slider from a kinematicVelocity body to body 11, a spherical joint 43 m long to body 30 and a slider from body
    // 30 to a kinematicPosition body, 13 lock rows on 12 freedoms, so one row depends on the others at every step. Eliminating
    // J M^-1 J^T joint by joint left it a pivot of 4e-7 of its size where rationals give 0, the exact solve of that rounding
    // gave 14,424 m/s at step 335 and 4,782,492 rad/s at step 336, and a joint stood 232 m open. Seed 35: 15 rows on 12
    // freedoms, 370,728 rad/s at step 577. The scene's kinematic turns carry an arm of 0.125 m at about 18,400 rad/s, and it
    // puts every body back inside a 32 m cube each step with anchors at most 1.42 m off a centre, so a joint opened wider than
    // 56.85 m and what its two bodies travelled in the step was opened by the solve. A body the scene flings travels that far
    // itself: seed 1's slider from a kinematicPosition body turning 77 rad/s carried body 30 at 2,670 m/s, 35 m out, and it
    // stood 97 m from the slider's line after the step, 44 m of it the step's own travel.
    for (seed, steps) in [(1, 400), (35, 600)] {
        let (top, spin, open) = web(seed, steps);
        println!("web {seed}: fastest {top:.0} m/s, top spin {spin:.0} rad/s, widest joint {open:.2} m");
        assert!(spin < 18_400.0, "seed {seed}: a body spun at {spin} rad/s");
        assert!(open < 56.85, "seed {seed}: a joint stood {open} m open");
    }
}

#[test]
fn a_cut_push_still_takes_back_the_speed_along_the_locks() {
    // Seed 45, step 1986: a hinge's limit stops a turn about an anchor 24 m off, which only the locks can carry, so it gives
    // its body 7,500 rad/s that the path solve after it takes back. The pushing pass cut its whole path solve to nothing, that
    // taking back included, and handed a neighbour 457,390 rad/s; contacts passed it on and a body landed 1,100 m from its
    // joints. The scene's own motion, a kinematic turn of 77 rad/s at up to 30 m, carries an anchor at 2,300 m/s, which
    // turns an arm of 0.125 m at no more than about 18,400 rad/s. Before the fix the web reached 162,278 rad/s.
    let (top, spin, _) = web(45, 2000);
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

/// A kinematicVelocity hub moving at `speed` along x drags a box on a spherical joint whose anchor starts 0.2 m out of
/// place, with no gravity: the energy the box gains over 60 steps less the work the ledger says the hub did.
fn dragged_gain(speed: f32) -> (f64, f64) {
    let mut w = World::new(4, 4).unwrap();
    no_gravity(&mut w);
    let hub = w.add_body(KINEMATIC_VELOCITY).unwrap();
    w.set_v(LINEAR_X, hub as usize, v3(speed, 0.0, 0.0));
    let box_ = point(&mut w, v3(1.2, 0.0, 0.0));
    w.set_v(LINEAR_X, box_ as usize, v3(speed, 0.0, 0.0));
    w.touch_body(box_);
    joint(&mut w, hub, box_, LINEAR, v3(1.0, 0.0, 0.0), v3(0.0, 0.0, 0.0));
    let (start, work) = (energy(&w, box_ as usize), driven());
    for _ in 0..60 {
        w.step(DT);
    }
    let gained = energy(&w, box_ as usize) - start;
    (gained - (driven() - work), driven() - work)
}

#[test]
fn the_energy_ledger_reads_the_same_in_a_moving_frame() {
    // A joint's position bias pushes the box back to its anchor and the relaxing pass takes the push's speed back. Both are
    // impulses the hub hands on, so both are its work. The ledger used to count the taking back and not the push, so a
    // hub moving at u read p u of work that did nothing, and the energy no force made grew with the frame's speed. What a
    // scene gains is the same in every frame (Galileo): the ledger's reading at 50 m/s matches its reading at rest.
    let (still, _) = dragged_gain(0.0);
    let (moving, work) = dragged_gain(50.0);
    println!("gain at rest {still:.6e} J, moving {moving:.6e} J over {work:.6e} J of the hub's work");
    // What f32 lets the two differ by: the 1 kg box's speed of 50 m/s rounds to an ulp of 2^-18 m/s, which moves its kinetic
    // energy by m v ulp, once a step for 60 steps (0.011 J). The old ledger read 4,800 J.
    let rounding = 60.0 * 50.0 * 2f64.powi(-18);
    assert!((moving - still).abs() < rounding, "at rest {still} J, at 50 m/s {moving} J");
}

