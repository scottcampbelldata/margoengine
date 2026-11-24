// Scene queries: rays, points, overlaps and shape casts against boxes, circles, capsules, rounded boxes and chains, with
// the filters (groups, kinds, excluded shape and body).
use margoengine_physics2d_kernel::math::{Rot, V2, Xf, v2};
use margoengine_physics2d_kernel::query::{EXCLUDE_DYNAMIC, EXCLUDE_FIXED, EXCLUDE_SENSORS, QueryFilter, ray_core};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

const NEAR: f32 = 1.0e-4;

fn at(x: f32, y: f32) -> BodyDef {
    BodyDef { kind: Kind::Static, position: v2(x, y), ..Default::default() }
}

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() < NEAR
}

#[test]
fn a_ray_meets_the_faces_of_a_box_a_ball_and_a_capsule() {
    let rect = Core::rect(1.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let (t, n) = ray_core(&rect, v2(-5.0, 0.0), v2(1.0, 0.0), 100.0, true).unwrap();
    assert!(near(t, 4.0) && near(n.x, -1.0) && near(n.y, 0.0), "{t} {n:?}");
    let (t, n) = ray_core(&rect, v2(0.0, 5.0), v2(0.0, -1.0), 100.0, true).unwrap();
    assert!(near(t, 4.5) && near(n.y, 1.0));
    // A miss past the corner, and a ray too short.
    assert!(ray_core(&rect, v2(-5.0, 0.6), v2(1.0, 0.0), 100.0, true).is_none());
    assert!(ray_core(&rect, v2(-5.0, 0.0), v2(1.0, 0.0), 3.9, true).is_none());
    let ball = Core::circle(v2(1.0, 1.0), 0.5).unwrap();
    let (t, n) = ray_core(&ball, v2(-3.0, 1.0), v2(1.0, 0.0), 100.0, true).unwrap();
    assert!(near(t, 3.5) && near(n.x, -1.0));
    let capsule = Core::capsule(v2(0.0, 0.0), v2(2.0, 0.0), 0.5).unwrap();
    let (t, n) = ray_core(&capsule, v2(1.0, 5.0), v2(0.0, -1.0), 100.0, true).unwrap();
    assert!(near(t, 4.5) && near(n.y, 1.0));
    // Down the capsule's axis: the end cap.
    let (t, n) = ray_core(&capsule, v2(-4.0, 0.0), v2(1.0, 0.0), 100.0, true).unwrap();
    assert!(near(t, 3.5) && near(n.x, -1.0));
    // Grazing the round end, not the offset sides.
    let (t, _) = ray_core(&capsule, v2(-4.0, 0.3), v2(1.0, 0.0), 100.0, true).unwrap();
    let x = -0.4f32; // 0.3^2 + x^2 = 0.25
    assert!(near(t, 4.0 + x), "{t}");
}

#[test]
fn a_rounded_box_has_round_corners() {
    let rounded = Core::rect(1.0, 1.0, V2::ZERO, 1.0, 0.0, 0.5).unwrap();
    // Along the diagonal toward the corner (1,1): the arc, at distance sqrt(2) + 0.5 from the origin.
    let d = v2(-1.0, -1.0).normalize().0;
    let (t, n) = ray_core(&rounded, v2(5.0, 5.0), d, 100.0, true).unwrap();
    assert!(near(t, 5.0 * 2f32.sqrt() - (2f32.sqrt() + 0.5)), "{t}");
    assert!(near(n.x, 0.70710677) && near(n.y, 0.70710677));
}

#[test]
fn a_ray_from_inside_hits_at_zero_when_solid_and_the_exit_when_not() {
    let rect = Core::rect(1.0, 1.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let (t, _) = ray_core(&rect, v2(0.0, 0.0), v2(1.0, 0.0), 100.0, true).unwrap();
    assert_eq!(t, 0.0);
    let (t, n) = ray_core(&rect, v2(0.0, 0.0), v2(1.0, 0.0), 100.0, false).unwrap();
    assert!(near(t, 1.0) && near(n.x, 1.0));
}

#[test]
fn the_world_ray_returns_the_nearest_shape_with_its_body_pose() {
    let mut world = World::default();
    let wall = world.create_body(&BodyDef { kind: Kind::Static, position: v2(10.0, 0.0), rotation: Rot::from_pair(0.0, 1.0), ..Default::default() }).unwrap();
    // A 4 wide, 1 tall box turned a quarter turn: 1 wide, 4 tall.
    let s_wall = world.create_shape(wall, Core::rect(2.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let near_body = world.create_body(&at(5.0, 0.0)).unwrap();
    let s_near = world.create_shape(near_body, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef::default()).unwrap();
    let f = QueryFilter::default();
    let hit = world.ray_cast(v2(0.0, 0.0), v2(1.0, 0.0), 100.0, true, &f).unwrap().unwrap();
    assert_eq!(hit.shape, s_near);
    assert!(near(hit.t, 4.0));
    let all = world.ray_cast_all(v2(0.0, 0.0), v2(1.0, 0.0), 100.0, true, &f).unwrap();
    assert_eq!(all.iter().map(|h| h.shape).collect::<Vec<_>>(), [s_near, s_wall]);
    assert!(near(all[1].t, 9.5), "{}", all[1].t);
    // Filters.
    let skip = QueryFilter { exclude_shape: s_near, ..f };
    assert_eq!(world.ray_cast(v2(0.0, 0.0), v2(1.0, 0.0), 100.0, true, &skip).unwrap().unwrap().shape, s_wall);
    let skip = QueryFilter { exclude_body: near_body, ..f };
    assert_eq!(world.ray_cast(v2(0.0, 0.0), v2(1.0, 0.0), 100.0, true, &skip).unwrap().unwrap().shape, s_wall);
    let skip = QueryFilter { flags: EXCLUDE_FIXED, ..f };
    assert!(world.ray_cast(v2(0.0, 0.0), v2(1.0, 0.0), 100.0, true, &skip).unwrap().is_none());
    let groups = QueryFilter { groups: 0x0002_0002, ..f };
    world.shapes[s_near as usize].groups = 0x0001_0001;
    world.shapes[s_wall as usize].groups = 0x0002_0002;
    assert_eq!(world.ray_cast(v2(0.0, 0.0), v2(1.0, 0.0), 100.0, true, &groups).unwrap().unwrap().shape, s_wall);
    assert!(world.ray_cast(v2(0.0, 0.0), v2(2.0, 0.0), 100.0, true, &f).is_err());
    assert!(world.ray_cast(v2(f32::NAN, 0.0), v2(1.0, 0.0), 100.0, true, &f).is_err());
}

#[test]
fn points_and_shapes_find_what_they_overlap_and_flags_leave_kinds_out() {
    let mut world = World::default();
    let ground = world.create_body(&at(0.0, -1.0)).unwrap();
    let s_ground = world.create_shape(ground, Core::rect(10.0, 1.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let zone = world.create_body(&at(0.0, 3.0)).unwrap();
    let s_zone = world.create_shape(zone, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef { sensor: true, ..Default::default() }).unwrap();
    let ball = world.create_body(&BodyDef { position: v2(4.0, 0.5), ..Default::default() }).unwrap();
    let s_ball = world.create_shape(ball, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    let f = QueryFilter::default();
    assert_eq!(world.point_query(v2(0.0, -0.5), &f).unwrap(), [s_ground]);
    assert_eq!(world.point_query(v2(0.0, 3.5), &f).unwrap(), [s_zone]);
    assert!(world.point_query(v2(0.0, 1.0), &f).unwrap().is_empty());
    assert!(world.point_query(v2(0.0, 3.5), &QueryFilter { flags: EXCLUDE_SENSORS, ..f }).unwrap().is_empty());
    assert_eq!(world.point_query(v2(4.0, 0.5), &QueryFilter { flags: EXCLUDE_FIXED, ..f }).unwrap(), [s_ball]);
    let probe = Core::circle(V2::ZERO, 0.6).unwrap();
    let found = world.shape_overlap(&probe, Xf { p: v2(3.2, 0.0), q: Rot::IDENTITY }, &f).unwrap();
    assert_eq!(found, [s_ground, s_ball]);
    let found = world.shape_overlap(&probe, Xf { p: v2(3.2, 0.0), q: Rot::IDENTITY }, &QueryFilter { flags: EXCLUDE_DYNAMIC, ..f }).unwrap();
    assert_eq!(found, [s_ground]);
    assert!(world.shape_overlap(&probe, Xf { p: v2(0.0, 1.0), q: Rot::IDENTITY }, &f).unwrap().is_empty());
}

#[test]
fn a_query_sees_a_body_moved_after_the_last_step() {
    let mut world = World::default();
    let b = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    let s = world.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef::default()).unwrap();
    world.step(1.0 / 60.0).unwrap();
    let f = QueryFilter::default();
    assert_eq!(world.point_query(v2(0.0, 0.0), &f).unwrap(), [s]);
    world.set_transform(b, v2(50.0, 0.0), Rot::IDENTITY).unwrap();
    assert!(world.point_query(v2(0.0, 0.0), &f).unwrap().is_empty());
    assert_eq!(world.point_query(v2(50.0, 0.0), &f).unwrap(), [s]);
}

#[test]
fn a_shape_cast_stops_where_the_shapes_touch() {
    let mut world = World::default();
    let ground = world.create_body(&at(0.0, -1.0)).unwrap();
    let s_ground = world.create_shape(ground, Core::rect(10.0, 1.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let f = QueryFilter::default();
    let ball = Core::circle(V2::ZERO, 0.5).unwrap();
    let hit = world.shape_cast(&ball, Xf { p: v2(0.0, 5.0), q: Rot::IDENTITY }, v2(0.0, -1.0), 20.0, &f).unwrap().unwrap();
    assert_eq!(hit.shape, s_ground);
    assert!(near_loose(hit.t, 4.5), "{}", hit.t);
    assert!(near_loose(hit.normal.y, -1.0) && near_loose(hit.point_b.y, 0.0), "{hit:?}");
    // At an angle: the ball touches the top face after 5/sin(45) - 0.5/sin(45).
    let d = v2(1.0, -1.0).normalize().0;
    let hit = world.shape_cast(&ball, Xf { p: v2(-2.0, 3.0), q: Rot::IDENTITY }, d, 20.0, &f).unwrap().unwrap();
    assert!(near_loose(hit.t, (3.0 - 0.5) * 2f32.sqrt()), "{}", hit.t);
    // Too short, moving away, and passing beside it.
    assert!(world.shape_cast(&ball, Xf { p: v2(0.0, 5.0), q: Rot::IDENTITY }, v2(0.0, -1.0), 4.0, &f).unwrap().is_none());
    assert!(world.shape_cast(&ball, Xf { p: v2(0.0, 5.0), q: Rot::IDENTITY }, v2(0.0, 1.0), 20.0, &f).unwrap().is_none());
    assert!(world.shape_cast(&ball, Xf { p: v2(12.0, 5.0), q: Rot::IDENTITY }, v2(0.0, -1.0), 20.0, &f).unwrap().is_none());
    // Overlapping at the start is a hit at 0.
    let hit = world.shape_cast(&ball, Xf { p: v2(0.0, 0.2), q: Rot::IDENTITY }, v2(0.0, -1.0), 20.0, &f).unwrap().unwrap();
    assert_eq!(hit.t, 0.0);
}

#[test]
fn a_box_cast_onto_a_chain_lands_on_it() {
    let mut world = World::default();
    let ground = world.create_body(&at(0.0, 0.0)).unwrap();
    let ids = world.create_chain(ground, &[v2(-5.0, 0.0), v2(0.0, 0.0), v2(5.0, 1.0)], false, &ShapeDef::default()).unwrap();
    let f = QueryFilter::default();
    let b = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let hit = world.shape_cast(&b, Xf { p: v2(-2.0, 4.0), q: Rot::IDENTITY }, v2(0.0, -1.0), 20.0, &f).unwrap().unwrap();
    assert_eq!(hit.shape, ids[0]);
    assert!(near_loose(hit.t, 3.5), "{}", hit.t);
}

fn near_loose(a: f32, b: f32) -> bool {
    (a - b).abs() < 2.0e-3
}

/// A ray's hit lies on the surface, and marching the ray in small steps finds no earlier point inside the core.
#[test]
fn random_rays_agree_with_marching() {
    let mut seed = 0x2545_f491u32;
    let mut next = move || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (seed >> 8) as f32 / 16777216.0
    };
    for case in 0..400 {
        let radius = if case % 2 == 0 { 0.0 } else { 0.1 + next() * 0.4 };
        let core = match case % 4 {
            0 | 1 => Core::rect(0.3 + next(), 0.3 + next(), v2(next() - 0.5, next() - 0.5), 1.0, 0.0, radius).unwrap(),
            2 => Core::capsule(v2(next() - 0.5, next() - 0.5), v2(1.0 + next(), next() - 0.5), radius).unwrap(),
            _ => Core::polygon(&[v2(0.0, 0.0), v2(1.5 + next(), 0.2), v2(1.0, 1.2 + next()), v2(-0.3, 0.8)], radius).unwrap(),
        };
        if core.count == 2 && core.radius == 0.0 {
            continue; // A segment has no area to march into.
        }
        let angle = next() * 6.2831855;
        let d = v2(angle.cos(), angle.sin());
        let origin = v2(-d.x * 4.0 + (next() - 0.5) * 2.0, -d.y * 4.0 + (next() - 0.5) * 2.0);
        let found = ray_core(&core, origin, d, 20.0, true);
        let mut marched = None;
        let mut t = 0.0f32;
        while t <= 20.0 {
            if margoengine_physics2d_kernel::query::core_distance(&core, origin.add(d.scale(t))) <= 0.0 {
                marched = Some(t);
                break;
            }
            t += 0.002;
        }
        match (found, marched) {
            (None, None) => {}
            (Some((t, _)), Some(m)) => assert!(t <= m + 1.0e-3 && m - t < 0.03, "case {case}: {t} against {m}"),
            other => panic!("case {case}: {other:?}"),
        }
    }
}

#[test]
fn the_closest_point_of_each_shape_and_boxes_that_meet() {
    use margoengine_physics2d_kernel::query::project_core;
    let rect = Core::rect(1.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let (p, inside) = project_core(&rect, v2(3.0, 0.2));
    assert!(!inside && near(p.x, 1.0) && near(p.y, 0.2), "{p:?}");
    let (p, inside) = project_core(&rect, v2(3.0, 2.0));
    assert!(!inside && near(p.x, 1.0) && near(p.y, 0.5), "a corner: {p:?}");
    assert!(project_core(&rect, v2(0.3, 0.1)).1);
    let ball = Core::circle(v2(1.0, 1.0), 0.5).unwrap();
    let (p, inside) = project_core(&ball, v2(4.0, 1.0));
    assert!(!inside && near(p.x, 1.5) && near(p.y, 1.0));
    let capsule = Core::capsule(v2(0.0, 0.0), v2(2.0, 0.0), 0.5).unwrap();
    let (p, _) = project_core(&capsule, v2(1.0, 3.0));
    assert!(near(p.x, 1.0) && near(p.y, 0.5));
    let mut world = World::default();
    let a = world.create_body(&at(0.0, 0.0)).unwrap();
    let s_a = world.create_shape(a, Core::circle(V2::ZERO, 1.0).unwrap(), &ShapeDef::default()).unwrap();
    let b = world.create_body(&at(10.0, 0.0)).unwrap();
    let s_b = world.create_shape(b, Core::rect(1.0, 1.0, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let f = QueryFilter::default();
    let all = world.project_point_all(v2(7.0, 0.0), &f).unwrap();
    assert_eq!(all.iter().map(|h| h.shape).collect::<Vec<_>>(), [s_b, s_a]);
    assert!(near(all[0].distance, 2.0) && near(all[1].distance, 6.0));
    let inside = world.project_point(v2(0.2, 0.0), &f).unwrap().unwrap();
    assert!(inside.inside && inside.distance == 0.0 && inside.shape == s_a);
    assert_eq!(world.aabb_query(v2(8.0, -5.0), v2(12.0, 5.0), &f).unwrap(), [s_b]);
    assert_eq!(world.aabb_query(v2(-20.0, -20.0), v2(20.0, 20.0), &f).unwrap(), [s_a, s_b]);
    assert!(world.aabb_query(v2(3.0, 3.0), v2(4.0, 4.0), &f).unwrap().is_empty());
}

#[test]
fn a_body_changes_kind_and_is_weighed_or_stopped() {
    let mut world = World::default();
    let b = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    world.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    assert_eq!(world.bodies[b as usize].inv_mass, 0.0);
    world.set_body_kind(b, Kind::Dynamic).unwrap();
    assert!(world.bodies[b as usize].mass > 0.9);
    for _ in 0..30 {
        world.step(1.0 / 60.0).unwrap();
    }
    assert!(world.bodies[b as usize].xf.p.y < -0.5, "it falls once dynamic");
    world.set_body_kind(b, Kind::Static).unwrap();
    let y = world.bodies[b as usize].xf.p.y;
    for _ in 0..30 {
        world.step(1.0 / 60.0).unwrap();
    }
    assert_eq!(world.bodies[b as usize].xf.p.y, y, "and stops once static");
}
