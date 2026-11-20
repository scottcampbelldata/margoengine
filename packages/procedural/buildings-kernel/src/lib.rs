// Clean-room rectangular split/repeat scopes, based on Wonka 2003 and Mueller 2006.
type P = [f64; 3];
#[derive(Default)]
struct Mesh {
    positions: Vec<f64>,
    normals: Vec<f64>,
    indices: Vec<f64>,
    materials: Vec<f64>,
    floors: Vec<f64>,
    bays: Vec<f64>,
}
struct Scope {
    origin: P,
    c: f64,
    s: f64,
}
impl Scope {
    fn point(&self, p: P) -> P {
        [
            self.origin[0] + self.c * p[0] + self.s * p[2],
            self.origin[1] + p[1],
            self.origin[2] - self.s * p[0] + self.c * p[2],
        ]
    }
}
impl Mesh {
    /// One planar face: shared vertices, the listed triangles, one normal from the first triangle's winding.
    fn face(&mut self, scope: &Scope, points: &[P], triangles: &[[usize; 3]], material: f64) {
        let [a, b, c] = triangles[0].map(|i| points[i]);
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let normal = [
            (scope.c * n[0] + scope.s * n[2]) / len,
            n[1] / len,
            (-scope.s * n[0] + scope.c * n[2]) / len,
        ];
        let first = (self.positions.len() / 3) as f64;
        for &p in points {
            self.positions.extend(scope.point(p));
            self.normals.extend(normal);
        }
        for t in triangles {
            self.indices.extend(t.map(|i| first + i as f64));
            self.materials.push(material);
        }
    }
    fn pack(self) -> Vec<f64> {
        let mut out = vec![
            0.,
            (self.positions.len() / 3) as f64,
            (self.indices.len() / 3) as f64,
            (self.bays.len() / 8) as f64,
            2.,
        ];
        out.extend(self.positions);
        out.extend(self.normals);
        out.extend(self.indices);
        out.extend(self.materials);
        out.extend(self.floors);
        out.extend(self.bays);
        out[0] = out.len() as f64;
        out
    }
}
/// Fan from `apex` over the chain, in the chain's order.
fn fan(apex: usize, chain: std::ops::Range<usize>) -> Vec<[usize; 3]> {
    chain
        .clone()
        .zip(chain.skip(1))
        .map(|(i, j)| [i, apex, j])
        .collect()
}
fn generate(input: &[f64]) -> Mesh {
    let w = input[0];
    let d = input[1];
    let scope = Scope {
        origin: [input[2], input[3], input[4]],
        c: input[5].cos(),
        s: input[5].sin(),
    };
    let nx = input[6] as usize;
    let nz = input[7] as usize;
    let wx = input[8];
    let wy = input[9];
    let rise = input[10];
    let heights = &input[11..];
    let mut mesh = Mesh::default();
    // Every face is cut at the same columns and rows, so each edge meets exactly one opposite edge (no T junction):
    // wall columns are bay ends and window sides, rows are floor ends and window sills and heads.
    let corners = [
        [-w / 2., -d / 2.],
        [w / 2., -d / 2.],
        [w / 2., d / 2.],
        [-w / 2., d / 2.],
    ];
    let mut columns: [Vec<[f64; 2]>; 4] = Default::default();
    let mut rows = vec![0.];
    let mut y = 0.;
    for &height in heights {
        mesh.floors.extend([y, height]);
        rows.extend([
            y + height * (1. - wy) / 2.,
            y + height * (1. + wy) / 2.,
            y + height,
        ]);
        y += height;
    }
    let top = y;
    for side in 0..4 {
        let (length, count) = if side % 2 == 0 { (w, nx) } else { (d, nz) };
        // Ends are the exact shared corners; inner points come from their integer scope indices, avoiding drift.
        let local = |u: f64| -> [f64; 2] {
            match side {
                0 => [-w / 2. + u, -d / 2.],
                1 => [w / 2., -d / 2. + u],
                2 => [w / 2. - u, d / 2.],
                _ => [-w / 2., d / 2. - u],
            }
        };
        let column = &mut columns[side];
        column.push(corners[side]);
        let mut y = 0.;
        for (floor, &height) in heights.iter().enumerate() {
            for bay in 0..count {
                let start = length * bay as f64 / count as f64;
                let end = if bay + 1 == count {
                    length
                } else {
                    length * (bay + 1) as f64 / count as f64
                };
                let a = start + (end - start) * (1. - wx) / 2.;
                let b = end - (end - start) * (1. - wx) / 2.;
                let low = y + height * (1. - wy) / 2.;
                let high = y + height * (1. + wy) / 2.;
                mesh.bays.extend([
                    floor as f64,
                    side as f64,
                    start,
                    y,
                    end - start,
                    height,
                    b - a,
                    high - low,
                ]);
                if floor == 0 {
                    column.extend([local(a), local(b)]);
                    column.push(if bay + 1 == count {
                        corners[(side + 1) % 4]
                    } else {
                        local(end)
                    });
                }
            }
            y += height;
        }
        let (cs, rs) = (column.len(), rows.len());
        let points: Vec<P> = rows
            .iter()
            .flat_map(|&v| column.iter().map(move |c| [c[0], v, c[1]]))
            .collect();
        let (mut wall, mut pane) = (vec![], vec![]);
        for r in 0..rs - 1 {
            for c in 0..cs - 1 {
                let p = r * cs + c;
                let quad = [[p, p + cs, p + cs + 1], [p, p + cs + 1, p + 1]];
                if r % 3 == 1 && c % 3 == 1 {
                    pane.extend(quad)
                } else {
                    wall.extend(quad)
                }
            }
        }
        mesh.face(&scope, &points, &wall, 0.);
        mesh.face(&scope, &points, &pane, 1.);
    }
    // Base and flat roof: fans from the centre over the perimeter at every wall column.
    let ring: Vec<[f64; 2]> = columns
        .iter()
        .flat_map(|c| c[..c.len() - 1].iter().copied())
        .collect();
    let n = ring.len();
    let mut points: Vec<P> = ring.iter().map(|c| [c[0], 0., c[1]]).collect();
    points.push([0., 0., 0.]);
    let base: Vec<_> = (0..n).map(|i| [n, i, (i + 1) % n]).collect();
    mesh.face(&scope, &points, &base, 3.);
    if rise == 0. {
        let mut points: Vec<P> = ring.iter().map(|c| [c[0], top, c[1]]).collect();
        points.push([0., top, 0.]);
        let roof: Vec<_> = (0..n).map(|i| [n, (i + 1) % n, i]).collect();
        mesh.face(&scope, &points, &roof, 2.);
    } else {
        let ridge = [[0., top + rise, -d / 2.], [0., top + rise, d / 2.]];
        let eave =
            |side: usize| -> Vec<P> { columns[side].iter().map(|c| [c[0], top, c[1]]).collect() };
        // Gables at -Z and +Z: fans from the apex over the top floor's columns.
        for (side, apex) in [(0, ridge[0]), (2, ridge[1])] {
            let mut points = eave(side);
            let k = points.len();
            points.push(apex);
            mesh.face(&scope, &points, &fan(k, 0..k), 2.);
        }
        // Slopes: the -X eave runs -Z to +Z (side 3 reversed), the +X eave +Z to -Z (side 1 reversed).
        // Each is a fan from the +Z ridge end over its eave, then the triangle that closes it to the -Z ridge end.
        for side in [3, 1] {
            let mut points = eave(side);
            points.reverse();
            let k = points.len();
            points.extend(ridge.iter().rev());
            let mut triangles: Vec<_> = (0..k - 1).map(|i| [i, i + 1, k]).collect();
            triangles.push(if side == 3 {
                [0, k, k + 1]
            } else {
                [k - 1, k + 1, k]
            });
            mesh.face(&scope, &points, &triangles, 2.);
        }
    }
    mesh
}
#[unsafe(no_mangle)]
pub extern "C" fn allocate(length: usize) -> *mut f64 {
    Box::into_raw(vec![0.; length].into_boxed_slice()) as *mut f64
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
pub unsafe extern "C" fn generate_building(pointer: *const f64, length: usize) -> *mut f64 {
    let input = unsafe { std::slice::from_raw_parts(pointer, length) };
    Box::into_raw(generate(input).pack().into_boxed_slice()) as *mut f64
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_repeat_counts_and_shared_basis() {
        let m = generate(&[12., 8., 0., 0., 0., 0., 4., 3., 0.55, 0.6, 2., 3., 4.]);
        assert_eq!(m.bays.len() / 8, 28);
        assert_eq!(m.floors, vec![0., 3., 3., 4.]);
        assert_eq!(m.materials.iter().filter(|&&x| x == 1.).count(), 56);
        assert_eq!(m.pack()[4], 2.);
    }
    #[test]
    fn every_triangle_has_outward_normal_and_positive_area() {
        let m = generate(&[
            0.1, 1000., 10000., -10000., 10000., 1., 1., 256., 0.95, 0.05, 100., 0.1,
        ]);
        for t in m.indices.chunks(3) {
            let p = |i: usize| {
                let j = t[i] as usize * 3;
                [m.positions[j], m.positions[j + 1], m.positions[j + 2]]
            };
            let a = p(0);
            let b = p(1);
            let c = p(2);
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let j = t[0] as usize * 3;
            assert!(n[0] * m.normals[j] + n[1] * m.normals[j + 1] + n[2] * m.normals[j + 2] > 0.);
        }
    }
}
