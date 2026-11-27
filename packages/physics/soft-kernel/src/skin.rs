// Skinned cloth: motion constraints that tie each particle of a garment to where the character's skin carries it. Each row
// holds a particle, its skinned point (where the skeleton puts that particle this step), the point's speed over the step, the
// skin's outward normal there, the farthest the particle may stray from the point (its max distance) and how far it may go
// behind the skin along the normal (its backstop). The point moves at a steady speed over the step, so a particle is held to
// where the skin is at each piece of it, not where it will end. A particle outside its sphere is put back on it, and one behind
// the skin's plane is put back on the plane: one-sided projections (Mueller, Heidelberger, Hennix and Ratcliff, "Position
// Based Dynamics", 2007), the motion and backstop constraints character cloth is tied with (Kim, Chentanez and Mueller, "Long
// Range Attachments", SCA 2012, section 5; Jakobsen, "Advanced Character Physics", GDC 2001). A particle within both moves
// as the cloth moves it, so a cape is free where it may swing and follows the body where it must.
use crate::math::sqrt;
use crate::world::World;

impl World {
    /// Carries every skinned point on by one piece of the step.
    pub fn advance_skin(&mut self, h: f32) {
        for s in 0..self.skins {
            self.sk_x[s] += h * self.sk_vx[s];
            self.sk_y[s] += h * self.sk_vy[s];
            self.sk_z[s] += h * self.sk_vz[s];
        }
    }

    /// One pass over the skinned particles: back inside the max distance, then in front of the backstop.
    pub fn solve_skin(&mut self) {
        for s in 0..self.skins {
            let p = self.sk_p[s] as usize;
            if !(self.w[p] > 0.0) {
                continue;
            }
            let (ax, ay, az) = (self.sk_x[s], self.sk_y[s], self.sk_z[s]);
            let (mut dx, mut dy, mut dz) = (self.x[p] - ax, self.y[p] - ay, self.z[p] - az);
            let reach = self.sk_max[s];
            let squared = dx * dx + dy * dy + dz * dz;
            if squared > reach * reach {
                let share = reach / sqrt(squared);
                dx *= share;
                dy *= share;
                dz *= share;
            }
            let back = self.sk_back[s];
            if back >= 0.0 {
                let (nx, ny, nz) = (self.sk_nx[s], self.sk_ny[s], self.sk_nz[s]);
                let ahead = dx * nx + dy * ny + dz * nz;
                if ahead < -back {
                    let push = -back - ahead;
                    dx += push * nx;
                    dy += push * ny;
                    dz += push * nz;
                }
            }
            self.x[p] = ax + dx;
            self.y[p] = ay + dy;
            self.z[p] = az + dz;
        }
    }
}
