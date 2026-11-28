// The contact solver: soft constraints with substeps and relaxation, the scheme Catto calls Soft Step (Solver2D, 2024;
// soft constraints from Catto 2011, substeps from Macklin et al. 2019). Contacts are found once a step; everything below
// runs each substep over those same points, with the gap worked out again from the bodies' new poses.
//
//   integrate velocities; warm start; solve with bias; integrate poses; tally the drift; relax, as many times as the
//   biased solve ran; restitution.
//
// The biased solve pushes shapes apart through a soft constraint, a spring and damper in implicit form with this frequency
// and damping ratio: omega = 2 pi hertz, a1 = 2 zeta + omega h, a2 = h omega a1, a3 = 1 / (1 + a2), and then
//
//   impulse = -(a2 a3) m (v + (omega / a1) s) - a3 impulse_so_far
//
// Relaxing solves again with no bias and does not move the poses, so the speed the push added leaves the velocities and
// stacks do not hop. A gap still open is a speculative point: it lets the bodies close it within this substep and no more.
//
// In the biased solve friction comes first, from the normal impulse so far, and in the relaxing one the normal does, so
// the cone is what the relaxed normal holds. The cone is circular: the tangent impulse is one vector, cut back to
// mu times the normal impulse. It is anchored: `drift` holds how far the two surfaces have slid since the point last
// stuck, and the biased solve pulls that back, so a block on a slope holds its place instead of creeping (the sticky
// anchors of Solver2D's TGS_Sticky). The drift is tallied from the speeds the poses moved with. Muller et al. 2020 hold
// static friction by position too, but cancel one substep's slip and let go when the multiplier passes the cone; here the
// slip adds up and is pulled back by a soft constraint of the same form as the normal. A cone that saturates keeps the
// anchor at its edge: the drift scales by the same cut, so a sliding block pulls it along and one that stops holds from
// there.
//
// The first point of a manifold turns each substep, as within a substep the first point sees the whole load: from a fixed
// first point a heavy box on a light one walks (`a_heavy_box_stands_on_a_light_one`).
//
// Restitution follows Muller et al. 2020: a point struck in this substep notes its approach speed, and after relaxing is
// solved to -e times that speed. The approach is the pre-solve one (Muller et al.'s v_n before the constraints run), noted
// for every point of a bouncy pair before the warm start (`note_approach`): a speed one pair's push gave a body within the
// substep is no approach of its next pair, or a strike carried through a body would bounce off both of its pairs and the
// energy would grow (three balls in a row 2 mm apart took 1.5 times the energy they were given). Slower than two substeps of gravity is rest, not a bounce. A point struck while its gap
// is still open notes the speed it will meet the surface with, gravity's gain over the gap added.
use crate::contact::tangent_of;
use crate::integrate::apply_inverse_inertia;
use crate::joints::HELD_BODIES;
use crate::layout::*;
use crate::math::*;
use crate::world::World;

/// 2 pi as the nearest f32.
const TAU: f32 = 6.283_185_5;

/// How far a body may turn in a step, radians, before the contact rows made at its first pose are made again for it: an inertia read at
/// a pose that far off is wrong by about that much in relative terms.
const STALE_TURN: f32 = 1e-3;

/// The most sweeps a pair's normal rows take in one pass. A manifold not settled by then is left as it stands. The part that
/// settled last, the shares four points take of one load among themselves, moves no body and is now solved exactly each sweep
/// (`normal_rows`), so a pass settles in 3 to 4 sweeps on average where it ran out at 16.
const SWEEPS: u32 = 16;
/// The share of a point's own stiffness added to its diagonal in the block solve, the square root of f32 rounding. Four points of
/// one plane push the bodies through three numbers, so their matrix has rank three; this makes it positive definite and the
/// split of the load among them the even one, the least squares answer, as the null-space step of the sweeps gives.
const REGULARISE: f32 = 3.452_669_8e-4;

/// Work counts for `examples/profile.rs`, native only (feature `counts`): one-point normal updates in biased passes [0]
/// and relaxing passes [1], every sweep counted. The Wasm build has no such feature, so its code is untouched.
#[cfg(feature = "counts")]
/// Manifolds the block solve answered exactly, and manifolds it left to the sweeps for want of an accepted active set.
#[cfg(feature = "counts")]
pub static BLOCK_SOLVES: [core::sync::atomic::AtomicU64; 2] = [core::sync::atomic::AtomicU64::new(0), core::sync::atomic::AtomicU64::new(0)];
pub static NORMAL_UPDATES: [core::sync::atomic::AtomicU64; 2] = [core::sync::atomic::AtomicU64::new(0), core::sync::atomic::AtomicU64::new(0)];

/// At one pass a substep, a contact between two movable bodies takes the soft constraint at an eighth of the substep rate
/// (30 Hz at 4 substeps of a 60 Hz step), unless it carries this many times the lighter body's weight. One Gauss-Seidel pass
/// does not settle a pile at a quarter of the rate: the 20-row pyramid of the harness rocked for good, its fastest box at
/// 0.28 m/s after 30 s, at damping ratios from 1 to 40, and its rows' rocking fed what the pass left back in as speed. An eighth
/// keeps the stiffness well below the substep rate, as Catto's Solver2D post (2024) asks of the soft step, where a quarter does
/// not at one pass; the pile then sleeps in 2.3 s. The ground, kinematic and dominant bodies keep the quarter, as one pass
/// solves such a pair against an immovable body within its own manifold, and so does a heavy body on a light one, whose sag is
/// its load over the spring: at an eighth the 1:100 and 1:1000 stacks of `examples/bars.rs` would sag 35 and 345 mm in place of
/// 14 and 137. The 20 and 30 row piles load their bottom pairs about 26 and 40 times a cube's weight, the stacks 100 and 1000,
/// so 50 lies between them with room on both sides. Two passes or more settle a quarter, and every pair keeps it there.
const CHAIN_LOAD: f32 = 50.0;

/// Scales of one soft constraint at one substep length.
#[derive(Clone, Copy)]
pub struct Soft {
    pub bias_rate: f32,
    pub mass_scale: f32,
    pub impulse_scale: f32,
}

/// The coefficients of a soft constraint (Catto 2011, in the form of Solver2D).
#[inline]
pub fn soft(hertz: f32, zeta: f32, h: f32) -> Soft {
    let omega = TAU * hertz;
    let a1 = 2.0 * zeta + omega * h;
    let a2 = h * omega * a1;
    let a3 = 1.0 / (1.0 + a2);
    Soft { bias_rate: omega / a1, mass_scale: a2 * a3, impulse_scale: a3 }
}

/// A symmetric 3 by 3 matrix: the world inverse inertia, with any locked axes zeroed in its rows and columns.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Sym {
    pub(crate) xx: f32,
    pub(crate) xy: f32,
    pub(crate) xz: f32,
    pub(crate) yy: f32,
    pub(crate) yz: f32,
    pub(crate) zz: f32,
}

impl Sym {
    #[inline(always)]
    pub fn mul(&self, v: V3) -> V3 {
        v3(self.xx * v.x + self.xy * v.y + self.xz * v.z, self.xy * v.x + self.yy * v.y + self.yz * v.z, self.xz * v.x + self.yz * v.y + self.zz * v.z)
    }
}

impl Sym {
    /// a . (this b) in doubles.
    #[inline]
    pub fn between(&self, a: V3, b: V3) -> f64 {
        let (ax, ay, az, bx, by, bz) = (a.x as f64, a.y as f64, a.z as f64, b.x as f64, b.y as f64, b.z as f64);
        let (xx, xy, xz, yy, yz, zz) = (self.xx as f64, self.xy as f64, self.xz as f64, self.yy as f64, self.yz as f64, self.zz as f64);
        ax * (xx * bx + xy * by + xz * bz) + ay * (xy * bx + yy * by + yz * bz) + az * (xz * bx + yz * by + zz * bz)
    }
}

/// What the solver needs of a body, held while it works on a pair.
#[derive(Clone, Copy)]
pub struct Moving {
    pub mass: V3,
    pub inertia: Sym,
    pub linear: V3,
    pub angular: V3,
}

#[cfg(not(target_arch = "wasm32"))]
std::thread_local! {
    /// The work bodies that take no push but move, kinematic ones, have done on what they are solved against, in joules, over
    /// this thread's steps: the energy a scene may gain that no force inside it made. Native only, for the tests; the Wasm
    /// build has none of it. Every impulse counts, a joint's position bias included: a kinematic body at speed u that hands
    /// on an impulse p does the work p . u whatever the impulse is for. A bias push that a relaxing pass takes back then nets
    /// no work and no energy, and a push left behind shows as a gain of about p b / 2 (b the bias speed), the energy no
    /// force made. Counting the take-back and not the push made the ledger depend on the frame: it read p . u as a gain,
    /// 3.4 MJ in one step of web seed 17, where the bodies gained 73 kJ.
    pub static DRIVEN: core::cell::Cell<f64> = const { core::cell::Cell::new(0.0) };
}

impl Moving {
    /// Counts the work of an impulse this body takes, `linear` and `angular` about its centre, when it takes no push: what it
    /// takes, the bodies it is solved against take the other way, at its speed. Native only (DRIVEN).
    #[cfg(not(target_arch = "wasm32"))]
    #[inline(always)]
    pub(crate) fn driven(&self, linear: V3, angular: V3) {
        let i = &self.inertia;
        if self.mass.dot(self.mass) == 0.0 && i.xx == 0.0 && i.yy == 0.0 && i.zz == 0.0 && i.xy == 0.0 && i.xz == 0.0 && i.yz == 0.0 {
            let work = -(linear.dot(self.linear) as f64 + angular.dot(self.angular) as f64);
            DRIVEN.with(|d| d.set(d.get() + work));
        }
    }

    /// The change of an impulse `p` at the arm `r`.
    #[inline(always)]
    pub(crate) fn push(&mut self, p: V3, r: V3) {
        #[cfg(not(target_arch = "wasm32"))]
        self.driven(p, r.cross(p));
        self.linear = self.linear.add(self.mass.mul(p));
        self.angular = self.angular.add(self.inertia.mul(r.cross(p)));
    }
    /// How much a unit impulse along `d` at `r` changes the speed there along `d`.
    #[inline(always)]
    pub(crate) fn give(&self, d: V3, r: V3) -> f32 {
        let turn = r.cross(d);
        d.mul(d).dot(self.mass) + turn.dot(self.inertia.mul(turn))
    }
    #[inline(always)]
    pub(crate) fn at(&self, r: V3) -> V3 {
        self.linear.add(self.angular.cross(r))
    }
    /// Takes no push: a wall to whatever it is solved against.
    #[inline(always)]
    fn immovable(&mut self) {
        self.mass = v3(0.0, 0.0, 0.0);
        self.inertia = Sym { xx: 0.0, xy: 0.0, xz: 0.0, yy: 0.0, yz: 0.0, zz: 0.0 };
    }
}

impl World {
    #[inline(always)]
    pub fn moving(&self, at: usize) -> Moving {
        let substeps = if self.window.substeps > 0 { self.window.substeps } else { self.header().substeps };
        let (linear, angular) = self.kinematic_velocity(at, self.window.substep, substeps, self.v(LINEAR_X, at), self.v(ANGULAR_X, at));
        Moving {
            mass: self.v(SOLVE_MASS_X, at),
            inertia: Sym {
                xx: self.s(SOLVE_INERTIA_XX, at),
                xy: self.s(SOLVE_INERTIA_XY, at),
                xz: self.s(SOLVE_INERTIA_XZ, at),
                yy: self.s(SOLVE_INERTIA_YY, at),
                yz: self.s(SOLVE_INERTIA_YZ, at),
                zz: self.s(SOLVE_INERTIA_ZZ, at),
            },
            linear,
            angular,
        }
    }

    /// The two bodies of a pair as its solve sees them: the one that dominates takes no push from this pair.
    #[inline(always)]
    pub(crate) fn pair_moving(&self, row: usize, a: usize, b: usize) -> (Moving, Moving) {
        let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
        let flags = self.uu(PAIR_FLAGS, row);
        if flags & PAIR_A_RULES != 0 {
            body_a.immovable();
        } else if flags & PAIR_B_RULES != 0 {
            body_b.immovable();
        }
        (body_a, body_b)
    }

    #[inline(always)]
    pub fn settle(&mut self, at: usize, body: &Moving) {
        self.set_v(LINEAR_X, at, body.linear);
        self.set_v(ANGULAR_X, at, body.angular);
    }

    /// Writes what the solver knows of a body: nothing moves one that is not an awake dynamic body, and locks hold.
    pub fn solver_mass(&mut self, at: usize) {
        let flags = self.flags(at);
        let rotation = self.q(ROTATION_X, at);
        self.set_v(CENTER_X, at, self.v(POSITION_X, at).add(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
        let (mut mass, mut inertia) = (v3(0.0, 0.0, 0.0), Sym { xx: 0.0, xy: 0.0, xz: 0.0, yy: 0.0, yz: 0.0, zz: 0.0 });
        if flags & KIND == DYNAMIC && flags & SLEEPING == 0 {
            let m = self.s(INVERSE_MASS, at);
            let free = |bit: u32| if flags & bit != 0 { 0.0 } else { 1.0 };
            mass = v3(m * free(LOCK_LINEAR_X), m * free(LOCK_LINEAR_X << 1), m * free(LOCK_LINEAR_X << 2));
            let frame = rotation.mul(self.q(INERTIA_FRAME_X, at));
            let inverse = self.v(INVERSE_INERTIA_X, at);
            let (x, y, z) = (
                apply_inverse_inertia(inverse, frame, v3(1.0, 0.0, 0.0)),
                apply_inverse_inertia(inverse, frame, v3(0.0, 1.0, 0.0)),
                apply_inverse_inertia(inverse, frame, v3(0.0, 0.0, 1.0)),
            );
            let (fx, fy, fz) = (free(LOCK_ANGULAR_X), free(LOCK_ANGULAR_X << 1), free(LOCK_ANGULAR_X << 2));
            inertia = Sym { xx: x.x * fx, xy: x.y * fx * fy, xz: x.z * fx * fz, yy: y.y * fy, yz: y.z * fy * fz, zz: z.z * fz };
        }
        self.set_v(SOLVE_MASS_X, at, mass);
        self.set_s(SOLVE_INERTIA_XX, at, inertia.xx);
        self.set_s(SOLVE_INERTIA_XY, at, inertia.xy);
        self.set_s(SOLVE_INERTIA_XZ, at, inertia.xz);
        self.set_s(SOLVE_INERTIA_YY, at, inertia.yy);
        self.set_s(SOLVE_INERTIA_YZ, at, inertia.yz);
        self.set_s(SOLVE_INERTIA_ZZ, at, inertia.zz);
    }

    /// Mixes one property of two colliders: a pair takes the higher rule of its two: GeometricMean over ClampedSum over Max over Multiply over Min over Average.
    fn combine(a: f32, b: f32, rule: u32) -> f32 {
        match rule {
            COMBINE_MAX => {
                if a > b {
                    a
                } else {
                    b
                }
            }
            COMBINE_GEOMETRIC_MEAN => {
                let product = a * b;
                if product > 0.0 { sqrt(product) } else { 0.0 }
            }
            COMBINE_CLAMPED_SUM => {
                let sum = a + b;
                if sum > 1.0 {
                    1.0
                } else if sum > 0.0 {
                    sum
                } else {
                    0.0
                }
            }
            COMBINE_MULTIPLY => a * b,
            COMBINE_MIN => {
                if a < b {
                    a
                } else {
                    b
                }
            }
            _ => 0.5 * (a + b),
        }
    }

    /// Once a step, before the substeps: lists the pairs to solve, and works out their arms, their effective masses and
    /// their friction and bounce. The arms and masses hold for the step.
    pub fn prepare_contacts(&mut self) {
        for slot in 0..self.header().awake as usize {
            let at = self.uu(AWAKE, slot) as usize;
            self.solver_mass(at);
        }
        let mut solving = 0;
        for i in 0..self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i) as usize;
            let count = self.uu(PAIR_CONTACTS, row) as usize;
            if count == 0 {
                continue;
            }
            let (a, b) = self.pair_bodies(row as u32);
            for body in [a, b] {
                if self.uu(AWAKE_SLOT, body) == crate::world::NONE {
                    self.solver_mass(body);
                }
            }
            let (first, second) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            let (rules_a, rules_b) = (self.uu(COLLIDER_COMBINE, first), self.uu(COLLIDER_COMBINE, second));
            let higher = |x: u32, y: u32| if x > y { x } else { y };
            let friction = Self::combine(self.s(COLLIDER_FRICTION, first), self.s(COLLIDER_FRICTION, second), higher(friction_rule(rules_a), friction_rule(rules_b)));
            let bounce = Self::combine(self.s(COLLIDER_RESTITUTION, first), self.s(COLLIDER_RESTITUTION, second), higher(restitution_rule(rules_a), restitution_rule(rules_b)));
            self.set_s(PAIR_FRICTION, row, friction);
            self.set_s(PAIR_RESTITUTION, row, bounce);
            self.set_v(PAIR_SURFACE_X, row, self.moving_surface(row, first, second));
            if (self.uu(COLLIDER_FLAGS, first) | self.uu(COLLIDER_FLAGS, second)) & COLLIDER_MODIFY != 0 {
                self.modify_contacts(row);
            }
            // The modifier may have cleared the pair's contacts.
            let count = self.uu(PAIR_CONTACTS, row) as usize;
            if count == 0 {
                continue;
            }
            let normal = self.v(PAIR_NORMAL_X, row);
            let tangent = tangent_of(normal);
            let other = normal.cross(tangent);
            self.set_v(PAIR_TANGENT_X, row, tangent);
            let (rotation_a, rotation_b) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
            // Fixed and kinematic bodies take no push anyway, and a body must never be a wall to its floor.
            let (rank_a, rank_b) = (self.s(DOMINANCE, a), self.s(DOMINANCE, b));
            let rule = if self.flags(a) & KIND != DYNAMIC || self.flags(b) & KIND != DYNAMIC {
                0
            } else if rank_a > rank_b {
                PAIR_A_RULES
            } else if rank_b > rank_a {
                PAIR_B_RULES
            } else {
                0
            };
            self.set_u(PAIR_FLAGS, row, self.uu(PAIR_FLAGS, row) & !(PAIR_A_RULES | PAIR_B_RULES) | rule);
            let (body_a, body_b) = self.pair_moving(row, a, b);
            for k in 0..count {
                let at = row * MANIFOLD + k;
                let (arm_a, arm_b) = (rotation_a.rotate(self.v(CONTACT_ANCHOR_A_X, at)), rotation_b.rotate(self.v(CONTACT_ANCHOR_B_X, at)));
                self.set_v(CONTACT_ARM_A_X, at, arm_a);
                self.set_v(CONTACT_ARM_B_X, at, arm_b);
                let mass = |d: V3| {
                    let give = body_a.give(d, arm_a) + body_b.give(d, arm_b);
                    if give > 0.0 { 1.0 / give } else { 0.0 }
                };
                self.set_s(CONTACT_NORMAL_MASS, at, mass(normal));
                self.set_s(CONTACT_TANGENT_MASS, at, mass(tangent));
                self.set_s(CONTACT_OTHER_MASS, at, mass(other));
            }
            self.set_s(PAIR_FORCE, row, 0.0);
            self.set_u(SOLVE_PAIRS, solving, row as u32);
            solving += 1;
        }
        self.header_mut().solving = solving as u32;
        self.order_pairs_by_island(solving);
        // What a solve called on its own (a test of the warm start, say) works on: the pairs just listed. A step sets its own.
        self.window = self.whole_window();
    }

    /// The island a listed pair belongs to: that of its dynamic body, which is the same for both when both are dynamic. None for a
    /// pair with no awake dynamic body in an island this step.
    fn island_of_pair(&self, row: usize) -> Option<usize> {
        let (a, b) = self.pair_bodies(row as u32);
        for body in [a, b] {
            if self.flags(body) & KIND == DYNAMIC && self.is_awake(body) {
                let id = self.uu(ISLAND_ID, body);
                if id != crate::world::NONE {
                    return Some(id as usize);
                }
            }
        }
        None
    }

    /// Puts the listed pairs in runs, one run an island and each run in the order it was listed (a stable counting sort), the
    /// pairs of no island last, and notes where each island's run starts and how long it is. Islands share no body that a solve
    /// changes, so the order of one island's pairs against another's moves nothing: every body ends where it was, and only
    /// the lists of what was solved in what order differ.
    fn order_pairs_by_island(&mut self, solving: usize) {
        let islands = self.header().islands as usize;
        for island in 0..islands {
            self.set_u(ISLAND_PAIR_COUNT, island, 0);
        }
        for i in 0..solving {
            if let Some(island) = self.island_of_pair(self.uu(SOLVE_PAIRS, i) as usize) {
                self.set_u(ISLAND_PAIR_COUNT, island, self.uu(ISLAND_PAIR_COUNT, island) + 1);
            }
        }
        let mut start = 0;
        for island in 0..islands {
            self.set_u(ISLAND_PAIR_START, island, start);
            start += self.uu(ISLAND_PAIR_COUNT, island);
        }
        let mut loose_at = start;
        // The impacts column is free until the first substep ends: the sorted list goes through it. Filling leaves each
        // run's count where it was and walks a cursor in the count's place, so the cursor is rebuilt from the start.
        for island in 0..islands {
            self.set_u(ISLAND_PAIR_CURSOR, island, self.uu(ISLAND_PAIR_START, island));
        }
        for i in 0..solving {
            let row = self.uu(SOLVE_PAIRS, i);
            let at = match self.island_of_pair(row as usize) {
                Some(island) => {
                    let at = self.uu(ISLAND_PAIR_CURSOR, island);
                    self.set_u(ISLAND_PAIR_CURSOR, island, at + 1);
                    at
                }
                None => {
                    loose_at += 1;
                    loose_at - 1
                }
            };
            self.set_u(IMPACTS, at as usize, row);
        }
        debug_assert_eq!(loose_at as usize, solving);
        for i in 0..solving {
            self.set_u(SOLVE_PAIRS, i, self.uu(IMPACTS, i));
        }
    }

    /// Whether body `at` has turned since the step began by more than `STALE_TURN`: its inertia in the world's axes is then not the one
    /// the step's contact rows were made with by more than a part in a thousand. A body that turns less is solved with the rows as they
    /// are, exactly as before: refreshed at every grain of rounding, a pile of 465 cubes at rest at one pass a substep crept at 4 mm/s
    /// where it crept at 0.6 mm/s, and a web of joints took another of its chaotic paths (seed 1 opened a joint 72 m, 40 m before).
    #[inline]
    fn has_turned(&self, at: usize) -> bool {
        if self.flags(at) & KIND != DYNAMIC {
            return false;
        }
        // The rotation since the step began: its vector part is sin(angle / 2) along the axis.
        let r = self.q(ROTATION_X, at).mul(self.q(PREVIOUS_ROTATION_X, at).conjugate());
        let half = 0.5 * STALE_TURN;
        r.x * r.x + r.y * r.y + r.z * r.z > half * half
    }

    /// After a substep's poses: the world inverse inertia of every body that has turned, and the effective masses of the contacts it is in,
    /// made again from where it is. The step's contact rows are made once, from the pose the step began with. An impulse `P` at a lever `r`
    /// changes the spin by `W (r x P)` with `W` the inverse inertia in the world's axes, and the kinetic energy it changes by is `P` times the
    /// mean speed of the point only when that `W` is the body's own now: with a stale `W`, an impulse that stops a point (a projection, which
    /// can only lose energy) changes the energy by `w . I (W_stale - W) (r x P)` as well, which grows with the spin. A thin bar spinning at
    /// 400 rad/s against a wall went from 85 to 273 kJ that way, with the step turning it 6.7 rad. The levers stay the step's (a point
    /// moved on by the turn is the sticky friction's to follow, which a lever refreshed with it would not let rest: Catto, "Solver2D", 2024,
    /// keeps anchors fixed over a step), and a lever is exact for every impulse as long as the speed it measures is the speed it applies at.
    pub fn refresh_turned_contacts(&mut self) {
        let mut any = false;
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            if self.has_turned(at) {
                self.solver_mass(at);
                any = true;
            }
        }
        if !any {
            return;
        }
        for i in self.window.pairs.0..self.window.pairs.1 {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            if !(self.has_turned(a) || self.has_turned(b)) {
                continue;
            }
            let normal = self.v(PAIR_NORMAL_X, row);
            let tangent = self.v(PAIR_TANGENT_X, row);
            let other = normal.cross(tangent);
            let (body_a, body_b) = self.pair_moving(row, a, b);
            for k in 0..self.uu(PAIR_CONTACTS, row) as usize {
                let at = row * MANIFOLD + k;
                let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
                let mass = |d: V3| {
                    let give = body_a.give(d, arm_a) + body_b.give(d, arm_b);
                    if give > 0.0 { 1.0 / give } else { 0.0 }
                };
                self.set_s(CONTACT_NORMAL_MASS, at, mass(normal));
                self.set_s(CONTACT_TANGENT_MASS, at, mass(tangent));
                self.set_s(CONTACT_OTHER_MASS, at, mass(other));
            }
        }
    }

    /// The gaps of pair `row`'s points from where its bodies are now, as `normal_rows` reads them at substep `turn`.
    fn point_gaps(&self, row: usize, a: usize, b: usize, h: f32, turn: usize) -> [f32; MANIFOLD] {
        let (center_a, center_b) = (self.pose_center(a), self.pose_center(b));
        let (rotation_a, rotation_b) = (self.pose_rotation(a), self.pose_rotation(b));
        let normal = self.v(PAIR_NORMAL_X, row);
        let surface_normal = self.v(PAIR_SURFACE_X, row).dot(normal);
        let (round_a, round_b) = (self.round_core(self.uu(PAIR_A, row) as usize), self.round_core(self.uu(PAIR_B, row) as usize));
        let mut gaps = [f32::MAX; MANIFOLD];
        for (k, gap) in gaps.iter_mut().enumerate().take(self.uu(PAIR_CONTACTS, row) as usize) {
            let at = row * MANIFOLD + k;
            let (anchor_a, anchor_b) = (self.v(CONTACT_ANCHOR_A_X, at), self.v(CONTACT_ANCHOR_B_X, at));
            let on_a = match round_a {
                Some(core) => center_a.add(rotation_a.rotate(core.nearest(anchor_a))).add(normal.scale(core.radius)),
                None => center_a.add(rotation_a.rotate(anchor_a)),
            };
            let on_b = match round_b {
                Some(core) => center_b.add(rotation_b.rotate(core.nearest(anchor_b))).sub(normal.scale(core.radius)),
                None => center_b.add(rotation_b.rotate(anchor_b)),
            };
            *gap = on_b.sub(on_a).dot(normal) - surface_normal * h * (turn as f32);
        }
        gaps
    }

    /// Each substep, before the contact solve: strikes into bodies that already touch another are resolved one pair at a
    /// time, Newton's law of restitution at each point, until no struck point still approaches (Guendelman, Bridson and
    /// Fedkiw, "Nonconvex rigid bodies with stacking", SIGGRAPH 2003, section 6: collisions before contact, pair by pair,
    /// on the positions the substep will reach). Solved together with the contacts, such a strike was shared along a line
    /// of touching balls in place of passing down it, so a touching Newton's cradle sent every ball off at a fifth of the
    /// speed. A point takes part when its pair has restitution, it approaches faster than the bounce speed (two substeps of
    /// gravity), it carried no load into the substep (so a resting pile is never struck), and it touches or will within
    /// this substep; a point still apart joins only when one of its bodies touches a third (within the slop) through
    /// another bouncy pair or was moved by a strike of the pass, as a lone strike is met exactly by the speculative row and
    /// the bounce after it. Each impulse is -(1 + e) times the approach times the point's normal mass, which takes energy
    /// out for e up to 1, so no sweep can add energy; friction then takes the slip toward rest within mu times that impulse,
    /// which takes energy out too.
    pub fn collide_pairwise(&mut self, h: f32, turn: usize) -> Shifts {
        let mut shifts = Shifts { count: 0, entries: [(usize::MAX, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0)); SHIFTS], later: false };
        let (start, end) = self.window.pairs;
        if !(start..end).any(|i| self.s(PAIR_RESTITUTION, self.uu(SOLVE_PAIRS, i) as usize) > 0.0) {
            return shifts;
        }
        let threshold = self.bounce_speed(h);
        // Touching is within the slop, where the solver holds resting points.
        let slop = self.header().contact_slop;
        // Whether `body` touches a third body through a bouncy pair other than `row`.
        let pressed = |world: &World, body: usize, row: usize| {
            (start..end).any(|j| {
                let other = world.uu(SOLVE_PAIRS, j) as usize;
                if other == row || world.s(PAIR_RESTITUTION, other) <= 0.0 {
                    return false;
                }
                let (c, d) = world.pair_bodies(other as u32);
                (c == body || d == body)
                    && world.point_gaps(other, c, d, h, turn).iter().take(world.uu(PAIR_CONTACTS, other) as usize).any(|&gap| gap <= slop)
            })
        };
        // ponytail: one sweep a pair at most, and the pressed test scans the window, O(pairs^2) on a substep with a strike;
        // a line of n touching bodies needs n - 1 sweeps when its pairs are listed against the strike.
        // Bodies a strike of this pass moved: struck in a line, they are not lone. ponytail: the first 32 a substep; past
        // them a strike is left to the contact solve, which shares it.
        let (mut hit, mut hits) = ([usize::MAX; 32], 0usize);
        // When in the substep each listed body was struck: a strike passed down a touching line happens when the first one did.
        let mut struck_at = [0.0f32; 32];
        for _ in start..end {
            let mut struck = false;
            for i in start..end {
                let row = self.uu(SOLVE_PAIRS, i) as usize;
                let bounce = self.s(PAIR_RESTITUTION, row);
                if bounce <= 0.0 {
                    continue;
                }
                let (a, b) = self.pair_bodies(row as u32);
                let gaps = self.point_gaps(row, a, b, h, turn);
                let normal = self.v(PAIR_NORMAL_X, row);
                let surface_normal = self.v(PAIR_SURFACE_X, row).dot(normal);
                for (k, &gap) in gaps.iter().enumerate().take(self.uu(PAIR_CONTACTS, row) as usize) {
                    let at = row * MANIFOLD + k;
                    let (mut body_a, mut body_b) = self.pair_moving(row, a, b);
                    let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
                    let speed = body_b.at(arm_b).sub(body_a.at(arm_a)).dot(normal) - surface_normal;
                    let impulse = -(1.0 + bounce) * speed * self.s(CONTACT_NORMAL_MASS, at);
                    // A point pressed by a load rests: a strike is a point that held nothing (as `normal_rows` marks one), so a
                    // rocking pile is left to the contact solve. The load it carried into the substep is a force of that over
                    // h, and a force that held for the whole step would take out at least this strike's impulse is a pile's
                    // weight on a point that rocks; a load that would not is no rest the strike meets, and the strike is an
                    // impact. Any load at all read as rest: the few micronewton-seconds that two hung touching balls press
                    // on each other while their joints close their drift (a millionth of the strike's half newton-second)
                    // made the last pair of a cradle a resting one, the strike that reached it was shared, two balls left at
                    // half the speed and the line lost half its energy (KB-PHYS-HUNGCRADLE1).
                    let load = self.s(CONTACT_NORMAL_IMPULSE, at);
                    if (load > 0.0 && load * self.header().step_dt >= impulse * h) || speed >= -threshold || (gap > 0.0 && !hit[..hits].contains(&a) && !hit[..hits].contains(&b) && !pressed(self, a, row) && !pressed(self, b, row)) {
                        continue;
                    }
                    // A strike into a line that does not close this substep is the pass's when it does: the contact solve's
                    // speculative row leaves it open (`normal_rows`), so the speeds the solve adds cannot close it there.
                    // They differ from the pass's by what the warm starts and the joints add, a pendulum's pull along its
                    // swing: a ball that the pass saw end its substep a micrometre short met the line in the speculative
                    // row, which shared the strike, and the cradle swung as one 75 s in (KB-PHYS-HUNGCRADLE1).
                    if gap + speed * h > 0.0 {
                        self.set_u(PAIR_FLAGS, row, self.uu(PAIR_FLAGS, row) | PAIR_STRIKE_LATER);
                        shifts.later = true;
                        continue;
                    }
                    // A body a joint holds is struck with the joints holding it (`held_response`): the impulse is the one its
                    // held mass takes, and the joints give nothing back inelastically after.
                    let held = self.held_response(row, a, b, normal, arm_a, arm_b, impulse);
                    // The bodies this strike changes, and their speeds before it.
                    let mut moved = [(usize::MAX, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0)); HELD_BODIES];
                    let mut count = 2;
                    match &held {
                        Some(held) => {
                            count = held.count;
                            for (k, entry) in moved.iter_mut().enumerate().take(count) {
                                *entry = (held.bodies[k], self.v(LINEAR_X, held.bodies[k]), self.v(ANGULAR_X, held.bodies[k]));
                            }
                        }
                        None => {
                            (moved[0], moved[1]) = ((a, self.v(LINEAR_X, a), self.v(ANGULAR_X, a)), (b, self.v(LINEAR_X, b), self.v(ANGULAR_X, b)));
                        }
                    }
                    let impulse = match &held {
                        Some(held) => {
                            let impulse = -(1.0 + bounce) * speed / held.inverse;
                            self.apply_held(held, impulse);
                            (body_a, body_b) = self.pair_moving(row, a, b);
                            impulse
                        }
                        None => {
                            let applied = normal.scale(impulse);
                            body_a.push(applied.scale(-1.0), arm_a);
                            body_b.push(applied, arm_b);
                            impulse
                        }
                    };
                    // Coulomb friction through the strike, as in the paper's collision step: the slip brought to rest along its
                    // own line, in the cone of mu times this impulse (a struck ball otherwise kept its whole sideways speed).
                    // Held bodies rub with the joints holding, as they are struck: a hung ball's contact point slips across the
                    // line at its swing's spin times its radius, and its free mass took a rub that spun the ball, which its
                    // joint then turned into swing, so the strike was shared and the line swung (KB-PHYS-HUNGCRADLE1).
                    let relative = body_b.at(arm_b).sub(body_a.at(arm_a)).sub(self.v(PAIR_SURFACE_X, row));
                    let slip = relative.sub(normal.scale(relative.dot(normal)));
                    let length = sqrt(slip.dot(slip));
                    let most = self.s(PAIR_FRICTION, row) * impulse;
                    if length > 0.0 && most > 0.0 {
                        let line = slip.scale(1.0 / length);
                        let rubbed = match held {
                            Some(_) => self.held_response(row, a, b, line, arm_a, arm_b, most),
                            None => None,
                        };
                        match rubbed {
                            Some(rubbed) => {
                                let stop = length / rubbed.inverse;
                                self.apply_held(&rubbed, -(if stop < most { stop } else { most }));
                                (body_a, body_b) = self.pair_moving(row, a, b);
                            }
                            None => {
                                let give = body_a.give(line, arm_a) + body_b.give(line, arm_b);
                                if give > 0.0 {
                                    let stop = length / give;
                                    let rub = slip.scale(-(if stop < most { stop } else { most }) / length);
                                    body_a.push(rub.scale(-1.0), arm_a);
                                    body_b.push(rub, arm_b);
                                }
                            }
                        }
                    }
                    self.settle(a, &body_a);
                    self.settle(b, &body_b);
                    self.set_s(PAIR_FORCE, row, self.s(PAIR_FORCE, row) + impulse);
                    // The time of impact: a point still apart meets when its gap closes, gap / -speed into the substep, and
                    // a body struck in this pass passes the strike on when it took it. The substep moves every body with
                    // the speed it leaves the pass with, so each body this strike changed is moved back by that change times
                    // the time once the substep has moved it (`shift_poses`; Mirtich and Canny 1995: advance to the
                    // collision, apply the impulse, go on). Moved as it came, a ball struck 0.2 mm short of a touching
                    // line stopped 0.2 mm short of it, swung back onto it at a millimetre a second, below any strike, and
                    // pushed the line, which then swung as one. The poses move after the solve, not now: moved now, the
                    // ball the line sends off would overlap its neighbour by up to its whole substep's travel through the
                    // contact solve, whose push then moved it further.
                    let listed = |body: usize| hit[..hits].iter().position(|&listed| listed == body).map_or(0.0, |place| struck_at[place]);
                    let own = if gap > 0.0 { gap / -speed } else { 0.0 };
                    let when = own.max(listed(a)).max(listed(b)).min(h);
                    if when > 0.0 {
                        for &(body, linear, angular) in &moved[..count] {
                            if self.flags(body) & KIND != DYNAMIC || !self.is_awake(body) {
                                continue;
                            }
                            let (gain, spin) = (self.v(LINEAR_X, body).sub(linear), self.v(ANGULAR_X, body).sub(angular));
                            shifts.add(body, gain.scale(-when), spin.scale(-when));
                        }
                    }
                    for body in [a, b] {
                        match hit[..hits].iter().position(|&listed| listed == body) {
                            Some(place) => struck_at[place] = struck_at[place].max(when),
                            None if hits < hit.len() => {
                                hit[hits] = body;
                                struck_at[hits] = when;
                                hits += 1;
                            }
                            None => {}
                        }
                    }
                    struck = true;
                }
            }
            if !struck {
                break;
            }
        }
        shifts
    }

    /// Once the substep has moved the poses: each body a strike of `collide_pairwise` changed is moved by its time of impact.
    pub fn shift_poses(&mut self, shifts: &Shifts) {
        for &(body, shift, turn) in &shifts.entries[..shifts.count] {
            self.shift_pose(body, shift, turn);
        }
    }

    /// Once the substep is solved: the pairs `collide_pairwise` left to strike later are plain pairs again.
    pub fn end_strikes(&mut self, shifts: &Shifts) {
        if shifts.later {
            for i in self.window.pairs.0..self.window.pairs.1 {
                let row = self.uu(SOLVE_PAIRS, i) as usize;
                self.set_u(PAIR_FLAGS, row, self.uu(PAIR_FLAGS, row) & !PAIR_STRIKE_LATER);
            }
        }
    }

    /// Each substep, before the warm start: every point of a pair with restitution notes its normal speed as it stands, the
    /// pre-solve approach (Muller et al. 2020) a strike is bounced from. Pairs with no restitution are skipped, so a scene
    /// with no bounce does no more work.
    pub fn note_approach(&mut self) {
        for i in self.window.pairs.0..self.window.pairs.1 {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            if self.s(PAIR_RESTITUTION, row) <= 0.0 {
                continue;
            }
            let (a, b) = self.pair_bodies(row as u32);
            let (body_a, body_b) = self.pair_moving(row, a, b);
            let normal = self.v(PAIR_NORMAL_X, row);
            let surface_normal = self.v(PAIR_SURFACE_X, row).dot(normal);
            for k in 0..self.uu(PAIR_CONTACTS, row) as usize {
                let at = row * MANIFOLD + k;
                let speed = body_b.at(self.v(CONTACT_ARM_B_X, at)).sub(body_a.at(self.v(CONTACT_ARM_A_X, at))).dot(normal) - surface_normal;
                self.set_s(CONTACT_APPROACH, at, speed);
            }
        }
    }

    /// Each substep: the impulses the points carry, before anything is solved.
    pub fn warm_start(&mut self) {
        let share = self.header().warm_start;
        for i in self.window.pairs.0..self.window.pairs.1 {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            let (mut body_a, mut body_b) = self.pair_moving(row, a, b);
            let normal = self.v(PAIR_NORMAL_X, row);
            for k in 0..self.uu(PAIR_CONTACTS, row) as usize {
                let at = row * MANIFOLD + k;
                // A share under one forgets part of what the point carried, stored and applied alike, so the solve's sums agree.
                if share != 1.0 {
                    self.set_s(CONTACT_NORMAL_IMPULSE, at, self.s(CONTACT_NORMAL_IMPULSE, at) * share);
                    self.set_v(CONTACT_TANGENT_X, at, self.v(CONTACT_TANGENT_X, at).scale(share));
                }
                let impulse = normal.scale(self.s(CONTACT_NORMAL_IMPULSE, at)).add(self.v(CONTACT_TANGENT_X, at));
                body_a.push(impulse.scale(-1.0), self.v(CONTACT_ARM_A_X, at));
                body_b.push(impulse, self.v(CONTACT_ARM_B_X, at));
            }
            // The simplified model's twist about the normal.
            let twist = if self.header().friction_model == 1 { self.s(PAIR_TWIST, row) } else { 0.0 };
            if twist == 0.0 && self.s(PAIR_TWIST, row) != 0.0 {
                self.set_s(PAIR_TWIST, row, 0.0);
            }
            if twist != 0.0 {
                let twist = if share != 1.0 { twist * share } else { twist };
                self.set_s(PAIR_TWIST, row, twist);
                let turn = normal.scale(twist);
                #[cfg(not(target_arch = "wasm32"))]
                (body_a.driven(v3(0.0, 0.0, 0.0), turn.scale(-1.0)), body_b.driven(v3(0.0, 0.0, 0.0), turn));
                body_a.angular = body_a.angular.sub(body_a.inertia.mul(turn));
                body_b.angular = body_b.angular.add(body_b.inertia.mul(turn));
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// Each substep, once the poses have moved: adds to each point's drift how far its two surfaces slid, across the normal.
    /// Each anchor's material point moved by its centre's step, the speed it moved with times h, and by its turn: the arm
    /// from the centre now less that arm turned back by the substep's spin, w h (the pose update turns a body by that).
    /// Tallied in the relaxing pass instead, each point would see the speeds as the points before it in that pass left
    /// them, a slide no pose made, and a resting block would keep a twist in its anchors that eats its friction
    /// (`a_block_slides_only_above_tan_t_equal_to_mu`). Tallied as speed times the step's lever, it missed how a turning body
    /// carries its anchor round, the centripetal w^2 r of a lever r, always the same way: a plate 60 m from a deck's pitch axis
    /// slid 4 mm a pitch through friction three times what it needed (`a_plate_rides_a_deck_turning_about_an_axis_far_away`).
    /// Read off the poses instead, it took in their f32 rounding, a unit of their last place where a resting box moves a
    /// fiftieth of one in a substep, and the anchors' pull on that noise made a pile's top boxes jitter; the turn is a series
    /// in the substep's spin for the same reason.
    pub fn tally_drift(&mut self, h: f32) {
        for i in self.window.pairs.0..self.window.pairs.1 {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            let (substep, substeps) = (self.window.substep, if self.window.substeps > 0 { self.window.substeps } else { self.header().substeps });
            let (linear_a, angular_a) = self.kinematic_velocity(a, substep, substeps, self.v(LINEAR_X, a), self.v(ANGULAR_X, a));
            let (linear_b, angular_b) = self.kinematic_velocity(b, substep, substeps, self.v(LINEAR_X, b), self.v(ANGULAR_X, b));
            let (rotation_a, rotation_b) = (self.pose_rotation(a), self.pose_rotation(b));
            let (turn_a, turn_b) = (angular_a.scale(h), angular_b.scale(h));
            // The arm's move over a turn t, arm - R(-t) arm = t x arm - (t x (t x arm)) / 2 to second order, written so (the
            // turn of a resting body is a few hundred-millionths of a radian, and an arm less its turned self in f32 is its
            // rounding, three times the move).
            let chord = |t: V3, arm: V3| t.cross(arm).sub(t.cross(t.cross(arm)).scale(0.5));
            let normal = self.v(PAIR_NORMAL_X, row);
            // A ball or a capsule touches where its core's nearest point plus its radius along the normal is, as the normal
            // rows read it, not at a point fixed in it: a point fixed in a rolling ball rolls up off the floor over the step, and
            // its move would be a slide no contact made (a capsule rolling across two meshes ended 2 mm off where it ends
            // on one, `next-mesh-seam.test.js`).
            let (round_a, round_b) = (self.round_core(self.uu(PAIR_A, row) as usize), self.round_core(self.uu(PAIR_B, row) as usize));
            for k in 0..self.uu(PAIR_CONTACTS, row) as usize {
                let at = row * MANIFOLD + k;
                let (anchor_a, anchor_b) = (self.v(CONTACT_ANCHOR_A_X, at), self.v(CONTACT_ANCHOR_B_X, at));
                let arm_a = match round_a {
                    Some(core) => rotation_a.rotate(core.nearest(anchor_a)).add(normal.scale(core.radius)),
                    None => rotation_a.rotate(anchor_a),
                };
                let arm_b = match round_b {
                    Some(core) => rotation_b.rotate(core.nearest(anchor_b)).sub(normal.scale(core.radius)),
                    None => rotation_b.rotate(anchor_b),
                };
                let moved_a = linear_a.scale(h).add(chord(turn_a, arm_a));
                let moved_b = linear_b.scale(h).add(chord(turn_b, arm_b));
                let moved = moved_b.sub(moved_a);
                let slide = moved.sub(normal.scale(moved.dot(normal)));
                self.set_v(CONTACT_DRIFT_X, at, self.v(CONTACT_DRIFT_X, at).add(slide));
            }
        }
    }

    /// One pass over the points. `biased`: the soft pass, which pushes; otherwise the relaxing one, which takes the push's
    /// speed back out. `least`: a pair joins only when its island asks for at least this many extra passes (see `step`).
    /// `last`: the last relaxing pass, after which what the points hold is what they gave in this substep.
    ///
    /// Gauss-Seidel over the pairs. Within a pair, friction takes one sweep over the points, the first point turning each
    /// substep; the normal rows sweep until no impulse moves by more than rounding. From one sweep the first point held a
    /// whole strike: a cube dropped flat on its face spun and slid off sideways, and two meeting head on left turning
    /// (`a_cube_dropped_flat_lands_flat`). The soft pass solves friction first, from the normal so far; the relaxing pass
    /// solves the normal first, so friction's cone is what the normal holds once the push is out. From the soft pass's
    /// normal, short of the load by its impulse scale, a block slid that should hold (`a_block_slides_only_above_tan_t_equal_to_mu`).
    #[allow(clippy::too_many_arguments)]
    pub fn solve_contacts(&mut self, h: f32, step: Soft, biased: bool, turn: usize, least: u32, last: bool) {
        let mut impacts = self.window.impacts;
        // The chain spring of `CHAIN_LOAD`, and the load (impulse times the lighter body's inverse mass) a chain pair stays under.
        let passes = self.header().iterations;
        let chain = if biased && passes < 2 {
            let (hertz, damping) = (self.header().contact_hertz, self.header().contact_damping);
            let hertz = if hertz * h > 0.125 { 0.125 / h } else { hertz };
            let g = v3(self.header().gravity[0], self.header().gravity[1], self.header().gravity[2]);
            Some((soft(hertz, damping, h), CHAIN_LOAD * h * sqrt(g.dot(g))))
        } else {
            None
        };
        for i in self.window.pairs.0..self.window.pairs.1 {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            if least > 0 && self.extra_of(a).max(self.extra_of(b)) < least {
                continue;
            }
            let (mut body_a, mut body_b) = self.pair_moving(row, a, b);
            let step = match chain {
                Some((eighth, limit)) if self.is_chain(row, a, b, passes, limit) => eighth,
                _ => step,
            };
            // A contact with a body that does not move may have a stiffness of its own, held under a quarter of the substep rate.
            let step = if self.header().static_hertz > 0.0 && (self.flags(a) & KIND != DYNAMIC || self.flags(b) & KIND != DYNAMIC) {
                let hertz = self.header().static_hertz;
                soft(if hertz * h > 0.25 { 0.25 / h } else { hertz }, self.header().static_damping, h)
            } else {
                step
            };
            // A contact a structure stands on is made as much stiffer as keeps it from tipping (tilt.rs), in the pushing pass. Only
            // where islands step at their own levels: the gains are worked out per island just before it solves, and with fixed
            // substeps (or phase by phase) a gain left from an earlier step would be stale.
            let gain = if self.island_major && self.header().adaptive_substeps != 0 { self.s(PAIR_TILT_GAIN, row) } else { 1.0 };
            let step = if biased && gain > 1.0 {
                let (hertz, damping) = self.pair_hertz(row, a, b, h);
                soft(hertz * sqrt(gain), damping, h)
            } else {
                step
            };
            let given = if biased {
                // Friction in the pushing pass is a switch (Rapier's `friction_in_bias_pass`), but with no relaxing pass to
                // solve it, the pushing one must.
                if self.header().friction_in_bias != 0 || self.header().stabilization == 0 {
                    self.friction_rows(row, step, true, turn, &mut body_a, &mut body_b);
                }
                self.normal_rows(row, a, b, h, step, true, turn, &mut impacts, &mut body_a, &mut body_b)
            } else {
                let given = self.normal_rows(row, a, b, h, step, false, turn, &mut impacts, &mut body_a, &mut body_b);
                self.friction_rows(row, step, false, turn, &mut body_a, &mut body_b);
                given
            };
            // What a point holds after the last relaxing pass is all it gave in this substep, its warm start included.
            if last {
                self.set_s(PAIR_FORCE, row, self.s(PAIR_FORCE, row) + given);
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
        self.window.impacts = impacts;
    }

    /// The frequency and damping ratio of the soft step pair `row` takes in a pushing pass at substep `h`: the chain spring's eighth
    /// of the substep rate at one pass, a static contact's own, or the world's, each held under its cap.
    pub(crate) fn pair_hertz(&self, row: usize, a: usize, b: usize, h: f32) -> (f32, f32) {
        if self.header().static_hertz > 0.0 && (self.flags(a) & KIND != DYNAMIC || self.flags(b) & KIND != DYNAMIC) {
            let hertz = self.header().static_hertz;
            return (if hertz * h > 0.25 { 0.25 / h } else { hertz }, self.header().static_damping);
        }
        let (hertz, damping) = (self.header().contact_hertz, self.header().contact_damping);
        let passes = self.header().iterations;
        if passes < 2 {
            let g = v3(self.header().gravity[0], self.header().gravity[1], self.header().gravity[2]);
            if self.is_chain(row, a, b, passes, CHAIN_LOAD * h * sqrt(g.dot(g))) {
                return (if hertz * h > 0.125 { 0.125 / h } else { hertz }, damping);
            }
        }
        (if hertz * h > 0.25 { 0.25 / h } else { hertz }, damping)
    }

    /// Whether a pair takes the chain spring of `CHAIN_LOAD`: two dynamic bodies, neither dominating, with one pass between
    /// them, carrying less than `limit` (its impulse so far times the lighter body's inverse mass).
    #[inline(always)]
    fn is_chain(&self, row: usize, a: usize, b: usize, passes: u32, limit: f32) -> bool {
        if self.flags(a) & KIND != DYNAMIC || self.flags(b) & KIND != DYNAMIC || self.uu(PAIR_FLAGS, row) & (PAIR_A_RULES | PAIR_B_RULES) != 0 {
            return false;
        }
        if passes.saturating_add(self.extra_of(a).max(self.extra_of(b))) >= 2 {
            return false;
        }
        let mut load = 0.0f32;
        for k in 0..self.uu(PAIR_CONTACTS, row) as usize {
            load += self.s(CONTACT_NORMAL_IMPULSE, row * MANIFOLD + k);
        }
        load * self.s(INVERSE_MASS, a).max(self.s(INVERSE_MASS, b)) < limit
    }

    /// The velocity the surface of a deformable mesh gives a part of pair `row` in this step, as the pair's surface velocity: the
    /// mesh's own if it is the pair's first collider, its negative if the second (see `friction_rows`).
    fn moving_surface(&self, row: usize, first: usize, second: usize) -> V3 {
        let zero = v3(0.0, 0.0, 0.0);
        if self.uu(PAIR_FLAGS, row) & PAIR_IS_PART == 0 || self.uu(PAIR_SUB, row) != crate::world::NONE {
            return zero;
        }
        let triangle = self.uu(PAIR_PART, row) as usize;
        for (collider, sign) in [(first, 1.0f32), (second, -1.0f32)] {
            if self.uu(COLLIDER_SHAPE, collider) == SHAPE_TRIMESH && self.uu(MESH_FLAGS, self.uu(COLLIDER_HULL, collider) as usize) & MESH_AIMED != 0 {
                return self.mesh_surface_velocity(collider, triangle).scale(sign);
            }
        }
        zero
    }

    /// A pair's friction, one sweep over the points, each in a circular cone of mu times its normal impulse so far.
    fn friction_rows(&mut self, row: usize, step: Soft, biased: bool, turn: usize, body_a: &mut Moving, body_b: &mut Moving) {
        if self.header().friction_model == 1 && self.uu(PAIR_CONTACTS, row) > 1 {
            return self.simplified_friction(row, step, biased, body_a, body_b);
        }
        let normal = self.v(PAIR_NORMAL_X, row);
        let tangent = self.v(PAIR_TANGENT_X, row);
        let other = normal.cross(tangent);
        let friction = self.s(PAIR_FRICTION, row);
        let surface = self.v(PAIR_SURFACE_X, row);
        let count = self.uu(PAIR_CONTACTS, row) as usize;
        for k in 0..count {
            let at = row * MANIFOLD + (k + turn) % count;
            let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
            let pressed = self.s(CONTACT_NORMAL_IMPULSE, at);
            let held = self.v(CONTACT_TANGENT_X, at);
            let drift = self.v(CONTACT_DRIFT_X, at);
            // A surface that moves (a conveyor) is a relative velocity that sliding is brought to, not to zero.
            let relative = body_b.at(arm_b).sub(body_a.at(arm_a)).sub(surface);
            let slide = relative.sub(normal.scale(relative.dot(normal)));
            let (mass_scale, impulse_scale, target) = if biased {
                (step.mass_scale, step.impulse_scale, slide.add(drift.scale(step.bias_rate)))
            } else {
                (1.0, 0.0, slide)
            };
            let along = -self.s(CONTACT_TANGENT_MASS, at) * mass_scale * target.dot(tangent) - impulse_scale * held.dot(tangent);
            let across = -self.s(CONTACT_OTHER_MASS, at) * mass_scale * target.dot(other) - impulse_scale * held.dot(other);
            let mut next = held.add(tangent.scale(along)).add(other.scale(across));
            let most = friction * pressed;
            let squared = next.dot(next);
            if squared > most * most {
                let cut = most / sqrt(squared);
                next = next.scale(cut);
                // Only the last word counts: within a substep the first point of a manifold sees the whole load. The anchor
                // comes along, to where the cone holds it: a sliding block pulls it along, and one that stops holds from there.
                if !biased {
                    self.set_v(CONTACT_DRIFT_X, at, drift.scale(cut));
                }
            }
            let applied = next.sub(held);
            body_a.push(applied.scale(-1.0), arm_a);
            body_b.push(applied, arm_b);
            self.set_v(CONTACT_TANGENT_X, at, next);
        }
    }

    /// The simplified friction model (Rapier's `FrictionModel::Simplified`): one friction constraint for the whole manifold, at the mean
    /// of its points, in a circular cone of mu times the load the points hold together, and a twist about the normal, limited by mu
    /// times each point's load times its distance from that mean (the limit surface of a patch, Goyal, Ruina and Papadopoulos 1991).
    /// The manifold's impulse is held as an equal share on each point, so the warm start puts back the same force and the same
    /// moment about the mean. A single point has no patch to twist on and takes the point rows.
    fn simplified_friction(&mut self, row: usize, step: Soft, biased: bool, body_a: &mut Moving, body_b: &mut Moving) {
        let normal = self.v(PAIR_NORMAL_X, row);
        let tangent = self.v(PAIR_TANGENT_X, row);
        let other = normal.cross(tangent);
        let friction = self.s(PAIR_FRICTION, row);
        let surface = self.v(PAIR_SURFACE_X, row);
        let count = self.uu(PAIR_CONTACTS, row) as usize;
        let share = 1.0 / count as f32;
        let (mut arm_a, mut arm_b) = (v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0));
        let (mut held, mut drift, mut pressed) = (v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), 0.0f32);
        for k in 0..count {
            let at = row * MANIFOLD + k;
            arm_a = arm_a.add(self.v(CONTACT_ARM_A_X, at));
            arm_b = arm_b.add(self.v(CONTACT_ARM_B_X, at));
            held = held.add(self.v(CONTACT_TANGENT_X, at));
            drift = drift.add(self.v(CONTACT_DRIFT_X, at));
            pressed += self.s(CONTACT_NORMAL_IMPULSE, at);
        }
        let (arm_a, arm_b, drift) = (arm_a.scale(share), arm_b.scale(share), drift.scale(share));
        let relative = body_b.at(arm_b).sub(body_a.at(arm_a)).sub(surface);
        let slide = relative.sub(normal.scale(relative.dot(normal)));
        let (mass_scale, impulse_scale, target) = if biased {
            (step.mass_scale, step.impulse_scale, slide.add(drift.scale(step.bias_rate)))
        } else {
            (1.0, 0.0, slide)
        };
        let mass_along = 1.0 / (body_a.give(tangent, arm_a) + body_b.give(tangent, arm_b));
        let mass_across = 1.0 / (body_a.give(other, arm_a) + body_b.give(other, arm_b));
        let along = -mass_along * mass_scale * target.dot(tangent) - impulse_scale * held.dot(tangent);
        let across = -mass_across * mass_scale * target.dot(other) - impulse_scale * held.dot(other);
        let mut next = held.add(tangent.scale(along)).add(other.scale(across));
        let most = friction * pressed;
        let squared = next.dot(next);
        if squared > most * most {
            let cut = most / sqrt(squared);
            next = next.scale(cut);
            if !biased {
                for k in 0..count {
                    let at = row * MANIFOLD + k;
                    self.set_v(CONTACT_DRIFT_X, at, self.v(CONTACT_DRIFT_X, at).scale(cut));
                }
            }
        }
        let applied = next.sub(held);
        body_a.push(applied.scale(-1.0), arm_a);
        body_b.push(applied, arm_b);
        for k in 0..count {
            self.set_v(CONTACT_TANGENT_X, row * MANIFOLD + k, next.scale(share));
        }
        // The twist: the relative turn about the normal, brought to rest within what the points' loads and their spread can hold.
        let mut reach = 0.0f32;
        for k in 0..count {
            let at = row * MANIFOLD + k;
            let spread = self.v(CONTACT_ARM_A_X, at).sub(arm_a);
            let flat = spread.sub(normal.scale(spread.dot(normal)));
            reach += self.s(CONTACT_NORMAL_IMPULSE, at) * sqrt(flat.dot(flat));
        }
        let turn = body_b.angular.sub(body_a.angular).dot(normal);
        let (ia, ib) = (body_a.inertia.mul(normal).dot(normal), body_b.inertia.mul(normal).dot(normal));
        if ia + ib > 0.0 {
            let held_twist = self.s(PAIR_TWIST, row);
            let wanted = held_twist - (mass_scale * turn / (ia + ib) + impulse_scale * held_twist);
            let limit = friction * reach;
            let next_twist = if wanted > limit { limit } else if wanted < -limit { -limit } else { wanted };
            let delta = next_twist - held_twist;
            #[cfg(not(target_arch = "wasm32"))]
            (body_a.driven(v3(0.0, 0.0, 0.0), normal.scale(-delta)), body_b.driven(v3(0.0, 0.0, 0.0), normal.scale(delta)));
            body_a.angular = body_a.angular.sub(body_a.inertia.mul(normal.scale(delta)));
            body_b.angular = body_b.angular.add(body_b.inertia.mul(normal.scale(delta)));
            self.set_s(PAIR_TWIST, row, next_twist);
        }
    }

    /// A pair's normal rows; returns what its points hold. Each row's update is the one a single point always had; the sweeps
    /// run on the points' speeds alone, through the manifold's own J M^-1 J^T, and the impulses land on the bodies at the end.
    #[allow(clippy::too_many_arguments)]
    fn normal_rows(
        &mut self,
        row: usize,
        a: usize,
        b: usize,
        h: f32,
        step: Soft,
        biased: bool,
        turn: usize,
        impacts: &mut usize,
        body_a: &mut Moving,
        body_b: &mut Moving,
    ) -> f32 {
        let max_push = self.header().contact_max_push;
        let slop = self.header().contact_slop;
        let threshold = self.bounce_speed(h);
        let (center_a, center_b) = (self.pose_center(a), self.pose_center(b));
        let (rotation_a, rotation_b) = (self.pose_rotation(a), self.pose_rotation(b));
        let normal = self.v(PAIR_NORMAL_X, row);
        let bounce = self.s(PAIR_RESTITUTION, row);
        let later = self.uu(PAIR_FLAGS, row) & PAIR_STRIKE_LATER != 0;
        let surface_normal = self.v(PAIR_SURFACE_X, row).dot(normal);
        let count = self.uu(PAIR_CONTACTS, row) as usize;
        let zero = v3(0.0, 0.0, 0.0);
        let (round_a, round_b) = (self.round_core(self.uu(PAIR_A, row) as usize), self.round_core(self.uu(PAIR_B, row) as usize));
        let (mut hold, mut was, mut speed, mut approach) = ([0.0f32; MANIFOLD], [0.0f32; MANIFOLD], [0.0f32; MANIFOLD], [0.0f32; MANIFOLD]);
        let mut open = [0.0f32; MANIFOLD];
        let (mut bias, mut scale, mut leak, mut most) = ([0.0f32; MANIFOLD], [0.0f32; MANIFOLD], [0.0f32; MANIFOLD], [f32::MAX; MANIFOLD]);
        let (mut turn_a, mut turn_b, mut spin_a, mut spin_b) = ([zero; MANIFOLD], [zero; MANIFOLD], [zero; MANIFOLD], [zero; MANIFOLD]);
        for k in 0..count {
            let at = row * MANIFOLD + k;
            let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
            let pressed = self.s(CONTACT_NORMAL_IMPULSE, at);
            // The gap from where the bodies are now. A ball or a capsule meets the other surface at its core plus its radius
            // along the normal, wherever it has turned to; a point fixed in it would rise off the floor as it rolls.
            let (anchor_a, anchor_b) = (self.v(CONTACT_ANCHOR_A_X, at), self.v(CONTACT_ANCHOR_B_X, at));
            let on_a = match round_a {
                Some(core) => center_a.add(rotation_a.rotate(core.nearest(anchor_a))).add(normal.scale(core.radius)),
                None => center_a.add(rotation_a.rotate(anchor_a)),
            };
            let on_b = match round_b {
                Some(core) => center_b.add(rotation_b.rotate(core.nearest(anchor_b))).sub(normal.scale(core.radius)),
                None => center_b.add(rotation_b.rotate(anchor_b)),
            };
            // A moving surface has come on by what it made since the step began: the gap closes by that, and the speed counts it.
            let gap = on_b.sub(on_a).dot(normal) - surface_normal * h * (turn as f32);
            (hold[k], was[k]) = (pressed, pressed);
            speed[k] = body_b.at(arm_b).sub(body_a.at(arm_a)).dot(normal) - surface_normal;
            // A bouncy pair's approach is its pre-solve speed (`note_approach`), not one an earlier pair's push gave in this pass.
            approach[k] = if bounce > 0.0 { self.s(CONTACT_APPROACH, at) } else { speed[k] };
            open[k] = gap;
            (bias[k], scale[k], leak[k]) = if gap > 0.0 {
                (gap / h, 1.0, 0.0)
            } else if biased && gap + slop > 0.0 {
                // Inside the slop the point closes to the slop's depth as a speculative row, rigidly (Catto's Solver2D
                // soft step). A soft row here, with nothing to push, let a point sink at a speed that followed its load,
                // so a cube on a slope tilted downhill for its first second.
                ((gap + slop) / h, 1.0, 0.0)
            } else if biased {
                let depth = gap + slop;
                let depth = if depth < 0.0 { depth } else { 0.0 };
                let push = step.bias_rate * depth;
                (if push > -max_push { push } else { -max_push }, step.mass_scale, step.impulse_scale)
            } else {
                (0.0, 1.0, 0.0)
            };
            // A relaxing pass only takes back. A gap still open is met by the next biased pass, which is where a strike is
            // noticed; acting here would slow the body first and hide it.
            if !biased && gap > 0.0 {
                most[k] = pressed;
            }
            // A strike into a line the pass left for a later substep stays open here, in the pushing and the relaxing passes
            // alike: the pass strikes it one pair at a time (`collide_pairwise`, PAIR_STRIKE_LATER) the next substep, from
            // an overlap of at most what this substep's other rows added to its speed, times h. Held in the relaxing pass,
            // the overlap stopped it dead, a strike with no bounce.
            if later && approach[k] < -threshold {
                most[k] = 0.0;
            }
            (turn_a[k], turn_b[k]) = (arm_a.cross(normal), arm_b.cross(normal));
            (spin_a[k], spin_b[k]) = (body_a.inertia.mul(turn_a[k]), body_b.inertia.mul(turn_b[k]));
        }
        let along = normal.mul(normal).dot(body_a.mass.add(body_b.mass));
        // Four points of one plane push the bodies through three numbers, a force and two turns, so one pattern of their
        // impulses moves no body: `null`, with sum zero and no turn about either body. On a soft row only the leak sees it,
        // and Gauss-Seidel settles it by about the leak a sweep (3 percent at the defaults), so the sweeps used to run out
        // first. Each sweep ends with the exact step along it, the minimum of the rows' quadratic on that line, cut to the bounds.
        let (mut null, mut cfm) = ([0.0f32; MANIFOLD], [0.0f32; MANIFOLD]);
        let mut along_null = false;
        if count == 4 {
            let tangent = self.v(PAIR_TANGENT_X, row);
            let other = normal.cross(tangent);
            let (u, w): ([f32; 4], [f32; 4]) = (core::array::from_fn(|i| turn_a[i].dot(tangent)), core::array::from_fn(|i| turn_a[i].dot(other)));
            // The cross product of the rows (1, 1, 1, 1), u and w in four dimensions: each entry a signed 3 x 3 minor.
            let minor = |a: usize, b: usize, c: usize| (u[b] * w[c] - u[c] * w[b]) - (u[a] * w[c] - u[c] * w[a]) + (u[a] * w[b] - u[b] * w[a]);
            null = [minor(1, 2, 3), -minor(0, 2, 3), minor(0, 1, 3), -minor(0, 1, 2)];
            let mut curve = 0.0f32;
            for k in 0..4 {
                let mass = self.s(CONTACT_NORMAL_MASS, row * MANIFOLD + k);
                cfm[k] = if mass > 0.0 { leak[k] / (mass * scale[k]) } else { 0.0 };
                curve += cfm[k] * null[k] * null[k];
            }
            along_null = curve > 0.0;
        }
        // The exact solve of the manifold's normal rows, when the world asks for it: no sweeps then, unless no active set holds.
        let blocked = self.header().block_solver != 0 && count >= 2 && {
            let mut k = [[0.0f32; MANIFOLD]; MANIFOLD];
            let (mut g, mut c) = ([0.0f32; MANIFOLD], [0.0f32; MANIFOLD]);
            for i in 0..count {
                for j in 0..count {
                    k[i][j] = along + turn_a[j].dot(spin_a[i]) + turn_b[j].dot(spin_b[i]);
                }
                let mass = self.s(CONTACT_NORMAL_MASS, row * MANIFOLD + i);
                let cfm = if mass * scale[i] > 0.0 { leak[i] / (mass * scale[i]) } else { 0.0 };
                c[i] = cfm + REGULARISE * k[i][i];
            }
            for i in 0..count {
                g[i] = speed[i] + bias[i] - (0..count).map(|j| k[i][j] * hold[j]).sum::<f32>();
            }
            let found = block_normal(count, &k, &g, &c, &most, &mut hold);
            #[cfg(feature = "counts")]
            BLOCK_SOLVES[(!found) as usize].fetch_add(1, core::sync::atomic::Ordering::Relaxed);
            found
        };
        let mut sweeps = 0;
        while !blocked {
            let (mut moved, mut largest) = (0.0f32, 0.0f32);
            for k in 0..count {
                let i = (k + turn) % count;
                let change = -self.s(CONTACT_NORMAL_MASS, row * MANIFOLD + i) * scale[i] * (speed[i] + bias[i]) - leak[i] * hold[i];
                let total = hold[i] + change;
                let total = if total > 0.0 { total } else { 0.0 };
                let total = if total > most[i] { most[i] } else { total };
                let applied = total - hold[i];
                if applied != 0.0 {
                    for j in 0..count {
                        speed[j] += (along + turn_a[j].dot(spin_a[i]) + turn_b[j].dot(spin_b[i])) * applied;
                    }
                    hold[i] = total;
                }
                let size = if applied < 0.0 { -applied } else { applied };
                moved = if size > moved { size } else { moved };
                largest = if total > largest { total } else { largest };
            }
            if along_null {
                let (mut slope, mut curve) = (0.0f32, 0.0f32);
                let (mut low, mut high) = (f32::MIN, f32::MAX);
                for k in 0..4 {
                    slope += null[k] * (speed[k] + bias[k] + cfm[k] * hold[k]);
                    curve += cfm[k] * null[k] * null[k];
                    if null[k] > 0.0 {
                        low = low.max(-hold[k] / null[k]);
                        high = high.min((most[k] - hold[k]) / null[k]);
                    } else if null[k] < 0.0 {
                        low = low.max((most[k] - hold[k]) / null[k]);
                        high = high.min(-hold[k] / null[k]);
                    }
                }
                let t = -slope / curve;
                let t = if t < low { low } else if t > high { high } else { t };
                if low <= high && t != 0.0 {
                    for k in 0..4 {
                        let total = hold[k] + t * null[k];
                        hold[k] = if total > 0.0 { if total > most[k] { most[k] } else { total } } else { 0.0 };
                    }
                }
            }
            sweeps += 1;
            #[cfg(feature = "counts")]
            NORMAL_UPDATES[if biased { 0 } else { 1 }].fetch_add(count as u64, core::sync::atomic::Ordering::Relaxed);
            // A lone point is exact in one sweep.
            if count == 1 || moved <= f32::EPSILON * largest || sweeps == SWEEPS {
                break;
            }
        }
        let mut given = 0.0;
        for k in 0..count {
            let at = row * MANIFOLD + k;
            let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
            let applied = normal.scale(hold[k] - was[k]);
            self.set_s(CONTACT_NORMAL_IMPULSE, at, hold[k]);
            given += hold[k];
            body_a.push(applied.scale(-1.0), arm_a);
            body_b.push(applied, arm_b);
            // A strike: the speed the point came in at, before any point of the manifold pushed.
            if biased && bounce > 0.0 && was[k] == 0.0 && hold[k] > 0.0 && approach[k] < -threshold {
                // A point struck across an open gap meets the surface faster than it is moving now, by what gravity adds
                // over the gap: v^2 = v0^2 + 2 a d, constant acceleration over the distance. Taking the speed of now left the
                // bounce short by about g h (4.5 mm of 0.25 m at 4 substeps).
                let pull = self.gravity_pull(a, b).dot(normal);
                let (gap, now) = (open[k], approach[k]);
                let approach = if gap > 0.0 && pull < 0.0 { -sqrt(now * now - 2.0 * pull * gap) } else { now };
                self.set_s(CONTACT_APPROACH, at, approach);
                // A window's strikes are listed in its own run of the column: at most one a point of its pairs.
                self.set_u(IMPACTS, self.window.pairs.0 * MANIFOLD + *impacts, at as u32);
                *impacts += 1;
            }
        }
        given
    }

    /// A ball's or a capsule's core in its body's frame, from the centre of mass: the segment from `middle - half` to
    /// `middle + half` (a point for a ball), and the radius around it. None for any other shape.
    fn round_core(&self, collider: usize) -> Option<RoundCore> {
        let shape = self.uu(COLLIDER_SHAPE, collider);
        if shape != SHAPE_BALL && shape != SHAPE_CAPSULE {
            return None;
        }
        let body = self.uu(COLLIDER_BODY, collider) as usize;
        let middle = self.v(COLLIDER_X, collider).sub(self.v(LOCAL_CENTER_X, body));
        let half = if shape == SHAPE_CAPSULE {
            self.q(COLLIDER_ROTATION_X, collider).rotate(v3(0.0, self.s(COLLIDER_B, collider), 0.0))
        } else {
            v3(0.0, 0.0, 0.0)
        };
        // A skin is part of the radius: the surface the contact is solved against is a skin further out.
        Some(RoundCore { middle, half, radius: self.s(COLLIDER_A, collider) + self.s(COLLIDER_SKIN, collider) })
    }

    /// Gravity's acceleration of b against a: none on a body the solve does not move.
    fn gravity_pull(&self, a: usize, b: usize) -> V3 {
        let g = self.header().gravity;
        let g = v3(g[0], g[1], g[2]);
        let pull = |at: usize| {
            if self.flags(at) & (KIND | SLEEPING) == DYNAMIC && self.s(INVERSE_MASS, at) > 0.0 { g.scale(self.s(GRAVITY_SCALE, at)) } else { v3(0.0, 0.0, 0.0) }
        };
        pull(b).sub(pull(a))
    }

    /// Speed under which a contact is rest: two substeps of gravity.
    fn bounce_speed(&self, h: f32) -> f32 {
        let g = self.header().gravity;
        2.0 * sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) * h
    }

    /// Sends the points struck in this substep off at their restitution, after relaxing took the push back out, and then
    /// solves the struck pair's friction again in the cone of the whole impulse. Coulomb friction acts through the restitution
    /// phase of an impact as through the compression (Brody 1984; Cross 2002, eqs. 11 to 13): a ball sliding through a bounce
    /// loses mu (1 + e) times its approach speed along the surface, not mu times it, and one that grips leaves rolling.
    /// Solved from the relaxed normal alone, a tennis ball bounced at 20 degrees on wood kept 0.92 of its speed along the
    /// surface where Cross measured 0.84, and at 45 degrees it slid where it rolls (`tests/rigid-materials.test.js`).
    pub fn solve_impacts(&mut self, turn: usize) {
        let first = self.window.pairs.0 * MANIFOLD;
        let last = first + self.window.impacts;
        let mut i = first;
        // A pair's struck points are listed together (`normal_rows`): each run takes its normals, then one friction sweep.
        while i < last {
            let row = self.uu(IMPACTS, i) as usize / MANIFOLD;
            let (a, b) = self.pair_bodies(row as u32);
            let (mut body_a, mut body_b) = self.pair_moving(row, a, b);
            let normal = self.v(PAIR_NORMAL_X, row);
            while i < last && self.uu(IMPACTS, i) as usize / MANIFOLD == row {
                let at = self.uu(IMPACTS, i) as usize;
                let (arm_a, arm_b) = (self.v(CONTACT_ARM_A_X, at), self.v(CONTACT_ARM_B_X, at));
                let speed = body_b.at(arm_b).sub(body_a.at(arm_a)).dot(normal);
                let wanted = -self.s(PAIR_RESTITUTION, row) * self.s(CONTACT_APPROACH, at);
                let pressed = self.s(CONTACT_NORMAL_IMPULSE, at);
                let free = self.s(CONTACT_NORMAL_MASS, at) * (wanted - speed);
                // A body a joint holds bounces with the joints holding it (`held_response`), as in `collide_pairwise`.
                self.settle(a, &body_a);
                self.settle(b, &body_b);
                let held = self.held_response(row, a, b, normal, arm_a, arm_b, free);
                let total = pressed + match &held {
                    Some(held) => (wanted - speed) / held.inverse,
                    None => free,
                };
                let total = if total > 0.0 { total } else { 0.0 };
                self.set_s(CONTACT_NORMAL_IMPULSE, at, total);
                self.set_s(PAIR_FORCE, row, self.s(PAIR_FORCE, row) + total - pressed);
                match &held {
                    Some(held) => {
                        self.apply_held(held, total - pressed);
                        (body_a, body_b) = self.pair_moving(row, a, b);
                    }
                    None => {
                        let applied = normal.scale(total - pressed);
                        body_a.push(applied.scale(-1.0), arm_a);
                        body_b.push(applied, arm_b);
                    }
                }
                i += 1;
            }
            // Unbiased, so the soft step's scales are not read.
            let plain = Soft { bias_rate: 0.0, mass_scale: 1.0, impulse_scale: 0.0 };
            self.friction_rows(row, plain, false, turn, &mut body_a, &mut body_b);
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
        self.window.impacts = 0;
    }
}

/// The most bodies one substep's strikes move to their time of impact (`collide_pairwise`); past them a strike's body moves
/// with the substep as it did before, by up to its gap.
pub const SHIFTS: usize = 64;

/// What `collide_pairwise` moves each struck body by once the substep has moved it: its centre and a rotation vector.
pub struct Shifts {
    pub count: usize,
    pub entries: [(usize, V3, V3); SHIFTS],
    /// Whether a pair was marked PAIR_STRIKE_LATER this substep.
    pub later: bool,
}

impl Shifts {
    fn add(&mut self, body: usize, shift: V3, turn: V3) {
        if let Some(entry) = self.entries[..self.count].iter_mut().find(|entry| entry.0 == body) {
            (entry.1, entry.2) = (entry.1.add(shift), entry.2.add(turn));
        } else if self.count < SHIFTS {
            self.entries[self.count] = (body, shift, turn);
            self.count += 1;
        }
    }
}

/// A round shape's core: a segment in its body's frame and the radius around it.
#[derive(Clone, Copy)]
struct RoundCore {
    middle: V3,
    half: V3,
    radius: f32,
}

impl RoundCore {
    /// The core's point nearest a point of the body's frame.
    #[inline(always)]
    fn nearest(&self, point: V3) -> V3 {
        let length = self.half.dot(self.half);
        if length == 0.0 {
            return self.middle;
        }
        let t = point.sub(self.middle).dot(self.half) / length;
        let t = if t < -1.0 { -1.0 } else if t > 1.0 { 1.0 } else { t };
        self.middle.add(self.half.scale(t))
    }
}

/// Solves a manifold's normal rows exactly: the loads `hold` in [0, most] with, for every point, `w = g + (K hold)_i + c_i hold_i`
/// zero where the load is between its bounds, not below zero where it is zero and not above zero where it is at `most`. Each
/// assignment of points to free, at zero or at `most` (a point with no finite `most` is never at it) is tried in a fixed order,
/// the free block solved by Cholesky (Baraff 1994, principal pivoting; Catto 2006 and 2024 for two points), and the first that
/// meets all three conditions within a few roundings of the terms it adds is taken. `c` is positive, so `K + diag(c)` is
/// positive definite and the answer is the only one. False, with `hold` as it was, when none is accepted.
fn block_normal(count: usize, k: &[[f32; MANIFOLD]; MANIFOLD], g: &[f32; MANIFOLD], c: &[f32; MANIFOLD], most: &[f32; MANIFOLD], hold: &mut [f32; MANIFOLD]) -> bool {
    let slack = 16.0 * f32::EPSILON;
    let mut combinations = 1usize;
    for _ in 0..count {
        combinations *= 3;
    }
    for code in 0..combinations {
        // The state of each point: 0 free, 1 at zero, 2 at its most.
        let (mut state, mut rest) = ([0u8; MANIFOLD], code);
        for slot in state.iter_mut().take(count) {
            *slot = (rest % 3) as u8;
            rest /= 3;
        }
        if (0..count).any(|i| state[i] == 2 && !(most[i] < f32::MAX)) {
            continue;
        }
        let mut lambda = [0.0f32; MANIFOLD];
        let (mut free, mut n) = ([0usize; MANIFOLD], 0);
        for i in 0..count {
            match state[i] {
                0 => {
                    free[n] = i;
                    n += 1;
                }
                2 => lambda[i] = most[i],
                _ => {}
            }
        }
        // The free block, A lambda_F = -g - K_FX x_X, by Cholesky.
        let mut a = [[0.0f32; MANIFOLD]; MANIFOLD];
        let mut r = [0.0f32; MANIFOLD];
        for p in 0..n {
            let i = free[p];
            r[p] = -g[i] - (0..count).filter(|&j| state[j] != 0).map(|j| k[i][j] * lambda[j]).sum::<f32>();
            for q in 0..n {
                a[p][q] = k[i][free[q]] + if p == q { c[i] } else { 0.0 };
            }
        }
        let mut sound = true;
        for p in 0..n {
            for q in 0..=p {
                let mut sum = a[p][q];
                for t in 0..q {
                    sum -= a[p][t] * a[q][t];
                }
                if p == q {
                    if !(sum > 0.0) || !sum.is_finite() {
                        sound = false;
                    }
                    a[p][p] = sqrt(if sum > 0.0 { sum } else { 1.0 });
                } else {
                    a[p][q] = sum / a[q][q];
                }
            }
        }
        if !sound {
            continue;
        }
        for p in 0..n {
            let mut sum = r[p];
            for t in 0..p {
                sum -= a[p][t] * r[t];
            }
            r[p] = sum / a[p][p];
        }
        for p in (0..n).rev() {
            let mut sum = r[p];
            for t in p + 1..n {
                sum -= a[t][p] * r[t];
            }
            r[p] = sum / a[p][p];
        }
        for p in 0..n {
            lambda[free[p]] = r[p];
        }
        let mut accepted = true;
        for i in 0..count {
            let mut terms = g[i].abs();
            let mut w = g[i] + c[i] * lambda[i];
            for j in 0..count {
                let push = k[i][j] * lambda[j];
                w += push;
                terms += push.abs();
            }
            let room = slack * terms;
            accepted &= match state[i] {
                0 => lambda[i] >= -slack * lambda[i].abs().max(terms) && !(lambda[i] > most[i] + slack * lambda[i].abs()),
                1 => w >= -room,
                _ => w <= room,
            };
            if !accepted {
                break;
            }
        }
        if accepted {
            for i in 0..count {
                hold[i] = if lambda[i] > 0.0 { if lambda[i] > most[i] { most[i] } else { lambda[i] } } else { 0.0 };
            }
            return true;
        }
    }
    false
}
