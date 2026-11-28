use crate::{
    Grid, HillError, NonZeroUsize, Settings, hill_multiplier, read_col, relax, sqrt, word,
    word_mut, write_col,
};
use core::{
    arch::wasm32::{f64x2, f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_sqrt},
    slice,
};

const RANGE: i32 = 1;
const CFL: i32 = 2;
const ABI: i32 = 3;
const RECEIPT: usize = 7;

#[repr(C)]
struct Job {
    wind: *const f64,
    controls: *const f64,
    height: *const f64,
    settings: *const Settings,
    mass: *mut f64,
    mobile: *mut f64,
    bed_delta: *mut f64,
    motion: *mut f64,
    dust: *mut f64,
    drag: *mut f64,
    budget: *mut f64,
    scratch: *mut f64,
    receipts: *mut [f64; RECEIPT],
    nx: u32,
    nz: u32,
    open: u32,
    substeps: u32,
    reserved: u32,
    dx: f64,
    dz: f64,
    dt: f64,
    world_dt: f64,
    sub_dt: f64,
}

const _: () = assert!(core::mem::size_of::<Job>() == 112);

impl Job {
    fn grid(&self) -> Option<(Grid, usize)> {
        let nx = NonZeroUsize::new(self.nx as usize)?;
        let nz = self.nz as usize;
        if nx.get() < 2 || nz < 2 {
            return None;
        }
        let n = nx.get().checked_mul(nz)?;
        Some((
            Grid {
                nx,
                nz,
                dx: self.dx,
                dz: self.dz,
                open: self.open,
            },
            n,
        ))
    }
}

unsafe fn output<'a>(ptr: *mut f64, n: usize, plane: usize, lo: usize, hi: usize) -> &'a mut [f64] {
    unsafe { slice::from_raw_parts_mut(ptr.add(plane * n + lo), hi - lo) }
}

fn speeds(x: &[f64], z: &[f64], i: usize) -> [f64; 2] {
    let x = f64x2(word(x, i), word(x, i + 1));
    let z = f64x2(word(z, i), word(z, i + 1));
    let speed = f64x2_sqrt(f64x2_add(f64x2_mul(x, x), f64x2_mul(z, z)));
    [
        f64x2_extract_lane::<0>(speed),
        f64x2_extract_lane::<1>(speed),
    ]
}

fn visit_speeds(
    x: &[f64],
    z: &[f64],
    lo: usize,
    hi: usize,
    mut visit: impl FnMut(usize, f64) -> bool,
) -> bool {
    let mut row = lo;
    while row + 1 < hi {
        let [left, right] = speeds(x, z, row);
        if !visit(row, left) || !visit(row + 1, right) {
            return false;
        }
        row += 2;
    }
    row == hi
        || visit(
            row,
            sqrt(word(x, row) * word(x, row) + word(z, row) * word(z, row)),
        )
}

#[unsafe(no_mangle)]
unsafe extern "C" fn aeolian_thread_phase(
    job: *const Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return ABI;
    };
    let Some((grid, n)) = job.grid() else {
        return ABI;
    };
    if part >= parts || stage > 3 {
        return ABI;
    }
    let lo = ((part as u64 * n as u64) / parts as u64) as usize;
    let hi = (((part as u64 + 1) * n as u64) / parts as u64) as usize;
    let receipt = unsafe { &mut *job.receipts.add(part) };
    let status = match stage {
        0 => {
            *receipt = [0.0; RECEIPT];
            if unsafe { slopes(job, grid, n, lo, hi) } {
                0
            } else {
                RANGE
            }
        }
        1 => unsafe { forcing(job, grid, n, lo, hi, receipt) },
        2 => {
            if unsafe { exchange(job, grid, n, lo, hi) } {
                0
            } else {
                RANGE
            }
        }
        _ => {
            if unsafe { publish(job, n, lo, hi) } {
                0
            } else {
                RANGE
            }
        }
    };
    if status != 0 {
        return status;
    }
    *word_mut(receipt, stage as usize + 1) += (hi - lo) as f64;
    if stage == 1 || stage == 2 {
        *word_mut(receipt, stage as usize + 4) += ((hi - lo) / 2) as f64;
    }
    0
}

unsafe fn slopes(job: &Job, grid: Grid, n: usize, lo: usize, hi: usize) -> bool {
    let height = unsafe { read_col(job.height, n, 0) };
    let sx = unsafe { output(job.scratch, n, 0, lo, hi) };
    let sz = unsafe { output(job.scratch, n, 1, lo, hi) };
    unsafe { output(job.bed_delta, n, 0, lo, hi) }.fill(0.0);
    unsafe { output(job.dust, n, 0, lo, hi) }.fill(0.0);
    let nx = grid.nx();
    for i in lo..hi {
        let (x, z) = grid.coords(i);
        let left = if x > 0 { i - 1 } else { i };
        let right = if x + 1 < nx { i + 1 } else { i };
        let near = if z > 0 { i - nx } else { i };
        let far = if z + 1 < grid.nz { i + nx } else { i };
        let x_slope =
            (word(height, right) - word(height, left)) / ((right - left) as f64 * grid.dx);
        let z_slope =
            (word(height, far) - word(height, near)) / ((far - near) as f64 / nx as f64 * grid.dz);
        if !x_slope.is_finite() || !z_slope.is_finite() {
            return false;
        }
        *word_mut(sx, i - lo) = x_slope;
        *word_mut(sz, i - lo) = z_slope;
    }
    true
}

unsafe fn forcing(
    job: &Job,
    grid: Grid,
    n: usize,
    lo: usize,
    hi: usize,
    receipt: &mut [f64; RECEIPT],
) -> i32 {
    let p = unsafe { &*job.settings };
    let cover = unsafe { read_col(job.controls, n, 1) };
    let ux = unsafe { read_col(job.wind, n, 0) };
    let uz = unsafe { read_col(job.wind, n, 1) };
    let air = unsafe { read_col(job.wind, n, 2) };
    let sx = unsafe { read_col(job.scratch, n, 0) };
    let sz = unsafe { read_col(job.scratch, n, 1) };
    let vx = unsafe { output(job.scratch, n, 2, lo, hi) };
    let vz = unsafe { output(job.scratch, n, 3, lo, hi) };
    let tau = unsafe { output(job.scratch, n, 4, lo, hi) };
    let threshold = unsafe { output(job.scratch, n, 5, lo, hi) };
    let mut max_departure: f64 = 0.0;
    let mut status = RANGE;
    let valid = visit_speeds(ux, uz, lo, hi, |i, speed| {
        if !speed.is_finite() {
            return false;
        }
        let (wx, wz, rho) = (word(ux, i), word(uz, i), word(air, i));
        let (east, south) = if speed > 0.0 {
            (wx / speed, wz / speed)
        } else {
            (0.0, 0.0)
        };
        let bed_shear = if rho > 0.0 && speed > 0.0 {
            let hill = match hill_multiplier(grid, i, sx, sz, east, south, p) {
                Ok(hill) => hill,
                Err(HillError::Range) => return false,
                Err(HillError::Fetch) => {
                    status = CFL;
                    return false;
                }
            };
            rho * speed * speed * word(cover, i) * hill
        } else {
            0.0
        };
        let critical = if p.impact_threshold > 0.0 {
            rho * p.impact_threshold * p.impact_threshold
        } else {
            0.0064 * (p.grain_density - rho).max(0.0) * p.gravity * p.diameter
        };
        let x_velocity = east * p.grain_speed;
        let z_velocity = south * p.grain_speed;
        let crossing = 6.0 * (x_velocity.abs() / grid.dx + z_velocity.abs() / grid.dz);
        if !bed_shear.is_finite() || !critical.is_finite() || crossing.is_nan() {
            return false;
        }
        let row = i - lo;
        *word_mut(tau, row) = bed_shear;
        *word_mut(threshold, row) = critical;
        *word_mut(vx, row) = x_velocity;
        *word_mut(vz, row) = z_velocity;
        max_departure = max_departure.max(crossing);
        true
    });
    receipt[0] = max_departure;
    if valid { 0 } else { status }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn aeolian_thread_plan(job: *mut Job, parts: usize) -> i32 {
    let Some(job) = (unsafe { job.as_mut() }) else {
        return ABI;
    };
    if parts == 0
        || job.grid().is_none()
        || !job.dt.is_finite()
        || job.dt < 0.0
        || !job.world_dt.is_finite()
        || job.world_dt <= 0.0
    {
        return ABI;
    }
    let mut max_departure: f64 = 0.0;
    for receipt in unsafe { slice::from_raw_parts(job.receipts, parts) } {
        max_departure = max_departure.max(receipt[0]);
    }
    let crossings = job.dt * max_departure;
    if !crossings.is_finite() || crossings > u32::MAX as f64 {
        return CFL;
    }
    let whole = crossings as u32;
    let count = (whole + u32::from((whole as f64) < crossings)).max(1);
    let sub_dt = job.dt / count as f64;
    if job.dt > 0.0 && !(sub_dt > 0.0 && job.dt - sub_dt < job.dt) {
        return CFL;
    }
    job.substeps = count;
    job.sub_dt = sub_dt;
    0
}

unsafe fn exchange(job: &Job, grid: Grid, n: usize, lo: usize, hi: usize) -> bool {
    let p = unsafe { &*job.settings };
    let area = unsafe { read_col(job.controls, n, 0) };
    let cover = unsafe { read_col(job.controls, n, 1) };
    let air = unsafe { read_col(job.wind, n, 2) };
    let vx = unsafe { read_col(job.scratch, n, 2) };
    let vz = unsafe { read_col(job.scratch, n, 3) };
    let tau = unsafe { read_col(job.scratch, n, 4) };
    let threshold = unsafe { read_col(job.scratch, n, 5) };
    let mass = unsafe { output(job.mass, n, 0, lo, hi) };
    let mobile = unsafe { output(job.mobile, n, 0, lo, hi) };
    let dust = unsafe { output(job.dust, n, 0, lo, hi) };
    let bed_delta = unsafe { output(job.bed_delta, n, 0, lo, hi) };
    let buffer = unsafe { output(job.scratch, n, 6, lo, hi) };
    let out = unsafe { output(job.scratch, n, 7, lo, hi) };
    let donor = unsafe { output(job.scratch, n, 8, lo, hi) };
    let particle_mass =
        p.grain_density * core::f64::consts::PI / 6.0 * p.diameter * p.diameter * p.diameter;
    let birth_period = sqrt(p.diameter / p.gravity);
    let mass_to_shear = p.gravity / (2.0 * p.restitution);
    let dt = job.sub_dt;
    if !particle_mass.is_finite()
        || !birth_period.is_finite()
        || birth_period <= 0.0
        || !mass_to_shear.is_finite()
        || mass_to_shear <= 0.0
    {
        return false;
    }
    visit_speeds(vx, vz, lo, hi, |i, speed| {
        let row = i - lo;
        let m = word(mass, row);
        let a = word(area, i);
        let critical = word(threshold, i);
        let local_shear = word(tau, i);
        let target = if local_shear > critical && critical > 0.0 {
            let excess = local_shear - critical;
            let mut sat = excess / mass_to_shear;
            if p.snow > 0.0 {
                let rho = word(air, i);
                let friction = sqrt(local_shear / (rho * word(cover, i)));
                let threshold_velocity = sqrt(critical / rho);
                // Pomeroy–Gray Eq. 11 removes vegetation stress in the numerator only.
                sat = 0.68 * threshold_velocity * excess / (p.gravity * friction * p.grain_speed);
            }
            let growth = p.multiplication * mass_to_shear * excess / (p.grain_speed * critical);
            let fluid_threshold = critical * p.initiation_ratio * p.initiation_ratio;
            if !sat.is_finite() || !growth.is_finite() || !fluid_threshold.is_finite() {
                return false;
            }
            let birth = if local_shear > fluid_threshold {
                particle_mass / birth_period
            } else {
                0.0
            };
            if sat > 0.0 {
                let Some(next) = relax(m, growth, sat, birth, dt) else {
                    return false;
                };
                next
            } else {
                m
            }
        } else {
            m * p.settling_time / (p.settling_time + dt)
        };
        let request = (target - m) * a;
        if !speed.is_finite() || !request.is_finite() {
            return false;
        }
        let pickup = request.min(word(mobile, row));
        let raw_moving = m + pickup / a;
        if !raw_moving.is_finite() {
            return false;
        }
        let moving = raw_moving.max(0.0);
        *word_mut(mass, row) = moving;
        *word_mut(mobile, row) -= pickup;
        let raw_dust = p.dust_efficiency * moving * speed * word(cover, i) * a * dt;
        if !raw_dust.is_finite() {
            return false;
        }
        let blown_dust = raw_dust.min(word(mobile, row));
        *word_mut(dust, row) += blown_dust;
        *word_mut(mobile, row) -= blown_dust;
        *word_mut(bed_delta, row) -= (pickup + blown_dust) / (a * p.bulk_density);
        let open_out = grid.outward_rate(i, word(vx, i), word(vz, i)) * moving * dt;
        *word_mut(out, row) = open_out;
        *word_mut(buffer, row) = moving * a;
        *word_mut(donor, row) = open_out;
        open_out.is_finite()
            && word(buffer, row).is_finite()
            && word(dust, row).is_finite()
            && word(mobile, row).is_finite()
            && word(bed_delta, row).is_finite()
    })
}

#[unsafe(no_mangle)]
unsafe extern "C" fn aeolian_thread_route(job: *const Job) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return ABI;
    };
    let Some((grid, n)) = job.grid() else {
        return ABI;
    };
    let p = unsafe { &*job.settings };
    let area = unsafe { read_col(job.controls, n, 0) };
    let cover = unsafe { read_col(job.controls, n, 1) };
    let height = unsafe { read_col(job.height, n, 0) };
    let hop_tail = unsafe { read_col(job.wind, n, 3) };
    let sx = unsafe { read_col(job.scratch, n, 0) };
    let sz = unsafe { read_col(job.scratch, n, 1) };
    let vx = unsafe { read_col(job.scratch, n, 2) };
    let vz = unsafe { read_col(job.scratch, n, 3) };
    let buffer = unsafe { write_col(job.scratch, n, 6) };
    let out = unsafe { write_col(job.scratch, n, 7) };
    let donor = unsafe { write_col(job.scratch, n, 8) };
    let mass = unsafe { write_col(job.mass, n, 0) };
    let mobile = unsafe { write_col(job.mobile, n, 0) };
    let bed_delta = unsafe { write_col(job.bed_delta, n, 0) };
    let budget = unsafe { write_col(job.budget, 2, 0) };
    let dt = job.sub_dt;

    if !grid.active_faces(n, |i, j, east, face| {
        let v = if east { vx } else { vz };
        let speed = 0.5 * (word(v, i) + word(v, j));
        let from = if speed >= 0.0 { i } else { j };
        let amount = word_mut(donor, from);
        *amount += speed.abs() * face * dt * word(mass, from);
        amount.is_finite()
    }) {
        return RANGE;
    }
    for i in 0..n {
        let scale = if word(donor, i) > word(buffer, i) {
            word(buffer, i) / word(donor, i)
        } else {
            1.0
        };
        *word_mut(donor, i) = scale;
        let export = scale * word(out, i);
        *word_mut(buffer, i) -= export;
        *word_mut(budget, 0) += export;
    }
    if !grid.active_faces(n, |i, j, east, face| {
        let v = if east { vx } else { vz };
        let speed = 0.5 * (word(v, i) + word(v, j));
        let (from, to) = if speed >= 0.0 { (i, j) } else { (j, i) };
        let moved = speed.abs() * face * dt * word(mass, from) * word(donor, from);
        *word_mut(buffer, from) -= moved;
        *word_mut(buffer, to) += moved;
        word(buffer, from).is_finite() && word(buffer, to).is_finite()
    }) {
        return RANGE;
    }
    for i in 0..n {
        let value = word(buffer, i) / word(area, i);
        if !value.is_finite() {
            return RANGE;
        }
        *word_mut(mass, i) = value.max(0.0);
    }
    if p.ripple_rate > 0.0 {
        buffer.fill(0.0);
        for i in 0..n {
            let (vx, vz) = (word(vx, i), word(vz, i));
            let crossing = (vx.abs() / grid.dx).max(vz.abs() / grid.dz);
            let ejected = if crossing > 0.0 {
                let slope = (vx * word(sx, i) + vz * word(sz, i)) / p.grain_speed;
                let raw_impacts = 1.0 + p.ripple_cotangent * slope;
                if !raw_impacts.is_finite() {
                    return RANGE;
                }
                let impacts = raw_impacts.max(0.0);
                let proposed =
                    dt * p.ripple_rate * word(mass, i) * impacts * word(area, i) * word(cover, i);
                if !proposed.is_finite() {
                    return RANGE;
                }
                proposed.min(word(mobile, i))
            } else {
                0.0
            };
            *word_mut(out, i) = ejected;
            if ejected > 0.0 {
                let delta = (vx / (grid.dx * crossing), vz / (grid.dz * crossing));
                let half = word(hop_tail, i);
                if !(delta.0.is_finite()
                    && delta.1.is_finite()
                    && (delta.0 != 0.0 || delta.1 != 0.0)
                    && (0.0..=1.0).contains(&half))
                {
                    return RANGE;
                }
                *word_mut(budget, 0) += grid.hop(buffer, i, delta, half, ejected);
            }
        }
        for i in 0..n {
            let moved = word(buffer, i) - word(out, i);
            *word_mut(mobile, i) += moved;
            *word_mut(bed_delta, i) += moved / (p.bulk_density * word(area, i));
            if !word(mobile, i).is_finite() || !word(bed_delta, i).is_finite() {
                return RANGE;
            }
        }
    }
    if p.avalanche_time > 0.0
        && !grid.active_faces(n, |i, j, east, _| {
            let difference =
                (word(height, i) - word(height, j)) + (word(bed_delta, i) - word(bed_delta, j));
            let (up, down) = if difference >= 0.0 { (i, j) } else { (j, i) };
            let distance = if east { grid.dx } else { grid.dz };
            let above_repose = difference.abs() - p.repose * distance;
            if !above_repose.is_finite() {
                return false;
            }
            let excess = above_repose.max(0.0);
            let reduction = excess * dt / (p.avalanche_time + dt);
            let proposed =
                reduction * p.bulk_density / (1.0 / word(area, up) + 1.0 / word(area, down));
            if !proposed.is_finite() {
                return false;
            }
            let mass = proposed.min(word(mobile, up));
            *word_mut(mobile, up) -= mass;
            *word_mut(mobile, down) += mass;
            *word_mut(bed_delta, up) -= mass / (p.bulk_density * word(area, up));
            *word_mut(bed_delta, down) += mass / (p.bulk_density * word(area, down));
            word(mobile, up).is_finite()
                && word(mobile, down).is_finite()
                && word(bed_delta, up).is_finite()
                && word(bed_delta, down).is_finite()
        })
    {
        return RANGE;
    }
    if !word(budget, 0).is_finite() {
        return RANGE;
    }
    0
}

unsafe fn publish(job: &Job, n: usize, lo: usize, hi: usize) -> bool {
    let p = unsafe { &*job.settings };
    let area = unsafe { read_col(job.controls, n, 0) };
    let vx = unsafe { read_col(job.scratch, n, 2) };
    let vz = unsafe { read_col(job.scratch, n, 3) };
    let tau = unsafe { read_col(job.scratch, n, 4) };
    let dust_mass = unsafe { output(job.scratch, n, 7, lo, hi) };
    let mass = unsafe { read_col(job.mass, n, 0) };
    let dust = unsafe { output(job.dust, n, 0, lo, hi) };
    let motion = unsafe { output(job.motion, n, 0, 3 * lo, 3 * hi) };
    let drag = unsafe { output(job.drag, n, 0, 2 * lo, 2 * hi) };
    let mass_to_shear = p.gravity / (2.0 * p.restitution);
    for i in lo..hi {
        let row = i - lo;
        let moving = word(mass, i);
        let grain_stress = moving * mass_to_shear;
        let stress = grain_stress.min(word(tau, i)) / p.grain_speed;
        let wind_x = -stress * word(vx, i);
        let wind_z = -stress * word(vz, i);
        let deposited = word(dust, row);
        let rate = deposited / (word(area, i) * job.world_dt);
        if !grain_stress.is_finite()
            || !wind_x.is_finite()
            || !wind_z.is_finite()
            || !rate.is_finite()
        {
            return false;
        }
        *word_mut(motion, 3 * row) = moving;
        *word_mut(motion, 3 * row + 1) = word(vx, i);
        *word_mut(motion, 3 * row + 2) = word(vz, i);
        *word_mut(drag, 2 * row) = wind_x;
        *word_mut(drag, 2 * row + 1) = wind_z;
        *word_mut(dust_mass, row) = deposited;
        *word_mut(dust, row) = rate;
    }
    true
}

#[unsafe(no_mangle)]
unsafe extern "C" fn aeolian_thread_finish(job: *const Job) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return ABI;
    };
    let Some((_, n)) = job.grid() else { return ABI };
    let dust_mass = unsafe { read_col(job.scratch, n, 7) };
    let budget = unsafe { &mut *job.budget.add(1) };
    for &emitted in dust_mass {
        *budget += emitted;
    }
    if !budget.is_finite() {
        return RANGE;
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn aeolian_step(job: *mut Job) -> i32 {
    for stage in [0, 1] {
        let status = unsafe { aeolian_thread_phase(job, stage, 0, 1) };
        if status != 0 {
            return status;
        }
    }
    let status = unsafe { aeolian_thread_plan(job, 1) };
    if status != 0 {
        return status;
    }
    for _ in 0..unsafe { (*job).substeps } {
        let status = unsafe { aeolian_thread_phase(job, 2, 0, 1) };
        if status != 0 {
            return status;
        }
        let status = unsafe { aeolian_thread_route(job) };
        if status != 0 {
            return status;
        }
    }
    let status = unsafe { aeolian_thread_phase(job, 3, 0, 1) };
    if status != 0 {
        return status;
    }
    unsafe { aeolian_thread_finish(job) }
}
