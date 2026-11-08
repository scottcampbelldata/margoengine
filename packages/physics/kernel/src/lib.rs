// Margo Engine physics kernel: the step of the own solver, written from papers (docs/clean-room.md).
// No dependencies. Native builds exist for `cargo test`; the shipped build is wasm32 with simd128.
// Determinism rule: only + - * / sqrt, compares and integer operations reach the state. No trigonometry, no fused
// multiply-add, no relaxed SIMD, no hash of an address, no order that depends on a table's size.
#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod api;
pub mod broad;
pub mod bvh;
pub mod cast;
pub mod ccd;
pub mod compound;
pub mod contact;
pub mod events;
pub mod gjk;
pub mod hull;
pub mod integrate;
pub mod island;
pub mod joints;
pub mod layout;
pub mod mass;
pub mod math;
pub mod memory;
pub mod mesh;
pub mod narrow;
pub mod query;
pub mod revolve;
pub mod sat;
pub mod smooth;
pub mod solver;
pub mod voxel;
pub mod world;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
