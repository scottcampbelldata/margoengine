// The 2D contact solver: the soft step (Catto, "Solver2D", 2024): substeps (Macklin et al., "Small Steps in Physics
// Simulation", SCA 2019), soft constraints (Catto, "Soft Constraints", GDC 2011), relaxation and restitution last.
// Contacts are found once a step; each substep runs over the same points, their gap worked out again from how far the
// bodies have moved and turned since the step began:
//
//   integrate velocities; warm start; solve with bias; certified support correction; integrate poses; relax (no bias);
//   repeat for each substep, then, once the
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
// The recovery cap applies to bias+C*impulse, so it bounds new recovery without imposing an elastic load ceiling.
// A certified uncapped answer keeps the ordinary f32 algebra; other rows use the capped NCP's scalar/two-row roots.
// path_support corrects slow supported-path equilibrium modes while retaining the original spring root and cap.
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
// joint passes. Scalar and SIMD common rows retain the same operation order; support correction changes results
// intentionally; the mixed-scene pin records this correction, with scalar, SIMD and Wasm equality checked.
//
// The passes visit the contacts colour by colour (kernel-common colour.rs): no two contacts of a colour write the same
// body, so the visits inside a colour do not wait on each other, and the contacts are coloured from the top of the scene
// down along gravity, so the order of a sweep follows the pile, not the order its bodies were made in. Joints go first,
// one at a time, as before. Each colour is solved four contacts at a time in SIMD lanes (solver/wide.rs), every bit as
// one at a time; the overflow and restitution go one at a time.
use crate::error::PhysicsError;
use alloc::vec::Vec;
use margoengine_physics_kernel_common::colour::{COLOURS, Colouring, NONE, float_key};

use crate::joint::{self, Pass};
use crate::math::{Rot, V2};
use crate::world::{Kind, World, gravity_length};

mod path_support;
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
        return Soft {
            bias_rate: 0.0,
            mass_scale: 1.0,
            impulse_scale: 0.0,
        };
    }
    let omega = TAU * hertz;
    let a1 = 2.0 * zeta + omega * h;
    let a2 = h * omega * a1;
    let a3 = 1.0 / (1.0 + a2);
    Soft {
        bias_rate: omega / a1,
        mass_scale: a2 * a3,
        impulse_scale: a3,
    }
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

/// Retained ordinary-solver workspace. Certified path proposals currently also use local temporary buffers.
#[derive(Default)]
pub struct Scratch {
    pub(crate) pose_speed: Vec<f32>,
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
fn place(
    world: &World,
    bodies: &mut Vec<SolverBody>,
    ids: &mut Vec<u32>,
    slot: &mut [u32],
    id: u32,
) -> u32 {
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
pub fn solve(world: &mut World, dt: f32) -> Result<(), PhysicsError> {
    let settings = world.settings;
    if !settings.contact_max_push.is_finite() || settings.contact_max_push < 0.0 {
        return Err(PhysicsError::InvalidParameter);
    }
    let substeps = settings.substeps.max(1);
    let passes = settings.passes.max(1);
    let h = dt / substeps as f32;
    let inv_h = 1.0 / h;
    if !(h > 0.0 && h.is_finite() && inv_h.is_finite()) {
        return Err(PhysicsError::ArithmeticOverflow);
    }
    let mut pose_speed = core::mem::take(&mut world.scratch.pose_speed);
    pose_speed.clear();
    pose_speed.resize(world.bodies.len(), 0.0f32);

    // The pair's spring: a quarter of the substep rate at most, an eighth for an unloaded chain pair at one pass.
    let quarter_rate = 0.25 * inv_h;
    let hertz = settings.contact_hertz.min(quarter_rate);
    let quarter = soft(hertz, settings.contact_damping, h);
    let eighth = soft(
        settings.contact_hertz.min(0.125 * inv_h),
        settings.contact_damping,
        h,
    );
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
    let origin = ids
        .first()
        .map_or([0.0; 2], |&id| world.bodies[id as usize].exact_center);
    let mut keys = core::mem::take(&mut world.scratch.keys);
    keys.clear();
    for (index, contact) in world.contacts.iter().enumerate() {
        if !contact.touching() {
            continue;
        }
        let (sa, sb) = (
            &world.shapes[contact.a as usize],
            &world.shapes[contact.b as usize],
        );
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
        let (ima, iia) = if ba.is_dynamic() {
            (ba.inv_mass, ba.inv_inertia)
        } else {
            (0.0, 0.0)
        };
        let (imb, iib) = if bb.is_dynamic() {
            (bb.inv_mass, bb.inv_inertia)
        } else {
            (0.0, 0.0)
        };
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
        let mut bounce = Bounce {
            restitution: sa.restitution.max(sb.restitution),
            approach: [0.0; 2],
        };
        let (ma, mb) = (
            Motion {
                v: ba.linear_velocity,
                w: ba.angular_velocity,
            },
            Motion {
                v: bb.linear_velocity,
                w: bb.angular_velocity,
            },
        );
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
            if !kn.is_finite()
                || !kt.is_finite()
                || kn < 0.0
                || kt < 0.0
                || kn > 0.0 && !(1.0 / kn).is_finite()
                || kt > 0.0 && !(1.0 / kt).is_finite()
            {
                return Err(crate::error::PhysicsError::ArithmeticOverflow);
            }
            c.k[if k == 0 { 0 } else { 2 }] = kn;
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
            let (r1a, r1b, r2a, r2b) = (
                p.anchor_a.cross(n),
                p.anchor_b.cross(n),
                q.anchor_a.cross(n),
                q.anchor_b.cross(n),
            );
            let k11 = ima + imb + iia * r1a * r1a + iib * r1b * r1b;
            let k22 = ima + imb + iia * r2a * r2a + iib * r2b * r2b;
            let k12 = ima + imb + iia * r1a * r2a + iib * r1b * r2b;
            if !k12.is_finite() {
                return Err(crate::error::PhysicsError::ArithmeticOverflow);
            }
            c.k = [k11, k12, k22];
            c.block = settings.block_solver && k11 * k11 < MAX_CONDITION * (k11 * k22 - k12 * k12);
        }
        if passes < 2
            && ba.kind == Kind::Dynamic
            && bb.kind == Kind::Dynamic
            && load * ima.max(imb) < chain_limit
        {
            c.eighth = true;
        }
        let (centre, p) = (ba.exact_center, c.points[0].anchor_a);
        keys.push(float_key(
            (gx * (centre[0] - origin[0] + p.x as f64) + gy * (centre[1] - origin[1] + p.y as f64))
                as f32,
        ));
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
    scratch
        .colouring
        .build(bodies.len(), &scratch.writes, &keys);
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
            blocks.push(
                &constraints,
                &order[starts[k] as usize..starts[k + 1] as usize],
            );
        }
    }
    let wide_springs = wide::Springs { quarter, eighth };
    let joints = !world.joints.is_empty();

    let g = settings.gravity;
    let (mut block, mut sequential) = (0u64, 0u64);
    // Joint passes: relaxing unless marked biased.
    let mut paths = core::mem::take(&mut world.scratch.paths);
    joint::build_paths(world, &mut paths);
    let joint_pass = Pass {
        h,
        inv_h,
        biased: false,
        spring: joint::joint_spring(settings.joint_hertz, settings.joint_damping, h),
        max_push: settings.joint_max_push,
    };
    let springs = [quarter, eighth];
    let max_push = settings.contact_max_push;
    let mut support_plan = path_support::plan(world, &ids, &constraints, &bounces);
    // Whether the bodies have moved since the four-lane solve last worked out its gaps (see wide::solve).
    let mut fresh = true;
    let mut substep_pose_speed = alloc::vec![0.0f32;world.bodies.len()];
    for _ in 0..substeps {
        substep_pose_speed.fill(0.0);
        if let Some(plan) = &mut support_plan {
            plan.snapshot(&bodies, &constraints);
        }
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
                joint::solve(
                    world,
                    &mut paths,
                    &Pass {
                        biased: true,
                        ..joint_pass
                    },
                );
                read_velocities(world, &mut bodies, &ids);
            }
            let (b, s) = wide::solve(
                &mut bodies,
                &mut blocks,
                true,
                fresh,
                inv_h,
                max_push,
                &wide_springs,
            )?;
            fresh = false;
            block += b;
            sequential += s;
            for &i in &order[single..] {
                let (b, s) = solve_contact(
                    &mut bodies,
                    &mut constraints[i as usize],
                    true,
                    inv_h,
                    max_push,
                    &springs,
                )?;
                block += b;
                sequential += s;
            }
        }
        if let Some(plan) = &support_plan {
            if lanes {
                let mut first = 0;
                for k in 0..COLOURS {
                    first += blocks.write_back(
                        first,
                        &mut constraints,
                        &order[starts[k] as usize..starts[k + 1] as usize],
                    );
                }
            }
            path_support::stabilize(
                plan,
                world,
                &mut bodies,
                &ids,
                &start,
                &mut constraints,
                &bounces,
                h,
                h,
                &springs,
                &mut substep_pose_speed,
            );
            if lanes {
                let mut first = 0;
                for k in 0..COLOURS {
                    first += blocks.read_impulses(
                        first,
                        &constraints,
                        &order[starts[k] as usize..starts[k + 1] as usize],
                    );
                }
            }
        }
        for ((body, &id), start) in bodies[..moving].iter_mut().zip(&ids).zip(&start) {
            let target = &mut world.bodies[id as usize];
            let step = body.v.scale(h);
            substep_pose_speed[id as usize] += body.v.length() + target.extent * body.w.abs();
            target.exact_center = [
                target.exact_center[0] + step.x as f64,
                target.exact_center[1] + step.y as f64,
            ];
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
            let (b, s) = wide::solve(
                &mut bodies,
                &mut blocks,
                false,
                fresh,
                inv_h,
                max_push,
                &wide_springs,
            )?;
            fresh = false;
            block += b;
            sequential += s;
            for &i in &order[single..] {
                let (b, s) = solve_contact(
                    &mut bodies,
                    &mut constraints[i as usize],
                    false,
                    inv_h,
                    max_push,
                    &springs,
                )?;
                block += b;
                sequential += s;
            }
        }
        for (observed, &substep) in pose_speed.iter_mut().zip(&substep_pose_speed) {
            *observed = observed.max(substep);
        }
    }
    world.counts.block = block;
    world.counts.sequential = sequential;
    if lanes {
        let mut first = 0;
        for k in 0..COLOURS {
            first += blocks.write_back(
                first,
                &mut constraints,
                &order[starts[k] as usize..starts[k + 1] as usize],
            );
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
            let vn = c
                .normal
                .dot(speed_at(mb, p.anchor_b).sub(speed_at(ma, p.anchor_a)));
            let impulse = -p.normal_mass * (vn + bounce.restitution * bounce.approach[k]);
            let total = (p.normal_impulse + impulse).max(0.0);
            c.points[k].normal_impulse = total;
            apply(
                c,
                &mut ma,
                &mut mb,
                &p,
                c.normal.scale(total - p.normal_impulse),
            );
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
    world.scratch.pose_speed = pose_speed;
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
    if product.is_finite() {
        return crate::math::sqrt(product);
    }
    // Finite nonnegative material coefficients can have an overflowing product but a representable mean.
    // In this branch smaller>1, so the ratio cannot underflow to zero; ratio<=1 proves the result<=larger.
    let (larger, smaller) = if a > b { (a, b) } else { (b, a) };
    larger * crate::math::sqrt(smaller / larger)
}

/// The solver bodies contact `c` writes, `NONE` for one it only reads (static, kinematic): what `store` writes.
fn writes(c: &Constraint) -> [u32; 2] {
    let a = if c.inv_mass_a > 0.0 || c.inv_i_a > 0.0 {
        c.a
    } else {
        NONE
    };
    let b = if c.inv_mass_b > 0.0 || c.inv_i_b > 0.0 {
        c.b
    } else {
        NONE
    };
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
        let j = c
            .normal
            .scale(p.normal_impulse)
            .add(t.scale(p.tangent_impulse));
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
fn row(spring: &Soft, s: f32, biased: bool, inv_h: f32, _max_push: f32) -> (f32, f32, f32) {
    if s > 0.0 {
        (s * inv_h, 1.0, 0.0)
    } else if biased {
        (
            spring.bias_rate * s,
            spring.mass_scale,
            spring.impulse_scale,
        )
    } else {
        (0.0, 1.0, 0.0)
    }
}

/// One pass over one contact: friction and normal, in the pass's order. Returns (block solves, sequential fallbacks).
fn solve_contact(
    bodies: &mut [SolverBody],
    c: &mut Constraint,
    biased: bool,
    inv_h: f32,
    max_push: f32,
    springs: &[Soft; 2],
) -> Result<(u64, u64), PhysicsError> {
    let (mut ma, mut mb) = motions(bodies, c);
    let mut gaps = [0.0f32; 2];
    for k in 0..c.count as usize {
        gaps[k] = gap(bodies, c, &c.points[k]);
    }
    if biased {
        friction(c, &mut ma, &mut mb);
    }
    let spring = &springs[c.eighth as usize];
    let counts = normal(c, &mut ma, &mut mb, gaps, biased, inv_h, max_push, spring)?;
    if !biased {
        friction(c, &mut ma, &mut mb);
    }
    store(bodies, c, ma, mb);
    Ok(counts)
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
fn normal(
    c: &mut Constraint,
    ma: &mut Motion,
    mb: &mut Motion,
    gaps: [f32; 2],
    biased: bool,
    inv_h: f32,
    max_push: f32,
    spring: &Soft,
) -> Result<(u64, u64), PhysicsError> {
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
        let c1 = if biased && gaps[0] <= 0.0 {
            k11 as f64 * (is1 as f64 / ms1 as f64)
        } else {
            0.0
        };
        let c2 = if biased && gaps[1] <= 0.0 {
            k22 as f64 * (is2 as f64 / ms2 as f64)
        } else {
            0.0
        };
        if let Some((x1, x2)) = answer {
            let valid = x1.is_finite()
                && x2.is_finite()
                && [m11, m22, det, r1, r2].into_iter().all(f32::is_finite)
                && c1.is_finite()
                && c2.is_finite()
                && c1 >= 0.0
                && c2 >= 0.0
                && (x1 == 0.0
                    || !(biased && gaps[0] <= 0.0)
                    || b1 as f64 + c1 * x1 as f64 >= -(max_push as f64))
                && (x2 == 0.0
                    || !(biased && gaps[1] <= 0.0)
                    || b2 as f64 + c2 * x2 as f64 >= -(max_push as f64));
            if !valid {
                answer = None;
            }
        }
        if answer.is_none() {
            answer = capped_block(
                [k11, k12, k22],
                [b1, b2],
                [c1, c2],
                [v1, v2],
                [l1, l2],
                [biased && gaps[0] <= 0.0, biased && gaps[1] <= 0.0],
                max_push,
            )?;
        }
        if let Some((x1, x2)) = answer {
            let (d1, d2) = (x1 - l1, x2 - l2);
            c.points[0].normal_impulse = x1;
            c.points[1].normal_impulse = x2;
            c.pushed |= (x1 > 0.0) as u8 | ((x2 > 0.0) as u8) << 1;
            apply(c, ma, mb, &p, n.scale(d1));
            apply(c, ma, mb, &q, n.scale(d2));
            return Ok((1, 0));
        }
        // Rounding left no case standing: the rows one at a time.
        sequential_normal(c, ma, mb, gaps, biased, inv_h, max_push, spring)?;
        return Ok((0, 1));
    }
    sequential_normal(c, ma, mb, gaps, biased, inv_h, max_push, spring)?;
    Ok((0, (c.count == 2) as u64))
}

#[allow(clippy::too_many_arguments)]
fn sequential_normal(
    c: &mut Constraint,
    ma: &mut Motion,
    mb: &mut Motion,
    gaps: [f32; 2],
    biased: bool,
    inv_h: f32,
    max_push: f32,
    spring: &Soft,
) -> Result<(), PhysicsError> {
    let n = c.normal;
    for k in 0..c.count as usize {
        let p = c.points[k];
        let (bias, mass_scale, impulse_scale) = row(spring, gaps[k], biased, inv_h, max_push);
        let vn = n.dot(speed_at(*mb, p.anchor_b).sub(speed_at(*ma, p.anchor_a)));
        let impulse = -p.normal_mass * mass_scale * (vn + bias) - impulse_scale * p.normal_impulse;
        let sum = p.normal_impulse + impulse;
        let ordinary = larger(sum, 0.0);
        let kii = c.k[if k == 0 { 0 } else { 2 }] as f64;
        if !kii.is_finite() {
            return Err(PhysicsError::ArithmeticOverflow);
        }
        if kii < 0.0 {
            return Err(PhysicsError::InvalidParameter);
        }
        let closed = biased && gaps[k] <= 0.0;
        let ci = if closed {
            kii * (impulse_scale as f64 / mass_scale as f64)
        } else {
            0.0
        };
        if !ci.is_finite() || !bias.is_finite() || !vn.is_finite() {
            return Err(PhysicsError::ArithmeticOverflow);
        }
        if ci < 0.0 {
            return Err(PhysicsError::InvalidParameter);
        }
        let common = p.normal_mass.is_finite()
            && impulse.is_finite()
            && sum.is_finite()
            && ordinary.is_finite()
            && (!closed
                || ordinary == 0.0
                || bias as f64 + ci * ordinary as f64 >= -(max_push as f64));
        let total = if common {
            ordinary
        } else {
            capped_row(
                kii,
                ci,
                vn as f64,
                bias as f64,
                p.normal_impulse as f64,
                max_push as f64,
            )?
        };
        let applied = total - p.normal_impulse;
        c.points[k].normal_impulse = total;
        c.pushed |= ((total > 0.0) as u8) << k;
        apply(c, ma, mb, &p, n.scale(applied));
    }
    Ok(())
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
}

/// Exact scalar root of the monotone capped residual, with wide intermediates and explicit numeric failure.
fn capped_row(
    k: f64,
    c: f64,
    v: f64,
    b: f64,
    old: f64,
    max_push: f64,
) -> Result<f32, PhysicsError> {
    if ![k, c, v, b, old, max_push].into_iter().all(f64::is_finite)
        || k < 0.0
        || c < 0.0
        || old < 0.0
        || max_push < 0.0
    {
        return Err(PhysicsError::InvalidParameter);
    }
    let result = if k == 0.0 {
        let residual = (v + b + c * 0.0).max(v - max_push);
        if residual >= 0.0 {
            0.0
        } else if c > 0.0 && v - max_push <= 0.0 {
            -(v + b) / c
        } else {
            return Err(PhysicsError::Degenerate);
        }
    } else {
        let soft = (k * old - v - b) / (k + c);
        let cap = old + (max_push - v) / k;
        soft.min(cap).max(0.0)
    };
    let rounded = result as f32;
    if !result.is_finite() || !rounded.is_finite() {
        return Err(PhysicsError::ArithmeticOverflow);
    }
    Ok(rounded)
}

/// Exact branch enumeration using finite f64 intermediates. Singular/roundoff active sets return None;
/// invalid coefficients and unrepresentable feasible impulses return a coded error.
fn capped_block(
    k: [f32; 3],
    b: [f32; 2],
    c: [f64; 2],
    v: [f32; 2],
    old: [f32; 2],
    soft: [bool; 2],
    max_push: f32,
) -> Result<Option<(f32, f32)>, PhysicsError> {
    if !k
        .into_iter()
        .chain(b)
        .chain(v)
        .chain(old)
        .chain([max_push])
        .all(f32::is_finite)
        || !c.into_iter().all(f64::is_finite)
        || k[0] < 0.0
        || k[2] < 0.0
        || c.into_iter().any(|x| x < 0.0)
        || old.into_iter().any(|x| x < 0.0)
        || max_push < 0.0
    {
        return Err(PhysicsError::InvalidParameter);
    }
    let [k11, k12, k22] = k.map(|x| x as f64);
    let b = b.map(|x| x as f64);
    let v = v.map(|x| x as f64);
    let old = old.map(|x| x as f64);
    let p = max_push as f64;
    if k11 * k22 - k12 * k12 < 0.0 {
        return Err(PhysicsError::InvalidParameter);
    }
    let r = [
        k11 * old[0] + k12 * old[1] - v[0],
        k12 * old[0] + k22 * old[1] - v[1],
    ];
    for states in [
        [1, 1],
        [1, 2],
        [2, 1],
        [2, 2],
        [1, 0],
        [2, 0],
        [0, 1],
        [0, 2],
        [0, 0],
    ] {
        if (states[0] == 2 && !soft[0]) || (states[1] == 2 && !soft[1]) {
            continue;
        }
        let m11 = k11 + if states[0] == 1 { c[0] } else { 0.0 };
        let m22 = k22 + if states[1] == 1 { c[1] } else { 0.0 };
        let rhs = [
            r[0] - if states[0] == 2 { -p } else { b[0] },
            r[1] - if states[1] == 2 { -p } else { b[1] },
        ];
        let x = if states[0] != 0 && states[1] != 0 {
            let det = m11 * m22 - k12 * k12;
            if !(det > 0.0) {
                continue;
            }
            [
                (m22 * rhs[0] - k12 * rhs[1]) / det,
                (m11 * rhs[1] - k12 * rhs[0]) / det,
            ]
        } else if states[0] != 0 {
            if !(m11 > 0.0) {
                continue;
            }
            [rhs[0] / m11, 0.0]
        } else if states[1] != 0 {
            if !(m22 > 0.0) {
                continue;
            }
            [0.0, rhs[1] / m22]
        } else {
            [0.0, 0.0]
        };
        if x.into_iter().any(|x| !x.is_finite() || x < 0.0) {
            continue;
        }
        let post = [
            k11 * x[0] + k12 * x[1] - r[0],
            k12 * x[0] + k22 * x[1] - r[1],
        ];
        let mut valid = true;
        for i in 0..2 {
            let elastic = b[i] + c[i] * x[i];
            let q = if soft[i] { elastic.max(-p) } else { elastic };
            if ![post[i], elastic, q].into_iter().all(f64::is_finite) {
                return Err(PhysicsError::ArithmeticOverflow);
            }
            valid &= match states[i] {
                0 => post[i] + q >= 0.0,
                1 => !soft[i] || elastic >= -p,
                _ => elastic <= -p,
            };
        }
        if valid {
            let result = (x[0] as f32, x[1] as f32);
            if !result.0.is_finite() || !result.1.is_finite() {
                return Err(PhysicsError::ArithmeticOverflow);
            }
            return Ok(Some(result));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod support_cap_tests {
    use super::*;
    #[test]
    fn compliant_support_has_no_representable_load_ceiling() {
        for exponent in -60..=60 {
            let load = 2.0f32.powi(exponent);
            let c = 0.25;
            let b = -c * load;
            let actual = capped_row(2.0, c as f64, 0.0, b as f64, load as f64, 3.0).unwrap();
            assert_eq!(actual, load, "load 2^{exponent}");
            let pair = capped_block(
                [2.0, 0.0, 2.0],
                [b, b],
                [c as f64, c as f64],
                [0.0, 0.0],
                [load, load],
                [true, true],
                3.0,
            )
            .unwrap()
            .unwrap();
            assert_eq!(pair, (load, load));
        }
    }
    #[test]
    fn recovery_cap_limits_new_separation_speed_after_elastic_support() {
        for b in [-1.0, -10.0, -1e3, -1e12] {
            for old in [0.0, 1.0, 1e3, 1e12] {
                let x = capped_row(2.0, 0.25, -1.0, b as f64, old as f64, 3.0).unwrap();
                let vn = -1.0 + 2.0 * (x - old);
                assert!(vn <= 3.0 || (vn - 3.0).abs() <= 4.0 * f32::EPSILON * old.max(1.0));
                let residual = vn + larger(b + 0.25 * x, -3.0);
                assert!(residual.abs() <= 8.0 * f32::EPSILON * (b.abs() + old + 1.0));
            }
        }
    }
    #[test]
    fn block_enumerates_mixed_soft_capped_and_zero_states() {
        for a in [-100.0, -3.0, -0.5, 0.0, 1.0] {
            for b in [-100.0, -3.0, -0.5, 0.0, 1.0] {
                let x = capped_block(
                    [2.0, -0.5, 2.0],
                    [a, b],
                    [0.25, 0.5],
                    [-1.0, 0.5],
                    [0.0, 0.0],
                    [true, true],
                    3.0,
                )
                .unwrap()
                .unwrap();
                let residual = [
                    2.0 * x.0 - 0.5 * x.1 - 1.0 + larger(a + 0.25 * x.0, -3.0),
                    -0.5 * x.0 + 2.0 * x.1 + 0.5 + larger(b + 0.5 * x.1, -3.0),
                ];
                for (l, r) in [(x.0, residual[0]), (x.1, residual[1])] {
                    assert!(l >= 0.0 && r >= -2e-6);
                    assert!(l * r.abs() < 1e-5);
                }
            }
        }
    }
    #[test]
    fn capped_numeric_domain_errors_are_explicit_and_finite_extremes_are_solved() {
        for (k, c, v, b, old, p) in [
            (-1.0, 0.0, 0.0, 0.0, 0.0, 3.0),
            (1.0, -1.0, 0.0, 0.0, 0.0, 3.0),
            (1.0, 0.0, 0.0, 0.0, -1.0, 3.0),
            (1.0, 0.0, 0.0, 0.0, 0.0, -1.0),
            (f64::NAN, 0.0, 0.0, 0.0, 0.0, 3.0),
        ] {
            assert!(capped_row(k, c, v, b, old, p).is_err());
        }
        assert_eq!(capped_row(0.0, 0.0, 1.0, 0.0, 0.0, 3.0), Ok(0.0));
        assert_eq!(
            capped_row(0.0, 0.0, -1.0, 0.0, 0.0, 3.0),
            Err(PhysicsError::Degenerate)
        );
        assert_eq!(
            capped_row(1e-39, 0.0, -0.1, 0.0, 0.0, 3.0).unwrap(),
            1e38f32
        );
        assert_eq!(
            capped_row(1e-39, 0.0, -10.0, 0.0, 0.0, 3.0),
            Err(PhysicsError::ArithmeticOverflow)
        );
        let c = 2.0f64.powi(64);
        let b = -(2.0f32.powi(64));
        assert_eq!(
            capped_block(
                [1.0, 0.0, 1.0],
                [b, b],
                [c, c],
                [0.0; 2],
                [0.0; 2],
                [true; 2],
                3.0
            )
            .unwrap()
            .unwrap(),
            (1.0, 1.0)
        );
        assert!(
            capped_block(
                [1.0, 2.0, 1.0],
                [0.0; 2],
                [0.0; 2],
                [0.0; 2],
                [0.0; 2],
                [false; 2],
                3.0
            )
            .is_err()
        );
        assert!(
            capped_block(
                [1.0, 0.0, 1.0],
                [0.0; 2],
                [f64::INFINITY, 0.0],
                [0.0; 2],
                [0.0; 2],
                [false; 2],
                3.0
            )
            .is_err()
        );
        // The singular contact has a valid single-active-row answer; a zero-rank infeasible row reports no block answer.
        assert!(
            capped_block(
                [1.0, 1.0, 1.0],
                [-1.0, -1.0],
                [0.0; 2],
                [0.0; 2],
                [0.0; 2],
                [false; 2],
                3.0
            )
            .unwrap()
            .is_some()
        );
        assert!(
            capped_block(
                [0.0; 3],
                [-1.0, -1.0],
                [0.0; 2],
                [0.0; 2],
                [0.0; 2],
                [false; 2],
                3.0
            )
            .unwrap()
            .is_none()
        );
    }
    #[test]
    fn mixed_active_states_satisfy_complementarity_with_only_float_rounding_residual() {
        let mut tested = 0;
        for k in [
            [2.0, -0.5, 2.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0 - 2.0f32.powi(-12), 1.0],
            [1e-39, 0.0, 1e-39],
            [1e30, 0.25e30, 1e30],
        ] {
            for coefficients in [
                [0.0, 0.0],
                [0.25, 0.5],
                [2.0f64.powi(64), 2.0f64.powi(64)],
                [1e40, 1e50],
            ] {
                for soft in [[true, true], [true, false], [false, true], [false, false]] {
                    let c = [
                        if soft[0] { coefficients[0] } else { 0.0 },
                        if soft[1] { coefficients[1] } else { 0.0 },
                    ];
                    for (b, v, old) in [
                        ([-100.0, -0.5], [-1.0, 0.5], [0.0, 0.0]),
                        ([-1.0, -10.0], [2.0, -3.0], [1.0, 2.0]),
                        ([-1e10, -1e10], [0.5, -0.5], [1e15, 2e15]),
                        ([0.0, 0.0], [1.0, 2.0], [0.0, 0.0]),
                    ] {
                        let b = [
                            if soft[0] { b[0] } else { 0.25 },
                            if soft[1] { b[1] } else { 0.5 },
                        ];
                        let answer = capped_block(k, b, c, v, old, soft, 3.0);
                        let Some((x, y)) = (match answer {
                            Ok(x) => x,
                            Err(PhysicsError::ArithmeticOverflow) => continue,
                            Err(e) => panic!("unexpected numeric domain {e:?}"),
                        }) else {
                            continue;
                        };
                        let x = [x, y];
                        let xf = x.map(|x| x as f64);
                        let error = x.map(|x| (x.next_up() as f64 - x as f64).abs());
                        for i in 0..2 {
                            let row = if i == 0 {
                                [k[0] as f64, k[1] as f64]
                            } else {
                                [k[1] as f64, k[2] as f64]
                            };
                            let post = v[i] as f64
                                + row[0] * (xf[0] - old[0] as f64)
                                + row[1] * (xf[1] - old[1] as f64);
                            let elastic = b[i] as f64 + c[i] * xf[i];
                            let q = if soft[i] { elastic.max(-3.0) } else { elastic };
                            let residual = post + q;
                            let evaluation = (v[i] as f64).abs()
                                + row[0].abs() * (xf[0].abs() + (old[0] as f64).abs())
                                + row[1].abs() * (xf[1].abs() + (old[1] as f64).abs())
                                + (b[i] as f64).abs()
                                + c[i].abs() * xf[i].abs()
                                + 3.0;
                            let bound = row[0].abs() * error[0]
                                + row[1].abs() * error[1]
                                + c[i].abs() * error[i]
                                + 64.0 * f64::EPSILON * evaluation;
                            assert!(
                                residual >= -bound,
                                "negative residual {residual} bound{bound} k{k:?} c{c:?} x{x:?}"
                            );
                            if x[i] > 0.0 {
                                assert!(
                                    residual.abs() <= bound,
                                    "noncomplementary residual {residual} bound{bound} k{k:?} c{c:?} x{x:?}"
                                );
                            }
                        }
                        tested += 1;
                    }
                }
            }
        }
        assert!(tested >= 200, "only {tested} finite active-state answers");
    }
    #[test]
    fn a_finite_zero_from_an_overflowed_soft_determinant_is_not_accepted() {
        // A unit box with density 2e-19: its original K is finite and well conditioned, but the 1 Hz soft
        // matrix determinant overflows f32. The old both-active formula produced the finite, wrong answer (0,0).
        let spring = soft(1.0, 10.0, 1.0 / 240.0);
        let mut c = Constraint {
            contact: 0,
            a: 0,
            b: 1,
            inv_mass_a: 0.0,
            inv_i_a: 0.0,
            inv_mass_b: 5e18,
            inv_i_b: 3e19,
            normal: V2 { x: 0.0, y: 1.0 },
            friction: 0.0,
            k: [1.25e19, -2.5e18, 1.25e19],
            points: [Point::default(); 2],
            count: 2,
            block: true,
            eighth: false,
            pushed: 0,
        };
        for (p, x) in c.points.iter_mut().zip([-0.5, 0.5]) {
            p.anchor_a = V2 { x, y: 0.0 };
            p.anchor_b = V2 { x, y: -0.5 };
            p.normal_mass = 1.0 / 1.25e19;
        }
        let m = c.k[0] + c.k[0] * (spring.impulse_scale / spring.mass_scale);
        assert!(!(m * m - c.k[1] * c.k[1]).is_finite());
        let mut a = Motion {
            v: V2::ZERO,
            w: 0.0,
        };
        let mut b = Motion {
            v: V2 { x: 0.0, y: -1.0 },
            w: 0.0,
        };
        assert_eq!(
            normal(&mut c, &mut a, &mut b, [0.0; 2], true, 240.0, 3.0, &spring).unwrap(),
            (1, 0)
        );
        assert!(c.points[0].normal_impulse > 0.0 && c.points[1].normal_impulse > 0.0);
        let compliance = c.k[0] as f64 * (spring.impulse_scale as f64 / spring.mass_scale as f64);
        for p in &c.points {
            let vn = c
                .normal
                .dot(speed_at(b, p.anchor_b).sub(speed_at(a, p.anchor_a)))
                as f64;
            assert!((vn + compliance * p.normal_impulse as f64).abs() < 32.0 * f32::EPSILON as f64);
        }
    }
}

#[cfg(test)]
mod material_input_regression {
    use super::*;
    #[test]
    fn material_mean_preserves_finite_product_bits_and_handles_overflowing_products() {
        for (a, b) in [
            (0.0, f32::MAX),
            (0.3, 0.7),
            (1.234_567, 8.765_432),
            (f32::MIN_POSITIVE, f32::MAX),
        ] {
            assert_eq!(
                sqrt_product(a, b).to_bits(),
                crate::math::sqrt(a * b).to_bits()
            );
        }
        for (a, b) in [
            (1.0e20, 1.0e20),
            (f32::MAX, f32::MAX),
            (f32::MAX, 1.234_567),
            (2.0e19, 3.0e19),
        ] {
            let actual = sqrt_product(a, b);
            let reference = ((a as f64) * (b as f64)).sqrt();
            assert!(actual.is_finite() && actual >= a.min(b) && actual <= a.max(b));
            assert!(((actual as f64) - reference).abs() <= 8.0 * f32::EPSILON as f64 * reference);
            assert_eq!(actual.to_bits(), sqrt_product(b, a).to_bits());
        }
    }
}
