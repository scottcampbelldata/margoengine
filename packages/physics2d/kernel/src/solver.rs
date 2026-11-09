// The 2D contact solver: the soft step (Catto, "Solver2D", 2024): substeps (Macklin et al., "Small Steps in Physics
// Simulation", SCA 2019), soft constraints (Catto, "Soft Constraints", GDC 2011), relaxation and restitution last.
// Contacts are found once a step; each substep runs over the same points, their gap worked out again from how far the
// bodies have moved and turned since the step began:
//
//   integrate velocities; warm start; solve with bias; integrate poses; relax (no bias), as many times; then, once the
//   substeps are done, restitution, and the impulses are kept for the next step's warm start.
//
// The soft constraint is a spring and damper in implicit form, with omega = 2 pi hertz, a1 = 2 zeta + omega h,
// a2 = h omega a1, a3 = 1 / (1 + a2), bias rate omega / a1, mass scale a2 a3, impulse scale a3:
//
//   impulse = -(mass scale) m (v + bias) - (impulse scale) impulse_so_far
//
// which is the same as asking that v_new + bias + (k / a2) impulse_new = 0, k the inverse effective mass. A gap still open
// is a speculative row with no spring: it lets the bodies close the gap within this substep and no further.
//
// Two-point manifolds solve their normal rows together as one linear complementarity problem of size 2 (the block
// solver; total enumeration of the four complementary cases, Cottle, Pang, Stone, "The Linear Complementarity Problem",
// 1992, section 1.1; for contact, Catto, GDC 2006 and 2009 talks). The soft rows add k_ii / a2 to the diagonal, so
//
//   (K + C) impulse_new = K impulse_old - v - bias,  impulse_new >= 0,  (K + C) impulse_new - rhs >= 0, complementary,
//
// and the first of {both pushing, only the first, only the second, neither} that satisfies its signs is the answer.
// When K is ill conditioned (the two points nearly the same row), the rows are solved one at a time instead.
//
// Friction is Coulomb's, a tangent impulse per point cut to mu times that point's normal impulse. In the biased pass
// friction comes first, from the normal so far; in the relaxing pass the normal comes first, so the cone is what the
// relaxed normal holds (the same order as the 3D kernel, PK23).
//
// At one pass a substep, a contact between two dynamic bodies takes its spring at an eighth of the substep rate unless it
// carries more than CHAIN_LOAD times the lighter body's weight; contacts with static or kinematic bodies and heavily
// loaded ones keep a quarter. This is the 3D kernel's rule for deep piles (eb1947a05, Catto 2024's advice that the soft
// step's stiffness sit well below the substep rate); the proof is the same: the 20-row pyramid sleeps at one pass, and the
// 1:100 stack keeps the quarter's small sag (tests/world.rs).
//
// The solver works on its own compact copy of the bodies (Catto, "Solver2D", 2024, and "SIMD Matters", 2024, as
// descriptions of the layout): 32 bytes each, the velocity, the turn, a pad, the offset moved this step and the rotation turned
// this step, the last worked out once a body integrates instead of twice on every visit. A contact's visit reads two of
// those and its own 128-byte record; the world's large body records are read and written once a substep, and around the
// joint passes. The same operations in the same order: every bit as before (tests/bits.rs).
//
// The passes visit the contacts colour by colour (kernel-common colour.rs): no two contacts of a colour write the same
// body, so the visits inside a colour do not wait on each other, and the contacts are coloured from the top of the scene
// down along gravity, so the order of a sweep follows the pile, not the order its bodies were made in. Joints go first,
// one at a time, as before. Each colour is solved four contacts at a time in SIMD lanes (solver/wide.rs), every bit as
// one at a time; the overflow and restitution go one at a time.
use alloc::vec::Vec;
use margoengine_physics_kernel_common::colour::{COLOURS, Colouring, NONE, float_key};

use crate::joint::{self, Pass};
use crate::math::{Rot, V2};
use crate::world::{Kind, World, gravity_length};

mod wide;

/// 2 pi as the nearest f32.
const TAU: f32 = 6.283_185_5;
/// The heaviest load, in multiples of the lighter body's weight, a pair of dynamic bodies carries and still takes the
/// eighth-rate spring at one pass (see the header).
const CHAIN_LOAD: f32 = 50.0;
/// The block solve needs k11^2 < MAX_CONDITION det K; past it the rows are near parallel and go one at a time.
const MAX_CONDITION: f32 = 1000.0;

/// Scales of one soft constraint at one substep length.
#[derive(Clone, Copy, Debug)]
pub struct Soft {
    pub bias_rate: f32,
    pub mass_scale: f32,
    pub impulse_scale: f32,
}

/// The coefficients of a soft constraint at `hertz` and damping ratio `zeta` for substep `h`.
#[inline]
pub fn soft(hertz: f32, zeta: f32, h: f32) -> Soft {
    if hertz <= 0.0 {
        return Soft { bias_rate: 0.0, mass_scale: 1.0, impulse_scale: 0.0 };
    }
    let omega = TAU * hertz;
    let a1 = 2.0 * zeta + omega * h;
    let a2 = h * omega * a1;
    let a3 = 1.0 / (1.0 + a2);
    Soft { bias_rate: omega / a1, mass_scale: a2 * a3, impulse_scale: a3 }
}

#[derive(Clone, Copy, Default, Debug)]
struct Point {
    /// From each centre of mass to the point, in world space at the step's start.
    anchor_a: V2,
    anchor_b: V2,
    /// The gap less what the centres' offset along the normal gave at the step's start.
    base: f32,
    normal_impulse: f32,
    tangent_impulse: f32,
    normal_mass: f32,
    tangent_mass: f32,
}

/// One contact as the solver visits it: 128 bytes.
#[derive(Clone, Copy, Debug)]
struct Constraint {
    contact: u32,
    /// The two bodies' places in the solver's list.
    a: u32,
    b: u32,
    inv_mass_a: f32,
    inv_i_a: f32,
    inv_mass_b: f32,
    inv_i_b: f32,
    normal: V2,
    friction: f32,
    /// K for the block solve: k11, k12, k22.
    k: [f32; 3],
    points: [Point; 2],
    count: u8,
    /// Whether K is well conditioned for the block solve.
    block: bool,
    /// Whether the pair takes the eighth-rate spring in the biased passes (else the quarter).
    eighth: bool,
    /// Bit k: whether point k has pushed in any substep (restitution needs it).
    pushed: u8,
}

/// What restitution needs of a constraint, kept beside it: the pair's restitution and each point's normal speed at the
/// step's start, before anything was solved (what restitution reverses).
#[derive(Clone, Copy, Debug)]
struct Bounce {
    restitution: f32,
    approach: [f32; 2],
}

/// A body as the solver sees it. `moved` is how far its centre of mass has moved this step and `turn` the rotation it
/// has turned, its rotation now times the inverse of the one at the step's start.
#[derive(Clone, Copy, Debug)]
#[repr(C, align(16))]
struct SolverBody {
    v: V2,
    w: f32,
    /// Unused: it makes the velocity half 16 bytes, so the four-lane solve loads and stores it whole.
    pad: f32,
    moved: V2,
    turn: Rot,
}

/// Lists the solver keeps between steps so a step allocates nothing once the world has settled in size.
#[derive(Default)]
pub struct Scratch {
    constraints: Vec<Constraint>,
    bounces: Vec<Bounce>,
    /// The solver's bodies; `ids[i]` is the world body of `bodies[i]`, `slot[id]` the place of world body `id` plus 1
    /// (0: none yet), `start[i]` the rotation at the step's start of the first `moving` bodies, the awake ones that are
    /// not static. After them come the static and sleeping bodies a contact touches, which never move.
    bodies: Vec<SolverBody>,
    ids: Vec<u32>,
    slot: Vec<u32>,
    start: Vec<Rot>,
    /// The colouring of the contacts (its `order` the visiting order), the bodies each writes, and their keys.
    colouring: Colouring,
    writes: Vec<[u32; 2]>,
    keys: Vec<u32>,
    /// The colours' contacts in blocks of four for the four-lane solve.
    blocks: wide::Blocks,
    pub(crate) paths: joint::Paths,
}

/// Velocity and turn of a body while the solver works, read from and written back to the solver's bodies.
#[derive(Clone, Copy)]
struct Motion {
    v: V2,
    w: f32,
}

/// The place of world body `id` in the solver's list, adding it (it does not move this step) when it has none yet.
fn place(world: &World, bodies: &mut Vec<SolverBody>, ids: &mut Vec<u32>, slot: &mut [u32], id: u32) -> u32 {
    if slot[id as usize] == 0 {
        let body = &world.bodies[id as usize];
        bodies.push(SolverBody {
            v: body.linear_velocity,
            w: body.angular_velocity,
            pad: 0.0,
            moved: V2::ZERO,
            turn: body.xf.q.mul(inverse(body.xf.q)),
        });
        ids.push(id);
        slot[id as usize] = bodies.len() as u32;
    }
    slot[id as usize] - 1
}

/// Writes the solver's velocities to the world's bodies (before a joint pass, and at the end of the step).
fn write_velocities(world: &mut World, bodies: &[SolverBody], ids: &[u32]) {
    for (body, &id) in bodies.iter().zip(ids) {
        let target = &mut world.bodies[id as usize];
        target.linear_velocity = body.v;
        target.angular_velocity = body.w;
    }
}

/// Reads the world's velocities back into the solver's bodies (after a joint pass).
fn read_velocities(world: &World, bodies: &mut [SolverBody], ids: &[u32]) {
    for (body, &id) in bodies.iter_mut().zip(ids) {
        let source = &world.bodies[id as usize];
        body.v = source.linear_velocity;
        body.w = source.angular_velocity;
    }
}

#[inline(always)]
fn speed_at(m: Motion, r: V2) -> V2 {
    // v + w x r, with w along z.
    m.v.add(r.left().scale(m.w))
}

/// The separation of point `p` of constraint `c` now, from how far each body moved and turned this step.
#[inline]
fn gap(bodies: &[SolverBody], c: &Constraint, p: &Point) -> f32 {
    let (ba, bb) = (&bodies[c.a as usize], &bodies[c.b as usize]);
    let ra = ba.turn.apply(p.anchor_a);
    let rb = bb.turn.apply(p.anchor_b);
    let d = bb.moved.add(rb).sub(ba.moved.add(ra));
    c.normal.dot(d) + p.base
}

#[inline(always)]
fn inverse(q: Rot) -> Rot {
    Rot { c: q.c, s: -q.s }
}

/// One step of `dt` over the world's awake bodies and the contacts that touch one.
pub fn solve(world: &mut World, dt: f32) -> Result<(), crate::error::PhysicsError> {
    let settings = world.settings;
    let substeps = settings.substeps.max(1);
    let passes = settings.passes.max(1);
    let h = dt / substeps as f32;
    let inv_h = 1.0 / h;

    // The pair's spring: a quarter of the substep rate at most, an eighth for an unloaded chain pair at one pass.
    let quarter_rate = 0.25 * inv_h;
    let hertz = settings.contact_hertz.min(quarter_rate);
    let quarter = soft(hertz, settings.contact_damping, h);
    let eighth = soft(settings.contact_hertz.min(0.125 * inv_h), settings.contact_damping, h);
    let chain_limit = CHAIN_LOAD * h * gravity_length(&settings);

    let mut constraints = core::mem::take(&mut world.scratch.constraints);
    let mut bounces = core::mem::take(&mut world.scratch.bounces);
    let mut bodies = core::mem::take(&mut world.scratch.bodies);
    let mut ids = core::mem::take(&mut world.scratch.ids);
    let mut slot = core::mem::take(&mut world.scratch.slot);
    let mut start = core::mem::take(&mut world.scratch.start);
    constraints.clear();
    bounces.clear();
    bodies.clear();
    ids.clear();
    start.clear();
    slot.clear();
    slot.resize(world.bodies.len(), 0);
    // Start of step: every moving body's place, offset and rotation; the bodies after them join as contacts reach them.
    for (id, body) in world.bodies.iter().enumerate() {
        if body.kind != Kind::Static && body.awake {
            place(world, &mut bodies, &mut ids, &mut slot, id as u32);
            start.push(body.xf.q);
        }
    }
    let moving = bodies.len();
    // Each contact's colouring key: g . p of its first point, p taken from the first moving body's centre so a scene far
    // from the origin keys as one at it (see the colour order below).
    let (gx, gy) = (settings.gravity.x as f64, settings.gravity.y as f64);
    let origin = ids.first().map_or([0.0; 2], |&id| world.bodies[id as usize].exact_center);
    let mut keys = core::mem::take(&mut world.scratch.keys);
    keys.clear();
    for (index, contact) in world.contacts.iter().enumerate() {
        if !contact.touching() {
            continue;
        }
        let (sa, sb) = (&world.shapes[contact.a as usize], &world.shapes[contact.b as usize]);
        let (a, b) = (sa.body, sb.body);
        let (ba, bb) = (&world.bodies[a as usize], &world.bodies[b as usize]);
        let dyn_a = ba.is_dynamic() && ba.awake;
        let dyn_b = bb.is_dynamic() && bb.awake;
        if !dyn_a && !dyn_b {
            continue;
        }
        let m = &contact.manifold;
        let n = m.normal;
        let t = n.right();
        let (ima, iia) = if ba.is_dynamic() { (ba.inv_mass, ba.inv_inertia) } else { (0.0, 0.0) };
        let (imb, iib) = if bb.is_dynamic() { (bb.inv_mass, bb.inv_inertia) } else { (0.0, 0.0) };
        let mut c = Constraint {
            contact: index as u32,
            a: place(world, &mut bodies, &mut ids, &mut slot, a),
            b: place(world, &mut bodies, &mut ids, &mut slot, b),
            inv_mass_a: ima,
            inv_i_a: iia,
            inv_mass_b: imb,
            inv_i_b: iib,
            normal: n,
            friction: sqrt_product(sa.friction, sb.friction),
            k: [0.0; 3],
            points: [Point::default(); 2],
            count: m.count as u8,
            block: false,
            eighth: false,
            pushed: 0,
        };
        let mut bounce = Bounce { restitution: sa.restitution.max(sb.restitution), approach: [0.0; 2] };
        let (ma, mb) = (Motion { v: ba.linear_velocity, w: ba.angular_velocity }, Motion { v: bb.linear_velocity, w: bb.angular_velocity });
        let mut load = 0.0f32;
        // The manifold's points are relative to A's centre already.
        let offset_b = bb.center_from(ba.exact_center);
        for k in 0..m.count {
            let mp = &m.points[k];
            let ra = mp.point;
            let rb = mp.point.sub(offset_b);
            let (rna, rnb) = (ra.cross(n), rb.cross(n));
            let (rta, rtb) = (ra.cross(t), rb.cross(t));
            let kn = ima + imb + iia * rna * rna + iib * rnb * rnb;
            let kt = ima + imb + iia * rta * rta + iib * rtb * rtb;
            if !kn.is_finite() || !kt.is_finite() || kn < 0.0 || kt < 0.0
                || kn > 0.0 && !(1.0 / kn).is_finite() || kt > 0.0 && !(1.0 / kt).is_finite() {
                return Err(crate::error::PhysicsError::ArithmeticOverflow);
            }
            let dv = speed_at(mb, rb).sub(speed_at(ma, ra));
            let approach = n.dot(dv);
            let base = mp.separation - n.dot(rb.sub(ra));
            if !dv.x.is_finite() || !dv.y.is_finite() || !approach.is_finite() || !base.is_finite() {
                return Err(crate::error::PhysicsError::ArithmeticOverflow);
            }
            c.points[k] = Point {
                anchor_a: ra,
                anchor_b: rb,
                base,
                normal_impulse: contact.normal_impulse[k],
                tangent_impulse: contact.tangent_impulse[k],
                normal_mass: if kn > 0.0 { 1.0 / kn } else { 0.0 },
                tangent_mass: if kt > 0.0 { 1.0 / kt } else { 0.0 },
            };
            bounce.approach[k] = approach;
            load += contact.normal_impulse[k];
        }
        if m.count == 2 {
            let (p, q) = (&c.points[0], &c.points[1]);
            let (r1a, r1b, r2a, r2b) = (p.anchor_a.cross(n), p.anchor_b.cross(n), q.anchor_a.cross(n), q.anchor_b.cross(n));
            let k11 = ima + imb + iia * r1a * r1a + iib * r1b * r1b;
            let k22 = ima + imb + iia * r2a * r2a + iib * r2b * r2b;
            let k12 = ima + imb + iia * r1a * r2a + iib * r1b * r2b;
            if !k12.is_finite() { return Err(crate::error::PhysicsError::ArithmeticOverflow); }
            c.k = [k11, k12, k22];
            c.block = settings.block_solver && k11 * k11 < MAX_CONDITION * (k11 * k22 - k12 * k12);
        }
        if passes < 2 && ba.kind == Kind::Dynamic && bb.kind == Kind::Dynamic && load * ima.max(imb) < chain_limit {
            c.eighth = true;
        }
        let (centre, p) = (ba.exact_center, c.points[0].anchor_a);
        keys.push(float_key((gx * (centre[0] - origin[0] + p.x as f64) + gy * (centre[1] - origin[1] + p.y as f64)) as f32));
        constraints.push(c);
        bounces.push(bounce);
    }
    world.counts.constraints = constraints.len() as u64;
    // Colour order: the passes below visit the contacts colour by colour, the overflow last. Inside a colour no two
    // contacts write the same body, so the visits are independent of each other. The contacts are coloured from the top
    // of the scene down along gravity (the key: g . p of the first point, lowest first; see colour.rs).
    let scratch = &mut world.scratch;
    scratch.writes.clear();
    scratch.writes.extend(constraints.iter().map(writes));
    scratch.colouring.build(bodies.len(), &scratch.writes, &keys);
    scratch.keys = keys;
    // The constraints stay where they were made; `order` lists them in visiting order.
    let colouring = core::mem::take(&mut scratch.colouring);
    let order = &colouring.order[..];
    world.counts.colours = colouring.used() as u64;
    world.counts.overflow = colouring.overflow() as u64;
    let starts = colouring.starts;
    // The colours go to the four-lane solve, the overflow one at a time after them, in the same order as one at a time.
    let lanes = settings.contact_lanes || cfg!(target_arch = "wasm32");
    let single = if lanes { starts[COLOURS] as usize } else { 0 };
    let mut blocks = core::mem::take(&mut scratch.blocks);
    blocks.blocks.clear();
    blocks.ends.clear();
    if lanes {
        for k in 0..COLOURS {
            blocks.push(&constraints, &order[starts[k] as usize..starts[k + 1] as usize]);
        }
    }
    let wide_springs = wide::Springs { quarter, eighth };
    let joints = !world.joints.is_empty();

    let g = settings.gravity;
    let (mut block, mut sequential) = (0u64, 0u64);
    // Joint passes: relaxing unless marked biased.
    let mut paths = core::mem::take(&mut world.scratch.paths);
    joint::build_paths(world, &mut paths);
    let joint_pass = Pass { h, inv_h, biased: false, spring: joint::joint_spring(settings.joint_hertz, settings.joint_damping, h), max_push: settings.joint_max_push };
    let springs = [quarter, eighth];
    let max_push = settings.contact_max_push;
    // Whether the bodies have moved since the four-lane solve last worked out its gaps (see wide::solve).
    let mut fresh = true;
    for _ in 0..substeps {
        for (body, &id) in bodies[..moving].iter_mut().zip(&ids) {
            let source = &world.bodies[id as usize];
            if source.kind != Kind::Dynamic {
                continue;
            }
            let v = body.v.add(g.scale(h * source.gravity_scale));
            body.v = v.scale(1.0 / (1.0 + h * source.linear_damping));
            body.w *= 1.0 / (1.0 + h * source.angular_damping);
        }
        wide::warm_start(&mut bodies, &blocks.blocks);
        for &i in &order[single..] {
            warm_start(&mut bodies, &constraints[i as usize]);
        }
        if joints {
            write_velocities(world, &bodies, &ids);
            joint::warm_start(world, &mut paths, h, settings.joint_geometric_stiffness);
            read_velocities(world, &mut bodies, &ids);
        }
        for _ in 0..passes {
            if joints {
                write_velocities(world, &bodies, &ids);
                joint::solve(world, &mut paths, &Pass { biased: true, ..joint_pass });
                read_velocities(world, &mut bodies, &ids);
            }
            let (b, s) = wide::solve(&mut bodies, &mut blocks, true, fresh, inv_h, max_push, &wide_springs);
            fresh = false;
            block += b;
            sequential += s;
            for &i in &order[single..] {
                let (b, s) = solve_contact(&mut bodies, &mut constraints[i as usize], true, inv_h, max_push, &springs);
                block += b;
                sequential += s;
            }
        }
        for ((body, &id), start) in bodies[..moving].iter_mut().zip(&ids).zip(&start) {
            let target = &mut world.bodies[id as usize];
            let step = body.v.scale(h);
            target.exact_center = [target.exact_center[0] + step.x as f64, target.exact_center[1] + step.y as f64];
            body.moved = body.moved.add(step);
            target.xf.q = target.xf.q.integrate(h * body.w);
            body.turn = target.xf.q.mul(inverse(*start));
        }
        fresh = true;
        for _ in 0..passes {
            if joints {
                write_velocities(world, &bodies, &ids);
                joint::solve(world, &mut paths, &joint_pass);
                read_velocities(world, &mut bodies, &ids);
            }
            let (b, s) = wide::solve(&mut bodies, &mut blocks, false, fresh, inv_h, max_push, &wide_springs);
            fresh = false;
            block += b;
            sequential += s;
            for &i in &order[single..] {
                let (b, s) = solve_contact(&mut bodies, &mut constraints[i as usize], false, inv_h, max_push, &springs);
                block += b;
                sequential += s;
            }
        }
    }
    world.counts.block = block;
    world.counts.sequential = sequential;
    if lanes {
        let mut first = 0;
        for k in 0..COLOURS {
            first += blocks.write_back(first, &mut constraints, &order[starts[k] as usize..starts[k + 1] as usize]);
        }
    }

    let threshold = settings.restitution_threshold;
    for &i in order {
        let (c, bounce) = (&mut constraints[i as usize], &bounces[i as usize]);
        if bounce.restitution == 0.0 {
            continue;
        }
        let (mut ma, mut mb) = motions(&bodies, c);
        for k in 0..c.count as usize {
            let p = c.points[k];
            if bounce.approach[k] > -threshold || c.pushed & (1 << k) == 0 {
                continue;
            }
            let vn = c.normal.dot(speed_at(mb, p.anchor_b).sub(speed_at(ma, p.anchor_a)));
            let impulse = -p.normal_mass * (vn + bounce.restitution * bounce.approach[k]);
            let total = (p.normal_impulse + impulse).max(0.0);
            c.points[k].normal_impulse = total;
            apply(c, &mut ma, &mut mb, &p, c.normal.scale(total - p.normal_impulse));
        }
        store(&mut bodies, c, ma, mb);
    }
    write_velocities(world, &bodies, &ids);

    for c in &constraints {
        let contact = &mut world.contacts[c.contact as usize];
        for k in 0..c.count as usize {
            contact.normal_impulse[k] = c.points[k].normal_impulse;
            contact.tangent_impulse[k] = c.points[k].tangent_impulse;
        }
    }
    for &id in &ids[..moving] {
        world.bodies[id as usize].round_pose();
    }
    world.scratch.constraints = constraints;
    world.scratch.bounces = bounces;
    world.scratch.bodies = bodies;
    world.scratch.ids = ids;
    world.scratch.slot = slot;
    world.scratch.start = start;
    world.scratch.paths = paths;
    world.scratch.blocks = blocks;
    world.scratch.colouring = colouring;
    Ok(())
}

/// sqrt(a b): the friction of two materials.
#[inline]
fn sqrt_product(a: f32, b: f32) -> f32 {
    let product = a * b;
    if product.is_finite() { return crate::math::sqrt(product); }
    // Finite nonnegative material coefficients can have an overflowing product but a representable mean.
    // In this branch smaller>1, so the ratio cannot underflow to zero; ratio<=1 proves the result<=larger.
    let (larger, smaller) = if a > b { (a, b) } else { (b, a) };
    larger * crate::math::sqrt(smaller / larger)
}

/// The solver bodies contact `c` writes, `NONE` for one it only reads (static, kinematic): what `store` writes.
fn writes(c: &Constraint) -> [u32; 2] {
    let a = if c.inv_mass_a > 0.0 || c.inv_i_a > 0.0 { c.a } else { NONE };
    let b = if c.inv_mass_b > 0.0 || c.inv_i_b > 0.0 { c.b } else { NONE };
    [a, b]
}

#[inline(always)]
fn motions(bodies: &[SolverBody], c: &Constraint) -> (Motion, Motion) {
    let (ba, bb) = (&bodies[c.a as usize], &bodies[c.b as usize]);
    (Motion { v: ba.v, w: ba.w }, Motion { v: bb.v, w: bb.w })
}

#[inline(always)]
fn store(bodies: &mut [SolverBody], c: &Constraint, ma: Motion, mb: Motion) {
    if c.inv_mass_a > 0.0 || c.inv_i_a > 0.0 {
        let body = &mut bodies[c.a as usize];
        body.v = ma.v;
        body.w = ma.w;
    }
    if c.inv_mass_b > 0.0 || c.inv_i_b > 0.0 {
        let body = &mut bodies[c.b as usize];
        body.v = mb.v;
        body.w = mb.w;
    }
}

/// Applies impulse `j` (from A to B) at point `p`.
#[inline(always)]
fn apply(c: &Constraint, ma: &mut Motion, mb: &mut Motion, p: &Point, j: V2) {
    ma.v = ma.v.sub(j.scale(c.inv_mass_a));
    ma.w -= c.inv_i_a * p.anchor_a.cross(j);
    mb.v = mb.v.add(j.scale(c.inv_mass_b));
    mb.w += c.inv_i_b * p.anchor_b.cross(j);
}

fn warm_start(bodies: &mut [SolverBody], c: &Constraint) {
    let (mut ma, mut mb) = motions(bodies, c);
    let t = c.normal.right();
    for p in &c.points[..c.count as usize] {
        let j = c.normal.scale(p.normal_impulse).add(t.scale(p.tangent_impulse));
        apply(c, &mut ma, &mut mb, p, j);
    }
    store(bodies, c, ma, mb);
}

/// `a` if it is above `b`, else `b`: a compare and a select, as the four-lane solve does it (f32::max's rules for zeros
/// and NaN differ between targets).
#[inline(always)]
fn larger(a: f32, b: f32) -> f32 {
    if a > b { a } else { b }
}

/// One row's terms: the bias, and the soft scales (1 and 0 for a rigid row).
#[inline(always)]
fn row(spring: &Soft, s: f32, biased: bool, inv_h: f32, max_push: f32) -> (f32, f32, f32) {
    if s > 0.0 {
        (s * inv_h, 1.0, 0.0)
    } else if biased {
        (larger(spring.bias_rate * s, -max_push), spring.mass_scale, spring.impulse_scale)
    } else {
        (0.0, 1.0, 0.0)
    }
}

/// One pass over one contact: friction and normal, in the pass's order. Returns (block solves, sequential fallbacks).
fn solve_contact(bodies: &mut [SolverBody], c: &mut Constraint, biased: bool, inv_h: f32, max_push: f32, springs: &[Soft; 2]) -> (u64, u64) {
    let (mut ma, mut mb) = motions(bodies, c);
    let mut gaps = [0.0f32; 2];
    for k in 0..c.count as usize {
        gaps[k] = gap(bodies, c, &c.points[k]);
    }
    if biased {
        friction(c, &mut ma, &mut mb);
    }
    let spring = &springs[c.eighth as usize];
    let counts = normal(c, &mut ma, &mut mb, gaps, biased, inv_h, max_push, spring);
    if !biased {
        friction(c, &mut ma, &mut mb);
    }
    store(bodies, c, ma, mb);
    counts
}

fn friction(c: &mut Constraint, ma: &mut Motion, mb: &mut Motion) {
    let t = c.normal.right();
    let mu = c.friction;
    for k in 0..c.count as usize {
        let p = c.points[k];
        let vt = t.dot(speed_at(*mb, p.anchor_b).sub(speed_at(*ma, p.anchor_a)));
        let limit = mu * p.normal_impulse;
        let total = crate::math::clamp(p.tangent_impulse - p.tangent_mass * vt, -limit, limit);
        let applied = total - p.tangent_impulse;
        c.points[k].tangent_impulse = total;
        apply(c, ma, mb, &p, t.scale(applied));
    }
}

#[allow(clippy::too_many_arguments)]
fn normal(c: &mut Constraint, ma: &mut Motion, mb: &mut Motion, gaps: [f32; 2], biased: bool, inv_h: f32, max_push: f32, spring: &Soft) -> (u64, u64) {
    let n = c.normal;
    if c.count == 2 && c.block {
        let (p, q) = (c.points[0], c.points[1]);
        let (b1, ms1, is1) = row(spring, gaps[0], biased, inv_h, max_push);
        let (b2, ms2, is2) = row(spring, gaps[1], biased, inv_h, max_push);
        let [k11, k12, k22] = c.k;
        // The soft rows' diagonal terms k_ii / a2 = k_ii (impulse scale / mass scale).
        let m11 = k11 + k11 * (is1 / ms1);
        let m22 = k22 + k22 * (is2 / ms2);
        let v1 = n.dot(speed_at(*mb, p.anchor_b).sub(speed_at(*ma, p.anchor_a)));
        let v2 = n.dot(speed_at(*mb, q.anchor_b).sub(speed_at(*ma, q.anchor_a)));
        let (l1, l2) = (p.normal_impulse, q.normal_impulse);
        let r1 = k11 * l1 + k12 * l2 - v1 - b1;
        let r2 = k12 * l1 + k22 * l2 - v2 - b2;
        let det = m11 * m22 - k12 * k12;
        let mut answer = None;
        if det > 0.0 {
            let x1 = (m22 * r1 - k12 * r2) / det;
            let x2 = (m11 * r2 - k12 * r1) / det;
            if x1 >= 0.0 && x2 >= 0.0 {
                answer = Some((x1, x2));
            }
        }
        if answer.is_none() {
            let x1 = r1 / m11;
            if x1 >= 0.0 && k12 * x1 - r2 >= 0.0 {
                answer = Some((x1, 0.0));
            }
        }
        if answer.is_none() {
            let x2 = r2 / m22;
            if x2 >= 0.0 && k12 * x2 - r1 >= 0.0 {
                answer = Some((0.0, x2));
            }
        }
        if answer.is_none() && r1 <= 0.0 && r2 <= 0.0 {
            answer = Some((0.0, 0.0));
        }
        if let Some((x1, x2)) = answer {
            let (d1, d2) = (x1 - l1, x2 - l2);
            c.points[0].normal_impulse = x1;
            c.points[1].normal_impulse = x2;
            c.pushed |= (x1 > 0.0) as u8 | ((x2 > 0.0) as u8) << 1;
            apply(c, ma, mb, &p, n.scale(d1));
            apply(c, ma, mb, &q, n.scale(d2));
            return (1, 0);
        }
        // Rounding left no case standing: the rows one at a time.
        sequential_normal(c, ma, mb, gaps, biased, inv_h, max_push, spring);
        return (0, 1);
    }
    sequential_normal(c, ma, mb, gaps, biased, inv_h, max_push, spring);
    (0, (c.count == 2) as u64)
}

#[allow(clippy::too_many_arguments)]
fn sequential_normal(c: &mut Constraint, ma: &mut Motion, mb: &mut Motion, gaps: [f32; 2], biased: bool, inv_h: f32, max_push: f32, spring: &Soft) {
    let n = c.normal;
    for k in 0..c.count as usize {
        let p = c.points[k];
        let (bias, mass_scale, impulse_scale) = row(spring, gaps[k], biased, inv_h, max_push);
        let vn = n.dot(speed_at(*mb, p.anchor_b).sub(speed_at(*ma, p.anchor_a)));
        let impulse = -p.normal_mass * mass_scale * (vn + bias) - impulse_scale * p.normal_impulse;
        let total = larger(p.normal_impulse + impulse, 0.0);
        let applied = total - p.normal_impulse;
        c.points[k].normal_impulse = total;
        c.pushed |= ((total > 0.0) as u8) << k;
        apply(c, ma, mb, &p, n.scale(applied));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_visit_reads_two_32_byte_bodies_and_a_128_byte_contact() {
        // 32 bytes on 16-byte bounds: the four-lane solve loads each half (v, w, pad; moved, turn) whole.
        assert_eq!(core::mem::size_of::<SolverBody>(), 32);
        assert_eq!(core::mem::align_of::<SolverBody>(), 16);
        assert_eq!(core::mem::size_of::<Constraint>(), 128);
    }

    #[test]
    fn material_mean_preserves_finite_product_bits_and_handles_overflowing_products() {
        for (a, b) in [(0.0, f32::MAX), (0.3, 0.7), (1.234_567, 8.765_432), (f32::MIN_POSITIVE, f32::MAX)] {
            assert_eq!(sqrt_product(a, b).to_bits(), crate::math::sqrt(a * b).to_bits());
        }
        for (a, b) in [(1.0e20, 1.0e20), (f32::MAX, f32::MAX), (f32::MAX, 1.234_567), (2.0e19, 3.0e19)] {
            let actual = sqrt_product(a, b);
            let reference = ((a as f64) * (b as f64)).sqrt();
            assert!(actual.is_finite() && actual >= a.min(b) && actual <= a.max(b));
            assert!(((actual as f64) - reference).abs() <= 8.0 * f32::EPSILON as f64 * reference);
            assert_eq!(actual.to_bits(), sqrt_product(b, a).to_bits());
        }
    }
}
