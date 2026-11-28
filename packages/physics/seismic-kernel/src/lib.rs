#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sub, v128, v128_load,
    v128_store,
};

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[derive(Clone, Copy)]
struct Column(*mut f64);

impl Column {
    unsafe fn get(self, i: usize) -> f64 {
        unsafe { *self.0.add(i) }
    }

    unsafe fn set(self, i: usize, value: f64) {
        unsafe { *self.0.add(i) = value };
    }

    unsafe fn pair(self, i: usize) -> v128 {
        unsafe { v128_load(self.0.add(i).cast()) }
    }

    unsafe fn write(self, i: usize, v: v128, pair: bool) {
        if pair {
            unsafe { v128_store(self.0.add(i).cast(), v) };
        } else {
            unsafe { self.set(i, f64x2_extract_lane::<0>(v)) };
        }
    }
}

#[derive(Clone, Copy)]
struct Section {
    state: *mut f64,
    width: usize,
    depth: usize,
    pitch: usize,
    count: usize,
    dx: f64,
    dz: f64,
    dt: f64,
}

impl Section {
    fn new(state: *mut f64, width: usize, depth: usize, dx: f64, dz: f64, dt: f64) -> Option<Self> {
        let pitch = width.checked_add(2)?;
        let count = pitch.checked_mul(depth.checked_add(2)?)?;
        if width == 0 || depth == 0 || count > isize::MAX as usize / (11 * size_of::<f64>()) {
            return None;
        }
        Some(Self {
            state,
            width,
            depth,
            pitch,
            count,
            dx,
            dz,
            dt,
        })
    }

    fn column(self, column: usize) -> Column {
        Column(unsafe { self.state.add(column * self.count) })
    }

    unsafe fn surface(self) {
        let width = self.width;
        let pitch = self.pitch;
        let dz = self.dz;
        let dt = self.dt;
        let vz = self.column(1);
        let szz = self.column(3);
        let bz = self.column(6);
        let attenuation = self.column(10);
        unsafe {
            // Zero shear and the odd normal stress extension make the top face traction-free.
            for x in 1..=width {
                let top = x + pitch;
                vz.set(
                    x,
                    (vz.get(x) + (2.0 * dt / dz) * bz.get(x) * szz.get(top))
                        / (1.0 + dt * attenuation.get(top)),
                );
            }
        }
    }

    unsafe fn velocity(self, first: usize, end: usize) {
        let width = self.width;
        let pitch = self.pitch;
        let column = |i| self.column(i);
        let [vx, vz, sxx, szz, sxz, bx, bz, attenuation] = [
            column(0),
            column(1),
            column(2),
            column(3),
            column(4),
            column(5),
            column(6),
            column(10),
        ];
        let ddx = f64x2_splat(self.dt / self.dx);
        let ddz = f64x2_splat(self.dt / self.dz);
        let tick = f64x2_splat(self.dt);
        let one = f64x2_splat(1.0);
        unsafe {
            for z in first..end {
                for x in (1..=width).step_by(2) {
                    let i = z * pitch + x;
                    let stretch = f64x2_add(one, f64x2_mul(tick, attenuation.pair(i)));
                    let horizontal = f64x2_add(
                        f64x2_mul(ddx, f64x2_sub(sxx.pair(i + 1), sxx.pair(i))),
                        f64x2_mul(ddz, f64x2_sub(sxz.pair(i), sxz.pair(i - pitch))),
                    );
                    let vertical = f64x2_add(
                        f64x2_mul(ddx, f64x2_sub(sxz.pair(i), sxz.pair(i - 1))),
                        f64x2_mul(ddz, f64x2_sub(szz.pair(i + pitch), szz.pair(i))),
                    );
                    let add_x = f64x2_mul(bx.pair(i), horizontal);
                    let add_z = f64x2_mul(bz.pair(i), vertical);
                    vx.write(
                        i,
                        f64x2_div(f64x2_add(vx.pair(i), add_x), stretch),
                        x < width,
                    );
                    vz.write(
                        i,
                        f64x2_div(f64x2_add(vz.pair(i), add_z), stretch),
                        x < width,
                    );
                }
            }
        }
    }

    unsafe fn stress(self, first: usize, end: usize) {
        let width = self.width;
        let pitch = self.pitch;
        let column = |i| self.column(i);
        let [vx, vz, sxx, szz, sxz, lambda, mu, corner, attenuation] = [
            column(0),
            column(1),
            column(2),
            column(3),
            column(4),
            column(7),
            column(8),
            column(9),
            column(10),
        ];
        let ddx = f64x2_splat(self.dt / self.dx);
        let ddz = f64x2_splat(self.dt / self.dz);
        let tick = f64x2_splat(self.dt);
        let one = f64x2_splat(1.0);
        let two = f64x2_splat(2.0);
        unsafe {
            for z in first..end {
                for x in (1..=width).step_by(2) {
                    let i = z * pitch + x;
                    let stretch = f64x2_add(one, f64x2_mul(tick, attenuation.pair(i)));
                    let dx_x = f64x2_mul(ddx, f64x2_sub(vx.pair(i), vx.pair(i - 1)));
                    let dz_z = f64x2_mul(ddz, f64x2_sub(vz.pair(i), vz.pair(i - pitch)));
                    let compress = f64x2_mul(lambda.pair(i), f64x2_add(dx_x, dz_z));
                    let shear = f64x2_mul(two, mu.pair(i));
                    let add_xx = f64x2_add(compress, f64x2_mul(shear, dx_x));
                    let add_zz = f64x2_add(compress, f64x2_mul(shear, dz_z));
                    let shear_rate = f64x2_add(
                        f64x2_mul(ddz, f64x2_sub(vx.pair(i + pitch), vx.pair(i))),
                        f64x2_mul(ddx, f64x2_sub(vz.pair(i + 1), vz.pair(i))),
                    );
                    let add_xz = f64x2_mul(corner.pair(i), shear_rate);
                    sxx.write(
                        i,
                        f64x2_div(f64x2_add(sxx.pair(i), add_xx), stretch),
                        x < width,
                    );
                    szz.write(
                        i,
                        f64x2_div(f64x2_add(szz.pair(i), add_zz), stretch),
                        x < width,
                    );
                    sxz.write(
                        i,
                        f64x2_div(f64x2_add(sxz.pair(i), add_xz), stretch),
                        x < width,
                    );
                }
            }
        }
    }
}

#[repr(C)]
#[derive(Default)]
struct Work {
    velocity_cells: f64,
    stress_cells: f64,
    paired_velocity_cells: f64,
    paired_stress_cells: f64,
}

#[repr(C)]
struct Job {
    state: *mut f64,
    width: usize,
    depth: usize,
    work: *mut Work,
    dx: f64,
    dz: f64,
    dt: f64,
}

const _: [(); 40] = [(); size_of::<Job>()];

impl Job {
    fn section(&self) -> Option<Section> {
        Section::new(
            self.state, self.width, self.depth, self.dx, self.dz, self.dt,
        )
    }
}

/// Plane-strain velocity–stress step on a Virieux staggered grid. TS allocates eleven columns with a one-cell
/// halo and supplies validated even or odd extents and material coefficients. v_z is stored positive down.
#[unsafe(no_mangle)]
unsafe extern "C" fn seismic_step(
    state: *mut f64,
    width: usize,
    depth: usize,
    dx: f64,
    dz: f64,
    dt: f64,
) {
    let Some(section) = Section::new(state, width, depth, dx, dz, dt) else {
        return;
    };
    unsafe {
        section.surface();
        section.velocity(1, section.depth + 1);
        section.stress(1, section.depth + 1);
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn seismic_surface(job: &Job) -> u32 {
    let Some(section) = job.section() else {
        return 1;
    };
    unsafe { section.surface() };
    0
}

/// Velocity workers read only immutable stress/halo and their own velocity rows. The caller joins them before
/// the stress pass reads neighbour velocities, including the already corrected free-surface halo.
#[unsafe(no_mangle)]
unsafe extern "C" fn seismic_thread_phase(job: &Job, stage: u32, part: u32, parts: u32) -> u32 {
    let Some(section) = job.section() else {
        return 1;
    };
    let Some(parts) = core::num::NonZeroU64::new(u64::from(parts)) else {
        return 1;
    };
    if stage > 1 || u64::from(part) >= parts.get() {
        return 1;
    }
    let depth = section.depth as u64;
    let first = 1 + (depth * u64::from(part) / parts.get()) as usize;
    let end = 1 + (depth * u64::from(part + 1) / parts.get()) as usize;
    let rows = end - first;
    let cells = (rows * section.width) as f64;
    let paired_cells = (rows * (section.width & !1)) as f64;
    let work = unsafe { job.work.add(part as usize) };
    if stage == 0 {
        unsafe {
            section.velocity(first, end);
            work.write(Work {
                velocity_cells: cells,
                paired_velocity_cells: paired_cells,
                ..Work::default()
            });
        }
    } else {
        unsafe {
            section.stress(first, end);
            (*work).stress_cells = cells;
            (*work).paired_stress_cells = paired_cells;
        }
    }
    0
}
