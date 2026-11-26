#![no_std]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
};

use margoengine_physics_kernel_common::pinned::{exp, pow};

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

#[repr(C)]
struct Roughness {
    low: f64,
    high: f64,
    start: f64,
    thickness: f64,
    beta: f64,
    exponent: f64,
    exponential: f64,
}

impl Roughness {
    fn stop(&self, depth: f64) -> f64 {
        let normalised = depth / self.thickness;
        let shape = if self.exponential == 0.0 {
            1.0 / (1.0 + normalised)
        } else {
            exp(-normalised)
        };
        self.low + (self.high - self.low) * shape
    }

    fn friction(&self, depth: f64, speed: f64, gravity: f64) -> f64 {
        let stop = self.stop(depth);
        let gap = self.start - self.low;
        if speed == 0.0 {
            return stop + gap;
        }
        let turnover = self.beta * sqrt(gravity * depth);
        if speed >= turnover {
            return self.stop(depth * (turnover / speed));
        }
        stop + gap * (1.0 - pow(speed / turnover, self.exponent))
    }
}

struct Model<'a> {
    gravity: f64,
    dx: f64,
    dz: f64,
    friction: f64,
    turbulence: f64,
    roughness: Option<&'a Roughness>,
    grain_load: f64,
    shaking: Option<&'a [[f64; 2]]>,
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
    transverse_bed_slope: f64,
    transverse_surface_slope: f64,
    shaking: [f64; 2],
) -> f64 {
    if model.gravity == 0.0 {
        return step;
    }
    let support = (1.0 + shaking[1] / model.gravity).max(0.0);
    let horizontal = shaking[0] / model.gravity;
    let driving_step = step * support + if x { width * horizontal } else { 0.0 };
    if model.grain_load == 0.0 || support == 0.0 {
        return driving_step;
    }
    let weight = low.depth + high.depth;
    let time = model.gravity * dt;
    let average_x = (low.discharge_x + high.discharge_x) / weight;
    let average_z = (low.discharge_z + high.discharge_z) / weight;
    let mut friction = model.friction;
    if let Some(roughness) = model.roughness {
        let rise = step / width;
        let (slope_x, slope_z) = if x {
            (rise, transverse_bed_slope)
        } else {
            (transverse_bed_slope, rise)
        };
        let metric = sqrt(1.0 + slope_x * slope_x + slope_z * slope_z);
        let vertical = slope_x * average_x + slope_z * average_z;
        let speed = length(length(average_x, average_z), vertical);
        friction = roughness.friction(0.5 * weight / metric, speed, model.gravity);
    }
    let friction = friction * model.grain_load * support;
    if friction == 0.0 {
        return driving_step;
    }
    let slope_impulse = ((low.depth - high.depth) - driving_step) * (time / width);
    let cross_impulse = -(transverse_surface_slope + if x { 0.0 } else { horizontal }) * time;
    let (trial_x, trial_z) = if x {
        (average_x + slope_impulse, average_z + cross_impulse)
    } else {
        (average_x + cross_impulse, average_z + slope_impulse)
    };
    let normal = if x { trial_x } else { trial_z };
    let limit = friction * time;
    let magnitude = length(trial_x, trial_z);
    if magnitude <= limit {
        // At exact rest this also avoids roundoff in reconstructing a static free surface.
        return low.depth - high.depth + (if x { average_x } else { average_z }) * (width / time);
    }
    driving_step + (normal / magnitude) * friction * width
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
    neighbours: (usize, usize, usize),
    support_columns: (usize, usize),
) {
    let a = unsafe { *state.get_unchecked(left) };
    let b = unsafe { *state.get_unchecked(right) };
    if a.depth == 0.0 && b.depth == 0.0 {
        return;
    }
    let mut bed_cross = 0.0;
    let mut surface_cross = 0.0;
    if model.roughness.is_some() {
        let (before, after, stride) = neighbours;
        let span = (before + after) / stride;
        if span > 0 {
            let cross_width = if x { model.dz } else { model.dx };
            let a_low = unsafe { state.get_unchecked(left - before) };
            let b_low = unsafe { state.get_unchecked(right - before) };
            let a_high = unsafe { state.get_unchecked(left + after) };
            let b_high = unsafe { state.get_unchecked(right + after) };
            let derivative = 0.5 / (span as f64 * cross_width);
            bed_cross = ((a_high.bed - a_low.bed) + (b_high.bed - b_low.bed)) * derivative;
            surface_cross = bed_cross
                + ((a_high.depth - a_low.depth) + (b_high.depth - b_low.depth)) * derivative;
        }
    }
    let shaking = model.shaking.map_or([0.0; 2], |motion| {
        let left = unsafe { motion.get_unchecked(support_columns.0) };
        let right = unsafe { motion.get_unchecked(support_columns.1) };
        [0.5 * (left[0] + right[0]), 0.5 * (left[1] + right[1])]
    });
    let offset = apparent_step(
        a,
        b,
        b.bed - a.bed,
        width,
        dt,
        model,
        x,
        bed_cross,
        surface_cross,
        shaking,
    );
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
            face(
                state,
                next,
                i,
                i + 1,
                dt,
                model.dx,
                model,
                true,
                (
                    if z > 0 { nx } else { 0 },
                    if z + 1 < nz { nx } else { 0 },
                    nx,
                ),
                (i - start, i - start + 1),
            );
        }
        wall(state, next, last, -dt / model.dx, model.gravity, true);
    }
    for x in 0..nx {
        let last = x + nx * (nz - 1);
        wall(state, next, x, dt / model.dz, model.gravity, false);
        for z in 0..nz - 1 {
            let i = x + z * nx;
            face(
                state,
                next,
                i,
                i + nx,
                dt,
                model.dz,
                model,
                false,
                (usize::from(x > 0), usize::from(x + 1 < nx), 1),
                (x, x),
            );
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

fn shaking_columns<'a>(address: *const f64, nx: usize) -> Option<&'a [[f64; 2]]> {
    if address.is_null() {
        return None;
    }
    Some(unsafe { core::slice::from_raw_parts(address.cast::<[f64; 2]>(), nx) })
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
    roughness: *const f64,
    grain_load: f64,
    ground: *const f64,
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
        roughness: unsafe { roughness.cast::<Roughness>().as_ref() },
        grain_load,
        shaking: shaking_columns(ground, nx),
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

#[repr(C)]
struct Deposit {
    density: f64,
    moving_density: f64,
    stop_speed: f64,
}

fn slope_axis(
    cells: &[Column],
    column: Column,
    low: usize,
    high: usize,
    intervals: usize,
    width: f64,
    support: f64,
    body_slope: f64,
    has_low: bool,
    has_high: bool,
) -> (f64, f64) {
    if intervals == 0 {
        return (0.0, 0.0);
    }
    let a = unsafe { cells.get_unchecked(low) };
    let b = unsafe { cells.get_unchecked(high) };
    let bed = (b.bed - a.bed) / (intervals as f64 * width);
    // A centred surface derivative is zero at a symmetric peak. Both sides still
    // drive outward motion there, so arrest checks the steepest downhill secant.
    let to_low = (column.bed - a.bed) * support
        + (column.depth - a.depth)
        + if has_low { body_slope * width } else { 0.0 };
    let to_high = (column.bed - b.bed) * support + (column.depth - b.depth)
        - if has_high { body_slope * width } else { 0.0 };
    (bed, to_low.max(to_high).max(0.0) / width)
}

fn deposit_candidate(
    cells: &[Column],
    i: usize,
    nx: usize,
    nz: usize,
    model: &Model,
    speed_limit: f64,
) -> bool {
    let column = unsafe { *cells.get_unchecked(i) };
    if column.depth == 0.0 {
        return false;
    }
    let [ux, uz] = column.velocity();
    if length(ux, uz) > speed_limit {
        return false;
    }
    let x = i % nx;
    let z = i / nx;
    let west = usize::from(x > 0);
    let east = usize::from(x + 1 < nx);
    let near = usize::from(z > 0);
    let far = usize::from(z + 1 < nz);
    let (support, body_slope) = model.shaking.map_or((1.0, 0.0), |motion| {
        let [ax, ay] = unsafe { *motion.get_unchecked(x) };
        ((1.0 + ay / model.gravity).max(0.0), ax / model.gravity)
    });
    if support == 0.0 {
        return false;
    }
    let (bx, sx) = slope_axis(
        cells,
        column,
        i - west,
        i + east,
        west + east,
        model.dx,
        support,
        body_slope,
        west > 0,
        east > 0,
    );
    let (bz, sz) = slope_axis(
        cells,
        column,
        i - near * nx,
        i + far * nx,
        near + far,
        model.dz,
        support,
        0.0,
        near > 0,
        far > 0,
    );
    let speed = length(length(ux, uz), bx * ux + bz * uz);
    let mut stop = model.friction;
    if let Some(roughness) = model.roughness {
        let normal = column.depth / sqrt(1.0 + bx * bx + bz * bz);
        stop = roughness.stop(normal);
        // The subcritical Froude condition is independent of the authored arrest tolerance.
        if speed > roughness.beta * sqrt(model.gravity * normal) {
            return false;
        }
    }
    speed <= speed_limit && length(sx, sz) <= stop * model.grain_load * support
}

// Freeze a subcritical plug in one transfer after advection. The two triangles assigned to
// each source cell give each vertex either one or two sixths of its projected footprint.
#[unsafe(no_mangle)]
pub extern "C" fn granular_deposit(
    input: *const f64,
    output: *mut f64,
    changes: *mut f64,
    vertex_area: *const f64,
    budget: *mut f64,
    params: *const f64,
    nx: usize,
    nz: usize,
    dx: f64,
    dz: f64,
    gravity: f64,
    friction: f64,
    roughness: *const f64,
    grain_load: f64,
    ground: *const f64,
) -> i32 {
    let count = nx * nz;
    let vertices = (nx + 1) * (nz + 1);
    let cells = unsafe { core::slice::from_raw_parts(input.cast::<Column>(), count) };
    let next = unsafe { core::slice::from_raw_parts_mut(output.cast::<Column>(), count) };
    let area = unsafe { core::slice::from_raw_parts(vertex_area, vertices) };
    let change = unsafe { core::slice::from_raw_parts_mut(changes, vertices) };
    let props = unsafe { &*params.cast::<Deposit>() };
    let model = Model {
        gravity,
        dx,
        dz,
        friction,
        turbulence: f64::INFINITY,
        roughness: unsafe { roughness.cast::<Roughness>().as_ref() },
        grain_load,
        shaking: shaking_columns(ground, nx),
    };
    let mut mass = 0.0;
    let mut impulse_x = 0.0;
    let mut impulse_z = 0.0;
    let mut kinetic = 0.0;
    let cell_area = dx * dz;
    let mass_per_depth = cell_area * props.moving_density;
    let stride = nz + 1;
    change.fill(0.0);
    for (i, (column, result)) in cells.iter().zip(next.iter_mut()).enumerate() {
        *result = *column;
        if !deposit_candidate(cells, i, nx, nz, &model, props.stop_speed) {
            continue;
        }
        let removed = column.depth * mass_per_depth;
        let [vx, vz] = column.velocity();
        let speed2 = vx * vx + vz * vz;
        mass += removed;
        impulse_x += removed * vx;
        impulse_z += removed * vz;
        kinetic += 0.5 * removed * speed2;
        result.depth = 0.0;
        result.discharge_x = 0.0;
        result.discharge_z = 0.0;
        let vertex = (i % nx) * stride + i / nx;
        let sixth = removed / props.density / 6.0;
        for (index, volume) in [
            (vertex, sixth),
            (vertex + 1, 2.0 * sixth),
            (vertex + stride, 2.0 * sixth),
            (vertex + stride + 1, sixth),
        ] {
            let a = unsafe { *area.get_unchecked(index) };
            let delta = unsafe { change.get_unchecked_mut(index) };
            *delta += volume / a;
        }
    }
    if !mass.is_finite()
        || !impulse_x.is_finite()
        || !impulse_z.is_finite()
        || !kinetic.is_finite()
        || change.iter().any(|delta| !delta.is_finite())
    {
        return -1;
    }
    let terms = unsafe { core::slice::from_raw_parts_mut(budget, 4) };
    for (out, piece) in terms.iter_mut().zip([mass, impulse_x, impulse_z, kinetic]) {
        *out += piece;
        if !out.is_finite() {
            return -1;
        }
    }
    0
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SeaCell {
    submerged_depth: f64,
    deposit_height: f64,
}

#[repr(C)]
struct SeaGrid {
    x: f64,
    z: f64,
    dx: f64,
    dz: f64,
    datum: f64,
    radius: f64,
}

#[repr(C)]
struct SeaBudget {
    baseline_computed: f64,
    initial_volume: f64,
    occupied_volume: f64,
}

#[repr(C)]
struct SeaSource {
    x: f64,
    z: f64,
    radius: f64,
    pressure: f64,
    volume: f64,
}

fn mean_deposit(deltas: &[f64], x: usize, z: usize, nz: usize) -> f64 {
    let stride = nz + 1;
    let i = x * stride + z;
    let lower =
        unsafe { *deltas.get_unchecked(i) } / 6.0 + unsafe { *deltas.get_unchecked(i + 1) } / 3.0;
    let upper = unsafe { *deltas.get_unchecked(i + stride) } / 3.0
        + unsafe { *deltas.get_unchecked(i + stride + 1) } / 6.0;
    lower + upper
}

// Emit the local change of combined slide and consolidated occupation at the water datum.
// A transfer from the mobile layer to TerrainBed must count once, including any compaction.
#[unsafe(no_mangle)]
pub extern "C" fn granular_sea_source(
    previous_state: *const f64,
    advanced: *const f64,
    earlier: *const f64,
    next: *mut f64,
    source: *mut f64,
    bed_change: *const f64,
    grid: *const f64,
    previous_budget: *const f64,
    budget: *mut f64,
    nx: usize,
    nz: usize,
) -> i32 {
    if nx == 0 || nz == 0 {
        return -1;
    }
    let count = nx * nz;
    let previous_state =
        unsafe { core::slice::from_raw_parts(previous_state.cast::<Column>(), count) };
    let advanced = unsafe { core::slice::from_raw_parts(advanced.cast::<Column>(), count) };
    let earlier = unsafe { core::slice::from_raw_parts(earlier.cast::<SeaCell>(), count) };
    let next = unsafe { core::slice::from_raw_parts_mut(next.cast::<SeaCell>(), count) };
    let sources = unsafe { core::slice::from_raw_parts_mut(source.cast::<SeaSource>(), count) };
    let deltas = if bed_change.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts(bed_change, (nx + 1) * (nz + 1)) })
    };
    let grid = unsafe { &*grid.cast::<SeaGrid>() };
    let before = unsafe { &*previous_budget.cast::<SeaBudget>() };
    let budget = unsafe { &mut *budget.cast::<SeaBudget>() };
    let area = grid.dx * grid.dz;
    let first = before.baseline_computed == 0.0;
    let mut initial = if first { 0.0 } else { before.initial_volume };
    let mut occupied = 0.0;
    for (i, cell) in advanced.iter().enumerate() {
        let past = unsafe { *earlier.get_unchecked(i) };
        let x = i % nx;
        let z = i / nx;
        let local_deposit = deltas.map_or(0.0, |d| mean_deposit(d, x, z, nz));
        let deposit_height = past.deposit_height + local_deposit;
        let underlying = cell.bed - past.deposit_height;
        let available = (grid.datum - underlying).max(0.0);
        let old = if first {
            let pre = unsafe { previous_state.get_unchecked(i) };
            let initial_depth = pre.depth.min(available);
            initial += initial_depth * area;
            initial_depth
        } else {
            past.submerged_depth
        };
        let current = (cell.depth + deposit_height).min(available);
        let delta = (current - old) * area;
        occupied += current * area;
        if !deposit_height.is_finite() || !delta.is_finite() {
            return -1;
        }
        *unsafe { next.get_unchecked_mut(i) } = SeaCell {
            submerged_depth: current,
            deposit_height,
        };
        *unsafe { sources.get_unchecked_mut(i) } = SeaSource {
            x: grid.x + (x as f64 + 0.5) * grid.dx,
            z: grid.z + (z as f64 + 0.5) * grid.dz,
            radius: grid.radius,
            pressure: 0.0,
            volume: delta,
        };
    }
    if !occupied.is_finite() || !initial.is_finite() {
        return -1;
    }
    *budget = SeaBudget {
        baseline_computed: 1.0,
        initial_volume: initial,
        occupied_volume: occupied,
    };
    0
}
