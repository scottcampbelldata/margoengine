//! Exact planar hydrostatic loading of a moving box, with body-frame Euler dynamics and ablation.
#![no_std]
#![cfg(target_arch = "wasm32")]

use core::{
    arch::wasm32::*,
    ops::{Add, Mul, Sub},
    slice,
};

#[panic_handler]
fn trap(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

const ROW_WORDS: usize = 20;
const SETTINGS_WORDS: usize = 15;

// A malformed index traps without requiring a static panic location in shared world memory.
fn at<T: Copy>(slice: &[T], i: usize) -> T {
    match slice.get(i) {
        Some(value) => *value,
        None => unreachable(),
    }
}

fn put<T>(slice: &mut [T], i: usize, value: T) {
    match slice.get_mut(i) {
        Some(word) => *word = value,
        None => unreachable(),
    }
}

#[derive(Clone, Copy)]
struct V(f64, f64, f64);

impl Add for V {
    type Output = Self;
    fn add(self, other: Self) -> Self {
        Self(self.0 + other.0, self.1 + other.1, self.2 + other.2)
    }
}
impl Sub for V {
    type Output = Self;
    fn sub(self, other: Self) -> Self {
        Self(self.0 - other.0, self.1 - other.1, self.2 - other.2)
    }
}
impl Mul<f64> for V {
    type Output = Self;
    fn mul(self, factor: f64) -> Self {
        Self(self.0 * factor, self.1 * factor, self.2 * factor)
    }
}

const ZERO: V = V(0.0, 0.0, 0.0);

impl V {
    #[inline(always)]
    fn read(words: &[f64]) -> Self {
        Self(words[0], words[1], words[2])
    }

    #[inline(always)]
    fn write(self, words: &mut [f64]) {
        words[0] = self.0;
        words[1] = self.1;
        words[2] = self.2;
    }

    fn dot(self, v: Self) -> f64 {
        let xy = f64x2_mul(f64x2(self.0, self.1), f64x2(v.0, v.1));
        (f64x2_extract_lane::<0>(xy) + f64x2_extract_lane::<1>(xy)) + self.2 * v.2
    }

    fn cross(self, v: Self) -> Self {
        Self(
            self.1 * v.2 - self.2 * v.1,
            self.2 * v.0 - self.0 * v.2,
            self.0 * v.1 - self.1 * v.0,
        )
    }

    fn volume(self) -> f64 {
        self.0 * self.1 * self.2
    }

    fn at(self, axis: usize) -> f64 {
        if axis == 0 {
            self.0
        } else if axis == 1 {
            self.1
        } else {
            self.2
        }
    }
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

#[derive(Clone, Copy)]
struct Rotor {
    xyz: V,
    w: f64,
}

impl Rotor {
    fn rotate(self, v: V) -> V {
        let t = self.xyz.cross(v) * 2.0;
        v + t * self.w + self.xyz.cross(t)
    }

    fn inverse(self, v: V) -> V {
        Self {
            xyz: self.xyz * -1.0,
            w: self.w,
        }
        .rotate(v)
    }

    fn advance(self, body_omega: V, dt: f64) -> Self {
        // The normalized Cayley increment has a second-order local expansion in omega * dt.
        let delta = body_omega * (0.5 * dt);
        let xyz = self.xyz + delta * self.w + self.xyz.cross(delta);
        let w = self.w - self.xyz.dot(delta);
        let unit = 1.0 / sqrt(xyz.dot(xyz) + w * w);
        Self {
            xyz: xyz * unit,
            w: w * unit,
        }
    }
}

#[derive(Clone, Copy)]
struct Body {
    point: V,
    orientation: Rotor,
    speed: V,
    spin: V,
    size: V,
}

impl Body {
    fn read(row: &[f64; ROW_WORDS]) -> Self {
        Self {
            point: V::read(row),
            orientation: Rotor {
                xyz: V::read(&row[3..]),
                w: row[6],
            },
            speed: V::read(&row[7..]),
            spin: V::read(&row[10..]),
            size: V::read(&row[13..]),
        }
    }

    fn write(self, row: &mut [f64; ROW_WORDS]) {
        self.point.write(row);
        self.orientation.xyz.write(&mut row[3..]);
        row[6] = self.orientation.w;
        self.speed.write(&mut row[7..]);
        self.spin.write(&mut row[10..]);
        self.size.write(&mut row[13..]);
    }

    fn kick(&mut self, acceleration: V, angular: V, dt: f64) {
        self.speed = self.speed + acceleration * dt;
        self.spin = self.spin + angular * dt;
    }

    fn drift(&mut self, dt: f64) {
        self.point = self.point + self.speed * dt;
        self.orientation = self.orientation.advance(self.spin, dt);
    }
}

struct Fluid {
    density: f64,
    speed: V,
    drag: f64,
}

struct Environment {
    gravity: f64,
    ice: f64,
    surface: f64,
    water: Fluid,
    air: Fluid,
    side_recession: f64,
    basal_recession: f64,
}

impl Environment {
    fn read(settings: &[f64; SETTINGS_WORDS]) -> Self {
        Self {
            gravity: settings[0],
            ice: settings[1],
            surface: settings[2],
            water: Fluid {
                density: settings[3],
                speed: V::read(&settings[4..]),
                drag: settings[7],
            },
            air: Fluid {
                density: settings[8],
                speed: V::read(&settings[9..]),
                drag: settings[12],
            },
            side_recession: settings[13],
            basal_recession: settings[14],
        }
    }
}

struct Wrench {
    force: V,
    torque: V,
    buoyancy: f64,
    wet_fractions: [f64; 6],
}

struct Panel {
    area: f64,
    first: V,
    pressure: f64,
    pressure_first: V,
}

#[repr(C)]
#[derive(Default)]
struct Work {
    rows: f64,
    active_rows: f64,
    substeps: f64,
    wrench_evaluations: f64,
    paired_panel_dots: f64,
}

fn clipped(face: [V; 4], waterline: f64, wet: bool) -> ([V; 5], usize) {
    let mut poly = [ZERO; 5];
    let mut n = 0;
    let mut previous = face[3];
    let mut previous_h = previous.1 - waterline;
    for point in face {
        let height = point.1 - waterline;
        let keep = if wet { height < 0.0 } else { height > 0.0 };
        let old = if wet {
            previous_h < 0.0
        } else {
            previous_h > 0.0
        };
        if keep != old {
            let t = previous_h / (previous_h - height);
            let middle = previous + (point - previous) * t;
            put(&mut poly, n, V(middle.0, waterline, middle.2));
            n += 1;
        }
        if keep {
            put(&mut poly, n, point);
            n += 1;
        }
        previous = point;
        previous_h = height;
    }
    (poly, n)
}

/// Integrate area, first moment, depth and depth first moment over a clipped planar face.
fn panel(face: [V; 4], waterline: f64, wet: bool, paired_dots: &mut usize) -> Panel {
    let (polygon, count) = clipped(face, waterline, wet);
    *paired_dots += count.saturating_sub(2);
    let mut result = Panel {
        area: 0.0,
        first: ZERO,
        pressure: 0.0,
        pressure_first: ZERO,
    };
    let a = polygon[0];
    for i in 2..count {
        let b = at(&polygon, i - 1);
        let c = at(&polygon, i);
        let cross = (b - a).cross(c - a);
        let area = 0.5 * sqrt(cross.dot(cross));
        let sum = a + b + c;
        result.area += area;
        result.first = result.first + sum * (area / 3.0);
        if wet {
            let pa = waterline - a.1;
            let pb = waterline - b.1;
            let pc = waterline - c.1;
            let total = pa + pb + pc;
            result.pressure += (area / 3.0) * total;
            result.pressure_first =
                result.pressure_first + (sum * total + a * pa + b * pb + c * pc) * (area / 12.0);
        }
    }
    result
}

fn drag(panel: &Panel, normal: V, speed: V, spin: V, fluid: &Fluid, wrench: &mut Wrench) {
    if panel.area == 0.0 || fluid.drag == 0.0 {
        return;
    }
    let centre = panel.first * (1.0 / panel.area);
    let normal_speed = (speed + spin.cross(centre) - fluid.speed).dot(normal);
    if normal_speed <= 0.0 {
        return;
    }
    let force = normal
        * (-0.5 * fluid.density * fluid.drag * panel.area * normal_speed.abs() * normal_speed);
    wrench.force = wrench.force + force;
    wrench.torque = wrench.torque + centre.cross(force);
}

fn loads(body: Body, env: &Environment, work: &mut Work) -> Wrench {
    let mut paired_dots = 0;
    let mut output = Wrench {
        force: ZERO,
        torque: ZERO,
        buoyancy: 0.0,
        wet_fractions: [0.0; 6],
    };
    let spin = body.orientation.rotate(body.spin);
    let waterline = env.surface - body.point.1;
    // Coordinates are offsets from the centre of mass, which preserves precision far from the origin.
    let ax = body.orientation.rotate(V(1.0, 0.0, 0.0));
    let ay = body.orientation.rotate(V(0.0, 1.0, 0.0));
    let az = body.orientation.rotate(V(0.0, 0.0, 1.0));
    let hx = ax * (0.5 * body.size.0);
    let hy = ay * (0.5 * body.size.1);
    let hz = az * (0.5 * body.size.2);
    let rho_g = env.water.density * env.gravity;
    for axis in 0..3 {
        let (base, tangent_a, tangent_b, direction) = if axis == 0 {
            (hx, hy, hz, ax)
        } else if axis == 1 {
            (hy, hx, hz, ay)
        } else {
            (hz, hx, hy, az)
        };
        let area = body.size.at((axis + 1) % 3) * body.size.at((axis + 2) % 3);
        for sign in 0..2 {
            let flip = if sign == 0 { -1.0 } else { 1.0 };
            let centre = base * flip;
            let normal = direction * flip;
            let face = [
                centre - tangent_a - tangent_b,
                centre + tangent_a - tangent_b,
                centre + tangent_a + tangent_b,
                centre - tangent_a + tangent_b,
            ];
            let wet = panel(face, waterline, true, &mut paired_dots);
            put(
                &mut output.wet_fractions,
                2 * axis + sign,
                (wet.area / area).min(1.0),
            );
            let pressure = normal * (-rho_g * wet.pressure);
            output.force = output.force + pressure;
            output.torque = output.torque + wet.pressure_first.cross(normal) * -rho_g;
            output.buoyancy += pressure.1;
            drag(&wet, normal, body.speed, spin, &env.water, &mut output);
            if env.air.drag > 0.0 {
                drag(
                    &panel(face, waterline, false, &mut paired_dots),
                    normal,
                    body.speed,
                    spin,
                    &env.air,
                    &mut output,
                );
            }
        }
    }
    work.wrench_evaluations += 1.0;
    work.paired_panel_dots += paired_dots as f64;
    output
}

fn inertia(body: Body, mass: f64) -> V {
    let size = body.size;
    let x = size.0 * size.0;
    let y = size.1 * size.1;
    let z = size.2 * size.2;
    let unit = mass / 12.0;
    V(unit * (y + z), unit * (x + z), unit * (x + y))
}

fn acceleration(body: Body, env: &Environment, load: &Wrench) -> (V, V) {
    let mass = env.ice * body.size.volume();
    let moment = inertia(body, mass);
    let checked_torque = body.orientation.inverse(load.torque);
    let omega = body.spin;
    let gyro = omega.cross(V(
        moment.0 * omega.0,
        moment.1 * omega.1,
        moment.2 * omega.2,
    ));
    let net = checked_torque - gyro;
    (
        load.force * (1.0 / mass) - V(0.0, env.gravity, 0.0),
        V(net.0 / moment.0, net.1 / moment.1, net.2 / moment.2),
    )
}

fn melt(body: &mut Body, env: &Environment, wet: &[f64; 6], dt: f64) {
    if env.side_recession == 0.0 && env.basal_recession == 0.0 {
        return;
    }
    let vertical = body.orientation.inverse(V(0.0, 1.0, 0.0));
    let up = V(vertical.0.abs(), vertical.1.abs(), vertical.2.abs());
    let axis = if up.0 >= up.1 && up.0 >= up.2 {
        0
    } else if up.1 >= up.2 {
        1
    } else {
        2
    };
    let down = axis * 2 + usize::from(vertical.at(axis) < 0.0);
    let mut shift = ZERO;
    let mut size = ZERO;
    for k in 0..3 {
        let lower = k * 2;
        let upper = lower + 1;
        let rate_lower = if lower == down {
            env.basal_recession
        } else {
            env.side_recession
        };
        let rate_upper = if upper == down {
            env.basal_recession
        } else {
            env.side_recession
        };
        let width = body.size.at(k);
        let a = dt * rate_lower * at(wet, lower);
        let b = dt * rate_upper * at(wet, upper);
        let extent = (width - (a + b)).max(0.0);
        let offset = 0.5 * (a - b);
        if k == 0 {
            size.0 = extent;
            shift.0 = offset;
        } else if k == 1 {
            size.1 = extent;
            shift.1 = offset;
        } else {
            size.2 = extent;
            shift.2 = offset;
        }
    }
    body.size = size;
    if size.volume() == 0.0 {
        body.size = ZERO;
        body.speed = ZERO;
        body.spin = ZERO;
    } else {
        body.point = body.point + body.orientation.rotate(shift);
    }
}

/// The shortest shape dimension bounds the undamped hydrostatic frequency.
/// The relative-motion bound also controls force reversal from quadratic drag.
fn stable_interval(body: Body, env: &Environment) -> f64 {
    let size = body.size;
    let shortest = size.0.min(size.1.min(size.2));
    let longest = size.0.max(size.1.max(size.2));
    let angular = sqrt(body.spin.dot(body.spin));
    let hydro = sqrt(6.0 * env.gravity * env.water.density / (shortest * env.ice));
    let drag_rate = |fluid: &Fluid| {
        let relative = body.speed - fluid.speed;
        let speed = sqrt(relative.dot(relative)) + 0.5 * longest * angular;
        fluid.density * fluid.drag * speed / (env.ice * shortest)
    };
    0.125 / (hydro + angular + drag_rate(&env.water) + drag_rate(&env.air))
}

fn advance_row(row: &mut [f64; ROW_WORDS], env: &Environment, dt: f64, work: &mut Work) -> bool {
    let mut body = Body::read(row);
    let initial = body.size.volume();
    let previous_wet = row[16];
    if initial == 0.0 {
        row[16] = 0.0;
        row[17] = -previous_wet;
        row[18] = 0.0;
        return true;
    }
    work.active_rows += 1.0;
    let mut time = 0.0;
    while time < dt && body.size.volume() > 0.0 {
        let mut local = dt - time;
        let stable = stable_interval(body, env);
        if !(stable.is_finite() && stable > 0.0) {
            return false;
        }
        while local > stable {
            local *= 0.5;
        }
        if time + local == time {
            return false;
        }
        let start = loads(body, env, work);
        let (a, spin) = acceleration(body, env, &start);
        body.kick(a, spin, 0.5 * local);
        body.drift(local);
        let end = loads(body, env, work);
        let (a, spin) = acceleration(body, env, &end);
        body.kick(a, spin, 0.5 * local);
        let wet = core::array::from_fn(|i| {
            0.5 * (at(&start.wet_fractions, i) + at(&end.wet_fractions, i))
        });
        melt(&mut body, env, &wet, local);
        time += local;
        work.substeps += 1.0;
    }
    body.write(row);
    let volume = body.size.volume();
    let wet = if volume > 0.0 {
        (loads(body, env, work).buoyancy / (env.gravity * env.water.density))
            .max(0.0)
            .min(volume)
    } else {
        0.0
    };
    let melted = (initial - volume).max(0.0);
    row[16] = wet;
    row[17] = if dt > 0.0 { wet - previous_wet } else { 0.0 };
    row[18] = melted;
    row[19] += melted;
    row.iter().all(|value| value.is_finite())
}

#[repr(C)]
struct Job {
    state: *mut f64,
    count: usize,
    settings: *const f64,
    work: *mut Work,
    dt: f64,
}

const _: [(); 24] = [(); size_of::<Job>()];

impl Job {
    fn valid(&self) -> bool {
        self.count <= isize::MAX as usize / size_of::<[f64; ROW_WORDS]>()
            && self.dt.is_finite()
            && self.dt >= 0.0
    }

    unsafe fn advance_rows(&self, start: usize, end: usize, part: usize) -> u32 {
        let rows = end - start;
        let mut work = Work {
            rows: rows as f64,
            ..Work::default()
        };
        if rows != 0 {
            // Each participant exclusively owns its candidate body rows. The environment is immutable.
            let data = unsafe {
                slice::from_raw_parts_mut(self.state.cast::<[f64; ROW_WORDS]>().add(start), rows)
            };
            let settings = unsafe { &*self.settings.cast::<[f64; SETTINGS_WORDS]>() };
            let env = Environment::read(settings);
            for row in data {
                if !advance_row(row, &env, self.dt, &mut work) {
                    return 1;
                }
            }
        }
        if !self.work.is_null() {
            unsafe { self.work.add(part).write(work) };
        }
        0
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn iceberg_step(
    state: *mut f64,
    count: usize,
    settings: *const f64,
    dt: f64,
    work: *mut Work,
) -> u32 {
    let job = Job {
        state,
        count,
        settings,
        work,
        dt,
    };
    if !job.valid() {
        return 1;
    }
    unsafe { job.advance_rows(0, count, 0) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn iceberg_thread_phase(job: &Job, stage: u32, part: u32, parts: u32) -> u32 {
    let Some(parts) = core::num::NonZeroU64::new(u64::from(parts)) else {
        return 1;
    };
    if stage != 0 || u64::from(part) >= parts.get() || !job.valid() {
        return 1;
    }
    let count = job.count as u64;
    let start = (count * u64::from(part) / parts.get()) as usize;
    let end = (count * u64::from(part + 1) / parts.get()) as usize;
    unsafe { job.advance_rows(start, end, part as usize) }
}
