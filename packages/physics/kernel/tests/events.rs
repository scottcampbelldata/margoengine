// Contact forces against what mechanics says, on the world's defaults: 8 substeps, 2 passes, 60 Hz steps.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;
const G: f64 = 9.81;

fn world(bodies: u32) -> World {
    World::new(bodies, bodies).unwrap()
}
fn floor(w: &mut World) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [50.0, 0.5, 50.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, body as usize, v3(0.0, -0.5, 0.0));
    body
}
fn block(w: &mut World, half: [f32; 3], at: V3, density: f32) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, half, [0.0; 3], IDENTITY, density).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    body
}
/// The normal impulse between two bodies in the last step.
fn force(w: &World, a: u32, b: u32) -> f64 {
    let mut sum = 0.0;
    for i in 0..w.header().solving as usize {
        let row = w.uu(SOLVE_PAIRS, i);
        let (one, other) = w.pair_bodies(row);
        if (one, other) == (a as usize, b as usize) || (one, other) == (b as usize, a as usize) {
            sum += w.s(PAIR_FORCE, row as usize) as f64;
        }
    }
    sum
}

#[test]
fn a_resting_stack_presses_with_the_weight_above_each_contact() {
    let mut w = world(4);
    let ground = floor(&mut w);
    let (lower, upper) = (block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 2.0), block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 1.5, 0.0), 1.0));
    for _ in 0..120 {
        w.step(DT);
    }
    // A cubic metre each: the upper block is 1 kg, the lower 2 kg.
    let (over, under) = (force(&w, lower, upper) / DT as f64, force(&w, ground, lower) / DT as f64);
    println!("stack forces: {over:.4} and {under:.4} N of {:.4} and {:.4}", G, 3.0 * G);
    assert!((over / G - 1.0).abs() < 1e-3, "{over}");
    assert!((under / (3.0 * G) - 1.0).abs() < 1e-3, "{under}");
}

#[test]
fn a_landing_gives_the_impulse_that_stops_it() {
    // A block dropped onto the floor with no bounce. Momentum: every impulse the floor gives adds to what gravity takes, so
    // from the drop to rest the floor's impulses add up to m g t.
    let mut w = world(4);
    let ground = floor(&mut w);
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 2.5, 0.0), 1.0);
    let (mut sum, mut peak) = (0.0f64, 0.0f64);
    let steps = 120;
    for _ in 0..steps {
        w.step(DT);
        let impulse = force(&w, ground, body);
        sum += impulse;
        peak = peak.max(impulse);
    }
    let want = G * steps as f64 * DT as f64;
    let speed = w.v(LINEAR_X, body as usize).y as f64;
    println!("landing: impulses add to {sum:.5} of {want:.5}, largest {peak:.4}, speed left {speed:.6}");
    assert!((sum / want - 1.0).abs() < 1e-3, "{sum} against {want}");
    // The speed at the floor is sqrt(2 g 2), 6.26 m/s; the first step of contact stops most of it.
    assert!(peak > 5.0, "{peak}");
}

#[test]
fn a_pair_without_contact_gives_nothing() {
    let mut w = world(4);
    let ground = floor(&mut w);
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 5.0, 0.0), 1.0);
    w.step(DT);
    assert_eq!(force(&w, ground, body), 0.0);
}

/// What the last steps said since the list was last read: (first collider, second, started, sensor).
fn events(w: &mut World) -> Vec<(u32, u32, bool, bool)> {
    let mut out = vec![];
    for i in 0..w.header().events as usize {
        let (word, b) = (w.uu(EVENTS, 2 * i), w.uu(EVENTS, 2 * i + 1));
        out.push((word & EVENT_COLLIDER, b, word & EVENT_STARTED != 0, word & EVENT_SENSOR != 0));
    }
    w.header_mut().events = 0;
    out
}
fn first_collider(w: &World, body: u32) -> u32 {
    w.uu(FIRST_COLLIDER, body as usize)
}
fn sensor_box(w: &mut World, kind: u32, half: [f32; 3], at: V3) -> (u32, u32) {
    let body = w.add_body(kind).unwrap();
    let collider = w.add_collider(body, SHAPE_BOX, half, [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_collider_state(collider, COLLIDER_SENSOR);
    (body, collider)
}
fn pack(memberships: u32, filter: u32) -> u32 {
    memberships << 16 | filter
}

#[test]
fn a_ball_through_a_sensor_says_when_it_enters_and_leaves_and_feels_nothing() {
    let mut w = world(4);
    let (_, trigger) = sensor_box(&mut w, FIXED, [2.0, 0.25, 2.0], v3(0.0, 3.0, 0.0));
    let ball = block(&mut w, [0.3, 0.3, 0.3], v3(0.0, 6.0, 0.0), 1.0);
    let mine = first_collider(&w, ball);
    let (mut entered, mut left) = (None, None);
    for step in 1..=90u32 {
        w.step(DT);
        for (a, b, started, sensor) in events(&mut w) {
            assert!(sensor && [a, b].contains(&trigger) && [a, b].contains(&mine));
            if started {
                assert!(entered.replace(step).is_none(), "entered twice");
            } else {
                assert!(left.replace(step).is_none(), "left twice");
            }
        }
    }
    // Free fall: the bottom of the box reaches 3.25 after sqrt(2 (6 - 0.3 - 3.25) / g) and the top leaves 2.75 after
    // sqrt(2 (6 + 0.3 - 2.75) / g). A sensor sees the pose a step starts from, so up to one step later.
    let at = |drop: f64| (2.0 * drop / G).sqrt() * 60.0;
    let (entered, left) = (entered.unwrap() as f64, left.unwrap() as f64);
    println!("sensor: entered at {entered} of {:.1}, left at {left} of {:.1}", at(2.45), at(3.55));
    assert!(entered >= at(2.45) && entered <= at(2.45) + 2.0, "{entered}");
    assert!(left >= at(3.55) && left <= at(3.55) + 2.0, "{left}");
    let free = G * 90.0 * DT as f64;
    let speed = -w.v(LINEAR_X, ball as usize).y as f64;
    assert!((speed / free - 1.0).abs() < 1e-3, "the sensor pushed: {speed} of {free}");
}

#[test]
fn a_sensor_sees_kinematic_and_fixed_bodies() {
    // A kinematic body walks through a fixed sensor; a kinematic sensor walks over a fixed box.
    let mut w = world(8);
    let (_, trigger) = sensor_box(&mut w, FIXED, [0.5, 1.0, 1.0], v3(3.0, 1.0, 0.0));
    let walker = w.add_body(KINEMATIC_POSITION).unwrap();
    w.add_collider(walker, SHAPE_BOX, [0.3, 0.7, 0.3], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(walker, v3(0.0, 1.0, 0.0), Q::IDENTITY, false);
    let wall = w.add_body(FIXED).unwrap();
    let solid = w.add_collider(wall, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(wall, v3(3.0, 10.0, 0.0), Q::IDENTITY, false);
    let (walking_sensor, moving) = sensor_box(&mut w, KINEMATIC_POSITION, [0.2, 0.2, 0.2], v3(0.0, 10.0, 0.0));
    let mut log = vec![];
    for step in 1..=120 {
        let x = 0.1 * step as f32;
        w.set_v(TARGET_X, walker as usize, v3(x, 1.0, 0.0));
        w.set_v(TARGET_X, walking_sensor as usize, v3(x, 10.0, 0.0));
        w.step(DT);
        for (a, b, started, sensor) in events(&mut w) {
            assert!(sensor);
            log.push(((a == trigger || b == trigger), (a == solid || b == solid) && (a == moving || b == moving), started));
        }
    }
    assert_eq!(log.iter().filter(|e| e.0 && e.2).count(), 1, "{log:?}");
    assert_eq!(log.iter().filter(|e| e.0 && !e.2).count(), 1, "{log:?}");
    assert_eq!(log.iter().filter(|e| e.1 && e.2).count(), 1, "{log:?}");
    assert_eq!(log.iter().filter(|e| e.1 && !e.2).count(), 1, "{log:?}");
}

#[test]
fn a_sensor_does_not_join_islands_or_wake_a_sleeper() {
    let mut w = world(8);
    floor(&mut w);
    let sleeper = w.add_body(DYNAMIC).unwrap();
    w.add_collider(sleeper, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_pose(sleeper, v3(0.0, 0.5, 0.0), Q::IDENTITY, false);
    for _ in 0..180 {
        w.step(DT);
    }
    assert!(w.flags(sleeper as usize) & SLEEPING != 0, "it sleeps");
    events(&mut w);
    let (scanner, _) = sensor_box(&mut w, KINEMATIC_POSITION, [0.2, 0.2, 0.2], v3(-3.0, 0.5, 0.0));
    let mut seen = 0;
    for step in 1..=60 {
        w.set_v(TARGET_X, scanner as usize, v3(-3.0 + 0.1 * step as f32, 0.5, 0.0));
        w.step(DT);
        seen += events(&mut w).len();
    }
    assert_eq!(seen, 2, "in and out");
    assert!(w.flags(sleeper as usize) & SLEEPING != 0, "it slept through");
}

#[test]
fn contact_events_begin_on_touching_and_end_on_leaving() {
    let mut w = world(4);
    let ground = floor(&mut w);
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.6, 0.0), 1.0);
    let mut log = vec![];
    for _ in 0..60 {
        w.step(DT);
        log.extend(events(&mut w));
    }
    assert_eq!(log.len(), 1, "one start, no chatter while it rests: {log:?}");
    assert!(log[0].2 && !log[0].3);
    w.set_v(LINEAR_X, body as usize, v3(0.0, 10.0, 0.0));
    for _ in 0..10 {
        w.step(DT);
        log.extend(events(&mut w));
    }
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(!log[1].2 && !log[1].3);
    assert!([log[1].0, log[1].1].contains(&first_collider(&w, ground)));
}

#[test]
fn a_teleport_out_of_a_contact_ends_it_and_a_removed_body_says_nothing() {
    let mut w = world(4);
    floor(&mut w);
    let body = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0);
    let other = block(&mut w, [0.5, 0.5, 0.5], v3(5.0, 0.5, 0.0), 1.0);
    for _ in 0..3 {
        w.step(DT);
    }
    assert_eq!(events(&mut w).len(), 2);
    w.set_pose(body, v3(0.0, 40.0, 0.0), Q::IDENTITY, true);
    w.step(DT);
    let log = events(&mut w);
    assert_eq!(log.len(), 1, "{log:?}");
    assert!(!log[0].2);
    w.remove_body(other);
    w.step(DT);
    assert_eq!(events(&mut w).len(), 0);
}

#[test]
fn groups_decide_who_collides_and_solver_groups_who_is_solved() {
    let mut w = world(8);
    let ground = floor(&mut w);
    let plate = first_collider(&w, ground);
    w.set_u(COLLIDER_GROUPS, plate as usize, pack(1, 1 | 2));
    w.set_u(COLLIDER_SOLVER_GROUPS, plate as usize, pack(1, 1));
    let (ghost, heavy, unsolved) = (
        block(&mut w, [0.5, 0.5, 0.5], v3(-4.0, 1.0, 0.0), 1.0),
        block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 1.0, 0.0), 1.0),
        block(&mut w, [0.5, 0.5, 0.5], v3(4.0, 1.0, 0.0), 1.0),
    );
    let (ghost_c, heavy_c, unsolved_c) = (first_collider(&w, ghost), first_collider(&w, heavy), first_collider(&w, unsolved));
    w.set_u(COLLIDER_GROUPS, ghost_c as usize, pack(4, 4));
    w.set_u(COLLIDER_GROUPS, heavy_c as usize, pack(2, 1));
    w.set_u(COLLIDER_SOLVER_GROUPS, unsolved_c as usize, pack(4, 4));
    let mut log = vec![];
    for _ in 0..90 {
        w.step(DT);
        log.extend(events(&mut w));
    }
    assert!(w.v(POSITION_X, ghost as usize).y < -1.0, "it falls through");
    assert!((w.v(POSITION_X, heavy as usize).y - 0.5).abs() < 0.02, "it rests");
    assert!(w.v(POSITION_X, unsolved as usize).y < -1.0, "it is not solved");
    let began = |c: u32| log.iter().filter(|e| e.2 && (e.0 == c || e.1 == c)).count();
    assert_eq!(began(ghost_c), 0, "groups that do not meet say nothing");
    assert_eq!(began(heavy_c), 1);
    assert_eq!(began(unsolved_c), 1, "a pair that is detected and not solved still says so");
    assert!(log.iter().any(|e| !e.2 && (e.0 == unsolved_c || e.1 == unsolved_c)), "and that it left");
}

#[test]
fn a_group_change_reaches_a_sleeper_on_a_floor() {
    let mut w = world(4);
    let ground = floor(&mut w);
    let plate = first_collider(&w, ground);
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_pose(body, v3(0.0, 0.5, 0.0), Q::IDENTITY, false);
    for _ in 0..180 {
        w.step(DT);
    }
    assert!(w.flags(body as usize) & SLEEPING != 0);
    w.set_u(COLLIDER_GROUPS, plate as usize, pack(1, 1));
    w.set_u(COLLIDER_GROUPS, first_collider(&w, body) as usize, pack(2, 2));
    w.touch_collider(plate);
    for _ in 0..60 {
        w.step(DT);
    }
    assert!(w.v(POSITION_X, body as usize).y < -0.5, "it falls");
}

fn only_even_pairs(a: u32, b: u32) -> bool {
    (a + b) % 2 == 0
}

#[test]
fn the_contact_filter_decides_pair_by_pair() {
    let mut w = world(8);
    floor(&mut w);
    // The floor's collider is row 0, so a block of an even row lands and one of an odd row falls through.
    let mut blocks = vec![];
    for i in 0..4 {
        blocks.push(block(&mut w, [0.4, 0.4, 0.4], v3(2.0 * i as f32, 1.0, 0.0), 1.0));
    }
    w.filter = Some(only_even_pairs);
    w.header_mut().filtering = 1;
    let mut log = vec![];
    for _ in 0..90 {
        w.step(DT);
        log.extend(events(&mut w));
    }
    for &body in &blocks {
        let (row, y) = (first_collider(&w, body), w.v(POSITION_X, body as usize).y);
        if row % 2 == 0 {
            assert!((y - 0.4).abs() < 0.02, "{row} at {y}");
        } else {
            assert!(y < -1.0, "{row} at {y}");
        }
    }
    assert_eq!(log.len(), 2, "only what the filter passes says anything: {log:?}");
}

#[test]
fn a_filter_refuses_a_sensor_its_events_too() {
    fn none(_: u32, _: u32) -> bool {
        false
    }
    let mut w = world(4);
    sensor_box(&mut w, FIXED, [2.0, 2.0, 2.0], v3(0.0, 0.0, 0.0));
    block(&mut w, [0.3, 0.3, 0.3], v3(0.0, 0.0, 0.0), 1.0);
    w.filter = Some(none);
    w.header_mut().filtering = 1;
    w.step(DT);
    assert_eq!(events(&mut w).len(), 0);
}

#[test]
fn a_dominant_body_takes_no_push_from_a_lower_one() {
    // Two blocks of equal mass meet head on in empty space. Equal, they stop. With one dominant it keeps its speed, and the
    // other leaves as from a wall: at the speed the wall moves, as no bounce is asked for. What is left is the speed the soft
    // push leaves in a contact, 0.014 m/s here, as a block on a real wall.
    for (rank, kept) in [(0.0f32, 0.0f64), (1.0, 2.0)] {
        let mut w = world(4);
        w.header_mut().gravity = [0.0; 3];
        let (left, right) = (block(&mut w, [0.5, 0.5, 0.5], v3(-2.0, 0.0, 0.0), 1.0), block(&mut w, [0.5, 0.5, 0.5], v3(2.0, 0.0, 0.0), 1.0));
        w.set_v(LINEAR_X, left as usize, v3(2.0, 0.0, 0.0));
        w.set_v(LINEAR_X, right as usize, v3(-2.0, 0.0, 0.0));
        w.set_s(DOMINANCE, left as usize, rank);
        for _ in 0..90 {
            w.step(DT);
        }
        let (a, b) = (w.v(LINEAR_X, left as usize).x as f64, w.v(LINEAR_X, right as usize).x as f64);
        println!("dominance {rank}: speeds {a:.4} and {b:.4}");
        assert!((a - kept).abs() < 0.02, "{a}");
        assert!((b - kept).abs() < 0.02, "{b}");
    }
}

#[test]
fn a_box_under_a_dominant_box_is_pressed_and_the_dominant_one_falls_as_if_on_a_wall() {
    // The lower body of a stack dominates: the upper one's weight does not reach it, and the floor still holds it.
    let mut w = world(4);
    let ground = floor(&mut w);
    let lower = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0);
    let upper = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 1.5, 0.0), 1.0);
    w.set_s(DOMINANCE, lower as usize, 1.0);
    for _ in 0..60 {
        w.step(DT);
    }
    let under = force(&w, ground, lower) / DT as f64;
    println!("dominant lower body presses the floor with {under:.4} N");
    assert!((under / G - 1.0).abs() < 1e-3, "{under}");
    assert!((force(&w, lower, upper) / DT as f64 / G - 1.0).abs() < 1e-3);
}

#[test]
fn a_disabled_body_leaves_the_world_and_comes_back() {
    let mut w = world(8);
    let ground = floor(&mut w);
    let lower = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0);
    let upper = w.add_body(DYNAMIC).unwrap();
    w.add_collider(upper, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_pose(upper, v3(0.0, 1.5, 0.0), Q::IDENTITY, false);
    for _ in 0..30 {
        w.step(DT);
    }
    events(&mut w);
    let (awake, held) = (w.header().awake, w.v(POSITION_X, lower as usize));
    w.set_body_enabled(lower, false);
    assert_eq!(events(&mut w).len(), 2, "both its contacts ended");
    assert_eq!(w.header().awake, awake - 1, "off the list");
    for _ in 0..12 {
        w.step(DT);
    }
    assert_eq!(w.v(POSITION_X, lower as usize).y, held.y, "it stays where it was");
    assert!(w.v(POSITION_X, upper as usize).y < 1.4, "what rested on it falls");
    w.wake(lower);
    assert_eq!(w.header().awake, awake - 1, "nothing wakes it");
    w.set_body_enabled(lower, true);
    assert_eq!(w.header().awake, awake);
    for _ in 0..120 {
        w.step(DT);
    }
    assert!((w.v(POSITION_X, upper as usize).y - 1.5).abs() < 0.02, "and it rests again");
    assert_eq!(force(&w, ground, upper), 0.0);
}

#[test]
fn a_floor_switched_off_lets_a_sleeper_fall() {
    for by_collider in [false, true] {
        let mut w = world(4);
        let ground = floor(&mut w);
        let body = w.add_body(DYNAMIC).unwrap();
        w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
        w.set_pose(body, v3(0.0, 0.5, 0.0), Q::IDENTITY, false);
        for _ in 0..180 {
            w.step(DT);
        }
        assert!(w.flags(body as usize) & SLEEPING != 0);
        events(&mut w);
        if by_collider {
            w.set_collider_state(first_collider(&w, ground), COLLIDER_OFF);
        } else {
            w.set_body_enabled(ground, false);
        }
        assert_eq!(events(&mut w).len(), 1, "the contact ended");
        for _ in 0..30 {
            w.step(DT);
        }
        assert!(w.v(POSITION_X, body as usize).y < 0.0, "it falls");
        assert_eq!(events(&mut w).len(), 0);
    }
}

#[test]
fn a_joint_on_a_disabled_body_rests_and_comes_back() {
    let mut w = world(4);
    let hook = w.add_body(FIXED).unwrap();
    w.set_pose(hook, v3(0.0, 10.0, 0.0), Q::IDENTITY, false);
    let holder = block_without_collider(&mut w, v3(0.0, 9.0, 0.0));
    let held = block_without_collider(&mut w, v3(0.0, 8.0, 0.0));
    let (one, two) = (w.add_joint(hook, holder, JOINT_LOCK * 7).unwrap(), w.add_joint(holder, held, JOINT_LOCK * 7).unwrap());
    w.set_v(JOINT_ANCHOR_B_X, one as usize, v3(0.0, 1.0, 0.0));
    w.set_v(JOINT_ANCHOR_B_X, two as usize, v3(0.0, 1.0, 0.0));
    w.step(DT);
    w.set_body_enabled(holder, false);
    for _ in 0..30 {
        w.step(DT);
    }
    assert_eq!(w.v(POSITION_X, holder as usize).y, 9.0);
    assert!(w.v(POSITION_X, held as usize).y < 7.5, "its joint rests, so it falls");
    w.set_pose(held, v3(0.0, 8.0, 0.0), Q::IDENTITY, false);
    w.set_v(LINEAR_X, held as usize, v3(0.0, 0.0, 0.0));
    w.set_body_enabled(holder, true);
    for _ in 0..60 {
        w.step(DT);
    }
    assert!((w.v(POSITION_X, held as usize).y - 8.0).abs() < 1e-3, "and holds again");
}

fn block_without_collider(w: &mut World, at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    let row = body as usize;
    w.set_s(INVERSE_MASS, row, 1.0);
    w.set_v(INERTIA_X, row, v3(0.1, 0.1, 0.1));
    w.set_v(INVERSE_INERTIA_X, row, v3(10.0, 10.0, 10.0));
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, row, w.flags(row) & !CAN_SLEEP);
    body
}

#[test]
fn a_sensor_turned_solid_ends_as_a_sensor_and_starts_as_a_contact() {
    let mut w = world(4);
    let (_, trigger) = sensor_box(&mut w, FIXED, [2.0, 0.5, 2.0], v3(0.0, -0.5, 0.0));
    let body = block(&mut w, [0.3, 0.3, 0.3], v3(0.0, 0.0, 0.0), 1.0);
    w.step(DT);
    let log = events(&mut w);
    assert_eq!(log.len(), 1);
    assert!(log[0].2 && log[0].3);
    w.set_collider_state(trigger, 0);
    let log = events(&mut w);
    assert_eq!(log.len(), 1);
    assert!(!log[0].2 && log[0].3);
    w.step(DT);
    let log = events(&mut w);
    assert_eq!(log.len(), 1, "{log:?}");
    assert!(log[0].2 && !log[0].3);
    assert!(w.v(POSITION_X, body as usize).y > -0.1, "held");
}

#[test]
fn a_body_whose_support_is_switched_off_falls_though_its_time_to_sleep_ran_out_long_ago() {
    // The lower block cannot sleep, so the upper one rests with its timer long full. Switching the lower one off has to start
    // that timer again, or the upper block sleeps in mid air at the first look. tests/sleep.rs holds removing and moving it.
    let mut w = world(4);
    floor(&mut w);
    let lower = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0), 1.0);
    w.set_u(FLAGS, lower as usize, w.flags(lower as usize) & !CAN_SLEEP);
    let upper = w.add_body(DYNAMIC).unwrap();
    w.add_collider(upper, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_pose(upper, v3(0.0, 1.5, 0.0), Q::IDENTITY, false);
    for _ in 0..120 {
        w.step(DT);
    }
    w.set_body_enabled(lower, false);
    for _ in 0..30 {
        w.step(DT);
    }
    let y = w.v(POSITION_X, upper as usize).y;
    assert!(y < 1.0, "it hangs at {y}");
}
