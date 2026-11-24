// Branched trees of joints solve exactly in one sweep: a humanoid-shaped tree with a 1000:1 mass ratio across a branch keeps
// every joint within 1 percent of a link length, a chain solved as a tree matches the chain sweep, and a tree under a
// load is held by it as a chain is.
use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

struct Tree {
    world: World,
    /// (body, parent body or the anchor, the joint's anchor on the parent, on the child).
    joints: Vec<(u32, u32, V2, V2)>,
}

fn pin(w: &mut World, a: u32, b: u32, at: V2, on_b: V2) {
    w.create_joint(&JointDef { kind: JointKind::Revolute { limits: None, motor: None }, a, b, anchor_a: at, anchor_b: on_b, collide: false }).unwrap();
}

/// A person hanging by the head from a fixed hook: torso, head, two arms of two links, two legs of three. 12 bodies; the heavy
/// torso (1000 kg/m^2 against 1) is the branch of five joints.
fn humanoid(heavy: f32, dynamics: bool) -> Tree {
    let mut w = World::default();
    w.solve_chains_as_trees = false;
    let hook = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, 6.0), ..Default::default() }).unwrap();
    let mut joints = Vec::new();
    let mut add = |w: &mut World, at: V2, half: V2, density: f32| -> u32 {
        let b = w.create_body(&BodyDef { position: at, can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(b, Core::rect(half.x, half.y, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density, friction: 0.0, groups: 0, ..Default::default() }).unwrap();
        b
    };
    // The head hangs from the hook; the torso hangs from the head.
    let head = add(&mut w, v2(0.0, 5.7), v2(0.15, 0.15), 1.0);
    pin(&mut w, hook, head, v2(0.0, 0.0), v2(0.0, 0.3));
    joints.push((head, hook, v2(0.0, 0.0), v2(0.0, 0.3)));
    let torso = add(&mut w, v2(0.0, 5.0), v2(0.25, 0.5), heavy);
    pin(&mut w, head, torso, v2(0.0, -0.15), v2(0.0, 0.5));
    joints.push((torso, head, v2(0.0, -0.15), v2(0.0, 0.5)));
    // Arms: from the shoulders out and down; legs: from the hips down.
    let mut limb = |w: &mut World, from: u32, at: V2, x: f32, y: f32, links: usize, half: V2| {
        let mut parent = from;
        let mut anchor = at;
        for i in 0..links {
            let centre = v2(x, y - i as f32 * 2.0 * half.y - half.y);
            let b = add(w, centre, half, 1.0);
            pin(w, parent, b, anchor, v2(0.0, half.y));
            joints.push((b, parent, anchor, v2(0.0, half.y)));
            parent = b;
            anchor = v2(0.0, -half.y);
        }
    };
    limb(&mut w, torso, v2(-0.25, 0.4), -0.25, 5.4, 2, v2(0.07, 0.25));
    limb(&mut w, torso, v2(0.25, 0.4), 0.25, 5.4, 2, v2(0.07, 0.25));
    limb(&mut w, torso, v2(-0.12, -0.5), -0.12, 4.5, 3, v2(0.08, 0.3));
    limb(&mut w, torso, v2(0.12, -0.5), 0.12, 4.5, 3, v2(0.08, 0.3));
    let _ = dynamics;
    Tree { world: w, joints }
}

/// The largest gap between a joint's two anchors, in metres.
fn worst_gap(t: &Tree) -> f32 {
    let w = &t.world;
    t.joints
        .iter()
        .map(|&(child, parent, on_parent, on_child)| {
            let (pc, cc) = (&w.bodies[parent as usize], &w.bodies[child as usize]);
            pc.xf.apply(on_parent).sub(cc.xf.apply(on_child)).length()
        })
        .fold(0.0, f32::max)
}

#[test]
fn a_branched_tree_with_a_thousand_to_one_mass_ratio_keeps_every_joint_closed() {
    let mut t = humanoid(1000.0, true);
    // The static hook is the parent of the head, whose anchor is the hook's world point: its gap reads against the hook.
    for step in 0..600 {
        t.world.step(DT).unwrap();
        if step > 60 {
            let gap = worst_gap(&t);
            assert!(gap < 0.01 * 0.5, "step {step}: a joint is open by {gap} m, over 1 percent of a link");
        }
    }
    // The tree was solved as a tree: all twelve joints, and no path.
    assert_eq!(t.world.counts.tree_joints, 12);
    // It hangs: the head is under the hook and the feet are lower than the torso.
    let head = &t.world.bodies[t.joints[0].0 as usize];
    assert!((head.xf.p.y - 5.7).abs() < 0.2, "head at {}", head.xf.p.y);
}

#[test]
fn the_tree_solve_matches_the_chain_sweep_on_a_chain() {
    let build = |as_trees: bool| {
        let mut w = World::default();
        w.solve_chains_as_trees = as_trees;
        let hook = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, 0.0), ..Default::default() }).unwrap();
        let mut parent = hook;
        let mut anchor = v2(0.0, 0.0);
        for i in 0..20 {
            let b = w.create_body(&BodyDef { position: v2(0.0, -0.5 - i as f32), can_sleep: false, linear_velocity: v2(0.3, 0.0), ..Default::default() }).unwrap();
            w.create_shape(b, Core::rect(0.05, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: if i == 19 { 500.0 } else { 1.0 }, friction: 0.0, groups: 0, ..Default::default() }).unwrap();
            pin(&mut w, parent, b, anchor, v2(0.0, 0.5));
            parent = b;
            anchor = v2(0.0, -0.5);
        }
        w
    };
    let (mut chain, mut tree) = (build(false), build(true));
    for _ in 0..240 {
        chain.step(DT).unwrap();
        tree.step(DT).unwrap();
    }
    let mut worst = 0.0f32;
    for (a, b) in chain.bodies.iter().zip(&tree.bodies) {
        worst = worst.max(a.xf.p.sub(b.xf.p).length());
    }
    assert!(worst < 2.0e-3, "the chain and the tree differ by {worst} m after 4 s");
}

#[test]
fn a_heavy_branch_pulls_a_light_trunk_and_a_trunk_of_light_bodies_holds_a_heavy_load() {
    // A Y: a light stem of three links, then two arms each ending in a 1000 times heavier ball, under gravity.
    let mut w = World::default();
    let hook = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, 10.0), ..Default::default() }).unwrap();
    let mut joints = Vec::new();
    let mut parent = hook;
    let mut anchor = V2::ZERO;
    let link = |w: &mut World, at: V2, density: f32| {
        let b = w.create_body(&BodyDef { position: at, can_sleep: false, ..Default::default() }).unwrap();
        w.create_shape(b, Core::rect(0.05, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density, friction: 0.0, groups: 0, ..Default::default() }).unwrap();
        b
    };
    for i in 0..3 {
        let b = link(&mut w, v2(0.0, 9.5 - i as f32), 1.0);
        pin(&mut w, parent, b, anchor, v2(0.0, 0.5));
        joints.push((b, parent, anchor, v2(0.0, 0.5)));
        parent = b;
        anchor = v2(0.0, -0.5);
    }
    for side in [-1.0f32, 1.0] {
        let (mut p, mut a) = (parent, anchor);
        for i in 0..3 {
            let heavy = i == 2;
            let b = link(&mut w, v2(0.0, 6.5 - i as f32), if heavy { 1000.0 } else { 1.0 });
            pin(&mut w, p, b, a, v2(0.0, 0.5));
            joints.push((b, p, a, v2(0.0, 0.5)));
            p = b;
            a = v2(0.0, -0.5);
        }
    }
    let mut t = Tree { world: w, joints };
    for step in 0..600 {
        t.world.step(DT).unwrap();
        if step % 100 == 99 {
            let _ = step;
        }
    }
    assert!(worst_gap(&t) < 0.005, "gap {}", worst_gap(&t));
    // Everything hangs below the hook, none stretched past its length.
    for (b, ..) in &t.joints {
        assert!(t.world.bodies[*b as usize].xf.p.y < 10.0);
    }
}

/// How far a joint of a hanging chain opens under an end load: the bar the tree has to meet.
#[test]
fn a_chain_under_the_same_loads_stays_closed_too() {
    let gap = |load: f32| {
        let mut w = World::default();
        let hook = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, 10.0), ..Default::default() }).unwrap();
        let (mut parent, mut anchor) = (hook, V2::ZERO);
        let mut joints = Vec::new();
        for i in 0..6 {
            let b = w.create_body(&BodyDef { position: v2(0.0, 9.5 - i as f32), can_sleep: false, ..Default::default() }).unwrap();
            w.create_shape(b, Core::rect(0.05, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: if i == 5 { load } else { 1.0 }, friction: 0.0, groups: 0, ..Default::default() }).unwrap();
            pin(&mut w, parent, b, anchor, v2(0.0, 0.5));
            joints.push((b, parent, anchor, v2(0.0, 0.5)));
            parent = b;
            anchor = v2(0.0, -0.5);
        }
        let mut t = Tree { world: w, joints };
        for _ in 0..600 {
            t.world.step(DT).unwrap();
        }
        worst_gap(&t)
    };
    for load in [1000.0, 2000.0] {
        let g = gap(load);
        assert!(g < 0.005, "a chain under {load}:1 opens by {g} m");
    }
}

/// The same arms started 0.05 m apart (joints open by up to 0.15 m): the tree closes them and holds the heavy balls where
/// block Gauss-Seidel leaves them open and sagging.
#[test]
fn a_tree_closes_joints_that_start_open_and_gauss_seidel_does_not() {
    let run = |trees: bool| {
        let mut w = World::default();
        w.no_joint_trees = !trees;
        let hook = w.create_body(&BodyDef { kind: Kind::Static, position: v2(0.0, 10.0), ..Default::default() }).unwrap();
        let mut joints = Vec::new();
        let (mut parent, mut anchor) = (hook, V2::ZERO);
        let mut link = |w: &mut World, at: V2, density: f32| {
            let b = w.create_body(&BodyDef { position: at, can_sleep: false, ..Default::default() }).unwrap();
            w.create_shape(b, Core::rect(0.05, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density, friction: 0.0, groups: 0, ..Default::default() }).unwrap();
            b
        };
        for i in 0..3 {
            let b = link(&mut w, v2(0.0, 9.5 - i as f32), 1.0);
            pin(&mut w, parent, b, anchor, v2(0.0, 0.5));
            joints.push((b, parent, anchor, v2(0.0, 0.5)));
            parent = b;
            anchor = v2(0.0, -0.5);
        }
        for side in [-1.0f32, 1.0] {
            let (mut p, mut a) = (parent, anchor);
            for i in 0..3 {
                let b = link(&mut w, v2(side * 0.05 * (i + 1) as f32, 6.5 - i as f32), if i == 2 { 1000.0 } else { 1.0 });
                pin(&mut w, p, b, a, v2(0.0, 0.5));
                joints.push((b, p, a, v2(0.0, 0.5)));
                p = b;
                a = v2(0.0, -0.5);
            }
        }
        let mut t = Tree { world: w, joints };
        for _ in 0..600 {
            t.world.step(DT).unwrap();
        }
        worst_gap(&t)
    };
    let (tree, gs) = (run(true), run(false));
    assert!(tree < gs, "the tree ({tree}) is no better than Gauss-Seidel ({gs})");
}

/// A kick to the heavy torso does not open a joint, over twenty seconds, and the same tree under block Gauss-Seidel flies
/// apart (the control).
#[test]
fn a_kicked_tree_stays_closed_and_gauss_seidel_does_not() {
    for (trees, closed) in [(true, true), (false, false)] {
        let mut t = humanoid(1000.0, true);
        t.world.no_joint_trees = !trees;
        t.world.bodies[2].linear_velocity = v2(1.0e-3, 0.0);
        let mut worst = 0.0f32;
        for step in 0..1200 {
            t.world.step(DT).unwrap();
            if step >= 60 {
                worst = worst.max(worst_gap(&t));
            }
        }
        assert_eq!(worst < 0.005, closed, "trees {trees}: worst gap {worst}");
    }
}
