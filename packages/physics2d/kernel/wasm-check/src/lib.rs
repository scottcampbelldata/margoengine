// Wasm checks of the 2D kernel (see Cargo.toml). Exports `checks()`, the number of checks, and `check(i)`, 0 when check
// i passes; `bits(i)` gives the hash a scene stepped to, for the failure report. Wasm only.
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
