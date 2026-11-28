// Vertex block descent for cloth (Chen, Liu, Yang and Yuksel, "Vertex Block Descent", ACM TOG 43(4), SIGGRAPH 2024): the
// edges of a sheet on the vertex-block solver are springs, and each pass visits every particle in turn and takes one Newton
// step on its own three coordinates of the step's incremental potential, m/(2h^2) |x - y|^2 (y where the particle would go
// with nothing holding it) plus the energy of the springs at it, with the others held where they are (Gauss-Seidel over the
// blocks). A spring of stiffness k and rest length L at the particle gives the gradient k (l - L) n and the Hessian
// k [n n^T + max(0, 1 - L/l) (I - n n^T)], the part of the true Hessian that stays positive when the spring is squeezed (the
// paper's projection), so every block is symmetric positive definite and each step lowers the potential. Damping is the
// paper's: (k_d / h) times the spring's Hessian on the particle's move over the piece, with k_d = 2 zeta / omega for the edge's
// damping ratio zeta at its own frequency omega. An edge's stiffness is its measured one (a fabric thread, `STIFFNESS`), or
// omega^2 over its effective inverse mass for a softness, or, for a rigid edge, that of a spring at ten times the piece's
// rate, which no pass can stretch by more than a sliver. A thread held rigid past its strain (`elimit`) is put back within it
// after the passes (strain limiting, Provot 1995).
use crate::math::{sqrt, sqrt64};
use crate::world::{BLOCK, STIFFNESS, TENSION, TORN, World};

const NO_EDGE: u32 = u32::MAX;
/// The fewest sweeps over the blocks a piece takes, whatever the world's passes: a measured fabric's bending couples every
/// particle along a strip, which one sweep moves a cell at a time; a 10-cell flannel cantilever settles within 0.3 degrees of
/// the elastica at 8 sweeps a piece and stops 3 degrees short of it at 4 (`tests/soft-bending.test.js`).
pub const BLOCK_SWEEPS: u32 = 8;

impl World {
    /// The particles' lists of block edges, rebuilt for the piece, and each block particle's first guess for it; false when no
    /// edge is on the block solver.
    pub(crate) fn prepare_cloth_blocks(&mut self, h: f32, gravity: [f32; 3]) -> bool {
        if !(0..self.edges).any(|e| self.eflags[e] & (BLOCK | TORN) == BLOCK) {
            return false;
        }
        self.cb_head.resize(self.particles);
        self.cb_next.resize(2 * self.edges);
        for i in 0..self.particles {
            self.cb_head[i] = NO_EDGE;
        }
        for e in 0..self.edges {
            if self.eflags[e] & (BLOCK | TORN) != BLOCK {
                continue;
            }
            for (k, end) in [self.ea[e], self.eb[e]].into_iter().enumerate() {
                let slot = 2 * e + k;
                self.cb_next[slot] = self.cb_head[end as usize];
                self.cb_head[end as usize] = slot as u32;
            }
        }
        // The first guess (the paper's adaptive initialisation, section 3.6): the predicted move takes gravity only as far as
        // the particle was last accelerating along it, so a cloth at rest starts the passes where it rests and the passes'
        // fixed point is its equilibrium, whatever their number; one falling freely starts where it falls to. The safeguard then
        // keeps the start no higher than where the particles were.
        let g2 = gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2];
        for i in 0..self.particles {
            if self.cb_head[i] == NO_EDGE || !(self.w[i] > 0.0) || self.bsleep[self.pbody[i] as usize] != 0 {
                continue;
            }
            let scale = self.gravity_scale[self.pbody[i] as usize];
            let g = [gravity[0] * scale, gravity[1] * scale, gravity[2] * scale];
            // The velocity before this piece's gravity, and the acceleration since the last piece along gravity.
            let v = [self.vx[i] - h * g[0], self.vy[i] - h * g[1], self.vz[i] - h * g[2]];
            let along = if g2 > 0.0 && scale != 0.0 {
                let a = [(v[0] - self.cbx[i]) / h, (v[1] - self.cby[i]) / h, (v[2] - self.cbz[i]) / h];
                let share = (a[0] * g[0] + a[1] * g[1] + a[2] * g[2]) / (g2 * scale * scale);
                share.clamp(0.0, 1.0)
            } else {
                0.0
            };
            let back = h * h * (1.0 - along);
            self.x[i] -= back * g[0];
            self.y[i] -= back * g[1];
            self.z[i] -= back * g[2];
            self.cbx[i] = v[0];
            self.cby[i] = v[1];
            self.cbz[i] = v[2];
        }
        self.safeguard_cloth_blocks(h);
        true
    }

    /// Each body's incremental potential with its block particles where they are now, J, into `out` (by body): inertia,
    /// springs and bending.
    fn cloth_block_potentials(&self, h: f32, out: &mut [f64]) {
        let dt = h as f64;
        let inertia = 1.0 / (dt * dt);
        for v in out.iter_mut() {
            *v = 0.0;
        }
        for i in 0..self.particles {
            if self.cb_head[i] == NO_EDGE || !(self.w[i] > 0.0) {
                continue;
            }
            let target = [(self.px[i] + h * self.vx[i]) as f64, (self.py[i] + h * self.vy[i]) as f64, (self.pz[i] + h * self.vz[i]) as f64];
            let r = [self.x[i] as f64 - target[0], self.y[i] as f64 - target[1], self.z[i] as f64 - target[2]];
            out[self.pbody[i] as usize] += 0.5 * inertia / self.w[i] as f64 * (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
        }
        for e in 0..self.edges {
            if self.eflags[e] & (BLOCK | TORN) != BLOCK {
                continue;
            }
            let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
            let d = [(self.x[a] - self.x[b]) as f64, (self.y[a] - self.y[b]) as f64, (self.z[a] - self.z[b]) as f64];
            let stretch = sqrt64(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) - self.rest[e] as f64;
            if self.eflags[e] & TENSION != 0 && stretch < 0.0 {
                continue;
            }
            let (k, _) = self.block_spring(e, dt);
            out[self.pbody[a] as usize] += 0.5 * k * stretch * stretch;
        }
        out_add_bends(self, out);
    }

    /// The first guess's safeguard: each body's passes start from the point of the segment from where its particles were to
    /// the first guess (t = 1, 1/2, 1/4, 1/8, 1/16 or 0 of the way) with the least incremental potential. Every block step
    /// lowers the potential (the backtracking of `solve_cloth_blocks`), so the piece ends no higher than where the particles
    /// were, which the passes alone do not promise: started from the inertial guess, which stretches a stiff measured thread,
    /// a few passes can end above it, and the piece then puts energy into the sheet. With the previous place as a candidate,
    /// the potential and the work of gravity at the piece's end are bounded by the energy at its start (the minimizing-movement
    /// estimate of implicit Euler, which holds for any point no higher than the previous place; Ortiz and Stainier, "The
    /// variational formulation of viscoplastic constitutive updates", CMAME 171, 1999; Kane, Marsden, Ortiz and West,
    /// "Variational integrators and the Newmark algorithm", IJNME 49, 2000). A 10-cell flannel cantilever at the default
    /// pieces flailed through 13 to 143 degrees without it (KB-SOFT-VBDBEND1).
    pub(crate) fn safeguard_cloth_blocks(&mut self, h: f32) {
        let n = self.bodies;
        const TRIES: usize = 6;
        self.cb_phi.resize((TRIES + 1) * n);
        self.cb_save.resize(self.particles);
        let mut phi = core::mem::take(&mut self.cb_phi);
        for i in 0..self.particles {
            self.cb_save[i] = [self.x[i], self.y[i], self.z[i]];
        }
        // t = 1, 1/2, 1/4, ..., 0 of the way from where the particle was to the guess.
        for k in 0..TRIES {
            let t = if k + 1 == TRIES { 0.0 } else { 1.0 / (1u32 << k) as f32 };
            for i in 0..self.particles {
                if self.cb_head[i] != NO_EDGE && self.w[i] > 0.0 {
                    let g = self.cb_save[i];
                    self.x[i] = self.px[i] + t * (g[0] - self.px[i]);
                    self.y[i] = self.py[i] + t * (g[1] - self.py[i]);
                    self.z[i] = self.pz[i] + t * (g[2] - self.pz[i]);
                }
            }
            self.cloth_block_potentials(h, &mut phi[k * n..(k + 1) * n]);
        }
        for b in 0..n {
            let mut best = 0;
            for k in 1..TRIES {
                if phi[k * n + b] < phi[best * n + b] {
                    best = k;
                }
            }
            phi[TRIES * n + b] = best as f64;
        }
        for i in 0..self.particles {
            if self.cb_head[i] != NO_EDGE && self.w[i] > 0.0 {
                let k = phi[TRIES * n + self.pbody[i] as usize] as usize;
                let t = if k + 1 == TRIES { 0.0 } else { 1.0 / (1u32 << k) as f32 };
                let g = self.cb_save[i];
                self.x[i] = self.px[i] + t * (g[0] - self.px[i]);
                self.y[i] = self.py[i] + t * (g[1] - self.py[i]);
                self.z[i] = self.pz[i] + t * (g[2] - self.pz[i]);
            }
        }
        self.cb_phi = phi;
    }

    /// An edge's stiffness (N/m) and stiffness-proportional damping (s) for the block solve.
    fn block_spring(&self, e: usize, h: f64) -> (f64, f64) {
        let w = (self.w[self.ea[e] as usize] + self.w[self.eb[e] as usize]) as f64;
        let omega = self.omega[e] as f64;
        let (k, frequency) = if self.eflags[e] & STIFFNESS != 0 && omega > 0.0 {
            (omega, if w > 0.0 { sqrt64(omega * w) } else { 0.0 })
        } else if omega > 0.0 {
            (omega * omega / w.max(1e-30), omega)
        } else {
            let rate = 10.0 / h;
            (rate * rate / w.max(1e-30), rate)
        };
        let damping = if frequency > 0.0 { 2.0 * self.zeta[e] as f64 / frequency } else { 0.0 };
        (k, damping)
    }

    /// One pass over the particles of the sheets on the block solver.
    pub(crate) fn solve_cloth_blocks(&mut self, h: f32, backward: bool) {
        let dt = h as f64;
        let inertia_scale = 1.0 / (dt * dt);
        for k in 0..self.particles {
            let i = if backward { self.particles - 1 - k } else { k };
            let mut slot = self.cb_head[i];
            if slot == NO_EDGE || !(self.w[i] > 0.0) || self.bsleep[self.pbody[i] as usize] != 0 {
                continue;
            }
            let mass = 1.0 / self.w[i] as f64;
            let x = [self.x[i] as f64, self.y[i] as f64, self.z[i] as f64];
            let target = [(self.px[i] + h * self.vx[i]) as f64, (self.py[i] + h * self.vy[i]) as f64, (self.pz[i] + h * self.vz[i]) as f64];
            let moved = [x[0] - self.px[i] as f64, x[1] - self.py[i] as f64, x[2] - self.pz[i] as f64];
            let m = mass * inertia_scale;
            let mut g = [m * (x[0] - target[0]), m * (x[1] - target[1]), m * (x[2] - target[2])];
            // The block's Hessian, symmetric: xx, yy, zz, xy, xz, yz.
            let mut hess = [m, m, m, 0.0, 0.0, 0.0];
            while slot != NO_EDGE {
                let e = (slot / 2) as usize;
                slot = self.cb_next[slot as usize];
                let j = if self.ea[e] as usize == i { self.eb[e] } else { self.ea[e] } as usize;
                let d = [x[0] - self.x[j] as f64, x[1] - self.y[j] as f64, x[2] - self.z[j] as f64];
                let length = sqrt64(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
                if !(length > 1e-12) {
                    continue;
                }
                let rest = self.rest[e] as f64;
                let stretch = length - rest;
                if self.eflags[e] & TENSION != 0 && stretch < 0.0 {
                    continue;
                }
                let n = [d[0] / length, d[1] / length, d[2] / length];
                let (k, damping) = self.block_spring(e, dt);
                // k [n n^T + s (I - n n^T)] with s = max(0, 1 - L/l): a n n^T + s k I, a = k (1 - s).
                let side = if length > rest { 1.0 - rest / length } else { 0.0 };
                let along = k * (1.0 - side);
                let around = k * side;
                // Damping on the particle's move over the piece: (k_d / h) H_e moved.
                let rate = damping / dt;
                let n_moved = n[0] * moved[0] + n[1] * moved[1] + n[2] * moved[2];
                for a in 0..3 {
                    let he_moved = along * n[a] * n_moved + around * moved[a];
                    g[a] += k * stretch * n[a] + rate * he_moved;
                }
                let scale = 1.0 + rate;
                hess[0] += scale * (along * n[0] * n[0] + around);
                hess[1] += scale * (along * n[1] * n[1] + around);
                hess[2] += scale * (along * n[2] * n[2] + around);
                hess[3] += scale * along * n[0] * n[1];
                hess[4] += scale * along * n[0] * n[2];
                hess[5] += scale * along * n[1] * n[2];
            }
            let bend = self.bend_block_terms(i, x, &mut g);
            hess[0] += bend;
            hess[1] += bend;
            hess[2] += bend;
            let mut step = crate::vertex_block::solve(hess, g);
            if !(step[0].is_finite() && step[1].is_finite() && step[2].is_finite()) {
                continue;
            }
            // The Newton step is exact for the inertia, the bending and the damping, all quadratic in the particle, but a stiff
            // thread's energy is not: turning about its other end, the step taken on the thread's tangent overshoots the arc and
            // can raise the potential, and a pass that raises it puts energy into the sheet (a 10-cell cantilever of flannel at the
            // default 8 pieces and 2 passes flailed through 13 to 143 degrees). So the step is halved until it lowers the block's
            // own potential (backtracking, Nocedal and Wright 2006, section 3.1; the descent each block step of VBD relies on,
            // Chen et al. 2024, section 3.3), which makes every pass a descent on the step's incremental potential.
            let start = self.cloth_block_potential(i, x, x, target, m, dt);
            let mut accepted = false;
            for _ in 0..24 {
                let trial = [x[0] - step[0], x[1] - step[1], x[2] - step[2]];
                if self.cloth_block_potential(i, x, trial, target, m, dt) <= start {
                    accepted = true;
                    break;
                }
                step = step.map(|v| 0.5 * v);
            }
            if !accepted {
                continue;
            }
            self.x[i] = (x[0] - step[0]) as f32;
            self.y[i] = (x[1] - step[1]) as f32;
            self.z[i] = (x[2] - step[2]) as f32;
        }
    }

    /// The block's potential at `trial`, up to a constant, for the backtracking of `solve_cloth_blocks`: the inertia, the
    /// springs' elastic energy and the bending exactly, and the damping by its Rayleigh potential on the move over the piece with
    /// each spring's Hessian taken where the particle is now (`x`), so its gradient is the one the step was solved with.
    fn cloth_block_potential(&self, i: usize, x: [f64; 3], trial: [f64; 3], target: [f64; 3], m: f64, dt: f64) -> f64 {
        let r = [trial[0] - target[0], trial[1] - target[1], trial[2] - target[2]];
        let mut e = 0.5 * m * (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
        let moved = [trial[0] - self.px[i] as f64, trial[1] - self.py[i] as f64, trial[2] - self.pz[i] as f64];
        let mut slot = self.cb_head[i];
        while slot != NO_EDGE {
            let edge = (slot / 2) as usize;
            slot = self.cb_next[slot as usize];
            let j = if self.ea[edge] as usize == i { self.eb[edge] } else { self.ea[edge] } as usize;
            let other = [self.x[j] as f64, self.y[j] as f64, self.z[j] as f64];
            let rest = self.rest[edge] as f64;
            let tension = self.eflags[edge] & TENSION != 0;
            let (k, damping) = self.block_spring(edge, dt);
            let d = [trial[0] - other[0], trial[1] - other[1], trial[2] - other[2]];
            let length = sqrt64(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
            let stretch = length - rest;
            if !(tension && stretch < 0.0) {
                e += 0.5 * k * stretch * stretch;
            }
            // The damping, as solve_cloth_blocks met it: on the spring's Hessian at the particle's place now, and only for a
            // spring that met it there.
            let d0 = [x[0] - other[0], x[1] - other[1], x[2] - other[2]];
            let l0 = sqrt64(d0[0] * d0[0] + d0[1] * d0[1] + d0[2] * d0[2]);
            if !(l0 > 1e-12) || (tension && l0 < rest) {
                continue;
            }
            let n = [d0[0] / l0, d0[1] / l0, d0[2] / l0];
            let side = if l0 > rest { 1.0 - rest / l0 } else { 0.0 };
            let n_moved = n[0] * moved[0] + n[1] * moved[1] + n[2] * moved[2];
            let moved2 = moved[0] * moved[0] + moved[1] * moved[1] + moved[2] * moved[2];
            e += 0.5 * damping / dt * k * ((1.0 - side) * n_moved * n_moved + side * moved2);
        }
        e + self.bend_block_energy(i, trial)
    }

    /// Threads held rigid past their strain: each block edge longer than (1 + elimit) L is brought back to it, by the ends'
    /// inverse masses (strain limiting, Provot 1995).
    pub(crate) fn limit_cloth_blocks(&mut self) {
        for e in 0..self.edges {
            if self.eflags[e] & (BLOCK | TORN) != BLOCK || !(self.elimit[e] > 0.0) {
                continue;
            }
            let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
            let (wa, wb) = (self.w[a], self.w[b]);
            if !(wa + wb > 0.0) {
                continue;
            }
            let (dx, dy, dz) = (self.x[a] - self.x[b], self.y[a] - self.y[b], self.z[a] - self.z[b]);
            let length = sqrt(dx * dx + dy * dy + dz * dz);
            let most = self.rest[e] * (1.0 + self.elimit[e]);
            if !(length > most) {
                continue;
            }
            let share = (length - most) / length / (wa + wb);
            self.x[a] -= wa * share * dx;
            self.y[a] -= wa * share * dy;
            self.z[a] -= wa * share * dz;
            self.x[b] += wb * share * dx;
            self.y[b] += wb * share * dy;
            self.z[b] += wb * share * dz;
        }
    }
}

fn out_add_bends(world: &World, out: &mut [f64]) {
    for s in 0..world.bends {
        for c in 0..3 {
            let alpha = world.bd_alpha[3 * s + c] as f64;
            if !(alpha > 0.0) || world.bd_flag[s] & crate::bend::BEND_BLOCK == 0 {
                continue;
            }
            let (p, r) = world.bend_row(s, c);
            let v = world.bend_value(p, r);
            out[world.pbody[p[0] as usize] as usize] += 0.5 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / alpha;
        }
    }
}
