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

// Halving from the largest finite f64 to the least subnormal requires
// traversing the exponent range and the significand. Allow one more
// significand for convergence away from zero.
const BISECTIONS: i32 = f64::MAX_EXP - f64::MIN_EXP + 2 * f64::MANTISSA_DIGITS as i32;

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

fn residual_ratio(x: f64) -> f64 {
    let mut term = 1.0;
    let mut residual = 0.5;
    for order in 3..=20 {
        term *= -x;
        residual += term / order as f64;
    }
    residual
}

fn scaled_elapsed(delta: f64, front: f64, suction: f64) -> f64 {
    let scale = front.max(suction);
    let front_fraction = front / scale;
    let suction_fraction = suction / scale;
    let denominator = front_fraction + suction_fraction;
    let x = (delta / scale) / denominator;
    let suction_fraction = suction_fraction / denominator;
    if x.is_infinite() {
        return delta;
    }
    if x >= 0.125 {
        return delta * (1.0 - suction_fraction * (ln(1.0 + x) / x));
    }
    // (x - ln(1 + x))/x². Keep the factor x² split across the large
    // quantities so a representable elapsed depth cannot underflow early.
    let from_front = if x > 0.0 {
        front * x
    } else {
        delta * (front_fraction / denominator)
    };
    from_front + ((delta * suction_fraction) * x) * residual_ratio(x)
}

fn log_elapsed(delta: f64, front: f64, suction: f64) -> f64 {
    let scale = front.max(suction);
    let denominator = front / scale + suction / scale;
    let log_x = ln(delta) - ln(scale) - ln(denominator);
    let x = exp(log_x);
    if x >= 0.125 {
        let correction = if x.is_infinite() {
            0.0
        } else {
            ln(1.0 + x) / x
        };
        return ln(delta) + ln(1.0 - ((suction / scale) / denominator) * correction);
    }
    let linear = ln(front) + log_x;
    let quadratic = ln(suction) + 2.0 * log_x + ln(residual_ratio(x));
    let high = linear.max(quadratic);
    high + ln(1.0 + exp(linear.min(quadratic) - high))
}

fn ponded_increment(
    front: f64,
    suction: f64,
    conductivity: f64,
    dt: f64,
    available: f64,
) -> Option<f64> {
    let capacity = conductivity * dt;
    if suction == 0.0 || dt == 0.0 || available == 0.0 {
        return Some(capacity.min(available));
    }
    if capacity >= available {
        return Some(available);
    }
    let denominator = front + suction;
    let normal_capacity = capacity.is_normal();
    let threshold = if normal_capacity {
        capacity
    } else {
        ln(conductivity) + ln(dt)
    };
    let elapsed_depth = |delta: f64| {
        if !normal_capacity {
            return log_elapsed(delta, front, suction);
        }
        let x = delta / denominator;
        let elapsed = if x >= 0.125 {
            delta - suction * (ln(denominator + delta) - ln(denominator))
        } else if (x * x).is_normal() {
            front * x + suction * log_residual(x)
        } else {
            return scaled_elapsed(delta, front, suction);
        };
        if elapsed >= 0.0 && elapsed.is_finite() {
            elapsed
        } else {
            scaled_elapsed(delta, front, suction)
        }
    };
    let elapsed = elapsed_depth(available);
    if !elapsed.is_finite() {
        return None;
    }
    if elapsed <= threshold {
        return Some(available);
    }
    let mut lo = 0.0;
    let mut hi = available;
    for _ in 0..BISECTIONS {
        let mid = lo + (hi - lo) * 0.5;
        if mid == lo || mid == hi {
            return Some(lo);
        }
        let elapsed = elapsed_depth(mid);
        if !elapsed.is_finite() {
            return None;
        }
        if elapsed > threshold {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    None
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
) -> Option<f64> {
    if available == 0.0 || conductivity == 0.0 {
        return Some(0.0);
    }
    if ponded > 0.0 {
        return ponded_increment(front, suction, conductivity, dt, available);
    }
    if offered_rate <= conductivity {
        return Some(available);
    }
    let excess_rate = offered_rate - conductivity;
    let suction_flux = conductivity * suction;
    let at_ponding = if suction == 0.0 || suction_flux.is_normal() {
        suction_flux / excess_rate
    } else {
        exp(ln(conductivity) + ln(suction) - ln(excess_rate))
    };
    let before_ponding = (at_ponding - front).max(0.0).min(available);
    let remaining_time = (dt - before_ponding / offered_rate).max(0.0);
    let wetted_front = front + before_ponding;
    if !wetted_front.is_finite() || at_ponding.is_nan() {
        return None;
    }
    Some(
        before_ponding
            + ponded_increment(
                wetted_front,
                suction,
                conductivity,
                remaining_time,
                available - before_ponding,
            )?,
    )
}

// Backward Euler upwind volume balance. Substituting u = depth^(1/3) leaves a monotone polynomial.
fn direct_route(water: f64, area: f64, rating: f64) -> Option<(f64, f64)> {
    let depth = water / area;
    if !(depth.is_normal() && rating.is_normal()) {
        return None;
    }
    let mut hi = pow(depth, 1.0 / 3.0);
    let mut lo = 0.0;
    for _ in 0..BISECTIONS {
        let mid = lo + (hi - lo) * 0.5;
        if mid == lo || mid == hi {
            let square = lo * lo;
            let rated_square = rating * square;
            let volume = rated_square * square * lo;
            if !(rated_square.is_normal() && volume.is_normal()) {
                return None;
            }
            let routed = volume.min(water);
            let rooted_depth = square * lo;
            let stored = area * rooted_depth;
            // At most four products and one rounded sum enter the balance.
            // When the storage is smaller than their roundoff, subtraction
            // cannot recover it. The independently solved depth still can.
            if stored <= (8.0 * f64::EPSILON) * water {
                return Some((water - stored, rooted_depth));
            }
            return Some((routed, (water - routed) / area));
        }
        let square = mid * mid;
        let cube = square * mid;
        let stored = area * cube;
        let rated_cube = rating * cube;
        let routed = rated_cube * square;
        if !(cube.is_normal() && stored.is_normal() && rated_cube.is_normal() && routed.is_normal())
        {
            return None;
        }
        if stored + routed > water {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    None
}

fn scaled_route(water: f64, area: f64, rating: f64, dt: f64) -> Option<(f64, f64)> {
    // Divide the balance by W and evaluate each positive term from its log.
    // Either term by itself bounds u from above. A factor two brackets the
    // root even after rounding the log/exp conversion.
    let log_water = ln(water);
    let stock = ln(area) - log_water;
    let flux = ln(rating) + ln(dt) - log_water;
    let mut hi = 2.0 * exp((-stock / 3.0).min(-flux / 5.0));
    if !(hi > 0.0 && hi.is_finite()) {
        return None;
    }
    let mut lo = 0.0;
    for _ in 0..BISECTIONS {
        let mid = lo + (hi - lo) * 0.5;
        if mid == lo || mid == hi {
            let log_fraction = flux + 5.0 * ln(lo);
            let fraction = exp(log_fraction);
            let depth = lo * lo * lo;
            if fraction.is_finite() && depth.is_finite() {
                let volume = if fraction.is_normal() {
                    water * fraction.min(1.0)
                } else {
                    exp(log_water + log_fraction)
                };
                return Some((volume, depth));
            }
            return None;
        }
        let log_u = ln(mid);
        let balance = exp(stock + 3.0 * log_u) + exp(flux + 5.0 * log_u);
        if balance.is_nan() {
            return None;
        }
        if balance > 1.0 {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    None
}

fn routed_volume(water: f64, area: f64, rating: f64, dt: f64) -> Option<(f64, f64)> {
    if !(water >= 0.0 && water.is_finite() && rating >= 0.0 && rating.is_finite()) {
        return None;
    }
    if water == 0.0 || rating == 0.0 {
        return Some((0.0, water / area));
    }
    if let Some(solution) = direct_route(water, area, rating * dt) {
        return Some(solution);
    }
    scaled_route(water, area, rating, dt)
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

fn finite_mean(sum: f64, count: usize, value: impl Fn(usize) -> f64) -> f64 {
    if sum.is_finite() {
        return sum / count as f64;
    }
    let mut scale: f64 = 0.0;
    for i in 0..count {
        let word = value(i);
        if !word.is_finite() {
            return f64::NAN;
        }
        scale = scale.max(word.abs());
    }
    let mut scaled_sum = 0.0;
    for i in 0..count {
        scaled_sum += value(i) / scale;
    }
    (scaled_sum / count as f64) * scale
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
) -> u32 {
    if !(count > 0
        && count <= isize::MAX as usize / (PLANES * core::mem::size_of::<f64>())
        && area > 0.0
        && area.is_finite()
        && dt > 0.0
        && dt.is_finite()
        && topographic_scale >= 0.0
        && topographic_scale.is_finite())
    {
        return 1;
    }
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
        mean_deficit = finite_mean(mean_deficit, count, |i| {
            coefficients[SOIL_CAPACITY * count + i] - state[SOIL * count + i]
        });
        mean_index = finite_mean(mean_index, count, |i| coefficients[TOPOGRAPHY * count + i]);
        if !(mean_deficit.is_finite() && mean_index.is_finite()) {
            return 1;
        }
    }

    for i in 0..count {
        let evaporation = forcing[2 * count + i] * dt;
        let condensation = (-evaporation).max(0.0);
        let mut surface = state[SURFACE * count + i];
        let mut soil = state[SOIL * count + i];
        let mut front = state[FRONT * count + i];
        let capacity = coefficients[SOIL_CAPACITY * count + i];
        let suction = coefficients[SUCTION_DEFICIT * count + i];
        let conductivity = coefficients[CONDUCTIVITY * count + i];
        let coefficient = coefficients[DRAINAGE * count + i];
        if !evaporation.is_finite()
            || ![
                surface,
                soil,
                front,
                capacity,
                suction,
                conductivity,
                coefficient,
                forcing[i],
                forcing[count + i],
            ]
            .iter()
            .all(|word| *word >= 0.0 && word.is_finite())
        {
            return 1;
        }
        let surface_loss = evaporation.max(0.0).min(surface);
        surface -= surface_loss;
        let soil_loss = (evaporation - surface_loss).max(0.0).min(soil);
        soil -= soil_loss;

        let offered = supply[i] + condensation / dt;
        let available = surface + offered * dt;
        if !(offered.is_finite() && available.is_finite()) {
            return 1;
        }
        let local_deficit = (capacity - soil).max(0.0);
        let deficit = if topographic_scale > 0.0 {
            let index = coefficients[TOPOGRAPHY * count + i];
            let difference = mean_index - index;
            let correction = if difference.is_finite() {
                topographic_scale * difference
            } else {
                topographic_scale * mean_index - topographic_scale * index
            };
            let adjusted = mean_deficit + correction;
            if adjusted.is_nan() {
                return 1;
            }
            local_deficit.min(adjusted.max(0.0))
        } else {
            local_deficit
        };
        let Some(infiltrated) = infiltration(
            front,
            suction,
            conductivity,
            surface,
            offered,
            available,
            dt,
        ) else {
            return 1;
        };
        let infiltrated = infiltrated.min(deficit);
        soil += infiltrated;
        front += infiltrated;
        let drainage = soil * (1.0 - exp(-coefficient * dt));
        let remaining_soil = soil - drainage;
        // When no water feeds the front, redistribution and evapotranspiration restore the dry soil's capacity.
        let stored_before_dry = soil + soil_loss;
        if available == 0.0 && stored_before_dry > 0.0 {
            if !stored_before_dry.is_finite() {
                return 1;
            }
            front *= remaining_soil / stored_before_dry;
        }
        let next = [
            (available - infiltrated).max(0.0),
            remaining_soil,
            front,
            infiltrated / dt,
            drainage / dt,
        ];
        let ledger = [
            forcing[i] * dt * area,
            forcing[count + i] * dt * area,
            condensation * area,
            (surface_loss + soil_loss) * area,
            drainage * area,
        ];
        if !next
            .iter()
            .chain(ledger.iter())
            .all(|word| *word >= 0.0 && word.is_finite())
        {
            return 1;
        }
        let [surface, soil, front, infiltration_rate, recharge_rate] = next;
        state[SURFACE * count + i] = surface;
        state[SOIL * count + i] = soil;
        state[FRONT * count + i] = front;
        state[INFILTRATION * count + i] = infiltration_rate;
        state[RECHARGE * count + i] = recharge_rate;
        for (total, delta) in budget.iter_mut().zip(ledger) {
            *total += delta;
            if !total.is_finite() {
                return 1;
            }
        }
    }

    for &cell in &topology[count..] {
        let i = cell as usize;
        if i >= count {
            return 1;
        }
        let volume = state[SURFACE * count + i] * area + incoming[i];
        let Some((routed, depth)) =
            routed_volume(volume, area, coefficients[MANNING * count + i], dt)
        else {
            return 1;
        };
        let discharge = routed / dt;
        if !(depth >= 0.0 && depth.is_finite() && discharge >= 0.0 && discharge.is_finite()) {
            return 1;
        }
        state[SURFACE * count + i] = depth;
        state[DISCHARGE * count + i] = discharge;
        let next = topology[i];
        if next < 0 {
            budget[5] += routed;
            if !budget[5].is_finite() {
                return 1;
            }
            state[OUTLET * count + i] = discharge;
        } else {
            if next as usize >= count {
                return 1;
            }
            incoming[next as usize] += routed;
            if !incoming[next as usize].is_finite() {
                return 1;
            }
            state[OUTLET * count + i] = 0.0;
        }
    }
    0
}
