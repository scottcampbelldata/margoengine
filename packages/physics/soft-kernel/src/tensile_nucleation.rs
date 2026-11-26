// The principal Green strain is half the largest squared stretch minus one.
// Li and Barbič (2014), "Stable Orthotropic Materials," section 3, defines the
// reference strain using F^T F. F F^T has the same spectrum and gives current axes.
use crate::World;
use crate::fem::{CRACK_FRONT_MASK, CRACK_FRONT_SHIFT, NONE, NUCLEATED_TET, TORN_TET, UNREPRESENTABLE_TET};
use crate::math::sqrt64;
use crate::vertex_block::{Columns, Vec3, cross, dot};

const EDGES: [(usize, usize, usize, usize); 6] = [
    (0, 1, 2, 3), (0, 2, 1, 3), (0, 3, 1, 2), (1, 2, 0, 3), (1, 3, 0, 2), (2, 3, 0, 1),
];

struct Candidate {
    cell: usize,
    stretch: f64,
    axis: Vec3,
    edge: u32,
    face: u32,
}

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

/// A propagation plane must pass through its old edge and cross interior material or coincide with a bonded face.
fn continuing_axis(points: [Vec3; 4], axis: Vec3, flags: u32, bonded: [bool; 4]) -> Option<(u32, Vec3, u32)> {
    let mut best = None;
    let mut balance = 0.0;
    for (edge, (a, b, c, d)) in EDGES.into_iter().enumerate() {
        if flags & (1 << (CRACK_FRONT_SHIFT + edge as u32)) == 0 {
            continue;
        }
        let direction = [0, 1, 2].map(|i| points[b][i] - points[a][i]);
        let length = dot(direction, direction);
        if length <= 0.0 {
            continue;
        }
        let along = dot(axis, direction) / length;
        let perpendicular = [0, 1, 2].map(|i| axis[i] - along * direction[i]);
        let length_squared = dot(perpendicular, perpendicular);
        if length_squared <= 128.0 * f64::EPSILON {
            continue;
        }
        let scale = sqrt64(length_squared).recip();
        let normal = perpendicular.map(|x| x * scale);
        let distance = |p: usize| {
            let terms = [0, 1, 2].map(|i| normal[i] * (points[p][i] - points[a][i]));
            let value = terms.into_iter().sum::<f64>();
            let error = 8.0 * f64::EPSILON * terms.into_iter().map(f64::abs).sum::<f64>();
            if value.abs() <= error { 0.0 } else { value }
        };
        let u = distance(c);
        let v = distance(d);
        let (ratio, face) = if u * v < 0.0 {
            (u.abs().min(v.abs()) / (u.abs() + v.abs()), NONE)
        } else if u == 0.0 && v != 0.0 && bonded[d] {
            (0.0, d as u32)
        } else if v == 0.0 && u != 0.0 && bonded[c] {
            (0.0, c as u32)
        } else {
            continue;
        };
        if best.is_none() || ratio > balance {
            balance = ratio;
            best = Some((edge as u32, normal, face));
        }
    }
    best
}

impl World {
    /// The most stretched admissible crack-tip cell, or an intact cell that can nucleate.
    pub fn tensile_nucleation(&mut self, first: usize, count: usize, threshold: f64) -> u32 {
        let minimum = 1.0 + 2.0 * threshold;
        let (mut existing, mut fresh): (Option<Candidate>, Option<Candidate>) = (None, None);
        for t in first..first + count {
            let flags = self.fem.flags[t];
            let at_front = flags & CRACK_FRONT_MASK != 0;
            if flags & (TORN_TET | NUCLEATED_TET | UNREPRESENTABLE_TET) != 0 || (!at_front && existing.is_some()) {
                continue;
            }
            let corners = [0, 1, 2, 3].map(|i| self.fem.p[i][t] as usize);
            let inverse = [0, 1, 2].map(|i| [0, 1, 2].map(|j| self.fem.b[3 * i + j][t] as f64));
            let f = self.vertex_deformation(corners, inverse, false);
            if !(dot(f[0], cross(f[1], f[2])) > 0.0) {
                continue;
            }
            let selected = if at_front { &mut existing } else { &mut fresh };
            let limit = selected.as_ref().map_or(minimum, |best| best.stretch);
            let Some((stretch, axis)) = principal_stretch(f, limit) else {
                continue;
            };
            if stretch <= limit {
                continue;
            }
            let (edge, axis, face) = if at_front {
                let points = corners.map(|p| [self.x[p] as f64, self.y[p] as f64, self.z[p] as f64]);
                let bonded = self.fem.nb.each_ref().map(|neighbors| neighbors[t] != NONE);
                let Some(front) = continuing_axis(points, axis, flags, bonded) else {
                    continue;
                };
                front
            } else {
                (NONE, axis, NONE)
            };
            *selected = Some(Candidate { cell: t, stretch, axis, edge, face });
        }
        let Some(candidate) = existing.or(fresh) else { return NONE };
        self.fem.fracture_axis = candidate.axis;
        self.fem.fracture_edge = candidate.edge;
        self.fem.fracture_face = candidate.face;
        candidate.cell as u32
    }
}

#[cfg(test)]
mod tests {
    use super::{CRACK_FRONT_SHIFT, NONE, continuing_axis, dot, principal_stretch};

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

    #[test]
    fn projected_axis_advances_through_the_existing_edge_without_cutting_a_tangent() {
        let tet = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, -1.0], [0.0, 1.0, 1.0]];
        let front = 1 << CRACK_FRONT_SHIFT;
        assert_eq!(continuing_axis(tet, [0.6, 0.0, 0.8], front, [false; 4]), Some((0, [0.0, 0.0, 1.0], NONE)));
        assert_eq!(continuing_axis(tet, [1.0, 0.0, 0.0], front, [true; 4]), None);
        assert_eq!(continuing_axis(tet, [0.0, 1.0, 0.0], front, [true; 4]), None);
    }

    #[test]
    fn coincident_plane_can_release_a_bonded_face_but_never_a_free_face() {
        let tet = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 1.0, 1.0]];
        let front = 1 << CRACK_FRONT_SHIFT;
        let normal = [0.0, 0.0, 1.0];
        assert_eq!(continuing_axis(tet, normal, front, [false, false, false, true]), Some((0, normal, 3)));
        assert_eq!(continuing_axis(tet, normal, front, [false, false, true, false]), None);
    }
}
