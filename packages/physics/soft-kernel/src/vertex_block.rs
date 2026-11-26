// Chen, Liu, Yang and Yuksel, "Vertex Block Descent" (2024), with the log-free stable Neo-Hookean energy shown in
// Smith, de Goes and Kim (2018), Eq. 13. A tetrahedron's F changes by a rank-one matrix in one vertex, so J is affine
// and the three-DOF energy is quadratic there. Its exact SPD Hessian is a scalar identity plus determinant outer products.
use crate::World;
use crate::col::Col;
use crate::fem::{NONE, TORN_TET, VERTEX_BLOCK_TET};

type Vec3 = [f64; 3];
type Columns = [Vec3; 3];

pub(crate) struct VertexBlock {
    pub head: Col<u32>,
    pub next: Col<u32>,
}

impl VertexBlock {
    pub const fn new() -> Self {
        Self { head: Col::new(), next: Col::new() }
    }
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn transform(f: Columns, g: Vec3) -> Vec3 {
    [0, 1, 2].map(|i| f[0][i] * g[0] + f[1][i] * g[1] + f[2][i] * g[2])
}

/// A symmetric LDL^T solve. Block inertia and shear are strictly positive for every moving vertex.
fn solve([xx, yy, zz, xy, xz, yz]: [f64; 6], b: Vec3) -> Vec3 {
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
    /// Builds a deterministic incident-corner list. Rebuilding from live flags also handles tears and new body pieces.
    pub(crate) fn prepare_vertex_blocks(&mut self) -> bool {
        let active = |flag| flag & (TORN_TET | VERTEX_BLOCK_TET) == VERTEX_BLOCK_TET;
        if !(0..self.fem.count).any(|t| active(self.fem.flags[t])) {
            return false;
        }
        let head = &mut self.fem.vertex_block.head;
        for i in 0..self.particles {
            head[i] = NONE;
        }
        let next = &mut self.fem.vertex_block.next;
        for t in 0..self.fem.count {
            if active(self.fem.flags[t]) {
                for k in 0..4 {
                    let index = 4 * t + k;
                    let particle = self.fem.p[k][t] as usize;
                    next[index] = head[particle];
                    head[particle] = index as u32;
                }
            }
        }
        true
    }

    /// D_s D_m^-1, computed with local f64 edges. Each entry in the result is a column.
    fn vertex_deformation(&self, corners: [usize; 4], b: [Vec3; 3], previous: bool) -> Columns {
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
            let mass = 1.0 / self.w[i] as f64;
            let current = [self.x[i] as f64, self.y[i] as f64, self.z[i] as f64];
            // Match the native f32 inertial prediction used at the start of the substep.
            let target = [(self.px[i] + h * self.vx[i]) as f64, (self.py[i] + h * self.vy[i]) as f64, (self.pz[i] + h * self.vz[i]) as f64];
            let mut grad = [0, 1, 2].map(|j| mass * (current[j] - target[j]));
            let mut isotropic = mass;
            let mut determinant = [0.0; 6];
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
                let mut fg = transform(f, g);
                let mut volumetric = lambda * (j - 1.0) - mu;
                if damping > 0.0 {
                    let prior = self.vertex_deformation(corners, b, true);
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
            for diagonal in determinant.iter_mut().take(3) {
                *diagonal += isotropic;
            }
            let dx = solve(determinant, grad);
            self.x[i] = (current[0] - dx[0]) as f32;
            self.y[i] = (current[1] - dx[1]) as f32;
            self.z[i] = (current[2] - dx[2]) as f32;
        }
    }
}
