// The Wasm exports: one world per instance, plain numbers across the boundary, columns read through JS views.
#![cfg(target_arch = "wasm32")]
use crate::layout::*;
use crate::world::World;

static mut WORLD: Option<World> = None;

#[inline(always)]
fn world() -> &'static mut World {
    // SAFETY: an instance runs on one thread, and KernelWorld calls world_new before anything else.
    unsafe { (*core::ptr::addr_of_mut!(WORLD)).as_mut().unwrap_unchecked() }
}

/// Creates this instance's one world; 0 when it cannot.
#[unsafe(no_mangle)]
pub extern "C" fn world_new(bodies: u32) -> u32 {
    match World::new(bodies) {
        Some(created) => {
            unsafe { *core::ptr::addr_of_mut!(WORLD) = Some(created) };
            1
        }
        None => 0,
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn world_base() -> u32 {
    world().arena.base as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn world_bytes() -> u32 {
    world().header().bytes
}
#[unsafe(no_mangle)]
pub extern "C" fn world_capacity(class: u32) -> u32 {
    world().header().capacity[class as usize]
}
#[unsafe(no_mangle)]
pub extern "C" fn world_offset(column: u32) -> u32 {
    world().header().offsets[column as usize]
}
#[unsafe(no_mangle)]
pub extern "C" fn world_columns() -> u32 {
    COLUMNS as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn world_reserve(bodies: u32) -> u32 {
    world().reserve(bodies) as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn world_hash() -> u32 {
    world().hash()
}
