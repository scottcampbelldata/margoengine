use crate::{
    CP, Column, Forcing, Grid, K0, LV, Local, Output, STEFAN, Settings, at, at_mut, exp, fourth,
    length, resolve, sqrt,
};
use core::arch::wasm32::{f64x2, f64x2_extract_lane, f64x2_mul, f64x2_sqrt};
use core::slice;

const RANGE: i32 = 1;
const CFL: i32 = 2;
const ABI: i32 = 3;
const RECEIPT: usize = 7;
type CellWork = [f64; 3];

#[repr(C)]
struct Job {
    state: *mut Column,
    next: *mut Column,
    local: *mut Local,
    forcing: *const Forcing,
    settings: *const Settings,
    departure: *mut f64,
    settling: *mut f64,
    ledger: *mut f64,
    output: *mut Output,
    optical: *mut [f32; 4],
    cell_work: *mut CellWork,
    receipt: *mut [f64; RECEIPT],
    width: usize,
    height: usize,
    open: u32,
    reserved: u32,
    remaining: f64,
    world_dt: f64,
    sub: f64,
}

const _: () = assert!(core::mem::size_of::<Job>() == 88);

impl Job {
    fn count(&self) -> Option<usize> {
        self.width
            .checked_mul(self.height)
            .filter(|&count| count > 0)
    }

    fn grid(&self, settings: &Settings) -> Grid {
        Grid {
            width: self.width,
            height: self.height,
            open: self.open,
            dx: settings.dx,
            dz: settings.dz,
        }
    }
}

fn valid_column(c: Column) -> bool {
    c.h.is_finite()
        && c.px.is_finite()
        && c.pz.is_finite()
        && c.energy.is_finite()
        && c.water.is_finite()
}

#[unsafe(no_mangle)]
unsafe extern "C" fn fog_thread_begin(job: *mut Job, parts: usize) -> i32 {
    let Some(job) = (unsafe { job.as_mut() }) else {
        return ABI;
    };
    let Some(n) = job.count() else { return ABI };
    if parts == 0
        || !job.remaining.is_finite()
        || job.remaining < 0.0
        || !job.world_dt.is_finite()
        || job.world_dt <= 0.0
    {
        return ABI;
    }
    let cfg = unsafe { &*job.settings };
    let area = cfg.dx * cfg.dz;
    if !area.is_finite() || area <= 0.0 || !cfg.air.is_finite() || cfg.air <= 0.0 {
        return RANGE;
    }
    unsafe { slice::from_raw_parts_mut(job.settling, n) }.fill(0.0);
    unsafe { slice::from_raw_parts_mut(job.receipt, parts) }.fill([0.0; RECEIPT]);
    job.sub = 0.0;
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn fog_thread_phase(
    job: *const Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return ABI;
    };
    let Some(n) = job.count() else { return ABI };
    if part >= parts || stage > 3 {
        return ABI;
    }
    let lo = ((part as u64 * n as u64) / parts as u64) as usize;
    let hi = (((part as u64 + 1) * n as u64) / parts as u64) as usize;
    let cfg = unsafe { &*job.settings };
    let forcing = unsafe { slice::from_raw_parts(job.forcing, n) };
    let grid = job.grid(cfg);
    let receipt = unsafe { &mut *job.receipt.add(part) };
    let accepted = match stage {
        0 => unsafe { prepare(job, cfg, &grid, forcing, lo, hi, receipt) },
        1 => unsafe { sources(job, cfg, &grid, forcing, lo, hi) },
        2 => unsafe { settle(job, cfg, forcing, lo, hi) },
        _ => unsafe { publish(job, cfg, forcing, lo, hi) },
    };
    if !accepted {
        return RANGE;
    }
    *at_mut(receipt, stage as usize + 2) += (hi - lo) as f64;
    0
}

unsafe fn prepare(
    job: &Job,
    cfg: &Settings,
    grid: &Grid,
    forcing: &[Forcing],
    lo: usize,
    hi: usize,
    receipt: &mut [f64; RECEIPT],
) -> bool {
    let columns = unsafe { slice::from_raw_parts(job.state, forcing.len()) };
    let local = unsafe { slice::from_raw_parts_mut(job.local.add(lo), hi - lo) };
    let mut crossing: f64 = 0.0;
    let mut change: f64 = 0.0;
    let mut increase = |i: usize, cell: Local, column: Column, wave: f64| {
        let (vx, vz) = column.velocity();
        let travel = (vx.abs() + wave) / cfg.dx + (vz.abs() + wave) / cfg.dz;
        let (gx, gz) = grid.slope(i, columns, forcing);
        let acceleration = cell.reduced_gravity * (gx.abs() / cfg.dx + gz.abs() / cfg.dz);
        if !travel.is_finite() || !acceleration.is_finite() {
            return false;
        }
        crossing = crossing.max(travel);
        change = change.max(acceleration);
        true
    };
    for (pair, rows) in local.chunks_exact_mut(2).enumerate() {
        let i = lo + 2 * pair;
        let (a, b) = (*at(columns, i), *at(columns, i + 1));
        let Some(ca) = resolve(a, at(forcing, i), cfg) else {
            return false;
        };
        let Some(cb) = resolve(b, at(forcing, i + 1), cfg) else {
            return false;
        };
        let waves = f64x2_sqrt(f64x2_mul(
            f64x2(ca.reduced_gravity, cb.reduced_gravity),
            f64x2(a.h, b.h),
        ));
        if !increase(i, ca, a, f64x2_extract_lane::<0>(waves))
            || !increase(i + 1, cb, b, f64x2_extract_lane::<1>(waves))
        {
            return false;
        }
        *at_mut(rows, 0) = ca;
        *at_mut(rows, 1) = cb;
        receipt[6] += 1.0;
    }
    if local.len() % 2 != 0 {
        let i = hi - 1;
        let column = *at(columns, i);
        let Some(cell) = resolve(column, at(forcing, i), cfg) else {
            return false;
        };
        if !increase(i, cell, column, sqrt(cell.reduced_gravity * column.h)) {
            return false;
        }
        *at_mut(local, i - lo) = cell;
    }
    receipt[0] = crossing;
    receipt[1] = change;
    true
}

#[unsafe(no_mangle)]
unsafe extern "C" fn fog_thread_plan(job: *mut Job, parts: usize) -> i32 {
    let Some(job) = (unsafe { job.as_mut() }) else {
        return ABI;
    };
    if parts == 0 || !(job.remaining > 0.0) {
        return ABI;
    }
    let mut crossing: f64 = 0.0;
    let mut change: f64 = 0.0;
    for receipt in unsafe { slice::from_raw_parts(job.receipt, parts) } {
        crossing = crossing.max(receipt[0]);
        change = change.max(receipt[1]);
    }
    let cfl = crossing + sqrt(change);
    let sub = if cfl > 0.0 {
        job.remaining.min(0.45 / cfl)
    } else {
        job.remaining
    };
    let remaining = job.remaining - sub;
    if !cfl.is_finite() || !(sub > 0.0 && remaining < job.remaining) {
        return CFL;
    }
    job.sub = sub;
    job.remaining = remaining;
    0
}

unsafe fn sources(
    job: &Job,
    cfg: &Settings,
    grid: &Grid,
    forcing: &[Forcing],
    lo: usize,
    hi: usize,
) -> bool {
    let columns = unsafe { slice::from_raw_parts(job.state, forcing.len()) };
    let local = unsafe { slice::from_raw_parts(job.local, forcing.len()) };
    let next = unsafe { slice::from_raw_parts_mut(job.next.add(lo), hi - lo) };
    let departure = unsafe { slice::from_raw_parts_mut(job.departure.add(lo), hi - lo) };
    let cell_work = unsafe { slice::from_raw_parts_mut(job.cell_work.add(lo), hi - lo) };
    let sub = job.sub;
    let area = cfg.dx * cfg.dz;
    for (row, result) in next.iter_mut().enumerate() {
        let i = lo + row;
        let (gx, gz) = grid.slope(i, columns, forcing);
        let f = at(forcing, i);
        let a = *at(local, i);
        let mut c = *at(columns, i);
        if c.h > 0.0 {
            let old_depth = c.h;
            let (ux, uz) = c.velocity();
            let relative = length(ux - f.wind_x, uz - f.wind_z);
            let shear = relative * relative;
            let entrained = if shear > 0.0 {
                sub * cfg.entrainment * relative * shear / (shear + a.reduced_gravity * c.h)
            } else {
                0.0
            };
            let outside = Column {
                h: entrained,
                px: entrained * f.wind_x,
                pz: entrained * f.wind_z,
                energy: entrained
                    * (CP * (f.atmospheric_temperature - K0) + LV * f.background_water),
                water: entrained * f.background_water,
            };
            c.add(outside);
            c.px -= sub * c.h * a.reduced_gravity * gx;
            c.pz -= sub * c.h * a.reduced_gravity * gz;
            let (px, pz) = (c.px - c.h * f.wind_x, c.pz - c.h * f.wind_z);
            let resistance = 1.0 + sub * cfg.drag * length(px, pz) / (c.h * c.h);
            if !relative.is_finite() || !resistance.is_finite() {
                return false;
            }
            c.px = c.h * f.wind_x + px / resistance;
            c.pz = c.h * f.wind_z + pz / resistance;
            // Stephens (1978) grey liquid-cloud mass absorption; the supplied dry term can be combined in opacity.
            // Old depth and liquid fraction refer to the same pre-entrainment phase equilibrium.
            let emissivity =
                if cfg.liquid_absorption > 0.0 && a.liquid > 0.0 && cfg.emissivity < 1.0 {
                    let depth = cfg.liquid_absorption * (cfg.air * (old_depth * a.liquid));
                    1.0 - (1.0 - cfg.emissivity) * exp(-depth)
                } else {
                    cfg.emissivity
                };
            let radiation = emissivity * STEFAN * (fourth(f.sky) - fourth(a.temperature));
            let raw_surface_water = sub * f.moisture / cfg.air;
            if !raw_surface_water.is_finite() {
                return false;
            }
            let surface_water = raw_surface_water.max(-c.water);
            c.energy += sub * (radiation + f.heat) / cfg.air + LV * surface_water;
            c.water += surface_water;
            *at_mut(cell_work, row) = [
                outside.h * cfg.air * area,
                outside.water * cfg.air * area,
                surface_water * cfg.air * area,
            ];
        }
        let (vx, vz) = c.velocity();
        let out = sub * grid.outward(i, vx, vz) * c.h;
        if !valid_column(c) || !out.is_finite() {
            return false;
        }
        *result = c;
        *at_mut(departure, row) = out;
    }
    true
}

#[unsafe(no_mangle)]
unsafe extern "C" fn fog_thread_route(job: *const Job) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return ABI;
    };
    let Some(n) = job.count() else { return ABI };
    let cfg = unsafe { &*job.settings };
    let columns = unsafe { slice::from_raw_parts_mut(job.state, n) };
    let next = unsafe { slice::from_raw_parts(job.next, n) };
    let forcing = unsafe { slice::from_raw_parts(job.forcing, n) };
    let departure = unsafe { slice::from_raw_parts_mut(job.departure, n) };
    let cell_work = unsafe { slice::from_raw_parts(job.cell_work, n) };
    let ledger = unsafe { slice::from_raw_parts_mut(job.ledger, 6) };
    let grid = job.grid(cfg);
    let sub = job.sub;
    let area = cfg.dx * cfg.dz;
    for (i, cell) in columns.iter().enumerate() {
        if cell.h > 0.0 {
            let [air, water, surface] = *at(cell_work, i);
            *at_mut(ledger, 0) += air;
            *at_mut(ledger, 1) += water;
            *at_mut(ledger, 2) += surface;
        }
    }
    if !grid.faces(|a, b, east| {
        let (from, _, rate) = grid.transfer(a, b, east, next, forcing);
        let out = at_mut(departure, from);
        *out += sub * rate;
        out.is_finite()
    }) {
        return RANGE;
    }
    for (i, column) in columns.iter_mut().enumerate() {
        let c = *at(next, i);
        let (ux, uz) = c.velocity();
        let capacity = at_mut(departure, i);
        // All four faces compete for the same donor mass before any transfer is applied.
        let fraction = if c.h > 0.0 {
            1.0 / c.h.max(*capacity)
        } else {
            0.0
        };
        *capacity = fraction;
        let raw_export = sub * grid.outward(i, ux, uz) * c.h * fraction;
        if !raw_export.is_finite() || !fraction.is_finite() {
            return RANGE;
        }
        let export = raw_export.min(1.0);
        *column = c.fraction(1.0 - export);
        *at_mut(ledger, 3) += export * c.h * cfg.air * area;
        *at_mut(ledger, 4) += export * c.water * cfg.air * area;
    }
    if !grid.faces(|a, b, east| {
        let (from, to, rate) = grid.transfer(a, b, east, next, forcing);
        let moving = at(next, from).fraction(sub * rate * *at(departure, from));
        at_mut(columns, from).add(moving.fraction(-1.0));
        at_mut(columns, to).add(moving);
        valid_column(*at(columns, from)) && valid_column(*at(columns, to))
    }) {
        return RANGE;
    }
    if !ledger.iter().all(|entry| entry.is_finite()) {
        return RANGE;
    }
    0
}

unsafe fn settle(job: &Job, cfg: &Settings, forcing: &[Forcing], lo: usize, hi: usize) -> bool {
    let columns = unsafe { slice::from_raw_parts_mut(job.state.add(lo), hi - lo) };
    let settling = unsafe { slice::from_raw_parts_mut(job.settling.add(lo), hi - lo) };
    let cell_work = unsafe { slice::from_raw_parts_mut(job.cell_work.add(lo), hi - lo) };
    let area = cfg.dx * cfg.dz;
    let sub = job.sub;
    for (row, c) in columns.iter_mut().enumerate() {
        if c.h <= 0.0 {
            *c = Column {
                h: 0.0,
                px: 0.0,
                pz: 0.0,
                energy: 0.0,
                water: 0.0,
            };
            continue;
        }
        let f = at(forcing, lo + row);
        let (_, _, droplets) = c.phase(f.pressure, f.atmospheric_temperature);
        let deposited =
            c.h * droplets * (sub * cfg.settling_speed / (c.h + sub * cfg.settling_speed));
        c.water -= deposited;
        let mass = cfg.air * deposited;
        let accumulated = at_mut(settling, row);
        *accumulated += mass;
        if !accumulated.is_finite() || !valid_column(*c) {
            return false;
        }
        at_mut(cell_work, row)[0] = area * mass;
    }
    true
}

#[unsafe(no_mangle)]
unsafe extern "C" fn fog_thread_fold(job: *const Job) -> i32 {
    let Some(job) = (unsafe { job.as_ref() }) else {
        return ABI;
    };
    let Some(n) = job.count() else { return ABI };
    let columns = unsafe { slice::from_raw_parts(job.state, n) };
    let contributions = unsafe { slice::from_raw_parts(job.cell_work, n) };
    let total = unsafe { &mut *job.ledger.add(5) };
    for (i, cell) in columns.iter().enumerate() {
        if cell.h > 0.0 {
            *total += at(contributions, i)[0];
        }
    }
    if !total.is_finite() {
        return RANGE;
    }
    0
}

unsafe fn publish(job: &Job, cfg: &Settings, forcing: &[Forcing], lo: usize, hi: usize) -> bool {
    let columns = unsafe { slice::from_raw_parts(job.state.add(lo), hi - lo) };
    let output = unsafe { slice::from_raw_parts_mut(job.output.add(lo), hi - lo) };
    let optical = unsafe { slice::from_raw_parts_mut(job.optical.add(lo), hi - lo) };
    let settling = unsafe { slice::from_raw_parts(job.settling.add(lo), hi - lo) };
    for (row, c) in columns.iter().copied().enumerate() {
        let f = at(forcing, lo + row);
        let Some(a) = resolve(c, f, cfg) else {
            return false;
        };
        let (ux, uz) = c.velocity();
        let beta = a.liquid * cfg.air * cfg.extinction_per_mass;
        let settle_rate = *at(settling, row) / job.world_dt;
        let ground = f.ground as f32;
        let top = (f.ground + c.h) as f32;
        let extinction = beta as f32;
        if !ground.is_finite()
            || !top.is_finite()
            || !extinction.is_finite()
            || !ux.is_finite()
            || !uz.is_finite()
            || !settle_rate.is_finite()
        {
            return false;
        }
        *at_mut(output, row) = Output {
            surface: f.ground,
            thickness: c.h,
            x_velocity: ux,
            z_velocity: uz,
            temperature: a.temperature,
            vapour: a.vapour,
            liquid: a.liquid,
            extinction: beta,
            settling: settle_rate,
        };
        *at_mut(optical, row) = [ground, top, extinction, 0.0];
    }
    true
}

#[unsafe(no_mangle)]
unsafe extern "C" fn fog_step(job: *mut Job) -> i32 {
    let status = unsafe { fog_thread_begin(job, 1) };
    if status != 0 {
        return status;
    }
    while unsafe { (*job).remaining } > 0.0 {
        for stage in [0, 1, 2] {
            let status = unsafe { fog_thread_phase(job, stage, 0, 1) };
            if status != 0 {
                return status;
            }
            let status = unsafe {
                match stage {
                    0 => fog_thread_plan(job, 1),
                    1 => fog_thread_route(job),
                    _ => fog_thread_fold(job),
                }
            };
            if status != 0 {
                return status;
            }
        }
    }
    unsafe { fog_thread_phase(job, 3, 0, 1) }
}
