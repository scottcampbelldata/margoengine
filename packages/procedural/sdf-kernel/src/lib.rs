// Clean room: Ju et al. 2002, uniform-grid dual contouring; Schaefer and Warren 2003,
// mass-point rank-deficient QEFs. Jacobi rotations solve the small symmetric systems.
type P = [f64; 3];
fn dot(a: P, b: P) -> f64 {
    (0..3).map(|k| a[k] * b[k]).sum()
}
fn field(code: &[f64], p: P) -> (f64, P) {
    let mut stack = [(0.0, [0.0; 3]); 64];
    let mut top = 0;
    for node in code.chunks_exact(7) {
        let op = node[0] as u32;
        if op >= 2 {
            let mut b = stack[top - 1];
            let a = stack[top - 2];
            top -= 1;
            if op == 4 {
                b = (-b.0, b.1.map(|v| -v));
            }
            stack[top - 1] = if (op == 2 && a.0 <= b.0) || (op != 2 && a.0 >= b.0) {
                a
            } else {
                b
            };
        } else {
            let q = std::array::from_fn(|k| p[k] - node[k + 1]);
            let value = if op == 0 {
                let len = dot(q, q).sqrt();
                (
                    len - node[4],
                    if len > 0.0 {
                        q.map(|v| v / len)
                    } else {
                        [1.0, 0.0, 0.0]
                    },
                )
            } else {
                let d: P = std::array::from_fn(|k| q[k].abs() - node[k + 4]);
                let positive = d.map(|v| v.max(0.0));
                let len = dot(positive, positive).sqrt();
                let max = d[0].max(d[1]).max(d[2]);
                let mut normal = [0.0; 3];
                if len > 0.0 {
                    for k in 0..3 {
                        normal[k] = positive[k] / len * if q[k] < 0.0 { -1.0 } else { 1.0 };
                    }
                } else {
                    let axis = (0..3).find(|&k| d[k] == max).unwrap();
                    normal[axis] = if q[axis] < 0.0 { -1.0 } else { 1.0 };
                }
                (len + max.min(0.0), normal)
            };
            stack[top] = value;
            top += 1;
        }
    }
    stack[0]
}
// Symmetric pseudoinverse, centred at the Hermite mass point. The absolute
// eigenvalue threshold is in world coordinates with unit input normals.
fn solve(mut a: [[f64; 3]; 3], b: P) -> P {
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..24 {
        let mut pair = (0, 1);
        for (p, q) in [(0, 2), (1, 2)] {
            if a[p][q].abs() > a[pair.0][pair.1].abs() {
                pair = (p, q);
            }
        }
        let (p, q) = pair;
        if a[p][q].abs() < 1e-14 {
            break;
        }
        let angle = 0.5 * (2.0 * a[p][q]).atan2(a[q][q] - a[p][p]);
        let (s, c) = angle.sin_cos();
        for k in 0..3 {
            let x = a[k][p];
            let y = a[k][q];
            a[k][p] = c * x - s * y;
            a[k][q] = s * x + c * y;
        }
        for k in 0..3 {
            let x = a[p][k];
            let y = a[q][k];
            a[p][k] = c * x - s * y;
            a[q][k] = s * x + c * y;
        }
        for row in &mut v {
            let x = row[p];
            let y = row[q];
            row[p] = c * x - s * y;
            row[q] = s * x + c * y;
        }
    }
    let mut out = [0.0; 3];
    for k in 0..3 {
        if a[k][k] > 1e-10 {
            let t = (0..3).map(|j| v[j][k] * b[j]).sum::<f64>() / a[k][k];
            for j in 0..3 {
                out[j] += v[j][k] * t;
            }
        }
    }
    out
}
fn qef(samples: &[(P, P)], origin: P, step: P) -> P {
    let mass: P = std::array::from_fn(|k| {
        samples
            .iter()
            .map(|s| (s.0[k] - origin[k]) / step[k])
            .sum::<f64>()
            / samples.len() as f64
    });
    let mut a = [[0.0; 3]; 3];
    let mut b = [0.0; 3];
    let rows: Vec<(P, f64)> = samples
        .iter()
        .map(|&(p, n)| {
            let d = (0..3)
                .map(|k| n[k] * (p[k] - origin[k] - mass[k] * step[k]))
                .sum();
            (n, d)
        })
        .collect();
    for &(row, d) in &rows {
        for i in 0..3 {
            b[i] += row[i] * d;
            for j in 0..3 {
                a[i][j] += row[i] * row[j];
            }
        }
    }
    let mut best = mass;
    let mut error = f64::INFINITY;
    // Enumerate interior, faces, edges and corners: a true bounded least-squares
    // minimum, rather than clamping an unbounded solution component by component.
    for state in 0..27 {
        let mut t = state;
        let mut fixed = [false; 3];
        let mut delta = [0.0; 3];
        for k in 0..3 {
            let s = t % 3;
            t /= 3;
            if s != 0 {
                fixed[k] = true;
                delta[k] = (if s == 1 { -mass[k] } else { 1.0 - mass[k] }) * step[k];
            }
        }
        let mut m = a;
        let mut rhs = b;
        for i in 0..3 {
            if fixed[i] {
                m[i] = [0.0; 3];
                m[i][i] = 1.0;
                rhs[i] = delta[i];
            } else {
                for j in 0..3 {
                    if fixed[j] {
                        rhs[i] -= a[i][j] * delta[j];
                        m[i][j] = 0.0;
                    }
                }
            }
        }
        // Remove constrained columns too, leaving a symmetric free subsystem.
        for j in 0..3 {
            if fixed[j] {
                for i in 0..3 {
                    if i != j {
                        m[i][j] = 0.0;
                    }
                }
            }
        }
        let d = solve(m, rhs);
        let candidate: P = std::array::from_fn(|k| mass[k] + d[k] / step[k]);
        if candidate
            .iter()
            .any(|&x| !(-1e-9..=1.0 + 1e-9).contains(&x))
        {
            continue;
        }
        let e = rows
            .iter()
            .map(|&(row, r)| (dot(row, d) - r).powi(2))
            .sum::<f64>();
        if e < error {
            error = e;
            best = candidate.map(|v| v.clamp(0.0, 1.0));
        }
    }
    std::array::from_fn(|k| origin[k] + best[k] * step[k])
}
struct Mesh {
    positions: Vec<P>,
    indices: Vec<usize>,
    edges: usize,
    uses: usize,
    boundary: bool,
}
fn build(code: &[f64], n: usize, origin: P, step: P) -> Mesh {
    let size = n + 1;
    let index = |x: usize, y: usize, z: usize| (z * size + y) * size + x;
    let cell = |x: usize, y: usize, z: usize| (z * n + y) * n + x;
    let at = |x: usize, y: usize, z: usize| {
        [
            origin[0] + x as f64 * step[0],
            origin[1] + y as f64 * step[1],
            origin[2] + z as f64 * step[2],
        ]
    };
    let mut values = vec![0.0; size * size * size];
    let mut mesh = Mesh {
        positions: vec![],
        indices: vec![],
        edges: 0,
        uses: 0,
        boundary: false,
    };
    for z in 0..size {
        for y in 0..size {
            for x in 0..size {
                let d = field(code, at(x, y, z)).0;
                values[index(x, y, z)] = d;
                if (x == 0 || y == 0 || z == 0 || x == n || y == n || z == n) && d <= 0.0 {
                    mesh.boundary = true;
                }
            }
        }
    }
    if mesh.boundary {
        return mesh;
    }
    let mut edges = vec![None; values.len() * 3];
    for z in 0..size {
        for y in 0..size {
            for x in 0..size {
                for axis in 0..3 {
                    let c = [x, y, z];
                    if c[axis] == n {
                        continue;
                    }
                    let mut next = c;
                    next[axis] += 1;
                    let a = values[index(x, y, z)];
                    let b = values[index(next[0], next[1], next[2])];
                    if (a < 0.0) == (b < 0.0) {
                        continue;
                    }
                    let p = at(x, y, z);
                    let mut lo = 0.0;
                    let mut hi = 1.0;
                    for _ in 0..40 {
                        let mid = (lo + hi) * 0.5;
                        let mut q = p;
                        q[axis] += mid * step[axis];
                        if (field(code, q).0 < 0.0) == (a < 0.0) {
                            lo = mid;
                        } else {
                            hi = mid;
                        }
                    }
                    let mut q = p;
                    q[axis] += (lo + hi) * 0.5 * step[axis];
                    let normal = field(code, q).1;
                    edges[index(x, y, z) * 3 + axis] = Some((q, normal));
                    mesh.edges += 1;
                }
            }
        }
    }
    let mut vertices = vec![usize::MAX; n * n * n];
    for z in 0..n {
        for y in 0..n {
            for x in 0..n {
                let base = [x, y, z];
                let mut samples = Vec::with_capacity(12);
                for axis in 0..3 {
                    let u = (axis + 1) % 3;
                    let v = (axis + 2) % 3;
                    for a in 0..2 {
                        for b in 0..2 {
                            let mut c = base;
                            c[u] += a;
                            c[v] += b;
                            if let Some(e) = edges[index(c[0], c[1], c[2]) * 3 + axis] {
                                samples.push(e);
                            }
                        }
                    }
                }
                if !samples.is_empty() {
                    mesh.uses += samples.len();
                    vertices[cell(x, y, z)] = mesh.positions.len();
                    mesh.positions.push(qef(&samples, at(x, y, z), step));
                }
            }
        }
    }
    for z in 0..size {
        for y in 0..size {
            for x in 0..size {
                for axis in 0..3 {
                    if edges[index(x, y, z) * 3 + axis].is_none() {
                        continue;
                    }
                    let base = [x, y, z];
                    let u = (axis + 1) % 3;
                    let v = (axis + 2) % 3;
                    if base[u] == 0 || base[v] == 0 || base[u] == n || base[v] == n {
                        continue;
                    }
                    let mut ids = [0; 4];
                    for (i, (a, b)) in [(0, 0), (1, 0), (1, 1), (0, 1)].into_iter().enumerate() {
                        let mut c = base;
                        c[u] -= 1 - a;
                        c[v] -= 1 - b;
                        ids[i] = vertices[cell(c[0], c[1], c[2])];
                    }
                    if values[index(x, y, z)] >= 0.0 {
                        ids.reverse();
                    }
                    mesh.indices
                        .extend([ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]]);
                }
            }
        }
    }
    mesh
}
#[unsafe(no_mangle)]
pub extern "C" fn allocate(length: usize) -> *mut f64 {
    Box::into_raw(vec![0.0; length].into_boxed_slice()) as *mut f64
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(pointer: *mut f64, length: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn contour(
    pointer: *const f64,
    length: usize,
    n: usize,
    x: f64,
    y: f64,
    z: f64,
    sx: f64,
    sy: f64,
    sz: f64,
) -> *mut f64 {
    let code = unsafe { std::slice::from_raw_parts(pointer, length) };
    let mesh = build(code, n, [x, y, z], [sx, sy, sz]);
    let mut out = vec![
        0.0,
        if mesh.boundary {
            -1.0
        } else {
            mesh.positions.len() as f64
        },
        mesh.indices.len() as f64,
        mesh.edges as f64,
        mesh.uses as f64,
    ];
    out.extend(mesh.positions.iter().flatten());
    out.extend(mesh.indices.iter().map(|&v| v as f64));
    out[0] = out.len() as f64;
    Box::into_raw(out.into_boxed_slice()) as *mut f64
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn singular_mass_and_corner() {
        let flat = [
            ([0.3, 0.2, 0.4], [1.0, 0.0, 0.0]),
            ([0.3, 0.8, 0.6], [1.0, 0.0, 0.0]),
        ];
        let p = qef(&flat, [0.0; 3], [1.0; 3]);
        for (a, b) in p.into_iter().zip([0.3, 0.5, 0.5]) {
            assert!((a - b).abs() < 1e-12);
        }
        let corner = [
            ([0.2, 0.5, 0.5], [1.0, 0.0, 0.0]),
            ([0.5, 0.3, 0.5], [0.0, 1.0, 0.0]),
            ([0.5, 0.5, 0.4], [0.0, 0.0, 1.0]),
        ];
        let p = qef(&corner, [0.0; 3], [1.0; 3]);
        for (a, b) in p.into_iter().zip([0.2, 0.3, 0.4]) {
            assert!((a - b).abs() < 1e-12);
        }
    }
    #[test]
    fn rotated_rank_two_and_bounded() {
        let s = 0.5_f64.sqrt();
        let samples = [
            ([0.2, 0.3, 0.4], [s, s, 0.0]),
            ([0.2, 0.3, 0.4], [0.0, s, s]),
        ];
        let p = qef(&samples, [0.0; 3], [1.0; 3]);
        for &(q, n) in &samples {
            assert!(dot(n, std::array::from_fn(|k| p[k] - q[k])).abs() < 1e-12);
        }
        let outside = [([2.0, 0.4, 0.4], [1.0, 0.0, 0.0])];
        assert_eq!(qef(&outside, [0.0; 3], [1.0; 3])[0], 1.0);
    }
    #[test]
    fn closed_box_edges_shared() {
        let mesh = build(
            &[1.0, 0.0, 0.0, 0.0, 0.7, 0.6, 0.5],
            16,
            [-1.0; 3],
            [0.125; 3],
        );
        assert!(!mesh.boundary);
        assert_eq!(mesh.uses, mesh.edges * 4);
        assert!(!mesh.indices.is_empty());
        assert!(mesh.indices.iter().all(|&i| i < mesh.positions.len()));
    }
    #[test]
    fn anisotropic_cells_do_not_destroy_rank() {
        let samples = [
            ([0.00003, 1.0, 1.0], [1.0, 0.0, 0.0]),
            ([0.00005, 2000.0, 1.0], [0.0, 1.0, 0.0]),
            ([0.00005, 1.0, 0.4], [0.0, 0.0, 1.0]),
        ];
        let p = qef(&samples, [0.0; 3], [0.0001, 10000.0, 1.0]);
        for (a, b) in p.into_iter().zip([0.00003, 2000.0, 0.4]) {
            assert!((a - b).abs() < 1e-12);
        }
    }
}
