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
/// The most a piece of a step may turn a body, in radians (the turn is linearised).
pub const MAX_TURN: f32 = 0.1;
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
    /// Per body row: where its centre of mass and its velocity were when the step began, so a plane found at the step's start
    /// follows the body (gravity, the corrections of earlier pieces) as the body moves.
    pub m0x: Col<f32>,
    pub m0y: Col<f32>,
    pub m0z: Col<f32>,
    pub l0x: Col<f32>,
    pub l0y: Col<f32>,
    pub l0z: Col<f32>,
    /// Per body row: how far this piece of the step's contacts have moved it (a translation of its centre and a small turn
    /// about it), so the next contact meets the body where the last one left it (Gauss-Seidel over a body's contacts, as in
    /// Mueller, Macklin, Chentanez, Jeschke and Kim 2020). The velocity change is this over the piece.
    /// Per body row: its angular velocity when the step began.
    pub a0x: Col<f32>,
    pub a0y: Col<f32>,
    pub a0z: Col<f32>,
    /// Per particle slot: the normal impulse this piece's corrections gave its contact, which bounds the friction impulse.
    pub kj: Col<f32>,
    /// How far into the step the last passes of contacts stood, for the velocity pass that follows.
    pub tau_end: f32,
    pub dmx: Col<f32>,
    pub dmy: Col<f32>,
    pub dmz: Col<f32>,
    pub thx: Col<f32>,
    pub thy: Col<f32>,
    pub thz: Col<f32>,
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
        grow(&mut self.kj, particles * SLOTS);
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
            &mut self.iiyy, &mut self.iiyz, &mut self.iizz, &mut self.gs, &mut self.dom, &mut self.m0x, &mut self.m0y, &mut self.m0z, &mut self.l0x, &mut self.l0y, &mut self.l0z, &mut self.a0x, &mut self.a0y, &mut self.a0z, &mut self.dmx, &mut self.dmy, &mut self.dmz, &mut self.thx, &mut self.thy, &mut self.thz,
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
        // Every body row moves on, by its velocity and by what the contacts of this piece moved it (a kinematic one by its velocity
        // alone), and takes the velocity that pose change implies (Mueller et al. 2020, section 3.4).
        let inv_h = 1.0 / h;
        for c in 0..self.colliders {
            self.mx[c] += self.lvx[c] * h + self.dmx[c];
            self.my[c] += self.lvy[c] * h + self.dmy[c];
            self.mz[c] += self.lvz[c] * h + self.dmz[c];
            self.lvx[c] += self.dmx[c] * inv_h;
            self.lvy[c] += self.dmy[c] * inv_h;
            self.lvz[c] += self.dmz[c] * inv_h;
            self.avx[c] += self.thx[c] * inv_h;
            self.avy[c] += self.thy[c] * inv_h;
            self.avz[c] += self.thz[c] * inv_h;
            self.dmx[c] = 0.0;
            self.dmy[c] = 0.0;
            self.dmz[c] = 0.0;
            self.thx[c] = 0.0;
            self.thy[c] = 0.0;
            self.thz[c] = 0.0;
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
        self.contact_velocities();
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
            let mp = [self.mx[c], self.my[c], self.mz[c]];
            self.resolve(i, c, [nx, ny, nz], -gap, surface, friction, h, mp, usize::MAX);
        }
    }

    /// Keeps every particle on the outer side of the planes it holds (`kc` to `kf`), each plane's point carried along its
    /// velocity for `tau` seconds since the start of the step: the host found them once for the step with its own query.
    pub fn apply_contacts(&mut self, h: f32, tau: f32) {
        self.tau_end = tau;
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
                let c = (c - 1) as usize;
                let v = [self.kvx[k], self.kvy[k], self.kvz[k]];
                let carried = [self.mx[c] + self.lvx[c] * h, self.my[c] + self.lvy[c] * h, self.mz[c] + self.lvz[c] * h];
                let dm = [self.dmx[c], self.dmy[c], self.dmz[c]];
                let (p, n) = self.plane_at(k, c, tau, carried, dm, [self.thx[c], self.thy[c], self.thz[c]]);
                let mp = [carried[0] + dm[0], carried[1] + dm[1], carried[2] + dm[2]];
                let d = (self.x[i] - p[0]) * n[0] + (self.y[i] - p[1]) * n[1] + (self.z[i] - p[2]) * n[2] - self.radius[i];
                if d < 0.0 {
                    let friction = self.kf[k];
                    self.resolve(i, c, n, -d, v, friction, h, mp, k);
                }
            }
        }
    }

    /// The plane of slot `k` of body row `c` at `tau` seconds into the step, for a body whose centre is at `carried` moved by `dm` and
    /// turned by `th` (a small angle) about it: the point on it and the unit normal.
    fn plane_at(&self, k: usize, c: usize, tau: f32, carried: [f32; 3], dm: [f32; 3], th: [f32; 3]) -> ([f32; 3], [f32; 3]) {
        let n0 = [self.knx[k], self.kny[k], self.knz[k]];
        let v = [self.kvx[k], self.kvy[k], self.kvz[k]];
        // The plane was found at the step's start; it follows the body's own motion since, and the rest of the surface's speed (a
        // spin, a deforming mesh); then it moves and turns with the corrections made to the body about its centre.
        let nominal = [
            self.kpx[k] + (v[0] - self.l0x[c]) * tau + (carried[0] - self.m0x[c]),
            self.kpy[k] + (v[1] - self.l0y[c]) * tau + (carried[1] - self.m0y[c]),
            self.kpz[k] + (v[2] - self.l0z[c]) * tau + (carried[2] - self.m0z[c]),
        ];
        let r = [nominal[0] - carried[0], nominal[1] - carried[1], nominal[2] - carried[2]];
        let turn = |a: [f32; 3]| [th[1] * a[2] - th[2] * a[1], th[2] * a[0] - th[0] * a[2], th[0] * a[1] - th[1] * a[0]];
        let (dr, dn) = (turn(r), turn(n0));
        let p = [nominal[0] + dm[0] + dr[0], nominal[1] + dm[1] + dr[1], nominal[2] + dm[2] + dr[2]];
        let mut n = [n0[0] + dn[0], n0[1] + dn[1], n0[2] + dn[2]];
        let len = sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        if len > 1e-9 {
            n = [n[0] / len, n[1] / len, n[2] / len];
        }
        (p, n)
    }

    /// After a piece, the speeds of the particles and the bodies they touch: a contact does not leave them separating faster than
    /// they met (the pop a position correction would leave is taken out, as an inelastic contact does) and holds back what
    /// Coulomb friction allows, with the same impulse given to the body (Macklin et al. 2014, section 4; Mueller et al. 2020,
    /// section 3.5, who solve the velocities of contacts after their positions).
    fn contact_velocities(&mut self) {
        let tau = self.tau_end;
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
                let c = (c - 1) as usize;
                // A body the soft body dominates meets particles that do not give way: for it the particle has no inverse mass.
                let wp = if self.dom[c] > 0.0 { 0.0 } else { self.w[i] };
                let carried = [self.mx[c], self.my[c], self.mz[c]];
                let (p, n) = self.plane_at(k, c, tau, carried, [0.0; 3], [0.0; 3]);
                let d = (self.x[i] - p[0]) * n[0] + (self.y[i] - p[1]) * n[1] + (self.z[i] - p[2]) * n[2] - self.radius[i];
                if d > 0.002 {
                    continue;
                }
                let q = [
                    self.x[i] - n[0] * self.radius[i] - carried[0],
                    self.y[i] - n[1] * self.radius[i] - carried[1],
                    self.z[i] - n[2] * self.radius[i] - carried[2],
                ];
                // The body's velocity at the contact: its own, the turn it has taken since the step began, and what the surface does
                // besides (a spin from before, a deforming mesh).
                let da = [self.avx[c] - self.a0x[c], self.avy[c] - self.a0y[c], self.avz[c] - self.a0z[c]];
                let vb = [
                    self.lvx[c] + da[1] * q[2] - da[2] * q[1] + self.kvx[k] - self.l0x[c],
                    self.lvy[c] + da[2] * q[0] - da[0] * q[2] + self.kvy[k] - self.l0y[c],
                    self.lvz[c] + da[0] * q[1] - da[1] * q[0] + self.kvz[k] - self.l0z[c],
                ];
                let rel = [self.vx[i] - vb[0], self.vy[i] - vb[1], self.vz[i] - vb[2]];
                let vn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
                let a = [q[1] * n[2] - q[2] * n[1], q[2] * n[0] - q[0] * n[2], q[0] * n[1] - q[1] * n[0]];
                let (ix, iy, iz) = self.inverse_inertia(c, a[0], a[1], a[2]);
                let wb = self.wm[c] + a[0] * ix + a[1] * iy + a[2] * iz;
                let denominator = wp + wb;
                if denominator <= 0.0 {
                    continue;
                }
                // The contact is inelastic: whatever the relative speed along the normal (closing or separating) is taken out.
                let jn = vn / denominator;
                let (tx, ty, tz) = (rel[0] - n[0] * vn, rel[1] - n[1] * vn, rel[2] - n[2] * vn);
                let tl = sqrt(tx * tx + ty * ty + tz * tz);
                let mut jt = 0.0;
                let t = if tl > 1e-9 { [tx / tl, ty / tl, tz / tl] } else { [0.0; 3] };
                if tl > 1e-9 {
                    // How easily the body gives way along the sliding direction, which its spin changes as much as its mass.
                    let at = [q[1] * t[2] - q[2] * t[1], q[2] * t[0] - q[0] * t[2], q[0] * t[1] - q[1] * t[0]];
                    let (jx, jy, jz) = self.inverse_inertia(c, at[0], at[1], at[2]);
                    let wt = wp + self.wm[c] + at[0] * jx + at[1] * jy + at[2] * jz;
                    let limit = self.kf[k] * ((if jn < 0.0 { -jn } else { jn }) + self.kj[k]);
                    let want = if wt > 0.0 { tl / wt } else { 0.0 };
                    jt = if want < limit { want } else { limit };
                }
                let j = [n[0] * jn + t[0] * jt, n[1] * jn + t[1] * jt, n[2] * jn + t[2] * jt];
                self.vx[i] -= wp * j[0];
                self.vy[i] -= wp * j[1];
                self.vz[i] -= wp * j[2];
                // The body takes the same impulse the other way round.
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
        }
        for k in 0..self.particles * SLOTS {
            self.kj[k] = 0.0;
        }
    }

    /// Pushes particle `i` out of the surface of body row `c` by `push` along the unit normal `n`, with friction, and gives
    /// the body what that cost.
    fn resolve(&mut self, i: usize, c: usize, n: [f32; 3], push: f32, surface: [f32; 3], friction: f32, h: f32, mp: [f32; 3], slot: usize) {
        let m = 1.0 / self.w[i];
        let (nx, ny, nz) = (n[0], n[1], n[2]);
        // The contact point, from the body's centre of mass, and how easily the body gives way there along the normal:
        // the particle takes the share of the correction its inverse mass leaves it (Macklin et al. 2014, section 4).
        let (qx, qy, qz) = (
            self.x[i] - mp[0] - nx * self.radius[i],
            self.y[i] - mp[1] - ny * self.radius[i],
            self.z[i] - mp[2] - nz * self.radius[i],
        );
        let (ax, ay, az) = (qy * nz - qz * ny, qz * nx - qx * nz, qx * ny - qy * nx);
        let (ix, iy, iz) = self.inverse_inertia(c, ax, ay, az);
        let wb = self.wm[c] + ax * ix + ay * iy + az * iz;
        if self.dom[c] > 0.0 {
            // The soft body dominates this body: the particle does not give way, and the body takes the whole correction at the
            // contact point.
            if wb > 0.0 {
                let lambda = push / wb;
                self.correct_body(c, [-nx * lambda, -ny * lambda, -nz * lambda], [qx, qy, qz], h);
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
        // The body takes the opposite correction, shared by inverse mass at the contact point, and moves on with it.
        // (The friction's reaction is a velocity impulse, given after the piece: see `contact_velocities`.)
        let lambda = m * share;
        self.correct_body(c, [-nx * push * lambda, -ny * push * lambda, -nz * push * lambda], [qx, qy, qz], h);
        if slot != usize::MAX {
            self.kj[slot] += push * lambda / h;
        }
    }

    /// Moves body row `c` by the position-level multiplier `lambda` (the reaction of a correction, a displacement times mass) at
    /// the point `q` from its centre of mass: its centre by `wm * lambda` and a turn of `I^-1 (q x lambda)`, which the next
    /// contact of the piece meets; the host gives the real body `lambda / h` as an impulse.
    pub(crate) fn correct_body(&mut self, c: usize, lambda: [f32; 3], q: [f32; 3], h: f32) {
        let inv = 1.0 / h;
        let moment = [q[1] * lambda[2] - q[2] * lambda[1], q[2] * lambda[0] - q[0] * lambda[2], q[0] * lambda[1] - q[1] * lambda[0]];
        let mut scale = 1.0f32;
        let (mut wx, mut wy, mut wz) = (0.0, 0.0, 0.0);
        if self.wm[c] > 0.0 {
            (wx, wy, wz) = self.inverse_inertia(c, moment[0], moment[1], moment[2]);
            // The turn is linearised, so a piece of a step may turn a body by a tenth of a radian and no more; the part of a
            // correction past that is left for the next piece or pass (the particle still holds its share), and the body, the
            // velocity it takes and the impulse the host gives all follow the part that was made.
            let (tx, ty, tz) = (self.thx[c] + wx, self.thy[c] + wy, self.thz[c] + wz);
            let (now, total, step) = (
                sqrt(self.thx[c] * self.thx[c] + self.thy[c] * self.thy[c] + self.thz[c] * self.thz[c]),
                sqrt(tx * tx + ty * ty + tz * tz),
                sqrt(wx * wx + wy * wy + wz * wz),
            );
            if total > MAX_TURN && step > 0.0 {
                let room = MAX_TURN - now;
                scale = if room <= 0.0 { 0.0 } else if room >= step { 1.0 } else { room / step };
            }
        }
        self.jx[c] += lambda[0] * inv * scale;
        self.jy[c] += lambda[1] * inv * scale;
        self.jz[c] += lambda[2] * inv * scale;
        self.kx[c] += moment[0] * inv * scale;
        self.ky[c] += moment[1] * inv * scale;
        self.kz[c] += moment[2] * inv * scale;
        if self.wm[c] > 0.0 {
            self.dmx[c] += lambda[0] * self.wm[c] * scale;
            self.dmy[c] += lambda[1] * self.wm[c] * scale;
            self.dmz[c] += lambda[2] * self.wm[c] * scale;
            self.thx[c] += wx * scale;
            self.thy[c] += wy * scale;
            self.thz[c] += wz * scale;
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
