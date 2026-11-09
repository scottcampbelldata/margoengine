// Wasm checks of the 2D kernel (see Cargo.toml). Exports `checks()`, the number of checks, and `check(i)`, 0 when check
// i passes; `bits(i)` gives the hash a scene stepped to, for the failure report; `bench_*` time a pyramid in a page.
// Wasm only.
#![no_std]
extern crate alloc;

#[path = "../../tests/support/bits_scenes.rs"]
mod scenes;
mod support_bars;

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
    if i as usize >= scenes::PINNED.len() { return 3; }
    if !invalid_input_checks() { return 2; }
    if i == 0 && !support_bars::check() { return 4; }
    (scene(i) != scenes::PINNED[i as usize]) as u32
}

// Run in the existing Node and browser check:merge gates as well as native tests.
// A missing sentinel guard traps this module instead of silently passing a valid-scene hash.
fn invalid_input_checks() -> bool {
    use margoengine_physics2d_kernel::{
        error::PhysicsError,
        manifold::{collide, collide_four},
        math::{Rot, V2, Xf, v2},
        shape::Core,
        world::{BodyDef, ShapeDef, World},
    };
    let Ok(core) = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0) else { return false; };
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        if collide(&core, Xf::IDENTITY, &core, Xf::IDENTITY, bad) != Err(PhysicsError::NotFinite) { return false; }
        let valid = (&core, Xf::IDENTITY, &core, Xf::IDENTITY, None);
        if collide_four([valid; 4], bad) != Err(PhysicsError::NotFinite) { return false; }
        let invalid = Xf { p: v2(bad, 0.0), ..Xf::IDENTITY };
        for speculative in [0.02, bad] {
            if collide(&core, invalid, &core, Xf::IDENTITY, speculative) != Err(PhysicsError::NotFinite) { return false; }
            let args = (&core, invalid, &core, Xf::IDENTITY, None);
            if collide_four([args; 4], speculative) != Err(PhysicsError::NotFinite) { return false; }
        }
        let mut world = World::default();
        if world.create_body(&BodyDef { position: v2(bad, 0.0), ..BodyDef::default() }) != Err(PhysicsError::NotFinite) || !world.bodies.is_empty() { return false; }
    }
    for density in [f32::INFINITY, f32::from_bits(1), f32::MAX] {
        let mut world = World::default();
        let Ok(body) = world.create_body(&BodyDef { fixed_rotation: true, ..BodyDef::default() }) else { return false; };
        let expected = if density.is_finite() { PhysicsError::ArithmeticOverflow } else { PhysicsError::NotFinite };
        if world.create_shape(body, core, &ShapeDef { density, ..ShapeDef::default() }) != Err(expected) || !world.shapes.is_empty() { return false; }
    }
    let mut world = World::default();
    world.settings.gravity = V2::ZERO;
    for x in [0.0, 0.75] {
        let Ok(body) = world.create_body(&BodyDef { position: v2(x, 0.0), ..BodyDef::default() }) else { return false; };
        if world.create_shape(body, core, &ShapeDef { friction: f32::MAX, ..ShapeDef::default() }).is_err() { return false; }
    }
    if world.step(1.0 / 240.0).is_err() { return false; }
    for (c, s) in [(1.0e30, 1.0e30), (0.0, f32::from_bits(1)), (1.0e-30, -1.0e-30)] {
        let q = Rot::from_pair(c, s);
        if !q.c.is_finite() || !q.s.is_finite() || (q.c * q.c + q.s * q.s - 1.0).abs() >= 4.0e-7 { return false; }
    }
    let mut world = World::default();
    world.settings.gravity = V2::ZERO;
    world.settings.substeps = 1;
    let Ok(body) = world.create_body(&BodyDef { angular_velocity: 1.0e30, ..BodyDef::default() }) else { return false; };
    if world.step(1.0 / 60.0).is_err() { return false; }
    let q = world.bodies[body as usize].xf.q;
    if (q.c * q.c + q.s * q.s - 1.0).abs() >= 4.0e-7 { return false; }
    if world.step(1.0e30) != Err(PhysicsError::ArithmeticOverflow) { return false; }
    let mut world = World::default();
    let Ok(body) = world.create_body(&BodyDef::default()) else { return false; };
    world.bodies[body as usize].xf.q = Rot { c: 0.0, s: 0.0 };
    if world.step(1.0 / 60.0) != Err(PhysicsError::InvalidParameter) { return false; }
    let mut world = World::default();
    world.settings.gravity = V2::ZERO;
    world.settings.substeps = 1;
    for sign in [-1.0, 1.0] {
        let Ok(body) = world.create_body(&BodyDef { position: v2(sign * 0.505, 0.0), linear_velocity: v2(-sign, 0.0), fixed_rotation: true, ..BodyDef::default() }) else { return false; };
        if world.create_shape(body, core, &ShapeDef { density: 4.0e-39, ..ShapeDef::default() }).is_err() { return false; }
    }
    if world.step(1.0 / 60.0) != Err(PhysicsError::ArithmeticOverflow) { return false; }
    let mut world = World::default();
    world.settings.gravity = V2::ZERO;
    world.settings.substeps = 1;
    let Ok(ground) = world.create_body(&BodyDef { kind: margoengine_physics2d_kernel::world::Kind::Static, ..BodyDef::default() }) else { return false; };
    let Ok(floor) = Core::rect(1.0e10, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0) else { return false; };
    if world.create_shape(ground, floor, &ShapeDef { friction: 0.0, ..ShapeDef::default() }).is_err() { return false; }
    let Ok(body) = world.create_body(&BodyDef { position: v2(0.0, 1.0e9), linear_velocity: v2(0.0, -1.0), angular_velocity: 1.0e30, ..BodyDef::default() }) else { return false; };
    let Ok(circle) = Core::circle(V2::ZERO, 1.0e9) else { return false; };
    if world.create_shape(body, circle, &ShapeDef { density: 1.0e-40, friction: 0.0, restitution: 0.0 }).is_err() { return false; }
    if world.step(1.0 / 60.0) != Err(PhysicsError::ArithmeticOverflow) { return false; }
    true
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
            world.step(scenes::DT).unwrap();
            world.counts.awake_bodies as u32
        }
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn diagnostic_eq(a: u32, b: u32) -> u32 {
    use margoengine_physics_kernel_common::lanes::F4;
    F4::new([f32::from_bits(a), f32::from_bits(b), f32::from_bits(a), f32::from_bits(b)]).eq(F4::new([f32::from_bits(b), f32::from_bits(a), f32::from_bits(a), f32::from_bits(b)])).bits()
}
