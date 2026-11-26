#![no_std]

use core::arch::wasm32::unreachable;

mod grid;
mod layer;
mod material;
mod tensor;
mod wake;

fn at<T>(items: &[T], index: usize) -> &T {
    items.get(index).unwrap_or_else(|| unreachable())
}

fn at_mut<T>(items: &mut [T], index: usize) -> &mut T {
    items.get_mut(index).unwrap_or_else(|| unreachable())
}

fn used_prefix<T>(items: &[T], length: usize) -> &[T] {
    items.get(..length).unwrap_or_else(|| unreachable())
}

use grid::Node;
use material::Material;
use tensor::{M, Spectrum, V, ZERO, add, apply, dot, scale, sqrt, sub};

struct ArenaOnly;

unsafe impl core::alloc::GlobalAlloc for ArenaOnly {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }

    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

#[global_allocator]
static NO_HEAP: ArenaOnly = ArenaOnly;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    position: V,
    velocity: V,
    affine: M,
    elastic: M,
    mass: f64,
    rest_volume: f64,
    plastic: f64,
    material: f64,
}

#[repr(C)]
struct Control {
    gravity: V,
    spacing: f64,
    friction: f64,
    affine: f64,
}

#[repr(C)]
struct Plane {
    normal: V,
    offset: f64,
}

fn speed_squared(point: &Point, velocity: V, wave: &Material, spacing: f64) -> f64 {
    let (mu, lambda) = wave.moduli(point.plastic);
    let inverse_density = point.rest_volume / point.mass;
    let wave_speed = sqrt((2.0 * mu + lambda) * inverse_density);
    let affine_norm = sqrt(point.affine.iter().map(|&v| dot(v, v)).sum());
    let speed = sqrt(dot(velocity, velocity)) + 1.5 * spacing * affine_norm + wave_speed;
    speed * speed
}

fn valid_position(position: V, spacing: f64) -> bool {
    position
        .iter()
        .all(|&value| (value / spacing).abs() < i32::MAX as f64 / 2.0)
}

#[unsafe(no_mangle)]
unsafe extern "C" fn mpm_scatter(
    points: *const Point,
    count: usize,
    models: *const Material,
    model_count: usize,
    nodes: *mut Node,
    slots: usize,
    active: *mut u32,
    control: *const Control,
    dt: f64,
    kicks: *const V,
    driven: i32,
) -> i32 {
    let points = unsafe { core::slice::from_raw_parts(points, count) };
    let kicks = unsafe { core::slice::from_raw_parts(kicks, if driven == 0 { 0 } else { count }) };
    let materials = unsafe { core::slice::from_raw_parts(models, model_count) };
    let nodes = unsafe { core::slice::from_raw_parts_mut(nodes, slots) };
    let active = unsafe { core::slice::from_raw_parts_mut(active, count * 27) };
    let control = unsafe { &*control };
    let factor = 4.0 / (control.spacing * control.spacing);
    let mut used = 0;
    for (i, point) in points.iter().enumerate() {
        let velocity = add(point.velocity, kicks.get(i).copied().unwrap_or(ZERO));
        let material = at(materials, point.material as usize);
        let test = dt / control.spacing;
        if speed_squared(point, velocity, material, control.spacing) * test * test > 0.16 {
            grid::clear(nodes, used_prefix(active, used));
            return -1;
        }
        if !valid_position(point.position, control.spacing) {
            grid::clear(nodes, used_prefix(active, used));
            return -2;
        }
        let Some(frame) = Spectrum::of(point.elastic) else {
            grid::clear(nodes, used_prefix(active, used));
            return -3;
        };
        let stress = material.stress(&frame, point.plastic);
        let scale_stress = -dt * point.rest_volume * factor;
        let transfer = core::array::from_fn(|i| {
            add(
                scale(point.affine[i], point.mass * control.affine),
                scale(stress[i], scale_stress),
            )
        });
        let momentum = scale(velocity, point.mass);
        grid::stencil(
            point.position,
            control.spacing,
            |coord, weight, distance| {
                grid::deposit(
                    nodes,
                    active,
                    &mut used,
                    coord,
                    point.mass * weight,
                    scale(add(momentum, apply(transfer, distance)), weight),
                );
            },
        );
    }
    used as i32
}

fn collide(velocity: V, position: V, plane: &Plane, dt: f64, friction: f64) -> V {
    let normal_speed = dot(velocity, plane.normal);
    if normal_speed >= 0.0 || dot(position, plane.normal) - plane.offset + normal_speed * dt >= 0.0
    {
        return velocity;
    }
    let tangent = sub(velocity, scale(plane.normal, normal_speed));
    let speed = sqrt(dot(tangent, tangent));
    let retain = if speed == 0.0 {
        0.0
    } else {
        (1.0 + friction * normal_speed / speed).max(0.0)
    };
    scale(tangent, retain)
}

#[unsafe(no_mangle)]
unsafe extern "C" fn mpm_move(
    points: *mut Point,
    next: *mut Point,
    count: usize,
    models: *const Material,
    model_count: usize,
    nodes: *mut Node,
    slots: usize,
    active: *const u32,
    used: usize,
    planes: *const Plane,
    control: *const Control,
    dt: f64,
) -> i32 {
    let points = unsafe { core::slice::from_raw_parts_mut(points, count) };
    let next = unsafe { core::slice::from_raw_parts_mut(next, count) };
    let materials = unsafe { core::slice::from_raw_parts(models, model_count) };
    let nodes = unsafe { core::slice::from_raw_parts_mut(nodes, slots) };
    let active = unsafe { core::slice::from_raw_parts(active, used) };
    let planes = unsafe { core::slice::from_raw_parts(planes, used) };
    let control = unsafe { &*control };
    let factor = 4.0 / (control.spacing * control.spacing);
    for (index, plane) in active.iter().zip(planes) {
        let node = at_mut(nodes, *index as usize);
        let velocity = add(
            scale(node.momentum, 1.0 / node.mass),
            scale(control.gravity, dt),
        );
        let position = node.coord.map(|axis| axis as f64 * control.spacing);
        node.momentum = collide(velocity, position, plane, dt, control.friction);
    }
    for (point, candidate) in points.iter().zip(next.iter_mut()) {
        let mut velocity = ZERO;
        let mut gradient = [ZERO; 3];
        grid::stencil(point.position, control.spacing, |coord, weight, offset| {
            let sample = scale(grid::gather(nodes, coord), weight);
            velocity = add(velocity, sample);
            for i in 0..3 {
                gradient[i] = add(gradient[i], scale(sample, factor * offset[i]));
            }
        });
        let mut advance = gradient.map(|axis| scale(axis, dt));
        for i in 0..3 {
            advance[i][i] += 1.0;
        }
        let deformation = point.elastic.map(|axis| apply(advance, axis));
        let position = add(point.position, scale(velocity, dt));
        if !valid_position(position, control.spacing) {
            return -2;
        }
        let Some(trial) = Spectrum::of(deformation) else {
            return -3;
        };
        let (elastic, plastic) =
            at(materials, point.material as usize).project(&trial, point.plastic, dt);
        *candidate = Point {
            position,
            velocity,
            affine: gradient,
            elastic: trial.rebuild(elastic),
            plastic: point.plastic + plastic,
            ..*point
        };
    }
    points.copy_from_slice(next);
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn mpm_clear(nodes: *mut Node, slots: usize, active: *const u32, used: usize) {
    let nodes = unsafe { core::slice::from_raw_parts_mut(nodes, slots) };
    let active = unsafe { core::slice::from_raw_parts(active, used) };
    grid::clear(nodes, active);
}
