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

// Keep a positive significand in [1,2) and an independent binary exponent.
// Only the final physical component is rounded into the f64 exponent range.
#[derive(Clone, Copy)]
struct Scaled {
    significand: f64,
    exponent: i32,
}

impl Scaled {
    fn power_of_two(exponent: i32) -> f64 {
        f64::from_bits(((exponent + 1023) as u64) << 52)
    }

    fn of(value: f64) -> Self {
        let (normal, shift) = if value.is_subnormal() {
            (value * Self::power_of_two(54), -54)
        } else {
            (value, 0)
        };
        let bits = normal.to_bits();
        Self {
            significand: f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000),
            exponent: ((bits >> 52) as i32 & 0x7ff) - 1023 + shift,
        }
    }

    fn times(self, other: Self) -> Self {
        let mut significand = self.significand * other.significand;
        let mut exponent = self.exponent + other.exponent;
        if significand >= 2.0 {
            significand *= 0.5;
            exponent += 1;
        }
        Self {
            significand,
            exponent,
        }
    }

    fn over(self, other: Self) -> Self {
        let mut significand = self.significand / other.significand;
        let mut exponent = self.exponent - other.exponent;
        if significand < 1.0 {
            significand *= 2.0;
            exponent -= 1;
        }
        Self {
            significand,
            exponent,
        }
    }

    fn value(self) -> f64 {
        if self.exponent > 1023 {
            f64::INFINITY
        } else if self.exponent >= -1022 {
            self.significand * Self::power_of_two(self.exponent)
        } else if self.exponent >= -1075 {
            (self.significand * Self::power_of_two(self.exponent + 1022)) * f64::MIN_POSITIVE
        } else {
            0.0
        }
    }
}

struct Separation {
    raw: [f64; 3],
    scaled: [f64; 3],
    scale: f64,
    norm: f64,
    distance: Scaled,
}

impl Separation {
    #[inline(never)]
    fn new(state: &[f64], i: usize, j: usize, xy: v128, z: f64, softening: f64) -> Option<Self> {
        let raw = [f64x2_extract_lane::<0>(xy), f64x2_extract_lane::<1>(xy), z];
        let mut scale = softening;
        for axis in 0..3 {
            let a = state[i * STATE + axis];
            let b = state[j * STATE + axis];
            if !(a.is_finite() && b.is_finite()) {
                return None;
            }
            let component = if raw[axis].is_finite() {
                raw[axis].abs()
            } else {
                a.abs().max(b.abs())
            };
            scale = scale.max(component);
        }
        if !(scale > 0.0 && scale.is_finite()) {
            return None;
        }
        let mut scaled = [0.0; 3];
        for axis in 0..3 {
            scaled[axis] = if raw[axis].is_finite() {
                raw[axis] / scale
            } else {
                state[j * STATE + axis] / scale - state[i * STATE + axis] / scale
            };
        }
        let soft = softening / scale;
        let norm = sqrt(length2(f64x2(scaled[0], scaled[1]), scaled[2]) + soft * soft);
        if !(norm > 0.0 && norm.is_finite()) {
            return None;
        }
        let distance = Scaled::of(scale).times(Scaled::of(norm));
        Some(Self {
            raw,
            scaled,
            scale,
            norm,
            distance,
        })
    }

    fn component(&self, axis: usize, strength: Scaled, signed_factor: f64) -> f64 {
        let raw = self.raw[axis];
        if raw == 0.0 || signed_factor == 0.0 {
            return if raw.is_sign_negative() ^ signed_factor.is_sign_negative() {
                -0.0
            } else {
                0.0
            };
        }
        let displacement = if raw.is_finite() {
            Scaled::of(raw.abs())
        } else {
            Scaled::of(self.scale).times(Scaled::of(self.scaled[axis].abs()))
        };
        let value = strength
            .times(displacement)
            .times(Scaled::of(signed_factor.abs()))
            .value();
        if raw.is_sign_negative() ^ signed_factor.is_sign_negative() {
            -value
        } else {
            value
        }
    }

    fn add(&self, output: &mut [f64], target: usize, strength: Scaled, factors: [f64; 3]) -> bool {
        let x = self.component(0, strength, factors[0]);
        let y = self.component(1, strength, factors[1]);
        let z = self.component(2, strength, factors[2]);
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return false;
        }
        add_accel(output, target, f64x2(x, y), z, 1.0);
        true
    }
}

struct Pair {
    xy: v128,
    z: f64,
    factor: f64,
}

impl Pair {
    fn new(state: &[f64], i: usize, j: usize, gravity: f64, softening: f64) -> Self {
        let xy = f64x2_sub(read2(state, j * STATE), read2(state, i * STATE));
        let z = state[j * STATE + 2] - state[i * STATE + 2];
        let radius2 = length2(xy, z) + softening * softening;
        let scale = gravity / radius2;
        let factor = if radius2.is_normal() && scale.is_normal() {
            scale / sqrt(radius2)
        } else {
            0.0
        };
        Self { xy, z, factor }
    }

    fn direct(&self, mass: f64) -> bool {
        self.factor.is_normal() && (mass == 0.0 || (self.factor * mass).is_normal())
    }

    fn add_scaled(
        separation: &Separation,
        output: &mut [f64],
        target: usize,
        mass: f64,
        gravity: f64,
        direction: f64,
    ) -> bool {
        if mass == 0.0 {
            return true;
        }
        let radius = separation.distance;
        let denominator = radius.times(radius).times(radius);
        let strength = Scaled::of(gravity)
            .times(Scaled::of(mass))
            .over(denominator);
        separation.add(output, target, strength, [direction; 3])
    }
}

fn add_pair(
    state: &[f64],
    output: &mut [f64],
    i: usize,
    j: usize,
    m_i: f64,
    m_j: f64,
    gravity: f64,
    softening: f64,
) -> bool {
    let pair = Pair::new(state, i, j, gravity, softening);
    if pair.direct(m_i) && pair.direct(m_j) {
        add_accel(output, i, pair.xy, pair.z, pair.factor * m_j);
        add_accel(output, j, pair.xy, pair.z, -pair.factor * m_i);
        return true;
    }
    let Some(separation) = Separation::new(state, i, j, pair.xy, pair.z, softening) else {
        return false;
    };
    Pair::add_scaled(&separation, output, i, m_j, gravity, 1.0)
        && Pair::add_scaled(&separation, output, j, m_i, gravity, -1.0)
}

#[inline(never)]
fn add_scaled_j2(
    state: &[f64],
    output: &mut [f64],
    primary: usize,
    target: usize,
    primary_mass: f64,
    target_mass: f64,
    xy: v128,
    z: f64,
    config: &[f64],
) -> bool {
    let Some(separation) = Separation::new(state, primary, target, xy, z, 0.0) else {
        return false;
    };
    let gravity = config[0];
    let j2 = config[4];
    let equatorial_sign = if j2 > 0.0 { 1.0 } else { -1.0 };
    let q = separation.scaled[2] / separation.norm;
    let axial = 5.0 * (q * q);
    let factors = [
        (axial - 1.0) * equatorial_sign,
        (axial - 1.0) * equatorial_sign,
        (axial - 3.0) * equatorial_sign,
    ];
    let distance = separation.distance;
    let squared_distance = distance.times(distance);
    let radius = Scaled::of(config[3]);
    let strength = Scaled::of(1.5)
        .times(Scaled::of(j2.abs()))
        .times(Scaled::of(gravity))
        .times(radius.times(radius))
        .over(squared_distance.times(squared_distance).times(distance));
    separation.add(
        output,
        target,
        strength.times(Scaled::of(primary_mass)),
        factors,
    ) && (target_mass == 0.0
        || separation.add(
            output,
            primary,
            strength.times(Scaled::of(target_mass)),
            factors.map(|n| -n),
        ))
}

fn add_j2(state: &[f64], mass: &[f64], output: &mut [f64], config: &[f64]) -> bool {
    let j2 = config[4];
    let gravity = config[0];
    if gravity == 0.0 || j2 == 0.0 {
        return true;
    }
    let count = mass.len() / MASS;
    let primary = config[2] as usize;
    if primary >= count || config[2] != primary as f64 {
        return false;
    }
    let primary_offset = primary * STATE;
    let source = read2(state, primary_offset);
    let source_mass = mass[primary * MASS];
    let radius = config[3];
    if !(source_mass > 0.0 && radius > 0.0 && radius.is_finite()) {
        return false;
    }
    for i in 0..count {
        if i == primary {
            continue;
        }
        let offset = i * STATE;
        let xy = f64x2_sub(read2(state, offset), source);
        let z = state[offset + 2] - state[primary_offset + 2];
        let r2 = length2(xy, z);
        let target_mass = mass[i * MASS];
        let radius_squared = radius * radius;
        let force_scale = 1.5 * j2 * gravity;
        let mass_scale = source_mass / r2;
        let radius_ratio = radius_squared / r2;
        let factor = (force_scale * mass_scale) * radius_ratio / sqrt(r2);
        let mass_ratio = target_mass / source_mass;
        let reaction = -factor * mass_ratio;
        if r2.is_normal()
            && radius_squared.is_normal()
            && force_scale.is_normal()
            && mass_scale.is_normal()
            && radius_ratio.is_normal()
            && factor.is_normal()
            && (target_mass == 0.0 || (mass_ratio.is_normal() && reaction.is_normal()))
        {
            let axial = 5.0 * (z * z / r2);
            let equatorial = times(xy, axial - 1.0);
            let axial = z * (axial - 3.0);
            add_accel(output, i, equatorial, axial, factor);
            add_accel(output, primary, equatorial, axial, reaction);
        } else if !add_scaled_j2(
            state,
            output,
            primary,
            i,
            source_mass,
            target_mass,
            xy,
            z,
            config,
        ) {
            return false;
        }
    }
    true
}

#[repr(C)]
#[derive(Default)]
struct Work {
    geometries: f64,
    contributions: f64,
}

fn compact_massive(mass: &[f64], indices: &mut [u32]) -> usize {
    let mut end = 0;
    for (i, body) in mass.chunks_exact(MASS).enumerate() {
        if body[0] > 0.0 {
            indices[end] = i as u32;
            end += 1;
        }
    }
    end
}

fn accelerations(
    state: &[f64],
    mass: &[f64],
    output: &mut [f64],
    config: &[f64],
    massive: Option<&[u32]>,
    work: &mut Work,
) -> bool {
    let count = mass.len() / MASS;
    let gravity = config[0];
    let softening = config[1];
    output.fill(0.0);
    if gravity == 0.0 {
        return true;
    }
    let mut first_massive = 0;
    for i in 0..count {
        let m_i = mass[i * MASS];
        if let Some(indices) = massive {
            while first_massive < indices.len() && indices[first_massive] as usize <= i {
                first_massive += 1;
            }
            if m_i == 0.0 {
                // Keep the ascending j order while visiting only nonzero sources.
                for &j in &indices[first_massive..] {
                    let j = j as usize;
                    if !add_pair(state, output, i, j, m_i, mass[j * MASS], gravity, softening) {
                        return false;
                    }
                    work.geometries += 1.0;
                    work.contributions += 1.0;
                }
                continue;
            }
        }
        for j in i + 1..count {
            let m_j = mass[j * MASS];
            if m_i == 0.0 && m_j == 0.0 {
                continue;
            }
            if !add_pair(state, output, i, j, m_i, m_j, gravity, softening) {
                return false;
            }
            work.geometries += 1.0;
            work.contributions += f64::from(u32::from(m_i != 0.0) + u32::from(m_j != 0.0));
        }
    }
    add_j2(state, mass, output, config) && output.iter().all(|a| a.is_finite())
}

fn directed_accelerations(
    state: &[f64],
    mass: &[f64],
    output: &mut [f64],
    range: core::ops::Range<usize>,
    config: &[f64],
    massive: &[u32],
    work: &mut Work,
) -> bool {
    output.fill(0.0);
    let gravity = config[0];
    if gravity == 0.0 {
        return true;
    }
    let softening = config[1];
    for (local, target) in range.enumerate() {
        for &source in massive {
            let source = source as usize;
            if target == source {
                continue;
            }
            let (i, j, direction) = if target < source {
                (target, source, 1.0)
            } else {
                (source, target, -1.0)
            };
            let pair = Pair::new(state, i, j, gravity, softening);
            let m_source = mass[source * MASS];
            // Use the same decision on both ends as the legacy unordered pair.
            // Each target sees its sources in ascending index order.
            if pair.direct(m_source) && pair.direct(mass[target * MASS]) {
                add_accel(
                    output,
                    local,
                    pair.xy,
                    pair.z,
                    (direction * pair.factor) * m_source,
                );
            } else {
                let Some(separation) = Separation::new(state, i, j, pair.xy, pair.z, softening)
                else {
                    return false;
                };
                if !Pair::add_scaled(&separation, output, local, m_source, gravity, direction) {
                    return false;
                }
            }
            work.geometries += 1.0;
            work.contributions += 1.0;
        }
    }
    output.iter().all(|a| a.is_finite())
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

fn valid_tick(count: usize, substeps: u32, fourth: u32, dt: f64) -> bool {
    if !(count > 0
        && count <= isize::MAX as usize / (STATE * 8)
        && dt > 0.0
        && dt.is_finite()
        && substeps > 0
        && fourth <= 1)
    {
        return false;
    }
    let step = dt / f64::from(substeps);
    step > 0.0 && (fourth == 0 || (step * YOSHIDA_INNER).is_finite())
}

fn valid_model(body: &[f64], config: &[f64]) -> bool {
    if !body.iter().all(|&word| word >= 0.0 && word.is_finite())
        || !config.iter().all(|word| word.is_finite())
        || config[0] < 0.0
        || config[1] < 0.0
        || config[5] < 0.0
    {
        return false;
    }
    if config[4] != 0.0 || config[5] != 0.0 {
        let primary = config[2] as usize;
        return primary < body.len() / MASS
            && config[2] == primary as f64
            && body[primary * MASS] > 0.0
            && config[3] > 0.0
            && config[6] > 0.0;
    }
    true
}

/// The caller has copied the committed body words to scratch. Only scratch is mutated until success.
#[unsafe(no_mangle)]
unsafe extern "C" fn orbit_step(
    state_pointer: *mut f64,
    body_pointer: *const f64,
    accel_pointer: *mut f64,
    config_pointer: *const f64,
    count: usize,
    substeps: u32,
    fourth_order: u32,
    dt: f64,
    massive_pointer: *mut u32,
    receipt: *mut Work,
) -> u32 {
    if !valid_tick(count, substeps, fourth_order, dt) {
        return 1;
    }
    let (state, body, acceleration, config) = unsafe {
        (
            slice::from_raw_parts_mut(state_pointer, count * STATE),
            slice::from_raw_parts(body_pointer, count * MASS),
            slice::from_raw_parts_mut(accel_pointer, count * ACCELERATION),
            slice::from_raw_parts(config_pointer, CONFIG),
        )
    };
    if !valid_model(body, config) {
        return 1;
    }
    let massive = if massive_pointer.is_null() {
        None
    } else {
        let indices = unsafe { slice::from_raw_parts_mut(massive_pointer, count) };
        let live = compact_massive(body, indices);
        Some(&indices[..live])
    };
    let mut work = Work::default();
    if !accelerations(state, body, acceleration, config, massive, &mut work) {
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
            if !accelerations(state, body, acceleration, config, massive, &mut work) {
                return 1;
            }
            kick(state, acceleration, duration * 0.5);
        }
        atmospheric_drag(state, body, config, step * 0.5);
    }
    if !state.iter().all(|x| x.is_finite()) {
        return 1;
    }
    if !receipt.is_null() {
        unsafe { receipt.write(work) };
    }
    0
}

#[repr(C)]
struct OrbitJob {
    state: *mut f64,
    body: *const f64,
    acceleration: *mut f64,
    config: *const f64,
    massive: *mut u32,
    count: usize,
    massive_count: usize,
    receipts: *mut Work,
    substeps: u32,
    fourth_order: u32,
    dt: f64,
}

const _: () = assert!(core::mem::size_of::<OrbitJob>() == 48);

impl OrbitJob {
    fn stage(&self, stage: u32) -> Option<(f64, f64, bool)> {
        let (factor, last) = match (self.fourth_order, stage) {
            (0, 0) => (1.0, true),
            (1, 0) => (YOSHIDA_OUTER, false),
            (1, 1) => (YOSHIDA_INNER, false),
            (1, 2) => (YOSHIDA_OUTER, true),
            _ => return None,
        };
        let step = self.dt / f64::from(self.substeps);
        Some((step, step * factor, last))
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn orbit_thread_prepare(job: *mut OrbitJob) -> u32 {
    unsafe {
        let Some(job) = job.as_mut() else { return 1 };
        if job.massive.is_null() || !valid_tick(job.count, job.substeps, job.fourth_order, job.dt) {
            return 1;
        }
        let body = slice::from_raw_parts(job.body, job.count * MASS);
        let config = slice::from_raw_parts(job.config, CONFIG);
        if !valid_model(body, config) {
            return 1;
        }
        job.massive_count =
            compact_massive(body, slice::from_raw_parts_mut(job.massive, job.count));
        0
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn orbit_thread_phase(
    job: *const OrbitJob,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    if stage != 0 || part >= parts {
        return 1;
    }
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let count = job.count as u64;
        let start = (u64::from(part) * count / u64::from(parts)) as usize;
        let end = ((u64::from(part) + 1) * count / u64::from(parts)) as usize;
        let state = slice::from_raw_parts(job.state, job.count * STATE);
        let body = slice::from_raw_parts(job.body, job.count * MASS);
        let config = slice::from_raw_parts(job.config, CONFIG);
        let massive = slice::from_raw_parts(job.massive, job.massive_count);
        // Borrow only each worker's owned acceleration columns.
        let output = slice::from_raw_parts_mut(
            job.acceleration.add(start * ACCELERATION),
            (end - start) * ACCELERATION,
        );
        let mut work = Work::default();
        if !directed_accelerations(state, body, output, start..end, config, massive, &mut work) {
            return 1;
        }
        if !job.receipts.is_null() {
            job.receipts.add(part as usize).write(work);
        }
        0
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn orbit_thread_finish_accel(job: *const OrbitJob) -> u32 {
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let state = slice::from_raw_parts(job.state, job.count * STATE);
        let body = slice::from_raw_parts(job.body, job.count * MASS);
        let config = slice::from_raw_parts(job.config, CONFIG);
        let output = slice::from_raw_parts_mut(job.acceleration, job.count * ACCELERATION);
        let okay = add_j2(state, body, output, config) && output.iter().all(|a| a.is_finite());
        u32::from(!okay)
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn orbit_thread_before(job: *const OrbitJob, stage: u32) -> u32 {
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let Some((step, duration, _)) = job.stage(stage) else {
            return 1;
        };
        let state = slice::from_raw_parts_mut(job.state, job.count * STATE);
        let body = slice::from_raw_parts(job.body, job.count * MASS);
        let config = slice::from_raw_parts(job.config, CONFIG);
        let acc = slice::from_raw_parts(job.acceleration, job.count * ACCELERATION);
        if stage == 0 {
            atmospheric_drag(state, body, config, step * 0.5);
        }
        kick_drift(state, acc, duration);
        u32::from(!state.iter().all(|value| value.is_finite()))
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn orbit_thread_after(job: *const OrbitJob, stage: u32) -> u32 {
    unsafe {
        let Some(job) = job.as_ref() else { return 1 };
        let Some((step, duration, last)) = job.stage(stage) else {
            return 1;
        };
        let state = slice::from_raw_parts_mut(job.state, job.count * STATE);
        let body = slice::from_raw_parts(job.body, job.count * MASS);
        let config = slice::from_raw_parts(job.config, CONFIG);
        let acc = slice::from_raw_parts(job.acceleration, job.count * ACCELERATION);
        kick(state, acc, duration * 0.5);
        if last {
            atmospheric_drag(state, body, config, step * 0.5);
        }
        u32::from(!state.iter().all(|value| value.is_finite()))
    }
}
