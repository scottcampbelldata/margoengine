// 2D joints against closed forms and the reference engines' black-box runs (physics-refs out/box2d3.json and
// out/rapier2d.json, 2026-11-08, same scenes): a pendulum swings with the period of the complete elliptic integral, a
// 50-link chain holds a 1000:1 end mass, the 30 by 30 joint grid keeps its anchors together, limits, motors, the
// prismatic line, the weld, the rope and the spring each do what their law says.
use margoengine_physics2d_kernel::joint::{JointDef, JointKind, Motor};
use margoengine_physics2d_kernel::math::{Rot, V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn fixed(world: &mut World, at: V2) -> u32 {
    world.create_body(&BodyDef { kind: Kind::Static, position: at, ..Default::default() })
}

fn ball(world: &mut World, at: V2, radius: f32, mass: f32) -> u32 {
    let b = world.create_body(&BodyDef { position: at, can_sleep: false, ..Default::default() });
    let density = mass / (std::f32::consts::PI * radius * radius);
    world.create_shape(b, Core::circle(V2::ZERO, radius).unwrap(), &ShapeDef { density, ..Default::default() });
    b
}

fn revolute(a: u32, b: u32, anchor_a: V2, anchor_b: V2) -> JointDef {
    JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a, b, anchor_a, anchor_b, collide: false }
}

/// The complete elliptic integral of the first kind K(k) by the arithmetic-geometric mean.
fn elliptic_k(k: f64) -> f64 {
    let (mut a, mut b) = (1.0f64, (1.0 - k * k).sqrt());
    for _ in 0..30 {
        (a, b) = (0.5 * (a + b), (a * b).sqrt());
    }
    std::f64::consts::PI / (2.0 * a)
}

#[test]
fn a_pendulum_swings_with_the_elliptic_period() {
    // A 1 kg ball of radius 0.05 m on a 1 m arm from a fixed pivot, let go 1 rad out. A physical pendulum:
    // T = 4 sqrt(I / (m g L)) K(sin(theta0 / 2)), I = m L^2 + m r^2 / 2 about the pivot.
    let mut world = World::default();
    let pivot = fixed(&mut world, v2(0.0, 10.0));
    let theta0 = 1.0f32;
    let (s, c) = ((theta0 as f64).sin() as f32, (theta0 as f64).cos() as f32);
    let bob = ball(&mut world, v2(s, 10.0 - c), 0.05, 1.0);
    world.create_joint(&revolute(pivot, bob, V2::ZERO, v2(-s, c)));
    let (l, r, g) = (1.0f64, 0.05f64, 9.81f64);
    let inertia = l * l + 0.5 * r * r;
    let expected = 4.0 * (inertia / (g * l)).sqrt() * elliptic_k((0.5 * theta0 as f64).sin());
    // Time between crossings of the bottom moving left, linearly interpolated.
    let (mut last_x, mut crossings, mut t) = (s, Vec::new(), 0.0f64);
    let mut highest = 0.0f32;
    for step in 0..(20.0 / DT) as usize {
        world.step(DT);
        t += DT as f64;
        let x = world.bodies[bob as usize].xf.p.x;
        if last_x > 0.0 && x <= 0.0 {
            crossings.push(t - DT as f64 * (x as f64 / (x as f64 - last_x as f64)));
        }
        last_x = x;
        if step as f32 * DT > 15.0 {
            highest = highest.max(world.bodies[bob as usize].xf.p.y);
        }
    }
    let periods: Vec<f64> = crossings.windows(2).map(|w| w[1] - w[0]).collect();
    let mean = periods.iter().sum::<f64>() / periods.len() as f64;
    let amplitude = (10.0 - highest as f64).acos();
    println!("pendulum: period {mean:.5} s, closed form {expected:.5} s ({:+.3} %), amplitude after 15 s {amplitude:.4} rad of 1", 100.0 * (mean / expected - 1.0));
    assert!((mean / expected - 1.0).abs() < 0.005, "period {mean} s, closed form {expected} s");
    assert!(amplitude > 0.97, "the swing lost amplitude: {amplitude} rad");
}

/// The reference scene: 50 balls 0.1 m apart on revolute joints from a fixed point, held at their surfaces (r 0.05; the
/// mass of a 0.05 m ball, 1 kg, at any radius `r`), the end `end` kg; worst stretch from 5 s to 10 s, as
/// (length / (49.5 L)) - 1 over the centres.
fn chain(settings: Settings, r: f32, end: f32) -> f64 {
    let (n, l) = (50usize, 0.1f32);
    let mut world = World::new(settings);
    let mut prev = fixed(&mut world, v2(0.0, 20.0));
    let mut links = Vec::new();
    for i in 1..=n {
        let mass = if i == n { end } else { 1.0 };
        let b = world.create_body(&BodyDef { position: v2(i as f32 * l, 20.0), can_sleep: false, ..Default::default() });
        let density = mass / (std::f32::consts::PI * r * r);
        world.create_shape(b, Core::circle(V2::ZERO, r).unwrap(), &ShapeDef { density, ..Default::default() });
        world.create_joint(&revolute(prev, b, v2(0.5 * l, 0.0), v2(-0.5 * l, 0.0)));
        links.push(b);
        prev = b;
    }
    let mut worst = 0.0f64;
    for step in 0..600 {
        world.step(DT);
        if step < 300 {
            continue;
        }
        let (mut p, mut length) = ([0.5 * l as f64, 20.0f64], 0.0f64);
        for &b in &links {
            let q = world.bodies[b as usize].exact_center;
            length += ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
            p = q;
        }
        worst = worst.max(length / ((n as f64 - 0.5) * l as f64) - 1.0);
    }
    worst
}

#[test]
fn a_chain_of_fifty_holds_a_thousand_to_one_end_mass() {
    // Box2D v3: 29.88; Rapier 2D: 22.18 (the chain flies apart in both). Ours holds by the exact path sweep and the
    // geometric stiffness together (joint.rs); either alone left 63 to 69.
    let worst = chain(Settings::default(), 0.05, 1000.0);
    println!("chain 50, 1000:1: worst stretch {worst:.4} (Box2D v3 29.88, Rapier 2D 22.18)");
    assert!(worst < 0.01, "stretched {worst}");
}

#[test]
fn a_chain_of_small_beads_hangs_without_flying_apart() {
    // 50 beads of 1 kg, r 0.02, held 0.05 m from their centres: the inertia is a sixth of m r_arm^2, so the beads spin
    // hard as the chain whips. Joint by joint with no geometric stiffness this ran to 1e19 m/s in 6 s; with the exact path
    // sweep alone it stretches 2.1 percent, and with the stiffness (joint.rs, `stiffen`) 0.57.
    let worst = chain(Settings::default(), 0.02, 1.0);
    println!("chain of beads r 0.02: worst stretch {worst:.4}");
    assert!(worst < 0.01, "stretched {worst}");
}

#[test]
fn without_the_geometric_stiffness_the_heavy_chain_flies_apart() {
    // The control: the same 1000:1 chain with the plain inertia. Its taut zigzag mode, sqrt(2 F r / I) = 890 rad/s,
    // outruns the substep (omega h = 3.7), as it does in the reference engines.
    let worst = chain(Settings { joint_geometric_stiffness: false, ..Default::default() }, 0.05, 1000.0);
    println!("chain 50, 1000:1, plain inertia: worst stretch {worst:.4}");
    assert!(worst > 1.0, "held at {worst}: the control no longer shows the mode");
}

#[test]
fn the_joint_grid_keeps_its_anchors_together() {
    // The reference scene: 30 by 30 balls (r 0.4, density 1) 1 m apart, revolute joints to the right and down
    // neighbours, the top row fixed; the worst anchor gap after 10 s. Box2D v3: 3.98 mm; Rapier 2D: 9.88 mm.
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
    let mut joints = Vec::new();
    for r in 0..n {
        for c in 0..n {
            if c + 1 < n && r > 0 {
                joints.push((id[r * n + c], id[r * n + c + 1], v2(0.5, 0.0), v2(-0.5, 0.0)));
            }
            if r + 1 < n {
                joints.push((id[r * n + c], id[(r + 1) * n + c], v2(0.0, -0.5), v2(0.0, 0.5)));
            }
        }
    }
    for &(a, b, pa, pb) in &joints {
        world.create_joint(&revolute(a, b, pa, pb));
    }
    for _ in 0..600 {
        world.step(DT);
    }
    let worst = joints
        .iter()
        .map(|&(a, b, pa, pb)| world.bodies[a as usize].xf.apply(pa).sub(world.bodies[b as usize].xf.apply(pb)).length())
        .fold(0.0, f32::max);
    println!("joint grid 30x30: {} joints, worst gap {:.3} mm (Box2D v3 3.98, Rapier 2D 9.88)", joints.len(), worst * 1e3);
    assert!(worst <= 0.00398, "worst gap {worst} m");
}

#[test]
fn revolute_limits_hold_and_a_motor_reaches_its_speed() {
    let mut world = World::default();
    let pivot = fixed(&mut world, v2(0.0, 5.0));
    let bob = ball(&mut world, v2(1.0, 5.0), 0.1, 1.0);
    let mut def = revolute(pivot, bob, V2::ZERO, v2(-1.0, 0.0));
    def.kind = JointKind::Revolute { limits: Some((-0.5, 0.5)), motor: None };
    world.create_joint(&def);
    let mut least = f32::INFINITY;
    for _ in 0..300 {
        world.step(DT);
        least = least.min(world.angle(bob));
    }
    println!("limit -0.5: lowest angle {least:.4} rad");
    assert!(least > -0.5 - 0.01, "passed the limit: {least}");
    // A wheel on a motor at 2 rad/s.
    let mut world = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
    let axle = fixed(&mut world, V2::ZERO);
    let wheel = ball(&mut world, V2::ZERO, 0.5, 1.0);
    let mut def = revolute(axle, wheel, V2::ZERO, V2::ZERO);
    def.kind = JointKind::Revolute { limits: None, motor: Some(Motor::velocity(2.0, 100.0)) };
    world.create_joint(&def);
    for _ in 0..60 {
        world.step(DT);
    }
    let w = world.bodies[wheel as usize].angular_velocity;
    println!("motor: {w:.4} rad/s");
    assert!((w - 2.0).abs() < 0.01, "motor speed {w}");
    // The same motor with a torque bound: torque t on inertia I gains t / I a second.
    let mut world = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
    let axle = fixed(&mut world, V2::ZERO);
    let wheel = ball(&mut world, V2::ZERO, 0.5, 1.0);
    let inertia = world.bodies[wheel as usize].inertia;
    let mut def = revolute(axle, wheel, V2::ZERO, V2::ZERO);
    def.kind = JointKind::Revolute { limits: None, motor: Some(Motor { max_force: 0.05, ..Motor::velocity(2.0, 100.0) }) };
    world.create_joint(&def);
    for _ in 0..30 {
        world.step(DT);
    }
    let w = world.bodies[wheel as usize].angular_velocity;
    let expected = 0.05 / inertia * 0.5;
    println!("bounded motor: {w:.4} rad/s after 0.5 s, closed form {expected:.4}");
    assert!((w - expected).abs() < 1e-3 * expected.max(1.0), "bounded motor {w}, expected {expected}");
}

#[test]
fn a_prismatic_joint_keeps_to_its_line_and_stops_at_its_limit() {
    let mut world = World::default();
    let base = fixed(&mut world, V2::ZERO);
    let slider = world.create_body(&BodyDef { position: v2(0.0, 0.0), can_sleep: false, ..Default::default() });
    world.create_shape(slider, Core::rect(0.2, 0.2, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default());
    // A line at 45 degrees down to the right; the body slides down it, held from turning, and stops 2 m along.
    let h = std::f32::consts::FRAC_1_SQRT_2;
    world.create_joint(&JointDef {
        kind: JointKind::Prismatic { axis: v2(h, -h), limits: Some((-1.0, 2.0)), motor: None },
        a: base,
        b: slider,
        anchor_a: V2::ZERO,
        anchor_b: V2::ZERO,
        collide: false,
    });
    let mut off_line = 0.0f32;
    for _ in 0..240 {
        world.step(DT);
        let p = world.bodies[slider as usize].xf.p;
        off_line = off_line.max((p.x + p.y).abs());
    }
    let p = world.bodies[slider as usize].xf.p;
    let along = p.x * h - p.y * h;
    println!("prismatic: {along:.4} m along, off the line by at most {:.3} mm, angle {:.2e}", off_line * 1e3, world.angle(slider));
    assert!(off_line < 0.002, "left the line by {off_line}");
    assert!((along - 2.0).abs() < 0.01, "stopped at {along}");
    assert!(world.angle(slider).abs() < 1e-3);
}

#[test]
fn a_fixed_joint_holds_a_beam_out_from_a_wall_and_keeps_its_angles() {
    let mut world = World::default();
    let wall = fixed(&mut world, V2::ZERO);
    let beam = world.create_body(&BodyDef { position: v2(1.0, 0.0), can_sleep: false, ..Default::default() });
    world.create_shape(beam, Core::rect(1.0, 0.05, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default());
    // A quarter turn in A's frame against none in B's: the beam stands up from the wall's anchor.
    world.create_joint(&JointDef {
        kind: JointKind::Fixed { angle_a: Rot { c: 0.0, s: 1.0 }, angle_b: Rot::IDENTITY },
        a: wall,
        b: beam,
        anchor_a: V2::ZERO,
        anchor_b: v2(-1.0, 0.0),
        collide: false,
    });
    for _ in 0..240 {
        world.step(DT);
    }
    let angle = world.angle(beam);
    let tip = world.bodies[beam as usize].xf.apply(v2(1.0, 0.0));
    println!("weld: angle {angle:.5} rad, tip at {tip:?}");
    assert!((angle - std::f32::consts::FRAC_PI_2).abs() < 0.01, "angle {angle}");
    assert!(tip.x.abs() < 0.03 && (tip.y - 2.0).abs() < 0.01);
}

#[test]
fn a_rope_holds_at_its_length_and_goes_slack_inside_it() {
    let mut world = World::default();
    let hook = fixed(&mut world, v2(0.0, 5.0));
    let weight = ball(&mut world, v2(1.0, 5.0), 0.1, 2.0);
    world.create_joint(&JointDef { kind: JointKind::Rope { length: 2.0 }, a: hook, b: weight, anchor_a: V2::ZERO, anchor_b: V2::ZERO, collide: false });
    let (mut longest, mut fell) = (0.0f32, false);
    for step in 0..300 {
        world.step(DT);
        let d = world.bodies[weight as usize].xf.p.sub(v2(0.0, 5.0)).length();
        longest = longest.max(d);
        // Inside the rope's length it falls freely for the first steps.
        if step == 5 {
            fell = (world.bodies[weight as usize].linear_velocity.y + 9.81 * 6.0 * DT).abs() < 0.01;
        }
    }
    println!("rope 2 m: longest {longest:.4} m");
    assert!(fell, "the slack rope pulled");
    assert!(longest < 2.01, "the rope stretched to {longest}");
}

#[test]
fn a_spring_joint_oscillates_with_period_two_pi_root_m_over_k() {
    let mut world = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
    let anchor = fixed(&mut world, V2::ZERO);
    let mass = ball(&mut world, v2(1.5, 0.0), 0.1, 1.0);
    let k = 40.0f32;
    world.create_joint(&JointDef { kind: JointKind::Spring { rest_length: 1.0, stiffness: k, damping: 0.0 }, a: anchor, b: mass, anchor_a: V2::ZERO, anchor_b: V2::ZERO, collide: false });
    let expected = 2.0 * std::f64::consts::PI * (1.0f64 / k as f64).sqrt();
    let (mut last, mut crossings, mut t) = (0.5f32, Vec::new(), 0.0f64);
    for _ in 0..600 {
        world.step(DT);
        t += DT as f64;
        let x = world.bodies[mass as usize].xf.p.x - 1.0;
        if last > 0.0 && x <= 0.0 {
            crossings.push(t - DT as f64 * (x as f64 / (x as f64 - last as f64)));
        }
        last = x;
    }
    let periods: Vec<f64> = crossings.windows(2).map(|w| w[1] - w[0]).collect();
    let mean = periods.iter().sum::<f64>() / periods.len() as f64;
    println!("spring: period {mean:.5} s, closed form {expected:.5} s");
    assert!((mean / expected - 1.0).abs() < 0.01, "period {mean}");
}

#[test]
fn joined_bodies_do_not_collide_unless_asked() {
    for collide in [false, true] {
        let mut world = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
        let a = world.create_body(&BodyDef { can_sleep: false, ..Default::default() });
        world.create_shape(a, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default());
        let b = world.create_body(&BodyDef { position: v2(0.6, 0.0), can_sleep: false, ..Default::default() });
        world.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default());
        world.create_joint(&JointDef { kind: JointKind::Rope { length: 5.0 }, a, b, anchor_a: V2::ZERO, anchor_b: V2::ZERO, collide });
        for _ in 0..60 {
            world.step(DT);
        }
        let gap = world.bodies[b as usize].xf.p.x - world.bodies[a as usize].xf.p.x;
        println!("collide {collide}: centres {gap:.4} m apart");
        if collide {
            assert!(gap > 0.99, "pushed apart only to {gap}");
        } else {
            assert!((gap - 0.6).abs() < 1e-5, "moved apart to {gap}");
        }
    }
}
