// The narrow phase's fast paths (src/manifold.rs: four-cornered polygons in lanes, the remainder-free edge walk) give
// the bits of the code they replaced, kept verbatim in support/manifold_ref.rs: every manifold of the suite scenes over
// 240 steps and of a million random pairs is compared field by field with `to_bits`. The ignored test is the paired
// A/B of the two (AGENTS.md: old and new in turns in one process, per-round minimums).
extern crate alloc;

#[path = "support/bits_scenes.rs"]
mod scenes;
#[path = "support/manifold_ref.rs"]
mod reference;

use margoengine_physics_kernel_common::lanes::F4;
use margoengine_physics2d_kernel::manifold::{Manifold, collide_coherent, reference_flip};
use margoengine_physics2d_kernel::math::{Rot, V2, Xf, v2};
use margoengine_physics2d_kernel::shape::Core;
use margoengine_physics2d_kernel::world::{SPECULATIVE, World};

type Input = (Core, Xf, Core, Xf, Option<bool>);

/// Every manifold field as bits: count, normal, then each point's position, separation and id.
fn key(m: &Manifold) -> Vec<u32> {
    let mut k = vec![m.count as u32, m.normal.x.to_bits(), m.normal.y.to_bits()];
    for p in &m.points[..m.count] {
        k.extend([p.point.x.to_bits(), p.point.y.to_bits(), p.separation.to_bits(), p.id]);
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

/// Compares the two on `inputs` at several speculative distances; returns (compared, differing).
fn compare(inputs: &[Input]) -> (u64, u64) {
    let (mut n, mut differ) = (0u64, 0u64);
    for (a, xa, b, xb, last) in inputs {
        for speculative in [SPECULATIVE, 0.5, 0.0] {
            let (new, old) = (collide_coherent(a, *xa, b, *xb, speculative, *last), reference::collide_coherent(a, *xa, b, *xb, speculative, *last));
            n += 1;
            if key(&new) != key(&old) {
                differ += 1;
                if differ <= 3 {
                    println!("differs: {a:?} {xa:?} {b:?} {xb:?} {last:?} at {speculative}\n new {new:?}\n old {old:?}");
                }
            }
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

#[test]
#[ignore]
fn narrow_ab_of_the_100_row_pyramid() {
    // Paired A/B: the reference and the fast paths on the same pyramid inputs in turns, 30 rounds, per-round minimums.
    let mut world = scenes::pyramid(100);
    for _ in 0..60 {
        world.step(scenes::DT);
    }
    let inputs = narrow_inputs(&world);
    let (mut old, mut new, mut sink) = (Vec::new(), Vec::new(), 0.0f32);
    for _ in 0..30 {
        let t = std::time::Instant::now();
        for (a, xa, b, xb, last) in &inputs {
            sink += reference::collide_coherent(a, *xa, b, *xb, SPECULATIVE, *last).normal.x;
        }
        old.push(t.elapsed().as_secs_f64() * 1e3);
        let t = std::time::Instant::now();
        for (a, xa, b, xb, last) in &inputs {
            sink += collide_coherent(a, *xa, b, *xb, SPECULATIVE, *last).normal.x;
        }
        new.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let (o, w) = (old.iter().cloned().fold(f64::INFINITY, f64::min), new.iter().cloned().fold(f64::INFINITY, f64::min));
    let faster = old.iter().zip(&new).filter(|(o, n)| n < o).count();
    println!(
        "AB {} pairs: old {o:.3} ms ({:.1} ns a pair), new {w:.3} ms ({:.1} ns), new faster in {faster} of 30 rounds {sink}",
        inputs.len(),
        o * 1e6 / inputs.len() as f64,
        w * 1e6 / inputs.len() as f64
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
