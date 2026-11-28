// A hyperelastic thin-shell membrane on the triangles of a closed soft surface, with the gas it holds, solved by vertex block
// descent (Chen, Liu, Yang and Yuksel, "Vertex Block Descent", ACM TOG 43(4), SIGGRAPH 2024).
//
// The law is the incompressible neo-Hookean membrane (Treloar, "The Physics of Rubber Elasticity", 3rd ed. 1975, ch. 4 and
// 10; Adkins and Rivlin, "Large elastic deformations of isotropic materials IX: the deformation of thin shells", Phil.
// Trans. R. Soc. A 244, 1952): with F the 3 x 2 deformation gradient of a triangle (its rest shape in its own plane mapped
// to where it is now), C = F^T F and J = sqrt(det C) = |f0 x f1| its area stretch, the thickness follows from
// incompressibility as H / J, and the energy per rest area is (mu H / 2) (tr C + 1 / J^2 - 3). A sphere of rest radius R
// stretched by lambda all round then needs the pressure p = 2 mu H / R (1 / lambda - 1 / lambda^7) (the same papers; the
// peak at lambda = 7^(1/6) is a balloon's), which the tests hold it to.
//
// The gas is the isothermal chamber of src/volume.rs, here as its energy, -nRT ln V + p_out V, so the membrane and the gas
// meet at one stationary point: their forces balance there. Each pass visits every particle on a membrane and takes one
// Newton step on its own three coordinates of the piece's incremental potential, m/2 |x - y|^2 + h^2 (E_membrane + E_gas),
// with the others held. Per particle and triangle the Hessian used is the majorizer mu H A0 [|s|^2 I + 3 J^-4 q q^T] (q the
// gradient of J at the particle, s its row of the rest-shape inverse): J is the norm of a function affine in one particle,
// so convex in it, and the dropped term -J^-3 d2J is negative. The gas's Hessian, nRT / V^2 g g^T, is exact, V being linear
// in each particle. The step is then cut back until the particle's potential falls, as the rubber cells' is
// (vertex_block.rs), so every step lowers the potential.
use crate::math::sqrt64;
use crate::world::World;
use margoengine_physics_kernel_common::pinned::ln;

const NONE: u32 = u32::MAX;

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// One triangle's terms at one of its corners: the energy per rest area over mu H, its gradient (same scale) and q, the
/// gradient of the area stretch J; None for a triangle flattened to no area.
fn corner_terms(e1: V3, e2: V3, m: [f64; 4], s: [f64; 2]) -> Option<(f64, V3, V3, f64)> {
    // F = [e1 e2] Dm^-1, the inverse stored row major: f0 = m00 e1 + m10 e2, f1 = m01 e1 + m11 e2.
    let f0 = [0, 1, 2].map(|k| m[0] * e1[k] + m[2] * e2[k]);
    let f1 = [0, 1, 2].map(|k| m[1] * e1[k] + m[3] * e2[k]);
    let n = cross(f0, f1);
    let j = sqrt64(dot(n, n));
    if !(j > 1e-12) {
        return None;
    }
    let u = [n[0] / j, n[1] / j, n[2] / j];
    // dJ/dx = s0 (f1 x u) + s1 (u x f0).
    let a = cross(f1, u);
    let b = cross(u, f0);
    let q = [0, 1, 2].map(|k| s[0] * a[k] + s[1] * b[k]);
    let energy = 0.5 * (dot(f0, f0) + dot(f1, f1) + 1.0 / (j * j) - 3.0);
    let inv3 = 1.0 / (j * j * j);
    let grad = [0, 1, 2].map(|k| s[0] * f0[k] + s[1] * f1[k] - inv3 * q[k]);
    Some((energy, grad, q, j))
}

impl World {
    /// The particles' lists of membrane triangle corners, rebuilt for the piece; false when no body has a membrane.
    pub(crate) fn prepare_membranes(&mut self) -> bool {
        if !(0..self.bodies).any(|b| self.vb_mu[b] > 0.0 && self.vb_count[b] > 0) {
            return false;
        }
        let corners = self.vtri.len();
        self.mh_head.resize(self.particles);
        self.mh_next.resize(corners);
        for i in 0..self.particles {
            self.mh_head[i] = NONE;
        }
        for b in 0..self.bodies {
            if !(self.vb_mu[b] > 0.0) {
                continue;
            }
            let first = self.vb_first[b] as usize;
            for t in first..first + self.vb_count[b] as usize {
                for k in 0..3 {
                    let slot = 3 * t + k;
                    let i = self.vtri[slot] as usize;
                    self.mh_next[slot] = self.mh_head[i];
                    self.mh_head[i] = slot as u32;
                }
            }
        }
        true
    }

    fn membrane_position(&self, i: usize) -> V3 {
        [self.x[i] as f64, self.y[i] as f64, self.z[i] as f64]
    }

    /// The body's enclosed volume in f64, measured from its first triangle's first corner.
    fn membrane_volume(&self, b: usize) -> f64 {
        let first = self.vb_first[b] as usize;
        let origin = self.membrane_position(self.vtri[3 * first] as usize);
        let mut volume = 0.0;
        for t in first..first + self.vb_count[b] as usize {
            let [pa, pb, pc] = [0, 1, 2].map(|k| sub(self.membrane_position(self.vtri[3 * t + k] as usize), origin));
            volume += dot(pa, cross(pb, pc)) / 6.0;
        }
        volume
    }

    /// The potential at particle `i` moved by `delta` from `x` (membrane and gas parts, times h^2), with what the gas sees.
    fn membrane_potential(&self, i: usize, x: V3, delta: V3, volume: f64, gas: Option<(f64, f64)>, gv: V3) -> f64 {
        let moved = [x[0] + delta[0], x[1] + delta[1], x[2] + delta[2]];
        let mut energy = 0.0;
        let mut slot = self.mh_head[i];
        while slot != NONE {
            let s = slot as usize;
            slot = self.mh_next[s];
            let t = s / 3;
            let k = s % 3;
            let p = [0, 1, 2].map(|c| if c == k { moved } else { self.membrane_position(self.vtri[3 * t + c] as usize) });
            let m = [self.mt_a[t] as f64, self.mt_b[t] as f64, self.mt_c[t] as f64, self.mt_d[t] as f64];
            let scale = self.vb_mu[self.pbody[i] as usize] as f64 * self.mt_area[t] as f64;
            if !(scale > 0.0) {
                continue;
            }
            match corner_terms(sub(p[1], p[0]), sub(p[2], p[0]), m, [0.0, 0.0]) {
                Some((e, _, _, _)) => energy += scale * e,
                None => return f64::INFINITY,
            }
        }
        if let Some((nrt, ambient)) = gas {
            let v = volume + dot(gv, delta);
            if !(v > 0.0) {
                return f64::INFINITY;
            }
            energy += -nrt * ln(v) + ambient * v;
        }
        energy
    }

    /// One pass over the particles on membranes.
    pub(crate) fn solve_membranes(&mut self, h: f32) {
        let dt = h as f64;
        let h2 = dt * dt;
        for b in 0..self.bodies {
            if !(self.vb_mu[b] > 0.0) || self.vb_count[b] == 0 || self.bsleep[b] != 0 {
                continue;
            }
            let mut volume = self.membrane_volume(b);
            let gas = if self.vb_on[b] == 2 { Some((self.vb_target[b] as f64, self.vb_ambient[b] as f64)) } else { None };
            let mu = self.vb_mu[b] as f64;
            let p0 = self.b_first[b] as usize;
            for i in p0..p0 + self.b_count[b] as usize {
                if self.mh_head[i] == NONE || !(self.w[i] > 0.0) {
                    continue;
                }
                let mass = 1.0 / self.w[i] as f64;
                let x = self.membrane_position(i);
                let target = [
                    (self.px[i] + h * self.vx[i]) as f64,
                    (self.py[i] + h * self.vy[i]) as f64,
                    (self.pz[i] + h * self.vz[i]) as f64,
                ];
                let mut grad = [0, 1, 2].map(|k| mass * (x[k] - target[k]));
                // Symmetric: xx, yy, zz, xy, xz, yz.
                let mut hess = [mass, mass, mass, 0.0, 0.0, 0.0];
                let mut gv = [0.0; 3];
                let mut slot = self.mh_head[i];
                let mut flat = false;
                while slot != NONE {
                    let s = slot as usize;
                    slot = self.mh_next[s];
                    let t = s / 3;
                    let k = s % 3;
                    let p = [0, 1, 2].map(|c| self.membrane_position(self.vtri[3 * t + c] as usize));
                    let m = [self.mt_a[t] as f64, self.mt_b[t] as f64, self.mt_c[t] as f64, self.mt_d[t] as f64];
                    let coefficients = match k {
                        0 => [-m[0] - m[2], -m[1] - m[3]],
                        1 => [m[0], m[1]],
                        _ => [m[2], m[3]],
                    };
                    let (e1, e2) = (sub(p[1], p[0]), sub(p[2], p[0]));
                    // The volume's gradient at this corner: the triangle's area normal over 3 (src/volume.rs).
                    let an = cross(e1, e2);
                    for a in 0..3 {
                        gv[a] += an[a] / 6.0;
                    }
                    // A torn triangle (a burst, rest area 0) holds nothing.
                    if !(self.mt_area[t] > 0.0) {
                        continue;
                    }
                    let Some((_, g, q, j)) = corner_terms(e1, e2, m, coefficients) else {
                        flat = true;
                        continue;
                    };
                    let scale = h2 * mu * self.mt_area[t] as f64;
                    for a in 0..3 {
                        grad[a] += scale * g[a];
                    }
                    let iso = scale * (coefficients[0] * coefficients[0] + coefficients[1] * coefficients[1]);
                    let rank = scale * 3.0 / (j * j * j * j);
                    hess[0] += iso + rank * q[0] * q[0];
                    hess[1] += iso + rank * q[1] * q[1];
                    hess[2] += iso + rank * q[2] * q[2];
                    hess[3] += rank * q[0] * q[1];
                    hess[4] += rank * q[0] * q[2];
                    hess[5] += rank * q[1] * q[2];
                }
                if flat {
                    continue;
                }
                if let Some((nrt, ambient)) = gas {
                    let pull = h2 * (ambient - nrt / volume);
                    let curve = h2 * nrt / (volume * volume);
                    for a in 0..3 {
                        grad[a] += pull * gv[a];
                    }
                    hess[0] += curve * gv[0] * gv[0];
                    hess[1] += curve * gv[1] * gv[1];
                    hess[2] += curve * gv[2] * gv[2];
                    hess[3] += curve * gv[0] * gv[1];
                    hess[4] += curve * gv[0] * gv[2];
                    hess[5] += curve * gv[1] * gv[2];
                }
                let mut step = crate::vertex_block::solve(hess, grad).map(|v| -v);
                if !step.iter().all(|v| v.is_finite()) || dot(step, step) == 0.0 {
                    continue;
                }
                let inertia = |d: V3| {
                    let r = [x[0] + d[0] - target[0], x[1] + d[1] - target[1], x[2] + d[2] - target[2]];
                    0.5 * mass * dot(r, r)
                };
                let initial = inertia([0.0; 3]) + h2 * self.membrane_potential(i, x, [0.0; 3], volume, gas, gv);
                let mut accepted = false;
                for _ in 0..24 {
                    let next = inertia(step) + h2 * self.membrane_potential(i, x, step, volume, gas, gv);
                    if next.is_finite() && next < initial {
                        accepted = true;
                        break;
                    }
                    step = step.map(|v| v * 0.5);
                }
                if !accepted {
                    continue;
                }
                volume += dot(gv, step);
                self.x[i] = (x[0] + step[0]) as f32;
                self.y[i] = (x[1] + step[1]) as f32;
                self.z[i] = (x[2] + step[2]) as f32;
            }
        }
    }
}
