#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;
use core::f64::consts::LN_2;
use core::num::{NonZeroU64, NonZeroUsize};
use margoengine_physics_kernel_common::pinned::{exp, ln, pow};

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

const BURGERS_PEAK_RADIUS: f64 = 1.120_906_420_485_664_5;
const BURGERS_PEAK_WIND: f64 = 0.638_172_686_338_951_5;

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

fn length(x: f64, z: f64) -> f64 {
    sqrt(x * x + z * z)
}

fn paired_length(x: v128, z: v128) -> v128 {
    f64x2_sqrt(f64x2_add(f64x2_mul(x, x), f64x2_mul(z, z)))
}

fn one_minus_decay(x: f64) -> f64 {
    if x < 1e-3 {
        x * (1.0 + x * (-0.5 + x * (1.0 / 6.0 + x * (-1.0 / 24.0 + x / 120.0))))
    } else {
        1.0 - exp(-x)
    }
}

fn exponential_integral(x: f64) -> f64 {
    if x <= 1.0 {
        let mut sum = 0.0;
        let mut term = 1.0;
        for k in 1..40 {
            let k = f64::from(k);
            term *= -x / k;
            sum -= term / k;
            if (term / k).abs() < 1e-17 {
                break;
            }
        }
        return -0.577_215_664_901_532_9 - ln(x) + sum;
    }
    let mut b = x + 1.0;
    let mut c = 1e300;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..200 {
        let i = f64::from(i);
        let a = -i * i;
        b += 2.0;
        d = 1.0 / (a * d + b);
        c = b + a / c;
        let delta = c * d;
        h *= delta;
        if (delta - 1.0).abs() < 1e-15 {
            break;
        }
    }
    h * exp(-x)
}

#[repr(C)]
struct Profile {
    family: f64,
    cx: f64,
    cz: f64,
    vx: f64,
    vz: f64,
    radius: f64,
    deficit: f64,
    shape: f64,
    density: f64,
    coriolis: f64,
    spin: f64,
    radial: f64,
    tangential: f64,
    surface: f64,
    height: f64,
    roughness: f64,
    ground: f64,
    decay: f64,
    peak: f64,
    secondary_radius: f64,
    secondary_width: f64,
    secondary_strength: f64,
}

const _: [(); 176] = [(); size_of::<Profile>()];

impl Profile {
    // Holland (1980) radial pressure and the existing exact compact-profile
    // cyclostrophic integral belong to the same family as the wind below.
    fn pressure(&self, radius: f64) -> f64 {
        if self.family == 0.0 {
            if radius <= 0.0 {
                self.deficit
            } else {
                self.deficit * one_minus_decay(pow(self.radius / radius, self.shape))
            }
        } else if self.family == 1.0 {
            let q = radius / self.radius;
            let tail = 1.0 / self.decay;
            self.deficit
                * if q <= 1.0 {
                    (tail + 1.0 - q * q) / (tail + 1.0)
                } else {
                    pow(1.0 / q, 2.0 * self.decay) / (1.0 + self.decay)
                }
        } else {
            let scaled = (radius / self.radius) * BURGERS_PEAK_RADIUS;
            let q = scaled * scaled;
            if q < 1e-8 {
                self.deficit * (1.0 - q / (2.0 * LN_2))
            } else if q > 300.0 {
                self.deficit / (2.0 * LN_2 * q)
            } else {
                let e = one_minus_decay(q);
                (self.deficit
                    * ((e * e) / q
                        + 2.0 * (exponential_integral(q) - exponential_integral(2.0 * q))))
                    / (2.0 * LN_2)
            }
        }
    }

    fn pressure_difference(&self, radii: v128) -> Option<f64> {
        let positive = f64x2_extract_lane::<0>(radii);
        let negative = f64x2_extract_lane::<1>(radii);
        if !positive.is_finite() || !negative.is_finite() {
            return None;
        }
        let high = self.pressure(positive);
        let low = self.pressure(negative);
        (high.is_finite() && high >= 0.0 && low.is_finite() && low >= 0.0).then_some(high - low)
    }

    fn gradient_speed(&self, radius: f64) -> f64 {
        if self.family == 0.0 {
            if radius <= 0.0 {
                return 0.0;
            }
            let scaled = pow(self.radius / radius, self.shape);
            if !scaled.is_finite() {
                return 0.0;
            }
            let forcing = (self.shape * self.deficit * scaled * exp(-scaled)) / self.density;
            let half = (radius * self.coriolis) / 2.0;
            if forcing > 0.0 {
                forcing / (sqrt(forcing + half * half) + half)
            } else {
                0.0
            }
        } else {
            let q = radius / self.radius;
            if !(q > 0.0) {
                return 0.0;
            }
            if self.family == 1.0 {
                if q <= 1.0 {
                    self.peak * q
                } else {
                    self.peak * pow(1.0 / q, self.decay)
                }
            } else {
                let scaled = q * BURGERS_PEAK_RADIUS;
                (self.peak * one_minus_decay(scaled * scaled)) / (BURGERS_PEAK_WIND * scaled)
            }
        }
    }

    fn wind(&self, dx: f64, dz: f64, height_factor: f64) -> (f64, f64) {
        let radius = length(dx, dz);
        let mut speed = self.gradient_speed(radius);
        if self.secondary_radius > 0.0 {
            let q = (radius - self.secondary_radius) / self.secondary_width;
            speed = speed.max(self.secondary_strength * self.peak * exp(-q * q));
        }
        let s = if radius > 0.0 {
            (speed * self.surface * height_factor) / radius
        } else {
            0.0
        };
        let radial = self.radial * s;
        let tangent = self.tangential * self.spin * s;
        (tangent * dz - radial * dx, -tangent * dx - radial * dz)
    }

    fn height_factor(&self, y: f64) -> f64 {
        let h = (y - self.ground).max(0.0);
        if h < 10.0 {
            ln(h.max(self.roughness) / self.roughness) / ln(10.0 / self.roughness)
        } else {
            exp(-(h - 10.0) / self.height)
        }
    }
}

#[repr(C)]
struct Geometry {
    dx: f64,
    dz: f64,
    origin_x: f64,
    origin_z: f64,
    offset_x: f64,
    offset_z: f64,
    sample_y: f64,
    density: f64,
    time: f64,
}

#[repr(C)]
struct Work {
    cells: f64,
    wet_cells: f64,
    pressure_samples: f64,
    wind_samples: f64,
    paired_radius_lanes: f64,
}

#[repr(C)]
struct Job {
    depths: *const f32,
    profile: *const Profile,
    geometry: *const Geometry,
    output: *mut [f64; 5],
    work: *mut Work,
    width: NonZeroUsize,
    depth: usize,
    wind: u32,
}

const _: [(); 32] = [(); size_of::<Job>()];

fn centre_delta(coord: v128, centre: f64, translation: f64) -> v128 {
    f64x2_sub(
        f64x2_sub(coord, f64x2_splat(centre)),
        f64x2_splat(translation),
    )
}

#[unsafe(no_mangle)]
unsafe extern "C" fn vortex_water_thread_phase(
    job: &Job,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    let Some(parts) = NonZeroU64::new(u64::from(parts)) else {
        return 1;
    };
    if stage != 0 || u64::from(part) >= parts.get() {
        return 1;
    }
    let width = job.width.get();
    let Some(count) = width.checked_mul(job.depth) else {
        return 1;
    };
    let start = (count as u64 * u64::from(part) / parts.get()) as usize;
    let end = (count as u64 * u64::from(part + 1) / parts.get()) as usize;
    let profile = unsafe { &*job.profile };
    let grid = unsafe { &*job.geometry };
    let wind = job.wind != 0;
    let height_factor = if wind {
        profile.height_factor(grid.sample_y)
    } else {
        0.0
    };
    let tx = profile.vx * grid.time;
    let tz = profile.vz * grid.time;
    let mut wet_cells = 0.0;
    for i in start..end {
        let h = f64::from(unsafe { *job.depths.add(i) });
        if !h.is_finite() {
            return 1;
        }
        let out = unsafe { &mut *job.output.add(i) };
        if h <= 0.0 {
            *out = [0.0; 5];
            continue;
        }
        if wind && !(grid.sample_y - profile.ground).is_finite() {
            return 1;
        }
        let x = grid.origin_x + (i % width) as f64 * grid.dx + grid.offset_x;
        let z = grid.origin_z + (i / width) as f64 * grid.dz + grid.offset_z;
        let dx = x - profile.cx - tx;
        let dz = z - profile.cz - tz;
        if !dx.is_finite() || !dz.is_finite() {
            return 1;
        }
        let dx_faces = centre_delta(f64x2(x + grid.dx / 2.0, x - grid.dx / 2.0), profile.cx, tx);
        let dz_faces = centre_delta(f64x2(z + grid.dz / 2.0, z - grid.dz / 2.0), profile.cz, tz);
        let rx = paired_length(dx_faces, f64x2_splat(dz));
        let rz = paired_length(f64x2_splat(dx), dz_faces);
        let Some(dpx) = profile.pressure_difference(rx) else {
            return 1;
        };
        let Some(dpz) = profile.pressure_difference(rz) else {
            return 1;
        };
        let mut fx = (h * dpx) / grid.dx;
        let mut fz = (h * dpz) / grid.dz;
        if wind {
            let (u, v) = profile.wind(dx, dz, height_factor);
            let speed = length(u, v);
            if !speed.is_finite() {
                return 1;
            }
            let drag = 0.0026_f64.min((0.75 + 0.067 * speed) * 1e-3);
            let stress = profile.density * drag * speed;
            fx += stress * u;
            fz += stress * v;
        }
        fx /= grid.density;
        fz /= grid.density;
        if !fx.is_finite() || !fz.is_finite() {
            return 1;
        }
        *out = [fx, fz, 0.0, 0.0, 0.0];
        wet_cells += 1.0;
    }
    unsafe {
        job.work.add(part as usize).write(Work {
            cells: (end - start) as f64,
            wet_cells,
            pressure_samples: 4.0 * wet_cells,
            wind_samples: if wind { wet_cells } else { 0.0 },
            paired_radius_lanes: 4.0 * wet_cells,
        })
    };
    0
}
