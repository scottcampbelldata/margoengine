// Joints. One six-axis joint serves every kind: each axis along or about frame A is locked, limited, driven by a motor, or
// free. A hinge is a joint with one free turning axis. Each substep:
//
//   integrate velocities; rows; warm start; settling passes; one pushing pass; integrate poses; rows; relaxing pass.
//
// Locks are rigid. Along a path of joints J M^-1 J^T is block tridiagonal, the sparsity Baraff 1996 uses, so block Cholesky
// solves a path exactly in one sweep: Gauss-Seidel moves a load one joint a pass, so a light chain under a heavy end would
// stretch for seconds. A path nothing leans on closes its whole error in the pushing pass and takes the speed of that push
// back out in the relaxing pass, on rows from the new pose: the two stages of RATTLE (Andersen 1983, in Hairer's notes,
// section V.5), which is why a pendulum keeps its period. Where a branch or a ring ends a path, paths meet by block
// Gauss-Seidel and close joint_loose_share of the error a substep: a full push fights its neighbours' pushes.
//
// The pushing pass is the only one that carries a position bias, and it is the only one the warm start does not remember.
// Remembering it makes a mode the passes have not settled a triple integrator, error from speed from impulse, whose one
// feedback is the error itself, and that grows at any share (the derivation is in docs/clean-room.md, row PK24). A soft
// row has its own way out, the gamma term below, which is why contacts can remember everything.
//
// Memory is only a guess, and the solve's own measure says when it is a bad one. A pass over the rows descends
// f(p) = 1/2 p^T K p + p^T J v, the energy an impulse p adds, with K = J M^-1 J^T, and the memory m stands at f(m) where a cold
// start stands at 0. A load that is right has its minimum at 1. An impact is no load: a limit that caught a swing holds the
// swing's whole impulse, and handing that back returns the swing. Rows that ask the impossible hold more still, in directions
// J^T m nearly cancels, which nothing corrects as they move nothing: once the rows turn that is a kick, the kick turns the
// rows faster, and speeds run away. So a warm start that would add more than one push's energy to its island is taken only as
// far as f's minimum along m, and the rest is forgotten. That is what the search limits, and only the memory: the passes
// still solve the rows, so a limit that forgets starts its substep cold. On the proof scenes it acts once per catch of a
// stop and nowhere else, and each figure in tests/joints.rs reads the same with it off. No paper does this: the search is
// the exact minimum of a quadratic along a line, the rule Buss 2009 uses for its Jacobian transpose step, and its use on a
// warm start is ours.
//
// Rows can depend on each other: a body held by more locks than it has freedoms, or a chain pulled straight. The factors drop
// such a row, as Baraff 1996 says K is singular there, and that takes a test that can see it. K is never formed. With
// F F^T = M^-1 per body, K = A^T A for A = F^T J^T, and the R of Householder QR of A with column pivoting is K's Cholesky
// factor with complete pivoting (Higham 1990, section 5.2). Along a path A is block banded, so each joint's front holds only
// the rows of A its columns reach: what the joint before left free on the body they share, at most six, and the six of its
// other body. Its pivot is the column with the most of its own length left, and a column with under n u of its squared
// length left depends on the others: Higham's stop (4.3) with his n u, on the matrix scaled to a unit diagonal, n the rows
// of the path and u f32's epsilon, as the rows are f32. Eliminating K itself joint by joint cannot see it: his Lemma 2.1
// puts W^T E W into each Schur complement, W = K11^-1 K12, and with no pivoting across joints W has any size. A slider 13 m
// from a kinematic body, a spherical joint 43 m long and a slider to a second kinematic body, 13 rows on 12 freedoms, left a
// pivot of 4e-7 of its row where rationals give exactly 0, and a web of joints spun a body at 4.8e6 rad/s. Reflections
// round a column by the doubles' share of its own length, times 1 + |W| (his Theorem 5.2) and not its square, and that row
// now reads 1e-32 of its size.
//
// Close to such a pose the rows are not dependent yet, and the exact solve needs speeds of 1 / angle to close what they ask.
// A push is a Gauss-Newton step, and there its first order model holds only for a small turn: Buss and Kim 2005's two links
// pulled nearly straight, the same pose as an arm reaching for what it cannot reach. Their section 4 bounds such a step by
// gamma = min(1, N / M) gamma_max, N what is asked and M what the parts would each move, which M far over N shows cancelling.
// Here N is what a path asks, M the fastest any of its bodies would go at its centre plus its arm, gamma_max is TURN, and in a
// substep a body's turn may rise by no more than gamma, nor its centre by more than gamma of its arm, which turns a row as a
// spin does. A rise, as a push that takes back a limit's kick slows its body and has nothing to cut. Only the pushing pass's
// position bias is cut: the speeds along the locks are solved whole first, so speeds stay exact, and what is cut stays in
// the error for the next substep. They damp each singular direction apart; a path has no decomposition, so the whole push
// is cut, and the useful part of it waits too, which is the cost they name for a plain clamp. TURN is measured: at pi / 4,
// the paper's value, a taut chain reaches 39 m/s, and at 0.1 it starts to cut the chain of fifty. At 0.2 it cuts nothing in
// tests/joints.rs, a turn whose rows are out by 2 percent of their arm.
//
// A lock's position bias is capped too, at joint_max_push and what the turning carries its anchors. Pairs are found once a
// step, over the motion the step expects, so a body a push moved further than that would land past what should stop it, as in
// a_stretched_joint_does_not_jump_a_body_past_a_wall. A gap that wide takes more substeps to close, which on the proof
// scenes means 5 rows of 6,960 in the limb, and the figures do not move. It is Buss and Kim's ClampMag, and the turning term
// is their D_max,i = d_i + D_max: a cap under what the end moves anyway loses to it, as rows that turn open r (h w)^2 / 2 a
// substep, which r w h covers up to a turn of 2 radians.
//
// A limit stops and starts, so it is a row of its own, in two halves. Up to its edge it is rigid, and a gap still open lets
// the axis close it within this substep and no more, so it stops a swing dead and holds any load. Past its edge it pushes as
// a contact does, a spring and damper in implicit form (Catto 2011) with the contact's frequency, so a limit and a floor
// that cannot both hold come to rest instead of trading a rigid push for ever. Its stiffness is per unit of effective mass:
// a wrist pushes out as fast as a thigh. Being soft it remembers all it gives, as a contact does. Its row is the Schur
// complement of the joint's own locks: on the free body alone the locks would take most of each impulse back, the passes would
// not settle that in a substep, and what the warm start then remembered sent a rod off its stop at a quarter of its speed.
//
// A motor or spring is a force, so it is a soft row and is not relaxed: gamma = 1 / (h (c + h k)), bias = h k gamma C, and
//
//   impulse = -(Cdot + bias + gamma impulse_so_far) / (K + gamma)
//
// which is implicit Euler of the spring (Catto 2011), stable at any stiffness. In the acceleration model k and c are
// taken per unit of effective mass, so a motor moves a light limb and a heavy one alike.
//
// A lock's rows are read from the poses a substep begins at, and so is the arm its pull turns a body by. A body pulled
// outward along an arm r by a force F is turned back across that arm with the stiffness F . r: a light link of a taut chain,
// pulled at both ends by the tension T, is a spring of 2 T r on its inertia I, and held as rows hold it, explicitly, it
// stands only while sqrt(2 T r / I) h stays under 2. A chain of fifty 1 kg balls laid out level and swung taut by a 1000 kg
// end carries 3 M g, 29 kN, at the bottom of its swing: 1,700 rad/s against the 960 a substep of 1 / 480 s holds, and it read
// 1,148 m long within 20 s (KB2161). That stiffness is the geometric stiffness of Tournier et al. 2015, the change of
// J^T lambda with the poses: for a lock of all three sliding axes [lambda]x [r]x on each body's turning and nothing else
// (their Eq 22), read with the forces of the step before. They put h^2 of it into the mass of a backward Euler step,
// (M - h^2 K) v+ = M v + h f + J^T mu (their Eq 21), which damps every turn a force does not follow, a swing among them:
// measured here, a bob's period at 90 degrees came out 3.1 percent short and the double pendulum of tests/joints.rs lost
// 11 J where its bar is 0.098 J (Andrews, Teichmann and Kry 2017 report that loss of the term too). A joint's own passes
// already turn a force with its body to second order, the two stages of RATTLE above, so all the stiffness has to temper is
// the change of speed the rows give inside a substep. It is taken as Zhang and Skeel 1997 take a stiff force's gradient
// into leapfrog, (M + beta h^2 V'') a = -V' (in Tao and Owhadi 2016, Eq 18), into the mass on both sides: the joints' rows
// turn a body by (I + TAUT h^2 G)^-1 where they turned it by I^-1 (`taut_inertia`), TAUT their beta, and nothing else
// changes. G is the part of the term that restores, F . r across each arm that is pulled outward: its diagonal in the arm's
// own frame, and all of it when the pull runs along the arm. Pushed inward it lowers the stiffness, and that part is left
// out, as Tournier et al. note a positive definite matrix may be kept.
//
// The step is then leapfrog on a heavier link, with nothing damped. Their bound is beta >= 1/4 for any stiffness: at TAUT 1,
// h^2 k / (I + h^2 k) stays under 1 where 4 is the limit. What it costs is frequency: a turn against the pull that a substep
// resolves is slowed by (h omega)^2 / 2 of itself, 1.4e-5 for the bob of tests/joints.rs, whose period moved by 1e-5, and
// one it does not resolve rings at a sixth of the substep rate instead of faster. The pull is what each lock carried
// through the whole substep before, read once a substep: before the relaxing pass the memory holds a part only, a seventh
// on that chain past its turn, as a swing's centripetal pull is the relaxing pass's to give, and the stiffness read from
// that part let the relaxing pass ring the chain apart (538 m).
//
// What it does not do is ring anything down. A chain that goes slack at the top of its swing and snaps taut keeps the turning
// the snap gave its links, 130 rad/s on that chain, and its joints then open by the turn of a link within a substep,
// r (h w)^2 / 2: 4 mm there, and the line reads 13 mm long, where the first swing holds 1e-4 of the length. Sliding joints,
// ropes and the locks of the turning axes carry no such term yet.
//
// Measures follow Muller et al. 2020: a hinge's axes are kept aligned by a1 x a2 (their Eq 20), its angle read with a target
// or limit along that axis (Eq 21, Algorithm 3). That form holds near half a turn, where the vector part of a quaternion
// no longer tells rotations apart.
use crate::layout::*;
use crate::math::*;
use crate::solver::{Moving, Soft, Sym};
use crate::world::{NONE, World};

const AXES: [V3; 3] = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];
const TAU: f32 = 2.0 * PI;
/// Anchors closer than this have no line between them.
const COINCIDENT: f32 = 1e-6;
/// A swing's sine under this has no direction to read, and cos^2(swing / 2) under this leaves the twist undefined.
const NO_SWING: f32 = 1e-6;
const NO_TWIST: f32 = 1e-4;
/// A pivot under this part of its row's size, times the rows of its path, is rounding: the rows are f32. Higham 1990's stop
/// (4.3) at n u, on a matrix scaled to a unit diagonal, as linear and turning rows do not share a unit.
const DEPENDENT: f64 = f32::EPSILON as f64;
/// The most a push turns a body in one substep where nothing cancels, in radians: Buss and Kim 2005's gamma max. See the head
/// of this file for why it is not theirs.
const TURN: f32 = 0.2;
/// How much of h^2 times a taut lock's turning stiffness joins the inertia its rows turn a body by: Zhang and Skeel 1997's
/// beta. Any share from 1/4 holds any tension; 1 is all of Tournier et al. 2015's term. See the head of this file.
const TAUT: f64 = 0.0;
/// The share of its column a pivot in the path's own order must hold (Duff, Erisman and Reid 2017 advise 0.1).
const THRESHOLD_SHARE: f64 = 0.1;
/// The margin alpha of a lock's geometric stiffness damping: where h^2 k passes 4 alpha m (`taut_d`).
const STIFF_MARGIN: f64 = 1.0;

/// The most bodies the probe of a strike on a held body follows through its locks (`held_response`).
pub const HELD_BODIES: usize = 32;
/// The most paths of locks that probe solves.
pub const HELD_PATHS: usize = 16;
/// Block Gauss-Seidel sweeps over the probe's paths when there are several; one path is exact in one.
const HELD_SWEEPS: usize = 8;

/// A strike's response on the joints holding its bodies, per unit of impulse along its normal (`held_response`).
pub struct Held {
    pub count: usize,
    pub bodies: [usize; HELD_BODIES],
    pub linear: [V3; HELD_BODIES],
    pub angular: [V3; HELD_BODIES],
    /// The point's change of speed along the normal: the inverse of its mass with the joints holding.
    pub inverse: f32,
    /// The work kinematic bodies do through the joints, per unit (native only; see `DRIVEN`).
    #[cfg(not(target_arch = "wasm32"))]
    pub driven: f64,
}

/// What a pass over the joints is for. See the head of this file.
#[derive(Clone, Copy, PartialEq)]
pub enum Pass {
    /// Velocity only, remembered.
    Settle,
    /// With the position bias, not remembered.
    Push,
    /// After the poses move: velocity only, remembered, motors left alone.
    Relax,
}

/// One constraint row: how speed along it reads from the two bodies, Cdot = d . (vB - vA) + tb . wB - ta . wA.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct Row {
    d: V3,
    ta: V3,
    tb: V3,
}

impl Row {
    #[inline(always)]
    fn speed(&self, a: &Moving, b: &Moving) -> f32 {
        self.d.dot(b.linear.sub(a.linear)) + self.tb.dot(b.angular) - self.ta.dot(a.angular)
    }
    /// J M^-1 J^T between this row and `o`.
    #[inline(always)]
    fn give(&self, o: &Row, a: &Moving, b: &Moving) -> f32 {
        self.d.mul(o.d).dot(a.mass.add(b.mass)) + self.ta.dot(a.inertia.mul(o.ta)) + self.tb.dot(b.inertia.mul(o.tb))
    }
    /// `give` in doubles, for the factors: a row that depends on others shows only under the rounding of f32.
    #[inline]
    fn give_exactly(&self, o: &Row, a: &Moving, b: &Moving) -> f64 {
        scaled(self.d, o.d, a.mass) + scaled(self.d, o.d, b.mass) + a.inertia.between(self.ta, o.ta) + b.inertia.between(self.tb, o.tb)
    }
    #[inline(always)]
    fn push(&self, a: &mut Moving, b: &mut Moving, p: f32) {
        #[cfg(not(target_arch = "wasm32"))]
        (a.driven(self.d.scale(-p), self.ta.scale(-p)), b.driven(self.d.scale(p), self.tb.scale(p)));
        a.linear = a.linear.sub(a.mass.mul(self.d).scale(p));
        a.angular = a.angular.sub(a.inertia.mul(self.ta).scale(p));
        b.linear = b.linear.add(b.mass.mul(self.d).scale(p));
        b.angular = b.angular.add(b.inertia.mul(self.tb).scale(p));
    }
}

/// a . (m b) in doubles, for m a diagonal.
#[inline(always)]
fn scaled(a: V3, b: V3, m: V3) -> f64 {
    a.x as f64 * b.x as f64 * m.x as f64 + a.y as f64 * b.y as f64 * m.y as f64 + a.z as f64 * b.z as f64 * m.z as f64
}

/// A joint as it stands at the start of a substep, kept in its JOINT_SCRATCH rows.
#[repr(C)]
#[derive(Clone, Copy)]
struct View {
    rows: [Row; 6],
    /// What each axis measures.
    at: [f32; 6],
    /// How long the arm on each body is.
    arms: [f32; 2],
}

/// Doubles at the words of JOINT_SCRATCH after the view: a joint's inverse block, its link to the joint before, its right
/// side, then its impulses, and for each limit how its locks lean on it and what it moves with them holding. A joint that
/// leads its island's warm start adds what that is worth, what it is worth once applied, and the mass it was worked out on.
const LINK: usize = 36;
const RIGHT: usize = 72;
const LEAN: usize = 78;
const EASE: usize = 114;
const WORTH: usize = 120;

/// How many lock rows, and their axes.
#[inline]
pub(crate) fn lock_rows(flags: u32) -> (usize, [usize; 6]) {
    let (mut count, mut rows) = (0, [0; 6]);
    for k in 0..6 {
        if flags & (JOINT_LOCK << k) != 0 {
            rows[count] = k;
            count += 1;
        }
    }
    (count, rows)
}

/// The inverse of the leading `m` by `m` of a symmetric positive semi-definite matrix, by Gauss-Jordan on the row with the most
/// left of its `size`, the diagonal it started from: complete pivoting on the scaled matrix, which Higham 1990 proves stable for
/// a rank this small. A row with less than DEPENDENT of it left depends on the others, and carries no impulse.
fn invert(k: &mut [[f64; 6]; 6], m: usize, size: &[f64; 6]) -> [[f64; 6]; 6] {
    let mut inverse = [[0.0; 6]; 6];
    let mut taken = [false; 6];
    for p in 0..m {
        inverse[p][p] = 1.0;
    }
    for _ in 0..m {
        let (mut p, mut most) = (m, DEPENDENT);
        for r in 0..m {
            if !taken[r] && k[r][r] > most * size[r] {
                p = r;
                most = k[r][r] / size[r];
            }
        }
        if p == m {
            break;
        }
        taken[p] = true;
        let scale = 1.0 / k[p][p];
        for c in 0..m {
            k[p][c] *= scale;
            inverse[p][c] *= scale;
        }
        for r in 0..m {
            let factor = k[r][p];
            if r != p && factor != 0.0 {
                for c in 0..m {
                    k[r][c] -= factor * k[p][c];
                    inverse[r][c] -= factor * inverse[p][c];
                }
            }
        }
    }
    for p in 0..m {
        if !taken[p] {
            for c in 0..m {
                inverse[p][c] = 0.0;
                inverse[c][p] = 0.0;
            }
        }
    }
    inverse
}

/// a . b over six doubles.
#[inline(always)]
fn dot6(a: &[f64; 6], b: &[f64; 6]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4] + a[5] * b[5]
}

/// A body's F, F F^T = M^-1: the root of each inverse mass and the lower Cholesky factor of its inverse inertia, so a row's
/// column of A = F^T J^T on the body is F^T j. A pivot at zero or under is a turn the body cannot make.
struct Root {
    linear: [f64; 3],
    turning: [[f64; 3]; 3],
}

impl Root {
    fn of(body: &Moving) -> Root {
        let linear = [sqrt64(body.mass.x as f64), sqrt64(body.mass.y as f64), sqrt64(body.mass.z as f64)];
        let mut l = [[0.0f64; 3]; 3];
        for j in 0..3 {
            let mut d = body.inertia.between(AXES[j], AXES[j]);
            for k in 0..j {
                d -= l[j][k] * l[j][k];
            }
            if d > 0.0 {
                l[j][j] = sqrt64(d);
                for i in j + 1..3 {
                    let mut e = body.inertia.between(AXES[i], AXES[j]);
                    for k in 0..j {
                        e -= l[i][k] * l[j][k];
                    }
                    l[i][j] = e / l[j][j];
                }
            }
        }
        Root { linear, turning: l }
    }

    /// F^T of `sign` times a row's linear and turning parts on this body.
    fn column(&self, d: V3, t: V3, sign: f64) -> [f64; 6] {
        let (d, t) = ([d.x as f64 * sign, d.y as f64 * sign, d.z as f64 * sign], [t.x as f64 * sign, t.y as f64 * sign, t.z as f64 * sign]);
        let l = &self.turning;
        [
            self.linear[0] * d[0],
            self.linear[1] * d[1],
            self.linear[2] * d[2],
            l[0][0] * t[0] + l[1][0] * t[1] + l[2][0] * t[2],
            l[1][1] * t[1] + l[2][1] * t[2],
            l[2][2] * t[2],
        ]
    }
}

/// What one joint's factor hands the next on its path: its pivot rows and the directions still free, each as it reads on the
/// body the two share.
struct Handed {
    pivots: [[f64; 6]; 6],
    taken: usize,
    carry: [[f64; 6]; 6],
    carried: usize,
}

/// The rows of A that a joint's columns reach, in an orthonormal basis the reflections turn: what each row reads in each
/// column, and its part on the body the path goes on through.
struct Front {
    rows: usize,
    at: [[f64; 6]; 12],
    onward: [[f64; 6]; 12],
}

/// The reflection that takes column `c` of `x` below row `p` onto row p alone, applied to `width` columns from `from` of `x`
/// and to every column of `also`, rows p to `rows`. Its sign is the one that does not cancel.
#[inline(never)]
fn reflect(x: &mut [[f64; 6]; 12], also: Option<&mut [[f64; 6]; 12]>, p: usize, rows: usize, c: usize, left: f64, from: usize, width: usize) {
    let length = sqrt64(left);
    let alpha = if x[p][c] > 0.0 { -length } else { length };
    let mut v = [0.0f64; 12];
    for r in p..rows {
        v[r] = x[r][c];
    }
    v[p] -= alpha;
    let mut vv = 0.0;
    for r in p..rows {
        vv += v[r] * v[r];
    }
    let apply = |y: &mut [[f64; 6]; 12], k: usize| {
        let mut sum = 0.0;
        for r in p..rows {
            sum += v[r] * y[r][k];
        }
        let f = 2.0 * sum / vv;
        for r in p..rows {
            y[r][k] -= f * v[r];
        }
    };
    for k in from..width {
        apply(x, k);
    }
    if let Some(y) = also {
        for k in 0..6 {
            apply(y, k);
        }
    }
}

impl Front {
    /// A body's own six rows: the columns as they read on it.
    fn fresh(&mut self, on: &[[f64; 6]; 6], m: usize, onward: bool) {
        for k in 0..6 {
            let at = self.rows;
            for c in 0..m {
                self.at[at][c] = on[c][k];
            }
            self.onward[at] = [0.0; 6];
            if onward {
                self.onward[at][k] = 1.0;
            }
            self.rows += 1;
        }
    }

    fn reflect(&mut self, p: usize, c: usize, left: f64, m: usize) {
        reflect(&mut self.at, Some(&mut self.onward), p, self.rows, c, left, 0, m);
    }

    /// The pivot rows as they read on the onward body, and the rows left over turned among themselves, by QR of their onward
    /// parts, so that at most six of them read on it at all. The rest move only bodies the path has passed.
    fn hand_on(&mut self, taken: usize) -> Handed {
        let mut handed = Handed { pivots: [[0.0; 6]; 6], taken, carry: [[0.0; 6]; 6], carried: 0 };
        for p in 0..taken {
            handed.pivots[p] = self.onward[p];
        }
        let rows = self.rows;
        for q in 0..6 {
            let p = taken + q;
            if p >= rows {
                break;
            }
            let mut left = 0.0;
            for r in p..rows {
                left += self.onward[r][q] * self.onward[r][q];
            }
            if left > 0.0 {
                reflect(&mut self.onward, None, p, rows, q, left, q, 6);
            }
        }
        handed.carried = if rows - taken < 6 { rows - taken } else { 6 };
        for q in 0..handed.carried {
            handed.carry[q] = self.onward[taken + q];
        }
        handed
    }
}

impl World {
    /// True when a joint between these two bodies keeps them from colliding.
    pub fn joined(&self, a: usize, b: usize) -> bool {
        let mut joint = self.uu(FIRST_JOINT, a);
        while joint != NONE {
            let row = joint as usize;
            let on_a = self.uu(JOINT_A, row) as usize == a;
            let other = self.uu(if on_a { JOINT_B } else { JOINT_A }, row) as usize;
            if other == b && self.uu(JOINT_FLAGS, row) & (JOINT_CONTACTS | JOINT_BROKEN) == 0 {
                return true;
            }
            joint = self.uu(if on_a { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
        }
        false
    }

    /// A new joint between two live bodies with these flags, or None when they are one body, one is gone, or memory is out.
    /// Its frames start as the identity and everything else as zero: the caller writes the columns it wants.
    pub fn add_joint(&mut self, a: u32, b: u32, flags: u32) -> Option<u32> {
        if a == b || !self.body_alive(a) || !self.body_alive(b) {
            return None;
        }
        let header = self.header();
        let (free, rows, capacity) = (header.free_joint, header.joint_rows, header.capacity[Rows::Joint as usize]);
        let row = if free != NONE {
            self.header_mut().free_joint = self.uu(JOINT_NEXT_A, free as usize);
            free
        } else {
            if rows == capacity && !self.grow_joints() {
                return None;
            }
            self.header_mut().joint_rows = rows + 1;
            rows
        };
        let at = row as usize;
        self.clear_row(Rows::Joint, at, JOINT_GENERATION);
        self.set_u(JOINT_A, at, a);
        self.set_u(JOINT_B, at, b);
        self.set_u(JOINT_FLAGS, at, flags | JOINT_ALIVE);
        self.set_s(JOINT_FRAME_A_W, at, 1.0);
        self.set_s(JOINT_FRAME_B_W, at, 1.0);
        self.set_u(JOINT_NEXT_A, at, self.uu(FIRST_JOINT, a as usize));
        self.set_u(FIRST_JOINT, a as usize, row);
        self.set_u(JOINT_NEXT_B, at, self.uu(FIRST_JOINT, b as usize));
        self.set_u(FIRST_JOINT, b as usize, row);
        self.wake(a);
        self.wake(b);
        Some(row)
    }

    pub fn grow_joints(&mut self) -> bool {
        let capacity = self.header().capacity;
        let rows = capacity[Rows::Joint as usize];
        if rows >= MAX_JOINTS {
            return false;
        }
        let more = if rows < 16 { 16 } else { rows * 2 };
        let mut next = capacity;
        next[Rows::Joint as usize] = more;
        next[Rows::JointList as usize] = more;
        next[Rows::JointScratch as usize] = more * JOINT_WORDS;
        self.grow(next)
    }

    /// Takes a joint out of one body's chain.
    fn unchain(&mut self, body: usize, joint: u32) {
        let next = |w: &World, row: usize, body: usize| if w.uu(JOINT_A, row) as usize == body { JOINT_NEXT_A } else { JOINT_NEXT_B };
        let after = self.uu(next(self, joint as usize, body), joint as usize);
        if self.uu(FIRST_JOINT, body) == joint {
            self.set_u(FIRST_JOINT, body, after);
            return;
        }
        let mut row = self.uu(FIRST_JOINT, body) as usize;
        loop {
            let column = next(self, row, body);
            let following = self.uu(column, row);
            if following == joint {
                self.set_u(column, row, after);
                return;
            }
            row = following as usize;
        }
    }

    /// Frees a joint, and wakes its bodies, as they may have hung from it. False when the row holds no joint.
    pub fn remove_joint(&mut self, joint: u32) -> bool {
        if joint >= self.header().joint_rows || self.uu(JOINT_FLAGS, joint as usize) & JOINT_ALIVE == 0 {
            return false;
        }
        let at = joint as usize;
        let (a, b) = (self.uu(JOINT_A, at), self.uu(JOINT_B, at));
        self.wake(a);
        self.wake(b);
        self.unchain(a as usize, joint);
        self.unchain(b as usize, joint);
        self.set_u(JOINT_FLAGS, at, 0);
        self.set_u(JOINT_GENERATION, at, self.uu(JOINT_GENERATION, at).wrapping_add(1));
        self.set_u(JOINT_NEXT_A, at, self.header().free_joint);
        self.header_mut().free_joint = joint;
        true
    }

    /// Frees every joint of a body that is leaving.
    pub fn remove_joints_of(&mut self, body: u32) {
        loop {
            let joint = self.uu(FIRST_JOINT, body as usize);
            if joint == NONE {
                return;
            }
            self.remove_joint(joint);
        }
    }

    /// Sets both frames so that frame X runs along `axis`, a direction in each body's own frame: the shortest arc from X
    /// (Dobrowolski 2015, Proposition 2: the spinor n(v + w) n(v) takes v to w). Here for `sqrt`.
    pub fn set_joint_axis(&mut self, joint: u32, axis: V3) {
        let size = sqrt(axis.dot(axis));
        let w = axis.scale(1.0 / size);
        let q = if w.x < -1.0 + 1e-6 {
            // Half a turn: about any line across X.
            Q { x: 0.0, y: 1.0, z: 0.0, w: 0.0 }
        } else {
            Q { x: 0.0, y: -w.z, z: w.y, w: 1.0 + w.x }.normalized()
        };
        self.set_q(JOINT_FRAME_A_X, joint as usize, q);
        self.set_q(JOINT_FRAME_B_X, joint as usize, q);
    }

    /// Wakes what a moving body is joined to.
    pub fn wake_across_joints(&mut self) {
        for row in 0..self.header().joint_rows as usize {
            if self.uu(JOINT_FLAGS, row) & (JOINT_ALIVE | JOINT_IDLE) != JOINT_ALIVE {
                continue;
            }
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (sleeping_a, sleeping_b) = (self.flags(a) & SLEEPING != 0, self.flags(b) & SLEEPING != 0);
            if sleeping_a && !sleeping_b && self.disturbs(b) {
                self.wake(a as u32);
            } else if sleeping_b && !sleeping_a && self.disturbs(a) {
                self.wake(b as u32);
            }
        }
    }

    /// Joined bodies are one island; a moving scripted body keeps what it holds awake, as a touch does.
    pub fn unite_joints(&mut self) {
        for row in 0..self.header().joint_rows as usize {
            if self.uu(JOINT_FLAGS, row) & (JOINT_ALIVE | JOINT_IDLE) != JOINT_ALIVE {
                continue;
            }
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (kind_a, kind_b) = (self.flags(a) & KIND, self.flags(b) & KIND);
            let awake = self.is_awake(a) && self.is_awake(b);
            if kind_a == DYNAMIC && kind_b == DYNAMIC && awake {
                self.unite(a as u32, b as u32);
            } else if kind_b == DYNAMIC && self.moving_kinematic(a) {
                self.set_s(SLEEP_TIME, b, 0.0);
            } else if kind_a == DYNAMIC && self.moving_kinematic(b) {
                self.set_s(SLEEP_TIME, a, 0.0);
            }
        }
    }

    /// True when a body that can move holds three locking joints or more, so no path runs through it.
    fn branches(&self, body: usize) -> bool {
        if !self.is_awake(body) || self.flags(body) & KIND != DYNAMIC {
            return false;
        }
        let (mut count, mut at) = (0, self.uu(FIRST_JOINT, body));
        while at != NONE {
            let row = at as usize;
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_LOCK * 63) != 0 && flags & JOINT_IDLE == 0 {
                count += 1;
            }
            at = self.uu(if self.uu(JOINT_A, row) as usize == body { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
        }
        count > 2
    }

    /// The other locking joint on `body`, when it joins exactly two and can move; NONE otherwise.
    fn linked(&self, joint: u32, body: usize) -> u32 {
        if !self.is_awake(body) || self.flags(body) & KIND != DYNAMIC {
            return NONE;
        }
        let (mut other, mut count) = (NONE, 0);
        let mut at = self.uu(FIRST_JOINT, body);
        while at != NONE {
            let row = at as usize;
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_LOCK * 63) != 0 && flags & JOINT_IDLE == 0 {
                count += 1;
                if at != joint {
                    other = at;
                }
            }
            at = self.uu(if self.uu(JOINT_A, row) as usize == body { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
        }
        if count == 2 { other } else { NONE }
    }

    #[inline(always)]
    fn other_body(&self, joint: usize, body: usize) -> usize {
        let a = self.uu(JOINT_A, joint) as usize;
        if a == body { self.uu(JOINT_B, joint) as usize } else { a }
    }

    /// Lists a joint, after the one before if `via` joins them.
    fn list_joint(&mut self, joint: u32, via: u32, solving: &mut usize, stamp: u32) {
        self.set_u(SOLVE_JOINTS, *solving, joint);
        self.set_u(SOLVE_VIA, *solving, via);
        self.set_u(JOINT_SEEN, joint as usize, stamp);
        *solving += 1;
    }

    /// Follows a path of locking joints from `first`, leaving by `going`. A ring stops short of its first joint: a path's
    /// joints touch only their neighbours, so its matrix is block tridiagonal.
    fn walk_path(&mut self, first: u32, mut going: usize, solving: &mut usize, stamp: u32) {
        let start = self.other_body(first as usize, going);
        let from = *solving;
        self.list_joint(first, NONE, solving, stamp);
        let mut at = first;
        let mut exact = !self.branches(start);
        loop {
            let next = self.linked(at, going);
            if next == NONE {
                exact = exact && !self.branches(going);
                break;
            }
            if self.uu(JOINT_SEEN, next as usize) == stamp {
                exact = false;
                break;
            }
            let far = self.other_body(next as usize, going);
            if far == start {
                self.list_joint(next, NONE, solving, stamp);
                exact = false;
                break;
            }
            self.list_joint(next, going as u32, solving, stamp);
            going = far;
            at = next;
        }
        // Only a path that nothing else leans on is solved exactly. Elsewhere a full push fights its neighbours' pushes.
        let share = if exact { self.header().joint_share } else { self.header().joint_loose_share };
        for i in from..*solving {
            self.set_s(SOLVE_SHARE, i, share);
            self.set_u(SOLVE_EXACT, i, exact as u32);
        }
    }

    /// The impulse row `k` of joint `row` gave in its last substep, not counting a motor's: the solver's own, JOINT_IMPULSE,
    /// which the next substep warm starts from, and on a lock what the locks' projection gave on top of it
    /// (JOINT_LOCK_P, which `shed_locks` keeps at zero on every row that is not a lock).
    pub fn joint_load(&self, row: usize, k: usize) -> f32 {
        self.s(JOINT_IMPULSE_0 + k, row) + self.s(JOINT_LOCK_P_0 + k, row)
    }

    /// After the last substep: a joint loaded past its break force or torque breaks. The load is the impulse its rows gave in
    /// the substep over the substep's length, and the force is the three linear rows together, the torque the three
    /// angular. A broken joint solves nothing, its two bodies may collide, and both wake.
    pub fn break_joints(&mut self, h: f32) {
        for row in 0..self.header().joint_rows as usize {
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_ALIVE | JOINT_IDLE) != JOINT_ALIVE {
                continue;
            }
            let (limit_force, limit_torque) = (self.s(JOINT_BREAK_FORCE, row), self.s(JOINT_BREAK_TORQUE, row));
            if !(limit_force > 0.0 || limit_torque > 0.0) {
                continue;
            }
            // The joint's impulses are its island's last substep's: that substep is the world's cut 2^level times finer.
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let body = if self.flags(a) & KIND == DYNAMIC { a } else { b };
            let level = if self.island_major && self.header().adaptive_substeps != 0 { self.uu(SUBSTEP_LEVEL, body) } else { 0 };
            let extra = self.uu(SUBSTEP_EXTRA, body);
            let h = if extra == 0 {
                h / (1u32 << level) as f32
            } else {
                self.header().step_dt / (self.header().substeps.saturating_add(extra) << level) as f32
            };
            let load = |w: &World, first: usize| {
                let (x, y, z) = (w.joint_load(row, first), w.joint_load(row, first + 1), w.joint_load(row, first + 2));
                sqrt(x * x + y * y + z * z) / h
            };
            if (limit_force > 0.0 && load(self, 0) > limit_force) || (limit_torque > 0.0 && load(self, 3) > limit_torque) {
                self.set_u(JOINT_FLAGS, row, flags | JOINT_BROKEN);
                for k in 0..6 {
                    self.set_s(JOINT_IMPULSE_0 + k, row, 0.0);
                    self.set_s(JOINT_LOCK_P_0 + k, row, 0.0);
                    self.set_s(JOINT_MOTOR_0 + k, row, 0.0);
                }
                let (a, b) = (self.uu(JOINT_A, row), self.uu(JOINT_B, row));
                self.wake(a);
                self.wake(b);
            }
        }
    }

    /// Once a step: lists the joints with a body awake, in paths, and gives their impulses the length of this substep.
    pub fn prepare_joints(&mut self) {
        let ratio = self.header().substep_ratio * self.header().joint_warm_start;
        let stamp = self.header().steps + 1;
        let rows = self.header().joint_rows as usize;
        let live = |w: &World, row: usize| {
            w.uu(JOINT_FLAGS, row) & (JOINT_ALIVE | JOINT_IDLE) == JOINT_ALIVE && (w.is_awake(w.uu(JOINT_A, row) as usize) || w.is_awake(w.uu(JOINT_B, row) as usize))
        };
        for row in 0..rows {
            if !live(self, row) {
                continue;
            }
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            for body in [a, b] {
                if !self.is_awake(body) {
                    self.solver_mass(body);
                }
            }
            if ratio != 1.0 {
                for k in 0..6 {
                    self.set_s(JOINT_IMPULSE_0 + k, row, self.s(JOINT_IMPULSE_0 + k, row) * ratio);
                    self.set_s(JOINT_MOTOR_0 + k, row, self.s(JOINT_MOTOR_0 + k, row) * ratio);
                }
            }
        }
        let mut solving = 0;
        // Paths with an end first, then rings, then joints with nothing locked.
        for row in 0..rows {
            if live(self, row) && self.uu(JOINT_SEEN, row) != stamp && self.uu(JOINT_FLAGS, row) & (JOINT_LOCK * 63) != 0 {
                let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
                if self.linked(row as u32, a) == NONE {
                    self.walk_path(row as u32, b, &mut solving, stamp);
                } else if self.linked(row as u32, b) == NONE {
                    self.walk_path(row as u32, a, &mut solving, stamp);
                }
            }
        }
        for row in 0..rows {
            if live(self, row) && self.uu(JOINT_SEEN, row) != stamp {
                if self.uu(JOINT_FLAGS, row) & (JOINT_LOCK * 63) != 0 {
                    self.walk_path(row as u32, self.uu(JOINT_B, row) as usize, &mut solving, stamp);
                } else {
                    self.set_s(SOLVE_SHARE, solving, self.header().joint_loose_share);
                    self.set_u(SOLVE_EXACT, solving, 0);
                    self.list_joint(row as u32, NONE, &mut solving, stamp);
                }
            }
        }
        self.header_mut().joint_solving = solving as u32;
        // The first joint listed on each island keeps its sums for the warm start.
        let moves = |w: &World, body: usize| w.flags(body) & KIND == DYNAMIC && w.is_awake(body);
        for i in 0..solving {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            for body in [self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize] {
                if moves(self, body) {
                    self.set_u(ISLAND_LEAD, self.uu(ISLAND_ID, body) as usize, NONE);
                }
            }
        }
        for i in 0..solving {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let body = if moves(self, a) { a } else { b };
            let mut lead = NONE;
            if moves(self, body) {
                let island = self.uu(ISLAND_ID, body) as usize;
                lead = self.uu(ISLAND_LEAD, island);
                if lead == NONE {
                    lead = row as u32;
                    self.set_u(ISLAND_LEAD, island, lead);
                }
            }
            self.set_u(SOLVE_LEAD, i, lead);
        }
        self.order_joints_by_island(solving);
        self.place_newton(solving);
    }

    /// Gives each path of the solving joints its own slice of NEWTON for the locks' Newton solve (`newton_right`), sized by its
    /// lock rows, so islands solving at once never share one; grows NEWTON when the paths need more. A copy of the world's bytes
    /// keeps every solve. When memory cannot hold them, every path is marked NONE and the step reports the failure.
    fn place_newton(&mut self, solving: usize) {
        let mut total = 0u64;
        let mut first = 0;
        while first < solving {
            let mut rows = lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, first) as usize)).0 as u64;
            let mut last = first;
            while last + 1 < solving && self.uu(SOLVE_VIA, last + 1) != NONE {
                last += 1;
                rows += lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, last) as usize)).0 as u64;
            }
            self.set_u(SOLVE_NEWTON, first, total.min(NONE as u64 - 1) as u32);
            total += newton_words(rows);
            first = last + 1;
        }
        let mut capacity = self.header().capacity;
        let have = capacity[Rows::Newton as usize] as u64;
        if total <= have {
            return;
        }
        // Doubling, so a world whose paths lengthen a little each step does not lay its memory out again each step.
        let want = total.max(2 * have);
        capacity[Rows::Newton as usize] = want.min(u32::MAX as u64) as u32;
        if want >= NONE as u64 || !self.grow(capacity) {
            capacity[Rows::Newton as usize] = total.min(u32::MAX as u64) as u32;
            if total >= NONE as u64 || !self.grow(capacity) {
                self.header_mut().failed = 1;
                for i in 0..solving {
                    self.set_u(SOLVE_NEWTON, i, NONE);
                }
            }
        }
    }

    /// The island a path of listed joints belongs to: that of the first awake dynamic body any of its joints holds. A path
    /// stops at every body that is not awake and dynamic (`linked`), and islands join the bodies of a joint that are, so all
    /// its joints share one island. None for a path of joints between bodies that cannot move.
    fn island_of_path(&self, from: usize, to: usize) -> Option<usize> {
        for i in from..to {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            for body in [self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize] {
                if self.flags(body) & KIND == DYNAMIC && self.is_awake(body) {
                    let id = self.uu(ISLAND_ID, body);
                    if id != NONE {
                        return Some(id as usize);
                    }
                }
            }
        }
        None
    }

    /// Puts the listed joints in runs, one run an island, a path whole and each run in the order it was listed (a stable counting
    /// sort of the paths), the joints of no island last, and notes where each island's run starts and how long it is. The lists
    /// that go by place in the list (the joint, the joint it goes on through, its share and the lead of its island) move together.
    fn order_joints_by_island(&mut self, solving: usize) {
        let islands = self.header().islands as usize;
        for island in 0..islands {
            self.set_u(ISLAND_JOINT_COUNT, island, 0);
        }
        // A path starts at a joint that goes on through no body.
        let mut i = 0;
        while i < solving {
            let mut end = i + 1;
            while end < solving && self.uu(SOLVE_VIA, end) != NONE {
                end += 1;
            }
            if let Some(island) = self.island_of_path(i, end) {
                self.set_u(ISLAND_JOINT_COUNT, island, self.uu(ISLAND_JOINT_COUNT, island) + (end - i) as u32);
            }
            i = end;
        }
        let mut start = 0;
        for island in 0..islands {
            self.set_u(ISLAND_JOINT_START, island, start);
            self.set_u(ISLAND_JOINT_CURSOR, island, start);
            start += self.uu(ISLAND_JOINT_COUNT, island);
        }
        let mut loose_at = start;
        let mut i = 0;
        while i < solving {
            let mut end = i + 1;
            while end < solving && self.uu(SOLVE_VIA, end) != NONE {
                end += 1;
            }
            let at = match self.island_of_path(i, end) {
                Some(island) => {
                    let at = self.uu(ISLAND_JOINT_CURSOR, island);
                    self.set_u(ISLAND_JOINT_CURSOR, island, at + (end - i) as u32);
                    at
                }
                None => {
                    loose_at += (end - i) as u32;
                    loose_at - (end - i) as u32
                }
            };
            for k in i..end {
                self.set_u(JOINT_ORDER, k, at + (k - i) as u32);
            }
            i = end;
        }
        debug_assert_eq!(loose_at as usize, solving);
        for column in [SOLVE_JOINTS, SOLVE_VIA, SOLVE_SHARE, SOLVE_LEAD, SOLVE_EXACT] {
            for k in 0..solving {
                self.set_u(JOINT_TEMP, self.uu(JOINT_ORDER, k) as usize, self.uu(column, k));
            }
            for k in 0..solving {
                self.set_u(column, k, self.uu(JOINT_TEMP, k));
            }
        }
    }

    #[inline(always)]
    fn view(&self, row: usize) -> View {
        unsafe { *(self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize) as *const View) }
    }

    /// The rows of the locks a joint's path solve holds this step, as its view read them at the substep's poses: each is
    /// (d, ta, tb), with Cdot = d . (vB - vA) + tb . wB - ta . wA. Returns the joint's two bodies and how many rows it wrote, or
    /// None for a joint the step does not solve (gone, idle, or not listed). A coupling reads them for the Schur complement of
    /// its row (couplings.rs, `Locks`).
    pub(crate) fn solved_locks(&self, joint: usize, out: &mut [(V3, V3, V3); 6]) -> Option<(usize, usize, usize)> {
        let flags = self.uu(JOINT_FLAGS, joint);
        if flags & (JOINT_ALIVE | JOINT_IDLE) != JOINT_ALIVE || self.uu(JOINT_SEEN, joint) != self.header().steps + 1 {
            return None;
        }
        let (m, axes) = lock_rows(flags);
        if m == 0 {
            return None;
        }
        let view = self.view(joint);
        for r in 0..m {
            let row = &view.rows[axes[r]];
            out[r] = (row.d, row.ta, row.tb);
        }
        Some((self.uu(JOINT_A, joint) as usize, self.uu(JOINT_B, joint) as usize, m))
    }
    /// The doubles of a joint's scratch.
    #[inline(always)]
    pub(crate) fn doubles(&self, row: usize) -> *mut f64 {
        unsafe { self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize + 64) as *mut f64 }
    }
    /// Where a joint's scratch keeps the inverse inertia its rows turn each of its two bodies by this substep.
    #[inline(always)]
    fn taut(&self, row: usize) -> *mut [Sym; 2] {
        unsafe { self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize + JOINT_TAUT as usize) as *mut [Sym; 2] }
    }
    /// Where a joint's scratch keeps its rows and its bodies' poses at the substep's start, and the discrete gradient since.
    #[inline(always)]
    fn lock_start(&self, row: usize) -> *mut LockStart {
        unsafe { self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize + JOINT_LOCK_START as usize) as *mut LockStart }
    }
    /// Where a joint's scratch keeps the step the projection last moved it by (`project_to`).
    #[inline(always)]
    fn lock_step(&self, row: usize) -> *mut LockStep {
        unsafe { self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize + JOINT_STEP as usize) as *mut LockStep }
    }
    /// Where a joint's scratch keeps what its three sliding rows carried through the substep before, along frame A's axes.
    #[inline(always)]
    fn pull(&self, row: usize) -> *mut V3 {
        unsafe { self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize + JOINT_TAUT as usize + 12) as *mut V3 }
    }
    /// A joint's two bodies as its rows move them: each turns by what `refresh_joints` made of its inertia (`taut_inertia`).
    #[inline(always)]
    fn ends(&self, row: usize) -> (Moving, Moving) {
        let (mut a, mut b) = (self.moving(self.uu(JOINT_A, row) as usize), self.moving(self.uu(JOINT_B, row) as usize));
        [a.inertia, b.inertia] = unsafe { *self.taut(row) };
        (a, b)
    }

    /// The inverse inertia this substep's joints turn `body` by: its `own` with the pull of its taut locks in it. See the head
    /// of this file. A lock of all three sliding axes that gave the body the impulse P at the arm r through the substep
    /// before, P . r over zero, is a spring of F . r across that arm with F = P / h, and TAUT h^2 of it joins the inertia:
    /// D = TAUT h P . r (1 - r r^T / r . r), summed over the body's joints. The inverse is (1 + W D)^-1 W with W the body's own
    /// inverse inertia, which also serves a body with locked axes, whose W has no inverse; 1 + W D has the eigenvalues of
    /// 1 + W^1/2 D W^1/2, none under 1.
    fn taut_d(&self, body: usize, own: Sym, h: f32, share: f64) -> Option<[[f64; 3]; 3]> {
        if own.xx == 0.0 && own.yy == 0.0 && own.zz == 0.0 {
            return None;
        }
        // A link of a multibody that holds is turned by its tree: what the rows give it is projected onto the tree's joint
        // space in the metric of the links' own masses (multibody.rs), so the rows must give it by those too. Given by a
        // heavier inertia, a hinge under a torque came out 3e-4 fast against tau / (I + a), and a branch between ends of
        // 1000 kg left the numbers.
        let role = self.uu(MB_ROLE, body);
        if role != 0 && self.uu(MB_HELD, if role == 1 { body } else { self.uu(MB_ROOT, body) as usize }) != 0 {
            return None;
        }
        // What the pulls add, over TAUT h: xx, xy, xz, yy, yz, zz.
        let mut g = [0.0f64; 6];
        // The geometric stiffness K~ = (dJ^T/dx) lambda for the body's turning block, summed over its locks: s P^T - (P . s) 1 per lock.
        let mut kt = [[0.0f64; 3]; 3];
        let mut at = self.uu(FIRST_JOINT, body);
        while at != NONE {
            let row = at as usize;
            let a = self.uu(JOINT_A, row) as usize;
            let on_a = a == body;
            at = self.uu(if on_a { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
            // Only a lock of all three sliding axes: its force may point any way, so only its arm turns with a body
            // (Tournier et al. 2015, Eq 22). A slider's force turns with body A as well, a rope's with the line of its anchors.
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_ALIVE | JOINT_IDLE | JOINT_DISTANCE | JOINT_LOCK * 7) != JOINT_ALIVE | JOINT_LOCK * 7 || self.uu(JOINT_COUPLE, row) & 7 != 0 {
                continue;
            }
            let carried = unsafe { *self.pull(row) };
            if carried.x == 0.0 && carried.y == 0.0 && carried.z == 0.0 {
                continue;
            }
            // The rows gave body B this impulse along frame A's axes, and body A its opposite.
            let rotation_a = self.pose_rotation(a);
            let given = rotation_a.mul(self.q(JOINT_FRAME_A_X, row)).rotate(carried);
            let (arm, pull) = if on_a {
                (rotation_a.rotate(self.v(JOINT_ANCHOR_A_X, row).sub(self.v(LOCAL_CENTER_X, body))), given.scale(-1.0))
            } else {
                (self.pose_rotation(body).rotate(self.v(JOINT_ANCHOR_B_X, row).sub(self.v(LOCAL_CENTER_X, body))), given)
            };
            let (x, y, z) = (arm.x as f64, arm.y as f64, arm.z as f64);
            let along = pull.x as f64 * x + pull.y as f64 * y + pull.z as f64 * z;
            let reach = x * x + y * y + z * z;
            let (sv, pv) = ([x, y, z], [pull.x as f64, pull.y as f64, pull.z as f64]);
            for i in 0..3 {
                for j in 0..3 {
                    kt[i][j] += sv[i] * pv[j] - if i == j { along } else { 0.0 };
                }
            }
            // Pushed inward a lock lowers the stiffness, which is no inertia to add: a strut is left to buckle as it did.
            if !(along > 0.0 && reach > 0.0) {
                continue;
            }
            let k = along / reach;
            g[0] += along - k * x * x;
            g[1] -= k * x * y;
            g[2] -= k * x * z;
            g[3] += along - k * y * y;
            g[4] -= k * y * z;
            g[5] += along - k * z * z;
        }
        let s = share * h as f64;
        let mut d = [[s * g[0], s * g[1], s * g[2]], [s * g[1], s * g[3], s * g[4]], [s * g[2], s * g[4], s * g[5]]];
        let alpha = STIFF_MARGIN;
        // Its diagonal bound K_d,ii = |column i of K~|, m = M_ii, and where h^2 k > 4 alpha m the damping
        // b = (h^2 k - 4 alpha m) / 2h joins the inertia as h b. kt holds h K~ (impulses over h), so h^2 k = h |column|.
        let w = [[own.xx as f64, own.xy as f64, own.xz as f64], [own.xy as f64, own.yy as f64, own.yz as f64], [own.xz as f64, own.yz as f64, own.zz as f64]];
        let det = w[0][0] * (w[1][1] * w[2][2] - w[1][2] * w[2][1]) - w[0][1] * (w[1][0] * w[2][2] - w[1][2] * w[2][0]) + w[0][2] * (w[1][0] * w[2][1] - w[1][1] * w[2][0]);
        for i in 0..3 {
            if w[i][i] <= 0.0 {
                continue;
            }
            let (j, k) = ((i + 1) % 3, (i + 2) % 3);
            let m = if det > 0.0 { (w[j][j] * w[k][k] - w[j][k] * w[k][j]) / det } else { 1.0 / w[i][i] };
            let col = sqrt64(kt[0][i] * kt[0][i] + kt[1][i] * kt[1][i] + kt[2][i] * kt[2][i]);
            let hk = h as f64 * col;
            if hk > 4.0 * alpha * m {
                d[i][i] += 0.5 * (hk - 4.0 * alpha * m);
            }
        }
        if d.iter().all(|r| r.iter().all(|&v| v == 0.0)) {
            return None;
        }
        Some(d)
    }

    /// The inertial damping a lock's geometric stiffness asks for, on the free motion: each dynamic body's spin becomes (I + h B)^-1 I w, that is
    /// (1 + W h B)^-1 w, with B the damping its locks' geometric stiffness asks for (`taut_d`).
    pub fn damp_taut(&mut self, h: f32) {
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            if self.flags(at) & KIND != DYNAMIC {
                continue;
            }
            let own = self.moving(at).inertia;
            let Some(d) = self.taut_d(at, own, h, 0.0) else { continue };
            let w = [[own.xx as f64, own.xy as f64, own.xz as f64], [own.xy as f64, own.yy as f64, own.yz as f64], [own.xz as f64, own.yz as f64, own.zz as f64]];
            let mut b = [[0.0f64; 3]; 3];
            for i in 0..3 {
                for j in 0..3 {
                    b[i][j] = w[i][0] * d[0][j] + w[i][1] * d[1][j] + w[i][2] * d[2][j] + if i == j { 1.0 } else { 0.0 };
                }
            }
            let o = self.v(ANGULAR_X, at);
            let o = [o.x as f64, o.y as f64, o.z as f64];
            // Solve b x = o by Cramer's rule: det b >= 1.
            let det = |m: [[f64; 3]; 3]| m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            let full = det(b);
            let mut x = [0.0f64; 3];
            for c in 0..3 {
                let mut m = b;
                for r in 0..3 {
                    m[r][c] = o[r];
                }
                x[c] = det(m) / full;
            }
            self.set_v(ANGULAR_X, at, v3(x[0] as f32, x[1] as f32, x[2] as f32));
        }
    }

    fn taut_inertia(&self, body: usize, own: Sym, h: f32) -> Sym {
        let Some(d) = self.taut_d(body, own, h, TAUT) else { return own };
        let w = [[own.xx as f64, own.xy as f64, own.xz as f64], [own.xy as f64, own.yy as f64, own.yz as f64], [own.xz as f64, own.yz as f64, own.zz as f64]];
        let mut b = [[0.0f64; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                b[i][j] = w[i][0] * d[0][j] + w[i][1] * d[1][j] + w[i][2] * d[2][j] + if i == j { 1.0 } else { 0.0 };
            }
        }
        // (1 + W D)^-1 by cofactors: its determinant is 1 or more.
        let c = [
            [b[1][1] * b[2][2] - b[1][2] * b[2][1], b[0][2] * b[2][1] - b[0][1] * b[2][2], b[0][1] * b[1][2] - b[0][2] * b[1][1]],
            [b[1][2] * b[2][0] - b[1][0] * b[2][2], b[0][0] * b[2][2] - b[0][2] * b[2][0], b[0][2] * b[1][0] - b[0][0] * b[1][2]],
            [b[1][0] * b[2][1] - b[1][1] * b[2][0], b[0][1] * b[2][0] - b[0][0] * b[2][1], b[0][0] * b[1][1] - b[0][1] * b[1][0]],
        ];
        let scale = 1.0 / (b[0][0] * c[0][0] + b[0][1] * c[1][0] + b[0][2] * c[2][0]);
        let t = |i: usize, j: usize| scale * (c[i][0] * w[0][j] + c[i][1] * w[1][j] + c[i][2] * w[2][j]);
        // Symmetric but for rounding: the mean of each pair is.
        Sym {
            xx: t(0, 0) as f32,
            xy: (0.5 * (t(0, 1) + t(1, 0))) as f32,
            xz: (0.5 * (t(0, 2) + t(2, 0))) as f32,
            yy: t(1, 1) as f32,
            yz: (0.5 * (t(1, 2) + t(2, 1))) as f32,
            zz: t(2, 2) as f32,
        }
    }

    /// What each of a joint's axes measures from where its bodies are now: offsets along frame A's axes, then frame B's turn in
    /// frame A as a rotation vector along them (a hinge's angle on its axis).
    pub(crate) fn joint_measure(&mut self, row: usize) -> [f32; 6] {
        self.joint_view(row).at
    }

    /// The rows and measures of a joint from where its bodies are now.
    fn joint_view(&mut self, row: usize) -> View {
        let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
        let flags = self.uu(JOINT_FLAGS, row);
        let (rotation_a, rotation_b) = (self.pose_rotation(a), self.pose_rotation(b));
        let arm_a = rotation_a.rotate(self.v(JOINT_ANCHOR_A_X, row).sub(self.v(LOCAL_CENTER_X, a)));
        let arm_b = rotation_b.rotate(self.v(JOINT_ANCHOR_B_X, row).sub(self.v(LOCAL_CENTER_X, b)));
        let gap = self.pose_center(b).add(arm_b).sub(self.pose_center(a).add(arm_a));
        let (frame_a, frame_b) = (rotation_a.mul(self.q(JOINT_FRAME_A_X, row)), rotation_b.mul(self.q(JOINT_FRAME_B_X, row)));
        let axes = [frame_a.rotate(AXES[0]), frame_a.rotate(AXES[1]), frame_a.rotate(AXES[2])];

        // Along an axis the arm on A runs to where B may stand: out along the axes that leave the anchor free (a prismatic's
        // slide), so an axis that turns with A is measured right, and not across the locked ones, where the gap is drift. Run
        // to the anchor on B, a locked row's speed held B at its drift as A turned: a spin w on a gap g asked w x g of B
        // each substep, and a gap of 0.8 m behind a kinematic body turning 77 rad/s gave a ball joint's body 1.6 times the
        // speed of its anchor (`a_joint_does_not_turn_its_drift_into_speed`).
        let rigid = flags / JOINT_LOCK & 7;
        let mut slide = gap;
        for k in 0..3 {
            if rigid >> k & 1 != 0 {
                slide = slide.sub(axes[k].scale(axes[k].dot(gap)));
            }
        }
        let reach = arm_a.add(slide);
        let mut rows = [Row { d: AXES[0], ta: AXES[0], tb: AXES[0] }; 6];
        let mut at = [0.0; 6];
        for k in 0..3 {
            rows[k] = Row { d: axes[k], ta: reach.cross(axes[k]), tb: arm_b.cross(axes[k]) };
            at[k] = axes[k].dot(gap);
            rows[3 + k] = Row { d: v3(0.0, 0.0, 0.0), ta: axes[k], tb: axes[k] };
        }
        if flags & JOINT_DISTANCE != 0 {
            let size = sqrt(gap.dot(gap));
            let line = if size > COINCIDENT { gap.scale(1.0 / size) } else { axes[0] };
            rows[0] = Row { d: line, ta: arm_a.cross(line), tb: arm_b.cross(line) };
            at[0] = size;
        }

        // Coupled sliding axes share one measure: how far the anchor on B is from frame A's origin inside their plane. The first of
        // them carries its row, along that line; its derivative also has A's turn, which `reach` carries as for any axis.
        let couple = self.uu(JOINT_COUPLE, row) & 7;
        if couple != 0 {
            let first = if couple & 1 != 0 { 0 } else if couple & 2 != 0 { 1 } else { 2 };
            let mut inside = v3(0.0, 0.0, 0.0);
            for k in 0..3 {
                if couple >> k & 1 != 0 {
                    inside = inside.add(axes[k].scale(axes[k].dot(gap)));
                }
            }
            let size = sqrt(inside.dot(inside));
            let line = if size > COINCIDENT { inside.scale(1.0 / size) } else { axes[first] };
            rows[first] = Row { d: line, ta: reach.cross(line), tb: arm_b.cross(line) };
            at[first] = size;
        }

        // Rotation of frame B in frame A, the short way round.
        let mut q = frame_a.conjugate().mul(frame_b);
        if q.w < 0.0 {
            q = Q { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
        }
        let locked = (flags / (JOINT_LOCK << 3) | self.uu(JOINT_SOFT, row) >> 3) & 7;
        let free = 3 - (locked & 1) - (locked >> 1 & 1) - (locked >> 2 & 1);
        if free == 0 {
            at[3] = 2.0 * q.x;
            at[4] = 2.0 * q.y;
            at[5] = 2.0 * q.z;
        } else if free == 1 {
            let k = if locked & 1 == 0 {
                0
            } else if locked & 2 == 0 {
                1
            } else {
                2
            };
            let off = axes[k].cross(frame_b.rotate(AXES[k]));
            for i in 0..3 {
                at[3 + i] = off.dot(axes[i]);
            }
            let raw = 2.0 * atan2([q.x, q.y, q.z][k], q.w);
            // The whole turns to the angle it last read, so a hinge can count past one.
            let turns = (self.s(JOINT_ANGLE, row) - raw) * (1.0 / TAU);
            let turns = (if turns < 0.0 { turns - 0.5 } else { turns + 0.5 }) as i32 as f32;
            let angle = raw + turns * TAU;
            self.set_s(JOINT_ANGLE, row, angle);
            at[3 + k] = angle;
        } else {
            let turn = q.to_rotation_vector();
            at[3] = turn.x;
            at[4] = turn.y;
            at[5] = turn.z;
        }
        if flags & JOINT_CONE != 0 {
            self.cone_rows(row, axes, frame_a, frame_b, q, &mut rows, &mut at);
        }
        View { rows, at, arms: [sqrt(arm_a.dot(arm_a)), sqrt(arm_b.dot(arm_b))] }
    }

    /// A cone's two rows. Frame B's turn in frame A splits into a twist about X and a swing that takes X to where frame B's X
    /// points (Dobrowolski 2015), so q = swing twist and the twist's angle is 2 atan2(q.x, q.w). Twist's rate is the relative
    /// spin along the bisector over cos(swing / 2), as d theta = (a1 + a2) . w / (2 (x^2 + w^2)). The swing stays inside an
    /// ellipse of its rotation vector, (r_y / limit_y)^2 + (r_z / limit_z)^2 <= 1: its row runs along the gradient, and what
    /// it measures is the first-order distance past the edge, negative inside. The limit in rows does the rest.
    #[allow(clippy::too_many_arguments)]
    fn cone_rows(&self, row: usize, axes: [V3; 3], frame_a: Q, frame_b: Q, q: Q, rows: &mut [Row; 6], at: &mut [f32; 6]) {
        let (a1, a2) = (axes[0], frame_b.rotate(AXES[0]));
        let bisector = a1.add(a2).scale(1.0 / (2.0 * (q.x * q.x + q.w * q.w).max(NO_TWIST)));
        rows[3] = Row { d: v3(0.0, 0.0, 0.0), ta: bisector, tb: bisector };
        at[3] = 2.0 * atan2(q.x, q.w);
        let across = frame_a.unrotate(a2);
        let sine = sqrt(across.y * across.y + across.z * across.z);
        if sine < NO_SWING && across.x > 0.0 {
            // Dead centre: inside any limit, along any line.
            at[4] = -1.0;
            return;
        }
        let swing = atan2(sine, across.x);
        // Straight back the line is lost too: any line across will do, and the row turns the axis out of it.
        let (y, z) = if sine < NO_SWING { (0.0, swing) } else { (-across.z * swing / sine, across.y * swing / sine) };
        let (limit_y, limit_z) = (self.s(JOINT_MIN_5, row), self.s(JOINT_MAX_5, row));
        let (over_y, over_z) = (y / (limit_y * limit_y), z / (limit_z * limit_z));
        let size = sqrt(over_y * over_y + over_z * over_z);
        let (line_y, line_z) = (over_y / size, over_z / size);
        let line = axes[1].scale(line_y).add(axes[2].scale(line_z));
        rows[4] = Row { d: v3(0.0, 0.0, 0.0), ta: line, tb: line };
        at[4] = (y * over_y + z * over_z - 1.0) / (2.0 * size);
    }

    /// Each substep, before the solve: every joint's rows from the bodies' poses, and the factors of each path, which solve the
    /// locks of a chain exactly in one sweep. Gauss-Seidel moves a load only one joint a pass, so a light chain under a heavy
    /// end would stretch for seconds before it held. See the head of this file for how the factors are made.
    #[inline(never)]
    pub fn refresh_joints(&mut self, h: f32, fresh: bool) {
        let (from, solving) = self.window.joints;
        if fresh {
            // What each lock carried through the whole substep before, for `taut_inertia`: the memory as the relaxing pass left
            // it. Before that pass it holds a part only, as a swing's centripetal pull is the relaxing pass's to give.
            for i in from..solving {
                let row = self.uu(SOLVE_JOINTS, i) as usize;
                unsafe { *self.pull(row) = self.v(JOINT_IMPULSE_0, row) };
            }
        }
        let mut handed = Handed { pivots: [[0.0; 6]; 6], taken: 0, carry: [[0.0; 6]; 6], carried: 0 };
        let mut tolerance = DEPENDENT;
        for i in from..solving {
            if self.uu(SOLVE_VIA, i) == NONE {
                // Higham 1990's stop (4.3) at n u, n the order of the path's matrix.
                let mut rows = lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, i) as usize)).0;
                let mut j = i + 1;
                while j < solving && self.uu(SOLVE_VIA, j) != NONE {
                    rows += lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, j) as usize)).0;
                    j += 1;
                }
                tolerance = DEPENDENT * rows as f64;
            }
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.joint_view(row);
            unsafe { *(self.f(JOINT_SCRATCH).add(row * JOINT_WORDS as usize) as *mut View) = view };
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            // The joint's rows turn each body by its inertia with its taut locks' pull in it, here and in every pass.
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            (body_a.inertia, body_b.inertia) = (self.taut_inertia(a, body_a.inertia, h), self.taut_inertia(b, body_b.inertia, h));
            unsafe { *self.taut(row) = [body_a.inertia, body_b.inertia] };
            if fresh {
                let poses = [(self.pose_center(a), self.pose_rotation(a)), (self.pose_center(b), self.pose_rotation(b))];
                unsafe { *self.lock_start(row) = LockStart { rows: view.rows, poses, dg: view.rows } };
            } else {
                // The discrete gradient read at the pose this refresh reads, as K is. The substep's first refresh wrote the
                // start of every joint it solves.
                let start = unsafe { *self.lock_start(row) };
                let mut rows = view.rows;
                for k in 0..6 {
                    let (s, c) = (start.rows[k], view.rows[k]);
                    rows[k] = Row { d: s.d.add(c.d).scale(0.5), ta: s.ta.add(c.ta).scale(0.5), tb: s.tb.add(c.tb).scale(0.5) };
                }
                self.gradient_rows(row, &start, &mut rows);
                unsafe { (*self.lock_start(row)).dg = rows };
            }
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let doubles = self.doubles(row);
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_LIMIT * 63) != 0 {
                // What each limit moves with the joint's own locks holding: the Schur complement of its locks in the block.
                let mut k = [[0.0f64; 6]; 6];
                for r in 0..m {
                    for s in 0..m {
                        k[r][s] = view.rows[axes[r]].give_exactly(&view.rows[axes[s]], &body_a, &body_b);
                    }
                }
                let mut size = [0.0f64; 6];
                for r in 0..m {
                    size[r] = k[r][r];
                }
                let own = invert(&mut k, m, &size);
                for q in 0..6 {
                    if flags & (JOINT_LIMIT << q) == 0 {
                        continue;
                    }
                    let mut across = [0.0f64; 6];
                    for r in 0..m {
                        across[r] = view.rows[axes[r]].give_exactly(&view.rows[q], &body_a, &body_b);
                    }
                    let mut ease = view.rows[q].give_exactly(&view.rows[q], &body_a, &body_b);
                    for r in 0..m {
                        let mut lean = 0.0;
                        for s in 0..m {
                            lean += own[r][s] * across[s];
                        }
                        unsafe { *doubles.add(LEAN + q * 6 + r) = lean };
                        ease -= lean * across[r];
                    }
                    unsafe { *doubles.add(EASE + q) = ease };
                }
            }
            let via = self.uu(SOLVE_VIA, i);
            let onward = if i + 1 < solving { self.uu(SOLVE_VIA, i + 1) } else { NONE };
            // Columns of A = F^T J^T, one per lock row, as they read on each body.
            let (root_a, root_b) = (Root::of(&body_a), Root::of(&body_b));
            let (mut on_a, mut on_b, mut size) = ([[0.0f64; 6]; 6], [[0.0f64; 6]; 6], [0.0f64; 6]);
            for c in 0..m {
                let lock = &view.rows[axes[c]];
                on_a[c] = root_a.column(lock.d, lock.ta, -1.0);
                on_b[c] = root_b.column(lock.d, lock.tb, 1.0);
                for k in 0..6 {
                    size[c] += on_a[c][k] * on_a[c][k] + on_b[c][k] * on_b[c][k];
                }
            }
            for k in 0..36 {
                unsafe { *doubles.add(LINK + k) = 0.0 };
            }
            let mut front = Front { rows: 0, at: [[0.0; 6]; 12], onward: [[0.0; 6]; 12] };
            if via == NONE {
                front.fresh(&on_a, m, a as u32 == onward);
                front.fresh(&on_b, m, b as u32 == onward);
            } else {
                // The joint before left its pivot rows and what is still free of the body they share. The joint after goes on
                // through the other body, as a body inside a path holds two locking joints.
                let (shared, other, other_body) = if a as u32 == via { (&on_a, &on_b, b) } else { (&on_b, &on_a, a) };
                for p in 0..handed.taken {
                    for c in 0..m {
                        unsafe { *doubles.add(LINK + p * 6 + c) = dot6(&handed.pivots[p], &shared[c]) };
                    }
                }
                for q in 0..handed.carried {
                    let at = front.rows;
                    for c in 0..m {
                        front.at[at][c] = dot6(&handed.carry[q], &shared[c]);
                    }
                    front.onward[at] = [0.0; 6];
                    front.rows += 1;
                }
                front.fresh(other, m, other_body as u32 == onward);
            }
            // Householder QR with column pivoting, on the column with the most of its own size left.
            let mut pivot = [6usize; 6];
            let mut order = [0usize; 6];
            let mut taken = 0;
            while taken < m && taken < front.rows {
                let (mut best, mut most, mut left) = (m, tolerance, 0.0);
                for c in 0..m {
                    if pivot[c] != 6 {
                        continue;
                    }
                    let mut length = 0.0;
                    for r in taken..front.rows {
                        length += front.at[r][c] * front.at[r][c];
                    }
                    if length > most * size[c] {
                        best = c;
                        most = length / size[c];
                        left = length;
                    }
                }
                if best == m {
                    break;
                }
                front.reflect(taken, best, left, m);
                pivot[best] = taken;
                order[taken] = best;
                taken += 1;
            }
            // R^-1, from pivot places to rows: column p solves R x = e_p by back substitution. A dropped row stays zero.
            for k in 0..36 {
                unsafe { *doubles.add(k) = 0.0 };
            }
            for p in 0..taken {
                let mut x = [0.0f64; 6];
                for q in (0..=p).rev() {
                    let mut sum = if q == p { 1.0 } else { 0.0 };
                    for k in q + 1..=p {
                        sum -= front.at[q][order[k]] * x[order[k]];
                    }
                    x[order[q]] = sum / front.at[q][order[q]];
                }
                for c in 0..m {
                    unsafe { *doubles.add(c * 6 + p) = x[c] };
                }
            }
            if onward != NONE {
                handed = front.hand_on(taken);
            }
        }
    }

    /// Each substep: the impulses the joints carry, before anything is solved. Motors first: they are forces, and what the
    /// rest is worth is judged with them applied. See the head of this file.
    pub fn warm_start_joints(&mut self) {
        let (from, solving) = self.window.joints;
        self.carry(JOINT_MOTOR_0);
        for i in from..solving {
            let lead = self.uu(SOLVE_LEAD, i);
            if lead != NONE {
                let worth = self.doubles(lead as usize);
                unsafe {
                    *worth.add(WORTH) = 0.0;
                    *worth.add(WORTH + 1) = 0.0;
                    *worth.add(WORTH + 2) = 0.0;
                }
            }
        }
        self.tally_memory(WORTH);
        self.carry(JOINT_IMPULSE_0);
        self.tally_memory(WORTH + 1);
        let most = self.header().joint_max_push as f64;
        for i in from..solving {
            let lead = self.uu(SOLVE_LEAD, i);
            if lead == NONE {
                continue;
            }
            let worth = self.doubles(lead as usize);
            // f(a) = before a + (after - before) a^2 / 2, as what the memory did to its own rows is p^T K p.
            let (before, after, mass) = unsafe { (*worth.add(WORTH), *worth.add(WORTH + 1), *worth.add(WORTH + 2)) };
            let curve = after - before;
            if !(before + 0.5 * curve > 0.5 * mass * most * most) {
                continue;
            }
            let keep = if before < 0.0 { (-before / curve) as f32 } else { 0.0 };
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = self.ends(row);
            for k in 0..6 {
                let carried = self.s(JOINT_IMPULSE_0 + k, row);
                if carried != 0.0 {
                    view.rows[k].push(&mut body_a, &mut body_b, (keep - 1.0) * carried);
                    self.set_s(JOINT_IMPULSE_0 + k, row, carried * keep);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// Adds to each island's sum at `slot` what its memory reads against the bodies' speeds now.
    fn tally_memory(&mut self, slot: usize) {
        for i in self.window.joints.0..self.window.joints.1 {
            let lead = self.uu(SOLVE_LEAD, i);
            if lead == NONE {
                continue;
            }
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (body_a, body_b) = (self.moving(a), self.moving(b));
            let mut sum = 0.0f64;
            for k in 0..6 {
                let carried = self.s(JOINT_IMPULSE_0 + k, row);
                if carried != 0.0 {
                    sum += carried as f64 * view.rows[k].speed(&body_a, &body_b) as f64;
                }
            }
            let worth = self.doubles(lead as usize);
            unsafe { *worth.add(slot) += sum };
            if slot == WORTH {
                for body in [a, b] {
                    let inverse = self.s(INVERSE_MASS, body);
                    if self.flags(body) & KIND == DYNAMIC && inverse > 0.0 {
                        unsafe { *worth.add(WORTH + 2) += 1.0 / inverse as f64 };
                    }
                }
            }
        }
    }

    /// Applies the impulses in six columns from `column`.
    fn carry(&mut self, column: usize) {
        for i in self.window.joints.0..self.window.joints.1 {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = self.ends(row);
            // A rotation drive's motors push along the target's axes, not along the rows the joint's own limits use.
            let (mut rows, mut at) = (view.rows, view.at);
            if column == JOINT_MOTOR_0 && self.uu(JOINT_FLAGS, row) & JOINT_DRIVE != 0 {
                self.drive_rows(row, a, b, &mut rows, &mut at);
            }
            for k in 0..6 {
                let impulse = self.s(column + k, row);
                if impulse != 0.0 {
                    rows[k].push(&mut body_a, &mut body_b, impulse);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// One pass over the joints.
    /// A path joins only when its island asks for at least `least` extra passes and fewer than `below` (see `step`).
    pub fn solve_joints(&mut self, h: f32, stiffness: Soft, pass: Pass, least: u32, below: u32) {
        let most = self.header().joint_max_push;
        let (from, solving) = self.window.joints;
        let mut first = from;
        while first < solving {
            let mut last = first;
            while last + 1 < solving && self.uu(SOLVE_VIA, last + 1) != NONE {
                last += 1;
            }
            if least > 0 || below != u32::MAX {
                // A path's joints are one island's: joints join the islands of their bodies.
                let row = self.uu(SOLVE_JOINTS, first) as usize;
                let extra = self.extra_of(self.uu(JOINT_A, row) as usize).max(self.extra_of(self.uu(JOINT_B, row) as usize));
                if extra < least || extra >= below {
                    first = last + 1;
                    continue;
                }
            }
            let rate = self.s(SOLVE_SHARE, first) / h;
            for i in first..=last {
                let row = self.uu(SOLVE_JOINTS, i) as usize;
                let flags = self.uu(JOINT_FLAGS, row);
                if flags & (JOINT_LIMIT * 63 | JOINT_MOTOR_ON * 63) != 0 {
                    self.soft_rows(row, flags, h, stiffness, most, pass);
                }
            }
            self.solve_path(first, last, rate, most, h, pass);
            first = last + 1;
        }
    }

    /// The turning rows of a rotation drive: the axes of body A's frame turned by the target, and what is left of the turn from
    /// there to body B, as a rotation vector along them. It is the measure of a free ball joint whose frame A sat on the target,
    /// read without moving any frame, and it takes the joint's frames out of it: the target is a rotation of body B in body A's
    /// frame, as a spherical joint's is, so a cone's frames (which hold its axis and its rest) do not change what it means.
    fn drive_rows(&self, row: usize, a: usize, b: usize, rows: &mut [Row; 6], at: &mut [f32; 6]) {
        let target = self.pose_rotation(a).mul(self.q(JOINT_DRIVE_X, row));
        let mut left = target.conjugate().mul(self.pose_rotation(b));
        if left.w < 0.0 {
            left = Q { x: -left.x, y: -left.y, z: -left.z, w: -left.w };
        }
        let turn = left.to_rotation_vector();
        let along = [turn.x, turn.y, turn.z];
        for k in 0..3 {
            let axis = target.rotate(AXES[k]);
            rows[3 + k] = Row { d: v3(0.0, 0.0, 0.0), ta: axis, tb: axis };
            at[3 + k] = along[k];
        }
    }

    /// A joint's motors and limits, one row at a time: they stop and start, which a factored path cannot.
    fn soft_rows(&mut self, row: usize, flags: u32, h: f32, stiffness: Soft, most: f32, pass: Pass) {
        let view = self.view(row);
        let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
        let (mut body_a, mut body_b) = self.ends(row);
        if pass != Pass::Relax {
            let (mut rows, mut at) = (view.rows, view.at);
            if flags & JOINT_DRIVE != 0 {
                self.drive_rows(row, a, b, &mut rows, &mut at);
            }
            // The motors a multibody's tree holds as implicit springs are its, not this pass's (multibody.rs, `tree_springs`).
            let held = self.tree_springs(row);
            for k in 0..6 {
                if flags & (JOINT_MOTOR_ON << k) != 0 && held & (1 << k) == 0 {
                    self.motor_row(row, k, flags & (JOINT_MOTOR_FORCE << k) != 0, &rows[k], at[k], h, &mut body_a, &mut body_b);
                }
            }
            if self.uu(JOINT_MODE, row) & JOINT_MODE_VECTOR_CAPS != 0 {
                self.cap_motor_vectors(row, &rows, h, &mut body_a, &mut body_b);
            }
        }
        for k in 0..6 {
            if flags & (JOINT_LIMIT << k) != 0 {
                self.limit_row(row, k, &view, h, stiffness, most, pass, &mut body_a, &mut body_b);
            }
        }
        self.settle(a, &body_a);
        self.settle(b, &body_b);
    }

    /// Solves the locks of the path from list place `first` to `last` exactly: forward, then back, then the impulses. The
    /// pushing pass solves twice on the same factors: first the speeds along the locks, whole, then the position bias, cut by
    /// `push_share` and capped from the speeds the locks now leave. One solve of both, cut, cut the speeds with the push, and
    /// the limits and contacts solved since the last pass leave speed along the locks: a hinge's limit stopping a turn about
    /// an anchor 24 m off gave its body 7,500 rad/s that only the locks take back, the next limit gave the body beyond it
    /// 457,390 rad/s, a cut to nothing kept it, and a body landed 1,100 m from its joints
    /// (`a_cut_push_still_takes_back_the_speed_along_the_locks`).
    fn solve_path(&mut self, first: usize, last: usize, rate: f32, most: f32, h: f32, pass: Pass) {
        let _ = (rate, h);
        // The locks' position is the projection's (`project_locks`), so every pass solves their speeds only, and remembers them:
        // `shed_locks` takes off exactly what they carry.
        self.path_right(first, last, rate, most, false);
        self.apply_path(first, last, 1.0, true);
        let _ = pass;
    }

    /// The path's impulses into RIGHT: what its locks' speeds ask, or with `bias` what their position bias asks, read from the
    /// bodies' speeds as they stand. Returns the sum over its joints of the largest row asked, turning rows by their lever.
    fn path_right(&mut self, first: usize, last: usize, rate: f32, most: f32, bias: bool) -> f32 {
        self.path_right_capped(first, last, rate, most, bias, JOINT_LEAVE_0).0
    }

    /// `path_right` for the projection: the bias closes each lock to the gap in column `to`, uncapped.
    fn path_right_to(&mut self, first: usize, last: usize, rate: f32, to: usize) -> f32 {
        self.path_right_capped(first, last, rate, f32::INFINITY, true, to).0
    }

    /// `path_right`, and whether the cap held any row's push back.
    fn path_right_capped(&mut self, first: usize, last: usize, rate: f32, most: f32, bias: bool, to: usize) -> (f32, bool) {
        let mut asked = 0.0f32;
        let mut capped = false;
        for i in first..=last {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            let (body_a, body_b) = (self.moving(self.uu(JOINT_A, row) as usize), self.moving(self.uu(JOINT_B, row) as usize));
            let doubles = self.doubles(row);
            let before = if i > first { self.doubles(self.uu(SOLVE_JOINTS, i - 1) as usize) } else { doubles };
            let n = if i > first { lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, i - 1) as usize)).0 } else { 0 };
            // The arms and not the gap, or a wide gap would raise its own cap. See the head of this file.
            let most = most + view.arms[0] * sqrt(body_a.angular.dot(body_a.angular)) + view.arms[1] * sqrt(body_b.angular.dot(body_b.angular));
            let lever = view.arms[0] + view.arms[1];
            let mut largest = 0.0f32;
            let mut b = [0.0f64; 6];
            for r in 0..m {
                let k = axes[r];
                let ask = if bias {
                    let push = rate * (view.at[k] - if most.is_finite() { 0.0 } else { self.s(to + k, row) });
                    if push > most {
                        capped = true;
                        most
                    } else if push < -most {
                        capped = true;
                        -most
                    } else {
                        push
                    }
                } else {
                    view.rows[k].speed(&body_a, &body_b)
                };
                let size = if ask < 0.0 { -ask } else { ask };
                let size = if k < 3 { size } else { size * lever };
                if size > largest {
                    largest = size;
                }
                // R^T y = b: what the joint before already holds of this row comes off first.
                let mut right = -ask as f64;
                for p in 0..n {
                    right -= unsafe { *doubles.add(LINK + p * 6 + r) * *before.add(RIGHT + p) };
                }
                b[r] = right;
            }
            for p in 0..m {
                let mut y = 0.0;
                for r in 0..m {
                    y += unsafe { *doubles.add(r * 6 + p) } * b[r];
                }
                unsafe { *doubles.add(RIGHT + p) = y };
            }
            asked += largest;
        }
        let mut next = [0.0f64; 6];
        for i in (first..=last).rev() {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let m = lock_rows(self.uu(JOINT_FLAGS, row)).0;
            let doubles = self.doubles(row);
            // R x = y: what the joint after takes comes off, then R^-1.
            let mut z = [0.0f64; 6];
            for p in 0..m {
                let mut sum = unsafe { *doubles.add(RIGHT + p) };
                if i < last {
                    let after = self.uu(SOLVE_JOINTS, i + 1) as usize;
                    let (n, _) = lock_rows(self.uu(JOINT_FLAGS, after));
                    let link = self.doubles(after);
                    for c in 0..n {
                        sum -= unsafe { *link.add(LINK + p * 6 + c) } * next[c];
                    }
                }
                z[p] = sum;
            }
            let mut x = [0.0f64; 6];
            for r in 0..m {
                let mut sum = 0.0;
                for p in 0..m {
                    sum += unsafe { *doubles.add(r * 6 + p) } * z[p];
                }
                x[r] = sum;
            }
            for r in 0..m {
                unsafe { *doubles.add(RIGHT + r) = x[r] };
            }
            next = x;
        }
        (asked, capped)
    }

    /// Applies `share` of the impulses in RIGHT to the path's bodies, and with `remember` adds them to what the joints carry.
    fn apply_path(&mut self, first: usize, last: usize, share: f32, remember: bool) {
        for i in (first..=last).rev() {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            let doubles = self.doubles(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (mut body_a, mut body_b) = self.ends(row);
            for r in 0..m {
                let k = axes[r];
                let p = unsafe { *doubles.add(RIGHT + r) } as f32 * share;
                view.rows[k].push(&mut body_a, &mut body_b, p);
                if remember {
                    self.set_s(JOINT_IMPULSE_0 + k, row, self.s(JOINT_IMPULSE_0 + k, row) + p);
                }
            }
            self.settle(a, &body_a);
            self.settle(b, &body_b);
        }
    }

    /// How a strike of `probe` along `normal` at the arms of pair `row`'s bodies `a` and `b` moves every body the locks holding
    /// them reach, with those locks holding: the strike's response on the joints, per unit of impulse. None when no lock holds
    /// either body, or when the locks reach more than HELD_BODIES bodies or HELD_PATHS paths, where a strike takes the
    /// bodies' own mass as before.
    ///
    /// A strike solved on the bodies alone and the joints after leaves the joints to take back, inelastically, what the
    /// bodies' own mass got wrong: a ball hung on a rod has the mass m + I / L^2 at its centre, not m, so a touching cradle
    /// of steel balls on 247 mm arms passed 99.1 percent of its energy on at each strike at restitution 1 and fell to 18
    /// percent in 30 s (KB-PHYS-HUNGCRADLE1). The impulse of a held body is the operational-space inverse inertia at the
    /// point, Lambda^-1 = J H^-1 J^T with the joints' constraints in H (Khatib 1987; Featherstone, "Rigid Body Dynamics
    /// Algorithms", 2008, chapter 11, impulsive dynamics; Mirtich 1996, the collision of articulated bodies), and the bodies
    /// take the joints' reaction with it, as Weinstein, Teran and Fedkiw 2006 have each collision followed by the joints'
    /// velocity solve. It is read off this substep's own path solve: the paths are solved once with the probe pushed and once
    /// without, and the difference over the probe is the response, which holds for any speeds the bodies have (the path
    /// solve is affine in them), a kinematic body's included. The paths are solved exactly; several paths meet by block
    /// Gauss-Seidel, HELD_SWEEPS sweeps. Nothing is remembered: a strike is no load for the warm start.
    pub(crate) fn held_response(&mut self, row: usize, a: usize, b: usize, normal: V3, arm_a: V3, arm_b: V3, probe: f32) -> Option<Held> {
        if probe == 0.0 || (self.uu(FIRST_JOINT, a) == NONE && self.uu(FIRST_JOINT, b) == NONE) {
            return None;
        }
        let (from, solving) = self.window.joints;
        let zero = v3(0.0, 0.0, 0.0);
        let mut held = Held {
            count: 2,
            bodies: [usize::MAX; HELD_BODIES],
            linear: [zero; HELD_BODIES],
            angular: [zero; HELD_BODIES],
            inverse: 0.0,
            #[cfg(not(target_arch = "wasm32"))]
            driven: 0.0,
        };
        (held.bodies[0], held.bodies[1]) = (a, b);
        // The paths of locks on each body that moves, and every body they hold, until no new body brings a new path.
        let (mut paths, mut count, mut next) = ([(0usize, 0usize); HELD_PATHS], 0usize, 0usize);
        while next < held.count {
            let body = held.bodies[next];
            next += 1;
            if self.flags(body) & KIND != DYNAMIC || !self.is_awake(body) {
                continue;
            }
            for i in from..solving {
                let joint = self.uu(SOLVE_JOINTS, i) as usize;
                if self.uu(JOINT_FLAGS, joint) & (JOINT_LOCK * 63) == 0 || (self.uu(JOINT_A, joint) as usize != body && self.uu(JOINT_B, joint) as usize != body) {
                    continue;
                }
                let (mut first, mut last) = (i, i);
                while first > from && self.uu(SOLVE_VIA, first) != NONE {
                    first -= 1;
                }
                while last + 1 < solving && self.uu(SOLVE_VIA, last + 1) != NONE {
                    last += 1;
                }
                if paths[..count].iter().any(|&(start, _)| start == first) {
                    continue;
                }
                if count == HELD_PATHS {
                    return None;
                }
                paths[count] = (first, last);
                count += 1;
                for j in first..=last {
                    let joint = self.uu(SOLVE_JOINTS, j) as usize;
                    for end in [self.uu(JOINT_A, joint) as usize, self.uu(JOINT_B, joint) as usize] {
                        if !held.bodies[..held.count].contains(&end) {
                            if held.count == HELD_BODIES {
                                return None;
                            }
                            held.bodies[held.count] = end;
                            held.count += 1;
                        }
                    }
                }
            }
        }
        if count == 0 {
            return None;
        }
        let n = held.count;
        let mut saved = [(zero, zero); HELD_BODIES];
        for (k, kept) in saved.iter_mut().enumerate().take(n) {
            *kept = (self.v(LINEAR_X, held.bodies[k]), self.v(ANGULAR_X, held.bodies[k]));
        }
        #[cfg(not(target_arch = "wasm32"))]
        let ledger = crate::solver::DRIVEN.with(|d| d.get());
        let sweeps = if count == 1 { 1 } else { HELD_SWEEPS };
        let mut runs = [[(zero, zero); HELD_BODIES]; 2];
        #[cfg(not(target_arch = "wasm32"))]
        let mut work = [0.0f64; 2];
        for (run, speeds) in runs.iter_mut().enumerate() {
            for (k, &(linear, angular)) in saved.iter().enumerate().take(n) {
                self.set_v(LINEAR_X, held.bodies[k], linear);
                self.set_v(ANGULAR_X, held.bodies[k], angular);
            }
            if run == 0 {
                let (mut body_a, mut body_b) = self.pair_moving(row, a, b);
                body_a.push(normal.scale(-probe), arm_a);
                body_b.push(normal.scale(probe), arm_b);
                self.settle(a, &body_a);
                self.settle(b, &body_b);
            }
            for _ in 0..sweeps {
                for &(first, last) in &paths[..count] {
                    self.path_right(first, last, 0.0, 0.0, false);
                    self.apply_path(first, last, 1.0, false);
                }
            }
            for (k, speed) in speeds.iter_mut().enumerate().take(n) {
                *speed = (self.v(LINEAR_X, held.bodies[k]), self.v(ANGULAR_X, held.bodies[k]));
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                work[run] = crate::solver::DRIVEN.with(|d| d.get()) - ledger;
                crate::solver::DRIVEN.with(|d| d.set(ledger));
            }
        }
        for (k, &(linear, angular)) in saved.iter().enumerate().take(n) {
            self.set_v(LINEAR_X, held.bodies[k], linear);
            self.set_v(ANGULAR_X, held.bodies[k], angular);
        }
        let per = 1.0 / probe;
        for k in 0..n {
            // A body that cannot move has no response, whatever its speed columns were written with.
            if self.flags(held.bodies[k]) & KIND != DYNAMIC || !self.is_awake(held.bodies[k]) {
                continue;
            }
            held.linear[k] = runs[0][k].0.sub(runs[1][k].0).scale(per);
            held.angular[k] = runs[0][k].1.sub(runs[1][k].1).scale(per);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            held.driven = (work[0] - work[1]) / probe as f64;
        }
        let at = |k: usize, arm: V3| held.linear[k].add(held.angular[k].cross(arm));
        held.inverse = at(1, arm_b).sub(at(0, arm_a)).dot(normal);
        if held.inverse > 0.0 { Some(held) } else { None }
    }

    /// Gives the bodies of `held` a strike of `impulse` with the joints holding: `held_response`'s response times it. A body
    /// that cannot move has no response and does not move.
    pub(crate) fn apply_held(&mut self, held: &Held, impulse: f32) {
        for k in 0..held.count {
            let body = held.bodies[k];
            if self.flags(body) & KIND != DYNAMIC || !self.is_awake(body) {
                continue;
            }
            self.set_v(LINEAR_X, body, self.v(LINEAR_X, body).add(held.linear[k].scale(impulse)));
            self.set_v(ANGULAR_X, body, self.v(ANGULAR_X, body).add(held.angular[k].scale(impulse)));
        }
        #[cfg(not(target_arch = "wasm32"))]
        crate::solver::DRIVEN.with(|d| d.set(d.get() + held.driven * impulse as f64));
    }

    /// What a joint's impulses, kept in RIGHT, would add to each of its bodies, with the arm on each.
    fn gains(&self, row: usize) -> [(V3, V3, f32); 2] {
        let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
        let view = self.view(row);
        let doubles = self.doubles(row);
        let (mut body_a, mut body_b) = self.ends(row);
        let still = v3(0.0, 0.0, 0.0);
        (body_a.linear, body_a.angular, body_b.linear, body_b.angular) = (still, still, still, still);
        for r in 0..m {
            view.rows[axes[r]].push(&mut body_a, &mut body_b, unsafe { *doubles.add(RIGHT + r) } as f32);
        }
        [(body_a.linear, body_a.angular, view.arms[0]), (body_b.linear, body_b.angular, view.arms[1])]
    }

    /// The rows the projection moves a joint's bodies along, the discrete gradient over the substep, and the inertia it
    /// turns them by.
    fn lock_dirs(&self, row: usize) -> ([Row; 6], Moving, Moving) {
        let (body_a, body_b) = self.ends(row);
        (unsafe { (*self.lock_start(row)).dg }, body_a, body_b)
    }

    /// A joint's arms, slide and axes at the given poses of its bodies, as `joint_view` reads them.
    fn lock_geometry(&self, row: usize, pa: (V3, Q), pb: (V3, Q)) -> (V3, V3, V3, [V3; 3]) {
        let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
        let flags = self.uu(JOINT_FLAGS, row);
        let arm_a = pa.1.rotate(self.v(JOINT_ANCHOR_A_X, row).sub(self.v(LOCAL_CENTER_X, a)));
        let arm_b = pb.1.rotate(self.v(JOINT_ANCHOR_B_X, row).sub(self.v(LOCAL_CENTER_X, b)));
        let gap = pb.0.add(arm_b).sub(pa.0.add(arm_a));
        let frame_a = pa.1.mul(self.q(JOINT_FRAME_A_X, row));
        let axes = [frame_a.rotate(AXES[0]), frame_a.rotate(AXES[1]), frame_a.rotate(AXES[2])];
        let rigid = flags / JOINT_LOCK & 7;
        let mut slide = gap;
        for k in 0..3 {
            if rigid >> k & 1 != 0 {
                slide = slide.sub(axes[k].scale(axes[k].dot(gap)));
            }
        }
        (arm_a, arm_b, slide, axes)
    }

    /// The discrete gradient of each sliding lock e . g over the substep so far (Gonzalez 1996): rows whose
    /// product with the step, a move dx and turns phi, is the change of the measure exactly. A turn phi takes w to
    /// w + sinc (phi x w) + c2 phi x (phi x w), so e . (exp(phi) - I) w = phi . (sinc (w x e) + c2 ((phi x w) x e)), and the
    /// product e . g changes by mean(e) . dg + mean(g) . de.
    fn gradient_rows(&self, row: usize, start: &LockStart, rows: &mut [Row; 6]) {
        let flags = self.uu(JOINT_FLAGS, row);
        if flags & JOINT_DISTANCE != 0 || self.uu(JOINT_COUPLE, row) & 7 != 0 {
            return;
        }
        let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
        let now = [(self.pose_center(a), self.pose_rotation(a)), (self.pose_center(b), self.pose_rotation(b))];
        let (arm_a0, arm_b0, slide0, axes0) = self.lock_geometry(row, start.poses[0], start.poses[1]);
        let (_, _, slide1, axes1) = self.lock_geometry(row, now[0], now[1]);
        let turn = |i: usize| {
            let mut q = now[i].1.mul(start.poses[i].1.conjugate());
            if q.w < 0.0 {
                q = Q { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
            }
            (q.to_rotation_vector(), q)
        };
        let ((phi_a, q_a), (phi_b, q_b)) = (turn(0), turn(1));
        // sinc and (1 - cos) / |phi|^2, by their series where |phi| is small. Past it from the turn's own quaternion, with
        // s = |q.xyz| = sin(t/2) and w = cos(t/2) over |q|: sin t = 2 s w and 1 - cos t = 2 s^2, so plus, times, divide and a
        // root alone reach the state (the head of lib.rs), and 1 - cos t takes no cancellation.
        let parts = |phi: V3, q: Q| {
            let t2 = phi.dot(phi);
            if t2 < 1e-4 {
                (1.0 - t2 / 6.0 + t2 * t2 / 120.0, 0.5 - t2 / 24.0 + t2 * t2 / 720.0)
            } else {
                let t = sqrt(t2);
                let s2 = q.x * q.x + q.y * q.y + q.z * q.z;
                let size = s2 + q.w * q.w;
                (2.0 * sqrt(s2) * q.w / size / t, 2.0 * s2 / size / t2)
            }
        };
        let grad = |phi: V3, q: Q, w: V3, e: V3| {
            let (s1, c2) = parts(phi, q);
            w.cross(e).scale(s1).add(phi.cross(w).cross(e).scale(c2))
        };
        let rigid = flags / JOINT_LOCK & 7;
        let mean_slide = slide0.add(slide1).scale(0.5);
        for k in 0..3 {
            if rigid >> k & 1 == 0 {
                continue;
            }
            let e = axes0[k].add(axes1[k]).scale(0.5);
            let tb = grad(phi_b, q_b, arm_b0, e);
            let ta = grad(phi_a, q_a, arm_a0, e).sub(grad(phi_a, q_a, axes0[k], mean_slide));
            rows[k] = Row { d: e, ta, tb };
        }
    }

    /// `gains` along `lock_dirs`.
    fn lock_gains(&self, row: usize) -> [(V3, V3, f32); 2] {
        let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
        let view = self.view(row);
        let doubles = self.doubles(row);
        let (rows, mut body_a, mut body_b) = self.lock_dirs(row);
        let still = v3(0.0, 0.0, 0.0);
        (body_a.linear, body_a.angular, body_b.linear, body_b.angular) = (still, still, still, still);
        for r in 0..m {
            rows[axes[r]].push(&mut body_a, &mut body_b, unsafe { *doubles.add(RIGHT + r) } as f32);
        }
        [(body_a.linear, body_a.angular, view.arms[0]), (body_b.linear, body_b.angular, view.arms[1])]
    }

    /// How much of a path's push to take. See the head of this file. A body between two joints gains from both.
    fn push_share(&self, first: usize, last: usize, asked: f32, h: f32) -> f32 {
        let (mut top, mut turn) = (0.0f32, 0.0f32);
        let mut carried = (v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), 0.0f32);
        for i in first..=last {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let gains = self.gains(row);
            let from = if i > first { self.uu(SOLVE_VIA, i) } else { NONE };
            let onward = if i < last { self.uu(SOLVE_VIA, i + 1) } else { NONE };
            for (gain, body) in gains.iter().zip([self.uu(JOINT_A, row), self.uu(JOINT_B, row)]) {
                if body == onward {
                    carried = *gain;
                } else {
                    let whole = if body == from { (gain.0.add(carried.0), gain.1.add(carried.1), gain.2.max(carried.2)) } else { *gain };
                    let spin = sqrt(whole.1.dot(whole.1));
                    top = top.max(sqrt(whole.0.dot(whole.0)) + whole.2 * spin);
                    let now = self.v(ANGULAR_X, body as usize);
                    let then = now.add(whole.1);
                    turn = turn.max(sqrt(then.dot(then)) - sqrt(now.dot(now)));
                    if whole.2 > 0.0 {
                        let now = self.v(LINEAR_X, body as usize);
                        let then = now.add(whole.0);
                        turn = turn.max((sqrt(then.dot(then)) - sqrt(now.dot(now))) / whole.2);
                    }
                }
            }
        }
        let room = if top > asked { TURN * asked / top } else { TURN };
        if h * turn > room { room / (h * turn) } else { 1.0 }
    }

    /// A motor joint's caps: the impulse the three sliding motors hold, as one vector, cut back to axis 0's cap over the substep,
    /// and the three turning motors' to axis 3's, each pushed back along its own rows. Each axis was capped alone as it solved;
    /// cutting the sum keeps its direction, as Box2D cuts its motor joint's accumulated impulse (Catto 2011).
    fn cap_motor_vectors(&mut self, row: usize, rows: &[Row; 6], h: f32, a: &mut Moving, b: &mut Moving) {
        for first in [0usize, 3] {
            let held = [self.s(JOINT_MOTOR_0 + first, row), self.s(JOINT_MOTOR_0 + first + 1, row), self.s(JOINT_MOTOR_0 + first + 2, row)];
            let length = sqrt(held[0] * held[0] + held[1] * held[1] + held[2] * held[2]);
            let cap = h * self.s(JOINT_CAP_0 + first, row);
            if !(length > cap) {
                continue;
            }
            let share = cap / length;
            for k in 0..3 {
                let total = held[k] * share;
                rows[first + k].push(a, b, total - held[k]);
                self.set_s(JOINT_MOTOR_0 + first + k, row, total);
            }
        }
    }

    /// A motor on one axis: a soft row toward its target and target speed, capped at its most force over this substep.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn motor_row(&mut self, row: usize, k: usize, force: bool, axis: &Row, at: f32, h: f32, a: &mut Moving, b: &mut Moving) {
        let give = axis.give(axis, a, b);
        if !(give > 0.0) {
            return;
        }
        let scale = if force { 1.0 } else { 1.0 / give };
        let (stiffness, damping) = (self.s(JOINT_STIFFNESS_0 + k, row) * scale, self.s(JOINT_DAMPING_0 + k, row) * scale);
        let softness = h * (damping + h * stiffness);
        if !(softness > 0.0) {
            return;
        }
        let gamma = 1.0 / softness;
        let bias = (at - self.s(JOINT_TARGET_0 + k, row)) * h * stiffness * gamma;
        let held = self.s(JOINT_MOTOR_0 + k, row);
        let speed = axis.speed(a, b) - self.s(JOINT_SPEED_0 + k, row);
        let total = held - (speed + bias + gamma * held) / (give + gamma);
        let cap = h * self.s(JOINT_CAP_0 + k, row);
        let total = if total > cap {
            cap
        } else if total < -cap {
            -cap
        } else {
            total
        };
        axis.push(a, b, total - held);
        self.set_s(JOINT_MOTOR_0 + k, row, total);
    }

    /// A limit on one axis, against its nearer end: a one-way row, rigid up to its edge and soft past it. It reads the speed
    /// its joint's locks leave it and moves what they let it move, and the path solve that follows adds their share.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn limit_row(&mut self, row: usize, k: usize, view: &View, h: f32, stiffness: Soft, most: f32, pass: Pass, a: &mut Moving, b: &mut Moving) {
        let (axis, at) = (&view.rows[k], view.at[k]);
        // A joint of its own softness gives way past its edge as that spring, not as a contact.
        let own = self.s(JOINT_LIMIT_HERTZ, row);
        let stiffness = if own > 0.0 { crate::solver::soft(own, self.s(JOINT_LIMIT_ZETA, row), h) } else { stiffness };
        let doubles = self.doubles(row);
        let give = unsafe { *doubles.add(EASE + k) } as f32;
        if !(give > 0.0) {
            return;
        }
        let (low, high) = (self.s(JOINT_MIN_0 + k, row), self.s(JOINT_MAX_0 + k, row));
        // +1 pushes up from the lower end, -1 down from the upper one.
        let (side, gap) = if at - low < high - at { (1.0, at - low) } else { (-1.0, high - at) };
        let carried = self.s(JOINT_IMPULSE_0 + k, row) * side;
        let pressed = if carried > 0.0 { carried } else { 0.0 };
        let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
        let mut along = axis.speed(a, b) as f64;
        for r in 0..m {
            along -= unsafe { *doubles.add(LEAN + k * 6 + r) } * view.rows[axes[r]].speed(a, b) as f64;
        }
        let speed = along as f32 * side;
        let (bias, mass_scale, impulse_scale) = if gap > 0.0 {
            (gap / h, 1.0, 0.0)
        } else if pass == Pass::Push {
            let push = stiffness.bias_rate * gap;
            (if push > -most { push } else { -most }, stiffness.mass_scale, stiffness.impulse_scale)
        } else {
            (0.0, 1.0, 0.0)
        };
        let total = pressed - mass_scale * (speed + bias) / give - impulse_scale * pressed;
        let total = if total > 0.0 { total } else { 0.0 };
        // A relaxing pass only takes back, as for a contact.
        let total = if pass == Pass::Relax && gap > 0.0 && total > pressed { pressed } else { total };
        axis.push(a, b, (total - carried) * side);
        self.set_s(JOINT_IMPULSE_0 + k, row, total * side);
    }
}

// Locks in time (KB2161). A lock read at the start of a substep turns its bodies explicitly: a light link pulled along its arms
// by a tension T is a spring of stiffness about 2 T r on its inertia, and semi-implicit Euler holds such a spring only while
// omega h stays under 2, so a level chain under a heavy end swings taut, crosses that bound and opens. So the locks' force is
// read at the end pose: the step is a projection, the pose where every lock holds that is closest, in the mass metric, to the
// pose the substep predicts (the fast projection of Goldenthal et al. 2007, on the path solve of Baraff 1996). The projection
// is Gauss-Newton on the Newton matrix J W G^T of each path, J the rows at the iterate and G the discrete gradient of the
// locks over the substep (Gonzalez 1996, 1999), with a backtracking line search on the gap (Nocedal and Wright 2006); a path
// with more locks than freedoms takes its rows by threshold partial pivoting (Duff, Erisman and Reid 2017, u = 0.1) and drops
// the ones that depend. The speeds follow the midpoint rule: the shift the projection made over h, twice, and the applied
// loads move the poses by h^2 a / 2, not the h^2 a of symplectic Euler (`shed_locks`). A taut three-axis lock's geometric
// stiffness damps the free motion where h^2 k outruns 4 m (`taut_d`, `damp_taut`). In a substep:
//
//   the passes solve the locks with everything else as velocity rows, so contacts and limits see the chain hold; the poses
//   take the midpoint rule's move back (`shed_locks`) and move; `project_locks` closes every lock at the new pose; the shift
//   it made gives the speeds (`lock_speeds`); the relaxing pass then solves the speeds along the locks on rows from the new
//   pose.

/// The most Gauss-Newton iterations of the projection, and the gap that ends it sooner: a lock closed to this, in metres along
/// a sliding lock or radians about a turning one.
const LOCK_ITERATIONS: usize = 24;
const LOCK_CLOSED: f32 = 1e-6;
/// What the projection's shift over h adds to the speeds: 1 for SHAKE, 2 for the midpoint rule.
const LOCK_SPEED_SHARE: f32 = 2.0;
/// A joint's rows and its bodies' poses at the start of a substep, and the discrete gradient
/// of its locks read since (`gradient_rows`), kept in its JOINT_SCRATCH words from JOINT_LOCK_START.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct LockStart {
    rows: [Row; 6],
    poses: [(V3, Q); 2],
    dg: [Row; 6],
}
const _: () = assert!(core::mem::size_of::<LockStart>() <= ((JOINT_STEP - JOINT_LOCK_START) * 4) as usize);

/// The step an iterate of the projection moved a joint's bodies by and gave its locks, kept in its JOINT_SCRATCH words from
/// JOINT_STEP so the line search can take it back; at the first joint of a path, also the widest gap the path stood at and
/// whether it stepped.
#[repr(C)]
#[derive(Clone, Copy)]
struct LockStep {
    moves: [V3; 4],
    given: [f32; 6],
    before: f32,
    stepped: u32,
}
const _: () = assert!(core::mem::size_of::<LockStep>() <= ((JOINT_WORDS - JOINT_STEP) * 4) as usize);

/// One lock row of a path in its Newton solve: the joint and row, the row read at this pose and the one the step moves along,
/// the joint's bodies and how they move, and the share of its gap it asks to close.
#[repr(C)]
#[derive(Clone, Copy)]
struct Entry {
    at: u32,
    r: u32,
    a: u32,
    b: u32,
    j: Row,
    g: Row,
    ma: Moving,
    mb: Moving,
    ask: f64,
}
const ENTRY_WORDS: u64 = (core::mem::size_of::<Entry>() / 4) as u64;
const _: () = assert!(core::mem::size_of::<Entry>() % 8 == 0);

/// Words of NEWTON a path of `n` lock rows takes: its entries, then the doubles of its matrix and the copy kept whole, seven
/// vectors of n doubles, and three lists of n places; even, so the next slice's doubles stay on 8 bytes.
pub(crate) fn newton_words(n: u64) -> u64 {
    let words = n * ENTRY_WORDS + 2 * (2 * n * n + 7 * n) + 3 * n;
    (words + 1) & !1
}

impl World {
    /// A stamp for this substep, so a body a lock holds is known once whatever number of joints it carries.
    fn lock_stamp(&self) -> u32 {
        self.header().steps.wrapping_mul(1024).wrapping_add(self.window.substep + 1)
    }

    /// After the last pass, before the poses move: the passes' lock impulses stay, so the poses move with the speeds the
    /// solve found and the projection starts from there; marks every body a lock holds, and records what each lock may leave
    /// open. A projection that started from the poses everything but the locks moves to would close to the pose nearest that,
    /// and past a turn of a radian in a substep that is the wrong one: a bead on a rail a kinematic body turns 1.29 rad is
    /// pulled in toward the hub, where the rail flings it out. Read as a shift of the step, that speed would also be taken as
    /// an acceleration of h^2 beta, which overshoots an impulse by gamma / beta.
    pub fn shed_locks(&mut self, h: f32) {
        let (from, solving) = self.window.joints;
        let stamp = self.lock_stamp();
        for i in from..solving {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            // The projection's own impulses gather here; a row that is no lock this substep carries none.
            for k in 0..6 {
                self.set_s(JOINT_LOCK_P_0 + k, row, 0.0);
            }
            if m == 0 {
                continue;
            }
            let view = self.view(row);
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let (body_a, body_b) = (self.moving(a), self.moving(b));
            let rate = self.s(SOLVE_SHARE, i);
            let arms = view.arms[0] * sqrt(body_a.angular.dot(body_a.angular)) + view.arms[1] * sqrt(body_b.angular.dot(body_b.angular));
            let most = h * (self.header().joint_max_push + arms);
            let driven = |at: usize, arm: f32, spin: V3| if self.flags(at) & KIND == DYNAMIC { 0.0 } else { arm * sqrt(spin.dot(spin)) };
            let reach = h * (self.header().joint_max_push + driven(a, view.arms[0], body_a.angular) + driven(b, view.arms[1], body_b.angular));
            for r in 0..m {
                let k = axes[r];
                // The pushing pass's bias closed share of the gap, capped at joint_max_push and what the turning carries the
                // anchors, over the substep (see the head of this file); the projection closes as much and leaves the rest.
                let gap = view.at[k];
                let close = rate * gap;
                let close = if close > most { most } else if close < -most { -most } else { close };
                self.set_s(JOINT_LEAVE_0 + k, row, gap - close);
                self.set_s(JOINT_BEGAN_0 + k, row, gap);
            }
            // As far as the pass's own cap reaches, what the turning carries the anchors included: past it the gap is drift.
            self.set_s(JOINT_REACH, row, reach);
            for body in [a, b] {
                if self.uu(LOCK_MARK, body) != stamp {
                    self.set_u(LOCK_MARK, body, stamp);
                    if self.lock_moves(body) {
                        // The applied loads' move over the substep as the midpoint rule makes it, h^2 a / 2, not
                        // the h^2 a of symplectic Euler: gravity, the body's force and its torque, as `integrate_velocities`
                        // gives them, locked axes left out.
                        let g = self.header().gravity;
                        let flags = self.flags(body);
                        let inverse_mass = self.s(INVERSE_MASS, body);
                        let mut push = v3(0.0, 0.0, 0.0);
                        if inverse_mass > 0.0 {
                            push = v3(g[0], g[1], g[2]).scale(self.s(GRAVITY_SCALE, body)).add(self.v(FORCE_X, body).scale(inverse_mass));
                        }
                        if flags & LOCK_LINEAR != 0 {
                            push = crate::integrate::lock(push, flags / LOCK_LINEAR_X);
                        }
                        let half = -0.5 * h * h;
                        let frame = self.q(ROTATION_X, body).mul(self.q(INERTIA_FRAME_X, body));
                        let torque = crate::integrate::lock(self.v(TORQUE_X, body), (flags & LOCK_ANGULAR) / LOCK_ANGULAR_X);
                        let mut turn = crate::integrate::apply_inverse_inertia(self.v(INVERSE_INERTIA_X, body), frame, torque);
                        if flags & LOCK_ANGULAR != 0 {
                            turn = crate::integrate::lock(turn, flags / LOCK_ANGULAR_X);
                        }
                        {
                            // The locked part of the loads, and on the free axes the whole change the substep made: a motor's
                            // spring or a contact moves the body by h^2 a / 2 as the loads do. A lock's impulse has no free part.
                            // A tree's implicit springs are loads too (`note_springs`): at rest they and gravity are what the
                            // locks carry, so the locked move is the locks' own impulse and the projection takes all of it
                            // back. Left out, the move was gravity's locked part link by link, which the chain's locks
                            // together hold only in part, and the rest moved the free axes by h^2 g / 2 a substep: a
                            // cantilever of 8 links stood 0.35 % low
                            // (`a_chain_of_implicit_springs_bends_as_its_beam_at_any_length_and_substeps`).
                            // Both were noted this substep: a body a lock moves is awake, so on the window's list.
                            let (sv, sw) = (self.v(SPRING_CHANGE_X, body), self.v(SPRING_CHANGE_SPIN_X, body));
                            if sv.dot(sv) + sw.dot(sw) > 0.0 {
                                (push, turn) = (push.add(sv), turn.add(sw));
                            }
                            (push, turn) = self.locked_part(body, push, turn);
                            let (v0, w0) = (self.v(MID_START_X, body), self.v(MID_START_SPIN_X, body));
                            let (dv, dw) = (self.v(LINEAR_X, body).sub(v0).scale(1.0 / h), self.v(ANGULAR_X, body).sub(w0).scale(1.0 / h));
                            let (lv, lw) = self.locked_part(body, dv, dw);
                            (push, turn) = (push.add(dv.sub(lv)), turn.add(dw.sub(lw)));
                        }
                        self.nudge(body, push.scale(half), turn.scale(half), false);
                    }
                }
            }
        }
    }

    /// Notes each awake body's velocity and spin before the substep's loads (MID_START).
    pub fn note_mid_start(&mut self) {
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            self.set_v(MID_START_X, at, self.v(LINEAR_X, at));
            self.set_v(MID_START_SPIN_X, at, self.v(ANGULAR_X, at));
        }
    }

    /// The part of a motion (`linear`, `angular`) of `body` its locks hold: its projection, in the body's mass metric, onto the
    /// span of W j^T over the lock rows j of its joints, W the body's inverse mass and inertia. With f = j and e = W j kept in
    /// pairs, <e, e'>_M = f . e' and <e, u>_M = f . u, so modified Gram-Schmidt needs no inverse of W.
    fn locked_part(&self, body: usize, linear: V3, angular: V3) -> (V3, V3) {
        let own = self.moving(body);
        let w = |l: V3, t: V3| -> [f64; 6] {
            let (l, t) = (v3(own.mass.x * l.x, own.mass.y * l.y, own.mass.z * l.z), own.inertia.mul(t));
            [l.x as f64, l.y as f64, l.z as f64, t.x as f64, t.y as f64, t.z as f64]
        };
        let dot = |a: &[f64; 6], b: &[f64; 6]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>();
        // At most six: past six the span is the whole space, and a seventh row's part outside it is rounding, which the test
        // below drops.
        let mut basis = [([0.0f64; 6], [0.0f64; 6]); 6];
        let mut count = 0;
        let mut at = self.uu(FIRST_JOINT, body);
        while at != NONE {
            let row = at as usize;
            let on_a = self.uu(JOINT_A, row) as usize == body;
            at = self.uu(if on_a { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
            let flags = self.uu(JOINT_FLAGS, row);
            if flags & (JOINT_ALIVE | JOINT_IDLE) != JOINT_ALIVE {
                continue;
            }
            let (m, axes) = lock_rows(flags);
            if m == 0 {
                continue;
            }
            let view = self.view(row);
            for r in 0..m {
                let j = &view.rows[axes[r]];
                let t = if on_a { j.ta } else { j.tb };
                let mut f = [j.d.x as f64, j.d.y as f64, j.d.z as f64, t.x as f64, t.y as f64, t.z as f64];
                let mut e = w(j.d, t);
                let size = dot(&f, &e);
                if !(size > 0.0) {
                    continue;
                }
                if count == basis.len() {
                    break;
                }
                for _ in 0..2 {
                    for (bf, be) in basis.iter().take(count) {
                        let c = dot(&f, be);
                        for i in 0..6 {
                            f[i] -= c * bf[i];
                            e[i] -= c * be[i];
                        }
                    }
                }
                let left = dot(&f, &e);
                if !(left > DEPENDENT * 64.0 * size) {
                    continue;
                }
                let inv = 1.0 / sqrt64(left);
                basis[count] = (f.map(|x| x * inv), e.map(|x| x * inv));
                count += 1;
            }
        }
        let u = [linear.x as f64, linear.y as f64, linear.z as f64, angular.x as f64, angular.y as f64, angular.z as f64];
        let mut out = [0.0f64; 6];
        for (bf, be) in basis.iter().take(count) {
            let c = dot(bf, &u);
            for i in 0..6 {
                out[i] += c * be[i];
            }
        }
        (v3(out[0] as f32, out[1] as f32, out[2] as f32), v3(out[3] as f32, out[4] as f32, out[5] as f32))
    }

    /// Around `spring_multibodies`: with `before`, notes each awake body's velocity and spin; after, keeps what the tree's
    /// implicit springs changed of them over `h`, as an acceleration, for `shed_locks`. A body no spring moved keeps zero.
    pub fn note_springs(&mut self, before: bool, h: f32) {
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            let (v, w) = (self.v(LINEAR_X, at), self.v(ANGULAR_X, at));
            let (v, w) = if before {
                (v, w)
            } else {
                let (v0, w0) = (self.v(SPRING_CHANGE_X, at), self.v(SPRING_CHANGE_SPIN_X, at));
                if v == v0 && w == w0 { (v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0)) } else { (v.sub(v0).scale(1.0 / h), w.sub(w0).scale(1.0 / h)) }
            };
            self.set_v(SPRING_CHANGE_X, at, v);
            self.set_v(SPRING_CHANGE_SPIN_X, at, w);
        }
    }

    /// Moves a body's pose by `linear` at its centre and `angular` as a rotation vector, and counts it in its shift.
    fn nudge(&mut self, at: usize, linear: V3, angular: V3, counted: bool) {
        let center = self.v(CENTER_X, at).add(linear);
        let rotation = Q::from_rotation_vector(angular).mul(self.q(ROTATION_X, at)).normalized();
        self.set_v(CENTER_X, at, center);
        self.set_q(ROTATION_X, at, rotation);
        self.set_v(POSITION_X, at, center.sub(rotation.rotate(self.v(LOCAL_CENTER_X, at))));
        if !counted {
            return;
        }
        self.set_v(LOCK_SHIFT_X, at, self.v(LOCK_SHIFT_X, at).add(linear));
        self.set_v(LOCK_SHIFT_SPIN_X, at, self.v(LOCK_SHIFT_SPIN_X, at).add(angular));
    }

    /// True when the body is dynamic and awake, so a lock may move it.
    fn lock_moves(&self, at: usize) -> bool {
        let flags = self.flags(at);
        flags & KIND == DYNAMIC && flags & SLEEPING == 0
    }

    /// After the poses move: a body a lock holds starts the projection's shift from zero.
    pub fn lock_drift(&mut self) {
        let stamp = self.lock_stamp();
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            if self.uu(LOCK_MARK, at) != stamp || !self.lock_moves(at) {
                continue;
            }
            self.set_v(LOCK_SHIFT_X, at, v3(0.0, 0.0, 0.0));
            self.set_v(LOCK_SHIFT_SPIN_X, at, v3(0.0, 0.0, 0.0));
        }
    }

    /// The largest gap any lock from list place `first` to `last` stands open by, from the views of the last `refresh_joints`.
    fn widest_lock(&self, first: usize, last: usize, to: usize) -> f32 {
        let mut widest = 0.0f32;
        for i in first..=last {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            for r in 0..m {
                let at = view.at[axes[r]] - self.s(to + axes[r], row);
                let at = if at < 0.0 { -at } else { at };
                if at > widest {
                    widest = at;
                }
            }
        }
        widest
    }

    /// Closes every lock at the new pose: Gauss-Newton toward the closest pose, in the mass metric, where the locks hold, each
    /// path solved exactly on rows read again at each iterate. Leaves the rows read at the pose it ends on.
    pub fn project_locks(&mut self, h: f32) {
        // First what this substep opened, the locks' force, then what earlier substeps left, a move of the poses alone: turned
        // into speed, the closing of an old gap is energy no force gave, and near a toggle a great deal of it.
        let (from, solving) = self.window.joints;
        for i in from..solving {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            let most = self.s(JOINT_REACH, row);
            for r in 0..m {
                let k = axes[r];
                // What the substep opened, as far as the cap lets a force close it: the rest closes as a move alone.
                let opened = view.at[k] - self.s(JOINT_BEGAN_0 + k, row);
                let opened = if opened > most { most } else if opened < -most { -most } else { opened };
                self.set_s(JOINT_BEGAN_0 + k, row, view.at[k] - opened);
            }
        }
        self.project_to(h, JOINT_BEGAN_0, true);
        self.project_to(h, JOINT_LEAVE_0, false);
    }

    /// One stage of `project_locks`: closes each lock to the gap in column `to`, and counts the shift as the locks' (`counted`).
    fn project_to(&mut self, h: f32, to: usize, counted: bool) {
        // Each path decides from its own gaps whether it takes the iteration, so a step solved island by island moves the same
        // bits as one solved phase by phase.
        for _ in 0..LOCK_ITERATIONS {
            let (from, solving) = self.window.joints;
            let mut open = false;
            let mut first = from;
            // Each path's step and the gap it stood at, for a backtracking line search on the gap, in its joints' LockStep.
            while first < solving {
                let mut last = first;
                while last + 1 < solving && self.uu(SOLVE_VIA, last + 1) != NONE {
                    last += 1;
                }
                let lead = self.uu(SOLVE_JOINTS, first) as usize;
                if !(self.widest_lock(first, last, to) > LOCK_CLOSED) {
                    unsafe { (*self.lock_step(lead)).stepped = 0 };
                    first = last + 1;
                    continue;
                }
                open = true;
                // RIGHT = K^-1 (-(gap - leave) / h): the speed whose move over the substep, h M^-1 J^T p, closes each lock to
                // what it may leave open, which already leaves the share's rest (`shed_locks`); a loose joint of a loop takes its
                // share an iterate, as it did a pass, as the paths of a loop step together and a whole step would fight its
                // neighbours'. Stepping an exact path by its share as well applied it twice: a share of 0.05 closed 3.5 % a
                // substep (`an_exact_path_closes_its_share_of_a_gap_each_substep`). Near a pose where the rows turn dependent the
                // step is a Gauss-Newton step past its first order model, so it is cut by `push_share` as the pushing pass's bias
                // was (Buss and Kim 2005; see the head of this file).
                let share = if self.uu(SOLVE_EXACT, first) != 0 { 1.0 } else { self.s(SOLVE_SHARE, first) };
                let asked = self.path_right_to(first, last, share / h, to);
                self.newton_right(first, last, share / h, to, counted);
                let by = h * self.push_share(first, last, asked, h);
                let before = self.widest_lock(first, last, to);
                for i in first..=last {
                    let row = self.uu(SOLVE_JOINTS, i) as usize;
                    let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
                    let doubles = self.doubles(row);
                    let mut given = [0.0f32; 6];
                    if counted {
                        for r in 0..m {
                            let p = unsafe { *doubles.add(RIGHT + r) } as f32 * by;
                            given[axes[r]] = p;
                            self.set_s(JOINT_LOCK_P_0 + axes[r], row, self.s(JOINT_LOCK_P_0 + axes[r], row) + p);
                        }
                    }
                    let [(la, aa, _), (lb, ab, _)] = if counted { self.lock_gains(row) } else { self.gains(row) };
                    let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
                    let mv = [la.scale(by), aa.scale(by), lb.scale(by), ab.scale(by)];
                    if self.lock_moves(a) {
                        self.nudge(a, mv[0], mv[1], counted);
                    }
                    if self.lock_moves(b) {
                        self.nudge(b, mv[2], mv[3], counted);
                    }
                    unsafe {
                        let step = self.lock_step(row);
                        (*step).moves = mv;
                        (*step).given = given;
                    }
                }
                unsafe {
                    let step = self.lock_step(lead);
                    (*step).before = before;
                    (*step).stepped = 1;
                }
                first = last + 1;
            }
            if !open {
                return;
            }
            self.refresh_joints(h, false);
            // A path whose step widened its gap takes half the step back, up to eight times (Armijo backtracking
            // on the gap, Nocedal and Wright 2006, ch. 3 and 10).
            for _ in 0..8 {
                let mut cut = false;
                let mut first = from;
                while first < solving {
                    let mut last = first;
                    while last + 1 < solving && self.uu(SOLVE_VIA, last + 1) != NONE {
                        last += 1;
                    }
                    let (path, next) = ((first, last), last + 1);
                    first = next;
                    let lead = unsafe { *self.lock_step(self.uu(SOLVE_JOINTS, path.0) as usize) };
                    if lead.stepped == 0 || !(self.widest_lock(path.0, path.1, to) > lead.before + LOCK_CLOSED) {
                        continue;
                    }
                    cut = true;
                    for i in path.0..=path.1 {
                        let row = self.uu(SOLVE_JOINTS, i) as usize;
                        let LockStep { moves: mut mv, mut given, .. } = unsafe { *self.lock_step(row) };
                        let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
                        for v in mv.iter_mut() {
                            *v = v.scale(0.5);
                        }
                        if self.lock_moves(a) {
                            self.nudge(a, mv[0].scale(-1.0), mv[1].scale(-1.0), counted);
                        }
                        if self.lock_moves(b) {
                            self.nudge(b, mv[2].scale(-1.0), mv[3].scale(-1.0), counted);
                        }
                        for k in 0..6 {
                            given[k] *= 0.5;
                            if counted {
                                self.set_s(JOINT_LOCK_P_0 + k, row, self.s(JOINT_LOCK_P_0 + k, row) - given[k]);
                            }
                        }
                        unsafe {
                            let step = self.lock_step(row);
                            (*step).moves = mv;
                            (*step).given = given;
                        }
                    }
                }
                if !cut {
                    break;
                }
                self.refresh_joints(h, false);
            }
        }
    }

    /// RIGHT solved on the Newton matrix N = J W G^T of the path, J the rows read at this pose and G
    /// the rows the step moves along (`lock_dirs`), so the step closes `rate` of each gap to first order however far G is
    /// from J (Gonzalez 1999 solves the discrete gradient's constraint with this matrix). Householder QR with column
    /// pivoting; a column under the path's tolerance is a dependent row and takes no push.
    fn newton_right(&mut self, first: usize, last: usize, rate: f32, to: usize, along_dirs: bool) {
        // The path's slice of NEWTON, which `prepare_joints` sized for its lock rows; none when memory could not hold it, and
        // then the path takes no push (the step reports the failure).
        let at = self.uu(SOLVE_NEWTON, first);
        if at == NONE {
            for i in first..=last {
                let row = self.uu(SOLVE_JOINTS, i) as usize;
                let doubles = self.doubles(row);
                for r in 0..6 {
                    unsafe { *doubles.add(RIGHT + r) = 0.0 };
                }
            }
            return;
        }
        let mut n = 0;
        for i in first..=last {
            n += lock_rows(self.uu(JOINT_FLAGS, self.uu(SOLVE_JOINTS, i) as usize)).0;
        }
        if n == 0 {
            return;
        }
        // Carved into its parts in the order `newton_words` counts them, none overlapping another.
        let base = unsafe { self.f(NEWTON).add(at as usize) };
        let list = unsafe { core::slice::from_raw_parts_mut(base as *mut Entry, n) };
        let doubles = unsafe { base.add(n * ENTRY_WORDS as usize) as *mut f64 };
        let part = |from: usize, len: usize| unsafe { core::slice::from_raw_parts_mut(doubles.add(from), len) };
        let (nm, whole) = (part(0, n * n), part(n * n, n * n));
        let vectors = 2 * n * n;
        let (rhs, asked, norms, own) = (part(vectors, n), part(vectors + n, n), part(vectors + 2 * n, n), part(vectors + 3 * n, n));
        let (x, lambda) = (part(vectors + 5 * n, n), part(vectors + 6 * n, n));
        let places = unsafe { doubles.add(vectors + 7 * n) as *mut u32 };
        let place = |from: usize| unsafe { core::slice::from_raw_parts_mut(places.add(from), n) };
        let (perm, left, order) = (place(0), place(n), place(2 * n));
        let mut count = 0;
        for i in first..=last {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            let view = self.view(row);
            // The rows the step moves along: the locks' own for a counted step (`lock_gains`), this pose's for a move (`gains`).
            let (g, ma, mb) = if along_dirs { self.lock_dirs(row) } else { let (ma, mb) = self.ends(row); (view.rows, ma, mb) };
            let (a, b) = (self.uu(JOINT_A, row), self.uu(JOINT_B, row));
            for r in 0..m {
                let k = axes[r];
                let ask = rate as f64 * (view.at[k] as f64 - self.s(to + k, row) as f64);
                list[count] = Entry { at: row as u32, r: r as u32, j: view.rows[k], g: g[k], a, b, ma, mb, ask };
                count += 1;
            }
        }
        // Each end as (body, sign, its part of the row, its Moving).
        let ends = |e: &Entry, row: &Row| [(e.a, -1.0f64, row.d, row.ta, e.ma), (e.b, 1.0f64, row.d, row.tb, e.mb)];
        for p in 0..n {
            for q in 0..n {
                let mut sum = 0.0f64;
                for (xa, sa, da, ta, wa) in ends(&list[p], &list[p].j) {
                    for (xb, sb, db, tb, _) in ends(&list[q], &list[q].g) {
                        if xa != xb {
                            continue;
                        }
                        sum += sa * sb * (scaled(da, db, wa.mass) + wa.inertia.between(ta, tb));
                    }
                }
                nm[p * n + q] = sum;
            }
        }
        for (r, e) in list.iter().enumerate() {
            rhs[r] = -e.ask;
        }
        whole.copy_from_slice(nm);
        asked.copy_from_slice(rhs);
        // Householder QR with column pivoting (Golub and Van Loan 2013, Algorithm 5.4.1).
        for c in 0..n {
            perm[c] = c as u32;
            norms[c] = (0..n).map(|r| nm[r * n + c] * nm[r * n + c]).sum::<f64>();
        }
        // Each column is judged against its own size, as the path's factor is (Higham 1990's stop at n u): a heavy end's
        // columns are a thousandth of a light link's and still hold.
        own.copy_from_slice(norms);
        let tolerance = DEPENDENT * n as f64;
        let mut rank = 0;
        for c in 0..n {
            let (mut best, mut most) = (c, -1.0);
            for k in c..n {
                let left = if own[k] > 0.0 { norms[k] / own[k] } else { 0.0 };
                if left > most {
                    (best, most) = (k, left);
                }
            }
            if best != c {
                for r in 0..n {
                    nm.swap(r * n + c, r * n + best);
                }
                norms.swap(c, best);
                own.swap(c, best);
                perm.swap(c, best);
            }
            let size = sqrt64((c..n).map(|r| nm[r * n + c] * nm[r * n + c]).sum::<f64>());
            if !(size > tolerance * sqrt64(own[c])) {
                break;
            }
            let alpha = if nm[c * n + c] > 0.0 { -size } else { size };
            let v = part(vectors + 4 * n, n - c);
            for r in c..n {
                v[r - c] = nm[r * n + c];
            }
            v[0] -= alpha;
            let vv: f64 = v.iter().map(|x| x * x).sum();
            if vv > 0.0 {
                for k in c..n {
                    let dot: f64 = (c..n).map(|r| v[r - c] * nm[r * n + k]).sum::<f64>() * 2.0 / vv;
                    for r in c..n {
                        nm[r * n + k] -= dot * v[r - c];
                    }
                }
                let dot: f64 = (c..n).map(|r| v[r - c] * rhs[r]).sum::<f64>() * 2.0 / vv;
                for r in c..n {
                    rhs[r] -= dot * v[r - c];
                }
            }
            for k in c + 1..n {
                norms[k] = (c + 1..n).map(|r| nm[r * n + k] * nm[r * n + k]).sum();
            }
            rank = c + 1;
        }
        x.fill(0.0);
        if rank < n {
            // More locks than freedoms: the rows are taken in the path's own order and one whose pivot is rounding against its
            // own diagonal is dropped, row and column, as the path's factor drops the row that depends (Higham 1990's stop)
            // (`a_path_with_more_locks_than_freedoms_drops_the_row_that_depends`). A least-squares step over every row asks the
            // body for a compromise the dependent rows' gaps move each substep, and that becomes speed. The factor is done
            // with, so its matrix and right side take the copies kept whole.
            let m = nm;
            m.copy_from_slice(whole);
            let y = rhs;
            y.copy_from_slice(asked);
            let mut lefts = n;
            for k in 0..n {
                left[k] = k as u32;
            }
            let mut ordered = 0;
            let share = THRESHOLD_SHARE;
            while lefts > 0 {
                let left_now = || left.iter().take(lefts);
                // A row in the path's own order is taken while its pivot holds against its column, the threshold test of
                // sparse LU (Duff, Erisman and Reid 2017, section 7.8); otherwise the steadiest of the rows left.
                let column = |k: usize| left_now().map(|&r| m[r as usize * n + k].abs()).fold(0.0f64, f64::max);
                let clear = |k: usize| m[k * n + k].abs() > tolerance * whole[k * n + k].abs();
                let pick = left_now().position(|&k| clear(k as usize) && m[k as usize * n + k as usize].abs() >= share * column(k as usize)).or_else(|| {
                    let mut best: Option<(usize, f64)> = None;
                    for (i, &k) in left_now().enumerate() {
                        let k = k as usize;
                        let ratio = m[k * n + k].abs() / column(k);
                        if clear(k) && best.map_or(true, |(_, r)| ratio > r) {
                            best = Some((i, ratio));
                        }
                    }
                    best.map(|(i, _)| i)
                });
                let Some(i) = pick else { break };
                let c = left[i] as usize;
                for k in i + 1..lefts {
                    left[k - 1] = left[k];
                }
                lefts -= 1;
                let pivot = m[c * n + c];
                for &r in left.iter().take(lefts) {
                    let r = r as usize;
                    let f = m[r * n + c] / pivot;
                    if f == 0.0 {
                        continue;
                    }
                    for k in 0..n {
                        m[r * n + k] -= f * m[c * n + k];
                    }
                    y[r] -= f * y[c];
                }
                order[ordered] = c as u32;
                ordered += 1;
            }
            // The rows left are the ones that depend: they are dropped, row and column.
            let z = x;
            for at in (0..ordered).rev() {
                let c = order[at] as usize;
                let mut sum = y[c];
                for &k in order.iter().take(ordered).skip(at + 1) {
                    sum -= m[c * n + k as usize] * z[k as usize];
                }
                z[c] = sum / m[c * n + c];
            }
            for (e, &l) in list.iter().zip(z.iter()) {
                let doubles = self.doubles(e.at as usize);
                unsafe { *doubles.add(RIGHT + e.r as usize) = l };
            }
            return;
        } else {
            for c in (0..rank).rev() {
                let mut sum = rhs[c];
                for k in c + 1..rank {
                    sum -= nm[c * n + k] * x[k];
                }
                x[c] = sum / nm[c * n + c];
            }
        }
        for c in 0..n {
            lambda[perm[c] as usize] = x[c];
        }
        for (e, &l) in list.iter().zip(lambda.iter()) {
            let doubles = self.doubles(e.at as usize);
            unsafe { *doubles.add(RIGHT + e.r as usize) = l };
        }
    }

    /// After the projection: its shift over h^2 beta (1 - alpha_f) / (1 - alpha_m) is the locks' acceleration x, the step's
    /// own a follows from it, and the speeds take h ((1 - gamma) a_before + gamma a).
    pub fn lock_speeds(&mut self, h: f32) {
        let stamp = self.lock_stamp();
        // Each lock's own share, the same step on its multipliers: the impulse the locks gave over the substep, which the
        // bodies' speeds below take as a whole, is what each joint carries, and a kinematic end hands it on as work.
        let (from, solving) = self.window.joints;
        for i in from..solving {
            let row = self.uu(SOLVE_JOINTS, i) as usize;
            let (m, axes) = lock_rows(self.uu(JOINT_FLAGS, row));
            if m == 0 {
                continue;
            }
            let (a, b) = (self.uu(JOINT_A, row) as usize, self.uu(JOINT_B, row) as usize);
            let held = self.lock_moves(a) || self.lock_moves(b);
            let (mut body_a, mut body_b) = (self.moving(a), self.moving(b));
            for r in 0..m {
                let k = axes[r];
                let impulse = if held { self.s(JOINT_LOCK_P_0 + k, row) * LOCK_SPEED_SHARE / h } else { 0.0 };
                // JOINT_IMPULSE stays the passes' own, which the next substep warm starts from; what the projection's step
                // gave on top of it is this, which every reading of a joint's load adds (`joint_load`).
                self.set_s(JOINT_LOCK_P_0 + k, row, impulse);
                // Only the ledger reads this push: neither copy is settled.
                let (rows, _, _) = self.lock_dirs(row);
                rows[k].push(&mut body_a, &mut body_b, impulse);
            }
        }
        let (list, from, to) = self.window.bodies;
        for slot in from..to {
            let at = self.uu(list, slot) as usize;
            if self.uu(LOCK_MARK, at) != stamp || !self.lock_moves(at) {
                continue;
            }
            for (shift, speed) in [(LOCK_SHIFT_X, LINEAR_X), (LOCK_SHIFT_SPIN_X, ANGULAR_X)] {
                self.set_v(speed, at, self.v(speed, at).add(self.v(shift, at).scale(LOCK_SPEED_SHARE / h)));
            }
        }
    }
}
