// Clean room: Runions et al. (2005, 2007), Runions (2008), geometric point growth.
use std::collections::BTreeMap;
type Point = [f64; 3];
type Cell = [i64; 3];
fn cell(p: Point, radius: f64) -> Cell {
    p.map(|v| (v / radius).floor() as i64)
}
fn squared(a: Point, b: Point) -> f64 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
}
fn random(state: &mut u32) -> f64 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    *state as f64 / 4294967296.0
}
fn cloud(count: usize, root: Point, seed: u32) -> Vec<Point> {
    let mut state = seed.max(1);
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let p = [
            random(&mut state) * 2.0 - 1.0,
            random(&mut state) * 2.0 - 1.0,
            random(&mut state) * 2.0 - 1.0,
        ];
        let length = squared(p, [0.0; 3]).sqrt();
        let scale = if length > 0.0 {
            2.0 * random(&mut state) / length
        } else {
            0.0
        };
        out.push([
            root[0] + p[0] * scale,
            root[1] + 3.0 + p[1] * scale,
            root[2] + p[2] * scale,
        ]);
    }
    out
}
struct Settings {
    root: Point,
    segment: f64,
    influence: f64,
    kill: f64,
    max_nodes: usize,
    max_iterations: usize,
}
fn nearest(
    p: Point,
    nodes: &[Point],
    grid: &BTreeMap<Cell, Vec<usize>>,
    radius: f64,
    tests: &mut usize,
    exhaustive: bool,
) -> Option<(usize, f64)> {
    let mut best = None;
    let mut distance = radius * radius;
    let mut cells: Vec<(f64, &[usize])> = Vec::with_capacity(125);
    let all: Vec<usize> = if exhaustive {
        (0..nodes.len()).collect()
    } else {
        Vec::new()
    };
    if exhaustive {
        cells.push((0.0, all.as_slice()));
    } else {
        let c = cell(p, radius);
        // Rounded distances can admit points just across the second cell boundary
        // (for example -MIN_SUBNORMAL and 1 at radius 1). One guard cell on
        // each side preserves the exhaustive floating-point distance contract.
        for x in -2..=2 {
            for y in -2..=2 {
                for z in -2..=2 {
                    let key = [c[0] + x, c[1] + y, c[2] + z];
                    if let Some(indices) = grid.get(&key) {
                        let mut lower = 0.0;
                        for k in 0..3 {
                            let lo = key[k] as f64 * radius;
                            let hi = (key[k] + 1) as f64 * radius;
                            // Expand the mathematical box conservatively for division,
                            // multiplication, subtraction and squared-sum rounding.
                            let margin = 16.0 * f64::EPSILON * (lo.abs() + hi.abs() + radius);
                            let d = (lo - margin - p[k]).max(0.0).max(p[k] - hi - margin);
                            lower += d * d;
                        }
                        cells.push((lower * (1.0 - 16.0 * f64::EPSILON), indices.as_slice()));
                    }
                }
            }
        }
        cells.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    for (lower, indices) in cells {
        if lower > distance {
            continue;
        }
        for &i in indices {
            *tests += 1;
            let d = squared(p, nodes[i]);
            if d < distance || (d == distance && best.is_none_or(|j| i < j)) {
                distance = d;
                best = Some(i);
            }
        }
    }
    best.map(|i| (i, distance))
}
fn run(points: Vec<Point>, s: Settings, exhaustive: bool) -> Vec<f64> {
    if points.len() > 8192
        || s.max_nodes == 0
        || s.max_nodes > 16384
        || s.max_iterations == 0
        || s.max_iterations > 512
        || points.len() as u64 * s.max_nodes as u64 * s.max_iterations as u64 > 134217728
        || !s.segment.is_finite()
        || !(0.0001..=10000.0).contains(&s.segment)
        || !s.influence.is_finite()
        || !(0.0001..=1000000.0).contains(&s.influence)
        || !s.kill.is_finite()
        || s.kill < s.segment / 2.0
        || s.kill > s.influence
        || points
            .iter()
            .chain(std::iter::once(&s.root))
            .flatten()
            .any(|v| !v.is_finite() || v.abs() > 1000005.0)
    {
        return vec![7.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    }
    let mut nodes = vec![s.root];
    let mut parents = vec![-1];
    let mut grid = BTreeMap::<Cell, Vec<usize>>::new();
    grid.entry(cell(s.root, s.influence)).or_default().push(0);
    let mut active = vec![true; points.len()];
    let mut remaining = points.len();
    let mut tests = 0;
    let mut iterations = 0;
    let mut reason = 4;
    for _ in 0..s.max_iterations {
        let mut sums = vec![[0.0; 3]; nodes.len()];
        for (i, &p) in points.iter().enumerate() {
            if !active[i] {
                continue;
            }
            if let Some((j, distance)) =
                nearest(p, &nodes, &grid, s.influence, &mut tests, exhaustive)
            {
                if distance <= s.kill * s.kill {
                    active[i] = false;
                    remaining -= 1;
                } else {
                    let length = distance.sqrt();
                    for k in 0..3 {
                        sums[j][k] += (p[k] - nodes[j][k]) / length;
                    }
                }
            }
        }
        if remaining == 0 {
            reason = 1;
            break;
        }
        if nodes.len() == s.max_nodes {
            reason = 3;
            break;
        }
        let before = nodes.len();
        for (j, direction) in sums.iter().enumerate() {
            let length = squared(*direction, [0.0; 3]).sqrt();
            if length <= 1e-12 {
                continue;
            }
            let p = std::array::from_fn(|k| nodes[j][k] + s.segment * direction[k] / length);
            let index = nodes.len();
            nodes.push(p);
            parents.push(j as i32);
            grid.entry(cell(p, s.influence)).or_default().push(index);
            if nodes.len() == s.max_nodes {
                break;
            }
        }
        iterations += 1;
        if before == nodes.len() {
            reason = 2;
            break;
        }
    }
    // Consume reached points after the final growth, even at an iteration/node cap.
    for (i, &p) in points.iter().enumerate() {
        if active[i]
            && nearest(p, &nodes, &grid, s.influence, &mut tests, exhaustive)
                .is_some_and(|(_, d)| d <= s.kill * s.kill)
        {
            remaining -= 1;
        }
    }
    if remaining == 0 {
        reason = 1;
    } else if nodes.len() == s.max_nodes {
        reason = 3;
    }
    let length = 7 + nodes.len() * 4 + points.len() * 3;
    let mut output = vec![
        length as f64,
        nodes.len() as f64,
        remaining as f64,
        iterations as f64,
        tests as f64,
        reason as f64,
        points.len() as f64,
    ];
    output.extend(nodes.iter().flatten());
    output.extend(parents.iter().map(|v| *v as f64));
    output.extend(points.iter().flatten());
    output
}
#[unsafe(no_mangle)]
pub extern "C" fn allocate(length: usize) -> *mut f64 {
    Box::into_raw(vec![0.0; length].into_boxed_slice()) as *mut f64
}
/// Input allocation must contain count * 3 initialized doubles, or count is zero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn generate(
    pointer: *const f64,
    count: usize,
    default_count: usize,
    seed: u32,
    x: f64,
    y: f64,
    z: f64,
    segment: f64,
    influence: f64,
    kill: f64,
    max_nodes: usize,
    max_iterations: usize,
) -> *mut f64 {
    let root = [x, y, z];
    let points = if default_count > 0 && default_count <= 8192 {
        cloud(default_count, root, seed)
    } else if count > 0 && count <= 8192 {
        unsafe { std::slice::from_raw_parts(pointer, count * 3) }
            .chunks_exact(3)
            .map(|p| [p[0], p[1], p[2]])
            .collect()
    } else {
        Vec::new()
    };
    Box::into_raw(
        run(
            points,
            Settings {
                root,
                segment,
                influence,
                kill,
                max_nodes,
                max_iterations,
            },
            false,
        )
        .into_boxed_slice(),
    ) as *mut f64
}
/// Release an input or output allocation exactly once with its original length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(pointer: *mut f64, length: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Settings {
        Settings {
            root: [0.0; 3],
            segment: 0.2,
            influence: 1.5,
            kill: 0.3,
            max_nodes: 2048,
            max_iterations: 128,
        }
    }
    #[test]
    fn grid_matches_exhaustive_for_seeds_boundaries_ties_and_negative_cells() {
        for seed in 0..32 {
            let mut p = cloud(256, [0.0; 3], seed);
            p.extend([
                [1.0, 0.0, 0.0],
                [-1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.8, 1.0, 0.0],
                [-0.8, 1.0, 0.0],
                [0.0, 1.0, 0.8],
                [0.0, 1.0, -0.8],
                [0.0; 3],
            ]);
            let mut a = run(p.clone(), settings(), false);
            let b = run(p, settings(), true);
            assert!(a[1] > 10.0);
            let count = a[1] as usize;
            let mut children = vec![0; count];
            for &parent in &a[7 + count * 3 + 1..7 + count * 4] {
                children[parent as usize] += 1;
            }
            assert!(children.iter().any(|&n| n > 1));
            assert!(a[4] < b[4]);
            a[4] = b[4];
            assert_eq!(a, b);
        }
    }
    #[test]
    fn invalid_limits_and_nonfinite_values() {
        let mut s = settings();
        s.segment = f64::NAN;
        assert_eq!(run(vec![[0.0; 3]], s, false)[1], 0.0);
        assert_eq!(run(vec![[f64::INFINITY; 3]], settings(), false)[1], 0.0);
        let mut s = settings();
        s.max_nodes = usize::MAX;
        assert_eq!(run(vec![[0.0; 3]], s, false)[1], 0.0);
    }
    #[test]
    fn conservative_cell_bounds_match_exhaustive_at_large_small_and_negative_coordinates() {
        let tiny = -f64::from_bits(1);
        let nodes = vec![[tiny, 0.0, 0.0]];
        let grid = BTreeMap::from([(cell(nodes[0], 1.0), vec![0])]);
        assert_eq!(
            nearest([1.0, 0.0, 0.0], &nodes, &grid, 1.0, &mut 0, false),
            Some((0, 1.0))
        );
        for radius in [0.0001, 0.2, 1.5, 1000000.0] {
            for origin in [-1000000.0, -0.3, 0.0, 1000000.0] {
                let mut nodes = Vec::new();
                let mut grid = BTreeMap::<Cell, Vec<usize>>::new();
                for i in -4..=4 {
                    let p = [origin + i as f64 * radius, origin, origin];
                    grid.entry(cell(p, radius)).or_default().push(nodes.len());
                    nodes.push(p);
                }
                // Duplicate positions test lowest-index ties regardless of cell ordering.
                nodes.push(nodes[0]);
                grid.entry(cell(nodes[0], radius))
                    .or_default()
                    .push(nodes.len() - 1);
                for offset in [-1e-10, 0.0, 1e-10, 0.5, -0.5] {
                    for i in -5..=5 {
                        let p = [origin + (i as f64 + offset) * radius, origin, origin];
                        assert_eq!(
                            nearest(p, &nodes, &grid, radius, &mut 0, false),
                            nearest(p, &nodes, &grid, radius, &mut 0, true)
                        );
                    }
                }
            }
        }
    }
}
