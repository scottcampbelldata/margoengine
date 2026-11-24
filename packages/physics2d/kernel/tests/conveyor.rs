// A hook can give a contact a tangent speed: the bodies slide against each other at that relative speed, a conveyor belt.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, ContactMod, HOOK_CONTACT, Hook, Kind, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

struct Belt {
    speed: f32,
    belt_shape: u32,
}

impl Hook for Belt {
    fn filter(&mut self, _: u32, _: u32) -> bool {
        true
    }
    fn contact(&mut self, change: &mut ContactMod) {
        // The speed is of B against A along the right of the normal, which runs from A to B: with the belt as A that is
        // +x for a normal pointing up; with the belt as B the sign turns.
        change.tangent_speed = if change.a == self.belt_shape { self.speed } else { -self.speed };
    }
}

fn scene(speed: Option<f32>) -> (World, u32) {
    let mut w = World::default();
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let belt = w.create_shape(ground, Core::rect(20.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef { hooks: if speed.is_some() { HOOK_CONTACT } else { 0 }, friction: 1.0, ..Default::default() }).unwrap();
    let crate_ = w.create_body(&BodyDef { position: v2(0.0, 0.5), can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(crate_, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { friction: 1.0, ..Default::default() }).unwrap();
    if let Some(speed) = speed {
        w.hook = Some(Box::new(Belt { speed, belt_shape: belt }));
    }
    (w, crate_)
}

#[test]
fn a_box_is_carried_at_the_belts_speed() {
    let (mut w, b) = scene(Some(3.0));
    for _ in 0..180 {
        w.step(DT).unwrap();
    }
    let body = &w.bodies[b as usize];
    assert!((body.linear_velocity.x - 3.0).abs() < 0.05, "carried at {}", body.linear_velocity.x);
    assert!(body.xf.p.x > 4.0, "and moved along: {}", body.xf.p.x);
    assert!((body.xf.p.y - 0.5).abs() < 0.02);
    let (mut w, b) = scene(Some(-2.0));
    for _ in 0..180 {
        w.step(DT).unwrap();
    }
    assert!((w.bodies[b as usize].linear_velocity.x + 2.0).abs() < 0.05, "the other way: {}", w.bodies[b as usize].linear_velocity.x);
}

#[test]
fn a_belt_that_does_not_move_changes_nothing_by_a_bit() {
    let hash = |w: &World| -> Vec<u32> { w.bodies.iter().flat_map(|b| [b.xf.p.x.to_bits(), b.xf.p.y.to_bits(), b.linear_velocity.x.to_bits(), b.linear_velocity.y.to_bits(), b.angular_velocity.to_bits()]).collect() };
    let (mut plain, _) = scene(None);
    let (mut hooked, _) = scene(Some(0.0));
    for step in 0..240 {
        plain.step(DT).unwrap();
        hooked.step(DT).unwrap();
        assert_eq!(hash(&plain), hash(&hooked), "step {step}");
    }
}
