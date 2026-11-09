// The 2D world and solver against the scenes of Catto's Solver2D post (2024) and closed forms: a 20-row pyramid rests
// and sleeps, built bottom up or top down, a card house stands, a 1:100 stack holds with the sag its springs give in closed form, a pyramid 10 km
// from the origin behaves as one at it, friction holds below tan t = mu and slides above, restitution bounces, and two
// worlds built alike step alike bit for bit.
//
// The pyramid's bars are the black-box runs of the reference engines on the same scene (unit boxes, 4 substeps, 60 Hz,
// g = 9.81, physics-refs out/box2d3.json and out/rapier2d.json, 2026-11-08): Box2D v3.2.0's top box drops 29.11 mm
// and the pile sleeps at 1.02 s; Rapier 2D 0.21.0's drops 29.56 mm and sleeps at 0.92 s.
use margoengine_physics2d_kernel::math::{Rot, V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn ground(world: &mut World, at: V2, half_width: f32) -> u32 {
    let g = world.create_body(&BodyDef { kind: Kind::Static, position: at, ..Default::default() }).unwrap();
    world.create_shape(g, Core::rect(half_width, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    g
}

fn boxed(world: &mut World, at: V2, hx: f32, hy: f32, density: f32, friction: f32) -> u32 {
    let b = world.create_body(&BodyDef { position: at, ..Default::default() }).unwrap();
    world.create_shape(b, Core::rect(hx, hy, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density, friction, restitution: 0.0 }).unwrap();
    b
}

/// A pyramid of `rows` rows of unit boxes standing on a ground whose top is at `origin`.
fn pyramid(world: &mut World, origin: V2, rows: usize) -> Vec<u32> {
    ground(world, origin, 40.0);
    let mut boxes = Vec::new();
    for row in 0..rows {
        let count = rows - row;
        for i in 0..count {
            let x = (i as f32 - 0.5 * (count as f32 - 1.0)) * 1.0;
            boxes.push(boxed(world, origin.add(v2(x, 0.5 + row as f32)), 0.5, 0.5, 1.0, 0.6));
        }
    }
    boxes
}

/// Runs `seconds`; returns the most any box strayed from its start and the time all were asleep (if they were).
fn settle(world: &mut World, boxes: &[u32], seconds: f32) -> (f32, Option<f32>) {
    let (drift, asleep, _) = settle_from(world, boxes, seconds);
    (drift, asleep)
}

/// As `settle`, and also the most any box moved from 1 s on, once the springs have taken their load (the creep).
fn settle_from(world: &mut World, boxes: &[u32], seconds: f32) -> (f32, Option<f32>, f32) {
    let start: Vec<V2> = boxes.iter().map(|&b| world.bodies[b as usize].xf.p).collect();
    let mut at_one = start.clone();
    let mut asleep_at = None;
    let steps = (seconds / DT) as usize;
    for step in 0..steps {
        if step == 60 {
            at_one = boxes.iter().map(|&b| world.bodies[b as usize].xf.p).collect();
        }
        world.step(DT).unwrap();
        if asleep_at.is_none() && boxes.iter().all(|&b| !world.bodies[b as usize].awake) {
            asleep_at = Some((step + 1) as f32 * DT);
        }
        for &b in boxes {
            let p = world.bodies[b as usize].xf.p;
            assert!(p.x.is_finite() && p.y.is_finite(), "step {step}: body {b} not finite");
        }
    }
    let most = |from: &[V2]| boxes.iter().zip(from).map(|(&b, s)| world.bodies[b as usize].xf.p.sub(*s).length()).fold(0.0, f32::max);
    (most(&start), asleep_at, most(&at_one))
}

/// How far the top box of a pyramid dropped.
fn top_drop(world: &World, boxes: &[u32], rows: usize, origin: V2) -> f32 {
    (origin.y as f64 + rows as f64 - 0.5 - world.bodies[*boxes.last().unwrap() as usize].exact_center[1]) as f32
}

#[test]
fn a_pyramid_of_twenty_rows_rests_and_sleeps() {
    let mut world = World::default();
    let boxes = pyramid(&mut world, V2::ZERO, 20);
    let (most, asleep, creep) = settle_from(&mut world, &boxes, 10.0);
    let top = top_drop(&world, &boxes, 20, V2::ZERO);
    println!("pyramid 20: top drop {:.2} mm, most {:.2} mm, creep after 1 s {:.3} mm, asleep at {asleep:?} s", top * 1e3, most * 1e3, creep * 1e3);
    // As stiff as the stiffer reference and asleep sooner than either; nothing creeps once the springs hold.
    assert!(top <= 0.02911, "top drop {top} m, Box2D v3's is 0.02911 m");
    assert!(most < 0.03, "a box moved {most} m");
    assert!(creep < 0.01, "creep {creep} m");
    assert!(asleep.is_some_and(|t| t <= 0.92), "asleep at {asleep:?}, Rapier 2D sleeps at 0.92 s");
}

#[test]
fn a_pyramid_of_twenty_rows_built_top_down_rests_as_one_built_bottom_up() {
    // The solve order follows height along gravity, not the order the bodies were made in. Before the colouring, the
    // contacts went in the order they were found, and this pile, its top row made first, dropped 29.41 mm and slept at
    // 0.88 s where the same pile made bottom up dropped 28.41 mm and slept at 0.75 s.
    let rows = 20;
    let mut world = World::default();
    ground(&mut world, V2::ZERO, 40.0);
    let mut boxes = Vec::new();
    for row in (0..rows).rev() {
        let count = rows - row;
        for i in 0..count {
            boxes.push(boxed(&mut world, v2(i as f32 - 0.5 * (count as f32 - 1.0), 0.5 + row as f32), 0.5, 0.5, 1.0, 0.6));
        }
    }
    let (_, asleep, creep) = settle_from(&mut world, &boxes, 10.0);
    let top = (rows as f64 - 0.5 - world.bodies[boxes[0] as usize].exact_center[1]) as f32;
    println!("pyramid 20 built top down: top drop {:.2} mm, creep after 1 s {:.3} mm, asleep at {asleep:?} s", top * 1e3, creep * 1e3);
    assert!(top <= 0.02911, "top drop {top} m, Box2D v3's is 0.02911 m");
    assert!(creep < 0.01, "creep {creep} m");
    assert!(asleep.is_some_and(|t| t <= 0.92), "asleep at {asleep:?}, Rapier 2D sleeps at 0.92 s");
}

#[test]
fn a_pyramid_of_twenty_rows_settles_with_sleep_off() {
    let mut world = World::new(Settings { sleep: false, ..Default::default() });
    let boxes = pyramid(&mut world, V2::ZERO, 20);
    let (_, _, creep) = settle_from(&mut world, &boxes, 10.0);
    let fastest = boxes.iter().map(|&b| world.bodies[b as usize].sleep_speed()).fold(0.0, f32::max);
    println!("pyramid 20, sleep off: creep after 1 s {:.3} mm, fastest {fastest:.2e} m/s", creep * 1e3);
    assert!(top_drop(&world, &boxes, 20, V2::ZERO) <= 0.02911);
    assert!(creep < 0.01, "creep {creep} m");
    assert!(fastest < 0.01, "still moving at {fastest} m/s");
}

#[test]
fn a_pyramid_ten_kilometres_out_behaves_as_one_at_the_origin() {
    // Floats are a millimetre apart at 1e4; the step works relative to each pair's first body and moves positions in
    // doubles, so the far pile's shape matches the near one's to well under that spacing.
    let far = v2(1.0e4, 1.0e4);
    let shape = |origin: V2| {
        let mut world = World::default();
        let boxes = pyramid(&mut world, origin, 20);
        let (_, asleep, _) = settle_from(&mut world, &boxes, 10.0);
        let offsets: Vec<[f64; 2]> = boxes
            .iter()
            .map(|&b| {
                let c = world.bodies[b as usize].exact_center;
                [c[0] - origin.x as f64, c[1] - origin.y as f64]
            })
            .collect();
        (offsets, asleep, top_drop(&world, &boxes, 20, origin))
    };
    let (near, near_asleep, near_top) = shape(V2::ZERO);
    let (away, asleep, top) = shape(far);
    let apart = near.iter().zip(&away).map(|(a, b)| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()).fold(0.0, f64::max);
    println!("pyramid 20 at 1e4 m: top drop {:.2} mm (origin {:.2}), asleep at {asleep:?} s (origin {near_asleep:?}), most apart from the origin pile {:.4} mm", top * 1e3, near_top * 1e3, apart * 1e3);
    assert!(asleep.is_some(), "never slept");
    assert!(top <= 0.02911);
    assert!(apart < 1e-3, "the far pile differs by {apart} m");
}

#[test]
fn a_card_house_stands() {
    // Catto's card house: cards 0.2 m tall and 1 mm thick leaning in pairs at 0.25 rad, flat cards across the tops, three
    // levels; friction 0.7.
    let mut world = World::default();
    ground(&mut world, V2::ZERO, 10.0);
    let (height, thickness, angle, friction) = (0.2f32, 0.001f32, 0.25f32, 0.7f32);
    let (c, s) = (cos(angle), sin(angle));
    let half = 0.5 * height;
    let lean = Rot { c, s };
    let lean_back = Rot { c, s: -s };
    let mut cards = Vec::new();
    let mut card = |world: &mut World, at: V2, q: Rot, flat: bool| {
        let body = world.create_body(&BodyDef { position: at, rotation: q, ..Default::default() }).unwrap();
        // A card is a segment rounded by half its thickness: thinner than the polygon weld allows as a box.
        let core = if flat { Core::capsule(v2(-half, 0.0), v2(half, 0.0), 0.5 * thickness) } else { Core::capsule(v2(0.0, -half), v2(0.0, half), 0.5 * thickness) };
        world.create_shape(body, core.unwrap(), &ShapeDef { density: 1000.0, friction, restitution: 0.0 }).unwrap();
        cards.push(body);
    };
    // A leaning card's top corner sits on the pair's ridge; its foot lies height * sin(angle) out from it.
    let (rise, run) = (height * c, height * s);
    let mut y = 0.0f32;
    let mut pairs = 3usize;
    while pairs > 0 {
        for i in 0..pairs {
            let ridge = (i as f32 - 0.5 * (pairs as f32 - 1.0)) * (2.0 * run + 0.01);
            let mid = y + 0.5 * rise;
            card(&mut world, v2(ridge - 0.5 * run, mid), lean_back, false);
            card(&mut world, v2(ridge + 0.5 * run, mid), lean, false);
            if i + 1 < pairs {
                let next = ridge + 2.0 * run + 0.01;
                card(&mut world, v2(0.5 * (ridge + next), y + rise + 0.5 * thickness), Rot::IDENTITY, true);
            }
        }
        y += rise + thickness;
        pairs -= 1;
    }
    let start: Vec<V2> = cards.iter().map(|&b| world.bodies[b as usize].xf.p).collect();
    for _ in 0..(10.0 / DT) as usize {
        world.step(DT).unwrap();
    }
    let drift = cards.iter().zip(&start).map(|(&b, s)| world.bodies[b as usize].xf.p.sub(*s).length()).fold(0.0, f32::max);
    println!("card house: {} cards, drift {:.2} mm", cards.len(), drift * 1000.0);
    assert!(drift < 0.01, "a card moved {drift} m");
}

#[test]
fn a_heavy_box_on_light_ones_holds_at_one_to_a_hundred() {
    let mut world = World::default();
    ground(&mut world, V2::ZERO, 10.0);
    let mut boxes = Vec::new();
    for i in 0..3 {
        boxes.push(boxed(&mut world, v2(0.0, 0.5 + i as f32), 0.5, 0.5, 1.0, 0.6));
    }
    boxes.push(boxed(&mut world, v2(0.0, 3.5), 0.5, 0.5, 100.0, 0.6));
    let (_, asleep, creep) = settle_from(&mut world, &boxes, 10.0);
    // Every pair carries over 50 light boxes' weight, so each keeps the quarter-rate spring (60 Hz). At rest a point's
    // spring holds lambda = -s h omega^2 m_ii, m_ii its own effective mass (1 / k_ii), so a contact of two points sinks
    // load g k_ii / (2 omega^2); the heavy box's drop is the sum down the column. A unit box's corner arm across the
    // normal is 0.5 and its inertia 1/6, so each body adds 1/m + 0.25 / I to k_ii.
    let omega = 2.0 * std::f64::consts::PI * 60.0;
    let k = |inv_a: f64, inv_b: f64| inv_a + inv_b + 0.25 * 6.0 * (inv_a + inv_b);
    let column = [(103.0, k(1.0, 0.0)), (102.0, k(1.0, 1.0)), (101.0, k(1.0, 1.0)), (100.0, k(1.0, 0.01))];
    let expected: f64 = column.iter().map(|(load, k_ii)| load * 9.81 * k_ii / (2.0 * omega * omega)).sum();
    let top = &world.bodies[boxes[3] as usize];
    let drop = 3.5 - top.exact_center[1];
    println!("1:100 stack: heavy box dropped {:.2} mm, closed form {:.2} mm, creep {:.3} mm, asleep at {asleep:?}", drop * 1e3, expected * 1e3, creep * 1e3);
    assert!((drop - expected).abs() < 0.03 * expected, "dropped {drop} m, closed form {expected} m");
    assert!(top.exact_center[0].abs() < 1e-4 && creep < 0.01, "creep {creep} m");
    assert!(asleep.is_some());
}

#[test]
fn the_block_solver_takes_two_point_contacts() {
    let mut world = World::default();
    let boxes = pyramid(&mut world, V2::ZERO, 4);
    world.settings.sleep = false;
    let (drift, _) = settle(&mut world, &boxes, 2.0);
    assert!(world.counts.block > 0, "{:?}", world.counts);
    assert_eq!(world.counts.sequential, 0, "{:?}", world.counts);
    assert!(drift < 0.01);
    // The same scene one row at a time also rests: the block solve is a speed and quality option, not the only path.
    let mut world = World::new(Settings { block_solver: false, sleep: false, ..Default::default() });
    let boxes = pyramid(&mut world, V2::ZERO, 4);
    let (drift, _) = settle(&mut world, &boxes, 2.0);
    assert_eq!(world.counts.block, 0);
    assert!(drift < 0.01, "drift {drift}");
}

/// cos and sin by series for the test's set-up only.
fn cos(x: f32) -> f32 {
    (x as f64).cos() as f32
}
fn sin(x: f32) -> f32 {
    (x as f64).sin() as f32
}

#[test]
fn friction_holds_below_tan_t_equal_to_mu_and_slides_above() {
    for (angle, holds) in [(0.45f32, true), (0.60f32, false)] {
        // mu = 0.6 for both shapes; tan(0.45) = 0.483 holds, tan(0.60) = 0.684 slides.
        let mut world = World::default();
        let q = Rot { c: cos(angle), s: sin(angle) };
        let slope = world.create_body(&BodyDef { kind: Kind::Static, rotation: q, ..Default::default() }).unwrap();
        world.create_shape(slope, Core::rect(20.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let up = q.apply(v2(0.0, 0.5));
        let b = world.create_body(&BodyDef { position: up, rotation: q, ..Default::default() }).unwrap();
        world.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
        let start = world.bodies[b as usize].xf.p;
        for _ in 0..120 {
            world.step(DT).unwrap();
        }
        let moved = world.bodies[b as usize].xf.p.sub(start).length();
        println!("slope {angle} rad: moved {:.2} mm", moved * 1000.0);
        if holds {
            assert!(moved < 0.005, "slid {moved} m at {angle} rad");
        } else {
            assert!(moved > 0.5, "held at {angle} rad, moved {moved} m");
        }
    }
}

#[test]
fn restitution_bounces_and_zero_restitution_does_not() {
    for (e, low, high) in [(0.0f32, 0.0f32, 0.05f32), (0.8, 0.55, 0.75)] {
        let mut world = World::default();
        ground(&mut world, V2::ZERO, 10.0);
        let ball = world.create_body(&BodyDef { position: v2(0.0, 2.25), ..Default::default() }).unwrap();
        world.create_shape(ball, Core::circle(V2::ZERO, 0.25).unwrap(), &ShapeDef { restitution: e, ..Default::default() }).unwrap();
        // Falls 2 m; e^2 of the drop comes back as height.
        let (mut hit, mut peak) = (false, 0.0f32);
        for _ in 0..240 {
            world.step(DT).unwrap();
            let y = world.bodies[ball as usize].xf.p.y - 0.25;
            if !hit && world.bodies[ball as usize].linear_velocity.y > 0.0 {
                hit = true;
            }
            if hit {
                peak = peak.max(y);
            }
        }
        let ratio = peak / 2.0;
        println!("restitution {e}: rebound {:.3} of the drop (e^2 = {:.3})", ratio, e * e);
        assert!(ratio >= low && ratio <= high, "rebound {ratio} for e = {e}");
    }
}

#[test]
fn a_sleeping_stack_wakes_when_struck() {
    let mut world = World::default();
    let boxes = pyramid(&mut world, V2::ZERO, 3);
    let (_, asleep) = settle(&mut world, &boxes, 3.0);
    assert!(asleep.is_some());
    let ball = world.create_body(&BodyDef { position: v2(-6.0, 0.5), linear_velocity: v2(8.0, 0.0), ..Default::default() }).unwrap();
    world.create_shape(ball, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    let mut woke = false;
    for _ in 0..60 {
        world.step(DT).unwrap();
        woke |= boxes.iter().any(|&b| world.bodies[b as usize].awake);
    }
    assert!(woke, "the struck stack never woke");
}

#[test]
fn two_worlds_built_alike_step_alike_bit_for_bit() {
    let run = || {
        let mut world = World::default();
        let boxes = pyramid(&mut world, v2(3.0, 1.0), 8);
        let ball = world.create_body(&BodyDef { position: v2(-4.0, 2.0), linear_velocity: v2(6.0, 1.0), angular_velocity: 2.0, ..Default::default() }).unwrap();
        world.create_shape(ball, Core::capsule(v2(-0.3, 0.0), v2(0.3, 0.0), 0.2).unwrap(), &ShapeDef::default()).unwrap();
        for _ in 0..300 {
            world.step(DT).unwrap();
        }
        boxes.iter().chain([ball].iter()).flat_map(|&b| {
            let body = &world.bodies[b as usize];
            [body.xf.p.x.to_bits(), body.xf.p.y.to_bits(), body.xf.q.c.to_bits(), body.xf.q.s.to_bits()]
        }).collect::<Vec<u32>>()
    };
    assert_eq!(run(), run());
}

#[test]
fn a_pyramid_of_a_hundred_rows_keeps_its_warm_start_and_sags_as_the_references() {
    // Box2D v3.2 drops the top 726 mm and Rapier 2D 735 mm; their row 30 spreads 70 and 64 mm (black-box runs,
    // the same scene through their APIs, 2026-11-08). Before the reference face kept its choice, 400 to 700
    // pairs flipped face a step and 1,100 to 1,800 points restarted from zero impulse: the top fell 902 mm by 5 s and
    // row 30 wedged 311 mm apart.
    let rows = 100;
    let mut world = World::new(Settings::default());
    let boxes = pyramid(&mut world, V2::ZERO, rows);
    let start: Vec<V2> = boxes.iter().map(|&b| world.bodies[b as usize].xf.p).collect();
    let row30: usize = (0..30).map(|r| rows - r).sum();
    let (mut worst_cold, mut colours, mut overflow) = (0, 0, 0);
    for step in 0..300 {
        world.step(DT).unwrap();
        if step >= 60 {
            worst_cold = worst_cold.max(world.counts.cold_points);
        }
        colours = colours.max(world.counts.colours);
        overflow = overflow.max(world.counts.overflow);
    }
    let top = top_drop(&world, &boxes, rows, V2::ZERO);
    let outward = (row30..row30 + rows - 30)
        .map(|k| (world.bodies[boxes[k] as usize].xf.p.x - start[k].x) * start[k].x.signum())
        .sum::<f32>()
        / (rows - 30) as f32;
    println!("pyramid 100 at 5 s: top drop {:.1} mm, row 30 mean outward {:.1} mm, most cold points a step after 1 s {worst_cold}, most colours {colours}, overflow {overflow}", top * 1e3, outward * 1e3);
    // Every contact found a colour: the pile's graph needs 8 of the 16.
    assert_eq!(overflow, 0);
    assert!(top <= 0.735, "top drop {top} m");
    assert!(outward <= 0.1, "row 30 outward {outward} m");
    assert!(worst_cold <= 10, "{worst_cold} points lost their warm start in one step");
}

#[test]
fn a_heavy_box_on_light_ones_holds_at_one_to_a_thousand() {
    let mut world = World::default();
    ground(&mut world, V2::ZERO, 10.0);
    let mut boxes = Vec::new();
    for i in 0..3 {
        boxes.push(boxed(&mut world, v2(0.0, 0.5 + i as f32), 0.5, 0.5, 1.0, 0.6));
    }
    boxes.push(boxed(&mut world, v2(0.0, 3.5), 0.5, 0.5, 1000.0, 0.6));
    let (_, asleep, creep) = settle_from(&mut world, &boxes, 10.0);
    // Every pair carries over 50 light boxes' weight, so each keeps the quarter-rate spring (60 Hz). At rest a point's
    // spring holds lambda = -s h omega^2 m_ii, m_ii its own effective mass (1 / k_ii), so a contact of two points sinks
    // load g k_ii / (2 omega^2); the heavy box's drop is the sum down the column. A unit box's corner arm across the
    // normal is 0.5 and its inertia 1/6, so each body adds 1/m + 0.25 / I to k_ii.
    let omega = 2.0 * std::f64::consts::PI * 60.0;
    let k = |inv_a: f64, inv_b: f64| inv_a + inv_b + 0.25 * 6.0 * (inv_a + inv_b);
    let column = [(1003.0, k(1.0, 0.0)), (1002.0, k(1.0, 1.0)), (1001.0, k(1.0, 1.0)), (1000.0, k(1.0, 0.001))];
    let expected: f64 = column.iter().map(|(load, k_ii)| load * 9.81 * k_ii / (2.0 * omega * omega)).sum();
    let top = &world.bodies[boxes[3] as usize];
    let drop = 3.5 - top.exact_center[1];
    println!("1:1000 contact stack: heavy box dropped {:.2} mm, closed form {:.2} mm, creep {:.3} mm, asleep at {asleep:?}", drop * 1e3, expected * 1e3, creep * 1e3);
    assert!((drop - expected).abs() < 0.03 * expected, "dropped {drop} m, closed form {expected} m");
    assert!(top.exact_center[0].abs() < 1e-4 && creep < 0.01, "creep {creep} m");
    assert!(asleep.is_some());
}
