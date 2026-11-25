// Extra solver passes per body (Rapier's additional solver iterations): the island of a body that asks runs more passes over its
// own contacts and joints, one at a time, and no other island is touched.
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;
/// Boxes in a column; the top one is a hundred times as heavy as the rest, which a few Gauss-Seidel passes a substep are slow to carry.
const COLUMN: usize = 20;

/// A floor and two columns of boxes far apart, so they are two islands: the left one (bodies 0..) and the right one.
fn two_columns(settings: Settings, left_extra: u32, right_extra: u32) -> (World, Vec<u32>, Vec<u32>) {
    let mut w = World::new(settings);
    let floor = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, -0.5), ..Default::default() }).unwrap();
    w.create_shape(floor, Core::rect(60.0, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default()).unwrap();
    let mut columns = [Vec::new(), Vec::new()];
    for (k, (x, extra)) in [(-20.0f32, left_extra), (20.0, right_extra)].into_iter().enumerate() {
        for i in 0..COLUMN {
            let b = w.create_body(&BodyDef { position: v2(x, 0.5 + i as f32 * 1.0), can_sleep: false, ..Default::default() }).unwrap();
            w.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: if i + 1 == COLUMN { 100.0 } else { 1.0 }, ..Default::default() }).unwrap();
            if extra > 0 {
                w.set_extra_passes(b, extra).unwrap();
            }
            columns[k].push(b);
        }
    }
    let [l, r] = columns;
    (w, l, r)
}

fn bits(w: &World, ids: &[u32]) -> Vec<u32> {
    ids.iter()
        .flat_map(|&b| {
            let body = &w.bodies[b as usize];
            [body.xf.p.x, body.xf.p.y, body.xf.q.c, body.xf.q.s, body.linear_velocity.x, body.linear_velocity.y, body.angular_velocity].map(f32::to_bits)
        })
        .collect()
}

/// How far the column's top box sits below where an unsquashed column of boxes of height 1 on the floor puts it.
fn sag(w: &World, ids: &[u32]) -> f32 {
    COLUMN as f32 - 0.5 - w.bodies[*ids.last().unwrap() as usize].xf.p.y
}

fn run(settings: Settings, left: u32, right: u32, steps: usize) -> (World, Vec<u32>, Vec<u32>) {
    let (mut w, l, r) = two_columns(settings, left, right);
    for _ in 0..steps {
        w.step(DT).unwrap();
    }
    (w, l, r)
}

#[test]
fn an_island_with_extra_passes_settles_further_and_the_other_island_does_not_change_a_bit() {
    let settings = Settings::default();
    let (base, bl, br) = run(settings, 0, 0, 240);
    let (asked, al, ar) = run(settings, 8, 0, 240);
    // The right island asked for nothing: every bit of its bodies is what it was without the left one asking.
    assert_eq!(bits(&asked, &ar), bits(&base, &br), "the island that did not ask changed");
    // The column the passes squash to rest is where a converged solve (64 extra passes) leaves it: 0.3591. One pass a substep is
    // still creeping toward it after four seconds (0.3017); eight more reach it.
    let (reference, rl, _) = run(settings, 64, 0, 240);
    let target = sag(&reference, &rl);
    assert!((target - 0.3591).abs() < 1.0e-3, "the converged sag moved to {target}");
    let (before, after) = ((sag(&base, &bl) - target).abs(), (sag(&asked, &al) - target).abs());
    assert!(before > 0.05, "without extra passes the sag is already {before} from the converged one");
    assert!(after < 1.0e-3, "with them it is {after} from the converged one");
}

#[test]
fn the_most_any_body_of_an_island_asks_for_is_what_the_island_runs() {
    // One body asking for 6 in a column is the whole column asking for 6: the same bits as every body asking.
    let (mut one, l1, _) = two_columns(Settings::default(), 0, 0);
    one.set_extra_passes(l1[3], 6).unwrap();
    let (mut all, la, _) = two_columns(Settings::default(), 6, 0);
    let mut mixed = two_columns(Settings::default(), 0, 0);
    for (i, &b) in mixed.1.iter().enumerate() {
        mixed.0.set_extra_passes(b, if i == 3 { 6 } else { 2 }).unwrap();
    }
    for _ in 0..60 {
        one.step(DT).unwrap();
        all.step(DT).unwrap();
        mixed.0.step(DT).unwrap();
    }
    assert_eq!(bits(&one, &l1), bits(&all, &la));
    assert_eq!(bits(&mixed.0, &mixed.1), bits(&all, &la));
}

#[test]
fn extra_passes_give_the_same_bits_whether_the_contacts_sit_in_wide_blocks_or_not() {
    let wide = Settings { contact_lanes: true, ..Default::default() };
    let single = Settings { contact_lanes: false, ..Default::default() };
    let (a, al, ar) = run(wide, 5, 0, 90);
    let (b, bl, br) = run(single, 5, 0, 90);
    assert_eq!(bits(&a, &al), bits(&b, &bl), "the asking island differs between the wide and the single solve");
    assert_eq!(bits(&a, &ar), bits(&b, &br), "the other island differs between the wide and the single solve");
}

#[test]
fn a_body_that_asks_for_none_leaves_the_step_as_it_was() {
    let (a, al, ar) = run(Settings::default(), 0, 0, 90);
    let (mut b, bl, br) = two_columns(Settings::default(), 3, 3);
    for &id in bl.iter().chain(&br) {
        b.set_extra_passes(id, 0).unwrap();
    }
    for _ in 0..90 {
        b.step(DT).unwrap();
    }
    assert_eq!(bits(&a, &al), bits(&b, &bl));
    assert_eq!(bits(&a, &ar), bits(&b, &br));
}

#[test]
fn extra_passes_survive_a_snapshot() {
    let (mut w, l, r) = two_columns(Settings::default(), 4, 0);
    w.step(DT).unwrap();
    let copy = World::from_snapshot(&w.snapshot()).unwrap();
    assert_eq!(copy.bodies[l[0] as usize].extra_passes, 4);
    assert_eq!(copy.bodies[r[0] as usize].extra_passes, 0);
}

/// Two triangles of jointed balls hanging by a pivot, 40 m apart: a closed ring of joints has no exact solve, so its passes matter. The
/// first asks for `left_extra` extra passes, the second for none.
fn two_rings(left_extra: u32) -> (World, Vec<u32>, Vec<u32>) {
    use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
    let mut w = World::new(Settings::default());
    let mut rings = [Vec::new(), Vec::new()];
    for (k, x) in [-20.0f32, 20.0].into_iter().enumerate() {
        let pivot = w.create_body(&BodyDef { kind: Kind::Static, position: v2(x, 10.0), ..Default::default() }).unwrap();
        let mut ball = |w: &mut World, at: V2| {
            let b = w.create_body(&BodyDef { position: at, can_sleep: false, ..Default::default() }).unwrap();
            w.create_shape(b, Core::circle(V2::ZERO, 0.2).unwrap(), &ShapeDef { density: if at.y < 8.5 { 50.0 } else { 1.0 }, ..Default::default() }).unwrap();
            if k == 0 && left_extra > 0 {
                w.set_extra_passes(b, left_extra).unwrap();
            }
            b
        };
        let (b1, b2, b3) = (ball(&mut w, v2(x - 1.0, 9.0)), ball(&mut w, v2(x + 1.0, 9.0)), ball(&mut w, v2(x, 8.0)));
        let revolute = |a, b, anchor_a, anchor_b| JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a, b, anchor_a, anchor_b, collide: false };
        for def in [
            revolute(pivot, b1, V2::ZERO, v2(1.0, 1.0)),
            revolute(b1, b2, v2(1.0, 0.0), v2(-1.0, 0.0)),
            revolute(b2, b3, v2(0.0, -1.0), v2(1.0, 0.0)),
            revolute(b3, b1, v2(-1.0, 0.0), v2(0.0, -1.0)),
        ] {
            w.create_joint(&def).unwrap();
        }
        rings[k] = vec![b1, b2, b3];
    }
    let [l, r] = rings;
    (w, l, r)
}

#[test]
fn extra_passes_work_the_joints_of_the_island_that_asks_and_no_others() {
    let (mut base, bl, br) = two_rings(0);
    let (mut asked, al, ar) = two_rings(6);
    for _ in 0..120 {
        base.step(DT).unwrap();
        asked.step(DT).unwrap();
    }
    assert_eq!(bits(&asked, &ar), bits(&base, &br), "the ring that did not ask changed");
    assert_ne!(bits(&asked, &al), bits(&base, &bl), "the ring that asked was solved no differently");
}

/// Two jointed structures hanging 40 m apart: a branching tree (solved whole, exactly) or a plain chain (a path, exactly), the first
/// asking for `left_extra` extra passes.
fn two_hung(tree: bool, left_extra: u32) -> (World, Vec<u32>, Vec<u32>) {
    use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
    let mut w = World::new(Settings::default());
    let mut groups = [Vec::new(), Vec::new()];
    for (k, x) in [-20.0f32, 20.0].into_iter().enumerate() {
        let pivot = w.create_body(&BodyDef { kind: Kind::Static, position: v2(x, 10.0), ..Default::default() }).unwrap();
        let mut ball = |w: &mut World, at: V2| {
            let b = w.create_body(&BodyDef { position: at, can_sleep: false, ..Default::default() }).unwrap();
            w.create_shape(b, Core::circle(V2::ZERO, 0.2).unwrap(), &ShapeDef { density: 1.0, ..Default::default() }).unwrap();
            if k == 0 && left_extra > 0 {
                w.set_extra_passes(b, left_extra).unwrap();
            }
            b
        };
        let revolute = |a, b, anchor_a, anchor_b| JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a, b, anchor_a, anchor_b, collide: false };
        let (b1, b2, b3) = (ball(&mut w, v2(x, 9.0)), ball(&mut w, v2(x - 1.0, 8.0)), ball(&mut w, v2(x + 1.0, 8.0)));
        let mut defs = vec![revolute(pivot, b1, V2::ZERO, v2(0.0, 1.0)), revolute(b1, b2, v2(0.0, -1.0), v2(1.0, 0.0))];
        // The tree: b1 carries both b2 and b3, three joints at one body. The chain: b3 hangs from b2 instead.
        defs.push(if tree { revolute(b1, b3, v2(0.0, -1.0), v2(-1.0, 0.0)) } else { revolute(b2, b3, v2(-1.0, 0.0), v2(-1.0, 0.0)) });
        for def in defs {
            w.create_joint(&def).unwrap();
        }
        groups[k] = vec![b1, b2, b3];
    }
    let [l, r] = groups;
    (w, l, r)
}

#[test]
fn extra_passes_leave_the_trees_and_paths_of_the_other_islands_alone() {
    for tree in [true, false] {
        let (mut base, bl, br) = two_hung(tree, 0);
        let (mut asked, al, ar) = two_hung(tree, 5);
        for _ in 0..120 {
            base.step(DT).unwrap();
            asked.step(DT).unwrap();
        }
        assert_eq!(bits(&asked, &ar), bits(&base, &br), "tree {tree}: the structure that did not ask changed");
        for (&a, &b) in al.iter().zip(&bl) {
            let (pa, pb) = (asked.bodies[a as usize].xf.p, base.bodies[b as usize].xf.p);
            assert!(pa.x.is_finite() && pa.y.is_finite() && (pa.x - pb.x).abs() < 0.05 && (pa.y - pb.y).abs() < 0.05, "tree {tree}: the asking structure moved to {pa:?} against {pb:?}");
        }
    }
}
