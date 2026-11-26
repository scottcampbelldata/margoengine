#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_mul, f64x2_sqrt, unreachable};

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
    ellipse: f64,
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
    heights: *const f32,
    floor: f64,
    budget: *mut f64,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    origin_x: f64,
    origin_z: f64,
) {
    let p = &*patch.cast::<Patch>();
    let along_cell = p.forward_x.abs() * dx + p.forward_z.abs() * dz;
    let across_cell = p.forward_z.abs() * dx + p.forward_x.abs() * dz;
    let halo = 0.5 * (along_cell / p.half_length).max(across_cell / p.half_width);
    let extent_x = p.forward_x.abs() * p.half_length + p.forward_z.abs() * p.half_width;
    let extent_z = p.forward_z.abs() * p.half_length + p.forward_x.abs() * p.half_width;
    let outer = 1.0 + 3.0 * halo;
    let (x_start, x_end) = bounds(p.x, extent_x * outer, origin_x, dx, nx);
    let (z_start, z_end) = bounds(p.z, extent_z * outer, origin_z, dz, nz);
    let mut removed = 0.0;
    let mut rim_area = 0.0;
    for x in x_start..x_end {
        let rx = origin_x + x as f64 * dx - p.x;
        for z in z_start..z_end {
            let rz = origin_z + z as f64 * dz - p.z;
            let station = (rx * p.forward_x + rz * p.forward_z) / p.half_length;
            let side = (rx * p.forward_z - rz * p.forward_x) / p.half_width;
            let radius = if p.ellipse != 0.0 {
                length(station, side)
            } else {
                station.abs().max(side.abs())
            };
            let coverage = ((1.0 + halo - radius) / (2.0 * halo)).clamp(0.0, 1.0);
            let i = x * nz + z;
            let area = *areas.add(i);
            // The bed's exact heights are f64, but the registry publishes f32. Use the lower
            // rounding boundary so we never request a cut the exact bedrock would refuse.
            let height = *heights.add(i);
            let lower = (height as f64 + height.next_down() as f64) * 0.5;
            let room = (lower + *deltas.add(i) - floor).max(0.0);
            let cut = (p.settlement * coverage - *peak.add(i)).max(0.0).min(room);
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
            let ring = ((outer - radius) / (2.0 * halo)).clamp(0.0, 1.0);
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
        loose
    } else {
        0.0
    };
    *budget.add(0) += removed;
    *budget.add(1) += compacted;
    *budget.add(2) += suspended;
    *budget.add(3) += deposited;
    *budget.add(4) += loose - deposited;
}
