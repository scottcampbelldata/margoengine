// Contact ids and warm starting: what a point keeps from step to step, against hand-written impulses.
use margoengine_physics_kernel::contact::{Kept, match_points, reproject, tangent_of};
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn kept(id: u32, x: f32) -> Kept {
    let zero = v3(0.0, 0.0, 0.0);
    Kept { id, anchor_a: v3(x, 0.0, 0.0), normal_impulse: 0.0, tangent_impulse: zero, drift: zero }
}
fn near(a: V3, b: V3) -> bool {
    let d = a.sub(b);
    d.dot(d) < 1e-10
}

fn crate_world(shape: u32, size: [f32; 3], kind: u32) -> (World, u32, u32) {
    let mut w = World::new(2, 2).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [5.0, 0.5, 5.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, floor as usize, v3(0.0, -0.5, 0.0));
    let body = w.add_body(kind).unwrap();
    w.add_collider(body, shape, size, [0.0; 3], IDENTITY, 1.0).unwrap();
    (w, floor, body)
}

/// Finds pairs and points without moving anything, so what a test wrote stays until the next call.
fn detect(w: &mut World, dt: f32) {
    w.broad_update(dt);
    w.narrow_phase(dt);
}

/// Marks each point of pair row 0 with an impulse that tells it apart.
fn mark(w: &mut World) -> Vec<(u32, f32)> {
    (0..w.uu(PAIR_CONTACTS, 0) as usize)
        .map(|k| {
            let value = 10.0 + k as f32;
            w.set_s(CONTACT_NORMAL_IMPULSE, k, value);
            (w.uu(CONTACT_ID, k), value)
        })
        .collect()
}

#[test]
fn points_match_by_id_whatever_their_order() {
    let old = [kept(7, 0.0), kept(9, 1.0), kept(11, 2.0)];
    let found = match_points(&old, &[(11, v3(9.0, 0.0, 0.0)), (7, v3(9.0, 0.0, 0.0)), (9, v3(9.0, 0.0, 0.0))]);
    assert_eq!(&found[..3], &[2, 0, 1]);
}

#[test]
fn a_point_with_a_new_id_continues_the_nearest_old_one_only_when_it_is_close() {
    let old = [kept(1, 0.0), kept(2, 1.0)];
    let found = match_points(&old, &[(50, v3(0.99, 0.0, 0.0)), (51, v3(0.5, 0.0, 0.0))]);
    assert_eq!(&found[..2], &[1, MANIFOLD]);
}

#[test]
fn an_old_point_goes_to_one_new_point_at_most() {
    // The id wins over distance, and a second claimant finds the point taken.
    let old = [kept(1, 0.0)];
    let found = match_points(&old, &[(60, v3(0.001, 0.0, 0.0)), (1, v3(5.0, 0.0, 0.0)), (1, v3(5.0, 0.0, 0.0))]);
    assert_eq!(&found[..3], &[MANIFOLD, 0, MANIFOLD]);
}

#[test]
fn an_impulse_turns_with_the_normal_as_one_world_vector() {
    let mut k = kept(1, 0.0);
    k.normal_impulse = 2.0;
    k.tangent_impulse = v3(1.0, 0.0, 0.0);
    k.drift = v3(0.25, 0.5, 0.0);
    let up = v3(0.0, 1.0, 0.0);
    // The same normal: nothing changes, and the sum is what it was.
    let (n, t, d) = reproject(&k, up, up, 1.0);
    assert_eq!(n, 2.0);
    assert!(near(t, v3(1.0, 0.0, 0.0)));
    assert!(near(d, v3(0.25, 0.0, 0.0)), "drift lies in the new tangent plane");
    // Turned 90 degrees onto the old tangent: the tangent impulse is now the normal one.
    let (n, t, _) = reproject(&k, up, v3(1.0, 0.0, 0.0), 1.0);
    assert_eq!(n, 1.0);
    assert!(near(t, v3(0.0, 2.0, 0.0)));
    // Half the substep: half the impulse, the same drift.
    let (n, t, d) = reproject(&k, up, up, 0.5);
    assert_eq!(n, 1.0);
    assert!(near(t, v3(0.5, 0.0, 0.0)));
    assert!(near(d, v3(0.25, 0.0, 0.0)));
    // Pushing the other way now: nothing carries.
    let (n, t, d) = reproject(&k, up, v3(0.0, -1.0, 0.0), 1.0);
    assert_eq!((n, t, d), (0.0, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0)));
}

#[test]
fn a_tangent_is_square_to_its_normal_and_unit_along_every_axis() {
    for n in [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0), v3(0.0, -1.0, 0.0), v3(0.6, 0.8, 0.0), v3(0.0, 0.6, -0.8)] {
        let t = tangent_of(n);
        assert!(t.dot(n).abs() < 1e-6);
        assert!((t.dot(t) - 1.0).abs() < 1e-6);
    }
}

#[test]
fn a_resting_box_keeps_its_impulses_by_id_from_step_to_step() {
    let (mut w, _, body) = crate_world(SHAPE_BOX, [0.5, 0.5, 0.5], DYNAMIC);
    w.set_v(POSITION_X, body as usize, v3(0.0, 0.49, 0.0));
    detect(&mut w, DT);
    assert_eq!(w.uu(PAIR_CONTACTS, 0), 4);
    let marked = mark(&mut w);
    detect(&mut w, DT);
    assert_eq!(w.uu(PAIR_CONTACTS, 0), 4);
    for k in 0..4 {
        let id = w.uu(CONTACT_ID, k);
        let expected = marked.iter().find(|m| m.0 == id).expect("the same four ids").1;
        assert_eq!(w.s(CONTACT_NORMAL_IMPULSE, k), expected);
    }
}

#[test]
fn a_ball_and_a_capsule_keep_theirs_by_their_round_ids() {
    let (mut w, _, body) = crate_world(SHAPE_BALL, [0.5, 0.0, 0.0], DYNAMIC);
    w.set_v(POSITION_X, body as usize, v3(0.0, 0.49, 0.0));
    detect(&mut w, DT);
    assert_eq!(w.uu(PAIR_CONTACTS, 0), 1);
    mark(&mut w);
    detect(&mut w, DT);
    assert_eq!(w.s(CONTACT_NORMAL_IMPULSE, 0), 10.0);

    let (mut w, _, body) = crate_world(SHAPE_CAPSULE, [0.25, 0.5, 0.0], DYNAMIC);
    // Lying down: a quarter turn about Z.
    let s = 0.5f32.sqrt();
    w.set_q(ROTATION_X, body as usize, Q { x: 0.0, y: 0.0, z: s, w: s });
    w.set_v(POSITION_X, body as usize, v3(0.0, 0.24, 0.0));
    detect(&mut w, DT);
    assert_eq!(w.uu(PAIR_CONTACTS, 0), 2);
    let marked = mark(&mut w);
    detect(&mut w, DT);
    for k in 0..2 {
        let id = w.uu(CONTACT_ID, k);
        assert_eq!(w.s(CONTACT_NORMAL_IMPULSE, k), marked.iter().find(|m| m.0 == id).unwrap().1);
    }
}

#[test]
fn a_pair_that_parts_and_meets_again_starts_from_zero() {
    let (mut w, _, body) = crate_world(SHAPE_BALL, [0.5, 0.0, 0.0], DYNAMIC);
    w.set_v(POSITION_X, body as usize, v3(0.0, 0.49, 0.0));
    detect(&mut w, DT);
    mark(&mut w);
    // Past the margin, the broad phase keeps the pair; further, it drops it and the row is free. Both forget.
    for height in [0.56, 0.7] {
        w.set_pose(body, v3(0.0, height, 0.0), Q::IDENTITY, true);
        detect(&mut w, DT);
        assert_eq!(w.header().pairs, if height < 0.6 { 1 } else { 0 });
        assert_eq!(w.uu(PAIR_CONTACTS, 0), if height < 0.6 { 0 } else { w.uu(PAIR_CONTACTS, 0) });
        w.set_pose(body, v3(0.0, 0.49, 0.0), Q::IDENTITY, true);
        detect(&mut w, DT);
        assert_eq!(w.uu(PAIR_CONTACTS, 0), 1);
        assert_eq!(w.s(CONTACT_NORMAL_IMPULSE, 0), 0.0);
        mark(&mut w);
    }
}

#[test]
fn a_new_substep_length_scales_what_carries() {
    let (mut w, _, body) = crate_world(SHAPE_BALL, [0.5, 0.0, 0.0], DYNAMIC);
    w.header_mut().substeps = 4;
    w.set_v(POSITION_X, body as usize, v3(0.0, 0.49, 0.0));
    detect(&mut w, DT);
    mark(&mut w);
    detect(&mut w, DT * 0.5);
    assert_eq!(w.s(CONTACT_NORMAL_IMPULSE, 0), 5.0);
    w.header_mut().substeps = 8;
    detect(&mut w, DT * 0.5);
    assert_eq!(w.s(CONTACT_NORMAL_IMPULSE, 0), 2.5);
}

#[test]
fn warm_starting_applies_the_carried_impulses_at_the_anchors() {
    // A unit ball on a fixed floor, the point straight below the centre: only the linear velocity changes for a normal
    // impulse, and a tangent impulse turns it by r x P through the inverse inertia.
    let (mut w, floor, body) = crate_world(SHAPE_BALL, [0.5, 0.0, 0.0], DYNAMIC);
    w.set_v(POSITION_X, body as usize, v3(0.0, 0.49, 0.0));
    detect(&mut w, DT);
    let at = body as usize;
    w.set_v(LINEAR_X, at, v3(0.0, 0.0, 0.0));
    w.set_v(ANGULAR_X, at, v3(0.0, 0.0, 0.0));
    let normal = w.v(PAIR_NORMAL_X, 0);
    assert!(near(normal, v3(0.0, -1.0, 0.0)) || near(normal, v3(0.0, 1.0, 0.0)));
    let up = if w.uu(PAIR_A, 0) == w.uu(FIRST_COLLIDER, floor as usize) { 1.0 } else { -1.0 };
    assert_eq!(normal.y, up, "the normal runs from A to B, floor to ball when the floor is A");
    w.set_s(CONTACT_NORMAL_IMPULSE, 0, 3.0);
    w.set_v(CONTACT_TANGENT_X, 0, v3(1.0, 0.0, 0.0).scale(up));
    w.prepare_contacts();
    w.warm_start();
    let inverse_mass = w.s(INVERSE_MASS, at);
    assert!(near(w.v(LINEAR_X, at), v3(inverse_mass, 3.0 * inverse_mass, 0.0)), "{:?}", w.v(LINEAR_X, at));
    // r = (0, -0.5, 0) (the anchor), P = (1, 3, 0): r x P = (0, 0, 0.5), through I^-1 = 1 / (2/5 m r^2).
    let inverse_inertia = w.s(INVERSE_INERTIA_X, at);
    let arm = w.q(ROTATION_X, at).rotate(if up > 0.0 { w.v(CONTACT_ANCHOR_B_X, 0) } else { w.v(CONTACT_ANCHOR_A_X, 0) });
    assert!(near(w.v(ANGULAR_X, at), arm.cross(v3(1.0, 3.0, 0.0)).scale(inverse_inertia)));
    assert!(arm.y < -0.49 && arm.x == 0.0);
    assert_eq!(w.v(LINEAR_X, floor as usize), v3(0.0, 0.0, 0.0), "a fixed body takes nothing");
}

#[test]
fn warm_starting_two_bodies_pushes_them_apart_with_equal_momentum() {
    let mut w = World::new(2, 2).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let (a, b) = (w.add_body(DYNAMIC).unwrap(), w.add_body(DYNAMIC).unwrap());
    w.add_collider(a, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.add_collider(b, SHAPE_BALL, [0.25, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, b as usize, v3(0.74, 0.0, 0.0));
    detect(&mut w, DT);
    assert_eq!(w.uu(PAIR_CONTACTS, 0), 1);
    w.set_s(CONTACT_NORMAL_IMPULSE, 0, 2.0);
    w.prepare_contacts();
    w.warm_start();
    let momentum = |body: u32| w.v(LINEAR_X, body as usize).scale(1.0 / w.s(INVERSE_MASS, body as usize));
    assert!(near(momentum(a).add(momentum(b)), v3(0.0, 0.0, 0.0)));
    assert!((momentum(b).x - 2.0).abs() < 1e-5);
    assert_eq!(w.v(ANGULAR_X, b as usize), v3(0.0, 0.0, 0.0), "through both centres nothing turns");
}

#[test]
fn locks_and_sleepers_hold_against_a_warm_start() {
    let (mut w, _, body) = crate_world(SHAPE_BALL, [0.5, 0.0, 0.0], DYNAMIC);
    let at = body as usize;
    w.set_v(POSITION_X, at, v3(0.0, 0.49, 0.0));
    detect(&mut w, DT);
    w.set_u(FLAGS, at, w.flags(at) | (LOCK_LINEAR_X << 1) | LOCK_ANGULAR);
    w.set_v(LINEAR_X, at, v3(0.0, 0.0, 0.0));
    w.set_s(CONTACT_NORMAL_IMPULSE, 0, 3.0);
    w.prepare_contacts();
    w.warm_start();
    assert_eq!(w.v(LINEAR_X, at).y, 0.0, "locked along Y");
    assert_eq!(w.v(ANGULAR_X, at), v3(0.0, 0.0, 0.0));
    let (mut w, _, body) = crate_world(SHAPE_BALL, [0.5, 0.0, 0.0], KINEMATIC_VELOCITY);
    w.set_v(POSITION_X, body as usize, v3(0.0, 0.49, 0.0));
    detect(&mut w, DT);
    assert_eq!(w.uu(PAIR_CONTACTS, 0), 0, "two scripted bodies hold no points");
}
