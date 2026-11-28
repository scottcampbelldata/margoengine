use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sub, v128,
};

#[repr(C)]
pub(crate) struct Sample {
    x: f64,
    y: f64,
    z: f64,
    depth_area: f64,
    cos_2b: f64,
    sin_2b: f64,
    cos_g: f64,
    sin_g: f64,
}

#[inline(never)]
fn pair_values(a: &Sample, b: &Sample, coefficients: &[v128; 9], x: f64, z: f64) -> [v128; 6] {
    let &[a00, a10, b11, b01, b_minus, c11, c01, c_minus, d10] = coefficients;
    let horizontal_x = f64x2_splat(x);
    let horizontal_z = f64x2_splat(z);
    let depth_area = f64x2(a.depth_area, b.depth_area);
    let cos_2b = f64x2(a.cos_2b, b.cos_2b);
    let sin_2b = f64x2(a.sin_2b, b.sin_2b);
    let cos_g = f64x2(a.cos_g, b.cos_g);
    let sin_g = f64x2(a.sin_g, b.sin_g);
    let cos_product = f64x2_mul(cos_2b, cos_g);
    let sin_product = f64x2_mul(sin_2b, sin_g);
    let mixed_a = f64x2_mul(cos_2b, sin_g);
    let mixed_b = f64x2_mul(sin_2b, cos_g);
    let alpha_y = f64x2_add(
        f64x2_add(
            f64x2_add(a00, f64x2_mul(a10, cos_2b)),
            f64x2_mul(b11, f64x2_add(mixed_a, mixed_b)),
        ),
        f64x2_add(
            f64x2_mul(b01, sin_g),
            f64x2_mul(b_minus, f64x2_sub(mixed_a, mixed_b)),
        ),
    );
    let alpha_h = f64x2_add(
        f64x2_add(
            f64x2_mul(c11, f64x2_sub(cos_product, sin_product)),
            f64x2_mul(c01, cos_g),
        ),
        f64x2_add(
            f64x2_mul(c_minus, f64x2_add(cos_product, sin_product)),
            f64x2_mul(d10, sin_2b),
        ),
    );
    let fy = f64x2_mul(depth_area, alpha_y);
    let fh = f64x2_mul(depth_area, alpha_h);
    let fx = f64x2_mul(fh, horizontal_x);
    let fz = f64x2_mul(fh, horizontal_z);
    let rx = f64x2(a.x, b.x);
    let ry = f64x2(a.y, b.y);
    let rz = f64x2(a.z, b.z);
    let tx = f64x2_sub(f64x2_mul(ry, fz), f64x2_mul(rz, fy));
    let ty = f64x2_sub(f64x2_mul(rz, fx), f64x2_mul(rx, fz));
    let tz = f64x2_sub(f64x2_mul(rx, fy), f64x2_mul(ry, fx));
    [fx, fy, fz, tx, ty, tz]
}

/// Li, Zhang and Goldman (2013), Eq. 2 and S8–S9. Each lane carries one independent buried element.
///
/// # Safety
/// The host owns aligned, disjoint arrays of nine coefficients, `count` samples and six output words.
/// The sample count is even. The host zero-pads the last lane if necessary.
#[unsafe(no_mangle)]
pub(crate) unsafe extern "C" fn resistive(
    coefficients: *const [f64; 9],
    samples: *const Sample,
    count: usize,
    horizontal_x: f64,
    horizontal_z: f64,
    forces: *mut [f64; 6],
) {
    let coefficients = (*coefficients).map(|value| f64x2_splat(value));
    let mut totals = [0.0; 6];
    for pair in 0..count / 2 {
        let a = &*samples.add(2 * pair);
        let b = &*samples.add(2 * pair + 1);
        let products = pair_values(a, b, &coefficients, horizontal_x, horizontal_z);
        for (total, values) in totals.iter_mut().zip(products) {
            *total += f64x2_extract_lane::<0>(values);
            *total += f64x2_extract_lane::<1>(values);
        }
    }
    *forces = totals;
}

#[repr(C)]
struct BodyRange {
    first: usize,
    count: usize,
    row: usize,
    _padding: u32,
    horizontal_x: f64,
    horizontal_z: f64,
}

impl BodyRange {
    fn end(&self) -> usize {
        self.first + (self.count + 1) / 2 * 2
    }
}

#[repr(C)]
#[derive(Default)]
struct Work {
    samples: f64,
    paired_samples: f64,
    simd_pairs: f64,
}

#[repr(C)]
struct Job {
    coefficients: *const [f64; 9],
    samples: *const Sample,
    ranges: *const BodyRange,
    values: *mut [f64; 6],
    forces: *mut [f64; 6],
    bodies: usize,
    sample_count: usize,
    work: *mut Work,
}

const _: [(); 32] = [(); core::mem::size_of::<BodyRange>()];
const _: [(); 32] = [(); core::mem::size_of::<Job>()];

/// Evaluate the local force law on disjoint pairs. The caller folds wrench words only after joining.
#[unsafe(no_mangle)]
unsafe extern "C" fn resistive_soil_thread_phase(
    job: &Job,
    stage: u32,
    part: u32,
    parts: u32,
) -> u32 {
    let Some(parts) = core::num::NonZeroU64::new(u64::from(parts)) else {
        return 1;
    };
    if stage != 0 || u64::from(part) >= parts.get() {
        return 1;
    }
    let pairs = (job.sample_count / 2) as u64;
    let start = 2 * (pairs * u64::from(part) / parts.get()) as usize;
    let finish = 2 * (pairs * u64::from(part + 1) / parts.get()) as usize;
    let mut work = Work::default();
    if start != finish {
        let coeff = unsafe { (*job.coefficients).map(|value| f64x2_splat(value)) };
        let ranges = unsafe { core::slice::from_raw_parts(job.ranges, job.bodies) };
        let first = ranges.partition_point(|range| range.end() <= start);
        for range in ranges.iter().skip(first) {
            let last = range.end().min(finish);
            let begin = start.max(range.first);
            if begin >= finish {
                break;
            }
            let live = last.min(range.first + range.count) - begin;
            work.samples += live as f64;
            work.paired_samples += (live & !1) as f64;
            work.simd_pairs += ((last - begin) / 2) as f64;
            for index in (begin..last).step_by(2) {
                let a = unsafe { &*job.samples.add(index) };
                let b = unsafe { &*job.samples.add(index + 1) };
                let values = pair_values(a, b, &coeff, range.horizontal_x, range.horizontal_z);
                unsafe {
                    job.values
                        .add(index)
                        .write(values.map(|v| f64x2_extract_lane::<0>(v)));
                    job.values
                        .add(index + 1)
                        .write(values.map(|v| f64x2_extract_lane::<1>(v)));
                }
            }
        }
    }
    unsafe { job.work.add(part as usize).write(work) };
    0
}

/// Preserve the original left-to-right sum for each body, including its odd padding lane.
#[unsafe(no_mangle)]
unsafe extern "C" fn resistive_soil_reduce(job: &Job) -> u32 {
    let ranges = unsafe { core::slice::from_raw_parts(job.ranges, job.bodies) };
    for range in ranges {
        let mut totals = [0.0; 6];
        for index in range.first..range.end() {
            let values = unsafe { &*job.values.add(index) };
            for (total, value) in totals.iter_mut().zip(values) {
                *total += *value;
            }
        }
        if totals.iter().any(|value| !value.is_finite()) {
            return 1;
        }
        unsafe { job.forces.add(range.row).write(totals) };
    }
    0
}
