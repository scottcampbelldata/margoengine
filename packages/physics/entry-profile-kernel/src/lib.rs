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
    levels: *const f64,
    areas: *mut f64,
    work: *mut Work,
    vertex_count: usize,
    triangle_count: usize,
    plane_count: usize,
    _reserved: u32,
    normal: Point,
}

fn finite(value: v128) -> bool {
    i64x2_all_true(f64x2_le(f64x2_abs(value), f64x2_splat(f64::MAX)))
}

fn projection(point: Point, normal: Point) -> f64 {
    (point[0] * normal[0] + point[1] * normal[1]) + point[2] * normal[2]
}

fn pair_projection(a: Point, b: Point, normal: Point) -> v128 {
    let x = f64x2_mul(f64x2(a[0], b[0]), f64x2_splat(normal[0]));
    let y = f64x2_mul(f64x2(a[1], b[1]), f64x2_splat(normal[1]));
    let z = f64x2_mul(f64x2(a[2], b[2]), f64x2_splat(normal[2]));
    f64x2_add(f64x2_add(x, y), z)
}

/// Project all vertices once (with a scalar odd tail), preserving the plane-clipping dot order.
/// # Safety
/// The aligned input and projected leases contain vertex_count rows and are disjoint.
/// The leader's receipt must be available for writing and the returned projection must join before clipping.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn entry_profile_project(job: &Job) -> i32 {
    let mut i = 0;
    unsafe {
        while i + 1 < job.vertex_count {
            let pair = pair_projection(*job.vertices.add(i), *job.vertices.add(i + 1), job.normal);
            if !finite(pair) {
                return NONFINITE;
            }
            v128_store(job.projected.add(i).cast(), pair);
            i += 2;
        }
        if i < job.vertex_count {
            let last = projection(*job.vertices.add(i), job.normal);
            if !last.is_finite() {
                return NONFINITE;
            }
            *job.projected.add(i) = last;
        }
        (*job.work).projected_vertices = job.vertex_count as f64;
    }
    0
}

struct Polygon {
    points: [Point; 4],
    count: usize,
}

impl Polygon {
    fn new() -> Self {
        Self {
            points: [[0.0; 3]; 4],
            count: 0,
        }
    }

    fn push(&mut self, point: Point) {
        // A triangle clipped against one plane has at most four retained/crossing points.
        unsafe { *self.points.get_unchecked_mut(self.count) = point };
        self.count += 1;
    }

    fn fan(&self, i: usize) -> (Point, Point) {
        let origin = self.points[0];
        // Callers enumerate exactly the triangles of this clipped polygon's fan.
        let a = unsafe { *self.points.get_unchecked(i + 1) };
        let b = unsafe { *self.points.get_unchecked(i + 2) };
        (
            [a[0] - origin[0], a[1] - origin[1], a[2] - origin[2]],
            [b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]],
        )
    }
}

fn interpolate(a: Point, b: Point, ratio: f64) -> Point {
    [
        a[0] + ratio * (b[0] - a[0]),
        a[1] + ratio * (b[1] - a[1]),
        a[2] + ratio * (b[2] - a[2]),
    ]
}

fn pair_interpolate(a: Point, b: Point, ratio: v128) -> (Point, Point) {
    let at = |axis: usize| {
        // Axes are exactly the three coordinate indices below.
        let start = unsafe { *a.get_unchecked(axis) };
        let end = unsafe { *b.get_unchecked(axis) };
        f64x2_add(
            f64x2_splat(start),
            f64x2_mul(ratio, f64x2_splat(end - start)),
        )
    };
    let (x, y, z) = (at(0), at(1), at(2));
    (
        [
            f64x2_extract_lane::<0>(x),
            f64x2_extract_lane::<0>(y),
            f64x2_extract_lane::<0>(z),
        ],
        [
            f64x2_extract_lane::<1>(x),
            f64x2_extract_lane::<1>(y),
            f64x2_extract_lane::<1>(z),
        ],
    )
}

fn cross((u, v): (Point, Point)) -> Point {
    [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ]
}

fn pair_fan((u, v): (Point, Point), (w, x): (Point, Point), normal: Point) -> v128 {
    let term = |j: usize, k: usize| {
        // Axes are exactly the three cyclic coordinate index pairs below.
        let (u1, u2, v1, v2, w1, w2, x1, x2) = unsafe {
            (
                *u.get_unchecked(j),
                *u.get_unchecked(k),
                *v.get_unchecked(j),
                *v.get_unchecked(k),
                *w.get_unchecked(j),
                *w.get_unchecked(k),
                *x.get_unchecked(j),
                *x.get_unchecked(k),
            )
        };
        f64x2_sub(
            f64x2_mul(f64x2(u1, w1), f64x2(v2, x2)),
            f64x2_mul(f64x2(u2, w2), f64x2(v1, x1)),
        )
    };
    let x = f64x2_mul(term(1, 2), f64x2_splat(normal[0]));
    let y = f64x2_mul(term(2, 0), f64x2_splat(normal[1]));
    let z = f64x2_mul(term(0, 1), f64x2_splat(normal[2]));
    f64x2_mul(f64x2_splat(0.5), f64x2_add(f64x2_add(x, y), z))
}

fn clip_edge(
    a: Point,
    b: Point,
    da: v128,
    db: v128,
    first: &mut Polygon,
    second: &mut Polygon,
    paired: bool,
    intersections: &mut f64,
) -> Option<()> {
    let a0 = f64x2_extract_lane::<0>(da);
    let b0 = f64x2_extract_lane::<0>(db);
    let a1 = f64x2_extract_lane::<1>(da);
    let b1 = f64x2_extract_lane::<1>(db);
    let keep0 = a0 <= 0.0;
    let keep1 = paired && a1 <= 0.0;
    if keep0 {
        first.push(a);
    }
    if keep1 {
        second.push(a);
    }
    let cross0 = keep0 != (b0 <= 0.0);
    let cross1 = paired && keep1 != (b1 <= 0.0);
    match (cross0, cross1) {
        (true, true) => {
            let denom = f64x2_sub(da, db);
            if !finite(denom) {
                return None;
            }
            let (p, q) = pair_interpolate(a, b, f64x2_div(da, denom));
            first.push(p);
            second.push(q);
            *intersections += 1.0;
        }
        (true, false) => {
            let denom = a0 - b0;
            if !denom.is_finite() {
                return None;
            }
            first.push(interpolate(a, b, a0 / denom));
        }
        (false, true) => {
            let denom = a1 - b1;
            if !denom.is_finite() {
                return None;
            }
            second.push(interpolate(a, b, a1 / denom));
        }
        (false, false) => {}
    }
    Some(())
}

unsafe fn clipped_pair(
    job: &Job,
    level0: f64,
    level1: f64,
    paired: bool,
    intersections: &mut f64,
    fan_pairs: &mut f64,
) -> Option<[f64; 2]> {
    let mut first = Polygon::new();
    let mut second = Polygon::new();
    let levels = f64x2(level0, level1);
    let mut sum = [0.0; 2];
    unsafe {
        for i in 0..job.triangle_count {
            let [a, b, c] = (*job.triangles.add(i)).map(|index| index as usize);
            if a >= job.vertex_count || b >= job.vertex_count || c >= job.vertex_count {
                return None;
            }
            let pa = *job.vertices.add(a);
            let pb = *job.vertices.add(b);
            let pc = *job.vertices.add(c);
            let da = f64x2_sub(f64x2_splat(*job.projected.add(a)), levels);
            let db = f64x2_sub(f64x2_splat(*job.projected.add(b)), levels);
            let dc = f64x2_sub(f64x2_splat(*job.projected.add(c)), levels);
            if !finite(da) || !finite(db) || !finite(dc) {
                return None;
            }
            first.count = 0;
            second.count = 0;
            clip_edge(
                pa,
                pb,
                da,
                db,
                &mut first,
                &mut second,
                paired,
                intersections,
            )?;
            clip_edge(
                pb,
                pc,
                db,
                dc,
                &mut first,
                &mut second,
                paired,
                intersections,
            )?;
            clip_edge(
                pc,
                pa,
                dc,
                da,
                &mut first,
                &mut second,
                paired,
                intersections,
            )?;
            let a_count = first.count.saturating_sub(2);
            let b_count = second.count.saturating_sub(2);
            let common = a_count.min(b_count);
            // Each lane sees fan terms in the original order. Extra terms stay scalar.
            for fan in 0..common {
                let term = pair_fan(first.fan(fan), second.fan(fan), job.normal);
                sum[0] += f64x2_extract_lane::<0>(term);
                sum[1] += f64x2_extract_lane::<1>(term);
                *fan_pairs += 1.0;
            }
            for fan in common..a_count {
                sum[0] += 0.5 * projection(cross(first.fan(fan)), job.normal);
            }
            for fan in common..b_count {
                sum[1] += 0.5 * projection(cross(second.fan(fan)), job.normal);
            }
        }
    }
    if sum.iter().any(|value| !value.is_finite()) {
        return None;
    }
    Some(sum.map(|s| if s < 0.0 { -s } else { 0.0 }))
}

/// Clip contiguous plane pairs with one lane per cut. Distinct participants write disjoint outputs.
/// # Safety
/// Vertex/triangle inputs and the joined projected buffer are immutable. The aligned level and area leases contain
/// plane_count rows. There is one work row per participant. Caller joins before reading the results.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn entry_profile_thread_phase(
    job: &Job,
    stage: usize,
    part: usize,
    parts: usize,
) -> i32 {
    let Some(parts_wide) = NonZeroU64::new(parts as u64) else {
        return INVALID_JOB;
    };
    if stage != 0 || part >= parts {
        return INVALID_JOB;
    }
    let pairs = (job.plane_count / 2) as u64;
    let lo = 2 * (pairs * part as u64 / parts_wide) as usize;
    let hi = if part + 1 == parts {
        job.plane_count
    } else {
        2 * (pairs * (part as u64 + 1) / parts_wide) as usize
    };
    let mut intersections = 0.0;
    let mut fans = 0.0;
    let mut i = lo;
    unsafe {
        while i < hi {
            let paired = i + 1 < hi;
            let level = *job.levels.add(i);
            let second = if paired {
                *job.levels.add(i + 1)
            } else {
                level
            };
            let Some([a, b]) =
                clipped_pair(job, level, second, paired, &mut intersections, &mut fans)
            else {
                return NONFINITE;
            };
            *job.areas.add(i) = a;
            if paired {
                *job.areas.add(i + 1) = b;
            }
            i += 2;
        }
        let out = job.work.add(part);
        (*out).planes = (hi - lo) as f64;
        (*out).triangle_visits = (hi - lo) as f64 * job.triangle_count as f64;
        (*out).triangle_pairs = ((hi - lo) / 2) as f64 * job.triangle_count as f64;
        (*out).intersection_pairs = intersections;
        (*out).fan_pairs = fans;
    }
    0
}
