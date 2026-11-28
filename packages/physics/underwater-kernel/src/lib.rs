#![no_std]

use core::arch::wasm32::{
    f64x2, f64x2_abs, f64x2_add, f64x2_extract_lane, f64x2_floor, f64x2_le, f64x2_mul, f64x2_splat,
    f64x2_sqrt, i64x2_bitmask, unreachable,
};
use core::f64::consts::{FRAC_PI_2, PI, TAU};
use core::slice;
use margoengine_physics_kernel_common::pinned::{exp, ln};

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

const EXACT_INTEGER: f64 = 9_007_199_254_740_991.0;
const PROFILE_WORDS: usize = 3;
const TRACE_WORDS: usize = 17;

// Status values are shared with the TypeScript owner of the candidate state.
const NUMERIC_RANGE: u32 = 1;
const TIME_RESOLUTION: u32 = 2;
const REFLECTION_COUNT: u32 = 4;

#[derive(Clone, Copy)]
#[repr(C)]
struct Knot {
    depth: f64,
    speed: f64,
    gradient: f64,
}

#[repr(C)]
struct Ray {
    layer: f64,
    range: f64,
    depth: f64,
    vertical: f64,
    slowness: f64,
    time: f64,
    length: f64,
    frequency: f64,
    launch_speed: f64,
    epsilon: f64,
    q_real: f64,
    q_imag: f64,
    p_real: f64,
    p_imag: f64,
    gouy: f64,
    pressure: f64,
    reflections: f64,
}

const _: () = assert!(core::mem::size_of::<Ray>() == TRACE_WORDS * 8);
const _: () = assert!(core::mem::size_of::<Knot>() == PROFILE_WORDS * 8);

#[derive(Clone, Copy)]
struct Boundaries {
    surface: f64,
    bottom: f64,
}

#[derive(Default)]
#[repr(C)]
struct Work {
    rays: f64,
    drifts: f64,
    crossings: f64,
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

fn floor(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(value)))
}

fn exact_count(value: f64) -> bool {
    value >= 0.0 && value <= EXACT_INTEGER && value == value as u64 as f64
}

fn reflection_power(mut factor: f64, mut count: u64) -> f64 {
    let mut value = 1.0;
    while count > 0 {
        if count & 1 == 1 {
            value *= factor;
        }
        count /= 2;
        factor *= factor;
    }
    value
}

// Same half-angle polynomial and quadrant convention as space/angles.ts.
fn atan2(y: f64, x: f64) -> f64 {
    let ay = y.abs();
    let ax = x.abs();
    if ax == 0.0 && ay == 0.0 {
        return 0.0;
    }
    let steep = ay > ax;
    let ratio = if steep { ax / ay } else { ay / ax };
    let h = ratio / (1.0 + sqrt(1.0 + ratio * ratio));
    let h2 = h * h;
    let mut p = 0.0;
    for n in (0..=19).rev() {
        let sign = if n % 2 == 0 { 1.0 } else { -1.0 };
        p = sign / f64::from(2 * n + 1) + h2 * p;
    }
    let a = 2.0 * h * p;
    let quadrant = if steep { FRAC_PI_2 - a } else { a };
    let angle = if x < 0.0 { PI - quadrant } else { quadrant };
    if y < 0.0 { -angle } else { angle }
}

fn log_one_plus(x: f64) -> f64 {
    let y = 1.0 + x;
    if y == 1.0 { x } else { (ln(y) * x) / (y - 1.0) }
}

fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

fn tanh(x: f64) -> f64 {
    if x.abs() < 1.0 / 32.0 {
        let xx = x * x;
        return x
            * (1.0
                + xx * (-1.0 / 3.0
                    + xx * (2.0 / 15.0
                        + xx * (-17.0 / 315.0
                            + xx * (62.0 / 2835.0 - (1382.0 / 155925.0) * xx)))));
    }
    let e = exp(-2.0 * x.abs());
    (js_sign(x) * (1.0 - e)) / (1.0 + e)
}

fn vertical_at(slowness: f64, speed: f64) -> f64 {
    let horizontal = slowness * speed;
    sqrt(((1.0 - horizontal) * (1.0 + horizontal)).max(0.0))
}

fn exit_time(
    delta: f64,
    toward: f64,
    speed: f64,
    slope: f64,
    vertical: f64,
    slowness: f64,
    edge_speed: f64,
) -> f64 {
    if slope == 0.0 {
        return if vertical * toward > 0.0 {
            delta / (speed * vertical)
        } else {
            f64::INFINITY
        };
    }
    let edge_vertical = vertical_at(slowness, edge_speed);
    if edge_vertical == 0.0 {
        return f64::INFINITY;
    }
    let moving_toward = vertical * toward >= 0.0;
    if !moving_toward && slope * toward > 0.0 {
        return f64::INFINITY;
    }
    let from = vertical.abs();
    if !moving_toward {
        let from_angle = ln((1.0 + from) / (slowness * speed));
        let to_angle = ln((1.0 + edge_vertical) / (slowness * edge_speed));
        return (js_sign(vertical) * (from_angle + to_angle)) / slope;
    }
    let change = slope * delta;
    let vertical_difference =
        (slowness * slowness * change * (speed + edge_speed)) / (from + edge_vertical);
    let ratio_change =
        change / speed + (edge_speed / speed) * (vertical_difference / (1.0 + edge_vertical));
    let time = (toward * log_one_plus(ratio_change)) / slope;
    if time.is_nan() { time } else { time.max(0.0) }
}

impl Ray {
    fn finite(&self) -> bool {
        // The fixed row is repr(C) with 17 consecutive f64 words.
        let words =
            unsafe { slice::from_raw_parts((self as *const Self).cast::<f64>(), TRACE_WORDS) };
        words.iter().all(|word| word.is_finite())
    }

    fn drift(&mut self, integral: f64) {
        let x = self.q_real;
        let y = self.q_imag;
        let change = f64x2_mul(f64x2_splat(integral), f64x2(self.p_real, self.p_imag));
        let next = f64x2_add(f64x2(x, y), change);
        let dx = f64x2_extract_lane::<0>(change);
        let dy = f64x2_extract_lane::<1>(change);
        let next_x = f64x2_extract_lane::<0>(next);
        let next_y = f64x2_extract_lane::<1>(next);
        let mut cross = x * dy - y * dx;
        let mut dot = x * next_x + y * next_y;
        if !cross.is_finite()
            || !dot.is_finite()
            || (cross == 0.0 && dot == 0.0 && (dx != 0.0 || dy != 0.0))
        {
            let before_scale = x.abs().max(y.abs());
            let after_scale = next_x.abs().max(next_y.abs());
            let a = x / before_scale;
            let b = y / before_scale;
            let c = next_x / after_scale;
            let d = next_y / after_scale;
            cross = a * d - b * c;
            dot = a * c + b * d;
        }
        self.gouy = (self.gouy - 0.5 * atan2(cross, dot)) % TAU;
        self.q_real = next_x;
        self.q_imag = next_y;
    }

    fn advance_inside(&mut self, speed: f64, slope: f64, dt: f64) {
        if dt == 0.0 {
            return;
        }
        let u = self.vertical;
        let slowness = self.slowness;
        let mut integral = speed * speed * dt;
        let mut depth = speed * u * dt;
        let mut length = speed * dt;
        if slope != 0.0 {
            let w = tanh(slope * dt);
            let stretch = sqrt((1.0 - w) * (1.0 + w));
            let divisor = 1.0 - u * w;
            let scale = if w == 0.0 { dt } else { w / slope };
            integral = (speed * speed * scale) / divisor;
            depth = (speed * scale * (u - w / (1.0 + stretch))) / divisor;
            self.vertical = (u - w) / divisor;
            if slowness == 0.0 {
                length = depth.abs();
            } else {
                let horizontal = slowness * speed;
                let next_u = self.vertical;
                let next_horizontal = (horizontal * stretch) / divisor;
                let angle_sine = (horizontal * w * (1.0 - (u * w) / (1.0 + stretch))) / divisor;
                length = if w == 0.0 {
                    speed * dt
                } else {
                    atan2(angle_sine, u * next_u + horizontal * next_horizontal)
                        / (slowness * slope)
                };
            }
        }
        let next = f64x2_add(
            f64x2(self.range, self.depth),
            f64x2(slowness * integral, depth),
        );
        self.range = f64x2_extract_lane::<0>(next);
        self.depth = f64x2_extract_lane::<1>(next);
        self.length += length;
        self.drift(integral);
    }

    fn bend(&mut self, slope_change: f64, vertical: f64) {
        if slope_change == 0.0 || vertical == 0.0 {
            return;
        }
        let kick = (-slope_change * self.slowness * self.slowness) / vertical;
        self.p_real += kick * self.q_real;
        self.p_imag += kick * self.q_imag;
    }

    fn fold_uniform(
        &mut self,
        speed: f64,
        bottom: f64,
        dt: f64,
        edge: Boundaries,
    ) -> Result<Option<f64>, u32> {
        let vertical = self.vertical;
        let travelled = (speed * vertical * dt).abs();
        let first_is_bottom = vertical > 0.0;
        let first_distance = if first_is_bottom {
            bottom - self.depth
        } else {
            self.depth
        };
        let past_first = travelled - first_distance;
        if !(past_first >= 16.0 * bottom) {
            return Ok(None);
        }
        let further = floor(past_first / bottom);
        let reflections = further + 1.0;
        let total = self.reflections + reflections;
        if !exact_count(reflections) || !exact_count(total) {
            return Err(REFLECTION_COUNT);
        }
        let last_is_bottom = first_is_bottom == (further as u64 & 1 == 0);
        let tail = past_first % bottom;
        let pairs = reflections as u64 / 2;
        let unpaired = reflections as u64 & 1;
        self.advance_inside(speed, 0.0, dt);
        self.depth = if last_is_bottom { bottom - tail } else { tail };
        self.vertical = if last_is_bottom {
            -vertical.abs()
        } else {
            vertical.abs()
        };
        self.pressure = self.pressure
            * reflection_power(
                edge.surface,
                pairs + if first_is_bottom { 0 } else { unpaired },
            )
            * reflection_power(
                edge.bottom,
                pairs + if first_is_bottom { unpaired } else { 0 },
            );
        self.reflections = total;
        Ok(Some(reflections))
    }

    fn advance(&mut self, profile: &[Knot], dt: f64, edge: Boundaries, work: &mut Work) -> u32 {
        if !self.finite() {
            return NUMERIC_RANGE;
        }
        if !exact_count(self.reflections) {
            return REFLECTION_COUNT;
        }
        let slowness = self.slowness;
        let mut remaining = dt;
        let mut previous_zero_time = false;
        if let [top, bottom] = profile {
            if top.gradient == 0.0
                && self.layer == 0.0
                && self.depth >= top.depth
                && self.depth <= bottom.depth
            {
                match self.fold_uniform(top.speed, bottom.depth, dt, edge) {
                    Ok(Some(crossings)) => {
                        work.drifts += 1.0;
                        work.crossings += crossings;
                        remaining = 0.0;
                    }
                    Ok(None) => {}
                    Err(status) => return status,
                }
            }
        }
        while remaining > 0.0 {
            let layer = self.layer as usize;
            if layer as f64 != self.layer || layer >= profile.len() - 1 {
                return NUMERIC_RANGE;
            }
            let top = unsafe { *profile.as_ptr().add(layer) };
            let bottom = unsafe { *profile.as_ptr().add(layer + 1) };
            let depth = self.depth;
            let speed = if depth == bottom.depth {
                bottom.speed
            } else {
                top.speed + (depth - top.depth) * top.gradient
            };
            if !(depth >= top.depth && depth <= bottom.depth && speed > 0.0 && speed.is_finite()) {
                return NUMERIC_RANGE;
            }
            let vertical = self.vertical;
            let pinned = vertical == 0.0
                && ((depth == top.depth && top.gradient > 0.0)
                    || (depth == bottom.depth && top.gradient < 0.0));
            let slope = if pinned { 0.0 } else { top.gradient };
            let upper = exit_time(
                top.depth - depth,
                -1.0,
                speed,
                slope,
                vertical,
                slowness,
                top.speed,
            );
            let lower = exit_time(
                bottom.depth - depth,
                1.0,
                speed,
                slope,
                vertical,
                slowness,
                bottom.speed,
            );
            if upper.is_nan() || lower.is_nan() {
                return NUMERIC_RANGE;
            }
            let exit = upper.min(lower);
            if exit > remaining {
                self.advance_inside(speed, slope, remaining);
                if !self.depth.is_finite() {
                    return NUMERIC_RANGE;
                }
                self.depth = self.depth.max(top.depth).min(bottom.depth);
                work.drifts += 1.0;
                break;
            }
            if exit < 0.0 {
                return NUMERIC_RANGE;
            }
            let next_time = remaining - exit;
            if (exit > 0.0 && next_time == remaining) || (exit == 0.0 && previous_zero_time) {
                return TIME_RESOLUTION;
            }
            previous_zero_time = exit == 0.0;
            self.advance_inside(speed, slope, exit);
            if exit != 0.0 {
                work.drifts += 1.0;
            }
            work.crossings += 1.0;
            let upward = upper < lower;
            let boundary = if upward { top } else { bottom };
            let incidence =
                (if upward { -1.0 } else { 1.0 }) * vertical_at(slowness, boundary.speed);
            let next_layer = if upward {
                layer.checked_sub(1)
            } else {
                Some(layer + 1)
            };
            self.depth = boundary.depth;
            if let Some(next) = next_layer.filter(|&next| next + 1 < profile.len()) {
                let knot = unsafe { *profile.as_ptr().add(next) };
                self.bend(knot.gradient - slope, incidence);
                self.layer = next as f64;
                self.vertical = incidence;
            } else {
                if self.reflections >= EXACT_INTEGER {
                    return REFLECTION_COUNT;
                }
                self.bend(-2.0 * slope, incidence);
                self.vertical = -incidence;
                self.pressure *= if upward { edge.surface } else { edge.bottom };
                self.reflections += 1.0;
            }
            remaining = next_time;
        }
        self.time += dt;
        work.rays += 1.0;
        0
    }
}

fn finite_pair(left: &Ray, right: &Ray) -> bool {
    let a = (left as *const Ray).cast::<f64>();
    let b = (right as *const Ray).cast::<f64>();
    let maximum = f64x2_splat(f64::MAX);
    for i in 0..TRACE_WORDS {
        let lane = unsafe { f64x2(a.add(i).read(), b.add(i).read()) };
        if i64x2_bitmask(f64x2_le(f64x2_abs(lane), maximum)) != 3 {
            return false;
        }
    }
    true
}

#[repr(C)]
struct UnderwaterJob {
    profile: *const Knot,
    profile_words: usize,
    rays: *mut Ray,
    ray_count: usize,
    settings: *const f64,
    receipts: *mut Work,
    dt: f64,
}

const _: () = assert!(core::mem::size_of::<UnderwaterJob>() == 32);

impl UnderwaterJob {
    unsafe fn trace(&self, range: core::ops::Range<usize>, part: usize) -> u32 {
        if !(self.dt > 0.0 && self.dt.is_finite())
            || self.profile_words < 2 * PROFILE_WORDS
            || self.profile_words % PROFILE_WORDS != 0
            || self.profile_words > isize::MAX as usize / 8
            || self.ray_count > isize::MAX as usize / core::mem::size_of::<Ray>()
        {
            return NUMERIC_RANGE;
        }
        unsafe {
            let profile = slice::from_raw_parts(self.profile, self.profile_words / PROFILE_WORDS);
            let boundaries = Boundaries {
                surface: self.settings.read(),
                bottom: self.settings.add(1).read(),
            };
            if !(boundaries.surface.abs() <= 1.0 && boundaries.bottom.abs() <= 1.0) {
                return NUMERIC_RANGE;
            }
            let mut work = Work::default();
            let mut i = range.start;
            while i + 1 < range.end {
                let left = &mut *self.rays.add(i);
                let right = &mut *self.rays.add(i + 1);
                let status = left.advance(profile, self.dt, boundaries, &mut work);
                if status != 0 {
                    return status;
                }
                let status = right.advance(profile, self.dt, boundaries, &mut work);
                if status != 0 {
                    return status;
                }
                if !finite_pair(left, right) {
                    return NUMERIC_RANGE;
                }
                i += 2;
            }
            if i < range.end {
                let ray = &mut *self.rays.add(i);
                let status = ray.advance(profile, self.dt, boundaries, &mut work);
                if status != 0 {
                    return status;
                }
                if !ray.finite() {
                    return NUMERIC_RANGE;
                }
            }
            if !self.receipts.is_null() {
                self.receipts.add(part).write(work);
            }
        }
        0
    }
}

// The owner initializes and commits the candidate region. Each worker has
// exclusive writes to its contiguous ray rows and its own work receipt.
#[unsafe(no_mangle)]
unsafe extern "C" fn underwater_trace(
    profile: *const Knot,
    profile_words: usize,
    rays: *mut Ray,
    ray_count: usize,
    settings: *const f64,
    dt: f64,
    receipts: *mut Work,
) -> u32 {
    let job = UnderwaterJob {
        profile,
        profile_words,
        rays,
        ray_count,
        settings,
        receipts,
        dt,
    };
    unsafe { job.trace(0..ray_count, 0) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn underwater_thread_phase(
    job: *const UnderwaterJob,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    if stage != 0 || part >= parts {
        return NUMERIC_RANGE;
    }
    unsafe {
        let Some(job) = job.as_ref() else {
            return NUMERIC_RANGE;
        };
        let limit = job.ray_count as u64;
        let start = (u64::from(part) * limit / u64::from(parts)) as usize;
        let end = ((u64::from(part) + 1) * limit / u64::from(parts)) as usize;
        job.trace(start..end, part as usize)
    }
}
