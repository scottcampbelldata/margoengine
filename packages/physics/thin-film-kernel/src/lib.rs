#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{
    f64x2_add, f64x2_ceil, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
    v128, v128_load,
};
use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    unreachable()
}

#[repr(C)]
struct Model {
    inv_dx: f64,
    density: f64,
    viscosity: f64,
    surface_tension: f64,
    slip: f64,
    pinning: f64,
    evaporation: f64,
}

#[repr(C)]
struct Wetting {
    precursor_depth: f64,
    stiffness: f64,
}

impl Wetting {
    fn pressure(&self, h: f64) -> f64 {
        let precursor = self.precursor_depth;
        if h <= precursor {
            // Continue the precursor tangent into the unresolved molecular layer.
            return self.stiffness * (h - precursor);
        }
        let ratio = precursor / h;
        self.stiffness * precursor * ratio * ratio * (1.0 - ratio)
    }
}

// Uniform current forcing in the moving plane, then left/right/up/down drainage flags.
#[repr(C)]
struct Forcing {
    gravity_n: f64,
    gravity_u: f64,
    gravity_v: f64,
    shear_u: f64,
    shear_v: f64,
    drain_u0: f64,
    drain_u1: f64,
    drain_v0: f64,
    drain_v1: f64,
}

#[derive(Clone, Copy)]
struct Grid {
    cols: usize,
    rows: usize,
    n: usize,
    inv_dx: f64,
}

impl Grid {
    fn neighbor(&self, i: usize, axis: usize) -> Option<usize> {
        if axis == 0 {
            if i.checked_rem(self.cols).unwrap_or_else(|| unreachable()) + 1 < self.cols {
                Some(i + 1)
            } else {
                None
            }
        } else if i + self.cols < self.n {
            Some(i + self.cols)
        } else {
            None
        }
    }

    fn degree(&self, i: usize) -> f64 {
        let x = i.checked_rem(self.cols).unwrap_or_else(|| unreachable());
        let z = i.checked_div(self.cols).unwrap_or_else(|| unreachable());
        f64::from(
            u32::from(x > 0)
                + u32::from(x + 1 < self.cols)
                + u32::from(z > 0)
                + u32::from(z + 1 < self.rows),
        )
    }

    unsafe fn laplacian(&self, input: *const f64, out: *mut f64) {
        zero(out, self.n);
        let inv_dx2 = self.inv_dx * self.inv_dx;
        for i in 0..self.n {
            for axis in 0..2 {
                if let Some(j) = self.neighbor(i, axis) {
                    let d = (*input.add(i) - *input.add(j)) * inv_dx2;
                    *out.add(i) += d;
                    *out.add(j) -= d;
                }
            }
        }
    }

    unsafe fn gradient_transpose(&self, face: *const f64, weight: *const f64, out: *mut f64) {
        zero(out, self.n);
        for i in 0..self.n {
            for axis in 0..2 {
                if let Some(j) = self.neighbor(i, axis) {
                    let k = 2 * i + axis;
                    let flux = *face.add(k) * *weight.add(k) * self.inv_dx;
                    *out.add(i) -= flux;
                    *out.add(j) += flux;
                }
            }
        }
    }
}

unsafe fn zero(values: *mut f64, count: usize) {
    values.write_bytes(0, count);
}

#[inline(always)]
fn scalar_sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

unsafe fn dot(a: *const f64, b: *const f64, n: usize) -> f64 {
    let mut sum = f64x2_splat(0.0);
    for k in 0..n / 2 {
        let offset = 2 * k;
        let x = v128_load(a.add(offset).cast::<v128>());
        let y = v128_load(b.add(offset).cast::<v128>());
        sum = f64x2_add(sum, f64x2_mul(x, y));
    }
    f64x2_extract_lane::<0>(sum) + f64x2_extract_lane::<1>(sum)
}

struct Workspace {
    pressure: *mut f64,
    trial: *mut f64,
    transpose: *mut f64,
    cellwork: *mut f64,
    donor: *mut f64,
    edges: *mut f64,
    weight: *mut f64,
    diagonal: *mut f64,
    solution: *mut f64,
    residual: *mut f64,
    z: *mut f64,
    direction: *mut f64,
    result: *mut f64,
    flux: *mut f64,
}

impl Workspace {
    unsafe fn new(base: *mut f64, cells: usize) -> Self {
        Self {
            pressure: base,
            trial: base.add(cells),
            transpose: base.add(2 * cells),
            cellwork: base.add(3 * cells),
            donor: base.add(4 * cells),
            edges: base.add(5 * cells),
            weight: base.add(9 * cells),
            diagonal: base.add(11 * cells),
            solution: base.add(13 * cells),
            residual: base.add(15 * cells),
            z: base.add(17 * cells),
            direction: base.add(19 * cells),
            result: base.add(21 * cells),
            flux: base.add(23 * cells),
        }
    }
}

struct Film {
    grid: Grid,
    work: Workspace,
    model: *const Model,
    wetting: *const Wetting,
    external: *const Forcing,
    height: *mut f64,
    base: *const f64,
}

impl Film {
    fn mobility(&self, h: f64) -> f64 {
        let model = unsafe { &*self.model };
        h * h * (h / 3.0 + model.slip) / model.viscosity
    }

    fn shear_weight(&self, h: f64) -> f64 {
        let model = unsafe { &*self.model };
        h * (0.5 * h + model.slip) / model.viscosity
    }

    unsafe fn hydraulic_pressure(&self, h: *const f64, k: f64, out: *mut f64) {
        let sigma = (*self.model).surface_tension;
        zero(out, self.grid.n);
        if sigma != 0.0 {
            self.grid.laplacian(h, out);
        }
        for i in 0..self.grid.n {
            *out.add(i) = k * *h.add(i) + sigma * *out.add(i);
        }
    }

    unsafe fn matrix(&self, x: *const f64, result: *mut f64, k: f64, dt: f64) {
        let w = &self.work;
        self.grid.gradient_transpose(x, w.weight, w.transpose);
        self.hydraulic_pressure(w.transpose, k, w.cellwork);
        for i in 0..self.grid.n {
            for axis in 0..2 {
                let f = 2 * i + axis;
                let g = if let Some(j) = self.grid.neighbor(i, axis) {
                    (*w.cellwork.add(j) - *w.cellwork.add(i)) * self.grid.inv_dx
                } else {
                    0.0
                };
                *result.add(f) = *x.add(f) + dt * g * *w.weight.add(f);
            }
        }
    }

    unsafe fn wet_solution(&self, k: f64, dt: f64) -> bool {
        let grid = self.grid;
        let work = &self.work;
        let model = &*self.model;
        let n = grid.n;
        for i in 0..n {
            work.trial
                .add(i)
                .write(*self.base.add(i) + *self.height.add(i));
        }
        self.hydraulic_pressure(work.trial, k, work.pressure);
        let mut k = k;
        if let Some(wetting) = self.wetting.as_ref() {
            if wetting.stiffness > 0.0 {
                for i in 0..n {
                    *work.pressure.add(i) += wetting.pressure(*self.height.add(i));
                }
                // Treat the upper bound on wetting energy curvature implicitly so PCG stays positive.
                k += wetting.stiffness;
            }
        }
        let dx2 = grid.inv_dx * grid.inv_dx;
        let capillary = model.surface_tension * dx2 * dx2;
        zero(work.solution, 2 * n);
        for i in 0..n {
            let h = *self.height.add(i);
            let head = *work.pressure.add(i);
            for axis in 0..2 {
                let f = 2 * i + axis;
                let mut weight = 0.0;
                let mut inverse = 1.0;
                let mut rhs = 0.0;
                if let Some(j) = grid.neighbor(i, axis) {
                    let other = *self.height.add(j);
                    let mut m = 0.5 * (self.mobility(h) + self.mobility(other));
                    rhs = -*work.pressure.add(j) + head;
                    // Contact-line hysteresis is a pressure deadband only at a wet/dry edge.
                    if (h == 0.0) != (other == 0.0) {
                        let threshold = model.pinning * grid.inv_dx;
                        rhs -= rhs.max(-threshold).min(threshold);
                        if rhs == 0.0 {
                            m = 0.0;
                        }
                    }
                    weight = scalar_sqrt(m);
                    inverse = 1.0
                        / (1.0
                            + dt * m
                                * (2.0 * k * dx2
                                    + (grid.degree(i) + grid.degree(j) + 2.0) * capillary));
                    rhs *= weight * grid.inv_dx;
                }
                work.weight.add(f).write(weight);
                work.diagonal.add(f).write(inverse);
                work.residual.add(f).write(rhs);
                work.direction.add(f).write(rhs * inverse);
            }
        }
        let len = 2 * n;
        let rhs2 = dot(work.residual, work.residual, len);
        if !rhs2.is_finite() {
            return false;
        }
        if rhs2 == 0.0 {
            return true;
        }
        // PCG on a symmetric positive definite face operator, with an exact diagonal.
        let tolerance2 = rhs2 * 1e-22;
        let mut rz = dot(work.residual, work.direction, len);
        for _ in 0..len {
            self.matrix(work.direction, work.result, k, dt);
            let denom = dot(work.direction, work.result, len);
            if !(denom > 0.0 && denom.is_finite()) {
                return false;
            }
            let alpha = rz / denom;
            for i in 0..len {
                *work.solution.add(i) += alpha * *work.direction.add(i);
                *work.residual.add(i) -= alpha * *work.result.add(i);
                *work.z.add(i) = *work.diagonal.add(i) * *work.residual.add(i);
            }
            if dot(work.residual, work.residual, len) <= tolerance2 {
                return true;
            }
            let next_rz = dot(work.residual, work.z, len);
            let beta = next_rz / rz;
            rz = next_rz;
            for i in 0..len {
                *work.direction.add(i) = *work.z.add(i) + beta * *work.direction.add(i);
            }
        }
        false
    }

    fn transport(&self, h: f64, body: f64, shear: f64, at_front: bool) -> f64 {
        let model = unsafe { &*self.model };
        let m = self.mobility(h);
        let q = m * body + self.shear_weight(h) * shear;
        if at_front && model.pinning > 0.0 {
            let threshold = model.pinning * self.grid.inv_dx * self.grid.inv_dx * m;
            q - q.max(-threshold).min(threshold)
        } else {
            q
        }
    }

    unsafe fn advective_faces(&self) {
        let s = &*self.external;
        let grid = self.grid;
        let w = &self.work;
        let density = (*self.model).density;
        let u_body = density * s.gravity_u;
        let v_body = density * s.gravity_v;
        let normal = density * s.gravity_n * 2.0 * grid.inv_dx;
        zero(w.flux, 2 * grid.n);
        zero(w.edges, 4 * grid.n);
        for i in 0..grid.n {
            let h = *self.height.add(i);
            let x = i.checked_rem(grid.cols).unwrap_or_else(|| unreachable());
            let z = i.checked_div(grid.cols).unwrap_or_else(|| unreachable());
            let slip_u = self.transport(h, u_body, s.shear_u, false);
            let slip_v = self.transport(h, v_body, s.shear_v, false);
            let head = self.mobility(h) * h * normal;
            // Open edges see a dry external reservoir, a half cell away.
            if x == 0 && s.drain_u0 != 0.0 {
                w.edges.add(4 * i).write((-slip_u + head).max(0.0));
            }
            if x + 1 == grid.cols && s.drain_u1 != 0.0 {
                w.edges.add(4 * i + 1).write((slip_u + head).max(0.0));
            }
            if z == 0 && s.drain_v0 != 0.0 {
                w.edges.add(4 * i + 2).write((-slip_v + head).max(0.0));
            }
            if z + 1 == grid.rows && s.drain_v1 != 0.0 {
                w.edges.add(4 * i + 3).write((slip_v + head).max(0.0));
            }
            for axis in 0..2 {
                if let Some(j) = grid.neighbor(i, axis) {
                    let other = *self.height.add(j);
                    let (body, shear, local) = if axis == 0 {
                        (u_body, s.shear_u, slip_u)
                    } else {
                        (v_body, s.shear_v, slip_v)
                    };
                    let other_flux = self.transport(other, body, shear, false);
                    // Left or right information upwinds the advective flux.
                    let q = if local + other_flux >= 0.0 {
                        self.transport(h, body, shear, other == 0.0)
                    } else {
                        self.transport(other, body, shear, h == 0.0)
                    };
                    w.flux.add(2 * i + axis).write(q);
                }
            }
        }
    }

    unsafe fn move_water(&mut self, dt: f64, drains: bool, out: *mut f64) {
        let w = &self.work;
        let grid = self.grid;
        let step = dt * grid.inv_dx;
        zero(w.donor, grid.n);
        zero(w.trial, grid.n);
        zero(w.cellwork, grid.n);
        for i in 0..grid.n {
            for axis in 0..2 {
                if let Some(j) = grid.neighbor(i, axis) {
                    let flux = *w.flux.add(2 * i + axis);
                    *w.donor.add(if flux >= 0.0 { i } else { j }) += step * flux.abs();
                }
            }
            if drains {
                for edge in 0..4 {
                    *w.donor.add(i) += step * *w.edges.add(4 * i + edge);
                }
            }
        }
        // Donors share the available cell volume across all exit faces. Both
        // sides of a face use the same limited flux, including near dry patches.
        for i in 0..grid.n {
            let leaving = *w.donor.add(i);
            w.donor.add(i).write(if leaving == 0.0 {
                1.0
            } else {
                (*self.height.add(i) / leaving).min(1.0)
            });
        }
        for i in 0..grid.n {
            for axis in 0..2 {
                if let Some(j) = grid.neighbor(i, axis) {
                    let flux = *w.flux.add(2 * i + axis);
                    let (from, to) = if flux >= 0.0 { (i, j) } else { (j, i) };
                    let water = step * flux.abs() * *w.donor.add(from);
                    *w.trial.add(from) += water;
                    *w.cellwork.add(to) += water;
                }
            }
            if drains {
                for edge in 0..4 {
                    let amount = step * *w.edges.add(4 * i + edge) * *w.donor.add(i);
                    *w.trial.add(i) += amount;
                    *out.add(i) += amount;
                }
            }
        }
        for i in 0..grid.n {
            *self.height.add(i) =
                (*self.height.add(i) - *w.trial.add(i)).max(0.0) + *w.cellwork.add(i);
        }
    }

    unsafe fn step(&mut self, rain: *const f64, exits: *mut f64, budget: *mut f64, dt: f64) -> u32 {
        let grid = self.grid;
        let n = grid.n;
        let model = &*self.model;
        let forcing = &*self.external;
        let k = forcing.gravity_n * model.density;
        let drains =
            forcing.drain_u0 + forcing.drain_u1 + forcing.drain_v0 + forcing.drain_v1 > 0.0;
        let area = 1.0 / (grid.inv_dx * grid.inv_dx);
        let mut rainfall = 0.0;
        let mut evaporation = 0.0;
        let mut max_adv: f64 = 0.0;
        zero(exits, n);
        for i in 0..n {
            let added = *rain.add(i) * dt;
            let available = *self.height.add(i) + added;
            let leaving = (dt * model.evaporation).min(available);
            let h = available - leaving;
            *self.height.add(i) = h;
            rainfall += added;
            evaporation += leaving;
            if h > 0.0 {
                let slope = model.density * (forcing.gravity_u.abs() + forcing.gravity_v.abs());
                let air = forcing.shear_u.abs() + forcing.shear_v.abs();
                // Characteristic speed uses d(q)/dh, including the open edge head.
                let speed = h * (h + 2.0 * model.slip) / model.viscosity * slope
                    + (h + model.slip) / model.viscosity * air;
                let edge_speed = if drains {
                    2.0 * grid.inv_dx * k * h * h * (4.0 * h / 3.0 + 3.0 * model.slip)
                        / model.viscosity
                } else {
                    0.0
                };
                max_adv = max_adv.max(speed + edge_speed);
            }
        }
        let substeps =
            f64x2_extract_lane::<0>(f64x2_ceil(f64x2_splat(2.0 * max_adv * dt * grid.inv_dx)))
                .max(1.0);
        if !(rainfall.is_finite() && evaporation.is_finite() && substeps <= f64::from(u32::MAX)) {
            return 1;
        }
        let step = dt / substeps;
        for _ in 0..substeps as u32 {
            self.advective_faces();
            self.move_water(step, true, exits);
            if !self.wet_solution(k, step) {
                return 2;
            }
            for i in 0..2 * n {
                let weight = *self.work.weight.add(i);
                let flux = *self.work.solution.add(i);
                self.work.flux.add(i).write(weight * flux);
            }
            self.move_water(step, false, exits);
        }
        let mut runoff = 0.0;
        let mut stored = 0.0;
        for i in 0..n {
            let h = *self.height.add(i);
            if !h.is_finite() || !(*exits.add(i)).is_finite() {
                return 1;
            }
            stored += h;
            runoff += *exits.add(i);
            *exits.add(i) *= area / dt;
        }
        budget.write(rainfall * area);
        budget.add(1).write(evaporation * area);
        budget.add(2).write(runoff * area);
        budget.add(3).write(stored * area);
        budget.add(4).write(substeps);
        0
    }
}

// Every pointer belongs to the calling solver's arena allocation.
#[unsafe(no_mangle)]
unsafe extern "C" fn thin_film_step(
    height: *mut f64,
    base: *const f64,
    rain: *const f64,
    out: *mut f64,
    budget: *mut f64,
    model: *const Model,
    forcing: *const Forcing,
    workspace: *mut f64,
    cols: u32,
    rows: u32,
    dt: f64,
    wetting: *const Wetting,
) -> u32 {
    let (cols, rows) = (cols as usize, rows as usize);
    let n = cols * rows;
    let grid = Grid {
        cols,
        rows,
        n,
        inv_dx: (*model).inv_dx,
    };
    let work = Workspace::new(workspace, n);
    Film {
        grid,
        work,
        model,
        wetting,
        external: forcing,
        height,
        base,
    }
    .step(rain, out, budget, dt)
}
