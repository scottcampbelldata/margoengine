// The world of soft bodies: every particle, edge and collider of one scene in rows, and the step that moves them.

/// Collider kinds, as TypeScript writes them in `c_kind`.
pub const SPHERE: u32 = 0;
pub const BOX: u32 = 1;
pub const CAPSULE: u32 = 2;
pub const HALF_SPACE: u32 = 3;

/// Particle flags.
pub const PINNED: u32 = 1;
/// A pinned particle that follows its target (`tx`, `ty`, `tz`) over the step.
pub const TARGETED: u32 = 2;
/// Edge flags.
pub const TORN: u32 = 1;
/// An edge that resists stretch and not squeeze (a rope that does not push).
pub const TENSION: u32 = 2;
/// No contact: the value of `kc` for a particle that meets nothing (a contact holds its table row plus one).
pub const NONE: u32 = 0;
/// Planes held for each particle.
pub const SLOTS: usize = 4;

use crate::math::{abs, sign, sqrt};
use crate::col::Col;

#[derive(Default)]
pub struct World {
    // Particles: position, the position a substep started from, velocity, inverse mass, radius, kinematic target.
    pub x: Col<f32>,
    pub y: Col<f32>,
    pub z: Col<f32>,
    pub px: Col<f32>,
    pub py: Col<f32>,
    pub pz: Col<f32>,
    pub vx: Col<f32>,
    pub vy: Col<f32>,
    pub vz: Col<f32>,
    pub w: Col<f32>,
    pub radius: Col<f32>,
    pub tx: Col<f32>,
    pub ty: Col<f32>,
    pub tz: Col<f32>,
    pub pflags: Col<u32>,
    pub pbody: Col<u32>,
    // Edges: two particles, the rest length, the softness (natural frequency in rad/s, 0 for rigid, and damping ratio), the
    // multiplier a substep has gathered, and the strain past which it tears (0 for never).
    pub ea: Col<u32>,
    pub eb: Col<u32>,
    pub rest: Col<f32>,
    pub omega: Col<f32>,
    pub zeta: Col<f32>,
    pub lambda: Col<f32>,
    pub tear: Col<f32>,
    pub eflags: Col<u32>,
    // Soft bodies: what applies to all their particles.
    pub gravity_scale: Col<f32>,
    pub linear_damping: Col<f32>,
    // Colliders handed in for a step: kind, pose, size, friction, the velocity of the body's centre and its spin, the centre.
    pub c_kind: Col<u32>,
    pub cx: Col<f32>,
    pub cy: Col<f32>,
    pub cz: Col<f32>,
    pub qx: Col<f32>,
    pub qy: Col<f32>,
    pub qz: Col<f32>,
    pub qw: Col<f32>,
    pub sx: Col<f32>,
    pub sy: Col<f32>,
    pub sz: Col<f32>,
    pub friction: Col<f32>,
    pub lvx: Col<f32>,
    pub lvy: Col<f32>,
    pub lvz: Col<f32>,
    pub avx: Col<f32>,
    pub avy: Col<f32>,
    pub avz: Col<f32>,
    pub mx: Col<f32>,
    pub my: Col<f32>,
    pub mz: Col<f32>,
    // What the step pushed on each collider's body: an impulse, and its moment about the body's centre.
    pub jx: Col<f32>,
    pub jy: Col<f32>,
    pub jz: Col<f32>,
    pub kx: Col<f32>,
    pub ky: Col<f32>,
    pub kz: Col<f32>,
    /// The body's inverse mass (0 for one that does not move) and the six distinct entries of its world inverse inertia.
    pub wm: Col<f32>,
    pub iixx: Col<f32>,
    pub iixy: Col<f32>,
    pub iixz: Col<f32>,
    pub iiyy: Col<f32>,
    pub iiyz: Col<f32>,
    pub iizz: Col<f32>,
    pub particles: usize,
    pub edges: usize,
    pub bodies: usize,
    pub colliders: usize,
    /// Edges that tore in the last step.
    pub torn: u32,
    // Shape matching (src/shape.rs). Per particle: the offset from the body's rest centre, the multipliers of the three axes
    // and the mass that weights the centre. Per body: on or off, the spring, the first particle and how many, and the
    // rotation kept from the last pass.
    pub rx: Col<f32>,
    pub ry: Col<f32>,
    pub rz: Col<f32>,
    pub slx: Col<f32>,
    pub sly: Col<f32>,
    pub slz: Col<f32>,
    pub sw: Col<f32>,
    pub b_on: Col<u32>,
    pub b_omega: Col<f32>,
    pub b_zeta: Col<f32>,
    pub b_first: Col<u32>,
    pub b_count: Col<u32>,
    pub bqx: Col<f32>,
    pub bqy: Col<f32>,
    pub bqz: Col<f32>,
    pub bqw: Col<f32>,
    // The planes each particle meets in the staged step, `SLOTS` a particle (slot `s` of particle `i` at row `i * SLOTS + s`):
    // the body row of the contacts table plus one (0 for none), the unit normal out of the surface, a point on it at the start
    // of the step, its velocity there and the friction coefficient. `apply_contacts` keeps a particle on the outer side of each.
    pub kc: Col<u32>,
    pub knx: Col<f32>,
    pub kny: Col<f32>,
    pub knz: Col<f32>,
    pub kpx: Col<f32>,
    pub kpy: Col<f32>,
    pub kpz: Col<f32>,
    pub kvx: Col<f32>,
    pub kvy: Col<f32>,
    pub kvz: Col<f32>,
    pub kf: Col<f32>,
    /// Tetrahedra and clusters (src/fem.rs).
    pub fem: crate::fem::Fem,
    // Particles pinned to rigid bodies (src/attach.rs): per attachment, the particle, the body row of the contacts table plus
    // one (0 for none this step) and the anchor's offset from the body's centre of mass in the world frame.
    pub at_p: Col<u32>,
    pub at_row: Col<u32>,
    pub at_rx: Col<f32>,
    pub at_ry: Col<f32>,
    pub at_rz: Col<f32>,
    pub attachments: usize,
    // Closed surfaces that keep their volume (src/volume.rs): the triangles (three particle indices each) and per body: on or
    // off, the first triangle and how many, the target volume, the spring and the multiplier; per particle, the gradient.
    pub vtri: Col<u32>,
    pub vb_on: Col<u32>,
    pub vb_first: Col<u32>,
    pub vb_count: Col<u32>,
    pub vb_target: Col<f32>,
    pub vb_omega: Col<f32>,
    pub vb_zeta: Col<f32>,
    pub vb_lambda: Col<f32>,
    pub vgx: Col<f32>,
    pub vgy: Col<f32>,
    pub vgz: Col<f32>,
    /// The exact solve of the rigid edges and attachments (src/rigid.rs).
    pub rg: crate::rigid::Rigid,
    /// Per body row: how much gravity pulls the body, so it falls through the step with the particles that hang from it.
    pub gs: Col<f32>,
    /// Per body row: 1 when the soft body dominates the body (the particle is immovable to it), else 0.
    pub dom: Col<f32>,
    /// Per body: 1 while it sleeps, its particles still and left out of the prediction.
    pub bsleep: Col<u32>,
}

fn grow<T: Copy>(v: &mut Col<T>, n: usize) {
    v.resize(n);
}

impl World {
    pub fn new() -> World {
        World::default()
    }

    /// Makes room for at least this many rows of each kind; counts say how many of them are in use.
    pub fn reserve(&mut self, particles: usize, edges: usize, bodies: usize, colliders: usize) {
        for v in [
            &mut self.x, &mut self.y, &mut self.z, &mut self.px, &mut self.py, &mut self.pz, &mut self.vx, &mut self.vy,
            &mut self.vz, &mut self.w, &mut self.radius, &mut self.tx, &mut self.ty, &mut self.tz,
        ] {
            grow(v, particles);
        }
        for v in [&mut self.rx, &mut self.ry, &mut self.rz, &mut self.slx, &mut self.sly, &mut self.slz, &mut self.sw] {
            grow(v, particles);
        }
        for v in [&mut self.b_omega, &mut self.b_zeta, &mut self.bqx, &mut self.bqy, &mut self.bqz, &mut self.bqw] {
            grow(v, bodies);
        }
        grow(&mut self.b_on, bodies);
        grow(&mut self.bsleep, bodies);
        grow(&mut self.b_first, bodies);
        grow(&mut self.b_count, bodies);
        for v in [
            &mut self.knx, &mut self.kny, &mut self.knz, &mut self.kpx, &mut self.kpy, &mut self.kpz, &mut self.kvx, &mut self.kvy,
            &mut self.kvz, &mut self.kf,
        ] {
            grow(v, particles * SLOTS);
        }
        grow(&mut self.kc, particles * SLOTS);
        for v in [&mut self.vgx, &mut self.vgy, &mut self.vgz] {
            grow(v, particles);
        }
        for v in [&mut self.vb_target, &mut self.vb_omega, &mut self.vb_zeta, &mut self.vb_lambda] {
            grow(v, bodies);
        }
        grow(&mut self.vb_on, bodies);
        grow(&mut self.vb_first, bodies);
        grow(&mut self.vb_count, bodies);
        grow(&mut self.pflags, particles);
        grow(&mut self.pbody, particles);
        for v in [&mut self.rest, &mut self.omega, &mut self.zeta, &mut self.lambda, &mut self.tear] {
            grow(v, edges);
        }
        grow(&mut self.ea, edges);
        grow(&mut self.eb, edges);
        grow(&mut self.eflags, edges);
        grow(&mut self.gravity_scale, bodies);
        grow(&mut self.linear_damping, bodies);
        grow(&mut self.c_kind, colliders);
        for v in [
            &mut self.cx, &mut self.cy, &mut self.cz, &mut self.qx, &mut self.qy, &mut self.qz, &mut self.qw, &mut self.sx,
            &mut self.sy, &mut self.sz, &mut self.friction, &mut self.lvx, &mut self.lvy, &mut self.lvz, &mut self.avx,
            &mut self.avy, &mut self.avz, &mut self.mx, &mut self.my, &mut self.mz, &mut self.jx, &mut self.jy, &mut self.jz,
            &mut self.kx, &mut self.ky, &mut self.kz, &mut self.wm, &mut self.iixx, &mut self.iixy, &mut self.iixz,
            &mut self.iiyy, &mut self.iiyz, &mut self.iizz, &mut self.gs, &mut self.dom,
        ] {
            grow(v, colliders);
        }
    }

    /// Advances every particle by `dt` seconds in `substeps` pieces of `iterations` passes each, meeting the colliders of the
    /// table. A host that finds its contacts elsewhere calls `begin`, then `substep_pre`, `apply_contacts` and `substep_post`
    /// for each piece, then `finish`.
    pub fn step(&mut self, dt: f32, substeps: u32, iterations: u32, gravity: [f32; 3]) {
        let substeps = substeps.max(1);
        let h = dt / substeps as f32;
        self.begin(dt);
        for _ in 0..substeps {
            self.substep(h, iterations.max(1), gravity);
        }
        self.finish();
    }

    /// Starts a step: clears what the bodies are owed and sends targeted particles toward their targets.
    pub fn begin(&mut self, dt: f32) {
        for c in 0..self.colliders {
            self.jx[c] = 0.0;
            self.jy[c] = 0.0;
            self.jz[c] = 0.0;
            self.kx[c] = 0.0;
            self.ky[c] = 0.0;
            self.kz[c] = 0.0;
        }
        self.torn = 0;
        // A pinned particle with a target travels to it at a steady speed over the step.
        for i in 0..self.particles {
            if self.pflags[i] & TARGETED != 0 {
                self.vx[i] = (self.tx[i] - self.x[i]) / dt;
                self.vy[i] = (self.ty[i] - self.y[i]) / dt;
                self.vz[i] = (self.tz[i] - self.z[i]) / dt;
            }
        }
    }

    /// Ends a step: targeted particles land on their targets.
    pub fn finish(&mut self) {
        for i in 0..self.particles {
            if self.pflags[i] & TARGETED != 0 {
                self.x[i] = self.tx[i];
                self.y[i] = self.ty[i];
                self.z[i] = self.tz[i];
                self.pflags[i] &= !TARGETED;
            }
        }
    }

    fn substep(&mut self, h: f32, iterations: u32, gravity: [f32; 3]) {
        self.substep_pre(h, iterations, gravity);
        for i in 0..self.particles {
            self.contact(i, h);
        }
        self.substep_post(h);
    }

    /// The first half of a piece of a step: move every particle under gravity, then solve the constraints.
    pub fn substep_pre(&mut self, h: f32, iterations: u32, gravity: [f32; 3]) {
        // A body that can move falls as the host's step will let it, so what hangs from it is held against its weight.
        for c in 0..self.colliders {
            if self.wm[c] > 0.0 {
                self.lvx[c] += h * gravity[0] * self.gs[c];
                self.lvy[c] += h * gravity[1] * self.gs[c];
                self.lvz[c] += h * gravity[2] * self.gs[c];
            }
        }
        for i in 0..self.particles {
            self.px[i] = self.x[i];
            self.py[i] = self.y[i];
            self.pz[i] = self.z[i];
            if self.bsleep[self.pbody[i] as usize] != 0 {
                // A sleeping body stays where it is.
                self.vx[i] = 0.0;
                self.vy[i] = 0.0;
                self.vz[i] = 0.0;
            } else if self.w[i] > 0.0 {
                let scale = self.gravity_scale[self.pbody[i] as usize];
                self.vx[i] += h * gravity[0] * scale;
                self.vy[i] += h * gravity[1] * scale;
                self.vz[i] += h * gravity[2] * scale;
                self.x[i] += h * self.vx[i];
                self.y[i] += h * self.vy[i];
                self.z[i] += h * self.vz[i];
            } else if self.pflags[i] & TARGETED != 0 {
                self.x[i] += h * self.vx[i];
                self.y[i] += h * self.vy[i];
                self.z[i] += h * self.vz[i];
            }
        }
        for e in 0..self.edges {
            self.lambda[e] = 0.0;
        }
        self.fem_implicit(h);
        self.shape_begin();
        self.fem_begin();
        self.volume_begin();
        self.rigid_begin(h);
        for _ in 0..iterations {
            for e in 0..self.edges {
                self.solve_edge(e, h);
            }
            self.solve_shape(h);
            self.solve_fem(h);
            self.solve_volume(h);
        }
        self.solve_rigid(h);
        self.collide(h);
    }

    /// The second half of a piece of a step, after the contacts: the bodies the particles pushed on move on, and the
    /// particles take the velocity they ended with.
    pub fn substep_post(&mut self, h: f32) {
        // A sleeping body does not move: whatever the constraints did to its particles this piece is undone.
        for i in 0..self.particles {
            if self.bsleep[self.pbody[i] as usize] != 0 {
                self.x[i] = self.px[i];
                self.y[i] = self.py[i];
                self.z[i] = self.pz[i];
            }
        }
        self.fem_end(h);
        // A body that the particles pushed on has a new velocity; it carries its collider along for the rest of the step.
        for c in 0..self.colliders {
            if self.wm[c] > 0.0 {
                self.cx[c] += self.lvx[c] * h;
                self.cy[c] += self.lvy[c] * h;
                self.cz[c] += self.lvz[c] * h;
                self.mx[c] += self.lvx[c] * h;
                self.my[c] += self.lvy[c] * h;
                self.mz[c] += self.lvz[c] * h;
            }
        }
        let inv = 1.0 / h;
        for i in 0..self.particles {
            if self.w[i] > 0.0 {
                self.vx[i] = (self.x[i] - self.px[i]) * inv;
                self.vy[i] = (self.y[i] - self.py[i]) * inv;
                self.vz[i] = (self.z[i] - self.pz[i]) * inv;
                let damp = 1.0 / (1.0 + h * self.linear_damping[self.pbody[i] as usize]);
                self.vx[i] *= damp;
                self.vy[i] *= damp;
                self.vz[i] *= damp;
            }
        }
    }

    /// One compliant distance constraint, C = |a - b| - rest (Macklin et al. 2016, with the damping of its section 4).
    fn solve_edge(&mut self, e: usize, h: f32) {
        if self.eflags[e] & TORN != 0 {
            return;
        }
        let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
        let (wa, wb) = (self.w[a], self.w[b]);
        let w = wa + wb;
        if w == 0.0 {
            return;
        }
        // A rigid edge (no natural frequency) is held by the exact solve (src/rigid.rs), together with the body links.
        if self.omega[e] == 0.0 && self.held_exactly(e) {
            return;
        }
        let dx = self.x[a] - self.x[b];
        let dy = self.y[a] - self.y[b];
        let dz = self.z[a] - self.z[b];
        let len = sqrt(dx * dx + dy * dy + dz * dz);
        if len < 1e-9 {
            return;
        }
        let rest = self.rest[e];
        let c = len - rest;
        if self.tear[e] > 0.0 && c > self.tear[e] * rest {
            self.eflags[e] |= TORN;
            self.torn += 1;
            return;
        }
        if self.eflags[e] & TENSION != 0 && c < 0.0 {
            return;
        }
        let (nx, ny, nz) = (dx / len, dy / len, dz / len);
        let omega = self.omega[e];
        let (alpha, gamma) = if omega > 0.0 {
            // alpha_tilde = w_eff / (omega h)^2 and gamma = 2 zeta / (omega h): the spring of a constraint of effective mass 1/w.
            let wh = omega * h;
            (w / (wh * wh), 2.0 * self.zeta[e] / wh)
        } else {
            (0.0, 0.0)
        };
        let rel = (self.x[a] - self.px[a] - (self.x[b] - self.px[b])) * nx
            + (self.y[a] - self.py[a] - (self.y[b] - self.py[b])) * ny
            + (self.z[a] - self.pz[a] - (self.z[b] - self.pz[b])) * nz;
        let d = ((1.0 + gamma) * w + alpha).max(1e-12);
        let dl = (-c - alpha * self.lambda[e] - gamma * rel) / d;
        self.lambda[e] += dl;
        self.x[a] += wa * dl * nx;
        self.y[a] += wa * dl * ny;
        self.z[a] += wa * dl * nz;
        self.x[b] -= wb * dl * nx;
        self.y[b] -= wb * dl * ny;
        self.z[b] -= wb * dl * nz;
    }

    /// Pushes a particle out of every collider of the table it sits in.
    fn contact(&mut self, i: usize, h: f32) {
        if self.w[i] <= 0.0 {
            return;
        }
        for c in 0..self.colliders {
            let (d, nx, ny, nz) = self.distance(c, self.x[i], self.y[i], self.z[i]);
            let gap = d - self.radius[i];
            if gap >= 0.0 {
                continue;
            }
            let friction = self.friction[c];
            // The surface moves as the body does: its velocity plus its spin about the point.
            let (rx, ry, rz) = (self.x[i] - self.mx[c], self.y[i] - self.my[c], self.z[i] - self.mz[c]);
            let surface = [
                self.lvx[c] + self.avy[c] * rz - self.avz[c] * ry,
                self.lvy[c] + self.avz[c] * rx - self.avx[c] * rz,
                self.lvz[c] + self.avx[c] * ry - self.avy[c] * rx,
            ];
            self.resolve(i, c, [nx, ny, nz], -gap, surface, friction, h);
        }
    }

    /// Keeps every particle on the outer side of the planes it holds (`kc` to `kf`), each plane's point carried along its
    /// velocity for `tau` seconds since the start of the step: the host found them once for the step with its own query.
    pub fn apply_contacts(&mut self, h: f32, tau: f32) {
        for i in 0..self.particles {
            if self.w[i] <= 0.0 {
                continue;
            }
            for s in 0..SLOTS {
                let k = i * SLOTS + s;
                let c = self.kc[k];
                if c == NONE {
                    continue;
                }
                let n = [self.knx[k], self.kny[k], self.knz[k]];
                let v = [self.kvx[k], self.kvy[k], self.kvz[k]];
                let p = [self.kpx[k] + v[0] * tau, self.kpy[k] + v[1] * tau, self.kpz[k] + v[2] * tau];
                let d = (self.x[i] - p[0]) * n[0] + (self.y[i] - p[1]) * n[1] + (self.z[i] - p[2]) * n[2] - self.radius[i];
                if d < 0.0 {
                    let friction = self.kf[k];
                    self.resolve(i, (c - 1) as usize, n, -d, v, friction, h);
                }
            }
        }
    }

    /// Pushes particle `i` out of the surface of body row `c` by `push` along the unit normal `n`, with friction, and gives
    /// the body what that cost.
    fn resolve(&mut self, i: usize, c: usize, n: [f32; 3], push: f32, surface: [f32; 3], friction: f32, h: f32) {
        let m = 1.0 / self.w[i];
        let (nx, ny, nz) = (n[0], n[1], n[2]);
        // The contact point, from the body's centre of mass, and how easily the body gives way there along the normal:
        // the particle takes the share of the correction its inverse mass leaves it (Macklin et al. 2014, section 4).
        let (qx, qy, qz) = (
            self.x[i] - self.mx[c] - nx * self.radius[i],
            self.y[i] - self.my[c] - ny * self.radius[i],
            self.z[i] - self.mz[c] - nz * self.radius[i],
        );
        let (ax, ay, az) = (qy * nz - qz * ny, qz * nx - qx * nz, qx * ny - qy * nx);
        let (ix, iy, iz) = self.inverse_inertia(c, ax, ay, az);
        let wb = self.wm[c] + ax * ix + ay * iy + az * iz;
        if self.dom[c] > 0.0 {
            // The soft body dominates this body: the particle does not give way, and the body takes the whole correction at the
            // contact point, as an impulse that moves it by `push` there.
            if wb > 0.0 {
                let s = push / (wb * h);
                self.apply_to_body(c, [-nx * s, -ny * s, -nz * s], [qx, qy, qz]);
            }
            return;
        }
        let share = self.w[i] / (self.w[i] + wb);
        self.x[i] += nx * push * share;
        self.y[i] += ny * push * share;
        self.z[i] += nz * push * share;
        // Friction as a bounded displacement across the surface (Macklin et al. 2014, "Unified Particle Physics").
        let (sx, sy, sz) = (surface[0], surface[1], surface[2]);
        let mut ux = self.x[i] - self.px[i] - sx * h;
        let mut uy = self.y[i] - self.py[i] - sy * h;
        let mut uz = self.z[i] - self.pz[i] - sz * h;
        let un = ux * nx + uy * ny + uz * nz;
        ux -= nx * un;
        uy -= ny * un;
        uz -= nz * un;
        let tl = sqrt(ux * ux + uy * uy + uz * uz);
        let (mut fx, mut fy, mut fz) = (0.0, 0.0, 0.0);
        if tl > 1e-12 {
            let limit = friction * push;
            let k = if tl < limit { 1.0 } else { limit / tl };
            fx = -ux * k;
            fy = -uy * k;
            fz = -uz * k;
            self.x[i] += fx * share;
            self.y[i] += fy * share;
            self.z[i] += fz * share;
        }
        // The body takes the opposite impulse, at the particle's surface point, and moves on with it.
        let s = share * m / h;
        let (jx, jy, jz) = (-(nx * push + fx) * s, -(ny * push + fy) * s, -(nz * push + fz) * s);
        self.jx[c] += jx;
        self.jy[c] += jy;
        self.jz[c] += jz;
        let (kx, ky, kz) = (qy * jz - qz * jy, qz * jx - qx * jz, qx * jy - qy * jx);
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

    /// Gives body row `c` an impulse `j` at the point `q` from its centre of mass, and moves its velocities on.
    pub(crate) fn apply_to_body(&mut self, c: usize, j: [f32; 3], q: [f32; 3]) {
        self.jx[c] += j[0];
        self.jy[c] += j[1];
        self.jz[c] += j[2];
        let (kx, ky, kz) = (q[1] * j[2] - q[2] * j[1], q[2] * j[0] - q[0] * j[2], q[0] * j[1] - q[1] * j[0]);
        self.kx[c] += kx;
        self.ky[c] += ky;
        self.kz[c] += kz;
        if self.wm[c] > 0.0 {
            self.lvx[c] += j[0] * self.wm[c];
            self.lvy[c] += j[1] * self.wm[c];
            self.lvz[c] += j[2] * self.wm[c];
            let (wx, wy, wz) = self.inverse_inertia(c, kx, ky, kz);
            self.avx[c] += wx;
            self.avy[c] += wy;
            self.avz[c] += wz;
        }
    }

    /// A body's world inverse inertia applied to a vector.
    pub(crate) fn inverse_inertia(&self, c: usize, x: f32, y: f32, z: f32) -> (f32, f32, f32) {
        (
            self.iixx[c] * x + self.iixy[c] * y + self.iixz[c] * z,
            self.iixy[c] * x + self.iiyy[c] * y + self.iiyz[c] * z,
            self.iixz[c] * x + self.iiyz[c] * y + self.iizz[c] * z,
        )
    }

    /// Signed distance from a point to a collider's surface, and the outward normal there.
    fn distance(&self, c: usize, x: f32, y: f32, z: f32) -> (f32, f32, f32, f32) {
        let q = [self.qx[c], self.qy[c], self.qz[c], self.qw[c]];
        let (dx, dy, dz) = (x - self.cx[c], y - self.cy[c], z - self.cz[c]);
        match self.c_kind[c] {
            HALF_SPACE => {
                let (nx, ny, nz) = rotate(q, self.sx[c], self.sy[c], self.sz[c]);
                (nx * dx + ny * dy + nz * dz, nx, ny, nz)
            }
            SPHERE => {
                let len = sqrt(dx * dx + dy * dy + dz * dz);
                if len < 1e-9 { (-self.sx[c], 0.0, 1.0, 0.0) } else { (len - self.sx[c], dx / len, dy / len, dz / len) }
            }
            CAPSULE => {
                let (lx, ly, lz) = rotate(conj(q), dx, dy, dz);
                let hh = self.sy[c];
                let near = if ly > hh { hh } else if ly < -hh { -hh } else { ly };
                let (ax, ay, az) = (lx, ly - near, lz);
                let len = sqrt(ax * ax + ay * ay + az * az);
                let (nx, ny, nz) = if len < 1e-9 { (1.0, 0.0, 0.0) } else { (ax / len, ay / len, az / len) };
                let (wx, wy, wz) = rotate(q, nx, ny, nz);
                (len - self.sx[c], wx, wy, wz)
            }
            _ => {
                let (lx, ly, lz) = rotate(conj(q), dx, dy, dz);
                let (hx, hy, hz) = (self.sx[c], self.sy[c], self.sz[c]);
                let (qx, qy, qz) = (abs(lx) - hx, abs(ly) - hy, abs(lz) - hz);
                let (ox, oy, oz) = (qx.max(0.0), qy.max(0.0), qz.max(0.0));
                let out = sqrt(ox * ox + oy * oy + oz * oz);
                let (nx, ny, nz, dist) = if out > 1e-9 {
                    (ox * sign(lx) / out, oy * sign(ly) / out, oz * sign(lz) / out, out)
                } else if qx >= qy && qx >= qz {
                    (sign(lx), 0.0, 0.0, qx)
                } else if qy >= qz {
                    (0.0, sign(ly), 0.0, qy)
                } else {
                    (0.0, 0.0, sign(lz), qz)
                };
                let (wx, wy, wz) = rotate(q, nx, ny, nz);
                (dist, wx, wy, wz)
            }
        }
    }

    /// A hash of every position's bits, equal wherever a step is.
    pub fn hash(&self) -> u32 {
        let mut h: u32 = 0x811c_9dc5;
        for i in 0..self.particles {
            for v in [self.x[i], self.y[i], self.z[i]] {
                h = (h ^ v.to_bits()).wrapping_mul(0x0100_0193);
            }
        }
        h
    }
}

fn conj(q: [f32; 4]) -> [f32; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

fn rotate(q: [f32; 4], x: f32, y: f32, z: f32) -> (f32, f32, f32) {
    let (qx, qy, qz, qw) = (q[0], q[1], q[2], q[3]);
    let tx = 2.0 * (qy * z - qz * y);
    let ty = 2.0 * (qz * x - qx * z);
    let tz = 2.0 * (qx * y - qy * x);
    (x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx))
}
