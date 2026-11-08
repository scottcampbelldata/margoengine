// Compound colliders: the children weigh what the same shapes as colliders of their own weigh, rest and touch as one
// collider with a part for each child that touches, leave the gaps between them empty, and go with their compound.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const DT: f32 = 1.0 / 60.0;
const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
/// A quarter turn about Z: a capsule's Y axis along X.
const ALONG_X: [f32; 4] = [0.0, 0.0, 0.707_106_8, 0.707_106_8];

fn floor(w: &mut World) -> u32 {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [10.0, 0.5, 10.0], [0.0, -0.5, 0.0], ID, 0.0).unwrap()
}

fn awake(w: &mut World, kind: u32, at: V3) -> u32 {
    let body = w.add_body(kind).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    body
}

/// Two balls of radius 0.5 at x = -1 and 1 on a thin capsule bar along X: a dumbbell, as one compound.
fn dumbbell(w: &mut World, body: u32) -> u32 {
    let c = w.add_collider(body, SHAPE_COMPOUND, [0.0; 3], [0.0; 3], ID, 1.0).unwrap();
    w.add_compound_part(c, SHAPE_BALL, [0.5, 0.0, 0.0], [-1.0, 0.0, 0.0], ID).unwrap();
    w.add_compound_part(c, SHAPE_BALL, [0.5, 0.0, 0.0], [1.0, 0.0, 0.0], ID).unwrap();
    w.add_compound_part(c, SHAPE_CAPSULE, [0.1, 0.5, 0.0], [0.0; 3], ALONG_X).unwrap();
    c
}

fn parts_of(w: &World, row: u32) -> Vec<u32> {
    let mut out = vec![];
    let mut part = w.uu(PAIR_CHILD, row as usize);
    while part != NONE {
        out.push(part);
        part = w.uu(PAIR_CHILD, part as usize);
    }
    out
}

fn touching(w: &World, part: u32) -> bool {
    w.uu(PAIR_CONTACTS, part as usize) > 0
}

#[test]
fn a_compound_weighs_what_its_children_weigh_as_colliders() {
    let mut w = World::new(4, 8).unwrap();
    let one = w.add_body(DYNAMIC).unwrap();
    dumbbell(&mut w, one);
    let three = w.add_body(DYNAMIC).unwrap();
    w.add_collider(three, SHAPE_BALL, [0.5, 0.0, 0.0], [-1.0, 0.0, 0.0], ID, 1.0).unwrap();
    w.add_collider(three, SHAPE_BALL, [0.5, 0.0, 0.0], [1.0, 0.0, 0.0], ID, 1.0).unwrap();
    w.add_collider(three, SHAPE_CAPSULE, [0.1, 0.5, 0.0], [0.0; 3], ALONG_X, 1.0).unwrap();
    for column in [INVERSE_MASS, LOCAL_CENTER_X, LOCAL_CENTER_Y, LOCAL_CENTER_Z, INERTIA_X, INERTIA_Y, INERTIA_Z] {
        assert_eq!(w.s(column, one as usize).to_bits(), w.s(column, three as usize).to_bits(), "column {column}");
    }
    let ball = 4.0 / 3.0 * 3.141_592_7 * 0.125;
    let bar = 3.141_592_7 * 0.01 * (4.0 / 3.0 * 0.1 + 1.0);
    let mass = 1.0 / w.s(INVERSE_MASS, one as usize);
    assert!((mass - (2.0 * ball + bar)).abs() < 1e-5 * mass, "mass {mass}");
    // The compound's density sets every child's.
    let compound = w.uu(FIRST_COLLIDER, one as usize) as usize;
    w.set_s(COLLIDER_DENSITY, compound, 2.0);
    w.update_mass(one);
    assert!((1.0 / w.s(INVERSE_MASS, one as usize) - 2.0 * mass).abs() < 1e-5 * mass);
}

#[test]
fn a_child_sits_in_the_body_frame_through_the_compound_pose() {
    let mut w = World::new(2, 4).unwrap();
    let body = w.add_body(DYNAMIC).unwrap();
    let c = w.add_collider(body, SHAPE_COMPOUND, [0.0; 3], [0.0, 1.0, 0.0], ALONG_X, 1.0).unwrap();
    let child = w.add_compound_part(c, SHAPE_BOX, [0.1, 0.2, 0.3], [1.0, 0.0, 0.0], ID).unwrap() as usize;
    let p = w.v(COLLIDER_X, child);
    assert!(p.x.abs() < 1e-6 && (p.y - 2.0).abs() < 1e-6 && p.z.abs() < 1e-6, "child at {p:?}");
    let q = w.q(COLLIDER_ROTATION_X, child);
    assert!((q.z - 0.707_106_8).abs() < 1e-6 && (q.w - 0.707_106_8).abs() < 1e-6, "child turned {q:?}");
    // Not a convex child, or not a compound: refused.
    assert!(w.add_compound_part(c, SHAPE_TRIMESH, [0.0; 3], [0.0; 3], ID).is_none());
    assert!(w.add_compound_part(c, SHAPE_COMPOUND, [0.0; 3], [0.0; 3], ID).is_none());
    assert!(w.add_compound_part(child as u32, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], ID).is_none());
}

#[test]
fn a_dumbbell_rests_on_its_two_balls_as_one_pair() {
    let mut w = World::new(4, 8).unwrap();
    let ground = floor(&mut w);
    let body = awake(&mut w, DYNAMIC, v3(0.0, 3.0, 0.0));
    let c = dumbbell(&mut w, body);
    let mut started = 0;
    for _ in 0..240 {
        w.step(DT);
        for i in 0..w.header().events as usize {
            if w.uu(EVENTS, 2 * i) & EVENT_STARTED != 0 {
                started += 1;
            }
        }
        w.header_mut().events = 0;
    }
    let p = w.v(POSITION_X, body as usize);
    println!("dumbbell rests at {p:?}");
    assert!((p.y - 0.5).abs() < 0.01 && p.x.abs() < 0.01, "rests on its balls at {p:?}");
    assert_eq!(started, 1, "one contact pair for the whole compound");
    assert_eq!(w.header().pairs, 1);
    let row = (0..w.header().pair_rows).find(|&r| w.uu(PAIR_A, r as usize) != NONE && w.uu(PAIR_FLAGS, r as usize) & PAIR_IS_PART == 0).unwrap();
    assert_eq!((w.uu(PAIR_A, row as usize), w.uu(PAIR_B, row as usize)), (ground.min(c), ground.max(c)));
    let held: Vec<u32> = parts_of(&w, row).into_iter().filter(|&p| touching(&w, p)).collect();
    assert_eq!(held.len(), 2, "a part for each ball, none for the bar");
    assert!(w.uu(PAIR_FLAGS, row as usize) & PAIR_TOUCHING != 0);
}

#[test]
fn a_dumbbell_rests_on_a_triangle_mesh() {
    let mut w = World::new(4, 8).unwrap();
    let vertices = [v3(-5.0, 0.0, -5.0), v3(-5.0, 0.0, 5.0), v3(5.0, 0.0, -5.0), v3(5.0, 0.0, 5.0)];
    assert!(w.begin_mesh(4, 2));
    let [_, v0, t0, _, _] = w.header().mesh_rows;
    for (i, &p) in vertices.iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 as usize + i, p);
    }
    for (i, tri) in [[0u32, 1, 2], [2, 1, 3]].iter().enumerate() {
        let at = t0 as usize + i;
        w.set_u(TRIANGLE_A, at, tri[0]);
        w.set_u(TRIANGLE_B, at, tri[1]);
        w.set_u(TRIANGLE_C, at, tri[2]);
        for k in 0..3 {
            w.set_u(TRIANGLE_ACROSS_0 + k, at, NONE);
        }
    }
    w.set_u(TRIANGLE_ACROSS_0 + 1, t0 as usize, 1);
    w.set_u(TRIANGLE_ACROSS_0, t0 as usize + 1, 0);
    let mesh = w.end_mesh(4, 2, MESH_FIX_EDGES);
    assert!(mesh >= 0);
    let ground = w.add_body(FIXED).unwrap();
    w.add_collider(ground, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], ID, 0.0).unwrap();
    let body = awake(&mut w, DYNAMIC, v3(0.3, 2.0, -0.2));
    dumbbell(&mut w, body);
    for _ in 0..240 {
        w.step(DT);
    }
    let p = w.v(POSITION_X, body as usize);
    println!("dumbbell on a mesh at {p:?}");
    assert!((p.y - 0.5).abs() < 0.01 && (p.x - 0.3).abs() < 0.01, "rests at {p:?}");
    // Parts name a triangle and the child on it.
    let row = (0..w.header().pair_rows).find(|&r| w.uu(PAIR_A, r as usize) != NONE && w.uu(PAIR_FLAGS, r as usize) & PAIR_IS_PART == 0).unwrap();
    for part in parts_of(&w, row).into_iter().filter(|&p| touching(&w, p)) {
        assert!(w.uu(PAIR_PART, part as usize) < 2 && w.uu(PAIR_SUB, part as usize) != NONE);
    }
}

#[test]
fn compound_boxes_stack() {
    let mut w = World::new(4, 16).unwrap();
    floor(&mut w);
    let mut bodies = vec![];
    for k in 0..3 {
        let body = awake(&mut w, DYNAMIC, v3(0.0, 0.5 + 1.1 * k as f32, 0.0));
        let c = w.add_collider(body, SHAPE_COMPOUND, [0.0; 3], [0.0; 3], ID, 1.0).unwrap();
        // Two half boxes side by side make one 1 m cube.
        w.add_compound_part(c, SHAPE_BOX, [0.25, 0.5, 0.5], [-0.25, 0.0, 0.0], ID).unwrap();
        w.add_compound_part(c, SHAPE_BOX, [0.25, 0.5, 0.5], [0.25, 0.0, 0.0], ID).unwrap();
        bodies.push(body);
    }
    for _ in 0..300 {
        w.step(DT);
    }
    for (k, &body) in bodies.iter().enumerate() {
        let p = w.v(POSITION_X, body as usize);
        assert!((p.y - (0.5 + k as f32)).abs() < 0.02 && p.x.abs() < 0.01 && p.z.abs() < 0.01, "cube {k} at {p:?}");
    }
}

#[test]
fn the_gap_between_children_is_empty() {
    let mut w = World::new(4, 8).unwrap();
    floor(&mut w);
    // Two posts with a 1 m gap between them.
    let posts = w.add_body(FIXED).unwrap();
    let c = w.add_collider(posts, SHAPE_COMPOUND, [0.0; 3], [0.0, 1.0, 0.0], ID, 0.0).unwrap();
    w.add_compound_part(c, SHAPE_BOX, [0.5, 1.0, 0.5], [-1.0, 0.0, 0.0], ID).unwrap();
    w.add_compound_part(c, SHAPE_BOX, [0.5, 1.0, 0.5], [1.0, 0.0, 0.0], ID).unwrap();
    let falls = awake(&mut w, DYNAMIC, v3(0.0, 4.0, 0.0));
    w.add_collider(falls, SHAPE_BALL, [0.3, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    let stays = awake(&mut w, DYNAMIC, v3(1.0, 4.0, 0.0));
    w.add_collider(stays, SHAPE_BALL, [0.3, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    for _ in 0..240 {
        w.step(DT);
    }
    let (a, b) = (w.v(POSITION_X, falls as usize), w.v(POSITION_X, stays as usize));
    assert!((a.y - 0.3).abs() < 0.01, "falls through the gap to the floor: {a:?}");
    assert!((b.y - 2.3).abs() < 0.01, "rests on a post: {b:?}");
}

#[test]
fn a_compound_sensor_sees_a_ball_in_a_child_only() {
    let mut w = World::new(4, 8).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let holder = w.add_body(FIXED).unwrap();
    let c = w.add_collider(holder, SHAPE_COMPOUND, [0.0; 3], [0.0; 3], ID, 0.0).unwrap();
    w.add_compound_part(c, SHAPE_BOX, [0.5, 0.5, 0.5], [-2.0, 0.0, 0.0], ID).unwrap();
    w.add_compound_part(c, SHAPE_BOX, [0.5, 0.5, 0.5], [2.0, 0.0, 0.0], ID).unwrap();
    w.set_collider_state(c, COLLIDER_SENSOR);
    let ball = awake(&mut w, DYNAMIC, v3(0.0, 0.0, 0.0));
    w.add_collider(ball, SHAPE_BALL, [0.2, 0.0, 0.0], [0.0; 3], ID, 1.0).unwrap();
    let mut log = vec![];
    for (x, steps) in [(0.0, 2), (2.0, 2), (0.0, 2)] {
        w.set_pose(ball, v3(x, 0.0, 0.0), Q::IDENTITY, false);
        for _ in 0..steps {
            w.step(DT);
            for i in 0..w.header().events as usize {
                let word = w.uu(EVENTS, 2 * i);
                log.push((word & EVENT_STARTED != 0, word & EVENT_SENSOR != 0));
            }
            w.header_mut().events = 0;
        }
    }
    assert_eq!(log, vec![(true, true), (false, true)], "starts in the right box, ends back in the gap");
}

#[test]
fn removing_a_compound_frees_its_children() {
    let mut w = World::new(4, 8).unwrap();
    floor(&mut w);
    let body = awake(&mut w, DYNAMIC, v3(0.0, 0.5, 0.0));
    let rows = {
        let c = dumbbell(&mut w, body);
        w.step(DT);
        assert!(w.remove_collider(c));
        w.step(DT);
        w.header().collider_rows
    };
    for _ in 0..5 {
        let c = dumbbell(&mut w, body);
        w.step(DT);
        assert!(w.remove_collider(c));
        w.step(DT);
        assert_eq!(w.header().collider_rows, rows, "rows come back for the next compound");
    }
    assert_eq!(w.header().pairs, 0);
    // A body with no collider left weighs nothing.
    assert_eq!(w.s(INVERSE_MASS, body as usize), 0.0);
}
