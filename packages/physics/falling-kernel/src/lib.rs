//! Andersen, Pesavento and Wang's quasi-steady plate equations use one fixed inertial plane.
//! Motion along its span is independent. Rounded grains use isotropic drag.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;
use core::f64::consts::{PI, TAU};

use margoengine_physics_kernel_common::pinned;

// The pinned-math crate contains optional allocating routines. This module
// only links its scalar arithmetic. Any future allocation must use the arena.
struct NoAllocation;

unsafe impl core::alloc::GlobalAlloc for NoAllocation {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }

    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

#[global_allocator]
static ALLOCATOR: NoAllocation = NoAllocation;

#[repr(C)]
struct Model {
    gravity_x: f64,
    gravity_y: f64,
    gravity_z: f64,
    mass: f64,
    volume: f64,
    side_drag_area: f64,
    semi_chord: f64,
    semi_thickness: f64,
    span: f64,
    inertia: f64,
    translational_lift: f64,
    rotational_lift: f64,
    edge_drag: f64,
    face_drag: f64,
    spin_drag_linear: f64,
    spin_drag_quadratic: f64,
    section_start: f64,
    section_count: f64,
    potential_lift: f64,
    vortex_lift: f64,
    profile_drag: f64,
    induced_drag: f64,
}

#[repr(C)]
struct Section {
    radius: f64,
    area: f64,
    sin_pitch: f64,
    cos_pitch: f64,
    sin_azimuth: f64,
    cos_azimuth: f64,
}

#[repr(C)]
struct Air {
    x: f64,
    y: f64,
    z: f64,
    density: f64,
    sphere_drag_area: f64,
}

#[derive(Copy, Clone)]
#[repr(C, packed(8))]
struct State {
    // Interleaved plane pairs and pairs advanced by the same RK weights.
    position: v128,
    velocity: v128,
    pitch: v128, // angle, angular velocity
    span: v128,  // position, velocity
}

#[derive(Copy, Clone)]
struct Coefficients {
    mass_x: f64,
    mass_y: f64,
    mass_difference: f64,
    inertia: f64,
    gravity_x: f64,
    gravity_y: f64,
    gravity_z: f64,
    drag: f64,
    side_drag: f64,
    linear_damping: f64,
    quadratic_damping: f64,
    rho_span: f64,
}

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

#[inline]
fn pair(x: f64, y: f64) -> v128 {
    f64x2_replace_lane::<1>(f64x2_splat(x), y)
}

#[inline]
fn scale(value: v128, weight: f64) -> v128 {
    f64x2_mul(value, f64x2_splat(weight))
}

#[inline]
fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

#[inline]
fn length(x: f64, y: f64, z: f64) -> f64 {
    let high = x.abs().max(y.abs()).max(z.abs());
    if high == 0.0 {
        return 0.0;
    }
    let (x, y, z) = (x / high, y / high, z / high);
    high * sqrt(x * x + y * y + z * z)
}

impl State {
    #[inline]
    fn offset(self, other: Self, weight: f64) -> Self {
        Self {
            position: f64x2_add(self.position, scale(other.position, weight)),
            velocity: f64x2_add(self.velocity, scale(other.velocity, weight)),
            pitch: f64x2_add(self.pitch, scale(other.pitch, weight)),
            span: f64x2_add(self.span, scale(other.span, weight)),
        }
    }

    #[inline]
    fn finite(self) -> bool {
        fn finite_pair(value: v128) -> bool {
            f64x2_extract_lane::<0>(value).is_finite() && f64x2_extract_lane::<1>(value).is_finite()
        }
        finite_pair(self.position)
            && finite_pair(self.velocity)
            && finite_pair(self.pitch)
            && finite_pair(self.span)
    }
}

fn coefficients(model: &Model, air: &Air) -> Coefficients {
    let chord2 = model.semi_chord * model.semi_chord;
    let thickness2 = model.semi_thickness * model.semi_thickness;
    let rho_span = air.density * model.span;
    let added_x = PI * rho_span * thickness2;
    let added_y = PI * rho_span * chord2;
    let delta = chord2 - thickness2;
    let added_inertia = PI * rho_span * delta * delta / 8.0;
    let moving_weight = model.mass - air.density * model.volume;
    let gravity = length(model.gravity_x, model.gravity_y, 0.0);
    let time_scale = if rho_span > 0.0 && model.semi_chord > 0.0 {
        sqrt(moving_weight.abs() * gravity / (PI * rho_span * model.semi_chord)) / model.semi_chord
    } else {
        0.0
    };
    let damping = PI * rho_span * chord2 * chord2;
    Coefficients {
        mass_x: model.mass + added_x,
        mass_y: model.mass + added_y,
        mass_difference: added_y - added_x,
        inertia: model.inertia + added_inertia,
        gravity_x: moving_weight * model.gravity_x,
        gravity_y: moving_weight * model.gravity_y,
        gravity_z: moving_weight * model.gravity_z,
        drag: model.semi_chord * rho_span,
        side_drag: 0.5
            * air.density
            * if model.semi_chord == 0.0 {
                air.sphere_drag_area
            } else {
                model.side_drag_area
            },
        linear_damping: damping * model.spin_drag_linear * time_scale,
        quadratic_damping: damping * model.spin_drag_quadratic,
        rho_span,
    }
}

// Rezgui, Hernández Arroyo and Theunissen (2020), equations 7, 11–18
// and 20–23. Relative translation contributes to each blade's inflow.
// Folding the polar through the chord extends it to both flow directions.
fn samara_force(
    model: &Model,
    sections: &[Section],
    density: f64,
    angle: f64,
    spin: f64,
    relative: [f64; 3],
) -> (f64, f64, f64, f64) {
    let (sin, cos) = (pinned::sin(angle), pinned::cos(angle));
    let [rx, ry, rz] = relative;
    let mut fx = 0.0;
    let mut fy = 0.0;
    let mut fz = 0.0;
    let mut torque = 0.0;
    for section in sections {
        let tangent_x = -(sin * section.cos_azimuth + cos * section.sin_azimuth);
        let tangent_y = cos * section.cos_azimuth - sin * section.sin_azimuth;
        let tangential = tangent_x * rx + tangent_y * ry + section.radius * spin;
        let speed = length(tangential, rz, 0.0);
        if speed == 0.0 {
            continue;
        }
        let sin_flow = -rz / speed;
        let cos_flow = tangential / speed;
        let sin_attack = section.sin_pitch * cos_flow + section.cos_pitch * sin_flow;
        let cos_attack = section.cos_pitch * cos_flow - section.sin_pitch * sin_flow;
        let normal = model.potential_lift * cos_attack.abs() + model.vortex_lift * sin_attack.abs();
        let lift = normal * sin_attack * cos_attack;
        // Cancels cos(alpha) before evaluating CL tan(alpha) at broadside.
        let drag = model.profile_drag + model.induced_drag * normal * sin_attack * sin_attack;
        let pressure_area = 0.5 * density * speed * speed * section.area;
        let side = pressure_area * (lift * sin_flow - drag * cos_flow);
        fx += side * tangent_x;
        fy += side * tangent_y;
        fz += pressure_area * (lift * cos_flow + drag * sin_flow);
        torque += side * section.radius;
    }
    (fx, fy, fz, torque)
}

#[inline]
fn derivative(
    state: State,
    model: &Model,
    sections: &[Section],
    air: &Air,
    c: &Coefficients,
) -> State {
    let vx = f64x2_extract_lane::<0>(state.velocity);
    let vy = f64x2_extract_lane::<1>(state.velocity);
    let vz = f64x2_extract_lane::<1>(state.span);
    let omega = f64x2_extract_lane::<1>(state.pitch);
    let (rx, ry, rz) = (vx - air.x, vy - air.y, vz - air.z);
    let (acceleration, az, omega_dot) = if !sections.is_empty() {
        let angle = f64x2_extract_lane::<0>(state.pitch) % TAU;
        let (fx, fy, fz, torque) =
            samara_force(model, sections, air.density, angle, omega, [rx, ry, rz]);
        (
            pair(
                (c.gravity_x + fx) / model.mass,
                (c.gravity_y + fy) / model.mass,
            ),
            (c.gravity_z + fz) / model.mass,
            torque / model.inertia,
        )
    } else if model.semi_chord == 0.0 {
        let drag = c.side_drag * length(rx, ry, rz);
        (
            pair(
                (c.gravity_x - drag * rx) / model.mass,
                (c.gravity_y - drag * ry) / model.mass,
            ),
            (c.gravity_z - drag * rz) / model.mass,
            0.0,
        )
    } else {
        let angle = f64x2_extract_lane::<0>(state.pitch) % TAU;
        let (sin, cos) = (pinned::sin(angle), pinned::cos(angle));
        let ux = cos * rx + sin * ry;
        let uy = -sin * rx + cos * ry;
        let speed = length(ux, uy, 0.0);
        let (sin_alpha, cos_alpha) = if speed == 0.0 {
            (0.0, 0.0)
        } else {
            (uy / speed, ux / speed)
        };
        let drag = c.drag
            * speed
            * (model.edge_drag * cos_alpha * cos_alpha + model.face_drag * sin_alpha * sin_alpha);
        let chord = model.semi_chord;
        let circulation = -2.0 * model.translational_lift * chord * ux * sin_alpha
            + 2.0 * model.rotational_lift * chord * chord * omega;
        let lift = c.rho_span * circulation;
        // APW (3.1–3.3) in the fixed plane. Adding the rotating-basis
        // derivative cancels the dry mass in the two angular cross terms.
        let ax = ((c.mass_difference * omega - lift) * uy + cos * c.gravity_x + sin * c.gravity_y
            - drag * ux)
            / c.mass_x;
        let ay = ((c.mass_difference * omega + lift) * ux - sin * c.gravity_x + cos * c.gravity_y
            - drag * uy)
            / c.mass_y;
        let torque = -c.mass_difference * ux * uy
            - (c.linear_damping + c.quadratic_damping * omega.abs()) * omega;
        (
            pair(cos * ax - sin * ay, sin * ax + cos * ay),
            (c.gravity_z - c.side_drag * rz.abs() * rz) / model.mass,
            torque / c.inertia,
        )
    };

    State {
        position: state.velocity,
        velocity: acceleration,
        pitch: pair(omega, omega_dot),
        span: pair(vz, az),
    }
}

fn rk4(
    state: State,
    model: &Model,
    sections: &[Section],
    air: &Air,
    c: &Coefficients,
    dt: f64,
) -> State {
    let a = derivative(state, model, sections, air, c);
    let b = derivative(state.offset(a, dt * 0.5), model, sections, air, c);
    let c_stage = derivative(state.offset(b, dt * 0.5), model, sections, air, c);
    let d = derivative(state.offset(c_stage, dt), model, sections, air, c);
    let slopes = a.offset(b, 2.0).offset(c_stage, 2.0).offset(d, 1.0);
    state.offset(slopes, dt / 6.0)
}

#[inline]
fn acceptable(full: State, half: State) -> bool {
    // RK4 step doubling: the half-step solution's local defect is about 1/15
    // of the difference from a full step, including unwrapped orientation.
    fn near(full: v128, half: v128, floor: v128) -> bool {
        let error = f64x2_abs(f64x2_sub(half, full));
        let limit = scale(f64x2_max(f64x2_abs(half), floor), 15e-8);
        i64x2_all_true(f64x2_le(error, limit))
    }
    half.finite()
        && near(full.velocity, half.velocity, f64x2_splat(1.0))
        && near(full.pitch, half.pitch, f64x2_splat(1.0))
        && near(full.span, half.span, f64x2_splat(1.0))
        && near(full.position, half.position, f64x2_splat(1.0))
}

fn advance(
    mut state: State,
    model: &Model,
    sections: &[Section],
    air: &Air,
    dt: f64,
) -> Option<State> {
    let c = coefficients(model, air);
    if ![
        c.mass_x,
        c.mass_y,
        c.mass_difference,
        c.inertia,
        c.gravity_x,
        c.gravity_y,
        c.gravity_z,
        c.drag,
        c.side_drag,
        c.linear_damping,
        c.quadratic_damping,
        c.rho_span,
    ]
    .into_iter()
    .all(f64::is_finite)
    {
        return None;
    }
    let mut remaining = dt;
    let mut step = dt;
    while remaining > 0.0 {
        let middle = rk4(state, model, sections, air, &c, step * 0.5);
        let half = rk4(middle, model, sections, air, &c, step * 0.5);
        if acceptable(rk4(state, model, sections, air, &c, step), half) {
            state = half;
            let angle = f64x2_extract_lane::<0>(state.pitch);
            state.pitch = f64x2_replace_lane::<0>(state.pitch, angle % TAU);
            remaining -= step;
            step = (step * 2.0).min(remaining);
        } else {
            step *= 0.5;
        }
        if remaining > 0.0 && remaining - step == remaining {
            return None;
        }
    }
    Some(state)
}

/// Returns the first failed row plus one, or zero after a complete batch.
/// Inputs and output are distinct arena regions. The caller only commits a
/// completed batch and validates the flow samples before this call.
#[unsafe(no_mangle)]
unsafe extern "C" fn falling_step(
    models: *const Model,
    sections: *const Section,
    air: *const Air,
    current: *const State,
    next: *mut State,
    count: u32,
    dt: f64,
) -> u32 {
    for index in 0..count as usize {
        unsafe {
            let model = &*models.add(index);
            let blade = core::slice::from_raw_parts(
                sections.add(model.section_start as usize),
                model.section_count as usize,
            );
            let Some(value) = advance(*current.add(index), model, blade, &*air.add(index), dt)
            else {
                return index as u32 + 1;
            };
            next.add(index).write(value);
        }
    }
    0
}
