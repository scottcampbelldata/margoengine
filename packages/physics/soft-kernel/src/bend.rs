// Measured bending of a sheet flat at rest: a plate of bending rigidity B (N m, KES-FB2's B per width) and no Poisson
// coupling stores B/2 (k11^2 + 2 k12^2 + k22^2) per area, k its curvature tensor (second fundamental form), whatever the
// sheet's width. It is built from Bergou, Wardetzky, Harmon, Zorin and Grinspun's quadratic bending ("A quadratic bending
// model for inextensible surfaces", SGP 2006): at each interior edge e (a hinge), the four particles of its two triangles
// (its ends x0, x1, the far corners x2, x3) and the row vector
//
//     K = (c03 + c04, c01 + c02, -c01 - c03, -c02 - c04),
//
// c0k and c1k the cotangents of the rest triangles' angles at x0 and x1, give the vector K x: zero on any flat placement, it
// sums to zero (a translation moves nothing) and, for a sheet bent isometrically, it is |e| times the hinge's dihedral angle
// along the surface normal. Summed over hinges with Bergou's weights, |K x|^2 converges to the integral of the squared mean
// curvature, (k11 + k22)^2: a plate of Poisson's ratio 1, which a free strip bends anticlastically at no cost (a cantilevered
// strip of that energy droops 30 to 45 percent further than a beam of its rigidity, at any width; a woven fabric's Poisson
// effect in bending is near nil). So the hinges' K x are instead gathered into each triangle's curvature tensor, as Cohen-Steiner
// and Morvan's normal-cycle tensor gathers dihedral angles ("Restricted Delaunay triangulations and normal cycle", SoCG
// 2003): over a region, the sum of each edge's angle times its length in the region times the outer product of the edge's
// in-plane normal, over the region's area. With the region a triangle and each of its hinges shared half and half with
// the triangle across,
//
//     k_T = 1 / (2 A_T) sum over its hinges e of (K_e x) (n_e n_e^T),
//
// n_e the unit normal of e in the triangle's rest plane: a vector (the surface normal times the curvature) for each of the
// three components k11, k12, k22, linear in the positions with constant coefficients, so the energy keeps Bergou's
// constant Hessian, invariance under rigid motions and conservation of momentum. On a cylinder of curvature kappa each
// triangle's k_T is exactly kappa u u^T (a triangle of a grid sees the one hinge across the bend). A missing hinge (a free
// edge) adds nothing, a free edge's natural condition.
//
// Each triangle and component is one vector constraint C = R x of compliance 1 / (B_c A_T w_c), w = (1, 2, 1) for k11, k12,
// k22 and B_c the rigidity along the warp (k11, the warp the triangle's u axis), across it (k22) and their mean for the twist
// (k12): three rows each of the exact solve (rigid.rs), each C_a + alpha / h^2 lambda_a = 0 (XPBD's compliant form,
// Macklin, Mueller and Chentanez, MIG 2016), solved with the sheet's threads, links and contacts. A Gauss-Seidel sweep would
// not do: a strip's bending couples every particle along it, and a sweep that leaves a 20-segment cantilever's stiffness to a
// few passes lets it hang far past its measured droop. On the vertex block solver each element adds k_c R_i (R x) to particle
// i's gradient and k_c R_i^2 I to its Hessian, positive however the sheet is bent.
use crate::math::sqrt64;
use crate::world::World;

/// An element on the vertex block solver (the others are rows of the exact solve).
pub const BEND_BLOCK: u32 = 1;
/// Particles an element touches: its triangle's three corners and the far corner across each of its edges.
pub const BEND_PARTS: usize = 6;
/// No particle in a slot (an edge with no triangle across).
pub const BEND_NONE: u32 = u32::MAX;
const NO_SLOT: u32 = u32::MAX;
/// The weights of k11, k12, k22 in the squared norm of the curvature tensor.
const WEIGHT: [f64; 3] = [1.0, 2.0, 1.0];

/// A triangle's area from its squared sides a, b, c: 16 A^2 = 2 (ab + bc + ca) - (a^2 + b^2 + c^2) (Heron's formula).
fn area(a: f64, b: f64, c: f64) -> f64 {
    let sixteen = 2.0 * (a * b + b * c + c * a) - (a * a + b * b + c * c);
    if sixteen > 0.0 { sqrt64(sixteen) / 4.0 } else { 0.0 }
}

/// Bergou's K for a hinge from the squared rest lengths of x0x1, x0x2, x1x2, x0x3, x1x3; None for a degenerate triangle.
fn hinge(l01: f64, l02: f64, l12: f64, l03: f64, l13: f64) -> Option<[f64; 4]> {
    let (a0, a1) = (area(l01, l02, l12), area(l01, l03, l13));
    if !(a0 > 0.0 && a1 > 0.0) {
        return None;
    }
    // The cotangent of the angle between sides b and c, opposite side a, of a triangle of area A: (b^2 + c^2 - a^2) / 4A.
    let c01 = (l01 + l02 - l12) / (4.0 * a0);
    let c03 = (l01 + l12 - l02) / (4.0 * a0);
    let c02 = (l01 + l03 - l13) / (4.0 * a1);
    let c04 = (l01 + l13 - l03) / (4.0 * a1);
    Some([c03 + c04, c01 + c02, -c01 - c03, -c02 - c04])
}

impl World {
    /// Makes room for this many bending elements and says how many are in use.
    pub fn reserve_bends(&mut self, n: usize) {
        self.bd_p.resize(BEND_PARTS * n);
        self.bd_r.resize(3 * BEND_PARTS * n);
        self.bd_alpha.resize(3 * n);
        self.bd_l.resize(9 * n);
        self.bd_flag.resize(n);
        self.bd_len.resize(n);
        self.bends = n;
    }

    /// Sets element `s`: triangle `t` (its corners), the far corner across each of its edges (edge k joins t[k] and
    /// t[k + 1]; `BEND_NONE` for a free edge), the rest lengths of its sides (t0t1, t1t2, t2t0) and of each far corner to
    /// that edge's ends (t[k] to far[k], t[k + 1] to far[k]), the side along the warp (0 to 2, or 3 for none: the first side
    /// is the u axis), the rigidity along and across the warp (N m) and its flags. A degenerate triangle is off.
    #[allow(clippy::too_many_arguments)]
    pub fn set_bend(&mut self, s: usize, t: [u32; 3], far: [u32; 3], sides: [f32; 3], spokes: [f32; 6], warp: u32, along: f32, across: f32, flag: u32) {
        for k in 0..3 {
            self.bd_p[BEND_PARTS * s + k] = t[k];
            self.bd_p[BEND_PARTS * s + 3 + k] = far[k];
        }
        for j in 0..3 * BEND_PARTS {
            self.bd_r[3 * BEND_PARTS * s + j] = 0.0;
        }
        self.bd_flag[s] = flag;
        for c in 0..3 {
            self.bd_alpha[3 * s + c] = 0.0;
        }
        let sq = sides.map(|v| v as f64 * v as f64);
        let at = area(sq[0], sq[1], sq[2]);
        if !(at > 0.0 && along > 0.0 && across > 0.0) {
            return;
        }
        // The rest triangle in its plane: t0 at the origin, t1 on the x axis.
        let l01 = sides[0] as f64;
        let x2 = (sq[0] + sq[2] - sq[1]) / (2.0 * l01);
        let y2 = 2.0 * at / l01;
        let corner = [[0.0, 0.0], [l01, 0.0], [x2, y2]];
        // The warp side's direction is the u axis.
        let w = if warp < 3 { warp as usize } else { 0 };
        let (a, b) = (corner[w], corner[(w + 1) % 3]);
        let lw = sqrt64((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
        let u = [(b[0] - a[0]) / lw, (b[1] - a[1]) / lw];
        let mut row = [[0.0f64; BEND_PARTS]; 3];
        for k in 0..3 {
            if far[k] == BEND_NONE {
                continue;
            }
            // Hinge k: ends t[k], t[k + 1], this triangle's third corner t[k + 2], and the far corner.
            let (i0, i1, i2) = (k, (k + 1) % 3, (k + 2) % 3);
            let side = |i: usize, j: usize| sq[if (i + 1) % 3 == j { i } else { j }];
            let (s0, s1) = (spokes[2 * k] as f64, spokes[2 * k + 1] as f64);
            let Some(kv) = hinge(sq[i0], side(i0, i2), side(i1, i2), s0 * s0, s1 * s1) else { continue };
            // The edge's in-plane normal, in the warp frame (u, v = u turned a quarter).
            let (p, q) = (corner[i0], corner[i1]);
            let le = sqrt64((q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]));
            let n = [-(q[1] - p[1]) / le, (q[0] - p[0]) / le];
            let (nu, nv) = (n[0] * u[0] + n[1] * u[1], -n[0] * u[1] + n[1] * u[0]);
            let nn = [nu * nu, nu * nv, nv * nv];
            let slots = [i0, i1, i2, 3 + k];
            for c in 0..3 {
                for j in 0..4 {
                    row[c][slots[j]] += nn[c] * kv[j] / (2.0 * at);
                }
            }
        }
        let (along, across) = (along as f64, across as f64);
        let rigidity = [along, 0.5 * (along + across), across];
        for c in 0..3 {
            for j in 0..BEND_PARTS {
                self.bd_r[3 * BEND_PARTS * s + BEND_PARTS * c + j] = row[c][j] as f32;
            }
            self.bd_alpha[3 * s + c] = (1.0 / (rigidity[c] * at * WEIGHT[c])) as f32;
        }
        self.bd_len[s] = sqrt64(at) as f32;
    }

    /// Element `s`'s particles (`BEND_NONE` in an empty slot) and component `c`'s coefficients in f64, less their mean over
    /// the particles it has: they sum to zero exactly in f64, as in exact arithmetic, so the element's moves keep the momentum
    /// whatever rounding the stored f32 coefficients took.
    pub(crate) fn bend_row(&self, s: usize, c: usize) -> ([u32; BEND_PARTS], [f64; BEND_PARTS]) {
        let mut p = [BEND_NONE; BEND_PARTS];
        let mut r = [0.0f64; BEND_PARTS];
        let (mut sum, mut count) = (0.0f64, 0.0f64);
        for j in 0..BEND_PARTS {
            p[j] = self.bd_p[BEND_PARTS * s + j];
            if p[j] != BEND_NONE {
                r[j] = self.bd_r[3 * BEND_PARTS * s + BEND_PARTS * c + j] as f64;
                sum += r[j];
                count += 1.0;
            }
        }
        for j in 0..BEND_PARTS {
            if p[j] != BEND_NONE {
                r[j] -= sum / count;
            }
        }
        (p, r)
    }

    /// `R x` of a component, in f64.
    pub(crate) fn bend_value(&self, p: [u32; BEND_PARTS], r: [f64; BEND_PARTS]) -> [f64; 3] {
        let mut v = [0.0f64; 3];
        for j in 0..BEND_PARTS {
            if p[j] == BEND_NONE {
                continue;
            }
            let i = p[j] as usize;
            v[0] += r[j] * self.x[i] as f64;
            v[1] += r[j] * self.y[i] as f64;
            v[2] += r[j] * self.z[i] as f64;
        }
        v
    }

    /// Starts a piece: no element has pushed yet.
    pub(crate) fn bend_begin(&mut self) {
        for j in 0..9 * self.bends {
            self.bd_l[j] = 0.0;
        }
    }

    /// Each particle's list of block elements (a slot per particle of an element), for the vertex block passes.
    pub(crate) fn prepare_bend_blocks(&mut self) {
        self.bd_head.resize(self.particles);
        self.bd_next.resize(BEND_PARTS * self.bends);
        for i in 0..self.particles {
            self.bd_head[i] = NO_SLOT;
        }
        for s in 0..self.bends {
            if self.bd_flag[s] & BEND_BLOCK == 0 || !(self.bd_alpha[3 * s] > 0.0) {
                continue;
            }
            for j in 0..BEND_PARTS {
                let p = self.bd_p[BEND_PARTS * s + j];
                if p == BEND_NONE {
                    continue;
                }
                let slot = BEND_PARTS * s + j;
                self.bd_next[slot] = self.bd_head[p as usize];
                self.bd_head[p as usize] = slot as u32;
            }
        }
    }

    /// What particle `i`'s block elements add to its gradient, at the particle's place `x`, and to the diagonal of its
    /// Hessian (the same on all three axes).
    pub(crate) fn bend_block_terms(&self, i: usize, x: [f64; 3], g: &mut [f64; 3]) -> f64 {
        if i >= self.bd_head.len() {
            return 0.0;
        }
        let mut diagonal = 0.0;
        let mut slot = self.bd_head[i];
        while slot != NO_SLOT {
            let s = slot as usize / BEND_PARTS;
            let own = slot as usize % BEND_PARTS;
            slot = self.bd_next[slot as usize];
            for c in 0..3 {
                let (p, r) = self.bend_row(s, c);
                let stiffness = 1.0 / self.bd_alpha[3 * s + c] as f64;
                let mut v = self.bend_value(p, r);
                let ri = r[own];
                v[0] += ri * (x[0] - self.x[i] as f64);
                v[1] += ri * (x[1] - self.y[i] as f64);
                v[2] += ri * (x[2] - self.z[i] as f64);
                for a in 0..3 {
                    g[a] += stiffness * ri * v[a];
                }
                diagonal += stiffness * ri * ri;
            }
        }
        diagonal
    }

    /// The energy of particle `i`'s block elements with the particle at `x` and the others where they are, J.
    pub(crate) fn bend_block_energy(&self, i: usize, x: [f64; 3]) -> f64 {
        if i >= self.bd_head.len() {
            return 0.0;
        }
        let mut e = 0.0;
        let mut slot = self.bd_head[i];
        while slot != NO_SLOT {
            let s = slot as usize / BEND_PARTS;
            let own = slot as usize % BEND_PARTS;
            slot = self.bd_next[slot as usize];
            for c in 0..3 {
                let (p, r) = self.bend_row(s, c);
                let mut v = self.bend_value(p, r);
                let ri = r[own];
                v[0] += ri * (x[0] - self.x[i] as f64);
                v[1] += ri * (x[1] - self.y[i] as f64);
                v[2] += ri * (x[2] - self.z[i] as f64);
                e += 0.5 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / self.bd_alpha[3 * s + c] as f64;
            }
        }
        e
    }

    /// The bending energy of every element now, J.
    pub fn bend_energy(&self) -> f64 {
        let mut e = 0.0;
        for s in 0..self.bends {
            for c in 0..3 {
                let alpha = self.bd_alpha[3 * s + c] as f64;
                if !(alpha > 0.0) {
                    continue;
                }
                let (p, r) = self.bend_row(s, c);
                let v = self.bend_value(p, r);
                e += 0.5 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / alpha;
            }
        }
        e
    }
}
