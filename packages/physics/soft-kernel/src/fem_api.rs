// The exports TypeScript calls for tetrahedra and clusters: rows by id, filled through the columns and `soft_tet_set`.
use crate::api::world;

/// Returns the most stretched cell over the supplied limit and leaves its current tensile axis in scratch.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_tensile_nucleation(first: u32, count: u32, threshold: f64) -> u32 {
    world().tensile_nucleation(first as usize, count as usize, threshold)
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_fracture_axis() -> u32 {
    world().fem.fracture_axis.as_ptr() as usize as u32
}

macro_rules! fem_columns {
    ($(($name:ident, $($field:tt)+),)*) => {
        #[allow(non_camel_case_types)]
        #[repr(u32)]
        enum FemColumn { $($name,)* }
        fn fem_column(id: u32) -> *mut u8 {
            let f = &mut world().fem;
            $(if id == FemColumn::$name as u32 { return f.$($field)+.as_mut_ptr() as *mut u8; })*
            core::ptr::null_mut()
        }
    };
}

fem_columns! {
    (p0, p[0]), (p1, p[1]), (p2, p[2]), (p3, p[3]),
    (b0, b[0]), (b1, b[1]), (b2, b[2]), (b3, b[3]), (b4, b[4]), (b5, b[5]), (b6, b[6]), (b7, b[7]), (b8, b[8]),
    (vol0, vol0), (mu, mu), (lambda, lambda), (model, model), (yield_strain, yield_strain), (creep, creep), (tear, tear),
    (flags, flags), (cstart, cstart), (ccount, ccount), (comega, comega), (member, member),
    (rest0, rest[0]), (rest1, rest[1]), (rest2, rest[2]),
    (damp, damp), (o0, b0[0]), (o1, b0[1]), (o2, b0[2]), (o3, b0[3]), (o4, b0[4]), (o5, b0[5]), (o6, b0[6]), (o7, b0[7]), (o8, b0[8]),
    (flowed, flowed), (flow_max, flow_max), (smooth, smooth), (interior, interior), (cbody, body),
    (nb0, nb[0]), (nb1, nb[1]), (nb2, nb[2]), (nb3, nb[3]),
    (e_yield, e_yield), (e_creep, e_creep), (e_max, e_max), (e_flow, e_flow), (e_rest0, e_rest0), (e_force, e_force),
    (e_strain, e_strain), (e_smooth, e_smooth),
    (bd_tear_max, tear_max), (bd_min_piece, min_piece),
    (imp_beta, imp.beta),
    (cproxy, proxy), (cpx, pos[0]), (cpy, pos[1]), (cpz, pos[2]), (cqx, quat[0]), (cqy, quat[1]), (cqz, quat[2]), (cqw, quat[3]),
    (clx, lin[0]), (cly, lin[1]), (clz, lin[2]), (cax, ang[0]), (cay, ang[1]), (caz, ang[2]),
    (load, load),
}

/// Makes room for tetrahedra, clusters and cluster members. Views over the memory are stale after it, and so are the soft world's.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_reserve(tets: u32, clusters: u32, members: u32) {
    world().fem_reserve(tets as usize, clusters as usize, members as usize);
}

/// Sets the rest-space reinforcement of the cells of one body. Zero stiffness clears the rows.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_fiber(first: u32, count: u32, x: f32, y: f32, z: f32, modulus: f32) {
    world().set_fiber(first as usize, count as usize, [x, y, z, modulus]);
}

/// Contiguous optional fiber rows for the host's snapshots.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_fiber_rows() -> u32 {
    let fiber = &mut world().fem.fiber;
    if fiber.is_empty() { 0 } else { fiber.as_mut_ptr() as usize as u32 }
}

/// Stores a uniform nine-constant orthotropic law and its three material axes on a body.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_orthotropy(
    first: u32, count: u32,
    ax: f32, ay: f32, az: f32, bx: f32, by: f32, bz: f32, cx: f32, cy: f32, cz: f32,
    xx: f32, yy: f32, zz: f32, xy: f32, xz: f32, yz: f32, gxy: f32, gxz: f32, gyz: f32,
) {
    world().set_orthotropy(first as usize, count as usize,
        [ax, ay, az, bx, by, bz, cx, cy, cz, xx, yy, zz, xy, xz, yz, gxy, gxz, gyz]);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_orthotropy_rows() -> u32 {
    let rows = &mut world().fem.orthotropy;
    if rows.is_empty() { 0 } else { rows.as_mut_ptr() as usize as u32 }
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_orthotropic_failure(
    first: u32, count: u32, tx: f32, ty: f32, tz: f32, cx: f32, cy: f32, cz: f32,
    xy: f32, xz: f32, yz: f32,
) {
    world().set_orthotropic_failure(first as usize, count as usize, [tx, ty, tz, cx, cy, cz, xy, xz, yz]);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_orthotropic_failure_rows() -> u32 {
    let rows = &mut world().fem.orthotropic_failure;
    if rows.is_empty() { 0 } else { rows.as_mut_ptr() as usize as u32 }
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_crack_band(first: u32, count: u32, x: f32, y: f32, z: f32, xy: f32, xz: f32, yz: f32) {
    world().set_crack_band(first as usize, count as usize, [x, y, z, xy, xz, yz]);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_crack_band_rows() -> u32 {
    let rows = &mut world().fem.crack_band;
    if rows.is_empty() { 0 } else { rows.as_mut_ptr() as usize as u32 }
}

/// Where a tetrahedron or cluster column starts in the memory.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_column(id: u32) -> u32 {
    fem_column(id) as usize as u32
}

/// Makes tetrahedron `t` of four particles, with the shape they stand in now as its rest shape; 1 when it is a solid element, 0 when
/// it is flat.
#[unsafe(no_mangle)]
pub extern "C" fn soft_tet_set(t: u32, a: u32, b: u32, c: u32, d: u32, mu: f32, lambda: f32, model: u32) -> u32 {
    world().set_tet(t as usize, [a, b, c, d], mu, lambda, model) as u32
}

/// Makes cluster `c` of the `count` particles whose ids lie in the member column from `start`, with the shape they stand in now.
#[unsafe(no_mangle)]
pub extern "C" fn soft_cluster_set(c: u32, start: u32, count: u32, omega: f32) {
    world().set_cluster_in_place(c as usize, start as usize, count as usize, omega);
}

#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_damping(damping: f32) {
    world().fem.damping = damping;
}

/// Tetrahedra that have torn so far.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_torn() -> u32 {
    world().fem.torn
}

/// Sets how many tetrahedra, clusters and cluster members are in use, after a body is removed and the rows after it moved up.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_trim(tets: u32, clusters: u32, members: u32) {
    let f = &mut world().fem;
    f.count = tets as usize;
    f.clusters = clusters as usize;
    f.members = members as usize;
}

/// Makes room for the per-edge and per-body settings: `edges` edges and `bodies` soft bodies.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_reserve_elements(edges: u32, bodies: u32) {
    world().fem_reserve_elements(edges as usize, bodies as usize);
}

/// Starts a step: each body may tear as many elements as its material allows.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_step_begin() {
    world().fem_step_begin();
}

/// Settings of the implicit solver: the relative residual that ends a solve, the most passes of it, and the unknowns at or below which
/// it runs to the end.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_implicit_settings(tolerance: f32, iterations: u32, dense: u32) {
    let f = &mut world().fem.imp;
    f.tolerance = tolerance;
    f.iterations = iterations;
    f.dense = dense;
}

/// Makes room for the implicit solver's scratch for `particles` particles.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_reserve_particles(particles: u32) {
    world().fem.imp.reserve_particles(particles as usize);
}

/// Works out where every proxied cluster stands now (its velocities read the last substep of length `h`).
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_proxies(h: f32) {
    world().fem_proxies(h);
}

/// The number of tetrahedra in use.
#[unsafe(no_mangle)]
pub extern "C" fn soft_fem_count() -> u32 {
    world().fem.count as u32
}
