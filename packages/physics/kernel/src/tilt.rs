// Tipping. A soft contact is a spring, and a patch of springs resists a turn about its middle: k_theta = omega^2 sum m_i d_i^2
// over its points (the normal masses m_i and their distances d_i from the patch's middle along the turn's lever). Gravity takes
// stiffness away from every body that leans: a body b tilted by psi_b lowers its own centre and everything it holds up, by
// G_bb psi_b^2 / 2 with G_bb = g (m_b (centre - base) + held (top - base)), heights along gravity from the contacts it stands on
// (base) to those it holds (top). In absolute tilts that loss is diagonal; the springs couple neighbours. The structure stands
// if the springs' energy beats gravity's for every tilt. Along each support path down to the ground the tilt of b is the sum of
// the turns of the interfaces under it, so by Cauchy-Schwarz psi_b^2 <= C_b sum k_i dpsi_i^2, C_b the sum of the compliances
// 1/k down the path (in parallel over several supports: a conductance Y_b = sum 1 / (1/k + C_s)). Summing over b, gravity's
// energy is at most sum_i k_i dpsi_i^2 * A_i, A_i the sum of G_bb C_b over the bodies that interface i holds up; so if every A_i
// is below 1 nothing tips (a discrete Hardy inequality). The step holds every A_i at TARGET: an interface whose A is above
// it is made stiffer, the gain kept for the step and recomputed every step from the bodies' masses and the contacts' shape,
// never from the impulses of the step before (a stiffness that followed the load rocked the pile it was meant to hold).
//
// The bodies holding each other up are taken along gravity (Guendelman, Bridson and Fedkiw 2003, the contact graph from the
// direction a body falls; Erleben 2007, layers of it by height), each pair once a step, lowest first, a tie by row so the order
// is a function of the world alone.
use crate::layout::*;
use crate::math::*;
use crate::world::World;

/// The bound every interface's sum is held to: half of the 1 at which a structure begins to tip, so the stiffness the springs
/// keep against gravity's pull is at least as much again as gravity takes.
const TARGET: f32 = 0.5;
/// A contact whose normal is within 60 degrees of straight up is one body standing on another.
const STANDS: f32 = 0.5;
/// Passes of the gains: each raises an interface's gain by what its own sum asks, and a lower one then sees the new compliance.
const PASSES: usize = 6;

impl World {
    /// Works out PAIR_TILT_GAIN for the window's pairs, whose soft step at substep `h` is `pair_hertz`'s, no gain above what lifts
    /// a contact to a quarter of the substep rate (stiffer, one pass shakes a pile it cannot settle). True when an interface would
    /// need more than that: the structure needs shorter substeps. With `finest`, `h` is the finest substep the island may take, and
    /// an interface that needs more even there is marked PAIR_TILT_UNHELD, which the coarser calls after it then leave out.
    pub(crate) fn tilt_gains(&mut self, h: f32, finest: bool) -> bool {
        let (first, end) = self.window.pairs;
        let g = self.header().gravity;
        let pull = sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
        if !(pull > 0.0) {
            for i in first..end {
                let row = self.uu(SOLVE_PAIRS, i) as usize;
                self.set_s(PAIR_TILT_GAIN, row, 1.0);
            }
            return false;
        }
        let up = v3(-g[0] / pull, -g[1] / pull, -g[2] / pull);
        // The pairs where one dynamic body stands on the other, and every body's mass and height marks reset.
        let mut supports = first;
        for i in first..end {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            self.set_s(PAIR_TILT_GAIN, row, 1.0);
            let (a, b) = self.pair_bodies(row as u32);
            for body in [a, b] {
                if self.flags(body) & KIND == DYNAMIC {
                    let mass = self.s(INVERSE_MASS, body);
                    self.set_s(TILT_MASS, body, if mass > 0.0 { 1.0 / mass } else { 0.0 });
                    self.set_u(TILT_SUPPORTS, body, 0);
                    self.set_s(TILT_BASE, body, 0.0);
                    self.set_s(TILT_TOP, body, 0.0);
                    self.set_u(TILT_TOPS, body, 0);
                    self.set_s(TILT_Y, body, 0.0);
                    self.set_s(TILT_A, body, 0.0);
                }
            }
        }
        for i in first..end {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            if let Some((upper, lower)) = self.stands(row, up) {
                self.set_u(TILT_PAIRS, supports, row as u32);
                supports += 1;
                let height = self.patch_middle(row, upper).dot(up);
                self.set_u(TILT_SUPPORTS, upper, self.uu(TILT_SUPPORTS, upper) + 1);
                self.set_s(TILT_BASE, upper, self.s(TILT_BASE, upper) + height);
                if self.flags(lower) & KIND == DYNAMIC {
                    self.set_s(TILT_TOP, lower, self.s(TILT_TOP, lower) + height);
                    self.set_u(TILT_TOPS, lower, self.uu(TILT_TOPS, lower) + 1);
                }
            }
        }
        if supports == first {
            return false;
        }
        let mut short = false;
        // Lowest standing body first; a tie by row.
        self.sort_by_height(first, supports, up);
        // The mass each body holds up, from the top down: a body's share goes evenly to each of its supports.
        for i in (first..supports).rev() {
            let row = self.uu(TILT_PAIRS, i) as usize;
            let (upper, lower) = self.stands(row, up).unwrap();
            if self.flags(lower) & KIND == DYNAMIC {
                let share = self.s(TILT_MASS, upper) / self.uu(TILT_SUPPORTS, upper) as f32;
                self.set_s(TILT_MASS, lower, self.s(TILT_MASS, lower) + share);
            }
        }
        for pass in 0..PASSES {
            // Conductance to the ground, from the bottom up.
            for i in first..supports {
                let row = self.uu(TILT_PAIRS, i) as usize;
                let (upper, lower) = self.stands(row, up).unwrap();
                let (a, b) = self.pair_bodies(row as u32);
                let k = self.patch_stiffness(row, upper, self.pair_hertz(row, a, b, h).0) * self.s(PAIR_TILT_GAIN, row);
                let below = if self.flags(lower) & KIND == DYNAMIC {
                    let y = self.s(TILT_Y, lower);
                    if y > 0.0 { 1.0 / y } else { f32::INFINITY }
                } else {
                    0.0
                };
                let path = if k > 0.0 { 1.0 / k + below } else { f32::INFINITY };
                if path < f32::INFINITY {
                    self.set_s(TILT_Y, upper, self.s(TILT_Y, upper) + 1.0 / path);
                }
            }
            // Each body's own term, then the sums from the top down.
            for i in first..supports {
                let row = self.uu(TILT_PAIRS, i) as usize;
                let (upper, _) = self.stands(row, up).unwrap();
                if self.s(TILT_A, upper) == 0.0 {
                    self.set_s(TILT_G, upper, self.tilt_loss(upper, up, pull));
                    let y = self.s(TILT_Y, upper);
                    self.set_s(TILT_A, upper, if y > 0.0 { self.s(TILT_G, upper) / y } else { 0.0 });
                }
            }
            let mut worst = 0.0f32;
            for i in (first..supports).rev() {
                let row = self.uu(TILT_PAIRS, i) as usize;
                let (upper, lower) = self.stands(row, up).unwrap();
                let a = self.s(TILT_A, upper);
                worst = worst.max(a);
                if self.flags(lower) & KIND == DYNAMIC {
                    let share = a / self.uu(TILT_SUPPORTS, upper) as f32;
                    self.set_s(TILT_A, lower, self.s(TILT_A, lower) + share);
                }
            }
            // An interface under too much: stiffer, by what its sum asks.
            let mut raised = false;
            for i in first..supports {
                let row = self.uu(TILT_PAIRS, i) as usize;
                let (upper, _) = self.stands(row, up).unwrap();
                let a = self.s(TILT_A, upper);
                if a > TARGET {
                    let (pa, pb) = self.pair_bodies(row as u32);
                    let hertz = self.pair_hertz(row, pa, pb, h).0;
                    let cap = ((0.25 / h / hertz) * (0.25 / h / hertz)).max(1.0);
                    let wanted = self.s(PAIR_TILT_GAIN, row) * (a / TARGET);
                    if wanted > cap {
                        if finest {
                            self.set_u(PAIR_TILT_UNHELD, row, 1);
                        }
                        if self.uu(PAIR_TILT_UNHELD, row) == 0 {
                            short = true;
                        }
                    }
                    let gain = wanted.min(cap);
                    if gain > self.s(PAIR_TILT_GAIN, row) {
                        self.set_s(PAIR_TILT_GAIN, row, gain);
                        raised = true;
                    }
                }
            }
            if !raised || pass + 1 == PASSES {
                break;
            }
            for i in first..supports {
                let row = self.uu(TILT_PAIRS, i) as usize;
                let (upper, lower) = self.stands(row, up).unwrap();
                for body in [upper, lower] {
                    if self.flags(body) & KIND == DYNAMIC {
                        self.set_s(TILT_Y, body, 0.0);
                        self.set_s(TILT_A, body, 0.0);
                    }
                }
            }
        }
        short
    }

    /// The pair's upper and lower body when one dynamic body stands on the other (or on a body that does not move) on a flat
    /// patch (`rolls`).
    fn stands(&self, row: usize, up: V3) -> Option<(usize, usize)> {
        let (a, b) = self.pair_bodies(row as u32);
        let lean = self.v(PAIR_NORMAL_X, row).dot(up);
        let (upper, lower) = if lean > STANDS { (b, a) } else if lean < -STANDS { (a, b) } else { return None };
        if self.flags(upper) & KIND != DYNAMIC || !self.is_awake(upper) || self.rolls(row) {
            return None;
        }
        Some((upper, lower))
    }

    /// True when either side of the pair touches on a curved feature. The tipping model above is a body leaning on a patch of
    /// springs: it turns about the patch's middle, and only the springs push it back. On a convex curved feature (a ball, a
    /// capsule, a cylinder's or a cone's side) the body rolls instead: as it turns the contact moves over the curve, and what
    /// brings it back or tips it is the rocking condition, its centre of mass below or above the centre of curvature at the
    /// contact (a radius of curvature rho against a height c: stable while c < rho). The springs' stiffness is not in that
    /// condition, so shorter substeps change nothing about it, and such a support is not a patch at all here: a ragdoll's hips
    /// capsule lying still on a floor, its few millimetres of spread read as a patch about to tip, held its island at level 3
    /// with stiffened contacts and its spine joint 4.2 cm open. A box, a hull, a mesh, a half space or a voxel grid touches
    /// on flat faces; resting on an edge or a corner instead, its patch has no moment arm across and the criterion already
    /// lets it tip (`island_level`). A cylinder or a cone is flat on a cap and curved on its side: the contact is on the cap
    /// when the outward normal there is nearer the cap's normal than the side's, the bisector of the two features' normals.
    /// A compound's children are not looked into, so it counts as flat, the model as it was.
    fn rolls(&self, row: usize) -> bool {
        let normal = self.v(PAIR_NORMAL_X, row);
        for (side, outward) in [(PAIR_A, normal), (PAIR_B, normal.scale(-1.0))] {
            let c = self.uu(side, row) as usize;
            let shape = self.uu(COLLIDER_SHAPE, c);
            if shape == SHAPE_BALL || shape == SHAPE_CAPSULE {
                return true;
            }
            if shape == SHAPE_CYLINDER || shape == SHAPE_CONE {
                // The outward normal in the shape's frame: its part along the axis and its part across.
                let local = self.collider_pose(c).q.conjugate().rotate(outward);
                let across = sqrt(local.x * local.x + local.z * local.z);
                let on_cap = if shape == SHAPE_CYLINDER {
                    // Caps along +-Y, the side straight across: nearer a cap when the axial part outweighs the radial one.
                    local.y * local.y > across * across
                } else {
                    // The base faces -Y; the side's outward normal is (2B r, A) / L across and up, L = sqrt(A^2 + 4B^2).
                    let (radius, half) = (self.s(COLLIDER_A, c), self.s(COLLIDER_B, c));
                    let length = sqrt(radius * radius + 4.0 * half * half);
                    -local.y > across * (2.0 * half / length) + local.y * (radius / length)
                };
                if !on_cap {
                    return true;
                }
            }
        }
        false
    }

    /// The middle of a pair's points, on the upper body's side, in the world.
    fn patch_middle(&self, row: usize, upper: usize) -> V3 {
        let (a, _) = self.pair_bodies(row as u32);
        let count = self.uu(PAIR_CONTACTS, row) as usize;
        let arm = if upper == a { CONTACT_ARM_A_X } else { CONTACT_ARM_B_X };
        let mut sum = v3(0.0, 0.0, 0.0);
        for k in 0..count {
            sum = sum.add(self.v(arm, row * MANIFOLD + k));
        }
        self.v(CENTER_X, upper).add(sum.scale(1.0 / count as f32))
    }

    /// The turning stiffness of a pair's patch at `hertz`: omega^2 times the least of sum m_i d_i^2 over the patch's two axes.
    fn patch_stiffness(&self, row: usize, upper: usize, hertz: f32) -> f32 {
        let (a, _) = self.pair_bodies(row as u32);
        let count = self.uu(PAIR_CONTACTS, row) as usize;
        let arm = if upper == a { CONTACT_ARM_A_X } else { CONTACT_ARM_B_X };
        let normal = self.v(PAIR_NORMAL_X, row);
        let tangent = self.v(PAIR_TANGENT_X, row);
        let other = normal.cross(tangent);
        let mut middle = v3(0.0, 0.0, 0.0);
        for k in 0..count {
            middle = middle.add(self.v(arm, row * MANIFOLD + k));
        }
        let middle = middle.scale(1.0 / count as f32);
        let (mut along, mut across) = (0.0f32, 0.0f32);
        for k in 0..count {
            let at = row * MANIFOLD + k;
            let d = self.v(arm, at).sub(middle);
            let m = self.s(CONTACT_NORMAL_MASS, at);
            along += m * d.dot(tangent) * d.dot(tangent);
            across += m * d.dot(other) * d.dot(other);
        }
        let omega = 6.283_185_5 * hertz;
        omega * omega * along.min(across)
    }

    /// G_bb: the stiffness gravity takes from body `b`'s tilt, its own weight at its centre and what it holds at its top.
    fn tilt_loss(&self, b: usize, up: V3, pull: f32) -> f32 {
        let supports = self.uu(TILT_SUPPORTS, b);
        if supports == 0 {
            return 0.0;
        }
        let base = self.s(TILT_BASE, b) / supports as f32;
        let mass = self.s(INVERSE_MASS, b);
        let own = if mass > 0.0 { 1.0 / mass } else { 0.0 };
        let centre = self.v(CENTER_X, b).dot(up) - base;
        let tops = self.uu(TILT_TOPS, b);
        let top = if tops > 0 { self.s(TILT_TOP, b) / tops as f32 - base } else { 0.0 };
        let held = self.s(TILT_MASS, b) - own;
        pull * (own * centre.max(0.0) + held * top.max(0.0))
    }

    /// Sorts TILT_PAIRS[..count] by the upper body's centre along `up`, lowest first, a tie by row: a merge sort through TILT_TEMP.
    fn sort_by_height(&mut self, first: usize, end: usize, up: V3) {
        let key = |w: &Self, row: u32| -> (f32, u32) {
            let (upper, _) = w.stands(row as usize, up).unwrap();
            (w.v(CENTER_X, upper).dot(up), row)
        };
        let mut width = 1;
        let (mut from, mut to) = (TILT_PAIRS, TILT_TEMP);
        let count = end;
        while width < count - first {
            let mut start = first;
            while start < count {
                let mid = (start + width).min(count);
                let end = (start + 2 * width).min(count);
                let (mut i, mut j, mut k) = (start, mid, start);
                while k < end {
                    let take_left = j >= end || (i < mid && {
                        let (ka, ra) = key(self, self.uu(from, i));
                        let (kb, rb) = key(self, self.uu(from, j));
                        ka < kb || (ka == kb && ra <= rb)
                    });
                    if take_left {
                        self.set_u(to, k, self.uu(from, i));
                        i += 1;
                    } else {
                        self.set_u(to, k, self.uu(from, j));
                        j += 1;
                    }
                    k += 1;
                }
                start = end;
            }
            core::mem::swap(&mut from, &mut to);
            width *= 2;
        }
        if from != TILT_PAIRS {
            for i in first..count {
                self.set_u(TILT_PAIRS, i, self.uu(from, i));
            }
        }
    }
}

/// The finest rate a substep may have: the framework's finest tick, 60 * 2^7 = 7,680 a second (`@margoengine/math/clock`,
/// `SOLVER_RATE_LEVELS`). An island's level is the largest k for which `substeps * 2^k / dt` stays at or under it: at the default
/// 1/60 s step that is 128 substeps, 2^5 times 4 or 2^4 times 8.
pub const FINEST_RATE: f32 = 7680.0;
/// The most a body in contact may turn in one substep, in radians, derived. A substep's rows are made at its first pose, and the
/// relaxing pass that takes the push back reads the world inverse inertia at the pose the push left; a turn of t between them
/// changes it by |R W R^T - W| <= 2 |R - I| |W|, with |R - I| = 2 sin(t / 2). The pass takes back exactly what it gave only when the
/// two agree; it can never take back more than it gave while the change stays below the inertia itself, |dW| < |W|, so that
/// 4 sin(t / 2) <= 1: t <= 2 asin(1 / 4) = 0.5054 rad. Measured as a check, not as the source (`spin_energy.rs`, the bar through
/// a wall): 0.5 rad a substep gains no energy at any spin to 700 rad/s and 0.6 gains 19 percent at 250 rad/s.
pub const TURN: f32 = 0.505_360_5;

impl World {
    /// The level island `window` steps at this step, a function of its own state alone: the least k, up to the finest the tick grid
    /// allows (`FINEST_RATE`), such that no
    /// body of it in contact turns more than `TURN` a substep at its present spin, and the structures standing in it get stiff enough
    /// contacts at a quarter of the substep rate not to tip (`tilt_gains`). Its pairs' tilt gains are left as that level needs.
    pub(crate) fn island_level(&mut self, dt: f32, substeps: u32) -> u32 {
        let mut most = 0;
        while ((substeps << (most + 1)) as f32) <= FINEST_RATE * dt && most < 24 {
            most += 1;
        }
        // The fastest turn of a dynamic body with contact points: a contact's rows are made at the substep's first pose.
        let (first, last) = self.window.pairs;
        let mut spin = 0.0f32;
        for i in first..last {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            if self.uu(PAIR_CONTACTS, row) == 0 {
                continue;
            }
            let (a, b) = self.pair_bodies(row as u32);
            for at in [a, b] {
                if self.flags(at) & KIND == DYNAMIC {
                    let w = self.v(ANGULAR_X, at);
                    spin = spin.max(sqrt(w.dot(w)));
                }
            }
        }
        let mut level = 0;
        while level < most && spin * dt / (substeps << level) as f32 > TURN {
            level += 1;
        }
        // Most islands stand at the level their spin asks. One that does not: first the interfaces that need more stiffness than
        // even the finest level gives, then the least level that holds the rest. A level only raises a patch's rate: its turning
        // stiffness omega^2 sum m_i d_i^2 (`patch_stiffness`) grows with the cap (0.25 / h)^2 and the sum of m_i d_i^2 stays what
        // the patch's shape makes it. So an interface whose sum asks for more than the finest cap tips as the bodies on it would,
        // whatever the substep; a point or an edge, whose sum is zero across it (no moment arm), always does. Asked by those
        // too, an island stepped at the finest level for as long as a ball rested on anything.
        let (first, last) = self.window.pairs;
        for i in first..last {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            self.set_u(PAIR_TILT_UNHELD, row, 0);
        }
        if !self.tilt_gains(dt / (substeps << level) as f32, false) || level >= most {
            return level;
        }
        self.tilt_gains(dt / (substeps << most) as f32, true);
        loop {
            let h = dt / (substeps << level) as f32;
            if !self.tilt_gains(h, false) || level >= most {
                return level;
            }
            level += 1;
        }
    }

    /// The impulses island `window` carries (its contacts' and joints') were made at its last level's substeps: scaled to the
    /// length of this level's, as a step whose substep changes length scales them.
    pub(crate) fn rescale_warm(&mut self, level: u32, extra: u32) {
        let base = self.header().substeps;
        let (first, end) = self.window.pairs;
        for i in first..end {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            let body = if self.flags(a) & KIND == DYNAMIC { a } else { b };
            let (before, more) = (self.uu(SUBSTEP_LEVEL, body), self.uu(SUBSTEP_EXTRA, body));
            if before == level && more == extra {
                continue;
            }
            let ratio = if more == extra { scale_of(before, level) } else { scale_counts(base, more, before, extra, level) };
            for k in 0..self.uu(PAIR_CONTACTS, row) as usize {
                let at = row * MANIFOLD + k;
                self.set_s(CONTACT_NORMAL_IMPULSE, at, self.s(CONTACT_NORMAL_IMPULSE, at) * ratio);
                self.set_v(CONTACT_TANGENT_X, at, self.v(CONTACT_TANGENT_X, at).scale(ratio));
            }
            self.set_s(PAIR_TWIST, row, self.s(PAIR_TWIST, row) * ratio);
        }
        let (first, end) = self.window.joints;
        for i in first..end {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let body = if self.flags(a) & KIND == DYNAMIC { a } else { b };
            let (before, more) = (self.uu(SUBSTEP_LEVEL, body), self.uu(SUBSTEP_EXTRA, body));
            if before == level && more == extra {
                continue;
            }
            let ratio = if more == extra { scale_of(before, level) } else { scale_counts(base, more, before, extra, level) };
            for k in 0..6 {
                self.set_s(JOINT_IMPULSE_0 + k, row, self.s(JOINT_IMPULSE_0 + k, row) * ratio);
                self.set_s(JOINT_MOTOR_0 + k, row, self.s(JOINT_MOTOR_0 + k, row) * ratio);
            }
        }
    }

    /// Records the level island `window` stepped at on each of its bodies.
    pub(crate) fn keep_level(&mut self, level: u32, extra: u32) {
        let (column, start, end) = self.window.bodies;
        for i in start..end {
            let at = self.uu(column, i) as usize;
            self.set_u(SUBSTEP_LEVEL, at, level);
            self.set_u(SUBSTEP_EXTRA, at, extra);
        }
    }
}

/// The factor a carried impulse made at a substep of level `from` takes into level `to`: 2^(from - to) going finer, exact in
/// f32, and 1 going coarser. A carried impulse is a guess the passes correct; the part of it a steady load explains scales with the
/// substep, but the part a passing strike left does not, and doubled at each coarser level it fed a joint web a runaway (a body
/// went 19, 35, 53, 89, 124, 339, 3,514 then 384,954 m/s as its island came down four levels in four steps). Going coarser, the
/// passes add what the shorter guess lacks.
/// The same for a change of extra substeps too: the old substep's length over the new one's, (base + more) 2^before against
/// (base + extra) 2^level substeps a step, and 1 going coarser, for the reason above.
fn scale_counts(base: u32, more: u32, before: u32, extra: u32, level: u32) -> f32 {
    let (from, to) = (base.saturating_add(more) << before, base.saturating_add(extra) << level);
    if from >= to { 1.0 } else { from as f32 / to as f32 }
}

fn scale_of(from: u32, to: u32) -> f32 {
    if from > to { 1.0 } else { 1.0 / (1u32 << (to - from)) as f32 }
}
