// The exports TypeScript calls: one world per Wasm instance, rows by id.
use crate::World;
use crate::col::Col;

static mut WORLD: World = World {
    x: Col::new(), y: Col::new(), z: Col::new(), px: Col::new(), py: Col::new(), pz: Col::new(), vx: Col::new(),
    vy: Col::new(), vz: Col::new(), w: Col::new(), radius: Col::new(), tx: Col::new(), ty: Col::new(), tz: Col::new(),
    pflags: Col::new(), pbody: Col::new(), ea: Col::new(), eb: Col::new(), rest: Col::new(), omega: Col::new(),
    zeta: Col::new(), lambda: Col::new(), tear: Col::new(), elimit: Col::new(), eflags: Col::new(), gravity_scale: Col::new(),
    linear_damping: Col::new(), c_kind: Col::new(), cx: Col::new(), cy: Col::new(), cz: Col::new(), qx: Col::new(),
    qy: Col::new(), qz: Col::new(), qw: Col::new(), sx: Col::new(), sy: Col::new(), sz: Col::new(), friction: Col::new(),
    lvx: Col::new(), lvy: Col::new(), lvz: Col::new(), avx: Col::new(), avy: Col::new(), avz: Col::new(), mx: Col::new(),
    my: Col::new(), mz: Col::new(), jx: Col::new(), jy: Col::new(), jz: Col::new(), kx: Col::new(), ky: Col::new(),
    kz: Col::new(), wm: Col::new(), iixx: Col::new(), iixy: Col::new(), iixz: Col::new(), iiyy: Col::new(),
    iiyz: Col::new(), iizz: Col::new(), particles: 0, edges: 0, bodies: 0, colliders: 0, torn: 0, fem: crate::fem::Fem::new(), rx: Col::new(), ry: Col::new(), rz: Col::new(), slx: Col::new(), sly: Col::new(),
    slz: Col::new(), sw: Col::new(), b_on: Col::new(), b_omega: Col::new(), b_zeta: Col::new(), b_first: Col::new(),
    b_count: Col::new(), bqx: Col::new(), bqy: Col::new(), bqz: Col::new(), bqw: Col::new(), kc: Col::new(), knx: Col::new(), kny: Col::new(), knz: Col::new(),
    kpx: Col::new(), kpy: Col::new(), kpz: Col::new(), kvx: Col::new(), kvy: Col::new(), kvz: Col::new(), kf: Col::new(), kr: Col::new(),
    at_p: Col::new(), at_row: Col::new(), at_rx: Col::new(), at_ry: Col::new(), at_rz: Col::new(), attachments: 0,
    vtri: Col::new(), vb_on: Col::new(), vb_first: Col::new(), vb_count: Col::new(), vb_target: Col::new(), vb_ambient: Col::new(), vb_omega: Col::new(),
    vb_zeta: Col::new(), vb_lambda: Col::new(), vgx: Col::new(), vgy: Col::new(), vgz: Col::new(),
    vb_mu: Col::new(), mt_a: Col::new(), mt_b: Col::new(), mt_c: Col::new(), mt_d: Col::new(), mt_area: Col::new(), mh_head: Col::new(), mh_next: Col::new(), rg: crate::rigid::Rigid::new(), gs: Col::new(), dom: Col::new(), bmesh: Col::new(), bsleep: Col::new(),
    m0x: Col::new(), m0y: Col::new(), m0z: Col::new(), l0x: Col::new(), l0y: Col::new(), l0z: Col::new(),
    dmx: Col::new(), dmy: Col::new(), dmz: Col::new(), a0x: Col::new(), a0y: Col::new(), a0z: Col::new(), kj: Col::new(), tau_end: 0.0, pieces: 0, tqx: Col::new(), tqy: Col::new(), tqz: Col::new(), tqw: Col::new(), rox: Col::new(), roy: Col::new(), roz: Col::new(), rqx: Col::new(), rqy: Col::new(), rqz: Col::new(), rqw: Col::new(), sqx: Col::new(), sqy: Col::new(), sqz: Col::new(), sqw: Col::new(),
    fc_a: Col::new(), fc_b: Col::new(), fc_c: Col::new(), fc_wa: Col::new(), fc_wb: Col::new(), fc_wc: Col::new(), fc_row: Col::new(),
    fc_nx: Col::new(), fc_ny: Col::new(), fc_nz: Col::new(), fc_px: Col::new(), fc_py: Col::new(), fc_pz: Col::new(), fc_vx: Col::new(),
    fc_vy: Col::new(), fc_vz: Col::new(), fc_f: Col::new(), fc_r: Col::new(), fc_j: Col::new(), fc_k: Col::new(), fc_side: Col::new(), faces: 0,
    tt_p: Col::new(), tt_a: Col::new(), tt_len: Col::new(), tethers: 0,
    sk_p: Col::new(), sk_x: Col::new(), sk_y: Col::new(), sk_z: Col::new(), sk_vx: Col::new(), sk_vy: Col::new(), sk_vz: Col::new(),
    sk_nx: Col::new(), sk_ny: Col::new(), sk_nz: Col::new(), sk_max: Col::new(), sk_back: Col::new(), skins: 0,
    cb_head: Col::new(), cb_next: Col::new(), cb_phi: Col::new(), cb_save: Col::new(), cbx: Col::new(), cby: Col::new(), cbz: Col::new(),
    ax: Col::new(), ay: Col::new(), az: Col::new(), pressed: Col::new(), vbx: Col::new(), vby: Col::new(), vbz: Col::new(),
    bd_p: Col::new(), bd_r: Col::new(), bd_alpha: Col::new(), bd_l: Col::new(), bd_flag: Col::new(), bd_len: Col::new(), bends: 0,
    bd_head: Col::new(), bd_next: Col::new(),
};

#[allow(static_mut_refs)]
pub(crate) fn world() -> &'static mut World {
    unsafe { &mut *(&raw mut WORLD) }
}

/// The columns, in the order TypeScript names them (`SOFT_COLUMNS` in src/soft.ts holds the same list).
macro_rules! columns {
    ($($name:ident,)*) => {
        #[allow(non_camel_case_types)]
        #[repr(u32)]
        enum Column { $($name,)* }
        fn column(w: &mut World, id: u32) -> *mut u8 {
            $(if id == Column::$name as u32 { return w.$name.as_mut_ptr() as *mut u8; })*
            core::ptr::null_mut()
        }
    };
}

columns! {
    x, y, z, px, py, pz, vx, vy, vz, w, radius, tx, ty, tz, pflags, pbody,
    ea, eb, rest, omega, zeta, lambda, tear, eflags, gravity_scale, linear_damping,
    c_kind, cx, cy, cz, qx, qy, qz, qw, sx, sy, sz, friction, lvx, lvy, lvz, avx, avy, avz, mx, my, mz,
    jx, jy, jz, kx, ky, kz, wm, iixx, iixy, iixz, iiyy, iiyz, iizz,
    rx, ry, rz, slx, sly, slz, sw, b_on, b_omega, b_zeta, b_first, b_count, bqx, bqy, bqz, bqw,
    kc, knx, kny, knz, kpx, kpy, kpz, kvx, kvy, kvz, kf,
    at_p, at_row, at_rx, at_ry, at_rz,
    vtri, vb_on, vb_first, vb_count, vb_target, vb_ambient, vb_omega, vb_zeta, vb_lambda, gs, dom, bsleep, m0x, m0y, m0z, l0x, l0y, l0z, a0x, a0y, a0z, kj, rox, roy, roz,
    fc_a, fc_b, fc_c, fc_wa, fc_wb, fc_wc, fc_row, fc_nx, fc_ny, fc_nz, fc_px, fc_py, fc_pz, fc_vx, fc_vy, fc_vz, fc_f, fc_r, fc_j, fc_k, kr, elimit, bmesh,
    tt_p, tt_a, tt_len,
    sk_p, sk_x, sk_y, sk_z, sk_vx, sk_vy, sk_vz, sk_nx, sk_ny, sk_nz, sk_max, sk_back,
    cbx, cby, cbz,
    ax, ay, az,
    vbx, vby, vbz,
    vb_mu, mt_a, mt_b, mt_c, mt_d, mt_area,
}

/// Makes room for rows and says how many are in use. Views over the memory are stale after it.
#[unsafe(no_mangle)]
pub extern "C" fn soft_reserve(particles: u32, edges: u32, bodies: u32, colliders: u32) {
    let w = world();
    w.reserve(particles as usize, edges as usize, bodies as usize, colliders as usize);
    w.particles = particles as usize;
    w.edges = edges as usize;
    w.bodies = bodies as usize;
    w.colliders = colliders as usize;
}

/// Makes room for particle attachments and says how many are in use. Views over the memory are stale after it.
#[unsafe(no_mangle)]
pub extern "C" fn soft_attach_reserve(attachments: u32) {
    let w = world();
    w.reserve_attachments(attachments as usize);
    w.attachments = attachments as usize;
}

/// Makes room for long range attachments and says how many are in use. Views over the memory are stale after it.
#[unsafe(no_mangle)]
pub extern "C" fn soft_tether_reserve(tethers: u32) {
    let w = world();
    w.tt_p.resize(tethers as usize);
    w.tt_a.resize(tethers as usize);
    w.tt_len.resize(tethers as usize);
    w.tethers = tethers as usize;
}

/// Makes room for quadratic bending stencils and says how many are in use. Views over the memory are stale after it.
#[unsafe(no_mangle)]
pub extern "C" fn soft_bend_reserve(bends: u32) {
    world().reserve_bends(bends as usize);
}

/// Sets bending element `s` (bend.rs, `set_bend`): triangle t0 t1 t2, the far corner across each edge (u32::MAX for none),
/// the rest lengths of its sides (t0t1, t1t2, t2t0) and of each far corner to its edge's ends, the warp side (3: none), the
/// rigidity along and across the warp (N m) and its flags.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn soft_bend_set(
    s: u32, t0: u32, t1: u32, t2: u32, f0: u32, f1: u32, f2: u32, s01: f32, s12: f32, s20: f32, a0: f32, b0: f32, a1: f32,
    b1: f32, a2: f32, b2: f32, warp: u32, along: f32, across: f32, flag: u32,
) {
    world().set_bend(s as usize, [t0, t1, t2], [f0, f1, f2], [s01, s12, s20], [a0, b0, a1, b1, a2, b2], warp, along, across, flag);
}

/// The bending energy of every element, J.
#[unsafe(no_mangle)]
pub extern "C" fn soft_bend_energy() -> f64 {
    world().bend_energy()
}

/// Makes room for skinned particles and says how many are in use. Views over the memory are stale after it.
#[unsafe(no_mangle)]
pub extern "C" fn soft_skin_reserve(skins: u32) {
    let w = world();
    let n = skins as usize;
    w.sk_p.resize(n);
    for col in [
        &mut w.sk_x, &mut w.sk_y, &mut w.sk_z, &mut w.sk_vx, &mut w.sk_vy, &mut w.sk_vz, &mut w.sk_nx, &mut w.sk_ny,
        &mut w.sk_nz, &mut w.sk_max, &mut w.sk_back,
    ] {
        col.resize(n);
    }
    w.skins = n;
}

/// Makes room for the face contacts of a step and says how many are in use. Views over the memory are stale after it.
#[unsafe(no_mangle)]
pub extern "C" fn soft_face_reserve(faces: u32) {
    let w = world();
    w.reserve_faces(faces as usize);
    w.faces = faces as usize;
}

/// Makes room for the triangles of closed surfaces that keep their volume (three particle indices each in `vtri`).
#[unsafe(no_mangle)]
pub extern "C" fn soft_volume_reserve(triangles: u32) {
    let w = world();
    w.vtri.resize(3 * triangles as usize);
    for col in [&mut w.mt_a, &mut w.mt_b, &mut w.mt_c, &mut w.mt_d, &mut w.mt_area] {
        col.resize(triangles as usize);
    }
}

/// The current volume of the closed surface of body `b`, in cubic metres.
#[unsafe(no_mangle)]
pub extern "C" fn soft_volume(b: u32) -> f32 {
    world().surface_volume(b as usize)
}

/// Where a column starts in the memory.
#[unsafe(no_mangle)]
pub extern "C" fn soft_column(id: u32) -> u32 {
    column(world(), id) as usize as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_step(dt: f32, substeps: u32, iterations: u32, gx: f32, gy: f32, gz: f32) {
    world().step(dt, substeps, iterations, [gx, gy, gz]);
}

/// Starts a step; with `soft_pre`, `soft_apply`, `soft_post` and `soft_finish` it is `soft_step` with the contacts found by
/// the host.
#[unsafe(no_mangle)]
pub extern "C" fn soft_begin(dt: f32) {
    world().begin(dt);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_pre(h: f32, iterations: u32, gx: f32, gy: f32, gz: f32) {
    world().substep_pre(h, iterations.max(1), [gx, gy, gz]);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_apply(h: f32, tau: f32) {
    world().apply_contacts(h, tau);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_post(h: f32) {
    world().substep_post(h);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_finish() {
    world().finish();
}

/// Makes room for cloth triangles and contacts and says where the triangles go (three particle indices each). Views over the
/// memory are stale after it.
#[unsafe(no_mangle)]
pub extern "C" fn soft_cloth_reserve(triangles: u32, contacts: u32) -> u32 {
    crate::collide::reserve(triangles as usize, contacts as usize);
    crate::collide::buffer() as usize as u32
}

/// Puts the first `triangles` of the buffer into the cloth contact search, with a thickness and a friction coefficient.
#[unsafe(no_mangle)]
pub extern "C" fn soft_cloth_enable(triangles: u32, thickness: f32, friction: f32) {
    crate::collide::enable(triangles as usize, thickness, friction);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_torn() -> u32 {
    world().torn
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_hash() -> u32 {
    world().hash()
}
