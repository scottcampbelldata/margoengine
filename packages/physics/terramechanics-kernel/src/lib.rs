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
    lug_count: f64,
    lug_width: f64,
    phase: f64,
    mesh_geometry: f64,
    mesh_triangles: f64,
    mesh_profile: f64,
    mesh_columns: f64,
    mesh_rows: f64,
    reaction: f64,
    skid: f64,
    skid_exponent: f64,
    side_reaction: f64,
    lateral_slip: f64,
    side_weight: f64,
    camber: f64,
    berm_slope: f64,
    grouser_fill: f64,
    grouser_slip: f64,
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
        // A wasm32 grid needs at most seven levels: one bit per face and a factor of 32 per level.
        for level in 1..=self.top {
            *path.get_unchecked_mut(level) = *path.get_unchecked(level - 1) / 32;
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

struct RollingReaction {
    normal: f64,
    drawbar: f64,
    axle_torque: f64,
    lateral: f64,
}

fn skid_motion(
    entry: f64,
    transition: f64,
    front_cosine: f64,
    ratio: f64,
    radius: f64,
    at: f64,
) -> (f64, f64) {
    let (start, bias) = if at < transition {
        (transition, ratio)
    } else {
        (entry, front_cosine)
    };
    let sine_difference = 2.0 * cos(0.5 * (start + at)) * sin(0.5 * (start - at));
    let distance = radius * (bias * (start - at) - sine_difference).abs();
    (distance, bias - cos(at))
}

fn slip_magnitude(x: f64, y: f64) -> f64 {
    let scale = x.abs().max(y.abs());
    if scale == 0.0 {
        0.0
    } else {
        scale * length(x / scale, y / scale)
    }
}

fn mobilized_motion(jx: f64, jy: f64, vx: f64, vy: f64, k: f64) -> (f64, f64) {
    let speed = slip_magnitude(vx, vy);
    if speed == 0.0 {
        return (0.0, 0.0);
    }
    let displacement = slip_magnitude(jx, jy);
    let fraction = if k > 0.0 {
        1.0 - exp(-displacement / k)
    } else {
        f64::from(displacement > 0.0)
    };
    (fraction * (vx / speed), fraction * (vy / speed))
}

fn sidewall(p: &Patch, radius: f64, sine: f64, cosine: f64, chord: (f64, f64, f64)) -> f64 {
    let (sin_exit, cos_exit, slope) = chord;
    let depth = (radius * ((sine - sin_exit) * slope + cosine - cos_exit)).max(0.0);
    let wedge = slip_magnitude(1.0, p.friction) + p.friction;
    let angle = p.lateral_slip / slip_magnitude(1.0, p.lateral_slip);
    let pressure = depth
        * wedge
        * (2.0 * p.cohesion
            + 0.5 * p.side_weight * depth * wedge * (1.0 + 0.5 * wedge * p.friction));
    radius * cosine * pressure * angle * angle.abs()
}

fn rolling_load<const REACTION: bool>(
    p: &Patch,
    entry: f64,
    (exit, peak): (f64, f64),
) -> RollingReaction {
    let rim = p.wheel_radius;
    let lug_entry = 2.0 * arc_sin(root(0.5 * (1.0 - rim * cos(entry) / (rim + p.lug_height))));
    let lug_sine = sin(lug_entry);
    let shear_radius = rim + 0.5 * p.lug_height;
    let mut normal = 0.0;
    let mut drawbar = 0.0;
    let mut axle_torque = 0.0;
    let mut lateral = 0.0;
    let skidding = p.skid < 0.0;
    let (transition, front_cosine, a, b, c) = if skidding {
        let transition = entry * (1.0 + 0.5 * p.skid);
        let half_front = 0.5 * (entry - transition);
        let front_cosine = cos(0.5 * (entry + transition))
            * if half_front > 0.0 {
                sin(half_front) / half_front
            } else {
                1.0
            };
        let reversal = (2.0 * arc_sin(root(0.5 * (1.0 - front_cosine))))
            .max(transition)
            .min(entry);
        (
            transition,
            front_cosine,
            transition.min(peak),
            transition.max(peak).min(reversal),
            reversal.max(peak),
        )
    } else {
        (0.0, 0.0, peak, entry, entry)
    };
    let lateral_slip = if p.side_reaction != 0.0 {
        p.lateral_slip
    } else {
        0.0
    };
    let lateral_active = lateral_slip != 0.0;
    let sin_exit = if lateral_active { sin(exit) } else { 0.0 };
    let cos_exit = if lateral_active { cos(exit) } else { 0.0 };
    let chord = if lateral_active {
        (
            sin_exit,
            cos_exit,
            (cos_exit - cos(entry)) / (sin(entry) - sin_exit),
        )
    } else {
        (0.0, 0.0, 0.0)
    };
    for (first, last) in [(exit, a), (a, b), (b, c), (c, entry)] {
        if first == last {
            continue;
        }
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
            let sine = sin(at);
            let cosine = cos(at);
            let (tangent, across) = if skidding {
                let (distance, velocity) = skid_motion(
                    entry,
                    transition,
                    front_cosine,
                    1.0 + p.skid,
                    shear_radius,
                    at,
                );
                mobilized_motion(
                    distance,
                    shear_radius * (entry - at) * lateral_slip,
                    velocity,
                    lateral_slip,
                    p.shear_length * (1.0 + p.skid),
                )
            } else {
                let travel = 1.0 - p.drive_slip;
                let slide = rim * ((lug_entry - at) - travel * (lug_sine - sine));
                if lateral_active {
                    let velocity = travel * lateral_slip;
                    mobilized_motion(
                        slide.max(0.0),
                        shear_radius * (lug_entry - at) * velocity,
                        1.0 - travel * cosine,
                        velocity,
                        p.shear_length,
                    )
                } else {
                    (1.0 - exp(-slide.max(0.0) / p.shear_length), 0.0)
                }
            };
            let yield_stress = p.cohesion + pressure * p.friction;
            let radial = rim * pressure;
            let tangential = shear_radius * (yield_stress * tangent);
            normal += delta * (radial * cosine + tangential * sine);
            if REACTION {
                drawbar += delta * (tangential * cosine - radial * sine);
                axle_torque += delta * tangential * shear_radius;
                if lateral_active {
                    lateral += delta
                        * (2.0 * p.half_width * shear_radius * yield_stress * across
                            + sidewall(p, shear_radius, sine, cosine, chord));
                }
            }
        }
    }
    let width = 2.0 * p.half_width;
    RollingReaction {
        normal: width * normal,
        drawbar: width * drawbar,
        axle_torque: width * axle_torque,
        lateral,
    }
}

fn loaded_arc(p: &Patch, fixed: Option<(f64, f64)>) -> Option<(f64, (f64, f64))> {
    let mut lo = fixed.map_or(0.0, |(_, peak)| peak);
    let mut hi = core::f64::consts::FRAC_PI_2;
    let angles = |entry| fixed.unwrap_or_else(|| rolling_angle(p, entry));
    if rolling_load::<false>(p, hi, angles(hi)).normal < p.load {
        return None;
    }
    while hi - lo > 1e-9 {
        let middle = 0.5 * (lo + hi);
        if rolling_load::<false>(p, middle, angles(middle)).normal < p.load {
            lo = middle;
        } else {
            hi = middle;
        }
    }
    let entry = 0.5 * (lo + hi);
    Some((entry, angles(entry)))
}

const ROLLING_ROWS: usize = 65;

#[derive(Clone, Copy)]
struct RollingCut {
    rim: f64,
    deepest: f64,
}

struct BermLattice {
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    origin_x: f64,
    origin_z: f64,
}

fn berm_sections(p: &Patch, depth: f64, cosine: f64, sin_abs: f64, chord: f64) -> (f64, f64) {
    let radius = p.wheel_radius;
    let centre_height = radius - depth;
    // Project the submerged wheel-face segment and the rim rectangle across travel.
    let angle = 2.0 * arc_sin(root(0.5 * depth / radius));
    let section = sin_abs * (radius * radius * angle - centre_height * chord).max(0.0);
    (section, 2.0 * p.half_width * depth * cosine)
}

fn berm_right_share(section: f64, face: f64, sine: f64) -> f64 {
    let sin_abs = sine.abs();
    if !(sin(core::f64::consts::PI / 18.0)..=sin(4.0 * core::f64::consts::PI / 9.0))
        .contains(&sin_abs)
    {
        return 0.5;
    }
    let area = section + face;
    if area == 0.0 {
        return 0.5;
    }
    if sine > 0.0 {
        face / area
    } else {
        section / area
    }
}

fn grouser_share(p: &Patch, area: f64) -> f64 {
    if area <= 0.0 || p.lug_height == 0.0 || p.grouser_fill == 0.0 {
        return 0.0;
    }
    let radius_ratio = p.wheel_radius / (p.wheel_radius + 0.5 * p.lug_height);
    let swept = radius_ratio * (2.0 * p.half_width * p.lug_height) * p.grouser_fill;
    if swept == 0.0 {
        return 0.0;
    }
    if p.grouser_slip < 0.0 {
        (swept * (1.0 + p.grouser_slip) / area).min(1.0)
    } else {
        (swept / (area * (1.0 - p.grouser_slip))).min(1.0)
    }
}

unsafe fn deposit_backfill(
    p: &Patch,
    lattice: &BermLattice,
    (x_start, x_end, z_start, z_end): (usize, usize, usize, usize),
    (travel_x, travel_z): (f64, f64),
    volume: f64,
    areas: *const f64,
    cuts: *const f64,
    deltas: *mut f64,
    work: *mut f64,
) -> f64 {
    if volume <= 0.0 {
        return 0.0;
    }
    let mut rear_volume = 0.0;
    for x in x_start..x_end {
        let along_x = (lattice.origin_x + x as f64 * lattice.dx - p.x) * travel_x;
        for z in z_start..z_end {
            let along = along_x + (lattice.origin_z + z as f64 * lattice.dz - p.z) * travel_z;
            let i = x * lattice.nz + z;
            if along < 0.0 {
                rear_volume += *cuts.add(i) * *areas.add(i);
            }
        }
    }
    let returned = volume.min(rear_volume);
    if returned > 0.0 {
        let scale = returned / rear_volume;
        for x in x_start..x_end {
            let along_x = (lattice.origin_x + x as f64 * lattice.dx - p.x) * travel_x;
            for z in z_start..z_end {
                let along = along_x + (lattice.origin_z + z as f64 * lattice.dz - p.z) * travel_z;
                let i = x * lattice.nz + z;
                if along < 0.0 {
                    *deltas.add(i) += *cuts.add(i) * scale;
                }
            }
        }
    }
    *work += (1.0 + f64::from(returned > 0.0)) * ((x_end - x_start) * (z_end - z_start)) as f64;
    returned
}

fn berm_node_weight(height: f64, slope: f64, distance: f64, grid_width: f64) -> f64 {
    let start = (distance - grid_width).max(0.0);
    let end = (distance + grid_width).min(height / slope);
    // Average the linear wedge over the vertex's projected support, including partial overlap.
    if end > start {
        (end - start) * (height - 0.5 * slope * (start + end)) / (2.0 * grid_width)
    } else {
        0.0
    }
}

unsafe fn deposit_cross_track(
    p: &Patch,
    lattice: BermLattice,
    halo: f64,
    depth: f64,
    loose: f64,
    cut_bounds: (usize, usize, usize, usize),
    areas: *const f64,
    deltas: *mut f64,
    rim: *mut f64,
    faces: *mut u32,
    work: *mut f64,
) -> f64 {
    let BermLattice {
        nx,
        nz,
        dx,
        dz,
        origin_x,
        origin_z,
    } = lattice;
    let inverse = 1.0 / slip_magnitude(1.0, p.lateral_slip);
    let sine = p.lateral_slip * inverse;
    let span = p.half_length * inverse + p.half_width * sine.abs();
    let reach = p.half_width * inverse + p.half_length * sine.abs();
    let travel_x = p.forward_x * inverse - p.forward_z * sine;
    let travel_z = p.forward_z * inverse + p.forward_x * sine;
    let chord = root(depth * (2.0 * p.wheel_radius - depth));
    let (section, face) = berm_sections(p, depth, inverse, sine.abs(), chord);
    let right_share = berm_right_share(section, face, sine);
    let front_aligned = chord * sine.abs() > p.half_width * inverse;
    let centred = !front_aligned && sine.abs() < sin(core::f64::consts::PI / 18.0);
    let source_share = if centred {
        1.0
    } else if sine > 0.0 {
        right_share
    } else {
        1.0 - right_share
    };
    let requested = loose * grouser_share(p, section + face).min(source_share);
    let backfill = if front_aligned {
        0.0
    } else {
        deposit_backfill(
            p,
            &lattice,
            cut_bounds,
            (travel_x, travel_z),
            requested,
            areas,
            rim,
            deltas,
            work,
        )
    };
    let banks = loose - backfill;
    let transferred = if front_aligned { requested } else { backfill };
    let right = if centred {
        banks * right_share
    } else if sine > 0.0 {
        (loose * right_share - transferred).max(0.0)
    } else if front_aligned {
        (loose * right_share + transferred).min(banks)
    } else {
        (loose * right_share).min(banks)
    };
    let left = banks - right;
    // Each side has triangular cross-section h²/(2*slope) and extends for twice span.
    let height_left = root(left * p.berm_slope / span);
    let height_right = root(right * p.berm_slope / span);
    let grid_width = travel_z.abs() * dx + travel_x.abs() * dz;
    let outside = reach + height_left.max(height_right) / p.berm_slope + grid_width;
    let (x_start, x_end) = bounds(
        p.x,
        travel_x.abs() * span + travel_z.abs() * outside,
        origin_x,
        dx,
        nx,
    );
    let (z_start, z_end) = bounds(
        p.z,
        travel_z.abs() * span + travel_x.abs() * outside,
        origin_z,
        dz,
        nz,
    );
    let mut left_area = 0.0;
    let mut right_area = 0.0;
    for x in x_start..x_end {
        let rx = origin_x + x as f64 * dx - p.x;
        for z in z_start..z_end {
            let rz = origin_z + z as f64 * dz - p.z;
            let i = x * nz + z;
            let transverse = rx * travel_z - rz * travel_x;
            let outside_contact = transverse.abs() - reach;
            let along = rx * travel_x + rz * travel_z;
            let weight = if outside_contact >= 0.0
                && along.abs() <= span
                && raster(p, halo, rx, rz).0 == 0.0
            {
                if transverse > 0.0 {
                    berm_node_weight(height_right, p.berm_slope, outside_contact, grid_width)
                } else {
                    -berm_node_weight(height_left, p.berm_slope, outside_contact, grid_width)
                }
            } else {
                0.0
            };
            *rim.add(i) = weight;
            if weight > 0.0 {
                right_area += weight * *areas.add(i);
            } else {
                left_area -= weight * *areas.add(i);
            }
        }
    }
    let left_scale = if left_area > 0.0 {
        left / left_area
    } else {
        0.0
    };
    let right_scale = if right_area > 0.0 {
        right / right_area
    } else {
        0.0
    };
    let queue = FaceQueue::new(faces, nx * nz);
    for x in x_start..x_end {
        for z in z_start..z_end {
            let i = x * nz + z;
            let weight = *rim.add(i);
            let deposit = if weight > 0.0 {
                weight * right_scale
            } else {
                -weight * left_scale
            };
            *deltas.add(i) += deposit;
            if deposit > 0.0 && *deltas.add(i) > 0.0 {
                queue.around(i, nx, nz, 0);
            }
        }
    }
    *work += 2.0 * ((x_end - x_start) * (z_end - z_start)) as f64;
    backfill + f64::from(left_area > 0.0) * left + f64::from(right_area > 0.0) * right
}

fn phase_offset(angle: f64, pitch: f64) -> f64 {
    let offset = angle % pitch;
    if offset < 0.0 { offset + pitch } else { offset }
}

#[derive(Clone, Copy)]
struct TreadPose {
    spin_sine: f64,
    spin_cosine: f64,
    tilt_sine: f64,
    tilt_cosine: f64,
}

fn rotate_tread(face: &[f64], pose: TreadPose) -> [[f64; 3]; 3] {
    core::array::from_fn(|i| {
        let [x, y, z] = [face[3 * i], face[3 * i + 1], face[3 * i + 2]];
        let spun_y = pose.spin_cosine * y - pose.spin_sine * z;
        [
            pose.tilt_cosine * x - pose.tilt_sine * spun_y,
            pose.tilt_sine * x + pose.tilt_cosine * spun_y,
            pose.spin_sine * y + pose.spin_cosine * z,
        ]
    })
}

fn enclose_tread(
    mesh: &[f64],
    pose: TreadPose,
    hub: f64,
    across: &mut f64,
    rear: &mut f64,
    fore: &mut f64,
    cap: &mut f64,
) {
    for face in mesh.chunks_exact(9) {
        let vertices = rotate_tread(face, pose);
        for i in 0..3 {
            let a = vertices[i];
            let b = vertices[(i + 1) % 3];
            if a[1] <= -hub {
                *across = across.max(a[0].abs());
                *rear = rear.min(a[2]);
                *fore = fore.max(a[2]);
                *cap = cap.max(-hub - a[1]);
            }
            if (a[1] < -hub) != (b[1] < -hub) {
                let t = (-hub - a[1]) / (b[1] - a[1]);
                let x = a[0] + t * (b[0] - a[0]);
                let z = a[2] + t * (b[2] - a[2]);
                *across = across.max(x.abs());
                *rear = rear.min(z);
                *fore = fore.max(z);
            }
        }
    }
}

fn raster_tread(
    mesh: &[f64],
    pose: TreadPose,
    hub: f64,
    across: f64,
    rear: f64,
    fore: f64,
    cap: f64,
    columns: usize,
    rows: usize,
    depth: &mut [f64],
) {
    let dx = 2.0 * across / (columns - 1) as f64;
    let dz = (fore - rear) / (rows - 1) as f64;
    for face in mesh.chunks_exact(9) {
        let [a, b, c] = rotate_tread(face, pose);
        if a[1].min(b[1]).min(c[1]) >= -hub {
            continue;
        }
        let ux = b[0] - a[0];
        let uz = b[2] - a[2];
        let vx = c[0] - a[0];
        let vz = c[2] - a[2];
        let det = ux * vz - uz * vx;
        if det == 0.0 || !det.is_finite() {
            continue;
        }
        let xmin = a[0].min(b[0]).min(c[0]);
        let xmax = a[0].max(b[0]).max(c[0]);
        let zmin = a[2].min(b[2]).min(c[2]);
        let zmax = a[2].max(b[2]).max(c[2]);
        let (start_x, end_x) = bounds(
            0.5 * xmin + 0.5 * xmax,
            0.5 * (xmax - xmin),
            -across,
            dx,
            columns,
        );
        let (start_z, end_z) = bounds(0.5 * zmin + 0.5 * zmax, 0.5 * (zmax - zmin), rear, dz, rows);
        for i in start_x..end_x {
            let x = -across + i as f64 * dx - a[0];
            for j in start_z..end_z {
                let z = rear + j as f64 * dz - a[2];
                let u = (x * vz - z * vx) / det;
                let v = (ux * z - uz * x) / det;
                let w = 1.0 - u - v;
                // Include the shared edge even when its barycentric value rounded a few ulps below zero.
                if u.min(v).min(w) >= -8.0 * f64::EPSILON {
                    let y = w * a[1] + u * b[1] + v * c[1];
                    let value = ((-hub - y) / cap).clamp(0.0, 1.0);
                    // Each range is clipped to its grid dimension and the caller supplies the full grid.
                    let sample = unsafe { depth.get_unchecked_mut(i * rows + j) };
                    *sample = sample.max(value);
                }
            }
        }
    }
}

unsafe fn rolling_footprint(p: &mut Patch, depth: &mut [f64]) -> Option<RollingCut> {
    let zero_angles = if p.skid < 0.0 {
        let mut reference = *p;
        reference.skid = 0.0;
        reference.exponent += p.skid * p.skid_exponent;
        if reference.lower_stiffness > 0.0 {
            reference.transition_pressure =
                reference.stiffness * pow(reference.transition, reference.exponent);
        }
        Some(loaded_arc(&reference, None)?.1)
    } else {
        None
    };
    let (entry, (exit, peak)) = loaded_arc(p, zero_angles)?;
    if p.reaction != 0.0 || p.side_reaction != 0.0 {
        let reaction = rolling_load::<true>(p, entry, (exit, peak));
        if !(reaction.normal.is_finite()
            && reaction.drawbar.is_finite()
            && reaction.axle_torque.is_finite())
            || !reaction.lateral.is_finite()
        {
            return None;
        }
        if p.reaction != 0.0 {
            *((p.reaction as usize) as *mut [f64; 3]) =
                [reaction.normal, reaction.drawbar, reaction.axle_torque];
        }
        if p.side_reaction != 0.0 {
            *((p.side_reaction as usize) as *mut f64) = reaction.lateral;
        }
    }
    let rim = p.wheel_radius;
    let rim_rear = rim * sin(exit);
    let rim_fore = rim * sin(entry);
    let rim_cut =
        (contact_depth(rim, entry, 0.0) + p.lug_height * p.drive_slip - p.lug_support).max(0.0);
    if rim_cut > rim {
        return None;
    }
    let highest = contact_depth(rim, entry, peak);
    let phased = p.lug_count > 0.0;
    let tip = rim + p.lug_height;
    let hub = rim - rim_cut;
    let half_lug = 0.5 * p.lug_width;
    let mut rear = rim_rear;
    let mut fore = rim_fore;
    let mut cap = rim_cut;
    let mut phase = 0.0;
    let mut pitch = 0.0;
    let mut engaged = false;
    let have_mesh = p.mesh_triangles > 0.0;
    let mut across = p.half_width;
    let (mesh, pose, columns, rows) = if have_mesh {
        let mesh = core::slice::from_raw_parts(
            (p.mesh_geometry as usize) as *const f64,
            p.mesh_triangles as usize * 9,
        );
        let pose = TreadPose {
            spin_sine: sin(p.phase),
            spin_cosine: cos(p.phase),
            tilt_sine: p.camber,
            tilt_cosine: root((1.0 - p.camber) * (1.0 + p.camber)),
        };
        enclose_tread(mesh, pose, hub, &mut across, &mut rear, &mut fore, &mut cap);
        (mesh, pose, p.mesh_columns as usize, p.mesh_rows as usize)
    } else {
        (
            &[][..],
            TreadPose {
                spin_sine: 0.0,
                spin_cosine: 1.0,
                tilt_sine: 0.0,
                tilt_cosine: 1.0,
            },
            2,
            if phased { ROLLING_ROWS } else { 33 },
        )
    };
    if phased {
        pitch = core::f64::consts::TAU / p.lug_count;
        phase = phase_offset(-p.phase, pitch);
        let limit = 2.0 * arc_sin(root(0.5 * (1.0 - hub / tip)));
        let nearest = if phase <= 0.5 * pitch {
            phase
        } else {
            phase - pitch
        };
        engaged = nearest.abs() <= limit;
        if engaged {
            let first = (-limit + phase_offset(phase + limit, pitch)).min(nearest);
            let last = (limit - phase_offset(limit - phase, pitch)).max(nearest);
            rear = rear.min(tip * sin(first) - half_lug);
            fore = fore.max(tip * sin(last) + half_lug);
            cap = cap.max(tip * cos(nearest) - hub);
        }
    }
    if !((fore - rear).is_finite() && across.is_finite() && cap.is_finite()) {
        return None;
    }
    let first = usize::from(!phased && !have_mesh);
    for i in first..rows - first {
        let position = rear + (fore - rear) * (i as f64 / (rows - 1) as f64);
        let mut profile = 0.0;
        if position >= rim_rear && position <= rim_fore {
            let angle = arc_sin(position / rim);
            let mapped = if angle < peak {
                entry - (angle - exit) * ((entry - peak) / (peak - exit))
            } else {
                angle
            };
            profile = (contact_depth(rim, entry, mapped) / highest).clamp(0.0, 1.0);
        }
        let value = if engaged && cap > 0.0 {
            let angle = arc_sin(position / tip);
            let closest = angle + phase_offset(phase - angle + 0.5 * pitch, pitch) - 0.5 * pitch;
            let lug = if (position - tip * sin(closest)).abs() <= half_lug {
                (tip * cos(closest) - hub).max(0.0)
            } else {
                0.0
            };
            (profile * rim_cut).max(lug) / cap
        } else if have_mesh && cap > 0.0 {
            profile * rim_cut / cap
        } else {
            profile
        };
        for column in 0..columns {
            let cross = -across + 2.0 * across * (column as f64 / (columns - 1) as f64);
            let rim_at_column = if cross.abs() <= p.half_width {
                value
            } else {
                0.0
            };
            // The supplied grid contains exactly these column and row ranges.
            *depth.get_unchecked_mut(i + column * rows) = rim_at_column;
        }
    }
    if have_mesh && cap > 0.0 {
        raster_tread(
            mesh, pose, hub, across, rear, fore, cap, columns, rows, depth,
        );
    }
    let shift = 0.5 * (rear + fore);
    p.x += shift * p.forward_x;
    p.z += shift * p.forward_z;
    p.half_length = 0.5 * (fore - rear);
    p.half_width = across;
    p.profile = depth.as_ptr() as usize as f64;
    p.profile_columns = columns as f64;
    p.profile_rows = rows as f64;
    p.projected_area = (fore - rear) * (2.0 * p.half_width);
    Some(RollingCut {
        rim: rim_cut,
        deepest: cap,
    })
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
    floor_grid: *const f64,
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
        let footprint = if local.mesh_triangles > 0.0 {
            core::slice::from_raw_parts_mut(
                (local.mesh_profile as usize) as *mut f64,
                local.mesh_columns as usize * local.mesh_rows as usize,
            )
        } else {
            &mut rolling_shape[..]
        };
        let Some(depth) = rolling_footprint(&mut local, footprint) else {
            return f64::NAN;
        };
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
            settlement = depth.deepest;
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
            let bedrock = if floor_grid.is_null() {
                floor
            } else {
                *floor_grid.add(i)
            };
            let room = (lower + *deltas.add(i) - bedrock).max(0.0);
            let cut = (settlement * depth_shape * coverage - *peak.add(i))
                .max(0.0)
                .min(room);
            *peak.add(i) += cut;
            *deltas.add(i) -= cut;
            *dust.add(i) += cut * p.dust_flux;
            removed += cut * area;
            if p.berm_slope == 0.0 {
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
            } else if p.grouser_fill > 0.0 {
                *rim.add(i) = cut;
            }
        }
    }
    let compacted = removed * p.compaction;
    let suspended = removed * p.dust;
    let loose = removed - compacted - suspended;
    let berm_depth = rolling_depth.filter(|_| p.berm_slope > 0.0 && loose > 0.0);
    let deposited = if let Some(depth) = berm_depth {
        deposit_cross_track(
            p,
            BermLattice {
                nx,
                nz,
                dx,
                dz,
                origin_x,
                origin_z,
            },
            halo,
            depth.rim,
            loose,
            (x_start, x_end, z_start, z_end),
            areas,
            deltas,
            rim,
            faces,
            work,
        )
    } else if rim_area > 0.0 {
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
    rolling_depth.map_or(settlement, |depth| depth.rim)
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
