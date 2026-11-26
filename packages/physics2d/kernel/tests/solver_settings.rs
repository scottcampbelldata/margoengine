// Solver settings Rapier has that the 2D kernel gained (D2-04): the warm start share, the allowed penetration, the
// prediction distance and a contact spring of its own for contacts with fixed bodies. Each changes what it says and
// nothing else: at their defaults every step is bit for bit the one before they existed (the pinned scenes, tests/bits.rs).
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

/// A 0.5 m box dropped onto a floor (top at y 0) with these settings; returns the world and the box.
fn box_on_floor(settings: Settings, drop: f32, steps: usize) -> (World, u32) {
    let mut w = World::new(Settings { gravity: v2(0.0, -9.81), ..settings });
    let floor = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(floor, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let b = w.create_body(&BodyDef { position: v2(0.0, 0.25 + drop), can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(b, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 50.0, ..Default::default() }).unwrap();
    for _ in 0..steps {
        w.step(DT).unwrap();
    }
    (w, b)
}

#[test]
fn an_allowed_penetration_lets_a_resting_box_overlap_the_floor_by_it() {
    let rest = |allowed: f32| box_on_floor(Settings { allowed_penetration: allowed, ..Default::default() }, 0.0, 240).0.bodies[1].xf.p.y;
    let plain = rest(0.0);
    for allowed in [0.01f32, 0.03] {
        let sink = plain - rest(allowed);
        assert!((sink - allowed).abs() < 0.002, "allowed {allowed}: rests {sink} m lower");
    }
}

#[test]
fn a_longer_prediction_distance_gives_a_hovering_box_contact_points_and_the_default_does_not() {
    // Held 5 cm above the floor (no gravity): within 0.1 m, not within the default 0.02 m.
    let points = |reach: f32| {
        let mut w = World::new(Settings { gravity: V2::ZERO, prediction_distance: reach, ..Default::default() });
        let floor = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
        w.create_shape(floor, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let b = w.create_body(&BodyDef { position: v2(0.0, 0.3), can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(b, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        w.step(DT).unwrap();
        w.contacts.iter().map(|c| c.manifold.count).sum::<usize>()
    };
    assert_eq!(points(0.02), 0);
    assert!(points(0.1) > 0);
}

#[test]
fn less_warm_start_lets_a_stack_sag_more() {
    // A single box on a floor is solved exactly by one pass whatever it starts from, so the test stacks ten: with one pass
    // a substep the impulse carried from the last step is what holds the upper boxes up.
    let sag = |share: f32| {
        let mut w = World::new(Settings { gravity: v2(0.0, -9.81), warm_start: share, substeps: 1, passes: 1, ..Default::default() });
        let floor = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
        w.create_shape(floor, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let mut top = 0;
        for i in 0..10 {
            let b = w.create_body(&BodyDef { position: v2(0.0, 0.25 + 0.5 * i as f32), can_sleep: false, ..Default::default() }).unwrap();
            w.create_shape(b, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
            top = b;
        }
        for _ in 0..120 {
            w.step(DT).unwrap();
        }
        4.75 - w.bodies[top as usize].xf.p.y
    };
    let (full, half, none) = (sag(1.0), sag(0.5), sag(0.0));
    // Without the full carried impulse the stack sinks into itself (half and none are both far below; which of the two
    // sinks further depends on how the collapsed boxes land, so the test does not order them).
    assert!(none > full + 0.2 && half > full + 0.2, "sag with no warm start {none}, half {half}, full {full}");
}

#[test]
fn a_soft_static_spring_sinks_a_box_on_the_floor_and_leaves_a_dynamic_pair_alone() {
    let sink = |hz: Option<f32>| {
        let (w, b) = box_on_floor(Settings { static_contact_hertz: hz, static_contact_damping: hz.map(|_| 0.5), ..Default::default() }, 0.5, 30);
        0.25 - w.bodies[b as usize].xf.p.y
    };
    assert!(sink(Some(2.0)) > sink(None) + 0.01, "soft {} against {}", sink(Some(2.0)), sink(None));
    // A box resting on a dynamic box resting on the floor: the static spring changes only the lower pair, so with the floor's
    // pair made a rigid joint-free weld... the upper box's contact with the lower one takes the contact spring either way.
    let stack = |hz: Option<f32>| {
        let mut w = World::new(Settings { gravity: v2(0.0, -9.81), static_contact_hertz: hz, ..Default::default() });
        let low = w.create_body(&BodyDef { kind: Kind::Kinematic, position: v2(0.0, 0.25), ..Default::default() }).unwrap();
        w.create_shape(low, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let mid = w.create_body(&BodyDef { position: v2(0.0, 0.75), can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(mid, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let top = w.create_body(&BodyDef { position: v2(3.0, 0.75), can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(top, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let top2 = w.create_body(&BodyDef { position: v2(3.0, 1.25), can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(top2, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        for _ in 0..60 {
            w.step(DT).unwrap();
        }
        // The pair of two dynamic boxes (top, top2) falls free and lands on nothing fixed: its relative pose must not depend
        // on the static spring at all.
        let (a, b) = (w.bodies[top as usize].xf.p, w.bodies[top2 as usize].xf.p);
        (b.y - a.y).to_bits()
    };
    assert_eq!(stack(None), stack(Some(2.0)), "a pair of two dynamic bodies takes the contact spring whatever the static one");
}

#[test]
fn a_snapshot_keeps_the_new_settings() {
    let s = Settings {
        warm_start: 0.25,
        allowed_penetration: 0.004,
        prediction_distance: 0.05,
        static_contact_hertz: Some(7.0),
        static_contact_damping: None,
        ..Default::default()
    };
    let (w, _) = box_on_floor(s, 0.1, 10);
    let back = World::from_snapshot(&w.snapshot()).unwrap();
    let t = back.settings;
    assert_eq!((t.warm_start, t.allowed_penetration, t.prediction_distance), (0.25, 0.004, 0.05));
    assert_eq!((t.static_contact_hertz, t.static_contact_damping), (Some(7.0), None));
}
