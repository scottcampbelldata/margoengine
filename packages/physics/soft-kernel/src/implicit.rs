// The implicit finite element solver of tetrahedral cells: one linear solve a substep, so the stiffness of a body does not depend on
// the number of passes it is given, as it does for the constraints of src/fem.rs.
//
// Each substep takes the velocities the particles have (gravity and the forces of the step already in them) and the elastic forces
// at the positions the substep began from, and finds the new velocities v' from the linearly implicit step of Baraff and Witkin,
// "Large Steps in Cloth Simulation" (SIGGRAPH 1998):
//
//     (M + h D + h^2 K) v' = M v + h f,        x' = x + h v',
//
// with K the stiffness matrix of the elastic forces and D = beta K the Rayleigh damping of Rayleigh, "The Theory of Sound" (1877),
// for the share of the speed along the cells' constraints each cell is asked to lose. A cell's force is the first Piola-Kirchhoff
// stress of its model against the gradients of its shape functions, f_i = -V P g_i (Bonet and Wood, "Nonlinear Continuum Mechanics
// for Finite Element Analysis", 1997): the stable Neo-Hookean of Smith, De Goes and Kim (2018) in the constraint form's own energy
// (Macklin and Mueller 2021) or the co-rotated linear one of Mueller and Gross (2004). Its matrix is the co-rotated K = R K0 R^T of
// the element (Mueller and Gross 2004; the matrix is positive semi-definite for any stretch, so the solve cannot go indefinite
// whatever the force model; with the Neo-Hookean force the step is a quasi-Newton one, and the same fixed point). K0 is the matrix of
// linear elasticity of a tetrahedron, K_ij w = V (lambda g_i (g_j . w) + mu (g_j (g_i . w) + (g_i . g_j) w)) (Zienkiewicz and Taylor,
// "The Finite Element Method", ch. 6), and its product with a vector is a short loop over the corners, so the system is solved by
// the conjugate gradient method of Hestenes and Stiefel (1952) without ever forming a matrix, with the diagonal of the mass and the
// stiffness as its preconditioner (Shewchuk, "An Introduction to the Conjugate Gradient Method Without the Agonizing Pain", 1994).
// A particle that does not move (infinite mass) keeps its velocity and is left out of the unknowns. A body of no more unknowns than
// `dense` is iterated until its residual is gone, as far as it has unknowns, the way a direct solve would finish. All the algebra is
// in f64 from f32 positions with only + - * / and compares, so a result is the same on every run.
use crate::World;
use crate::col::Col;
use crate::fem::{COROTATED, IMPLICIT_TET, TORN_TET, VOLUME, det, mul, rotation_of, transposed};

const F: Col<f32> = Col::new();
const D: Col<f64> = Col::new();

pub struct Implicit {
    /// Relative residual that ends a solve, the most passes of it, and the unknowns at or below which it runs to the end.
    pub tolerance: f32,
    pub iterations: u32,
    pub dense: u32,
    /// Per cell: its rotation, the gradients of its four shape functions, and the Rayleigh factor of its damping (set by the host).
    pub rot: [Col<f32>; 9],
    pub grad: [Col<f32>; 12],
    pub beta: Col<f32>,
    /// Per particle, for each axis: the right side, the unknowns, the residual, the search direction, A times it.
    pub rhs: [Col<f64>; 3],
    pub sol: [Col<f64>; 3],
    pub res: [Col<f64>; 3],
    pub dir: [Col<f64>; 3],
    pub aq: [Col<f64>; 3],
    pub diag: Col<f64>,
    pub mass: Col<f64>,
    /// Per particle, the unit normal of the still body it rests on, along which the solve holds its velocity at zero (zero: none),
    /// and whether the floor pulled it at the last piece, so this piece lets it go (Baraff and Witkin 1998, section 5.3).
    pub floor: [Col<f32>; 3],
    pub lift: Col<u32>,
    /// Per particle, whether this piece's first guess is made (fem_implicit).
    pub guessed: Col<u32>,
    /// Whether the solve under way filters by `floor` (the fem solve does; the projective one does not).
    pub filtered: bool,
}

impl Implicit {
    pub const fn new() -> Implicit {
        Implicit {
            tolerance: 1e-5,
            iterations: 20,
            dense: 600,
            rot: [F; 9],
            grad: [F; 12],
            beta: F,
            rhs: [D; 3],
            sol: [D; 3],
            res: [D; 3],
            dir: [D; 3],
            aq: [D; 3],
            diag: D,
            mass: D,
            floor: [F; 3],
            lift: Col::new(),
            guessed: Col::new(),
            filtered: false,
        }
    }

    pub fn reserve_cells(&mut self, tets: usize) {
        for c in self.rot.iter_mut().chain(self.grad.iter_mut()) {
            c.resize(tets);
        }
        self.beta.resize(tets);
    }

    pub fn reserve_particles(&mut self, particles: usize) {
        for c in self.rhs.iter_mut().chain(self.sol.iter_mut()).chain(self.res.iter_mut()).chain(self.dir.iter_mut()).chain(self.aq.iter_mut()) {
            c.resize(particles);
        }
        self.diag.resize(particles);
        self.mass.resize(particles);
        for c in self.floor.iter_mut() {
            c.resize(particles);
        }
        self.lift.resize(particles);
        self.guessed.resize(particles);
    }
}

impl World {
    fn implicit_cell(&self, t: usize) -> bool {
        self.fem.flags[t] & TORN_TET == 0 && self.fem.flags[t] & IMPLICIT_TET != 0 && self.fem.model[t] != VOLUME
    }

    /// The product of the system matrix with the vector in `v` (scaled by the cells' stiffness) into `out`.
    fn implicit_multiply(&mut self, h: f64, input: u8) {
        let n = self.particles;
        for i in 0..n {
            let m = self.fem.imp.mass[i];
            for a in 0..3 {
                let v = if input == 0 { self.fem.imp.sol[a][i] } else { self.fem.imp.dir[a][i] };
                self.fem.imp.aq[a][i] = m * v;
            }
        }
        for t in 0..self.fem.count {
            if !self.implicit_cell(t) {
                continue;
            }
            let c = [self.fem.p[0][t] as usize, self.fem.p[1][t] as usize, self.fem.p[2][t] as usize, self.fem.p[3][t] as usize];
            let (mu, lambda, vol) = (self.fem.mu[t] as f64, self.fem.lambda[t] as f64, self.fem.vol0[t] as f64);
            let scale = (self.fem.imp.beta[t] as f64) * h + h * h;
            let r = &self.fem.imp;
            let rot = [
                r.rot[0][t] as f64, r.rot[1][t] as f64, r.rot[2][t] as f64, r.rot[3][t] as f64, r.rot[4][t] as f64, r.rot[5][t] as f64,
                r.rot[6][t] as f64, r.rot[7][t] as f64, r.rot[8][t] as f64,
            ];
            let mut g = [[0.0f64; 3]; 4];
            for i in 0..4 {
                for a in 0..3 {
                    g[i][a] = r.grad[3 * i + a][t] as f64;
                }
            }
            // The corners' vectors in the cell's rest frame: R^T w.
            let mut w = [[0.0f64; 3]; 4];
            for j in 0..4 {
                let p = c[j];
                let v = if input == 0 {
                    [r.sol[0][p], r.sol[1][p], r.sol[2][p]]
                } else {
                    [r.dir[0][p], r.dir[1][p], r.dir[2][p]]
                };
                for a in 0..3 {
                    w[j][a] = rot[a] * v[0] + rot[3 + a] * v[1] + rot[6 + a] * v[2];
                }
            }
            let mut s = 0.0;
            for j in 0..4 {
                s += g[j][0] * w[j][0] + g[j][1] * w[j][1] + g[j][2] * w[j][2];
            }
            for i in 0..4 {
                let mut f = [lambda * s * g[i][0], lambda * s * g[i][1], lambda * s * g[i][2]];
                for j in 0..4 {
                    let gi_w = g[i][0] * w[j][0] + g[i][1] * w[j][1] + g[i][2] * w[j][2];
                    let gi_gj = g[i][0] * g[j][0] + g[i][1] * g[j][1] + g[i][2] * g[j][2];
                    for a in 0..3 {
                        f[a] += mu * (g[j][a] * gi_w + gi_gj * w[j][a]);
                    }
                }
                let k = scale * vol;
                let out = [
                    rot[0] * f[0] + rot[1] * f[1] + rot[2] * f[2],
                    rot[3] * f[0] + rot[4] * f[1] + rot[5] * f[2],
                    rot[6] * f[0] + rot[7] * f[1] + rot[8] * f[2],
                ];
                let p = c[i];
                for a in 0..3 {
                    self.fem.imp.aq[a][p] += k * out[a];
                }
            }
        }
    }

    /// Takes the cells with the implicit solver a substep: the new velocities and, from them, the positions.
    pub(crate) fn fem_implicit(&mut self, h: f32, gravity: [f32; 3]) {
        let mut any = false;
        for t in 0..self.fem.count {
            if self.implicit_cell(t) {
                any = true;
                break;
            }
        }
        if !any {
            return;
        }
        let n = self.particles;
        let hh = h as f64;
        for i in 0..n {
            let m = if self.w[i] > 0.0 { 1.0 / self.w[i] as f64 } else { 0.0 };
            self.fem.imp.mass[i] = m;
            self.fem.imp.rhs[0][i] = m * self.vx[i] as f64;
            self.fem.imp.rhs[1][i] = m * self.vy[i] as f64;
            self.fem.imp.rhs[2][i] = m * self.vz[i] as f64;
            self.fem.imp.diag[i] = m;
        }
        // The forces at the positions the substep began from, and the rotation and gradients each cell keeps for the solve.
        for t in 0..self.fem.count {
            if !self.implicit_cell(t) {
                continue;
            }
            let c = [self.fem.p[0][t] as usize, self.fem.p[1][t] as usize, self.fem.p[2][t] as usize, self.fem.p[3][t] as usize];
            let (mu, lambda, vol) = (self.fem.mu[t], self.fem.lambda[t], self.fem.vol0[t]);
            let b: [f32; 9] = [
                self.fem.b[0][t], self.fem.b[1][t], self.fem.b[2][t], self.fem.b[3][t], self.fem.b[4][t], self.fem.b[5][t], self.fem.b[6][t],
                self.fem.b[7][t], self.fem.b[8][t],
            ];
            let (ox, oy, oz) = (self.px[c[0]], self.py[c[0]], self.pz[c[0]]);
            let ds: [f32; 9] = [
                self.px[c[1]] - ox, self.px[c[2]] - ox, self.px[c[3]] - ox, self.py[c[1]] - oy, self.py[c[2]] - oy, self.py[c[3]] - oy,
                self.pz[c[1]] - oz, self.pz[c[2]] - oz, self.pz[c[3]] - oz,
            ];
            let f = mul(&ds, &b);
            let r = rotation_of(&f);
            // The gradients of the shape functions: the rows of B for the three edges, minus their sum for the first corner.
            let mut g = [[0.0f32; 3]; 4];
            for k in 0..3 {
                for a in 0..3 {
                    g[k + 1][a] = b[3 * k + a];
                    g[0][a] -= b[3 * k + a];
                }
            }
            for i in 0..9 {
                self.fem.imp.rot[i][t] = r[i];
            }
            for i in 0..4 {
                for a in 0..3 {
                    self.fem.imp.grad[3 * i + a][t] = g[i][a];
                }
            }
            // The stress: stable Neo-Hookean (mu F + lambda (J - 1 - mu / lambda) cof F) or co-rotated linear.
            let mut p = [0.0f32; 9];
            if self.fem.model[t] == COROTATED {
                let rt = transposed(&r);
                let rtf = mul(&rt, &f);
                let tr = rtf[0] + rtf[4] + rtf[8] - 3.0;
                for k in 0..9 {
                    p[k] = 2.0 * mu * (f[k] - r[k]) + lambda * tr * r[k];
                }
            } else {
                let col = |k: usize| [f[k], f[3 + k], f[6 + k]];
                let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
                let (c0, c1, c2) = (cross(col(1), col(2)), cross(col(2), col(0)), cross(col(0), col(1)));
                let cof = [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
                let gamma = 1.0 + mu / lambda;
                let j = det(&f);
                for k in 0..9 {
                    p[k] = mu * f[k] + lambda * (j - gamma) * cof[k];
                }
            }
            for i in 0..4 {
                let fi = [
                    -vol * (p[0] * g[i][0] + p[1] * g[i][1] + p[2] * g[i][2]),
                    -vol * (p[3] * g[i][0] + p[4] * g[i][1] + p[5] * g[i][2]),
                    -vol * (p[6] * g[i][0] + p[7] * g[i][1] + p[8] * g[i][2]),
                ];
                for a in 0..3 {
                    self.fem.imp.rhs[a][c[i]] += hh * fi[a] as f64;
                }
            }
            // Rayleigh damping: the factor beta on the cell's stiffness is written for it (src/soft.ts: the rate it is asked to lose over
            // the square of its shear wave's frequency).
            let beta = self.fem.imp.beta[t];
            let scale = beta as f64 * hh + hh * hh;
            for i in 0..4 {
                let gg = (g[i][0] * g[i][0] + g[i][1] * g[i][1] + g[i][2] * g[i][2]) as f64;
                self.fem.imp.diag[c[i]] += scale * (vol as f64) * ((lambda as f64 + mu as f64) * gg + 3.0 * mu as f64 * gg) / 3.0;
            }
        }
        // A particle resting on a still body is held there inside the solve, as Baraff and Witkin (1998, section 5) hold a
        // constrained particle: its velocity along the floor's normal is held at zero by filtering the residual and the search
        // directions, so the cells meet the floor in the same solve as their elasticity (KB-SOFT-CONTACTSPLIT1). Met only after
        // the solve, the floor took the base back each piece while the rest of the body went on into it. One the floor pulled
        // at the last piece is let go for this one.
        for i in 0..n {
            let normal = if self.fem.imp.mass[i] > 0.0 && self.fem.imp.lift[i] == 0 { self.resting_normal(i) } else { [0.0; 3] };
            self.fem.imp.lift[i] = 0;
            for a in 0..3 {
                self.fem.imp.floor[a][i] = normal[a];
            }
        }
        // The unknowns start at the velocities there are, a resting particle's without its part along the floor's normal; the
        // residual b - A v is left to the free particles. A particle of a cell starts without this piece's accelerations, but
        // as far as it was last accelerating along them (the first guess of Chen et al. 2024, section 3.6, as vertex_block.rs
        // makes it): a body at rest under its load then starts at its answer, where a solve cut short at its iteration limit
        // from the full prediction stopped a load's share off it (a hemisphere pressed on a floor sank by 3.2 times Hertz's
        // approach at the default 20 iterations; KB-SOFT-VBDGUESS1).
        for i in 0..n {
            self.fem.imp.sol[0][i] = self.vx[i] as f64;
            self.fem.imp.sol[1][i] = self.vy[i] as f64;
            self.fem.imp.sol[2][i] = self.vz[i] as f64;
        }
        for i in 0..n {
            self.fem.imp.guessed[i] = 0;
        }
        for t in 0..self.fem.count {
            if !self.implicit_cell(t) {
                continue;
            }
            for k in 0..4 {
                let i = self.fem.p[k][t] as usize;
                if self.fem.imp.mass[i] == 0.0 || self.fem.imp.guessed[i] != 0 {
                    continue;
                }
                self.fem.imp.guessed[i] = 1;
                let scale = self.gravity_scale[self.pbody[i] as usize];
                let a = [gravity[0] * scale + self.ax[i], gravity[1] * scale + self.ay[i], gravity[2] * scale + self.az[i]];
                let a2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
                let v = [self.vx[i] - h * a[0], self.vy[i] - h * a[1], self.vz[i] - h * a[2]];
                let along = if a2 > 0.0 {
                    let last = [(v[0] - self.vbx[i]) / h, (v[1] - self.vby[i]) / h, (v[2] - self.vbz[i]) / h];
                    ((last[0] * a[0] + last[1] * a[1] + last[2] * a[2]) / a2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                for d in 0..3 {
                    self.fem.imp.sol[d][i] = (v[d] + h * a[d] * along) as f64;
                }
                self.vbx[i] = v[0];
                self.vby[i] = v[1];
                self.vbz[i] = v[2];
            }
        }
        for i in 0..n {
            self.filter_floor(i, 3);
        }
        self.fem.imp.filtered = true;
        self.solve_preconditioned(hh, Self::implicit_multiply);
        self.fem.imp.filtered = false;
        // The floor's push on each resting particle is A v - b along its normal: one it pulls is let go at the next piece.
        Self::implicit_multiply(self, hh, 0);
        for i in 0..n {
            let normal = [self.fem.imp.floor[0][i] as f64, self.fem.imp.floor[1][i] as f64, self.fem.imp.floor[2][i] as f64];
            if normal == [0.0; 3] {
                continue;
            }
            let push: f64 = (0..3).map(|a| (self.fem.imp.aq[a][i] - self.fem.imp.rhs[a][i]) * normal[a]).sum();
            if push < 0.0 {
                self.fem.imp.lift[i] = 1;
            }
        }
        // The new velocities, and the particles carried by them from where the substep began.
        for i in 0..n {
            if self.fem.imp.mass[i] == 0.0 {
                continue;
            }
            self.vx[i] = self.fem.imp.sol[0][i] as f32;
            self.vy[i] = self.fem.imp.sol[1][i] as f32;
            self.vz[i] = self.fem.imp.sol[2][i] as f32;
            self.x[i] = self.px[i] + h * self.vx[i];
            self.y[i] = self.py[i] + h * self.vy[i];
            self.z[i] = self.pz[i] + h * self.vz[i];
        }
    }

    /// The unit normal of a still body particle `i` rests on where the piece began (its gap within a micrometre), or zero.
    fn resting_normal(&self, i: usize) -> [f32; 3] {
        for s in 0..crate::world::SLOTS {
            let k = i * crate::world::SLOTS + s;
            let c = self.kc[k];
            if c == crate::world::NONE {
                continue;
            }
            let c = (c - 1) as usize;
            if !self.still(c) || self.dom[c] > 0.0 || self.bmesh[c] > 0.0 || self.linked_to(i, c) {
                continue;
            }
            let carried = [self.mx[c], self.my[c], self.mz[c]];
            let spin = [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]];
            let (n, _, gap) = self.meet(k, c, 0.0, carried, spin, [0.0; 3], [0.0, 0.0, 0.0, 1.0], [self.px[i], self.py[i], self.pz[i]]);
            if gap - self.radius[i] <= 1e-6 {
                return n;
            }
        }
        [0.0; 3]
    }

    /// Takes the part along the floor's normal out of particle `i`'s unknowns (`which` 3), residual (4) or direction (5).
    fn filter_floor(&mut self, i: usize, which: u8) {
        let n = [self.fem.imp.floor[0][i] as f64, self.fem.imp.floor[1][i] as f64, self.fem.imp.floor[2][i] as f64];
        if n == [0.0; 3] {
            return;
        }
        let v = match which {
            3 => &mut self.fem.imp.sol,
            4 => &mut self.fem.imp.res,
            _ => &mut self.fem.imp.dir,
        };
        let along = v[0][i] * n[0] + v[1][i] * n[1] + v[2][i] * n[2];
        for a in 0..3 {
            v[a][i] -= along * n[a];
        }
    }

    /// Diagonal-preconditioned conjugate gradients on the free coordinates.
    pub(crate) fn solve_preconditioned(&mut self, h: f64, multiply: impl Fn(&mut Self, f64, u8)) {
        let n = self.particles;
        multiply(self, h, 0);
        let (mut rz, mut bb, mut free) = (0.0f64, 0.0f64, 0usize);
        for i in 0..n {
            if self.fem.imp.mass[i] == 0.0 {
                for a in 0..3 {
                    self.fem.imp.res[a][i] = 0.0;
                    self.fem.imp.dir[a][i] = 0.0;
                }
                continue;
            }
            free += 1;
            let d = self.fem.imp.diag[i];
            for a in 0..3 {
                self.fem.imp.res[a][i] = self.fem.imp.rhs[a][i] - self.fem.imp.aq[a][i];
                bb += self.fem.imp.rhs[a][i] * self.fem.imp.rhs[a][i];
            }
            if self.fem.imp.filtered {
                self.filter_floor(i, 4);
            }
            for a in 0..3 {
                let r = self.fem.imp.res[a][i];
                self.fem.imp.dir[a][i] = r / d;
                rz += r * r / d;
            }
        }
        let tolerance = (self.fem.imp.tolerance as f64) * (self.fem.imp.tolerance as f64);
        let unknowns = 3 * free;
        let limit = if unknowns as u32 <= self.fem.imp.dense { (self.fem.imp.iterations as usize).max(unknowns) } else { self.fem.imp.iterations as usize };
        let mut rr = 0.0f64;
        for i in 0..n {
            for a in 0..3 {
                rr += self.fem.imp.res[a][i] * self.fem.imp.res[a][i];
            }
        }
        let mut pass = 0;
        while pass < limit && rr > tolerance * bb && rz > 0.0 {
            multiply(self, h, 1);
            let mut pap = 0.0f64;
            for i in 0..n {
                if self.fem.imp.mass[i] == 0.0 {
                    continue;
                }
                for a in 0..3 {
                    pap += self.fem.imp.dir[a][i] * self.fem.imp.aq[a][i];
                }
            }
            if !(pap > 0.0) {
                break;
            }
            let alpha = rz / pap;
            let mut rz_next = 0.0f64;
            rr = 0.0;
            for i in 0..n {
                if self.fem.imp.mass[i] == 0.0 {
                    continue;
                }
                let d = self.fem.imp.diag[i];
                for a in 0..3 {
                    self.fem.imp.sol[a][i] += alpha * self.fem.imp.dir[a][i];
                    self.fem.imp.res[a][i] -= alpha * self.fem.imp.aq[a][i];
                }
                if self.fem.imp.filtered {
                    self.filter_floor(i, 4);
                }
                for a in 0..3 {
                    let r = self.fem.imp.res[a][i];
                    rz_next += r * r / d;
                    rr += r * r;
                }
            }
            let beta = rz_next / rz;
            rz = rz_next;
            for i in 0..n {
                if self.fem.imp.mass[i] == 0.0 {
                    continue;
                }
                let d = self.fem.imp.diag[i];
                for a in 0..3 {
                    self.fem.imp.dir[a][i] = self.fem.imp.res[a][i] / d + beta * self.fem.imp.dir[a][i];
                }
            }
            pass += 1;
        }
    }
}
