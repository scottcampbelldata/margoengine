// Seams of a mesh of triangles (FIX_INTERNAL_EDGES in 2D): a shape slides over the joins between triangles without catching,
// and a strip with no seams joined catches as before.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::seams::find_seams;
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

/// A strip 0..10 by -1..0 cut into 40 triangles, its cuts slanted as a mesh exporter gives them (`thin`: 5 cm deep, slivers);
/// the shapes in order.
fn strip(w: &mut World, body: u32, thin: bool) -> Vec<u32> {
    let depth = if thin { -0.05 } else { -1.0 };
    let mut ids = Vec::new();
    for i in 0..20 {
        let (x0, x1) = (i as f32 * 0.5, i as f32 * 0.5 + 0.5);
        for tri in [[v2(x0, 0.0), v2(x0, depth), v2(x1, 0.0)], [v2(x0, depth), v2(x1, depth), v2(x1, 0.0)]] {
            ids.push(w.create_shape(body, Core::polygon(&tri, 0.0).unwrap(), &ShapeDef { friction: 0.0, ..Default::default() }).unwrap());
        }
    }
    ids
}

/// A 0.2 m box (or a 0.1 m ball) slid along the strip with no friction, starting at rest on it or dropped 0.3 m; the slowest it
/// went forward, the fastest it went up, and the most it turned, until it neared the far end.
fn slide(seamed: bool, thin: bool, ball: bool, speed: f32, drop: f32) -> (f32, f32, f32) {
    let mut w = World::new(Settings { gravity: v2(0.0, -9.81), ..Default::default() });
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let ids = strip(&mut w, ground, thin);
    if seamed {
        w.join_seams(&ids).unwrap();
    }
    let core = if ball { Core::circle(V2::ZERO, 0.1).unwrap() } else { Core::rect(0.1, 0.1, V2::ZERO, 1.0, 0.0, 0.0).unwrap() };
    let b = w
        .create_body(&BodyDef { position: v2(0.3, 0.1 + drop), linear_velocity: v2(speed, 0.0), can_sleep: false, ..Default::default() })
        .unwrap();
    w.create_shape(b, core, &ShapeDef { friction: 0.0, ..Default::default() }).unwrap();
    let (mut slowest, mut up, mut turn) = (f32::MAX, 0.0f32, 0.0f32);
    for _ in 0..80 {
        w.step(DT).unwrap();
        let body = &w.bodies[b as usize];
        if body.xf.p.x > 9.5 {
            break;
        }
        slowest = slowest.min(body.linear_velocity.x);
        up = up.max(body.linear_velocity.y);
        turn = turn.max(body.xf.q.s.atan2(body.xf.q.c).abs());
    }
    (slowest, up, turn)
}

#[test]
fn a_box_and_a_ball_slide_over_the_seams_of_a_joined_strip_without_catching() {
    for thin in [false, true] {
        for ball in [false, true] {
            for speed in [2.0f32, 6.0, 12.0] {
                for drop in [0.0f32, 0.3] {
                    let (slowest, up, turn) = slide(true, thin, ball, speed, drop);
                    let label = format!("thin {thin}, ball {ball}, {speed} m/s, dropped {drop} m");
                    assert!(slowest > speed * 0.999, "{label}: slowed to {slowest} m/s");
                    assert!(up < 0.01, "{label}: rose at {up} m/s");
                    assert!(ball || turn < 0.05, "{label}: turned {turn} rad");
                }
            }
        }
    }
}

#[test]
fn the_same_strip_unjoined_catches_which_is_what_the_seams_fix() {
    // The ghost collisions the seams remove: on the plain triangles every one of these is stopped, thrown up or tipped.
    for thin in [false, true] {
        for speed in [2.0f32, 6.0] {
            let (slowest, up, turn) = slide(false, thin, false, speed, 0.0);
            assert!(slowest < speed * 0.9 || up > 0.1 || turn > 0.1, "thin {thin}, {speed} m/s: slowest {slowest}, up {up}, turn {turn}");
        }
    }
}

#[test]
fn a_ball_on_the_strip_s_convex_end_corner_rolls_off_it_as_off_one_solid() {
    // Off the corner at (10, 0) a contact keeps the corner's tilted normal: the ball is pushed out and away, the same as on
    // the plain triangles there (no seam is near the end).
    let roll = |seamed: bool| {
        let mut w = World::new(Settings { gravity: v2(0.0, -9.81), ..Default::default() });
        let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
        let ids = strip(&mut w, ground, false);
        if seamed {
            w.join_seams(&ids).unwrap();
        }
        let b = w.create_body(&BodyDef { position: v2(10.03, 0.095), can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(b, Core::circle(V2::ZERO, 0.1).unwrap(), &ShapeDef::default()).unwrap();
        for _ in 0..20 {
            w.step(DT).unwrap();
        }
        w.bodies[b as usize].linear_velocity
    };
    let (seamed, plain) = (roll(true), roll(false));
    assert!(seamed.x > 0.1, "the ball was not pushed off the corner: {seamed:?}");
    assert!((seamed.x - plain.x).abs() < 1e-4 && (seamed.y - plain.y).abs() < 1e-4, "seamed {seamed:?}, plain {plain:?}");
}

#[test]
fn shared_edges_are_cuts_and_the_outline_corners_know_their_turn() {
    let tri = |a: V2, b: V2, c: V2| Core::polygon(&[a, b, c], 0.0).unwrap();
    // A unit square as two triangles: the diagonal is the only cut; all four corners are convex.
    let s = find_seams(&[tri(v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0)), tri(v2(0.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0))]).unwrap();
    assert_eq!(s[0].cut.count_ones() + s[1].cut.count_ones(), 2);
    for seams in &s {
        for corner in seams.corner.iter().flatten() {
            assert!(corner.2, "a square's corners are convex");
        }
    }
    // A polygon with a radius cannot be seamed.
    assert!(find_seams(&[Core::polygon(&[v2(0.0, 0.0), v2(1.0, 0.0), v2(0.0, 1.0)], 0.1).unwrap()]).is_err());
}

#[test]
fn a_snapshot_keeps_the_seams() {
    let mut w = World::new(Settings { gravity: v2(0.0, -9.81), ..Default::default() });
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let ids = strip(&mut w, ground, false);
    w.join_seams(&ids).unwrap();
    let back = World::from_snapshot(&w.snapshot()).unwrap();
    for &id in &ids {
        assert_eq!(back.shapes[id as usize].seams, w.shapes[id as usize].seams);
    }
}

#[test]
fn joining_refuses_what_cannot_be_seamed_and_changes_nothing() {
    let mut w = World::new(Settings::default());
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let other = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let ids = strip(&mut w, ground, false);
    let round = w.create_shape(ground, Core::polygon(&[v2(0.0, 1.0), v2(1.0, 1.0), v2(0.0, 2.0)], 0.05).unwrap(), &ShapeDef::default()).unwrap();
    let elsewhere = w.create_shape(other, Core::polygon(&[v2(0.0, 1.0), v2(1.0, 1.0), v2(0.0, 2.0)], 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let circle = w.create_shape(ground, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef::default()).unwrap();
    for bad in [vec![ids[0], round], vec![ids[0], elsewhere], vec![ids[0], ids[0]], vec![ids[0], circle], vec![ids[0], 999]] {
        assert!(w.join_seams(&bad).is_err(), "{bad:?}");
        assert!(w.shapes[ids[0] as usize].seams.is_none());
    }
}

#[test]
fn a_seamed_triangle_moved_on_its_body_turns_its_corners_and_a_new_outline_drops_them() {
    use margoengine_physics2d_kernel::math::{Rot, Xf};
    let mut w = World::new(Settings::default());
    let ground = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let ids = strip(&mut w, ground, false);
    w.join_seams(&ids).unwrap();
    let before = *w.shapes[ids[0] as usize].seams.clone().unwrap();
    let quarter = Rot { c: 0.0, s: 1.0 };
    w.move_shape(ids[0], Xf { p: V2::ZERO, q: quarter }).unwrap();
    let after = *w.shapes[ids[0] as usize].seams.clone().unwrap();
    assert_eq!(after.cut, before.cut);
    for (a, b) in after.corner.iter().zip(before.corner) {
        if let (Some(a), Some(b)) = (a, b) {
            assert!((a.0.sub(quarter.apply(b.0)).length()) < 1e-6 && a.2 == b.2);
        }
    }
    w.set_shape_core(ids[0], Core::polygon(&[v2(0.0, 0.0), v2(1.0, 0.0), v2(0.0, 1.0)], 0.0).unwrap()).unwrap();
    assert!(w.shapes[ids[0] as usize].seams.is_none());
}
