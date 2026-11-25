// Which hook question a pair asks: the contact filter of a pair of solids, the intersection filter of a pair with a sensor in it
// (Rapier's FILTER_CONTACT_PAIRS and FILTER_INTERSECTION_PAIRS), and only for shapes that ask.
use std::cell::RefCell;
use std::rc::Rc;

use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, ContactMod, HOOK_FILTER, HOOK_INTERSECTION, Hook, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

/// Records each pair it is asked about and answers `allow`.
struct Recorder {
    asked: Rc<RefCell<Vec<(u32, u32)>>>,
    allow: bool,
}

impl Hook for Recorder {
    fn filter(&mut self, a: u32, b: u32) -> bool {
        self.asked.borrow_mut().push((a, b));
        self.allow
    }
    fn contact(&mut self, _: &mut ContactMod) {}
}

/// A sensor circle and a solid one, each overlapping a ball, in no gravity: (world, asked, [sensor, solid, ball in the sensor, ball at the solid]).
fn scene(sensor_hooks: u8, solid_hooks: u8, ball_hooks: u8, allow: bool) -> (World, Rc<RefCell<Vec<(u32, u32)>>>, [u32; 4]) {
    let mut w = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
    let asked = Rc::new(RefCell::new(Vec::new()));
    w.hook = Some(Box::new(Recorder { asked: asked.clone(), allow }));
    let mut shape = |w: &mut World, at: V2, sensor: bool, hooks: u8| {
        let b = w.create_body(&BodyDef { kind: Kind::Static, position: at, ..Default::default() }).unwrap();
        w.create_shape(b, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef { sensor, hooks, events: 3, ..Default::default() }).unwrap()
    };
    let zone = shape(&mut w, v2(0.0, 0.0), true, sensor_hooks);
    let wall = shape(&mut w, v2(10.0, 0.0), false, solid_hooks);
    // Two balls, one in the zone and one against the wall, both dynamic.
    let mut ball = |w: &mut World, at: V2| {
        let b = w.create_body(&BodyDef { position: at, can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef { density: 1.0, hooks: ball_hooks, events: 3, ..Default::default() }).unwrap()
    };
    let in_zone = ball(&mut w, v2(0.5, 0.0));
    let at_wall = ball(&mut w, v2(10.5, 0.0));
    w.step(DT).unwrap();
    (w, asked, [zone, wall, in_zone, at_wall])
}

#[test]
fn a_sensor_pair_asks_the_intersection_filter_and_a_solid_pair_the_contact_filter() {
    // The ball asks for the contact filter only: the sensor pair is not asked about, the solid one is.
    let (_, asked, ids) = scene(0, 0, HOOK_FILTER, true);
    let asked = asked.borrow();
    assert!(asked.iter().all(|&(a, b)| a != ids[0] && b != ids[0]), "the contact filter was asked of a sensor pair: {asked:?}");
    assert!(asked.iter().any(|&(a, b)| a == ids[1] || b == ids[1]), "and not of the solid pair either: {asked:?}");
    // The ball asks for the intersection filter only: the sensor pair is asked, the solid one is not.
    let (_, asked, ids) = scene(0, 0, HOOK_INTERSECTION, true);
    let asked = asked.borrow();
    assert!(asked.iter().any(|&(a, b)| a == ids[0] || b == ids[0]), "the intersection filter was not asked of the sensor pair: {asked:?}");
    assert!(asked.iter().all(|&(a, b)| a != ids[1] && b != ids[1]), "the intersection filter was asked of a solid pair: {asked:?}");
}

#[test]
fn a_vetoed_intersection_reports_no_overlap() {
    let (w, _, _) = scene(0, 0, HOOK_INTERSECTION, false);
    assert!(w.events.iter().all(|e| !e.sensor), "a vetoed intersection was reported: {:?}", w.events);
    let (w, _, _) = scene(0, 0, HOOK_INTERSECTION, true);
    assert!(w.events.iter().any(|e| e.sensor), "an allowed one was not");
}
