// Margo Engine 2D physics kernel: the step of the own 2D solver, written from papers (docs/clean-room.md, batch 127).
// No dependencies. Native builds exist for `cargo test`; the shipped build is wasm32 with simd128.
// Determinism rule, as in the 3D kernel: only + - * / sqrt, compares and integer operations reach the state.
#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod manifold;
pub mod mass;
pub mod math;
pub mod shape;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
