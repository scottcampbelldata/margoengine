// The Wasm exports: one world per instance, plain numbers across the boundary, columns read through JS views.
#![cfg(target_arch = "wasm32")]
use crate::layout::*;
use crate::math::{Q, v3};
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
/// Makes room for a snapshot of `bytes`; 0 when memory cannot hold it. JS then writes the block with one copy.
#[unsafe(no_mangle)]
pub extern "C" fn world_ensure(bytes: u32) -> u32 {
    world().arena.ensure(bytes as usize) as u32
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
pub extern "C" fn world_set_iterations(iterations: u32) {
    world().header_mut().iterations = iterations;
}
#[unsafe(no_mangle)]
pub extern "C" fn world_iterations() -> u32 {
    world().header().iterations
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
pub extern "C" fn world_step(dt: f32) -> u32 {
    world().step(dt);
    world().header().failed
}
/// Counts layout changes: when it moves, JS binds its views again.
#[unsafe(no_mangle)]
pub extern "C" fn world_layout() -> u32 {
    world().header().layout
}
#[unsafe(no_mangle)]
pub extern "C" fn world_pairs() -> u32 {
    world().header().pairs
}
/// Pair rows handed out so far: pair columns hold rows below this, freed ones with NONE in PAIR_A.
#[unsafe(no_mangle)]
pub extern "C" fn world_pair_rows() -> u32 {
    world().header().pair_rows
}
#[unsafe(no_mangle)]
pub extern "C" fn body_touch(body: u32) {
    world().touch_body(body);
}
/// Bodies a step walks: the moving ones, as sleepers and fixed bodies are on no list.
#[unsafe(no_mangle)]
pub extern "C" fn world_awake() -> u32 {
    world().header().awake
}
#[unsafe(no_mangle)]
pub extern "C" fn world_islands() -> u32 {
    world().header().islands
}
#[unsafe(no_mangle)]
pub extern "C" fn world_set_sleep(energy: f32, time: f32) {
    let header = world().header_mut();
    header.sleep_energy = energy;
    header.sleep_time = time;
}
#[unsafe(no_mangle)]
pub extern "C" fn world_sleep_energy() -> f32 {
    world().header().sleep_energy
}
#[unsafe(no_mangle)]
pub extern "C" fn world_sleep_time() -> f32 {
    world().header().sleep_time
}
#[unsafe(no_mangle)]
pub extern "C" fn body_wake(body: u32) {
    if world().body_alive(body) {
        world().wake(body);
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn body_sleep(body: u32) {
    if world().body_alive(body) {
        world().request_sleep(body);
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_pose(body: u32, x: f32, y: f32, z: f32, qx: f32, qy: f32, qz: f32, qw: f32, wake: u32) {
    world().set_pose(body, v3(x, y, z), Q { x: qx, y: qy, z: qz, w: qw }, wake != 0);
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_target(body: u32, x: f32, y: f32, z: f32, qx: f32, qy: f32, qz: f32, qw: f32) {
    world().set_target(body, v3(x, y, z), Q { x: qx, y: qy, z: qz, w: qw });
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
/// Makes room for a hull of this size, whose rows JS then writes through its views; 0 when memory cannot.
#[unsafe(no_mangle)]
pub extern "C" fn hull_begin(vertices: u32, faces: u32, edges: u32) -> u32 {
    world().begin_hull(vertices, faces, edges) as u32
}
/// Finishes the hull written after `hull_begin`: its row, or a negative HULL_ code.
#[unsafe(no_mangle)]
pub extern "C" fn hull_end(vertices: u32, faces: u32, edges: u32) -> i32 {
    world().end_hull(vertices, faces, edges)
}
/// Where the next hull's rows start: 0 vertices, 1 half-edges, 2 faces.
#[unsafe(no_mangle)]
pub extern "C" fn hull_next(class: u32) -> u32 {
    world().header().hull_rows[class as usize + 1]
}
#[unsafe(no_mangle)]
pub extern "C" fn collider_remove(collider: u32) -> u32 {
    world().remove_collider(collider) as u32
}
