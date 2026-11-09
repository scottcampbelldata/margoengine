// The scenes of the pinned-bits test, shared by the native test (tests/bits.rs) and the Wasm check (wasm-check/), so
// one source decides both and the Wasm build of the shipped solve is held to the same hashes. no_std safe: the inputs
// carry no trigonometry (the turns and the floor's wave are the f32 cos and sin bit patterns, as native Rust gives
// them), so the scenes are the same bits on every target.
use alloc::vec::Vec;
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{Rot, V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

/// The hashes of `run` over `[pyramid(100), joint_grid(), mixed()]`.
pub const PINNED: [u64; 3] = [0x9ffe_fc83_c3a9_9be4, 0x95a4_7530_df18_0011, 0x92db_6847_c4e9_19d4];

/// cos and sin of 0.1 i for i in 0..30, f32 bit patterns.
const TURN: [(u32, u32); 30] = [
    (0x3f800000, 0x00000000), (0x3f7eb898, 0x3dcc7577), (0x3f7ae5a5, 0x3e4b6ff9), (0x3f7490ef, 0x3e974e6d),
    (0x3f6bcaa7, 0x3ec761d7), (0x3f60a940, 0x3ef57744), (0x3f534932, 0x3f108c69), (0x3f43ccb3, 0x3f24eb73),
    (0x3f325b5f, 0x3f37a4a6), (0x3f1f21d4, 0x3f48881d), (0x3f0a5140, 0x3f576aa4), (0x3ee83dbf, 0x3f64262b),
    (0x3eb986f3, 0x3f6e9a1d), (0x3e88f599, 0x3f76abc0), (0x3e2e0bdf, 0x3f7c466f), (0x3d90deaa, 0x3f7f5bd5),
    (0xbcef33e3, 0x3f7fe40e), (0xbe03efd3, 0x3f7dddbf), (0xbe68a7af, 0x3f794e14), (0xbea58635, 0x3f7240b9),
    (0xbed51133, 0x3f68c7b7), (0xbf013d9a, 0x3f5cfb49), (0xbf16a803, 0x3f4ef99e), (0xbf2a9110, 0x3f3ee68a),
    (0xbf3cc5d7, 0x3f2ceb27), (0xbf4d17bf, 0x3f193578), (0xbf5b5d11, 0x3f03f7e4), (0xbf677146, 0x3edad188),
    (0xbf71357b, 0x3eab8393), (0xbf7890b7, 0x3e74fdc0),
];

/// sin(0.7 i) for i in 0..=40, f32 bit patterns.
const WAVE: [u32; 41] = [
    0x00000000, 0x3f24eb73, 0x3f7c466f, 0x3f5cfb4b, 0x3eab8393, 0xbeb399dc, 0xbf5f1f95, 0xbf7b8203,
    0xbf219ab2, 0x3c89bcb5, 0x3f283046, 0x3f7cf897, 0x3f5ac702, 0x3ea360ee, 0xbebba32d, 0xbf6133be,
    0xbf7aab65, 0xbf1e3e41, 0x3d09b7b8, 0x3f2b68ef, 0x3f7d9872, 0x3f5882df, 0x3e9b3260, 0xbec39ee9,
    0xbf633792, 0xbf79c2a0, 0xbf1ad662, 0x3d4e879f, 0x3f2e9530, 0x3f7e25ef, 0x3f562f10, 0x3e92f8b5,
    0xbecb8c5f, 0xbf652b03, 0xbf78c7cb, 0xbf176335, 0x3d89a3ca, 0x3f31b4c2, 0x3f7ea10b, 0x3f53cbca,
    0x3e8ab42a,
];

pub const DT: f32 = 1.0 / 60.0;

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
pub fn run(mut world: World) -> u64 {
    let mut h = Fnv::new();
    for _ in 0..120 {
        world.step(DT).unwrap();
        for b in &world.bodies {
            h.add(b.exact_center[0].to_bits());
            h.add(b.exact_center[1].to_bits());
            h.add((b.xf.q.c.to_bits() as u64) << 32 | b.xf.q.s.to_bits() as u64);
            h.add((b.linear_velocity.x.to_bits() as u64) << 32 | b.linear_velocity.y.to_bits() as u64);
            h.add((b.angular_velocity.to_bits() as u64) << 32 | b.awake as u64);
        }
        let c = world.counts;
        for x in [c.pairs, c.manifolds, c.cold_points, c.constraints, c.block, c.sequential, c.colours, c.overflow, c.islands, c.awake_bodies] {
            h.add(x);
        }
    }
    h.0
}

/// A box turned by `TURN[turn]`.
fn rect(world: &mut World, kind: Kind, at: V2, hx: f32, hy: f32, turn: usize, def: &ShapeDef) -> u32 {
    let (c, s) = TURN[turn];
    let b = world.create_body(&BodyDef { kind, position: at, rotation: Rot::from_pair(f32::from_bits(c), f32::from_bits(s)), ..Default::default() }).unwrap();
    world.create_shape(b, Core::rect(hx, hy, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), def).unwrap();
    b
}

pub fn pyramid(rows: usize) -> World {
    let mut world = World::default();
    rect(&mut world, Kind::Static, v2(0.0, -0.5), 500.0, 0.5, 0, &ShapeDef::default());
    let def = ShapeDef { density: 1.0, friction: 0.6, restitution: 0.0 };
    for row in 0..rows {
        let count = rows - row;
        for i in 0..count {
            rect(&mut world, Kind::Dynamic, v2(i as f32 - 0.5 * (count as f32 - 1.0), 0.5 + row as f32), 0.5, 0.5, 0, &def);
        }
    }
    world
}

pub fn joint_grid() -> World {
    let n = 30usize;
    let mut world = World::default();
    let mut id = Vec::new();
    for r in 0..n {
        for c in 0..n {
            let kind = if r == 0 { Kind::Static } else { Kind::Dynamic };
            let b = world.create_body(&BodyDef { kind, position: v2(c as f32, -(r as f32)), ..Default::default() }).unwrap();
            world.create_shape(b, Core::circle(V2::ZERO, 0.4).unwrap(), &ShapeDef::default()).unwrap();
            id.push(b);
        }
    }
    let revolute = JointKind::Revolute { limits: None, motor: None };
    for r in 0..n {
        for c in 0..n {
            if c + 1 < n && r > 0 {
                world.create_joint(&JointDef { kind: revolute, a: id[r * n + c], b: id[r * n + c + 1], anchor_a: v2(0.5, 0.0), anchor_b: v2(-0.5, 0.0), collide: false }).unwrap();
            }
            if r + 1 < n {
                world.create_joint(&JointDef { kind: revolute, a: id[r * n + c], b: id[(r + 1) * n + c], anchor_a: v2(0.0, -0.5), anchor_b: v2(0.0, 0.5), collide: false }).unwrap();
            }
        }
    }
    world
}

/// A bent chain floor with boxes and balls dropped and slid on it, a kinematic paddle sweeping through, bouncing balls,
/// and a hanging chain of boxes whose links hit the floor: contacts with every body kind, restitution, joints touching
/// contacts, sleep and wake.
pub fn mixed() -> World {
    let mut world = World::default();
    let floor = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let points: Vec<V2> = (0..=40).map(|i| v2(i as f32 - 20.0, 0.3 * f32::from_bits(WAVE[i]))).collect();
    world.create_chain(floor, &points, false, &ShapeDef::default()).unwrap();
    let def = ShapeDef { density: 1.0, friction: 0.5, restitution: 0.0 };
    for i in 0..30 {
        let x = -15.0 + i as f32;
        rect(&mut world, Kind::Dynamic, v2(x, 1.5 + (i % 3) as f32), 0.4, 0.3, i, &def);
    }
    let bouncy = ShapeDef { density: 1.0, friction: 0.3, restitution: 0.7 };
    for i in 0..10 {
        let b = world.create_body(&BodyDef { position: v2(-10.0 + 2.0 * i as f32, 6.0), linear_velocity: v2(1.0, 0.0), ..Default::default() }).unwrap();
        world.create_shape(b, Core::circle(V2::ZERO, 0.3).unwrap(), &bouncy).unwrap();
    }
    let paddle = world.create_body(&BodyDef { kind: Kind::Kinematic, position: v2(-18.0, 1.0), linear_velocity: v2(3.0, 0.0), angular_velocity: 1.0, ..Default::default() }).unwrap();
    world.create_shape(paddle, Core::rect(1.0, 0.1, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &def).unwrap();
    let anchor = world.create_body(&BodyDef { kind: Kind::Static, position: v2(5.0, 8.0), ..Default::default() }).unwrap();
    let mut prev = anchor;
    for i in 0..10 {
        let b = rect(&mut world, Kind::Dynamic, v2(5.5 + i as f32, 8.0), 0.45, 0.1, 0, &def);
        let anchor_a = if i == 0 { V2::ZERO } else { v2(0.5, 0.0) };
        world.create_joint(&JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a: prev, b, anchor_a, anchor_b: v2(-0.5, 0.0), collide: false }).unwrap();
        prev = b;
    }
    world
}
