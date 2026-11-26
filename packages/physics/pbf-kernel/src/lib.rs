#![no_std]
#![cfg(target_arch = "wasm32")]

mod grid;
mod vector;

use grid::{Bucket, Grid};
use vector::{Vec3, ZERO, add, cross, dot, length, norm2, rotate, scale, sqrt, sub};

const POLY6: f64 = 315.0 / (64.0 * core::f64::consts::PI);
const SPIKY: f64 = -45.0 / core::f64::consts::PI;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

// A checked access traps on a malformed native buffer without linking panic-location data into the shared arena.
#[inline]
fn item<T>(rows: &[T], index: usize) -> &T {
    match rows.get(index) {
        Some(row) => row,
        None => core::arch::wasm32::unreachable(),
    }
}

#[inline]
fn item_mut<T>(rows: &mut [T], index: usize) -> &mut T {
    match rows.get_mut(index) {
        Some(row) => row,
        None => core::arch::wasm32::unreachable(),
    }
}

#[repr(C)]
pub struct Particle {
    position: Vec3,
    velocity: Vec3,
    density: f64,
    mass: f64,
}

#[repr(C)]
pub struct Work {
    previous: Vec3,
    correction: Vec3,
    curl: Vec3,
    smoothing: Vec3,
    lambda: f64,
    contact: Vec3,
    contact_solid: f64,
}

#[repr(C)]
pub struct Boundary {
    position: Vec3,
    volume: f64,
    shape: f64,
}

#[repr(C)]
pub struct Solid {
    position: Vec3,
    rotation: [f64; 4],
    half: Vec3,
    linear: Vec3,
    angular: Vec3,
    centre: Vec3,
    body: f64,
    active: f64,
}

#[repr(C)]
pub struct Settings {
    gravity: Vec3,
    lower: Vec3,
    upper: Vec3,
    support: f64,
    rest: f64,
    radius: f64,
    relaxation: f64,
    tensile: f64,
    tensile_distance: f64,
    viscosity: f64,
    confinement: f64,
    friction: f64,
    iterations: f64,
    tolerance: f64,
    walls: f64,
    cohesive: f64,
}

type Reaction = [f64; 6];

#[inline]
fn kernel(distance2: f64) -> f64 {
    let remainder = (1.0 - distance2).max(0.0);
    POLY6 * remainder * remainder * remainder
}

#[inline]
fn gradient(offset: Vec3, distance2: f64, i: usize, j: usize) -> Vec3 {
    if distance2 >= 1.0 {
        return ZERO;
    }
    if distance2 == 0.0 {
        // Antisymmetric choice at the undefined direction of a coincident particle pair.
        let axis = (i ^ j) % 3;
        let mut direction = ZERO;
        direction[axis] = if i > j { SPIKY } else { -SPIKY };
        return direction;
    }
    let distance = sqrt(distance2);
    let remainder = 1.0 - distance;
    scale(offset, SPIKY * remainder * remainder / distance)
}

fn record_impulse(out: &mut [Reaction], object: &Solid, point: Vec3, impulse: Vec3) {
    if object.body < 0.0 {
        return;
    }
    let torque = cross(sub(point, object.centre), impulse);
    let row = item_mut(out, object.body as usize);
    for axis in 0..3 {
        row[axis] += impulse[axis];
        row[axis + 3] += torque[axis];
    }
}

fn clip_solid(object: &Solid, p: Vec3, radius: f64) -> Option<(Vec3, f64)> {
    if object.active == 0.0 {
        return None;
    }
    let p = rotate(sub(p, object.position), object.rotation, true);
    if object.active >= 2.0 {
        let segment = object.half[1];
        let axis = [0.0, p[1].max(-segment).min(segment), 0.0];
        let offset = sub(p, axis);
        let reach = object.half[0] + radius;
        let d2 = norm2(offset);
        if d2 >= reach * reach {
            return None;
        }
        let distance = sqrt(d2);
        let normal = if distance > 0.0 {
            scale(offset, 1.0 / distance)
        } else {
            [1.0, 0.0, 0.0]
        };
        return Some((rotate(normal, object.rotation, false), reach - distance));
    }
    let closest = [
        p[0].max(-object.half[0]).min(object.half[0]),
        p[1].max(-object.half[1]).min(object.half[1]),
        p[2].max(-object.half[2]).min(object.half[2]),
    ];
    let difference = sub(p, closest);
    let d2 = norm2(difference);
    if d2 >= radius * radius {
        return None;
    }
    let (normal, push) = if d2 > 0.0 {
        let d = sqrt(d2);
        (scale(difference, 1.0 / d), radius - d)
    } else {
        let gap = [
            object.half[0] - p[0].abs(),
            object.half[1] - p[1].abs(),
            object.half[2] - p[2].abs(),
        ];
        let mut axis = if gap[1] < gap[0] { 1 } else { 0 };
        if gap[2] < gap[axis] {
            axis = 2;
        }
        let mut n = ZERO;
        n[axis] = if p[axis] < 0.0 { -1.0 } else { 1.0 };
        (n, radius + gap[axis])
    };
    Some((rotate(normal, object.rotation, false), push))
}

fn contacts(
    settings: &Settings,
    point: &mut Particle,
    work: &mut Work,
    shapes: &[Solid],
    reactions: &mut [Reaction],
    dt: f64,
) {
    let walls = settings.walls as u32;
    for axis in 0..3 {
        let low = settings.lower[axis] + settings.radius;
        let high = settings.upper[axis] - settings.radius;
        let q = point.position[axis];
        if (walls & (1 << (2 * axis))) != 0 && q < low {
            point.position[axis] = low;
            work.contact = ZERO;
            work.contact[axis] = 1.0;
            work.contact_solid = -1.0;
        }
        if (walls & (1 << (2 * axis + 1))) != 0 && q > high {
            point.position[axis] = high;
            work.contact = ZERO;
            work.contact[axis] = -1.0;
            work.contact_solid = -1.0;
        }
    }
    for (index, object) in shapes.iter().enumerate() {
        if let Some((normal, displacement)) = clip_solid(object, point.position, settings.radius) {
            let delta = scale(normal, displacement);
            point.position = add(point.position, delta);
            let contact = sub(point.position, scale(normal, settings.radius));
            record_impulse(reactions, object, contact, scale(delta, -point.mass / dt));
            work.contact = normal;
            work.contact_solid = index as f64;
        }
    }
}

fn rebuild(grid: &mut Grid<'_>, points: &[Particle], boundary: &[Boundary]) {
    grid.clear();
    for (i, point) in points.iter().enumerate() {
        grid.insert(point.position, i);
    }
    for (i, sample) in boundary.iter().enumerate() {
        if sample.volume > 0.0 {
            grid.insert(sample.position, points.len() + i);
        }
    }
}

fn estimate_density(
    points: &mut [Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    grid: &Grid<'_>,
    settings: &Settings,
    volume_scale: f64,
    evaluations: &mut f64,
) -> f64 {
    let mut maximum: f64 = 0.0;
    for i in 0..points.len() {
        let centre = item(points, i).position;
        let mut density = 0.0;
        let mut gradient_sum = ZERO;
        let mut neighbours = 0.0;
        grid.nearby(centre, |j| {
            let (p, weight) = if j < points.len() {
                (
                    item(points, j).position,
                    item(points, j).mass * volume_scale,
                )
            } else {
                let sample = item(boundary, j - points.len());
                (sample.position, sample.volume)
            };
            let offset = scale(sub(centre, p), 1.0 / settings.support);
            let d2 = norm2(offset);
            *evaluations += 1.0;
            density += weight * kernel(d2);
            if i != j && d2 < 1.0 {
                let g = scale(gradient(offset, d2, i, j), weight);
                gradient_sum = add(gradient_sum, g);
                if j < points.len() {
                    neighbours += norm2(g);
                }
            }
        });
        let compression = density - 1.0;
        maximum = maximum.max(compression);
        // Kernel deficiency in an open interface is not negative pressure. The cohesive preview
        // option keeps the signed PBF constraint up to the deficit of a planar half-space.
        let limit = if settings.cohesive == 0.0 { 0.0 } else { -0.5 };
        item_mut(work, i).lambda =
            -compression.max(limit) / (norm2(gradient_sum) + neighbours + settings.relaxation);
        item_mut(points, i).density = density * settings.rest;
    }
    maximum
}

fn project_density(
    points: &[Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    shapes: &[Solid],
    grid: &Grid<'_>,
    settings: &Settings,
    volume_scale: f64,
    dt: f64,
    reactions: &mut [Reaction],
    evaluations: &mut f64,
) -> f64 {
    let tensile_reference = kernel(settings.tensile_distance * settings.tensile_distance);
    let mut longest: f64 = 0.0;
    for i in 0..points.len() {
        let current = item(points, i).position;
        let mut delta = ZERO;
        grid.nearby(current, |j| {
            if i == j {
                return;
            }
            let (position, weight) = if j < points.len() {
                (
                    item(points, j).position,
                    item(points, j).mass * volume_scale,
                )
            } else {
                let sample = item(boundary, j - points.len());
                (sample.position, sample.volume)
            };
            let offset = scale(sub(current, position), 1.0 / settings.support);
            let d2 = norm2(offset);
            *evaluations += 1.0;
            if d2 >= 1.0 {
                return;
            }
            let g = gradient(offset, d2, i, j);
            let coefficient = if j < points.len() {
                let ratio = kernel(d2) / tensile_reference;
                let square = ratio * ratio;
                item(work, i).lambda + item(work, j).lambda - settings.tensile * square * square
            } else {
                item(work, i).lambda.min(0.0)
            };
            let contribution = scale(g, settings.support * weight * coefficient);
            delta = add(delta, contribution);
            if j >= points.len() {
                let sample = item(boundary, j - points.len());
                record_impulse(
                    reactions,
                    item(shapes, sample.shape as usize),
                    sample.position,
                    scale(contribution, -item(points, i).mass / dt),
                );
            }
        });
        item_mut(work, i).correction = delta;
        longest = longest.max(norm2(delta));
    }
    // A common trust radius preserves the action/reaction sum and keeps all points within the neighbour halo.
    let limit = 0.4 * settings.support;
    if longest > limit * limit {
        limit / sqrt(longest)
    } else {
        1.0
    }
}

fn recover_velocity(
    points: &mut [Particle],
    work: &[Work],
    shapes: &[Solid],
    reactions: &mut [Reaction],
    settings: &Settings,
    dt: f64,
) {
    for (p, w) in points.iter_mut().zip(work) {
        p.velocity = scale(sub(p.position, w.previous), 1.0 / dt);
        if norm2(w.contact) == 0.0 {
            continue;
        }
        let surface = sub(p.position, scale(w.contact, settings.radius));
        let object = if w.contact_solid < 0.0 {
            None
        } else {
            Some(item(shapes, w.contact_solid as usize))
        };
        let target = object.map_or(ZERO, |b| {
            add(b.linear, cross(b.angular, sub(surface, b.centre)))
        });
        let relative = sub(p.velocity, target);
        let into = dot(relative, w.contact);
        let tangent = sub(relative, scale(w.contact, into));
        let delta = add(
            scale(w.contact, -into.min(0.0)),
            scale(tangent, -settings.friction),
        );
        p.velocity = add(p.velocity, delta);
        if let Some(body) = object {
            record_impulse(reactions, body, surface, scale(delta, -p.mass));
        }
    }
}

fn limit_mechanical_energy(points: &mut [Particle], work: &[Work], gravity: Vec3, incoming: f64) {
    let mut budget = incoming;
    let mut energy = 0.0;
    let mut momentum = ZERO;
    let mut mass = 0.0;
    for (p, state) in points.iter().zip(work) {
        budget += 2.0 * p.mass * dot(gravity, sub(p.position, state.previous));
        energy += p.mass * norm2(p.velocity);
        momentum = add(momentum, scale(p.velocity, p.mass));
        mass += p.mass;
    }
    if energy <= budget || !energy.is_finite() {
        return;
    }
    let mean = scale(momentum, 1.0 / mass);
    let translation = mass * norm2(mean);
    if budget <= translation {
        let retain = if translation > 0.0 {
            sqrt(budget.max(0.0) / translation)
        } else {
            0.0
        };
        for p in points {
            p.velocity = scale(mean, retain);
        }
    } else {
        let retain = sqrt((budget - translation) / (energy - translation));
        for p in points {
            p.velocity = add(mean, scale(sub(p.velocity, mean), retain));
        }
    }
}

fn smooth(
    points: &mut [Particle],
    work: &mut [Work],
    grid: &Grid<'_>,
    settings: &Settings,
    volume_scale: f64,
    dt: f64,
    evaluations: &mut f64,
) {
    if settings.viscosity == 0.0 && settings.confinement == 0.0 {
        return;
    }
    let mut maximum_weight: f64 = 1.0;
    let mut energy_before = 0.0;
    for i in 0..points.len() {
        let p = item(points, i);
        let mut difference = ZERO;
        let mut omega = ZERO;
        let mut total_weight = 0.0;
        grid.nearby(p.position, |j| {
            if i == j || j >= points.len() {
                return;
            }
            let q = item(points, j);
            let offset = scale(sub(p.position, q.position), 1.0 / settings.support);
            let d2 = norm2(offset);
            let dv = sub(q.velocity, p.velocity);
            let volume = q.mass * volume_scale;
            let weight = volume * kernel(d2);
            *evaluations += 1.0;
            total_weight += weight;
            difference = add(difference, scale(dv, weight));
            if settings.confinement > 0.0 && d2 < 1.0 {
                omega = add(
                    omega,
                    scale(
                        cross(gradient(offset, d2, i, j), dv),
                        volume / settings.support,
                    ),
                );
            }
        });
        maximum_weight = maximum_weight.max(total_weight);
        item_mut(work, i).smoothing = difference;
        item_mut(work, i).curl = omega;
        energy_before += p.mass * norm2(p.velocity);
    }

    let mut mass = 0.0;
    let mut net = ZERO;
    let mut energy_smoothed = 0.0;
    for i in 0..points.len() {
        let p = item(points, i);
        let mut direction = ZERO;
        if settings.confinement > 0.0 {
            let magnitude = sqrt(norm2(item(work, i).curl));
            grid.nearby(p.position, |j| {
                if i == j || j >= points.len() {
                    return;
                }
                let offset = scale(
                    sub(p.position, item(points, j).position),
                    1.0 / settings.support,
                );
                let d2 = norm2(offset);
                *evaluations += 1.0;
                if d2 < 1.0 {
                    let difference = sqrt(norm2(item(work, j).curl)) - magnitude;
                    direction = add(
                        direction,
                        scale(
                            gradient(offset, d2, i, j),
                            difference * item(points, j).mass * volume_scale,
                        ),
                    );
                }
            });
        }
        let d2 = norm2(direction);
        let confinement = if d2 > 0.0 {
            scale(
                cross(direction, item(work, i).curl),
                dt * settings.confinement / sqrt(d2),
            )
        } else {
            ZERO
        };
        let velocity = add(
            p.velocity,
            scale(item(work, i).smoothing, settings.viscosity / maximum_weight),
        );
        item_mut(work, i).smoothing = velocity;
        item_mut(work, i).correction = confinement;
        energy_smoothed += p.mass * norm2(velocity);
        mass += p.mass;
        net = add(net, scale(confinement, p.mass));
    }
    // Confinement may restore energy dissipated by smoothing but cannot create surplus energy.
    let mean = scale(net, 1.0 / mass);
    let mut linear = 0.0;
    let mut quadratic = 0.0;
    for (p, w) in points.iter().zip(work.iter_mut()) {
        w.correction = sub(w.correction, mean);
        linear += 2.0 * p.mass * dot(w.smoothing, w.correction);
        quadratic += p.mass * norm2(w.correction);
    }
    let room = (energy_before - energy_smoothed).max(0.0);
    let strength = if quadratic != 0.0 && linear + quadratic > room {
        let root = sqrt(linear * linear + 4.0 * quadratic * room);
        if linear > 0.0 {
            2.0 * room / (root + linear)
        } else {
            (root - linear) / (2.0 * quadratic)
        }
    } else {
        1.0
    };
    for (p, w) in points.iter_mut().zip(work) {
        p.velocity = add(w.smoothing, scale(w.correction, strength));
    }
}

/// All buffers are caller-owned world regions. Positions and velocities are SI, while density iteration is nondimensional.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn solve_pbf(
    particle_ptr: *mut Particle,
    count: usize,
    work_ptr: *mut Work,
    bucket_ptr: *mut Bucket,
    buckets: usize,
    next_ptr: *mut u32,
    used_ptr: *mut u32,
    boundary_ptr: *const Boundary,
    boundary_count: usize,
    shapes_ptr: *const Solid,
    shape_count: usize,
    reaction_ptr: *mut Reaction,
    correction_ptr: *mut Reaction,
    body_count: usize,
    settings: *const Settings,
    statistics: *mut [f64; 6],
    dt: f64,
) -> u32 {
    let (
        points,
        work,
        buckets,
        next,
        used,
        boundary,
        shapes,
        reactions,
        corrections,
        settings,
        statistics,
    ) = unsafe {
        (
            core::slice::from_raw_parts_mut(particle_ptr, count),
            core::slice::from_raw_parts_mut(work_ptr, count),
            core::slice::from_raw_parts_mut(bucket_ptr, buckets),
            core::slice::from_raw_parts_mut(next_ptr, count + boundary_count),
            core::slice::from_raw_parts_mut(used_ptr, count + boundary_count),
            core::slice::from_raw_parts(boundary_ptr, boundary_count),
            core::slice::from_raw_parts(shapes_ptr, shape_count),
            core::slice::from_raw_parts_mut(reaction_ptr, body_count),
            core::slice::from_raw_parts_mut(correction_ptr, body_count),
            &*settings,
            &mut *statistics,
        )
    };
    reactions.fill([0.0; 6]);
    let mut velocity = 0.0_f64;
    for p in points.iter() {
        velocity = velocity.max(length(p.velocity));
    }
    for object in shapes.iter() {
        if object.active > 0.0 {
            let extent = if object.active >= 2.0 {
                object.half[0] + object.half[1]
            } else {
                length(object.half)
            };
            let speed = length(object.linear) + length(object.angular) * extent;
            velocity = velocity.max(speed);
        }
    }
    let speed = velocity + dt * length(settings.gravity);
    let requested = dt * speed / (0.4 * settings.support);
    if !requested.is_finite() || requested >= (usize::MAX - 1) as f64 {
        return 1;
    }
    let substeps = 1 + requested as usize;
    let step = dt / substeps as f64;
    let volume_scale =
        1.0 / (settings.rest * settings.support * settings.support * settings.support);
    let mut grid = Grid::new(buckets, next, used, 1.0 / settings.support);
    let mut evaluations = 0.0;
    let mut rounds = 0.0;
    let mut compression = 0.0;
    if dt == 0.0 {
        rebuild(&mut grid, points, boundary);
        statistics[4] = estimate_density(
            points,
            work,
            boundary,
            &grid,
            settings,
            volume_scale,
            &mut evaluations,
        );
        statistics[5] = velocity;
        grid.clear();
        return 0;
    }
    // Prescribed static walls cannot supply mechanical work. Live moving bodies exchange separate impulses instead.
    let stationary = shapes.iter().all(|body| {
        body.active == 0.0 || (body.body < 0.0 && norm2(body.linear) + norm2(body.angular) == 0.0)
    });
    for _ in 0..substeps {
        let incoming = if stationary {
            points.iter().map(|p| p.mass * norm2(p.velocity)).sum()
        } else {
            0.0
        };
        for (p, w) in points.iter_mut().zip(work.iter_mut()) {
            w.previous = p.position;
            w.contact = ZERO;
            w.contact_solid = -1.0;
            p.velocity = add(p.velocity, scale(settings.gravity, step));
            p.position = add(p.position, scale(p.velocity, step));
            contacts(settings, p, w, shapes, reactions, step);
        }
        for _ in 0..settings.iterations as usize {
            rebuild(&mut grid, points, boundary);
            compression = estimate_density(
                points,
                work,
                boundary,
                &grid,
                settings,
                volume_scale,
                &mut evaluations,
            );
            if settings.tolerance > 0.0
                && compression < settings.tolerance
                && settings.tensile == 0.0
                && settings.cohesive == 0.0
            {
                break;
            }
            corrections.fill([0.0; 6]);
            let mut fraction = project_density(
                points,
                work,
                boundary,
                shapes,
                &grid,
                settings,
                volume_scale,
                step,
                corrections,
                &mut evaluations,
            );
            if stationary && settings.gravity != ZERO {
                let mut available = incoming;
                let mut work_requested = 0.0;
                for (p, w) in points.iter().zip(work.iter()) {
                    available += 2.0 * p.mass * dot(settings.gravity, sub(p.position, w.previous));
                    work_requested += 2.0 * p.mass * dot(settings.gravity, w.correction);
                }
                if work_requested < 0.0 {
                    fraction = fraction.min(available.max(0.0) / -work_requested);
                }
            }
            for (reaction, correction) in reactions.iter_mut().zip(corrections.iter()) {
                for axis in 0..6 {
                    reaction[axis] += fraction * correction[axis];
                }
            }
            for (p, w) in points.iter_mut().zip(work.iter_mut()) {
                p.position = add(p.position, scale(w.correction, fraction));
                contacts(settings, p, w, shapes, reactions, step);
            }
            rounds += 1.0;
        }
        recover_velocity(points, work, shapes, reactions, settings, step);
        if stationary {
            limit_mechanical_energy(points, work, settings.gravity, incoming);
        }
        rebuild(&mut grid, points, boundary);
        compression = estimate_density(
            points,
            work,
            boundary,
            &grid,
            settings,
            volume_scale,
            &mut evaluations,
        );
        smooth(
            points,
            work,
            &grid,
            settings,
            volume_scale,
            step,
            &mut evaluations,
        );
    }
    statistics[1] = substeps as f64;
    statistics[2] = rounds;
    statistics[3] = evaluations;
    statistics[4] = compression;
    statistics[5] = points
        .iter()
        .fold(0.0_f64, |top, p| top.max(length(p.velocity)));
    grid.clear();
    0
}
