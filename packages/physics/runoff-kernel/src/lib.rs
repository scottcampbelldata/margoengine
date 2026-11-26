#![no_std]
#![cfg(target_arch = "wasm32")]

use core::slice;
use margoengine_physics_kernel_common::pinned::{exp, ln, pow};

struct HostOwnsStorage;

// The pinned-math crate also exports allocating helpers. This module calls only its scalar functions.
unsafe impl core::alloc::GlobalAlloc for HostOwnsStorage {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }

    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

#[global_allocator]
static NO_HEAP: HostOwnsStorage = HostOwnsStorage;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

// Soil and routing coefficients, by plane.
const CONDUCTIVITY: usize = 0;
const SUCTION_DEFICIT: usize = 1;
const SOIL_CAPACITY: usize = 2;
const DRAINAGE: usize = 3;
const MANNING: usize = 4;
const TOPOGRAPHY: usize = 5;
const COEFFICIENTS: usize = 6;

// Water state and the published rate planes.
const SURFACE: usize = 0;
const SOIL: usize = 1;
const FRONT: usize = 2;
const INFILTRATION: usize = 3;
const RECHARGE: usize = 4;
const DISCHARGE: usize = 5;
const OUTLET: usize = 6;
const PLANES: usize = 7;

// x - log1p(x), without cancelling the leading x term at a dry wetting front.
fn log_residual(x: f64) -> f64 {
    let mut term = x * x;
    let mut value = 0.5 * term;
    for order in 3..=20 {
        term *= -x;
        value += term / order as f64;
    }
    value
}

fn ponded_increment(front: f64, suction: f64, capacity: f64, available: f64) -> f64 {
    if suction == 0.0 || capacity == 0.0 {
        return capacity.min(available);
    }
    let denominator = front + suction;
    let elapsed_depth = |delta: f64| {
        let x = delta / denominator;
        if x >= 0.125 {
            delta - suction * (ln(denominator + delta) - ln(denominator))
        } else {
            front * x + suction * log_residual(x)
        }
    };
    if elapsed_depth(available) <= capacity {
        return available;
    }
    let mut lo = 0.0;
    let mut hi = available;
    loop {
        let mid = lo + (hi - lo) * 0.5;
        if mid == lo || mid == hi {
            return lo;
        }
        if elapsed_depth(mid) > capacity {
            hi = mid;
        } else {
            lo = mid;
        }
    }
}

// Green-Ampt with the preponding step of Mein and Larson. Each world tick holds its rain rate.
fn infiltration(
    front: f64,
    suction: f64,
    conductivity: f64,
    ponded: f64,
    offered_rate: f64,
    available: f64,
    dt: f64,
) -> f64 {
    if available == 0.0 || conductivity == 0.0 {
        return 0.0;
    }
    if ponded > 0.0 {
        return ponded_increment(front, suction, conductivity * dt, available);
    }
    if offered_rate <= conductivity {
        return available;
    }
    let at_ponding = conductivity * suction / (offered_rate - conductivity);
    let before_ponding = (at_ponding - front).max(0.0).min(available);
    let remaining_time = (dt - before_ponding / offered_rate).max(0.0);
    before_ponding
        + ponded_increment(
            front + before_ponding,
            suction,
            conductivity * remaining_time,
            available - before_ponding,
        )
}

// Backward Euler upwind volume balance. Substituting u = depth^(1/3) leaves a monotone polynomial.
fn routed_volume(water: f64, area: f64, rating: f64, dt: f64) -> f64 {
    if water == 0.0 || rating == 0.0 {
        return 0.0;
    }
    let mut lo = 0.0;
    let mut hi = pow(water / area, 1.0 / 3.0);
    let rating = rating * dt;
    loop {
        let mid = lo + (hi - lo) * 0.5;
        if mid == lo || mid == hi {
            let square = lo * lo;
            return (rating * square * square * lo).min(water);
        }
        let square = mid * mid;
        let cube = square * mid;
        if area * cube + rating * cube * square > water {
            hi = mid;
        } else {
            lo = mid;
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn rain_and_melt(rain: &[f64], melt: &[f64], sum: &mut [f64]) {
    use core::arch::wasm32::{f64x2_add, v128, v128_load, v128_store};
    let pair_end = sum.len() & !1;
    for i in (0..pair_end).step_by(2) {
        // Both inputs and the output have the same length. A pair fits before pair_end.
        unsafe {
            let a = v128_load(rain.as_ptr().add(i).cast::<v128>());
            let b = v128_load(melt.as_ptr().add(i).cast::<v128>());
            v128_store(sum.as_mut_ptr().add(i).cast::<v128>(), f64x2_add(a, b));
        }
    }
    if pair_end < sum.len() {
        sum[pair_end] = rain[pair_end] + melt[pair_end];
    }
}

/// Advances grid storage and routes the resulting water through a topologically sorted drainage graph.
/// Each pointer describes an allocated world region and is validated by the TypeScript bridge.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn runoff_step(
    state: *mut f64,
    coefficients: *const f64,
    topology: *const i32,
    forcing: *const f64,
    scratch: *mut f64,
    budget: *mut f64,
    count: usize,
    area: f64,
    topographic_scale: f64,
    dt: f64,
) {
    let state = unsafe { slice::from_raw_parts_mut(state, PLANES * count) };
    let coefficients = unsafe { slice::from_raw_parts(coefficients, COEFFICIENTS * count) };
    let topology = unsafe { slice::from_raw_parts(topology, 2 * count) };
    let forcing = unsafe { slice::from_raw_parts(forcing, 3 * count) };
    let scratch = unsafe { slice::from_raw_parts_mut(scratch, 2 * count) };
    let budget = unsafe { slice::from_raw_parts_mut(budget, 6) };
    let (supply, incoming) = scratch.split_at_mut(count);
    rain_and_melt(&forcing[..count], &forcing[count..2 * count], supply);
    incoming.fill(0.0);

    let mut mean_deficit = 0.0;
    let mut mean_index = 0.0;
    if topographic_scale > 0.0 {
        for i in 0..count {
            mean_deficit += coefficients[SOIL_CAPACITY * count + i] - state[SOIL * count + i];
            mean_index += coefficients[TOPOGRAPHY * count + i];
        }
        mean_deficit /= count as f64;
        mean_index /= count as f64;
    }

    for i in 0..count {
        let evaporation = forcing[2 * count + i] * dt;
        let condensation = (-evaporation).max(0.0);
        let mut surface = state[SURFACE * count + i];
        let mut soil = state[SOIL * count + i];
        let surface_loss = evaporation.max(0.0).min(surface);
        surface -= surface_loss;
        let soil_loss = (evaporation - surface_loss).max(0.0).min(soil);
        soil -= soil_loss;

        let offered = supply[i] + condensation / dt;
        let available = surface + offered * dt;
        let mut front = state[FRONT * count + i];
        let capacity = coefficients[SOIL_CAPACITY * count + i];
        let local_deficit = (capacity - soil).max(0.0);
        let deficit = if topographic_scale > 0.0 {
            let index = coefficients[TOPOGRAPHY * count + i];
            local_deficit.min((mean_deficit + topographic_scale * (mean_index - index)).max(0.0))
        } else {
            local_deficit
        };
        let infiltrated = infiltration(
            front,
            coefficients[SUCTION_DEFICIT * count + i],
            coefficients[CONDUCTIVITY * count + i],
            surface,
            offered,
            available,
            dt,
        )
        .min(deficit);
        soil += infiltrated;
        front += infiltrated;
        let coefficient = coefficients[DRAINAGE * count + i];
        let drainage = soil * (1.0 - exp(-coefficient * dt));
        let remaining_soil = soil - drainage;
        // When no water feeds the front, redistribution and evapotranspiration restore the dry soil's capacity.
        let stored_before_dry = soil + soil_loss;
        if available == 0.0 && stored_before_dry > 0.0 {
            front *= remaining_soil / stored_before_dry;
        }
        state[SURFACE * count + i] = (available - infiltrated).max(0.0);
        state[SOIL * count + i] = remaining_soil;
        state[FRONT * count + i] = front;
        state[INFILTRATION * count + i] = infiltrated / dt;
        state[RECHARGE * count + i] = drainage / dt;
        budget[0] += forcing[i] * dt * area;
        budget[1] += forcing[count + i] * dt * area;
        budget[2] += condensation * area;
        budget[3] += (surface_loss + soil_loss) * area;
        budget[4] += drainage * area;
    }

    for &cell in &topology[count..] {
        let i = cell as usize;
        let volume = state[SURFACE * count + i] * area + incoming[i];
        let routed = routed_volume(volume, area, coefficients[MANNING * count + i], dt);
        state[SURFACE * count + i] = (volume - routed) / area;
        state[DISCHARGE * count + i] = routed / dt;
        let next = topology[i];
        if next < 0 {
            budget[5] += routed;
            state[OUTLET * count + i] = routed / dt;
        } else {
            incoming[next as usize] += routed;
            state[OUTLET * count + i] = 0.0;
        }
    }
}
