// Chen, Liu, Yang and Yuksel, "Vertex Block Descent" (2024), with the log-free stable Neo-Hookean energy shown in
// Smith, de Goes and Kim (2018), Eq. 13. A tetrahedron's F changes by a rank-one matrix in one vertex, so J is affine
// and the three-DOF energy is quadratic there. Its exact SPD Hessian is a scalar identity plus determinant outer products.
use crate::World;
use crate::col::Col;
use crate::fem::{NONE, TORN_TET, VERTEX_BLOCK_TET};
use crate::rubber::{self, COMPONENTS, RubberLaw};

pub(crate) type Vec3 = [f64; 3];
pub(crate) type Columns = [Vec3; 3];

fn active_vertex_block(flag: u32) -> bool {
    flag & (TORN_TET | VERTEX_BLOCK_TET) == VERTEX_BLOCK_TET
}

pub(crate) struct VertexBlock {
    pub head: Col<u32>,
    pub next: Col<u32>,
}

impl VertexBlock {
    pub const fn new() -> Self {
        Self { head: Col::new(), next: Col::new() }
    }
}

pub(crate) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub(crate) fn transform(f: Columns, g: Vec3) -> Vec3 {
    [0, 1, 2].map(|i| f[0][i] * g[0] + f[1][i] * g[1] + f[2][i] * g[2])
}

/// Nearest unit-length image of a rest-space fiber. At complete collapse all unit targets are tied.
pub(crate) fn fiber_target(image: Vec3, axis: Vec3) -> Vec3 {
    let length = crate::math::sqrt64(dot(image, image));
    if length == 0.0 { axis } else { image.map(|component| component / length) }
}

/// A symmetric LDL^T solve. Block inertia and shear are strictly positive for every moving vertex.
pub(crate) fn solve([xx, yy, zz, xy, xz, yz]: [f64; 6], b: Vec3) -> Vec3 {
    let yx = xy / xx;
    let zx = xz / xx;
    let dyy = yy - yx * xy;
    let zy = (yz - zx * xy) / dyy;
    let dzz = zz - zx * xz - zy * zy * dyy;
    let sy = b[1] - yx * b[0];
    let z = (b[2] - zx * b[0] - zy * sy) / dzz;
    let y = sy / dyy - zy * z;
    [b[0] / xx - yx * y - zx * z, y, z]
}

impl World {
    pub fn set_fiber(&mut self, first: usize, count: usize, fiber: [f32; 4]) {
        if count == 0 || (fiber[3] == 0.0 && self.fem.fiber.is_empty()) {
            return;
        }
        self.fem.fiber.resize(self.fem.count.max(first + count));
        self.fem.fiber[first..first + count].fill(fiber);
    }

    pub(crate) fn fiber(&self, t: usize) -> (Vec3, f64) {
        let Some([x, y, z, modulus]) = self.fem.fiber.get(t).copied() else { return ([0.0; 3], 0.0) };
        ([x as f64, y as f64, z as f64], modulus as f64)
    }
    pub fn set_rubber(&mut self, row: usize, config: [f32; 3]) {
        if config[0] == 0.0 && self.fem.rubber.is_empty() {
            return;
        }
        self.fem.rubber.resize(self.fem.count.max(row + 1));
        self.fem.rubber[row] = config;
    }

    fn rubber_law(&self, row: usize) -> Option<RubberLaw> {
        let &[locking, transverse, spread] = self.fem.rubber.get(row)?;
        if locking == 0.0 {
            return None;
        }
        let (mu, lambda) = (self.fem.mu[row] as f64, self.fem.lambda[row] as f64);
        let law = RubberLaw::new(mu, lambda, locking as f64, transverse as f64, spread as f64);
        debug_assert!(law.valid());
        Some(law)
    }

    /// Builds a deterministic incident-corner list. Rebuilding from live flags also handles tears and new body pieces.
    pub(crate) fn prepare_vertex_blocks(&mut self, h: f32, gravity: [f32; 3]) -> bool {
        if !(0..self.fem.count).any(|t| active_vertex_block(self.fem.flags[t])) {
            return false;
        }
        for b in 0..self.bodies {
            self.pressed[b] = 0;
        }
        let head = &mut self.fem.vertex_block.head;
        for i in 0..self.particles {
            head[i] = NONE;
        }
        let next = &mut self.fem.vertex_block.next;
        for t in 0..self.fem.count {
            if active_vertex_block(self.fem.flags[t]) {
                for k in 0..4 {
                    let index = 4 * t + k;
                    let particle = self.fem.p[k][t] as usize;
                    next[index] = head[particle];
                    head[particle] = index as u32;
                }
            }
        }
        self.first_guess(h, gravity);
        true
    }

    /// The passes' first guess (Chen et al. 2024, section 3.6, adaptive initialization): the predicted move takes the piece's
    /// accelerations (gravity and the forces put on the particle) only as far as the particle was last accelerating along them,
    /// so a body at rest under a load starts the passes where it rests. The inertial target the passes minimize toward keeps the
    /// whole acceleration; only where they start moves. Started from the full prediction, a pass count that leaves the sweep
    /// unconverged put the fixed point a load's h^2 a over one minus the sweep's convergence off the equilibrium: a hemisphere
    /// pressed on a floor at 8 pieces of 2 passes flattened (KB-SOFT-VBDGUESS1).
    fn first_guess(&mut self, h: f32, gravity: [f32; 3]) {
        for i in 0..self.particles {
            if self.fem.vertex_block.head[i] == NONE || !(self.w[i] > 0.0) || self.bsleep[self.pbody[i] as usize] != 0 {
                continue;
            }
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
            let back = h * h * (1.0 - along);
            self.x[i] -= back * a[0];
            self.y[i] -= back * a[1];
            self.z[i] -= back * a[2];
            self.vbx[i] = v[0];
            self.vby[i] = v[1];
            self.vbz[i] = v[2];
        }
    }

    /// D_s D_m^-1, computed with local f64 edges. Each entry in the result is a column.
    pub(crate) fn vertex_deformation(&self, corners: [usize; 4], b: [Vec3; 3], previous: bool) -> Columns {
        let at = |i| {
            if previous {
                [self.px[i] as f64, self.py[i] as f64, self.pz[i] as f64]
            } else {
                [self.x[i] as f64, self.y[i] as f64, self.z[i] as f64]
            }
        };
        let origin = at(corners[0]);
        let edges = [1, 2, 3].map(|i| {
            let position = at(corners[i]);
            [0, 1, 2].map(|j| position[j] - origin[j])
        });
        [0, 1, 2].map(|j| transform(edges, [b[0][j], b[1][j], b[2][j]]))
    }

    pub(crate) fn solve_vertex_blocks(&mut self, h: f32) {
        let dt = h as f64;
        let h2 = dt * dt;
        for i in 0..self.particles {
            let mut linked = self.fem.vertex_block.head[i];
            if linked == NONE || self.w[i] == 0.0 || self.bsleep[self.pbody[i] as usize] != 0 {
                continue;
            }
            if self.has_orthotropy((linked / 4) as usize) {
                self.solve_orthotropic_vertex(i, linked, h);
                self.hold_still_contacts(i, h);
                continue;
            }
            let mass = 1.0 / self.w[i] as f64;
            let current = [self.x[i] as f64, self.y[i] as f64, self.z[i] as f64];
            // Match the native f32 inertial prediction used at the start of the substep.
            let target = [(self.px[i] + h * self.vx[i]) as f64, (self.py[i] + h * self.vy[i]) as f64, (self.pz[i] + h * self.vz[i]) as f64];
            let mut grad = [0, 1, 2].map(|j| mass * (current[j] - target[j]));
            let mut isotropic = mass;
            let mut determinant = [0.0; 6];
            let mut has_rubber = false;
            while linked != NONE {
                let t = (linked / 4) as usize;
                let c = (linked % 4) as usize;
                linked = self.fem.vertex_block.next[linked as usize];
                let corners = [0, 1, 2, 3].map(|j| self.fem.p[j][t] as usize);
                let b = [0, 1, 2].map(|j| [0, 1, 2].map(|k| self.fem.b[3 * j + k][t] as f64));
                let g = if c == 0 { [0, 1, 2].map(|j| -b[0][j] - b[1][j] - b[2][j]) } else { b[c - 1] };
                let f = self.vertex_deformation(corners, b, false);
                let cof = [cross(f[1], f[2]), cross(f[2], f[0]), cross(f[0], f[1])];
                let j = dot(f[0], cof[0]);
                let dj = transform(cof, g);
                let mu = self.fem.mu[t] as f64;
                // The energy's lambda includes mu to recover the caller's Lamé parameters at rest.
                let lambda = self.fem.lambda[t] as f64 + mu;
                let scale = h2 * self.fem.vol0[t] as f64;
                let damping = self.fem.imp.beta[t] as f64 / dt;
                let prior = if damping > 0.0 { self.vertex_deformation(corners, b, true) } else { f };
                let fg = transform(f, g);
                if let Some(law) = self.rubber_law(t) {
                    has_rubber = true;
                    let (elastic, hessian) = rubber::vertex_terms(law, f, cof, g);
                    let pg = transform(prior, g);
                    let prior_j = dot(prior[0], cross(prior[1], prior[2]));
                    for axis in 0..3 {
                        let viscous = mu * (fg[axis] - pg[axis]) + lambda * (j - prior_j) * dj[axis];
                        grad[axis] += scale * (elastic[axis] + damping * viscous);
                    }
                    let viscous_scale = scale * damping;
                    isotropic += viscous_scale * mu * dot(g, g);
                    for (a, (j, k)) in COMPONENTS.into_iter().enumerate() {
                        determinant[a] += scale * hessian[a] + viscous_scale * lambda * dj[j] * dj[k];
                    }
                } else {
                    let mut fg = fg;
                    let mut volumetric = lambda * (j - 1.0) - mu;
                    if damping > 0.0 {
                        let pg = transform(prior, g);
                        for axis in 0..3 {
                            fg[axis] += damping * (fg[axis] - pg[axis]);
                        }
                        volumetric += damping * lambda * (j - dot(prior[0], cross(prior[1], prior[2])));
                    }
                    for axis in 0..3 {
                        grad[axis] += scale * (mu * fg[axis] + volumetric * dj[axis]);
                    }
                    let stiff = scale * (1.0 + damping);
                    isotropic += stiff * mu * dot(g, g);
                    for (a, (j, k)) in [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)].into_iter().enumerate() {
                        determinant[a] += stiff * lambda * dj[j] * dj[k];
                    }
                }
                let (axis, modulus) = self.fiber(t);
                if modulus > 0.0 {
                    let axial_gradient = dot(g, axis);
                    let image = transform(f, axis);
                    let target = fiber_target(image, axis);
                    let w = scale * modulus;
                    let old = transform(prior, axis);
                    for j in 0..3 {
                        grad[j] += w * axial_gradient * (image[j] - target[j] + damping * (image[j] - old[j]));
                    }
                    isotropic += w * (1.0 + damping) * axial_gradient * axial_gradient;
                }
            }
            for diagonal in determinant.iter_mut().take(3) {
                *diagonal += isotropic;
            }
            let mut direction = solve(determinant, grad).map(|value| -value);
            if has_rubber {
                if !direction.iter().all(|value| value.is_finite()) || dot(direction, direction) == 0.0 {
                    continue;
                }
                let objective = |delta| self.vertex_objective(i, current, target, mass, dt, delta);
                let initial = objective([0.0; 3]);
                // The majorized block gives a descent direction. Backtracking accepts an actual energy decrease.
                let mut accepted = false;
                for _ in 0..24 {
                    let next = objective(direction);
                    if next.is_finite() && next < initial {
                        accepted = true;
                        break;
                    }
                    direction = direction.map(|value| value * 0.5);
                }
                if !accepted {
                    continue;
                }
            }
            self.x[i] = (current[0] + direction[0]) as f32;
            self.y[i] = (current[1] + direction[1]) as f32;
            self.z[i] = (current[2] + direction[2]) as f32;
            self.hold_still_contacts(i, h);
        }
    }

    fn vertex_objective(&self, particle: usize, current: Vec3, target: Vec3, mass: f64, dt: f64, delta: Vec3) -> f64 {
        let residual = [0, 1, 2].map(|i| current[i] + delta[i] - target[i]);
        let mut value = 0.5 * mass * dot(residual, residual);
        let mut linked = self.fem.vertex_block.head[particle];
        while linked != NONE {
            let cell = linked as usize / 4;
            let corner = linked as usize % 4;
            linked = self.fem.vertex_block.next[linked as usize];
            let corners = [0, 1, 2, 3].map(|j| self.fem.p[j][cell] as usize);
            let b = [0, 1, 2].map(|j| [0, 1, 2].map(|k| self.fem.b[3 * j + k][cell] as f64));
            let g = if corner == 0 { [0, 1, 2].map(|j| -b[0][j] - b[1][j] - b[2][j]) } else { b[corner - 1] };
            let mut f = self.vertex_deformation(corners, b, false);
            for column in 0..3 {
                for axis in 0..3 {
                    f[column][axis] += delta[axis] * g[column];
                }
            }
            let cof = [cross(f[1], f[2]), cross(f[2], f[0]), cross(f[0], f[1])];
            let i1 = f.iter().map(|&axis| dot(axis, axis)).sum::<f64>();
            let j = dot(f[0], cof[0]);
            let mu = self.fem.mu[cell] as f64;
            let lambda = self.fem.lambda[cell] as f64 + mu;
            let elastic = if let Some(law) = self.rubber_law(cell) {
                let i2 = cof.iter().map(|&axis| dot(axis, axis)).sum();
                law.invariants(i1, i2, j).0
            } else {
                let gap = j - 1.0;
                0.5 * mu * (i1 - 3.0) + (0.5 * lambda * gap - mu) * gap
            };
            let damping = self.fem.imp.beta[cell] as f64 / dt;
            let prior = if damping > 0.0 { self.vertex_deformation(corners, b, true) } else { f };
            let viscous = if damping > 0.0 {
                let delta_j = j - dot(prior[0], cross(prior[1], prior[2]));
                let delta_f = [0, 1, 2].map(|j| [0, 1, 2].map(|i| f[j][i] - prior[j][i]));
                0.5 * damping * (mu * delta_f.iter().map(|&axis| dot(axis, axis)).sum::<f64>() + lambda * delta_j * delta_j)
            } else { 0.0 };

            let (axis, modulus) = self.fiber(cell);
            let fiber = if modulus > 0.0 {
                let image = transform(f, axis);
                let elongation = crate::math::sqrt64(dot(image, image)) - 1.0;
                let old = transform(prior, axis);
                let displacement = [0, 1, 2].map(|i| image[i] - old[i]);
                0.5 * modulus * (elongation * elongation + damping * dot(displacement, displacement))
            } else { 0.0 };

            value += dt * dt * self.fem.vol0[cell] as f64 * (elastic + viscous + fiber);
        }
        value
    }

    /// Minimize the implicit objective along the free translation after the local sweeps.
    /// Internal strain and its damping only depend on relative positions. Translating an
    /// unpinned body to its inertial mass center changes only the quadratic inertial term.
    pub(crate) fn solve_vertex_block_translation(&mut self, h: f32) {
        // The host keeps cell ranges contiguous by body, including after compaction or a cut.
        let mut previous = None;
        for cell in 0..self.fem.count {
            if !active_vertex_block(self.fem.flags[cell]) {
                continue;
            }
            let b = self.fem.body[cell] as usize;
            if previous == Some(b) {
                continue;
            }
            previous = Some(b);
            // A body the passes held off a still body has an outside reaction, as a pinned one has: its translation is not free.
            if self.bsleep[b] != 0 || self.pressed[b] != 0 {
                continue;
            }
            let first = self.b_first[b] as usize;
            let last = first + self.b_count[b] as usize;
            let mut total_mass = 0.0;
            let mut residual = [0.0; 3];
            for i in first..last {
                let inverse_mass = self.w[i] as f64;
                if inverse_mass == 0.0 {
                    // A pin supplies an external reaction, so uniform translation is not free.
                    total_mass = 0.0;
                    break;
                }
                let mass = inverse_mass.recip();
                total_mass += mass;
                let target = [self.px[i] + h * self.vx[i], self.py[i] + h * self.vy[i], self.pz[i] + h * self.vz[i]];
                let solved = [self.x[i], self.y[i], self.z[i]];
                for a in 0..3 {
                    residual[a] += mass * (target[a] as f64 - solved[a] as f64);
                }
            }
            if total_mass == 0.0 {
                continue;
            }
            let delta = residual.map(|value| value / total_mass);
            for i in first..last {
                self.x[i] = (self.x[i] as f64 + delta[0]) as f32;
                self.y[i] = (self.y[i] as f64 + delta[1]) as f32;
                self.z[i] = (self.z[i] as f64 + delta[2]) as f32;
            }
        }
    }
}
