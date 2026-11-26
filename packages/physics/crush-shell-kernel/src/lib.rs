#![cfg_attr(target_arch = "wasm32", no_std)]

mod bending;
mod cohesive;
mod contact;
mod material;
mod math;
mod membrane;
mod solver;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
