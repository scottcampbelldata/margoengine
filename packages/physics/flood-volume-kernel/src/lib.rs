#![no_std]

use core::arch::wasm32::{
    f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_le, f64x2_mul, f64x2_splat,
    f64x2_sub, i64x2_all_true, v128, v128_store,
};
use core::num::NonZeroU64;

const NONFINITE: i32 = 1;
const INVALID_JOB: i32 = 2;
type Point = [f64; 3];

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Work {
    projected_vertices: f64,
    planes: f64,
    triangle_visits: f64,
    triangle_pairs: f64,
    intersection_pairs: f64,
    fan_pairs: f64,
}

#[repr(C)]
pub struct Job {
    vertices: *const Point,
    triangles: *const [u32; 3],
    projected: *mut f64,
    heights: *const f64,
    volumes: *mut f64,
    work: *mut Work,
    vertex_count: usize,
    triangle_count: usize,
    plane_count: usize,
    _reserved: u32,
    up: Point,
}

fn finite(value: v128) -> bool {
    i64x2_all_true(f64x2_le(f64x2_abs(value), f64x2_splat(f64::MAX)))
}

fn pair(a: Point, b: Point) -> [v128; 3] {
    [f64x2(a[0], b[0]), f64x2(a[1], b[1]), f64x2(a[2], b[2])]
}

/// # Safety
/// All input/staged output ranges must be aligned, correctly sized and disjoint. Only the leader
/// runs this projection, and the caller joins before clipping reads it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flood_volume_project(job: &Job) -> i32 {
    let [ux, uy, uz] = job.up;
    let mut i = 0;
    unsafe {
        while i + 1 < job.vertex_count {
            let [x, y, z] = pair(*job.vertices.add(i), *job.vertices.add(i + 1));
            let result = f64x2_add(
                f64x2_add(f64x2_mul(f64x2_splat(ux), x), f64x2_mul(f64x2_splat(uy), y)),
                f64x2_mul(f64x2_splat(uz), z),
            );
            if !finite(result) {
                return NONFINITE;
            }
            v128_store(job.projected.add(i).cast(), result);
            i += 2;
        }
        if i < job.vertex_count {
            let [x, y, z] = *job.vertices.add(i);
            let result = ux * x + uy * y + uz * z;
            if !result.is_finite() {
                return NONFINITE;
            }
            *job.projected.add(i) = result;
        }
        (*job.work).projected_vertices = job.vertex_count as f64;
    }
    0
}

struct Polygon {
    points: [Point; 4],
    len: usize,
}

impl Polygon {
    fn new() -> Self {
        Self {
            points: [[0.0; 3]; 4],
            len: 0,
        }
    }

    fn push(&mut self, p: Point) {
        // A triangle clipped against one plane emits at most four points.
        unsafe { *self.points.get_unchecked_mut(self.len) = p };
        self.len += 1;
    }

    fn relative(&self, fan: usize, origin: Point) -> [Point; 3] {
        // The caller enumerates exactly the extant triangles of the clipped polygon's fan.
        [0, fan + 1, fan + 2].map(|i| {
            let p = unsafe { *self.points.get_unchecked(i) };
            [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]
        })
    }
}

fn lerp(a: Point, b: Point, ratio: f64) -> Point {
    [0, 1, 2].map(|i| a[i] + ratio * (b[i] - a[i]))
}

fn intersect(a: Point, b: Point, numerator: f64, end: f64) -> Option<Point> {
    let denom = numerator - end;
    denom.is_finite().then(|| lerp(a, b, numerator / denom))
}

fn paired_edge(
    [a, b]: [Point; 2],
    [da, db]: [v128; 2],
    left: &mut Polygon,
    right: &mut Polygon,
    intersections: &mut f64,
) -> Option<()> {
    let a0 = f64x2_extract_lane::<0>(da);
    let b0 = f64x2_extract_lane::<0>(db);
    let a1 = f64x2_extract_lane::<1>(da);
    let b1 = f64x2_extract_lane::<1>(db);
    let keep0 = a0 <= 0.0;
    let keep1 = a1 <= 0.0;
    if keep0 {
        left.push(a);
    }
    if keep1 {
        right.push(a);
    }
    match (keep0 != (b0 <= 0.0), keep1 != (b1 <= 0.0)) {
        (true, true) => {
            let denom = f64x2_sub(da, db);
            if !finite(denom) {
                return None;
            }
            let ratio = f64x2_div(da, denom);
            let [x, y, z] = [0, 1, 2].map(|i| {
                f64x2_add(
                    f64x2_splat(a[i]),
                    f64x2_mul(ratio, f64x2_splat(b[i] - a[i])),
                )
            });
            left.push([
                f64x2_extract_lane::<0>(x),
                f64x2_extract_lane::<0>(y),
                f64x2_extract_lane::<0>(z),
            ]);
            right.push([
                f64x2_extract_lane::<1>(x),
                f64x2_extract_lane::<1>(y),
                f64x2_extract_lane::<1>(z),
            ]);
            *intersections += 1.0;
        }
        (true, false) => left.push(intersect(a, b, a0, b0)?),
        (false, true) => right.push(intersect(a, b, a1, b1)?),
        (false, false) => {}
    }
    Some(())
}

fn tetra([a, b, c]: [Point; 3]) -> f64 {
    (a[0] * (b[1] * c[2] - b[2] * c[1])
        + a[1] * (b[2] * c[0] - b[0] * c[2])
        + a[2] * (b[0] * c[1] - b[1] * c[0]))
        / 6.0
}

fn paired_tetra([a, b, c]: [Point; 3], [d, e, f]: [Point; 3]) -> v128 {
    let a = pair(a, d);
    let b = pair(b, e);
    let c = pair(c, f);
    let term = |i: usize, j: usize, k: usize| {
        f64x2_mul(
            a[i],
            f64x2_sub(f64x2_mul(b[j], c[k]), f64x2_mul(b[k], c[j])),
        )
    };
    f64x2_div(
        f64x2_add(f64x2_add(term(0, 1, 2), term(1, 2, 0)), term(2, 0, 1)),
        f64x2_splat(6.0),
    )
}

struct Mesh<'a> {
    vertices: &'a [Point],
    triangles: &'a [[u32; 3]],
    projected: &'a [f64],
}

impl Mesh<'_> {
    fn triangle(&self, indices: [u32; 3]) -> Option<([Point; 3], [f64; 3])> {
        let [a, b, c] = indices.map(|i| i as usize);
        Some((
            [
                *self.vertices.get(a)?,
                *self.vertices.get(b)?,
                *self.vertices.get(c)?,
            ],
            [
                *self.projected.get(a)?,
                *self.projected.get(b)?,
                *self.projected.get(c)?,
            ],
        ))
    }

    fn clipped_pair(&self, levels: [f64; 2], up: Point, work: &mut Work) -> Option<[f64; 2]> {
        let origins = levels.map(|h| up.map(|u| u * h));
        let heights = f64x2(levels[0], levels[1]);
        let mut sum = [0.0, 0.0];
        let mut left = Polygon::new();
        let mut right = Polygon::new();
        for &triangle in self.triangles {
            let (points, projection) = self.triangle(triangle)?;
            let d = projection.map(|s| f64x2_sub(f64x2_splat(s), heights));
            if !d.into_iter().all(finite) {
                return None;
            }
            left.len = 0;
            right.len = 0;
            let [a, b, c] = points;
            let [da, db, dc] = d;
            for (edge, distance) in [([a, b], [da, db]), ([b, c], [db, dc]), ([c, a], [dc, da])] {
                paired_edge(
                    edge,
                    distance,
                    &mut left,
                    &mut right,
                    &mut work.intersection_pairs,
                )?;
            }
            let left_count = left.len.saturating_sub(2);
            let right_count = right.len.saturating_sub(2);
            let overlap = left_count.min(right_count);
            // A lane sees every fan in the same order as the single-plane implementation.
            for fan in 0..overlap {
                let next = paired_tetra(
                    left.relative(fan, origins[0]),
                    right.relative(fan, origins[1]),
                );
                sum[0] += f64x2_extract_lane::<0>(next);
                sum[1] += f64x2_extract_lane::<1>(next);
            }
            work.fan_pairs += overlap as f64;
            for fan in overlap..left_count {
                sum[0] += tetra(left.relative(fan, origins[0]));
            }
            for fan in overlap..right_count {
                sum[1] += tetra(right.relative(fan, origins[1]));
            }
        }
        sum.into_iter().all(f64::is_finite).then_some(sum)
    }

    fn clipped(&self, height: f64, up: Point) -> Option<f64> {
        let origin = up.map(|u| u * height);
        let mut sum = 0.0;
        let mut poly = Polygon::new();
        for &triangle in self.triangles {
            let (points, projection) = self.triangle(triangle)?;
            let d = projection.map(|p| p - height);
            if !d.into_iter().all(f64::is_finite) {
                return None;
            }
            poly.len = 0;
            for (a, b) in [(0, 1), (1, 2), (2, 0)] {
                let keep = d[a] <= 0.0;
                if keep {
                    poly.push(points[a]);
                }
                if keep != (d[b] <= 0.0) {
                    poly.push(intersect(points[a], points[b], d[a], d[b])?);
                }
            }
            for fan in 0..poly.len.saturating_sub(2) {
                sum += tetra(poly.relative(fan, origin));
            }
        }
        sum.is_finite().then_some(sum)
    }
}

/// # Safety
/// Input mesh/projections and heights stay immutable. Output and work writes are disjoint
/// between participants. The caller joins all participants before reading any results.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flood_volume_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(partition) = NonZeroU64::new(parts as u64) else {
        return INVALID_JOB;
    };
    if stage != 0 || part >= parts {
        return INVALID_JOB;
    }
    let pairs = (job.plane_count / 2) as u64;
    let lo = 2 * (pairs * part as u64 / partition) as usize;
    let hi = if part + 1 == parts {
        job.plane_count
    } else {
        2 * (pairs * (part + 1) as u64 / partition) as usize
    };
    unsafe {
        let mesh = Mesh {
            vertices: core::slice::from_raw_parts(job.vertices, job.vertex_count),
            triangles: core::slice::from_raw_parts(job.triangles, job.triangle_count),
            projected: core::slice::from_raw_parts(job.projected, job.vertex_count),
        };
        let work = &mut *job.work.add(part);
        let mut i = lo;
        while i + 1 < hi {
            let heights = [*job.heights.add(i), *job.heights.add(i + 1)];
            let Some([a, b]) = mesh.clipped_pair(heights, job.up, work) else {
                return NONFINITE;
            };
            *job.volumes.add(i) = a;
            *job.volumes.add(i + 1) = b;
            i += 2;
        }
        if i < hi {
            let Some(volume) = mesh.clipped(*job.heights.add(i), job.up) else {
                return NONFINITE;
            };
            *job.volumes.add(i) = volume;
        }
        let planes = (hi - lo) as f64;
        let triangles = job.triangle_count as f64;
        work.planes = planes;
        work.triangle_visits = planes * triangles;
        work.triangle_pairs = ((hi - lo) / 2) as f64 * triangles;
    }
    0
}
