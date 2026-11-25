// Debug lines: the outline of each shape kind closes, rounded shapes bulge by their radius, and joints, contacts and
// boxes are drawn on request.
use margoengine_physics2d_kernel::debug::{COLOUR_AWAKE, COLOUR_FIXED, COLOUR_JOINT, COLOUR_SENSOR, DEBUG_ALL, DEBUG_BOXES, DEBUG_CONTACTS, DEBUG_JOINTS, DEBUG_SHAPES};
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

fn lines(w: &World, what: u32) -> Vec<[f32; 5]> {
    w.debug_lines(what).chunks(5).map(|c| [c[0], c[1], c[2], c[3], c[4]]).collect()
}

fn bounds(lines: &[[f32; 5]]) -> (V2, V2) {
    let (mut lo, mut hi) = (v2(f32::MAX, f32::MAX), v2(f32::MIN, f32::MIN));
    for l in lines {
        for (x, y) in [(l[0], l[1]), (l[2], l[3])] {
            lo = v2(lo.x.min(x), lo.y.min(y));
            hi = v2(hi.x.max(x), hi.y.max(y));
        }
    }
    (lo, hi)
}

fn one(core: Core, kind: Kind) -> World {
    let mut w = World::default();
    let b = w.create_body(&BodyDef { kind, position: v2(10.0, 20.0), ..Default::default() }).unwrap();
    w.create_shape(b, core, &ShapeDef::default()).unwrap();
    w
}

#[test]
fn outlines_close_and_reach_where_the_shape_does() {
    let cases = [
        (Core::circle(V2::ZERO, 1.5).unwrap(), 24, (8.5, 18.5, 11.5, 21.5)),
        (Core::rect(1.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), 4, (9.0, 19.5, 11.0, 20.5)),
        (Core::capsule(v2(-1.0, 0.0), v2(1.0, 0.0), 0.5).unwrap(), 0, (8.5, 19.5, 11.5, 20.5)),
        (Core::rect(1.0, 1.0, V2::ZERO, 1.0, 0.0, 0.5).unwrap(), 0, (8.5, 18.5, 11.5, 21.5)),
        (Core::segment(v2(0.0, 0.0), v2(2.0, 0.0)).unwrap(), 2, (10.0, 20.0, 12.0, 20.0)),
    ];
    for (core, count, (x0, y0, x1, y1)) in cases {
        let w = one(core, Kind::Static);
        let l = lines(&w, DEBUG_SHAPES);
        if count > 0 {
            assert_eq!(l.len(), count);
        }
        assert!(l.iter().all(|s| s[4] == COLOUR_FIXED));
        let (lo, hi) = bounds(&l);
        let near = |a: f32, b: f32| (a - b).abs() < 0.02;
        assert!(near(lo.x, x0) && near(lo.y, y0) && near(hi.x, x1) && near(hi.y, y1), "{lo:?} {hi:?} for {x0} {y0} {x1} {y1}");
        // Each point is the start of one segment and the end of one.
        if core.count > 1 && core.radius > 0.0 || core.count == 1 {
            for s in &l {
                assert!(l.iter().any(|t| (t[0] - s[2]).abs() < 1e-3 && (t[1] - s[3]).abs() < 1e-3), "open at {s:?}");
            }
        }
    }
}

#[test]
fn colours_follow_what_a_shape_is_doing_and_joints_contacts_and_boxes_are_asked_for() {
    let mut w = World::default();
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(ground, Core::rect(5.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let ball = w.create_body(&BodyDef { position: v2(0.0, 0.52), ..Default::default() }).unwrap();
    w.create_shape(ball, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    let zone = w.create_body(&BodyDef { kind: Kind::Static, position: v2(3.0, 3.0), ..Default::default() }).unwrap();
    w.create_shape(zone, Core::rect(1.0, 1.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { sensor: true, ..Default::default() }).unwrap();
    w.create_joint(&JointDef { kind: JointKind::Rope { length: 2.0 }, a: ground, b: ball, anchor_a: v2(0.0, 2.0), anchor_b: V2::ZERO, collide: true }).unwrap();
    w.step(1.0 / 60.0).unwrap();
    let all = lines(&w, DEBUG_ALL);
    let shapes = lines(&w, DEBUG_SHAPES);
    assert!(shapes.iter().any(|l| l[4] == COLOUR_FIXED) && shapes.iter().any(|l| l[4] == COLOUR_AWAKE) && shapes.iter().any(|l| l[4] == COLOUR_SENSOR));
    assert_eq!(lines(&w, DEBUG_JOINTS).len(), 1);
    assert_eq!(lines(&w, DEBUG_JOINTS)[0][4], COLOUR_JOINT);
    assert!(lines(&w, DEBUG_CONTACTS).len() >= 3, "a point and its normal");
    assert_eq!(lines(&w, DEBUG_BOXES).len() % 4, 0);
    assert!(lines(&w, DEBUG_BOXES).len() >= 12);
    assert_eq!(all.len(), shapes.len() + lines(&w, DEBUG_JOINTS).len() + lines(&w, DEBUG_CONTACTS).len() + lines(&w, DEBUG_BOXES).len());
    assert!(lines(&w, 0).is_empty());
    for _ in 0..300 {
        w.step(1.0 / 60.0).unwrap();
    }
    assert!(lines(&w, DEBUG_SHAPES).iter().any(|l| l[4] == margoengine_physics2d_kernel::debug::COLOUR_SLEEPING));
}

#[test]
fn axes_are_two_lines_a_body_along_its_own_x_and_y_and_a_skip_list_leaves_a_body_out() {
    use margoengine_physics2d_kernel::debug::{COLOUR_AXIS_X, COLOUR_AXIS_Y, DEBUG_AXES};
    use margoengine_physics2d_kernel::math::Rot;
    let mut w = World::default();
    let turned = w.create_body(&BodyDef { position: v2(1.0, 2.0), rotation: Rot::from_pair(0.0, 1.0), ..Default::default() }).unwrap();
    let other = w.create_body(&BodyDef { position: v2(5.0, 0.0), ..Default::default() }).unwrap();
    let _ = other;
    let axes = lines(&w, DEBUG_AXES);
    assert_eq!(axes.len(), 4, "two a body");
    let x = axes.iter().find(|l| l[4] == COLOUR_AXIS_X && (l[0] - 1.0).abs() < 1e-5).expect("the turned body's x axis");
    // Turned a quarter, its x axis points up the world's y: from (1, 2) to (1, 2.5).
    assert!((x[2] - 1.0).abs() < 1e-4 && (x[3] - 2.5).abs() < 1e-4, "{:?}", x);
    let y = axes.iter().find(|l| l[4] == COLOUR_AXIS_Y && (l[0] - 1.0).abs() < 1e-5).unwrap();
    assert!((y[2] - 0.5).abs() < 1e-4 && (y[3] - 2.0).abs() < 1e-4, "{:?}", y);
    let left: Vec<f32> = w.debug_lines_without(DEBUG_AXES, &[turned]);
    assert_eq!(left.len() / 5, 2, "the skipped body's axes are gone");
}
