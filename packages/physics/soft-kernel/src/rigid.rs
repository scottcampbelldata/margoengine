// The exact solve: every rigid edge (an edge of zero natural frequency, a constraint that must not stretch), every particle
// attached to a rigid body and every contact of a particle or a face with a rigid body is a row of one system, solved
// together each piece. The rigid bodies are unknowns of it too, each with its six degrees of freedom: what a body's links and
// contacts do to it is one rigid motion, so a cloth hung from a body or lying on one pushes and is pushed by the same body
// (Shinar, Schroeder and Fedkiw, "Two-way coupling of rigid and deformable bodies", SCA 2008, who couple the two in one
// solve). A sweep that held the cloth's edges apart from the bodies' contacts and links fought them: the contact pushed the
// sheet, the edges pulled it back into the body, the contact pushed the body out, and the body took the energy
// (KB-SOFT-LOOPSTRETCH1, KB-SOFT-ATTACHKICK1).
//
// Each Newton step solves K lambda = -C with K = J M^-1 J^T, the constraint mass matrix (M^-1 the particles' inverse masses
// and the bodies' inverse mass and world inverse inertia), C the rows' violations: an edge's stretch, a link's
// gap along each axis, a contact's depth. A contact pushes and never pulls, so its multiplier is bounded below by zero, and
// the bounded system is solved by MPRGP, the conjugate gradient method with proportioning and gradient projection for bound
// constraints (Dostal and Schoberl, "Minimizing quadratic functions subject to bound constraints with the rate of convergence
// and finite termination", Computational Optimization and Applications 30, 2005), on the system scaled to a unit diagonal
// (Jacobi). With no contact it is the conjugate gradient method itself (Hestenes and Stiefel 1952). The Newton step is then
// taken as far as it lowers the violation (a backtracking line search), so a heavy load that bends the rows far within a
// step converges instead of cycling, and Newton steps go on until every row is within its tolerance: a woven sheet's threads
// at the strain Goldenthal et al. hold inextensible cloth to (0.1 percent), everything else at a hundred thousandth of an
// edge or 10 micrometres of a link or a contact. Friction stays out of the system: a pass after it holds each contact's slide
// back by at most its coefficient times the push the contact gave (Macklin et al. 2014).
//
// All the algebra is in f64, from f32 positions, with only + - * / sqrt and compares, so a result is the same on every run.
use crate::col::Col;
use crate::math::sqrt;
use crate::world::{BLOCK, NONE, OFF, SHEET, SLOTS, STIFFNESS, TENSION, TORN, World};

/// Row kinds.
/// No particle or no body in a row's slot (the kernel's NONE, 0, is a row number plus one elsewhere).
const EMPTY: u32 = u32::MAX;
const EDGE: u32 = 0;
const LINK: u32 = 1;
const CONTACT: u32 = 2;
const FACE: u32 = 3;
const FRICTION: u32 = 4;
const BEND: u32 = 5;

pub struct Rigid {
    // Per row: its kind and what it is (an edge, a link's attachment times three plus the axis, a contact slot, a face), its
    // up to three particles and their coefficient vectors (the row of J for each), its body and the body's linear and angular
    // coefficients, whether its multiplier is bounded at zero, its violation, its diagonal, its multiplier and the solver's
    // scratch.
    kind: Col<u32>,
    item: Col<u32>,
    pp: Col<u32>,
    co: Col<f64>,
    body: Col<u32>,
    bj: Col<f64>,
    bounded: Col<u32>,
    // Per row, the bounds of its multiplier: a contact's at [0, inf), an equality's unbounded, a friction row's within the
    // coefficient times its contact's push either way.
    lo: Col<f64>,
    hi: Col<f64>,
    b: Col<f64>,
    d: Col<f64>,
    u: Col<f64>,
    r: Col<f64>,
    p: Col<f64>,
    ap: Col<f64>,
    g: Col<f64>,
    // Per row, its compliance over the piece's length squared (0 for a row held exactly), and per edge its row this Newton step.
    cmp: Col<f64>,
    edge_row: Col<u32>,
    // Per bending element, its first row (of nine) this Newton step.
    bend_row: Col<u32>,
    // The solver's scratch vectors, kept from piece to piece: a `Col` keeps the block it grows from, so a fresh one each solve
    // would leave a block behind every time.
    ms: Col<f64>,
    my: Col<f64>,
    mg: Col<f64>,
    mp: Col<f64>,
    map: Col<f64>,
    md: Col<f64>,
    mt: Col<f64>,
    rows: usize,
    // Per particle: J^T v, and the positions before a trial step.
    fx: Col<f64>,
    fy: Col<f64>,
    fz: Col<f64>,
    sx: Col<f32>,
    sy: Col<f32>,
    sz: Col<f32>,
    // Per body: J^T v (force then torque), its world inverse inertia (six entries) and its correction before a trial step.
    bf: Col<f64>,
    ii: Col<f64>,
    saved: Col<f32>,
    // Per body, its impulse this solve (linear then angular), summed in f64 and handed to the rigid world once at the end: a
    // solve that takes hundreds of small Newton steps added each step's impulse to the body's f32 total, which dropped the
    // part of every step under its spacing (KB-SOFT-LASHCONTACT1).
    owed: Col<f64>,
    // Which edges the system holds (`find_held`), and the union-find of the rigid edges' components.
    tree: Col<u32>,
    parent: Col<u32>,
    count: Col<i32>,
    mark: Col<u32>,
    // The body row each particle is linked to (`EMPTY` if none).
    linked: Col<u32>,
    /// The largest Levenberg-Marquardt damping of the rows with no compliance, a fraction of each row's diagonal
    /// (`ROW_DAMPING`; 0 for the undamped solve a test compares it with), and the damping of this Newton step.
    pub damping: f64,
    now: f64,
}

impl Rigid {
    pub const fn new() -> Rigid {
        Rigid {
            kind: Col::new(),
            item: Col::new(),
            pp: Col::new(),
            co: Col::new(),
            body: Col::new(),
            bj: Col::new(),
            bounded: Col::new(),
            lo: Col::new(),
            hi: Col::new(),
            b: Col::new(),
            d: Col::new(),
            u: Col::new(),
            r: Col::new(),
            p: Col::new(),
            ap: Col::new(),
            g: Col::new(),
            cmp: Col::new(),
            edge_row: Col::new(),
            bend_row: Col::new(),
            ms: Col::new(),
            my: Col::new(),
            mg: Col::new(),
            mp: Col::new(),
            map: Col::new(),
            md: Col::new(),
            mt: Col::new(),
            rows: 0,
            fx: Col::new(),
            fy: Col::new(),
            fz: Col::new(),
            sx: Col::new(),
            sy: Col::new(),
            sz: Col::new(),
            bf: Col::new(),
            ii: Col::new(),
            saved: Col::new(),
            owed: Col::new(),
            tree: Col::new(),
            parent: Col::new(),
            count: Col::new(),
            mark: Col::new(),
            linked: Col::new(),
            damping: ROW_DAMPING,
            now: 0.0,
        }
    }
}

impl Rigid {
    /// Whether particle `i` is linked to body row `c` (as `World::rigid_begin` last marked them).
    pub(crate) fn is_linked(&self, i: usize, c: usize) -> bool {
        i < self.linked.len() && self.linked[i] == c as u32
    }
}

impl Default for Rigid {
    fn default() -> Self {
        Rigid::new()
    }
}

/// How close a row must come before a Newton step is the last: a fraction of an edge's length, or metres for a link or a
/// contact.
const TOLERANCE: f64 = 1e-5;
/// The strain a sheet's edges are held to: the strictest permissible strain of Goldenthal, Harmon, Fattal, Bercovier
/// and Grinspun, "Efficient simulation of inextensible cloth" (SIGGRAPH 2007), whose fast projection iterates "while strain
/// exceeds threshold" (Algorithm 1), over the 0.1 to 10 percent its experiments allow (figures 4 and 5).
const SHEET_STRAIN: f64 = 1e-3;
/// Armijo's sufficient-decrease constant, the standard one (Nocedal and Wright, *Numerical Optimization*, 2006, section 3.1).
const ARMIJO: f64 = 1e-4;
/// MPRGP's proportioning constant: a step is a conjugate gradient step while the gradient pushing off the bounds is at most
/// this times the free gradient (Dostal and Schoberl 2005 prove the rate for any positive value and use 1).
const PROPORTION: f64 = 1.0;
/// The largest Levenberg-Marquardt damping of a row with no compliance of its own (a rigid edge, a link, a contact), as a
/// fraction of the row's own diagonal (Marquardt, "An algorithm for least-squares estimation of nonlinear parameters", J. SIAM
/// 11(2), 1963, who scales the damping by the diagonal). Rows can be redundant: a flat triangle mesh's rigid edges hold its
/// interior vertices twice over in its plane (a flat mesh with V vertices, B of them on its border, has 3V - 3 - B edges,
/// and its plane holds only 2V - 3 of them), a light body pinched between two sides is held twice, and contacts can ask for
/// what no motion gives (a particle between two surfaces closer than its thickness). The system is then singular. Rounding
/// of the rows' f32 directions leaves its right side a little off the range, and undamped, the multipliers grow without
/// bound along the motion that cancels itself. That motion is only cancelled to the rounding eps of f32: a kicked mesh flew
/// apart in five steps, and a 1 g box was thrown at 10 m/s. Damped, a multiplier is at most the row's violation over the
/// damping, and the motion rounding leaves is at most eps / damping of the violation: sqrt(eps) makes both sqrt(eps), about
/// 3e-4. It is also the geometric mean of the two sizes that fail (N. J. Higham, *Accuracy and Stability of Numerical
/// Algorithms*, 2002, section 10.3, on shifts of a semidefinite matrix): rounding itself is lost in the sum and a shift of
/// order one moves the answer. The rigid kernel's block solve shifts its contact matrix by the same amount, for the same
/// reason. A contact's row keeps this damping (a regularized contact: two contacts that ask for what no motion gives keep
/// asking however close the solve comes); an edge's or a link's is the worst violation squared, up to this (`solve_rigid`),
/// so it fades as the rows close and a row the solve can meet ends where the undamped solve ends (Levenberg, "A method for the solution of
/// certain non-linear problems in least squares", Q. Appl. Math. 2(2), 1944); `damping` makes that checkable. Regularized
/// contact rows keep bounded multipliers on sets with no answer: Lacoursiere, "Ghosts and machines: regularized variational
/// methods for interactive simulations of multibodies with dry frictional contacts", PhD thesis, Umea University, 2007,
/// chapter 5.
pub const ROW_DAMPING: f64 = 3.452669830012439e-4;
/// Particles a row holds: a bending element's six.
const PARTS: usize = crate::bend::BEND_PARTS;
/// Coefficients a row holds: its particles' three components each.
const CO: usize = 3 * PARTS;
/// Body coefficients a row holds: linear then angular.
const BJ: usize = 6;

fn sqrt64(x: f64) -> f64 {
    sqrt(x as f32) as f64
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `q v q*` in f64.
fn rotate64(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let u = [q[0], q[1], q[2]];
    let t = cross(u, v);
    let t = [2.0 * t[0], 2.0 * t[1], 2.0 * t[2]];
    let c = cross(u, t);
    [v[0] + q[3] * t[0] + c[0], v[1] + q[3] * t[1] + c[1], v[2] + q[3] * t[2] + c[2]]
}

/// A turn by the small rotation vector `w` composed onto `t`, made unit again (Mueller et al. 2020, equations 8 and 9), as
/// `World::correct_body` composes one.
fn compose(t: [f32; 4], w: [f32; 3]) -> [f32; 4] {
    let (x, y, z, s) = (t[0], t[1], t[2], t[3]);
    let (wx, wy, wz) = (w[0], w[1], w[2]);
    let nx = x + 0.5 * (s * wx + wy * z - wz * y);
    let ny = y + 0.5 * (s * wy + wz * x - wx * z);
    let nz = z + 0.5 * (s * wz + wx * y - wy * x);
    let ns = s - 0.5 * (wx * x + wy * y + wz * z);
    let len = sqrt(nx * nx + ny * ny + nz * nz + ns * ns);
    [nx / len, ny / len, nz / len, ns / len]
}

impl World {
    fn rigid_edge(&self, e: usize) -> bool {
        self.rg.tree[e] != 0 && self.eflags[e] & TORN == 0 && self.w[self.ea[e] as usize] + self.w[self.eb[e] as usize] > 0.0
    }

    /// Whether the exact solve holds edge `e` this piece (the sweep leaves it alone).
    pub(crate) fn held_exactly(&self, e: usize) -> bool {
        e < self.rg.tree.len() && self.rg.tree[e] != 0
    }

    /// A rigid edge, or a sheet's edge with a stiffness (a fabric thread of measured tensile stiffness, held in the system with
    /// its compliance): what the exact solve may hold.
    fn candidate(&self, e: usize) -> bool {
        let held = self.omega[e] == 0.0 || self.eflags[e] & (SHEET | STIFFNESS) == SHEET | STIFFNESS;
        held && self.eflags[e] & (TORN | BLOCK | OFF) == 0 && self.w[self.ea[e] as usize] + self.w[self.eb[e] as usize] > 0.0
    }

    /// An edge's compliance over the piece's length squared: 1 / (k h^2) for a sheet's edge of stiffness k (XPBD's
    /// alpha-tilde, Macklin, Mueller and Chentanez 2016), 0 for a rigid one.
    fn compliance(&self, e: usize, h: f32) -> f64 {
        if self.eflags[e] & STIFFNESS != 0 && self.omega[e] > 0.0 {
            1.0 / (self.omega[e] as f64 * h as f64 * h as f64)
        } else {
            0.0
        }
    }

    fn live_attachment(&self, a: usize) -> bool {
        self.at_row[a] != NONE && self.w[self.at_p[a] as usize] > 0.0
    }

    /// The pose of body row `c` at the end of this piece as the solve has it now: its centre carried by its velocity and moved
    /// by the piece's corrections, and its turn since the step began (`sq`, the piece's own turn included) and by the
    /// corrections (`tq`).
    fn pose(&self, c: usize, h: f32) -> ([f32; 3], [f32; 4], [f32; 3], [f32; 4]) {
        (
            [self.mx[c] + self.lvx[c] * h, self.my[c] + self.lvy[c] * h, self.mz[c] + self.lvz[c] * h],
            [self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]],
            [self.dmx[c], self.dmy[c], self.dmz[c]],
            [self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]],
        )
    }

    /// Body row `c`'s world inverse inertia now, its six distinct entries in f64: `R I0^-1 R^T`, R its turn since the step
    /// began and by this piece's corrections.
    fn inverse_inertia64(&self, c: usize) -> [f64; 6] {
        let q = |x: f32, y: f32, z: f32, w: f32| [x as f64, y as f64, z as f64, w as f64];
        let spin = q(self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]);
        let turn = q(self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]);
        let i0 = [
            [self.iixx[c] as f64, self.iixy[c] as f64, self.iixz[c] as f64],
            [self.iixy[c] as f64, self.iiyy[c] as f64, self.iiyz[c] as f64],
            [self.iixz[c] as f64, self.iiyz[c] as f64, self.iizz[c] as f64],
        ];
        // The columns of R I0^-1 R^T: the image of each axis, taken back to the step's start, through I0^-1, and forward again.
        let back = |v: [f64; 3]| {
            let v = rotate64([-turn[0], -turn[1], -turn[2], turn[3]], v);
            rotate64([-spin[0], -spin[1], -spin[2], spin[3]], v)
        };
        let forward = |v: [f64; 3]| rotate64(turn, rotate64(spin, v));
        let image = |axis: [f64; 3]| {
            let v = back(axis);
            forward([dot(i0[0], v), dot(i0[1], v), dot(i0[2], v)])
        };
        let (cx, cy, cz) = (image([1.0, 0.0, 0.0]), image([0.0, 1.0, 0.0]), image([0.0, 0.0, 1.0]));
        // Symmetric by construction; average the mirrored entries so rounding leaves it exactly so.
        [cx[0], 0.5 * (cx[1] + cy[0]), 0.5 * (cx[2] + cz[0]), cy[1], 0.5 * (cy[2] + cz[1]), cz[2]]
    }

    fn apply_ii(ii: &[f64], c: usize, v: [f64; 3]) -> [f64; 3] {
        let m = &ii[6 * c..6 * c + 6];
        [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[1] * v[0] + m[3] * v[1] + m[4] * v[2], m[2] * v[0] + m[4] * v[1] + m[5] * v[2]]
    }

    /// Marks the edges the exact solve holds: the rigid edges of a component with no loop (a rope, a tree of them), and a
    /// sheet's edges (`SHEET`: a grid of warp and weft, a triangle mesh), which have no redundant edge (Goldenthal et al. 2007). A rigid edge in a loop
    /// of anything else stays with the sweep: a sheet braced with both diagonals of every cell, say, holds more rigid edges
    /// than its particles can satisfy at once (a redundant framework), which no exact solve holds.
    fn find_held(&mut self) {
        let (ne, np) = (self.edges, self.particles);
        self.rg.tree.resize(ne);
        if self.rg.parent.len() < np {
            self.rg.parent.resize(np);
            self.rg.count.resize(np);
            self.rg.mark.resize(np);
        }
        for i in 0..np {
            self.rg.parent[i] = i as u32;
            self.rg.count[i] = 0;
            self.rg.mark[i] = 0;
        }
        // Components of rigid edges (union-find), then each one's edges and particles: a tree has one edge fewer.
        for e in 0..ne {
            if self.candidate(e) {
                let (a, b) = (self.root(self.ea[e]), self.root(self.eb[e]));
                if a != b {
                    self.rg.parent[a] = b as u32;
                }
            }
        }
        for e in 0..ne {
            if !self.candidate(e) {
                continue;
            }
            let r = self.root(self.ea[e]);
            // Edges count up, particles down, per component.
            self.rg.count[r] += 1;
            for end in [self.ea[e] as usize, self.eb[e] as usize] {
                if self.rg.mark[end] == 0 {
                    self.rg.mark[end] = 1;
                    let r = self.root(end as u32);
                    self.rg.count[r] -= 1;
                }
            }
        }
        for e in 0..ne {
            self.rg.tree[e] = 0;
            if self.candidate(e) {
                let r = self.root(self.ea[e]);
                if self.rg.count[r] < 0 || self.eflags[e] & SHEET != 0 {
                    self.rg.tree[e] = 1;
                }
            }
        }
    }

    fn root(&self, mut i: u32) -> usize {
        while self.rg.parent[i as usize] != i {
            i = self.rg.parent[i as usize];
        }
        i as usize
    }

    /// Starts a piece: which edges the solve holds, and every body's turn through to the piece's end (the turn its contacts and
    /// links are met with, as `apply_contacts` meets them).
    pub(crate) fn rigid_begin(&mut self, h: f32) {
        self.find_held();
        // The body each particle is linked to, if one (a particle linked to two keeps the first).
        let np = self.particles;
        if self.rg.linked.len() < np {
            self.rg.linked.resize(np);
        }
        for i in 0..np {
            self.rg.linked[i] = EMPTY;
        }
        for a in 0..self.attachments {
            if self.live_attachment(a) {
                let p = self.at_p[a] as usize;
                if self.rg.linked[p] == EMPTY {
                    self.rg.linked[p] = self.at_row[a] - 1;
                }
            }
        }
        for c in 0..self.colliders {
            let spun = self.spun(c, h);
            (self.sqx[c], self.sqy[c], self.sqz[c], self.sqw[c]) = (spun[0], spun[1], spun[2], spun[3]);
        }
    }

    /// One row: its kind and item, its particles and their coefficients, its body and the body's coefficients, its bound and
    /// its violation (the right-hand side is its negative).
    #[allow(clippy::too_many_arguments)]
    fn push_row(&mut self, kind: u32, item: usize, parts: &[(u32, [f64; 3])], body: u32, bj: [f64; 6], bounded: bool, c: f64) {
        let r = self.rg.rows;
        let grow = r + 1;
        for col in [&mut self.rg.kind, &mut self.rg.item, &mut self.rg.body, &mut self.rg.bounded] {
            if col.len() < grow {
                col.resize(grow);
            }
        }
        for col in [&mut self.rg.b, &mut self.rg.d, &mut self.rg.u, &mut self.rg.r, &mut self.rg.p, &mut self.rg.ap, &mut self.rg.g, &mut self.rg.cmp, &mut self.rg.lo, &mut self.rg.hi] {
            if col.len() < grow {
                col.resize(grow);
            }
        }
        if self.rg.pp.len() < grow * PARTS {
            self.rg.pp.resize(grow * PARTS);
        }
        if self.rg.co.len() < grow * CO {
            self.rg.co.resize(grow * CO);
        }
        if self.rg.bj.len() < grow * BJ {
            self.rg.bj.resize(grow * BJ);
        }
        self.rg.kind[r] = kind;
        self.rg.item[r] = item as u32;
        for k in 0..PARTS {
            self.rg.pp[r * PARTS + k] = if k < parts.len() { parts[k].0 } else { EMPTY };
        }
        for k in 0..PARTS {
            for j in 0..3 {
                self.rg.co[r * CO + 3 * k + j] = if k < parts.len() { parts[k].1[j] } else { 0.0 };
            }
        }
        self.rg.body[r] = body;
        for j in 0..BJ {
            self.rg.bj[r * BJ + j] = bj[j];
        }
        self.rg.bounded[r] = bounded as u32;
        self.rg.lo[r] = if bounded { 0.0 } else { f64::NEG_INFINITY };
        self.rg.hi[r] = f64::INFINITY;
        self.rg.b[r] = -c;
        self.rg.cmp[r] = 0.0;
        self.rg.rows = grow;
    }

    /// Builds the rows from the particles and the bodies as they stand (`build`), or only measures them: the worst row against
    /// its tolerance (1 is at it) and the sum of the squared violations (a contact counts only while it is too deep).
    fn rows_now(&mut self, h: f32, tau: f32, build: bool, alpha: f64) -> (f64, f64) {
        if build {
            self.rg.rows = 0;
            if self.rg.edge_row.len() < self.edges {
                self.rg.edge_row.resize(self.edges);
            }
            for e in 0..self.edges {
                self.rg.edge_row[e] = EMPTY;
            }
        }
        let (ne, na) = (self.edges, self.attachments);
        let (mut worst, mut merit) = (0.0f64, 0.0f64);
        let none = (EMPTY, [0.0; 3]);
        // Rigid edges. One whose two particles are both linked to one body is held by the body's rigidity already, and as a
        // row it would be a redundant constraint (no unique multipliers; Tournier et al., "Stable constrained dynamics", SIGGRAPH
        // 2015, section 2): left out.
        for e in 0..ne {
            if !self.rigid_edge(e) {
                continue;
            }
            let (a, b) = (self.ea[e] as usize, self.eb[e] as usize);
            if self.rg.linked.len() > a.max(b) && self.rg.linked[a] != EMPTY && self.rg.linked[a] == self.rg.linked[b] {
                continue;
            }
            let (dx, dy, dz) = ((self.x[a] - self.x[b]) as f64, (self.y[a] - self.y[b]) as f64, (self.z[a] - self.z[b]) as f64);
            let len = sqrt64(dx * dx + dy * dy + dz * dz);
            if len < 1e-9 {
                continue;
            }
            let rest = self.rest[e] as f64;
            let c = len - rest;
            if build && self.tear[e] > 0.0 && c > self.tear[e] as f64 * rest {
                self.eflags[e] |= TORN;
                self.torn += 1;
                continue;
            }
            if self.eflags[e] & TENSION != 0 && c <= 0.0 {
                // A rope that resists stretch only does not push: while slack it is out of the system.
                continue;
            }
            // A compliant edge's residual is its stretch plus its compliance times the multiplier it has taken this piece (the
            // spring's force, XPBD's C + alpha-tilde lambda); a rigid edge's is its stretch. A compliant edge stretched past its
            // limit (a fabric thread past its measured range) is held rigid at the limit (strain limiting: Provot, "Deformation
            // constraints in a mass-spring model to describe rigid cloth behavior", Graphics Interface 1995).
            let limit = self.elimit[e] as f64;
            let limited = limit > 0.0 && c > limit * rest;
            let cmp = if limited { 0.0 } else { self.compliance(e, h) };
            let mut taken = self.lambda[e] as f64;
            if !build && cmp > 0.0 && self.rg.edge_row[e] != EMPTY {
                taken += alpha * self.rg.u[self.rg.edge_row[e] as usize];
            }
            let res = if limited { c - limit * rest } else { c + cmp * taken };
            merit += res * res;
            let scale = if rest > 1e-3 { rest } else { 1e-3 };
            let m = (if res < 0.0 { -res } else { res }) / scale
                / if cmp == 0.0 && self.eflags[e] & SHEET != 0 { SHEET_STRAIN } else { TOLERANCE };
            if m > worst {
                worst = m;
            }
            if build {
                let n = [dx / len, dy / len, dz / len];
                self.rg.edge_row[e] = self.rg.rows as u32;
                self.push_row(EDGE, e, &[(a as u32, n), (b as u32, [-n[0], -n[1], -n[2]]), none, none], EMPTY, [0.0; 6], false, res);
                let r = self.rg.rows - 1;
                self.rg.cmp[r] = cmp;
            }
        }
        // Bending elements (bend.rs): each curvature component's R x along each axis, with its compliance over the piece's
        // length squared and the multiplier it has taken this piece, as a compliant edge's row (XPBD's C + alpha-tilde lambda).
        if build && self.rg.bend_row.len() < self.bends {
            self.rg.bend_row.resize(self.bends);
        }
        for s in 0..self.bends {
            if self.bd_flag[s] & crate::bend::BEND_BLOCK != 0 || !(self.bd_alpha[3 * s] > 0.0) {
                if build {
                    self.rg.bend_row[s] = EMPTY;
                }
                continue;
            }
            let moving = (0..PARTS).any(|j| {
                let p = self.bd_p[PARTS * s + j];
                p != crate::bend::BEND_NONE && self.w[p as usize] > 0.0
            });
            if !moving {
                if build {
                    self.rg.bend_row[s] = EMPTY;
                }
                continue;
            }
            if build {
                self.rg.bend_row[s] = self.rg.rows as u32;
            }
            for c in 0..3 {
                let (p, r) = self.bend_row(s, c);
                let value = self.bend_value(p, r);
                let cmp = self.bd_alpha[3 * s + c] as f64 / (h as f64 * h as f64);
                for axis in 0..3 {
                    let mut taken = self.bd_l[9 * s + 3 * c + axis] as f64;
                    if !build && self.rg.bend_row[s] != EMPTY {
                        taken += alpha * self.rg.u[self.rg.bend_row[s] as usize + 3 * c + axis];
                    }
                    let res = value[axis] + cmp * taken;
                    merit += res * res;
                    // R x is a curvature: held to a hundred thousandth of a radian over the element's size.
                    let m = (if res < 0.0 { -res } else { res }) * self.bd_len[s] as f64 / TOLERANCE;
                    if m > worst {
                        worst = m;
                    }
                    if build {
                        let mut parts = [(EMPTY, [0.0f64; 3]); PARTS];
                        for j in 0..PARTS {
                            if p[j] != crate::bend::BEND_NONE && self.w[p[j] as usize] > 0.0 {
                                parts[j].0 = p[j];
                                parts[j].1[axis] = r[j];
                            }
                        }
                        self.push_row(BEND, 9 * s + 3 * c + axis, &parts, EMPTY, [0.0; 6], false, res);
                        let row = self.rg.rows - 1;
                        self.rg.cmp[row] = cmp;
                    }
                }
            }
        }
        // Links: the particle at the body's point, along each axis.
        for a in 0..na {
            if !self.live_attachment(a) {
                continue;
            }
            let p = self.at_p[a] as usize;
            let c = (self.at_row[a] - 1) as usize;
            let (carried, spin, dm, turn) = self.pose(c, h);
            let lever0 = crate::world::rotate(spin, self.at_rx[a], self.at_ry[a], self.at_rz[a]);
            let lever = crate::world::rotate(turn, lever0.0, lever0.1, lever0.2);
            let q = [lever.0 as f64, lever.1 as f64, lever.2 as f64];
            let point = [
                (carried[0] + dm[0]) as f64 + q[0],
                (carried[1] + dm[1]) as f64 + q[1],
                (carried[2] + dm[2]) as f64 + q[2],
            ];
            let x = [self.x[p] as f64, self.y[p] as f64, self.z[p] as f64];
            for k in 0..3 {
                let gap = x[k] - point[k];
                merit += gap * gap;
                let m = (if gap < 0.0 { -gap } else { gap }) / TOLERANCE;
                if m > worst {
                    worst = m;
                }
                if build {
                    let axis = [if k == 0 { 1.0 } else { 0.0 }, if k == 1 { 1.0 } else { 0.0 }, if k == 2 { 1.0 } else { 0.0 }];
                    let ang = cross(q, axis);
                    self.push_row(LINK, 3 * a + k, &[(p as u32, axis), none, none, none], c as u32, [-axis[0], -axis[1], -axis[2], -ang[0], -ang[1], -ang[2]], false, gap);
                }
            }
        }
        // Contacts of particles with bodies, too deep: pushes, never pulls.
        for i in 0..self.particles {
            if self.w[i] <= 0.0 {
                continue;
            }
            for s in 0..SLOTS {
                let k = i * SLOTS + s;
                if self.kc[k] == NONE {
                    continue;
                }
                let c = (self.kc[k] - 1) as usize;
                // A body the soft body dominates is pushed by the contact passes, which give it the whole correction. A particle
                // linked to the body does not also touch it: the link holds it at a point of the body's surface, which a contact
                // would push it a radius away from, and no answer holds both. A body whose surface follows particles of this
                // world (another soft body's surface collider) is left to the contact passes too: its surface moves with
                // particles this solve also moves, which a row would hold still, so both sides would each take the whole
                // separation; and two surfaces that were one (the faces of a cut) meet at no distance, where the side each
                // point is on, and so the normal, is a matter of rounding, and contacts of one corner can push it both ways.
                // The passes push each side off the other in turn, as before.
                if self.dom[c] > 0.0 || self.bmesh[c] > 0.0 || self.rg.linked[i] == c as u32 {
                    continue;
                }
                let (carried, spin, dm, turn) = self.pose(c, h);
                let (n, q, gap) = self.meet(k, c, tau, carried, spin, dm, turn, [self.x[i], self.y[i], self.z[i]]);
                let depth = (gap - self.radius[i]) as f64;
                // Only a contact too deep, and one the host measured: a depth that is not a number (a contact found at no
                // distance, where no normal is defined) is no contact, as the contact passes take it.
                if !(depth < 0.0) {
                    continue;
                }
                merit += depth * depth;
                let m = -depth / TOLERANCE;
                if m > worst {
                    worst = m;
                }
                if build {
                    let n = [n[0] as f64, n[1] as f64, n[2] as f64];
                    let ang = cross([q[0] as f64, q[1] as f64, q[2] as f64], n);
                    self.push_row(CONTACT, k, &[(i as u32, n), none, none, none], c as u32, [-n[0], -n[1], -n[2], -ang[0], -ang[1], -ang[2]], true, depth);
                }
            }
        }
        // Contacts of faces with bodies: the triangle's point the sheet's thickness out of the body.
        for f in 0..self.faces {
            if self.fc_row[f] == NONE {
                continue;
            }
            let c = (self.fc_row[f] - 1) as usize;
            if self.dom[c] > 0.0 || self.bmesh[c] > 0.0 {
                continue;
            }
            let (carried, spin, dm, turn) = self.pose(c, h);
            let Some((corners, weights, n, q, gap)) = self.face_meet(f, c, tau, carried, spin, dm, turn) else { continue };
            // Nor does a triangle with a corner linked to the body, or one that nothing in the row can move (every corner pinned,
            // against a body that does not move), which no push would open.
            if corners.iter().any(|&k| self.rg.linked[k] == c as u32) || (corners.iter().all(|&k| self.w[k] <= 0.0) && self.wm[c] <= 0.0) {
                continue;
            }
            let depth = (gap - self.fc_r[f]) as f64;
            if !(depth < 0.0) {
                continue;
            }
            merit += depth * depth;
            let m = -depth / TOLERANCE;
            if m > worst {
                worst = m;
            }
            if build {
                let n = [n[0] as f64, n[1] as f64, n[2] as f64];
                let ang = cross([q[0] as f64, q[1] as f64, q[2] as f64], n);
                let part = |k: usize| {
                    let w = weights[k] as f64;
                    (if self.w[corners[k]] > 0.0 { corners[k] as u32 } else { EMPTY }, [w * n[0], w * n[1], w * n[2]])
                };
                let parts = [part(0), part(1), part(2), none];
                self.push_row(FACE, f, &parts, c as u32, [-n[0], -n[1], -n[2], -ang[0], -ang[1], -ang[2]], true, depth);
            }
        }
        (worst, merit)
    }

    /// `J^T v` into the particles' (`fx`, `fy`, `fz`) and the bodies' (`bf`) accumulators.
    fn spread(&mut self, v: &Col<f64>) {
        for i in 0..self.particles {
            self.rg.fx[i] = 0.0;
            self.rg.fy[i] = 0.0;
            self.rg.fz[i] = 0.0;
        }
        for j in 0..6 * self.colliders {
            self.rg.bf[j] = 0.0;
        }
        for r in 0..self.rg.rows {
            let s = v[r];
            if s == 0.0 {
                continue;
            }
            for (k, p) in (0..PARTS).map(|k| (k, self.rg.pp[r * PARTS + k])) {
                if p == EMPTY {
                    continue;
                }
                let p = p as usize;
                self.rg.fx[p] += self.rg.co[r * CO + 3 * k] * s;
                self.rg.fy[p] += self.rg.co[r * CO + 3 * k + 1] * s;
                self.rg.fz[p] += self.rg.co[r * CO + 3 * k + 2] * s;
            }
            let c = self.rg.body[r];
            if c != EMPTY {
                let c = c as usize;
                for j in 0..6 {
                    self.rg.bf[6 * c + j] += self.rg.bj[r * BJ + j] * s;
                }
            }
        }
    }

    /// The product of K with `v` into `out`: `J M^-1 J^T v`.
    fn multiply(&mut self, v: &Col<f64>, out: &mut Col<f64>) {
        self.spread(v);
        for r in 0..self.rg.rows {
            let mut sum = 0.0f64;
            for (k, p) in (0..PARTS).map(|k| (k, self.rg.pp[r * PARTS + k])) {
                if p == EMPTY {
                    continue;
                }
                let p = p as usize;
                let w = self.w[p] as f64;
                sum += w
                    * (self.rg.co[r * CO + 3 * k] * self.rg.fx[p]
                        + self.rg.co[r * CO + 3 * k + 1] * self.rg.fy[p]
                        + self.rg.co[r * CO + 3 * k + 2] * self.rg.fz[p]);
            }
            let c = self.rg.body[r];
            if c != EMPTY {
                let c = c as usize;
                let wm = self.wm[c] as f64;
                let bf = &self.rg.bf[6 * c..6 * c + 6];
                let lin = [bf[0], bf[1], bf[2]];
                let tor = World::apply_ii(&self.rg.ii, c, [bf[3], bf[4], bf[5]]);
                let bj = &self.rg.bj[r * BJ..r * BJ + 6];
                sum += wm * (bj[0] * lin[0] + bj[1] * lin[1] + bj[2] * lin[2]) + bj[3] * tor[0] + bj[4] * tor[1] + bj[5] * tor[2];
            }
            out[r] = sum + self.rg.cmp[r] * v[r];
        }
    }

    /// Each row's diagonal of K, and a bound on K's largest eigenvalue after scaling it to that diagonal (Gershgorin's bound
    /// on the matrix of absolute values: an upper bound, never less than the eigenvalue).
    fn diagonal(&mut self) -> f64 {
        let n = self.rg.rows;
        for r in 0..n {
            let mut sum = 0.0f64;
            for (k, p) in (0..PARTS).map(|k| (k, self.rg.pp[r * PARTS + k])) {
                if p == EMPTY {
                    continue;
                }
                let w = self.w[p as usize] as f64;
                let co = &self.rg.co[r * CO + 3 * k..r * CO + 3 * k + 3];
                sum += w * (co[0] * co[0] + co[1] * co[1] + co[2] * co[2]);
            }
            let c = self.rg.body[r];
            if c != EMPTY {
                let c = c as usize;
                let bj = [self.rg.bj[r * BJ], self.rg.bj[r * BJ + 1], self.rg.bj[r * BJ + 2]];
                let ba = [self.rg.bj[r * BJ + 3], self.rg.bj[r * BJ + 4], self.rg.bj[r * BJ + 5]];
                sum += self.wm[c] as f64 * dot(bj, bj) + dot(ba, World::apply_ii(&self.rg.ii, c, ba));
            }
            // Friction rows are bounded both ways, so their multipliers are bounded already. A contact keeps the whole
            // damping, a regularized contact (Lacoursiere 2007): two contacts that ask for what no motion gives keep asking
            // however close the solve comes. An edge's or a link's fades with the violation (`solve_rigid`).
            if self.rg.kind[r] != FRICTION && self.rg.cmp[r] == 0.0 {
                let kind = self.rg.kind[r];
                self.rg.cmp[r] = if kind == CONTACT || kind == FACE { self.rg.damping } else { self.rg.now } * sum;
            }
            let sum = sum + self.rg.cmp[r];
            self.rg.d[r] = if sum > 1e-300 { sum } else { 1.0 };
        }
        // |K| times the vector of 1 / sqrt(d), scaled by 1 / sqrt(d) again: the row sums of the scaled |K|.
        let mut v = core::mem::replace(&mut self.rg.ms, Col::new());
        let mut out = core::mem::replace(&mut self.rg.mt, Col::new());
        v.resize(n);
        out.resize(n);
        for r in 0..n {
            v[r] = 1.0 / sqrt64(self.rg.d[r]);
        }
        self.multiply_abs(&v, &mut out);
        let mut bound = 0.0f64;
        for r in 0..n {
            let s = out[r] * v[r];
            if s > bound {
                bound = s;
            }
        }
        self.rg.ms = v;
        self.rg.mt = out;
        if bound > 0.0 { bound } else { 1.0 }
    }

    /// The product of |J| |M^-1| |J|^T with a vector of non-negative entries: an entrywise upper bound of K times it.
    fn multiply_abs(&mut self, v: &Col<f64>, out: &mut Col<f64>) {
        let abs = |x: f64| if x < 0.0 { -x } else { x };
        for i in 0..self.particles {
            self.rg.fx[i] = 0.0;
            self.rg.fy[i] = 0.0;
            self.rg.fz[i] = 0.0;
        }
        for j in 0..6 * self.colliders {
            self.rg.bf[j] = 0.0;
        }
        for r in 0..self.rg.rows {
            for (k, p) in (0..PARTS).map(|k| (k, self.rg.pp[r * PARTS + k])) {
                if p == EMPTY {
                    continue;
                }
                let p = p as usize;
                self.rg.fx[p] += abs(self.rg.co[r * CO + 3 * k]) * v[r];
                self.rg.fy[p] += abs(self.rg.co[r * CO + 3 * k + 1]) * v[r];
                self.rg.fz[p] += abs(self.rg.co[r * CO + 3 * k + 2]) * v[r];
            }
            let c = self.rg.body[r];
            if c != EMPTY {
                for j in 0..6 {
                    self.rg.bf[6 * c as usize + j] += abs(self.rg.bj[r * BJ + j]) * v[r];
                }
            }
        }
        for r in 0..self.rg.rows {
            let mut sum = 0.0f64;
            for (k, p) in (0..PARTS).map(|k| (k, self.rg.pp[r * PARTS + k])) {
                if p == EMPTY {
                    continue;
                }
                let p = p as usize;
                let w = self.w[p] as f64;
                sum += w
                    * (abs(self.rg.co[r * CO + 3 * k]) * self.rg.fx[p]
                        + abs(self.rg.co[r * CO + 3 * k + 1]) * self.rg.fy[p]
                        + abs(self.rg.co[r * CO + 3 * k + 2]) * self.rg.fz[p]);
            }
            let c = self.rg.body[r];
            if c != EMPTY {
                let c = c as usize;
                let wm = self.wm[c] as f64;
                let m = &self.rg.ii[6 * c..6 * c + 6];
                let full = [[abs(m[0]), abs(m[1]), abs(m[2])], [abs(m[1]), abs(m[3]), abs(m[4])], [abs(m[2]), abs(m[4]), abs(m[5])]];
                let bf = &self.rg.bf[6 * c..6 * c + 6];
                let tor = [dot(full[0], [bf[3], bf[4], bf[5]]), dot(full[1], [bf[3], bf[4], bf[5]]), dot(full[2], [bf[3], bf[4], bf[5]])];
                let bj = &self.rg.bj[r * BJ..r * BJ + 6];
                sum += wm * (abs(bj[0]) * bf[0] + abs(bj[1]) * bf[1] + abs(bj[2]) * bf[2])
                    + abs(bj[3]) * tor[0]
                    + abs(bj[4]) * tor[1]
                    + abs(bj[5]) * tor[2];
            }
            out[r] = sum + self.rg.cmp[r] * v[r];
        }
    }

    /// Solves K u = b with u >= 0 on the bounded rows, by MPRGP (Dostal and Schoberl 2005) on the system scaled to a unit
    /// diagonal: conjugate gradient steps on the rows off their bounds while the gradient pushing a bounded row off its bound
    /// is the smaller (proportional), expansion steps of the projected gradient when a step would cross a bound, and
    /// proportioning steps that free a bound row when its push dominates. With no bounded row it is the conjugate gradient
    /// method, which ends within n steps (Hestenes and Stiefel 1952); with bounds it ends in finitely many (ibid., Dostal and
    /// Schoberl), and 4 n is a guard that a converging solve does not reach.
    fn mprgp(&mut self, bound: f64) {
        let n = self.rg.rows;
        // Scaled unknowns y = sqrt(d) u, matrix D^-1/2 K D^-1/2, right side D^-1/2 b; bounds stay at zero.
        let mut s = core::mem::replace(&mut self.rg.ms, Col::new());
        let mut y = core::mem::replace(&mut self.rg.my, Col::new());
        let mut g = core::mem::replace(&mut self.rg.mg, Col::new());
        let mut p = core::mem::replace(&mut self.rg.mp, Col::new());
        let mut ap = core::mem::replace(&mut self.rg.map, Col::new());
        let mut dvec = core::mem::replace(&mut self.rg.md, Col::new());
        let mut tmp = core::mem::replace(&mut self.rg.mt, Col::new());
        for col in [&mut s, &mut y, &mut g, &mut p, &mut ap, &mut dvec, &mut tmp] {
            col.resize(n);
        }
        for r in 0..n {
            s[r] = 1.0 / sqrt64(self.rg.d[r]);
            y[r] = 0.0;
        }
        let product = |world: &mut World, y: &Col<f64>, out: &mut Col<f64>, s: &Col<f64>, v: &mut Col<f64>| {
            for r in 0..n {
                v[r] = y[r] * s[r];
            }
            world.multiply(v, out);
            for r in 0..n {
                out[r] *= s[r];
            }
        };
        let mut scale = 0.0f64;
        for r in 0..n {
            let rhs = self.rg.b[r] * s[r];
            // g = A y - rhs with y = 0.
            g[r] = -rhs;
            let m = if rhs < 0.0 { -rhs } else { rhs };
            if m > scale {
                scale = m;
            }
        }
        // The bounds in the scaled unknowns: [lo, hi] times sqrt(d).
        let low = |world: &World, s: &Col<f64>, r: usize| world.rg.lo[r] / s[r];
        let high = |world: &World, s: &Col<f64>, r: usize| world.rg.hi[r] / s[r];
        // Free gradient phi (zero on a row at a bound) and chopped gradient beta (on a row at a bound, the part that would push
        // it off: min(g, 0) at its lower bound, max(g, 0) at its upper).
        let phi = |world: &World, y: &Col<f64>, g: &Col<f64>, r: usize| {
            if y[r] <= low(world, &s, r) || y[r] >= high(world, &s, r) { 0.0 } else { g[r] }
        };
        // A row with no room between its bounds (a friction row of a contact with no push) is never freed.
        let beta = |world: &World, y: &Col<f64>, g: &Col<f64>, r: usize| {
            if !(low(world, &s, r) < high(world, &s, r)) {
                0.0
            } else if y[r] <= low(world, &s, r) && g[r] < 0.0 {
                g[r]
            } else if y[r] >= high(world, &s, r) && g[r] > 0.0 {
                g[r]
            } else {
                0.0
            }
        };
        for r in 0..n {
            p[r] = phi(self, &y, &g, r);
        }
        let stop = 1e-5 * scale + 1e-12;
        let alpha_bar = 1.0 / bound;
        let guard = 4 * n + 4;
        for _ in 0..guard {
            let (mut free2, mut chop2, mut worst) = (0.0f64, 0.0f64, 0.0f64);
            for r in 0..n {
                let f = phi(self, &y, &g, r);
                let b = beta(self, &y, &g, r);
                free2 += f * f;
                chop2 += b * b;
                let m = { let v = f + b; if v < 0.0 { -v } else { v } };
                if m > worst {
                    worst = m;
                }
            }
            if worst <= stop {
                break;
            }
            if chop2 <= PROPORTION * PROPORTION * free2 {
                // A conjugate gradient step, as far as the bounds allow.
                product(self, &p, &mut ap, &s, &mut tmp);
                let mut pap = 0.0f64;
                let mut gp = 0.0f64;
                for r in 0..n {
                    pap += p[r] * ap[r];
                    gp += g[r] * p[r];
                }
                if !(pap > 0.0) {
                    break;
                }
                let acg = gp / pap;
                // The longest step along -p that keeps every row within its bounds.
                let mut afeas = f64::MAX;
                for r in 0..n {
                    let a = if p[r] > 0.0 {
                        (y[r] - low(self, &s, r)) / p[r]
                    } else if p[r] < 0.0 {
                        (y[r] - high(self, &s, r)) / p[r]
                    } else {
                        f64::MAX
                    };
                    if a < afeas {
                        afeas = a;
                    }
                }
                if acg <= afeas {
                    for r in 0..n {
                        y[r] -= acg * p[r];
                        g[r] -= acg * ap[r];
                    }
                    let mut num = 0.0f64;
                    for r in 0..n {
                        num += phi(self, &y, &g, r) * ap[r];
                    }
                    let beta_cg = num / pap;
                    for r in 0..n {
                        p[r] = phi(self, &y, &g, r) - beta_cg * p[r];
                    }
                } else {
                    // Expansion: to the bound, then a projected step of the free gradient, the fixed length 1 / ||A||.
                    for r in 0..n {
                        y[r] -= afeas * p[r];
                        g[r] -= afeas * ap[r];
                    }
                    for r in 0..n {
                        let f = phi(self, &y, &g, r);
                        let v = y[r] - alpha_bar * f;
                        let (l, u) = (low(self, &s, r), high(self, &s, r));
                        y[r] = if v < l { l } else if v > u { u } else { v };
                    }
                    product(self, &y, &mut g, &s, &mut tmp);
                    for r in 0..n {
                        g[r] -= self.rg.b[r] * s[r];
                    }
                    for r in 0..n {
                        p[r] = phi(self, &y, &g, r);
                    }
                }
            } else {
                // Proportioning: free the bound rows whose push dominates, along the chopped gradient.
                for r in 0..n {
                    dvec[r] = beta(self, &y, &g, r);
                }
                product(self, &dvec, &mut ap, &s, &mut tmp);
                let (mut num, mut den) = (0.0f64, 0.0f64);
                for r in 0..n {
                    num += g[r] * dvec[r];
                    den += dvec[r] * ap[r];
                }
                if !(den > 0.0) {
                    break;
                }
                // As far as the other bound of each freed row allows: a friction row is bounded both ways, and a step past
                // its far bound would hold more than Coulomb's limit.
                let mut a = num / den;
                for r in 0..n {
                    let far = if dvec[r] < 0.0 {
                        (y[r] - high(self, &s, r)) / dvec[r]
                    } else if dvec[r] > 0.0 {
                        (y[r] - low(self, &s, r)) / dvec[r]
                    } else {
                        f64::MAX
                    };
                    if far < a {
                        a = far;
                    }
                }
                for r in 0..n {
                    y[r] -= a * dvec[r];
                    g[r] -= a * ap[r];
                }
                for r in 0..n {
                    p[r] = phi(self, &y, &g, r);
                }
            }
        }
        for r in 0..n {
            self.rg.u[r] = y[r] * s[r];
        }
        self.rg.ms = s;
        self.rg.my = y;
        self.rg.mg = g;
        self.rg.mp = p;
        self.rg.map = ap;
        self.rg.md = dvec;
        self.rg.mt = tmp;
    }

    /// Moves the particles and the bodies by `alpha` times the solve's answer: the particles by `alpha W J^T u`, each body by
    /// its share of `alpha M^-1 J^T u` (its centre, and a turn composed onto its correction).
    fn step_by(&mut self, alpha: f64) {
        let u = core::mem::replace(&mut self.rg.u, Col::new());
        self.spread(&u);
        self.rg.u = u;
        for i in 0..self.particles {
            let w = self.w[i] as f64 * alpha;
            if w == 0.0 {
                continue;
            }
            self.x[i] += (w * self.rg.fx[i]) as f32;
            self.y[i] += (w * self.rg.fy[i]) as f32;
            self.z[i] += (w * self.rg.fz[i]) as f32;
        }
        for c in 0..self.colliders {
            let bf = [self.rg.bf[6 * c], self.rg.bf[6 * c + 1], self.rg.bf[6 * c + 2], self.rg.bf[6 * c + 3], self.rg.bf[6 * c + 4], self.rg.bf[6 * c + 5]];
            if bf.iter().all(|&v| v == 0.0) {
                continue;
            }
            let wm = self.wm[c] as f64 * alpha;
            self.dmx[c] += (wm * bf[0]) as f32;
            self.dmy[c] += (wm * bf[1]) as f32;
            self.dmz[c] += (wm * bf[2]) as f32;
            let w = World::apply_ii(&self.rg.ii, c, [bf[3], bf[4], bf[5]]);
            let w = [(alpha * w[0]) as f32, (alpha * w[1]) as f32, (alpha * w[2]) as f32];
            if w != [0.0, 0.0, 0.0] {
                let t = compose([self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]], w);
                (self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]) = (t[0], t[1], t[2], t[3]);
            }
        }
    }

    fn save(&mut self) {
        let np = self.particles;
        for col in [&mut self.rg.sx, &mut self.rg.sy, &mut self.rg.sz] {
            if col.len() < np {
                col.resize(np);
            }
        }
        for i in 0..np {
            self.rg.sx[i] = self.x[i];
            self.rg.sy[i] = self.y[i];
            self.rg.sz[i] = self.z[i];
        }
        let nc = self.colliders;
        if self.rg.saved.len() < 7 * nc {
            self.rg.saved.resize(7 * nc);
        }
        for c in 0..nc {
            let s = [self.dmx[c], self.dmy[c], self.dmz[c], self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]];
            for j in 0..7 {
                self.rg.saved[7 * c + j] = s[j];
            }
        }
    }

    fn restore(&mut self) {
        for i in 0..self.particles {
            self.x[i] = self.rg.sx[i];
            self.y[i] = self.rg.sy[i];
            self.z[i] = self.rg.sz[i];
        }
        for c in 0..self.colliders {
            let s = &self.rg.saved[7 * c..7 * c + 7];
            (self.dmx[c], self.dmy[c], self.dmz[c]) = (s[0], s[1], s[2]);
            (self.tqx[c], self.tqy[c], self.tqz[c], self.tqw[c]) = (s[3], s[4], s[5], s[6]);
        }
    }

    /// Takes the largest part of the Newton step that lowers the summed squared violation by Armijo's sufficient decrease,
    /// halving from the whole step (Nocedal and Wright 2006, section 3.1): a heavy load bends the rows far within a step, and
    /// whole steps there overshoot and cycle. The step is made, measured and undone until one passes. The fraction taken, or
    /// 0 when no step the positions can hold (in f32) lowers it: the solve is as close as it can come.
    fn line_search(&mut self, h: f32, tau: f32, f0: f64) -> f64 {
        // The largest move of the whole step, and the smallest a position held in f32 can make.
        let u = core::mem::replace(&mut self.rg.u, Col::new());
        self.spread(&u);
        self.rg.u = u;
        let (mut most, mut size) = (0.0f64, 1.0f64);
        for i in 0..self.particles {
            let w = self.w[i] as f64;
            for (d, x) in [(self.rg.fx[i], self.x[i]), (self.rg.fy[i], self.y[i]), (self.rg.fz[i], self.z[i])] {
                let m = if w * d < 0.0 { -w * d } else { w * d };
                if m > most {
                    most = m;
                }
                let x = if x < 0.0 { -x as f64 } else { x as f64 };
                if x > size {
                    size = x;
                }
            }
        }
        for c in 0..self.colliders {
            let wm = self.wm[c] as f64;
            for j in 0..3 {
                let m = wm * self.rg.bf[6 * c + j];
                let m = if m < 0.0 { -m } else { m };
                if m > most {
                    most = m;
                }
            }
        }
        let floor = size * f32::EPSILON as f64;
        self.save();
        let mut alpha = 1.0f64;
        while alpha * most > floor {
            self.step_by(alpha);
            let (_, f) = self.rows_now(h, tau, false, alpha);
            if f <= (1.0 - 2.0 * ARMIJO * alpha) * f0 {
                return alpha;
            }
            self.restore();
            alpha *= 0.5;
        }
        0.0
    }

    /// What the rows took in a step of `alpha` of the answer: a rigid edge's load and each contact's push (for the velocity
    /// pass's friction and restitution) row by row, and each body's impulse (for the rigid world) as the body's part of
    /// `J^T alpha u` summed in f64 before it is rounded: rows that hold a body redundantly (links of particles a rigid edge
    /// also joins) carry large multipliers that cancel, which rounding one row at a time would not.
    fn book(&mut self, alpha: f64, h: f32) {
        let inv = 1.0 / h as f64;
        for r in 0..self.rg.rows {
            let lam = alpha * self.rg.u[r];
            if lam == 0.0 {
                continue;
            }
            let item = self.rg.item[r] as usize;
            match self.rg.kind[r] {
                EDGE => self.lambda[item] += lam as f32,
                BEND => self.bd_l[item] += lam as f32,
                CONTACT => self.kj[item] += (lam * inv) as f32,
                FACE => self.fc_j[item] += (lam * inv) as f32,
                _ => {}
            }
        }
        let u = core::mem::replace(&mut self.rg.u, Col::new());
        self.spread(&u);
        self.rg.u = u;
        let k = alpha * inv;
        for j in 0..6 * self.colliders {
            self.rg.owed[j] += self.rg.bf[j] * k;
        }
    }

    /// Holds every rigid edge, link and contact at once, exactly (see the header).
    /// Each body's world inverse inertia, in f64, as it is turned now.
    fn inverse_inertias(&mut self) {
        for c in 0..self.colliders {
            let ii = self.inverse_inertia64(c);
            for j in 0..6 {
                self.rg.ii[6 * c + j] = ii[j];
            }
        }
    }

    pub(crate) fn solve_rigid(&mut self, h: f32) {
        let (np, nc) = (self.particles, self.colliders);
        for col in [&mut self.rg.fx, &mut self.rg.fy, &mut self.rg.fz] {
            if col.len() < np {
                col.resize(np);
            }
        }
        if self.rg.bf.len() < 6 * nc {
            self.rg.bf.resize(6 * nc);
        }
        if self.rg.ii.len() < 6 * nc {
            self.rg.ii.resize(6 * nc);
        }
        if self.rg.owed.len() < 6 * nc {
            self.rg.owed.resize(6 * nc);
        }
        for j in 0..6 * nc {
            self.rg.owed[j] = 0.0;
        }
        self.pieces += 1;
        let tau = h * self.pieces as f32;
        loop {
            let (worst, merit) = self.rows_now(h, tau, true, 0.0);
            if self.rg.rows == 0 || worst <= 1.0 {
                break;
            }
            self.inverse_inertias();
            // The damping fades with the worst violation, as a fraction (Yamashita and Fukushima, "On the rate of convergence
            // of the Levenberg-Marquardt method", Computing Suppl. 15, 2001, and Fan and Yuan, "On the quadratic convergence
            // of the Levenberg-Marquardt method without nonsingularity assumption", Computing 74, 2005: a damping of the
            // residual squared keeps Newton's quadratic convergence, singular rows and all). Near the answer the steps are
            // Newton's and land on it, so a well-posed solve ends where the undamped one does; a set with no answer keeps
            // its violation, and so its damping.
            let violation = worst * TOLERANCE;
            self.rg.now = self.rg.damping.min(violation * violation);
            let bound = self.diagonal();
            self.mprgp(bound);
            let alpha = self.line_search(h, tau, merit);
            if alpha == 0.0 {
                break;
            }
            self.book(alpha, h);
        }
        self.friction_solve(h, tau);
        for c in 0..nc {
            let o = &self.rg.owed[6 * c..6 * c + 6];
            self.jx[c] += o[0] as f32;
            self.jy[c] += o[1] as f32;
            self.jz[c] += o[2] as f32;
            self.kx[c] += o[3] as f32;
            self.ky[c] += o[4] as f32;
            self.kz[c] += o[5] as f32;
        }
    }

    /// Two friction rows across each contact the solve pushed this piece, along the slide and across it: the move that undoes
    /// the particle's (or the face's) slide over the body's surface, its multiplier within the coefficient times the contact's
    /// push either way (a four-sided pyramid of the friction cone), on the particles and the bodies.
    #[allow(clippy::too_many_arguments)]
    fn push_friction(&mut self, kind_item: usize, parts: [(u32, [f64; 3]); 3], c: usize, q: [f32; 3], n: [f32; 3], slip: [f32; 3], limit: f64) {
        let n = [n[0] as f64, n[1] as f64, n[2] as f64];
        let s = [slip[0] as f64, slip[1] as f64, slip[2] as f64];
        let sn = dot(s, n);
        let st = [s[0] - n[0] * sn, s[1] - n[1] * sn, s[2] - n[2] * sn];
        let len = sqrt64(dot(st, st));
        // Along the slide, or any direction in the plane when there is none, and the one across it.
        let t1 = if len > 1e-12 {
            [st[0] / len, st[1] / len, st[2] / len]
        } else {
            let a = if n[0] * n[0] < 0.5 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
            let t = cross(n, a);
            let l = sqrt64(dot(t, t));
            [t[0] / l, t[1] / l, t[2] / l]
        };
        let t2 = cross(n, t1);
        let qf = [q[0] as f64, q[1] as f64, q[2] as f64];
        for t in [t1, t2] {
            let scaled = |part: (u32, [f64; 3])| {
                let w = part.1[0] * n[0] + part.1[1] * n[1] + part.1[2] * n[2];
                (part.0, [w * t[0], w * t[1], w * t[2]])
            };
            let ang = cross(qf, t);
            self.push_row(FRICTION, kind_item, &[scaled(parts[0]), scaled(parts[1]), scaled(parts[2]), (EMPTY, [0.0; 3])], c as u32, [-t[0], -t[1], -t[2], -ang[0], -ang[1], -ang[2]], false, dot(s, t));
            let r = self.rg.rows - 1;
            self.rg.lo[r] = -limit;
            self.rg.hi[r] = limit;
        }
    }

    /// Friction as its own bounded solve after the contacts' (staggered projections: Kaufman, Sueda, James and Pai, "Staggered
    /// projections for frictional contact in multibody systems", SIGGRAPH Asia 2008, who alternate the normal and the friction
    /// problems): the rows the solve holds exactly (edges, links) as they stand, and two friction rows per contact it pushed,
    /// each within the coefficient times that contact's push this piece (Coulomb's |lambda_t| <= mu lambda_n). Solved together,
    /// a particle resists sliding with the stiffness of the sheet it belongs to, not its own mass alone, and the body takes its
    /// part, so a box on a cloth is held below its friction angle and slides above it. The velocity pass then leaves friction
    /// alone: counting it there as well would hold a contact at twice its coefficient.
    fn friction_solve(&mut self, h: f32, tau: f32) {
        let (worst, _) = self.rows_now(h, tau, true, 0.0);
        self.inverse_inertias();
        let violation = worst * TOLERANCE;
        self.rg.now = self.rg.damping.min(violation * violation);
        let held = self.rg.rows;
        // The rows the normal solve held stay as they stand: no right side of their own (their residuals are the normal
        // solve's to close), so only the slides move anything. A residual there, on rows that hold the same motion twice,
        // would leave the problem without a lowest point and the solve running off along it.
        for r in 0..held {
            self.rg.b[r] = 0.0;
        }
        let none = (EMPTY, [0.0; 3]);
        for i in 0..self.particles {
            let wp = self.w[i];
            if wp <= 0.0 {
                continue;
            }
            for slot in 0..SLOTS {
                let k = i * SLOTS + slot;
                if self.kc[k] == NONE || self.kj[k] <= 0.0 {
                    continue;
                }
                let c = (self.kc[k] - 1) as usize;
                if self.dom[c] > 0.0 || self.bmesh[c] > 0.0 || self.rg.linked[i] == c as u32 {
                    continue;
                }
                let (carried, spin, dm, turn) = self.pose(c, h);
                let (n, q, gap) = self.meet(k, c, tau, carried, spin, dm, turn, [self.x[i], self.y[i], self.z[i]]);
                if gap - self.radius[i] > 1e-4 {
                    continue;
                }
                let surface = self.surface_velocity(c, q, [self.kpx[k], self.kpy[k], self.kpz[k]], [self.kvx[k], self.kvy[k], self.kvz[k]]);
                let slip = [self.x[i] - self.px[i] - surface[0] * h, self.y[i] - self.py[i] - surface[1] * h, self.z[i] - self.pz[i] - surface[2] * h];
                let limit = self.kf[k] as f64 * self.kj[k] as f64 * h as f64;
                let nn = [n[0] as f64, n[1] as f64, n[2] as f64];
                self.push_friction(k, [(i as u32, nn), none, none], c, q, n, slip, limit);
            }
        }
        for f in 0..self.faces {
            if self.fc_row[f] == NONE || self.fc_j[f] <= 0.0 {
                continue;
            }
            let c = (self.fc_row[f] - 1) as usize;
            if self.dom[c] > 0.0 || self.bmesh[c] > 0.0 {
                continue;
            }
            let (carried, spin, dm, turn) = self.pose(c, h);
            let Some((corners, weights, n, q, gap)) = self.face_meet(f, c, tau, carried, spin, dm, turn) else { continue };
            if gap - self.fc_r[f] > 1e-4 || corners.iter().any(|&k| self.rg.linked[k] == c as u32) {
                continue;
            }
            let now = self.face_point(corners, weights);
            let mut before = [0.0f32; 3];
            for k in 0..3 {
                let i = corners[k];
                before[0] += weights[k] * self.px[i];
                before[1] += weights[k] * self.py[i];
                before[2] += weights[k] * self.pz[i];
            }
            let surface = self.surface_velocity(c, q, [self.fc_px[f], self.fc_py[f], self.fc_pz[f]], [self.fc_vx[f], self.fc_vy[f], self.fc_vz[f]]);
            let slip = [now[0] - before[0] - surface[0] * h, now[1] - before[1] - surface[1] * h, now[2] - before[2] - surface[2] * h];
            let limit = self.fc_f[f] as f64 * self.fc_j[f] as f64 * h as f64;
            let nn = [n[0] as f64, n[1] as f64, n[2] as f64];
            let part = |k: usize| {
                let w = weights[k] as f64;
                (if self.w[corners[k]] > 0.0 { corners[k] as u32 } else { EMPTY }, [w * nn[0], w * nn[1], w * nn[2]])
            };
            let parts = [part(0), part(1), part(2)];
            self.push_friction(f, parts, c, q, n, slip, limit);
        }
        if self.rg.rows == held {
            return;
        }
        let bound = self.diagonal();
        self.mprgp(bound);
        self.step_by(1.0);
        self.book(1.0, h);
    }
}
