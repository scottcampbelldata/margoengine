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
    fn face(&mut self, scope: &Scope, points: &[P], material: f64) {
        let a = points[0];
        let b = points[1];
        let c = points[2];
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
        for i in 1..points.len() - 1 {
            self.indices
                .extend([first, first + i as f64, first + i as f64 + 1.]);
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
    let mut mesh = Mesh::default();
    let mut y = 0.;
    for (floor, &height) in input[11..].iter().enumerate() {
        mesh.floors.extend([y, height]);
        for side in 0..4 {
            let (length, count) = if side % 2 == 0 { (w, nx) } else { (d, nz) };
            // Endpoints are evaluated from their integer scope indices, avoiding cumulative drift.
            let point = |u: f64, v: f64| -> P {
                match side {
                    0 => [-w / 2. + u, v, -d / 2.],
                    1 => [w / 2., v, -d / 2. + u],
                    2 => [w / 2. - u, v, d / 2.],
                    _ => [-w / 2., v, d / 2. - u],
                }
            };
            for bay in 0..count {
                let start = length * bay as f64 / count as f64;
                let end = length * (bay + 1) as f64 / count as f64;
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
                let mut quad = |x0: f64, x1: f64, y0: f64, y1: f64, mat: f64| {
                    mesh.face(
                        &scope,
                        &[point(x0, y0), point(x0, y1), point(x1, y1), point(x1, y0)],
                        mat,
                    );
                };
                quad(start, a, y, y + height, 0.);
                quad(b, end, y, y + height, 0.);
                quad(a, b, y, low, 0.);
                quad(a, b, high, y + height, 0.);
                quad(a, b, low, high, 1.);
            }
        }
        y += height;
    }
    mesh.face(
        &scope,
        &[
            [-w / 2., 0., -d / 2.],
            [w / 2., 0., -d / 2.],
            [w / 2., 0., d / 2.],
            [-w / 2., 0., d / 2.],
        ],
        3.,
    );
    if rise == 0. {
        mesh.face(
            &scope,
            &[
                [-w / 2., y, -d / 2.],
                [-w / 2., y, d / 2.],
                [w / 2., y, d / 2.],
                [w / 2., y, -d / 2.],
            ],
            2.,
        );
    } else {
        mesh.face(
            &scope,
            &[
                [-w / 2., y, -d / 2.],
                [0., y + rise, -d / 2.],
                [w / 2., y, -d / 2.],
            ],
            2.,
        );
        mesh.face(
            &scope,
            &[
                [w / 2., y, d / 2.],
                [0., y + rise, d / 2.],
                [-w / 2., y, d / 2.],
            ],
            2.,
        );
        mesh.face(
            &scope,
            &[
                [-w / 2., y, -d / 2.],
                [-w / 2., y, d / 2.],
                [0., y + rise, d / 2.],
                [0., y + rise, -d / 2.],
            ],
            2.,
        );
        mesh.face(
            &scope,
            &[
                [0., y + rise, -d / 2.],
                [0., y + rise, d / 2.],
                [w / 2., y, d / 2.],
                [w / 2., y, -d / 2.],
            ],
            2.,
        );
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
