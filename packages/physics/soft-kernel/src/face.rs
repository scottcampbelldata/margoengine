// A rigid body against the faces of a soft body: a body smaller than the spacing of a cloth's particles, or a thin one lying
// between them, is held by the triangle under it, not by the particles at its corners. The host finds each contact once a step
// (the rigid world's face probe): a point on the body's surface, the normal out of it, and the triangle's corners with their
// weights at the point of the triangle facing it. Every pass of every piece keeps that point of the triangle the sheet's
// thickness out of the body's surface, as the constraint of a point and a triangle with a thickness (Mueller, Heidelberger,
// Hennix and Ratcliff 2007, "Position based dynamics", section 4.4; Bridson, Fedkiw and Anderson 2002 for the thickness),
//
//     C = (sum w_i x_i - p) . n - r >= 0,
//
// with the body as the point side. The correction is shared by generalized inverse masses: the triangle's sum w_i^2 / m_i
// (each corner moving by its weight over its mass), and the body's 1/m + (q x n) I^-1 (q x n) at the point `q` from its centre
// (Mueller, Macklin, Chentanez, Jeschke and Kim 2020, "Detailed rigid body simulation with extended position based dynamics",
// equations 2 to 4), the body taking the reaction at the point it was found at, as the particle planes do (Shinar, Schroeder and
// Fedkiw 2008, "Two-way coupling of rigid and deformable bodies", for the reaction of a deformable surface point shared among the
// nodes that carry it). Friction is a bounded displacement across the plane (Macklin et al. 2014), and after the piece the
// velocities of the triangle's point and the body's are made inelastic along the normal with Coulomb friction across it, as the
// particle planes' are (`contact_velocities`).
use crate::math::sqrt;

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
use crate::world::{NONE, World};

impl World {
    /// Makes room for this many face contacts.
    pub fn reserve_faces(&mut self, n: usize) {
        for v in [&mut self.fc_a, &mut self.fc_b, &mut self.fc_c, &mut self.fc_row] {
            v.resize(n);
        }
        for v in [
            &mut self.fc_wa, &mut self.fc_wb, &mut self.fc_wc, &mut self.fc_nx, &mut self.fc_ny, &mut self.fc_nz, &mut self.fc_px,
            &mut self.fc_py, &mut self.fc_pz, &mut self.fc_vx, &mut self.fc_vy, &mut self.fc_vz, &mut self.fc_f, &mut self.fc_r,
            &mut self.fc_j, &mut self.fc_k, &mut self.fc_side,
        ] {
            v.resize(n);
        }
    }

    /// The three particles of face contact `f` and their weights.
    fn face_corners(&self, f: usize) -> ([usize; 3], [f32; 3]) {
        ([self.fc_a[f] as usize, self.fc_b[f] as usize, self.fc_c[f] as usize], [self.fc_wa[f], self.fc_wb[f], self.fc_wc[f]])
    }

    /// The point of the triangle a face contact faces: the weighted sum of its corners.
    fn face_point(&self, corners: [usize; 3], weights: [f32; 3]) -> [f32; 3] {
        let mut p = [0.0f32; 3];
        for k in 0..3 {
            let i = corners[k];
            p[0] += weights[k] * self.x[i];
            p[1] += weights[k] * self.y[i];
            p[2] += weights[k] * self.z[i];
        }
        p
    }

    /// The triangle's generalized inverse mass at the point: sum w_k^2 / m_k; 0 where the soft body dominates the body.
    fn face_inverse_mass(&self, c: usize, corners: [usize; 3], weights: [f32; 3]) -> f32 {
        if self.dom[c] > 0.0 {
            return 0.0;
        }
        weights[0] * weights[0] * self.w[corners[0]] + weights[1] * weights[1] * self.w[corners[1]] + weights[2] * weights[2] * self.w[corners[2]]
    }

    /// The body's inverse mass at the point `q` from its centre along `n`.
    fn body_inverse_mass(&self, c: usize, q: [f32; 3], n: [f32; 3]) -> f32 {
        let a = [q[1] * n[2] - q[2] * n[1], q[2] * n[0] - q[0] * n[2], q[0] * n[1] - q[1] * n[0]];
        let (ix, iy, iz) = self.inverse_inertia(c, a[0], a[1], a[2]);
        self.wm[c] + a[0] * ix + a[1] * iy + a[2] * iz
    }

    /// The side of its triangle each face contact's body is on, where the body is round (a ball, a capsule's side, a rounded
    /// edge: a radius of curvature above 0), from where both were at the step's start (`begin`), kept for the step: the body's
    /// centre of curvature then against the triangle's plane then (Bridson, Fedkiw and Anderson 2002, "Robust treatment of
    /// collisions, contact and friction for cloth animation", and Harmon, Vouga, Tamstorf and Grinspun 2008, "Robust treatment
    /// of simultaneous collisions", both keep the side a pair was on before the step). The normal a round contact was found with
    /// cannot say: the host finds it where the body touches during the step, in the body's frame at the step's start, and a
    /// round body that rolls carries its contact round its surface (Montana 1988, "The kinematics of contact and grasp"), so for
    /// a rod rolling a radian or two a step the normal found under it came back lying almost in the sheet's plane, or turned
    /// with the rod past a quarter turn pointed back into it; either way the sheet was met from below and the rod thrown through
    /// it. A point of a body's own (a corner or an edge, rho 0), and a round body whose centre of curvature lies in the plane
    /// itself, keep 0: their side is the normal found, turned with the body, as before.
    pub(crate) fn face_sides(&mut self) {
        for f in 0..self.faces {
            self.fc_side[f] = 0.0;
            let rho = self.fc_k[f];
            if self.fc_row[f] == NONE || !(rho > 0.0) {
                continue;
            }
            let (corners, _) = self.face_corners(f);
            let p = |i: usize| [self.x[i], self.y[i], self.z[i]];
            let (a, b, d) = (p(corners[0]), p(corners[1]), p(corners[2]));
            let (e1, e2) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]);
            let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            let length = sqrt(dot(n, n));
            if !(length > 1e-12) {
                continue;
            }
            // The centre of curvature where the contact was found, in the body's pose at the step's start.
            let n0 = [self.fc_nx[f], self.fc_ny[f], self.fc_nz[f]];
            let centre = [self.fc_px[f] - rho * n0[0], self.fc_py[f] - rho * n0[1], self.fc_pz[f] - rho * n0[2]];
            let above = dot([centre[0] - a[0], centre[1] - a[1], centre[2] - a[2]], n) / length;
            // The normal points out of the body toward the triangle: against the side the centre is on.
            self.fc_side[f] = if above > 1e-6 { -1.0 } else if above < -1e-6 { 1.0 } else { 0.0 };
        }
    }

    /// Where face contact `f` with body row `c` stands at `tau` seconds into the step (the body's centre at `carried`, turned by
    /// `spin`, moved by `dm` and turned by `turn`): the triangle's corners and their weights at the point of it the contact holds,
    /// the unit normal out of the body, the point where the body takes the push (from its centre) and the gap from the body's
    /// surface to the triangle along the normal; None when the body's place has left the triangle (its neighbour holds it then).
    ///
    /// Where the body is flat (a face of a box over a corner of the triangle) the triangle's point is the one found and the body's
    /// plane turns with it, as a particle meets a face. Where the body is round, a corner or an edge (a bead, a rod, the corner of
    /// a box over the inside of the triangle), the triangle is the flat side: the normal is the triangle's own as it is now, and
    /// the point of the triangle is the foot of the body's nearest point on its plane, so the push on both lies on one line.
    #[allow(clippy::too_many_arguments)]
    fn face_meet(&self, f: usize, c: usize, tau: f32, carried: [f32; 3], spin: [f32; 4], dm: [f32; 3], turn: [f32; 4]) -> Option<([usize; 3], [f32; 3], [f32; 3], [f32; 3], f32)> {
        let found = [self.fc_px[f], self.fc_py[f], self.fc_pz[f]];
        let n0 = [self.fc_nx[f], self.fc_ny[f], self.fc_nz[f]];
        let v = [self.fc_vx[f], self.fc_vy[f], self.fc_vz[f]];
        let surface = self.surface_at(c, found, n0, v, self.fc_k[f], tau, carried, spin, dm, turn);
        let (corners, weights) = self.face_corners(f);
        if surface.flat {
            let (n, q, gap) = surface.meet(self.face_point(corners, weights));
            return Some((corners, weights, n, q, gap));
        }
        // The triangle's plane now, its normal turned out of the body: by the side a round body was on at the step's start
        // (`face_sides`), else as the contact's normal was found, turned with the body.
        let p = |i: usize| [self.x[i], self.y[i], self.z[i]];
        let (a, b, d) = (p(corners[0]), p(corners[1]), p(corners[2]));
        let (e1, e2) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]);
        let mut n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        let length = sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        if !(length > 1e-12) {
            return None;
        }
        let side = if self.fc_side[f] != 0.0 { self.fc_side[f] } else { dot(n, surface.normal) };
        let s = if side < 0.0 { -1.0 / length } else { 1.0 / length };
        n = [n[0] * s, n[1] * s, n[2] * s];
        // The body's point nearest the triangle, and its foot on the triangle's plane.
        let on = [surface.at[0] + n[0] * surface.rho, surface.at[1] + n[1] * surface.rho, surface.at[2] + n[2] * surface.rho];
        let gap = (a[0] - on[0]) * n[0] + (a[1] - on[1]) * n[1] + (a[2] - on[2]) * n[2];
        let foot = [on[0] + n[0] * gap, on[1] + n[1] * gap, on[2] + n[2] * gap];
        // Its weights on the triangle; past an edge the body is over the neighbouring triangle.
        let rel = [foot[0] - a[0], foot[1] - a[1], foot[2] - a[2]];
        let (d00, d01, d11) = (dot(e1, e1), dot(e1, e2), dot(e2, e2));
        let (d20, d21) = (dot(rel, e1), dot(rel, e2));
        let denominator = d00 * d11 - d01 * d01;
        if !(denominator > 0.0) {
            return None;
        }
        let wb = (d11 * d20 - d01 * d21) / denominator;
        let wc = (d00 * d21 - d01 * d20) / denominator;
        let wa = 1.0 - wb - wc;
        let slack = -1e-3;
        if wa < slack || wb < slack || wc < slack {
            return None;
        }
        let q = [on[0] - surface.centre[0], on[1] - surface.centre[1], on[2] - surface.centre[2]];
        Some((corners, [wa.max(0.0), wb.max(0.0), wc.max(0.0)], n, q, gap))
    }

    /// Keeps the point each face contact faces the sheet's thickness out of its body, at `tau` seconds into the step.
    pub fn apply_faces(&mut self, h: f32, tau: f32) {
        for f in 0..self.faces {
            if self.fc_row[f] == NONE {
                continue;
            }
            let c = (self.fc_row[f] - 1) as usize;
            let carried = [self.mx[c] + self.lvx[c] * h, self.my[c] + self.lvy[c] * h, self.mz[c] + self.lvz[c] * h];
            let dm = [self.dmx[c], self.dmy[c], self.dmz[c]];
            let turn = [self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]];
            let spin = [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]];
            let Some((corners, weights, n, q, gap)) = self.face_meet(f, c, tau, carried, spin, dm, turn) else { continue };
            let d = gap - self.fc_r[f];
            if d >= 0.0 {
                continue;
            }
            let wt = self.face_inverse_mass(c, corners, weights);
            let wb = self.body_inverse_mass(c, q, n);
            if wt + wb <= 0.0 {
                continue;
            }
            // The multiplier of the correction (a displacement times mass): the triangle's point moves out by wt of it, the body
            // back by wb of it, closing the gap.
            let lambda = -d / (wt + wb);
            if wt > 0.0 {
                // Each corner by its weight over its mass, so the point moves by wt * lambda along the normal.
                let mut moved = [0.0f32; 3];
                for k in 0..3 {
                    let s = weights[k] * self.w[corners[k]] * lambda;
                    self.x[corners[k]] += n[0] * s;
                    self.y[corners[k]] += n[1] * s;
                    self.z[corners[k]] += n[2] * s;
                }
                // Friction: the point's slide across the plane over the piece, against the surface's, held back by at most the
                // coefficient times the push, the triangle taking its share (Macklin et al. 2014).
                let now = self.face_point(corners, weights);
                let mut before = [0.0f32; 3];
                for k in 0..3 {
                    let i = corners[k];
                    before[0] += weights[k] * self.px[i];
                    before[1] += weights[k] * self.py[i];
                    before[2] += weights[k] * self.pz[i];
                }
                let v = [self.fc_vx[f], self.fc_vy[f], self.fc_vz[f]];
                let mut u = [now[0] - before[0] - v[0] * h, now[1] - before[1] - v[1] * h, now[2] - before[2] - v[2] * h];
                let un = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
                u = [u[0] - n[0] * un, u[1] - n[1] * un, u[2] - n[2] * un];
                let slide = sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
                if slide > 1e-12 {
                    let limit = self.fc_f[f] * -d;
                    let keep = if slide < limit { 1.0 } else { limit / slide };
                    let share = wt / (wt + wb);
                    moved = [-u[0] * keep * share, -u[1] * keep * share, -u[2] * keep * share];
                }
                // A move of the point by `moved` is each corner by its weight over its mass, over the triangle's inverse mass.
                for k in 0..3 {
                    let s = weights[k] * self.w[corners[k]] / wt;
                    self.x[corners[k]] += moved[0] * s;
                    self.y[corners[k]] += moved[1] * s;
                    self.z[corners[k]] += moved[2] * s;
                }
            }
            self.correct_body(c, [-n[0] * lambda, -n[1] * lambda, -n[2] * lambda], q, h);
            self.fc_j[f] += lambda / h;
        }
    }

    /// After a piece: the face contacts' speeds along the normal are taken out (an inelastic contact) and friction holds back what
    /// Coulomb allows across it, the body taking the same impulse back.
    pub(crate) fn face_velocities(&mut self) {
        let tau = self.tau_end;
        for f in 0..self.faces {
            if self.fc_row[f] == NONE {
                continue;
            }
            // Only a contact the piece pushed on (Mueller et al. 2020, section 3.6: the velocity pass is over the contacts the
            // position pass made).
            if self.fc_j[f] <= 0.0 {
                continue;
            }
            let c = (self.fc_row[f] - 1) as usize;
            let carried = [self.mx[c], self.my[c], self.mz[c]];
            let found = [self.fc_px[f], self.fc_py[f], self.fc_pz[f]];
            let sv = [self.fc_vx[f], self.fc_vy[f], self.fc_vz[f]];
            let spin = [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]];
            let Some((corners, weights, n, q, gap)) = self.face_meet(f, c, tau, carried, spin, [0.0; 3], [0.0, 0.0, 0.0, 1.0]) else { continue };
            if gap - self.fc_r[f] > 0.002 {
                continue;
            }
            let vb = self.surface_velocity(c, q, found, sv);
            let mut vx = [0.0f32; 3];
            for k in 0..3 {
                let i = corners[k];
                vx[0] += weights[k] * self.vx[i];
                vx[1] += weights[k] * self.vy[i];
                vx[2] += weights[k] * self.vz[i];
            }
            let rel = [vx[0] - vb[0], vx[1] - vb[1], vx[2] - vb[2]];
            let vn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
            let wt = self.face_inverse_mass(c, corners, weights);
            let wb = self.body_inverse_mass(c, q, n);
            if wt + wb <= 0.0 {
                continue;
            }
            let jn = vn / (wt + wb);
            let (tx, ty, tz) = (rel[0] - n[0] * vn, rel[1] - n[1] * vn, rel[2] - n[2] * vn);
            let tl = sqrt(tx * tx + ty * ty + tz * tz);
            let mut jt = 0.0;
            let t = if tl > 1e-9 { [tx / tl, ty / tl, tz / tl] } else { [0.0; 3] };
            if tl > 1e-9 {
                let along = wt + self.body_inverse_mass(c, q, t);
                let limit = self.fc_f[f] * ((if jn < 0.0 { -jn } else { jn }) + self.fc_j[f]);
                let want = if along > 0.0 { tl / along } else { 0.0 };
                jt = if want < limit { want } else { limit };
            }
            let j = [n[0] * jn + t[0] * jt, n[1] * jn + t[1] * jt, n[2] * jn + t[2] * jt];
            if wt > 0.0 {
                for k in 0..3 {
                    let s = weights[k] * self.w[corners[k]];
                    self.vx[corners[k]] -= s * j[0];
                    self.vy[corners[k]] -= s * j[1];
                    self.vz[corners[k]] -= s * j[2];
                }
            }
            self.jx[c] += j[0];
            self.jy[c] += j[1];
            self.jz[c] += j[2];
            let moment = [q[1] * j[2] - q[2] * j[1], q[2] * j[0] - q[0] * j[2], q[0] * j[1] - q[1] * j[0]];
            self.kx[c] += moment[0];
            self.ky[c] += moment[1];
            self.kz[c] += moment[2];
            if self.wm[c] > 0.0 {
                self.lvx[c] += j[0] * self.wm[c];
                self.lvy[c] += j[1] * self.wm[c];
                self.lvz[c] += j[2] * self.wm[c];
                let (wx, wy, wz) = self.inverse_inertia(c, moment[0], moment[1], moment[2]);
                self.avx[c] += wx;
                self.avy[c] += wy;
                self.avz[c] += wz;
            }
        }
        for f in 0..self.faces {
            self.fc_j[f] = 0.0;
        }
    }
}
