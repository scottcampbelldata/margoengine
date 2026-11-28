#![no_std]

use core::arch::wasm32::{
    f64x2_add, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sub, v128_load, v128_store,
};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

// The backward-Euler Pringle M-matrix in x = sqrt(r) is solved by ordered Thomas factors.
unsafe fn transport(
    n: usize,
    config: *const f64,
    scratch: *mut f64,
    mass: *mut f64,
    flux: *mut f64,
    budget: *mut f64,
    dt: f64,
    feed: f64,
) -> bool {
    unsafe {
        let face = config.add(4 * n);
        let rhs = scratch.add(n);
        let mut residual_fraction = 1.0;
        let mut elimination = 0.0;
        // The raw pivot subtraction is replaced by the positive residual/pivot ratio of the previous row.
        for i in 0..n {
            let left = dt * *face.add(i);
            let right = dt * *face.add(i + 1);
            let w = *config.add(i);
            let residual = 1.0 + (left * w) * residual_fraction;
            let diagonal = residual + right * w;
            let original = *mass.add(i) + if i + 1 == n { dt * feed } else { 0.0 };
            *rhs.add(i) = original
                + if i == 0 {
                    0.0
                } else {
                    elimination * *rhs.add(i - 1)
                };
            if !(diagonal > 0.0 && diagonal.is_finite()) || !(*rhs.add(i)).is_finite() {
                return false;
            }
            *scratch.add(i) = diagonal;
            residual_fraction = residual / diagonal;
            elimination = (right * w) / diagonal;
        }
        for i in (0..n).rev() {
            let d = *scratch.add(i);
            let next = if i + 1 == n {
                0.0
            } else {
                ((dt * *face.add(i + 1)) * *config.add(i + 1) / d) * *mass.add(i + 1)
            };
            let value = *rhs.add(i) / d + next;
            if !(value >= 0.0 && value.is_finite()) {
                return false;
            }
            *mass.add(i) = value;
        }
        let mut previous = 0.0;
        let mut total_mass = 0.0;
        for i in 0..n {
            let current = *mass.add(i) * *config.add(i);
            *flux.add(i) = *face.add(i) * (current - previous);
            if !current.is_finite() || !(*flux.add(i)).is_finite() {
                return false;
            }
            previous = current;
            total_mass += *mass.add(i);
        }
        *flux.add(n) = feed - *face.add(n) * previous;
        *budget += dt * feed;
        *budget.add(1) += dt * *flux;
        *budget.add(2) += dt * (*face.add(n) * previous);
        *budget.add(3) = total_mass;

        (*flux.add(n)).is_finite()
            && core::slice::from_raw_parts(budget, 4)
                .iter()
                .all(|value| value.is_finite())
    }
}

// Every annulus derives its density, one-face heating and orbital phase independently.
unsafe fn annuli(
    n: usize,
    config: *const f64,
    mass: *const f64,
    density: *mut f64,
    heat: *mut f64,
    phase: *mut f64,
    dt: f64,
    first: usize,
    end: usize,
) {
    unsafe {
        let inv_area = config.add(n);
        let omega = inv_area.add(n);
        let heat_factor = omega.add(n);
        let step = f64x2_splat(dt);
        let tau = core::f64::consts::TAU;
        let period = f64x2_splat(tau);
        let inverse_period = f64x2_splat(1.0 / tau);
        let mut i = first;
        while i + 1 < end {
            let sigma = f64x2_mul(
                v128_load(mass.add(i).cast()),
                v128_load(inv_area.add(i).cast()),
            );
            v128_store(density.add(i).cast(), sigma);
            v128_store(
                heat.add(i).cast(),
                f64x2_mul(sigma, v128_load(heat_factor.add(i).cast())),
            );
            let angle = f64x2_add(
                v128_load(phase.add(i).cast()),
                f64x2_mul(step, v128_load(omega.add(i).cast())),
            );
            let turns = f64x2_floor(f64x2_mul(angle, inverse_period));
            v128_store(
                phase.add(i).cast(),
                f64x2_sub(angle, f64x2_mul(period, turns)),
            );
            i += 2;
        }
        if i < end {
            *density.add(i) = *mass.add(i) * *inv_area.add(i);
            *heat.add(i) = *density.add(i) * *heat_factor.add(i);
            let angle = *phase.add(i) + dt * *omega.add(i);
            *phase.add(i) = angle
                - tau
                    * core::arch::wasm32::f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(
                        angle * (1.0 / tau),
                    )));
        }
    }
}

unsafe fn luminosity(n: usize, config: *const f64, heat: *const f64) -> f64 {
    let mut luminosity = 0.0;
    unsafe {
        let inv_area = config.add(n);
        for i in 0..n {
            luminosity += (2.0 * *heat.add(i)) / *inv_area.add(i);
        }
    }
    luminosity
}

#[repr(C)]
struct Work {
    annuli: f64,
    paired_annuli: f64,
}

#[repr(C)]
struct Job {
    n: usize,
    config: *const f64,
    scratch: *mut f64,
    mass: *mut f64,
    density: *mut f64,
    heat: *mut f64,
    phase: *mut f64,
    flux: *mut f64,
    budget: *mut f64,
    work: *mut Work,
    dt: f64,
    feed: f64,
}

const _: [(); 56] = [(); size_of::<Job>()];

impl Job {
    fn valid(&self) -> bool {
        let max_words = isize::MAX as usize / size_of::<f64>();
        self.n > 0
            && self.n <= (max_words - 1) / 5
            && self.dt >= 0.0
            && self.dt.is_finite()
            && self.feed >= 0.0
            && self.feed.is_finite()
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn accretion_prepare(job: &Job) -> u32 {
    if !job.valid() {
        return 1;
    }
    u32::from(!unsafe {
        transport(
            job.n,
            job.config,
            job.scratch,
            job.mass,
            job.flux,
            job.budget,
            job.dt,
            job.feed,
        )
    })
}

#[unsafe(no_mangle)]
unsafe extern "C" fn accretion_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if !job.valid() || stage != 0 || !matches!(parts, 1 | 2 | 4) || part >= parts {
        return 1;
    }
    let pairs = job.n / 2;
    let first = 2 * (part * pairs / parts);
    let end = if part + 1 == parts {
        job.n
    } else {
        2 * ((part + 1) * pairs / parts)
    };
    unsafe {
        annuli(
            job.n,
            job.config,
            job.mass,
            job.density,
            job.heat,
            job.phase,
            job.dt,
            first,
            end,
        );
        for i in first..end {
            if !(*job.density.add(i)).is_finite()
                || !(*job.heat.add(i)).is_finite()
                || !(*job.phase.add(i)).is_finite()
            {
                return 1;
            }
        }
        job.work.add(part).write(Work {
            annuli: (end - first) as f64,
            paired_annuli: ((end - first) & !1) as f64,
        });
    }
    0
}

#[unsafe(no_mangle)]
unsafe extern "C" fn accretion_finish(job: &Job) -> u32 {
    if !job.valid() {
        return 1;
    }
    unsafe {
        let value = luminosity(job.n, job.config, job.heat);
        if !value.is_finite() {
            return 1;
        }
        *job.budget.add(4) = value;
    }
    0
}
