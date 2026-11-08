// The narrow phase's fast paths (src/manifold.rs: four-cornered polygons in lanes, the remainder-free edge walk) give
// the bits of the code they replaced, kept verbatim in support/manifold_ref.rs: every scalar and four-pair manifold of
// the suite scenes over 240 steps and of 400,000 random pairs at three speculative distances is compared field by field with `to_bits`. The ignored
// test is the paired
// A/B of the two (AGENTS.md: old and new in turns in one process, per-round minimums).
extern crate alloc;

#[path = "support/bits_scenes.rs"]
mod scenes;
#[path = "support/manifold_ref.rs"]
mod reference;

use margoengine_physics_kernel_common::lanes::F4;
use margoengine_physics2d_kernel::manifold::{Manifold, collide_coherent, collide_four, reference_flip};
use margoengine_physics2d_kernel::math::{Rot, V2, Xf, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::smooth::collide_smooth;
use margoengine_physics2d_kernel::world::{BodyDef, Kind, SPECULATIVE, Settings, ShapeDef, World};

type Input = (Core, Xf, Core, Xf, Option<bool>);

/// Every manifold field as bits, including the unused point slots and an empty manifold's normal.
fn key(m: &Manifold) -> [u32; 11] {
    let mut k = [0; 11];
    k[..3].copy_from_slice(&[m.count as u32, m.normal.x.to_bits(), m.normal.y.to_bits()]);
    for (i, p) in m.points.iter().enumerate() {
        k[3 + 4 * i..7 + 4 * i].copy_from_slice(&[p.point.x.to_bits(), p.point.y.to_bits(), p.separation.to_bits(), p.id]);
    }
    k
}

/// The inputs the world's narrow phase gives `collide_coherent` this step (chains go through smooth.rs instead).
fn narrow_inputs(world: &World) -> Vec<Input> {
    let mut out = Vec::new();
    for contact in &world.contacts {
        let (sa, sb) = (&world.shapes[contact.a as usize], &world.shapes[contact.b as usize]);
        let (ba, bb) = (&world.bodies[sa.body as usize], &world.bodies[sb.body as usize]);
        if !ba.awake && !bb.awake || sa.chain || sb.chain {
            continue;
        }
        let from = ba.exact_center;
        let (oa, ob) = (ba.exact_origin(), bb.exact_origin());
        let xa = Xf { p: v2((oa[0] - from[0]) as f32, (oa[1] - from[1]) as f32), q: ba.xf.q };
        let xb = Xf { p: v2((ob[0] - from[0]) as f32, (ob[1] - from[1]) as f32), q: bb.xf.q };
        out.push((sa.core, xa, sb.core, xb, reference_flip(&contact.manifold)));
    }
    out
}

/// Both entry points against the kept reference, lane by lane; no lane can borrow another lane's result or face choice.
fn compare_lanes(inputs: [&Input; 4], speculative: f32, n: &mut u64, differ: &mut u64) {
    let batch = inputs.map(|(a, xa, b, xb, last)| (a, *xa, b, *xb, *last));
    let batched = collide_four(batch, speculative);
    for (lane, (a, xa, b, xb, last)) in inputs.into_iter().enumerate() {
        let old = reference::collide_coherent(a, *xa, b, *xb, speculative, *last);
        let scalar = collide_coherent(a, *xa, b, *xb, speculative, *last);
        for (path, new) in [("scalar", scalar), ("four", batched[lane])] {
            *n += 1;
            if key(&new) != key(&old) {
                *differ += 1;
                if *differ <= 3 {
                    println!("{path} lane {lane} differs: {a:?} {xa:?} {b:?} {xb:?} {last:?} at {speculative}\n new {new:?}\n old {old:?}");
                }
            }
        }
    }
}

/// Compares both entry points at several speculative distances; pads a final 1/2/3-pair batch with live inputs and
/// checks those lanes too, so the same input is exact whether it stands alone or shares a full batch.
fn compare(inputs: &[Input]) -> (u64, u64) {
    let (mut n, mut differ) = (0u64, 0u64);
    for chunk in inputs.chunks(4) {
        let batch = core::array::from_fn(|lane| &chunk[lane % chunk.len()]);
        for speculative in [SPECULATIVE, 0.5, 0.0] {
            compare_lanes(batch, speculative, &mut n, &mut differ);
        }
    }
    (n, differ)
}

#[test]
fn suite_scene_manifolds_keep_their_bits() {
    let (mut n, mut differ) = (0, 0);
    for mut world in [scenes::pyramid(100), scenes::joint_grid(), scenes::mixed(), scenes::pyramid(20)] {
        for _ in 0..240 {
            let (a, b) = compare(&narrow_inputs(&world));
            (n, differ) = (n + a, differ + b);
            world.step(scenes::DT);
        }
    }
    println!("compared {n} manifolds, {differ} differ");
    assert!(n > 3_000_000, "only {n} manifolds compared");
    assert_eq!(differ, 0);
}

/// A small generator (xorshift32) so the pairs are the same on every run.
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}

/// A random shape: a box (turned, offset, sometimes rounded), a random quad, a triangle, a hexagon, a capsule or a circle.
fn shape(r: &mut Rng) -> Core {
    let kind = (r.next() * 8.0) as u32;
    let radius = if r.next() < 0.3 { r.range(0.0, 0.1) } else { 0.0 };
    let angle = r.range(-3.2, 3.2);
    let (c, s) = (angle.cos(), angle.sin());
    let at = v2(r.range(-0.2, 0.2), r.range(-0.2, 0.2));
    let corners = |r: &mut Rng, n: usize| -> Vec<V2> {
        (0..n).map(|i| {
            let t = (i as f32 + r.range(-0.3, 0.3)) * core::f32::consts::TAU / n as f32;
            let size = r.range(0.3, 0.8);
            v2(size * t.cos(), size * t.sin())
        }).collect()
    };
    let core = match kind {
        0..=2 => Core::rect(r.range(0.05, 1.0), r.range(0.05, 1.0), at, c, s, radius),
        3 => Core::polygon(&corners(r, 4), radius),
        4 => Core::polygon(&corners(r, 3), radius),
        5 => Core::polygon(&corners(r, 6), radius),
        6 => Core::capsule(v2(-0.4, 0.0), v2(0.4, r.range(-0.2, 0.2)), r.range(0.0, 0.3)),
        _ => Core::circle(at, r.range(0.05, 0.5)),
    };
    core.unwrap_or_else(|_| Core::circle(at, 0.3).unwrap())
}

fn pose(r: &mut Rng, spread: f32) -> Xf {
    let angle = r.range(-3.2, 3.2);
    Xf { p: v2(r.range(-spread, spread), r.range(-spread, spread)), q: Rot { c: angle.cos(), s: angle.sin() } }
}

#[test]
fn random_pair_manifolds_keep_their_bits() {
    let mut r = Rng(0x9e37_79b9);
    let mut inputs = Vec::new();
    for i in 0..400_000 {
        let (a, b) = (shape(&mut r), shape(&mut r));
        // Near poses, and every fourth pair nearly resting: B a small turn and a small gap above A.
        let (xa, xb) = if i % 4 == 0 {
            let xa = Xf { p: v2(0.0, 0.0), q: Rot { c: 1.0, s: 0.0 } };
            let turn = r.range(-0.02, 0.02);
            (xa, Xf { p: v2(r.range(-1.0, 1.0), r.range(0.5, 1.2)), q: Rot { c: turn.cos(), s: turn.sin() } })
        } else {
            (pose(&mut r, 0.3), pose(&mut r, 1.2))
        };
        let last = match i % 3 {
            0 => None,
            1 => Some(false),
            _ => Some(true),
        };
        inputs.push((a, xa, b, xb, last));
    }
    let (n, differ) = compare(&inputs);
    println!("compared {n} random manifolds, {differ} differ");
    assert_eq!(differ, 0);
}

const LAST_FACES: [Option<bool>; 3] = [None, Some(false), Some(true)];
const PERMUTATIONS: [[usize; 4]; 24] = [
    [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1], [0, 3, 1, 2], [0, 3, 2, 1],
    [1, 0, 2, 3], [1, 0, 3, 2], [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0],
    [2, 0, 1, 3], [2, 0, 3, 1], [2, 1, 0, 3], [2, 1, 3, 0], [2, 3, 0, 1], [2, 3, 1, 0],
    [3, 0, 1, 2], [3, 0, 2, 1], [3, 1, 0, 2], [3, 1, 2, 0], [3, 2, 0, 1], [3, 2, 1, 0],
];

/// Mixed batches deliberately put overlap clipping, apart-distance fallback, rejection and non-quad fallback together.
fn batch_cases() -> [Input; 12] {
    let square = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let rounded = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.1).unwrap();
    let quad = Core::polygon(&[v2(-0.7, -0.4), v2(0.5, -0.6), v2(0.8, 0.4), v2(-0.4, 0.7)], 0.03).unwrap();
    let triangle = Core::polygon(&[v2(-0.6, -0.5), v2(0.6, -0.5), v2(0.0, 0.7)], 0.02).unwrap();
    let capsule = Core::capsule(v2(-0.4, 0.0), v2(0.4, 0.1), 0.2).unwrap();
    let circle = Core::circle(v2(0.1, -0.1), 0.3).unwrap();
    let at = |x, y| Xf { p: v2(x, y), q: Rot { c: 1.0, s: 0.0 } };
    let turned = |x, y| Xf { p: v2(x, y), q: Rot { c: 0.8, s: 0.6 } };
    [
        (square, Xf::IDENTITY, square, at(0.0, 0.9), None),
        (rounded, Xf::IDENTITY, rounded, at(1.08, 1.08), None),
        (square, Xf::IDENTITY, square, at(4.0, 3.0), None),
        (circle, Xf::IDENTITY, circle, at(0.4, 0.0), None),
        (square, Xf::IDENTITY, square, at(0.1, 1.015), None),
        (square, at(-0.2, 0.4), square, turned(0.35, 0.9), None),
        (quad, Xf::IDENTITY, triangle, turned(0.4, 0.5), None),
        (capsule, turned(0.0, 0.0), circle, at(0.3, 0.15), None),
        (quad, turned(-0.4, 0.1), rounded, at(0.3, 0.4), None),
        (square, Xf::IDENTITY, square, at(0.0, 1.0), None),
        (square, Xf::IDENTITY, square, turned(0.9, 0.6), None),
        (square, turned(0.0, 0.0), quad, turned(1.0, 0.3), None),
    ]
}

#[test]
fn four_pair_lane_permutations_and_all_face_choices_keep_their_bits() {
    let cases = batch_cases();
    let (mut n, mut differ) = (0, 0);
    for group in cases.chunks_exact(4) {
        for permutation in PERMUTATIONS {
            // All 3^4 histories, independently in each lane. A batch-wide last-face flag would fail this test.
            for histories in 0..81 {
                let mut remaining = histories;
                let batch: [Input; 4] = permutation.map(|index| {
                    let mut input = group[index];
                    input.4 = LAST_FACES[remaining % 3];
                    remaining /= 3;
                    input
                });
                for speculative in [SPECULATIVE, 0.5, 0.0] {
                    compare_lanes(batch.each_ref(), speculative, &mut n, &mut differ);
                    assert_eq!(differ, 0, "permutation {permutation:?}, face histories {histories}, speculative {speculative}");
                }
            }
        }
    }
    assert_eq!(n, 3 * 24 * 81 * 3 * 8);
}

#[test]
fn four_pair_empty_and_short_tails_keep_their_bits() {
    let cases = batch_cases();
    // Every tail length, both with and without a preceding full batch. Rotate the cases so each path can be the tail.
    for offset in 0..cases.len() {
        let rotated: Vec<Input> = (0..cases.len()).map(|i| cases[(i + offset) % cases.len()]).collect();
        for len in 0..=cases.len() {
            let (n, differ) = compare(&rotated[..len]);
            assert_eq!(n, len.div_ceil(4) as u64 * 24, "offset {offset}, tail length {len}");
            assert_eq!(differ, 0, "offset {offset}, tail length {len}");
        }
    }
}

#[test]
fn world_quad_queue_crosses_scalar_chain_and_sleep_gaps_and_keeps_tail_bits() {
    let square = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
    let circle = Core::circle(V2::ZERO, 0.5).unwrap();
    for quads in 0..=12usize {
        let mut world = World::new(Settings { gravity: V2::ZERO, ..Default::default() });
        let groups = quads.max(1);
        for group in 0..groups {
            for kind in 0..4 {
                if kind == 0 && group >= quads {
                    continue;
                }
                let x = (group * 4 + kind) as f32 * 10.0;
                let base = world.create_body(&BodyDef { kind: Kind::Static, position: v2(x, 0.0), ..Default::default() });
                let height = if kind == 2 { 0.51 } else { 1.01 };
                let top = world.create_body(&BodyDef { position: v2(x, height), ..Default::default() });
                match kind {
                    0 | 3 => {
                        world.create_shape(base, square, &ShapeDef::default());
                        world.create_shape(top, square, &ShapeDef::default());
                    }
                    1 => {
                        world.create_shape(base, circle, &ShapeDef::default());
                        world.create_shape(top, circle, &ShapeDef::default());
                    }
                    _ => {
                        // Alternate which shape id owns the chain, exercising both smooth-dispatch directions.
                        if group % 2 == 0 {
                            world.create_shape(top, circle, &ShapeDef::default());
                        }
                        world.create_chain(base, &[v2(-0.5, 0.0), v2(0.5, 0.0)], false, &ShapeDef::default()).unwrap();
                        if group % 2 != 0 {
                            world.create_shape(top, circle, &ShapeDef::default());
                        }
                    }
                }
                if kind == 3 {
                    world.bodies[top as usize].awake = false;
                }
            }
        }
        for step in 0..3 {
            let before = world.bodies.clone();
            let old_contacts = world.contacts.clone();
            world.step(scenes::DT);
            let (mut eligible, mut built, mut cold) = (0, 0, 0);
            for contact in &world.contacts {
                let (sa, sb) = (&world.shapes[contact.a as usize], &world.shapes[contact.b as usize]);
                let (ba, bb) = (&before[sa.body as usize], &before[sb.body as usize]);
                let old = old_contacts.iter().find(|c| (c.a, c.b) == (contact.a, contact.b));
                let previous = old.map_or(Manifold::default(), |c| c.manifold);
                let expected = if !ba.awake && !bb.awake {
                    previous
                } else {
                    built += 1;
                    eligible += usize::from(!sa.chain && !sb.chain && sa.core.count == 4 && sb.core.count == 4);
                    let from = ba.exact_center;
                    let (oa, ob) = (ba.exact_origin(), bb.exact_origin());
                    let xa = Xf { p: v2((oa[0] - from[0]) as f32, (oa[1] - from[1]) as f32), q: ba.xf.q };
                    let xb = Xf { p: v2((ob[0] - from[0]) as f32, (ob[1] - from[1]) as f32), q: bb.xf.q };
                    let manifold = if sa.chain {
                        collide_smooth(&sa.core, sa.ghosts, xa, &sb.core, xb, SPECULATIVE)
                    } else if sb.chain {
                        let mut m = collide_smooth(&sb.core, sb.ghosts, xb, &sa.core, xa, SPECULATIVE);
                        m.normal = m.normal.neg();
                        m
                    } else {
                        reference::collide_coherent(&sa.core, xa, &sb.core, xb, SPECULATIVE, reference_flip(&previous))
                    };
                    if old.is_some_and(|c| c.normal_impulse[..c.manifold.count].iter().any(|&impulse| impulse != 0.0)) {
                        cold += manifold.points[..manifold.count].iter().filter(|point| {
                            !previous.points[..previous.count].iter().any(|old_point| old_point.id == point.id)
                        }).count() as u64;
                    }
                    manifold
                };
                assert_eq!(key(&contact.manifold), key(&expected), "{quads} queued quads, step {step}, pair ({}, {})", contact.a, contact.b);
            }
            assert_eq!(eligible, quads, "eligible queue length, step {step}");
            assert_eq!(built, quads + 2 * groups, "awake quad/scalar/chain contacts, step {step}");
            assert_eq!(world.contacts.len(), quads + 3 * groups, "including sleeping gaps, step {step}");
            assert_eq!(world.counts.manifolds, built as u64);
            assert_eq!(world.counts.cold_points, cold);
        }
    }
}

#[test]
fn four_pair_identity_and_signed_zero_manifolds_keep_their_bits() {
    let mut inputs = Vec::new();
    for zero in [0.0f32, -0.0] {
        for other_zero in [0.0f32, -0.0] {
            let a = Core::rect(0.5, 0.5, v2(zero, other_zero), 1.0, zero, other_zero).unwrap();
            let b = Core::rect(0.6, 0.2, v2(other_zero, zero), 0.0, 1.0, zero).unwrap();
            let rotations = [Rot { c: 1.0, s: zero }, Rot { c: -1.0, s: other_zero }, Rot { c: zero, s: 1.0 }];
            for qa in rotations {
                for qb in rotations {
                    for p in [v2(zero, other_zero), v2(zero, 0.69), v2(1.1001, other_zero), v2(2.0, 2.0)] {
                        for last in LAST_FACES {
                            inputs.push((a, Xf { p: v2(zero, other_zero), q: qa }, b, Xf { p, q: qb }, last));
                        }
                    }
                }
            }
        }
    }
    let (n, differ) = compare(&inputs);
    assert_eq!(n, inputs.len() as u64 * 6);
    assert_eq!(differ, 0);
}

#[test]
fn four_pair_large_local_and_world_coordinates_keep_their_bits() {
    let mut inputs = Vec::new();
    for local in [0.0, 1_000.0, 100_000.0, 1_000_000.0] {
        let a = Core::rect(0.5, 0.75, v2(local, -local), 1.0, 0.0, 0.03).unwrap();
        let b = Core::rect(0.7, 0.3, v2(local, -local), 0.8, 0.6, 0.07).unwrap();
        for world in [0.0, -1_000.0, 1_000_000.0, -16_777_216.0, 1e15] {
            for q in [Rot { c: 1.0, s: 0.0 }, Rot { c: 0.8, s: 0.6 }] {
                let xa = Xf { p: v2(world, -world), q };
                for offset in [v2(0.0, 0.0), v2(0.7, 0.2), v2(1.4, 0.0), v2(3.0, -2.0)] {
                    let xb = Xf { p: xa.p.add(offset), q };
                    for last in LAST_FACES {
                        inputs.push((a, xa, b, xb, last));
                    }
                }
            }
        }
    }
    let (n, differ) = compare(&inputs);
    assert_eq!(n, inputs.len() as u64 * 6);
    assert_eq!(differ, 0);
}

#[test]
#[ignore]
fn narrow_ab_of_the_100_row_pyramid() {
    // Current scalar versus four-pair entry on identical inputs: alternate order on every visit and take
    // each round's fastest of five visits, so a busy machine's scheduling does not decide the comparison.
    const ROUNDS: usize = 30;
    const VISITS: usize = 5;
    let mut world = scenes::pyramid(100);
    for _ in 0..60 {
        world.step(scenes::DT);
    }
    let inputs = narrow_inputs(&world);
    assert!(!inputs.is_empty());
    for chunk in inputs.chunks_exact(4) {
        let batch = core::array::from_fn(|lane| {
            let (a, xa, b, xb, last) = &chunk[lane];
            (a, *xa, b, *xb, *last)
        });
        for ((a, xa, b, xb, last), four) in chunk.iter().zip(collide_four(batch, SPECULATIVE)) {
            assert_eq!(key(&collide_coherent(a, *xa, b, *xb, SPECULATIVE, *last)), key(&four));
        }
    }
    let scalar = || {
        let mut sink = 0.0f32;
        for (a, xa, b, xb, last) in std::hint::black_box(inputs.as_slice()) {
            let manifold = std::hint::black_box(collide_coherent(a, *xa, b, *xb, SPECULATIVE, *last));
            sink += manifold.normal.x;
        }
        std::hint::black_box(sink)
    };
    let four = || {
        let mut sink = 0.0f32;
        let mut chunks = std::hint::black_box(inputs.as_slice()).chunks_exact(4);
        for chunk in &mut chunks {
            let batch = core::array::from_fn(|lane| {
                let (a, xa, b, xb, last) = &chunk[lane];
                (a, *xa, b, *xb, *last)
            });
            for manifold in collide_four(batch, SPECULATIVE) {
                let manifold = std::hint::black_box(manifold);
                sink += manifold.normal.x;
            }
        }
        // The same final one, two or three pairs are still solved, without padding or extra work.
        for (a, xa, b, xb, last) in chunks.remainder() {
            let manifold = std::hint::black_box(collide_coherent(a, *xa, b, *xb, SPECULATIVE, *last));
            sink += manifold.normal.x;
        }
        std::hint::black_box(sink)
    };
    assert_eq!(scalar().to_bits(), four().to_bits());
    let time = |run: &dyn Fn() -> f32| {
        let t = std::time::Instant::now();
        std::hint::black_box(run());
        t.elapsed().as_secs_f64() * 1e3
    };
    let (mut scalar_rounds, mut four_rounds) = (Vec::new(), Vec::new());
    for round in 0..ROUNDS {
        let (mut scalar_min, mut four_min) = (f64::INFINITY, f64::INFINITY);
        for visit in 0..VISITS {
            let (s, f) = if (round + visit) % 2 == 0 {
                (time(&scalar), time(&four))
            } else {
                let f = time(&four);
                (time(&scalar), f)
            };
            scalar_min = scalar_min.min(s);
            four_min = four_min.min(f);
        }
        scalar_rounds.push(scalar_min);
        four_rounds.push(four_min);
        println!(
            "AB round {:02}: scalar {scalar_min:.6} ms, four {four_min:.6} ms, ratio {:.6}",
            round + 1,
            four_min / scalar_min
        );
    }
    let scalar_min = scalar_rounds.iter().copied().fold(f64::INFINITY, f64::min);
    let four_min = four_rounds.iter().copied().fold(f64::INFINITY, f64::min);
    let faster = scalar_rounds.iter().zip(&four_rounds).filter(|(s, f)| f < s).count();
    println!(
        "AB {} pairs, {ROUNDS} rounds, {VISITS} visits: scalar {scalar_min:.6} ms ({:.3} ns a pair), four {four_min:.6} ms ({:.3} ns), ratio {:.6}, four faster in {faster} rounds",
        inputs.len(),
        scalar_min * 1e6 / inputs.len() as f64,
        four_min * 1e6 / inputs.len() as f64,
        four_min / scalar_min
    );
}

#[test]
fn pmin_and_pmax_are_the_compare_and_select() {
    // The lane path's least and its clamps lean on this: `pmin` is `o < self ? o : self` and `pmax` is
    // `self < o ? o : self`, lane by lane, zeros of either sign and NaN included (not `f32::min` or `f32::max`).
    let values = [0.0f32, -0.0, 1.0, -1.0, 0.5, f32::INFINITY, f32::NEG_INFINITY, f32::NAN, 1e-38, -3.5];
    for &x in &values {
        for &y in &values {
            let (a, b) = (F4::splat(x), F4::splat(y));
            let (lo, hi) = (a.pmin(b).get()[0], a.pmax(b).get()[0]);
            assert_eq!(lo.to_bits(), (if y < x { y } else { x }).to_bits(), "pmin({x}, {y})");
            assert_eq!(hi.to_bits(), (if x < y { y } else { x }).to_bits(), "pmax({x}, {y})");
        }
    }
}

#[test]
fn transpose_moves_rows_to_columns_and_keeps_every_bit() {
    // The four-lane solve gathers bodies with it: lane i of column j is lane j of row i, NaN payloads and -0 kept.
    let rows = [
        [1.0f32, -0.0, f32::from_bits(0x7fc0_1234), 4.0],
        [5.0, 6.0, f32::INFINITY, -8.5],
        [9.0, 1e-40, 11.0, 12.0],
        [-13.0, 14.0, 15.0, f32::NEG_INFINITY],
    ];
    let columns = F4::transpose(rows.map(F4::new)).map(F4::get);
    for i in 0..4 {
        for j in 0..4 {
            assert_eq!(columns[j][i].to_bits(), rows[i][j].to_bits(), "row {i} lane {j}");
        }
    }
}
