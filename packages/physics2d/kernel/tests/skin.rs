// Contact skin (Rapier's `setContactSkin`): a shape's contacts start its skin farther out, and the solver holds it that far
// off what it touches, so two shapes rest the sum of their skins apart; queries still meet the outline itself, and a
// negative or non-finite skin is refused.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::query::QueryFilter;
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

fn rest(box_skin: f32, floor_skin: f32) -> (World, u32) {
    let mut w = World::new(Settings { gravity: v2(0.0, -9.81), ..Default::default() });
    let floor = w.create_body(&BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(floor, Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef { skin: floor_skin, ..Default::default() }).unwrap();
    let b = w.create_body(&BodyDef { position: v2(0.0, 1.0), can_sleep: false, ..Default::default() }).unwrap();
    w.create_shape(b, Core::rect(0.25, 0.25, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { skin: box_skin, ..Default::default() }).unwrap();
    for _ in 0..180 {
        w.step(DT).unwrap();
    }
    (w, b)
}

#[test]
fn a_box_rests_the_sum_of_the_two_skins_above_the_floor() {
    // Without skins the box's centre rests at its half height, 0.25 m, within the contact solver's slop (0.005 m).
    let (w, b) = rest(0.0, 0.0);
    let plain = w.bodies[b as usize].xf.p.y;
    assert!((plain - 0.25).abs() < 0.006, "plain {plain}");
    for (box_skin, floor_skin) in [(0.05f32, 0.0f32), (0.03, 0.02), (0.0, 0.1)] {
        let (w, b) = rest(box_skin, floor_skin);
        let y = w.bodies[b as usize].xf.p.y;
        let gap = y - plain;
        assert!((gap - (box_skin + floor_skin)).abs() < 0.002, "skins {box_skin} + {floor_skin}: rests {gap} m higher");
    }
}

#[test]
fn queries_meet_the_outline_not_the_skin_and_bad_skins_are_refused() {
    let (mut w, _) = rest(0.05, 0.0);
    // A ray down onto the box from above meets its top face, its centre's height plus 0.25, not the skin above it.
    let y = w.bodies[1].xf.p.y;
    let hit = w.ray_cast(v2(0.0, 3.0), v2(0.0, -1.0), 10.0, true, &QueryFilter::default()).unwrap().unwrap();
    assert!((3.0 - hit.t - (y + 0.25)).abs() < 1e-4, "hit at {}", 3.0 - hit.t);
    let b = w.create_body(&BodyDef::default()).unwrap();
    for skin in [-0.1f32, f32::NAN, f32::INFINITY] {
        assert!(w.create_shape(b, Core::circle(V2::ZERO, 0.5).unwrap(), &ShapeDef { skin, ..Default::default() }).is_err());
    }
}
