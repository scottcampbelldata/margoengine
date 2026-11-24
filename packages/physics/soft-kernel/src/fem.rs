// Volumetric soft bodies: tetrahedra with elastic, plastic and tearing material, and shape-matching clusters.
//
// A tetrahedron holds its rest shape as B = Dm^-1, the inverse of the edge matrix from its first corner at rest, and its volume
// V0, so a deformation gradient is F = Ds B from the current edges. Its elasticity is two position-based constraints on F with
// compliances from the Lame parameters, in the form of Macklin and Mueller, "A Constraint-based Formulation of Stable Neo-Hookean
// Elasticity" (SIGGRAPH 2021), which is the stable Neo-Hookean energy of Smith, de Goes and Kim, "Stable Neo-Hookean Flesh
// Simulation" (ACM TOG 2018) solved by XPBD (Macklin, Mueller, Chentanez 2016) in small steps (Macklin et al. 2019):
//
//   deviatoric   C_D = |F|_F             compliance 1 / (mu V0)
//   hydrostatic  C_H = det F - (1 + mu / lambda)   compliance 1 / (lambda V0)
//
// Neither depends on F being close to a rotation or on det F staying above zero, so an inverted element comes back instead of
// locking. The co-rotated model (Mueller and Gross, "Interactive Virtual Materials", 2004) is the option for a stiffer material at
// small strain: C_D = |F - R|_F with compliance 1 / (2 mu V0) and C_V = tr(R^T F) - 3 with 1 / (lambda V0), R the rotation of the
// polar decomposition F = R S, found by the scaled Newton iteration of Higham, "Computing the polar decomposition with
// applications" (SIAM J. Sci. Stat. Comput. 1986), a fixed number of steps of only + - * / sqrt, so it gives the same bits everywhere.
//
// Plasticity follows the multiplicative split of Bargteil, Wojtan, Hodgins and Turk, "A finite element method for animating large
// viscoplastic flow" (SIGGRAPH 2007) and Irving, Teran and Fedkiw (2004): F = Fe Fp, with Fp^-1 folded into B so the elastic
// strain is always read from B and the edges. When the deviatoric part of the elastic stretch S - I, in Frobenius norm, passes
// the yield strain, a share of the excess (all of it at once for a creep of 0, else `creep` per second times the substep) is
// handed to Fp and the element's rest shape moves to where it stands. Tearing is the removal of an element whose stretch passes
// its tear strain, as an edge of a rope tears: its constraints are dropped for good.
//
// A cluster is shape matching (Mueller, Heidelberger, Teschner, Gross, "Meshless Deformations Based on Shape Matching", SIGGRAPH
// 2005): the particles of a group are pulled toward the rest shape of the group turned and moved to where the group stands,
// the turn from the polar decomposition of its covariance A = sum m (x - c) q^T, as an implicit spring of natural frequency
// omega, so it is stable at any stiffness.
extern crate alloc;
use crate::World;
use crate::col::Col;
use crate::math::sqrt;

/// An element is gone: its constraints are not solved again.
pub const TORN_TET: u32 = 1;
/// Elasticity models.
pub const STABLE_NEO_HOOKEAN: u32 = 0;
pub const COROTATED: u32 = 1;

const U: Col<u32> = Col::new();
const F: Col<f32> = Col::new();

pub struct Fem {
    /// Tetrahedra in use, and how many have torn so far.
    pub count: usize,
    pub torn: u32,
    /// Rayleigh-style damping of the elastic constraints, 1 / s: the share of the relative speed along a constraint that they remove.
    pub damping: f32,
    /// The four corners, B = Dm^-1 row by row, rest volume.
    pub p: [Col<u32>; 4],
    pub b: [Col<f32>; 9],
    pub vol0: Col<f32>,
    /// Lame parameters and the model.
    pub mu: Col<f32>,
    pub lambda: Col<f32>,
    pub model: Col<u32>,
    /// Strain past which it flows, how fast (1 / s, 0 for all at once), and past which it tears (0 for never); 0 yield is elastic.
    pub yield_strain: Col<f32>,
    pub creep: Col<f32>,
    pub tear: Col<f32>,
    pub flags: Col<u32>,
    /// The multipliers a substep has gathered.
    pub ld: Col<f32>,
    pub lh: Col<f32>,
    /// Clusters: first member, member count, natural frequency, and the members' rest places from their centre of mass.
    pub clusters: usize,
    pub members: usize,
    pub cstart: Col<u32>,
    pub ccount: Col<u32>,
    pub comega: Col<f32>,
    pub member: Col<u32>,
    pub rest: [Col<f32>; 3],
}

impl Fem {
    pub const fn new() -> Fem {
        Fem {
            count: 0,
            torn: 0,
            damping: 0.0,
            p: [U; 4],
            b: [F; 9],
            vol0: F,
            mu: F,
            lambda: F,
            model: U,
            yield_strain: F,
            creep: F,
            tear: F,
            flags: U,
            ld: F,
            lh: F,
            clusters: 0,
            members: 0,
            cstart: U,
            ccount: U,
            comega: F,
            member: U,
            rest: [F; 3],
        }
    }
}

impl Default for Fem {
    fn default() -> Fem {
        Fem::new()
    }
}

type M3 = [f32; 9];

fn mul(a: &M3, b: &M3) -> M3 {
    let mut o = [0.0; 9];
    for r in 0..3 {
        for c in 0..3 {
            o[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
        }
    }
    o
}
fn transposed(a: &M3) -> M3 {
    [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]
}
fn det(a: &M3) -> f32 {
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
}
fn inverse(a: &M3) -> Option<M3> {
    let d = det(a);
    if !(d.abs() > 1e-20) {
        return None;
    }
    let i = 1.0 / d;
    Some([
        (a[4] * a[8] - a[5] * a[7]) * i,
        (a[2] * a[7] - a[1] * a[8]) * i,
        (a[1] * a[5] - a[2] * a[4]) * i,
        (a[5] * a[6] - a[3] * a[8]) * i,
        (a[0] * a[8] - a[2] * a[6]) * i,
        (a[2] * a[3] - a[0] * a[5]) * i,
        (a[3] * a[7] - a[4] * a[6]) * i,
        (a[1] * a[6] - a[0] * a[7]) * i,
        (a[0] * a[4] - a[1] * a[3]) * i,
    ])
}
fn frob(a: &M3) -> f32 {
    sqrt(a.iter().map(|x| x * x).sum())
}

/// The rotation of the polar decomposition a = R S, a fixed number of scaled Newton steps (Higham 1986); the identity for a
/// matrix with no inverse. An orthogonal factor with determinant -1 (an inverted element) is turned to a rotation by its sign.
fn rotation_of(a: &M3) -> M3 {
    let mut x = *a;
    for _ in 0..12 {
        let Some(inv) = inverse(&x) else { return [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] };
        let it = transposed(&inv);
        let scale = sqrt(frob(&it) / frob(&x));
        let mut next = [0.0; 9];
        for k in 0..9 {
            next[k] = 0.5 * (scale * x[k] + it[k] / scale);
        }
        x = next;
    }
    if det(&x) < 0.0 {
        for v in x.iter_mut() {
            *v = -*v;
        }
    }
    x
}

impl World {
    /// Room for this many tetrahedra, clusters and cluster members.
    pub fn fem_reserve(&mut self, tets: usize, clusters: usize, members: usize) {
        let f = &mut self.fem;
        for c in f.p.iter_mut() {
            c.resize(tets);
        }
        for c in f.b.iter_mut() {
            c.resize(tets);
        }
        for c in [&mut f.vol0, &mut f.mu, &mut f.lambda, &mut f.yield_strain, &mut f.creep, &mut f.tear, &mut f.ld, &mut f.lh] {
            c.resize(tets);
        }
        f.model.resize(tets);
        f.flags.resize(tets);
        for c in [&mut f.cstart, &mut f.ccount] {
            c.resize(clusters);
        }
        f.comega.resize(clusters);
        f.member.resize(members);
        for c in f.rest.iter_mut() {
            c.resize(members);
        }
    }

    /// Makes tetrahedron `t` of the four particles with the shape they stand in now as its rest shape, and the material given. Corners
    /// that make a left-handed element are put in order by swapping the last two. Returns false for a flat element.
    pub fn set_tet(&mut self, t: usize, corners: [u32; 4], mu: f32, lambda: f32, model: u32) -> bool {
        let at = |k: usize| [self.x[corners[k] as usize], self.y[corners[k] as usize], self.z[corners[k] as usize]];
        let mut c = corners;
        let edges = |c: &[u32; 4], s: &World| -> M3 {
            let p = |k: usize| [s.x[c[k] as usize], s.y[c[k] as usize], s.z[c[k] as usize]];
            let o = p(0);
            let (a, b, d) = (p(1), p(2), p(3));
            // Columns are the edges.
            [a[0] - o[0], b[0] - o[0], d[0] - o[0], a[1] - o[1], b[1] - o[1], d[1] - o[1], a[2] - o[2], b[2] - o[2], d[2] - o[2]]
        };
        let _ = at(0);
        let mut dm = edges(&c, self);
        if det(&dm) < 0.0 {
            c.swap(2, 3);
            dm = edges(&c, self);
        }
        let volume = det(&dm) / 6.0;
        let Some(inv) = inverse(&dm) else { return false };
        if !(volume > 0.0) {
            return false;
        }
        let f = &mut self.fem;
        for k in 0..4 {
            f.p[k][t] = c[k];
        }
        for k in 0..9 {
            f.b[k][t] = inv[k];
        }
        f.vol0[t] = volume;
        f.mu[t] = mu;
        f.lambda[t] = lambda;
        f.model[t] = model;
        f.yield_strain[t] = 0.0;
        f.creep[t] = 0.0;
        f.tear[t] = 0.0;
        f.flags[t] = 0;
        f.count = f.count.max(t + 1);
        true
    }

    /// Makes cluster `c` of `count` particles whose ids are already in the member column from `start`, as {@link set_cluster} does.
    pub fn set_cluster_in_place(&mut self, c: usize, start: usize, count: usize, omega: f32) {
        let ids: alloc::vec::Vec<u32> = (0..count).map(|k| self.fem.member[start + k]).collect();
        let before = start;
        self.set_cluster_at(c, before, &ids, omega);
    }

    /// Makes cluster `c` of these particles with the shape they stand in now as its rest shape, held by an implicit spring of natural
    /// frequency `omega`. Members are stored back to back, so clusters must be set in order from the first.
    pub fn set_cluster(&mut self, c: usize, particles: &[u32], omega: f32) {
        let start = if c == 0 { 0 } else { (self.fem.cstart[c - 1] + self.fem.ccount[c - 1]) as usize };
        self.set_cluster_at(c, start, particles, omega);
    }

    fn set_cluster_at(&mut self, c: usize, start: usize, particles: &[u32], omega: f32) {
        let (mut mass, mut cx, mut cy, mut cz) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for &p in particles {
            let p = p as usize;
            let m = if self.w[p] > 0.0 { 1.0 / self.w[p] } else { 1e6 };
            mass += m;
            cx += m * self.x[p];
            cy += m * self.y[p];
            cz += m * self.z[p];
        }
        let (cx, cy, cz) = (cx / mass, cy / mass, cz / mass);
        let f = &mut self.fem;
        f.cstart[c] = start as u32;
        f.ccount[c] = particles.len() as u32;
        f.comega[c] = omega;
        for (k, &p) in particles.iter().enumerate() {
            f.member[start + k] = p;
        }
        for (k, &p) in particles.iter().enumerate() {
            let p = p as usize;
            f.rest[0][start + k] = self.x[p] - cx;
            f.rest[1][start + k] = self.y[p] - cy;
            f.rest[2][start + k] = self.z[p] - cz;
        }
        let f = &mut self.fem;
        f.clusters = f.clusters.max(c + 1);
        f.members = f.members.max(start + particles.len());
    }

    pub(crate) fn fem_begin(&mut self) {
        for t in 0..self.fem.count {
            self.fem.ld[t] = 0.0;
            self.fem.lh[t] = 0.0;
        }
    }

    /// The deformation gradient of tetrahedron `t` from the particles as they stand: columns of Ds B.
    fn gradient(&self, t: usize) -> (M3, [usize; 4]) {
        let f = &self.fem;
        let c = [f.p[0][t] as usize, f.p[1][t] as usize, f.p[2][t] as usize, f.p[3][t] as usize];
        let (ox, oy, oz) = (self.x[c[0]], self.y[c[0]], self.z[c[0]]);
        let ds: M3 = [
            self.x[c[1]] - ox, self.x[c[2]] - ox, self.x[c[3]] - ox,
            self.y[c[1]] - oy, self.y[c[2]] - oy, self.y[c[3]] - oy,
            self.z[c[1]] - oz, self.z[c[2]] - oz, self.z[c[3]] - oz,
        ];
        let b: M3 = [f.b[0][t], f.b[1][t], f.b[2][t], f.b[3][t], f.b[4][t], f.b[5][t], f.b[6][t], f.b[7][t], f.b[8][t]];
        (mul(&ds, &b), c)
    }

    /// The gradients of a constraint wrt the four corners, from its gradient `p` wrt F: row k - 1 of B against the rows of P for
    /// corners 1..3, and corner 0 takes minus their sum.
    fn corner_gradients(&self, t: usize, p: &M3) -> [[f32; 3]; 4] {
        let f = &self.fem;
        let b = [f.b[0][t], f.b[1][t], f.b[2][t], f.b[3][t], f.b[4][t], f.b[5][t], f.b[6][t], f.b[7][t], f.b[8][t]];
        let mut g = [[0.0f32; 3]; 4];
        for k in 0..3 {
            for r in 0..3 {
                g[k + 1][r] = p[3 * r] * b[3 * k] + p[3 * r + 1] * b[3 * k + 1] + p[3 * r + 2] * b[3 * k + 2];
            }
        }
        for r in 0..3 {
            g[0][r] = -(g[1][r] + g[2][r] + g[3][r]);
        }
        g
    }

    /// One XPBD step on the two constraints of an element together, as Macklin and Mueller 2021 solve the stable Neo-Hookean pair (their
    /// section 4): at F = I neither is zero (the deviatoric one has the gradient the hydrostatic one cancels), so a constraint at a time
    /// would settle where the element is inflated. The 2 by 2 system is
    ///
    ///   [ (1 + g_D) J_D W J_D^T + a_D   (1 + g_D) J_D W J_H^T       ] [dl_D]     [ C_D + a_D l_D + g_D J_D dx ]
    ///   [ (1 + g_H) J_H W J_D^T         (1 + g_H) J_H W J_H^T + a_H  ] [dl_H] = - [ C_H + a_H l_H + g_H J_H dx ]
    ///
    /// (the damping factor of a row multiplies the whole row, as in the single constraint of Macklin et al. 2016 eq. 26, so a state
    /// whose multipliers cancel in position, the rest of a stable Neo-Hookean element, moves nothing).
    ///
    /// with a = compliance / h^2 and g the damping share. A constraint with a zero compliance and no gradient is left out.
    #[allow(clippy::too_many_arguments)]
    fn tet_pair(&mut self, t: usize, corners: [usize; 4], cd: f32, pd: &M3, ad: f32, ch: f32, ph: &M3, ah: f32, h: f32) {
        let gd = self.corner_gradients(t, pd);
        let gh = self.corner_gradients(t, ph);
        let (ad, ah) = (ad / (h * h), ah / (h * h));
        let damping = self.fem.damping * h;
        let (gam_d, gam_h) = (ad * damping, ah * damping);
        let (mut dd, mut dh, mut hh, mut reld, mut relh) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for k in 0..4 {
            let i = corners[k];
            let w = self.w[i];
            dd += w * (gd[k][0] * gd[k][0] + gd[k][1] * gd[k][1] + gd[k][2] * gd[k][2]);
            hh += w * (gh[k][0] * gh[k][0] + gh[k][1] * gh[k][1] + gh[k][2] * gh[k][2]);
            dh += w * (gd[k][0] * gh[k][0] + gd[k][1] * gh[k][1] + gd[k][2] * gh[k][2]);
            let (vx, vy, vz) = (self.x[i] - self.px[i], self.y[i] - self.py[i], self.z[i] - self.pz[i]);
            reld += gd[k][0] * vx + gd[k][1] * vy + gd[k][2] * vz;
            relh += gh[k][0] * vx + gh[k][1] * vy + gh[k][2] * vz;
        }
        let a = (1.0 + gam_d) * dd + ad;
        let d = (1.0 + gam_h) * hh + ah;
        let rd = -(cd + ad * self.fem.ld[t] + gam_d * reld);
        let rh = -(ch + ah * self.fem.lh[t] + gam_h * relh);
        // Each row carries its own damping factor, so the matrix is not symmetric.
        let (bd, bh) = ((1.0 + gam_d) * dh, (1.0 + gam_h) * dh);
        let det = a * d - bd * bh;
        if !(det.abs() > 1e-30) {
            return;
        }
        let dl_d = (rd * d - bd * rh) / det;
        let dl_h = (a * rh - bh * rd) / det;
        self.fem.ld[t] += dl_d;
        self.fem.lh[t] += dl_h;
        for k in 0..4 {
            let i = corners[k];
            let w = self.w[i];
            self.x[i] += w * (gd[k][0] * dl_d + gh[k][0] * dl_h);
            self.y[i] += w * (gd[k][1] * dl_d + gh[k][1] * dl_h);
            self.z[i] += w * (gd[k][2] * dl_d + gh[k][2] * dl_h);
        }
    }

    /// One pass over every live tetrahedron and cluster.
    pub(crate) fn solve_fem(&mut self, h: f32) {
        for t in 0..self.fem.count {
            if self.fem.flags[t] & TORN_TET != 0 {
                continue;
            }
            let (mu, lambda, vol) = (self.fem.mu[t], self.fem.lambda[t], self.fem.vol0[t]);
            let (f, c) = self.gradient(t);
            if self.fem.model[t] == COROTATED {
                let r = rotation_of(&f);
                let mut e = [0.0; 9];
                for k in 0..9 {
                    e[k] = f[k] - r[k];
                }
                let n = frob(&e);
                let mut p = e;
                if n > 1e-7 {
                    for v in p.iter_mut() {
                        *v /= n;
                    }
                } else {
                    p = [0.0; 9];
                }
                let value = f[0] * r[0] + f[1] * r[1] + f[2] * r[2] + f[3] * r[3] + f[4] * r[4] + f[5] * r[5] + f[6] * r[6] + f[7] * r[7] + f[8] * r[8] - 3.0;
                self.tet_pair(t, c, n, &p, 1.0 / (2.0 * mu * vol), value, &r, 1.0 / (lambda * vol), h);
            } else {
                let n = frob(&f);
                let mut p = f;
                if n > 1e-7 {
                    for v in p.iter_mut() {
                        *v /= n;
                    }
                }
                // d(det F) / dF: the columns are cross products of the other two columns of F.
                let col = |k: usize| [f[k], f[3 + k], f[6 + k]];
                let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
                let (c0, c1, c2) = (cross(col(1), col(2)), cross(col(2), col(0)), cross(col(0), col(1)));
                let cof: M3 = [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
                let gamma = 1.0 + mu / lambda;
                self.tet_pair(t, c, n, &p, 1.0 / (mu * vol), det(&f) - gamma, &cof, 1.0 / (lambda * vol), h);
            }
        }
        self.solve_clusters(h);
    }

    /// Pulls every cluster's particles toward its rest shape, turned and moved to where the group stands.
    fn solve_clusters(&mut self, h: f32) {
        for c in 0..self.fem.clusters {
            let (start, count, omega) = (self.fem.cstart[c] as usize, self.fem.ccount[c] as usize, self.fem.comega[c]);
            if count == 0 || !(omega > 0.0) {
                continue;
            }
            let (mut mass, mut cx, mut cy, mut cz) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for k in 0..count {
                let p = self.fem.member[start + k] as usize;
                let m = if self.w[p] > 0.0 { 1.0 / self.w[p] } else { 1e6 };
                mass += m;
                cx += m * self.x[p];
                cy += m * self.y[p];
                cz += m * self.z[p];
            }
            let (cx, cy, cz) = (cx / mass, cy / mass, cz / mass);
            // The covariance of the group, A = sum m (x - c) q^T, with q the rest place.
            let mut a = [0.0f32; 9];
            for k in 0..count {
                let p = self.fem.member[start + k] as usize;
                let m = if self.w[p] > 0.0 { 1.0 / self.w[p] } else { 1e6 };
                let d = [self.x[p] - cx, self.y[p] - cy, self.z[p] - cz];
                let q = [self.fem.rest[0][start + k], self.fem.rest[1][start + k], self.fem.rest[2][start + k]];
                for r in 0..3 {
                    for s in 0..3 {
                        a[3 * r + s] += m * d[r] * q[s];
                    }
                }
            }
            let r = rotation_of(&a);
            // An implicit spring to the goal: the share of the way a unit mass of natural frequency omega goes in a substep.
            let wh = omega * h;
            let share = wh * wh / (1.0 + wh * wh);
            for k in 0..count {
                let p = self.fem.member[start + k] as usize;
                if self.w[p] <= 0.0 {
                    continue;
                }
                let q = [self.fem.rest[0][start + k], self.fem.rest[1][start + k], self.fem.rest[2][start + k]];
                let gx = r[0] * q[0] + r[1] * q[1] + r[2] * q[2] + cx;
                let gy = r[3] * q[0] + r[4] * q[1] + r[5] * q[2] + cy;
                let gz = r[6] * q[0] + r[7] * q[1] + r[8] * q[2] + cz;
                self.x[p] += (gx - self.x[p]) * share;
                self.y[p] += (gy - self.y[p]) * share;
                self.z[p] += (gz - self.z[p]) * share;
            }
        }
    }

    /// After a substep's solve: plastic flow into the rest shape, and tearing.
    pub(crate) fn fem_end(&mut self, h: f32) {
        for t in 0..self.fem.count {
            if self.fem.flags[t] & TORN_TET != 0 {
                continue;
            }
            let (yield_strain, tear) = (self.fem.yield_strain[t], self.fem.tear[t]);
            if !(yield_strain > 0.0) && !(tear > 0.0) {
                continue;
            }
            let (f, _) = self.gradient(t);
            let r = rotation_of(&f);
            // The stretch S = R^T F and its strain S - I.
            let s = mul(&transposed(&r), &f);
            let mut strain = s;
            strain[0] -= 1.0;
            strain[4] -= 1.0;
            strain[8] -= 1.0;
            if tear > 0.0 && frob(&strain) > tear {
                self.fem.flags[t] |= TORN_TET;
                self.fem.torn += 1;
                continue;
            }
            if yield_strain > 0.0 {
                // Only the deviatoric part flows, so a plastic element keeps its volume.
                let tr = (strain[0] + strain[4] + strain[8]) / 3.0;
                let mut dev = strain;
                dev[0] -= tr;
                dev[4] -= tr;
                dev[8] -= tr;
                let n = frob(&dev);
                if n > yield_strain {
                    let flow = if self.fem.creep[t] > 0.0 { (self.fem.creep[t] * h).min(1.0) } else { 1.0 };
                    let keep = 1.0 - flow * (1.0 - yield_strain / n);
                    // S' = I + tr I + keep * dev; the rest shape takes B <- B S^-1 S'.
                    let mut next = [0.0f32; 9];
                    for k in 0..9 {
                        next[k] = keep * dev[k];
                    }
                    next[0] += 1.0 + tr;
                    next[4] += 1.0 + tr;
                    next[8] += 1.0 + tr;
                    if let Some(inv) = inverse(&s) {
                        let ratio = mul(&inv, &next);
                        let f = &mut self.fem;
                        let b: M3 = [f.b[0][t], f.b[1][t], f.b[2][t], f.b[3][t], f.b[4][t], f.b[5][t], f.b[6][t], f.b[7][t], f.b[8][t]];
                        let nb = mul(&b, &ratio);
                        for k in 0..9 {
                            f.b[k][t] = nb[k];
                        }
                    }
                }
            }
        }
    }
}
