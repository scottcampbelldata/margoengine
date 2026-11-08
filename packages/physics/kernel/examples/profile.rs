// Where a step's time goes, natively: the harness scenes of physics-refs, each phase of `World::step` timed apart.
// `cargo run --release --example profile -- [scene] [default|equal]`. Scenes: pyramid, cubes1000, cubes5000,
// cubes1000-awake, cubes5000-awake, chain, grid, all (the default).
//
// The loop below is `World::step` written out with a clock between the phases. After each scene a twin world takes the
// same steps through `World::step` itself and the two world hashes must agree, so a change to the
// step that this copy misses stops the run instead of timing something else.
use std::time::Instant;

use margoengine_physics_kernel::joints::Pass;
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::solver::soft;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

const PHASES: [&str; 14] = [
    "begin_step",
    "broad_update",
    "narrow_phase",
    "update_islands",
    "prepare_contacts",
    "prepare_joints",
    "integrate_velocities",
    "refresh_joints",
    "warm_start",
    "solve_joints",
    "solve_contacts biased",
    "integrate_poses",
    "solve_contacts relax",
    "impacts, events, range",
];

struct Clock {
    total: [f64; PHASES.len()],
    last: Instant,
}

impl Clock {
    fn lap(&mut self, phase: usize) {
        let now = Instant::now();
        self.total[phase] += (now - self.last).as_secs_f64();
        self.last = now;
    }
}

/// `World::step`, phase by phase.
fn step(w: &mut World, dt: f32, clock: &mut Clock) {
    if w.header().lost != NONE {
        return;
    }
    clock.last = Instant::now();
    let substeps = w.header().substeps;
    let h = dt / substeps as f32;
    w.begin_step(dt);
    clock.lap(0);
    w.broad_update(dt);
    clock.lap(1);
    w.narrow_phase(dt);
    clock.lap(2);
    w.update_islands(dt);
    clock.lap(3);
    w.prepare_contacts();
    clock.lap(4);
    w.prepare_joints();
    clock.lap(5);
    let (hertz, damping) = (w.header().contact_hertz, w.header().contact_damping);
    let hertz = if hertz * h > 0.25 { 0.25 / h } else { hertz };
    let stiffness = soft(hertz, damping, h);
    for substep in 0..substeps {
        w.integrate_velocities(h);
        clock.lap(6);
        w.refresh_joints();
        clock.lap(7);
        w.warm_start();
        clock.lap(8);
        w.warm_start_joints();
        clock.lap(9);
        let (passes, most) = (w.header().iterations, w.header().extra_passes);
        if passes < 2 {
            w.solve_joints(h, stiffness, Pass::Settle, 0, 2 - passes);
            clock.lap(9);
        }
        let all = passes.saturating_add(most);
        for pass in 1..=all {
            let least = most.saturating_add(1).saturating_sub(pass);
            w.solve_joints(h, stiffness, if pass == all { Pass::Push } else { Pass::Settle }, least, u32::MAX);
            clock.lap(9);
            w.solve_contacts(h, stiffness, true, substep as usize, least, false);
            clock.lap(10);
        }
        w.integrate_poses(h, substep + 1 == substeps);
        w.tally_drift(h);
        clock.lap(11);
        w.refresh_joints();
        clock.lap(7);
        let relaxes = all.max(1);
        for pass in 1..=relaxes {
            let need = relaxes - (pass - 1);
            let least = if need <= 1 { 0 } else { need.saturating_sub(passes) };
            w.solve_joints(h, stiffness, Pass::Relax, least, u32::MAX);
            clock.lap(9);
            w.solve_contacts(h, stiffness, false, substep as usize, least, pass == relaxes);
            clock.lap(12);
        }
        w.solve_impacts();
        clock.lap(13);
    }
    w.gather_events();
    w.header_mut().steps += 1;
    w.check_range();
    clock.lap(13);
}

fn floor(w: &mut World) {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [500.0, 0.5, 500.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(body, v3(0.0, -0.5, 0.0), Q::IDENTITY, false);
}
fn cube(w: &mut World, at: V3, sleep: bool) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    if !sleep {
        w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    }
    body
}

/// The scenes of physics-refs/js/margo-next/margo3d.mjs: (world, steps).
fn build(scene: &str, equal: bool) -> (World, usize) {
    let (mut w, steps) = match scene {
        "pyramid" => {
            let rows = 20;
            let mut w = World::new(rows * (rows + 1) / 2 + 1, rows * (rows + 1) / 2 + 1).unwrap();
            floor(&mut w);
            for row in 0..rows {
                for i in 0..rows - row {
                    let x = i as f32 - (rows - row - 1) as f32 * 0.5;
                    cube(&mut w, v3(x, 0.5 + row as f32, 0.0), true);
                }
            }
            (w, 1800)
        }
        "cubes1000" | "cubes5000" | "cubes1000-awake" | "cubes5000-awake" => {
            let n: u32 = if scene.starts_with("cubes1000") { 1000 } else { 5000 };
            let sleep = !scene.ends_with("-awake");
            let mut w = World::new(n + 1, n + 1).unwrap();
            floor(&mut w);
            let side = (n as f64).cbrt().ceil() as u32;
            for i in 0..n {
                let at = v3(
                    (i % side) as f32 * 1.1 - side as f32 / 2.0,
                    1.0 + (i / (side * side)) as f32 * 1.1,
                    ((i / side) % side) as f32 * 1.1 - side as f32 / 2.0,
                );
                cube(&mut w, at, sleep);
            }
            (w, 600)
        }
        "chain" => {
            // 50 balls of r 0.05 m, 0.1 m apart on ball joints from a fixed pivot, the last 1000 kg; no collisions.
            let n = 50;
            let mut w = World::new(n + 1, 1).unwrap();
            let pivot = w.add_body(FIXED).unwrap();
            w.set_pose(pivot, v3(0.0, 20.0, 0.0), Q::IDENTITY, false);
            let mut previous = pivot;
            for i in 1..=n {
                let body = w.add_body(DYNAMIC).unwrap();
                let mass = if i == n { 1000.0 } else { 1.0 };
                let inertia = 0.4 * mass * 0.05 * 0.05;
                w.set_s(INVERSE_MASS, body as usize, 1.0 / mass);
                w.set_v(INERTIA_X, body as usize, v3(inertia, inertia, inertia));
                w.set_v(INVERSE_INERTIA_X, body as usize, v3(1.0 / inertia, 1.0 / inertia, 1.0 / inertia));
                w.set_pose(body, v3(i as f32 * 0.1, 20.0, 0.0), Q::IDENTITY, false);
                w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
                let joint = w.add_joint(previous, body, JOINT_LOCK * 7).unwrap();
                w.set_v(JOINT_ANCHOR_A_X, joint as usize, v3(0.05, 0.0, 0.0));
                w.set_v(JOINT_ANCHOR_B_X, joint as usize, v3(-0.05, 0.0, 0.0));
                previous = body;
            }
            (w, 600)
        }
        "grid" => {
            // 30 x 30 point masses of a 0.4 m ball, 1 m apart, hinges about z to the right and down, top row fixed.
            let n = 30u32;
            let mut w = World::new(n * n, 1).unwrap();
            let mut id = vec![];
            for r in 0..n {
                for c in 0..n {
                    let body = w.add_body(if r == 0 { FIXED } else { DYNAMIC }).unwrap();
                    if r > 0 {
                        let mass = 4.0 / 3.0 * PI * 0.4 * 0.4 * 0.4;
                        let inertia = 0.4 * mass * 0.4 * 0.4;
                        w.set_s(INVERSE_MASS, body as usize, 1.0 / mass);
                        w.set_v(INERTIA_X, body as usize, v3(inertia, inertia, inertia));
                        w.set_v(INVERSE_INERTIA_X, body as usize, v3(1.0 / inertia, 1.0 / inertia, 1.0 / inertia));
                    }
                    w.set_pose(body, v3(c as f32, -(r as f32), 0.0), Q::IDENTITY, false);
                    id.push(body);
                }
            }
            let hinge = JOINT_LOCK * 7 | JOINT_LOCK * (6 << 3);
            for r in 0..n {
                for c in 0..n {
                    let at = (r * n + c) as usize;
                    let link = |w: &mut World, other: usize, on_a: V3, on_b: V3| {
                        let joint = w.add_joint(id[at], id[other], hinge).unwrap();
                        w.set_v(JOINT_ANCHOR_A_X, joint as usize, on_a);
                        w.set_v(JOINT_ANCHOR_B_X, joint as usize, on_b);
                    };
                    if c + 1 < n && r > 0 {
                        link(&mut w, at + 1, v3(0.5, 0.0, 0.0), v3(-0.5, 0.0, 0.0));
                    }
                    if r + 1 < n {
                        link(&mut w, at + n as usize, v3(0.0, -0.5, 0.0), v3(0.0, 0.5, 0.0));
                    }
                }
            }
            (w, 600)
        }
        _ => panic!("unknown scene {scene}"),
    };
    w.header_mut().gravity = [0.0, -9.81, 0.0];
    if equal {
        w.header_mut().substeps = 4;
        w.header_mut().iterations = 1;
    }
    (w, steps)
}

fn run(scene: &str, equal: bool) {
    let (mut w, steps) = build(scene, equal);
    let mut clock = Clock { total: [0.0; PHASES.len()], last: Instant::now() };
    let mut times = Vec::with_capacity(steps);
    let (mut pairs, mut solving, mut points, mut awake) = (0u64, 0u64, 0u64, 0u64);
    for _ in 0..steps {
        let start = Instant::now();
        step(&mut w, DT, &mut clock);
        times.push(start.elapsed().as_secs_f64() * 1e3);
        let header = w.header();
        pairs += header.active_pairs as u64;
        solving += header.solving as u64;
        awake += header.awake as u64;
        for i in 0..header.solving as usize {
            points += w.uu(PAIR_CONTACTS, w.uu(SOLVE_PAIRS, i) as usize) as u64;
        }
    }
    // The twin, through World::step itself.
    let (mut twin, _) = build(scene, equal);
    for _ in 0..steps {
        twin.step(DT);
    }
    assert!(w.hash() == twin.hash(), "{scene}: the profiled loop left a different world from World::step; update examples/profile.rs");

    let mut sorted = times.clone();
    sorted.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let total: f64 = times.iter().sum();
    let n = steps as f64;
    println!(
        "{scene} {}: {steps} steps, median {:.4} ms, p95 {:.4} ms, mean {:.4} ms; per step: awake {:.0}, active pairs {:.0}, solving {:.0}, points {:.0}, joints {}",
        if equal { "equal 4x1" } else { "defaults 8x2" },
        sorted[steps / 2],
        sorted[(steps as f64 * 0.95) as usize],
        total / n,
        awake as f64 / n,
        pairs as f64 / n,
        solving as f64 / n,
        points as f64 / n,
        w.header().joint_solving,
    );
    for (k, name) in PHASES.iter().enumerate() {
        let ms = clock.total[k] * 1e3;
        if ms > 0.0005 * total {
            println!("  {name:<24} {:>9.4} ms/step {:>5.1}%", ms / n, 100.0 * ms / total);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let scene = args.first().map(String::as_str).unwrap_or("all");
    let modes: Vec<bool> = match args.get(1).map(String::as_str) {
        Some("default") => vec![false],
        Some("equal") => vec![true],
        _ => vec![false, true],
    };
    let scenes: Vec<&str> =
        if scene == "all" { vec!["pyramid", "cubes1000", "cubes1000-awake", "cubes5000", "cubes5000-awake", "chain", "grid"] } else { vec![scene] };
    for scene in scenes {
        for &equal in &modes {
            run(scene, equal);
        }
    }
}
