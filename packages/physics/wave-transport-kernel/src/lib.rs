#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_ge, f64x2_gt, f64x2_le, f64x2_lt,
    f64x2_mul, f64x2_ne, f64x2_splat, f64x2_sub, v128, v128_and, v128_bitselect, v128_load,
    v128_store,
};
use core::num::NonZeroUsize;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Job {
    before: *const f64,
    after: *mut f64,
    depth: *const f64,
    group_velocity: *const f64,
    direction_x: *const f64,
    direction_z: *const f64,
    swell: *const f64,
    work: *mut Work,
    nx: usize,
    nz: usize,
    nf: usize,
    nd: usize,
    axis: u32,
    wrap_x: u32,
    wrap_z: u32,
    reserved: u32,
    dt: f64,
    h: f64,
}

#[repr(C)]
#[derive(Default)]
struct Work {
    fluxes: f64,
    paired_fluxes: f64,
    quickest_fluxes: f64,
    updates: f64,
    paired_updates: f64,
}

const _: [(); 80] = [(); core::mem::size_of::<Job>()];
const _: [(); 40] = [(); core::mem::size_of::<Work>()];

struct Line<'a> {
    job: &'a Job,
    per: usize,
    directions: NonZeroUsize,
    q: usize,
    along: isize,
    wrap: bool,
    x_axis: bool,
}

#[derive(Clone, Copy)]
struct Stencil {
    speed: f64,
    c: f64,
    nc: f64,
    nu: f64,
    nd: f64,
    quickest: bool,
}

/// QUICKEST interpolation and the ULTIMATE limiter, Leonard (1991),
/// doi:10.1016/0045-7825(91)90232-U, and WW3 v5.16 §3.3.3, Eqs. 3.12–3.23.
/// The first-order edge decision and the operation order match the existing scalar sweep.
fn scalar_flux(s: Stencil) -> f64 {
    let Stencil {
        speed,
        c,
        nc,
        nu,
        nd,
        quickest,
    } = s;
    if !quickest {
        return speed * nc;
    }
    let curvature = nu - 2.0 * nc + nd;
    let mut face = 0.5 * ((1.0 + c) * nc + (1.0 - c) * nd) - ((1.0 - c * c) / 6.0) * curvature;
    let span = nd - nu;
    if span != 0.0 {
        let tc = (nc - nu) / span;
        if tc >= 0.0 && tc <= 1.0 {
            let mut tb = (face - nu) / span;
            let top = if c > 0.0 && tc / c < 1.0 { tc / c } else { 1.0 };
            if tb < tc {
                tb = tc;
            }
            if tb > top {
                tb = top;
            }
            face = nu + tb * span;
        } else {
            face = nc;
        }
    } else {
        face = nc;
    }
    speed * face
}

fn paired_flux(a: Stencil, b: Stencil) -> v128 {
    let speed = f64x2(a.speed, b.speed);
    let nc = f64x2(a.nc, b.nc);
    if !a.quickest && !b.quickest {
        return f64x2_mul(speed, nc);
    }
    let one = f64x2_splat(1.0);
    let zero = f64x2_splat(0.0);
    let c = f64x2(a.c, b.c);
    let nu = f64x2(a.nu, b.nu);
    let nd = f64x2(a.nd, b.nd);
    let curvature = f64x2_add(f64x2_sub(nu, f64x2_mul(f64x2_splat(2.0), nc)), nd);
    let central = f64x2_add(
        f64x2_mul(f64x2_add(one, c), nc),
        f64x2_mul(f64x2_sub(one, c), nd),
    );
    let correction = f64x2_div(f64x2_sub(one, f64x2_mul(c, c)), f64x2_splat(6.0));
    let face = f64x2_sub(
        f64x2_mul(f64x2_splat(0.5), central),
        f64x2_mul(correction, curvature),
    );
    let span = f64x2_sub(nd, nu);
    let tc = f64x2_div(f64x2_sub(nc, nu), span);
    let tb = f64x2_div(f64x2_sub(face, nu), span);
    let tc_over_c = f64x2_div(tc, c);
    let top = v128_bitselect(
        tc_over_c,
        one,
        v128_and(f64x2_gt(c, zero), f64x2_lt(tc_over_c, one)),
    );
    let lower = v128_bitselect(tc, tb, f64x2_lt(tb, tc));
    let clipped = v128_bitselect(top, lower, f64x2_gt(lower, top));
    let reconstructed = f64x2_add(nu, f64x2_mul(clipped, span));
    let monotone = v128_and(f64x2_ge(tc, zero), f64x2_le(tc, one));
    let quickest = f64x2_ne(f64x2(f64::from(a.quickest), f64::from(b.quickest)), zero);
    let active = v128_and(quickest, v128_and(f64x2_ne(span, zero), monotone));
    f64x2_mul(speed, v128_bitselect(reconstructed, nc, active))
}

#[inline]
fn finite_pair(value: v128) -> bool {
    f64x2_extract_lane::<0>(value).is_finite() && f64x2_extract_lane::<1>(value).is_finite()
}

impl Line<'_> {
    fn cell(&self, p: isize) -> Option<usize> {
        // A face requests positions only in [-2, along + 1].
        let p = if self.wrap && self.along == 1 {
            0
        } else if self.wrap && p < 0 {
            p + self.along
        } else if self.wrap && p >= self.along {
            p - self.along
        } else if (0..self.along).contains(&p) {
            p
        } else {
            return None;
        } as usize;
        Some(if self.x_axis {
            p + self.job.nx * self.q
        } else {
            self.q + self.job.nx * p
        })
    }

    fn wet(&self, cell: Option<usize>) -> Option<usize> {
        cell.filter(|&id| unsafe { *self.job.depth.add(id) > 0.0 })
    }

    fn value(&self, cell: Option<usize>, bin: usize) -> f64 {
        if let Some(cell) = cell {
            if self.wet(Some(cell)).is_some() {
                unsafe { *self.job.before.add(cell * self.per + bin) }
            } else {
                0.0
            }
        } else if self.job.swell.is_null() {
            0.0
        } else {
            unsafe { *self.job.swell.add(bin) }
        }
    }

    fn stencil(
        &self,
        p: isize,
        bin: usize,
        left: Option<usize>,
        right: Option<usize>,
    ) -> Option<Stencil> {
        let lw = self.wet(left);
        let rw = self.wet(right);
        let direction_pointer = if self.x_axis {
            self.job.direction_x
        } else {
            self.job.direction_z
        };
        let direction = unsafe { *direction_pointer.add(bin % self.directions) };
        let f = bin / self.directions;
        let cg = |cell| unsafe { *self.job.group_velocity.add(cell * self.job.nf + f) };
        let speed = match (lw, rw) {
            (Some(l), Some(r)) => 0.5 * (cg(l) + cg(r)),
            (Some(cell), None) | (None, Some(cell)) => cg(cell),
            (None, None) => return None,
        } * direction;
        let (upstream, downstream, far) = if speed >= 0.0 {
            (left, right, self.cell(p - 2))
        } else {
            (right, left, self.cell(p + 1))
        };
        let nc = self.value(upstream, bin);
        let quickest = lw.is_some() && rw.is_some() && self.wet(far).is_some();
        let courant = speed * self.job.dt / self.job.h;
        Some(Stencil {
            speed,
            c: if courant < 0.0 { -courant } else { courant },
            nc,
            nu: if quickest { self.value(far, bin) } else { 0.0 },
            nd: if quickest {
                self.value(downstream, bin)
            } else {
                0.0
            },
            quickest,
        })
    }

    fn single(&self, bin: usize, work: &mut Work) -> bool {
        let dt_h = self.job.dt / self.job.h;
        let mut prior = 0.0;
        for p in 0..=self.along {
            let left = self.cell(p - 1);
            let right = self.cell(p);
            let flux = match self.stencil(p, bin, left, right) {
                None => 0.0,
                Some(stencil) => {
                    work.fluxes += 1.0;
                    work.quickest_fluxes += f64::from(stencil.quickest);
                    scalar_flux(stencil)
                }
            };
            if !flux.is_finite() {
                return false;
            }
            if p > 0
                && let Some(cell) = left
            {
                let at = cell * self.per + bin;
                let before = unsafe { *self.job.before.add(at) };
                let value = if self.wet(left).is_some() {
                    let next = before + dt_h * (prior - flux);
                    if !next.is_finite() {
                        return false;
                    }
                    work.updates += 1.0;
                    if next > 0.0 { next } else { 0.0 }
                } else {
                    before
                };
                unsafe { self.job.after.add(at).write(value) };
            }
            prior = flux;
        }
        true
    }

    fn paired(&self, bin: usize, work: &mut Work) -> bool {
        let zero = f64x2_splat(0.0);
        let dt_h = f64x2_splat(self.job.dt / self.job.h);
        let mut prior = zero;
        for p in 0..=self.along {
            let left = self.cell(p - 1);
            let right = self.cell(p);
            let flux = match (
                self.stencil(p, bin, left, right),
                self.stencil(p, bin + 1, left, right),
            ) {
                (Some(a), Some(b)) => {
                    work.fluxes += 2.0;
                    work.paired_fluxes += 2.0;
                    work.quickest_fluxes += f64::from(a.quickest) + f64::from(b.quickest);
                    paired_flux(a, b)
                }
                _ => zero,
            };
            if !finite_pair(flux) {
                return false;
            }
            if p > 0
                && let Some(cell) = left
            {
                let at = cell * self.per + bin;
                let before = unsafe { v128_load(self.job.before.add(at).cast()) };
                let value = if self.wet(left).is_some() {
                    let next = f64x2_add(before, f64x2_mul(dt_h, f64x2_sub(prior, flux)));
                    if !finite_pair(next) {
                        return false;
                    }
                    work.updates += 2.0;
                    work.paired_updates += 2.0;
                    v128_bitselect(next, zero, f64x2_gt(next, zero))
                } else {
                    before
                };
                unsafe { v128_store(self.job.after.add(at).cast(), value) };
            }
            prior = flux;
        }
        true
    }
}

/// Safety: this private buffer contains checked immutable spectra, geometry and disjoint output bins.
#[unsafe(no_mangle)]
unsafe extern "C" fn wave_transport_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if stage != 0 || !matches!(parts, 1 | 2 | 4) || part >= parts || job.axis > 1 {
        return 1;
    }
    let x_axis = job.axis == 0;
    let (along, across, wrap) = if x_axis {
        (job.nx, job.nz, job.wrap_x)
    } else {
        (job.nz, job.nx, job.wrap_z)
    };
    let per = job.nf * job.nd;
    let Some(directions) = NonZeroUsize::new(job.nd) else {
        return 1;
    };
    if along == 0 || across == 0 || per == 0 || !(job.dt > 0.0 && job.h > 0.0) {
        return 1;
    }
    let tasks_per_line = per.div_ceil(2);
    let tasks = across * tasks_per_line;
    let mut work = Work::default();
    for task in tasks * part / parts..tasks * (part + 1) / parts {
        let bin = 2 * (task % tasks_per_line);
        let line = Line {
            job,
            per,
            directions,
            q: task / tasks_per_line,
            along: along as isize,
            wrap: wrap != 0,
            x_axis,
        };
        let finite = if bin + 1 < per {
            line.paired(bin, &mut work)
        } else {
            line.single(bin, &mut work)
        };
        if !finite {
            return 2;
        }
    }
    unsafe { job.work.add(part).write(work) };
    0
}
