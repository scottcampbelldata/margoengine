// Clean room: Bridson (2007), spatial neighbour rejection; Turk (1992 thesis),
// area-weighted triangle selection and reflected barycentric candidates.
use std::collections::HashMap;

#[unsafe(no_mangle)]
pub extern "C" fn allocate(len: usize) -> *mut f64 {
    Box::into_raw(vec![0.0; len].into_boxed_slice()) as *mut f64
}

/// The caller frees exactly a buffer returned by allocate or sample, once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(ptr: *mut f64, len: usize) {
    unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))) }
}

fn random(state: &mut u32) -> f64 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    f64::from(*state) / 4294967296.0
}

fn run(data: &[f64], radius: f64, seed: u32, limit: usize, budget: usize, mode: u32) -> Vec<f64> {
    let dim = if mode == 0 { 2 } else { 3 };
    let fail = || vec![-1.0, 0.0, 0.0];
    if !(1e-6..=1e6).contains(&radius)
        || limit > 65536
        || budget > 2_000_000
        || mode > 2
        || data.iter().any(|v| !v.is_finite() || v.abs() > 1e6)
    {
        return fail();
    }
    if (mode == 0 && (data.len() != 4 || data[2] <= data[0] || data[3] <= data[1]))
        || (mode == 1 && data.len() % 9 != 0)
        || (mode == 2 && data.len() % 3 != 0)
    {
        return fail();
    }
    let mut areas = Vec::new();
    let mut total = 0.0;
    if mode == 1 {
        for t in data.chunks_exact(9) {
            let a = [t[3] - t[0], t[4] - t[1], t[5] - t[2]];
            let b = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
            let c = [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ];
            total += c[0].hypot(c[1]).hypot(c[2]);
            areas.push(total);
        }
        if total == 0.0 {
            return vec![0.0, 0.0, 0.0];
        }
    }
    let mut state = seed.max(1);
    let mut points: Vec<[f64; 3]> = Vec::new();
    let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    let mut checks: u64 = 0;
    let mut used = 0;
    let attempts = if mode == 2 { data.len() / 3 } else { budget };
    for at in 0..attempts {
        if points.len() == limit {
            break;
        }
        used += 1;
        let p = if mode == 0 {
            [
                data[0] + random(&mut state) * (data[2] - data[0]),
                data[1] + random(&mut state) * (data[3] - data[1]),
                0.0,
            ]
        } else if mode == 1 {
            let target = random(&mut state) * total;
            let tri = areas.partition_point(|&a| a <= target);
            let t = &data[tri * 9..tri * 9 + 9];
            let mut u = random(&mut state);
            let mut v = random(&mut state);
            if u + v > 1.0 {
                u = 1.0 - u;
                v = 1.0 - v;
            }
            [
                t[0] + u * (t[3] - t[0]) + v * (t[6] - t[0]),
                t[1] + u * (t[4] - t[1]) + v * (t[7] - t[1]),
                t[2] + u * (t[5] - t[2]) + v * (t[8] - t[2]),
            ]
        } else {
            [data[at * 3], data[at * 3 + 1], data[at * 3 + 2]]
        };
        let key = [
            (p[0] / radius).floor() as i64,
            (p[1] / radius).floor() as i64,
            (p[2] / radius).floor() as i64,
        ];
        let mut accepted = true;
        'near: for dz in (if dim == 2 { 0 } else { -1 })..=(if dim == 2 { 0 } else { 1 }) {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if let Some(cell) = grid.get(&[key[0] + dx, key[1] + dy, key[2] + dz]) {
                        for &i in cell {
                            checks += 1;
                            let q = points[i];
                            let d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
                            if d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < radius * radius {
                                accepted = false;
                                break 'near;
                            }
                        }
                    }
                }
            }
        }
        if accepted {
            grid.entry(key).or_default().push(points.len());
            points.push(p);
        }
    }
    let mut result = vec![points.len() as f64, used as f64, checks as f64];
    for p in points {
        result.extend_from_slice(&p[..dim]);
    }
    result
}

/// Inputs live in this instance's memory and remain borrowed for this call only.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sample(
    ptr: *const f64,
    len: usize,
    radius: f64,
    seed: u32,
    limit: usize,
    budget: usize,
    mode: u32,
) -> *mut f64 {
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    Box::into_raw(run(data, radius, seed, limit, budget, mode).into_boxed_slice()) as *mut f64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grid_matches_all_pairs_with_less_work() {
        let data: Vec<f64> = (0..4096)
            .flat_map(|i| [(i % 64) as f64, (i / 64) as f64, 0.0])
            .collect();
        let out = run(&data, 0.9, 1, 65536, 0, 2);
        assert_eq!(&out[3..], &data);
        assert!(out[2] < (4096 * 4095 / 2) as f64 / 100.0);
    }
    #[test]
    fn invalid_and_empty_surfaces_are_bounded() {
        assert_eq!(run(&[], 1.0, 1, 1, 100, 1), vec![0.0, 0.0, 0.0]);
        assert_eq!(run(&[f64::NAN; 9], 1.0, 1, 1, 100, 1)[0], -1.0);
        assert_eq!(run(&[0.0; 9], 1.0, 1, 1, 100, 1), vec![0.0, 0.0, 0.0]);
    }
}
