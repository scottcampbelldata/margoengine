#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_mul, f64x2_sqrt, unreachable};
use margoengine_physics_kernel_common::pinned::pow;

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

/// Rasterizes one moving soil contact into pending bed deltas, using exact nodal areas for the mass ledger.
/// Arrays belong to the caller's arena. Scratch is only accessed in the footprint and its first exterior ring.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn stamp(
    patch: *const f64,
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
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    origin_x: f64,
    origin_z: f64,
) -> f64 {
    let p = &*patch.cast::<Patch>();
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
    if resolved {
        // Integrate F = sum K (z_max profile)^n dA, then solve once for the peak
        // settlement. The same geometry and weights are used for the load field.
        let mut contact_area = 0.0;
        for x in x_start..x_end {
            let rx = origin_x + x as f64 * dx - p.x;
            for z in z_start..z_end {
                let rz = origin_z + z as f64 * dz - p.z;
                let (coverage, profile, _) = raster(p, halo, rx, rz);
                contact_area += *areas.add(x * nz + z) * coverage * pow(profile, p.exponent);
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
                *pressure.add(i) += crest_pressure * coverage * pow(profile, p.exponent);
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
        for x in x_start..x_end {
            for z in z_start..z_end {
                let i = x * nz + z;
                *deltas.add(i) += *rim.add(i) * fill;
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
    nx: usize,
    nz: usize,
    limit_x: f64,
    limit_z: f64,
) -> f64 {
    let mut moved = 0.0;
    let mut face = |a: usize, b: usize, limit: f64| {
        if *pressure.add(a) > 0.0 || *pressure.add(b) > 0.0 {
            return;
        }
        let ha = *heights.add(a) as f64 + *deltas.add(a);
        let hb = *heights.add(b) as f64 + *deltas.add(b);
        let (source, target) = if ha > hb { (a, b) } else { (b, a) };
        let gradient = (ha - hb).abs() - limit;
        if gradient <= 0.0 || *deltas.add(source) <= 0.0 {
            return;
        }
        let source_area = *areas.add(source);
        let target_area = *areas.add(target);
        let volume = (gradient / (1.0 / source_area + 1.0 / target_area))
            .min(*deltas.add(source) * source_area);
        *deltas.add(source) -= volume / source_area;
        *deltas.add(target) += volume / target_area;
        moved += volume;
    };
    for x in 0..nx {
        for z in 0..nz {
            let i = x * nz + z;
            if x + 1 < nx {
                face(i, i + nz, limit_x);
            }
            if z + 1 < nz {
                face(i, i + 1, limit_z);
            }
        }
    }
    moved
}
