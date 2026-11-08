// Wasm checks of the 2D kernel (see Cargo.toml). Exports `checks()`, the number of checks, and `check(i)`, 0 when check
// i passes; `bits(i)` gives the hash a scene stepped to, for the failure report; `bench_*` time a pyramid in a page.
// Wasm only.
#![no_std]
extern crate alloc;

#[path = "../../tests/support/bits_scenes.rs"]
mod scenes;

fn scene(i: u32) -> u64 {
    match i {
        0 => scenes::run(scenes::pyramid(100)),
        1 => scenes::run(scenes::joint_grid()),
        _ => scenes::run(scenes::mixed()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn checks() -> u32 {
    scenes::PINNED.len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn bits(i: u32) -> u64 {
    scene(i)
}

#[unsafe(no_mangle)]
pub extern "C" fn check(i: u32) -> u32 {
    (scene(i) != scenes::PINNED[i as usize]) as u32
}

/// One world for the browser timing run (scripts/physics2d-kernel-browsers.mjs): `bench_pyramid(rows)` builds the
/// pinned-bits pyramid, `bench_step()` steps it once, and the page times each call. One thread, as every Wasm instance
/// without the threads proposal, so the cell is never entered twice at once.
struct Bench(core::cell::UnsafeCell<Option<margoengine_physics2d_kernel::world::World>>);
unsafe impl Sync for Bench {}
static BENCH: Bench = Bench(core::cell::UnsafeCell::new(None));

#[unsafe(no_mangle)]
pub extern "C" fn bench_pyramid(rows: u32) {
    unsafe { *BENCH.0.get() = Some(scenes::pyramid(rows as usize)) };
}

/// Steps the timing world; returns its awake bodies after the step (0 when there is no world).
#[unsafe(no_mangle)]
pub extern "C" fn bench_step() -> u32 {
    match unsafe { &mut *BENCH.0.get() } {
        Some(world) => {
            world.step(scenes::DT);
            world.counts.awake_bodies as u32
        }
        None => 0,
    }
}
