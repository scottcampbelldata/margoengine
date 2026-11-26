// A full orthotropic Hooke tensor applied to Green strain in the material frame (Sifakis and Barbič,
// 2012). A fourth-order volume energy selects the proper orientation without changing the tangent
// stiffness at rest. The elastic and damping energies are invariant under rigid rotation.
use crate::World;
use crate::fem::{INTERIOR_TET, NONE};
use crate::vertex_block::{Columns, Vec3, cross, dot, solve, transform};

type Strain = [f64; 6];
const SHEARS: [(usize, usize); 3] = [(0, 1), (0, 2), (1, 2)];
const BLOCK: [(usize, usize); 6] = [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)];

struct OrthotropicCell {
    corners: [usize; 4],
    inverse: Columns,
    gradient: Vec3,
    axes: Columns,
    stiffness: [f64; 9],
    scale: f64,
    damping: f64,
}

impl OrthotropicCell {
    fn stress(&self, e: Strain) -> Strain {
        let [xx, yy, zz, xy, xz, yz, gxy, gxz, gyz] = self.stiffness;
        [
            xx * e[0] + xy * e[1] + xz * e[2],
            xy * e[0] + yy * e[1] + yz * e[2],
            xz * e[0] + yz * e[1] + zz * e[2],
            gxy * e[3],
            gxz * e[4],
            gyz * e[5],
        ]
    }

    fn energy(&self, e: Strain) -> f64 {
        0.5 * dot6(e, self.stress(e))
    }

    fn strain(&self, f: Columns) -> (Strain, Columns) {
        let z = self.axes.map(|axis| transform(f, axis));
        let e = [
            (dot(z[0], z[0]) - 1.0) * 0.5,
            (dot(z[1], z[1]) - 1.0) * 0.5,
            (dot(z[2], z[2]) - 1.0) * 0.5,
            dot(z[0], z[1]),
            dot(z[0], z[2]),
            dot(z[1], z[2]),
        ];
        (e, z)
    }

    fn mean_normal(&self) -> f64 {
        (self.stiffness[0] + self.stiffness[1] + self.stiffness[2]) / 3.0
    }

    fn deficit(f: Columns) -> f64 {
        (1.0 - dot(f[0], cross(f[1], f[2]))).max(0.0)
    }
}

fn dot6(a: Strain, b: Strain) -> f64 {
    a.into_iter().zip(b).map(|(x, y)| x * y).sum()
}

impl World {
    pub fn set_orthotropy(&mut self, first: usize, count: usize, data: [f32; 18]) {
        if count == 0 || (data[9] == 0.0 && self.fem.orthotropy.is_empty()) {
            return;
        }
        self.fem
            .orthotropy
            .resize(self.fem.count.max(first + count));
        self.fem.orthotropy[first..first + count].fill(data);
    }

    pub(crate) fn has_orthotropy(&self, t: usize) -> bool {
        self.fem.orthotropy.get(t).is_some_and(|row| row[9] > 0.0)
    }

    pub fn set_orthotropic_failure(&mut self, first: usize, count: usize, strengths: [f32; 9]) {
        if count == 0 || (strengths[0] == 0.0 && self.fem.orthotropic_failure.is_empty()) {
            return;
        }
        let rows = &mut self.fem.orthotropic_failure;
        let mut data = [0.0; 18];
        data[..9].copy_from_slice(&strengths);
        rows.resize(self.fem.count.max(first + count));
        rows[first..first + count].fill(data);
    }

    /// Seeber et al. (2024), equation 26. The Green-strain conjugate stress is in material axes,
    /// and the signed normal and absolute shear loads keep separate histories.
    pub(crate) fn orthotropic_failure_ratio(&mut self, t: usize, h: f32) -> f32 {
        let Some(row) = self.fem.orthotropic_failure.get(t) else {
            return 0.0;
        };
        if row[0] <= 0.0 || !self.has_orthotropy(t) {
            return 0.0;
        }
        let cell = self.orthotropic_corner(4 * t as u32, h as f64);
        let (strain, _) = cell.strain(self.vertex_deformation(cell.corners, cell.inverse, false));
        let [x, y, z, xy, xz, yz] = cell.stress(strain);
        let loads = [
            x.max(0.0),
            y.max(0.0),
            z.max(0.0),
            (-x).max(0.0),
            (-y).max(0.0),
            (-z).max(0.0),
            xy.abs(),
            xz.abs(),
            yz.abs(),
        ];
        let tau = self.fem.smooth[t];
        let step = if tau > 0.0 {
            (h as f64 / tau as f64).min(1.0)
        } else {
            1.0
        };
        let row = &mut self.fem.orthotropic_failure[t];
        let mut maximum = 0.0f32;
        for (i, load) in loads.into_iter().enumerate() {
            let old = row[9 + i] as f64;
            let target = load / row[i] as f64;
            let next = ((1.0 - step) * old + step * target).min(f32::MAX as f64) as f32;
            row[9 + i] = next;
            maximum = maximum.max(next);
        }
        if self.fem.flags[t] & INTERIOR_TET != 0 {
            maximum / self.fem.interior[t]
        } else {
            maximum
        }
    }

    /// A body's cells share one material; its incident corners all use the same elastic law.
    fn orthotropic_corner(&self, link: u32, dt: f64) -> OrthotropicCell {
        let t = (link / 4) as usize;
        let c = (link % 4) as usize;
        let row = &self.fem.orthotropy[t];
        let inverse = [0, 1, 2].map(|i| [0, 1, 2].map(|j| self.fem.b[3 * i + j][t] as f64));
        let gradient = if c == 0 {
            [0, 1, 2].map(|i| -inverse[0][i] - inverse[1][i] - inverse[2][i])
        } else {
            inverse[c - 1]
        };
        OrthotropicCell {
            corners: [0, 1, 2, 3].map(|i| self.fem.p[i][t] as usize),
            inverse,
            gradient,
            axes: [0, 1, 2].map(|i| [0, 1, 2].map(|j| row[3 * i + j] as f64)),
            stiffness: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(|i| row[9 + i] as f64),
            scale: self.fem.vol0[t] as f64 * dt * dt,
            damping: self.fem.imp.beta[t] as f64 / dt,
        }
    }

    fn orthotropic_energy(&self, mut link: u32, dt: f64) -> f64 {
        let mut energy = 0.0;
        while link != NONE {
            let m = self.orthotropic_corner(link, dt);
            let f = self.vertex_deformation(m.corners, m.inverse, false);
            let (e, _) = m.strain(f);
            let compression = OrthotropicCell::deficit(f);
            let compression2 = compression * compression;
            let damping = if m.damping > 0.0 {
                let (old, _) = m.strain(self.vertex_deformation(m.corners, m.inverse, true));
                let change = [0, 1, 2, 3, 4, 5].map(|i| e[i] - old[i]);
                m.damping * m.energy(change)
            } else {
                0.0
            };
            energy += m.scale
                * (m.energy(e) + damping + m.mean_normal() * compression2 * compression2 * 0.25);
            link = self.fem.vertex_block.next[link as usize];
        }
        energy
    }

    pub(crate) fn solve_orthotropic_vertex(&mut self, i: usize, head: u32, h: f32) {
        let dt = h as f64;
        let mass = 1.0 / self.w[i] as f64;
        let start = [self.x[i], self.y[i], self.z[i]];
        let inertial = [
            self.px[i] + h * self.vx[i],
            self.py[i] + h * self.vy[i],
            self.pz[i] + h * self.vz[i],
        ]
        .map(f64::from);
        let offset = [0, 1, 2].map(|a| start[a] as f64 - inertial[a]);
        let mut gradient = offset.map(|x| mass * x);
        let mut stiffness = [mass, mass, mass, 0.0, 0.0, 0.0];
        let mut link = head;
        while link != NONE {
            let m = self.orthotropic_corner(link, dt);
            let f = self.vertex_deformation(m.corners, m.inverse, false);
            let (e, z) = m.strain(f);
            let mut stress = m.stress(e);
            if m.damping > 0.0 {
                let (old, _) = m.strain(self.vertex_deformation(m.corners, m.inverse, true));
                let rate = m.stress([0, 1, 2, 3, 4, 5].map(|k| e[k] - old[k]));
                for k in 0..6 {
                    stress[k] += m.damping * rate[k];
                }
            }
            let b = m.axes.map(|axis| dot(axis, m.gradient));
            let normal = [0, 1, 2].map(|k| z[k].map(|v| b[k] * v));
            let shear = SHEARS.map(|(p, q)| [0, 1, 2].map(|a| b[p] * z[q][a] + b[q] * z[p][a]));
            let differential = [
                normal[0], normal[1], normal[2], shear[0], shear[1], shear[2],
            ];
            let jac = [0, 1, 2].map(|a| differential.map(|d| d[a]));
            let elastic_hessian = jac.map(|d| m.stress(d));
            let metric = [
                b[0] * b[0],
                b[1] * b[1],
                b[2] * b[2],
                2.0 * b[0] * b[1],
                2.0 * b[0] * b[2],
                2.0 * b[1] * b[2],
            ];
            let geometric = dot6(stress, metric).max(0.0);
            let compression = OrthotropicCell::deficit(f);
            let dj = transform(
                [cross(f[1], f[2]), cross(f[2], f[0]), cross(f[0], f[1])],
                m.gradient,
            );
            let volume_gradient = m.mean_normal() * compression * compression * compression;
            let volume_hessian = 3.0 * m.mean_normal() * compression * compression;
            for a in 0..3 {
                gradient[a] += m.scale * (dot6(stress, jac[a]) - volume_gradient * dj[a]);
                stiffness[a] += m.scale * geometric;
            }
            for (row, (a, b)) in BLOCK.into_iter().enumerate() {
                stiffness[row] += m.scale
                    * ((1.0 + m.damping) * dot6(jac[a], elastic_hessian[b])
                        + volume_hessian * dj[a] * dj[b]);
            }
            link = self.fem.vertex_block.next[link as usize];
        }
        let delta = solve(stiffness, gradient);
        let initial = 0.5 * mass * dot(offset, offset) + self.orthotropic_energy(head, dt);
        let mut weight = 1.0;
        // The full Green-strain objective is quartic in a vertex. The positive block gives a
        // descent direction, and evaluation at the rounded position guards against overshoot.
        for _ in 0..=f32::MANTISSA_DIGITS {
            let point = [0, 1, 2].map(|a| (start[a] as f64 - weight * delta[a]) as f32);
            if point == start {
                break;
            }
            if point.iter().all(|x| x.is_finite()) {
                [self.x[i], self.y[i], self.z[i]] = point;
                let changed = [0, 1, 2].map(|a| point[a] as f64 - inertial[a]);
                let value = 0.5 * mass * dot(changed, changed) + self.orthotropic_energy(head, dt);
                if value <= initial {
                    return;
                }
            }
            weight *= 0.5;
        }
        [self.x[i], self.y[i], self.z[i]] = start;
    }
}
