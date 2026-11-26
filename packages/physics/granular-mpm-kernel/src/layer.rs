use margoengine_physics_kernel_common::pinned::exp;

use super::tensor::{determinant, floor};
use super::{Point, at_mut};

#[repr(C)]
struct LayerGrid {
    min_x: f64,
    min_z: f64,
    inv_dx: f64,
    inv_dz: f64,
    offset_x: f64,
    offset_z: f64,
}

fn cell(value: f64, cells: usize) -> (usize, f64) {
    let x = value.max(0.0).min(cells as f64);
    let i = (floor(x) as usize).min(cells - 1);
    (i, x - i as f64)
}

#[unsafe(no_mangle)]
unsafe extern "C" fn mpm_layer(
    particles: *const Point,
    count: usize,
    grid: *const LayerGrid,
    columns: usize,
    rows: usize,
    volumes: *mut f64,
) {
    let points = unsafe { core::slice::from_raw_parts(particles, count) };
    let shape = unsafe { &*grid };
    let stride = rows + 1;
    let volumes = unsafe { core::slice::from_raw_parts_mut(volumes, stride * (columns + 1)) };
    volumes.fill(0.0);
    for point in points {
        let (column, u) = cell(
            (point.position[0] + shape.offset_x - shape.min_x) * shape.inv_dx,
            columns,
        );
        let (row, v) = cell(
            (point.position[2] + shape.offset_z - shape.min_z) * shape.inv_dz,
            rows,
        );
        let origin = column * stride + row;
        let volume = point.rest_volume * determinant(point.elastic) * exp(point.plastic);
        if u + v <= 1.0 {
            *at_mut(volumes, origin) += (1.0 - u - v) * volume;
            *at_mut(volumes, origin + stride) += u * volume;
            *at_mut(volumes, origin + 1) += v * volume;
        } else {
            *at_mut(volumes, origin + stride) += (1.0 - v) * volume;
            *at_mut(volumes, origin + 1) += (1.0 - u) * volume;
            *at_mut(volumes, origin + stride + 1) += (u + v - 1.0) * volume;
        }
    }
}
