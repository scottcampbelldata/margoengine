#![no_std]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

// Depth-integrated natural granular flows. The equations and limits are in the physics clean-room record.

#[derive(Clone, Copy)]
#[repr(C)]
struct Column {
    depth: f64,
    discharge_x: f64,
    discharge_z: f64,
    bed: f64,
}

impl Column {
    fn velocity(self) -> [f64; 2] {
        if self.depth == 0.0 {
            return [0.0; 2];
        }
        [self.discharge_x / self.depth, self.discharge_z / self.depth]
    }

    fn add_flux(
        &mut self,
        dt_over_width: f64,
        mass: f64,
        normal: f64,
        tangent: f64,
        along_x: bool,
    ) {
        self.depth += mass * dt_over_width;
        let (flux_x, flux_z) = if along_x {
            (normal, tangent)
        } else {
            (tangent, normal)
        };
        self.discharge_x += flux_x * dt_over_width;
        self.discharge_z += flux_z * dt_over_width;
    }
}

struct Model {
    gravity: f64,
    dx: f64,
    dz: f64,
    friction: f64,
    turbulence: f64,
}

fn length(x: f64, z: f64) -> f64 {
    let scale = x.abs().max(z.abs());
    if scale == 0.0 || !scale.is_finite() {
        return scale;
    }
    let pair = f64x2(x / scale, z / scale);
    let square = f64x2_mul(pair, pair);
    scale * sqrt(f64x2_extract_lane::<0>(square) + f64x2_extract_lane::<1>(square))
}

// Apparent topography includes the interface projection of Coulomb friction. Projection in both
// velocity components makes an oblique sliding column use one friction budget.
fn apparent_step(
    low: Column,
    high: Column,
    step: f64,
    width: f64,
    dt: f64,
    model: &Model,
    x: bool,
) -> f64 {
    if model.friction == 0.0 || model.gravity == 0.0 {
        return step;
    }
    let weight = low.depth + high.depth;
    let time = model.gravity * dt;
    let average_x = (low.discharge_x + high.discharge_x) / weight;
    let average_z = (low.discharge_z + high.discharge_z) / weight;
    let slope_impulse = ((low.depth - high.depth) - step) * (time / width);
    let (trial_x, trial_z) = if x {
        (average_x + slope_impulse, average_z)
    } else {
        (average_x, average_z + slope_impulse)
    };
    let normal = if x { trial_x } else { trial_z };
    let limit = model.friction * time;
    let magnitude = length(trial_x, trial_z);
    if magnitude <= limit {
        // At exact rest this also avoids roundoff in reconstructing a static free surface.
        return low.depth - high.depth + (if x { average_x } else { average_z }) * (width / time);
    }
    step + (normal / magnitude) * model.friction * width
}

fn face(
    state: &[Column],
    next: &mut [Column],
    left: usize,
    right: usize,
    dt: f64,
    width: f64,
    model: &Model,
    x: bool,
) {
    let a = unsafe { *state.get_unchecked(left) };
    let b = unsafe { *state.get_unchecked(right) };
    if a.depth == 0.0 && b.depth == 0.0 {
        return;
    }
    let offset = apparent_step(a, b, b.bed - a.bed, width, dt, model, x);
    let ha = (a.depth - offset.max(0.0)).max(0.0);
    let hb = (b.depth - (-offset).max(0.0)).max(0.0);
    let [ax, az] = a.velocity();
    let [bx, bz] = b.velocity();
    let ((ua, va), (ub, vb)) = if x {
        ((ax, az), (bx, bz))
    } else {
        ((az, ax), (bz, bx))
    };
    let speed = (ua.abs() + sqrt(model.gravity * ha)).max(ub.abs() + sqrt(model.gravity * hb));
    let qa = ha * ua;
    let qb = hb * ub;
    let mass = 0.5 * (qa + qb - speed * (hb - ha));
    let advective = 0.5 * (qa * ua + qb * ub - speed * (qb - qa));
    let tangent = 0.5 * (qa * va + qb * vb - speed * (hb * vb - ha * va));
    // Group the hydrostatic difference this way so a resting interface evaluates to exactly
    // each cell's own column pressure, including at a reconstructed dry bank.
    let difference = (hb - ha) * (hb + ha);
    let pressure = 0.5 * model.gravity;
    let normal_a = advective + pressure * (a.depth * a.depth + 0.5 * difference);
    let normal_b = advective + pressure * (b.depth * b.depth - 0.5 * difference);
    let span = dt / width;
    unsafe { next.get_unchecked_mut(left) }.add_flux(-span, mass, normal_a, tangent, x);
    unsafe { next.get_unchecked_mut(right) }.add_flux(span, mass, normal_b, tangent, x);
}

fn wall(state: &[Column], next: &mut [Column], index: usize, span: f64, g: f64, x: bool) {
    let column = unsafe { *state.get_unchecked(index) };
    let next = unsafe { next.get_unchecked_mut(index) };
    let [ux, uz] = column.velocity();
    let u = if x { ux } else { uz };
    let q = if x {
        column.discharge_x
    } else {
        column.discharge_z
    };
    let speed = u.abs() + sqrt(g * column.depth);
    // Slip wall reflection reverses only the normal discharge. It transmits no mass.
    let signed_q = if span > 0.0 { -q } else { q };
    let normal = q * u + 0.5 * g * (column.depth * column.depth) + speed * signed_q;
    next.add_flux(span, 0.0, normal, 0.0, x);
}

fn advance(
    state: &[Column],
    next: &mut [Column],
    nx: usize,
    nz: usize,
    dt: f64,
    model: &Model,
) -> bool {
    unsafe { core::ptr::copy_nonoverlapping(state.as_ptr(), next.as_mut_ptr(), state.len()) };
    for z in 0..nz {
        let start = z * nx;
        let last = start + nx - 1;
        wall(state, next, start, dt / model.dx, model.gravity, true);
        for i in start..last {
            face(state, next, i, i + 1, dt, model.dx, model, true);
        }
        wall(state, next, last, -dt / model.dx, model.gravity, true);
    }
    for x in 0..nx {
        let last = x + nx * (nz - 1);
        wall(state, next, x, dt / model.dz, model.gravity, false);
        for z in 0..nz - 1 {
            let i = x + z * nx;
            face(state, next, i, i + nx, dt, model.dz, model, false);
        }
        wall(state, next, last, -dt / model.dz, model.gravity, false);
    }
    for value in next.iter_mut() {
        if !value.depth.is_finite() || value.depth < 0.0 {
            return false;
        }
        if value.depth == 0.0 {
            value.discharge_x = 0.0;
            value.discharge_z = 0.0;
            continue;
        }
        let speed = length(value.discharge_x, value.discharge_z) / value.depth;
        if !speed.is_finite() {
            return false;
        }
        // Positive backward-Euler root of u + dt*g*u^2/(xi*h) = u_before.
        let drag = (model.gravity * dt / model.turbulence) * speed / value.depth;
        let scale = 2.0 / (1.0 + sqrt(1.0 + 4.0 * drag));
        value.discharge_x *= scale;
        value.discharge_z *= scale;
    }
    true
}

// Callers use two independently allocated arena regions of nx*nz columns. Work is transactional
// at the public port: the TypeScript adapter copies this scratch state out only on success.
#[unsafe(no_mangle)]
pub extern "C" fn granular_step(
    work: *mut f64,
    trial: *mut f64,
    nx: usize,
    nz: usize,
    dt: f64,
    dx: f64,
    dz: f64,
    gravity: f64,
    friction: f64,
    turbulence: f64,
) -> i32 {
    let count = nx * nz;
    let work = unsafe { core::slice::from_raw_parts_mut(work.cast::<Column>(), count) };
    let trial = unsafe { core::slice::from_raw_parts_mut(trial.cast::<Column>(), count) };
    let model = Model {
        gravity,
        dx,
        dz,
        friction,
        turbulence,
    };
    let mut remaining = dt;
    let mut steps = 0;
    while remaining > 0.0 {
        let mut max_x = 0.0_f64;
        let mut max_z = 0.0_f64;
        for value in work.iter() {
            let [u, v] = value.velocity();
            let c = sqrt(gravity * value.depth);
            max_x = max_x.max(u.abs() + c);
            max_z = max_z.max(v.abs() + c);
        }
        // Each face can remove at most its speed bound times the donor column.
        // The combined 2D Courant number leaves a strict nonnegative reserve.
        let step = remaining.min(0.25 / (max_x / dx + max_z / dz));
        if step <= 0.0 || steps == 65536 || !advance(work, trial, nx, nz, step, &model) {
            return -1;
        }
        unsafe { core::ptr::copy_nonoverlapping(trial.as_ptr(), work.as_mut_ptr(), count) };
        remaining -= step;
        steps += 1;
    }
    steps
}
