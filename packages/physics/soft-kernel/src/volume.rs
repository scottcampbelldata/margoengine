// Volume preservation of a closed triangle surface: one constraint on the enclosed volume V = sum over triangles of
// x_a . (x_b x x_c) / 6, held to a target (the rest volume times a factor above 1 to inflate it) by a compliant position
// correction along the gradient of V, in the XPBD form (Macklin, Mueller, Chentanez 2016); the gradient of the enclosed volume
// with respect to a vertex is the sum of the cross products of the other two vertices of each triangle around it, over 6
// (the divergence theorem form used for pressurized cloth by Mueller, Heidelberger, Hennix and Ratcliff, "Position Based
// Dynamics", 2007, section 4.4, "balloons"). A natural frequency of 0 holds the volume exactly.
use crate::math::sqrt64;
use crate::world::World;

fn area_thirds(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 3] {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    [
        (u[1] * v[2] - u[2] * v[1]) / 6.0,
        (u[2] * v[0] - u[0] * v[2]) / 6.0,
        (u[0] * v[1] - u[1] * v[0]) / 6.0,
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

impl World {
    /// The enclosed volume of the closed surface of body `b`: positive when its triangles face outward.
    pub fn surface_volume(&self, b: usize) -> f32 {
        let first = self.vb_first[b] as usize;
        let count = self.vb_count[b] as usize;
        if count == 0 {
            return 0.0;
        }
        let origin = self.volume_position(self.vtri[3 * first] as usize);
        let mut volume = 0.0;
        for t in first..first + count {
            let (_, corner, normal) = self.volume_triangle(t);
            volume += dot([corner[0] - origin[0], corner[1] - origin[1], corner[2] - origin[2]], normal);
        }
        volume as f32
    }

    pub(crate) fn volume_begin(&mut self) {
        for b in 0..self.bodies {
            self.vb_lambda[b] = 0.0;
        }
    }

    pub(crate) fn solve_volume(&mut self, h: f32) {
        for b in 0..self.bodies {
            if self.vb_count[b] > 0 {
                match self.vb_on[b] {
                    1 => self.hold_volume(b, h),
                    2 => self.solve_gas(b, h),
                    _ => {}
                }
            }
        }
    }

    fn volume_position(&self, i: usize) -> [f64; 3] {
        [self.x[i] as f64, self.y[i] as f64, self.z[i] as f64]
    }

    fn volume_triangle(&self, t: usize) -> ([usize; 3], [f64; 3], [f64; 3]) {
        let indices = [self.vtri[3 * t] as usize, self.vtri[3 * t + 1] as usize, self.vtri[3 * t + 2] as usize];
        let [a, b, c] = indices.map(|i| self.volume_position(i));
        (indices, a, area_thirds(a, b, c))
    }

    /// Implicit isothermal gas pressure with a linearized volume response to the XPBD multiplier.
    fn solve_gas(&mut self, b: usize, h: f32) {
        let first = self.vb_first[b] as usize;
        let count = self.vb_count[b] as usize;
        let p0 = self.b_first[b] as usize;
        let p1 = p0 + self.b_count[b] as usize;
        for i in p0..p1 {
            self.vgx[i] = 0.0;
            self.vgy[i] = 0.0;
            self.vgz[i] = 0.0;
        }
        let origin = self.volume_position(self.vtri[3 * first] as usize);
        let mut volume = 0.0;
        for t in first..first + count {
            let (indices, corner, normal) = self.volume_triangle(t);
            volume += dot([corner[0] - origin[0], corner[1] - origin[1], corner[2] - origin[2]], normal);
            // On a closed shell, the area-normal contribution of one triangle is identical at all three vertices.
            for i in indices {
                self.vgx[i] += normal[0] as f32;
                self.vgy[i] += normal[1] as f32;
                self.vgz[i] += normal[2] as f32;
            }
        }
        let mut weight = 0.0;
        for i in p0..p1 {
            let g = [self.vgx[i] as f64, self.vgy[i] as f64, self.vgz[i] as f64];
            weight += self.w[i] as f64 * dot(g, g);
        }
        if weight == 0.0 || !weight.is_finite() {
            return;
        }
        let h2 = f64::from(h) * f64::from(h);
        let old = self.vb_lambda[b] as f64;
        let ambient = self.vb_ambient[b] as f64;
        let nrt = self.vb_target[b] as f64;
        // V_next = V + W * (lambda_next - lambda), lambda_next = h² * (nRT / V_next - p_out).
        // The positive quadratic root stays well-conditioned even when the ambient load dominates.
        let free = volume - weight * (old + h2 * ambient);
        let gas = weight * h2 * nrt;
        let discriminant = sqrt64(free * free + 4.0 * gas);
        let next_volume = if free >= 0.0 {
            (free + discriminant) * 0.5
        } else {
            (2.0 * gas) / (discriminant - free)
        };
        let next = h2 * (nrt / next_volume - ambient);
        let delta = next - old;
        self.vb_lambda[b] = next as f32;
        for i in p0..p1 {
            let change = self.w[i] as f64 * delta;
            self.x[i] = (self.x[i] as f64 + change * self.vgx[i] as f64) as f32;
            self.y[i] = (self.y[i] as f64 + change * self.vgy[i] as f64) as f32;
            self.z[i] = (self.z[i] as f64 + change * self.vgz[i] as f64) as f32;
        }
    }

    fn hold_volume(&mut self, b: usize, h: f32) {
        let (first, count) = (self.vb_first[b] as usize, self.vb_count[b] as usize);
        let (p0, pn) = (self.b_first[b] as usize, self.b_count[b] as usize);
        // The gradient of the volume at each particle of the body, and the volume itself.
        for i in p0..p0 + pn {
            self.vgx[i] = 0.0;
            self.vgy[i] = 0.0;
            self.vgz[i] = 0.0;
        }
        let mut volume = 0.0f32;
        for t in first..first + count {
            let (a, bb, c) = (self.vtri[3 * t] as usize, self.vtri[3 * t + 1] as usize, self.vtri[3 * t + 2] as usize);
            let (pa, pb, pc) = ([self.x[a], self.y[a], self.z[a]], [self.x[bb], self.y[bb], self.z[bb]], [self.x[c], self.y[c], self.z[c]]);
            let (ga, gb, gc) = (cross(pb, pc), cross(pc, pa), cross(pa, pb));
            volume += (pa[0] * ga[0] + pa[1] * ga[1] + pa[2] * ga[2]) / 6.0;
            for (i, g) in [(a, ga), (bb, gb), (c, gc)] {
                self.vgx[i] += g[0] / 6.0;
                self.vgy[i] += g[1] / 6.0;
                self.vgz[i] += g[2] / 6.0;
            }
        }
        // sum w |gradient|^2, and the gradient's dot with the motion of the piece for the damping term.
        let (mut weight, mut moved) = (0.0f32, 0.0f32);
        for i in p0..p0 + pn {
            let g = [self.vgx[i], self.vgy[i], self.vgz[i]];
            weight += self.w[i] * (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
            moved += g[0] * (self.x[i] - self.px[i]) + g[1] * (self.y[i] - self.py[i]) + g[2] * (self.z[i] - self.pz[i]);
        }
        if weight <= 1e-20 {
            return;
        }
        let omega = self.vb_omega[b];
        let (alpha, gamma) = if omega > 0.0 {
            let wh = omega * h;
            (weight / (wh * wh), 2.0 * self.vb_zeta[b] / wh)
        } else {
            (0.0, 0.0)
        };
        let c = volume - self.vb_target[b];
        let delta = (-c - alpha * self.vb_lambda[b] - gamma * moved) / ((1.0 + gamma) * weight + alpha);
        self.vb_lambda[b] += delta;
        for i in p0..p0 + pn {
            let wi = self.w[i];
            self.x[i] += wi * delta * self.vgx[i];
            self.y[i] += wi * delta * self.vgy[i];
            self.z[i] += wi * delta * self.vgz[i];
        }
    }
}
