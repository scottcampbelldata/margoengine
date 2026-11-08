// Polylines with ghost vertices: a box and a ball slide across the seams of a flat chain of 50 one-metre segments at
// 5 m/s with no friction and keep their speed (acceptance 2, the tilemap slide), where the same segments without their
// ghosts catch (the control). The scene is the reference harness's `slide_chain_50_segments` (physics-refs, run as a
// black box on 2026-11-08): Box2D v3.2.0's chain keeps vx at 5 with |vy| at most 7.4e-5 and the angle at most 5.6e-5;
// Rapier 2D 0.21.0's polyline catches (vx down to -0.17, |vy| up to 2.25). Bent chains still meet shapes at their
// corners: a ball rolls over a convex bump and settles in a concave valley.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

/// The floor: 51 points, a segment a metre, as one chain or as loose segments.
fn floor(world: &mut World, ghosts: bool) {
    let points: Vec<V2> = (0..=50).map(|i| v2(i as f32, 0.0)).collect();
    let body = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() });
    let def = ShapeDef { friction: 0.0, ..Default::default() };
    if ghosts {
        world.create_chain(body, &points, false, &def).unwrap();
    } else {
        for w in points.windows(2) {
            world.create_shape(body, Core::segment(w[0], w[1]).unwrap(), &def);
        }
    }
}

struct Slide {
    min_vx: f32,
    max_vx: f32,
    max_vy: f32,
    max_angle: f32,
}

/// `chain_first`: the floor's shapes get the lower ids, so the pair is (chain, body); else (body, chain).
fn slide(ghosts: bool, ball: bool, chain_first: bool) -> Slide {
    let mut world = World::default();
    if chain_first {
        floor(&mut world, ghosts);
    }
    let (y, core) = if ball { (0.5, Core::circle(V2::ZERO, 0.5).unwrap()) } else { (0.5, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap()) };
    let body = world.create_body(&BodyDef { position: v2(1.0, y), linear_velocity: v2(5.0, 0.0), can_sleep: false, fixed_rotation: ball, ..Default::default() });
    world.create_shape(body, core, &ShapeDef { friction: 0.0, ..Default::default() });
    if !chain_first {
        floor(&mut world, ghosts);
    }
    let mut out = Slide { min_vx: 5.0, max_vx: 5.0, max_vy: 0.0, max_angle: 0.0 };
    for _ in 0..480 {
        world.step(DT);
        let b = &world.bodies[body as usize];
        if b.xf.p.x >= 48.0 {
            break;
        }
        out.min_vx = out.min_vx.min(b.linear_velocity.x);
        out.max_vx = out.max_vx.max(b.linear_velocity.x);
        out.max_vy = out.max_vy.max(b.linear_velocity.y.abs());
        out.max_angle = out.max_angle.max(b.xf.q.s.abs());
    }
    out
}

#[test]
fn a_box_and_a_ball_slide_across_the_seams_of_a_chain() {
    for (ball, chain_first) in [(false, true), (true, true), (false, false), (true, false)] {
        let s = slide(true, ball, chain_first);
        let name = if ball { "ball" } else { "box" };
        println!("{name} on a chain (chain first {chain_first}): vx {} to {}, |vy| <= {:.2e}, |angle| <= {:.2e}", s.min_vx, s.max_vx, s.max_vy, s.max_angle);
        // Speed variance under 1e-4 (acceptance 2): vx stays within 1e-4 of 5. |vy| and the angle stay within Box2D v3's.
        assert!(s.min_vx > 5.0 - 1e-4 && s.max_vx < 5.0 + 1e-4, "{name}: vx {} to {}", s.min_vx, s.max_vx);
        assert!(s.max_vy <= 7.44e-5, "{name}: |vy| {}, Box2D v3's 7.44e-5", s.max_vy);
        assert!(s.max_angle <= 5.57e-5, "{name}: angle {}, Box2D v3's 5.57e-5", s.max_angle);
    }
}

#[test]
fn without_their_ghosts_the_same_segments_catch() {
    let s = slide(false, false, true);
    println!("box on loose segments: vx {} to {}, |vy| <= {:.2e}", s.min_vx, s.max_vx, s.max_vy);
    assert!(s.min_vx < 4.5 || s.max_vy > 0.1, "the control did not catch: vx {} |vy| {}", s.min_vx, s.max_vy);
}

#[test]
fn a_ball_rolls_over_a_bump_and_settles_in_a_valley() {
    // A chain up a slope, over a ridge and down into a valley: corners that turn away from the ball and toward it.
    let mut world = World::default();
    let body = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() });
    let points = [v2(-6.0, 3.0), v2(-3.0, 0.0), v2(0.0, 0.0), v2(2.0, 1.0), v2(4.0, 0.0), v2(7.0, 3.0)];
    world.create_chain(body, &points, false, &ShapeDef::default()).unwrap();
    let ball = world.create_body(&BodyDef { position: v2(-5.0, 3.5), ..Default::default() });
    world.create_shape(ball, Core::circle(V2::ZERO, 0.25).unwrap(), &ShapeDef { friction: 0.6, ..Default::default() });
    let mut lowest = f32::INFINITY;
    for _ in 0..1200 {
        world.step(DT);
        let p = world.bodies[ball as usize].xf.p;
        assert!(p.y > -0.01, "fell through the chain at {p:?}");
        lowest = lowest.min(p.y);
    }
    let p = world.bodies[ball as usize].xf.p;
    println!("ball at {p:?}, lowest {lowest}");
    // It ends in one of the two valleys, resting on the chain.
    assert!(!world.bodies[ball as usize].awake || world.bodies[ball as usize].sleep_speed() < 0.05);
    assert!(p.y < 0.5, "did not settle in a valley: {p:?}");
}

#[test]
fn a_closed_chain_holds_a_box_inside() {
    let mut world = World::default();
    let body = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() });
    let ring = [v2(-2.0, 0.0), v2(2.0, 0.0), v2(2.0, 4.0), v2(-2.0, 4.0)];
    let shapes = world.create_chain(body, &ring, true, &ShapeDef::default()).unwrap();
    assert_eq!(shapes.len(), 4);
    let b = world.create_body(&BodyDef { position: v2(0.0, 2.0), linear_velocity: v2(7.0, 3.0), angular_velocity: 3.0, ..Default::default() });
    world.create_shape(b, Core::rect(0.3, 0.2, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution: 0.5, ..Default::default() });
    for _ in 0..600 {
        world.step(DT);
        let p = world.bodies[b as usize].xf.p;
        assert!(p.x.abs() < 2.0 && p.y > 0.0 && p.y < 4.0, "left the ring at {p:?}");
    }
}

#[test]
fn a_chain_refuses_too_few_points() {
    let mut world = World::default();
    let body = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() });
    assert!(world.create_chain(body, &[v2(0.0, 0.0)], false, &ShapeDef::default()).is_err());
    assert!(world.create_chain(body, &[v2(0.0, 0.0), v2(0.0, 0.0)], false, &ShapeDef::default()).is_err());
    assert!(world.create_chain(body, &[v2(0.0, 0.0), v2(1.0, 0.0)], true, &ShapeDef::default()).is_err());
}
