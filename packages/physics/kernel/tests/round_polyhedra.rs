// A box or hull with a border (Rapier's round cuboid and round convex): its surface is every point within the border of the
// core, so closed forms hold: a face is a border out, a corner a sphere of the border's radius.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn close(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol * (1.0 + a.abs().max(b.abs()))
}

fn round_box(w: &mut World, kind: u32, half: [f32; 3], border: f32, at: V3) -> (u32, u32) {
    let body = w.add_body(kind).unwrap();
    let c = w.add_collider(body, SHAPE_BOX, half, [0.0; 3], ID, 1.0).unwrap();
    assert!(w.set_collider_border(c, border));
    w.set_v(POSITION_X, body as usize, at);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    (body, c)
}

#[test]
fn a_ray_meets_a_face_a_border_out_and_a_corner_on_the_border_sphere() {
    let mut w = World::new(8, 8).unwrap();
    let (_, c) = round_box(&mut w, FIXED, [1.0, 1.0, 1.0], 0.25, v3(0.0, 0.0, 0.0));
    w.step(DT);
    let face = w.ray_collider(c as usize, v3(-5.0, 0.3, 0.2), v3(1.0, 0.0, 0.0), 100.0, true).unwrap();
    assert!(close(face.t, 5.0 - 1.25, 1e-4), "{}", face.t);
    assert!(close(face.normal.x, -1.0, 1e-3) && face.normal.y.abs() < 1e-3);
    // Along the diagonal to the corner (1, 1, 1): the border sphere's near point is a border from the corner.
    let d = v3(-1.0, -1.0, -1.0).scale(1.0 / sqrt(3.0));
    let corner = w.ray_collider(c as usize, v3(5.0, 5.0, 5.0), d, 100.0, true).unwrap();
    let to_corner = 5.0 * sqrt(3.0) - sqrt(3.0);
    assert!(close(corner.t, to_corner - 0.25, 1e-4), "{} vs {}", corner.t, to_corner - 0.25);
    assert!(close(corner.normal.x, 1.0 / sqrt(3.0), 1e-3), "{:?}", corner.normal);
}

#[test]
fn a_round_box_rests_a_border_higher_than_a_sharp_one() {
    let mut w = World::new(8, 8).unwrap();
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [20.0, 0.5, 20.0], [0.0, -0.5, 0.0], ID, 0.0).unwrap();
    let (body, _) = round_box(&mut w, DYNAMIC, [0.5, 0.5, 0.5], 0.1, v3(0.0, 1.0, 0.0));
    for _ in 0..240 {
        w.step(DT);
    }
    // The core rests 0.5 + 0.1 above the floor's top face.
    let y = w.v(POSITION_X, body as usize).y;
    assert!(close(y, 0.6, 5e-3), "{y}");
}

#[test]
fn a_border_widens_the_reach_of_the_broad_phase() {
    let mut w = World::new(8, 8).unwrap();
    let (_, a) = round_box(&mut w, FIXED, [0.5, 0.5, 0.5], 0.0, v3(0.0, 0.0, 0.0));
    let (_, b) = round_box(&mut w, DYNAMIC, [0.5, 0.5, 0.5], 0.0, v3(1.3, 0.0, 0.0));
    w.header_mut().gravity = [0.0; 3];
    w.step(DT);
    let before = w.header().pairs;
    assert_eq!(before, 0, "boxes 0.3 apart are not yet near");
    assert!(w.set_collider_border(a, 0.35));
    w.step(DT);
    assert!(w.header().pairs >= 1, "a border of 0.35 closes the 0.3 gap");
    let _ = b;
}

#[test]
fn a_border_is_refused_for_what_cannot_have_one() {
    let mut w = World::new(8, 8).unwrap();
    let body = w.add_body(FIXED).unwrap();
    let ball = w.add_collider(body, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    assert!(!w.set_collider_border(ball, 0.1));
    let (_, b) = round_box(&mut w, FIXED, [0.5, 0.5, 0.5], 0.0, v3(0.0, 0.0, 0.0));
    assert!(!w.set_collider_border(b, -1.0));
    assert!(!w.set_collider_border(b, f32::NAN));
    assert!(!w.set_collider_border(999, 0.1));
}
