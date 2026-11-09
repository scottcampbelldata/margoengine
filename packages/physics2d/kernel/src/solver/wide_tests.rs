use super::*;
include!("wide_certificate_tests.rs");

std::thread_local! { static VISITS: core::cell::Cell<[u64;4]> = const { core::cell::Cell::new([0;4]) }; }

pub(super) fn record(common: M4, exceptional: M4, biased: bool) {
    VISITS.with(|visits| {
        let mut v = visits.get();
        let i = if biased { 0 } else { 2 };
        v[i] += common.bits().count_ones() as u64;
        v[i + 1] += exceptional.bits().count_ones() as u64;
        visits.set(v);
    });
}

fn constraint(scale: f32, count: u8, coupled: bool, old: [f32; 2]) -> Constraint {
    let mut c = Constraint {
        contact: 0,
        a: 0,
        b: 1,
        inv_mass_a: 0.0,
        inv_i_a: 0.0,
        inv_mass_b: scale,
        inv_i_b: 6.0 * scale,
        normal: super::super::V2 { x: 0.0, y: 1.0 },
        friction: 0.5,
        k: [2.5 * scale, -0.5 * scale, 2.5 * scale],
        points: [super::super::Point::default(); 2],
        count,
        block: coupled,
        eighth: false,
        pushed: 0,
    };
    for (i, x) in [-0.5, 0.5].into_iter().enumerate() {
        c.points[i].anchor_a = super::super::V2 { x, y: 0.0 };
        c.points[i].anchor_b = super::super::V2 { x, y: -0.5 };
        c.points[i].normal_mass = 1.0 / c.k[if i == 0 { 0 } else { 2 }];
        c.points[i].normal_impulse = old[i];
    }
    if count == 1 {
        c.points[1] = super::super::Point::default();
    }
    c
}

fn block(cs: &[Constraint]) -> Block {
    let mut blocks = Blocks::default();
    let order: Vec<_> = (0..cs.len() as u32).collect();
    blocks.push(cs, &order);
    blocks.blocks[0]
}

fn motion(vy: [f32; 4], w: [f32; 4]) -> Motion4 {
    Motion4 {
        vx: F4::splat(0.3),
        vy: F4::new(vy),
        w: F4::new(w),
    }
}

fn bits(c: &Block, a: Motion4, b: Motion4) -> Vec<u32> {
    let mut out = Vec::new();
    for v in [
        c.points[0].normal_impulse,
        c.points[1].normal_impulse,
        a.vx,
        a.vy,
        a.w,
        b.vx,
        b.vy,
        b.w,
    ] {
        out.extend(v.get()[..c.lanes as usize].iter().map(|v| v.to_bits()));
    }
    out.extend(c.pushed.map(|p| p.bits() & c.live.bits()));
    out
}

/// Every unit-test world visit shadows the production SIMD answer with the pre-existing scalar/f64 adapter.
/// This covers all original world/chain/joint fixtures below, not just sampled final scene hashes.
#[allow(clippy::too_many_arguments)]
pub(super) fn check_visit(
    start: (Block, Motion4, Motion4),
    got: &Block,
    a: Motion4,
    b: Motion4,
    gaps: [F4; 2],
    biased: bool,
    inv_h: F4,
    max_push: F4,
    spring: (F4, F4, F4),
    result: Result<(u64, u64), PhysicsError>,
) {
    let (mut reference, mut ra, mut rb) = start;
    let expected = capped_lanes(
        reference.live,
        &mut reference,
        &mut ra,
        &mut rb,
        gaps,
        biased,
        inv_h,
        max_push,
        spring,
    );
    assert_eq!(
        result, expected,
        "per-visit counts/error differs from scalar reference"
    );
    if result.is_ok() {
        assert_eq!(
            bits(got, a, b),
            bits(&reference, ra, rb),
            "per-visit motion/impulse bits differ from scalar reference"
        );
    }
}

fn compare(
    mut c: Block,
    mut a: Motion4,
    mut b: Motion4,
    gaps: [F4; 2],
    biased: bool,
    s: Soft,
    cap: f32,
) -> u32 {
    let (mut reference, mut ra, mut rb) = (c, a, b);
    let (inv_h, max_push) = (F4::splat(240.0), F4::splat(cap));
    let spring = (
        F4::splat(s.bias_rate),
        F4::splat(s.mass_scale),
        F4::splat(s.impulse_scale),
    );
    let ratio = F4::splat(s.impulse_scale / s.mass_scale);
    let (mut probe, mut pa, mut pb) = (c, a, b);
    let (_, certified) = normal_common(
        &mut probe, &mut pa, &mut pb, gaps, biased, inv_h, max_push, spring, ratio,
    );
    let expected = capped_lanes(
        reference.live,
        &mut reference,
        &mut ra,
        &mut rb,
        gaps,
        biased,
        inv_h,
        max_push,
        spring,
    );
    let got = normal(
        &mut c, &mut a, &mut b, gaps, biased, inv_h, max_push, spring, ratio,
    );
    assert_eq!(
        got,
        expected,
        "counts/error mismatch, gaps {:?}/{:?}, spring {s:?}, cap {cap}",
        gaps[0].get(),
        gaps[1].get()
    );
    if got.is_ok() {
        assert_eq!(
            bits(&c, a, b),
            bits(&reference, ra, rb),
            "motion/cache mismatch, gaps {:?}/{:?}, spring {s:?}, cap {cap}",
            gaps[0].get(),
            gaps[1].get()
        );
    }
    certified.bits()
}

#[test]
fn mixed_common_capped_sequential_and_open_lanes_match_the_scalar_reference() {
    let c = block(&[
        constraint(1.0, 2, true, [0.1; 2]),
        constraint(1.0, 2, true, [0.0; 2]),
        constraint(1.0, 2, false, [0.0; 2]),
        constraint(1.0, 1, false, [0.0; 2]),
    ]);
    let mask = compare(
        c,
        motion([0.0; 4], [0.0; 4]),
        motion([-0.1, -1.0, -0.1, -0.1], [0.0; 4]),
        [F4::new([0.0, -1.0, -0.01, 0.01]); 2],
        true,
        super::super::soft(60.0, 10.0, 1.0 / 240.0),
        3.0,
    );
    assert_eq!(
        mask & 15,
        13,
        "only the deliberately cap-active lane must decline common arithmetic"
    );
}

#[test]
fn potential_certificate_keeps_cap_boundary_bits_and_checks_the_zero_row_domain() {
    let zero = F4::splat(0.0);
    let one = F4::splat(1.0);
    for cap in [0.0f32, 0.1, 3.0, 17.123] {
        let bias = F4::new([(-cap).next_down(), -cap, (-cap).next_up(), -100.0]);
        for x in [0.0, f32::from_bits(1), 0.125, 1.0, f32::MAX] {
            for (kii, ms, is) in [
                (1.0, 1.0, 0.0),
                (1.0, 1.0, 1.0),
                (f32::MAX, f32::from_bits(1), f32::MAX),
            ] {
                let answer = F4::splat(x);
                let got = certify_potential(
                    M4::from_bits(15),
                    F4::splat(kii),
                    zero,
                    true,
                    bias,
                    F4::splat(ms),
                    F4::splat(is),
                    answer,
                    F4::splat(cap),
                );
                let c = kii as f64 * (is as f64 / ms as f64);
                let mut expected = 0;
                for (i, b) in bias.get().into_iter().enumerate() {
                    expected |=
                        ((x == 0.0 || b as f64 + c * x as f64 >= -(cap as f64)) as u32) << i;
                }
                assert_eq!(
                    got.bits(),
                    expected,
                    "boundary cap{cap} x{x} K{kii} ms{ms} is{is}"
                );
            }
        }
    }
    for (ms, is) in [
        (0.0, 0.0),
        (0.0, 1.0),
        (-1.0, 1.0),
        (1.0, -1.0),
        (1.0, f32::INFINITY),
    ] {
        assert_eq!(
            certify_potential(
                M4::from_bits(15),
                one,
                zero,
                true,
                zero,
                F4::splat(ms),
                F4::splat(is),
                zero,
                one
            )
            .bits(),
            0,
            "a zero impulse must not hide invalid compliance"
        );
        assert_eq!(
            certify_potential(
                M4::from_bits(15),
                one,
                one,
                true,
                zero,
                F4::splat(ms),
                F4::splat(is),
                zero,
                one
            )
            .bits(),
            15,
            "an open row does not use the spring coefficients"
        );
    }
}

#[test]
fn common_certificate_zero_rows_partial_blocks_and_numeric_extremes_match_scalar() {
    let mut seed = 0x7823445au32;
    let mut random = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (seed >> 8) as f32 / (1u32 << 24) as f32
    };
    let mut common = 0;
    let mut exceptional = 0;
    for case in 0..4096 {
        let lanes = 1 + case % 4;
        let mut constraints = Vec::new();
        let mut vy = [0.0; 4];
        let mut angular = [0.0; 4];
        let mut gaps = [[0.0; 4]; 2];
        for lane in 0..lanes {
            let exponent = [-100, -60, -10, 0, 10, 60, 100][(case + lane) % 7];
            let scale = 2.0f32.powi(exponent);
            let count = if (case + lane) % 3 == 0 { 1 } else { 2 };
            constraints.push(constraint(
                scale,
                count,
                count == 2 && (case + lane) % 5 != 0,
                [(random() * 8.0) / scale, (random() * 8.0) / scale],
            ));
            vy[lane] = (random() - 0.5) * 64.0;
            angular[lane] = (random() - 0.5) * 8.0;
            for gap in &mut gaps {
                gap[lane] = (random() - 0.7) * 2.0;
            }
        }
        let spring = super::super::soft([0.0, 1.0, 60.0, 240.0][case % 4], 10.0, 1.0 / 240.0);
        let mask = compare(
            block(&constraints),
            motion([0.0; 4], [0.0; 4]),
            motion(vy, angular),
            gaps.map(F4::new),
            case % 7 != 0,
            spring,
            [0.0, 0.1, 3.0, 17.123][case % 4],
        );
        common += (mask & ((1 << lanes) - 1)).count_ones();
        exceptional += ((!mask) & ((1 << lanes) - 1)).count_ones();
    }
    assert!(
        common > 1000 && exceptional > 1000,
        "coverage common{common} exceptional{exceptional}"
    );
    // A zero normal impulse remains certified even below the cap: its nonnegative original soft residual
    // remains nonnegative after replacing the row potential by max(soft,cap).
    let c = block(&[constraint(1.0, 2, true, [0.0; 2])]);
    assert_eq!(
        compare(
            c,
            motion([0.0; 4], [0.0; 4]),
            motion([1000.0; 4], [0.0; 4]),
            [F4::splat(-1.0); 2],
            true,
            super::super::soft(60.0, 10.0, 1.0 / 240.0),
            3.0
        ) & 1,
        1
    );
}

// Reuse original assertions and scene inputs verbatim; these tests additionally execute check_visit above.
#[test]
fn accepted_scene_hashes_match_while_every_simd_visit_is_shadowed() {
    // The production scenes and pins, additionally checked at every intermediate live SIMD visit.
    for lanes in [true, false] {
        let got = [scenes::pyramid(100), scenes::joint_grid(), scenes::mixed()].map(|mut world| {
            world.settings.contact_lanes = lanes;
            scenes::run(world)
        });
        assert_eq!(got, scenes::PINNED, "accepted scene hashes, lanes={lanes}");
    }
}
#[path = "../../tests/support_numeric.rs"]
mod derived_numeric_bars;

#[path = "../../tests/support/bits_scenes.rs"]
mod scenes;

#[test]
fn certified_common_path_avoids_scalar_materialization_in_the_pyramid_window() {
    let mut w = scenes::pyramid(100);
    for _ in 0..60 {
        w.step(scenes::DT).unwrap();
    }
    VISITS.with(|v| v.set([0; 4]));
    for _ in 60..100 {
        w.step(scenes::DT).unwrap();
    }
    let v = VISITS.with(core::cell::Cell::get);
    println!(
        "SIMD_COMMON_WINDOW biased_common={} biased_exceptional={} relax_common={} relax_exceptional={}",
        v[0], v[1], v[2], v[3]
    );
    assert!(
        v[0] > v[1] && v[0] > 0,
        "the common biased path must actually avoid reference records"
    );
}
#[path = "../../tests/chain.rs"]
mod original_chain_bars;
#[path = "../../tests/joints.rs"]
mod original_joint_bars;
#[path = "../../tests/world.rs"]
mod original_world_bars;
#[path = "../../tests/support_domains.rs"]
mod transition_bars;
