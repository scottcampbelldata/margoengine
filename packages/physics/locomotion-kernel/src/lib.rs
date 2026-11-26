#![no_std]

use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_sqrt};
use core::f64::consts::{PI, TAU};
use core::panic::PanicInfo;
use core::slice;
use margoengine_physics_kernel_common::pinned::{cos, sin};

type V = [f64; 3];
type Q = [f64; 4];
const ZERO: V = [0.0; 3];
const UP: V = [0.0, 1.0, 0.0];
const FORWARD: V = [0.0, 0.0, 1.0];

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

fn scale(v: V, s: f64) -> V {
    [v[0] * s, v[1] * s, v[2] * s]
}

fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: V, b: V) -> f64 {
    let xz = f64x2_mul(f64x2(a[0], a[2]), f64x2(b[0], b[2]));
    f64x2_extract_lane::<0>(xz) + a[1] * b[1] + f64x2_extract_lane::<1>(xz)
}

fn cross(a: V, b: V) -> V {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2(x, x)))
}

fn norm(v: V) -> f64 {
    sqrt(dot(v, v))
}

fn unit(v: V, if_zero: V) -> V {
    let length = norm(v);
    if length > 0.0 {
        scale(v, 1.0 / length)
    } else {
        if_zero
    }
}

fn wrap(phase: f64) -> f64 {
    phase - f64x2_extract_lane::<0>(f64x2_floor(f64x2(phase, 0.0)))
}

fn tangent(v: V, normal: V) -> V {
    sub(v, scale(normal, dot(v, normal)))
}

fn rotate(v: V, q: Q) -> V {
    let axis = [q[0], q[1], q[2]];
    let twice_cross = scale(cross(axis, v), 2.0);
    add(v, add(scale(twice_cross, q[3]), cross(axis, twice_cross)))
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Body {
    position: V,
    velocity: V,
    rotation: Q,
    momentum: V,
    phase: f64,
}

impl Body {
    fn advance(&mut self, acceleration: V, torque: V, inertia: f64, shape_spin: V, dt: f64) {
        self.velocity = add(self.velocity, scale(acceleration, dt));
        self.position = add(self.position, scale(self.velocity, dt));
        self.momentum = add(self.momentum, scale(torque, dt));
        let omega = scale(sub(self.momentum, shape_spin), 1.0 / inertia);
        let qv = [self.rotation[0], self.rotation[1], self.rotation[2]];
        let next = add(
            qv,
            scale(
                add(cross(omega, qv), scale(omega, self.rotation[3])),
                0.5 * dt,
            ),
        );
        let scalar = self.rotation[3] - 0.5 * dt * dot(omega, qv);
        let length = sqrt(dot(next, next) + scalar * scalar);
        self.rotation = [
            next[0] / length,
            next[1] / length,
            next[2] / length,
            scalar / length,
        ];
    }

    fn finite(&self) -> bool {
        self.position
            .iter()
            .chain(&self.velocity)
            .chain(&self.rotation)
            .chain(&self.momentum)
            .all(|value| value.is_finite())
    }
}

#[repr(C)]
struct Profile {
    snake: f64,
    mass: f64,
    inertia: f64,
    stiffness: f64,
    damping: f64,
    friction: f64,
    frequency: f64,
    size: f64,
    stride: f64,
    swing: f64,
    duty: f64,
    direction: V,
    angle: f64,
    waves: f64,
    sideways_friction: f64,
    reverse_friction: f64,
    slip_speed: f64,
    push: f64,
    placement: f64,
    body_radius: f64,
    traction: f64,
    posture: f64,
    heading: [f64; 2],
    target_speed: f64,
    external_force: V,
    lean: f64,
    support_velocity: V,
}

#[repr(C)]
struct Actuator {
    hip: V,
    rest: V,
    phase: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Anchor {
    x: f64,
    z: f64,
    planted: f64,
}

#[repr(C)]
struct Geometry {
    point: V,
    internal_velocity: V,
    axis: V,
    normal: V,
    elevation: f64,
    stance: f64,
    phase: f64,
}

#[repr(C)]
struct Contact {
    point: V,
    axis: V,
    force: V,
    stance: f64,
    couple: V,
}

/// Prescribed midpoint tangents give an inextensible chain. Center positions
/// and prescribed velocities separately to keep the net internal linear momentum zero.
fn chain(body: &Body, profile: &Profile, geometry: &mut [Geometry]) {
    let parts = geometry.len() as f64;
    let spacing = profile.size / parts;
    let mut point = ZERO;
    let mut velocity = ZERO;
    let mut centre = ZERO;
    let mut mean_velocity = ZERO;
    for (index, link) in geometry.iter_mut().enumerate() {
        let arc = (index as f64 + 0.5) / parts;
        let argument = TAU * wrap(body.phase + profile.waves * arc);
        let angle = profile.angle * sin(argument);
        let axis = [sin(angle), 0.0, cos(angle)];
        let angular_speed = TAU * profile.frequency * profile.angle * cos(argument);
        let derivative = scale([axis[2], 0.0, -axis[0]], spacing * angular_speed);
        let displacement = scale(axis, spacing);
        let middle = add(point, scale(displacement, 0.5));
        let middle_velocity = add(velocity, scale(derivative, 0.5));
        link.point = middle;
        link.internal_velocity = middle_velocity;
        link.axis = rotate(axis, body.rotation);
        centre = add(centre, middle);
        mean_velocity = add(mean_velocity, middle_velocity);
        point = add(point, displacement);
        velocity = add(velocity, derivative);
    }

    let centre = scale(centre, 1.0 / parts);
    let mean_velocity = scale(mean_velocity, 1.0 / parts);
    for link in geometry {
        link.point = add(
            body.position,
            rotate(sub(link.point, centre), body.rotation),
        );
        link.internal_velocity = rotate(sub(link.internal_velocity, mean_velocity), body.rotation);
    }
}

fn desired_velocity(profile: &Profile) -> V {
    let [sin_half, cos_half] = profile.heading;
    let forward = [
        2.0 * sin_half * cos_half,
        0.0,
        1.0 - 2.0 * sin_half * sin_half,
    ];
    let side = [forward[2], 0.0, -forward[0]];
    let local = scale(
        add(
            scale(side, profile.direction[0]),
            scale(forward, profile.direction[2]),
        ),
        profile.target_speed,
    );
    add(
        local,
        [
            profile.support_velocity[0],
            0.0,
            profile.support_velocity[2],
        ],
    )
}

fn feet(
    body: &Body,
    profile: &Profile,
    actuators: &[Actuator],
    anchors: &[Anchor],
    geometry: &mut [Geometry],
) {
    let (torso, feet) = geometry.split_last_mut().unwrap();
    torso.point = body.position;
    torso.axis = rotate(FORWARD, body.rotation);
    let forward = unit(tangent(torso.axis, UP), FORWARD);
    let side = [forward[2], 0.0, -forward[0]];
    let desired = desired_velocity(profile);
    let actual = [
        body.velocity[0] - profile.support_velocity[0],
        0.0,
        body.velocity[2] - profile.support_velocity[2],
    ];
    let relative_target = sub(
        desired,
        [
            profile.support_velocity[0],
            0.0,
            profile.support_velocity[2],
        ],
    );
    let stance_seconds = if profile.frequency > 0.0 {
        profile.duty / profile.frequency
    } else {
        0.0
    };
    // Raibert's touchdown captures both horizontal components. Reach comes
    // from the nominal shaft length and its supported vertical component.
    let tracking = scale(sub(actual, relative_target), profile.placement);
    let reach = profile.size * sqrt(1.0 - 0.87 * 0.87);
    for ((leg, anchor), foot) in actuators.iter().zip(anchors).zip(feet) {
        let phase = wrap(body.phase + leg.phase);
        let stance = phase < profile.duty;
        let swing_phase = ((phase - profile.duty) / (1.0 - profile.duty)).max(0.0);
        let neutral = 0.5 - if stance { phase / profile.duty } else { 0.0 };
        let adjustment = add(scale(actual, stance_seconds * neutral), tracking);
        let shift = scale(unit(adjustment, ZERO), norm(adjustment).min(reach));
        let rest = add(scale(side, leg.rest[0]), scale(forward, leg.rest[2]));
        foot.point = add(add(body.position, rest), shift);
        if stance && anchor.planted == 1.0 {
            foot.point[0] = anchor.x;
            foot.point[2] = anchor.z;
        } else if !stance && anchor.planted != 0.0 {
            let smooth = swing_phase * swing_phase * (3.0 - 2.0 * swing_phase);
            foot.point[0] = anchor.x + (foot.point[0] - anchor.x) * smooth;
            foot.point[2] = anchor.z + (foot.point[2] - anchor.z) * smooth;
        }
        foot.internal_velocity = [0.0, profile.swing * sin(PI * swing_phase), 0.0];
        foot.axis = forward;
        foot.stance = if stance { 1.0 } else { 0.0 };
        foot.phase = phase / profile.duty;
    }
}

/// Pass disjoint leases allocated by the host with exactly `count` geometry,
/// actuator and anchor rows. No host call or allocation occurs inside either export.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn locomotion_prepare(
    body: *const Body,
    profile: *const Profile,
    actuator: *const Actuator,
    anchors: *const Anchor,
    geometry: *mut Geometry,
    count: usize,
) {
    let (body, profile) = unsafe { (&*body, &*profile) };
    let geometry = unsafe { slice::from_raw_parts_mut(geometry, count) };
    if profile.snake != 0.0 {
        chain(body, profile, geometry);
    } else {
        let actuators = unsafe { slice::from_raw_parts(actuator, count) };
        let anchors = unsafe { slice::from_raw_parts(anchors, count) };
        feet(body, profile, actuators, anchors, geometry);
    }
}

fn snake_inertia(body: &Body, profile: &Profile, shape: &[Geometry]) -> (f64, V) {
    let element_mass = profile.mass / shape.len() as f64;
    let mut inertia = profile.inertia;
    let mut shape_spin = 0.0;
    for element in shape {
        let arm = sub(element.point, body.position);
        inertia += element_mass * dot(arm, arm);
        shape_spin += element_mass * cross(arm, element.internal_velocity)[1];
    }
    (inertia, [0.0, shape_spin, 0.0])
}

fn snake_contact(body: &Body, profile: &Profile, g: &Geometry, velocity: V, parts: f64) -> V {
    let normal = g.normal;
    let penetration = profile.stride - (g.point[1] - g.elevation) * normal[1];
    if penetration <= 0.0 {
        return ZERO;
    }
    let arm = sub(g.point, body.position);
    let slip = add(
        add(body.velocity, cross(velocity, arm)),
        g.internal_velocity,
    );
    let normal_load =
        ((profile.stiffness * penetration - profile.damping * dot(slip, normal)) / parts).max(0.0);
    let tangent_slip = tangent(slip, normal);
    let movement = scale(
        tangent_slip,
        1.0 / norm(tangent_slip).max(profile.slip_speed),
    );
    let forward = unit(tangent(g.axis, normal), g.axis);
    let side = cross(normal, forward);
    let along = dot(movement, forward);
    let coefficient = if along >= 0.0 {
        profile.friction
    } else {
        profile.reverse_friction
    };
    // Hu et al. Eq. (2): both anisotropic terms use the same ground-tangent slip direction.
    let friction = add(
        scale(forward, coefficient * along),
        scale(side, profile.sideways_friction * dot(movement, side)),
    );
    scale(sub(normal, friction), normal_load)
}

fn torso_contact(body: &Body, profile: &Profile, torso: &Geometry, count: f64) -> V {
    let normal = torso.normal;
    let compression = profile.body_radius - (body.position[1] - torso.elevation) * normal[1];
    if compression <= 0.0 {
        return ZERO;
    }
    let load = (profile.stiffness * compression - profile.damping * dot(body.velocity, normal))
        .max(0.0)
        * count;
    let slip = tangent(body.velocity, normal);
    let tangent_friction = scale(slip, profile.friction / norm(slip).max(0.06));
    scale(sub(normal, tangent_friction), load)
}

fn leg_contact(
    body: &Body,
    profile: &Profile,
    leg: &Actuator,
    foot: &Geometry,
    omega: V,
    stiffness: f64,
) -> V {
    let arm = rotate(leg.hip, body.rotation);
    if foot.stance == 0.0 {
        return ZERO;
    }
    let ground = [foot.point[0], foot.elevation, foot.point[2]];
    let leg_vector = sub(add(body.position, arm), ground);
    let length = norm(leg_vector);
    let axis = unit(leg_vector, foot.normal);
    let stretch_velocity = dot(
        sub(
            add(body.velocity, cross(omega, arm)),
            profile.support_velocity,
        ),
        axis,
    );
    let extension = profile.push * foot.phase * foot.phase;
    let rest_length = profile.size * (1.0 + extension);
    let length_rate =
        2.0 * profile.size * profile.push * foot.phase * profile.frequency / profile.duty;
    let load = if length < rest_length {
        ((rest_length - length) * stiffness - profile.damping * (stretch_velocity - length_rate))
            .max(0.0)
    } else {
        0.0
    };
    let normal_load = (load * dot(axis, foot.normal)).max(0.0);
    let shear = scale(tangent(axis, foot.normal), load);
    let limited = scale(
        unit(shear, ZERO),
        norm(shear).min(profile.friction * normal_load),
    );
    add(scale(foot.normal, normal_load), limited)
}

fn posture_couple(body: &Body, profile: &Profile, omega: V, support_up: V) -> V {
    if profile.posture == 0.0 {
        return ZERO;
    }
    let actual = [-body.rotation[0], -body.rotation[1], -body.rotation[2]];
    let [y, yaw_w] = profile.heading;
    let yaw = [0.0, y, 0.0];
    let (target, w) = if profile.lean > 0.0 {
        let axis = cross(UP, support_up);
        let scalar = 1.0 + dot(UP, support_up);
        let scale_by = 1.0 / sqrt(dot(axis, axis) + scalar * scalar);
        let slope = scale(axis, scale_by);
        let slope_w = scalar * scale_by;
        (
            add(
                add(scale(yaw, slope_w), scale(slope, yaw_w)),
                cross(slope, yaw),
            ),
            slope_w * yaw_w - dot(slope, yaw),
        )
    } else {
        (yaw, yaw_w)
    };
    let scalar = w * body.rotation[3] - dot(target, actual);
    let axis = add(
        add(scale(actual, w), scale(target, body.rotation[3])),
        cross(target, actual),
    );
    let error = scale(axis, if scalar >= 0.0 { 2.0 } else { -2.0 });
    let time = profile.posture;
    scale(
        sub(scale(error, 1.0 / time), scale(omega, 2.0)),
        profile.inertia / time,
    )
}

fn drive(
    body: &Body,
    profile: &Profile,
    shape: &[Geometry],
    contacts: &mut [Contact],
    omega: V,
    gravity: V,
) {
    let feet = contacts.len() - 1;
    let support = contacts[..feet]
        .iter()
        .zip(shape)
        .fold(0.0, |sum, (foot, geo)| sum + dot(foot.force, geo.normal));
    if support <= 0.0 {
        return;
    }
    let lever = 0.5 * profile.size;
    let mut traction = ZERO;
    if profile.traction > 0.0 {
        let actual = [body.velocity[0], 0.0, body.velocity[2]];
        let requested = scale(
            sub(desired_velocity(profile), actual),
            profile.mass / profile.traction,
        );
        if profile.lean > 0.0 {
            // Leave the torque budget needed to deliver shear below the COM.
            // With COM height h the same shear consumes F + hF/lever.
            let traction_limit = profile.friction * support / (1.0 + 0.87 * profile.size / lever);
            traction = scale(unit(requested, ZERO), norm(requested).min(traction_limit));
        } else {
            traction = requested;
        }
    }
    let desired_couple = if profile.lean > 0.0 {
        let mut stance_normal = ZERO;
        let mut delivered_moment = ZERO;
        for (foot, geo) in contacts[..feet].iter().zip(shape) {
            let normal = dot(geo.normal, foot.force);
            let weight = normal / support;
            stance_normal = add(stance_normal, scale(geo.normal, weight));
            let force = add(
                scale(geo.normal, normal),
                scale(tangent(traction, geo.normal), weight),
            );
            delivered_moment = add(
                delivered_moment,
                cross(sub(foot.point, body.position), force),
            );
        }
        let leaning_acceleration = scale(traction, 1.0 / profile.mass);
        let up = unit(
            add(scale(stance_normal, norm(gravity)), leaning_acceleration),
            UP,
        );
        sub(posture_couple(body, profile, omega, up), delivered_moment)
    } else {
        posture_couple(body, profile, omega, UP)
    };
    for (foot, geo) in contacts[..feet].iter_mut().zip(shape) {
        let load = dot(foot.force, geo.normal).max(0.0);
        let weight = load / support;
        let shear = if profile.traction > 0.0 {
            scale(tangent(traction, geo.normal), weight)
        } else {
            tangent(foot.force, geo.normal)
        };
        let moment = scale(desired_couple, weight);
        // A planted group has finite purchase: allow a support couple over its
        // representative stance lever, sharing the budget with tangential force.
        let demand = norm(shear) + norm(moment) / lever;
        let factor = if demand > 0.0 {
            (profile.friction * load / demand).min(1.0)
        } else {
            0.0
        };
        foot.force = add(scale(geo.normal, load), scale(shear, factor));
        foot.couple = scale(moment, factor);
    }
}

/// Advances one body against the sampled ground. The host stages all bodies and
/// their changed contacts in separate leases and publishes only on complete success.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn locomotion_step(
    body: *mut Body,
    profile: *const Profile,
    actuator: *const Actuator,
    anchors: *mut Anchor,
    geometry: *const Geometry,
    contacts: *mut Contact,
    count: usize,
    dt: f64,
    gravity_x: f64,
    gravity_y: f64,
    gravity_z: f64,
) -> u32 {
    let (body, profile) = unsafe { (&mut *body, &*profile) };
    let geometry = unsafe { slice::from_raw_parts(geometry, count) };
    let actuators = unsafe { slice::from_raw_parts(actuator, count) };
    let anchors = unsafe { slice::from_raw_parts_mut(anchors, count) };
    let contacts = unsafe { slice::from_raw_parts_mut(contacts, count) };
    let snake = profile.snake != 0.0;
    let (inertia, shape_spin) = if snake {
        snake_inertia(body, profile, geometry)
    } else {
        (profile.inertia, ZERO)
    };
    let omega = scale(sub(body.momentum, shape_spin), 1.0 / inertia);
    for (index, (((g, leg), anchor), contact)) in geometry
        .iter()
        .zip(actuators)
        .zip(anchors)
        .zip(contacts.iter_mut())
        .enumerate()
    {
        let (force, point, stance) = if snake {
            let force = snake_contact(body, profile, g, omega, count as f64);
            (
                force,
                g.point,
                if dot(force, g.normal) > 0.0 { 1.0 } else { 0.0 },
            )
        } else if index == count - 1 {
            let force = torso_contact(body, profile, g, (count - 1) as f64);
            let arm = scale(g.normal, -profile.body_radius);
            (
                force,
                add(body.position, arm),
                if dot(force, g.normal) > 0.0 { 1.0 } else { 0.0 },
            )
        } else {
            let force = leg_contact(body, profile, leg, g, omega, profile.stiffness);
            if g.stance != 0.0 || anchor.planted == 0.0 {
                let carried_time = if g.stance != 0.0 { dt } else { 0.0 };
                anchor.x = g.point[0] + profile.support_velocity[0] * carried_time;
                anchor.z = g.point[2] + profile.support_velocity[2] * carried_time;
            }
            anchor.planted = if g.stance != 0.0 { 1.0 } else { -1.0 };
            (
                force,
                [g.point[0], g.elevation + g.internal_velocity[1], g.point[2]],
                g.stance,
            )
        };
        if point.iter().chain(&force).any(|value| !value.is_finite()) {
            return 1;
        }
        let couple = if !snake && index == count - 1 && stance > 0.0 && dt > 0.0 {
            let available = profile.friction * dot(force, g.normal) * profile.body_radius;
            scale(
                unit(body.momentum, ZERO),
                -(norm(body.momentum) / dt).min(available),
            )
        } else {
            ZERO
        };
        *contact = Contact {
            point,
            axis: g.axis,
            force,
            stance,
            couple,
        };
    }
    let gravity = [gravity_x, gravity_y, gravity_z];
    if !snake {
        drive(body, profile, geometry, contacts, omega, gravity);
    }
    let mut net_force = profile.external_force;
    let mut torque = ZERO;
    for contact in contacts {
        net_force = add(net_force, contact.force);
        let moment = add(
            cross(sub(contact.point, body.position), contact.force),
            contact.couple,
        );
        torque = add(torque, if snake { [0.0, moment[1], 0.0] } else { moment });
    }
    body.advance(
        add(gravity, scale(net_force, 1.0 / profile.mass)),
        torque,
        inertia,
        shape_spin,
        dt,
    );
    body.phase = wrap(body.phase + profile.frequency * dt);
    u32::from(!body.finite() || !body.phase.is_finite())
}
