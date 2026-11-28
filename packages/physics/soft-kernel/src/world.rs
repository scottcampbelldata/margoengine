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
/// An edge of a sheet: a woven sheet's warp or weft thread, or an edge of a triangle mesh. Rigid, it is held by the exact
/// solve with the sheet's other edges, loops and all (`rigid.rs`), as inextensible cloth is (Goldenthal et al. 2007): a grid
/// of threads, or a triangulated surface, has no redundant edge, so the solve can hold every one.
pub const SHEET: u32 = 4;
/// An edge whose `omega` holds a spring stiffness in N/m, not a natural frequency: its compliance is 1/k whatever its
/// particles weigh (a fabric's shear rigidity, which a pinned corner must not stiffen), and `zeta` its damping ratio.
pub const STIFFNESS: u32 = 8;
/// An edge of a sheet on the vertex-block solver (cloth_block.rs): a spring of the block solve, not swept or held exactly.
pub const BLOCK: u32 = 16;
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
    /// The strain an edge of a sheet is held to beyond its spring (0: none): a fabric thread's strain at the end of its measured
    /// range, past which the solve holds it rigid (`rigid.rs`).
    pub elimit: Col<f32>,
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
    /// Per particle slot: the collider's radius of curvature at the plane's point (0 on a flat face or a corner): the contact is
    /// the point a radius along the normal from a centre fixed in the body, so a round body's contact stays under it as it turns.
    pub kr: Col<f32>,
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
    /// External pressure in Pa when `vb_on` is 2 (a gas chamber). `vb_target` is then nRT in Pa m³.
    pub vb_ambient: Col<f32>,
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
    /// Per body row: 1 when the body's surface is a mesh that follows particles of this world (a soft body's surface or
    /// deformable collider), else 0. A contact with it is one soft body against another, which the contact passes take
    /// (rigid.rs).
    pub bmesh: Col<f32>,
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
    /// Per body row: its angular velocity when the step began.
    pub a0x: Col<f32>,
    pub a0y: Col<f32>,
    pub a0z: Col<f32>,
    /// Per particle slot: the normal impulse this piece's corrections gave its contact, which bounds the friction impulse.
    pub kj: Col<f32>,
    /// How far into the step the last passes of contacts stood, for the velocity pass that follows.
    pub tau_end: f32,
    /// The pieces this step has begun: the solve's time into the step is the piece's length times this.
    pub pieces: u32,
    /// Per body row: how far this piece of the step's contacts have moved it, a translation of its centre (`dm`) and a turn
    /// about it (the unit quaternion `tq`, x, y, z, w), so the next contact meets the body where the last one left it
    /// (Gauss-Seidel over a body's contacts, as in Mueller, Macklin, Chentanez, Jeschke and Kim 2020). The velocity change is
    /// this over the piece.
    pub dmx: Col<f32>,
    pub dmy: Col<f32>,
    pub dmz: Col<f32>,
    pub tqx: Col<f32>,
    pub tqy: Col<f32>,
    pub tqz: Col<f32>,
    pub tqw: Col<f32>,
    /// Per body row: how far it has turned since the step began, the sum of its turn over each piece (a rotation vector), so the
    /// host can give the body the motion the step gave it (see `SoftBodies.beforeStep`).
    pub rox: Col<f32>,
    pub roy: Col<f32>,
    pub roz: Col<f32>,
    /// Per body row: its turn since the step began as a unit quaternion (x, y, z, w), each piece composed with the turn its
    /// angular velocity makes over the piece as the rigid world turns a body (`q <- q + 1/2 [w h, 0] q`, made unit again), so a
    /// plane found on a spinning body at the step's start turns with it.
    pub rqx: Col<f32>,
    pub rqy: Col<f32>,
    pub rqz: Col<f32>,
    pub rqw: Col<f32>,
    /// Per body row: the turn the contacts meet it at now (unit quaternion): through a piece's contacts its turn since the step
    /// began carried on over the piece, after it the turn it ended with. The planes' points and the inertia both go by it.
    pub sqx: Col<f32>,
    pub sqy: Col<f32>,
    pub sqz: Col<f32>,
    pub sqw: Col<f32>,
    /// The faces of the soft bodies the host found touching a body this step (src/face.rs): per contact, the triangle's three
    /// particles and their weights at the point facing the body, the body row of the contacts table plus one, the plane (normal
    /// out of the body, the point on it at the step's start, the surface's velocity there), the friction coefficient, the sheet's
    /// thickness, the normal impulse the piece's corrections gave it and the body's radius of curvature there.
    pub fc_a: Col<u32>,
    pub fc_b: Col<u32>,
    pub fc_c: Col<u32>,
    pub fc_wa: Col<f32>,
    pub fc_wb: Col<f32>,
    pub fc_wc: Col<f32>,
    pub fc_row: Col<u32>,
    pub fc_nx: Col<f32>,
    pub fc_ny: Col<f32>,
    pub fc_nz: Col<f32>,
    pub fc_px: Col<f32>,
    pub fc_py: Col<f32>,
    pub fc_pz: Col<f32>,
    pub fc_vx: Col<f32>,
    pub fc_vy: Col<f32>,
    pub fc_vz: Col<f32>,
    pub fc_f: Col<f32>,
    pub fc_r: Col<f32>,
    pub fc_j: Col<f32>,
    /// The collider's radius of curvature at each face contact's point, as `kr` is for a particle's.
    pub fc_k: Col<f32>,
    /// Which way each face contact's triangle normal points out of a round body this step, +1 or -1 on the triangle's own normal
    /// (the order of its corners), or 0 to go by the normal found; set from the step's start by `face_sides` (not a column the
    /// host writes).
    pub fc_side: Col<f32>,
    pub faces: usize,
    // Long range attachments (src/tether.rs): a particle, the pinned particle it is tied to, and the most it may stand from it.
    pub tt_p: Col<u32>,
    pub tt_a: Col<u32>,
    pub tt_len: Col<f32>,
    pub tethers: usize,
    // Skinned particles (skin.rs): the particle, its skinned point and that point's speed over the step, the skin's normal there,
    // the max distance and the backstop (below 0: none).
    pub sk_p: Col<u32>,
    pub sk_x: Col<f32>,
    pub sk_y: Col<f32>,
    pub sk_z: Col<f32>,
    pub sk_vx: Col<f32>,
    pub sk_vy: Col<f32>,
    pub sk_vz: Col<f32>,
    pub sk_nx: Col<f32>,
    pub sk_ny: Col<f32>,
    pub sk_nz: Col<f32>,
    pub sk_max: Col<f32>,
    pub sk_back: Col<f32>,
    pub skins: usize,
    /// Each particle's first block edge slot, and the next slot (cloth_block.rs); scratch, built for each piece.
    pub cb_head: Col<u32>,
    pub cb_next: Col<u32>,
    /// A block-solved particle's velocity at the start of the last piece, before gravity (cloth_block.rs): its acceleration
    /// decides how much of gravity the next piece's first guess takes.
    /// Each particle's acceleration from the forces put on it for the step (`addForce`, `addParticleForce`), in m/s^2: taken
    /// with gravity at the start of every piece, so a steady force is steady through the pieces and the solves see its load.
    pub ax: Col<f32>,
    pub ay: Col<f32>,
    pub az: Col<f32>,
    /// Per body row: whether a pass of this piece held one of its particles off a still body (`hold_still_contacts`).
    pub pressed: Col<u32>,
    /// A vertex-block tetrahedron particle's velocity at the start of the last piece, before its accelerations (vertex_block.rs):
    /// how far it was then accelerating along them decides how much of them the next piece's first guess takes.
    pub vbx: Col<f32>,
    pub vby: Col<f32>,
    pub vbz: Col<f32>,
    pub cbx: Col<f32>,
    pub cby: Col<f32>,
    pub cbz: Col<f32>,
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
        for v in [&mut self.vbx, &mut self.vby, &mut self.vbz] {
            grow(v, particles);
        }
        for v in [&mut self.ax, &mut self.ay, &mut self.az] {
            grow(v, particles);
        }
        for v in [&mut self.cbx, &mut self.cby, &mut self.cbz] {
            grow(v, particles);
        }
        for v in [&mut self.b_omega, &mut self.b_zeta, &mut self.bqx, &mut self.bqy, &mut self.bqz, &mut self.bqw] {
            grow(v, bodies);
        }
        grow(&mut self.b_on, bodies);
        grow(&mut self.bsleep, bodies);
        grow(&mut self.pressed, bodies);
        grow(&mut self.b_first, bodies);
        grow(&mut self.b_count, bodies);
        for v in [
            &mut self.knx, &mut self.kny, &mut self.knz, &mut self.kpx, &mut self.kpy, &mut self.kpz, &mut self.kvx, &mut self.kvy,
            &mut self.kvz, &mut self.kf, &mut self.kr,
        ] {
            grow(v, particles * SLOTS);
        }
        grow(&mut self.kc, particles * SLOTS);
        grow(&mut self.kj, particles * SLOTS);
        for v in [&mut self.vgx, &mut self.vgy, &mut self.vgz] {
            grow(v, particles);
        }
        for v in [&mut self.vb_target, &mut self.vb_ambient, &mut self.vb_omega, &mut self.vb_zeta, &mut self.vb_lambda] {
            grow(v, bodies);
        }
        grow(&mut self.vb_on, bodies);
        grow(&mut self.vb_first, bodies);
        grow(&mut self.vb_count, bodies);
        grow(&mut self.pflags, particles);
        grow(&mut self.pbody, particles);
        grow(&mut self.fem.vertex_block.head, particles);
        for v in [&mut self.rest, &mut self.omega, &mut self.zeta, &mut self.lambda, &mut self.tear, &mut self.elimit] {
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
            &mut self.iiyy, &mut self.iiyz, &mut self.iizz, &mut self.gs, &mut self.dom, &mut self.bmesh, &mut self.m0x, &mut self.m0y, &mut self.m0z, &mut self.l0x, &mut self.l0y, &mut self.l0z, &mut self.a0x, &mut self.a0y, &mut self.a0z, &mut self.dmx, &mut self.dmy, &mut self.dmz, &mut self.tqx, &mut self.tqy, &mut self.tqz, &mut self.tqw, &mut self.rox, &mut self.roy, &mut self.roz, &mut self.rqx, &mut self.rqy, &mut self.rqz, &mut self.rqw, &mut self.sqx, &mut self.sqy, &mut self.sqz, &mut self.sqw,
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
            self.rox[c] = 0.0;
            self.roy[c] = 0.0;
            self.roz[c] = 0.0;
            self.rqx[c] = 0.0;
            self.rqy[c] = 0.0;
            self.rqz[c] = 0.0;
            self.rqw[c] = 1.0;
            self.sqx[c] = 0.0;
            self.sqy[c] = 0.0;
            self.sqz[c] = 0.0;
            self.sqw[c] = 1.0;
            self.clear_correction(c);
        }
        self.torn = 0;
        self.pieces = 0;
        self.face_sides();
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
                self.vx[i] += h * (gravity[0] * scale + self.ax[i]);
                self.vy[i] += h * (gravity[1] * scale + self.ay[i]);
                self.vz[i] += h * (gravity[2] * scale + self.az[i]);
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
        self.advance_skin(h);
        self.fem_implicit(h, gravity);
        self.solve_projective(h, iterations);
        let vertex_block = self.prepare_vertex_blocks(h, gravity);
        let cloth_block = self.prepare_cloth_blocks(h, gravity);
        self.shape_begin();
        self.fem_begin();
        self.volume_begin();
        self.rigid_begin(h);
        for _ in 0..iterations {
            for e in 0..self.edges {
                self.solve_edge(e, h);
            }
            if cloth_block {
                self.solve_cloth_blocks(h);
            }
            self.solve_tethers();
            self.solve_skin();
            self.solve_shape(h);
            self.solve_fem(h);
            self.hold_constraint_cells(h);
            if vertex_block {
                self.solve_vertex_blocks(h);
            }
            self.solve_volume(h);
        }
        if vertex_block {
            self.solve_vertex_block_translation(h);
        }
        if cloth_block {
            self.limit_cloth_blocks();
        }
        self.solve_rigid(h);
        // The exact solve of the threads may pull a skinned particle past its limits; the skin has the last word before contacts.
        self.solve_skin();
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
        // alone), and takes the velocity that pose change implies: the change of its centre over the piece, and twice the vector
        // part of its turn over the piece, the shorter way round (Mueller et al. 2020, section 3.4 and algorithm 2).
        let inv_h = 1.0 / h;
        for c in 0..self.colliders {
            self.mx[c] += self.lvx[c] * h + self.dmx[c];
            self.my[c] += self.lvy[c] * h + self.dmy[c];
            self.mz[c] += self.lvz[c] * h + self.dmz[c];
            self.lvx[c] += self.dmx[c] * inv_h;
            self.lvy[c] += self.dmy[c] * inv_h;
            self.lvz[c] += self.dmz[c] * inv_h;
            let way = if self.tqw[c] < 0.0 { -2.0 * inv_h } else { 2.0 * inv_h };
            self.avx[c] += self.tqx[c] * way;
            self.avy[c] += self.tqy[c] * way;
            self.avz[c] += self.tqz[c] * way;
            // The body turns through the piece at the speed it ends with, as its centre moves (semi-implicit Euler).
            self.rox[c] += self.avx[c] * h;
            self.roy[c] += self.avy[c] * h;
            self.roz[c] += self.avz[c] * h;
            let spun = self.spun(c, h);
            (self.rqx[c], self.rqy[c], self.rqz[c], self.rqw[c]) = (spun[0], spun[1], spun[2], spun[3]);
            (self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]) = (spun[0], spun[1], spun[2], spun[3]);
            self.clear_correction(c);
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
        self.thread_damping(h);
        self.contact_velocities();
    }

    /// The internal damping of a fabric's threads, at velocity level after the piece: each compliant sheet edge's speed of
    /// stretch decays over the piece as a spring of its stiffness and damping ratio (`zeta`) would, by exp(-2 zeta omega h),
    /// omega = sqrt(k (w_a + w_b)) the edge's natural frequency, its two particles sharing the change by their inverse masses so
    /// momentum is kept. A fabric's damping ratio comes from its measured tensile resilience (KES-F RT, the share of the work
    /// of stretching it gives back, through Jacobsen's equivalent viscous damping: SoftBodyMaterial in soft.ts).
    fn thread_damping(&mut self, h: f32) {
        for e in 0..self.edges {
            if self.eflags[e] & (SHEET | STIFFNESS | TORN) != SHEET | STIFFNESS || !(self.zeta[e] > 0.0) || !(self.omega[e] > 0.0) {
                continue;
            }
            let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
            let (wa, wb) = (self.w[a], self.w[b]);
            let w = wa + wb;
            if !(w > 0.0) {
                continue;
            }
            let (dx, dy, dz) = (self.x[a] - self.x[b], self.y[a] - self.y[b], self.z[a] - self.z[b]);
            let len = sqrt(dx * dx + dy * dy + dz * dz);
            if !(len > 1e-9) {
                continue;
            }
            let n = [dx / len, dy / len, dz / len];
            let rel = (self.vx[a] - self.vx[b]) * n[0] + (self.vy[a] - self.vy[b]) * n[1] + (self.vz[a] - self.vz[b]) * n[2];
            let omega = sqrt(self.omega[e] * w);
            let keep = margoengine_physics_kernel_common::pinned::exp(-2.0 * self.zeta[e] as f64 * omega as f64 * h as f64) as f32;
            let change = rel * (1.0 - keep) / w;
            self.vx[a] -= wa * change * n[0];
            self.vy[a] -= wa * change * n[1];
            self.vz[a] -= wa * change * n[2];
            self.vx[b] += wb * change * n[0];
            self.vy[b] += wb * change * n[1];
            self.vz[b] += wb * change * n[2];
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
        // An edge the exact solve holds (src/rigid.rs: a rigid edge, a sheet's compliant thread) is not swept, nor one of the
        // vertex-block solve (cloth_block.rs).
        if self.held_exactly(e) || self.eflags[e] & BLOCK != 0 {
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
        // A stiffness k is a natural frequency of sqrt(k w) on the constraint's effective mass 1/w, taken from the masses now.
        let omega = if self.eflags[e] & STIFFNESS != 0 { sqrt(self.omega[e] * w) } else { self.omega[e] };
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

    /// Whether body row `c` is still: fixed (no inverse mass or inertia) and not moving, so a contact with it is a plane that
    /// stays put through the piece.
    pub(crate) fn still(&self, c: usize) -> bool {
        self.wm[c] == 0.0
            && self.iixx[c] == 0.0
            && self.iiyy[c] == 0.0
            && self.iizz[c] == 0.0
            && self.lvx[c] == 0.0
            && self.lvy[c] == 0.0
            && self.lvz[c] == 0.0
            && self.avx[c] == 0.0
            && self.avy[c] == 0.0
            && self.avz[c] == 0.0
    }

    /// Keeps particle `i` off the still bodies it holds contacts with, along each contact's normal, inside the passes of the
    /// vertex-block solve: the ground is then one of the constraints the passes meet, as a pin is, and a body pressed on it comes
    /// to the static equilibrium of its load and the ground's reaction (KB-SOFT-CONTACTSPLIT1). Held only after the passes, as a
    /// projection the elastic solve never saw, the ground took the bottom layer back each piece while the rest of the body went
    /// on falling into it, and a loaded body sank by twice its static deflection at 20 pieces a step. The push is booked as the
    /// contact's impulse, so the friction and velocity passes after it treat it as the contact passes' own.
    pub(crate) fn hold_still_contacts(&mut self, i: usize, h: f32) {
        if self.w[i] <= 0.0 {
            return;
        }
        for s in 0..SLOTS {
            let k = i * SLOTS + s;
            let c = self.kc[k];
            if c == NONE {
                continue;
            }
            let c = (c - 1) as usize;
            if !self.still(c) || self.dom[c] > 0.0 || self.bmesh[c] > 0.0 || self.linked_to(i, c) {
                continue;
            }
            let carried = [self.mx[c], self.my[c], self.mz[c]];
            let spin = [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]];
            let turn = [self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]];
            let dm = [self.dmx[c], self.dmy[c], self.dmz[c]];
            let (n, _, gap) = self.meet(k, c, 0.0, carried, spin, dm, turn, [self.x[i], self.y[i], self.z[i]]);
            let d = gap - self.radius[i];
            if d < 0.0 {
                self.x[i] -= n[0] * d;
                self.y[i] -= n[1] * d;
                self.z[i] -= n[2] * d;
                self.kj[k] -= d / (self.w[i] * h);
                self.pressed[self.pbody[i] as usize] = 1;
            }
        }
    }

    /// Holds the corners of the cells the constraints solve off the still bodies they touch, inside each pass, as the vertex-block
    /// solve holds its vertices (KB-SOFT-CONTACTSPLIT1).
    fn hold_constraint_cells(&mut self, h: f32) {
        use crate::fem::{IMPLICIT_TET, PROJECTIVE_TET, TORN_TET, VERTEX_BLOCK_TET};
        for t in 0..self.fem.count {
            if self.fem.flags[t] & (TORN_TET | IMPLICIT_TET | VERTEX_BLOCK_TET | PROJECTIVE_TET) != 0 {
                continue;
            }
            for k in 0..4 {
                let i = self.fem.p[k][t] as usize;
                self.hold_still_contacts(i, h);
            }
        }
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
            // The body is pushed at the point of its surface nearest the particle.
            let q = [self.x[i] - nx * d - self.mx[c], self.y[i] - ny * d - self.my[c], self.z[i] - nz * d - self.mz[c]];
            self.resolve(i, c, [nx, ny, nz], -gap, surface, friction, h, q, usize::MAX);
        }
    }

    /// Keeps every particle on the outer side of the planes it holds (`kc` to `kf`), each plane's point carried along its
    /// velocity for `tau` seconds since the start of the step: the host found them once for the step with its own query.
    pub fn apply_contacts(&mut self, h: f32, tau: f32) {
        self.tau_end = tau;
        // Through the piece the contacts meet each body turned as it will be at the piece's end.
        for c in 0..self.colliders {
            let spun = self.spun(c, h);
            (self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]) = (spun[0], spun[1], spun[2], spun[3]);
        }
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
                // A particle linked to the body is held by the link, not pushed off its surface (rigid.rs).
                if self.linked_to(i, c) {
                    continue;
                }
                let v = [self.kvx[k], self.kvy[k], self.kvz[k]];
                let carried = [self.mx[c] + self.lvx[c] * h, self.my[c] + self.lvy[c] * h, self.mz[c] + self.lvz[c] * h];
                let dm = [self.dmx[c], self.dmy[c], self.dmz[c]];
                let spin = [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]];
                let turn = [self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]];
                let (n, q, gap) = self.meet(k, c, tau, carried, spin, dm, turn, [self.x[i], self.y[i], self.z[i]]);
                let d = gap - self.radius[i];
                if d < 0.0 {
                    let friction = self.kf[k];
                    self.resolve(i, c, n, -d, v, friction, h, q, k);
                }
            }
        }
        self.apply_faces(h, tau);
    }

    /// Where a particle at `x` stands against the contact of slot `k` with body row `c` at `tau` seconds into the step, for a body
    /// whose centre is at `carried` and turned by `spin` since the step began, moved by `dm` and turned by `turn` about its centre
    /// by the corrections of this piece: the unit normal out of the body, the point where the body takes the push (from its
    /// centre), and the gap from the body's surface to `x` along the normal.
    #[allow(clippy::too_many_arguments)]
    pub fn meet(&self, k: usize, c: usize, tau: f32, carried: [f32; 3], spin: [f32; 4], dm: [f32; 3], turn: [f32; 4], x: [f32; 3]) -> ([f32; 3], [f32; 3], f32) {
        let found = [self.kpx[k], self.kpy[k], self.kpz[k]];
        let n0 = [self.knx[k], self.kny[k], self.knz[k]];
        let v = [self.kvx[k], self.kvy[k], self.kvz[k]];
        let surface = self.surface_at(c, found, n0, v, self.kr[k], tau, carried, spin, dm, turn);
        surface.meet(x)
    }

    /// The surface of body row `c` where a contact was found at the step's start (a point on it, the normal out of it, the
    /// surface's velocity there and what it is there, `rho`: -1 a flat face, else its radius of curvature), as it stands at `tau`
    /// seconds into the step for a body whose centre is now at `carried`, turned by `spin` since the step began, then moved by
    /// `dm` and turned by `turn` about the centre. A surface that moves besides (a deforming mesh's vertices) goes on at that part
    /// of its speed.
    #[allow(clippy::too_many_arguments)]
    pub fn surface_at(&self, c: usize, found: [f32; 3], n0: [f32; 3], v: [f32; 3], rho: f32, tau: f32, carried: [f32; 3], spin: [f32; 4], dm: [f32; 3], turn: [f32; 4]) -> Surface {
        let r0 = [found[0] - self.m0x[c], found[1] - self.m0y[c], found[2] - self.m0z[c]];
        // What the surface does that the body's own motion does not: its speed less the body's velocity at the point.
        let (ax, ay, az) = (self.a0x[c], self.a0y[c], self.a0z[c]);
        let own = [
            v[0] - self.l0x[c] - (ay * r0[2] - az * r0[1]),
            v[1] - self.l0y[c] - (az * r0[0] - ax * r0[2]),
            v[2] - self.l0z[c] - (ax * r0[1] - ay * r0[0]),
        ];
        let centre = [carried[0] + dm[0], carried[1] + dm[1], carried[2] + dm[2]];
        // A point fixed in the body, from its centre at the step's start to where the body has taken it (rotations, so it keeps its
        // distance from the centre however far the body turns).
        let place = |r: [f32; 3]| {
            let a = rotate(spin, r[0], r[1], r[2]);
            let a = rotate(turn, a.0, a.1, a.2);
            [centre[0] + a.0 + own[0] * tau, centre[1] + a.1 + own[1] * tau, centre[2] + a.2 + own[2] * tau]
        };
        if rho < 0.0 {
            // A face: its plane, through the point, turns with the body.
            let n = rotate(spin, n0[0], n0[1], n0[2]);
            let n = rotate(turn, n.0, n.1, n.2);
            Surface { flat: true, at: place(r0), normal: [n.0, n.1, n.2], rho: 0.0, centre }
        } else {
            // A round place, or a corner or an edge (rho 0): its centre of curvature is fixed in the body.
            let at = place([r0[0] - rho * n0[0], r0[1] - rho * n0[1], r0[2] - rho * n0[2]]);
            let n = rotate(spin, n0[0], n0[1], n0[2]);
            let n = rotate(turn, n.0, n.1, n.2);
            Surface { flat: false, at, normal: [n.0, n.1, n.2], rho, centre }
        }
    }

    /// Body row `c`'s turn since the step began, carried on through a piece of `h` seconds at its angular velocity (the rigid
    /// world's update of a rotation, Mueller et al. 2020 equation 8: `q + 1/2 [w h, 0] q`, made unit again).
    pub(crate) fn spun(&self, c: usize, h: f32) -> [f32; 4] {
        let (x, y, z, s) = (self.rqx[c], self.rqy[c], self.rqz[c], self.rqw[c]);
        let (wx, wy, wz) = (self.avx[c] * h, self.avy[c] * h, self.avz[c] * h);
        let nx = x + 0.5 * (s * wx + wy * z - wz * y);
        let ny = y + 0.5 * (s * wy + wz * x - wx * z);
        let nz = z + 0.5 * (s * wz + wx * y - wy * x);
        let ns = s - 0.5 * (wx * x + wy * y + wz * z);
        let len = sqrt(nx * nx + ny * ny + nz * nz + ns * ns);
        [nx / len, ny / len, nz / len, ns / len]
    }

    /// The velocity of body row `c`'s surface at the point `q` from its centre: the body's own (its velocity and its spin now),
    /// and what a surface found at `found` going at `v` at the step's start does besides.
    pub(crate) fn surface_velocity(&self, c: usize, q: [f32; 3], found: [f32; 3], v: [f32; 3]) -> [f32; 3] {
        let r0 = [found[0] - self.m0x[c], found[1] - self.m0y[c], found[2] - self.m0z[c]];
        let (ax, ay, az) = (self.a0x[c], self.a0y[c], self.a0z[c]);
        let (wx, wy, wz) = (self.avx[c], self.avy[c], self.avz[c]);
        [
            self.lvx[c] + wy * q[2] - wz * q[1] + v[0] - self.l0x[c] - (ay * r0[2] - az * r0[1]),
            self.lvy[c] + wz * q[0] - wx * q[2] + v[1] - self.l0y[c] - (az * r0[0] - ax * r0[2]),
            self.lvz[c] + wx * q[1] - wy * q[0] + v[2] - self.l0z[c] - (ax * r0[1] - ay * r0[0]),
        ]
    }

    /// After a piece, the speeds of the particles and the bodies they touch: a contact does not leave them separating faster than
    /// they met (the pop a position correction would leave is taken out, as an inelastic contact does), with the same impulse
    /// given to the body (Macklin et al. 2014, section 4; Mueller et al. 2020, section 3.5, who solve the velocities of contacts
    /// after their positions). Friction is the exact solve's (rigid.rs, `friction_solve`).
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
                // Only a contact the piece pushed on (Mueller et al. 2020, section 3.6: the velocity pass is over the contacts the
                // position pass made).
                if self.kj[k] <= 0.0 {
                    continue;
                }
                let c = (c - 1) as usize;
                if self.linked_to(i, c) {
                    continue;
                }
                // A body the soft body dominates meets particles that do not give way: for it the particle has no inverse mass.
                let wp = if self.dom[c] > 0.0 { 0.0 } else { self.w[i] };
                let carried = [self.mx[c], self.my[c], self.mz[c]];
                let spin = [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]];
                let (n, q, gap) = self.meet(k, c, tau, carried, spin, [0.0; 3], [0.0, 0.0, 0.0, 1.0], [self.x[i], self.y[i], self.z[i]]);
                let d = gap - self.radius[i];
                if d > 0.002 {
                    continue;
                }
                // The body's velocity at the contact, and what the surface does besides (a deforming mesh).
                let vb = self.surface_velocity(c, q, [self.kpx[k], self.kpy[k], self.kpz[k]], [self.kvx[k], self.kvy[k], self.kvz[k]]);
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
                // Only the normal: friction is the exact solve's (rigid.rs, `friction_solve`), and holding the slide here as well
                // would count each push twice.
                let j = [n[0] * jn, n[1] * jn, n[2] * jn];
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
        self.face_velocities();
    }

    /// Whether particle `i` is linked to body row `c` this piece (`rigid_begin` marks them).
    pub(crate) fn linked_to(&self, i: usize, c: usize) -> bool {
        self.rg.is_linked(i, c)
    }

    /// Pushes particle `i` out of the surface of body row `c` by `push` along the unit normal `n`, with friction, and gives
    /// the body what that cost at the point `q` of its surface (from its centre of mass).
    fn resolve(&mut self, i: usize, c: usize, n: [f32; 3], push: f32, surface: [f32; 3], friction: f32, h: f32, q: [f32; 3], slot: usize) {
        let m = 1.0 / self.w[i];
        let (nx, ny, nz) = (n[0], n[1], n[2]);
        // How easily the body gives way at the contact along the normal: the particle takes the share of the correction its
        // inverse mass leaves it (Macklin et al. 2014, section 4).
        let (qx, qy, qz) = (q[0], q[1], q[2]);
        let (ax, ay, az) = (qy * nz - qz * ny, qz * nx - qx * nz, qx * ny - qy * nx);
        let (ix, iy, iz) = self.inverse_inertia(c, ax, ay, az);
        let wb = self.wm[c] + ax * ix + ay * iy + az * iz;
        if self.dom[c] > 0.0 {
            // The soft body dominates this body: the particle does not give way, and the body takes the whole correction at the
            // contact point.
            if wb > 0.0 {
                let lambda = push / wb;
                self.correct_body(c, [-nx * lambda, -ny * lambda, -nz * lambda], [qx, qy, qz], h);
                if slot != usize::MAX {
                    self.kj[slot] += lambda / h;
                }
            }
            return;
        }
        let share = self.w[i] / (self.w[i] + wb);
        self.x[i] += nx * push * share;
        self.y[i] += ny * push * share;
        self.z[i] += nz * push * share;
        // Friction as a bounded displacement across the surface (Macklin et al. 2014, "Unified Particle Physics").
        // The slide against the body's point: the surface's own motion over the piece and what this piece's corrections moved
        // the point by, so a body that takes the friction's reaction is not pushed again for a slide it has already followed.
        let moved = self.correction_at(c, [qx, qy, qz]);
        let (sx, sy, sz) = (surface[0], surface[1], surface[2]);
        let mut ux = self.x[i] - self.px[i] - sx * h - moved[0];
        let mut uy = self.y[i] - self.py[i] - sy * h - moved[1];
        let mut uz = self.z[i] - self.pz[i] - sz * h - moved[2];
        let un = ux * nx + uy * ny + uz * nz;
        ux -= nx * un;
        uy -= ny * un;
        uz -= nz * un;
        // The body takes the opposite correction, shared by inverse mass at the contact point, and moves on with it.
        let lambda = m * share;
        self.correct_body(c, [-nx * push * lambda, -ny * push * lambda, -nz * push * lambda], [qx, qy, qz], h);
        if slot != usize::MAX {
            self.kj[slot] += push * lambda / h;
        }
        let tl = sqrt(ux * ux + uy * uy + uz * uz);
        if tl > 1e-12 {
            let limit = friction * push;
            let k = if tl < limit { 1.0 } else { limit / tl };
            // The slide is shared by the generalized inverse masses along it (Mueller et al. 2020, section 3.5: friction is a
            // positional constraint of its own along the slide), and the body takes the reaction at the contact point: a slide
            // taken off the particle alone left its momentum nowhere (KB-SOFT-LASHCONTACT1).
            let t = [ux / tl, uy / tl, uz / tl];
            let wt = self.body_inverse_mass(c, [qx, qy, qz], t);
            let f = k / (self.w[i] + wt);
            self.x[i] -= ux * f * self.w[i];
            self.y[i] -= uy * f * self.w[i];
            self.z[i] -= uz * f * self.w[i];
            self.correct_body(c, [ux * f, uy * f, uz * f], [qx, qy, qz], h);
        }
    }

    /// Moves body row `c` by the position-level multiplier `lambda` (the reaction of a correction, a displacement times mass) at
    /// the point `q` from its centre of mass: its centre by `wm * lambda` and a turn of `I^-1 (q x lambda)`, which the next
    /// contact of the piece meets; the host gives the real body `lambda / h` as an impulse. The turn is composed with the turn
    /// already made as Mueller et al. 2020 update a rotation (their equations 8 and 9): `t <- t + 1/2 [dtheta, 0] t`, made unit
    /// again, so it stays a rotation however large it is.
    pub fn correct_body(&mut self, c: usize, lambda: [f32; 3], q: [f32; 3], h: f32) {
        let inv = 1.0 / h;
        let moment = [q[1] * lambda[2] - q[2] * lambda[1], q[2] * lambda[0] - q[0] * lambda[2], q[0] * lambda[1] - q[1] * lambda[0]];
        self.jx[c] += lambda[0] * inv;
        self.jy[c] += lambda[1] * inv;
        self.jz[c] += lambda[2] * inv;
        self.kx[c] += moment[0] * inv;
        self.ky[c] += moment[1] * inv;
        self.kz[c] += moment[2] * inv;
        if self.wm[c] > 0.0 {
            self.dmx[c] += lambda[0] * self.wm[c];
            self.dmy[c] += lambda[1] * self.wm[c];
            self.dmz[c] += lambda[2] * self.wm[c];
            let (wx, wy, wz) = self.inverse_inertia(c, moment[0], moment[1], moment[2]);
            let (x, y, z, s) = (self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]);
            // [w, 0] t = [s w + w x v, -w . v] for t = [v, s].
            let nx = x + 0.5 * (s * wx + wy * z - wz * y);
            let ny = y + 0.5 * (s * wy + wz * x - wx * z);
            let nz = z + 0.5 * (s * wz + wx * y - wy * x);
            let ns = s - 0.5 * (wx * x + wy * y + wz * z);
            let len = sqrt(nx * nx + ny * ny + nz * nz + ns * ns);
            self.tqx[c] = nx / len;
            self.tqy[c] = ny / len;
            self.tqz[c] = nz / len;
            self.tqw[c] = ns / len;
        }
    }

    /// How far this piece's corrections moved body row `c`'s point that is at `q` from its centre now: its centre's move and
    /// the turn that took the point there.
    pub(crate) fn correction_at(&self, c: usize, q: [f32; 3]) -> [f32; 3] {
        let back = rotate(conj([self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]]), q[0], q[1], q[2]);
        [self.dmx[c] + q[0] - back.0, self.dmy[c] + q[1] - back.1, self.dmz[c] + q[2] - back.2]
    }

    /// No correction yet this piece: the body row is where its velocity takes it, unturned.
    fn clear_correction(&mut self, c: usize) {
        self.dmx[c] = 0.0;
        self.dmy[c] = 0.0;
        self.dmz[c] = 0.0;
        self.tqx[c] = 0.0;
        self.tqy[c] = 0.0;
        self.tqz[c] = 0.0;
        self.tqw[c] = 1.0;
    }

    /// A body's world inverse inertia applied to a vector, the body turned as the contacts meet it now: the inverse inertia of the
    /// step's start (`ii*`) turned by the body's turn since (`R I0^-1 R^T`, R its turn `sq` and this piece's corrections `tq`), the
    /// same turn its contacts' points go by. The inertia goes with the body: on a body of very uneven inertia (a thin rod, whose inertia about its own
    /// axis is tiny) a turn left out would read a moment across the axis it now has as one about the axis it had, and spin it.
    pub fn inverse_inertia(&self, c: usize, x: f32, y: f32, z: f32) -> (f32, f32, f32) {
        let turn = [self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]];
        let spin = [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]];
        // Into the frame of the step's start, through the inverse inertia there, and back.
        let (x, y, z) = rotate(conj(turn), x, y, z);
        let (x, y, z) = rotate(conj(spin), x, y, z);
        let (x, y, z) = (
            self.iixx[c] * x + self.iixy[c] * y + self.iixz[c] * z,
            self.iixy[c] * x + self.iiyy[c] * y + self.iiyz[c] * z,
            self.iixz[c] * x + self.iiyz[c] * y + self.iizz[c] * z,
        );
        let (x, y, z) = rotate(spin, x, y, z);
        rotate(turn, x, y, z)
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

/// A body's surface where a contact was found, as it stands now (see `World::surface_at`).
#[derive(Clone, Copy)]
pub struct Surface {
    /// A flat face (`at` a point of its plane, `normal` its normal), else a round place, corner or edge (`at` its centre of
    /// curvature, `rho` its radius, `normal` the normal it was found with).
    pub flat: bool,
    pub at: [f32; 3],
    pub normal: [f32; 3],
    pub rho: f32,
    /// The body's centre of mass now.
    pub centre: [f32; 3],
}

impl Surface {
    /// Where a thing at `x` meets the surface: the unit normal out of the body toward it, the point where the body takes the push
    /// (from its centre of mass), and the gap from the surface to `x` along the normal. On a face the thing is held where it
    /// stands, the body pushed at the foot of `x` on the plane; on a round place, from the centre of curvature along the line to
    /// `x`. Either way the push on the body and on the thing lie on one line, so the contact turns the body only as it should.
    pub fn meet(&self, x: [f32; 3]) -> ([f32; 3], [f32; 3], f32) {
        let d = [x[0] - self.at[0], x[1] - self.at[1], x[2] - self.at[2]];
        if self.flat {
            let n = self.normal;
            let gap = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
            let foot = [x[0] - n[0] * gap, x[1] - n[1] * gap, x[2] - n[2] * gap];
            return (n, [foot[0] - self.centre[0], foot[1] - self.centre[1], foot[2] - self.centre[2]], gap);
        }
        let length = sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        let n = if length > 1e-9 { [d[0] / length, d[1] / length, d[2] / length] } else { self.normal };
        // A thing at the centre itself (inside a ball) leaves by the normal it was found with.
        let gap = if length > 1e-9 { length - self.rho } else { -self.rho };
        let on = [self.at[0] + n[0] * self.rho, self.at[1] + n[1] * self.rho, self.at[2] + n[2] * self.rho];
        (n, [on[0] - self.centre[0], on[1] - self.centre[1], on[2] - self.centre[2]], gap)
    }
}

fn conj(q: [f32; 4]) -> [f32; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

pub(crate) fn rotate(q: [f32; 4], x: f32, y: f32, z: f32) -> (f32, f32, f32) {
    let (qx, qy, qz, qw) = (q[0], q[1], q[2], q[3]);
    let tx = 2.0 * (qy * z - qz * y);
    let ty = 2.0 * (qz * x - qx * z);
    let tz = 2.0 * (qx * y - qy * x);
    (x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx))
}
