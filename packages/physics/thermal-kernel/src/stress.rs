//! Linear isotropic thermoelastic equilibrium on a conforming tetrahedral subdivision
//! of the heat grid. All pointers address world-owned storage. Element traversal and
//! every reduction have a fixed order. The Wasm stack is zero bytes.

use crate::load2;
use core::arch::wasm32::*;
use core::ptr;

const DIAGONAL: u32 = 0;
const THERMAL_LOAD: u32 = 1;
const ELASTIC_LOAD: u32 = 2;

#[inline]
unsafe fn add3(dst: *mut f64, i: usize, xy: v128, z: f64) {
    unsafe {
        v128_store(dst.add(i).cast(), f64x2_add(load2(dst, i), xy));
        *dst.add(i + 2) += z;
    }
}

#[inline]
unsafe fn edge(dst: *mut f64, a: usize, b: usize, factor: f64, sx: f64, sy: f64, sz: f64) {
    let xy = f64x2_mul(f64x2_splat(factor), f64x2(sx, sy));
    let z = factor * sz;
    unsafe {
        add3(dst, a, f64x2_neg(xy), -z);
        add3(dst, b, xy, z);
    }
}

#[inline]
unsafe fn diagonal_edge(dst: *mut f64, a: usize, b: usize, x: f64, y: f64, z: f64) {
    let xy = f64x2(x, y);
    unsafe {
        add3(dst, a, xy, z);
        add3(dst, b, xy, z);
    }
}

#[inline]
unsafe fn gradient(u: *const f64, a: usize, b: usize, h_inv: f64) -> v128 {
    unsafe { f64x2_mul(f64x2_sub(load2(u, b), load2(u, a)), f64x2_splat(h_inv)) }
}

// The three positive axis edges form a path from lower to upper voxel corner.
// The affine displacement gradient uses differences along precisely these edges;
// its transpose applies equal and opposite nodal forces at their endpoints.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
unsafe fn tet<const MODE: u32>(
    grid: *const f64,
    dst: *mut f64,
    u: *const f64,
    cell_stress: *mut f64,
    mu2: f64,
    bulk: f64,
    pressure: f64,
    xa: usize,
    xb: usize,
    ya: usize,
    yb: usize,
    za: usize,
    zb: usize,
) {
    unsafe {
        let ix = *grid.add(3);
        let iy = *grid.add(4);
        let iz = *grid.add(5);
        let volume = *grid.add(6);
        let vx = volume * ix;
        let vy = volume * iy;
        let vz = volume * iz;
        if MODE == DIAGONAL {
            let mu = mu2 * 0.5;
            let parallel = bulk + (2.0 / 3.0) * mu2;
            diagonal_edge(
                dst,
                xa,
                xb,
                (vx * parallel) * ix,
                (vx * mu) * ix,
                (vx * mu) * ix,
            );
            diagonal_edge(
                dst,
                ya,
                yb,
                (vy * mu) * iy,
                (vy * parallel) * iy,
                (vy * mu) * iy,
            );
            diagonal_edge(
                dst,
                za,
                zb,
                (vz * mu) * iz,
                (vz * mu) * iz,
                (vz * parallel) * iz,
            );
            return;
        }
        if MODE == THERMAL_LOAD {
            edge(dst, xa, xb, vx, pressure, 0.0, 0.0);
            edge(dst, ya, yb, vy, 0.0, pressure, 0.0);
            edge(dst, za, zb, vz, 0.0, 0.0, pressure);
            return;
        }

        let dx = gradient(u, xa, xb, ix);
        let dy = gradient(u, ya, yb, iy);
        let dz = gradient(u, za, zb, iz);
        let dxx = f64x2_extract_lane::<0>(dx);
        let dyy = f64x2_extract_lane::<1>(dy);
        let dzz = (*u.add(zb + 2) - *u.add(za + 2)) * iz;
        let div = (dxx + dyy) + dzz;
        let third = div / 3.0;
        let hydrostatic = bulk * div;
        let xx = hydrostatic + mu2 * (dxx - third);
        let yy = hydrostatic + mu2 * (dyy - third);
        let zz = hydrostatic + mu2 * (dzz - third);
        let mu = mu2 * 0.5;
        let xy = mu * (f64x2_extract_lane::<1>(dx) + f64x2_extract_lane::<0>(dy));
        let yz = mu * ((*u.add(yb + 2) - *u.add(ya + 2)) * iy + f64x2_extract_lane::<1>(dz));
        let zx = mu * (f64x2_extract_lane::<0>(dz) + (*u.add(xb + 2) - *u.add(xa + 2)) * ix);
        edge(dst, xa, xb, vx, xx, xy, zx);
        edge(dst, ya, yb, vy, xy, yy, yz);
        edge(dst, za, zb, vz, zx, yz, zz);
        if !cell_stress.is_null() {
            let sixth = 1.0 / 6.0;
            *cell_stress += (xx - pressure) * sixth;
            *cell_stress.add(1) += (yy - pressure) * sixth;
            *cell_stress.add(2) += (zz - pressure) * sixth;
            *cell_stress.add(3) += xy * sixth;
            *cell_stress.add(4) += yz * sixth;
            *cell_stress.add(5) += zx * sixth;
        }
    }
}

unsafe fn assemble<const MODE: u32>(
    grid: *const f64,
    coefficients: *const f64,
    pressure: *const f64,
    dst: *mut f64,
    u: *const f64,
    stress: *mut f64,
) {
    unsafe {
        let nx = *grid as usize;
        let ny = *grid.add(1) as usize;
        let nz = *grid.add(2) as usize;
        let sx = 3;
        let sy = sx * (nx + 1);
        let sz = sy * (ny + 1);
        ptr::write_bytes(dst, 0, sz * (nz + 1));
        let mut index = 0;
        for z in 0..nz {
            for y in 0..ny {
                let mut p = z * sz + y * sy;
                for _ in 0..nx {
                    let px = p + sx;
                    let py = p + sy;
                    let pz = p + sz;
                    let pxy = px + sy;
                    let pyz = py + sz;
                    let pzx = pz + sx;
                    let pxyz = pxy + sz;
                    let mu2 = *coefficients.add(4 * index);
                    let bulk = *coefficients.add(4 * index + 1);
                    let q = if pressure.is_null() {
                        0.0
                    } else {
                        *pressure.add(index)
                    };
                    let cell = if stress.is_null() {
                        stress
                    } else {
                        let cell = stress.add(6 * index);
                        ptr::write_bytes(cell, 0, 6);
                        cell
                    };
                    tet::<MODE>(grid, dst, u, cell, mu2, bulk, q, p, px, px, pxy, pxy, pxyz);
                    tet::<MODE>(grid, dst, u, cell, mu2, bulk, q, p, px, pzx, pxyz, px, pzx);
                    tet::<MODE>(grid, dst, u, cell, mu2, bulk, q, py, pxy, p, py, pxy, pxyz);
                    tet::<MODE>(grid, dst, u, cell, mu2, bulk, q, pyz, pxyz, p, py, py, pyz);
                    tet::<MODE>(grid, dst, u, cell, mu2, bulk, q, pz, pzx, pzx, pxyz, p, pz);
                    tet::<MODE>(grid, dst, u, cell, mu2, bulk, q, pyz, pxyz, pz, pyz, p, pz);
                    p += sx;
                    index += 1;
                }
            }
        }
    }
}

unsafe fn dot(a: *const f64, b: *const f64, n: usize) -> f64 {
    let mut sum = 0.0;
    let mut i = 0;
    unsafe {
        while i + 1 < n {
            let product = f64x2_mul(load2(a, i), load2(b, i));
            sum += f64x2_extract_lane::<0>(product);
            sum += f64x2_extract_lane::<1>(product);
            i += 2;
        }
        if i < n {
            sum += *a.add(i) * *b.add(i);
        }
    }
    sum
}

unsafe fn direction(p: *mut f64, r: *const f64, inv_diag: *const f64, n: usize, beta: f64) -> f64 {
    let mut product = 0.0;
    unsafe {
        for i in 0..n {
            let ri = *r.add(i);
            let preconditioned = *inv_diag.add(i) * ri;
            product += ri * preconditioned;
            *p.add(i) = preconditioned + beta * *p.add(i);
        }
    }
    product
}

unsafe fn residual(
    r: *mut f64,
    rhs: *const f64,
    applied: *const f64,
    flags: *const u8,
    n: usize,
) -> f64 {
    let mut max: f64 = 0.0;
    unsafe {
        for i in 0..n {
            let value = if *flags.add(i) == 0 {
                *rhs.add(i) - *applied.add(i)
            } else {
                0.0
            };
            if !value.is_finite() {
                return f64::NAN;
            }
            *r.add(i) = value;
            max = max.max(value.abs());
        }
    }
    max
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn thermoelastic_prepare(
    grid: *const f64,
    coefficients: *const f64,
    flags: *const u8,
    inv_diag: *mut f64,
    dofs: usize,
) -> u32 {
    unsafe {
        assemble::<DIAGONAL>(
            grid,
            coefficients,
            ptr::null(),
            inv_diag,
            ptr::null(),
            ptr::null_mut(),
        );
        for i in 0..dofs {
            let diagonal = *inv_diag.add(i);
            if !(diagonal > 0.0) || !diagonal.is_finite() || !(1.0 / diagonal).is_finite() {
                return 1;
            }
            *inv_diag.add(i) = if *flags.add(i) == 0 {
                1.0 / diagonal
            } else {
                0.0
            };
        }
    }
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn thermoelastic_solve(
    grid: *const f64,
    coeff: *const f64,
    flags: *const u8,
    inv_diag: *const f64,
    temperature: *const f64,
    phase: *const f64,
    displacement: *mut f64,
    stress: *mut f64,
    reaction: *mut f64,
    work: *mut f64,
    cells: usize,
    dofs: usize,
) -> u32 {
    unsafe {
        let rhs = work.add(dofs);
        let r = rhs.add(dofs);
        let p = r.add(dofs);
        let ap = p.add(dofs);
        let pressure = ap.add(dofs);
        let cell_stress = pressure.add(cells);
        for i in 0..cells {
            if !phase.is_null() && *phase.add(i) != 0.0 {
                return 2;
            }
            let t = *temperature.add(i);
            let change = t - *coeff.add(4 * i + 3);
            let q = change * *coeff.add(4 * i + 2);
            if !(t >= 0.0) || !q.is_finite() {
                return 1;
            }
            *pressure.add(i) = q;
        }
        assemble::<THERMAL_LOAD>(grid, coeff, pressure, rhs, ptr::null(), ptr::null_mut());
        for i in 0..dofs {
            *work.add(i) = if *flags.add(i) == 0 {
                0.0
            } else {
                *displacement.add(i)
            };
        }
        assemble::<ELASTIC_LOAD>(grid, coeff, ptr::null(), ap, work, ptr::null_mut());
        let initial = residual(r, rhs, ap, flags, dofs);
        if !initial.is_finite() {
            return 1;
        }
        let tolerance = *grid.add(7) * initial;
        if initial != 0.0 {
            // The constrained entries remain exactly zero in every search direction.
            ptr::write_bytes(p, 0, dofs);
            let mut rho = direction(p, r, inv_diag, dofs, 0.0);
            let mut converged = false;
            for _ in 0..*grid.add(8) as u32 {
                assemble::<ELASTIC_LOAD>(grid, coeff, ptr::null(), ap, p, ptr::null_mut());
                let pap = dot(p, ap, dofs);
                if !(pap > 0.0) || !(rho > 0.0) || !pap.is_finite() || !rho.is_finite() {
                    return 1;
                }
                let alpha = rho / pap;
                let mut error: f64 = 0.0;
                let mut next_rho = 0.0;
                for i in 0..dofs {
                    if *flags.add(i) != 0 {
                        continue;
                    }
                    *work.add(i) += alpha * *p.add(i);
                    let ri = *r.add(i) - alpha * *ap.add(i);
                    if !ri.is_finite() || !(*work.add(i)).is_finite() {
                        return 1;
                    }
                    *r.add(i) = ri;
                    error = error.max(ri.abs());
                    next_rho += ri * (*inv_diag.add(i) * ri);
                }
                if error <= tolerance {
                    converged = true;
                    break;
                }
                let beta = next_rho / rho;
                rho = direction(p, r, inv_diag, dofs, beta);
            }
            if !converged {
                return 3;
            }
        }

        // Re-evaluate equilibrium from the displacement, independent of the
        // recursively updated residual. Write published state only on success.
        assemble::<ELASTIC_LOAD>(grid, coeff, pressure, ap, work, cell_stress);
        let check = residual(r, rhs, ap, flags, dofs);
        if !check.is_finite() {
            return 1;
        }
        if check > tolerance {
            return 3;
        }
        for i in 0..6 * cells {
            if !(*cell_stress.add(i)).is_finite() {
                return 1;
            }
        }
        for i in 0..dofs {
            let force = if *flags.add(i) == 2 {
                *ap.add(i) - *rhs.add(i)
            } else {
                0.0
            };
            if !force.is_finite() {
                return 1;
            }
            *r.add(i) = force;
        }
        ptr::copy_nonoverlapping(work, displacement, dofs);
        ptr::copy_nonoverlapping(r, reaction, dofs);
        ptr::copy_nonoverlapping(cell_stress, stress, 6 * cells);
    }
    0
}
