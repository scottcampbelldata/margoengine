// The four-lane contact solve: the contacts of one colour, four at a time, in SIMD lanes (kernel-common lanes.rs). No two
// contacts of a colour write the same body, so four visits at once give what four visits one after another give; every
// lane does the scalar solve's operations in the scalar solve's order (solver.rs), branches turned into compares and
// selects, so the two agree bit for bit (tests/bits.rs runs both). A colour's contacts sit in blocks of four, field by
// field; a block's last lanes may be empty. Bodies are gathered 16 bytes at a time (each half of a 32-byte body)
// and turned into lanes by a transpose, and written back the same way, only for the lanes that hold a contact and write
// that body. Two blocks of one colour are visited together, step by step, so their chains overlap (they write different
// bodies, so the order between them changes nothing).
//
// Less work for the same bits: a lane that holds no contact is never written back, so a step that covers every live
// lane (point 0, point 1 of a block whose contacts all have two points, the block solve answering every lane) writes
// its results without the selects that keep the other lanes; each point's gap is worked out once after the poses move
// and kept for the passes until they move again; a block's counts are worked out once when it is made.
use crate::error::PhysicsError;
use alloc::vec::Vec;

use margoengine_physics_kernel_common::lanes::{F4, M4};

use super::{Constraint, Soft, SolverBody};

#[derive(Clone, Copy)]
struct PointLanes {
    rax: F4,
    ray: F4,
    rbx: F4,
    rby: F4,
    base: F4,
    normal_impulse: F4,
    tangent_impulse: F4,
    normal_mass: F4,
    tangent_mass: F4,
}

/// Four contacts of one colour.
#[derive(Clone, Copy)]
pub(super) struct Block {
    a: [u32; 4],
    b: [u32; 4],
    /// Lanes that hold a contact; lanes whose contact has two points; lanes that take the block solve; lanes on the
    /// eighth-rate spring; lanes whose body A and body B are written.
    live: M4,
    two: M4,
    block: M4,
    eighth: M4,
    write_a: u32,
    write_b: u32,
    /// Whether every contact of the block has two points; whether every one takes the block solve. A step that touches
    /// every live lane needs no select to leave the others as they were: the lanes without a contact are never written
    /// back (`scatter` and `write_back` skip them), so what they hold does not matter.
    all_two: bool,
    all_block: bool,
    /// Contacts in the block.
    lanes: u8,
    inv_mass_a: F4,
    inv_i_a: F4,
    inv_mass_b: F4,
    inv_i_b: F4,
    nx: F4,
    ny: F4,
    friction: F4,
    k11: F4,
    k12: F4,
    k22: F4,
    points: [PointLanes; 2],
    /// Lanes whose point k has pushed in some substep.
    pushed: [M4; 2],
    /// Each point's gap as the last pass that worked it out found it: the bodies have not moved since when the pass is
    /// not `fresh` (see `solve`).
    gap: [F4; 2],
}

/// Velocities of four bodies.
#[derive(Clone, Copy)]
struct Motion4 {
    vx: F4,
    vy: F4,
    w: F4,
}

/// The blocks of a step, kept between steps so a step allocates nothing once the world has settled in size.
#[derive(Default)]
pub(super) struct Blocks {
    pub(super) blocks: Vec<Block>,
    /// Where each pushed colour's blocks end.
    pub(super) ends: Vec<usize>,
}

impl Blocks {
    /// Synchronizes a coupled substep's impulses without changing rows, layout or colour order.
    pub(super) fn read_impulses(
        &mut self,
        first: usize,
        constraints: &[Constraint],
        order: &[u32],
    ) -> usize {
        let count = order.len().div_ceil(4);
        for (block, group) in self.blocks[first..first + count]
            .iter_mut()
            .zip(order.chunks(4))
        {
            let mut values = [[0.0f32; 4]; 4];
            let (mut p0, mut p1) = (0, 0);
            for (lane, &ci) in group.iter().enumerate() {
                let c = &constraints[ci as usize];
                values[0][lane] = c.points[0].normal_impulse;
                values[1][lane] = c.points[0].tangent_impulse;
                values[2][lane] = c.points[1].normal_impulse;
                values[3][lane] = c.points[1].tangent_impulse;
                p0 |= (c.pushed as u32 & 1) << lane;
                p1 |= (c.pushed as u32 >> 1 & 1) << lane;
            }
            block.points[0].normal_impulse = F4::new(values[0]);
            block.points[0].tangent_impulse = F4::new(values[1]);
            block.points[1].normal_impulse = F4::new(values[2]);
            block.points[1].tangent_impulse = F4::new(values[3]);
            block.pushed = [M4::from_bits(p0), M4::from_bits(p1)];
        }
        count
    }
    /// Puts `constraints[order[i]]` (one colour's, in visiting order) into blocks of four.
    pub(super) fn push(&mut self, constraints: &[Constraint], order: &[u32]) {
        for group in order.chunks(4) {
            // Field by field across the lanes; empty lanes keep zeros and the last contact's bodies.
            let mut f = [[0.0f32; 4]; 12 + 18];
            let last = &constraints[group[group.len() - 1] as usize];
            let (mut a, mut b) = ([last.a; 4], [last.b; 4]);
            let (
                mut two,
                mut block,
                mut eighth,
                mut write_a,
                mut write_b,
                mut pushed0,
                mut pushed1,
            ) = (0, 0, 0, 0, 0, 0, 0);
            for (k, c) in group.iter().map(|&i| &constraints[i as usize]).enumerate() {
                a[k] = c.a;
                b[k] = c.b;
                two |= ((c.count == 2) as u32) << k;
                block |= ((c.count == 2 && c.block) as u32) << k;
                eighth |= (c.eighth as u32) << k;
                write_a |= ((c.inv_mass_a > 0.0 || c.inv_i_a > 0.0) as u32) << k;
                write_b |= ((c.inv_mass_b > 0.0 || c.inv_i_b > 0.0) as u32) << k;
                pushed0 |= (c.pushed as u32 & 1) << k;
                pushed1 |= (c.pushed as u32 >> 1 & 1) << k;
                let head = [
                    c.inv_mass_a,
                    c.inv_i_a,
                    c.inv_mass_b,
                    c.inv_i_b,
                    c.normal.x,
                    c.normal.y,
                    c.friction,
                    c.k[0],
                    c.k[1],
                    c.k[2],
                    0.0,
                    0.0,
                ];
                for (i, &x) in head.iter().enumerate() {
                    f[i][k] = x;
                }
                for (i, p) in c.points.iter().enumerate() {
                    let row = [
                        p.anchor_a.x,
                        p.anchor_a.y,
                        p.anchor_b.x,
                        p.anchor_b.y,
                        p.base,
                        p.normal_impulse,
                        p.tangent_impulse,
                        p.normal_mass,
                        p.tangent_mass,
                    ];
                    for (j, &x) in row.iter().enumerate() {
                        f[12 + 9 * i + j][k] = x;
                    }
                }
            }
            let v = |i: usize| F4::new(f[i]);
            let point = |i: usize| {
                let o = 12 + 9 * i;
                PointLanes {
                    rax: v(o),
                    ray: v(o + 1),
                    rbx: v(o + 2),
                    rby: v(o + 3),
                    base: v(o + 4),
                    normal_impulse: v(o + 5),
                    tangent_impulse: v(o + 6),
                    normal_mass: v(o + 7),
                    tangent_mass: v(o + 8),
                }
            };
            self.blocks.push(Block {
                a,
                b,
                live: M4::from_bits((1 << group.len()) - 1),
                two: M4::from_bits(two),
                block: M4::from_bits(block),
                eighth: M4::from_bits(eighth),
                write_a,
                write_b,
                all_two: two == (1 << group.len()) - 1,
                all_block: block == (1 << group.len()) - 1,
                lanes: group.len() as u8,
                inv_mass_a: v(0),
                inv_i_a: v(1),
                inv_mass_b: v(2),
                inv_i_b: v(3),
                nx: v(4),
                ny: v(5),
                friction: v(6),
                k11: v(7),
                k12: v(8),
                k22: v(9),
                points: [point(0), point(1)],
                pushed: [M4::from_bits(pushed0), M4::from_bits(pushed1)],
                gap: [F4::splat(0.0); 2],
            });
        }
        self.ends.push(self.blocks.len());
    }

    /// Writes the impulses and pushed bits of the blocks from `first` on back to `constraints[order[i]]`, the contacts
    /// `push` put in them, in the same order; returns the number of blocks read.
    pub(super) fn write_back(
        &self,
        first: usize,
        constraints: &mut [Constraint],
        order: &[u32],
    ) -> usize {
        let count = order.len().div_ceil(4);
        for (block, group) in self.blocks[first..first + count]
            .iter()
            .zip(order.chunks(4))
        {
            let [p0, p1] = &block.points;
            let (n0, t0, n1, t1) = (
                p0.normal_impulse.get(),
                p0.tangent_impulse.get(),
                p1.normal_impulse.get(),
                p1.tangent_impulse.get(),
            );
            let (pushed0, pushed1) = (block.pushed[0].bits(), block.pushed[1].bits());
            for (k, &i) in group.iter().enumerate() {
                let c = &mut constraints[i as usize];
                c.points[0].normal_impulse = n0[k];
                c.points[0].tangent_impulse = t0[k];
                c.points[1].normal_impulse = n1[k];
                c.points[1].tangent_impulse = t1[k];
                c.pushed = (pushed0 >> k & 1) as u8 | ((pushed1 >> k & 1) as u8) << 1;
            }
        }
        count
    }
}

/// The velocities of four bodies: each body's first 16 bytes (v, w, pad) loaded whole, then turned into lanes.
#[inline(always)]
fn gather(bodies: &[SolverBody], at: &[u32; 4]) -> Motion4 {
    let rows = at.map(|k| {
        let b = &bodies[k as usize];
        F4::new([b.v.x, b.v.y, b.w, b.pad])
    });
    let [vx, vy, w, _] = F4::transpose(rows);
    Motion4 { vx, vy, w }
}

/// Writes the velocities back to the bodies of the lanes in `write`, 16 bytes a body (the pad written as 0).
#[inline(always)]
fn scatter(bodies: &mut [SolverBody], at: &[u32; 4], m: Motion4, write: u32) {
    let rows = F4::transpose([m.vx, m.vy, m.w, F4::splat(0.0)]);
    for k in 0..4 {
        if write >> k & 1 == 1 {
            let [x, y, w, pad] = rows[k].get();
            let body = &mut bodies[at[k] as usize];
            body.v.x = x;
            body.v.y = y;
            body.w = w;
            body.pad = pad;
        }
    }
}

#[inline(always)]
fn keep(m: M4, new: Motion4, old: Motion4) -> Motion4 {
    Motion4 {
        vx: F4::select(m, new.vx, old.vx),
        vy: F4::select(m, new.vy, old.vy),
        w: F4::select(m, new.w, old.w),
    }
}

/// `speed_at(m, r)`: v + w x r, with w along z, as (v.x + (-r.y) w, v.y + r.x w).
#[inline(always)]
fn speed_at(m: &Motion4, rx: F4, ry: F4) -> (F4, F4) {
    (m.vx + -ry * m.w, m.vy + rx * m.w)
}

/// `apply`: impulse (jx, jy) from A to B at point `p`, in the lanes of `m` only; `full`: `m` holds every live lane, so
/// the other lanes need not be kept.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn apply(
    c: &Block,
    ma: &mut Motion4,
    mb: &mut Motion4,
    p: &PointLanes,
    jx: F4,
    jy: F4,
    m: M4,
    full: bool,
) {
    let na = Motion4 {
        vx: ma.vx - jx * c.inv_mass_a,
        vy: ma.vy - jy * c.inv_mass_a,
        w: ma.w - c.inv_i_a * (p.rax * jy - p.ray * jx),
    };
    let nb = Motion4 {
        vx: mb.vx + jx * c.inv_mass_b,
        vy: mb.vy + jy * c.inv_mass_b,
        w: mb.w + c.inv_i_b * (p.rbx * jy - p.rby * jx),
    };
    if full {
        *ma = na;
        *mb = nb;
    } else {
        *ma = keep(m, na, *ma);
        *mb = keep(m, nb, *mb);
    }
}

/// The normal speed of point `p`: n . (speed at B - speed at A).
#[inline(always)]
fn normal_speed(c: &Block, ma: &Motion4, mb: &Motion4, p: &PointLanes) -> F4 {
    let (bx, by) = speed_at(mb, p.rbx, p.rby);
    let (ax, ay) = speed_at(ma, p.rax, p.ray);
    c.nx * (bx - ax) + c.ny * (by - ay)
}

pub(super) fn warm_start(bodies: &mut [SolverBody], blocks: &[Block]) {
    for c in blocks {
        let (mut ma, mut mb) = (gather(bodies, &c.a), gather(bodies, &c.b));
        // t = n.right() = (ny, -nx); j = n ni + t ti.
        let (tx, ty) = (c.ny, -c.nx);
        for (i, p) in c.points.iter().enumerate() {
            let m = if i == 0 { c.live } else { c.live.and(c.two) };
            let jx = c.nx * p.normal_impulse + tx * p.tangent_impulse;
            let jy = c.ny * p.normal_impulse + ty * p.tangent_impulse;
            apply(c, &mut ma, &mut mb, p, jx, jy, m, i == 0 || c.all_two);
        }
        scatter(bodies, &c.a, ma, c.write_a);
        scatter(bodies, &c.b, mb, c.write_b);
    }
}

/// The two springs, quarter and eighth, as lanes picked per contact.
#[derive(Clone, Copy)]
pub(super) struct Springs {
    pub(super) quarter: Soft,
    pub(super) eighth: Soft,
}

/// `row`: the bias and the soft scales of one row in each lane, from its gap `s`.
#[inline(always)]
fn row(spring: (F4, F4, F4), s: F4, biased: bool, inv_h: F4, _max_push: F4) -> (F4, F4, F4) {
    let zero = F4::splat(0.0);
    let one = F4::splat(1.0);
    let open = s.gt(zero);
    let (bias, ms, is) = if biased {
        (spring.0 * s, spring.1, spring.2)
    } else {
        (zero, one, zero)
    };
    (
        F4::select(open, s * inv_h, bias),
        F4::select(open, one, ms),
        F4::select(open, zero, is),
    )
}

/// One pass over the blocks: friction and normal, in the pass's order. Returns (block solves, sequential fallbacks).
/// Inside a colour two blocks are visited together, step by step, so their independent chains overlap; they write
/// different bodies, so this gives what one after the other gives. `fresh`: the bodies have moved since the last pass,
/// so each point's gap is worked out again and kept; otherwise the kept gap is the same number and is read instead (a
/// gap depends only on how far the bodies have moved and turned, which changes only when the poses integrate).
#[allow(clippy::too_many_arguments)]
pub(super) fn solve(
    bodies: &mut [SolverBody],
    blocks: &mut Blocks,
    biased: bool,
    fresh: bool,
    inv_h: f32,
    max_push: f32,
    springs: &Springs,
) -> Result<(u64, u64), PhysicsError> {
    let (inv_h, max_push) = (F4::splat(inv_h), F4::splat(max_push));
    // Each spring's impulse scale over its mass scale, the block solve's diagonal term, once a pass: the same division
    // the scalar solve makes on every visit, so the same bits.
    let lanes = |s: &Soft| {
        (
            F4::splat(s.bias_rate),
            F4::splat(s.mass_scale),
            F4::splat(s.impulse_scale),
            F4::splat(s.impulse_scale / s.mass_scale),
        )
    };
    let (q, e) = (lanes(&springs.quarter), lanes(&springs.eighth));
    let (mut block_count, mut sequential_count) = (0u64, 0u64);
    let mut begin = 0;
    for &end in &blocks.ends {
        let mut i = begin;
        while i + 1 < end {
            let (x, y) = blocks.blocks.split_at_mut(i + 1);
            let (b, s) = visit(
                bodies,
                [&mut x[i], &mut y[0]],
                biased,
                fresh,
                inv_h,
                max_push,
                q,
                e,
            )?;
            block_count += b;
            sequential_count += s;
            i += 2;
        }
        if i < end {
            let (b, s) = visit(
                bodies,
                [&mut blocks.blocks[i]],
                biased,
                fresh,
                inv_h,
                max_push,
                q,
                e,
            )?;
            block_count += b;
            sequential_count += s;
        }
        begin = end;
    }
    Ok((block_count, sequential_count))
}

type Lanes4 = (F4, F4, F4, F4);

#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn visit<const N: usize>(
    bodies: &mut [SolverBody],
    mut cs: [&mut Block; N],
    biased: bool,
    fresh: bool,
    inv_h: F4,
    max_push: F4,
    q: Lanes4,
    e: Lanes4,
) -> Result<(u64, u64), PhysicsError> {
    let mut ma: [Motion4; N] = core::array::from_fn(|j| gather(bodies, &cs[j].a));
    let mut mb: [Motion4; N] = core::array::from_fn(|j| gather(bodies, &cs[j].b));
    let g: [[F4; 2]; N] = core::array::from_fn(|j| {
        if fresh {
            cs[j].gap = gaps(bodies, cs[j]);
        }
        cs[j].gap
    });
    if biased {
        friction_n(&mut cs, &mut ma, &mut mb);
    }
    let (mut blocks, mut sequential) = (0u64, 0u64);
    normal_n(
        &mut cs,
        &mut ma,
        &mut mb,
        g,
        biased,
        inv_h,
        max_push,
        q,
        e,
        &mut blocks,
        &mut sequential,
    )?;
    if !biased {
        friction_n(&mut cs, &mut ma, &mut mb);
    }
    for j in 0..N {
        scatter(bodies, &cs[j].a, ma[j], cs[j].write_a);
        scatter(bodies, &cs[j].b, mb[j], cs[j].write_b);
    }
    Ok((blocks, sequential))
}

/// `gap`: each point's separation now, from how far each body moved and turned this step.
#[inline(always)]
fn gaps(bodies: &[SolverBody], c: &Block) -> [F4; 2] {
    // Each body's second 16 bytes (moved, turn) loaded whole, then turned into lanes.
    let half = |at: &[u32; 4]| {
        F4::transpose(at.map(|k| {
            let b = &bodies[k as usize];
            F4::new([b.moved.x, b.moved.y, b.turn.c, b.turn.s])
        }))
    };
    let [amx, amy, ac, as_] = half(&c.a);
    let [bmx, bmy, bc, bs] = half(&c.b);
    let gap = |p: &PointLanes| {
        // turn.apply(v) = (c vx - s vy, s vx + c vy)
        let (rax, ray) = (ac * p.rax - as_ * p.ray, as_ * p.rax + ac * p.ray);
        let (rbx, rby) = (bc * p.rbx - bs * p.rby, bs * p.rbx + bc * p.rby);
        let (dx, dy) = ((bmx + rbx) - (amx + rax), (bmy + rby) - (amy + ray));
        (c.nx * dx + c.ny * dy) + p.base
    };
    [gap(&c.points[0]), gap(&c.points[1])]
}

#[inline(always)]
fn friction_n<const N: usize>(
    cs: &mut [&mut Block; N],
    ma: &mut [Motion4; N],
    mb: &mut [Motion4; N],
) {
    for i in 0..2 {
        for j in 0..N {
            friction_point(cs[j], &mut ma[j], &mut mb[j], i);
        }
    }
}

#[inline(always)]
fn friction_point(c: &mut Block, ma: &mut Motion4, mb: &mut Motion4, i: usize) {
    let (tx, ty) = (c.ny, -c.nx);
    let m = if i == 0 { c.live } else { c.live.and(c.two) };
    let p = c.points[i];
    let (bx, by) = speed_at(mb, p.rbx, p.rby);
    let (ax, ay) = speed_at(ma, p.rax, p.ray);
    let vt = tx * (bx - ax) + ty * (by - ay);
    let limit = c.friction * p.normal_impulse;
    let low = -limit;
    // clamp(x, -limit, limit): x below the low end becomes it, then x above the high end becomes it.
    let x = p.tangent_impulse - p.tangent_mass * vt;
    let x = F4::select(x.lt(low), low, x);
    let total = F4::select(x.gt(limit), limit, x);
    let invalid = limit
        .lt(F4::splat(0.0))
        .or(M4::from_bits(15).and_not(limit.eq(limit)));
    let total = F4::select(invalid, F4::splat(f32::NAN), total);
    let applied = total - p.tangent_impulse;
    let full = i == 0 || c.all_two;
    c.points[i].tangent_impulse = if full {
        total
    } else {
        F4::select(m, total, p.tangent_impulse)
    };
    apply(c, ma, mb, &p, tx * applied, ty * applied, m, full);
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn normal_n<const N: usize>(
    cs: &mut [&mut Block; N],
    ma: &mut [Motion4; N],
    mb: &mut [Motion4; N],
    g: [[F4; 2]; N],
    biased: bool,
    inv_h: F4,
    max_push: F4,
    q: Lanes4,
    e: Lanes4,
    blocks: &mut u64,
    sequential: &mut u64,
) -> Result<(), PhysicsError> {
    for j in 0..N {
        let c = &mut *cs[j];
        let spring = (
            F4::select(c.eighth, e.0, q.0),
            F4::select(c.eighth, e.1, q.1),
            F4::select(c.eighth, e.2, q.2),
        );
        let ratio = F4::select(c.eighth, e.3, q.3);
        let (b, s) = normal(
            c, &mut ma[j], &mut mb[j], g[j], biased, inv_h, max_push, spring, ratio,
        )?;
        *blocks += b;
        *sequential += s;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn normal_common(
    c: &mut Block,
    ma: &mut Motion4,
    mb: &mut Motion4,
    gaps: [F4; 2],
    biased: bool,
    inv_h: F4,
    max_push: F4,
    spring: (F4, F4, F4),
    ratio: F4,
) -> (M4, M4) {
    let zero = F4::splat(0.0);
    let mut certified = c.live;
    let (p, q) = (c.points[0], c.points[1]);
    let both = c.live.and(c.block);
    let mut done = M4::from_bits(0);
    let (start_a, start_b) = (*ma, *mb);
    if c.all_block || both.bits() != 0 {
        let (b1, _, _) = row(spring, gaps[0], biased, inv_h, max_push);
        let (b2, _, _) = row(spring, gaps[1], biased, inv_h, max_push);
        let (k11, k12, k22) = (c.k11, c.k12, c.k22);
        // is / ms: 0 / 1 for an open row or a relaxing pass, the spring's ratio for a closed row in a biased pass.
        let closed = |s: F4| {
            if biased {
                F4::select(s.gt(zero), zero, ratio)
            } else {
                zero
            }
        };
        let m11 = k11 + k11 * closed(gaps[0]);
        let m22 = k22 + k22 * closed(gaps[1]);
        let v1 = normal_speed(c, ma, mb, &p);
        let v2 = normal_speed(c, ma, mb, &q);
        let (l1, l2) = (p.normal_impulse, q.normal_impulse);
        let r1 = k11 * l1 + k12 * l2 - v1 - b1;
        let r2 = k12 * l1 + k22 * l2 - v2 - b2;
        let det = m11 * m22 - k12 * k12;
        // The four complementary cases in their order; the first that holds is the answer.
        let x1 = (m22 * r1 - k12 * r2) / det;
        let x2 = (m11 * r2 - k12 * r1) / det;
        let case1 = det.gt(zero).and(x1.ge(zero)).and(x2.ge(zero));
        if c.all_block && both.and_not(case1).bits() == 0 {
            // Every contact of the block on the block solve and answered by both points pushing (the usual case at
            // rest): no select needed, the lanes without a contact are never read back.
            c.points[0].normal_impulse = x1;
            c.points[1].normal_impulse = x2;
            c.pushed[0] = c.pushed[0].or(x1.gt(zero));
            c.pushed[1] = c.pushed[1].or(x2.gt(zero));
            apply(
                c,
                ma,
                mb,
                &p,
                c.nx * (x1 - l1),
                c.ny * (x1 - l1),
                both,
                true,
            );
            apply(
                c,
                ma,
                mb,
                &q,
                c.nx * (x2 - l2),
                c.ny * (x2 - l2),
                both,
                true,
            );
            return (
                both,
                certify_block(
                    c,
                    gaps,
                    biased,
                    max_push,
                    spring,
                    [b1, b2],
                    [m11, m22, det, r1, r2],
                    [x1, x2],
                )
                .and(both),
            );
        }
        let (found, n1, n2, full) = if both.and_not(case1).bits() == 0 {
            // Every lane is answered by both points pushing (the usual case at rest): the other cases are not needed.
            (both, x1, x2, c.all_block)
        } else {
            let y1 = r1 / m11;
            let case2 = y1.ge(zero).and((k12 * y1 - r2).ge(zero)).and_not(case1);
            let y2 = r2 / m22;
            let case3 = y2
                .ge(zero)
                .and((k12 * y2 - r1).ge(zero))
                .and_not(case1.or(case2));
            let case4 = r1
                .le(zero)
                .and(r2.le(zero))
                .and_not(case1.or(case2).or(case3));
            let found = case1.or(case2).or(case3).or(case4).and(both);
            (
                found,
                F4::select(case1, x1, F4::select(case2, y1, zero)),
                F4::select(case1, x2, F4::select(case3, y2, zero)),
                false,
            )
        };
        let valid = certify_block(
            c,
            gaps,
            biased,
            max_push,
            spring,
            [b1, b2],
            [m11, m22, det, r1, r2],
            [n1, n2],
        )
        .and(found);
        certified = certified.and_not(both).or(valid);
        let (d1, d2) = (n1 - l1, n2 - l2);
        c.points[0].normal_impulse = F4::select(found, n1, l1);
        c.points[1].normal_impulse = F4::select(found, n2, l2);
        c.pushed[0] = c.pushed[0].or(n1.gt(zero).and(found));
        c.pushed[1] = c.pushed[1].or(n2.gt(zero).and(found));
        apply(c, ma, mb, &p, c.nx * d1, c.ny * d1, found, full);
        apply(c, ma, mb, &q, c.nx * d2, c.ny * d2, found, full);
        done = found;
    }
    // Lanes the block solve did not answer: the rows one at a time, from the velocities the visit started with.
    let rest = c.live.and_not(done);
    if rest.bits() != 0 {
        let (mut sa, mut sb) = (start_a, start_b);
        for i in 0..2 {
            let m = if i == 0 { rest } else { rest.and(c.two) };
            let p = c.points[i];
            let (bias, mass_scale, impulse_scale) = row(spring, gaps[i], biased, inv_h, max_push);
            let vn = normal_speed(c, &sa, &sb, &p);
            let impulse =
                -p.normal_mass * mass_scale * (vn + bias) - impulse_scale * p.normal_impulse;
            let sum = p.normal_impulse + impulse;
            let total = F4::select(sum.gt(zero), sum, zero);
            let valid = certify_row(
                c,
                i,
                gaps[i],
                biased,
                max_push,
                mass_scale,
                impulse_scale,
                [bias, vn, p.normal_mass, impulse, sum, total],
            );
            certified = certified.and_not(m.and_not(valid));
            let applied = total - p.normal_impulse;
            c.points[i].normal_impulse = F4::select(m, total, p.normal_impulse);
            c.pushed[i] = c.pushed[i].or(total.gt(zero).and(m));
            apply(
                c,
                &mut sa,
                &mut sb,
                &p,
                c.nx * applied,
                c.ny * applied,
                m,
                false,
            );
        }
        *ma = keep(rest, sa, *ma);
        *mb = keep(rest, sb, *mb);
    }
    (done, certified)
}

/// Exceptional lanes alone materialize the scalar capped-LCP record; certified lanes keep the F4 result.
fn capped_lanes(
    lanes: M4,
    c: &mut Block,
    ma: &mut Motion4,
    mb: &mut Motion4,
    gaps: [F4; 2],
    biased: bool,
    inv_h: F4,
    max_push: F4,
    spring: (F4, F4, F4),
) -> Result<(u64, u64), PhysicsError> {
    let (mut avx, mut avy, mut aw) = (ma.vx.get(), ma.vy.get(), ma.w.get());
    let (mut bvx, mut bvy, mut bw) = (mb.vx.get(), mb.vy.get(), mb.w.get());
    let (mut n0, mut n1) = (
        c.points[0].normal_impulse.get(),
        c.points[1].normal_impulse.get(),
    );
    let (mut push0, mut push1) = (c.pushed[0].bits(), c.pushed[1].bits());
    let mut counts = (0, 0);
    for lane in 0..c.lanes as usize {
        if lanes.bits() >> lane & 1 == 0 {
            continue;
        }
        let point = |i: usize| {
            let p = &c.points[i];
            super::Point {
                anchor_a: super::V2 {
                    x: p.rax.get()[lane],
                    y: p.ray.get()[lane],
                },
                anchor_b: super::V2 {
                    x: p.rbx.get()[lane],
                    y: p.rby.get()[lane],
                },
                base: p.base.get()[lane],
                normal_impulse: p.normal_impulse.get()[lane],
                tangent_impulse: p.tangent_impulse.get()[lane],
                normal_mass: p.normal_mass.get()[lane],
                tangent_mass: p.tangent_mass.get()[lane],
            }
        };
        let mut scalar = Constraint {
            contact: 0,
            a: 0,
            b: 0,
            inv_mass_a: c.inv_mass_a.get()[lane],
            inv_i_a: c.inv_i_a.get()[lane],
            inv_mass_b: c.inv_mass_b.get()[lane],
            inv_i_b: c.inv_i_b.get()[lane],
            normal: super::V2 {
                x: c.nx.get()[lane],
                y: c.ny.get()[lane],
            },
            friction: c.friction.get()[lane],
            k: [c.k11.get()[lane], c.k12.get()[lane], c.k22.get()[lane]],
            points: [point(0), point(1)],
            count: if c.two.bits() >> lane & 1 != 0 { 2 } else { 1 },
            block: c.block.bits() >> lane & 1 != 0,
            eighth: false,
            pushed: ((push0 >> lane & 1) | ((push1 >> lane & 1) << 1)) as u8,
        };
        let mut a = super::Motion {
            v: super::V2 {
                x: avx[lane],
                y: avy[lane],
            },
            w: aw[lane],
        };
        let mut b = super::Motion {
            v: super::V2 {
                x: bvx[lane],
                y: bvy[lane],
            },
            w: bw[lane],
        };
        let s = Soft {
            bias_rate: spring.0.get()[lane],
            mass_scale: spring.1.get()[lane],
            impulse_scale: spring.2.get()[lane],
        };
        let result = super::normal(
            &mut scalar,
            &mut a,
            &mut b,
            [gaps[0].get()[lane], gaps[1].get()[lane]],
            biased,
            inv_h.get()[lane],
            max_push.get()[lane],
            &s,
        )?;
        counts.0 += result.0;
        counts.1 += result.1;
        (avx[lane], avy[lane], aw[lane]) = (a.v.x, a.v.y, a.w);
        (bvx[lane], bvy[lane], bw[lane]) = (b.v.x, b.v.y, b.w);
        n0[lane] = scalar.points[0].normal_impulse;
        n1[lane] = scalar.points[1].normal_impulse;
        push0 |= ((scalar.pushed as u32) & 1) << lane;
        push1 |= ((scalar.pushed as u32) >> 1 & 1) << lane;
    }
    *ma = Motion4 {
        vx: F4::new(avx),
        vy: F4::new(avy),
        w: F4::new(aw),
    };
    *mb = Motion4 {
        vx: F4::new(bvx),
        vy: F4::new(bvy),
        w: F4::new(bw),
    };
    c.points[0].normal_impulse = F4::new(n0);
    c.points[1].normal_impulse = F4::new(n1);
    c.pushed = [M4::from_bits(push0), M4::from_bits(push1)];
    Ok(counts)
}

/// A finite scalar value in every selected SIMD lane. Comparisons reject NaN as well as infinities.
#[inline(always)]
fn finite(values: &[F4]) -> M4 {
    let bound = F4::splat(f32::MAX);
    values.iter().fold(M4::from_bits(15), |m, &x| {
        m.and(x.le(bound)).and(x.ge(-bound))
    })
}

/// Certifies that the ordinary soft LCP answer also solves the capped NCP. A zero-impulse row keeps its
/// original nonnegative soft residual, so max(soft,cap) cannot violate complementarity. For positive rows,
/// b >= -P is an all-SIMD sufficient certificate because C*x >= 0. Only deeper rows need the scalar f64 predicate.
#[allow(clippy::too_many_arguments)]
fn certify_potential(
    mut mask: M4,
    kii: F4,
    gap: F4,
    biased: bool,
    bias: F4,
    ms: F4,
    is: F4,
    answer: F4,
    max_push: F4,
) -> M4 {
    if !biased {
        return mask;
    }
    let zero = F4::splat(0.0);
    let closed = gap.le(zero);
    // Every finite f32 factor is below 2^128 and positive ms >= 2^-149. Thus C=Kii*(is/ms)
    // is nonnegative and below 2^405 (including rounding slack), comfortably inside the f64 domain.
    let domain = finite(&[kii, ms, is])
        .and(kii.ge(zero))
        .and(ms.gt(zero))
        .and(is.ge(zero));
    mask = mask.and_not(closed.and_not(domain));
    let difficult = mask
        .and(closed)
        .and(answer.gt(zero))
        .and_not(bias.ge(-max_push));
    if difficult.bits() == 0 {
        return mask;
    }
    let mut bits = mask.bits();
    for lane in 0..4 {
        if difficult.bits() >> lane & 1 == 0 {
            continue;
        }
        let ci = kii.get()[lane] as f64 * (is.get()[lane] as f64 / ms.get()[lane] as f64);
        if !(bias.get()[lane] as f64 + ci * answer.get()[lane] as f64
            >= -(max_push.get()[lane] as f64))
        {
            bits &= !(1 << lane);
        }
    }
    M4::from_bits(bits)
}

#[allow(clippy::too_many_arguments)]
fn certify_block(
    c: &Block,
    gaps: [F4; 2],
    biased: bool,
    max_push: F4,
    spring: (F4, F4, F4),
    bias: [F4; 2],
    intermediates: [F4; 5],
    answer: [F4; 2],
) -> M4 {
    let mut mask = c
        .live
        .and(finite(&intermediates))
        .and(finite(&answer))
        .and(finite(&[c.k11, c.k12, c.k22]));
    for i in 0..2 {
        mask = certify_potential(
            mask,
            if i == 0 { c.k11 } else { c.k22 },
            gaps[i],
            biased,
            bias[i],
            spring.1,
            spring.2,
            answer[i],
            max_push,
        );
    }
    mask
}

#[allow(clippy::too_many_arguments)]
fn certify_row(
    c: &Block,
    i: usize,
    gap: F4,
    biased: bool,
    max_push: F4,
    ms: F4,
    is: F4,
    values: [F4; 6],
) -> M4 {
    let kii = if i == 0 { c.k11 } else { c.k22 };
    let mask = c
        .live
        .and(finite(&values))
        .and(finite(&[kii]))
        .and(kii.ge(F4::splat(0.0)));
    certify_potential(
        mask, kii, gap, biased, values[0], ms, is, values[5], max_push,
    )
}

#[allow(clippy::too_many_arguments)]
fn normal_certified(
    c: &mut Block,
    ma: &mut Motion4,
    mb: &mut Motion4,
    gaps: [F4; 2],
    biased: bool,
    inv_h: F4,
    max_push: F4,
    spring: (F4, F4, F4),
    ratio: F4,
) -> Result<(u64, u64), PhysicsError> {
    let old = [c.points[0].normal_impulse, c.points[1].normal_impulse];
    let pushed = c.pushed;
    let (a, b) = (*ma, *mb);
    let (done, certified) = normal_common(c, ma, mb, gaps, biased, inv_h, max_push, spring, ratio);
    let certified = certified.and(finite(&[
        c.points[0].normal_impulse,
        c.points[1].normal_impulse,
        ma.vx,
        ma.vy,
        ma.w,
        mb.vx,
        mb.vy,
        mb.w,
    ]));
    let exceptional = c.live.and_not(certified);
    #[cfg(test)]
    common_path_tests::record(certified, exceptional, biased);
    let counts = (
        (done.and(certified)).bits().count_ones() as u64,
        c.two.and(certified).and_not(done).bits().count_ones() as u64,
    );
    if exceptional.bits() == 0 {
        return Ok(counts);
    }
    // Restart exceptional lanes from the exact pre-normal visit state; certified neighbours remain untouched.
    c.points[0].normal_impulse = F4::select(exceptional, old[0], c.points[0].normal_impulse);
    c.points[1].normal_impulse = F4::select(exceptional, old[1], c.points[1].normal_impulse);
    let preserve = |new: M4, old: M4| {
        M4::from_bits((new.bits() & !exceptional.bits()) | (old.bits() & exceptional.bits()))
    };
    c.pushed = [
        preserve(c.pushed[0], pushed[0]),
        preserve(c.pushed[1], pushed[1]),
    ];
    *ma = keep(exceptional, a, *ma);
    *mb = keep(exceptional, b, *mb);
    let fallback = capped_lanes(
        exceptional,
        c,
        ma,
        mb,
        gaps,
        biased,
        inv_h,
        max_push,
        spring,
    )?;
    Ok((counts.0 + fallback.0, counts.1 + fallback.1))
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn normal(
    c: &mut Block,
    ma: &mut Motion4,
    mb: &mut Motion4,
    gaps: [F4; 2],
    biased: bool,
    inv_h: F4,
    max_push: F4,
    spring: (F4, F4, F4),
    ratio: F4,
) -> Result<(u64, u64), PhysicsError> {
    #[cfg(test)]
    let start = (*c, *ma, *mb);
    let result = normal_certified(c, ma, mb, gaps, biased, inv_h, max_push, spring, ratio);
    #[cfg(test)]
    common_path_tests::check_visit(
        start, c, *ma, *mb, gaps, biased, inv_h, max_push, spring, result,
    );
    result
}

#[cfg(test)]
#[path = "wide_tests.rs"]
mod common_path_tests;
