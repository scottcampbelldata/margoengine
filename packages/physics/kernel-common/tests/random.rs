// Philox 4x32-10 and the streams built on it: known answers, no dependence on the order of use, independent streams.
use margoengine_physics_kernel_common::random::{Random, philox4x32};

#[test]
fn the_published_known_answers_come_out() {
    // The known-answer vectors of Philox 4x32-10 as published with Salmon et al. 2011 (the counter and key in words, then
    // what ten rounds give).
    assert_eq!(philox4x32([0, 0, 0, 0], [0, 0]), [0x6627_e8d5, 0xe169_c58d, 0xbc57_ac4c, 0x9b00_dbd8]);
    assert_eq!(philox4x32([u32::MAX; 4], [u32::MAX; 2]), [0x408f_276d, 0x41c8_3b0e, 0xa20b_c7c6, 0x6d54_51fd]);
    assert_eq!(
        philox4x32([0x243f_6a88, 0x85a3_08d3, 0x1319_8a2e, 0x0370_7344], [0xa409_3822, 0x299f_31d0]),
        [0xd16c_fe09, 0x94fd_cceb, 0x5001_e420, 0x2412_6ea1]
    );
}

#[test]
fn what_an_element_draws_does_not_depend_on_the_order_the_elements_are_visited_in() {
    let draw = |element: u32| Random::new(7, 3, 1000, element).block(2);
    let forward: Vec<[u32; 4]> = (0..1000).map(draw).collect();
    let backward: Vec<[u32; 4]> = (0..1000).rev().map(draw).collect::<Vec<_>>().into_iter().rev().collect();
    assert_eq!(forward, backward);
    // And a number is the same asked twice: nothing is consumed.
    assert_eq!(draw(5), draw(5));
}

#[test]
fn seed_solver_tick_element_and_stream_each_change_the_numbers() {
    let base = Random::new(1, 1, 1, 1).block(1);
    for other in [
        Random::new(2, 1, 1, 1).block(1),
        Random::new(1u64 << 32 | 1, 1, 1, 1).block(1),
        Random::new(1, 2, 1, 1).block(1),
        Random::new(1, 1, 2, 1).block(1),
        Random::new(1, 1, 1u64 << 32 | 1, 1).block(1),
        Random::new(1, 1, 1, 2).block(1),
        Random::new(1, 1, 1, 1).block(2),
    ] {
        assert_ne!(base, other);
        // Not a near miss: about half the 128 bits differ.
        let flipped: u32 = base.iter().zip(&other).map(|(a, b)| (a ^ b).count_ones()).sum();
        assert!((40..=88).contains(&flipped), "{flipped} bits differ");
    }
}

#[test]
fn floats_are_exact_in_their_range_and_integers_stay_below_n() {
    let r = Random::new(9, 4, 12, 7);
    let (mut sum, mut count) = (0.0f64, 0u32);
    for tick in 0..2000u64 {
        let r = Random::new(9, 4, tick, 7);
        for x in r.unit_f32(0) {
            assert!((0.0..1.0).contains(&x));
            assert_eq!(x * 16_777_216.0, (x * 16_777_216.0).floor(), "a multiple of 2^-24");
            sum += x as f64;
            count += 1;
        }
        for x in r.unit_f64(1) {
            assert!((0.0..1.0).contains(&x));
        }
        for n in r.below(2, 6) {
            assert!(n < 6);
        }
    }
    let mean = sum / count as f64;
    assert!((mean - 0.5).abs() < 0.01, "mean {mean}");
    let _ = r;
}
