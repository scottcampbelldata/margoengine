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
use alloc::vec::Vec;

use crate::joint::{self, Pass};
use crate::math::{Rot, V2};
use crate::world::{Kind, World, gravity_length};

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
    /// The largest normal impulse any substep gave: restitution needs the point to have pushed.
    max_normal_impulse: f32,
    normal_mass: f32,
    tangent_mass: f32,
    /// The normal speed at the step's start, before anything was solved: what restitution reverses.
    approach: f32,
}

#[derive(Clone, Copy, Debug)]
struct Constraint {
    contact: u32,
    a: u32,
    b: u32,
    inv_mass_a: f32,
    inv_i_a: f32,
    inv_mass_b: f32,
    inv_i_b: f32,
    normal: V2,
    friction: f32,
    restitution: f32,
    count: usize,
    points: [Point; 2],
    /// K for the block solve: k11, k12, k22; `block` when it is well conditioned.
    k: [f32; 3],
    block: bool,
    /// The spring of this pair for the biased passes.
    spring: Soft,
}

/// Lists the solver keeps between steps so a step allocates nothing once the world has settled in size.
#[derive(Default)]
pub struct Scratch {
    constraints: Vec<Constraint>,
    pub(crate) paths: joint::Paths,
}

/// Velocity and turn of a body while the solver works, read from and written back to the world.
#[derive(Clone, Copy)]
struct Motion {
    v: V2,
    w: f32,
}

#[inline(always)]
fn speed_at(m: Motion, r: V2) -> V2 {
    // v + w x r, with w along z.
    m.v.add(r.left().scale(m.w))
}

/// The separation of point `p` of constraint `c` now, from how far each body moved and turned this step.
#[inline]
fn gap(world: &World, c: &Constraint, p: &Point) -> f32 {
    let (ba, bb) = (&world.bodies[c.a as usize], &world.bodies[c.b as usize]);
    let turn_a = ba.xf.q.mul(inverse(ba.start_rotation));
    let turn_b = bb.xf.q.mul(inverse(bb.start_rotation));
    let ra = turn_a.apply(p.anchor_a);
    let rb = turn_b.apply(p.anchor_b);
    let d = bb.moved.add(rb).sub(ba.moved.add(ra));
    c.normal.dot(d) + p.base
}

#[inline(always)]
fn inverse(q: Rot) -> Rot {
    Rot { c: q.c, s: -q.s }
}

/// One step of `dt` over the world's awake bodies and the contacts that touch one.
pub fn solve(world: &mut World, dt: f32) {
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
    constraints.clear();
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
            a,
            b,
            inv_mass_a: ima,
            inv_i_a: iia,
            inv_mass_b: imb,
            inv_i_b: iib,
            normal: n,
            friction: sqrt_product(sa.friction, sb.friction),
            restitution: sa.restitution.max(sb.restitution),
            count: m.count,
            points: [Point::default(); 2],
            k: [0.0; 3],
            block: false,
            spring: quarter,
        };
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
            let dv = speed_at(mb, rb).sub(speed_at(ma, ra));
            c.points[k] = Point {
                anchor_a: ra,
                anchor_b: rb,
                base: mp.separation - n.dot(rb.sub(ra)),
                normal_impulse: contact.normal_impulse[k],
                tangent_impulse: contact.tangent_impulse[k],
                max_normal_impulse: 0.0,
                normal_mass: if kn > 0.0 { 1.0 / kn } else { 0.0 },
                tangent_mass: if kt > 0.0 { 1.0 / kt } else { 0.0 },
                approach: n.dot(dv),
            };
            load += contact.normal_impulse[k];
        }
        if m.count == 2 {
            let (p, q) = (&c.points[0], &c.points[1]);
            let (r1a, r1b, r2a, r2b) = (p.anchor_a.cross(n), p.anchor_b.cross(n), q.anchor_a.cross(n), q.anchor_b.cross(n));
            let k11 = ima + imb + iia * r1a * r1a + iib * r1b * r1b;
            let k22 = ima + imb + iia * r2a * r2a + iib * r2b * r2b;
            let k12 = ima + imb + iia * r1a * r2a + iib * r1b * r2b;
            c.k = [k11, k12, k22];
            c.block = settings.block_solver && k11 * k11 < MAX_CONDITION * (k11 * k22 - k12 * k12);
        }
        if passes < 2 && ba.kind == Kind::Dynamic && bb.kind == Kind::Dynamic && load * ima.max(imb) < chain_limit {
            c.spring = eighth;
        }
        constraints.push(c);
    }
    world.counts.constraints = constraints.len() as u64;

    // Start of step: every moving body's offset and rotation.
    for body in world.bodies.iter_mut() {
        body.moved = V2::ZERO;
        body.start_rotation = body.xf.q;
    }

    let g = settings.gravity;
    let (mut block, mut sequential) = (0u64, 0u64);
    // Joint passes: relaxing unless marked biased.
    let mut paths = core::mem::take(&mut world.scratch.paths);
    joint::build_paths(world, &mut paths);
    let joint_pass = Pass { h, inv_h, biased: false, spring: joint::joint_spring(settings.joint_hertz, settings.joint_damping, h), max_push: settings.joint_max_push };
    for _ in 0..substeps {
        for body in world.bodies.iter_mut() {
            if body.kind != Kind::Dynamic || !body.awake {
                continue;
            }
            let v = body.linear_velocity.add(g.scale(h * body.gravity_scale));
            body.linear_velocity = v.scale(1.0 / (1.0 + h * body.linear_damping));
            body.angular_velocity *= 1.0 / (1.0 + h * body.angular_damping);
        }
        for c in &constraints {
            warm_start(world, c);
        }
        joint::warm_start(world, &mut paths, h, settings.joint_geometric_stiffness);
        for _ in 0..passes {
            joint::solve(world, &mut paths, &Pass { biased: true, ..joint_pass });
            for c in constraints.iter_mut() {
                let (b, s) = solve_contact(world, c, true, inv_h, settings.contact_max_push);
                block += b;
                sequential += s;
            }
        }
        for body in world.bodies.iter_mut() {
            if body.kind == Kind::Static || !body.awake {
                continue;
            }
            let step = body.linear_velocity.scale(h);
            body.exact_center = [body.exact_center[0] + step.x as f64, body.exact_center[1] + step.y as f64];
            body.moved = body.moved.add(step);
            body.xf.q = body.xf.q.integrate(h * body.angular_velocity);
        }
        for _ in 0..passes {
            joint::solve(world, &mut paths, &joint_pass);
            for c in constraints.iter_mut() {
                let (b, s) = solve_contact(world, c, false, inv_h, settings.contact_max_push);
                block += b;
                sequential += s;
            }
        }
    }
    world.counts.block = block;
    world.counts.sequential = sequential;

    let threshold = settings.restitution_threshold;
    for c in constraints.iter_mut() {
        if c.restitution == 0.0 {
            continue;
        }
        let (mut ma, mut mb) = motions(world, c);
        for k in 0..c.count {
            let p = c.points[k];
            if p.approach > -threshold || p.max_normal_impulse == 0.0 {
                continue;
            }
            let vn = c.normal.dot(speed_at(mb, p.anchor_b).sub(speed_at(ma, p.anchor_a)));
            let impulse = -p.normal_mass * (vn + c.restitution * p.approach);
            let total = (p.normal_impulse + impulse).max(0.0);
            c.points[k].normal_impulse = total;
            apply(c, &mut ma, &mut mb, &p, c.normal.scale(total - p.normal_impulse));
        }
        store(world, c, ma, mb);
    }

    for c in &constraints {
        let contact = &mut world.contacts[c.contact as usize];
        for k in 0..c.count {
            contact.normal_impulse[k] = c.points[k].normal_impulse;
            contact.tangent_impulse[k] = c.points[k].tangent_impulse;
        }
    }
    for body in world.bodies.iter_mut() {
        if body.kind != Kind::Static && body.awake {
            body.round_pose();
        }
    }
    world.scratch.constraints = constraints;
    world.scratch.paths = paths;
}

/// sqrt(a b): the friction of two materials.
#[inline]
fn sqrt_product(a: f32, b: f32) -> f32 {
    crate::math::sqrt(a * b)
}

#[inline(always)]
fn motions(world: &World, c: &Constraint) -> (Motion, Motion) {
    let (ba, bb) = (&world.bodies[c.a as usize], &world.bodies[c.b as usize]);
    (Motion { v: ba.linear_velocity, w: ba.angular_velocity }, Motion { v: bb.linear_velocity, w: bb.angular_velocity })
}

#[inline(always)]
fn store(world: &mut World, c: &Constraint, ma: Motion, mb: Motion) {
    if c.inv_mass_a > 0.0 || c.inv_i_a > 0.0 {
        let body = &mut world.bodies[c.a as usize];
        body.linear_velocity = ma.v;
        body.angular_velocity = ma.w;
    }
    if c.inv_mass_b > 0.0 || c.inv_i_b > 0.0 {
        let body = &mut world.bodies[c.b as usize];
        body.linear_velocity = mb.v;
        body.angular_velocity = mb.w;
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

fn warm_start(world: &mut World, c: &Constraint) {
    let (mut ma, mut mb) = motions(world, c);
    let t = c.normal.right();
    for p in &c.points[..c.count] {
        let j = c.normal.scale(p.normal_impulse).add(t.scale(p.tangent_impulse));
        apply(c, &mut ma, &mut mb, p, j);
    }
    store(world, c, ma, mb);
}

/// One row's terms: the bias, and the soft scales (1 and 0 for a rigid row).
#[inline(always)]
fn row(c: &Constraint, s: f32, biased: bool, inv_h: f32, max_push: f32) -> (f32, f32, f32) {
    if s > 0.0 {
        (s * inv_h, 1.0, 0.0)
    } else if biased {
        ((c.spring.bias_rate * s).max(-max_push), c.spring.mass_scale, c.spring.impulse_scale)
    } else {
        (0.0, 1.0, 0.0)
    }
}

/// One pass over one contact: friction and normal, in the pass's order. Returns (block solves, sequential fallbacks).
fn solve_contact(world: &mut World, c: &mut Constraint, biased: bool, inv_h: f32, max_push: f32) -> (u64, u64) {
    let (mut ma, mut mb) = motions(world, c);
    let mut gaps = [0.0f32; 2];
    for k in 0..c.count {
        gaps[k] = gap(world, c, &c.points[k]);
    }
    if biased {
        friction(c, &mut ma, &mut mb);
    }
    let counts = normal(c, &mut ma, &mut mb, gaps, biased, inv_h, max_push);
    if !biased {
        friction(c, &mut ma, &mut mb);
    }
    store(world, c, ma, mb);
    counts
}

fn friction(c: &mut Constraint, ma: &mut Motion, mb: &mut Motion) {
    let t = c.normal.right();
    let mu = c.friction;
    for k in 0..c.count {
        let p = c.points[k];
        let vt = t.dot(speed_at(*mb, p.anchor_b).sub(speed_at(*ma, p.anchor_a)));
        let limit = mu * p.normal_impulse;
        let total = (p.tangent_impulse - p.tangent_mass * vt).clamp(-limit, limit);
        let applied = total - p.tangent_impulse;
        c.points[k].tangent_impulse = total;
        apply(c, ma, mb, &p, t.scale(applied));
    }
}

#[allow(clippy::too_many_arguments)]
fn normal(c: &mut Constraint, ma: &mut Motion, mb: &mut Motion, gaps: [f32; 2], biased: bool, inv_h: f32, max_push: f32) -> (u64, u64) {
    let n = c.normal;
    if c.count == 2 && c.block {
        let (p, q) = (c.points[0], c.points[1]);
        let (b1, ms1, is1) = row(c, gaps[0], biased, inv_h, max_push);
        let (b2, ms2, is2) = row(c, gaps[1], biased, inv_h, max_push);
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
            c.points[0].max_normal_impulse = c.points[0].max_normal_impulse.max(x1);
            c.points[1].max_normal_impulse = c.points[1].max_normal_impulse.max(x2);
            apply(c, ma, mb, &p, n.scale(d1));
            apply(c, ma, mb, &q, n.scale(d2));
            return (1, 0);
        }
        // Rounding left no case standing: the rows one at a time.
        sequential_normal(c, ma, mb, gaps, biased, inv_h, max_push);
        return (0, 1);
    }
    sequential_normal(c, ma, mb, gaps, biased, inv_h, max_push);
    (0, (c.count == 2) as u64)
}

#[allow(clippy::too_many_arguments)]
fn sequential_normal(c: &mut Constraint, ma: &mut Motion, mb: &mut Motion, gaps: [f32; 2], biased: bool, inv_h: f32, max_push: f32) {
    let n = c.normal;
    for k in 0..c.count {
        let p = c.points[k];
        let (bias, mass_scale, impulse_scale) = row(c, gaps[k], biased, inv_h, max_push);
        let vn = n.dot(speed_at(*mb, p.anchor_b).sub(speed_at(*ma, p.anchor_a)));
        let impulse = -p.normal_mass * mass_scale * (vn + bias) - impulse_scale * p.normal_impulse;
        let total = (p.normal_impulse + impulse).max(0.0);
        let applied = total - p.normal_impulse;
        c.points[k].normal_impulse = total;
        c.points[k].max_normal_impulse = c.points[k].max_normal_impulse.max(total);
        apply(c, ma, mb, &p, n.scale(applied));
    }
}
