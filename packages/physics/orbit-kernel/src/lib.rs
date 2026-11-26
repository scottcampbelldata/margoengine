//! World-owned Cartesian N-body state with pairwise SIMD forces and symplectic drift/kick.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;
use core::slice;
use margoengine_physics_kernel_common::pinned::exp;

const STATE: usize = 6;
const ACCELERATION: usize = 3;
const MASS: usize = 2;
const CONFIG: usize = 8;
const YOSHIDA_OUTER: f64 = 1.351_207_191_959_657_8;
const YOSHIDA_INNER: f64 = -1.702_414_383_919_315_3;

struct HostMemory;

// Only the allocating forms in the shared crate would use this allocator. The orbit kernel uses host regions.
unsafe impl core::alloc::GlobalAlloc for HostMemory {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }

    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

#[global_allocator]
static NO_HEAP: HostMemory = HostMemory;

#[panic_handler]
fn trap(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

#[inline]
fn read2(words: &[f64], index: usize) -> v128 {
    // Every vector occupies two consecutive words of the host-validated row.
    unsafe { v128_load(words.as_ptr().add(index).cast()) }
}

#[inline]
fn write2(words: &mut [f64], index: usize, value: v128) {
    unsafe { v128_store(words.as_mut_ptr().add(index).cast(), value) }
}

#[inline]
fn times(vector: v128, scalar: f64) -> v128 {
    f64x2_mul(vector, f64x2_splat(scalar))
}

#[inline]
fn length2(xy: v128, z: f64) -> f64 {
    let square = f64x2_mul(xy, xy);
    (f64x2_extract_lane::<0>(square) + f64x2_extract_lane::<1>(square)) + z * z
}

#[inline]
fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

#[inline]
fn add_accel(acceleration: &mut [f64], body: usize, xy: v128, z: f64, strength: f64) {
    let offset = body * ACCELERATION;
    let updated = f64x2_add(read2(acceleration, offset), times(xy, strength));
    write2(acceleration, offset, updated);
    acceleration[offset + 2] += z * strength;
}

fn accelerations(state: &[f64], mass: &[f64], output: &mut [f64], config: &[f64]) -> bool {
    let count = mass.len() / MASS;
    let gravity = config[0];
    let softening = config[1];
    output.fill(0.0);
    if gravity == 0.0 {
        return true;
    }
    for i in 0..count {
        let here = i * STATE;
        let m_i = mass[i * MASS];
        let xy = read2(state, here);
        for j in i + 1..count {
            let m_j = mass[j * MASS];
            if m_i == 0.0 && m_j == 0.0 {
                continue;
            }
            let there = j * STATE;
            let difference = f64x2_sub(read2(state, there), xy);
            let dz = state[there + 2] - state[here + 2];
            let distance2 = length2(difference, dz) + softening * softening;
            if !(distance2 > 0.0 && distance2.is_finite()) {
                return false;
            }
            let factor = gravity / distance2 / sqrt(distance2);
            add_accel(output, i, difference, dz, factor * m_j);
            add_accel(output, j, difference, dz, -factor * m_i);
        }
    }
    let j2 = config[4];
    if j2 != 0.0 {
        let primary = config[2] as usize;
        let primary_offset = primary * STATE;
        let source = read2(state, primary_offset);
        let source_mass = mass[primary * MASS];
        let radius = config[3];
        for i in 0..count {
            if i == primary {
                continue;
            }
            let offset = i * STATE;
            let xy = f64x2_sub(read2(state, offset), source);
            let z = state[offset + 2] - state[primary_offset + 2];
            let r2 = length2(xy, z);
            if !(r2 > 0.0 && r2.is_finite()) {
                return false;
            }
            let factor =
                ((1.5 * j2 * gravity) * (source_mass / r2)) * ((radius * radius) / r2) / sqrt(r2);
            let axial = 5.0 * (z * z / r2);
            let equatorial = times(xy, axial - 1.0);
            let axial = z * (axial - 3.0);
            add_accel(output, i, equatorial, axial, factor);
            add_accel(
                output,
                primary,
                equatorial,
                axial,
                -factor * (mass[i * MASS] / source_mass),
            );
        }
    }
    true
}

fn kick_drift(state: &mut [f64], accel: &[f64], dt: f64) {
    let half = 0.5 * dt;
    for body in 0..state.len() / STATE {
        let at = body * STATE;
        let accel_at = body * ACCELERATION;
        let velocity = f64x2_add(read2(state, at + 3), times(read2(accel, accel_at), half));
        write2(state, at + 3, velocity);
        let position = f64x2_add(read2(state, at), times(velocity, dt));
        write2(state, at, position);
        state[at + 5] += half * accel[accel_at + 2];
        state[at + 2] += dt * state[at + 5];
    }
}

fn kick(state: &mut [f64], accel: &[f64], half: f64) {
    for body in 0..state.len() / STATE {
        let at = body * STATE + 3;
        let accel_at = body * ACCELERATION;
        let velocity = f64x2_add(read2(state, at), times(read2(accel, accel_at), half));
        write2(state, at, velocity);
        state[at + 2] += half * accel[accel_at + 2];
    }
}

fn atmospheric_drag(state: &mut [f64], body: &[f64], config: &[f64], duration: f64) {
    let density = config[5];
    if density == 0.0 {
        return;
    }
    let primary = config[2] as usize;
    let source = primary * STATE;
    let radius = config[3];
    let scale_height = config[6];
    let spin = config[7];
    let base_velocity = read2(state, source + 3);
    for i in 0..state.len() / STATE {
        let drag = body[i * MASS + 1];
        if drag == 0.0 || i == primary {
            continue;
        }
        let index = i * STATE;
        let position = f64x2_sub(read2(state, index), read2(state, source));
        let z = state[index + 2] - state[source + 2];
        let altitude = (sqrt(length2(position, z)) - radius).max(0.0);
        let rho = density * exp(-altitude / scale_height);
        let rotation = f64x2(
            -spin * f64x2_extract_lane::<1>(position),
            spin * f64x2_extract_lane::<0>(position),
        );
        let wind = f64x2_add(base_velocity, rotation);
        let relative = f64x2_sub(read2(state, index + 3), wind);
        let vertical = state[index + 5] - state[source + 5];
        let speed = sqrt(length2(relative, vertical));
        let decay = 1.0 / (1.0 + ((0.5 * rho) * drag) * speed * duration);
        write2(state, index + 3, f64x2_add(wind, times(relative, decay)));
        state[index + 5] = state[source + 5] + vertical * decay;
    }
}

/// The caller has copied the committed body words to scratch. Only scratch is mutated until success.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn orbit_step(
    state_pointer: *mut f64,
    body_pointer: *const f64,
    accel_pointer: *mut f64,
    config_pointer: *const f64,
    count: usize,
    substeps: u32,
    fourth_order: u32,
    dt: f64,
) -> u32 {
    let (state, body, acceleration, config) = unsafe {
        (
            slice::from_raw_parts_mut(state_pointer, count * STATE),
            slice::from_raw_parts(body_pointer, count * MASS),
            slice::from_raw_parts_mut(accel_pointer, count * ACCELERATION),
            slice::from_raw_parts(config_pointer, CONFIG),
        )
    };
    if !accelerations(state, body, acceleration, config) {
        return 1;
    }
    let step = dt / f64::from(substeps);
    for _ in 0..substeps {
        atmospheric_drag(state, body, config, step * 0.5);
        let stages: &[f64] = if fourth_order == 1 {
            &[YOSHIDA_OUTER, YOSHIDA_INNER, YOSHIDA_OUTER]
        } else {
            &[1.0]
        };
        for factor in stages {
            let duration = step * factor;
            kick_drift(state, acceleration, duration);
            if !accelerations(state, body, acceleration, config) {
                return 1;
            }
            kick(state, acceleration, duration * 0.5);
        }
        atmospheric_drag(state, body, config, step * 0.5);
    }
    u32::from(!state.iter().all(|x| x.is_finite()))
}
