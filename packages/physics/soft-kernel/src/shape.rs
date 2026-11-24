// Shape matching: every particle of a body is pulled toward its place in the best-fit rotated rest shape (Mueller, Heidelberger,
// Teschner and Gross, "Meshless Deformations Based on Shape Matching", 2005), as a compliant position constraint in the
// XPBD form, so a natural frequency of 0 holds the shape rigid. The rotation of the best fit is found by the iteration of
// Mueller, Bender, Chentanez and Macklin, "A Robust Method to Extract the Rotational Part of Deformations", 2016, which
// divides and takes square roots but never calls a trigonometric function, and is warm-started from the last rotation.
use crate::math::sqrt;
use crate::world::World;

type Quat = [f32; 4];

fn mul(a: Quat, b: Quat) -> Quat {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

fn rotate(q: Quat, v: [f32; 3]) -> [f32; 3] {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let tx = 2.0 * (y * v[2] - z * v[1]);
    let ty = 2.0 * (z * v[0] - x * v[2]);
    let tz = 2.0 * (x * v[1] - y * v[0]);
    [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalized(q: Quat) -> Quat {
    let n = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if n < 1e-12 { [0.0, 0.0, 0.0, 1.0] } else { [q[0] / n, q[1] / n, q[2] / n, q[3] / n] }
}

/// The rotation part of `a`, whose columns are `a[0..3]`: the rotation `q` improved until it stops changing.
fn extract(a: [[f32; 3]; 3], mut q: Quat) -> Quat {
    for _ in 0..16 {
        let r = [rotate(q, [1.0, 0.0, 0.0]), rotate(q, [0.0, 1.0, 0.0]), rotate(q, [0.0, 0.0, 1.0])];
        let c = [cross(r[0], a[0]), cross(r[1], a[1]), cross(r[2], a[2])];
        let top = [c[0][0] + c[1][0] + c[2][0], c[0][1] + c[1][1] + c[2][1], c[0][2] + c[1][2] + c[2][2]];
        let bottom = dot(r[0], a[0]) + dot(r[1], a[1]) + dot(r[2], a[2]);
        let bottom = (if bottom < 0.0 { -bottom } else { bottom }) + 1e-9;
        let (wx, wy, wz) = (top[0] / bottom, top[1] / bottom, top[2] / bottom);
        let size = sqrt(wx * wx + wy * wy + wz * wz);
        if size < 1e-7 {
            break;
        }
        // A rotation by 2 atan(|w| / 2) about w: the first-order step, with no sine or cosine.
        q = normalized(mul([wx * 0.5, wy * 0.5, wz * 0.5, 1.0], q));
    }
    q
}

impl World {
    /// Clears the multipliers of every matched particle at the start of a substep.
    pub(crate) fn shape_begin(&mut self) {
        for b in 0..self.bodies {
            if self.b_on[b] == 0 {
                continue;
            }
            let (first, count) = (self.b_first[b] as usize, self.b_count[b] as usize);
            for i in first..first + count {
                self.slx[i] = 0.0;
                self.sly[i] = 0.0;
                self.slz[i] = 0.0;
            }
        }
    }

    /// One pass of shape matching over every matched body.
    pub(crate) fn solve_shape(&mut self, h: f32) {
        for b in 0..self.bodies {
            if self.b_on[b] != 0 {
                self.match_body(b, h);
            }
        }
    }

    fn match_body(&mut self, b: usize, h: f32) {
        let (first, count) = (self.b_first[b] as usize, self.b_count[b] as usize);
        let (mut m, mut cx, mut cy, mut cz) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for i in first..first + count {
            let mi = self.sw[i];
            m += mi;
            cx += mi * self.x[i];
            cy += mi * self.y[i];
            cz += mi * self.z[i];
        }
        if m <= 0.0 {
            return;
        }
        let (cx, cy, cz) = (cx / m, cy / m, cz / m);
        // A = sum m (x - c) r^T, kept by column: column j is sum m (x - c) r_j.
        let mut a = [[0.0f32; 3]; 3];
        for i in first..first + count {
            let mi = self.sw[i];
            let p = [self.x[i] - cx, self.y[i] - cy, self.z[i] - cz];
            let r = [self.rx[i], self.ry[i], self.rz[i]];
            for j in 0..3 {
                for k in 0..3 {
                    a[j][k] += mi * p[k] * r[j];
                }
            }
        }
        let mut q = [self.bqx[b], self.bqy[b], self.bqz[b], self.bqw[b]];
        if q[0] == 0.0 && q[1] == 0.0 && q[2] == 0.0 && q[3] == 0.0 {
            q = [0.0, 0.0, 0.0, 1.0];
        }
        q = extract(a, q);
        self.bqx[b] = q[0];
        self.bqy[b] = q[1];
        self.bqz[b] = q[2];
        self.bqw[b] = q[3];
        let omega = self.b_omega[b];
        let (alpha_scale, gamma) = if omega > 0.0 {
            let wh = omega * h;
            (1.0 / (wh * wh), 2.0 * self.b_zeta[b] / wh)
        } else {
            (0.0, 0.0)
        };
        for i in first..first + count {
            let wi = self.w[i];
            if wi == 0.0 {
                continue;
            }
            let g = rotate(q, [self.rx[i], self.ry[i], self.rz[i]]);
            let goal = [cx + g[0], cy + g[1], cz + g[2]];
            let alpha = wi * alpha_scale;
            let denominator = (1.0 + gamma) * wi + alpha;
            let moved = [self.x[i] - self.px[i], self.y[i] - self.py[i], self.z[i] - self.pz[i]];
            let err = [self.x[i] - goal[0], self.y[i] - goal[1], self.z[i] - goal[2]];
            let lam = [self.slx[i], self.sly[i], self.slz[i]];
            let mut d = [0.0f32; 3];
            for k in 0..3 {
                d[k] = (-err[k] - alpha * lam[k] - gamma * moved[k]) / denominator;
            }
            self.slx[i] += d[0];
            self.sly[i] += d[1];
            self.slz[i] += d[2];
            self.x[i] += wi * d[0];
            self.y[i] += wi * d[1];
            self.z[i] += wi * d[2];
        }
    }
}
