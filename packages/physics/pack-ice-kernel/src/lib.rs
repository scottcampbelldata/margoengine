#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_ceil, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat,
    f64x2_sqrt, f64x2_sub, unreachable, v128,
};
use core::panic::PanicInfo;

const PI: f64 = core::f64::consts::PI;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    unreachable()
}

#[repr(transparent)]
#[derive(Clone, Copy)]
struct Vec2(v128);

impl Vec2 {
    #[inline(always)]
    fn new(x: f64, z: f64) -> Self {
        Self(f64x2(x, z))
    }

    #[inline(always)]
    fn x(self) -> f64 {
        f64x2_extract_lane::<0>(self.0)
    }

    #[inline(always)]
    fn z(self) -> f64 {
        f64x2_extract_lane::<1>(self.0)
    }

    #[inline(always)]
    fn plus(self, rhs: Self) -> Self {
        Self(f64x2_add(self.0, rhs.0))
    }

    #[inline(always)]
    fn minus(self, rhs: Self) -> Self {
        Self(f64x2_sub(self.0, rhs.0))
    }

    #[inline(always)]
    fn scale(self, factor: f64) -> Self {
        Self(f64x2_mul(self.0, f64x2_splat(factor)))
    }

    #[inline(always)]
    fn dot(self, rhs: Self) -> f64 {
        let pair = Self(f64x2_mul(self.0, rhs.0));
        pair.x() + pair.z()
    }

    #[inline(always)]
    fn perpendicular(self) -> Self {
        Self::new(self.z(), -self.x())
    }

    #[inline(always)]
    fn moment(self, force: Self) -> f64 {
        self.perpendicular().dot(force)
    }

    #[inline(always)]
    fn length(self) -> f64 {
        sqrt(self.dot(self))
    }
}

#[inline(always)]
fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

// Float64 layouts match the optional entry's typed-array fields. The vector pairs
// are read as scalars, so the arena does not need SIMD-aligned records.
#[repr(C)]
struct Floe {
    x: f64,
    z: f64,
    vx: f64,
    vz: f64,
    heading: f64,
    spin: f64,
    radius: f64,
    thickness: f64,
    volume: f64,
    rafted: f64,
    ridged: f64,
}

impl Floe {
    fn position(&self) -> Vec2 {
        Vec2::new(self.x, self.z)
    }

    fn velocity(&self) -> Vec2 {
        Vec2::new(self.vx, self.vz)
    }

    fn set_position(&mut self, p: Vec2) {
        self.x = p.x();
        self.z = p.z();
    }

    fn set_velocity(&mut self, v: Vec2) {
        self.vx = v.x();
        self.vz = v.z();
    }

    fn inverse_mass(&self, settings: &Settings) -> f64 {
        1.0 / (settings.ice_density * self.volume)
    }

    fn inverse_inertia(&self, inverse_mass: f64) -> f64 {
        2.0 * inverse_mass / (self.radius * self.radius)
    }
}

#[repr(C)]
struct Settings {
    ice_density: f64,
    water_density: f64,
    gravity: f64,
    air_skin: f64,
    air_edge: f64,
    water_skin: f64,
    water_edge: f64,
    restitution: f64,
    friction: f64,
    rafting_limit: f64,
    residual_radius: f64,
    tensile_strength: f64,
    icebreaking: f64,
    cell_width: f64,
}

#[repr(C)]
struct Flow {
    air_x: f64,
    air_z: f64,
    air_density: f64,
    current_x: f64,
    current_z: f64,
    water_density: f64,
}

#[repr(C)]
struct Vessel {
    x: f64,
    z: f64,
    forward_x: f64,
    forward_z: f64,
    center_x: f64,
    center_z: f64,
    vx: f64,
    vz: f64,
    spin: f64,
    inverse_mass: f64,
    inverse_yaw_inertia: f64,
    half_spine: f64,
    radius: f64,
    row: f64,
    enabled: f64,
}

impl Vessel {
    fn velocity(&self) -> Vec2 {
        Vec2::new(self.vx, self.vz)
    }

    fn forward(&self) -> Vec2 {
        Vec2::new(self.forward_x, self.forward_z)
    }

    fn advance(&mut self, dt: f64) {
        if self.enabled == 0.0 {
            return;
        }
        let center = Vec2::new(self.center_x, self.center_z);
        let advance = self.velocity().scale(dt);
        let forward = self.forward();
        // Cayley rotation integrates a fixed yaw rate without host trigonometry.
        let turn = self.spin * dt * 0.5;
        let scale = 1.0 / (1.0 + turn * turn);
        let cosine = (1.0 - turn * turn) * scale;
        let sine = 2.0 * turn * scale;
        let offset = Vec2::new(self.x, self.z).minus(center);
        let origin = center.plus(advance).plus(
            offset
                .scale(cosine)
                .plus(offset.perpendicular().scale(sine)),
        );
        self.center_x += advance.x();
        self.center_z += advance.z();
        self.x = origin.x();
        self.z = origin.z();
        let direction = forward
            .scale(cosine)
            .plus(forward.perpendicular().scale(sine));
        self.forward_x = direction.x();
        self.forward_z = direction.z();
    }
}

#[repr(C)]
struct Cell {
    x: i32,
    z: i32,
    head: u32,
    generation: u32,
}

struct Grid {
    cells: *mut Cell,
    next: *mut u32,
    mask: u32,
    width: f64,
    generation: u32,
}

impl Grid {
    fn coordinates(&self, p: Vec2) -> (i32, i32) {
        let cell = f64x2_floor(p.scale(1.0 / self.width).0);
        (
            f64x2_extract_lane::<0>(cell) as i32,
            f64x2_extract_lane::<1>(cell) as i32,
        )
    }

    unsafe fn slot(&self, x: i32, z: i32) -> *mut Cell {
        let mut slot =
            ((x as u32).wrapping_mul(0x9e3779b1) ^ (z as u32).wrapping_mul(0x85ebca77)) & self.mask;
        loop {
            let cell = self.cells.add(slot as usize);
            if (*cell).generation != self.generation || ((*cell).x == x && (*cell).z == z) {
                return cell;
            }
            slot = (slot + 1) & self.mask;
        }
    }

    unsafe fn insert(&self, index: u32, p: Vec2) {
        let (x, z) = self.coordinates(p);
        let cell = &mut *self.slot(x, z);
        let previous = if cell.generation == self.generation {
            cell.head
        } else {
            0
        };
        *cell = Cell {
            x,
            z,
            head: index + 1,
            generation: self.generation,
        };
        self.next.add(index as usize).write(previous);
    }

    unsafe fn first(&self, x: i32, z: i32) -> u32 {
        let cell = &*self.slot(x, z);
        if cell.generation == self.generation {
            cell.head
        } else {
            0
        }
    }
}

fn drag(floe: &Floe, flow: &Flow, s: &Settings, dt: f64) -> Vec2 {
    let area = PI * floe.radius * floe.radius;
    let height = floe.volume / area;
    let draft = height * s.ice_density / s.water_density;
    let diameter = 2.0 * floe.radius;
    let air = Vec2::new(flow.air_x, flow.air_z).minus(floe.velocity());
    let current = Vec2::new(flow.current_x, flow.current_z);
    let air_force =
        flow.air_density * (s.air_skin * area + s.air_edge * diameter * (height - draft));
    let water_coefficient =
        flow.water_density * (s.water_skin * area + s.water_edge * diameter * draft);
    let inverse_mass = floe.inverse_mass(s);
    let water_step = dt * inverse_mass * water_coefficient;
    // Backward Euler for linear ocean drag, explicit quadratic relative-air drag.
    // The air contribution alone cannot reverse its own relative velocity.
    let air_step = (dt * inverse_mass * air_force * air.length()).min(1.0);
    floe.velocity()
        .plus(air.scale(air_step))
        .plus(current.scale(water_step))
        .scale(1.0 / (1.0 + water_step))
}

fn normal(axis: Vec2, relative: Vec2, distance: f64) -> Vec2 {
    if distance > 0.0 {
        axis.scale(1.0 / distance)
    } else {
        let speed = relative.length();
        if speed > 0.0 {
            relative.scale(-1.0 / speed)
        } else {
            Vec2::new(1.0, 0.0)
        }
    }
}

// Convert a bounded contact band into piled ice. Mass stays with its parent; the
// smaller disk describes the remaining level-ice footprint, not lost material.
fn pile(floe: &mut Floe, penetration: f64, work: f64, break_against_hull: bool, s: &Settings) {
    let radius = floe.radius;
    let limit = s.residual_radius;
    if work <= 0.0 || radius <= limit || s.icebreaking == 0.0 {
        return;
    }
    let cut = penetration.min(radius - limit);
    let width = 2.0 * sqrt(cut * (2.0 * radius - cut));
    let max_area = PI * cut * (2.0 * radius - cut);
    let thickness = floe.thickness;
    let rafting = thickness < s.rafting_limit && !break_against_hull;
    let lifting = if rafting {
        s.ice_density
    } else {
        // One half of a symmetric ridge is raised, one half submerged.
        s.water_density * 0.5
    };
    // The contact must meet flexural fracture work before converting thick ice.
    let fracture_work = if rafting {
        0.0
    } else {
        s.tensile_strength * width * thickness * cut
    };
    let volume = ((work - fracture_work).max(0.0) / (lifting * s.gravity * thickness))
        .min(max_area * thickness);
    if volume == 0.0 {
        return;
    }
    let remaining_area = (PI * radius * radius - volume / thickness).max(PI * limit * limit);
    floe.radius = sqrt(remaining_area / PI);
    if rafting {
        floe.rafted += volume;
    } else {
        floe.ridged += volume;
    }
}

fn collide(a: &mut Floe, b: &mut Floe, s: &Settings) {
    let delta = b.position().minus(a.position());
    let distance = delta.length();
    let penetration = a.radius + b.radius - distance;
    if penetration < 0.0 {
        return;
    }
    let relative = b.velocity().minus(a.velocity());
    let n = normal(delta, relative, distance);
    let inv_a = a.inverse_mass(s);
    let inv_b = b.inverse_mass(s);
    let inverse_mass = inv_a + inv_b;
    let close = relative.dot(n);
    if close < 0.0 {
        let t = n.perpendicular();
        let jn = -(1.0 + s.restitution) * close / inverse_mass;
        let inv_ia = a.inverse_inertia(inv_a);
        let inv_ib = b.inverse_inertia(inv_b);
        // The impulses act at one shared point, even within a penetrated pair.
        let ra = (distance + a.radius - b.radius)
            .max(0.0)
            .min(2.0 * distance)
            * 0.5;
        let rb = distance - ra;
        let tangent_speed = relative.dot(t) - a.spin * ra - b.spin * rb;
        let tangent_inv_mass = inverse_mass + ra * ra * inv_ia + rb * rb * inv_ib;
        let bound = s.friction * jn;
        let jt = (-tangent_speed / tangent_inv_mass).max(-bound).min(bound);
        let j = n.scale(jn).plus(t.scale(jt));
        a.set_velocity(a.velocity().minus(j.scale(inv_a)));
        b.set_velocity(b.velocity().plus(j.scale(inv_b)));
        a.spin -= ra * jt * inv_ia;
        b.spin -= rb * jt * inv_ib;
        let work = -jn * (close + 0.5 * jn * inverse_mass)
            - jt * (tangent_speed + 0.5 * jt * tangent_inv_mass);
        pile(a, penetration * inv_a / inverse_mass, work * 0.5, false, s);
        pile(b, penetration * inv_b / inverse_mass, work * 0.5, false, s);
    }
    let remainder = (a.radius + b.radius - distance).max(0.0);
    a.set_position(
        a.position()
            .minus(n.scale(remainder * inv_a / inverse_mass)),
    );
    b.set_position(b.position().plus(n.scale(remainder * inv_b / inverse_mass)));
}

unsafe fn hull_contact(floe: &mut Floe, hull: &mut Vessel, s: &Settings, output: *mut f64) {
    if hull.enabled == 0.0 {
        return;
    }
    let origin = Vec2::new(hull.x, hull.z);
    let center = Vec2::new(hull.center_x, hull.center_z);
    let along = hull.forward();
    let arm = floe.position().minus(origin).dot(along);
    let spine = origin.plus(along.scale(arm.max(-hull.half_spine).min(hull.half_spine)));
    let delta = floe.position().minus(spine);
    let distance = delta.length();
    let penetration = hull.radius + floe.radius - distance;
    if penetration < 0.0 {
        return;
    }
    let n = normal(delta, floe.velocity().minus(hull.velocity()), distance);
    let contact = spine.plus(n.scale(hull.radius)).minus(center);
    let hull_velocity = hull
        .velocity()
        .plus(contact.perpendicular().scale(hull.spin));
    let relative = floe.velocity().minus(hull_velocity);
    let close = relative.dot(n);
    let inverse_mass = floe.inverse_mass(s);
    if close < 0.0 {
        let t = n.perpendicular();
        let lever_n = contact.moment(n);
        let lever_t = contact.moment(t);
        let inv_ia = floe.inverse_inertia(inverse_mass);
        let combined = inverse_mass + hull.inverse_mass;
        let inv_n = combined + lever_n * lever_n * hull.inverse_yaw_inertia;
        let jn = -(1.0 + s.restitution) * close / inv_n;
        let floe_arm = distance - hull.radius;
        let inv_t =
            combined + lever_t * lever_t * hull.inverse_yaw_inertia + floe_arm * floe_arm * inv_ia;
        let cross = lever_n * lever_t * hull.inverse_yaw_inertia;
        let tangent_speed = relative.dot(t) - floe.spin * floe_arm;
        let bound = s.friction * jn;
        let jt = (-(tangent_speed + cross * jn) / inv_t)
            .max(-bound)
            .min(bound);
        let impulse = n.scale(jn).plus(t.scale(jt));
        let torque = contact.moment(impulse);
        let next_hull = hull.velocity().minus(impulse.scale(hull.inverse_mass));
        hull.vx = next_hull.x();
        hull.vz = next_hull.z();
        hull.spin -= torque * hull.inverse_yaw_inertia;
        let body = output.add(hull.row as usize * 6);
        *body -= impulse.x();
        *body.add(2) -= impulse.z();
        *body.add(4) -= torque;
        floe.set_velocity(floe.velocity().plus(impulse.scale(inverse_mass)));
        floe.spin -= floe_arm * jt * inv_ia;
        let work =
            -jn * (close + 0.5 * jn * inv_n) - jt * (tangent_speed + jn * cross + 0.5 * jt * inv_t);
        pile(floe, penetration, work, true, s);
    }
    let remainder = (hull.radius + floe.radius - distance).max(0.0);
    floe.set_position(floe.position().plus(n.scale(remainder)));
}

struct PackStep {
    floes: *mut Floe,
    forcing: *const Flow,
    rings: *mut Vessel,
    count: u32,
    vessels: u32,
    grid: Grid,
    settings: *const Settings,
    impulses: *mut f64,
    stats: *mut u32,
}

impl PackStep {
    unsafe fn advance(&mut self, dt: f64) -> u32 {
        let s = &*self.settings;
        let mut smallest = f64::INFINITY;
        let mut fastest: f64 = 0.0;
        let mut hull_speed: f64 = 0.0;
        for i in 0..self.count as usize {
            let floe = &*self.floes.add(i);
            let flow = &*self.forcing.add(i);
            smallest = smallest.min(floe.radius);
            fastest = fastest
                .max(floe.velocity().length())
                .max(drag(floe, flow, s, dt).length());
        }
        for j in 0..self.vessels as usize {
            let hull = &*self.rings.add(j);
            if hull.enabled != 0.0 {
                let offset = Vec2::new(hull.x - hull.center_x, hull.z - hull.center_z);
                hull_speed = hull_speed.max(
                    hull.velocity().length()
                        + hull.spin.abs() * (offset.length() + hull.half_spine + hull.radius),
                );
            }
        }
        // The initial relative travel is at most half the smallest residual radius per substep.
        let travel = 2.0 * dt * (fastest + fastest.max(hull_speed)) / smallest;
        let count = f64x2_extract_lane::<0>(f64x2_ceil(f64x2_splat(travel))).max(1.0);
        if !(count <= f64::from(u32::MAX)) {
            return 1;
        }
        let substeps = count as u32;
        let step = dt / count;
        let mut candidates = 0_u32;
        for generation in 1..=substeps {
            self.grid.generation = generation;
            for i in 0..self.count {
                let floe = &mut *self.floes.add(i as usize);
                floe.set_velocity(drag(floe, &*self.forcing.add(i as usize), s, step));
                floe.set_position(floe.position().plus(floe.velocity().scale(step)));
                floe.heading += step * floe.spin;
                self.grid.insert(i, floe.position());
            }
            for j in 0..self.vessels as usize {
                (&mut *self.rings.add(j)).advance(step);
            }
            for i in 0..self.count {
                let floe = &mut *self.floes.add(i as usize);
                let (x, z) = self.grid.coordinates(floe.position());
                for dz in -1..=1 {
                    for dx in -1..=1 {
                        let mut head = self.grid.first(x.wrapping_add(dx), z.wrapping_add(dz));
                        while head != 0 {
                            let j = head - 1;
                            if j > i {
                                collide(floe, &mut *self.floes.add(j as usize), s);
                                candidates = candidates.saturating_add(1);
                            }
                            head = *self.grid.next.add(j as usize);
                        }
                    }
                }
                for j in 0..self.vessels as usize {
                    hull_contact(floe, &mut *self.rings.add(j), s, self.impulses);
                }
                if !floe.x.is_finite()
                    || !floe.z.is_finite()
                    || !floe.vx.is_finite()
                    || !floe.vz.is_finite()
                    || !floe.heading.is_finite()
                    || !floe.spin.is_finite()
                {
                    return 2;
                }
            }
        }
        self.stats.write(substeps);
        self.stats.add(1).write(candidates);
        0
    }
}

// All pointers address regions allocated for this one solver in the world's arena.
#[unsafe(no_mangle)]
unsafe extern "C" fn pack_ice_step(
    floes: *mut Floe,
    forcing: *const Flow,
    count: u32,
    rings: *mut Vessel,
    vessels: u32,
    settings: *const Settings,
    cells: *mut Cell,
    capacity: u32,
    next: *mut u32,
    impulses: *mut f64,
    stats: *mut u32,
    dt: f64,
) -> u32 {
    for i in 0..capacity as usize {
        (*cells.add(i)).generation = 0;
    }
    let grid = Grid {
        cells,
        next,
        mask: capacity - 1,
        width: (*settings).cell_width,
        generation: 0,
    };
    PackStep {
        floes,
        forcing,
        rings,
        count,
        vessels,
        grid,
        settings,
        impulses,
        stats,
    }
    .advance(dt)
}
