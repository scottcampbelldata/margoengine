#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_mul, f64x2_sqrt, unreachable};
use margoengine_physics_kernel_common::pinned::{cos, exp, pow, sin};

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
struct Patch {
    x: f64,
    z: f64,
    forward_x: f64,
    forward_z: f64,
    half_length: f64,
    half_width: f64,
    settlement: f64,
    compaction: f64,
    dust: f64,
    dust_flux: f64,
    shear_share: f64,
    slip_x: f64,
    slip_z: f64,
    shape_flags: f64,
    distributed: f64,
    load: f64,
    stiffness: f64,
    exponent: f64,
    profile: f64,
    profile_columns: f64,
    profile_rows: f64,
    lower_stiffness: f64,
    lower_exponent: f64,
    transition: f64,
    transition_pressure: f64,
    lower_at_transition: f64,
    wheel_radius: f64,
    lug_height: f64,
    lug_support: f64,
    peak_fraction: f64,
    peak_slip: f64,
    exit_fraction: f64,
    drive_slip: f64,
    cohesion: f64,
    friction: f64,
    shear_length: f64,
    projected_area: f64,
}

fn length(x: f64, z: f64) -> f64 {
    let vector = f64x2(x, z);
    let square = f64x2_mul(vector, vector);
    let sum = f64x2_extract_lane::<0>(square) + f64x2_extract_lane::<1>(square);
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2(sum, sum)))
}

fn bounds(centre: f64, radius: f64, origin: f64, spacing: f64, size: usize) -> (usize, usize) {
    let start = ((centre - radius - origin) / spacing) as usize;
    let end = (((centre + radius - origin) / spacing) as usize).saturating_add(2);
    (start.min(size), end.min(size))
}

// Candidate faces use the full grid's x-major order. Each higher word marks nonempty words one level below.
struct FaceQueue {
    words: *mut u32,
    levels: [usize; 7],
    top: usize,
}

impl FaceQueue {
    fn new(words: *mut u32, vertices: usize) -> Self {
        let mut levels = [0; 7];
        let mut count = vertices.div_ceil(16);
        let mut top = 0;
        while count > 1 {
            levels[top + 1] = levels[top] + count;
            count = count.div_ceil(32);
            top += 1;
        }
        Self { words, levels, top }
    }

    unsafe fn add(&self, face: usize) {
        let mut path = [0; 7];
        path[0] = face / 32;
        for level in 1..=self.top {
            path[level] = path[level - 1] / 32;
        }
        for level in (1..=self.top).rev() {
            let parent = self.words.add(self.levels[level] + path[level]);
            let bit = 1 << (path[level - 1] % 32);
            if *parent & bit == 0 {
                *self.words.add(self.levels[level - 1] + path[level - 1]) = 0;
                *parent |= bit;
            }
        }
        *self.words.add(path[0]) |= 1 << (face % 32);
    }

    unsafe fn next(&self) -> Option<usize> {
        if *self.words.add(self.levels[self.top]) == 0 {
            return None;
        }
        let mut face = 0;
        for level in (0..=self.top).rev() {
            let bits = *self.words.add(self.levels[level] + face);
            face = face * 32 + bits.trailing_zeros() as usize;
        }
        let mut child = face;
        for level in 0..=self.top {
            let word_index = child / 32;
            let word = self.words.add(self.levels[level] + word_index);
            *word &= !(1 << (child % 32));
            if *word != 0 {
                break;
            }
            child = word_index;
        }
        Some(face)
    }

    unsafe fn around(&self, vertex: usize, nx: usize, nz: usize, first: usize) {
        let x = vertex / nz;
        let z = vertex % nz;
        if x > 0 && 2 * (vertex - nz) >= first {
            self.add(2 * (vertex - nz));
        }
        if z > 0 && 2 * vertex - 1 >= first {
            self.add(2 * vertex - 1);
        }
        if x + 1 < nx && 2 * vertex >= first {
            self.add(2 * vertex);
        }
        if z + 1 < nz && 2 * vertex + 1 >= first {
            self.add(2 * vertex + 1);
        }
    }
}

#[inline]
unsafe fn depth_at(patch: &Patch, side: f64, station: f64) -> f64 {
    if side.abs() > 1.0 || station.abs() > 1.0 {
        return 0.0;
    }
    let columns = patch.profile_columns as usize;
    let rows = patch.profile_rows as usize;
    let values = (patch.profile as usize) as *const f64;
    let x = (side + 1.0) * 0.5 * (columns - 1) as f64;
    let z = (station + 1.0) * 0.5 * (rows - 1) as f64;
    let a = (x as usize).min(columns - 2);
    let b = (z as usize).min(rows - 2);
    let tx = x - a as f64;
    let tz = z - b as f64;
    let left = *values.add(a * rows + b) * (1.0 - tz) + *values.add(a * rows + b + 1) * tz;
    let right =
        *values.add((a + 1) * rows + b) * (1.0 - tz) + *values.add((a + 1) * rows + b + 1) * tz;
    left * (1.0 - tx) + right * tx
}

#[inline]
unsafe fn raster(patch: &Patch, halo: f64, dx: f64, dz: f64) -> (f64, f64, f64) {
    let station = (dx * patch.forward_x + dz * patch.forward_z) / patch.half_length;
    let side = (dx * patch.forward_z - dz * patch.forward_x) / patch.half_width;
    if patch.profile_columns != 0.0 {
        let depth = depth_at(patch, side, station);
        if depth > 0.0 {
            return (1.0, depth, 0.0);
        }
        let reach = 2.0 * halo;
        let ring = depth_at(patch, side - reach, station)
            .max(depth_at(patch, side + reach, station))
            .max(depth_at(patch, side, station - reach))
            .max(depth_at(patch, side, station + reach));
        return (0.0, 0.0, ring);
    }
    let flags = patch.shape_flags as u8;
    let radius = if flags & 1 != 0 {
        length(station, side)
    } else {
        station.abs().max(side.abs())
    };
    let coverage = ((1.0 + halo - radius) / (2.0 * halo)).clamp(0.0, 1.0);
    let profile = if flags & 2 != 0 {
        (1.0 - radius * radius).max(0.0)
    } else {
        1.0
    };
    let ring = ((1.0 + 3.0 * halo - radius) / (2.0 * halo)).clamp(0.0, 1.0);
    (coverage, profile, ring)
}

fn layered_pressure(p: &Patch, depth: f64) -> (f64, f64) {
    if depth > p.transition {
        let raw = p.lower_stiffness * pow(depth, p.lower_exponent);
        (
            p.transition_pressure + (raw - p.lower_at_transition),
            raw * p.lower_exponent,
        )
    } else {
        let raw = p.stiffness * pow(depth, p.exponent);
        (raw, raw * p.exponent)
    }
}

fn root(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2(value, value)))
}

fn arc_sin(value: f64) -> f64 {
    let v = value.clamp(-1.0, 1.0);
    if v.abs() == 1.0 {
        return v * core::f64::consts::FRAC_PI_2;
    }
    // Half-angle reduction keeps the Newton iterations away from the vanishing derivative.
    let y = v / root(2.0 * (1.0 + root((1.0 - v) * (1.0 + v))));
    let mut angle = y;
    for _ in 0..5 {
        angle += (y - sin(angle)) / cos(angle);
    }
    2.0 * angle
}

fn contact_depth(radius: f64, entry: f64, angle: f64) -> f64 {
    (2.0 * radius * sin(0.5 * (entry + angle)) * sin(0.5 * (entry - angle))).max(0.0)
}

fn rolling_angle(p: &Patch, entry: f64) -> (f64, f64) {
    (
        p.exit_fraction * entry,
        (p.peak_fraction + p.peak_slip * p.drive_slip) * entry,
    )
}

fn rolling_load(p: &Patch, entry: f64) -> f64 {
    let (exit, peak) = rolling_angle(p, entry);
    let rim = p.wheel_radius;
    let lug_entry = 2.0 * arc_sin(root(0.5 * (1.0 - rim * cos(entry) / (rim + p.lug_height))));
    let lug_sine = sin(lug_entry);
    let shear_radius = rim + 0.5 * p.lug_height;
    let mut force = 0.0;
    for (first, last) in [(exit, peak), (peak, entry)] {
        let delta = (last - first) / 24.0;
        for i in 0..24 {
            let at = first + (i as f64 + 0.5) * delta;
            let mirrored = if at < peak {
                entry - (at - exit) * ((entry - peak) / (peak - exit))
            } else {
                at
            };
            let depth = contact_depth(rim, entry, mirrored);
            let pressure = if p.lower_stiffness > 0.0 {
                layered_pressure(p, depth).0
            } else {
                p.stiffness * pow(depth, p.exponent)
            };
            let slide = rim * ((lug_entry - at) - (1.0 - p.drive_slip) * (lug_sine - sin(at)));
            let shear = (p.cohesion + pressure * p.friction)
                * (1.0 - exp(-slide.max(0.0) / p.shear_length));
            force += delta * (rim * pressure * cos(at) + shear_radius * shear * sin(at));
        }
    }
    2.0 * p.half_width * force
}

const ROLLING_ROWS: usize = 33;

fn rolling_footprint(p: &mut Patch, depth: &mut [f64; ROLLING_ROWS * 2]) -> f64 {
    let mut lo = 0.0;
    let mut hi = core::f64::consts::FRAC_PI_2;
    if rolling_load(p, hi) < p.load {
        return f64::NAN;
    }
    while hi - lo > 1e-9 {
        let middle = 0.5 * (lo + hi);
        if rolling_load(p, middle) < p.load {
            lo = middle;
        } else {
            hi = middle;
        }
    }
    let entry = 0.5 * (lo + hi);
    let (exit, peak) = rolling_angle(p, entry);
    let rim = p.wheel_radius;
    let rear = rim * sin(exit);
    let fore = rim * sin(entry);
    let shift = 0.5 * (rear + fore);
    let highest = contact_depth(rim, entry, peak);
    for i in 1..ROLLING_ROWS - 1 {
        let position = rear + (fore - rear) * (i as f64 / (ROLLING_ROWS - 1) as f64);
        let angle = arc_sin(position / rim);
        let mapped = if angle < peak {
            entry - (angle - exit) * ((entry - peak) / (peak - exit))
        } else {
            angle
        };
        let value = (contact_depth(rim, entry, mapped) / highest).clamp(0.0, 1.0);
        depth[i] = value;
        depth[i + ROLLING_ROWS] = value;
    }
    p.x += shift * p.forward_x;
    p.z += shift * p.forward_z;
    p.half_length = 0.5 * (fore - rear);
    p.profile = depth.as_ptr() as usize as f64;
    p.profile_columns = 2.0;
    p.profile_rows = ROLLING_ROWS as f64;
    p.projected_area = (fore - rear) * (2.0 * p.half_width);
    (contact_depth(rim, entry, 0.0) + p.lug_height * p.drive_slip - p.lug_support).max(0.0)
}

/// Rasterizes one moving soil contact into pending bed deltas, using exact nodal areas for the mass ledger.
/// Arrays belong to the caller's arena. Scratch is only accessed in the footprint and its first exterior ring.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn stamp(
    patch: *mut f64,
    areas: *const f64,
    peak: *mut f64,
    deltas: *mut f64,
    dust: *mut f64,
    rim: *mut f64,
    pressure: *mut f64,
    heights: *const f32,
    floor: f64,
    budget: *mut f64,
    work: *mut f64,
    faces: *mut u32,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    origin_x: f64,
    origin_z: f64,
) -> f64 {
    let source = &mut *patch.cast::<Patch>();
    let mut local = *source;
    let mut rolling_shape = [0.0; ROLLING_ROWS * 2];
    let rolling_depth = if local.wheel_radius > 0.0 {
        let depth = rolling_footprint(&mut local, &mut rolling_shape);
        if !depth.is_finite() {
            return f64::NAN;
        }
        source.projected_area = local.projected_area;
        Some(depth)
    } else {
        None
    };
    let p = &local;
    let along_cell = p.forward_x.abs() * dx + p.forward_z.abs() * dz;
    let across_cell = p.forward_z.abs() * dx + p.forward_x.abs() * dz;
    let halo = 0.5 * (along_cell / p.half_length).max(across_cell / p.half_width);
    let extent_x = p.forward_x.abs() * p.half_length + p.forward_z.abs() * p.half_width;
    let extent_z = p.forward_z.abs() * p.half_length + p.forward_x.abs() * p.half_width;
    let outer = 1.0 + 3.0 * halo;
    let (x_start, x_end) = bounds(p.x, extent_x * outer, origin_x, dx, nx);
    let (z_start, z_end) = bounds(p.z, extent_z * outer, origin_z, dz, nz);
    let visit = ((x_end - x_start) * (z_end - z_start)) as f64;
    let resolved = p.distributed != 0.0;
    let mut settlement = p.settlement;
    let mut crest_pressure = 0.0;
    let mut pressure_scale = 1.0;
    let mut layered = false;
    if resolved {
        // Integrate F = sum K (z_max profile)^n dA, then solve once for the peak
        // settlement. The same geometry and weights are used for the load field.
        let mut contact_area = 0.0;
        let mut largest_vertex = (0.0, 0.0);
        for x in x_start..x_end {
            let rx = origin_x + x as f64 * dx - p.x;
            for z in z_start..z_end {
                let rz = origin_z + z as f64 * dz - p.z;
                let (coverage, profile, _) = raster(p, halo, rx, rz);
                let area = *areas.add(x * nz + z) * coverage;
                contact_area += area * pow(profile, p.exponent);
                if p.lower_stiffness > 0.0 && area * profile > largest_vertex.0 * largest_vertex.1 {
                    largest_vertex = (area, profile);
                }
            }
        }
        *work += visit;
        if contact_area == 0.0 {
            return 0.0;
        }
        crest_pressure = p.load / contact_area;
        settlement = pow(crest_pressure / p.stiffness, 1.0 / p.exponent);
        if !settlement.is_finite() || !crest_pressure.is_finite() {
            return f64::NAN;
        }
        if let Some(depth) = rolling_depth {
            settlement = depth;
        }
        layered = rolling_depth.is_none() && p.lower_stiffness > 0.0 && settlement > p.transition;
        if layered {
            let (area, profile) = largest_vertex;
            // A single vertex carrying the entire prescribed force bounds the solution from above.
            let single_pressure = p.load / area;
            let single_depth = if single_pressure > p.transition_pressure {
                pow(
                    (single_pressure - p.transition_pressure + p.lower_at_transition)
                        / p.lower_stiffness,
                    1.0 / p.lower_exponent,
                )
            } else {
                pow(single_pressure / p.stiffness, 1.0 / p.exponent)
            };
            let mut upper = (single_depth / profile).max(settlement) * (1.0 + 8.0 * f64::EPSILON);
            if !upper.is_finite() {
                return f64::NAN;
            }
            let mut lower = p.transition;
            loop {
                *work += visit;
                let mut force = 0.0;
                let mut slope = 0.0;
                for x in x_start..x_end {
                    let rx = origin_x + x as f64 * dx - p.x;
                    for z in z_start..z_end {
                        let rz = origin_z + z as f64 * dz - p.z;
                        let (coverage, profile, _) = raster(p, halo, rx, rz);
                        if profile > 0.0 && coverage > 0.0 {
                            let area = *areas.add(x * nz + z) * coverage;
                            let (stress, slope_times_peak) =
                                layered_pressure(p, settlement * profile);
                            force += stress * area;
                            slope += slope_times_peak * area;
                        }
                    }
                }
                let residual = force - p.load;
                if residual.abs() <= (32.0 * f64::EPSILON) * p.load {
                    pressure_scale = p.load / force;
                    break;
                }
                if residual > 0.0 || !force.is_finite() {
                    upper = settlement;
                } else {
                    lower = settlement;
                }
                let span = upper - lower;
                let midpoint = lower + 0.5 * span;
                if midpoint <= lower || midpoint >= upper {
                    pressure_scale = p.load / force;
                    break;
                }
                let newton = settlement - residual * (settlement / slope);
                settlement = if newton > lower + 0.125 * span && newton < upper - 0.125 * span {
                    newton
                } else {
                    midpoint
                };
            }
            if !pressure_scale.is_finite() || pressure_scale <= 0.0 {
                return f64::NAN;
            }
        }
    }
    let mut removed = 0.0;
    let mut rim_area = 0.0;
    for x in x_start..x_end {
        let rx = origin_x + x as f64 * dx - p.x;
        for z in z_start..z_end {
            let rz = origin_z + z as f64 * dz - p.z;
            let (coverage, profile, ring) = raster(p, halo, rx, rz);
            let i = x * nz + z;
            let area = *areas.add(i);
            let depth_shape = if resolved { profile } else { 1.0 };
            if resolved {
                *pressure.add(i) += if layered {
                    layered_pressure(p, settlement * profile).0 * coverage * pressure_scale
                } else {
                    crest_pressure * coverage * pow(profile, p.exponent)
                };
            }
            // The bed's exact heights are f64, but the registry publishes f32. Use the lower
            // rounding boundary so we never request a cut the exact bedrock would refuse.
            let height = *heights.add(i);
            let lower = (height as f64 + height.next_down() as f64) * 0.5;
            let room = (lower + *deltas.add(i) - floor).max(0.0);
            let cut = (settlement * depth_shape * coverage - *peak.add(i))
                .max(0.0)
                .min(room);
            *peak.add(i) += cut;
            *deltas.add(i) -= cut;
            *dust.add(i) += cut * p.dust_flux;
            removed += cut * area;
            let distance = length(rx, rz);
            let normal = if distance > 0.0 {
                (p.slip_x * rx + p.slip_z * rz) / distance
            } else {
                0.0
            };
            let weight = if coverage == 0.0 {
                ring * (1.0 + p.shear_share * normal)
            } else {
                0.0
            };
            *rim.add(i) = weight;
            rim_area += weight * area;
        }
    }
    let compacted = removed * p.compaction;
    let suspended = removed * p.dust;
    let loose = removed - compacted - suspended;
    let deposited = if rim_area > 0.0 {
        let fill = loose / rim_area;
        let queue = FaceQueue::new(faces, nx * nz);
        for x in x_start..x_end {
            for z in z_start..z_end {
                let i = x * nz + z;
                let deposit = *rim.add(i) * fill;
                *deltas.add(i) += deposit;
                if resolved && deposit > 0.0 && *deltas.add(i) > 0.0 {
                    queue.around(i, nx, nz, 0);
                }
            }
        }
        if resolved {
            *work += visit;
        }
        loose
    } else {
        0.0
    };
    *budget.add(0) += removed;
    *budget.add(1) += compacted;
    *budget.add(2) += suspended;
    *budget.add(3) += deposited;
    *budget.add(4) += loose - deposited;
    if resolved {
        *work += visit;
    }
    settlement
}

/// Conservative gravity redistribution of freshly displaced material outside the current contact patches.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn repose(
    areas: *const f64,
    deltas: *mut f64,
    pressure: *const f64,
    heights: *const f32,
    faces: *mut u32,
    work: *mut f64,
    nx: usize,
    nz: usize,
    limit_x: f64,
    limit_z: f64,
) -> f64 {
    let mut moved = 0.0;
    let queue = FaceQueue::new(faces, nx * nz);
    let mut examined = 0;
    while let Some(face) = queue.next() {
        examined += 1;
        let a = face / 2;
        let (b, limit) = if face % 2 == 0 {
            (a + nz, limit_x)
        } else {
            (a + 1, limit_z)
        };
        if *pressure.add(a) > 0.0 || *pressure.add(b) > 0.0 {
            continue;
        }
        let ha = *heights.add(a) as f64 + *deltas.add(a);
        let hb = *heights.add(b) as f64 + *deltas.add(b);
        let (source, target) = if ha > hb { (a, b) } else { (b, a) };
        let gradient = (ha - hb).abs() - limit;
        if gradient <= 0.0 || *deltas.add(source) <= 0.0 {
            continue;
        }
        let source_area = *areas.add(source);
        let target_area = *areas.add(target);
        let volume = (gradient / (1.0 / source_area + 1.0 / target_area))
            .min(*deltas.add(source) * source_area);
        *deltas.add(source) -= volume / source_area;
        *deltas.add(target) += volume / target_area;
        moved += volume;
        if *deltas.add(target) > 0.0 {
            queue.around(target, nx, nz, face + 1);
        }
    }
    *work.add(1) = examined as f64;
    moved
}
