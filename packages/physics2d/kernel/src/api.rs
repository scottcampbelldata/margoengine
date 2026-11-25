// The Wasm interface of the 2D kernel: plain C functions over handles and one shared word buffer, the shape
// `packages/physics2d/src/kernel.ts` calls. Numbers go in and out through the buffer (`io_reserve` gives its address; read
// it again after any call, as memory may have grown), handles and counts through the return value. A negative return is an
// error: -(code + 1), `PhysicsError` in declaration order. The module is single threaded, as every Wasm instance is.
use alloc::boxed::Box;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use crate::decompose::decompose;
use crate::error::PhysicsError;
use crate::joint::{JointDef, JointKind, Motor};
use crate::math::{Rot, V2, Xf, v2};
use crate::query::QueryFilter;
use crate::shape::Core;
use crate::world::{BodyDef, ContactMod, EventKind, Hook, Kind, Settings, ShapeDef, World};

/// The version the loader checks; bump it when an export or the buffer layout changes.
pub const API_VERSION: u32 = 1;

struct State {
    worlds: Vec<Option<Box<World>>>,
    io: Vec<u32>,
}

struct Global(UnsafeCell<Option<State>>);
// SAFETY: a Wasm instance runs one thread.
unsafe impl Sync for Global {}
static STATE: Global = Global(UnsafeCell::new(None));

#[allow(clippy::mut_from_ref)]
fn state() -> &'static mut State {
    // SAFETY: single threaded, and no reference outlives a call.
    unsafe { (*STATE.0.get()).get_or_insert_with(|| State { worlds: Vec::new(), io: alloc::vec![0; 256] }) }
}

fn fail(error: PhysicsError) -> i32 {
    let index = match error {
        PhysicsError::NotFinite => 0,
        PhysicsError::InvalidCore => 1,
        PhysicsError::Degenerate => 2,
        PhysicsError::ArithmeticOverflow => 3,
        PhysicsError::InvalidHandle => 4,
        PhysicsError::InvalidParameter => 5,
    };
    -(index + 1)
}

fn world(handle: i32) -> Result<&'static mut World, PhysicsError> {
    state().worlds.get_mut(handle as usize).and_then(|w| w.as_deref_mut()).ok_or(PhysicsError::InvalidHandle)
}

macro_rules! with_world {
    ($w:expr, |$world:ident| $body:expr) => {{
        match world($w) {
            Ok($world) => {
                let result: Result<i32, PhysicsError> = (|| $body)();
                match result {
                    Ok(value) => value,
                    Err(error) => fail(error),
                }
            }
            Err(error) => fail(error),
        }
    }};
}

fn io() -> &'static mut Vec<u32> {
    &mut state().io
}
fn f(index: usize) -> f32 {
    f32::from_bits(io()[index])
}
fn put(index: usize, value: f32) {
    io()[index] = value.to_bits();
}
fn ensure(words: usize) {
    if io().len() < words {
        io().resize(words, 0);
    }
}
fn point(index: usize) -> V2 {
    v2(f(index), f(index + 1))
}

#[unsafe(no_mangle)]
pub extern "C" fn api_version() -> u32 {
    API_VERSION
}

/// Makes the buffer at least `words` long and returns its address.
#[unsafe(no_mangle)]
pub extern "C" fn io_reserve(words: u32) -> u32 {
    ensure(words as usize);
    io().as_ptr() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn world_create(gx: f32, gy: f32) -> i32 {
    let world = Box::new(World::new(Settings { gravity: v2(gx, gy), ..Settings::default() }));
    let worlds = &mut state().worlds;
    if let Some(slot) = worlds.iter().position(|w| w.is_none()) {
        worlds[slot] = Some(world);
        return slot as i32;
    }
    worlds.push(Some(world));
    worlds.len() as i32 - 1
}

#[unsafe(no_mangle)]
pub extern "C" fn world_destroy(handle: i32) -> i32 {
    match state().worlds.get_mut(handle as usize) {
        Some(slot) if slot.is_some() => {
            *slot = None;
            0
        }
        _ => fail(PhysicsError::InvalidHandle),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn world_set_gravity(handle: i32, gx: f32, gy: f32) -> i32 {
    with_world!(handle, |w| {
        if !gx.is_finite() || !gy.is_finite() {
            return Err(PhysicsError::NotFinite);
        }
        w.settings.gravity = v2(gx, gy);
        // Sleeping bodies would float in the old field.
        for id in 0..w.bodies.len() as u32 {
            if w.bodies[id as usize].kind == Kind::Dynamic && !w.bodies[id as usize].awake {
                w.wake(id)?;
            }
        }
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn world_step(handle: i32, dt: f32) -> i32 {
    with_world!(handle, |w| w.step(dt).map(|()| 0))
}

/// Milliseconds a phase of the world's last step took, by its place in `world::PHASES`: 0 the whole step, then begin, broad phase, narrow
/// phase, islands, solver, continuous collision and events, and the finer splits of the solver and the sweep; NaN past the last.
/// All zero before the first step.
#[unsafe(no_mangle)]
pub extern "C" fn world_timing(handle: i32, phase: u32) -> f32 {
    match world(handle) {
        Ok(w) => w.timing.get(phase as usize).copied().unwrap_or(f32::NAN),
        Err(_) => f32::NAN,
    }
}

/// Writes the work the last step did to the buffer, as whole numbers and in this order: awake bodies, active islands, broad-phase
/// boxes compared, pairs kept, manifolds built, manifold points that started cold, contacts solved, two-point solves
/// taken as a block, two-point solves taken one point at a time, colours, contacts in no colour, joints solved as trees,
/// events, steps taken in all. Returns how many numbers it wrote.
#[unsafe(no_mangle)]
pub extern "C" fn world_counts(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let c = w.counts;
        let all = [
            c.awake_bodies, c.active_islands, c.compared, c.pairs, c.manifolds, c.cold_points, c.constraints, c.block, c.sequential,
            c.colours, c.overflow, c.tree_joints, w.events.len() as u64, w.steps,
        ];
        ensure(all.len());
        for (i, n) in all.into_iter().enumerate() {
            io()[i] = n.min(u32::MAX as u64) as u32;
        }
        Ok(all.len() as i32)
    })
}

fn kind_of(value: u32) -> Result<Kind, PhysicsError> {
    match value {
        0 => Ok(Kind::Dynamic),
        1 => Ok(Kind::Static),
        2 => Ok(Kind::Kinematic),
        _ => Err(PhysicsError::InvalidParameter),
    }
}

/// io: x, y, cos, sin, vx, vy, angular velocity, linear damping, angular damping, gravity scale, dominance (an i32).
/// `flags`: 1 can sleep, 2 fixed rotation, 4 ccd. Returns the body's handle.
#[unsafe(no_mangle)]
pub extern "C" fn body_create(handle: i32, kind: u32, flags: u32) -> i32 {
    with_world!(handle, |w| {
        let def = BodyDef {
            kind: kind_of(kind)?,
            position: point(0),
            rotation: Rot { c: f(2), s: f(3) },
            linear_velocity: point(4),
            angular_velocity: f(6),
            linear_damping: f(7),
            angular_damping: f(8),
            gravity_scale: f(9),
            can_sleep: flags & 1 != 0,
            fixed_rotation: flags & 2 != 0,
            ccd: flags & 4 != 0,
            dominance: (io()[10] as i32).clamp(-127, 127) as i8,
            soft_ccd: 0.0,
        };
        if def.linear_damping < 0.0 || def.angular_damping < 0.0 {
            return Err(PhysicsError::InvalidParameter);
        }
        w.create_body(&def).map(|id| id as i32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_remove(handle: i32, body: u32) -> i32 {
    with_world!(handle, |w| w.remove_body(body).map(|()| 0))
}

/// Writes x, y, cos, sin, vx, vy, angular velocity, mass, awake (u32), the world centre of mass and whether the body is enabled (u32) to the buffer.
#[unsafe(no_mangle)]
pub extern "C" fn body_read(handle: i32, body: u32) -> i32 {
    with_world!(handle, |w| {
        let b = w.bodies.get(body as usize).filter(|b| !b.dead).ok_or(PhysicsError::InvalidHandle)?;
        let (xf, v, av, mass, awake, center, enabled) = (b.xf, b.linear_velocity, b.angular_velocity, b.mass, b.awake, b.center, b.enabled);
        ensure(12);
        for (i, value) in [xf.p.x, xf.p.y, xf.q.c, xf.q.s, v.x, v.y, av, mass].into_iter().enumerate() {
            put(i, value);
        }
        io()[8] = awake as u32;
        put(9, center.x);
        put(10, center.y);
        io()[11] = enabled as u32;
        Ok(0)
    })
}

/// io[0..count] holds body handles; writes x, y, cos, sin for each after them, at `count + 4 i`.
#[unsafe(no_mangle)]
pub extern "C" fn body_read_poses(handle: i32, count: u32) -> i32 {
    with_world!(handle, |w| {
        let count = count as usize;
        ensure(count * 5);
        for i in 0..count {
            let id = io()[i] as usize;
            let b = w.bodies.get(id).filter(|b| !b.dead).ok_or(PhysicsError::InvalidHandle)?;
            let xf = b.xf;
            let at = count + 4 * i;
            put(at, xf.p.x);
            put(at + 1, xf.p.y);
            put(at + 2, xf.q.c);
            put(at + 3, xf.q.s);
        }
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_set_transform(handle: i32, body: u32, x: f32, y: f32, c: f32, s: f32) -> i32 {
    with_world!(handle, |w| w.set_transform(body, v2(x, y), Rot { c, s }).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_velocity(handle: i32, body: u32, vx: f32, vy: f32, av: f32) -> i32 {
    with_world!(handle, |w| w.set_velocity(body, v2(vx, vy), av).map(|()| 0))
}
/// A zero `has_point` applies the impulse at the centre of mass.
#[unsafe(no_mangle)]
pub extern "C" fn body_impulse(handle: i32, body: u32, jx: f32, jy: f32, has_point: u32, px: f32, py: f32) -> i32 {
    with_world!(handle, |w| w.apply_impulse(body, v2(jx, jy), (has_point != 0).then(|| v2(px, py))).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_torque_impulse(handle: i32, body: u32, torque: f32) -> i32 {
    with_world!(handle, |w| w.apply_torque_impulse(body, torque).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_add_force(handle: i32, body: u32, fx: f32, fy: f32, torque: f32) -> i32 {
    with_world!(handle, |w| w.add_force(body, v2(fx, fy), torque).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_add_force_at(handle: i32, body: u32, fx: f32, fy: f32, px: f32, py: f32) -> i32 {
    with_world!(handle, |w| w.add_force_at(body, v2(fx, fy), v2(px, py)).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_reset_torques(handle: i32, body: u32) -> i32 {
    with_world!(handle, |w| w.reset_torques(body).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_reset_forces(handle: i32, body: u32) -> i32 {
    with_world!(handle, |w| w.reset_forces(body).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_params(handle: i32, body: u32, linear_damping: f32, angular_damping: f32, gravity_scale: f32, flags: u32, dominance: i32) -> i32 {
    with_world!(handle, |w| w
        .set_body_params(body, linear_damping, angular_damping, gravity_scale, flags & 1 != 0, flags & 4 != 0, dominance.clamp(-127, 127) as i8)
        .map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_fixed_rotation(handle: i32, body: u32, fixed: u32) -> i32 {
    with_world!(handle, |w| w.set_fixed_rotation(body, fixed != 0).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_next(handle: i32, body: u32, x: f32, y: f32, c: f32, s: f32) -> i32 {
    with_world!(handle, |w| w.set_next_kinematic(body, v2(x, y), Rot { c, s }).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_wake(handle: i32, body: u32) -> i32 {
    with_world!(handle, |w| w.wake(body).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_sleep(handle: i32, body: u32) -> i32 {
    with_world!(handle, |w| w.sleep_body(body).map(|()| 0))
}

// Shape kinds in the buffer, after the 8 words of settings.
const CIRCLE: u32 = 0;
const CAPSULE: u32 = 1;
const SEGMENT: u32 = 2;
const RECT: u32 = 3;
const POLYGON: u32 = 4;
const CHAIN: u32 = 5;
const DECOMPOSED: u32 = 6;
const VOXELS: u32 = 7;

fn shape_def() -> ShapeDef {
    let flags = io()[5];
    ShapeDef {
        density: f(0),
        friction: f(1),
        restitution: f(2),
        groups: io()[3],
        solver_groups: io()[4],
        events: (flags & 3) as u8,
        active_types: ((flags >> 8) & 0xff) as u8,
        sensor: flags & (1 << 16) != 0,
        force_threshold: f(6),
        one_sided: flags & (1 << 17) != 0,
        hooks: ((flags >> 18) & 3) as u8,
    }
}

fn points(at: usize, count: usize) -> Result<Vec<V2>, PhysicsError> {
    if at + 2 * count > io().len() {
        return Err(PhysicsError::InvalidParameter);
    }
    Ok((0..count).map(|i| point(at + 2 * i)).collect())
}

/// One convex core from the buffer at `at`.
fn read_core(kind: u32, at: usize) -> Result<Core, PhysicsError> {
    Ok(match kind {
        CIRCLE => Core::circle(point(at), f(at + 2))?,
        CAPSULE => Core::capsule(point(at), point(at + 2), f(at + 4))?,
        SEGMENT => Core::segment(point(at), point(at + 2))?,
        RECT => Core::rect(f(at), f(at + 1), point(at + 2), f(at + 4), f(at + 5), f(at + 6))?,
        POLYGON => {
            let (radius, n) = (f(at), io()[at + 1] as usize);
            Core::polygon(&points(at + 2, n)?, radius)?
        }
        _ => return Err(PhysicsError::InvalidParameter),
    })
}

/// io: the 8 settings words (density, friction, restitution, groups, solver groups, flags: events in bits 0..1, active
/// types in 8..15, sensor in 16; force threshold; one spare), then the shape. Writes the new shape handles to io[0..]
/// and returns how many: a chain and a concave polygon make several.
#[unsafe(no_mangle)]
pub extern "C" fn shape_create(handle: i32, body: u32, kind: u32) -> i32 {
    with_world!(handle, |w| {
        let def = shape_def();
        let mut made: Vec<u32> = Vec::new();
        match kind {
            CHAIN => {
                let (closed, n) = (io()[8] != 0, io()[9] as usize);
                let pts = points(10, n)?;
                made = w.create_chain(body, &pts, closed, &def)?;
            }
            DECOMPOSED => {
                let (radius, n) = (f(8), io()[9] as usize);
                let pts = points(10, n)?;
                let pieces = decompose(&pts).map_err(|_| PhysicsError::Degenerate)?;
                let mut cores = Vec::with_capacity(pieces.len());
                for piece in &pieces {
                    cores.push(Core::polygon(piece, radius)?);
                }
                for core in cores {
                    match w.create_shape(body, core, &def) {
                        Ok(id) => made.push(id),
                        Err(error) => {
                            for id in made {
                                let _ = w.remove_shape(id);
                            }
                            return Err(error);
                        }
                    }
                }
            }
            VOXELS => {
                let (cols, rows) = (io()[8], io()[9]);
                let (cell, origin, n) = (point(10), point(12), io()[14] as usize);
                if 15 + n > io().len() {
                    return Err(PhysicsError::InvalidParameter);
                }
                let bits: Vec<u32> = io()[15..15 + n].to_vec();
                let grid = crate::voxel::Grid::new(cols, rows, cell, origin, &bits).ok_or(PhysicsError::InvalidParameter)?;
                made.push(w.create_voxels(body, grid, &def)?);
            }
            _ => {
                let core = read_core(kind, 8)?;
                made.push(w.create_shape(body, core, &def)?);
            }
        }
        ensure(made.len());
        for (i, id) in made.iter().enumerate() {
            io()[i] = *id;
        }
        Ok(made.len() as i32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn shape_remove(handle: i32, shape: u32) -> i32 {
    with_world!(handle, |w| w.remove_shape(shape).map(|()| 0))
}

/// io: the 8 settings words as `shape_create` reads them.
#[unsafe(no_mangle)]
pub extern "C" fn shape_set(handle: i32, shape: u32) -> i32 {
    with_world!(handle, |w| {
        let def = shape_def();
        w.set_shape_params(shape, &def).map(|()| 0)
    })
}

/// The body of a shape, and in the buffer its settings words and whether it is a chain segment.
#[unsafe(no_mangle)]
pub extern "C" fn shape_read(handle: i32, shape: u32) -> i32 {
    with_world!(handle, |w| {
        let s = w.shapes.get(shape as usize).filter(|s| !s.dead).ok_or(PhysicsError::InvalidHandle)?;
        let words = [s.density.to_bits(), s.friction.to_bits(), s.restitution.to_bits(), s.groups, s.solver_groups, (s.events as u32) | ((s.active_types as u32) << 8) | ((s.sensor as u32) << 16), s.force_threshold.to_bits(), s.chain as u32];
        let body = s.body;
        ensure(8);
        io()[..8].copy_from_slice(&words);
        Ok(body as i32)
    })
}

/// io: kind code (0 revolute, 1 prismatic, 2 fixed, 3 rope, 4 spring), then the anchors on A and on B (x, y each), a
/// has-limits word and the low and high limit, a has-motor word and the motor (target position, target speed, stiffness,
/// damping, most force), the prismatic axis, the fixed angles (cos, sin of A's and of B's), and the rope or rest length,
/// spring stiffness and damping; kind 5 is a generic joint whose locks are the bits of word 24 (1 x, 2 y, 4 angle).
#[unsafe(no_mangle)]
pub extern "C" fn joint_create(handle: i32, a: u32, b: u32, collide: u32) -> i32 {
    with_world!(handle, |w| {
        let limits = (io()[5] != 0).then(|| (f(6), f(7)));
        let motor = (io()[8] != 0).then(|| Motor { target_position: f(9), target_velocity: f(10), stiffness: f(11), damping: f(12), max_force: f(13), per_mass: if io()[25] != 0 { 1.0 } else { 0.0 } });
        let kind = match io()[0] {
            0 => JointKind::Revolute { limits, motor },
            1 => JointKind::Prismatic { axis: point(14), limits, motor },
            2 => JointKind::Fixed { angle_a: Rot::from_pair(f(16), f(17)), angle_b: Rot::from_pair(f(18), f(19)) },
            5 => {
                let mask = io()[24];
                JointKind::Generic { lock_x: mask & 1 != 0, lock_y: mask & 2 != 0, lock_angle: mask & 4 != 0, frame_a: Rot::from_pair(f(16), f(17)), frame_b: Rot::from_pair(f(18), f(19)) }
            }
            3 => JointKind::Rope { length: f(20) },
            4 => JointKind::Spring { rest_length: f(20), stiffness: f(21), damping: f(22) },
            _ => return Err(PhysicsError::InvalidParameter),
        };
        w.create_joint(&JointDef { kind, a, b, anchor_a: point(1), anchor_b: point(3), collide: collide != 0 }).map(|id| id as i32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn joint_remove(handle: i32, joint: u32) -> i32 {
    with_world!(handle, |w| w.remove_joint(joint).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn joint_set_limits(handle: i32, joint: u32, has: u32, lo: f32, hi: f32) -> i32 {
    with_world!(handle, |w| w.set_joint_limits(joint, (has != 0).then_some((lo, hi))).map(|()| 0))
}
/// io: target position, target speed, stiffness, damping, most force, then 1 for gains per unit of mass.
#[unsafe(no_mangle)]
pub extern "C" fn joint_set_motor(handle: i32, joint: u32, has: u32) -> i32 {
    with_world!(handle, |w| {
        let motor = (has != 0).then(|| Motor { target_position: f(0), target_velocity: f(1), stiffness: f(2), damping: f(3), max_force: f(4), per_mass: f(5) });
        w.set_joint_motor(joint, motor).map(|()| 0)
    })
}

/// Writes the last step's events, three words each (shape a, shape b, 1 for a start and 2 for a stop, plus 4 for a
/// sensor pair); returns how many.
#[unsafe(no_mangle)]
pub extern "C" fn events_read(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let n = w.events.len();
        ensure(3 * n);
        for (i, e) in w.events.iter().enumerate() {
            io()[3 * i] = e.a;
            io()[3 * i + 1] = e.b;
            io()[3 * i + 2] = (if e.kind == EventKind::Started { 1 } else { 2 }) | ((e.sensor as u32) << 2);
        }
        Ok(n as i32)
    })
}

/// Writes the last step's contact force events, five words each (shape a, shape b, force, normal x, normal y).
#[unsafe(no_mangle)]
pub extern "C" fn force_events_read(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let n = w.force_events.len();
        ensure(5 * n);
        for (i, e) in w.force_events.iter().enumerate() {
            io()[5 * i] = e.a;
            io()[5 * i + 1] = e.b;
            put(5 * i + 2, e.force);
            put(5 * i + 3, e.normal.x);
            put(5 * i + 4, e.normal.y);
        }
        Ok(n as i32)
    })
}

fn filter_at(at: usize) -> QueryFilter {
    QueryFilter { groups: io()[at], flags: io()[at + 1] as u8, exclude_shape: io()[at + 2], exclude_body: io()[at + 3] }
}

/// io: the filter (groups, flags, excluded shape, excluded body), the ray's origin and unit direction, its length and
/// whether it is solid. Writes each hit as four words (shape, distance, normal x, normal y), nearest first.
#[unsafe(no_mangle)]
pub extern "C" fn ray_cast(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let (filter, origin, dir, max, solid) = (filter_at(0), point(4), point(6), f(8), io()[9] != 0);
        let hits = w.ray_cast_all(origin, dir, max, solid, &filter)?;
        ensure(4 * hits.len());
        for (i, h) in hits.iter().enumerate() {
            io()[4 * i] = h.shape;
            put(4 * i + 1, h.t);
            put(4 * i + 2, h.normal.x);
            put(4 * i + 3, h.normal.y);
        }
        Ok(hits.len() as i32)
    })
}

/// io: the filter, the point. Writes the shape handles.
#[unsafe(no_mangle)]
pub extern "C" fn point_query(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let (filter, p) = (filter_at(0), point(4));
        let found = w.point_query(p, &filter)?;
        ensure(found.len());
        io()[..found.len()].copy_from_slice(&found);
        Ok(found.len() as i32)
    })
}

/// io: the filter, the query shape's position and rotation (x, y, cos, sin), then the shape as `shape_create` reads
/// one (kind in `kind`, geometry from word 8). Writes the shape handles it overlaps.
#[unsafe(no_mangle)]
pub extern "C" fn shape_overlap(handle: i32, kind: u32) -> i32 {
    with_world!(handle, |w| {
        let (filter, xf) = (filter_at(0), Xf { p: point(4), q: Rot { c: f(6), s: f(7) } });
        let core = read_core(kind, 8)?;
        let found = w.shape_overlap(&core, xf, &filter)?;
        ensure(found.len());
        io()[..found.len()].copy_from_slice(&found);
        Ok(found.len() as i32)
    })
}

/// io: as `shape_overlap` up to word 7, then the unit direction (words 8 and 9), the distance (10) and the shape from
/// word 11. Writes each hit as eight words (shape, distance, point on the cast shape x y, point on the hit shape
/// x y, normal x y), nearest first.
#[unsafe(no_mangle)]
pub extern "C" fn shape_cast(handle: i32, kind: u32) -> i32 {
    with_world!(handle, |w| {
        let (filter, xf) = (filter_at(0), Xf { p: point(4), q: Rot { c: f(6), s: f(7) } });
        let (dir, max) = (point(8), f(10));
        let core = read_core(kind, 11)?;
        let hits = w.shape_cast_all(&core, xf, dir, max, &filter)?;
        ensure(8 * hits.len());
        for (i, h) in hits.iter().enumerate() {
            io()[8 * i] = h.shape;
            for (k, value) in [h.t, h.point_a.x, h.point_a.y, h.point_b.x, h.point_b.y, h.normal.x, h.normal.y].into_iter().enumerate() {
                put(8 * i + 1 + k, value);
            }
        }
        Ok(hits.len() as i32)
    })
}

/// Takes a body out of the simulation (0) or puts it back (1).
#[unsafe(no_mangle)]
pub extern "C" fn body_set_enabled(handle: i32, body: u32, enabled: u32) -> i32 {
    with_world!(handle, |w| w.set_body_enabled(body, enabled != 0).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_additional_mass_properties(handle: i32, body: u32, mass: f32, x: f32, y: f32, inertia: f32) -> i32 {
    with_world!(handle, |w| w.set_additional_mass_properties(body, mass, v2(x, y), inertia).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn body_set_additional_mass(handle: i32, body: u32, mass: f32) -> i32 {
    with_world!(handle, |w| w.set_additional_mass(body, mass).map(|()| 0))
}

/// Writes the world's snapshot to the buffer as bytes and returns their count.
#[unsafe(no_mangle)]
pub extern "C" fn world_snapshot(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let bytes = w.snapshot();
        ensure(bytes.len().div_ceil(4));
        let words = io();
        for (i, chunk) in bytes.chunks(4).enumerate() {
            let mut word = [0u8; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            words[i] = u32::from_le_bytes(word);
        }
        Ok(bytes.len() as i32)
    })
}

/// Replaces the world with the snapshot of `len` bytes in the buffer; handles into it stay what they were.
#[unsafe(no_mangle)]
pub extern "C" fn world_restore(handle: i32, len: u32) -> i32 {
    if world(handle).is_err() {
        return fail(PhysicsError::InvalidHandle);
    }
    let len = len as usize;
    if len.div_ceil(4) > io().len() {
        return fail(PhysicsError::InvalidParameter);
    }
    let mut bytes = Vec::with_capacity(len);
    for word in io().iter().take(len.div_ceil(4)) {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    bytes.truncate(len);
    match World::from_snapshot(&bytes) {
        Ok(mut restored) => {
            // The hook is not part of a snapshot: the world keeps the one it had.
            if let Ok(old) = world(handle) {
                restored.hook = old.hook.take();
            }
            state().worlds[handle as usize] = Some(Box::new(restored));
            0
        }
        Err(error) => fail(error),
    }
}

/// Writes the lines to draw (five numbers each: x1, y1, x2, y2, colour; `what` is the `DEBUG_*` bits) and returns how many.
#[unsafe(no_mangle)]
pub extern "C" fn debug_lines(handle: i32, what: u32) -> i32 {
    with_world!(handle, |w| {
        let lines = w.debug_lines(what);
        ensure(lines.len());
        for (i, v) in lines.iter().enumerate() {
            put(i, *v);
        }
        Ok((lines.len() / 5) as i32)
    })
}

// The world's hook asks the page: `hook_filter` says whether a pair may meet, `hook_contact` changes a touching contact.
// The page answers a contact through the first words of the buffer (friction, restitution, a one-way direction), and the
// return value says which of them it set: 1 the contact does not push, 2 friction, 4 restitution, 8 a one-way direction.
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn hook_filter(a: u32, b: u32) -> u32;
    fn hook_contact(a: u32, b: u32, nx: f32, ny: f32, points: u32) -> u32;
}

struct PageHook;

impl Hook for PageHook {
    fn filter(&mut self, a: u32, b: u32) -> bool {
        // SAFETY: the import is the page's callback; it takes and returns plain numbers.
        unsafe { hook_filter(a, b) != 0 }
    }
    fn contact(&mut self, change: &mut ContactMod) {
        // SAFETY: as above; the page reads and writes the buffer's first words while this call runs.
        let answer = unsafe { hook_contact(change.a, change.b, change.normal.x, change.normal.y, change.points as u32) };
        change.solver_active = answer & 1 == 0;
        if answer & 2 != 0 {
            change.friction = Some(f(0));
        }
        if answer & 4 != 0 {
            change.restitution = Some(f(1));
        }
        if answer & 8 != 0 {
            change.one_way = Some(point(2));
        }
        if answer & 16 != 0 {
            change.tangent_speed = f(4);
        }
    }
}

/// Turns the page's hook on or off for a world: shapes with hook flags ask it about their pairs.
#[unsafe(no_mangle)]
pub extern "C" fn world_set_hooks(handle: i32, on: u32) -> i32 {
    with_world!(handle, |w| {
        w.hook = (on != 0).then(|| Box::new(PageHook) as Box<dyn Hook>);
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_set_kind(handle: i32, body: u32, kind: u32) -> i32 {
    with_world!(handle, |w| w.set_body_kind(body, kind_of(kind)?).map(|()| 0))
}

/// io: the filter (4 words), the point. Writes every accepted shape with its closest point, nearest first, five words each:
/// shape, point x, point y, distance, inside (u32); returns how many.
#[unsafe(no_mangle)]
pub extern "C" fn project_point(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let (filter, p) = (filter_at(0), point(4));
        let all = w.project_point_all(p, &filter)?;
        ensure(5 * all.len());
        for (i, hit) in all.iter().enumerate() {
            io()[5 * i] = hit.shape;
            put(5 * i + 1, hit.point.x);
            put(5 * i + 2, hit.point.y);
            put(5 * i + 3, hit.distance);
            io()[5 * i + 4] = hit.inside as u32;
        }
        Ok(all.len() as i32)
    })
}

/// io: the filter, the box (min x, min y, max x, max y). Writes the shape handles.
#[unsafe(no_mangle)]
pub extern "C" fn aabb_query(handle: i32) -> i32 {
    with_world!(handle, |w| {
        let (filter, lo, hi) = (filter_at(0), point(4), point(6));
        let found = w.aabb_query(lo, hi, &filter)?;
        ensure(found.len());
        io()[..found.len()].copy_from_slice(&found);
        Ok(found.len() as i32)
    })
}

/// Writes the contacts of a shape, eleven words each: the other shape, flags (1 pushes, 2 touching, the point count in
/// bits 2 and up), the normal from this shape to the other, then two points (x, y, separation) and the step's normal
/// impulse; returns how many.
#[unsafe(no_mangle)]
pub extern "C" fn contacts_of(handle: i32, shape: u32) -> i32 {
    with_world!(handle, |w| {
        if w.shapes.get(shape as usize).is_none_or(|s| s.dead) {
            return Err(PhysicsError::InvalidHandle);
        }
        let mut rows: Vec<[u32; 11]> = Vec::new();
        for c in w.contacts.iter().filter(|c| c.a == shape || c.b == shape) {
            let first = c.a == shape;
            let other = if first { c.b } else { c.a };
            let from = w.bodies[w.shapes[c.a as usize].body as usize].exact_center;
            let n = if first { c.manifold.normal } else { c.manifold.normal.neg() };
            let m = &c.manifold;
            let mut row = [0u32; 11];
            row[0] = other;
            row[1] = (c.solved as u32) | ((c.overlap as u32) << 1) | ((m.count as u32) << 2);
            row[2] = n.x.to_bits();
            row[3] = n.y.to_bits();
            for k in 0..m.count.min(2) {
                let p = &m.points[k];
                row[4 + 3 * k] = ((from[0] + p.point.x as f64) as f32).to_bits();
                row[5 + 3 * k] = ((from[1] + p.point.y as f64) as f32).to_bits();
                row[6 + 3 * k] = p.separation.to_bits();
            }
            row[10] = (c.normal_impulse[0] + c.normal_impulse[1]).to_bits();
            rows.push(row);
        }
        ensure(11 * rows.len());
        for (i, row) in rows.iter().enumerate() {
            io()[11 * i..11 * i + 11].copy_from_slice(row);
        }
        Ok(rows.len() as i32)
    })
}

/// How far ahead, in metres, a body's contacts reach beyond the world's own margin (0 for none).
#[unsafe(no_mangle)]
pub extern "C" fn body_set_soft_ccd(handle: i32, body: u32, distance: f32) -> i32 {
    with_world!(handle, |w| w.set_soft_ccd(body, distance).map(|()| 0))
}
