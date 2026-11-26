// Bouaziz, Martin, Liu, Kavan and Pauly (2014), §§3.3, 5.1, 5.2 and Appendix A.
// Tetrahedra project their gradients onto rotations and unit determinant. The same matrix-free
// mass/stiffness system finds the positions that best fit those independent projections.
use crate::World;
use crate::fem::{PROJECTIVE_TET, TORN_TET};
use crate::math::sqrt64;
use crate::vertex_block::{Columns, Vec3, cross, dot, transform};

const AXES: Columns = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn normal(a: Vec3) -> Vec3 {
    let inv = 1.0 / sqrt64(dot(a, a));
    a.map(|v| v * inv)
}

// Orthogonal signed SVD: keep both frames proper and put any reflection on the least singular axis.
fn signed_frames(f: Columns) -> (Columns, Vec3, Columns) {
    let mut gram = f.map(|a| f.map(|b| dot(a, b)));
    let scale = gram.iter().enumerate().map(|(i, col)| col[i]).fold(0.0, f64::max);
    if scale == 0.0 {
        return (AXES, [0.0; 3], AXES);
    }
    let mut basis = AXES;
    for _ in 0..12 {
        let mut rotated = false;
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            let coupling = gram[p][q];
            if coupling.abs() <= scale * f64::EPSILON {
                continue;
            }
            rotated = true;
            let ratio = (gram[q][q] - gram[p][p]) / (2.0 * coupling);
            let turn = ratio.signum() / (ratio.abs() + sqrt64(1.0 + ratio * ratio));
            let cosine = 1.0 / sqrt64(1.0 + turn * turn);
            let sine = cosine * turn;
            gram[p][p] -= turn * coupling;
            gram[q][q] += turn * coupling;
            gram[p][q] = 0.0;
            gram[q][p] = 0.0;
            let other = 3 - p - q;
            let (a, b) = (gram[p][other], gram[q][other]);
            gram[p][other] = cosine * a - sine * b;
            gram[q][other] = sine * a + cosine * b;
            gram[other][p] = gram[p][other];
            gram[other][q] = gram[q][other];
            let (a, b) = (basis[p], basis[q]);
            basis[p] = [0, 1, 2].map(|k| cosine * a[k] - sine * b[k]);
            basis[q] = [0, 1, 2].map(|k| sine * a[k] + cosine * b[k]);
        }
        if !rotated {
            break;
        }
    }
    let mut order = [0, 1, 2];
    order.sort_unstable_by(|&a, &b| gram[b][b].total_cmp(&gram[a][a]).then(a.cmp(&b)));
    let (v0, v1) = (basis[order[0]], basis[order[1]]);
    let v = [v0, v1, cross(v0, v1)];
    let image = v.map(|c| transform(f, c));
    let u0 = normal(image[0]);
    let overlap = dot(u0, image[1]);
    let second = [0, 1, 2].map(|i| image[1][i] - overlap * u0[i]);
    let min_axis = u0.iter().enumerate().min_by(|a, b| a.1.abs().total_cmp(&b.1.abs())).unwrap().0;
    let cutoff = 64.0 * f64::EPSILON;
    let u1 = if dot(second, second) > scale * cutoff * cutoff {
        normal(second)
    } else {
        normal(cross(u0, AXES[min_axis]))
    };
    let u = [u0, u1, cross(u0, u1)];
    let sigma = [0, 1, 2].map(|i| dot(u[i], image[i]));
    (u, sigma, v)
}

fn from_spectrum(u: Columns, sigma: Vec3, v: Columns) -> Columns {
    [0, 1, 2].map(|i| transform(u, [0, 1, 2].map(|k| sigma[k] * v[k][i])))
}

fn product(a: Vec3) -> f64 {
    a[0] * a[1] * a[2]
}

fn distance(a: Vec3, b: Vec3) -> f64 {
    let d = [0, 1, 2].map(|i| a[i] - b[i]);
    dot(d, d)
}

fn threshold(mut lo: f64, mut hi: f64, below: impl Fn(f64) -> bool) -> f64 {
    for _ in 0..56 {
        let x = lo + (hi - lo) * 0.5;
        if x == lo || x == hi {
            break;
        }
        if below(x) { lo = x; } else { hi = x; }
    }
    (lo + hi) * 0.5
}

/// Safeguarded Newton solve for the monotonic branch nearest the unprojected singular values.
fn large_roots(sigma: Vec3, mut hi: f64, compressed: bool) -> Vec3 {
    let mut lo = 0.0;
    let mut k = if compressed && sigma[2] <= 0.0 { 1.0 / hi } else { 0.0 };
    let mut q = sigma;
    let sign = if compressed { 1.0 } else { -1.0 };
    for _ in 0..64 {
        let d = sigma.map(|s| sqrt64(f64::max(s * s + 4.0 * sign * k, 0.0)));
        q = [0, 1, 2].map(|i| {
            if sigma[i] < 0.0 { 2.0 * k / (d[i] - sigma[i]) } else { (sigma[i] + d[i]) * 0.5 }
        });
        let residual = product(q) - 1.0;
        if residual.abs() <= 32.0 * f64::EPSILON {
            break;
        }
        if residual * sign < 0.0 { lo = k; } else { hi = k; }
        let derivative = q[1] * q[2] / d[0] + q[2] * q[0] / d[1] + q[0] * q[1] / d[2];
        let next = k - residual * sign / derivative;
        k = if next > lo && next < hi {
            next
        } else if compressed && lo * 4.0 < hi {
            // A log-space bracket handles inversion with a very large aspect ratio.
            sqrt64(lo.max(f64::MIN_POSITIVE)) * sqrt64(hi)
        } else {
            lo + (hi - lo) * 0.5
        };
    }
    q
}

// The constrained stationary values obey q(q - sigma) = -lambda. The compressed branch increases
// each singular value with a negative multiplier. Under expansion, only the smallest singular
// value can be on the smaller root at a minimum: two negative second derivatives violate the
// product-constraint second-order test. Compare the viable branches in the Euclidean metric.
fn unit_determinant(sigma: Vec3) -> Vec3 {
    let j = product(sigma);
    if (j - 1.0).abs() <= 32.0 * f64::EPSILON {
        return sigma;
    }
    let mut projected = if j < 1.0 {
        large_roots(sigma, 1.0 + sigma.iter().map(|s| s.abs()).fold(0.0, f64::max), true)
    } else {
        let cap = sigma[2] * sigma[2] * 0.25;
        let large = |s, lambda| (s + sqrt64(f64::max(s * s - 4.0 * lambda, 0.0))) * 0.5;
        let plus = |lambda| sigma.map(|s| large(s, lambda));
        let mut best = [sigma[0], sigma[1], 1.0 / (sigma[0] * sigma[1])];
        if product(plus(cap)) <= 1.0 {
            best = large_roots(sigma, cap, false);
        }
        if distance(sigma, best) >= cap {
            let minus = |q| {
                let lambda = q * (sigma[2] - q);
                [large(sigma[0], lambda), large(sigma[1], lambda), q]
            };
            let mut prev = 0.0;
            let intervals = 32;
            for i in 1..=intervals {
                let end = sigma[2] * (i as f64 / (2 * intervals) as f64);
                let low = product(minus(prev)) < 1.0;
                if low != (product(minus(end)) < 1.0) {
                    let q = minus(threshold(prev, end, |t| (product(minus(t)) < 1.0) == low));
                    if distance(sigma, q) < distance(sigma, best) {
                        best = q;
                    }
                }
                prev = end;
            }
        }
        best
    };
    // Make the result feasible to working precision, including the last rounding of the bracket.
    projected[2] = 1.0 / (projected[0] * projected[1]);
    projected
}

fn deformation(positions: [Vec3; 4], g: [Vec3; 4]) -> Columns {
    let edges = [1, 2, 3].map(|i| [0, 1, 2].map(|a| positions[i][a] - positions[0][a]));
    [0, 1, 2].map(|i| transform(edges, [g[1][i], g[2][i], g[3][i]]))
}

impl World {
    fn projective_cell(&self, t: usize) -> bool {
        self.fem.flags[t] & (TORN_TET | PROJECTIVE_TET) == PROJECTIVE_TET
    }

    fn projective_geometry(&self, t: usize, dt: f64) -> ([usize; 4], [Vec3; 4], f64, f64, f64) {
        let corners = [0, 1, 2, 3].map(|i| self.fem.p[i][t] as usize);
        let rows = [0, 1, 2].map(|i| [0, 1, 2].map(|a| self.fem.b[3 * i + a][t] as f64));
        let gradients = [[0, 1, 2].map(|a| -rows[0][a] - rows[1][a] - rows[2][a]), rows[0], rows[1], rows[2]];
        let scale = dt * dt * self.fem.vol0[t] as f64;
        let shear = 2.0 * self.fem.mu[t] as f64 * scale;
        let bulk = 3.0 * self.fem.lambda[t] as f64 * scale;
        let damp = (shear + bulk) * self.fem.imp.beta[t] as f64 / dt;
        (corners, gradients, shear, bulk, damp)
    }

    fn position(&self, i: usize) -> Vec3 {
        [self.x[i] as f64, self.y[i] as f64, self.z[i] as f64]
    }

    fn previous_position(&self, i: usize) -> Vec3 {
        [self.px[i] as f64, self.py[i] as f64, self.pz[i] as f64]
    }

    fn projective_prediction(&self, i: usize, dt: f32) -> Vec3 {
        if self.fem.imp.mass[i] == 0.0 {
            return self.position(i);
        }
        [(self.px[i] + dt * self.vx[i]) as f64, (self.py[i] + dt * self.vy[i]) as f64, (self.pz[i] + dt * self.vz[i]) as f64]
    }

    fn projective_multiply(&mut self, dt: f64, input: u8) {
        let vector = |world: &World, i: usize| {
            let column = if input == 0 { &world.fem.imp.sol } else { &world.fem.imp.dir };
            [0, 1, 2].map(|a| column[a][i])
        };
        for i in 0..self.particles {
            let value = vector(self, i);
            for (a, component) in value.into_iter().enumerate() {
                self.fem.imp.aq[a][i] = self.fem.imp.mass[i] * component;
            }
        }
        for t in 0..self.fem.count {
            if !self.projective_cell(t) {
                continue;
            }
            let (corners, g, shear, bulk, damp) = self.projective_geometry(t, dt);
            let gradient = deformation(corners.map(|i| vector(self, i)), g);
            let w = shear + bulk + damp;
            for (i, shape) in corners.into_iter().zip(g) {
                let product = transform(gradient, shape);
                for (a, component) in product.into_iter().enumerate() {
                    self.fem.imp.aq[a][i] += w * component;
                }
            }
        }
    }

    /// Alternates local projections with a global solve for the correction to the inertial position.
    pub(crate) fn solve_projective(&mut self, h: f32, iterations: u32) {
        if !(0..self.fem.count).any(|t| self.projective_cell(t)) {
            return;
        }
        let dt = h as f64;
        self.fem.imp.mass[..self.particles].fill(0.0);
        self.fem.imp.diag[..self.particles].fill(0.0);
        for t in 0..self.fem.count {
            if !self.projective_cell(t) {
                continue;
            }
            let (corners, g, shear, bulk, damp) = self.projective_geometry(t, dt);
            for (i, shape) in corners.into_iter().zip(g) {
                if self.w[i] > 0.0 && self.bsleep[self.pbody[i] as usize] == 0 {
                    self.fem.imp.mass[i] = 1.0 / self.w[i] as f64;
                    self.fem.imp.diag[i] += (shear + bulk + damp) * dot(shape, shape);
                }
            }
        }
        for i in 0..self.particles {
            self.fem.imp.diag[i] += self.fem.imp.mass[i];
        }
        for _ in 0..iterations {
            for i in 0..self.particles {
                let current = self.position(i);
                let predicted = self.projective_prediction(i, h);
                for a in 0..3 {
                    self.fem.imp.rhs[a][i] = 0.0;
                    self.fem.imp.sol[a][i] = current[a] - predicted[a];
                }
            }
            for t in 0..self.fem.count {
                if !self.projective_cell(t) {
                    continue;
                }
                let (corners, g, shear, bulk, damp) = self.projective_geometry(t, dt);
                let f = deformation(corners.map(|i| self.position(i)), g);
                let x = deformation(corners.map(|i| self.projective_prediction(i, h)), g);
                let old = deformation(corners.map(|i| self.previous_position(i)), g);
                let (u, sigma, v) = signed_frames(f);
                let r = from_spectrum(u, [1.0; 3], v);
                let q = if bulk > 0.0 { from_spectrum(u, unit_determinant(sigma), v) } else { x };
                let target = [0, 1, 2].map(|i| [0, 1, 2].map(|a| {
                    shear * (r[i][a] - x[i][a]) + bulk * (q[i][a] - x[i][a]) + damp * (old[i][a] - x[i][a])
                }));
                for (i, shape) in corners.into_iter().zip(g) {
                    for (a, component) in transform(target, shape).into_iter().enumerate() {
                        self.fem.imp.rhs[a][i] += component;
                    }
                }
            }
            self.solve_preconditioned(dt, Self::projective_multiply);
            for i in 0..self.particles {
                if self.fem.imp.mass[i] == 0.0 {
                    continue;
                }
                let goal = self.projective_prediction(i, h);
                self.x[i] = (goal[0] + self.fem.imp.sol[0][i]) as f32;
                self.y[i] = (goal[1] + self.fem.imp.sol[1][i]) as f32;
                self.z[i] = (goal[2] + self.fem.imp.sol[2][i]) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projective_frames_reconstruct_general_and_inverted_gradients_with_proper_rotations() {
        for f in [
            [[1.0, 0.2, -0.1], [0.3, 1.4, -0.2], [0.4, 0.2, 0.5]],
            [[-1.0, -0.2, 0.1], [0.3, 1.4, -0.2], [0.4, 0.2, 0.5]],
            [[0.0; 3]; 3],
        ] {
            let (u, sigma, v) = signed_frames(f);
            let actual = from_spectrum(u, sigma, v);
            let r = from_spectrum(u, [1.0; 3], v);
            assert!((dot(r[0], cross(r[1], r[2])) - 1.0).abs() < 64.0 * f64::EPSILON);
            for (a, b) in actual.into_iter().zip(f) {
                assert!(distance(a, b) < (64.0 * f64::EPSILON) * (64.0 * f64::EPSILON));
            }
            assert!((product(unit_determinant(sigma)) - 1.0).abs() < 32.0 * f64::EPSILON);
        }
    }

    #[test]
    fn projective_volume_projection_matches_symmetric_compression_and_expansion() {
        for isotropic in [0.1, 0.9, 1.01, 1.2] {
            let p = unit_determinant([isotropic; 3]);
            assert!(p.iter().all(|v| (v - 1.0).abs() <= 32.0 * f64::EPSILON), "{p:?}");
        }
        let extreme = [12.0; 3];
        let p = unit_determinant(extreme);
        assert!((product(p) - 1.0).abs() < 32.0 * f64::EPSILON);
        assert!(distance(p, extreme) < distance([1.0; 3], extreme));
        for sigma in [[0.0; 3], [1000.0, 0.002, -0.0001], [180.0, 70.0, 0.05], [1.0e6, 10.0, 1.0e-4]] {
            let p = unit_determinant(sigma);
            assert!(p.iter().all(|s| s.is_finite() && *s > 0.0), "{sigma:?} -> {p:?}");
            assert!((product(p) - 1.0).abs() < 32.0 * f64::EPSILON);
        }
    }
}
