// Margo Engine 2D physics kernel: the step of the own 2D solver, written from papers (docs/clean-room.md, batch 127).
// One dependency, the shared kernel parts (packages/physics/kernel-common). Native builds exist for `cargo test`; the
// shipped build is wasm32 with simd128.
// Determinism rule, as in the 3D kernel: only + - * / sqrt, compares and integer operations reach the state.
#![cfg_attr(target_arch = "wasm32", no_std)]
extern crate alloc;

pub mod manifold;
pub mod mass;
pub mod math;
pub mod shape;
pub mod smooth;
pub mod solver;
pub mod world;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
