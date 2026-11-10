// Clean-room span rasterization from Sutherland-Hodgman clipping; see docs/clean-room.md.
// Triangle classification remains at the JS boundary to preserve Math.hypot and slope thresholds exactly.
#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

type Vertex = [f64; 3];

#[derive(Default)]
pub struct Raster {
    head: Vec<i32>,
    bottom: Vec<i32>,
    top: Vec<i32>,
    next: Vec<i32>,
    walk: Vec<i32>,
    rise: Vec<i32>,
    intersections: u64,
    cells: u64,
}

fn int32(value: f64) -> i32 {
    if value.is_finite() {
        (value % 4294967296.0) as i64 as i32
    } else {
        0
    }
}

impl Raster {
    fn add(
        &mut self,
        column: usize,
        mut low: f64,
        mut high: f64,
        mut walk: i32,
        mut rise: i32,
        climb: f64,
    ) {
        let mut before = -1;
        let mut at = self.head[column];
        while at >= 0 && (self.top[at as usize] as f64) < low {
            before = at;
            at = self.next[at as usize];
        }
        while at >= 0 && (self.bottom[at as usize] as f64) <= high {
            let i = at as usize;
            low = low.min(self.bottom[i] as f64);
            let other = self.top[i] as f64;
            if (other - high).abs() <= climb {
                if self.walk[i] != 0 {
                    rise = if walk != 0 {
                        rise.max(self.rise[i])
                    } else {
                        self.rise[i]
                    };
                    walk = 1;
                }
            } else if other > high {
                walk = self.walk[i];
                rise = self.rise[i];
            }
            high = high.max(other);
            at = self.next[i];
        }
        let span = self.bottom.len() as i32;
        self.bottom.push(int32(low));
        self.top.push(int32(high));
        self.walk.push(walk);
        self.rise.push(rise);
        self.next.push(at);
        if before >= 0 {
            self.next[before as usize] = span;
        } else {
            self.head[column] = span;
        }
    }
}

#[inline]
fn lerp(a: Vertex, b: Vertex, t: f64) -> Vertex {
    #[cfg(target_arch = "wasm32")]
    {
        let av = f64x2(a[0], a[1]);
        let bv = f64x2(b[0], b[1]);
        let xy = f64x2_add(av, f64x2_mul(f64x2_splat(t), f64x2_sub(bv, av)));
        [
            f64x2_extract_lane::<0>(xy),
            f64x2_extract_lane::<1>(xy),
            a[2] + t * (b[2] - a[2]),
        ]
    }
    #[cfg(not(target_arch = "wasm32"))]
    [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
    ]
}

fn clip(
    from: &[Vertex],
    out: &mut [Vertex; 12],
    axis: usize,
    bound: f64,
    sign: f64,
    count: &mut u64,
) -> usize {
    let mut n = 0;
    for i in 0..from.len() {
        let a = from[i];
        let b = from[(i + 1) % from.len()];
        let di = sign * (a[axis] - bound);
        let dj = sign * (b[axis] - bound);
        if di >= 0.0 {
            out[n] = a;
            n += 1;
        }
        if (di >= 0.0) != (dj >= 0.0) {
            out[n] = lerp(a, b, di / (di - dj));
            n += 1;
            *count += 1;
        }
    }
    n
}

fn rasterize(triangles: &[f64], p: &[f64]) -> Raster {
    let width = p[0] as usize;
    let depth = p[1] as usize;
    let (ox, oy, oz, cx, cz, floor, cs, ch, climb, keep) = (
        p[2],
        p[3],
        p[4],
        p[5],
        p[6],
        p[7],
        p[8],
        p[9],
        p[10],
        p[11] != 0.0,
    );
    let mut out = Raster {
        head: vec![-1; width * depth],
        ..Raster::default()
    };
    let mut slab = [[0.0; 3]; 12];
    let mut strip = [[0.0; 3]; 12];
    let mut piece = [[0.0; 3]; 12];
    for t in triangles.chunks_exact(12) {
        let vertices = [[t[0], t[1], t[2]], [t[3], t[4], t[5]], [t[6], t[7], t[8]]];
        let walk = t[9] as i32;
        let rise = t[10] as i32;
        let wall = t[11] != 0.0;
        // Degenerate triangles are marked -1 by the identical JS metadata calculation.
        if walk < 0 {
            continue;
        }
        let mut x0 = f64::INFINITY;
        let mut x1 = f64::NEG_INFINITY;
        let mut z0 = f64::INFINITY;
        let mut z1 = f64::NEG_INFINITY;
        for v in vertices {
            x0 = x0.min(v[0]);
            x1 = x1.max(v[0]);
            z0 = z0.min(v[2]);
            z1 = z1.max(v[2]);
        }
        if keep
            && (((x1 - ox) / cs).ceil() - cx <= 0.0
                || ((x0 - ox) / cs).floor() - cx >= width as f64)
        {
            continue;
        }
        if keep
            && (((z1 - oz) / cs).ceil() - cz <= 0.0
                || ((z0 - oz) / cs).floor() - cz >= depth as f64)
        {
            continue;
        }
        let cx0 = (((x0 - ox) / cs).floor() - cx)
            .max(0.0)
            .min((width - 1) as f64) as usize;
        let cx1 = (((x1 - ox) / cs).ceil() - 1.0 - cx)
            .max(cx0 as f64)
            .min((width - 1) as f64) as usize;
        let cz0 = (((z0 - oz) / cs).floor() - cz)
            .max(0.0)
            .min((depth - 1) as f64) as usize;
        let cz1 = (((z1 - oz) / cs).ceil() - 1.0 - cz)
            .max(cz0 as f64)
            .min((depth - 1) as f64) as usize;
        for z in cz0..=cz1 {
            let n = clip(
                &vertices,
                &mut slab,
                2,
                oz + (cz + z as f64) * cs,
                1.0,
                &mut out.intersections,
            );
            let rows = clip(
                &slab[..n],
                &mut strip,
                2,
                oz + (cz + z as f64 + 1.0) * cs,
                -1.0,
                &mut out.intersections,
            );
            if rows == 0 {
                continue;
            }
            for x in cx0..=cx1 {
                out.cells += 1;
                let n = clip(
                    &strip[..rows],
                    &mut slab,
                    0,
                    ox + (cx + x as f64) * cs,
                    1.0,
                    &mut out.intersections,
                );
                let m = clip(
                    &slab[..n],
                    &mut piece,
                    0,
                    ox + (cx + x as f64 + 1.0) * cs,
                    -1.0,
                    &mut out.intersections,
                );
                if m == 0 {
                    continue;
                }
                let mut low = f64::INFINITY;
                let mut high = f64::NEG_INFINITY;
                let mut area = 0.0;
                for i in 0..m {
                    let a = piece[i];
                    let b = piece[(i + 1) % m];
                    low = low.min(a[1]);
                    high = high.max(a[1]);
                    area += a[0] * b[2] - b[0] * a[2];
                }
                if !wall && area.abs() <= 1e-9 * cs * cs {
                    continue;
                }
                let bottom = floor.max(((low - oy) / ch).floor());
                let top = (bottom + 1.0).max(((high - oy) / ch).floor() + 1.0);
                out.add(z * width + x, bottom, top, walk, rise, climb);
            }
        }
    }
    out
}

#[no_mangle]
pub extern "C" fn allocate(n: usize) -> *mut f64 {
    Box::into_raw(vec![0.0; n].into_boxed_slice()) as *mut f64
}

/// Inputs are allocations of n*12 and 12 f64 values, transferred to this call.
#[no_mangle]
pub unsafe extern "C" fn raster(input: *mut f64, n: usize, settings: *mut f64) -> *mut Raster {
    let data = Box::from_raw(core::ptr::slice_from_raw_parts_mut(input, n * 12));
    let params = Box::from_raw(core::ptr::slice_from_raw_parts_mut(settings, 12));
    Box::into_raw(Box::new(rasterize(&data, &params)))
}
#[no_mangle]
pub unsafe extern "C" fn array(result: *const Raster, field: usize) -> *const i32 {
    let r = &*result;
    match field {
        0 => r.head.as_ptr(),
        1 => r.bottom.as_ptr(),
        2 => r.top.as_ptr(),
        3 => r.next.as_ptr(),
        4 => r.walk.as_ptr(),
        _ => r.rise.as_ptr(),
    }
}
#[no_mangle]
pub unsafe extern "C" fn count(result: *const Raster) -> usize {
    (*result).bottom.len()
}
#[no_mangle]
pub unsafe extern "C" fn work(result: *const Raster, field: usize) -> u64 {
    if field == 0 {
        (*result).intersections
    } else {
        (*result).cells
    }
}
#[no_mangle]
pub unsafe extern "C" fn free_result(result: *mut Raster) {
    drop(Box::from_raw(result));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interpolation_and_half_plane_preserve_coordinates() {
        assert_eq!(
            lerp([1.0, 2.0, 3.0], [5.0, 6.0, 7.0], 0.25),
            [2.0, 3.0, 4.0]
        );
        let mut count = 0;
        let mut cut = [[0.0; 3]; 12];
        let n = clip(
            &[[0.0, 0.0, 0.0], [2.0, 1.0, 0.0], [0.0, 0.0, 2.0]],
            &mut cut,
            0,
            1.0,
            1.0,
            &mut count,
        );
        assert_eq!(count, 2);
        assert_eq!(n, 3);
        assert!(cut[..n].iter().all(|p| p[0] >= 1.0));
    }
    #[test]
    fn flat_floor_raster_and_span_merge_are_deterministic() {
        let data = [
            0., 0., 0., 4., 0., 0., 4., 0., 4., 1., 0., 0., 0., 0., 0., 4., 0., 4., 0., 0., 4., 1.,
            0., 0.,
        ];
        let p = [4., 4., 0., 0., 0., 0., 0., 0., 1., 0.1, 2., 0.];
        let r = rasterize(&data, &p);
        assert!(r.head.iter().all(|&h| h >= 0));
        for &h in &r.head {
            assert_eq!(r.bottom[h as usize], 0);
            assert_eq!(r.top[h as usize], 1);
            assert_eq!(r.walk[h as usize], 1);
        }
        assert!(r.intersections > 0);
        assert!(r.cells >= 16);
    }
}
