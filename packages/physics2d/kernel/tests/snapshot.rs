// Snapshots: a world restored from bytes steps bit for bit as the original does, including its warm start, its sleepers,
// its removed slots and its joints; bad bytes are refused.
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, EVENT_COLLISION, Kind, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn scene() -> World {
    let mut w = World::default();
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(ground, Core::rect(20.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef { events: EVENT_COLLISION, ..Default::default() }).unwrap();
    w.create_chain(ground, &[v2(-20.0, 0.0), v2(-20.0, 5.0)], false, &ShapeDef::default()).unwrap();
    let mut last = ground;
    for i in 0..12 {
        let b = w.create_body(&BodyDef { position: v2(-3.0 + (i % 4) as f32 * 1.1, 1.0 + i as f32 * 0.9), ccd: i == 3, ..Default::default() }).unwrap();
        let core = if i % 3 == 0 { Core::circle(V2::ZERO, 0.4).unwrap() } else { Core::rect(0.4, 0.3, V2::ZERO, 1.0, 0.0, 0.0).unwrap() };
        w.create_shape(b, core, &ShapeDef { events: EVENT_COLLISION, ..Default::default() }).unwrap();
        if i == 5 {
            w.create_joint(&JointDef { kind: JointKind::Revolute { limits: Some((-0.5, 0.5)), motor: None }, a: last, b, anchor_a: v2(0.0, 1.0), anchor_b: v2(0.0, -1.0), collide: false }).unwrap();
        }
        last = b;
    }
    // A removed body leaves a free slot the snapshot must keep.
    let spare = w.create_body(&BodyDef { position: v2(30.0, 5.0), ..Default::default() }).unwrap();
    w.create_shape(spare, Core::circle(V2::ZERO, 0.3).unwrap(), &ShapeDef::default()).unwrap();
    w.remove_body(spare).unwrap();
    w
}

fn hash(w: &World) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut eat = |v: u64| {
        h ^= v;
        h = h.wrapping_mul(0x100_0000_01b3);
    };
    for b in &w.bodies {
        for v in [b.xf.p.x, b.xf.p.y, b.xf.q.c, b.xf.q.s, b.linear_velocity.x, b.linear_velocity.y, b.angular_velocity] {
            eat(v.to_bits() as u64);
        }
        eat(b.awake as u64);
    }
    for c in &w.contacts {
        eat(c.manifold.count as u64);
        for v in [c.normal_impulse[0], c.normal_impulse[1], c.tangent_impulse[0]] {
            eat(v.to_bits() as u64);
        }
    }
    h
}

#[test]
fn a_restored_world_steps_bit_for_bit_as_the_original() {
    for taken_at in [0usize, 7, 90, 400] {
        let mut a = scene();
        for _ in 0..taken_at {
            a.step(DT).unwrap();
        }
        let bytes = a.snapshot();
        let mut b = World::from_snapshot(&bytes).unwrap();
        assert_eq!(hash(&a), hash(&b), "restored state at {taken_at}");
        assert_eq!(a.snapshot(), b.snapshot(), "a snapshot of the restored world is the same bytes");
        for step in 0..150 {
            a.step(DT).unwrap();
            b.step(DT).unwrap();
            assert_eq!(hash(&a), hash(&b), "taken at {taken_at}, step {step}");
            assert_eq!(a.events, b.events, "events agree");
        }
    }
}

#[test]
fn bad_snapshots_are_refused() {
    let bytes = scene().snapshot();
    for cut in [0, 3, 8, bytes.len() / 2, bytes.len() - 1] {
        assert!(World::from_snapshot(&bytes[..cut]).is_err(), "cut at {cut}");
    }
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(World::from_snapshot(&longer).is_err());
    let mut foreign = bytes.clone();
    foreign[0] ^= 1;
    assert!(World::from_snapshot(&foreign).is_err());
    // Flipping bytes at many places never panics: the world comes back or an error does.
    for at in (0..bytes.len()).step_by(37) {
        let mut hurt = bytes.clone();
        hurt[at] ^= 0x5a;
        let _ = World::from_snapshot(&hurt);
    }
}

#[test]
fn a_world_with_added_mass_keeps_it() {
    let mut w = World::default();
    let b = w.create_body(&BodyDef::default()).unwrap();
    w.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let (m, i) = (w.bodies[b as usize].mass, w.bodies[b as usize].inertia);
    w.set_additional_mass(b, 3.0).unwrap();
    assert!((w.bodies[b as usize].mass - (m + 3.0)).abs() < 1e-5);
    assert!((w.bodies[b as usize].inertia - i * (m + 3.0) / m).abs() < 1e-4);
    let r = World::from_snapshot(&w.snapshot()).unwrap();
    assert_eq!(r.bodies[b as usize].mass, w.bodies[b as usize].mass);
    w.set_additional_mass(b, 0.0).unwrap();
    assert!((w.bodies[b as usize].mass - m).abs() < 1e-6);
    assert!(w.set_additional_mass(b, -1.0).is_err());
}
