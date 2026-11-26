#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
};
use margoengine_physics_kernel_common::pinned::{cos, sin};

struct NoHeap;
unsafe impl core::alloc::GlobalAlloc for NoHeap {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }
    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}
#[global_allocator]
static ALLOCATOR: NoHeap = NoHeap;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

#[repr(C)]
#[derive(Clone, Copy)]
struct V {
    x: f64,
    y: f64,
    z: f64,
}

impl V {
    const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };
    const X: Self = Self {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    };
    const Y: Self = Self {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    const Z: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 1.0,
    };
    fn add(self, b: Self) -> Self {
        Self {
            x: self.x + b.x,
            y: self.y + b.y,
            z: self.z + b.z,
        }
    }
    fn subtract(self, b: Self) -> Self {
        self.add(b.scale(-1.0))
    }
    #[inline(always)]
    fn scale(self, a: f64) -> Self {
        Self {
            x: self.x * a,
            y: self.y * a,
            z: self.z * a,
        }
    }
    #[inline(always)]
    fn dot(self, b: Self) -> f64 {
        let p = f64x2_mul(f64x2(self.x, self.y), f64x2(b.x, b.y));
        f64x2_extract_lane::<0>(p) + f64x2_extract_lane::<1>(p) + self.z * b.z
    }
    #[inline(always)]
    fn cross(self, b: Self) -> Self {
        Self {
            x: self.y * b.z - self.z * b.y,
            y: self.z * b.x - self.x * b.z,
            z: self.x * b.y - self.y * b.x,
        }
    }
    fn length(self) -> f64 {
        sqrt(self.dot(self))
    }
    #[inline(always)]
    fn direction(self, fallback: Self) -> Self {
        let length = self.length();
        if length > 1e-20 {
            self.scale(1.0 / length)
        } else {
            fallback
        }
    }
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Q {
    v: V,
    w: f64,
}

impl Q {
    fn conjugate(self) -> Self {
        Self {
            v: self.v.scale(-1.0),
            w: self.w,
        }
    }
    fn mul(self, b: Self) -> Self {
        Self {
            v: self
                .v
                .scale(b.w)
                .add(b.v.scale(self.w))
                .add(self.v.cross(b.v)),
            w: self.w * b.w - self.v.dot(b.v),
        }
    }
    fn normalized(self) -> Self {
        let inverse = 1.0 / sqrt(self.v.dot(self.v) + self.w * self.w);
        Self {
            v: self.v.scale(inverse),
            w: self.w * inverse,
        }
    }
    #[inline(always)]
    fn rotate(self, v: V) -> V {
        let twice = self.v.cross(v).scale(2.0);
        v.add(twice.scale(self.w)).add(self.v.cross(twice))
    }
    fn correct(self, world_angle: V) -> Self {
        Self {
            v: world_angle.scale(0.5),
            w: 1.0,
        }
        .mul(self)
        .normalized()
    }
    fn advance(self, omega: V, dt: f64) -> Self {
        let speed = omega.length();
        if speed == 0.0 {
            return self;
        }
        let angle = 0.5 * dt * speed;
        Self {
            v: omega.scale(sin(angle) / speed),
            w: cos(angle),
        }
        .mul(self)
        .normalized()
    }
    #[inline(always)]
    fn toward(self, target: V) -> Self {
        let axis = self.rotate(V::Z);
        let w = 1.0 + axis.dot(target);
        if w <= 1e-12 {
            return Self {
                v: self.rotate(V::X),
                w: 0.0,
            }
            .mul(self)
            .normalized();
        }
        Self {
            v: axis.cross(target),
            w,
        }
        .normalized()
        .mul(self)
        .normalized()
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct State {
    position: V,
    velocity: V,
    frame: Q,
    spin: V,
}

#[repr(C)]
struct Material {
    inverse_mass: f64,
    inverse_bend: f64,
    inverse_twist: f64,
    radius: f64,
    length: f64,
    shear: f64,
    axial: f64,
    bend: f64,
    twist: f64,
    natural: Q,
}

impl Material {
    fn inverse_inertia(&self, frame: Q, gradient: V) -> V {
        let tangent = frame.rotate(V::Z);
        gradient
            .scale(self.inverse_bend)
            .add(tangent.scale((self.inverse_twist - self.inverse_bend) * tangent.dot(gradient)))
    }
}

#[repr(C)]
struct Environment {
    wind: V,
    drag: f64,
    ground: V,
    plane: f64,
}

#[repr(C)]
struct Scratch {
    old: State,
    correction: V,
    shear: V,
    bend: V,
    contact: V,
}

#[repr(C)]
struct Root {
    start: f64,
    count: f64,
    position: V,
    frame: Q,
}

#[repr(C)]
struct Capsule {
    start: V,
    end: V,
    radius: f64,
}

#[repr(C)]
struct RigidCapsule {
    shape: Capsule,
    centre: V,
    velocity: V,
    angular: V,
    row: f64,
}

#[repr(C)]
struct Reaction {
    impulse: V,
    angular: V,
}

#[repr(C)]
struct Hit {
    collider: usize,
    point: V,
}

#[repr(C)]
struct Advance {
    gravity: V,
    dt: f64,
    retention: f64,
    iterations: f64,
    follow_damping: f64,
    friction: f64,
    contact_flags: f64,
    grid_size: f64,
}

#[repr(C)]
struct Link {
    next: i32,
    x: i32,
    y: i32,
    z: i32,
}

fn bucket(x: i32, y: i32, z: i32, mask: usize) -> usize {
    let hash = x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663) ^ z.wrapping_mul(83_492_791);
    hash as usize & mask
}

fn coordinate(value: f64, size: f64) -> i32 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(value / size))) as i32
}

fn self_contacts(
    nodes: &mut [State],
    material: &[Material],
    scratch: &mut [Scratch],
    links: &mut [Link],
    buckets: &mut [i32],
    size: f64,
) -> f64 {
    buckets.fill(-1);
    let mask = buckets.len() - 1;
    for (i, node) in nodes.iter().enumerate() {
        let p = node.position;
        let (x, y, z) = (
            coordinate(p.x, size),
            coordinate(p.y, size),
            coordinate(p.z, size),
        );
        let head = slot_mut(buckets, bucket(x, y, z, mask));
        *slot_mut(links, i) = Link {
            next: *head,
            x,
            y,
            z,
        };
        *head = i as i32;
    }
    let mut checked = 0.0;
    for i in 0..nodes.len() {
        let source = slot(links, i);
        let a = slot(material, i);
        for dz in -1..=1 {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (x, y, z) = (
                        source.x.wrapping_add(dx),
                        source.y.wrapping_add(dy),
                        source.z.wrapping_add(dz),
                    );
                    let mut j = *slot(buckets, bucket(x, y, z, mask));
                    while j >= 0 {
                        let index = j as usize;
                        let found = slot(links, index);
                        j = found.next;
                        if index <= i
                            || (index == i + 1 && a.length > 0.0)
                            || found.x != x
                            || found.y != y
                            || found.z != z
                        {
                            continue;
                        }
                        let b = slot(material, index);
                        let weight = a.inverse_mass + b.inverse_mass;
                        if weight == 0.0 {
                            continue;
                        }
                        checked += 1.0;
                        let (first, second) = pair(nodes, i, index);
                        let d = second.position.subtract(first.position);
                        let distance = d.length();
                        let penetration = a.radius + b.radius - distance;
                        if penetration <= 0.0 {
                            continue;
                        }
                        let correction = d.direction(V::X).scale(penetration / weight);
                        let ca = correction.scale(-a.inverse_mass);
                        let cb = correction.scale(b.inverse_mass);
                        first.position = first.position.add(ca);
                        second.position = second.position.add(cb);
                        let sa = slot_mut(scratch, i);
                        sa.contact = sa.contact.add(ca);
                        let sb = slot_mut(scratch, index);
                        sb.contact = sb.contact.add(cb);
                    }
                }
            }
        }
    }
    checked
}

fn shear_constraint(
    a: &mut State,
    b: &mut State,
    ma: &Material,
    mb: &Material,
    lambda: &mut V,
    dt: f64,
) {
    shear_axis(a, b, ma, mb, V::X, 0.0, ma.shear, &mut lambda.x, dt);
    shear_axis(a, b, ma, mb, V::Y, 0.0, ma.shear, &mut lambda.y, dt);
    shear_axis(a, b, ma, mb, V::Z, 1.0, ma.axial, &mut lambda.z, dt);
}

#[inline(always)]
fn shear_axis(
    a: &mut State,
    b: &mut State,
    ma: &Material,
    mb: &Material,
    axis: V,
    target: f64,
    compliance: f64,
    sum: &mut f64,
    dt: f64,
) {
    let inv_length = 1.0 / ma.length;
    let director = a.frame.rotate(axis);
    let edge = b.position.subtract(a.position).scale(inv_length);
    let value = edge.dot(director) - target;
    let gradient = director.cross(edge);
    let angular = ma.inverse_inertia(a.frame, gradient);
    let alpha = compliance / (dt * dt);
    let denominator = (ma.inverse_mass + mb.inverse_mass) * inv_length * inv_length
        + gradient.dot(angular)
        + alpha;
    if denominator <= 0.0 {
        return;
    }
    let delta = -(value + alpha * *sum) / denominator;
    *sum += delta;
    let shift = director.scale(delta * inv_length);
    a.position = a.position.subtract(shift.scale(ma.inverse_mass));
    b.position = b.position.add(shift.scale(mb.inverse_mass));
    a.frame = a.frame.correct(angular.scale(delta));
}

fn bend_constraint(
    a: &mut State,
    b: &mut State,
    ma: &Material,
    mb: &Material,
    lambda: &mut V,
    dt: f64,
) {
    bend_axis(a, b, ma, mb, V::X, ma.bend, &mut lambda.x, dt);
    bend_axis(a, b, ma, mb, V::Y, ma.bend, &mut lambda.y, dt);
    bend_axis(a, b, ma, mb, V::Z, ma.twist, &mut lambda.z, dt);
}

#[inline(always)]
fn bend_axis(
    a: &mut State,
    b: &mut State,
    ma: &Material,
    mb: &Material,
    axis: V,
    compliance: f64,
    sum: &mut f64,
    dt: f64,
) {
    let natural = a.frame.mul(ma.natural);
    let error = natural.conjugate().mul(b.frame);
    let sign = if error.w < 0.0 { -1.0 } else { 1.0 };
    let value = 2.0 * sign * error.v.dot(axis);
    let gradient = natural
        .rotate(axis.scale(error.w).add(error.v.cross(axis)))
        .scale(sign);
    let wa = ma.inverse_inertia(a.frame, gradient);
    let wb = mb.inverse_inertia(b.frame, gradient);
    let alpha = compliance / (dt * dt);
    let denominator = gradient.dot(wa.add(wb)) + alpha;
    if denominator <= 0.0 {
        return;
    }
    let delta = -(value + alpha * *sum) / denominator;
    *sum += delta;
    a.frame = a.frame.correct(wa.scale(-delta));
    b.frame = b.frame.correct(wb.scale(delta));
}

/// Projects onto the allowed part of the link sphere at a plane contact.
fn ground_direction(
    direction: V,
    parent: V,
    length: f64,
    radius: f64,
    environment: &Environment,
) -> V {
    let normal = environment.ground;
    if normal.dot(normal) == 0.0 {
        return direction;
    }
    let minimum = (environment.plane + radius - parent.dot(normal)) / length;
    let approach = direction.dot(normal);
    if approach >= minimum {
        return direction;
    }
    if minimum >= 1.0 {
        return normal;
    }
    let lateral = direction.subtract(normal.scale(approach));
    let axis = if normal.x.abs() < 0.5 { V::X } else { V::Y };
    let tangent = lateral.direction(normal.cross(axis).direction(V::Z));
    normal
        .scale(minimum)
        .add(tangent.scale(sqrt(1.0 - minimum * minimum)))
}

#[inline(always)]
fn capsule_contact(position: V, radius: f64, obstacle: &Capsule) -> Option<(V, V)> {
    let axis = obstacle.end.subtract(obstacle.start);
    let offset = position.subtract(obstacle.start);
    let square = axis.dot(axis);
    let along = if square > 0.0 {
        (axis.dot(offset) / square).max(0.0).min(1.0)
    } else {
        0.0
    };
    let radial = offset.subtract(axis.scale(along));
    let penetration = obstacle.radius + radius - radial.length();
    if penetration <= 0.0 {
        return None;
    }
    let normal = radial.direction(axis.cross(V::X).direction(V::Y));
    let nearest = obstacle.start.add(axis.scale(along));
    Some((
        nearest.add(normal.scale(obstacle.radius)),
        normal.scale(penetration),
    ))
}

#[derive(Clone, Copy)]
struct Segment {
    start: V,
    edge: V,
}

impl Segment {
    fn new(start: V, end: V) -> Self {
        Self {
            start,
            edge: end.subtract(start),
        }
    }

    fn point(self, fraction: f64) -> V {
        self.start.add(self.edge.scale(fraction))
    }

    fn closest(self, point: V) -> f64 {
        let length_sq = self.edge.dot(self.edge);
        if length_sq == 0.0 {
            0.0
        } else {
            (self.edge.dot(point.subtract(self.start)) / length_sq).clamp(0.0, 1.0)
        }
    }
}

/// The constrained quadratic minimum lies either inside the parameter square or on one of its four edges.
fn nearest_segments(first: Segment, second: Segment) -> (f64, f64, V) {
    let base = first.start.subtract(second.start);
    let uu = first.edge.dot(first.edge);
    let vv = second.edge.dot(second.edge);
    let uv = first.edge.dot(second.edge);
    let u_base = first.edge.dot(base);
    let v_base = second.edge.dot(base);
    let area_sq = first.edge.cross(second.edge);
    let denominator = area_sq.dot(area_sq);
    if denominator > 16.0 * f64::EPSILON * uu * vv {
        let along_first = (uv * v_base - vv * u_base) / denominator;
        let along_second = (uu * v_base - uv * u_base) / denominator;
        if (0.0..=1.0).contains(&along_first) && (0.0..=1.0).contains(&along_second) {
            return (
                along_first,
                along_second,
                first
                    .point(along_first)
                    .subtract(second.point(along_second)),
            );
        }
    }
    let mut along_first = first.closest(second.start);
    let mut along_second = 0.0;
    let mut gap = first.point(along_first).subtract(second.start);
    for (a, b) in [
        (first.closest(second.point(1.0)), 1.0),
        (0.0, second.closest(first.start)),
        (1.0, second.closest(first.point(1.0))),
    ] {
        let delta = first.point(a).subtract(second.point(b));
        if delta.dot(delta) < gap.dot(gap) {
            (along_first, along_second, gap) = (a, b, delta);
        }
    }
    (along_first, along_second, gap)
}

struct SegmentContact {
    surface: V,
    first: V,
    second: V,
}

fn contact_edge(
    a: &State,
    b: &State,
    ma: &Material,
    mb: &Material,
    obstacle: &Capsule,
) -> Option<SegmentContact> {
    let strand = Segment::new(a.position, b.position);
    let axis = Segment::new(obstacle.start, obstacle.end);
    let (s, t, gap) = nearest_segments(strand, axis);
    if s == 0.0 || s == 1.0 {
        return None;
    }
    let length = gap.length();
    let overlap = obstacle.radius + ma.radius - length;
    let alpha = ma.inverse_mass * (1.0 - s);
    let beta = mb.inverse_mass * s;
    let inverse = alpha * (1.0 - s) + beta * s;
    if overlap <= 0.0 || inverse == 0.0 {
        return None;
    }
    let fallback = strand.edge.cross(V::X).direction(V::Y);
    let normal = gap.direction(strand.edge.cross(axis.edge).direction(fallback));
    let correction = normal.scale(overlap / inverse);
    Some(SegmentContact {
        surface: axis.point(t).add(normal.scale(obstacle.radius)),
        first: correction.scale(alpha),
        second: correction.scale(beta),
    })
}

fn add_contact(
    a: &mut State,
    b: &mut State,
    scratch: &mut [Scratch],
    index: usize,
    contact: &SegmentContact,
) {
    a.position = a.position.add(contact.first);
    b.position = b.position.add(contact.second);
    let first = slot_mut(scratch, index);
    first.contact = first.contact.add(contact.first);
    let second = slot_mut(scratch, index + 1);
    second.contact = second.contact.add(contact.second);
}

fn edge_contacts(
    nodes: &mut [State],
    material: &[Material],
    scratch: &mut [Scratch],
    obstacles: &[Capsule],
    rigid: &[RigidCapsule],
    hits: &mut [Hit],
    reactions: &mut [Reaction],
    dt: f64,
) {
    for (i, ma) in material.iter().enumerate() {
        if ma.length == 0.0 {
            continue;
        }
        let mb = slot(material, i + 1);
        let (a, b) = pair(nodes, i, i + 1);
        for obstacle in obstacles {
            if let Some(correction) = contact_edge(a, b, ma, mb, obstacle) {
                add_contact(a, b, scratch, i, &correction);
            }
        }
        for (index, obstacle) in rigid.iter().enumerate() {
            if obstacle.row < 0.0 {
                continue;
            }
            if let Some(correction) = contact_edge(a, b, ma, mb, &obstacle.shape) {
                add_contact(a, b, scratch, i, &correction);
                let mut impulse = V::ZERO;
                if ma.inverse_mass > 0.0 {
                    impulse = impulse.add(correction.first.scale(-1.0 / (ma.inverse_mass * dt)));
                    *slot_mut(hits, i) = Hit {
                        collider: index + 1,
                        point: correction.surface,
                    };
                }
                if mb.inverse_mass > 0.0 {
                    impulse = impulse.add(correction.second.scale(-1.0 / (mb.inverse_mass * dt)));
                    *slot_mut(hits, i + 1) = Hit {
                        collider: index + 1,
                        point: correction.surface,
                    };
                }
                transfer(reactions, obstacle, correction.surface, impulse);
            }
        }
    }
}

// The reaction is taken at the capsule surface and reported about the rigid centre of mass.
fn transfer(reactions: &mut [Reaction], body: &RigidCapsule, point: V, impulse: V) {
    let reaction = slot_mut(reactions, body.row as usize);
    reaction.impulse = reaction.impulse.add(impulse);
    reaction.angular = reaction
        .angular
        .add(point.subtract(body.centre).cross(impulse));
}

fn rigid_contact(
    position: &mut V,
    material: &Material,
    bodies: &[RigidCapsule],
    reactions: &mut [Reaction],
    hit: &mut Hit,
    dt: f64,
) -> V {
    if material.inverse_mass == 0.0 {
        return V::ZERO;
    }
    let mut total = V::ZERO;
    for (i, body) in bodies.iter().enumerate() {
        if body.row < 0.0 {
            continue;
        }
        if let Some((surface, correction)) =
            capsule_contact(*position, material.radius, &body.shape)
        {
            *position = position.add(correction);
            total = total.add(correction);
            transfer(
                reactions,
                body,
                surface,
                correction.scale(-1.0 / (material.inverse_mass * dt)),
            );
            hit.collider = i + 1;
            hit.point = surface;
        }
    }
    total
}

fn contact(
    position: &mut V,
    material: &Material,
    environment: &Environment,
    capsules: &[Capsule],
) -> V {
    if material.inverse_mass == 0.0 {
        return V::ZERO;
    }
    let mut normal = V::ZERO;
    let penetration = environment.plane + material.radius - position.dot(environment.ground);
    if penetration > 0.0 && environment.ground.dot(environment.ground) != 0.0 {
        *position = position.add(environment.ground.scale(penetration));
        normal = environment.ground.scale(penetration);
    }
    for obstacle in capsules {
        if let Some((_, correction)) = capsule_contact(*position, material.radius, obstacle) {
            *position = position.add(correction);
            normal = normal.add(correction);
        }
    }
    normal
}

fn slot<T>(items: &[T], at: usize) -> &T {
    items.get(at).unwrap_or_else(|| unreachable())
}
fn slot_mut<T>(items: &mut [T], at: usize) -> &mut T {
    items.get_mut(at).unwrap_or_else(|| unreachable())
}

fn pair<T>(items: &mut [T], a: usize, b: usize) -> (&mut T, &mut T) {
    let (left, right) = items
        .split_at_mut_checked(b)
        .unwrap_or_else(|| unreachable());
    (slot_mut(left, a), slot_mut(right, 0))
}

/// Advances every strand in deterministic authoring order. All pointers name disjoint host-owned world ranges.
#[unsafe(no_mangle)]
unsafe extern "C" fn advance_strands(
    nodes: *mut State,
    material: *const Material,
    environment: *const Environment,
    scratch: *mut Scratch,
    roots: *const Root,
    obstacles: *const Capsule,
    config: *const Advance,
    links: *mut Link,
    buckets: *mut i32,
    count: usize,
    chains: usize,
    colliders: usize,
    bucket_count: usize,
    moving_capsules: *const RigidCapsule,
    moving_count: usize,
    hits: *mut Hit,
    reactions: *mut Reaction,
    reaction_count: usize,
) -> f64 {
    let cfg = unsafe { &*config };
    let nodes = unsafe { core::slice::from_raw_parts_mut(nodes, count) };
    let material = unsafe { core::slice::from_raw_parts(material, count) };
    let env = unsafe { core::slice::from_raw_parts(environment, count) };
    let scratch = unsafe { core::slice::from_raw_parts_mut(scratch, count) };
    let roots = unsafe { core::slice::from_raw_parts(roots, chains) };
    let obstacles = unsafe { core::slice::from_raw_parts(obstacles, colliders) };
    let links = unsafe { core::slice::from_raw_parts_mut(links, count) };
    let buckets = unsafe { core::slice::from_raw_parts_mut(buckets, bucket_count) };
    let bodies = unsafe { core::slice::from_raw_parts(moving_capsules, moving_count) };
    let reactions = unsafe { core::slice::from_raw_parts_mut(reactions, reaction_count) };
    let hits =
        unsafe { core::slice::from_raw_parts_mut(hits, if bodies.is_empty() { 0 } else { count }) };
    for hit in hits.iter_mut() {
        hit.collider = 0;
    }
    let dt = cfg.dt;
    for (i, node) in nodes.iter_mut().enumerate() {
        let rest = slot(material, i);
        let air = slot(env, i);
        *slot_mut(scratch, i) = Scratch {
            old: *node,
            correction: V::ZERO,
            shear: V::ZERO,
            bend: V::ZERO,
            contact: V::ZERO,
        };
        if rest.inverse_mass > 0.0 {
            let relative = node
                .velocity
                .scale(cfg.retention)
                .add(cfg.gravity.scale(dt))
                .subtract(air.wind);
            node.velocity = air
                .wind
                .add(relative.scale(1.0 / (1.0 + dt * air.drag * relative.length())));
            node.position = node.position.add(node.velocity.scale(dt));
        }
        if rest.inverse_bend > 0.0 {
            node.frame = node.frame.advance(node.spin.scale(cfg.retention), dt);
        }
    }
    for root in roots {
        let at = root.start as usize;
        let first = slot_mut(nodes, at);
        first.position = root.position;
        first.frame = root.frame;
    }
    let iterations = cfg.iterations as usize;
    let contacts = cfg.contact_flags as u8;
    let mut checked = 0.0;
    if iterations == 0 {
        for root in roots {
            let start = root.start as usize;
            for i in start + 1..start + root.count as usize {
                let edge = slot(material, i - 1);
                let (previous, current) = pair(nodes, i - 1, i);
                let predicted = current.position;
                slot_mut(scratch, i).contact = contact(
                    &mut current.position,
                    slot(material, i),
                    slot(env, i),
                    obstacles,
                );
                let direction = current
                    .position
                    .subtract(previous.position)
                    .direction(previous.frame.rotate(V::Z));
                let direction = ground_direction(
                    direction,
                    previous.position,
                    edge.length,
                    slot(material, i).radius,
                    slot(env, i),
                );
                current.position = previous.position.add(direction.scale(edge.length));
                previous.frame = previous.frame.toward(direction);
                slot_mut(scratch, i).correction = current.position.subtract(predicted);
            }
        }
    } else {
        for _ in 0..iterations {
            for root in roots {
                let start = root.start as usize;
                let end = start + root.count as usize;
                for i in start..end - 1 {
                    let (a, b) = pair(nodes, i, i + 1);
                    let ma = slot(material, i);
                    let mb = slot(material, i + 1);
                    let state = slot_mut(scratch, i);
                    shear_constraint(a, b, ma, mb, &mut state.shear, dt);
                    if i + 2 < end {
                        bend_constraint(a, b, ma, mb, &mut state.bend, dt);
                    }
                }
            }
            for (i, node) in nodes.iter_mut().enumerate() {
                let state = slot_mut(scratch, i);
                state.contact = state.contact.add(contact(
                    &mut node.position,
                    slot(material, i),
                    slot(env, i),
                    obstacles,
                ));
                if !bodies.is_empty() {
                    state.contact = state.contact.add(rigid_contact(
                        &mut node.position,
                        slot(material, i),
                        bodies,
                        reactions,
                        slot_mut(hits, i),
                        dt,
                    ));
                }
            }
            if contacts & 2 != 0 {
                edge_contacts(
                    nodes, material, scratch, obstacles, bodies, hits, reactions, dt,
                );
            }
            if contacts & 1 != 0 {
                checked += self_contacts(nodes, material, scratch, links, buckets, cfg.grid_size);
            }
        }
    }
    for root in roots {
        let start = root.start as usize;
        let end = start + root.count as usize;
        for i in start..end {
            let node = slot_mut(nodes, i);
            let last = slot(scratch, i);
            let follower = if iterations == 0 && i + 1 < end && i > start {
                slot(scratch, i + 1).correction.scale(cfg.follow_damping)
            } else {
                V::ZERO
            };
            node.velocity = node
                .position
                .subtract(last.old.position)
                .subtract(follower)
                .scale(1.0 / dt);
            let correction = last.contact.length();
            if correction > 0.0 {
                let normal = last.contact.scale(1.0 / correction);
                let hit = if bodies.is_empty() {
                    None
                } else {
                    hits.get(i).filter(|hit| hit.collider != 0)
                };
                let wall = hit
                    .map(|hit| {
                        let body = slot(bodies, hit.collider - 1);
                        body.velocity
                            .add(body.angular.cross(hit.point.subtract(body.centre)))
                    })
                    .unwrap_or(V::ZERO);
                let prior = node.velocity;
                let relative = if hit.is_some() {
                    prior.subtract(wall)
                } else {
                    prior
                };
                let speed = relative.dot(normal);
                let tangent = relative.subtract(normal.scale(speed));
                let limit = cfg.friction * (correction / dt);
                let retained = (1.0 - limit / tangent.length()).max(0.0);
                node.velocity = tangent.scale(retained).add(normal.scale(speed.max(0.0)));
                if let Some(hit) = hit {
                    node.velocity = node.velocity.add(wall);
                    let mass = 1.0 / slot(material, i).inverse_mass;
                    transfer(
                        reactions,
                        slot(bodies, hit.collider - 1),
                        hit.point,
                        prior.subtract(node.velocity).scale(mass),
                    );
                }
            }
            let difference = node.frame.mul(last.old.frame.conjugate());
            let sign = if difference.w < 0.0 { -1.0 } else { 1.0 };
            node.spin = difference.v.scale(2.0 * sign / dt);
        }
    }
    checked
}
