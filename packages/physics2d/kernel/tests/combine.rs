// How a contact combines two shapes' friction and restitution (Rapier's `CoefficientCombineRule`): the average by default,
// or the smaller, the product or the larger, the later rule in that order winning when the two shapes differ.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{
    BodyDef, COMBINE_AVERAGE, COMBINE_CLAMPED_SUM, COMBINE_GEOMETRIC_MEAN, COMBINE_MAX, COMBINE_MIN, COMBINE_MULTIPLY, Kind, ShapeDef, World, combine,
};

const DT: f32 = 1.0 / 60.0;

#[test]
fn each_rule_combines_as_it_says_and_the_later_of_two_rules_wins() {
    let (a, b) = (0.2f32, 0.8f32);
    assert_eq!(combine(a, COMBINE_AVERAGE, b, COMBINE_AVERAGE), 0.5);
    assert_eq!(combine(a, COMBINE_MIN, b, COMBINE_MIN), 0.2);
    assert_eq!(combine(a, COMBINE_MULTIPLY, b, COMBINE_MULTIPLY), a * b);
    assert_eq!(combine(a, COMBINE_MAX, b, COMBINE_MAX), 0.8);
    assert_eq!(combine(a, COMBINE_CLAMPED_SUM, b, COMBINE_CLAMPED_SUM), 1.0);
    assert_eq!(combine(0.2, COMBINE_CLAMPED_SUM, 0.3, COMBINE_CLAMPED_SUM), 0.2 + 0.3);
    assert!((combine(a, COMBINE_GEOMETRIC_MEAN, b, COMBINE_GEOMETRIC_MEAN) - 0.4).abs() < 1e-7);
    assert_eq!(combine(0.0, COMBINE_GEOMETRIC_MEAN, b, COMBINE_GEOMETRIC_MEAN), 0.0);
    // Average < Min < Multiply < Max: the later wins, from either side.
    assert_eq!(combine(a, COMBINE_MIN, b, COMBINE_AVERAGE), 0.2);
    assert_eq!(combine(a, COMBINE_AVERAGE, b, COMBINE_MULTIPLY), a * b);
    assert_eq!(combine(a, COMBINE_MULTIPLY, b, COMBINE_MAX), 0.8);
    assert_eq!(combine(a, COMBINE_MAX, b, COMBINE_CLAMPED_SUM), 1.0);
    assert!((combine(a, COMBINE_CLAMPED_SUM, b, COMBINE_GEOMETRIC_MEAN) - 0.4).abs() < 1e-7);
    // Two coefficients near f32::MAX average to a finite number.
    assert_eq!(combine(f32::MAX, COMBINE_AVERAGE, f32::MAX, COMBINE_AVERAGE), f32::MAX);
}

/// The rebound of a ball of restitution 0.8 dropped 2 m onto a floor of restitution 0, its rule `rule`, as a fraction of the drop.
fn rebound(rule: u8) -> f32 {
    let mut w = World::default();
    let floor = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(floor, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef { restitution: 0.0, ..Default::default() }).unwrap();
    let ball = w.create_body(&BodyDef { position: v2(0.0, 2.25), ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.25).unwrap(), &ShapeDef { restitution: 0.8, restitution_rule: rule, ..Default::default() }).unwrap();
    let (mut hit, mut peak) = (false, 0.0f32);
    for _ in 0..240 {
        w.step(DT).unwrap();
        if !hit && w.bodies[ball as usize].linear_velocity.y > 0.0 {
            hit = true;
        }
        if hit {
            peak = peak.max(w.bodies[ball as usize].xf.p.y - 0.25);
        }
    }
    peak / 2.0
}

#[test]
fn a_ball_bounces_by_the_pair_s_rule_the_average_by_default() {
    // The rebound height is e^2 of the drop, e the pair's restitution: 0.4 by the average (0.16), 0.8 by the larger (0.64),
    // none by the smaller or the product. The contact solver's restitution threshold and step take a little: within 0.85
    // to 1.05 of e^2.
    let average = rebound(COMBINE_AVERAGE);
    assert!(average >= 0.85 * 0.16 && average <= 1.05 * 0.16, "average: {average}");
    let max = rebound(COMBINE_MAX);
    assert!(max >= 0.85 * 0.64 && max <= 1.05 * 0.64, "max: {max}");
    for rule in [COMBINE_MIN, COMBINE_MULTIPLY] {
        assert!(rebound(rule) < 0.01, "rule {rule}: no bounce");
    }
}

#[test]
fn a_rule_past_the_last_is_refused() {
    let mut w = World::default();
    let b = w.create_body(&BodyDef::default()).unwrap();
    assert!(w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef { friction_rule: 6, ..Default::default() }).is_err());
}
