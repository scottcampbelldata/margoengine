// Rigid edges and body links solved together, exactly: every edge of zero natural frequency (a constraint that must not
// stretch) and every particle attached to a rigid body is one constraint of a linear system K lambda = -C with
// K = J W J^T, solved to a tolerance by the preconditioned conjugate gradient method (Hestenes and Stiefel 1952; Shewchuk,
// "An Introduction to the Conjugate Gradient Method Without the Agonizing Pain", 1994; Baraff and Witkin, "Large Steps in Cloth
// Simulation", SIGGRAPH 1998, who use a conjugate gradient solve of the constraints of a cloth), then a few Newton steps for
// the curve of the distances. The answer is the solution of the system, whatever the number of iterations the step is given,
// so the stiffness of a rope or a sheet does not depend on it, nor on the mass ratio of a load at its end; a Gauss-Seidel
// sweep, as XPBD uses (Macklin, Mueller and Chentanez 2016), moves a correction one edge at a time and leaves a long chain
// stretched. A chain, a tree and a sheet with its loops alike are solved: the product with K is a pass over the edges, so a
// system of E constraints costs about E operations an iteration and at most E iterations; Baraff, "Linear-Time Dynamics using
// Lagrange Multipliers", SIGGRAPH 1996, solves a tree directly in linear time, which a conjugate gradient solve matches in
// the answer and exceeds in what it can hold (loops). An attached body is a heavy particle at the end of the chain: its
// effective inverse mass along each axis at the anchor is the ghost's, and what the solve moves it by is the impulse it takes.
// All the algebra is in f64, from f32 positions, with only + - * / sqrt and compares, so a result is the same on every run.
use crate::col::Col;
use crate::math::sqrt;
use crate::world::{NONE, TENSION, TORN, World};

pub struct Rigid {
    nx: Col<f64>,
    ny: Col<f64>,
    nz: Col<f64>,
    u: Col<f64>,
    b: Col<f64>,
    r: Col<f64>,
    p: Col<f64>,
    ap: Col<f64>,
    z: Col<f64>,
    d: Col<f64>,
    fx: Col<f64>,
    fy: Col<f64>,
    fz: Col<f64>,
    // Per attachment, three numbers each: the anchor where the piece began, how far the body's ghost has moved, its inverse mass.
    anchor: Col<f64>,
    ghost: Col<f64>,
    inverse: Col<f64>,
    // The edges the exact solve holds: those of a component with no loop (a rope, a tree of them). Loops stay with the sweep.
    tree: Col<u32>,
    parent: Col<u32>,
    edges_in: Col<u32>,
    vertices_in: Col<u32>,
    mark: Col<u32>,
    // Edges that resist stretch only and are slack this pass: left out of the system until they pull.
    slack: Col<u32>,
}

impl Rigid {
    pub const fn new() -> Rigid {
        Rigid {
            nx: Col::new(),
            ny: Col::new(),
            nz: Col::new(),
            u: Col::new(),
            b: Col::new(),
            r: Col::new(),
            p: Col::new(),
            ap: Col::new(),
            z: Col::new(),
            d: Col::new(),
            fx: Col::new(),
            fy: Col::new(),
            fz: Col::new(),
            anchor: Col::new(),
            ghost: Col::new(),
            inverse: Col::new(),
            tree: Col::new(),
            parent: Col::new(),
            edges_in: Col::new(),
            vertices_in: Col::new(),
            mark: Col::new(),
            slack: Col::new(),
        }
    }
}

impl Default for Rigid {
    fn default() -> Self {
        Rigid::new()
    }
}

/// How close a constraint must come, as a fraction of an edge's length (in metres for a body link), before a Newton step is the last.
const TOLERANCE: f64 = 1e-5;
const NEWTON: usize = 4;

fn sqrt64(x: f64) -> f64 {
    sqrt(x as f32) as f64
}

impl World {
    fn rigid_edge(&self, e: usize) -> bool {
        self.rg.tree[e] != 0 && self.rg.slack[e] == 0 && self.eflags[e] & TORN == 0 && self.w[self.ea[e] as usize] + self.w[self.eb[e] as usize] > 0.0
    }

    /// Whether the exact solve holds edge `e` this piece (the sweep leaves it alone).
    pub(crate) fn held_exactly(&self, e: usize) -> bool {
        e < self.rg.tree.len() && self.rg.tree[e] != 0
    }

    /// Marks the rigid edges that belong to a component without a loop: a connected set of rigid edges is a tree when it has
    /// one edge fewer than it has particles.
    fn find_trees(&mut self) {
        let (ne, np) = (self.edges, self.particles);
        self.rg.tree.resize(ne);
        self.rg.slack.resize(ne);
        for c in [&mut self.rg.parent, &mut self.rg.edges_in, &mut self.rg.vertices_in, &mut self.rg.mark] {
            c.resize(np);
        }
        for i in 0..np {
            self.rg.parent[i] = i as u32;
            self.rg.edges_in[i] = 0;
            self.rg.vertices_in[i] = 0;
            self.rg.mark[i] = 0;
        }
        for e in 0..ne {
            if !self.candidate(e) {
                continue;
            }
            let (a, b) = (self.root(self.ea[e]), self.root(self.eb[e]));
            if a != b {
                self.rg.parent[a] = b as u32;
            }
        }
        for e in 0..ne {
            if !self.candidate(e) {
                continue;
            }
            let r = self.root(self.ea[e]);
            self.rg.edges_in[r] += 1;
            for end in [self.ea[e] as usize, self.eb[e] as usize] {
                if self.rg.mark[end] == 0 {
                    self.rg.mark[end] = 1;
                    let r = self.root(end as u32);
                    self.rg.vertices_in[r] += 1;
                }
            }
        }
        for e in 0..ne {
            self.rg.tree[e] = 0;
            if self.candidate(e) {
                let r = self.root(self.ea[e]);
                if self.rg.edges_in[r] < self.rg.vertices_in[r] {
                    self.rg.tree[e] = 1;
                }
            }
        }
    }

    fn candidate(&self, e: usize) -> bool {
        self.omega[e] == 0.0 && self.eflags[e] & TORN == 0 && self.w[self.ea[e] as usize] + self.w[self.eb[e] as usize] > 0.0
    }

    fn root(&self, mut i: u32) -> usize {
        while self.rg.parent[i as usize] != i {
            i = self.rg.parent[i as usize];
        }
        i as usize
    }

    fn live_attachment(&self, a: usize) -> bool {
        self.at_row[a] != NONE && self.w[self.at_p[a] as usize] > 0.0
    }

    /// The product of K with `v` (edges first, then three axes an attachment) into `out`.
    fn multiply(&mut self, v: &Col<f64>, out: &mut Col<f64>) {
        let (ne, na, np) = (self.edges, self.attachments, self.particles);
        for i in 0..np {
            self.rg.fx[i] = 0.0;
            self.rg.fy[i] = 0.0;
            self.rg.fz[i] = 0.0;
        }
        for e in 0..ne {
            if v[e] == 0.0 || !self.rigid_edge(e) {
                continue;
            }
            let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
            let s = v[e];
            self.rg.fx[a] += self.rg.nx[e] * s;
            self.rg.fy[a] += self.rg.ny[e] * s;
            self.rg.fz[a] += self.rg.nz[e] * s;
            self.rg.fx[b] -= self.rg.nx[e] * s;
            self.rg.fy[b] -= self.rg.ny[e] * s;
            self.rg.fz[b] -= self.rg.nz[e] * s;
        }
        for a in 0..na {
            if !self.live_attachment(a) {
                continue;
            }
            let p = self.at_p[a] as usize;
            self.rg.fx[p] += v[ne + 3 * a];
            self.rg.fy[p] += v[ne + 3 * a + 1];
            self.rg.fz[p] += v[ne + 3 * a + 2];
        }
        for e in 0..ne {
            if !self.rigid_edge(e) {
                out[e] = 0.0;
                continue;
            }
            let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
            let (wa, wb) = (self.w[a] as f64, self.w[b] as f64);
            out[e] = self.rg.nx[e] * (wa * self.rg.fx[a] - wb * self.rg.fx[b])
                + self.rg.ny[e] * (wa * self.rg.fy[a] - wb * self.rg.fy[b])
                + self.rg.nz[e] * (wa * self.rg.fz[a] - wb * self.rg.fz[b]);
        }
        for a in 0..na {
            for k in 0..3 {
                out[ne + 3 * a + k] = 0.0;
            }
            if !self.live_attachment(a) {
                continue;
            }
            let p = self.at_p[a] as usize;
            let wp = self.w[p] as f64;
            out[ne + 3 * a] = wp * self.rg.fx[p] + self.rg.inverse[3 * a] * v[ne + 3 * a];
            out[ne + 3 * a + 1] = wp * self.rg.fy[p] + self.rg.inverse[3 * a + 1] * v[ne + 3 * a + 1];
            out[ne + 3 * a + 2] = wp * self.rg.fz[p] + self.rg.inverse[3 * a + 2] * v[ne + 3 * a + 2];
        }
    }

    /// Solves K u = b to a tolerance, preconditioned by the diagonal.
    fn conjugate(&mut self, n: usize) -> bool {
        let mut b = core::mem::replace(&mut self.rg.b, Col::new());
        let mut u = core::mem::replace(&mut self.rg.u, Col::new());
        let mut r = core::mem::replace(&mut self.rg.r, Col::new());
        let mut p = core::mem::replace(&mut self.rg.p, Col::new());
        let mut ap = core::mem::replace(&mut self.rg.ap, Col::new());
        let mut z = core::mem::replace(&mut self.rg.z, Col::new());
        let d = core::mem::replace(&mut self.rg.d, Col::new());
        let mut scale = 0.0f64;
        for i in 0..n {
            u[i] = 0.0;
            r[i] = b[i];
            z[i] = r[i] / d[i];
            p[i] = z[i];
            let m = if b[i] < 0.0 { -b[i] } else { b[i] };
            if m > scale {
                scale = m;
            }
        }
        let mut rz = 0.0f64;
        for i in 0..n {
            rz += r[i] * z[i];
        }
        let limit = if n + 8 < 400 { n + 8 } else { 400 };
        // Until the residual is a hundred thousandth of the violation, or too small to matter; Newton steps finish the job.
        let stop = 1e-5 * scale + 1e-12;
        for _ in 0..limit {
            let mut worst = 0.0f64;
            for i in 0..n {
                let m = if r[i] < 0.0 { -r[i] } else { r[i] };
                if m > worst {
                    worst = m;
                }
            }
            if worst <= stop {
                break;
            }
            self.multiply(&p, &mut ap);
            let mut pap = 0.0f64;
            for i in 0..n {
                pap += p[i] * ap[i];
            }
            if !(pap > 0.0) {
                break;
            }
            let alpha = rz / pap;
            let mut rz_new = 0.0f64;
            for i in 0..n {
                u[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
                z[i] = r[i] / d[i];
                rz_new += r[i] * z[i];
            }
            let beta = rz_new / rz;
            rz = rz_new;
            for i in 0..n {
                p[i] = z[i] + beta * p[i];
            }
        }
        let _ = &mut b;
        self.rg.b = b;
        self.rg.u = u;
        self.rg.r = r;
        self.rg.p = p;
        self.rg.ap = ap;
        self.rg.z = z;
        self.rg.d = d;
        true
    }

    /// Starts a piece of a step: each attachment's anchor where the piece begins, how easily its body gives way along each axis
    /// there (carried a piece along its velocity, as the particles are predicted), and no motion of its ghost yet (it accumulates over the piece's passes).
    pub(crate) fn rigid_begin(&mut self, h: f32) {
        self.find_trees();
        let (ne, na, np) = (self.edges, self.attachments, self.particles);
        for c in [&mut self.rg.nx, &mut self.rg.ny, &mut self.rg.nz] {
            c.resize(ne);
        }
        for c in [&mut self.rg.u, &mut self.rg.b, &mut self.rg.r, &mut self.rg.p, &mut self.rg.ap, &mut self.rg.z, &mut self.rg.d] {
            c.resize(ne + 3 * na);
        }
        for c in [&mut self.rg.fx, &mut self.rg.fy, &mut self.rg.fz] {
            c.resize(np);
        }
        for c in [&mut self.rg.anchor, &mut self.rg.ghost, &mut self.rg.inverse] {
            c.resize(3 * na);
        }
        for a in 0..na {
            if !self.live_attachment(a) {
                continue;
            }
            let c = (self.at_row[a] - 1) as usize;
            let r = [self.at_rx[a], self.at_ry[a], self.at_rz[a]];
            self.rg.anchor[3 * a] = (self.mx[c] + r[0] + self.lvx[c] * h) as f64;
            self.rg.anchor[3 * a + 1] = (self.my[c] + r[1] + self.lvy[c] * h) as f64;
            self.rg.anchor[3 * a + 2] = (self.mz[c] + r[2] + self.lvz[c] * h) as f64;
            for k in 0..3 {
                self.rg.ghost[3 * a + k] = 0.0;
                let axis = [if k == 0 { 1.0 } else { 0.0 }, if k == 1 { 1.0 } else { 0.0 }, if k == 2 { 1.0 } else { 0.0 }];
                let lever = [r[1] * axis[2] - r[2] * axis[1], r[2] * axis[0] - r[0] * axis[2], r[0] * axis[1] - r[1] * axis[0]];
                let (ix, iy, iz) = self.inverse_inertia(c, lever[0], lever[1], lever[2]);
                self.rg.inverse[3 * a + k] = (self.wm[c] + lever[0] * ix + lever[1] * iy + lever[2] * iz) as f64;
            }
        }
    }

    /// Holds every rigid edge to its length and every attached particle to its anchor, exactly (see the header).
    pub(crate) fn solve_rigid(&mut self, h: f32) {
        let (ne, na) = (self.edges, self.attachments);
        let n = ne + 3 * na;
        if n == 0 {
            return;
        }
        // Slack edges are tested afresh each pass.
        for e in 0..ne {
            self.rg.slack[e] = 0;
        }
        let mut any = false;
        for e in 0..ne {
            if self.rigid_edge(e) {
                any = true;
                break;
            }
        }
        for a in 0..na {
            if self.live_attachment(a) {
                any = true;
            }
        }
        if !any {
            return;
        }
        for _ in 0..NEWTON {
            // The constraints now: each rigid edge's stretch and each attachment's gap.
            let mut worst = 0.0f64;
            for e in 0..ne {
                self.rg.slack[e] = 0;
            }
            for e in 0..ne {
                if !self.rigid_edge(e) {
                    self.rg.b[e] = 0.0;
                    self.rg.d[e] = 1.0;
                    continue;
                }
                let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
                let (dx, dy, dz) = ((self.x[a] - self.x[b]) as f64, (self.y[a] - self.y[b]) as f64, (self.z[a] - self.z[b]) as f64);
                let len = sqrt64(dx * dx + dy * dy + dz * dz);
                if len < 1e-9 {
                    self.rg.b[e] = 0.0;
                    self.rg.d[e] = 1.0;
                    self.rg.nx[e] = 0.0;
                    self.rg.ny[e] = 0.0;
                    self.rg.nz[e] = 0.0;
                    continue;
                }
                let rest = self.rest[e] as f64;
                let c = len - rest;
                if self.tear[e] > 0.0 && c > self.tear[e] as f64 * rest {
                    self.eflags[e] |= TORN;
                    self.torn += 1;
                    self.rg.b[e] = 0.0;
                    self.rg.d[e] = 1.0;
                    continue;
                }
                if self.eflags[e] & TENSION != 0 && c <= 0.0 {
                    // A rope that resists stretch only does not push: while slack it is out of the system.
                    self.rg.slack[e] = 1;
                    self.rg.b[e] = 0.0;
                    self.rg.d[e] = 1.0;
                    continue;
                }
                self.rg.nx[e] = dx / len;
                self.rg.ny[e] = dy / len;
                self.rg.nz[e] = dz / len;
                self.rg.b[e] = -c;
                self.rg.d[e] = (self.w[a] + self.w[b]) as f64;
                let m = (if c < 0.0 { -c } else { c }) / (if rest > 1e-3 { rest } else { 1e-3 });
                if m > worst {
                    worst = m;
                }
            }
            for a in 0..na {
                for k in 0..3 {
                    let at = ne + 3 * a + k;
                    if !self.live_attachment(a) {
                        self.rg.b[at] = 0.0;
                        self.rg.d[at] = 1.0;
                        continue;
                    }
                    let p = self.at_p[a] as usize;
                    let position = [self.x[p], self.y[p], self.z[p]][k] as f64;
                    let c = position - (self.rg.anchor[3 * a + k] + self.rg.ghost[3 * a + k]);
                    self.rg.b[at] = -c;
                    self.rg.d[at] = self.w[p] as f64 + self.rg.inverse[3 * a + k];
                    let m = if c < 0.0 { -c } else { c };
                    if m > worst {
                        worst = m;
                    }
                }
            }
            if worst < TOLERANCE {
                break;
            }
            self.conjugate(n);
            // Move the particles by W J^T u, the bodies' ghosts the other way, and give each body what the attachment cost.
            for e in 0..ne {
                if !self.rigid_edge(e) {
                    continue;
                }
                let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
                let s = self.rg.u[e];
                // The multiplier gathers over the substep as a sweep's does, so the load on the edge can be read from it.
                self.lambda[e] += s as f32;
                self.x[a] += (self.w[a] as f64 * self.rg.nx[e] * s) as f32;
                self.y[a] += (self.w[a] as f64 * self.rg.ny[e] * s) as f32;
                self.z[a] += (self.w[a] as f64 * self.rg.nz[e] * s) as f32;
                self.x[b] -= (self.w[b] as f64 * self.rg.nx[e] * s) as f32;
                self.y[b] -= (self.w[b] as f64 * self.rg.ny[e] * s) as f32;
                self.z[b] -= (self.w[b] as f64 * self.rg.nz[e] * s) as f32;
            }
            for a in 0..na {
                if !self.live_attachment(a) {
                    continue;
                }
                let p = self.at_p[a] as usize;
                let c = (self.at_row[a] - 1) as usize;
                let wp = self.w[p] as f64;
                let u = [self.rg.u[ne + 3 * a], self.rg.u[ne + 3 * a + 1], self.rg.u[ne + 3 * a + 2]];
                self.x[p] += (wp * u[0]) as f32;
                self.y[p] += (wp * u[1]) as f32;
                self.z[p] += (wp * u[2]) as f32;
                for k in 0..3 {
                    self.rg.ghost[3 * a + k] -= self.rg.inverse[3 * a + k] * u[k];
                }
                // The body takes the reaction: an impulse of -u / h along each axis at the anchor.
                let (jx, jy, jz) = ((-u[0] / h as f64) as f32, (-u[1] / h as f64) as f32, (-u[2] / h as f64) as f32);
                let (rx, ry, rz) = (self.at_rx[a], self.at_ry[a], self.at_rz[a]);
                self.jx[c] += jx;
                self.jy[c] += jy;
                self.jz[c] += jz;
                let (kx, ky, kz) = (ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx);
                self.kx[c] += kx;
                self.ky[c] += ky;
                self.kz[c] += kz;
                if self.wm[c] > 0.0 {
                    self.lvx[c] += jx * self.wm[c];
                    self.lvy[c] += jy * self.wm[c];
                    self.lvz[c] += jz * self.wm[c];
                    let (wx, wy, wz) = self.inverse_inertia(c, kx, ky, kz);
                    self.avx[c] += wx;
                    self.avy[c] += wy;
                    self.avz[c] += wz;
                }
            }
        }
    }
}
