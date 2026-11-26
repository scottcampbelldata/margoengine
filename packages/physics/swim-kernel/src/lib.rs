#![no_std]

use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_sqrt};
use core::f64::consts::{PI, TAU};
use core::panic::PanicInfo;

type Vec3 = [f64; 3];

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2(x, x)))
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    let xy = f64x2_mul(f64x2(a[0], a[1]), f64x2(b[0], b[1]));
    (f64x2_extract_lane::<0>(xy) + f64x2_extract_lane::<1>(xy)) + a[2] * b[2]
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn multiply(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn direction(a: Vec3) -> Vec3 {
    let magnitude = sqrt(dot(a, a));
    if magnitude > 0.0 {
        scale(a, 1.0 / magnitude)
    } else {
        a
    }
}

fn rotate(q: [f64; 4], v: Vec3, inverse: bool) -> Vec3 {
    let s = if inverse { -1.0 } else { 1.0 };
    let vector = [q[0] * s, q[1] * s, q[2] * s];
    let t = scale(cross(vector, v), 2.0);
    add(v, add(scale(t, q[3]), cross(vector, t)))
}

fn advance_orientation(q: [f64; 4], omega: Vec3, dt: f64) -> [f64; 4] {
    // Midpoint (Cayley) rotation. It has unit length before round-off and needs no trig.
    let a = scale(omega, 0.5 * dt);
    let inverse = 1.0 / sqrt(1.0 + dot(a, a));
    let qv = [q[0], q[1], q[2]];
    let next = scale(add(qv, add(scale(a, q[3]), cross(qv, a))), inverse);
    let w = (q[3] - dot(qv, a)) * inverse;
    let norm = 1.0 / sqrt(dot(next, next) + w * w);
    [next[0] * norm, next[1] * norm, next[2] * norm, w * norm]
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Body {
    position: Vec3,
    velocity: Vec3,
    orientation: [f64; 4],
    angular: Vec3,
    phase: f64,
    frequency: f64,
    amplitude: f64,
    thrust: f64,
    wet: f64,
    fin_phase: f64,
}

#[repr(C)]
struct Parameters {
    mass: f64,
    length: f64,
    width: f64,
    height: f64,
    volume: f64,
    wetted_area: f64,
    form_drag_area: f64,
    lateral_cd: f64,
    vertical_cd: f64,
    axial_added_ratio: f64,
    tail_amplitude: f64,
    tail_span: f64,
    tail_wavelength: f64,
    frequency: f64,
    maximum_frequency: f64,
    fin_area: f64,
    fin_cl: f64,
    fin_cd: f64,
    fin_speed: f64,
    fin_arm: f64,
    fin_spacing: f64,
    response: f64,
    buoyancy_centre: Vec3,
    steering: Vec3,
}

#[repr(C)]
struct Medium {
    flow: Vec3,
    acceleration: Vec3,
    gravity: Vec3,
    buoyancy_offset: Vec3,
    density: f64,
    wet: f64,
    friction: f64,
    gait: f64,
    fin_stroke: f64,
    target: Vec3,
    has_target: f64,
    fin_phase: f64,
    contact_force: Vec3,
    contact_torque: Vec3,
}

#[repr(C)]
struct Motion {
    position: Vec3,
    velocity: Vec3,
}

#[repr(C)]
struct Wake {
    position: Vec3,
    impulse: Vec3,
    radius: f64,
    wet: f64,
}

fn step(body: &Body, p: &Parameters, m: &Medium, dt: f64) -> (Body, Wake, Wake) {
    let q = body.orientation;
    let flow = rotate(q, m.flow, true);
    let water_acceleration = rotate(q, m.acceleration, true);
    let gravity = rotate(q, m.gravity, true);
    let velocity = rotate(q, body.velocity, true);
    let relative = add(velocity, scale(flow, -1.0));
    let length = p.length;
    let half_width = p.width * 0.5;
    let half_height = p.height * 0.5;
    let rho = m.density * m.wet;
    // Elliptical potential-flow strips integrated over the ellipsoidal length.
    let width2 = half_width * half_width;
    let height2 = half_height * half_height;
    let section = PI * rho * length;
    let added = [
        section * height2 * (2.0 / 3.0),
        section * width2 * (2.0 / 3.0),
        rho * p.volume * p.axial_added_ratio,
    ];
    let pitch_yaw = section * length * length / 30.0;
    let roll_shape = width2 - height2;
    let added_inertia = [
        pitch_yaw * width2,
        pitch_yaw * height2,
        section * roll_shape * roll_shape / 15.0,
    ];
    let half_length2 = 0.25 * length * length;
    let inertia = scale(
        [
            height2 + half_length2,
            width2 + half_length2,
            width2 + height2,
        ],
        p.mass / 5.0,
    );
    let friction = p.form_drag_area + p.wetted_area * m.friction;
    let axial_drag = 0.5 * rho * friction;
    let mass = add([p.mass; 3], added);
    let forward = relative[2].abs();
    let tail_scale =
        rho * PI * p.tail_span * p.tail_span * p.tail_amplitude * p.tail_amplitude / 16.0;
    let through_frequency = TAU * relative[2] / p.tail_wavelength;
    let has_target = m.has_target > 0.0;
    let goal = rotate(q, m.target, true);
    let frequency = if has_target && tail_scale > 0.0 {
        let demand = (mass[2] * (goal[2] - relative[2]) / p.response
            + axial_drag * relative[2] * forward)
            .max(0.0);
        if demand > 0.0 {
            (sqrt(demand / tail_scale + through_frequency * through_frequency) / TAU)
                .min(p.maximum_frequency)
        } else {
            0.0
        }
    } else {
        p.frequency
    } * m.gait;
    let beat = TAU * frequency;
    let thrust = if beat > 0.0 {
        tail_scale * (beat - through_frequency) * (beat + through_frequency)
    } else {
        0.0
    };
    let volume_mass = rho * p.volume;
    let buoyancy = scale(gravity, -volume_mass);
    let linear_momentum = add(scale(velocity, p.mass), multiply(added, relative));
    let angular_momentum = multiply(add(inertia, added_inertia), body.angular);
    let gyroscopic_force = add(
        cross(body.angular, linear_momentum),
        scale(multiply(mass, cross(body.angular, velocity)), -1.0),
    );
    let gyroscopic_torque = add(
        cross(body.angular, angular_momentum),
        cross(relative, multiply(added, relative)),
    );
    let ambient_force = multiply(add([volume_mass; 3], added), water_acceleration);
    let mut force = add(
        add(scale(gravity, p.mass), buoyancy),
        add(ambient_force, scale(gyroscopic_force, -1.0)),
    );
    let mut torque = add(
        cross(add(p.buoyancy_centre, m.buoyancy_offset), buoyancy),
        scale(gyroscopic_torque, -1.0),
    );
    force = add(force, rotate(q, m.contact_force, true));
    torque = add(torque, rotate(q, m.contact_torque, true));
    force[2] += thrust;

    // Passive axial resistance is handled by a linearly implicit impulse.
    let mut damping = [0.0, 0.0, axial_drag * forward];
    let mut rotational_damping = [0.0; 3];
    // Four-point Gauss-Legendre per half-body: integrates z^3 exactly for pure yaw or pitch
    // with constant strip width. Opposite strips give opposing loads about the COM.
    let nodes = [0.339_981_043_584_856_26, 0.861_136_311_594_052_6];
    let weights = [0.652_145_154_862_546_1, 0.347_854_845_137_453_85];
    for side in [-1.0, 1.0] {
        for (node, weight) in nodes.into_iter().zip(weights) {
            for station in [-1.0, 1.0] {
                let z = side * 0.25 * length * (1.0 + station * node);
                let area_factor =
                    sqrt(1.0 - (2.0 * z / length) * (2.0 * z / length)) * weight * length * 0.25;
                let crossflow = add(relative, cross(body.angular, [0.0, 0.0, z]));
                let dx = 0.5 * rho * p.lateral_cd * p.height * area_factor * crossflow[0].abs();
                let dy = 0.5 * rho * p.vertical_cd * p.width * area_factor * crossflow[1].abs();
                damping[0] += dx;
                damping[1] += dy;
                force[0] -= dx * body.angular[1] * z;
                force[1] += dy * body.angular[0] * z;
                torque[0] += dy * relative[1] * z;
                torque[1] -= dx * relative[0] * z;
                rotational_damping[0] += dy * z * z;
                rotational_damping[1] += dx * z * z;
            }
        }
    }
    // Two symmetric pectoral centres resist and command roll.
    let rolling_speed = p.fin_spacing * body.angular[2];
    rotational_damping[2] =
        rho * p.fin_cd * p.fin_area * p.fin_spacing * p.fin_spacing * rolling_speed.abs();
    let blade_speed = p.fin_speed * m.fin_stroke;
    let fin_flow = add(relative, [0.0, blade_speed, 0.0]);
    let lift_capacity = 0.5 * rho * p.fin_area * p.fin_cl * dot(fin_flow, fin_flow);
    let scull_capacity = 0.5
        * rho
        * p.fin_area
        * p.fin_cd
        * blade_speed
        * blade_speed
        * if blade_speed > 0.0 { 1.0 } else { 0.0 };
    let goal_direction = direction(goal);
    let demand = scale(
        multiply(mass, add(goal, scale(relative, -1.0))),
        1.0 / p.response,
    );
    let mut fin = if has_target {
        [
            demand[0].clamp(-lift_capacity, lift_capacity),
            demand[1].clamp(-lift_capacity, lift_capacity),
            demand[2].clamp(-scull_capacity, scull_capacity),
        ]
    } else {
        [
            p.steering[0] * lift_capacity,
            p.steering[1] * lift_capacity,
            p.steering[2] * scull_capacity,
        ]
    };
    // Hydrofoil control authority is one vector of lift. Brake or scull with the pectoral drag stroke.
    let lift_demand = sqrt(fin[0] * fin[0] + fin[1] * fin[1]);
    if lift_demand > lift_capacity {
        fin[0] *= lift_capacity / lift_demand;
        fin[1] *= lift_capacity / lift_demand;
    }
    let (desired_yaw, desired_pitch) = if has_target {
        let half_turn = sqrt(0.5 * (1.0 - goal_direction[2])).min(1.0);
        let perpendicular = direction([goal_direction[0], goal_direction[1], 0.0]);
        if goal_direction[2] < 0.0 && perpendicular == [0.0; 3] {
            // The antiparallel direction has no preferred steering side.
            (half_turn, 0.0)
        } else {
            (half_turn * perpendicular[0], -half_turn * perpendicular[1])
        }
    } else {
        (p.steering[0], -p.steering[1])
    };
    // At speed a command can also bank the body by differential load on left/right fins.
    let up = rotate(
        q,
        if dot(m.gravity, m.gravity) > 0.0 {
            scale(direction(m.gravity), -1.0)
        } else {
            [0.0, 1.0, 0.0]
        },
        true,
    );
    let roll_command = (desired_yaw - up[0] - body.angular[2] * p.response).clamp(-1.0, 1.0);
    let tip = [
        (desired_yaw - body.angular[1] * p.response).clamp(-1.0, 1.0),
        (desired_pitch - body.angular[0] * p.response).clamp(-1.0, 1.0),
        roll_command,
    ];
    let pitch_yaw_command = direction([tip[0], tip[1], 0.0]);
    let command_length = sqrt(tip[0] * tip[0] + tip[1] * tip[1]).min(1.0);
    let steer_load = scale(pitch_yaw_command, lift_capacity * command_length);
    torque = add(
        torque,
        [
            p.fin_arm * steer_load[1],
            p.fin_arm * steer_load[0],
            p.fin_spacing * lift_capacity * tip[2],
        ],
    );
    force = add(force, fin);

    let mut next_relative = [0.0; 3];
    let total_inertia = add(inertia, added_inertia);
    let mut next_angular = [0.0; 3];
    for axis in 0..3 {
        next_relative[axis] =
            (mass[axis] * relative[axis] + dt * force[axis]) / (mass[axis] + dt * damping[axis]);
        next_angular[axis] = (total_inertia[axis] * body.angular[axis] + dt * torque[axis])
            / (total_inertia[axis] + dt * rotational_damping[axis]);
    }
    // The rigid-frame rotation has been canceled analytically; apply the increment
    // on the old frame before advancing the orientation independently.
    let next_velocity = rotate(q, add(next_relative, flow), false);
    let position = add(
        body.position,
        scale(add(body.velocity, next_velocity), 0.5 * dt),
    );
    let orientation = advance_orientation(q, scale(add(body.angular, next_angular), 0.5), dt);
    let next_phase = body.phase + dt * frequency;
    let phase = next_phase - f64x2_extract_lane::<0>(f64x2_floor(f64x2(next_phase, next_phase)));
    let blend = dt / (p.response + dt);
    let amplitude = body.amplitude
        + blend * (p.tail_amplitude * if frequency > 0.0 { 1.0 } else { 0.0 } - body.amplitude);
    let next = Body {
        position,
        velocity: next_velocity,
        orientation,
        angular: next_angular,
        phase,
        frequency,
        amplitude,
        thrust,
        wet: m.wet,
        fin_phase: m.fin_phase,
    };
    let wake = |arm, force, radius| Wake {
        position: add(body.position, rotate(q, [0.0, 0.0, arm], false)),
        impulse: scale(rotate(q, force, false), -dt),
        radius,
        wet: m.wet,
    };
    (
        next,
        wake(-length * 0.5, [0.0, 0.0, thrust], p.tail_span * 0.5),
        wake(-p.fin_arm, fin, sqrt(p.fin_area / PI)),
    )
}

/// Each pointer is a nonoverlapping f64-aligned region allocated and sized by the host.
#[unsafe(no_mangle)]
unsafe extern "C" fn swim_step(
    input: *const Body,
    parameters: *const Parameters,
    medium: *const Medium,
    output: *mut Body,
    kinematics: *mut Motion,
    wakes: *mut Wake,
    count: usize,
    dt: f64,
) -> i32 {
    for index in 0..count {
        unsafe {
            let (body, tail, fin) = step(
                &*input.add(index),
                &*parameters.add(index),
                &*medium.add(index),
                dt,
            );
            let values = core::slice::from_raw_parts((&body as *const Body).cast::<f64>(), 19);
            if values.iter().any(|value| !value.is_finite()) {
                return 1;
            }
            output.add(index).write(body);
            kinematics.add(index).write(Motion {
                position: body.position,
                velocity: body.velocity,
            });
            wakes.add(2 * index).write(tail);
            wakes.add(2 * index + 1).write(fin);
        }
    }
    0
}
