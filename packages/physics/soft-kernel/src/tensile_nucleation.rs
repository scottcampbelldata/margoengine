// The principal Green strain is half the largest squared stretch minus one.
// Li and Barbič (2014), "Stable Orthotropic Materials," section 3, defines the
// reference strain using F^T F. F F^T has the same spectrum and gives current axes.
use crate::World;
use crate::fem::{NONE, NUCLEATED_TET, TORN_TET};
use crate::math::sqrt64;
use crate::vertex_block::{Columns, Vec3, cross, dot};

/// Largest eigenvalue of F F^T and its world-space eigenvector, via symmetric Jacobi rotations.
fn principal_stretch(f: Columns, minimum: f64) -> Option<(f64, Vec3)> {
    let rows = [0, 1, 2].map(|i| f.map(|column| column[i]));
    let mut tensor = rows.map(|r| rows.map(|s| dot(r, s)));
    // A symmetric tensor's maximum eigenvalue is no larger than its maximum absolute row sum.
    // Nearly resting material can be rejected without diagonalizing it.
    if tensor.into_iter().map(|r| r.into_iter().map(f64::abs).sum::<f64>()).fold(0.0, f64::max) <= minimum {
        return None;
    }
    let mut directions: Columns = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let magnitude = tensor[0][0].max(tensor[1][1]).max(tensor[2][2]);
    for _ in 0..16 {
        let (mut p, mut q) = (0, 1);
        for (i, j) in [(0, 2), (1, 2)] {
            if tensor[i][j].abs() > tensor[p][q].abs() {
                (p, q) = (i, j);
            }
        }
        let off = tensor[p][q];
        if off.abs() <= 8.0 * f64::EPSILON * magnitude {
            break;
        }
        let gap = (tensor[q][q] - tensor[p][p]) * 0.5;
        let scale = gap.abs().max(off.abs());
        let (u, v) = (gap / scale, off / scale);
        let sign = if gap < 0.0 { -1.0 } else { 1.0 };
        let t = sign * v / (u.abs() + sqrt64(u * u + v * v));
        let c = sqrt64(1.0 + t * t).recip();
        let s = t * c;
        tensor[p][p] -= t * off;
        tensor[q][q] += t * off;
        tensor[p][q] = 0.0;
        tensor[q][p] = 0.0;
        let remaining = 3 - p - q;
        let (old_p, old_q) = (tensor[p][remaining], tensor[q][remaining]);
        let (new_p, new_q) = (c * old_p - s * old_q, s * old_p + c * old_q);
        tensor[p][remaining] = new_p;
        tensor[remaining][p] = new_p;
        tensor[q][remaining] = new_q;
        tensor[remaining][q] = new_q;
        let a = directions[p];
        let b = directions[q];
        directions[p] = [0, 1, 2].map(|i| c * a[i] - s * b[i]);
        directions[q] = [0, 1, 2].map(|i| s * a[i] + c * b[i]);
    }
    let index = (1..3).fold(0, |best, i| if tensor[i][i] > tensor[best][best] { i } else { best });
    Some((tensor[index][index], directions[index]))
}

impl World {
    /// The most stretched intact, previously uncracked cell in a body's contiguous range.
    pub fn tensile_nucleation(&mut self, first: usize, count: usize, threshold: f64) -> u32 {
        let mut best = NONE;
        let mut stretch_limit = 1.0 + 2.0 * threshold;
        for t in first..first + count {
            if self.fem.flags[t] & (TORN_TET | NUCLEATED_TET) != 0 {
                continue;
            }
            let corners = [0, 1, 2, 3].map(|i| self.fem.p[i][t] as usize);
            let inverse = [0, 1, 2].map(|i| [0, 1, 2].map(|j| self.fem.b[3 * i + j][t] as f64));
            let f = self.vertex_deformation(corners, inverse, false);
            if !(dot(f[0], cross(f[1], f[2])) > 0.0) {
                continue;
            }
            let Some((stretch, axis)) = principal_stretch(f, stretch_limit) else {
                continue;
            };
            if stretch > stretch_limit {
                stretch_limit = stretch;
                best = t as u32;
                self.fem.fracture_axis = axis;
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::{dot, principal_stretch};

    #[test]
    fn rotated_and_compressed_principal_stretches_match_the_analytic_spectrum() {
        let f = [[1.2 * 0.6, 1.2 * 0.8, 0.0], [-0.8, 0.6, 0.0], [0.0, 0.0, 0.9]];
        let (stretch, axis) = principal_stretch(f, 1.0).unwrap();
        assert!((stretch - 1.44).abs() <= 8.0 * f64::EPSILON);
        assert!((dot(axis, [0.6, 0.8, 0.0]).abs() - 1.0).abs() <= 8.0 * f64::EPSILON);
        let compressed = [[0.8, 0.0, 0.0], [0.0, 0.9, 0.0], [0.0, 0.0, 0.7]];
        let (compression, _) = principal_stretch(compressed, 0.0).unwrap();
        assert!((compression - 0.81).abs() <= f64::EPSILON);
        assert!(principal_stretch(compressed, 1.0).is_none());
    }
}
