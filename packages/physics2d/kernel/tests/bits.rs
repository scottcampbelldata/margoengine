// Pinned bits: suite scenes stepped 120 times, every body's exact centre, rotation and velocities and every step's work
// counts folded into one FNV-1a hash. A change that must not move a bit (a new memory layout, a faster loop) keeps these
// hashes; a change that moves results re-pins them in its own commit and re-measures every bar. Pinned 2026-11-08 at the
// solver before the compact solver bodies (perf history entry 85).
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{Rot, V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

struct Fnv(u64);
impl Fnv {
    fn new() -> Fnv {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn add(&mut self, x: u64) {
        for byte in x.to_le_bytes() {
            self.0 ^= byte as u64;
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

/// Steps `world` 120 times, folding every body's state and the step's counts into the hash after each step.
fn run(mut world: World) -> u64 {
    let mut h = Fnv::new();
    for _ in 0..120 {
        world.step(DT);
        for b in &world.bodies {
            h.add(b.exact_center[0].to_bits());
            h.add(b.exact_center[1].to_bits());
            h.add((b.xf.q.c.to_bits() as u64) << 32 | b.xf.q.s.to_bits() as u64);
            h.add((b.linear_velocity.x.to_bits() as u64) << 32 | b.linear_velocity.y.to_bits() as u64);
            h.add((b.angular_velocity.to_bits() as u64) << 32 | b.awake as u64);
        }
        let c = world.counts;
        for x in [c.pairs, c.manifolds, c.cold_points, c.constraints, c.block, c.sequential, c.islands, c.awake_bodies] {
            h.add(x);
        }
    }
    h.0
}

fn rect(world: &mut World, kind: Kind, at: V2, hx: f32, hy: f32, angle: f32, def: &ShapeDef) -> u32 {
    let b = world.create_body(&BodyDef { kind, position: at, rotation: Rot::from_pair(angle.cos(), angle.sin()), ..Default::default() });
    world.create_shape(b, Core::rect(hx, hy, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), def);
    b
}

fn pyramid(rows: usize) -> World {
    let mut world = World::default();
    rect(&mut world, Kind::Static, v2(0.0, -0.5), 500.0, 0.5, 0.0, &ShapeDef::default());
    let def = ShapeDef { density: 1.0, friction: 0.6, restitution: 0.0 };
    for row in 0..rows {
        let count = rows - row;
        for i in 0..count {
            rect(&mut world, Kind::Dynamic, v2(i as f32 - 0.5 * (count as f32 - 1.0), 0.5 + row as f32), 0.5, 0.5, 0.0, &def);
        }
    }
    world
}

fn joint_grid() -> World {
    let n = 30usize;
    let mut world = World::default();
    let mut id = Vec::new();
    for r in 0..n {
        for c in 0..n {
            let kind = if r == 0 { Kind::Static } else { Kind::Dynamic };
            let b = world.create_body(&BodyDef { kind, position: v2(c as f32, -(r as f32)), ..Default::default() });
            world.create_shape(b, Core::circle(V2::ZERO, 0.4).unwrap(), &ShapeDef::default());
            id.push(b);
        }
    }
    let revolute = JointKind::Revolute { limits: None, motor: None };
    for r in 0..n {
        for c in 0..n {
            if c + 1 < n && r > 0 {
                world.create_joint(&JointDef { kind: revolute, a: id[r * n + c], b: id[r * n + c + 1], anchor_a: v2(0.5, 0.0), anchor_b: v2(-0.5, 0.0), collide: false });
            }
            if r + 1 < n {
                world.create_joint(&JointDef { kind: revolute, a: id[r * n + c], b: id[(r + 1) * n + c], anchor_a: v2(0.0, -0.5), anchor_b: v2(0.0, 0.5), collide: false });
            }
        }
    }
    world
}

/// A bent chain floor with boxes and balls dropped and slid on it, a kinematic paddle sweeping through, bouncing balls,
/// and a hanging chain of boxes whose links hit the floor: contacts with every body kind, restitution, joints touching
/// contacts, sleep and wake.
fn mixed() -> World {
    let mut world = World::default();
    let floor = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() });
    let points: Vec<V2> = (0..=40).map(|i| v2(i as f32 - 20.0, 0.3 * ((i as f32) * 0.7).sin())).collect();
    world.create_chain(floor, &points, false, &ShapeDef::default()).unwrap();
    let def = ShapeDef { density: 1.0, friction: 0.5, restitution: 0.0 };
    for i in 0..30 {
        let x = -15.0 + i as f32;
        rect(&mut world, Kind::Dynamic, v2(x, 1.5 + (i % 3) as f32), 0.4, 0.3, 0.1 * i as f32, &def);
    }
    let bouncy = ShapeDef { density: 1.0, friction: 0.3, restitution: 0.7 };
    for i in 0..10 {
        let b = world.create_body(&BodyDef { position: v2(-10.0 + 2.0 * i as f32, 6.0), linear_velocity: v2(1.0, 0.0), ..Default::default() });
        world.create_shape(b, Core::circle(V2::ZERO, 0.3).unwrap(), &bouncy);
    }
    let paddle = world.create_body(&BodyDef { kind: Kind::Kinematic, position: v2(-18.0, 1.0), linear_velocity: v2(3.0, 0.0), angular_velocity: 1.0, ..Default::default() });
    world.create_shape(paddle, Core::rect(1.0, 0.1, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &def);
    let anchor = world.create_body(&BodyDef { kind: Kind::Static, position: v2(5.0, 8.0), ..Default::default() });
    let mut prev = anchor;
    for i in 0..10 {
        let b = rect(&mut world, Kind::Dynamic, v2(5.5 + i as f32, 8.0), 0.45, 0.1, 0.0, &def);
        let anchor_a = if i == 0 { V2::ZERO } else { v2(0.5, 0.0) };
        world.create_joint(&JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a: prev, b, anchor_a, anchor_b: v2(-0.5, 0.0), collide: false });
        prev = b;
    }
    world
}

#[test]
fn suite_scenes_step_to_their_pinned_bits() {
    let got = [run(pyramid(100)), run(joint_grid()), run(mixed())];
    println!("pinned bits: {:#018x} {:#018x} {:#018x}", got[0], got[1], got[2]);
    assert_eq!(got, [0x467f_2501_232a_dcc3, 0x2122_d3ba_bb99_7111, 0xd63e_3577_cfbc_6921], "the 100-row pyramid, the joint grid, the mixed scene");
}

#[test]
#[ignore]
fn step_time_of_the_100_row_pyramid() {
    // One side of a paired A/B against another commit: 60 steps to settle, then the fastest of the next 40 steps. Run
    // this commit's and the other's test binaries in turns, many rounds, and compare per-round minimums (AGENTS.md).
    let mut world = pyramid(100);
    for _ in 0..60 {
        world.step(DT);
    }
    let mut best = f64::INFINITY;
    for _ in 0..40 {
        let start = std::time::Instant::now();
        world.step(DT);
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
    }
    println!("STEP {best:.3}");
}
