#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{f64x2_mul, f64x2_splat, v128, v128_load, v128_store};
use core::num::NonZeroUsize;
use core::ops::{Deref, DerefMut, Index, IndexMut};
use core::slice::SliceIndex;
use margoengine_physics_kernel_common::pinned::exp;

mod layers;
mod publication;

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
    core::arch::wasm32::unreachable()
}

// Trap a forged range directly, without the formatting data of Rust's standard indexing panic.
#[repr(transparent)]
struct Words([f64]);
impl Words {
    fn read(slice: &[f64]) -> &Self {
        unsafe { &*(slice as *const [f64] as *const Self) }
    }
    fn write(slice: &mut [f64]) -> &mut Self {
        unsafe { &mut *(slice as *mut [f64] as *mut Self) }
    }
}
impl Deref for Words {
    type Target = [f64];
    fn deref(&self) -> &[f64] {
        &self.0
    }
}
impl DerefMut for Words {
    fn deref_mut(&mut self) -> &mut [f64] {
        &mut self.0
    }
}
impl<I: SliceIndex<[f64]>> Index<I> for Words {
    type Output = I::Output;
    fn index(&self, index: I) -> &Self::Output {
        self.0
            .get(index)
            .unwrap_or_else(|| core::arch::wasm32::unreachable())
    }
}
impl<I: SliceIndex<[f64]>> IndexMut<I> for Words {
    fn index_mut(&mut self, index: I) -> &mut Self::Output {
        self.0
            .get_mut(index)
            .unwrap_or_else(|| core::arch::wasm32::unreachable())
    }
}

#[derive(Clone, Copy)]
struct Grid {
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
}

impl Grid {
    fn neighbours(self, i: usize) -> (usize, usize, usize, usize) {
        let width = NonZeroUsize::new(self.nx).unwrap_or_else(|| core::arch::wasm32::unreachable());
        let x = i % width.get();
        let z = i / width.get();
        let east = z * self.nx + ((x + 1) & (self.nx - 1));
        let west = z * self.nx + (x.wrapping_sub(1) & (self.nx - 1));
        let north = ((z + 1) & (self.nz - 1)) * self.nx + x;
        let south = (z.wrapping_sub(1) & (self.nz - 1)) * self.nx + x;
        (east, west, north, south)
    }

    fn transform(self, values: &mut [f64], table: &[f64], inverse: bool) {
        for z in 0..self.nz {
            line_fft(values, z * self.nx, self.nx, 1, table, inverse);
        }
        for x in 0..self.nx {
            line_fft(values, x, self.nz, self.nx, table, inverse);
        }
    }
}

fn line_fft(
    values: &mut [f64],
    offset: usize,
    n: usize,
    stride: usize,
    table: &[f64],
    inverse: bool,
) {
    let values = Words::write(values);
    let table = Words::read(table);
    let table_n = table.len() / 2;
    let shift = usize::BITS - n.trailing_zeros();
    for i in 0..n {
        let j = i.reverse_bits() >> shift;
        if i < j {
            let a = 2 * (offset + stride * i);
            let b = 2 * (offset + stride * j);
            let re = values[a];
            let im = values[a + 1];
            values[a] = values[b];
            values[a + 1] = values[b + 1];
            values[b] = re;
            values[b + 1] = im;
        }
    }
    let sign = if inverse { -1.0 } else { 1.0 };
    let mut width = 2;
    while width <= n {
        let half = width / 2;
        let divisor = NonZeroUsize::new(width).unwrap_or_else(|| core::arch::wasm32::unreachable());
        let twiddle_stride = table_n / divisor.get();
        let mut origin = 0;
        while origin < n {
            for j in 0..half {
                let a = 2 * (offset + stride * (origin + j));
                let b = a + 2 * stride * half;
                let w = 2 * j * twiddle_stride;
                let (c, s) = (table[w], sign * table[w + 1]);
                let re = values[b] * c - values[b + 1] * s;
                let im = values[b] * s + values[b + 1] * c;
                values[b] = values[a] - re;
                values[b + 1] = values[a + 1] - im;
                values[a] += re;
                values[a + 1] += im;
            }
            origin += width;
        }
        width *= 2;
    }
}

fn forward(grid: Grid, q: &[f64], fft: &mut [f64], table: &[f64]) {
    for (pair, &value) in fft.chunks_exact_mut(2).zip(q) {
        pair[0] = value;
        pair[1] = 0.0;
    }
    grid.transform(fft, table, false);
}

fn backward(grid: Grid, out: &mut [f64], fft: &mut [f64], table: &[f64]) {
    grid.transform(fft, table, true);
    let scale = 1.0 / out.len() as f64;
    for (value, pair) in out.iter_mut().zip(fft.chunks_exact(2)) {
        *value = scale * pair[0];
    }
}

fn poisson(
    grid: Grid,
    source: &[f64],
    result: &mut [f64],
    fft: &mut [f64],
    table: &[f64],
    inv_laplace: &[f64],
) {
    forward(grid, source, fft, table);
    for (pair, &weight) in fft.chunks_exact_mut(2).zip(inv_laplace) {
        let ptr = pair.as_mut_ptr().cast::<v128>();
        unsafe { v128_store(ptr, f64x2_mul(v128_load(ptr), f64x2_splat(weight))) };
    }
    backward(grid, result, fft, table);
}

fn beta_rotation(
    grid: Grid,
    vort: &mut [f64],
    fft: &mut [f64],
    table: &[f64],
    frequencies: &[f64],
    dt_beta: f64,
) {
    if dt_beta == 0.0 {
        return;
    }
    forward(grid, vort, fft, table);
    for (pair, &frequency) in fft.chunks_exact_mut(2).zip(frequencies) {
        let a = 0.5 * dt_beta * frequency;
        let d = 1.0 + a * a;
        let re = (1.0 - a * a) / d;
        let im = -2.0 * a / d;
        let left = pair[0] * re - pair[1] * im;
        pair[1] = pair[0] * im + pair[1] * re;
        pair[0] = left;
    }
    backward(grid, vort, fft, table);
}

/// Vertically weighted lifting induced by the specified regional mean wind. Mode multipliers are host-owned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn filter_orography(
    geometry: *mut f64,
    modes: *const f64,
    fft: *mut f64,
    twiddles: *const f64,
    nx: usize,
    nz: usize,
) {
    let count = nx * nz;
    let grid = Grid {
        nx,
        nz,
        dx: 1.0,
        dz: 1.0,
    };
    let geometry = Words::write(unsafe { core::slice::from_raw_parts_mut(geometry, 3 * count) });
    let fft = unsafe { core::slice::from_raw_parts_mut(fft, 2 * count) };
    let table = unsafe { core::slice::from_raw_parts(twiddles, 2 * nx.max(nz)) };
    let transfer = unsafe { core::slice::from_raw_parts(modes.add(2 * count), 2 * count) };
    forward(grid, &geometry[..count], fft, table);
    for (pair, effect) in fft.chunks_exact_mut(2).zip(transfer.chunks_exact(2)) {
        let re = pair[0] * effect[0] - pair[1] * effect[1];
        pair[1] = pair[0] * effect[1] + pair[1] * effect[0];
        pair[0] = re;
    }
    backward(grid, &mut geometry[2 * count..], fft, table);
}

fn flow(grid: Grid, psi: &[f64], east: &mut [f64], north: &mut [f64], mean: [f64; 2]) -> f64 {
    let psi = Words::read(psi);
    let east = Words::write(east);
    let north = Words::write(north);
    let mut max_u: f64 = 0.0;
    let mut max_v: f64 = 0.0;
    for i in 0..psi.len() {
        let (e, w, n, s) = grid.neighbours(i);
        let (_, _, ne, se) = grid.neighbours(e);
        let (en, wn, _, _) = grid.neighbours(n);
        east[i] = mean[0] - (psi[n] + psi[ne] - psi[s] - psi[se]) / (4.0 * grid.dz);
        north[i] = mean[1] + (psi[e] + psi[en] - psi[w] - psi[wn]) / (4.0 * grid.dx);
        max_u = max_u.max(east[i].abs());
        max_v = max_v.max(north[i].abs());
    }
    max_u / grid.dx + max_v / grid.dz
}

fn slope(west: f64, center: f64, east: f64) -> f64 {
    let left = center - west;
    let right = east - center;
    if left.signum() != right.signum() {
        0.0
    } else {
        left.signum()
            * (0.5 * (left + right).abs())
                .min(2.0 * left.abs())
                .min(2.0 * right.abs())
    }
}

fn face_flux(
    q: &[f64],
    a: usize,
    b: usize,
    outer_a: usize,
    outer_b: usize,
    speed: f64,
    high: bool,
) -> f64 {
    let q = Words::read(q);
    let donor = if speed >= 0.0 { a } else { b };
    if !high {
        return speed * q[donor];
    }
    let value = if speed >= 0.0 {
        q[a] + 0.5 * slope(q[outer_a], q[a], q[b])
    } else {
        q[b] - 0.5 * slope(q[a], q[b], q[outer_b])
    };
    speed * value
}

fn transport(
    grid: Grid,
    q: &[f64],
    out: &mut [f64],
    east: &[f64],
    north: &[f64],
    dt: f64,
    high: bool,
) {
    let q = Words::read(q);
    let east = Words::read(east);
    let north = Words::read(north);
    for (i, value) in out.iter_mut().enumerate() {
        let (e, w, n, s) = grid.neighbours(i);
        let (ee, _, _, _) = grid.neighbours(e);
        let (_, ww, _, _) = grid.neighbours(w);
        let (_, _, nn, _) = grid.neighbours(n);
        let (_, _, _, ss) = grid.neighbours(s);
        let fx =
            face_flux(q, i, e, w, ee, east[i], high) - face_flux(q, w, i, ww, e, east[w], high);
        let fz =
            face_flux(q, i, n, s, nn, north[i], high) - face_flux(q, s, i, ss, n, north[s], high);
        *value = q[i] - dt * (fx / grid.dx + fz / grid.dz);
    }
}

struct Parameters {
    coriolis: f64,
    beta: f64,
    mean: [f64; 2],
    convert: f64,
    fallout: f64,
    lift_sensitivity: f64,
    lapse: f64,
    base_pressure: f64,
    density: f64,
    courant: f64,
    high: bool,
    layered: bool,
}

fn uplift(
    grid: Grid,
    at: usize,
    height: &Words,
    mean_lift: &Words,
    u: f64,
    v: f64,
    p: &Parameters,
) -> f64 {
    let (e, w, n, s) = grid.neighbours(at);
    let mean = if p.high { p.mean } else { [0.0, 0.0] };
    (u - mean[0]) * (height[e] - height[w]) / (2.0 * grid.dx)
        + (v - mean[1]) * (height[n] - height[s]) / (2.0 * grid.dz)
        + mean_lift[at]
}

fn exchange_vapour(vapour: f64, cloud: f64, temperature: f64, lift: f64, p: &Parameters) -> f64 {
    if lift == 0.0 || p.lift_sensitivity == 0.0 || (p.lift_sensitivity < 0.0 && p.lapse == 0.0) {
        return 0.0;
    }
    const LATENT_HEAT: f64 = 2.5e6;
    const VAPOUR_GAS: f64 = 461.5;
    const AIR_GAS: f64 = 287.05;
    const GRAVITY: f64 = 9.80665;
    const GAS_RATIO: f64 = AIR_GAS / VAPOUR_GAS;
    let pressure = 611.2 * exp((LATENT_HEAT / VAPOUR_GAS) * (1.0 / 273.15 - 1.0 / temperature));
    let lapse = if p.lapse > 0.0 { p.lapse } else { 0.0065 };
    // Smith–Barstad Appendix A: integral of the exponentially decreasing saturated vapour density.
    let capacity = pressure * temperature / (LATENT_HEAT * lapse);
    let sensitivity = if p.lift_sensitivity >= 0.0 {
        p.lift_sensitivity
    } else {
        // Multiply numerator and denominator of the moist lapse by the dry partial pressure.
        let dry = (p.base_pressure - pressure).max(0.0);
        let latent_ratio = LATENT_HEAT * GAS_RATIO / (AIR_GAS * temperature);
        let moist_lapse = GRAVITY * (dry + latent_ratio * pressure)
            / (1004.0 * dry + latent_ratio * latent_ratio * AIR_GAS * pressure);
        pressure * moist_lapse / (VAPOUR_GAS * temperature * lapse)
    };
    let exchange = lift * sensitivity;
    let displaced_capacity = (capacity - exchange).max(0.0);
    let excess = vapour - displaced_capacity;
    if exchange > 0.0 {
        exchange.min(excess.max(0.0)).min(vapour)
    } else {
        exchange.max(excess.min(0.0)).max(-cloud)
    }
}

fn microphysics(dt: f64, tc: f64, tf: f64) -> (f64, f64, f64) {
    let ec = exp(-dt / tc);
    let ef = exp(-dt / tf);
    let x = dt * (1.0 / tf - 1.0 / tc);
    let transition = if x.abs() < 1.0e-4 {
        let phi = 1.0 + x * (0.5 + x * (1.0 / 6.0 + x / 24.0));
        ef * (dt / tc) * phi
    } else {
        (ec - ef) / (tc * (1.0 / tf - 1.0 / tc))
    };
    (ec, ef, transition)
}

/// The host owns every input and scratch range in the imported arena. All arrays are disjoint.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn advance_synoptic(
    state: *mut f64,
    diagnostics: *mut f64,
    work: *mut f64,
    geometry: *const f64,
    modes: *const f64,
    twiddles: *const f64,
    input: *const f64,
) -> f64 {
    let input = unsafe { Words::read(core::slice::from_raw_parts(input, 16)) };
    let grid = Grid {
        nx: input[0] as usize,
        nz: input[1] as usize,
        dx: input[2],
        dz: input[3],
    };
    let p = Parameters {
        mean: [input[5], input[6]],
        coriolis: input[7],
        beta: input[8],
        convert: input[9],
        fallout: input[10],
        lift_sensitivity: input[11],
        lapse: input[12],
        base_pressure: input[13],
        density: input[14],
        courant: 0.4,
        high: input[15] != 0.0,
        layered: input[15] == 2.0,
    };
    let count = grid.nx * grid.nz;
    let (height, geometry) = unsafe { core::slice::from_raw_parts(geometry, 3 * count) }
        .split_at_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (evaporation, mean_lift) = geometry
        .split_at_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (lambda, beta_freq) = unsafe { core::slice::from_raw_parts(modes, 2 * count) }
        .split_at_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let table = unsafe { core::slice::from_raw_parts(twiddles, 2 * grid.nx.max(grid.nz)) };
    let state = unsafe { core::slice::from_raw_parts_mut(state, 5 * count) };
    let diag = unsafe { core::slice::from_raw_parts_mut(diagnostics, 8 * count + 3) };
    let (psi, diag) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (u, diag) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (v, diag) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (pressure, diag) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (lift, diag) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (rain, diag) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (temperature, diag) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (cooled, ledger) = diag
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let work = unsafe { core::slice::from_raw_parts_mut(work, 7 * count) };
    let (fft, work) = work
        .split_at_mut_checked(2 * count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (east, work) = work
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (north, work) = work
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (first, work) = work
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (second, balances) = work
        .split_at_mut_checked(count)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let height = Words::read(height);
    let evaporation = Words::read(evaporation);
    let mean_lift = Words::read(mean_lift);
    let state = Words::write(state);
    let psi = Words::write(psi);
    let u = Words::write(u);
    let v = Words::write(v);
    let lift = Words::write(lift);
    let rain = Words::write(rain);
    let temperature = Words::write(temperature);
    let cooled = Words::write(cooled);
    let ledger = Words::write(ledger);
    let east = Words::write(east);
    let north = Words::write(north);
    let balances = Words::write(balances);
    let duration = input[4];
    let mut remaining = duration;
    let mut steps = 0.0;
    rain.fill(0.0);
    loop {
        poisson(grid, &state[..count], psi, fft, table, lambda);
        let rate = flow(grid, psi, east, north, p.mean);
        if remaining <= 0.0 {
            break;
        }
        let dt = remaining.min(p.courant / rate);
        if !dt.is_finite() || dt <= 0.0 || remaining - dt >= remaining {
            return f64::NAN;
        }
        for column in usize::from(p.layered)..5 {
            let q = &mut state[column * count..(column + 1) * count];
            transport(grid, q, first, east, north, dt, p.high);
            if p.high {
                transport(grid, first, second, east, north, dt, true);
                for (q, &b) in q.iter_mut().zip(second.iter()) {
                    *q = 0.5 * (*q + b);
                }
            } else {
                for (q, &value) in q.iter_mut().zip(first.iter()) {
                    *q = value;
                }
            }
        }
        if !p.layered {
            beta_rotation(
                grid,
                &mut state[..count],
                fft,
                table,
                beta_freq,
                dt * p.beta,
            );
        }
        let (ec, ef, transition) = microphysics(dt, p.convert, p.fallout);
        for i in 0..count {
            let (_, w, _, s) = grid.neighbours(i);
            let ux = 0.5 * (east[i] + east[w]);
            let vz = 0.5 * (north[i] + north[s]);
            let vertical = uplift(grid, i, height, mean_lift, ux, vz, &p);
            let added = dt * evaporation[i];
            let vapour = state[count + i] + added;
            let cloud = state[2 * count + i];
            let drops = state[3 * count + i];
            let local_temperature = state[4 * count + i] - p.lapse * height[i];
            let source = exchange_vapour(vapour, cloud, local_temperature, vertical * dt, &p);
            let condensed = cloud + source;
            let next_cloud = condensed * ec;
            let next_drops = drops * ef + condensed * transition;
            let fallout = (drops + condensed - next_cloud - next_drops).max(0.0);
            state[count + i] = vapour - source;
            state[2 * count + i] = next_cloud;
            state[3 * count + i] = next_drops;
            rain[i] += fallout;
            ledger[0] += added;
            ledger[1] += fallout;
        }
        remaining -= dt;
        steps += 1.0;
    }
    for i in 0..count {
        let (_, w, _, s) = grid.neighbours(i);
        u[i] = 0.5 * (east[i] + east[w]);
        v[i] = 0.5 * (north[i] + north[s]);
        lift[i] = uplift(grid, i, height, mean_lift, u[i], v[i], &p);
        temperature[i] = state[4 * count + i];
        cooled[i] = temperature[i] - p.lapse * height[i];
        if duration > 0.0 {
            rain[i] /= duration;
        }
    }
    if p.high {
        // Horizontal divergence of the rotating incompressible momentum equation, including curved-flow acceleration.
        for i in 0..count {
            let (e, w, n, s) = grid.neighbours(i);
            let det = ((u[e] - u[w]) * (v[n] - v[s]) - (u[n] - u[s]) * (v[e] - v[w]))
                / (4.0 * grid.dx * grid.dz);
            balances[i] = p.coriolis * state[i] + 2.0 * det - p.beta * (u[i] - p.mean[0]);
        }
        poisson(grid, balances, pressure, fft, table, lambda);
        for value in pressure {
            *value = p.base_pressure + p.density * *value;
        }
    } else {
        for (i, value) in pressure.iter_mut().enumerate() {
            *value = p.base_pressure + p.density * p.coriolis * psi[i];
        }
    }
    ledger[2] += steps;
    steps
}
