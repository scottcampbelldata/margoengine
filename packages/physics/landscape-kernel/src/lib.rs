#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, v128_load, v128_store,
};
use core::slice;
use margoengine_physics_kernel_common::pinned::{exp, ln, pow};

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
    core::arch::wasm32::unreachable()
}

fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

// Stable even when only nanometres move during one world tick.
fn decay_loss(x: f64) -> f64 {
    if x < 0.001 {
        x * (1.0 - x * (0.5 - x * (1.0 / 6.0 - x * (1.0 / 24.0 - x * (1.0 / 120.0 - x / 720.0)))))
    } else {
        1.0 - exp(-x)
    }
}

const NEIGHBOURS: [(isize, isize); 8] = [
    (-1, 0),
    (1, 0),
    (0, -1),
    (0, 1),
    (-1, -1),
    (-1, 1),
    (1, -1),
    (1, 1),
];

#[derive(Clone, Copy)]
struct Grid {
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    outlets: u32,
}

impl Grid {
    fn outlet(self, i: usize) -> bool {
        let (x, z) = (i / self.nz, i % self.nz);
        (x == 0 && self.outlets & 1 != 0)
            || (x + 1 == self.nx && self.outlets & 2 != 0)
            || (z == 0 && self.outlets & 4 != 0)
            || (z + 1 == self.nz && self.outlets & 8 != 0)
    }

    fn adjacent(self, i: usize, k: usize) -> Option<usize> {
        let (ox, oz) = NEIGHBOURS[k];
        let x = (i / self.nz).checked_add_signed(ox)?;
        let z = (i % self.nz).checked_add_signed(oz)?;
        (x < self.nx && z < self.nz).then_some(x * self.nz + z)
    }

    fn distances(self) -> [f64; 8] {
        let square = self.dx * self.dx + self.dz * self.dz;
        let diagonal = if square.is_normal() {
            sqrt(square)
        } else {
            let largest = self.dx.max(self.dz);
            let ratio = self.dx.min(self.dz) / largest;
            largest * sqrt(1.0 + ratio * ratio)
        };
        [
            self.dx, self.dx, self.dz, self.dz, diagonal, diagonal, diagonal, diagonal,
        ]
    }

    fn slope(self, height: &[f64], i: usize, j: usize, distance: f64) -> f64 {
        let difference = height[i] - height[j];
        if difference.is_finite() {
            difference / distance
        } else {
            height[i] / distance - height[j] / distance
        }
    }

    fn route_peak(self, height: &[f64], i: usize, distances: &[f64; 8]) -> f64 {
        let mut peak: f64 = 0.0;
        for (k, &distance) in distances.iter().enumerate() {
            if let Some(j) = self.adjacent(i, k) {
                if height[i] > height[j] {
                    peak = peak.max(self.slope(height, i, j, distance));
                }
            }
        }
        peak
    }

    fn routes(
        self,
        height: &[f64],
        i: usize,
        distances: &[f64; 8],
        scale: f64,
        mut visit: impl FnMut(usize, f64, f64, f64),
    ) -> bool {
        if self.outlet(i) {
            return true;
        }
        for (k, &distance) in distances.iter().enumerate() {
            if let Some(j) = self.adjacent(i, k) {
                if height[i] > height[j] {
                    let slope = self.slope(height, i, j, distance);
                    if !(slope > 0.0 && slope.is_finite()) {
                        return false;
                    }
                    visit(j, distance, slope, pow(slope / scale, 1.1));
                }
            }
        }
        true
    }

    // Freeman's relative weights are invariant under a common positive slope
    // scale. Keep the ordinary order and use scaling only at the ends of f64.
    fn route_stats(
        self,
        height: &[f64],
        i: usize,
        distances: &[f64; 8],
    ) -> Option<(f64, f64, f64)> {
        let (mut normalisation, mut slope, mut length) = (0.0, 0.0, 0.0);
        let mut regular = true;
        if !self.routes(height, i, distances, 1.0, |j, distance, _, weight| {
            let moment = weight * (height[i] - height[j]);
            let span = weight * distance;
            let grade = moment / distance;
            regular &=
                weight.is_normal() && moment.is_normal() && span.is_normal() && grade.is_normal();
            normalisation += weight;
            slope += grade;
            length += span;
        }) {
            return None;
        }
        if regular && normalisation.is_finite() && slope.is_finite() && length.is_finite() {
            if normalisation == 0.0 {
                return Some((0.0, 0.0, 0.0));
            }
            let mean_slope = slope / normalisation;
            let mean_length = length / normalisation;
            if mean_slope > 0.0
                && mean_slope.is_finite()
                && mean_length > 0.0
                && mean_length.is_finite()
            {
                return Some((normalisation, mean_slope, mean_length));
            }
        }
        let peak = self.route_peak(height, i, distances);
        let longest = distances[4];
        (normalisation, slope, length) = (0.0, 0.0, 0.0);
        let mut scaled_length = 0.0;
        self.routes(height, i, distances, peak, |_, distance, edge, weight| {
            normalisation += weight;
            slope += weight * (edge / peak);
            length += weight * distance;
            scaled_length += weight * (distance / longest);
        });
        let mean_slope = (slope / normalisation) * peak;
        let mean_length = if length.is_finite() {
            length / normalisation
        } else {
            (scaled_length / normalisation) * longest
        };
        if mean_slope > 0.0
            && mean_slope.is_finite()
            && mean_length > 0.0
            && mean_length.is_finite()
        {
            // The negative sign marks scaled weights for the later sweeps.
            Some((-normalisation, mean_slope, mean_length))
        } else {
            None
        }
    }

    fn weight_scale(
        self,
        height: &[f64],
        i: usize,
        distances: &[f64; 8],
        normalisation: f64,
    ) -> f64 {
        if normalisation < 0.0 {
            self.route_peak(height, i, distances)
        } else {
            1.0
        }
    }
}

fn routed_share(value: f64, weight: f64, normalisation: f64) -> f64 {
    let scale = value / normalisation;
    if scale.is_normal() || value == 0.0 {
        scale * weight
    } else {
        value * (weight / normalisation)
    }
}

#[repr(C)]
struct Settings {
    incision: f64,
    discharge_exp: f64,
    roughness: f64,
    water_density: f64,
    gravity: f64,
    rock_threshold: f64,
    porosity: f64,
    diffusivity: f64,
    thermal: f64,
    talus: f64,
}

#[repr(C)]
struct Grain {
    diameter: f64,
    relative_density: f64,
    critical_shields: f64,
    parent_fraction: f64,
    travel_length: f64,
}

fn hydraulic_shear(discharge: f64, area: f64, length: f64, slope: f64, settings: &Settings) -> f64 {
    if discharge == 0.0 || settings.gravity == 0.0 {
        return 0.0;
    }
    let width = area / length;
    let flow = discharge * settings.roughness;
    let section = width * sqrt(slope);
    let depth = pow(flow / section, 0.6);
    let shear = settings.water_density * settings.gravity * depth * slope;
    if flow.is_normal() && section.is_normal() && depth.is_normal() && shear.is_normal() {
        shear
    } else {
        // Manning inversion, then rho g h S. Keep the products in range
        // when a small section or a large discharge cancels a large factor.
        let log_slope = ln(slope);
        let log_depth = 0.6
            * (ln(discharge) + ln(settings.roughness) - ln(area) + ln(length) - 0.5 * log_slope);
        exp(ln(settings.water_density) + ln(settings.gravity) + log_depth + log_slope)
    }
}

fn implicit_drop(
    grid: Grid,
    height: &[f64],
    distances: &[f64; 8],
    index: usize,
    weights: f64,
    base: f64,
    potential: &[f64],
    discharge: f64,
    settings: &Settings,
    dt: f64,
) -> Option<f64> {
    if settings.incision == 0.0 || (discharge == 0.0 && settings.discharge_exp > 0.0) {
        return Some(0.0);
    }
    let scale = grid.weight_scale(height, index, distances, weights);
    let normalisation = weights.abs();
    let time_rate = dt * settings.incision;
    let coefficient = time_rate * pow(discharge, settings.discharge_exp) / normalisation;
    let (mut diagonal, mut drop) = (1.0, 0.0);
    let mut regular = time_rate.is_normal() && coefficient.is_normal();
    if !grid.routes(height, index, distances, scale, |j, distance, _, weight| {
        let a = coefficient * weight / distance;
        regular &= a.is_normal();
        diagonal += a;
        drop += a * (base - potential[j]);
    }) {
        return None;
    }
    if regular && diagonal.is_finite() && drop.is_finite() {
        return Some(drop / diagonal);
    }

    // Divide the implicit row by its largest coefficient rather than form
    // inf/inf in the stiff limit. The identity term has coefficient one.
    let mut peak = f64::NEG_INFINITY;
    let mut height_scale = base.abs();
    grid.routes(height, index, distances, scale, |j, distance, _, weight| {
        peak = peak.max(ln(weight) - ln(distance));
        height_scale = height_scale.max(potential[j].abs());
    });
    if height_scale == 0.0 {
        return Some(0.0);
    }
    let flow = if settings.discharge_exp == 0.0 {
        0.0
    } else {
        settings.discharge_exp * ln(discharge)
    };
    let log_strength = ln(dt) + ln(settings.incision) + flow - ln(normalisation) + peak;
    diagonal = exp(-log_strength.max(0.0));
    drop = 0.0;
    grid.routes(height, index, distances, scale, |j, distance, _, weight| {
        let a = exp((ln(weight) - ln(distance) - peak) + log_strength.min(0.0));
        diagonal += a;
        drop += a * (base / height_scale - potential[j] / height_scale);
    });
    let result = (drop / diagonal) * height_scale;
    (!result.is_nan()).then_some(result)
}

fn passing_sediment(
    incoming: f64,
    driving: f64,
    area: f64,
    length: f64,
    grain: &Grain,
    settings: &Settings,
    dt: f64,
) -> Option<f64> {
    if driving == 0.0 {
        return Some(0.0);
    }
    if settings.gravity == 0.0 {
        return None;
    }
    let scaled_gravity = (grain.relative_density - 1.0) * settings.gravity;
    let weight = settings.water_density * scaled_gravity * grain.diameter;
    let shields = driving / weight;
    let excess = (shields - grain.critical_shields).max(0.0);
    let mobility = sqrt(scaled_gravity * grain.diameter * grain.diameter * grain.diameter);
    let capacity =
        3.97 * excess * sqrt(excess) * mobility * (area / length) * dt / (1.0 - settings.porosity);
    let remaining = if grain.travel_length > 0.0 {
        incoming * exp(-length / grain.travel_length)
    } else {
        incoming
    };
    if weight.is_normal()
        && shields.is_normal()
        && ((excess == 0.0 && capacity == 0.0) || capacity.is_normal())
    {
        return Some(capacity.min(remaining));
    }

    // The capacity is rate-limited by available sediment. Keep the Shields
    // and mobility factors separately scaled before making that comparison.
    let log_g = ln(grain.relative_density - 1.0) + ln(settings.gravity);
    let log_d = ln(grain.diameter);
    let log_shields = ln(driving) - ln(settings.water_density) - log_g - log_d;
    let margin = log_shields - ln(grain.critical_shields);
    if margin <= 0.0 {
        return Some(0.0);
    }
    let log_excess = log_shields + ln(decay_loss(margin));
    let log_capacity =
        ln(3.97) + 1.5 * log_excess + 0.5 * (log_g + 3.0 * log_d) + ln(area) - ln(length) + ln(dt)
            - ln(1.0 - settings.porosity);
    (!log_capacity.is_nan()).then(|| exp(log_capacity).min(remaining))
}

// A strict downhill graph has no cycles. Count each node's receivers, then release its donors
// when the last receiver has been placed. The resulting order serves both triangular sweeps.
fn receiver_order(grid: Grid, height: &[f64], count: &mut [u32], order: &mut [u32]) -> bool {
    let mut tail = 0;
    for i in 0..height.len() {
        let receiver_count = if grid.outlet(i) {
            0
        } else {
            (0..NEIGHBOURS.len())
                .filter_map(|k| grid.adjacent(i, k))
                .filter(|&j| height[j] < height[i])
                .count() as u32
        };
        count[i] = receiver_count;
        if receiver_count == 0 {
            order[tail] = i as u32;
            tail += 1;
        }
    }
    let mut head = 0;
    while head < tail {
        let i = order[head] as usize;
        head += 1;
        for k in 0..NEIGHBOURS.len() {
            if let Some(j) = grid.adjacent(i, k) {
                if height[j] > height[i] && !grid.outlet(j) {
                    count[j] -= 1;
                    if count[j] == 0 {
                        order[tail] = j as u32;
                        tail += 1;
                    }
                }
            }
        }
    }
    tail == height.len()
}

// Initialise two nodes at once. Rainfall and uplift are sampled before the update.
fn initialise(
    uplift: &[f64],
    rain: &[f64],
    area: &[f64],
    delta: &mut [f64],
    discharge: &mut [f64],
    dt: f64,
) {
    let n = uplift.len();
    let pair_end = n & !1;
    unsafe {
        for i in (0..pair_end).step_by(2) {
            let u = v128_load(uplift.as_ptr().add(i).cast());
            let p = v128_load(rain.as_ptr().add(i).cast());
            let a = v128_load(area.as_ptr().add(i).cast());
            v128_store(
                delta.as_mut_ptr().add(i).cast(),
                f64x2_mul(u, f64x2_splat(dt)),
            );
            v128_store(discharge.as_mut_ptr().add(i).cast(), f64x2_mul(p, a));
        }
    }
    if pair_end < n {
        delta[pair_end] = dt * uplift[pair_end];
        discharge[pair_end] = rain[pair_end] * area[pair_end];
    }
}

fn erode_class(
    mobile: &mut [f64],
    class_pos: usize,
    mobile_total: f64,
    removal: f64,
    grain: &Grain,
) -> f64 {
    let alluvium = if mobile_total == 0.0 {
        0.0
    } else {
        mobile[class_pos] * (removal.min(mobile_total) / mobile_total)
    };
    mobile[class_pos] -= alluvium;
    alluvium + (removal - mobile_total).max(0.0) * grain.parent_fraction
}

fn diffuse_pair(
    i: usize,
    j: usize,
    area: &[f64],
    floor: &[f64],
    roots: &[f64],
    height: &mut [f64],
    delta: &mut [f64],
    mobile: &mut [f64],
    grains: &[Grain],
    distance: f64,
    face_width: f64,
    settings: &Settings,
    dt: f64,
) -> bool {
    let (up, down) = if height[i] >= height[j] {
        (i, j)
    } else {
        (j, i)
    };
    let n = height.len();
    let mobile_total: f64 = (0..grains.len()).map(|k| mobile[k * n + up]).sum();
    let drop = height[up] - height[down];
    if !(drop.is_finite() && mobile_total.is_finite()) {
        return false;
    }
    let inverse_area = 1.0 / area[up] + 1.0 / area[down];
    let conductance = face_width / distance * inverse_area;
    let minimum = area[up].min(area[down]);
    let area_ratio = 1.0 + minimum / area[up].max(area[down]);
    let log_conductance = || ln(face_width) - ln(distance) - ln(minimum) + ln(area_ratio);
    let rate = |first: f64, second: f64, duration: f64| {
        if (first == 0.0 && second == 0.0) || duration == 0.0 {
            return 0.0;
        }
        let x = (first + second) * conductance * duration;
        if x.is_normal() {
            x
        } else {
            let scale = first.max(second);
            exp(ln(scale) + ln(first / scale + second / scale) + log_conductance() + ln(duration))
        }
    };
    let mut critical = settings.talus * distance;
    if roots[up] > 0.0 && mobile_total > 0.0 && settings.gravity > 0.0 {
        let mass = grains
            .iter()
            .enumerate()
            .map(|(k, grain)| grain.relative_density * mobile[k * n + up])
            .sum::<f64>()
            * settings.water_density
            * (1.0 - settings.porosity);
        if !(mass > 0.0 && mass.is_finite()) {
            return false;
        }
        let root_threshold = roots[up] * area[up] * distance / (mass * settings.gravity);
        critical += if root_threshold.is_normal() {
            root_threshold
        } else {
            exp(ln(roots[up]) + ln(area[up]) + ln(distance) - ln(mass) - ln(settings.gravity))
        };
    }
    let linear = settings.diffusivity;
    let thermal = settings.thermal;
    // While both processes are active, the difference relaxes towards a shifted equilibrium.
    // If it reaches the repose threshold part way through, finish with linear diffusion alone.
    let reduction = if drop > critical && thermal > 0.0 {
        let total = linear + thermal;
        let scale = linear.max(thermal);
        let thermal_share = if total.is_finite() {
            thermal / total
        } else {
            (thermal / scale) / (linear / scale + thermal / scale)
        };
        let equilibrium = thermal_share * critical;
        let loss = (drop - equilibrium) * decay_loss(rate(linear, thermal, dt));
        if loss <= drop - critical || linear == 0.0 || critical == 0.0 {
            loss
        } else {
            let crossing =
                ln((drop - equilibrium) / (critical - equilibrium)) / rate(linear, thermal, 1.0);
            if !crossing.is_finite() {
                return false;
            }
            drop - critical + critical * decay_loss(rate(linear, 0.0, (dt - crossing).max(0.0)))
        }
    } else {
        drop * decay_loss(rate(linear, 0.0, dt))
    };
    if !(critical >= 0.0 && reduction.is_finite()) {
        return false;
    }
    let reduction = reduction.max(0.0);
    let available = if inverse_area.is_normal() || reduction == 0.0 {
        reduction / inverse_area
    } else {
        exp(ln(reduction) + ln(minimum) - ln(area_ratio))
    };
    let volume = available.min((height[up] - floor[up]).max(0.0) * area[up]);
    let cut = volume / area[up];
    let fill = volume / area[down];
    height[up] -= cut;
    height[down] += fill;
    delta[up] -= cut;
    delta[down] += fill;
    for (k, grain) in grains.iter().enumerate() {
        let moved = erode_class(mobile, k * n + up, mobile_total, volume, grain);
        mobile[k * n + down] += moved;
    }
    [height[up], height[down], delta[up], delta[down]]
        .iter()
        .all(|value| value.is_finite())
}

fn diffuse(
    grid: Grid,
    height: &mut [f64],
    delta: &mut [f64],
    floor: &[f64],
    area: &[f64],
    roots: &[f64],
    mobile: &mut [f64],
    grains: &[Grain],
    settings: &Settings,
    dt: f64,
) -> bool {
    if settings.diffusivity == 0.0 && settings.thermal == 0.0 {
        return true;
    }
    // Symmetric splitting over four matchings. Within a matching no two faces share vertices.
    for colour in [0, 1, 2, 3, 2, 1, 0] {
        let along_x = colour < 2;
        let duration = if colour == 3 { dt } else { dt * 0.5 };
        let (distance, width) = if along_x {
            (grid.dx, grid.dz)
        } else {
            (grid.dz, grid.dx)
        };
        for i in 0..height.len() {
            let (along, cross, cross_count) = if along_x {
                (i / grid.nz, i % grid.nz, grid.nz)
            } else {
                (i % grid.nz, i / grid.nz, grid.nx)
            };
            if along % 2 != colour % 2 || grid.outlet(i) {
                continue;
            }
            if let Some(j) = grid.adjacent(i, if along_x { 1 } else { 3 }) {
                if !grid.outlet(j) {
                    let face_width = if cross == 0 || cross + 1 == cross_count {
                        width * 0.5
                    } else {
                        width
                    };
                    if !diffuse_pair(
                        i, j, area, floor, roots, height, delta, mobile, grains, distance,
                        face_width, settings, duration,
                    ) {
                        return false;
                    }
                }
            }
        }
    }
    true
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn landscape_step(
    input_ptr: *const f64,
    constants_ptr: *const f64,
    settings: *const f64,
    grain_ptr: *const f64,
    state_ptr: *mut f64,
    delta_ptr: *mut f64,
    budget_ptr: *mut f64,
    scratch_ptr: *mut f64,
    topology_ptr: *mut u32,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    classes: usize,
    outlets: u32,
    dt: f64,
) -> u32 {
    let Some(n) = nx.checked_mul(nz) else {
        return 1;
    };
    let Some(words) = classes
        .checked_add(6)
        .and_then(|planes| n.checked_mul(planes))
    else {
        return 1;
    };
    if !(n > 0
        && words <= isize::MAX as usize / core::mem::size_of::<f64>()
        && dx > 0.0
        && dx.is_finite()
        && dz > 0.0
        && dz.is_finite()
        && dt > 0.0
        && dt.is_finite())
    {
        return 1;
    }
    let grid = Grid {
        nx,
        nz,
        dx,
        dz,
        outlets,
    };
    let distances = grid.distances();
    let settings = unsafe { &*settings.cast::<Settings>() };
    let grains = unsafe { slice::from_raw_parts(grain_ptr.cast::<Grain>(), classes) };
    if !distances[4].is_finite()
        || ![
            settings.incision,
            settings.discharge_exp,
            settings.roughness,
            settings.water_density,
            settings.gravity,
            settings.rock_threshold,
            settings.porosity,
            settings.diffusivity,
            settings.thermal,
            settings.talus,
        ]
        .iter()
        .all(|&value| value >= 0.0 && value.is_finite())
        || !(settings.roughness > 0.0 && settings.water_density > 0.0 && settings.porosity < 1.0)
        || grains.iter().any(|grain| {
            !(grain.diameter > 0.0
                && grain.diameter.is_finite()
                && grain.relative_density > 1.0
                && grain.relative_density.is_finite()
                && [
                    grain.critical_shields,
                    grain.parent_fraction,
                    grain.travel_length,
                ]
                .iter()
                .all(|&value| value >= 0.0 && value.is_finite()))
        })
    {
        return 1;
    }
    let input = unsafe { slice::from_raw_parts(input_ptr, n * 4) };
    let constants = unsafe { slice::from_raw_parts(constants_ptr, n * 3) };
    let (height, inputs) = input.split_at(n);
    let (effective_rain, inputs) = inputs.split_at(n);
    let (forced_shear, root) = inputs.split_at(n);
    let (area, constants) = constants.split_at(n);
    let (uplift, floor) = constants.split_at(n);
    let (state, mobile) =
        unsafe { slice::from_raw_parts_mut(state_ptr, n * (3 + classes)) }.split_at_mut(3 * n);
    let (discharge, diagnostics) = state.split_at_mut(n);
    let (incision, sediment_rate) = diagnostics.split_at_mut(n);
    let delta = unsafe { slice::from_raw_parts_mut(delta_ptr, n) };
    let budget = unsafe { slice::from_raw_parts_mut(budget_ptr, 3 + classes) };
    let scratch = unsafe { slice::from_raw_parts_mut(scratch_ptr, n * (6 + classes)) };
    let (base, scratch) = scratch.split_at_mut(n);
    let (potential, scratch) = scratch.split_at_mut(n);
    let (normalisation, scratch) = scratch.split_at_mut(n);
    let (slope, scratch) = scratch.split_at_mut(n);
    let (shear, scratch) = scratch.split_at_mut(n);
    let (length, load) = scratch.split_at_mut(n);
    let (counts, order) = unsafe { slice::from_raw_parts_mut(topology_ptr, 2 * n) }.split_at_mut(n);

    if !height
        .iter()
        .chain(uplift)
        .chain(forced_shear)
        .chain(budget.iter())
        .all(|value| value.is_finite())
        || !area.iter().all(|&value| value > 0.0 && value.is_finite())
        || !floor
            .iter()
            .all(|&value| value == f64::NEG_INFINITY || value.is_finite())
        || !effective_rain
            .iter()
            .chain(root)
            .chain(mobile.iter())
            .all(|&value| value >= 0.0 && value.is_finite())
    {
        return 1;
    }
    initialise(uplift, effective_rain, area, delta, discharge, dt);
    for i in 0..n {
        if !(delta[i].is_finite() && discharge[i].is_finite()) {
            return 1;
        }
        if grid.outlet(i) {
            delta[i] = 0.0;
        } else {
            delta[i] = delta[i].max((floor[i] - height[i]).min(0.0));
            budget[1] += delta[i] * area[i];
        }
        base[i] = height[i] + delta[i];
        if !(base[i].is_finite() && budget[1].is_finite()) {
            return 1;
        }
        let Some((weights, grade, distance)) = grid.route_stats(height, i, &distances) else {
            return 1;
        };
        (normalisation[i], slope[i], length[i]) = (weights, grade, distance);
    }
    if !receiver_order(grid, height, counts, order) {
        return 1;
    }
    for &index in order.iter().rev() {
        let i = index as usize;
        let incoming = discharge[i];
        if !incoming.is_finite() {
            return 1;
        }
        if normalisation[i] != 0.0 {
            let scale = grid.weight_scale(height, i, &distances, normalisation[i]);
            grid.routes(height, i, &distances, scale, |j, _, _, weight| {
                discharge[j] += routed_share(incoming, weight, normalisation[i].abs());
            });
            shear[i] = if forced_shear[i] >= 0.0 {
                forced_shear[i]
            } else {
                hydraulic_shear(incoming, area[i], length[i], slope[i], settings)
            };
            if !shear[i].is_finite() {
                return 1;
            }
        } else {
            shear[i] = 0.0;
        }
    }

    // Backward Euler for the weighted linear-slope stream-power law. The downstream solved
    // elevations are already available. Write the drop directly to preserve sub-ULP erosion.
    for &index in order.iter() {
        let i = index as usize;
        let mut drop = 0.0;
        if normalisation[i] != 0.0 && shear[i] > settings.rock_threshold + root[i] {
            let Some(solved) = implicit_drop(
                grid,
                height,
                &distances,
                i,
                normalisation[i],
                base[i],
                potential,
                discharge[i],
                settings,
                dt,
            ) else {
                return 1;
            };
            drop = solved.max(0.0).min((base[i] - floor[i]).max(0.0));
        }
        potential[i] = base[i] - drop;
        incision[i] = drop / dt;
        if !(potential[i].is_finite() && incision[i].is_finite()) {
            return 1;
        }
    }

    load.fill(0.0);
    sediment_rate.fill(0.0);
    for &index in order.iter().rev() {
        let i = index as usize;
        let removal = incision[i] * dt * area[i];
        let mobile_total = (0..classes).map(|k| mobile[k * n + i]).sum::<f64>();
        if !(removal.is_finite() && mobile_total.is_finite()) {
            return 1;
        }
        // Maintain the change separately so an update smaller than the height ULP reaches the bed.
        delta[i] -= removal / area[i];
        for (k, grain) in grains.iter().enumerate() {
            let p = k * n + i;
            let incoming = load[p] + erode_class(mobile, p, mobile_total, removal, grain);
            if !incoming.is_finite() {
                return 1;
            }
            if grid.outlet(i) {
                budget[3 + k] += incoming;
                sediment_rate[i] += incoming / dt;
                if !budget[3 + k].is_finite() {
                    return 1;
                }
                continue;
            }
            let mut passing = 0.0;
            if normalisation[i] != 0.0 && incoming > 0.0 {
                let Some(accepted) = passing_sediment(
                    incoming,
                    (shear[i] - root[i]).max(0.0),
                    area[i],
                    length[i],
                    grain,
                    settings,
                    dt,
                ) else {
                    return 1;
                };
                passing = accepted;
                let scale = grid.weight_scale(height, i, &distances, normalisation[i]);
                grid.routes(height, i, &distances, scale, |j, _, _, weight| {
                    load[k * n + j] += routed_share(passing, weight, normalisation[i].abs());
                });
            }
            let deposited = incoming - passing;
            mobile[p] += deposited;
            delta[i] += deposited / area[i];
            sediment_rate[i] += passing / dt;
        }
        base[i] = height[i] + delta[i];
        if !(base[i].is_finite() && sediment_rate[i].is_finite()) {
            return 1;
        }
    }

    if !diffuse(
        grid, base, delta, floor, area, root, mobile, grains, settings, dt,
    ) {
        return 1;
    }
    budget[0] += dt;
    budget[2] = mobile.iter().sum();
    if !delta
        .iter()
        .chain(budget.iter())
        .all(|value| value.is_finite())
        || !mobile
            .iter()
            .all(|&value| value >= 0.0 && value.is_finite())
    {
        return 1;
    }
    0
}
