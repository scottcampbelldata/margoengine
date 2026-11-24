// A particle pinned to a rigid body: the particle is pulled to a point fixed in the body, and the body is pulled back with
// the same impulse at that point, shared by the two inverse masses and the body's inverse inertia (a point-to-point link, as
// a rigid-body joint of zero length; Macklin, Mueller and Chentanez 2016 for the position-level form, Macklin et al. 2014
// section 4 for the share). The anchor travels with the body's centre of mass through the step.
use crate::math::sqrt;
use crate::world::{NONE, World};

impl World {
    /// Makes room for this many attachments.
    pub fn reserve_attachments(&mut self, n: usize) {
        self.at_p.resize(n);
        self.at_row.resize(n);
        self.at_rx.resize(n);
        self.at_ry.resize(n);
        self.at_rz.resize(n);
    }

    /// One pass over the attachments: each particle moves toward its anchor, and the body takes the reaction.
    pub(crate) fn pull_attachments(&mut self, h: f32) {
        for a in 0..self.attachments {
            let row = self.at_row[a];
            let i = self.at_p[a] as usize;
            if row == NONE || self.w[i] <= 0.0 {
                continue;
            }
            let c = (row - 1) as usize;
            let (rx, ry, rz) = (self.at_rx[a], self.at_ry[a], self.at_rz[a]);
            let (ex, ey, ez) = (self.mx[c] + rx - self.x[i], self.my[c] + ry - self.y[i], self.mz[c] + rz - self.z[i]);
            let len = sqrt(ex * ex + ey * ey + ez * ez);
            if len < 1e-9 {
                continue;
            }
            let (nx, ny, nz) = (ex / len, ey / len, ez / len);
            // How easily the body gives way at the anchor along the pull.
            let (ax, ay, az) = (ry * nz - rz * ny, rz * nx - rx * nz, rx * ny - ry * nx);
            let (ix, iy, iz) = self.inverse_inertia(c, ax, ay, az);
            let wb = self.wm[c] + ax * ix + ay * iy + az * iz;
            let share = self.w[i] / (self.w[i] + wb);
            self.x[i] += nx * len * share;
            self.y[i] += ny * len * share;
            self.z[i] += nz * len * share;
            // The body takes the opposite impulse at the anchor, and moves on with it.
            let s = share / self.w[i] / h * len;
            let (jx, jy, jz) = (nx * s, ny * s, nz * s);
            let (jx, jy, jz) = (-jx, -jy, -jz);
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
