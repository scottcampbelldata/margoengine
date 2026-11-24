// Interaction groups 32 bits wide with Rapier's test modes: `And` (each side's memberships meet the other's filter) and `Or`
// (either way), `Or` only when both colliders ask for it. The packed 16-bit words keep their old meaning.
use margoengine_physics_kernel::events::{wide_groups, wide_meet};
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::query::*;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

/// A collider whose 32-bit memberships and filter are `memberships` and `filter`, collision groups or solver groups.
fn set_groups(w: &mut World, collider: u32, memberships: u32, filter: u32, solver: bool, or: bool) {
    let (packed, hi, flag, wide) = if solver {
        (COLLIDER_SOLVER_GROUPS, COLLIDER_SOLVER_GROUPS_HI, COLLIDER_SOLVER_OR, COLLIDER_SOLVER_WIDE)
    } else {
        (COLLIDER_GROUPS, COLLIDER_GROUPS_HI, COLLIDER_GROUPS_OR, COLLIDER_GROUPS_WIDE)
    };
    let at = collider as usize;
    w.set_u(packed, at, (memberships << 16) | (filter & 0xffff));
    w.set_u(hi, at, (memberships & 0xffff_0000) | (filter >> 16));
    let flags = w.uu(COLLIDER_FLAGS, at) | wide;
    w.set_u(COLLIDER_FLAGS, at, if or { flags | flag } else { flags & !flag });
}

fn two(w: &mut World) -> (u32, u32) {
    let (a, b) = (w.add_body(DYNAMIC).unwrap(), w.add_body(DYNAMIC).unwrap());
    (
        w.add_collider(a, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap(),
        w.add_collider(b, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap(),
    )
}

#[test]
fn the_words_split_and_join_as_the_packed_ones_did() {
    // The packed word holds the lower 16 bits of each side as it always did; the upper halves are the second word's.
    assert_eq!(wide_groups(0x000d_0004, 0, false), (0x000d, 0x0004));
    assert_eq!(wide_groups(0x000d_0004, 0x8000_0001, true), (0x8000_000d, 0x0001_0004));
    assert_eq!(wide_groups(0x000d_0004, 0x8000_0001, false), (0x000d, 0x0004), "the upper halves are read only when wide");
    assert_eq!(wide_groups(u32::MAX, 0, false), (u32::MAX, u32::MAX), "a packed all is all 32 bits");
    assert_eq!(wide_groups(u32::MAX, 0, true), (0xffff, 0xffff), "but a wide one that is 16 ones is 16");
    // And needs both ways, Or either.
    assert!(wide_meet((1, 2), (2, 1), false));
    assert!(!wide_meet((1, 2), (4, 1), false) && wide_meet((1, 2), (4, 1), true));
    assert!(!wide_meet((1, 2), (4, 8), true));
}

#[test]
fn groups_above_bit_15_meet_by_and_or_or_and_a_mixed_pair_tests_by_and() {
    let mut w = World::new(4, 4).unwrap();
    let (a, b) = two(&mut w);
    // A is in group 20 and wants group 21; B is in group 21 and wants group 20: they meet by either test.
    set_groups(&mut w, a, 1 << 20, 1 << 21, false, false);
    set_groups(&mut w, b, 1 << 21, 1 << 20, false, false);
    assert!(w.colliders_meet(a as usize, b as usize, false));
    // B no longer wants A's group: And fails, and Or (both ask) holds through A's side alone.
    set_groups(&mut w, b, 1 << 21, 1 << 22, false, false);
    assert!(!w.colliders_meet(a as usize, b as usize, false));
    set_groups(&mut w, a, 1 << 20, 1 << 21, false, true);
    assert!(!w.colliders_meet(a as usize, b as usize, false), "only A asks for Or, so the pair tests by And");
    set_groups(&mut w, b, 1 << 21, 1 << 22, false, true);
    assert!(w.colliders_meet(a as usize, b as usize, false), "both ask for Or: B's membership (21) is in A's filter");
    // Neither side shares a bit: Or fails too.
    set_groups(&mut w, b, 1 << 25, 1 << 22, false, true);
    assert!(!w.colliders_meet(a as usize, b as usize, false));
    // Solver groups are their own words and flag.
    set_groups(&mut w, a, 1 << 30, 1 << 31, true, false);
    set_groups(&mut w, b, 1 << 31, 1 << 30, true, false);
    assert!(w.colliders_meet(a as usize, b as usize, true));
    assert!(!w.colliders_meet(a as usize, b as usize, false), "collision groups are unchanged by solver groups");
}

#[test]
fn a_new_collider_is_in_every_one_of_the_32_groups() {
    let mut w = World::new(4, 4).unwrap();
    let (a, b) = two(&mut w);
    assert!(w.colliders_meet(a as usize, b as usize, false) && w.colliders_meet(a as usize, b as usize, true));
    set_groups(&mut w, b, 1 << 31, 1 << 31, false, false);
    assert!(w.colliders_meet(a as usize, b as usize, false), "all meets group 31");
    set_groups(&mut w, a, 1, 1, false, false);
    assert!(!w.colliders_meet(a as usize, b as usize, false), "group 0 does not meet group 31");
}

#[test]
fn a_query_sees_what_its_wide_groups_meet_and_a_packed_one_as_before() {
    let mut w = World::new(4, 4).unwrap();
    let body = w.add_body(FIXED).unwrap();
    let collider = w.add_collider(body, SHAPE_BALL, [1.0, 0.0, 0.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    set_groups(&mut w, collider, 1 << 20, 1 << 21, false, false);
    w.broad_update(1.0 / 60.0);
    let ray = |w: &World, flags: u32, groups: u32| w.cast_ray(v3(-5.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), 20.0, true, &Filter { flags, groups, collider: NONE, body: NONE }).map(|(c, _)| c);
    // A query in group 21 that wants group 20 sees it by And; one in group 22 does not.
    w.query_groups_hi = (1 << 21) | (1 << 4);
    assert_eq!(ray(&w, WIDE_GROUPS, 0), Some(collider));
    w.query_groups_hi = (1 << 22) | (1 << 4);
    assert_eq!(ray(&w, WIDE_GROUPS, 0), None);
    // By Or, with the collider asking too, one direction is enough: the collider's memberships are in the query's filter.
    w.query_groups_hi = 1 << 22 | 1 << 4;
    set_groups(&mut w, collider, 1 << 20, 1 << 21, false, true);
    assert_eq!(ray(&w, WIDE_GROUPS | GROUPS_OR, 0), Some(collider));
    // A packed query (no WIDE flag) tests the lower 16 bits only, as before: the collider's group 20 is not among them.
    set_groups(&mut w, collider, 1 << 3, 1 << 4, false, false);
    assert_eq!(ray(&w, 0, (1 << 20) | (1 << 3)), Some(collider), "packed: query group 4 wants group 3, the collider is in 3 and wants 4");
    assert_eq!(ray(&w, 0, (1 << 21) | (1 << 3)), None, "packed: query group 5 is not in the collider's filter");
}
