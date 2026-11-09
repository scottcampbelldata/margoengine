// Pinned bits: suite scenes stepped 120 times, every body's exact centre, rotation and velocities and every step's work
// counts folded into one FNV-1a hash. A change that must not move a bit (a new memory layout, a faster loop) keeps these
// hashes; a change that moves results re-pins them in its own commit and re-measures every bar. Re-pinned 2026-11-08 when
// the contacts went to colour order (perf history entry 86); the compact solver bodies before it kept every bit (85), and
// the four-lane solve after it keeps them, run both ways (87). The scenes and hashes live in support/bits_scenes.rs, which
// wasm-check/ steps inside the shipped Wasm build (simd128) against the same hashes (`npm run check:rust-kernels`).
extern crate alloc;

#[path = "support/bits_scenes.rs"]
mod scenes;
use scenes::{DT, PINNED, joint_grid, mixed, pyramid, run};

#[test]
fn suite_scenes_step_to_their_pinned_bits() {
    // The four-lane solve and the same solve one contact at a time give the same bits.
    for lanes in [true, false] {
        let got = [pyramid(100), joint_grid(), mixed()].map(|mut world| {
            world.settings.contact_lanes = lanes;
            run(world)
        });
        println!("pinned bits, lanes {lanes}: {:#018x} {:#018x} {:#018x}", got[0], got[1], got[2]);
        assert_eq!(got, PINNED, "the 100-row pyramid, the joint grid, the mixed scene, lanes {lanes}");
    }
}

#[test]
#[ignore]
fn step_time_of_the_100_row_pyramid() {
    // One side of a paired A/B against another commit: 60 steps to settle, then the fastest of the next 40 steps. Run
    // this commit's and the other's test binaries in turns, many rounds, and compare per-round minimums (AGENTS.md).
    let mut world = pyramid(100);
    for _ in 0..60 {
        world.step(DT).unwrap();
    }
    let mut best = f64::INFINITY;
    for _ in 0..40 {
        let start = std::time::Instant::now();
        world.step(DT).unwrap();
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
    }
    println!("STEP {best:.3}");
}
