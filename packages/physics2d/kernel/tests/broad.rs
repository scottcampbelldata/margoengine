// The broad phase: the box tree (kernel-common tree.rs) finds the same pairs as the sweep and brute force, and on the
// 100-row pyramid the world steps to the same bits with either while the tree tests a small part of the boxes. The
// paired timing (ignored by default, run with --ignored) takes turns between the two in one process and compares per-round
// minimums (AGENTS.md: speed by work counts or a paired A/B, never a wall clock alone).
use margoengine_physics_kernel_common::broad::{Bounds, SweepPrune};
use margoengine_physics_kernel_common::tree::Tree;
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{BodyDef, BroadPhase, Kind, Settings, ShapeDef, World};

const DT: f32 = 1.0 / 60.0;

/// A tiny deterministic generator (xorshift), so the random scenes are the same on every run.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
}

fn brute(boxes: &[Option<Bounds<2>>]) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for i in 0..boxes.len() {
        for j in i + 1..boxes.len() {
            if let (Some(a), Some(b)) = (&boxes[i], &boxes[j]) {
                if a.overlaps(b) {
                    out.push((i as u32, j as u32));
                }
            }
        }
    }
    out
}

#[test]
fn the_tree_keeps_the_pairs_brute_force_finds_as_boxes_move_come_and_go() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let (mut tree, mut sweep) = (Tree::<2>::new(), SweepPrune::<2>::new());
    let mut fat: Vec<Option<Bounds<2>>> = vec![None; 400];
    let mut tight: Vec<Option<Bounds<2>>> = vec![None; 400];
    let (mut a, mut b) = (Vec::new(), Vec::new());
    for round in 0..200 {
        for _ in 0..60 {
            let key = (rng.next() * 400.0) as usize % 400;
            if rng.next() < 0.1 && tight[key].is_some() {
                tree.remove(key as u32);
                sweep.remove(key as u32);
                tight[key] = None;
                fat[key] = None;
                continue;
            }
            // A box somewhere in a 40 m square, 0.1 to 3 m wide, or nudged from where it was.
            let (x, y, w, h) = match tight[key] {
                Some(t) if rng.next() < 0.7 => (t.min[0] + 0.3 * (rng.next() - 0.5), t.min[1] + 0.3 * (rng.next() - 0.5), t.max[0] - t.min[0], t.max[1] - t.min[1]),
                _ => (40.0 * rng.next(), 40.0 * rng.next(), 0.1 + 3.0 * rng.next(), 0.1 + 3.0 * rng.next()),
            };
            let t = Bounds { min: [x, y], max: [x + w, y + h] };
            tight[key] = Some(t);
            tree.place(key as u32, &t, 0.1);
            sweep.place(key as u32, &t, 0.1);
            fat[key] = tree.fat(key as u32).copied();
            assert_eq!(tree.fat(key as u32), sweep.fat(key as u32));
        }
        tree.pairs(&mut a, |_, _| true);
        sweep.pairs(&mut b, |_, _| true);
        assert_eq!(a, brute(&fat), "round {round}: the tree's pairs");
        assert_eq!(a, b, "round {round}: the sweep's pairs");
    }
}

fn pyramid(settings: Settings, rows: usize) -> (World, Vec<u32>) {
    let mut world = World::new(settings);
    let g = world.create_body(&BodyDef { kind: Kind::Static, ..Default::default() });
    world.create_shape(g, Core::rect(500.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &ShapeDef::default());
    let mut boxes = Vec::new();
    for row in 0..rows {
        let count = rows - row;
        for i in 0..count {
            let x = i as f32 - 0.5 * (count as f32 - 1.0);
            let b = world.create_body(&BodyDef { position: v2(x, 0.5 + row as f32), ..Default::default() });
            world.create_shape(b, Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &ShapeDef { density: 1.0, friction: 0.6, restitution: 0.0 });
            boxes.push(b);
        }
    }
    (world, boxes)
}

fn bits(world: &World) -> Vec<u64> {
    world
        .bodies
        .iter()
        .flat_map(|b| [b.exact_center[0].to_bits(), b.exact_center[1].to_bits(), (b.xf.q.c.to_bits() as u64) << 32 | b.xf.q.s.to_bits() as u64])
        .collect()
}

#[test]
fn the_100_row_pyramid_steps_to_the_same_bits_with_either_broad_phase() {
    let (mut tree, _) = pyramid(Settings::default(), 100);
    let (mut sweep, _) = pyramid(Settings { broad_phase: BroadPhase::Sweep, ..Default::default() }, 100);
    let (mut tested_tree, mut tested_sweep, mut pairs) = (0u64, 0u64, 0u64);
    let steps = 120;
    for step in 0..steps {
        tree.step(DT);
        sweep.step(DT);
        assert_eq!(tree.counts.pairs, sweep.counts.pairs, "step {step}: pairs");
        assert!(tree.contacts.iter().map(|c| (c.a, c.b)).eq(sweep.contacts.iter().map(|c| (c.a, c.b))), "step {step}: contacts");
        assert_eq!(bits(&tree), bits(&sweep), "step {step}: the bodies' bits");
        tested_tree += tree.counts.compared;
        tested_sweep += sweep.counts.compared;
        pairs += tree.counts.pairs;
    }
    let n = steps as u64;
    println!(
        "100-row pyramid, {steps} steps: boxes tested a step, tree {} against sweep {}, for {} pairs",
        tested_tree / n,
        tested_sweep / n,
        pairs / n
    );
    // Measured 2026-11-08: 15,133 against 497,402 a step (the tree's first step, every box put in, is 329,171).
    assert!(tested_tree * 20 < tested_sweep, "the tree tested {tested_tree}, the sweep {tested_sweep}");
}

#[test]
#[ignore]
fn paired_timing_of_the_two_broad_phases_on_the_100_row_pyramid() {
    // Rounds of 20 steps on each world in turn, both from the same start; per-round minimums of the step time.
    use std::time::Instant;
    let (mut tree, _) = pyramid(Settings::default(), 100);
    let (mut sweep, _) = pyramid(Settings { broad_phase: BroadPhase::Sweep, ..Default::default() }, 100);
    let (mut best_tree, mut best_sweep) = (f64::INFINITY, f64::INFINITY);
    let mut rounds = Vec::new();
    for round in 0..30 {
        let (mut t, mut s) = (f64::INFINITY, f64::INFINITY);
        for _ in 0..20 {
            let start = Instant::now();
            tree.step(DT);
            t = t.min(start.elapsed().as_secs_f64() * 1e3);
            let start = Instant::now();
            sweep.step(DT);
            s = s.min(start.elapsed().as_secs_f64() * 1e3);
        }
        assert_eq!(bits(&tree), bits(&sweep), "round {round}");
        best_tree = best_tree.min(t);
        best_sweep = best_sweep.min(s);
        rounds.push((t, s));
    }
    for (i, (t, s)) in rounds.iter().enumerate() {
        println!("round {i}: tree {t:.3} ms, sweep {s:.3} ms");
    }
    println!("best step: tree {best_tree:.3} ms, sweep {best_sweep:.3} ms");
}
