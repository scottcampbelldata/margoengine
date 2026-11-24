// The exports TypeScript calls: one world per Wasm instance, rows by id.
use crate::World;
use crate::col::Col;

static mut WORLD: World = World {
    x: Col::new(), y: Col::new(), z: Col::new(), px: Col::new(), py: Col::new(), pz: Col::new(), vx: Col::new(),
    vy: Col::new(), vz: Col::new(), w: Col::new(), radius: Col::new(), tx: Col::new(), ty: Col::new(), tz: Col::new(),
    pflags: Col::new(), pbody: Col::new(), ea: Col::new(), eb: Col::new(), rest: Col::new(), omega: Col::new(),
    zeta: Col::new(), lambda: Col::new(), tear: Col::new(), eflags: Col::new(), gravity_scale: Col::new(),
    linear_damping: Col::new(), c_kind: Col::new(), cx: Col::new(), cy: Col::new(), cz: Col::new(), qx: Col::new(),
    qy: Col::new(), qz: Col::new(), qw: Col::new(), sx: Col::new(), sy: Col::new(), sz: Col::new(), friction: Col::new(),
    lvx: Col::new(), lvy: Col::new(), lvz: Col::new(), avx: Col::new(), avy: Col::new(), avz: Col::new(), mx: Col::new(),
    my: Col::new(), mz: Col::new(), jx: Col::new(), jy: Col::new(), jz: Col::new(), kx: Col::new(), ky: Col::new(),
    kz: Col::new(), wm: Col::new(), iixx: Col::new(), iixy: Col::new(), iixz: Col::new(), iiyy: Col::new(),
    iiyz: Col::new(), iizz: Col::new(), particles: 0, edges: 0, bodies: 0, colliders: 0, torn: 0, fem: crate::fem::Fem::new(), rx: Col::new(), ry: Col::new(), rz: Col::new(), slx: Col::new(), sly: Col::new(),
    slz: Col::new(), sw: Col::new(), b_on: Col::new(), b_omega: Col::new(), b_zeta: Col::new(), b_first: Col::new(),
    b_count: Col::new(), bqx: Col::new(), bqy: Col::new(), bqz: Col::new(), bqw: Col::new(), kc: Col::new(), knx: Col::new(), kny: Col::new(), knz: Col::new(),
    kd: Col::new(), kpx: Col::new(), kpy: Col::new(), kpz: Col::new(), kf: Col::new(),
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
    kc, knx, kny, knz, kd, kpx, kpy, kpz, kf,
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
pub extern "C" fn soft_apply(h: f32) {
    world().apply_contacts(h);
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
