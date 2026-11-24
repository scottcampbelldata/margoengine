// Volume preservation of a closed triangle surface: one constraint on the enclosed volume V = sum over triangles of
// x_a . (x_b x x_c) / 6, held to a target (the rest volume times a factor above 1 to inflate it) by a compliant position
// correction along the gradient of V, in the XPBD form (Macklin, Mueller, Chentanez 2016); the gradient of the enclosed volume
// with respect to a vertex is the sum of the cross products of the other two vertices of each triangle around it, over 6
// (the divergence theorem form used for pressurized cloth by Mueller, Heidelberger, Hennix and Ratcliff, "Position Based
// Dynamics", 2007, section 4.4, "balloons"). A natural frequency of 0 holds the volume exactly.
use crate::world::World;

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

impl World {
    /// The enclosed volume of the closed surface of body `b`: positive when its triangles face outward.
    pub fn surface_volume(&self, b: usize) -> f32 {
        let (first, count) = (self.vb_first[b] as usize, self.vb_count[b] as usize);
        let mut v = 0.0f32;
        for t in first..first + count {
            let (a, bb, c) = (self.vtri[3 * t] as usize, self.vtri[3 * t + 1] as usize, self.vtri[3 * t + 2] as usize);
            let n = cross([self.x[bb], self.y[bb], self.z[bb]], [self.x[c], self.y[c], self.z[c]]);
            v += (self.x[a] * n[0] + self.y[a] * n[1] + self.z[a] * n[2]) / 6.0;
        }
        v
    }

    pub(crate) fn volume_begin(&mut self) {
        for b in 0..self.bodies {
            self.vb_lambda[b] = 0.0;
        }
    }

    pub(crate) fn solve_volume(&mut self, h: f32) {
        for b in 0..self.bodies {
            if self.vb_on[b] != 0 && self.vb_count[b] > 0 {
                self.hold_volume(b, h);
            }
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
