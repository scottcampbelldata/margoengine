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
pub extern "C" fn world_new(bodies: u32, colliders: u32) -> u32 {
    match World::new(bodies, colliders) {
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
pub extern "C" fn world_reserve(bodies: u32, colliders: u32) -> u32 {
    world().reserve(bodies, colliders) as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn world_hash() -> u32 {
    world().hash()
}
#[unsafe(no_mangle)]
pub extern "C" fn world_set_gravity(x: f32, y: f32, z: f32) {
    world().header_mut().gravity = [x, y, z];
}
#[unsafe(no_mangle)]
pub extern "C" fn world_set_substeps(substeps: u32) {
    world().header_mut().substeps = substeps;
}
#[unsafe(no_mangle)]
pub extern "C" fn world_steps() -> u32 {
    world().header().steps
}
#[unsafe(no_mangle)]
pub extern "C" fn world_substeps() -> u32 {
    world().header().substeps
}
#[unsafe(no_mangle)]
pub extern "C" fn world_gravity(axis: u32) -> f32 {
    world().header().gravity[axis as usize]
}
/// A new row of the given kind, or -1 when the rows are used up.
#[unsafe(no_mangle)]
pub extern "C" fn body_add(kind: u32) -> i32 {
    world().add_body(kind).map_or(-1, |row| row as i32)
}
#[unsafe(no_mangle)]
pub extern "C" fn world_step(dt: f32) {
    world().step(dt);
}
#[unsafe(no_mangle)]
pub extern "C" fn body_remove(body: u32) -> u32 {
    world().remove_body(body) as u32
}
/// Recomputes a body's mass after its additional mass changed.
#[unsafe(no_mangle)]
pub extern "C" fn body_update_mass(body: u32) {
    if world().body_alive(body) {
        world().update_mass(body);
    }
}
/// A new collider on `body`, or -1 when the rows are used up or the body is gone.
#[unsafe(no_mangle)]
pub extern "C" fn collider_add(
    body: u32, shape: u32, a: f32, b: f32, c: f32, x: f32, y: f32, z: f32, qx: f32, qy: f32, qz: f32, qw: f32, density: f32,
) -> i32 {
    world().add_collider(body, shape, [a, b, c], [x, y, z], [qx, qy, qz, qw], density).map_or(-1, |row| row as i32)
}
#[unsafe(no_mangle)]
pub extern "C" fn collider_remove(collider: u32) -> u32 {
    world().remove_collider(collider) as u32
}
