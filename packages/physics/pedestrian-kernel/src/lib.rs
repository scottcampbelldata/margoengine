#![no_std]
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_sqrt};
use core::f64::consts::PI;
use core::panic::PanicInfo;
use core::slice;
use margoengine_physics_kernel_common::pinned::{cos, exp, sin};

type V = [f64; 2];

// Kernel-common contains heap-using modules. This kernel uses only its pinned
// math and the caller's scratch space; there is no heap in the linked build.
struct NoHeap;
#[global_allocator]
static ALLOCATOR: NoHeap = NoHeap;
unsafe impl GlobalAlloc for NoHeap {
    unsafe fn alloc(&self, _: Layout) -> *mut u8 {
        core::ptr::null_mut()
    }
    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

fn dot(a: V, b: V) -> f64 {
    let result = f64x2_mul(f64x2(a[0], a[1]), f64x2(b[0], b[1]));
    f64x2_extract_lane::<0>(result) + f64x2_extract_lane::<1>(result)
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2(value, value)))
}

fn floor(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2(value, value)))
}

fn norm(a: V) -> f64 {
    sqrt(dot(a, a))
}

fn scale(a: V, s: f64) -> V {
    [a[0] * s, a[1] * s]
}

fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1]]
}

fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1]]
}

fn side(a: V) -> V {
    [-a[1], a[0]]
}

fn direction(a: V, fallback: V) -> V {
    let length = norm(a);
    if length > 0.0 {
        scale(a, 1.0 / length)
    } else {
        fallback
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Walker {
    position: V,
    velocity: V,
    heading: V,
    distance: f64,
    normal_load: f64,
    contact_force: V,
    density: f64,
    avoidance_force: V,
}

#[repr(C)]
struct Profile {
    inverse_mass: f64,
    shoulder: f64,
    depth: f64,
    response: f64,
    drive_limit: f64,
    turn_rate: f64,
}

#[repr(C)]
struct Command {
    preferred: V,
    applied: V,
}

#[repr(C)]
struct Edge {
    a: V,
    b: V,
}

#[repr(C)]
struct Settings {
    stiffness: f64,
    damping: f64,
    friction: f64,
    anticipation: f64,
    decay: f64,
    horizon: f64,
    reaction: f64,
    sample_radius: f64,
    maximum_density: f64,
    density_response: f64,
    clearance: f64,
    maximum_radius: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Grid {
    x: i32,
    z: i32,
    row: u32,
}

#[repr(C)]
struct StepJob {
    before: *const Walker,
    profiles: *const Profile,
    commands: *const Command,
    walls: *const Edge,
    wall_count: usize,
    gates: *const Edge,
    gate_count: usize,
    settings: *const Settings,
    after: *mut Walker,
    grid: *mut Grid,
    count: usize,
    work: *mut Work,
    dt: f64,
}

#[repr(C)]
struct Work {
    driven: f64,
    wall_checks: f64,
    wall_contacts: f64,
    integrated: f64,
    paired_dots: f64,
}

impl Grid {
    fn key(self) -> (i32, i32, u32) {
        (self.x, self.z, self.row)
    }
}

fn radius(profile: &Profile, heading: V, normal: V) -> f64 {
    let longitudinal = dot(heading, normal) * profile.depth;
    let lateral = dot(side(heading), normal) * profile.shoulder;
    return sqrt(longitudinal * longitudinal + lateral * lateral);
}

fn nearest(edge: &Edge, p: V) -> (V, f64) {
    let along = sub(edge.b, edge.a);
    let local = sub(p, edge.a);
    let fraction = (dot(local, along) / dot(along, along)).clamp(0.0, 1.0);
    (sub(local, scale(along, fraction)), fraction)
}

fn heading(
    walker: &Walker,
    profile: &Profile,
    desired: V,
    gates: &[Edge],
    settings: &Settings,
    dt: f64,
) -> V {
    let old = walker.heading;
    let speed = norm(desired);
    if speed == 0.0 {
        return old;
    }
    let mut target = scale(desired, 1.0 / speed);
    let mut gate_distance = f64::INFINITY;
    for gate in gates {
        let (offset, along) = nearest(gate, walker.position);
        if !(along > 0.0 && along < 1.0) {
            continue;
        }
        let distance = norm(offset);
        if distance >= gate_distance || distance > speed * profile.response + profile.shoulder {
            continue;
        }
        let line = sub(gate.b, gate.a);
        let width = norm(line);
        let across = scale(line, 1.0 / width);
        let forward = side(across);
        let available = (width * along.min(1.0 - along) - settings.clearance).max(0.0);
        if available >= profile.shoulder
            || profile.shoulder <= profile.depth
            || dot(target, forward) == 0.0
        {
            continue;
        }
        let space2 = (available * available - profile.depth * profile.depth)
            / (profile.shoulder * profile.shoulder - profile.depth * profile.depth);
        let long = sqrt(space2.clamp(0.0, 1.0));
        let wide = sqrt((1.0 - space2).clamp(0.0, 1.0));
        let sideways = if dot(old, across) < 0.0 { -1.0 } else { 1.0 };
        let forwards = if dot(target, forward) < 0.0 {
            -1.0
        } else {
            1.0
        };
        target = add(
            scale(across, sideways * wide),
            scale(forward, forwards * long),
        );
        gate_distance = distance;
    }
    let angle = profile.turn_rate * dt;
    if angle >= PI || dot(old, target) >= cos(angle) {
        return target;
    }
    let cross = old[0] * target[1] - old[1] * target[0];
    let turn = if cross < 0.0 { -angle } else { angle };
    direction(
        add(scale(old, cos(turn)), scale(side(old), sin(turn))),
        target,
    )
}

fn mass_pair(a: &Profile, b: &Profile) -> f64 {
    a.inverse_mass + b.inverse_mass
}

// Karamouzas et al., eqs. 2-3. Use the cancellation-free first positive root and
// differentiate the collision time with respect to separation.
fn anticipate(r: V, v: V, reach: f64, settings: &Settings) -> V {
    let c = dot(r, r) - reach * reach;
    let b = dot(r, v);
    let a = dot(v, v);
    let discriminant = b * b - a * c;
    if !(c > 0.0 && b < 0.0 && discriminant > 0.0) || settings.anticipation == 0.0 {
        return [0.0; 2];
    }
    let root = sqrt(discriminant);
    let time = c / (root - b);
    if time > settings.horizon {
        return [0.0; 2];
    }
    let corrected = time + settings.reaction;
    let inverse = 1.0 / corrected;
    let gradient = settings.anticipation
        * exp(-corrected / settings.decay)
        * inverse
        * inverse
        * (2.0 * inverse + 1.0 / settings.decay)
        / root;
    scale(add(r, scale(v, time)), gradient)
}

fn density_kernel(distance_sq: f64, radius_sq: f64) -> f64 {
    let f = (1.0 - distance_sq / radius_sq).max(0.0);
    4.0 * f * f * f / (PI * radius_sq)
}

// One backward-Euler contact solve. The normal spring and an approach damper are unilateral.
// The pair's tangential damping acts on the compression at the end of their normal update.
fn contact(
    speed: V,
    normal: V,
    overlap: f64,
    inverse_mass: f64,
    cfg: &Settings,
    dt: f64,
) -> (V, f64, bool) {
    let vn = dot(speed, normal);
    let free_overlap = overlap - dt * vn;
    if free_overlap <= 0.0 {
        return ([0.0; 2], 0.0, false);
    }
    let damping = if vn < 0.0 { cfg.damping } else { 0.0 };
    let normal_impulse = (dt * (cfg.stiffness * free_overlap - damping * vn)
        / (1.0 + inverse_mass * dt * (dt * cfg.stiffness + damping)))
        .max(0.0);
    let compression = (free_overlap - dt * normal_impulse * inverse_mass).max(0.0);
    let friction = dt * cfg.friction * compression;
    let tangent = side(normal);
    let slide = -friction * dot(speed, tangent) / (1.0 + friction * inverse_mass);
    (
        add(scale(normal, normal_impulse), scale(tangent, slide)),
        normal_impulse,
        true,
    )
}

fn impulse(walker: &mut Walker, value: V, load: f64, inverse_mass: f64, dt: f64) {
    walker.velocity = add(walker.velocity, scale(value, inverse_mass));
    walker.contact_force = add(walker.contact_force, scale(value, 1.0 / dt));
    walker.normal_load += load / dt;
}

fn pairs(grid: &[Grid], mut visit: impl FnMut(usize, usize)) {
    for item in grid {
        for dz in [-1, 0, 1] {
            for dx in [-1, 0, 1] {
                let x = item.x + dx;
                let z = item.z + dz;
                let from = grid.partition_point(|point| point.key() < (x, z, 0));
                for point in &grid[from..] {
                    if point.x != x || point.z != z {
                        break;
                    }
                    if point.row > item.row {
                        visit(item.row as usize, point.row as usize);
                    }
                }
            }
        }
    }
}

fn prepare(
    before: &[Walker],
    profiles: &[Profile],
    commands: &[Command],
    gates: &[Edge],
    cfg: &Settings,
    after: &mut [Walker],
    grid: &mut [Grid],
    dt: f64,
) -> bool {
    let mut max_speed: f64 = 0.0;
    let radius_sq = cfg.sample_radius * cfg.sample_radius;
    for (row, old) in before.iter().enumerate() {
        let profile = &profiles[row];
        let cmd = &commands[row];
        let next = &mut after[row];
        *next = *old;
        next.normal_load = 0.0;
        next.contact_force = [0.0; 2];
        next.avoidance_force = [0.0; 2];
        next.density = density_kernel(0.0, radius_sq);
        next.heading = heading(old, profile, cmd.preferred, gates, cfg, dt);
        let free_speed = norm(old.velocity).max(norm(cmd.preferred));
        let extra_speed = dt * (profile.drive_limit + profile.inverse_mass * norm(cmd.applied));
        max_speed = max_speed.max(free_speed + extra_speed);
    }
    // This cell size includes every possible contact, predicted pair within the
    // observation horizon, and every contributor to the compact density kernel.
    let cell_size = cfg
        .sample_radius
        .max(2.0 * (cfg.maximum_radius + max_speed * cfg.horizon.max(dt)));
    for (row, (position, record)) in before
        .iter()
        .map(|body| body.position)
        .zip(grid.iter_mut())
        .enumerate()
    {
        let x = floor(position[0] / cell_size);
        let z = floor(position[1] / cell_size);
        if x.abs() >= i32::MAX as f64 - 1.0 || z.abs() >= i32::MAX as f64 - 1.0 {
            return false;
        }
        *record = Grid {
            x: x as i32,
            z: z as i32,
            row: row as u32,
        };
    }
    grid.sort_unstable_by_key(|item| item.key());
    pairs(grid, |i, j| {
        let a = &before[i];
        let b = &before[j];
        let relative = sub(a.position, b.position);
        let velocity = sub(a.velocity, b.velocity);
        let d2 = dot(relative, relative);
        let weight = density_kernel(d2, radius_sq);
        after[i].density += weight;
        after[j].density += weight;
        let normal = direction(relative, [-1.0, 0.0]);
        let reach = radius(&profiles[i], after[i].heading, normal)
            + radius(&profiles[j], after[j].heading, normal);
        let anticipatory = anticipate(relative, velocity, reach, cfg);
        after[i].avoidance_force = add(after[i].avoidance_force, anticipatory);
        after[j].avoidance_force = sub(after[j].avoidance_force, anticipatory);
    });
    true
}

fn drive(
    before: &[Walker],
    profiles: &[Profile],
    commands: &[Command],
    cfg: &Settings,
    after: &mut [Walker],
    dt: f64,
) {
    for (row, next) in after.iter_mut().enumerate() {
        let old = &before[row];
        let profile = &profiles[row];
        let desired = commands[row].preferred;
        let crowding = if cfg.maximum_density > 0.0 {
            // The one-sided compressibility penalizes only density above the declared packing value.
            let pressure = ((next.density - cfg.maximum_density) / cfg.maximum_density).max(0.0);
            1.0 / (1.0 + cfg.density_response * pressure)
        } else {
            1.0
        };
        let desired = scale(desired, crowding);
        let steering = add(
            scale(sub(desired, old.velocity), 1.0 / profile.response),
            scale(next.avoidance_force, profile.inverse_mass),
        );
        let magnitude = norm(steering);
        let acceleration = if magnitude > profile.drive_limit {
            scale(steering, profile.drive_limit / magnitude)
        } else {
            steering
        };
        let relaxation = dt / (1.0 + dt / profile.response);
        next.velocity = add(
            old.velocity,
            add(
                scale(acceleration, relaxation),
                scale(commands[row].applied, dt * profile.inverse_mass),
            ),
        );
    }
}

fn pair_contacts(
    before: &[Walker],
    profiles: &[Profile],
    cfg: &Settings,
    after: &mut [Walker],
    grid: &[Grid],
    dt: f64,
) {
    pairs(grid, |i, j| {
        let a = &before[i];
        let b = &before[j];
        let relative = sub(a.position, b.position);
        let normal = direction(relative, [-1.0, 0.0]);
        let radius_i = radius(&profiles[i], after[i].heading, normal);
        let radius_j = radius(&profiles[j], after[j].heading, normal);
        let overlap = radius_i + radius_j - norm(relative);
        let rel_v = sub(after[i].velocity, after[j].velocity);
        let (pair_impulse, load, _) = contact(
            rel_v,
            normal,
            overlap,
            mass_pair(&profiles[i], &profiles[j]),
            cfg,
            dt,
        );
        impulse(
            &mut after[i],
            pair_impulse,
            load,
            profiles[i].inverse_mass,
            dt,
        );
        impulse(
            &mut after[j],
            scale(pair_impulse, -1.0),
            load,
            profiles[j].inverse_mass,
            dt,
        );
    });
}

fn finish(
    profiles: &[Profile],
    walls: &[Edge],
    cfg: &Settings,
    after: &mut [Walker],
    dt: f64,
    work: &mut Work,
) -> bool {
    work.wall_checks = after.len() as f64 * walls.len() as f64;
    work.wall_contacts = 0.0;
    work.integrated = after.len() as f64;
    let mut tangential_dots = 0.0;
    for (row, next) in after.iter_mut().enumerate() {
        for wall in walls {
            let (delta, _) = nearest(wall, next.position);
            let along = sub(wall.b, wall.a);
            let normal = direction(delta, direction(side(along), [0.0, 1.0]));
            let overlap = radius(&profiles[row], next.heading, normal) - norm(delta);
            let (value, load, tangent) = contact(
                next.velocity,
                normal,
                overlap,
                profiles[row].inverse_mass,
                cfg,
                dt,
            );
            work.wall_contacts += u32::from(load > 0.0) as f64;
            tangential_dots += u32::from(tangent) as f64;
            impulse(next, value, load, profiles[row].inverse_mass, dt);
        }
        let travel = scale(next.velocity, dt);
        next.position = add(next.position, travel);
        next.distance += norm(travel);
        let values = unsafe { slice::from_raw_parts((next as *const Walker).cast::<f64>(), 13) };
        if values.iter().any(|value| !value.is_finite()) {
            return false;
        }
    }
    // The drive steering norm and travel norm each use one two-component dot.
    // Each wall always evaluates two nearest, two normal, two radius, one
    // separation and one normal-contact dot, plus the tangent when applicable.
    work.paired_dots = work.driven + work.integrated + 8.0 * work.wall_checks + tangential_dots;
    true
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pedestrian_prepare(job: *const StepJob) -> u32 {
    let job = unsafe { &*job };
    unsafe {
        u32::from(!prepare(
            slice::from_raw_parts(job.before, job.count),
            slice::from_raw_parts(job.profiles, job.count),
            slice::from_raw_parts(job.commands, job.count),
            slice::from_raw_parts(job.gates, job.gate_count),
            &*job.settings,
            slice::from_raw_parts_mut(job.after, job.count),
            slice::from_raw_parts_mut(job.grid, job.count),
            job.dt,
        ))
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pedestrian_pairs(job: *const StepJob) {
    let job = unsafe { &*job };
    unsafe {
        pair_contacts(
            slice::from_raw_parts(job.before, job.count),
            slice::from_raw_parts(job.profiles, job.count),
            &*job.settings,
            slice::from_raw_parts_mut(job.after, job.count),
            slice::from_raw_parts(job.grid, job.count),
            job.dt,
        );
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pedestrian_thread_phase(
    job: *const StepJob,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if stage >= 2 || !matches!(parts, 1 | 2 | 4) || part >= parts {
        return 1;
    }
    let job = unsafe { &*job };
    let from = part * job.count / parts;
    let count = (part + 1) * job.count / parts - from;
    // Each participant borrows only its disjoint destination and receipt. Both
    // joins are complete before the caller sees or modifies the full row range.
    let after = unsafe { slice::from_raw_parts_mut(job.after.add(from), count) };
    let profiles = unsafe { slice::from_raw_parts(job.profiles.add(from), count) };
    let settings = unsafe { &*job.settings };
    let work = unsafe { &mut *job.work.add(part) };
    if stage == 0 {
        drive(
            unsafe { slice::from_raw_parts(job.before.add(from), count) },
            profiles,
            unsafe { slice::from_raw_parts(job.commands.add(from), count) },
            settings,
            after,
            job.dt,
        );
        work.driven = count as f64;
        return 0;
    }
    u32::from(!finish(
        profiles,
        unsafe { slice::from_raw_parts(job.walls, job.wall_count) },
        settings,
        after,
        job.dt,
        work,
    ))
}
