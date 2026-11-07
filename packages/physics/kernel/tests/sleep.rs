// Islands against a plain search of the graph, and sleeping against what each rule of the policy promises.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};
use std::collections::{BTreeMap, BTreeSet};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

struct Random(u32);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    fn range(&mut self, low: f32, high: f32) -> f32 {
        low + (high - low) * (self.next() >> 8) as f32 / 16_777_216.0
    }
}

fn free_world(bodies: u32) -> World {
    let mut w = World::new(bodies, bodies).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    w
}
fn ball(w: &mut World, kind: u32, x: f32) -> u32 {
    let body = w.add_body(kind).unwrap();
    w.add_collider(body, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, if kind == DYNAMIC { 1.0 } else { 0.0 }).unwrap();
    w.set_v(POSITION_X, body as usize, v3(x, 0.0, 0.0));
    body
}
fn asleep(w: &World, body: u32) -> bool {
    w.flags(body as usize) & SLEEPING != 0
}

/// The lists, the rings and the islands must agree with the plain facts, whatever happened before.
fn check(w: &World) {
    let header = w.header();
    let mut expected_awake = BTreeSet::new();
    for body in 0..header.rows {
        let flags = w.flags(body as usize);
        if flags & ALIVE != 0 && flags & KIND != FIXED && flags & SLEEPING == 0 {
            expected_awake.insert(body);
        }
    }
    let mut awake = BTreeSet::new();
    for slot in 0..header.awake {
        let body = w.uu(AWAKE, slot as usize);
        assert_eq!(w.uu(AWAKE_SLOT, body as usize), slot);
        assert!(awake.insert(body), "body {body} listed twice");
    }
    assert_eq!(awake, expected_awake);
    // Each sleeper sits on a ring of sleepers.
    for body in 0..header.rows {
        if w.flags(body as usize) & ALIVE != 0 && asleep(w, body) {
            assert_eq!(w.uu(AWAKE_SLOT, body as usize), NONE);
            let mut at = w.uu(ISLAND_NEXT, body as usize);
            let mut steps = 0;
            while at != body {
                assert!(asleep(w, at));
                at = w.uu(ISLAND_NEXT, at as usize);
                steps += 1;
                assert!(steps <= header.rows);
            }
        } else {
            assert_eq!(w.uu(ISLAND_NEXT, body as usize), NONE);
        }
    }
    // The active list is exactly the pairs with an awake body.
    let mut expected_active = BTreeSet::new();
    for row in 0..header.pair_rows {
        if w.uu(PAIR_A, row as usize) != NONE {
            let (a, b) = w.pair_bodies(row);
            if awake.contains(&(a as u32)) || awake.contains(&(b as u32)) {
                expected_active.insert(row);
            }
        }
    }
    let mut active = BTreeSet::new();
    for slot in 0..header.active_pairs {
        let row = w.uu(ACTIVE_PAIRS, slot as usize);
        assert_eq!(w.uu(PAIR_SLOT, row as usize), slot);
        active.insert(row);
    }
    assert_eq!(active, expected_active);
}

/// Islands by a plain depth-first search over awake dynamic bodies and the pairs between them, as sets of bodies.
fn components(w: &World) -> BTreeSet<BTreeSet<u32>> {
    let mut edges: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let dynamic = |body: usize| w.flags(body) & KIND == DYNAMIC;
    for slot in 0..w.header().awake {
        let body = w.uu(AWAKE, slot as usize);
        if dynamic(body as usize) {
            edges.entry(body).or_default();
        }
    }
    for slot in 0..w.header().active_pairs {
        let (a, b) = w.pair_bodies(w.uu(ACTIVE_PAIRS, slot as usize));
        if dynamic(a) && dynamic(b) {
            edges.entry(a as u32).or_default().push(b as u32);
            edges.entry(b as u32).or_default().push(a as u32);
        }
    }
    let mut seen = BTreeSet::new();
    let mut out = BTreeSet::new();
    for &start in edges.keys() {
        if seen.insert(start) {
            let (mut stack, mut group) = (vec![start], BTreeSet::new());
            while let Some(body) = stack.pop() {
                group.insert(body);
                for &other in &edges[&body] {
                    if seen.insert(other) {
                        stack.push(other);
                    }
                }
            }
            out.insert(group);
        }
    }
    out
}

/// The islands the kernel says, by its runs, also checking each body's island number.
fn islands(w: &World) -> BTreeSet<BTreeSet<u32>> {
    let mut out = BTreeSet::new();
    for island in 0..w.header().islands as usize {
        let start = w.uu(ISLAND_START, island) as usize;
        let group: BTreeSet<u32> = (0..w.uu(ISLAND_COUNT, island) as usize).map(|i| w.uu(ISLAND_BODIES, start + i)).collect();
        for &body in &group {
            assert_eq!(w.uu(ISLAND_ID, body as usize) as usize, island);
        }
        out.insert(group);
    }
    out
}

#[test]
fn islands_are_the_connected_groups_of_random_scenes() {
    let mut w = free_world(200);
    let mut r = Random(4242);
    let mut bodies = vec![];
    for i in 0..200 {
        let kind = if i % 11 == 0 { FIXED } else if i % 13 == 0 { KINEMATIC_VELOCITY } else { DYNAMIC };
        let body = ball(&mut w, kind, 0.0);
        w.set_v(POSITION_X, body as usize, v3(r.range(-12.0, 12.0), r.range(-12.0, 12.0), r.range(-12.0, 12.0)));
        if kind != FIXED {
            w.set_v(LINEAR_X, body as usize, v3(r.range(-3.0, 3.0), r.range(-3.0, 3.0), r.range(-3.0, 3.0)));
        }
        bodies.push(body);
    }
    let mut sizes = BTreeSet::new();
    for _ in 0..240 {
        for &body in &bodies {
            let at = body as usize;
            let (position, mut velocity) = (w.v(POSITION_X, at), w.v(LINEAR_X, at));
            if position.dot(position) > 200.0 {
                velocity = velocity.scale(-1.0);
            }
            w.set_v(LINEAR_X, at, velocity);
        }
        w.step(DT);
        check(&w);
        let found = islands(&w);
        assert_eq!(found, components(&w));
        sizes.extend(found.iter().map(|group| group.len()));
    }
    assert!(sizes.iter().any(|&size| size >= 3), "scenes must hold real groups: {sizes:?}");
}

#[test]
fn fixed_and_kinematic_bodies_join_no_island() {
    // Erleben 2005: such a body is an insulator, so what touches it on two sides stays two groups.
    for kind in [FIXED, KINEMATIC_VELOCITY] {
        let mut w = free_world(3);
        let (a, b) = (ball(&mut w, DYNAMIC, -0.8), ball(&mut w, DYNAMIC, 0.8));
        ball(&mut w, kind, 0.0);
        w.step(DT);
        assert_eq!(w.header().pairs, 2);
        assert_eq!(w.header().islands, 2);
        assert_ne!(w.uu(ISLAND_ID, a as usize), w.uu(ISLAND_ID, b as usize));
    }
}

#[test]
fn a_still_body_sleeps_after_the_window_and_then_costs_nothing() {
    let mut w = free_world(1);
    let body = ball(&mut w, DYNAMIC, 0.0);
    let mut steps = 0;
    while !asleep(&w, body) {
        w.step(DT);
        steps += 1;
        assert!(steps < 100);
    }
    // The window of 0.5 s at 1/60 s: thirty steps, give or take f32 rounding of the sum.
    assert!((30..=31).contains(&steps), "{steps}");
    assert_eq!(w.header().awake, 0);
    assert_eq!(w.header().islands, 0);
    let before = w.v(POSITION_X, body as usize);
    for _ in 0..100 {
        w.step(DT);
    }
    assert_eq!(w.v(POSITION_X, body as usize), before);
    assert!(asleep(&w, body));
}

#[test]
fn a_ball_at_the_top_of_its_flight_does_not_sleep() {
    // Erleben 2005's classic failure: the speed passes through zero, so the test must hold across a window.
    let mut w = World::new(1, 1).unwrap();
    let body = ball(&mut w, DYNAMIC, 0.0);
    w.set_v(LINEAR_X, body as usize, v3(0.0, 2.0, 0.0));
    for _ in 0..200 {
        w.step(DT);
        assert!(!asleep(&w, body));
    }
}

#[test]
fn a_body_that_gathers_energy_stays_awake_however_slowly() {
    // Under the threshold the whole time, rising: the relative test of Erleben 2005 keeps it awake, and when the rise
    // stops the next full window sends it to sleep.
    let mut w = free_world(1);
    let body = ball(&mut w, DYNAMIC, 0.0);
    let limit = (2.0 * w.header().sleep_energy).sqrt();
    let steps = 200;
    for step in 0..steps {
        w.set_v(LINEAR_X, body as usize, v3(limit * 0.9 * step as f32 / steps as f32, 0.0, 0.0));
        w.step(DT);
        assert!(!asleep(&w, body), "step {step}");
    }
    let mut left = 70;
    while !asleep(&w, body) {
        w.step(DT);
        left -= 1;
        assert!(left > 0, "a steady slow body must sleep");
    }
}

#[test]
fn a_force_keeps_a_body_awake() {
    let mut w = free_world(1);
    let body = ball(&mut w, DYNAMIC, 0.0);
    w.set_v(FORCE_X, body as usize, v3(1e-9, 0.0, 0.0));
    for _ in 0..100 {
        w.step(DT);
    }
    assert!(!asleep(&w, body));
}

#[test]
fn a_body_that_may_not_sleep_keeps_its_island_awake() {
    let mut w = free_world(2);
    let (a, b) = (ball(&mut w, DYNAMIC, -0.2), ball(&mut w, DYNAMIC, 0.2));
    let flags = w.flags(a as usize) & !CAN_SLEEP;
    w.set_u(FLAGS, a as usize, flags);
    for _ in 0..100 {
        w.step(DT);
    }
    assert!(!asleep(&w, a) && !asleep(&w, b));
}

#[test]
fn an_island_sleeps_only_when_all_its_bodies_are_ready() {
    let mut w = free_world(3);
    let (a, b, c) = (ball(&mut w, DYNAMIC, 0.0), ball(&mut w, DYNAMIC, 0.7), ball(&mut w, DYNAMIC, 1.4));
    w.set_v(ANGULAR_X, c as usize, v3(0.0, 1.0, 0.0));
    for _ in 0..120 {
        w.step(DT);
    }
    assert!(!asleep(&w, a) && !asleep(&w, b) && !asleep(&w, c), "the spinning end holds the chain awake");
    w.set_v(ANGULAR_X, c as usize, v3(0.0, 0.0, 0.0));
    for _ in 0..40 {
        w.step(DT);
        assert_eq!(asleep(&w, a), asleep(&w, c), "all together or none");
    }
    assert!(asleep(&w, b));
    check(&w);
}

#[test]
fn a_moving_body_wakes_the_whole_island_it_reaches() {
    let mut w = free_world(102);
    let chain: Vec<u32> = (0..100).map(|i| ball(&mut w, DYNAMIC, i as f32 * 0.7)).collect();
    for _ in 0..40 {
        w.step(DT);
    }
    assert!(chain.iter().all(|&b| asleep(&w, b)));
    assert_eq!(w.header().active_pairs, 0);
    assert_eq!(w.header().pairs, 99);
    let comet = ball(&mut w, DYNAMIC, -5.0);
    w.set_v(LINEAR_X, comet as usize, v3(40.0, 0.0, 0.0));
    for _ in 0..3 {
        w.step(DT);
    }
    assert!(chain.iter().all(|&b| asleep(&w, b)), "not there yet");
    let mut steps = 0;
    while asleep(&w, chain[99]) {
        w.step(DT);
        steps += 1;
        assert!(steps < 30);
    }
    assert!(chain.iter().all(|&b| !asleep(&w, b)));
    check(&w);
    assert_eq!(islands(&w), components(&w));
}

#[test]
fn a_moving_kinematic_body_keeps_what_it_touches_awake_and_a_still_one_does_not() {
    let mut w = free_world(2);
    let dynamic = ball(&mut w, DYNAMIC, 0.0);
    let kinematic = ball(&mut w, KINEMATIC_VELOCITY, 0.8);
    for _ in 0..40 {
        w.step(DT);
    }
    assert!(asleep(&w, dynamic), "a still kinematic body lets it sleep");
    check(&w);
    w.set_v(LINEAR_X, kinematic as usize, v3(0.0, 0.001, 0.0));
    w.step(DT);
    assert!(!asleep(&w, dynamic), "it starts to move: the sleeper wakes");
    for _ in 0..100 {
        w.step(DT);
        assert!(!asleep(&w, dynamic));
    }
    w.set_v(LINEAR_X, kinematic as usize, v3(0.0, 0.0, 0.0));
    for _ in 0..40 {
        w.step(DT);
    }
    assert!(asleep(&w, dynamic));
}

#[test]
fn removing_a_sleeper_or_changing_its_colliders_wakes_its_island() {
    let setup = || {
        let mut w = free_world(3);
        let (a, b) = (ball(&mut w, DYNAMIC, 0.0), ball(&mut w, DYNAMIC, 0.7));
        for _ in 0..40 {
            w.step(DT);
        }
        assert!(asleep(&w, a) && asleep(&w, b));
        (w, a, b)
    };
    let (mut w, a, b) = setup();
    assert!(w.remove_body(a));
    assert!(!asleep(&w, b));
    w.step(DT);
    check(&w);
    assert_eq!(w.header().pairs, 0);

    let (mut w, a, b) = setup();
    assert!(w.remove_collider(w.uu(FIRST_COLLIDER, a as usize)));
    assert!(!asleep(&w, b));
    w.step(DT);
    check(&w);

    let (mut w, a, b) = setup();
    w.add_collider(a, SHAPE_BALL, [0.1, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    assert!(!asleep(&w, b));
    w.step(DT);
    check(&w);

    let (mut w, a, b) = setup();
    w.touch_body(b);
    assert!(!asleep(&w, a));
    check(&w);

    let (mut w, a, b) = setup();
    w.wake(a);
    assert!(!asleep(&w, b));
    w.wake(a);
    check(&w);
}

#[test]
fn a_sleep_request_takes_a_body_down_with_its_island() {
    let mut w = free_world(2);
    let body = ball(&mut w, DYNAMIC, 0.0);
    w.set_v(LINEAR_X, body as usize, v3(5.0, 0.0, 0.0));
    w.request_sleep(body);
    w.step(DT);
    assert!(asleep(&w, body));
    assert_eq!(w.v(LINEAR_X, body as usize), v3(0.0, 0.0, 0.0));
    let (previous, position) = (w.v(PREVIOUS_X, body as usize), w.v(POSITION_X, body as usize));
    assert_eq!(previous, position, "interpolation holds a sleeper still");
}

#[test]
fn sleepers_in_a_random_churn_keep_every_list_true() {
    let run = |bodies: u32, colliders: u32| {
        let mut w = World::new(bodies, colliders).unwrap();
        w.header_mut().gravity = [0.0, 0.0, 0.0];
        let mut r = Random(31337);
        let mut alive = vec![];
        let mut trace = vec![];
        for step in 0..1500 {
            match r.next() % 16 {
                0 | 1 if alive.len() < 150 => {
                    w.reserve(w.header().rows + 1, w.header().collider_rows + 1);
                    let body = ball(&mut w, if r.next() % 9 == 0 { FIXED } else { DYNAMIC }, 0.0);
                    w.set_v(POSITION_X, body as usize, v3(r.range(-6.0, 6.0), r.range(-6.0, 6.0), r.range(-6.0, 6.0)));
                    w.touch_body(body);
                    alive.push(body);
                }
                2 if alive.len() > 5 => {
                    let body = alive.swap_remove((r.next() as usize) % alive.len());
                    assert!(w.remove_body(body));
                }
                3 if !alive.is_empty() => {
                    let body = alive[(r.next() as usize) % alive.len()];
                    w.wake(body);
                    if w.flags(body as usize) & KIND == DYNAMIC {
                        w.set_v(LINEAR_X, body as usize, v3(r.range(-4.0, 4.0), r.range(-4.0, 4.0), 0.0));
                    }
                }
                4 if !alive.is_empty() => {
                    let body = alive[(r.next() as usize) % alive.len()];
                    w.request_sleep(body);
                }
                5 => {
                    // Brakes everything, so groups fall asleep often.
                    for &body in &alive {
                        if w.flags(body as usize) & KIND == DYNAMIC {
                            w.set_v(LINEAR_X, body as usize, v3(0.0, 0.0, 0.0));
                        }
                    }
                }
                _ => {}
            }
            w.step(DT);
            if bodies == 1 {
                check(&w);
                assert_eq!(islands(&w), components(&w), "step {step}");
            }
            trace.push((w.header().awake, w.header().active_pairs, w.header().islands));
        }
        assert!(trace.iter().any(|t| t.0 < 40), "sleep must really happen: {:?}", trace.last());
        trace
    };
    assert_eq!(run(1, 1), run(3000, 3000));
}
