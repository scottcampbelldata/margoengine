// Mechanisms that tie the motion of two bodies together without a joint between them: a gear, a rack and pinion and a pulley.
// Each is one row of the solve, a speed Cdot = sum of (a direction times a body's linear or angular speed) that must stay zero,
// solved in every substep next to the joint pass with the sequential impulses the joints and contacts use: the impulse a row
// has given is carried from one substep to the next (the warm start), a biased pass shares out the error the row has built up, and
// a soft row takes the form of Catto, "Soft Constraints", GDC 2011 (a frequency and a damping ratio). Every row's error is read from
// the poses, so float rounding of the poses cannot build up against it: a gear's from each body's turn about its axis since the row
// began, counted past one turn (the twist of swing-twist, Dobrowolski 2015), a rack's from that and the rack's travel along its axis,
// a pulley's from the length of its rope. The error then closes a share a substep, Baumgarte 1972's position term in the velocity
// row, as the joints' position-level rows do; Box2D's gear joint reads its error from its joints' coordinates the same way (Catto,
// "Modeling and Solving Constraints", GDC 2009). An error made by summing the row's speed drifted: a rack 0.5 m from the origin
// fell 0.35 mm behind in ten turns, a sign that changed with the step (KB-PHYS-COUPLINGDRIFT1). Baraff, "Linear-Time
// Dynamics using Lagrange Multipliers", SIGGRAPH 1996, is the form of a row between two bodies' coordinates. The table is a fixed one
// in the header, so a snapshot carries it.
use crate::layout::*;
use crate::math::*;
use crate::solver::Moving;
use crate::world::{NONE, World};

/// Most couplings a world holds.
pub const MAX_COUPLINGS: u32 = 1 << 20;

/// What a coupling is.
pub const GEAR: u32 = 1;
pub const RACK_AND_PINION: u32 = 2;
pub const PULLEY: u32 = 3;
/// Two anchors that keep a distance within a range: `ratio` is the least, `total` the greatest (0 for no greatest).
pub const DISTANCE: u32 = 4;
/// A body held to a curve fixed on another: a Catmull-Rom spline through any number of points (in A's frame), open or closed, with a
/// motor along it. The points live in a shared column, a range each, with an index of boxes over its spans.
pub const PATH: u32 = 5;
/// Two joint coordinates held together: side A is a hinge angle or a slide of the body `a` against its parent, side B the same for
/// `b` against its parent, and the rate of A plus `ratio` times the rate of B stays zero (Baraff, "Linear-Time Dynamics using Lagrange
/// Multipliers", SIGGRAPH 1996, a row between two joints' coordinates). The row's own fields: `a` and `b` the children, `path` and
/// `count` their parents, `cap` the sides' kinds (bit 0 set: A slides, bit 1: B slides; clear: it turns), `axis_a` and `axis_b` the axis
/// in each child's frame. A hinge's rate is the axis dotted with the child's turn less the parent's; a slide's, the axis dotted with the
/// child's centre's velocity in the parent's frame (less the parent's velocity and its turn about the child's centre). The row's effective inverse mass is the speed the unit impulse gives it, which holds for
/// two sides that share a parent, where a sum of each side's own would not.
pub const COORDS: u32 = 6;
/// Most points of a path.
pub const MAX_PATH_POINTS: u32 = 1 << 20;
/// Most words of the path column.
const MAX_PATH_WORDS: u32 = 1 << 26;
/// Spans a block of the index covers.
const BLOCK: usize = 16;

/// Words of a path range of `cap` points: the points, a box (six numbers) for each span, and a box for each block of spans.
#[inline]
fn path_words(cap: u32) -> u32 {
    9 * cap + 6 * (cap / BLOCK as u32 + 1)
}

/// One coupling: bodies `a` and `b`, directions in their own frames, and the row's memory. A free slot has kind 0.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Coupling {
    pub kind: u32,
    pub a: u32,
    pub b: u32,
    /// A gear turns about `axis_a` of A and `axis_b` of B; a rack and pinion about `axis_a` of the pinion A and along `axis_b` of the rack B.
    pub axis_a: [f32; 3],
    pub axis_b: [f32; 3],
    /// A pulley's rope ties at `anchor_a` of A and `anchor_b` of B (their own frames) and runs over `ground_a` and `ground_b` (world).
    pub anchor_a: [f32; 3],
    pub anchor_b: [f32; 3],
    pub ground_a: [f32; 3],
    pub ground_b: [f32; 3],
    /// A gear's ratio, a pinion's radius, a pulley's ratio of the second length to the first.
    pub ratio: f32,
    /// The rope's length sum a pulley keeps.
    pub total: f32,
    /// Soft constraint: a frequency in hertz (0 is rigid) and a damping ratio; the share of the error a rigid row closes a step.
    pub hertz: f32,
    pub zeta: f32,
    pub correction: f32,
    /// The error of the combination, and the impulse the row has given.
    pub error: f32,
    pub impulse: f32,
    /// A path: where its range starts in the path column (words), how many points it holds and has room for, whether it closes on
    /// itself, how many points the index was built for (it is rebuilt when they change) and the span the follower was nearest last,
    /// where the next search starts.
    pub path: u32,
    pub count: u32,
    pub cap: u32,
    pub closed: u32,
    pub indexed: u32,
    pub last_span: u32,
    /// The impulses of a path's two normal rows beside `impulse` (the motor's), and the motor's speed along the path and the most
    /// force it may use (0 for no motor).
    pub impulse_n1: f32,
    pub impulse_n2: f32,
    pub motor_speed: f32,
    pub motor_force: f32,
}

impl Coupling {
    // A COORDS coupling keeps its parents and the kinds of its sides in the words a PATH keeps its range in (`path`, `count`, `cap`), which
    // a coordinates row has no use for: the layout of the table, and so every hash on file, stays as it was. These views are the only
    // place that reuse is spelt out; nothing else may read those three words of a COORDS row as a path.
    /// The parent of the first side's child.
    #[inline]
    pub fn coords_parent_a(&self) -> u32 {
        self.path
    }
    /// The parent of the second side's child.
    #[inline]
    pub fn coords_parent_b(&self) -> u32 {
        self.count
    }
    /// Whether the first side slides (otherwise it turns).
    #[inline]
    pub fn coords_slides_a(&self) -> bool {
        self.cap & 1 != 0
    }
    /// Whether the second side slides (otherwise it turns).
    #[inline]
    pub fn coords_slides_b(&self) -> bool {
        self.cap & 2 != 0
    }
    /// Sets the two parents and which sides slide (bit 0 the first, bit 1 the second).
    #[inline]
    pub fn set_coords(&mut self, parent_a: u32, parent_b: u32, slides: u32) {
        self.path = parent_a;
        self.count = parent_b;
        self.cap = slides & 3;
    }

    // A gear and a rack keep where they began in words their kinds have no other use for, as COORDS does above: the turn A began
    // at (`anchor_a`, `ground_a[0]` its w), a gear's B the same (`anchor_b`, `ground_a[1]`) and a rack's starting centre
    // (`anchor_b`), the angle each body read last (`ground_b`), the whole turns since (`closed` for A, `last_span` for B, as
    // i32), and `indexed` set once they are read. These views are the only place that reuse is spelt out.
    /// Whether a gear's or a rack's start has been read.
    #[inline]
    fn begun(&self) -> bool {
        self.indexed != 0
    }
    /// The turn A began at.
    #[inline]
    fn start_a(&self) -> Q {
        Q { x: self.anchor_a[0], y: self.anchor_a[1], z: self.anchor_a[2], w: self.ground_a[0] }
    }
    /// The turn a gear's B began at.
    #[inline]
    fn start_b(&self) -> Q {
        Q { x: self.anchor_b[0], y: self.anchor_b[1], z: self.anchor_b[2], w: self.ground_a[1] }
    }

    pub const NONE: Coupling = Coupling {
        kind: 0,
        a: NONE,
        b: NONE,
        axis_a: [0.0; 3],
        axis_b: [0.0; 3],
        anchor_a: [0.0; 3],
        anchor_b: [0.0; 3],
        ground_a: [0.0; 3],
        ground_b: [0.0; 3],
        ratio: 1.0,
        total: 0.0,
        hertz: 0.0,
        zeta: 1.0,
        correction: 0.2,
        error: 0.0,
        impulse: 0.0,
        path: 0,
        count: 0,
        cap: 0,
        closed: 0,
        indexed: 0,
        last_span: 0,
        impulse_n1: 0.0,
        impulse_n2: 0.0,
        motor_speed: 0.0,
        motor_force: 0.0,
    };
}

fn vec(a: [f32; 3]) -> V3 {
    v3(a[0], a[1], a[2])
}

/// The row of a coupling as the solve sees it: what a unit impulse does to each body's speed and how the combination's speed reads.
struct Row {
    /// Linear direction and arm of each end (a pulley), or zero.
    la: V3,
    lb: V3,
    ra: V3,
    rb: V3,
    /// Angular axis of each end (a gear, a pinion), already scaled by its weight in the row.
    ta: V3,
    tb: V3,
    /// Linear direction of the rack.
    db: V3,
}

/// Most lock rows a coupling's Schur complement takes: two joints' worth of five or six. More is a subset, which still bounds the
/// row's give from above (a constraint left out only frees the bodies), so the row then pushes short and never over.
const LEAN_ROWS: usize = 12;

/// One end of a row: it reads `lin . v + ang . w` of `body`.
#[derive(Clone, Copy)]
struct End {
    body: usize,
    lin: V3,
    ang: V3,
}

/// The two ends of a row that pushes `-p` on A along `d` at arm `ra` and `p` on B at arm `rb`: d . (vB + wB x rB - vA - wA x rA).
fn arm_ends(a: usize, b: usize, d: V3, ra: V3, rb: V3) -> [End; 2] {
    [End { body: a, lin: d.scale(-1.0), ang: ra.cross(d).scale(-1.0) }, End { body: b, lin: d, ang: rb.cross(d) }]
}

/// a . (m b) in doubles, for m a diagonal.
#[inline]
fn scaled(a: V3, b: V3, m: V3) -> f64 {
    a.x as f64 * b.x as f64 * m.x as f64 + a.y as f64 * b.y as f64 * m.y as f64 + a.z as f64 * b.z as f64 * m.z as f64
}

/// What a unit impulse along one end gives the speed the other end reads, on the same body; 0 on two bodies.
#[inline]
fn between(w: &World, x: &End, y: &End) -> f64 {
    if x.body != y.body {
        return 0.0;
    }
    let m = w.moving(x.body);
    scaled(x.lin, y.lin, m.mass) + m.inertia.between(x.ang, y.ang)
}

/// The locks of the joints on a coupling's moving bodies, and the inverse of their J M^-1 J^T. A coupling is solved before the
/// joints in each pass, and the joints' path solve then takes back whatever the coupling's push did along their locks. So the row
/// is solved on its Schur complement, as a joint's own limit is on its locks (joints.rs, `limit_row`): it gives what the locks let
/// it give, k - x^T K^-1 x, with x its cross terms on the locks, and it reads the speed the locks will leave it,
/// Cdot - x^T K^-1 (the locks' speeds). One sweep then holds a row whose push the locks would otherwise mostly take back: a
/// follower on a slide held to a path by a point 1 m off its centre, inertia 0.01, saw a hundredth of each push stay, and the
/// path ran away (KB-PHYS-PATHMOVINGBASE1). This is block elimination of the coupled system, the use of the Schur complement
/// that Featherstone 2008 (chapter 7, articulated-body inertia) and Baraff 1996 make, on one row against its bodies' joints.
struct Locks {
    m: usize,
    ends: [[End; 2]; LEAN_ROWS],
    inverse: [[f64; LEAN_ROWS]; LEAN_ROWS],
}

impl Locks {
    /// The give and the speed of a row with the locks answering: (speed, give), or the row's own when no lock touches it. A row
    /// the locks hold entirely gives 0 and is left to them.
    fn through(&self, w: &World, row: &[End; 2], speed: f32, give: f32) -> (f32, f32) {
        if self.m == 0 {
            return (speed, give);
        }
        let mut x = [0.0f64; LEAN_ROWS];
        let mut any = false;
        for i in 0..self.m {
            for e in row {
                for f in &self.ends[i] {
                    x[i] += between(w, e, f);
                }
            }
            any |= x[i] != 0.0;
        }
        if !any {
            return (speed, give);
        }
        let mut own = 0.0f64;
        for e in row {
            for f in row {
                own += between(w, e, f);
            }
        }
        let (mut ease, mut along) = (own, speed as f64);
        for i in 0..self.m {
            let mut lean = 0.0;
            for j in 0..self.m {
                lean += self.inverse[i][j] * x[j];
            }
            if lean == 0.0 {
                continue;
            }
            ease -= lean * x[i];
            let mut lock = 0.0f64;
            for f in &self.ends[i] {
                let m = w.moving(f.body);
                lock += f.lin.dot(m.linear) as f64 + f.ang.dot(m.angular) as f64;
            }
            along -= lean * lock;
        }
        // Higham's stop, as the joints' factors use it: what is left under n u of the row's own give is rounding.
        if !(ease > own * f32::EPSILON as f64 * (self.m + 1) as f64) {
            return (speed, 0.0);
        }
        (along as f32, ease as f32)
    }
}

impl World {
    /// The locks of the joints the step solves on the moving bodies among `bodies`, up to LEAN_ROWS rows.
    fn locks_on(&self, bodies: [u32; 2]) -> Locks {
        let none = End { body: 0, lin: v3(0.0, 0.0, 0.0), ang: v3(0.0, 0.0, 0.0) };
        let mut locks = Locks { m: 0, ends: [[none; 2]; LEAN_ROWS], inverse: [[0.0; LEAN_ROWS]; LEAN_ROWS] };
        let mut seen = [NONE; 2 * LEAN_ROWS];
        let mut joints = 0;
        let mut rows = [(v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0)); 6];
        for body in bodies {
            let body = body as usize;
            if self.flags(body) & KIND != DYNAMIC || !self.is_awake(body) {
                continue;
            }
            let mut at = self.uu(FIRST_JOINT, body);
            while at != NONE && joints < seen.len() {
                let joint = at as usize;
                at = self.uu(if self.uu(JOINT_A, joint) as usize == body { JOINT_NEXT_A } else { JOINT_NEXT_B }, joint);
                if seen[..joints].contains(&(joint as u32)) {
                    continue;
                }
                seen[joints] = joint as u32;
                joints += 1;
                let Some((a, b, count)) = self.solved_locks(joint, &mut rows) else { continue };
                for &(d, ta, tb) in &rows[..count] {
                    if locks.m == LEAN_ROWS {
                        break;
                    }
                    locks.ends[locks.m] = [End { body: a, lin: d.scale(-1.0), ang: ta.scale(-1.0) }, End { body: b, lin: d, ang: tb }];
                    locks.m += 1;
                }
            }
        }
        let m = locks.m;
        if m == 0 {
            return locks;
        }
        // K = J M^-1 J^T of the locks, inverted by Gauss-Jordan with complete pivoting on the scaled diagonal (Higham 1990), a
        // dependent row (a body held by more locks than it has freedoms) dropped as the joints' own `invert` drops it.
        let mut k = [[0.0f64; LEAN_ROWS]; LEAN_ROWS];
        let mut size = [0.0f64; LEAN_ROWS];
        for i in 0..m {
            for j in 0..m {
                let mut sum = 0.0;
                for e in &locks.ends[i] {
                    for f in &locks.ends[j] {
                        sum += between(self, e, f);
                    }
                }
                k[i][j] = sum;
            }
            size[i] = k[i][i];
        }
        let inverse = &mut locks.inverse;
        for p in 0..m {
            inverse[p][p] = 1.0;
        }
        let mut taken = [false; LEAN_ROWS];
        let tolerance = f32::EPSILON as f64 * m as f64;
        for _ in 0..m {
            let (mut p, mut most) = (m, tolerance);
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
        locks
    }

    /// The coupling in a slot.
    #[inline]
    fn coupling(&self, slot: usize) -> Coupling {
        unsafe { *(self.f(COUPLINGS).add(slot * COUPLING_WORDS as usize) as *const Coupling) }
    }

    #[inline]
    fn put_coupling(&mut self, slot: usize, c: Coupling) {
        unsafe { *(self.f(COUPLINGS).add(slot * COUPLING_WORDS as usize) as *mut Coupling) = c };
    }

    /// Makes room for more couplings.
    pub fn grow_couplings(&mut self) -> bool {
        let capacity = self.header().capacity;
        let slots = capacity[Rows::Coupling as usize] / COUPLING_WORDS;
        if slots >= MAX_COUPLINGS {
            return false;
        }
        let mut next = capacity;
        next[Rows::Coupling as usize] = (if slots < 16 { 16 } else { slots * 2 }) * COUPLING_WORDS;
        self.grow(next)
    }

    /// Adds a coupling between two live bodies; its slot, or None when they are one body, one is gone, the kind is not one, or
    /// memory is out.
    pub fn add_coupling(&mut self, kind: u32, a: u32, b: u32) -> Option<usize> {
        if a == b || !self.body_alive(a) || !self.body_alive(b) || !(GEAR..=COORDS).contains(&kind) {
            return None;
        }
        let used = self.header().coupling_rows as usize;
        let slot = match (0..used).find(|&k| self.coupling(k).kind == 0) {
            Some(free) => free,
            None => {
                if used as u32 >= self.header().capacity[Rows::Coupling as usize] / COUPLING_WORDS && !self.grow_couplings() {
                    return None;
                }
                self.header_mut().coupling_rows = used as u32 + 1;
                used
            }
        };
        self.put_coupling(slot, Coupling { kind, a, b, ..Coupling::NONE });
        self.wake(a);
        self.wake(b);
        Some(slot)
    }

    /// Writes one of a coupling's parameters: the slot's fields by index (see `coupling_set` in api.rs).
    pub fn set_coupling(&mut self, slot: usize, field: u32, value: [f32; 3]) {
        if slot >= self.header().coupling_rows as usize {
            return;
        }
        if field == 9 {
            self.add_path_point(slot, value);
            return;
        }
        let mut c = self.coupling(slot);
        match field {
            0 => c.axis_a = value,
            1 => c.axis_b = value,
            2 => c.anchor_a = value,
            3 => c.anchor_b = value,
            4 => c.ground_a = value,
            5 => c.ground_b = value,
            6 => c.ratio = value[0],
            7 => c.total = value[0],
            8 => {
                c.hertz = value[0];
                c.zeta = value[1];
                c.correction = value[2];
            }
            10 => {
                c.motor_speed = value[0];
                c.motor_force = value[1];
            }
            11 => c.closed = (value[0] != 0.0) as u32,
            // A coordinates coupling's parents and the kinds of its two sides (see COORDS).
            12 => {
                c.set_coords(value[0] as u32, value[1] as u32, value[2] as u32);
            }
            _ => {}
        }
        // A gear or a rack given new axes or a ratio holds from where its bodies stand now.
        if (c.kind == GEAR || c.kind == RACK_AND_PINION) && field <= 7 {
            c.indexed = 0;
            c.error = 0.0;
        }
        c.impulse = 0.0;
        c.impulse_n1 = 0.0;
        c.impulse_n2 = 0.0;
        self.put_coupling(slot, c);
    }

    /// Reads where a gear's or a rack's bodies stand, the start its error is measured from.
    fn begin_reading(&mut self, slot: usize) {
        let mut c = self.coupling(slot);
        let (a, b) = (c.a as usize, c.b as usize);
        let qa = self.pose_rotation(a);
        c.anchor_a = [qa.x, qa.y, qa.z];
        c.ground_a = [qa.w, 0.0, 0.0];
        if c.kind == GEAR {
            let qb = self.pose_rotation(b);
            c.anchor_b = [qb.x, qb.y, qb.z];
            c.ground_a[1] = qb.w;
        } else {
            let centre = self.pose_center(b);
            c.anchor_b = [centre.x, centre.y, centre.z];
        }
        c.ground_b = [0.0; 3];
        c.closed = 0;
        c.last_span = 0;
        c.error = 0.0;
        c.indexed = 1;
        self.put_coupling(slot, c);
    }

    /// A gear's or a rack's error from the poses: A's turn about its axis since the start plus `ratio` times B's (a gear), or
    /// `ratio` times A's turn plus B's travel along its axis (a rack), each axis at the length it was given, as the row's speed
    /// reads them. The whole turns are counted from the angle read the substep before, so a substep must turn less than half a
    /// turn. Sums are in doubles: a hundred turns is 628 rad, where an f32 is 6e-5 rad coarse.
    fn read_error(&mut self, slot: usize) {
        let mut c = self.coupling(slot);
        let (a, b) = (c.a as usize, c.b as usize);
        let turned = |start: Q, now: Q, axis: [f32; 3], last: &mut f32, turns: &mut u32| -> f64 {
            let raw = twist(start, now, axis);
            let step = raw - *last as f64;
            let mut whole = *turns as i32;
            if step > core::f64::consts::PI {
                whole -= 1;
            } else if step < -core::f64::consts::PI {
                whole += 1;
            }
            *last = raw as f32;
            *turns = whole as u32;
            let length = sqrt64(axis[0] as f64 * axis[0] as f64 + axis[1] as f64 * axis[1] as f64 + axis[2] as f64 * axis[2] as f64);
            (raw + whole as f64 * core::f64::consts::TAU) * length
        };
        let (mut last_a, mut last_b) = (c.ground_b[0], c.ground_b[1]);
        let (mut turns_a, mut turns_b) = (c.closed, c.last_span);
        let angle_a = turned(c.start_a(), self.pose_rotation(a), c.axis_a, &mut last_a, &mut turns_a);
        let error = if c.kind == GEAR {
            angle_a + c.ratio as f64 * turned(c.start_b(), self.pose_rotation(b), c.axis_b, &mut last_b, &mut turns_b)
        } else {
            let along = self.pose_rotation(b).rotate(vec(c.axis_b));
            let moved = self.pose_center(b).sub(vec(c.anchor_b));
            c.ratio as f64 * angle_a + moved.x as f64 * along.x as f64 + moved.y as f64 * along.y as f64 + moved.z as f64 * along.z as f64
        };
        c.ground_b = [last_a, last_b, 0.0];
        (c.closed, c.last_span) = (turns_a, turns_b);
        c.error = error as f32;
        self.put_coupling(slot, c);
    }

    pub fn remove_coupling(&mut self, slot: usize) -> bool {
        if slot < self.header().coupling_rows as usize && self.coupling(slot).kind != 0 {
            self.put_coupling(slot, Coupling::NONE);
            return true;
        }
        false
    }

    pub fn coupling_error(&self, slot: usize) -> f32 {
        if slot < self.header().coupling_rows as usize { self.coupling(slot).error } else { 0.0 }
    }

    pub fn coupling_impulse(&self, slot: usize) -> f32 {
        if slot < self.header().coupling_rows as usize { self.coupling(slot).impulse } else { 0.0 }
    }

    /// Whether a coupling's two bodies are both there.
    fn coupling_live(&self, c: &Coupling) -> bool {
        c.kind != 0 && self.body_alive(c.a) && self.body_alive(c.b) && (c.kind != COORDS || (self.body_alive(c.coords_parent_a()) && self.body_alive(c.coords_parent_b())))
    }

    /// Wakes what a moving body is coupled to, as `wake_across_joints` does for joints.
    pub fn wake_across_couplings(&mut self) {
        for k in 0..self.header().coupling_rows as usize {
            let c = self.coupling(k);
            if !self.coupling_live(&c) {
                continue;
            }
            let (a, b) = (c.a as usize, c.b as usize);
            let (sleeping_a, sleeping_b) = (self.flags(a) & SLEEPING != 0, self.flags(b) & SLEEPING != 0);
            if sleeping_a && !sleeping_b && self.disturbs(b) {
                self.wake(c.a);
            } else if sleeping_b && !sleeping_a && self.disturbs(a) {
                self.wake(c.b);
            }
        }
    }

    /// Coupled bodies are one island, as joined ones are: they sleep together and are woken together.
    pub fn unite_couplings(&mut self) {
        for k in 0..self.header().coupling_rows as usize {
            let c = self.coupling(k);
            if !self.coupling_live(&c) {
                continue;
            }
            if c.kind == COORDS {
                for other in [c.b, c.coords_parent_a(), c.coords_parent_b()] {
                    if self.flags(c.a as usize) & KIND == DYNAMIC && self.flags(other as usize) & KIND == DYNAMIC && self.is_awake(c.a as usize) && self.is_awake(other as usize) {
                        self.unite(c.a, other);
                    }
                }
                continue;
            }
            let (a, b) = (c.a as usize, c.b as usize);
            let (kind_a, kind_b) = (self.flags(a) & KIND, self.flags(b) & KIND);
            let awake = self.is_awake(a) && self.is_awake(b);
            if kind_a == DYNAMIC && kind_b == DYNAMIC && awake {
                self.unite(c.a, c.b);
            } else if kind_b == DYNAMIC && self.moving_kinematic(a) {
                self.set_s(SLEEP_TIME, b, 0.0);
            } else if kind_a == DYNAMIC && self.moving_kinematic(b) {
                self.set_s(SLEEP_TIME, a, 0.0);
            }
        }
    }

    /// Lays out the row of a coupling at the poses the bodies have now.
    fn coupling_row(&self, c: &Coupling) -> (Row, f32) {
        let (a, b) = (c.a as usize, c.b as usize);
        let (qa, qb) = (self.pose_rotation(a), self.pose_rotation(b));
        let zero = v3(0.0, 0.0, 0.0);
        let mut row = Row { la: zero, lb: zero, ra: zero, rb: zero, ta: zero, tb: zero, db: zero };
        match c.kind {
            GEAR => {
                row.ta = qa.rotate(vec(c.axis_a));
                row.tb = qb.rotate(vec(c.axis_b)).scale(c.ratio);
                (row, 0.0)
            }
            RACK_AND_PINION => {
                row.ta = qa.rotate(vec(c.axis_a)).scale(c.ratio);
                row.db = qb.rotate(vec(c.axis_b));
                (row, 0.0)
            }
            DISTANCE => {
                let pa = self.pose_position(a).add(qa.rotate(vec(c.anchor_a)));
                let pb = self.pose_position(b).add(qb.rotate(vec(c.anchor_b)));
                let d = pb.sub(pa);
                let length = sqrt(d.dot(d));
                row.la = if length > 1e-9 { d.scale(1.0 / length) } else { v3(1.0, 0.0, 0.0) };
                row.ra = pa.sub(self.pose_center(a));
                row.rb = pb.sub(self.pose_center(b));
                // The distance from the nearest end of the range (positive past the greatest, negative short of the least), and the length.
                let past = if c.total > 0.0 && length > c.total {
                    length - c.total
                } else if length < c.ratio {
                    length - c.ratio
                } else {
                    0.0
                };
                row.lb = v3(length, 0.0, 0.0);
                (row, past)
            }
            _ => {
                let pa = self.pose_position(a).add(qa.rotate(vec(c.anchor_a)));
                let pb = self.pose_position(b).add(qb.rotate(vec(c.anchor_b)));
                let (da, db) = (pa.sub(vec(c.ground_a)), pb.sub(vec(c.ground_b)));
                let (la, lb) = (sqrt(da.dot(da)), sqrt(db.dot(db)));
                row.la = if la > 1e-9 { da.scale(1.0 / la) } else { v3(0.0, -1.0, 0.0) };
                row.lb = if lb > 1e-9 { db.scale(1.0 / lb) } else { v3(0.0, -1.0, 0.0) };
                row.ra = pa.sub(self.pose_center(a));
                row.rb = pb.sub(self.pose_center(b));
                (row, la + c.ratio * lb - c.total)
            }
        }
    }

    /// The speed of a row from two bodies' motion, and the inverse mass it meets.
    fn coupling_speed(c: &Coupling, row: &Row, a: &Moving, b: &Moving) -> (f32, f32) {
        match c.kind {
            GEAR => (row.ta.dot(a.angular) + row.tb.dot(b.angular), row.ta.dot(a.inertia.mul(row.ta)) + row.tb.dot(b.inertia.mul(row.tb))),
            RACK_AND_PINION => (
                row.ta.dot(a.angular) + row.db.dot(b.linear),
                row.ta.dot(a.inertia.mul(row.ta)) + row.db.mul(row.db).dot(b.mass),
            ),
            DISTANCE => {
                let speed = row.la.dot(b.at(row.rb).sub(a.at(row.ra)));
                (speed, a.give(row.la, row.ra) + b.give(row.la, row.rb))
            }
            _ => {
                let speed = row.la.dot(a.at(row.ra)) + c.ratio * row.lb.dot(b.at(row.rb));
                (speed, a.give(row.la, row.ra) + c.ratio * c.ratio * b.give(row.lb, row.rb))
            }
        }
    }

    /// The ends of a coupling's row, as `Locks` reads them.
    fn coupling_ends(c: &Coupling, row: &Row) -> [End; 2] {
        let (a, b, zero) = (c.a as usize, c.b as usize, v3(0.0, 0.0, 0.0));
        match c.kind {
            GEAR => [End { body: a, lin: zero, ang: row.ta }, End { body: b, lin: zero, ang: row.tb }],
            RACK_AND_PINION => [End { body: a, lin: zero, ang: row.ta }, End { body: b, lin: row.db, ang: zero }],
            DISTANCE => arm_ends(a, b, row.la, row.ra, row.rb),
            _ => [
                End { body: a, lin: row.la, ang: row.ra.cross(row.la) },
                End { body: b, lin: row.lb.scale(c.ratio), ang: row.rb.cross(row.lb).scale(c.ratio) },
            ],
        }
    }

    /// Gives a body the push of an impulse `p` along a row.
    fn coupling_push(c: &Coupling, row: &Row, a: &mut Moving, b: &mut Moving, p: f32) {
        match c.kind {
            GEAR => {
                a.angular = a.angular.add(a.inertia.mul(row.ta).scale(p));
                b.angular = b.angular.add(b.inertia.mul(row.tb).scale(p));
            }
            RACK_AND_PINION => {
                a.angular = a.angular.add(a.inertia.mul(row.ta).scale(p));
                b.linear = b.linear.add(b.mass.mul(row.db).scale(p));
            }
            DISTANCE => {
                a.push(row.la.scale(-p), row.ra);
                b.push(row.la.scale(p), row.rb);
            }
            _ => {
                a.push(row.la.scale(p), row.ra);
                b.push(row.lb.scale(p * c.ratio), row.rb);
            }
        }
    }

    /// The island a coupling belongs to: that of the first awake dynamic body it holds (the two it ties, and for coordinates their
    /// parents), which `unite_couplings` made one. None when it holds none.
    fn island_of_coupling(&self, c: &Coupling) -> Option<usize> {
        let bodies = if c.kind == COORDS { [c.a, c.b, c.coords_parent_a(), c.coords_parent_b()] } else { [c.a, c.b, c.a, c.b] };
        for body in bodies {
            let body = body as usize;
            if self.flags(body) & KIND == DYNAMIC && self.is_awake(body) {
                let id = self.uu(ISLAND_ID, body);
                if id != NONE {
                    return Some(id as usize);
                }
            }
        }
        None
    }

    /// The island of a coupling that is live (both its bodies, and for coordinates their parents, exist: a dead slot's bodies are no
    /// rows to read), or None.
    fn island_of_live_coupling(&self, c: &Coupling) -> Option<usize> {
        if self.coupling_live(c) { self.island_of_coupling(c) } else { None }
    }

    /// Lists the couplings' slots in runs, one run an island and each in slot order (a stable counting sort), those of no island
    /// last, and notes where each island's run starts and how long it is. A dead slot is listed too and skipped where it is read.
    pub fn order_couplings_by_island(&mut self) {
        let (islands, rows) = (self.header().islands as usize, self.header().coupling_rows as usize);
        for island in 0..islands {
            self.set_u(ISLAND_COUPLING_COUNT, island, 0);
        }
        for k in 0..rows {
            let c = self.coupling(k);
            if let Some(island) = self.island_of_live_coupling(&c) {
                self.set_u(ISLAND_COUPLING_COUNT, island, self.uu(ISLAND_COUPLING_COUNT, island) + 1);
            }
        }
        let mut start = 0;
        for island in 0..islands {
            self.set_u(ISLAND_COUPLING_START, island, start);
            self.set_u(ISLAND_COUPLING_CURSOR, island, start);
            start += self.uu(ISLAND_COUPLING_COUNT, island);
        }
        let mut loose_at = start;
        for k in 0..rows {
            let c = self.coupling(k);
            let at = match self.island_of_live_coupling(&c) {
                Some(island) => {
                    let at = self.uu(ISLAND_COUPLING_CURSOR, island);
                    self.set_u(ISLAND_COUPLING_CURSOR, island, at + 1);
                    at
                }
                None => {
                    loose_at += 1;
                    loose_at - 1
                }
            };
            self.set_u(COUPLING_ORDER, at as usize, k as u32);
        }
        debug_assert_eq!(loose_at as usize, rows);
    }

    /// Gives every coupling the impulse it carries, at the start of a substep.
    pub fn warm_start_couplings(&mut self) {
        for place in self.window.couplings.0..self.window.couplings.1 {
            let k = self.uu(COUPLING_ORDER, place) as usize;
            let c = self.coupling(k);
            if c.kind == PATH {
                self.warm_curve(k);
                continue;
            }
            if (c.kind == GEAR || c.kind == RACK_AND_PINION) && !c.begun() && self.coupling_live(&c) {
                self.begin_reading(k);
            }
            if c.kind == COORDS {
                if self.coupling_live(&c) && c.impulse != 0.0 {
                    let side = self.coords_sides(&c);
                    self.coords_push(&c, &side, c.impulse);
                }
                continue;
            }
            if !self.coupling_live(&c) || c.impulse == 0.0 {
                continue;
            }
            let (row, _) = self.coupling_row(&c);
            let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
            Self::coupling_push(&c, &row, &mut a, &mut b, c.impulse);
            self.settle(c.a as usize, &a);
            self.settle(c.b as usize, &b);
        }
    }

    /// One pass over the couplings; `bias` is the pass that also closes the error. With `coords` false it solves every row but the
    /// coordinates rows, which go before the joints (their rows are on what the joints' locks let them move, `Locks`); with it
    /// true only the coordinates rows, which go after the joints: their row is on a joint's own coordinate and its give is the
    /// four bodies' free response, so the joints must have answered first.
    pub fn solve_couplings(&mut self, h: f32, bias: bool, coords: bool) {
        for place in self.window.couplings.0..self.window.couplings.1 {
            let k = self.uu(COUPLING_ORDER, place) as usize;
            let c = self.coupling(k);
            if !self.coupling_live(&c) || (c.kind == COORDS) != coords {
                continue;
            }
            if c.kind == PATH {
                self.solve_curve(k, h, bias);
                continue;
            }
            if c.kind == COORDS {
                self.solve_coords(k, h, bias);
                continue;
            }
            let (row, rope) = self.coupling_row(&c);
            let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
            let (speed, inverse) = Self::coupling_speed(&c, &row, &a, &b);
            let (speed, inverse) = self.locks_on([c.a, c.b]).through(self, &Self::coupling_ends(&c, &row), speed, inverse);
            if !(inverse > 0.0) {
                continue;
            }
            let error = if c.kind == PULLEY || c.kind == DISTANCE { rope } else { c.error };
            // A soft row gives by its stiffness, a rigid one closes a share of its error in the biased pass.
            let (beta, gamma) = if c.hertz > 0.0 {
                let mass = 1.0 / inverse;
                let omega = 2.0 * core::f32::consts::PI * c.hertz;
                let d = 2.0 * mass * c.zeta * omega;
                let spring = mass * omega * omega;
                (spring / (d + h * spring), 1.0 / (h * (d + h * spring)))
            } else {
                (if bias { c.correction / h } else { 0.0 }, 0.0)
            };
            let mut change = -(speed + beta * error + gamma * c.impulse) / (inverse + gamma);
            // A rope pulls and does not push, and a slack one does nothing.
            if c.kind == PULLEY {
                let wanted = c.impulse + change;
                let kept = if wanted > 0.0 || error + speed * h < -1e-5 { 0.0 } else { wanted };
                change = kept - c.impulse;
            }
            // A distance joint pushes or pulls only where its range ends: apart at the least, together at the greatest.
            if c.kind == DISTANCE {
                let length = row.lb.x;
                let (high, low) = (c.total > 0.0 && length + speed * h > c.total, length + speed * h < c.ratio);
                let wanted = c.impulse + change;
                let kept = if high { wanted.min(0.0) } else if low { wanted.max(0.0) } else { 0.0 };
                change = kept - c.impulse;
            }
            if change == 0.0 {
                continue;
            }
            Self::coupling_push(&c, &row, &mut a, &mut b, change);
            self.settle(c.a as usize, &a);
            self.settle(c.b as usize, &b);
            let mut kept = self.coupling(k);
            kept.impulse = c.impulse + change;
            self.put_coupling(k, kept);
        }
    }

    /// After a substep's poses: a gear's and a rack's error read from them, and a coordinates row's from the speed it ended with.
    pub fn track_couplings(&mut self, h: f32) {
        for place in self.window.couplings.0..self.window.couplings.1 {
            let k = self.uu(COUPLING_ORDER, place) as usize;
            let c = self.coupling(k);
            if !self.coupling_live(&c) || c.kind == PULLEY || c.kind == DISTANCE || c.kind == PATH {
                continue;
            }
            if c.kind == COORDS {
                let side = self.coords_sides(&c);
                let speed = self.coords_speed(&c, &side);
                let mut kept = self.coupling(k);
                kept.error = c.error + speed * h;
                self.put_coupling(k, kept);
                continue;
            }
            if c.begun() {
                self.read_error(k);
            }
        }
    }
}

/// The arc tangent of `z` in [0, 1], in doubles: two halvings, tan(x / 2) = tan x / (1 + sqrt(1 + tan^2 x)), bring it under
/// tan(pi / 16), where nine terms of the series leave under 1e-14.
fn arc_tangent64(z: f64) -> f64 {
    let t = z / (1.0 + sqrt64(1.0 + z * z));
    let t = t / (1.0 + sqrt64(1.0 + t * t));
    let s = t * t;
    let mut sum = 0.0;
    for k in (0..9).rev() {
        let term = 1.0 / (2 * k + 1) as f64;
        sum = (if k % 2 == 0 { term } else { -term }) + s * sum;
    }
    4.0 * t * sum
}

/// The angle of (x, y) for x >= 0, from -pi / 2 to pi / 2, in doubles.
fn half_atan2(y: f64, x: f64) -> f64 {
    let size_y = if y < 0.0 { -y } else { y };
    if size_y == 0.0 && x == 0.0 {
        return 0.0;
    }
    let angle = if size_y <= x { arc_tangent64(size_y / x) } else { core::f64::consts::FRAC_PI_2 - arc_tangent64(x / size_y) };
    if y < 0.0 { -angle } else { angle }
}

/// The turn from `start` to `now` about `axis` (in the body's frame), from -pi to pi: the twist of start^-1 now, 2 atan2(v . u, w)
/// with the quaternion's sign taken so w >= 0. The product is in doubles, so the angle is as fine as the two f32 quaternions.
fn twist(start: Q, now: Q, axis: [f32; 3]) -> f64 {
    let (ax, ay, az, aw) = (-start.x as f64, -start.y as f64, -start.z as f64, start.w as f64);
    let (bx, by, bz, bw) = (now.x as f64, now.y as f64, now.z as f64, now.w as f64);
    let x = aw * bx + ax * bw + ay * bz - az * by;
    let y = aw * by - ax * bz + ay * bw + az * bx;
    let z = aw * bz + ax * by - ay * bx + az * bw;
    let w = aw * bw - ax * bx - ay * by - az * bz;
    let (ux, uy, uz) = (axis[0] as f64, axis[1] as f64, axis[2] as f64);
    let length = sqrt64(ux * ux + uy * uy + uz * uz);
    if !(length > 0.0) {
        return 0.0;
    }
    let along = (x * ux + y * uy + z * uz) / length;
    let (along, w) = if w < 0.0 { (-along, -w) } else { (along, w) };
    2.0 * half_atan2(along, w)
}

/// One side of a coordinates coupling at the poses the bodies have now.
struct Side {
    child: usize,
    parent: usize,
    /// The hinge axis, or the slide direction, in the world, already scaled by the side's weight in the row.
    axis: V3,
    slides: bool,
    /// A slide: no arm on the child (its centre), and the parent's arm to the child's centre. A hinge: both zero.
    arm_child: V3,
    arm_parent: V3,
}

impl World {
    fn coords_sides(&self, c: &Coupling) -> [Side; 2] {
        let side = |child: u32, parent: u32, axis: [f32; 3], slides: bool, weight: f32| {
            let (child, parent) = (child as usize, parent as usize);
            let qc = self.pose_rotation(child);
            // A slide's offset is that of the child's centre in the parent's frame, which turns with the parent: its rate is the child's
            // velocity less that of the parent's material point under it, v_c - v_p - w_p x (x_c - x_p).
            let arm_parent = if slides { self.pose_center(child).sub(self.pose_center(parent)) } else { v3(0.0, 0.0, 0.0) };
            Side { child, parent, axis: qc.rotate(vec(axis)).scale(weight), slides, arm_child: v3(0.0, 0.0, 0.0), arm_parent }
        };
        [
            side(c.a, c.coords_parent_a(), c.axis_a, c.coords_slides_a(), 1.0),
            side(c.b, c.coords_parent_b(), c.axis_b, c.coords_slides_b(), c.ratio),
        ]
    }

    /// The speed of the row from the bodies' current speeds.
    fn coords_speed(&self, _c: &Coupling, sides: &[Side; 2]) -> f32 {
        let mut speed = 0.0;
        for s in sides {
            let (child, parent) = (self.moving(s.child), self.moving(s.parent));
            speed += if s.slides { s.axis.dot(child.at(s.arm_child).sub(parent.at(s.arm_parent))) } else { s.axis.dot(child.angular.sub(parent.angular)) };
        }
        speed
    }

    /// Gives the bodies the push of an impulse `p` along the row, one body at a time so a parent two sides share takes both.
    fn coords_push(&mut self, _c: &Coupling, sides: &[Side; 2], p: f32) {
        for s in sides {
            let mut child = self.moving(s.child);
            let mut parent = self.moving(s.parent);
            if s.slides {
                child.push(s.axis.scale(p), s.arm_child);
                parent.push(s.axis.scale(-p), s.arm_parent);
            } else {
                child.angular = child.angular.add(child.inertia.mul(s.axis).scale(p));
                parent.angular = parent.angular.sub(parent.inertia.mul(s.axis).scale(p));
            }
            self.settle(s.child, &child);
            self.settle(s.parent, &parent);
        }
    }

    /// The speed a unit impulse along the row would give it: J M^-1 J^T by its own response, so two sides that share a parent count
    /// that parent's response to both pushes together.
    fn coords_inverse(&self, sides: &[Side; 2]) -> f32 {
        // At most four distinct bodies; a parent that two sides share is held once.
        let mut ids = [usize::MAX; 4];
        let mut states = [self.moving(sides[0].child); 4];
        let mut count = 0;
        for s in sides {
            for id in [s.child, s.parent] {
                if !ids[..count].contains(&id) {
                    ids[count] = id;
                    states[count] = self.moving(id);
                    count += 1;
                }
            }
        }
        let at = |id: usize| ids[..count].iter().position(|&k| k == id).unwrap_or(0);
        let read = |states: &[Moving; 4]| {
            let mut speed = 0.0;
            for s in sides {
                let (child, parent) = (states[at(s.child)], states[at(s.parent)]);
                speed += if s.slides { s.axis.dot(child.at(s.arm_child).sub(parent.at(s.arm_parent))) } else { s.axis.dot(child.angular.sub(parent.angular)) };
            }
            speed
        };
        let before = read(&states);
        for s in sides {
            let (ci, pi) = (at(s.child), at(s.parent));
            if s.slides {
                states[ci].push(s.axis, s.arm_child);
                states[pi].push(s.axis.scale(-1.0), s.arm_parent);
            } else {
                let child = states[ci];
                states[ci].angular = child.angular.add(child.inertia.mul(s.axis));
                let parent = states[pi];
                states[pi].angular = parent.angular.sub(parent.inertia.mul(s.axis));
            }
        }
        read(&states) - before
    }

    /// One pass of a coordinates coupling, as the other rows' (see `solve_couplings`).
    fn solve_coords(&mut self, k: usize, h: f32, bias: bool) {
        let c = self.coupling(k);
        let sides = self.coords_sides(&c);
        let inverse = self.coords_inverse(&sides);
        if !(inverse > 0.0) {
            return;
        }
        let speed = self.coords_speed(&c, &sides);
        let (beta, gamma) = if c.hertz > 0.0 {
            let mass = 1.0 / inverse;
            let omega = 2.0 * core::f32::consts::PI * c.hertz;
            let d = 2.0 * mass * c.zeta * omega;
            let spring = mass * omega * omega;
            (spring / (d + h * spring), 1.0 / (h * (d + h * spring)))
        } else {
            (if bias { c.correction / h } else { 0.0 }, 0.0)
        };
        let change = -(speed + beta * c.error + gamma * c.impulse) / (inverse + gamma);
        if change == 0.0 {
            return;
        }
        self.coords_push(&c, &sides, change);
        let mut kept = self.coupling(k);
        kept.impulse = c.impulse + change;
        self.put_coupling(k, kept);
    }
}

/// A point of a Catmull-Rom span (the uniform spline through `p1` and `p2`, with `p0` and `p3` as neighbours) and its derivative.
fn spline(p0: V3, p1: V3, p2: V3, p3: V3, t: f32) -> (V3, V3) {
    let (t2, t3) = (t * t, t * t * t);
    let a = p1.scale(2.0);
    let b = p2.sub(p0);
    let c = p0.scale(2.0).sub(p1.scale(5.0)).add(p2.scale(4.0)).sub(p3);
    let d = p3.sub(p0).add(p1.sub(p2).scale(3.0));
    let point = a.add(b.scale(t)).add(c.scale(t2)).add(d.scale(t3)).scale(0.5);
    let slope = b.add(c.scale(2.0 * t)).add(d.scale(3.0 * t2)).scale(0.5);
    (point, slope)
}

/// What a path row needs: the nearest point of the curve to the follower's anchor, the curve's direction there, two directions
/// across it, the arms from each body's centre and the span it lies on.
struct PathState {
    on: V3,
    tangent: V3,
    n1: V3,
    n2: V3,
    ra: V3,
    rb: V3,
    error: V3,
    span: u32,
}

/// The squared distance from `p` to a box of `lo` and `hi`.
#[inline]
fn box_distance(lo: V3, hi: V3, p: V3) -> f32 {
    let d = |lo: f32, hi: f32, p: f32| if p < lo { lo - p } else if p > hi { p - hi } else { 0.0 };
    let (x, y, z) = (d(lo.x, hi.x, p.x), d(lo.y, hi.y, p.y), d(lo.z, hi.z, p.z));
    x * x + y * y + z * z
}

impl World {
    #[inline]
    fn path_at(&self, word: usize) -> V3 {
        unsafe {
            let p = self.f(PATH_WORD).add(word);
            v3(*p, *p.add(1), *p.add(2))
        }
    }

    #[inline]
    fn path_put(&mut self, word: usize, v: V3) {
        unsafe {
            let p = self.f(PATH_WORD).add(word);
            *p = v.x;
            *p.add(1) = v.y;
            *p.add(2) = v.z;
        }
    }

    /// Point `i` of a path, in A's frame: past an end it wraps on a closed path and holds the end's point on an open one.
    fn path_point(&self, c: &Coupling, i: i64) -> V3 {
        let n = c.count as i64;
        let at = if c.closed != 0 { ((i % n) + n) % n } else if i < 0 { 0 } else if i > n - 1 { n - 1 } else { i };
        self.path_at(c.path as usize + 3 * at as usize)
    }

    /// The four neighbours of span `s`.
    fn span_points(&self, c: &Coupling, s: usize) -> (V3, V3, V3, V3) {
        let s = s as i64;
        (self.path_point(c, s - 1), self.path_point(c, s), self.path_point(c, s + 1), self.path_point(c, s + 2))
    }

    /// How many spans a path has.
    fn path_spans(c: &Coupling) -> usize {
        let n = c.count as usize;
        if n < 2 { 0 } else if c.closed != 0 { n } else { n - 1 }
    }

    /// Makes the path column hold at least `words` words.
    pub fn reserve_paths(&mut self, words: u32) -> bool {
        let mut next = self.header().capacity;
        if next[Rows::PathPoint as usize] >= words {
            return true;
        }
        next[Rows::PathPoint as usize] = words;
        self.grow(next)
    }

    /// Hands out `words` of the path column, packing the ranges first and growing the column when they do not fit.
    fn path_alloc(&mut self, words: u32) -> Option<u32> {
        let (used, capacity) = (self.header().path_used, self.header().capacity[Rows::PathPoint as usize]);
        if used as u64 + words as u64 > capacity as u64 {
            self.compact_paths();
            let used = self.header().path_used;
            if used as u64 + words as u64 > capacity as u64 {
                let need = (used as u64 + words as u64).next_power_of_two().max(1024);
                if need > MAX_PATH_WORDS as u64 {
                    return None;
                }
                if !self.reserve_paths(need as u32) {
                    return None;
                }
            }
        }
        let start = self.header().path_used;
        self.header_mut().path_used = start + words;
        Some(start)
    }

    /// Moves every live path's range down against the one before it, in the order the ranges lie, so what removed couplings and
    /// grown paths left behind is free again. A moved path's index is rebuilt at its next solve.
    fn compact_paths(&mut self) {
        let (mut next, mut last) = (0u32, -1i64);
        loop {
            let mut pick = None;
            for k in 0..self.header().coupling_rows as usize {
                let c = self.coupling(k);
                if c.kind == PATH && c.cap > 0 && c.path as i64 > last && pick.map_or(true, |(_, at)| c.path < at) {
                    pick = Some((k, c.path));
                }
            }
            let Some((k, at)) = pick else { break };
            let mut c = self.coupling(k);
            if c.path != next {
                unsafe {
                    let base = self.f(PATH_WORD);
                    core::ptr::copy(base.add(c.path as usize), base.add(next as usize), 3 * c.count as usize);
                }
                c.path = next;
                c.indexed = 0;
                self.put_coupling(k, c);
            }
            next += path_words(c.cap);
            last = at as i64;
        }
        self.header_mut().path_used = next;
    }

    /// Appends a point to a path, moving it to a larger range when its own is full.
    fn add_path_point(&mut self, slot: usize, value: [f32; 3]) {
        let c = self.coupling(slot);
        if c.kind != PATH || c.count >= MAX_PATH_POINTS {
            return;
        }
        if c.count == c.cap {
            let cap = if c.cap < 4 { 8 } else { c.cap * 2 };
            let Some(start) = self.path_alloc(path_words(cap)) else { return };
            // A compaction inside the allocation may have moved this path.
            let mut c = self.coupling(slot);
            unsafe {
                let base = self.f(PATH_WORD);
                core::ptr::copy(base.add(c.path as usize), base.add(start as usize), 3 * c.count as usize);
            }
            c.path = start;
            c.cap = cap;
            self.put_coupling(slot, c);
        }
        let mut c = self.coupling(slot);
        self.path_put(c.path as usize + 3 * c.count as usize, vec(value));
        c.count += 1;
        c.indexed = 0;
        c.impulse = 0.0;
        c.impulse_n1 = 0.0;
        c.impulse_n2 = 0.0;
        self.put_coupling(slot, c);
    }

    /// Builds the boxes over a path's spans and over blocks of them when its points have changed. A Catmull-Rom span is the Bezier
    /// curve whose inner control points are `p1 + (p2 - p0) / 6` and `p2 - (p3 - p1) / 6`, so it lies in the box of those four.
    fn index_path(&mut self, k: usize) {
        let mut c = self.coupling(k);
        if c.indexed == c.count {
            return;
        }
        let spans = Self::path_spans(&c);
        let (boxes, blocks) = (c.path as usize + 3 * c.cap as usize, c.path as usize + 9 * c.cap as usize);
        let grow = |lo: &mut V3, hi: &mut V3, p: V3| {
            if p.x < lo.x { lo.x = p.x }
            if p.y < lo.y { lo.y = p.y }
            if p.z < lo.z { lo.z = p.z }
            if p.x > hi.x { hi.x = p.x }
            if p.y > hi.y { hi.y = p.y }
            if p.z > hi.z { hi.z = p.z }
        };
        let blocks_used = (spans + BLOCK - 1) / BLOCK;
        for b in 0..blocks_used {
            let (mut blo, mut bhi) = (v3(f32::MAX, f32::MAX, f32::MAX), v3(-f32::MAX, -f32::MAX, -f32::MAX));
            for s in b * BLOCK..(b * BLOCK + BLOCK).min(spans) {
                let (p0, p1, p2, p3) = self.span_points(&c, s);
                let (q1, q2) = (p1.add(p2.sub(p0).scale(1.0 / 6.0)), p2.sub(p3.sub(p1).scale(1.0 / 6.0)));
                let (mut lo, mut hi) = (p1, p1);
                for p in [q1, q2, p2] {
                    grow(&mut lo, &mut hi, p);
                }
                self.path_put(boxes + 6 * s, lo);
                self.path_put(boxes + 6 * s + 3, hi);
                grow(&mut blo, &mut bhi, lo);
                grow(&mut blo, &mut bhi, hi);
            }
            self.path_put(blocks + 6 * b, blo);
            self.path_put(blocks + 6 * b + 3, bhi);
        }
        c.indexed = c.count;
        self.put_coupling(k, c);
    }

    /// The nearest point of span `s` to `p` by sixteen samples: its squared distance and parameter.
    fn sample_span(&self, c: &Coupling, s: usize, p: V3) -> (f32, f32) {
        self.path_samples.set(self.path_samples.get() + 1);
        let (p0, p1, p2, p3) = self.span_points(c, s);
        let (mut best, mut at) = (f32::MAX, 0.0f32);
        for k in 0..=16 {
            let t = k as f32 / 16.0;
            let d = spline(p0, p1, p2, p3, t).0.sub(p);
            let l = d.dot(d);
            if l < best {
                best = l;
                at = t;
            }
        }
        (best, at)
    }

    fn path_state(&self, c: &Coupling) -> Option<PathState> {
        let spans = Self::path_spans(c);
        if spans == 0 || c.indexed != c.count {
            return None;
        }
        let (a, b) = (c.a as usize, c.b as usize);
        let (qa, qb) = (self.pose_rotation(a), self.pose_rotation(b));
        let (pa, pb) = (self.pose_position(a), self.pose_position(b));
        self.path_searches.set(self.path_searches.get() + 1);
        let anchor = pb.add(qb.rotate(vec(c.anchor_b)));
        // The search runs in A's frame, where the points and their boxes stand still.
        let local = qa.unrotate(anchor.sub(pa));
        let (boxes, blocks) = (c.path as usize + 3 * c.cap as usize, c.path as usize + 9 * c.cap as usize);
        // Start from where the follower was: the spans beside the last one give a distance the boxes then prune against.
        let seed = (c.last_span as usize).min(spans - 1);
        let (mut best, mut span, mut at_t) = (f32::MAX, seed, 0.0f32);
        for s in [seed, (seed + 1) % spans, (seed + spans - 1) % spans] {
            let (d, t) = self.sample_span(c, s, local);
            if d < best {
                (best, span, at_t) = (d, s, t);
            }
        }
        for blk in 0..(spans + BLOCK - 1) / BLOCK {
            if box_distance(self.path_at(blocks + 6 * blk), self.path_at(blocks + 6 * blk + 3), local) >= best {
                continue;
            }
            for s in blk * BLOCK..(blk * BLOCK + BLOCK).min(spans) {
                if box_distance(self.path_at(boxes + 6 * s), self.path_at(boxes + 6 * s + 3), local) >= best {
                    continue;
                }
                let (d, t) = self.sample_span(c, s, local);
                if d < best {
                    (best, span, at_t) = (d, s, t);
                }
            }
        }
        let (p0, p1, p2, p3) = self.span_points(c, span);
        for _ in 0..2 {
            let (point, slope) = spline(p0, p1, p2, p3, at_t);
            let denom = slope.dot(slope);
            if denom > 1e-12 {
                let next = at_t - point.sub(local).dot(slope) / denom;
                at_t = if next < 0.0 { 0.0 } else if next > 1.0 { 1.0 } else { next };
            }
        }
        let (on_local, slope_local) = spline(p0, p1, p2, p3, at_t);
        let on = pa.add(qa.rotate(on_local));
        let slope = qa.rotate(slope_local);
        let length = sqrt(slope.dot(slope));
        let tangent = if length > 1e-9 { slope.scale(1.0 / length) } else { v3(1.0, 0.0, 0.0) };
        // The two directions across the curve: from the world axis least along it.
        let axis = if tangent.x.abs() < 0.6 {
            v3(1.0, 0.0, 0.0)
        } else if tangent.y.abs() < 0.6 {
            v3(0.0, 1.0, 0.0)
        } else {
            v3(0.0, 0.0, 1.0)
        };
        let n1 = tangent.cross(axis);
        let n1 = n1.scale(1.0 / sqrt(n1.dot(n1)));
        let n2 = tangent.cross(n1);
        Some(PathState { on, tangent, n1, n2, ra: on.sub(self.pose_center(a)), rb: anchor.sub(self.pose_center(b)), error: anchor.sub(on), span: span as u32 })
    }

    fn warm_curve(&mut self, k: usize) {
        let c = self.coupling(k);
        if !self.coupling_live(&c) || (c.impulse == 0.0 && c.impulse_n1 == 0.0 && c.impulse_n2 == 0.0) {
            return;
        }
        self.index_path(k);
        let c = self.coupling(k);
        let Some(s) = self.path_state(&c) else { return };
        let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
        for (d, p) in [(s.n1, c.impulse_n1), (s.n2, c.impulse_n2), (s.tangent, c.impulse)] {
            a.push(d.scale(-p), s.ra);
            b.push(d.scale(p), s.rb);
        }
        self.settle(c.a as usize, &a);
        self.settle(c.b as usize, &b);
    }

    /// One pass over a path: the follower's anchor is held on the curve by two rows across it, and a motor along it drives it.
    fn solve_curve(&mut self, k: usize, h: f32, bias: bool) {
        self.index_path(k);
        let mut c = self.coupling(k);
        let Some(s) = self.path_state(&c) else { return };
        c.last_span = s.span;
        let locks = self.locks_on([c.a, c.b]);
        let speed_of = |a: &Moving, b: &Moving, d: V3| d.dot(b.at(s.rb).sub(a.at(s.ra)));
        for row in 0..3 {
            let (mut a, mut b) = (self.moving(c.a as usize), self.moving(c.b as usize));
            let (d, held) = match row {
                0 => (s.n1, c.impulse_n1),
                1 => (s.n2, c.impulse_n2),
                _ => (s.tangent, c.impulse),
            };
            if row == 2 && !(c.motor_force > 0.0) {
                continue;
            }
            let (speed, inverse) = locks.through(self, &arm_ends(c.a as usize, c.b as usize, d, s.ra, s.rb), speed_of(&a, &b, d), a.give(d, s.ra) + b.give(d, s.rb));
            if !(inverse > 0.0) {
                continue;
            }
            let (beta, gamma) = if row < 2 && c.hertz > 0.0 {
                let mass = 1.0 / inverse;
                let omega = 2.0 * core::f32::consts::PI * c.hertz;
                let damping = 2.0 * mass * c.zeta * omega;
                let spring = mass * omega * omega;
                (spring / (damping + h * spring), 1.0 / (h * (damping + h * spring)))
            } else {
                (if bias && row < 2 { c.correction / h } else { 0.0 }, 0.0)
            };
            let error = if row == 0 { s.error.dot(s.n1) } else if row == 1 { s.error.dot(s.n2) } else { 0.0 };
            let target = if row == 2 { c.motor_speed } else { 0.0 };
            let mut change = -(speed - target + beta * error + gamma * held) / (inverse + gamma);
            if row == 2 {
                let cap = c.motor_force * h;
                let wanted = held + change;
                let kept = if wanted > cap { cap } else if wanted < -cap { -cap } else { wanted };
                change = kept - held;
            }
            a.push(d.scale(-change), s.ra);
            b.push(d.scale(change), s.rb);
            self.settle(c.a as usize, &a);
            self.settle(c.b as usize, &b);
            match row {
                0 => c.impulse_n1 += change,
                1 => c.impulse_n2 += change,
                _ => c.impulse += change,
            }
        }
        self.put_coupling(k, c);
        let _ = s.on;
    }
}
