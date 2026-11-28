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
        // fixed point is its equilibrium, whatever their number; one falling freely starts where it falls to.
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
        true
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
    pub(crate) fn solve_cloth_blocks(&mut self, h: f32) {
        let dt = h as f64;
        let inertia_scale = 1.0 / (dt * dt);
        for i in 0..self.particles {
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
            let step = crate::vertex_block::solve(hess, g);
            if !(step[0].is_finite() && step[1].is_finite() && step[2].is_finite()) {
                continue;
            }
            self.x[i] = (x[0] - step[0]) as f32;
            self.y[i] = (x[1] - step[1]) as f32;
            self.z[i] = (x[2] - step[2]) as f32;
        }
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
