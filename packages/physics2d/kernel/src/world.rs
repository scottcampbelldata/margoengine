// The 2D world: bodies, the shapes on them, the contacts between shapes, and the step. A step finds candidate pairs by
// sweep and prune over fat boxes (kernel-common, PK38), builds each awake pair's manifold (manifold.rs), joins bodies
// touching each other into islands, wakes an island any awake body touches, solves the awake contacts (solver.rs), then
// lets an island sleep once every body in it has been slow for the sleep time.
//
// Everything runs in an order that depends on the ids alone: shapes and bodies by index, pairs and contacts sorted by
// their shape ids, so two worlds built the same way step the same, bit for bit.
use alloc::vec::Vec;
use margoengine_physics_kernel_common::broad::{Bounds, SweepPrune};
use margoengine_physics_kernel_common::island::{UnionFind, sleep_tick};

use crate::manifold::{Manifold, collide};
use crate::mass::mass_of;
use crate::math::{Rot, V2, Xf, sqrt, v2};
use crate::shape::{Core, LINEAR_SLOP};
use crate::solver;

/// How far apart two shapes may be and still get contact points: a gap the solver closes within a substep.
pub const SPECULATIVE: f32 = 4.0 * LINEAR_SLOP;
/// How far a fat box reaches past its shape, so a slow body keeps its box, and so its pairs, for many steps.
pub const BOX_MARGIN: f32 = 0.1;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// Never moves.
    Static,
    /// Moves at the velocity it is given, pushes and is never pushed.
    Kinematic,
    /// Moved by gravity, forces and contacts.
    Dynamic,
}

#[derive(Clone, Copy, Debug)]
pub struct BodyDef {
    pub kind: Kind,
    /// Where the body's origin is, and its rotation.
    pub position: V2,
    pub rotation: Rot,
    pub linear_velocity: V2,
    pub angular_velocity: f32,
    /// Fractions of the speed lost a second, applied implicitly: v / (1 + h d) each substep.
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub gravity_scale: f32,
    pub can_sleep: bool,
    /// No turning: infinite inertia.
    pub fixed_rotation: bool,
}

impl Default for BodyDef {
    fn default() -> Self {
        BodyDef {
            kind: Kind::Dynamic,
            position: V2::ZERO,
            rotation: Rot::IDENTITY,
            linear_velocity: V2::ZERO,
            angular_velocity: 0.0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            gravity_scale: 1.0,
            can_sleep: true,
            fixed_rotation: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Body {
    pub kind: Kind,
    /// The pose of the body's origin, its position rounded from `exact_center` after each step.
    pub xf: Xf,
    /// The centre of mass in world space, rounded, and in the body's frame.
    pub center: V2,
    pub local_center: V2,
    /// The centre of mass in world space in doubles: the position the step moves. Everything else works relative to a
    /// pair's first body, so a pile 10 km out steps as one at the origin, where floats alone would move it in steps of
    /// a millimetre (the float spacing at 1e4).
    pub exact_center: [f64; 2],
    pub linear_velocity: V2,
    pub angular_velocity: f32,
    pub mass: f32,
    pub inv_mass: f32,
    pub inertia: f32,
    pub inv_inertia: f32,
    /// The farthest any shape reaches from the centre of mass: turning at w moves a point at most w times this.
    pub extent: f32,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub gravity_scale: f32,
    pub can_sleep: bool,
    pub fixed_rotation: bool,
    pub awake: bool,
    pub sleep_time: f32,
    pub shapes: Vec<u32>,
    /// How far the centre of mass has moved this step, and the rotation at the step's start (the solver's).
    pub(crate) moved: V2,
    pub(crate) start_rotation: Rot,
}

impl Body {
    /// The body's origin in doubles.
    #[inline]
    pub fn exact_origin(&self) -> [f64; 2] {
        let offset = self.xf.q.apply(self.local_center);
        [self.exact_center[0] - offset.x as f64, self.exact_center[1] - offset.y as f64]
    }
    /// The offset from `from` to this body's centre of mass, rounded once.
    #[inline]
    pub fn center_from(&self, from: [f64; 2]) -> V2 {
        v2((self.exact_center[0] - from[0]) as f32, (self.exact_center[1] - from[1]) as f32)
    }
    /// The rounded centre and origin from the exact centre.
    #[inline]
    pub(crate) fn round_pose(&mut self) {
        let origin = self.exact_origin();
        self.center = v2(self.exact_center[0] as f32, self.exact_center[1] as f32);
        self.xf.p = v2(origin[0] as f32, origin[1] as f32);
    }
    /// Whether gravity and contacts move it.
    #[inline]
    pub fn is_dynamic(&self) -> bool {
        self.kind == Kind::Dynamic
    }
    /// The speed the sleep test reads: the fastest any point of the body moves, to first order.
    #[inline]
    pub fn sleep_speed(&self) -> f32 {
        self.linear_velocity.length().max(self.angular_velocity.abs() * self.extent)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ShapeDef {
    /// Kilograms per square metre.
    pub density: f32,
    pub friction: f32,
    pub restitution: f32,
}

impl Default for ShapeDef {
    fn default() -> Self {
        ShapeDef { density: 1.0, friction: 0.6, restitution: 0.0 }
    }
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub body: u32,
    /// The core in the body's frame.
    pub core: Core,
    pub density: f32,
    pub friction: f32,
    pub restitution: f32,
}

/// What two shapes keep between steps: the manifold and each point's impulses, matched by point id.
#[derive(Clone, Copy, Debug)]
pub struct Contact {
    /// Shape ids, `a < b`; the manifold's normal points from `a` to `b`, and its points are relative to the centre of
    /// mass of `a`'s body (world axes): add that body's `exact_center` for world space.
    pub a: u32,
    pub b: u32,
    pub manifold: Manifold,
    pub normal_impulse: [f32; 2],
    pub tangent_impulse: [f32; 2],
}

impl Contact {
    #[inline]
    pub fn touching(&self) -> bool {
        self.manifold.count > 0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub gravity: V2,
    /// Substeps a step, and biased passes (each followed by as many relaxing ones) a substep.
    pub substeps: u32,
    pub passes: u32,
    /// The contact spring: its frequency, held to a quarter of the substep rate, and damping ratio; and how fast a
    /// depth is pushed out at most, in metres a second.
    pub contact_hertz: f32,
    pub contact_damping: f32,
    pub contact_max_push: f32,
    /// Below this approach speed a contact does not bounce.
    pub restitution_threshold: f32,
    /// A body slower than this, everywhere, for `sleep_time` seconds may sleep with its island.
    pub sleep_threshold: f32,
    pub sleep_time: f32,
    pub sleep: bool,
    /// Two-point manifolds solved as one 2 by 2 problem (solver.rs); off, point by point.
    pub block_solver: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            gravity: v2(0.0, -9.81),
            substeps: 4,
            passes: 1,
            contact_hertz: 60.0,
            contact_damping: 10.0,
            contact_max_push: 3.0,
            restitution_threshold: 1.0,
            sleep_threshold: 0.05,
            sleep_time: 0.5,
            sleep: true,
            block_solver: true,
        }
    }
}

/// Work counts, reset each step: they prove speed changes by work done, not by wall clock (AGENTS.md).
#[derive(Clone, Copy, Debug, Default)]
pub struct Counts {
    /// Fat box pairs compared in the sweep, pairs it kept, manifolds built.
    pub compared: u64,
    pub pairs: u64,
    pub manifolds: u64,
    /// Contacts solved, and of their two-point normal solves, how many took the block and how many fell back.
    pub constraints: u64,
    pub block: u64,
    pub sequential: u64,
    pub islands: u64,
    pub awake_bodies: u64,
}

pub struct World {
    pub settings: Settings,
    pub bodies: Vec<Body>,
    pub shapes: Vec<Shape>,
    pub contacts: Vec<Contact>,
    pub counts: Counts,
    pub steps: u64,
    broad: SweepPrune<2>,
    pairs: Vec<(u32, u32)>,
    union: UnionFind,
    island_of: Vec<u32>,
    pub(crate) scratch: solver::Scratch,
}

impl Default for World {
    fn default() -> Self {
        Self::new(Settings::default())
    }
}

/// The box around `core` at `xf`.
pub fn bounds_of(core: &Core, xf: Xf) -> Bounds<2> {
    let first = xf.apply(core.vertices[0]);
    let (mut lo, mut hi) = (first, first);
    for i in 1..core.count {
        let p = xf.apply(core.vertices[i]);
        lo = v2(lo.x.min(p.x), lo.y.min(p.y));
        hi = v2(hi.x.max(p.x), hi.y.max(p.y));
    }
    let r = core.radius;
    Bounds { min: [lo.x - r, lo.y - r], max: [hi.x + r, hi.y + r] }
}

impl World {
    pub fn new(settings: Settings) -> Self {
        World {
            settings,
            bodies: Vec::new(),
            shapes: Vec::new(),
            contacts: Vec::new(),
            counts: Counts::default(),
            steps: 0,
            broad: SweepPrune::new(),
            pairs: Vec::new(),
            union: UnionFind::new(),
            island_of: Vec::new(),
            scratch: solver::Scratch::default(),
        }
    }

    pub fn create_body(&mut self, def: &BodyDef) -> u32 {
        let rotation = Rot::from_pair(def.rotation.c, def.rotation.s);
        let moving = def.kind != Kind::Static;
        self.bodies.push(Body {
            kind: def.kind,
            xf: Xf { p: def.position, q: rotation },
            center: def.position,
            local_center: V2::ZERO,
            exact_center: [def.position.x as f64, def.position.y as f64],
            linear_velocity: if moving { def.linear_velocity } else { V2::ZERO },
            angular_velocity: if moving { def.angular_velocity } else { 0.0 },
            mass: 0.0,
            inv_mass: 0.0,
            inertia: 0.0,
            inv_inertia: 0.0,
            extent: 0.0,
            linear_damping: def.linear_damping,
            angular_damping: def.angular_damping,
            gravity_scale: def.gravity_scale,
            can_sleep: def.can_sleep,
            fixed_rotation: def.fixed_rotation,
            awake: moving,
            sleep_time: 0.0,
            shapes: Vec::new(),
            moved: V2::ZERO,
            start_rotation: rotation,
        });
        let id = self.bodies.len() as u32 - 1;
        self.update_mass(id);
        id
    }

    /// Adds `core`, given in the body's frame, to `body`, and works out the body's mass again.
    pub fn create_shape(&mut self, body: u32, core: Core, def: &ShapeDef) -> u32 {
        let id = self.shapes.len() as u32;
        self.shapes.push(Shape { body, core, density: def.density, friction: def.friction, restitution: def.restitution });
        self.bodies[body as usize].shapes.push(id);
        self.update_mass(body);
        let xf = self.bodies[body as usize].xf;
        self.broad.place(id, &bounds_of(&core, xf), BOX_MARGIN);
        id
    }

    /// Mass, centre and inertia from the shapes. A dynamic body with no area gets a mass of 1 kg and does not turn.
    fn update_mass(&mut self, id: u32) {
        let body = &self.bodies[id as usize];
        let (mut mass, mut first, mut list) = (0.0f32, V2::ZERO, Vec::new());
        for &s in &body.shapes {
            let shape = &self.shapes[s as usize];
            let data = mass_of(&shape.core, shape.density);
            mass += data.mass;
            first = first.add(data.center.scale(data.mass));
            list.push(data);
        }
        let local_center = if mass > 0.0 { first.scale(1.0 / mass) } else { V2::ZERO };
        let mut inertia = 0.0f32;
        for data in &list {
            inertia += data.inertia + data.mass * data.center.sub(local_center).length_squared();
        }
        let mut extent = 0.0f32;
        for &s in &body.shapes {
            let core = &self.shapes[s as usize].core;
            for i in 0..core.count {
                extent = extent.max(core.vertices[i].sub(local_center).length() + core.radius);
            }
        }
        let body = &mut self.bodies[id as usize];
        let origin = body.exact_origin();
        body.local_center = local_center;
        let offset = body.xf.q.apply(local_center);
        body.exact_center = [origin[0] + offset.x as f64, origin[1] + offset.y as f64];
        body.round_pose();
        body.extent = extent;
        if body.kind != Kind::Dynamic {
            (body.mass, body.inv_mass, body.inertia, body.inv_inertia) = (0.0, 0.0, 0.0, 0.0);
            return;
        }
        let mass = if mass > 0.0 { mass } else { 1.0 };
        body.mass = mass;
        body.inv_mass = 1.0 / mass;
        body.inertia = inertia;
        body.inv_inertia = if inertia > 0.0 && !body.fixed_rotation { 1.0 / inertia } else { 0.0 };
    }

    /// Wakes `body` and resets its sleep timer.
    pub fn wake(&mut self, body: u32) {
        let b = &mut self.bodies[body as usize];
        if b.kind != Kind::Static {
            b.awake = true;
            b.sleep_time = 0.0;
        }
    }

    /// Whether a contact between the two shapes' bodies can do anything: two shapes of one body, or two bodies that
    /// nothing moves, never touch.
    fn may_touch(&self, a: u32, b: u32) -> bool {
        let (ba, bb) = (self.shapes[a as usize].body, self.shapes[b as usize].body);
        ba != bb && (self.bodies[ba as usize].is_dynamic() || self.bodies[bb as usize].is_dynamic())
    }

    pub fn step(&mut self, dt: f32) {
        if !(dt > 0.0) {
            return;
        }
        self.counts = Counts::default();
        self.steps += 1;
        self.broad_phase();
        self.narrow_phase();
        self.wake_and_join();
        solver::solve(self, dt);
        self.sleep(dt);
    }

    /// Refits the boxes of moving shapes, then merges the sweep's pairs into the contact list, keeping what the
    /// contacts that remain had.
    fn broad_phase(&mut self) {
        for s in 0..self.shapes.len() {
            let body = &self.bodies[self.shapes[s].body as usize];
            if body.kind != Kind::Static && body.awake {
                let tight = bounds_of(&self.shapes[s].core, body.xf);
                self.broad.place(s as u32, &tight, BOX_MARGIN);
            }
        }
        let mut pairs = core::mem::take(&mut self.pairs);
        let shapes = &self.shapes;
        let bodies = &self.bodies;
        self.broad.pairs(&mut pairs, |a, b| {
            let (ba, bb) = (shapes[a as usize].body, shapes[b as usize].body);
            ba != bb && (bodies[ba as usize].is_dynamic() || bodies[bb as usize].is_dynamic())
        });
        debug_assert!(pairs.iter().all(|&(a, b)| self.may_touch(a, b)));
        self.counts.compared = self.broad.compared;
        self.counts.pairs = pairs.len() as u64;
        // Both lists are sorted by (a, b): one merge keeps the contacts whose pair remains.
        let old = core::mem::take(&mut self.contacts);
        let mut next = Vec::with_capacity(pairs.len());
        let mut i = 0;
        for &(a, b) in &pairs {
            while i < old.len() && (old[i].a, old[i].b) < (a, b) {
                i += 1;
            }
            if i < old.len() && (old[i].a, old[i].b) == (a, b) {
                next.push(old[i]);
            } else {
                next.push(Contact { a, b, manifold: Manifold::default(), normal_impulse: [0.0; 2], tangent_impulse: [0.0; 2] });
            }
        }
        self.contacts = next;
        self.pairs = pairs;
    }

    /// New manifolds for the contacts with an awake body; each new point takes the impulses of the old point with its id.
    fn narrow_phase(&mut self) {
        let mut built = 0u64;
        for contact in self.contacts.iter_mut() {
            let (sa, sb) = (&self.shapes[contact.a as usize], &self.shapes[contact.b as usize]);
            let (ba, bb) = (&self.bodies[sa.body as usize], &self.bodies[sb.body as usize]);
            if !ba.awake && !bb.awake {
                continue;
            }
            built += 1;
            // In a frame at A's centre of mass with world axes, the offsets rounded once from doubles.
            let from = ba.exact_center;
            let (oa, ob) = (ba.exact_origin(), bb.exact_origin());
            let xa = Xf { p: v2((oa[0] - from[0]) as f32, (oa[1] - from[1]) as f32), q: ba.xf.q };
            let xb = Xf { p: v2((ob[0] - from[0]) as f32, (ob[1] - from[1]) as f32), q: bb.xf.q };
            let manifold = collide(&sa.core, xa, &sb.core, xb, SPECULATIVE);
            let (mut normal, mut tangent) = ([0.0f32; 2], [0.0f32; 2]);
            for (k, point) in manifold.points[..manifold.count].iter().enumerate() {
                for j in 0..contact.manifold.count {
                    if contact.manifold.points[j].id == point.id {
                        normal[k] = contact.normal_impulse[j];
                        tangent[k] = contact.tangent_impulse[j];
                    }
                }
            }
            contact.manifold = manifold;
            contact.normal_impulse = normal;
            contact.tangent_impulse = tangent;
        }
        self.counts.manifolds = built;
    }

    /// Islands of dynamic bodies joined by touching contacts. An island any awake body is in, or that an awake body
    /// outside it touches, is awake as a whole; a body woken here starts its sleep timer again.
    fn wake_and_join(&mut self) {
        let n = self.bodies.len();
        self.union.reset(n);
        let mut woken = Vec::new();
        for contact in &self.contacts {
            if !contact.touching() {
                continue;
            }
            let (a, b) = (self.shapes[contact.a as usize].body, self.shapes[contact.b as usize].body);
            let (ba, bb) = (&self.bodies[a as usize], &self.bodies[b as usize]);
            if ba.is_dynamic() && bb.is_dynamic() {
                self.union.union(a, b);
            } else {
                // A kinematic or static body joins no island; an awake kinematic one wakes the dynamic body it touches.
                let (other, dynamic) = if ba.is_dynamic() { (bb, b) } else { (ba, a) };
                if other.kind == Kind::Kinematic && other.awake {
                    woken.push(dynamic);
                }
            }
        }
        let count = self.union.islands(&mut self.island_of);
        self.counts.islands = count as u64;
        let mut awake = Vec::new();
        awake.resize(count, false);
        for (i, body) in self.bodies.iter().enumerate() {
            if body.is_dynamic() && body.awake {
                awake[self.island_of[i] as usize] = true;
            }
        }
        for &b in &woken {
            awake[self.island_of[b as usize] as usize] = true;
            self.bodies[b as usize].sleep_time = 0.0;
        }
        for (i, body) in self.bodies.iter_mut().enumerate() {
            if body.is_dynamic() && !body.awake && awake[self.island_of[i] as usize] {
                body.awake = true;
                body.sleep_time = 0.0;
            }
        }
    }

    /// Sleep timers, then every island whose bodies have all been slow for the sleep time goes to sleep.
    fn sleep(&mut self, dt: f32) {
        let threshold = self.settings.sleep_threshold;
        let mut awake_bodies = 0u64;
        for body in self.bodies.iter_mut() {
            if body.kind == Kind::Static || !body.awake {
                continue;
            }
            awake_bodies += 1;
            body.sleep_time = if body.can_sleep { sleep_tick(body.sleep_time, body.sleep_speed(), threshold, dt) } else { 0.0 };
            if body.kind == Kind::Kinematic && body.sleep_time > 0.0 {
                // A kinematic body at rest sleeps alone: it is in no island.
                if self.settings.sleep && body.sleep_time >= self.settings.sleep_time {
                    body.awake = false;
                }
            }
        }
        self.counts.awake_bodies = awake_bodies;
        if !self.settings.sleep {
            return;
        }
        let count = self.counts.islands as usize;
        let mut least = Vec::new();
        least.resize(count, f32::INFINITY);
        for (i, body) in self.bodies.iter().enumerate() {
            if body.is_dynamic() && body.awake {
                let slot = &mut least[self.island_of[i] as usize];
                *slot = slot.min(body.sleep_time);
            }
        }
        for (i, body) in self.bodies.iter_mut().enumerate() {
            if body.is_dynamic() && body.awake && least[self.island_of[i] as usize] >= self.settings.sleep_time {
                body.awake = false;
                body.linear_velocity = V2::ZERO;
                body.angular_velocity = 0.0;
            }
        }
    }

    /// The total kinetic energy of the dynamic bodies.
    pub fn kinetic_energy(&self) -> f64 {
        self.bodies
            .iter()
            .filter(|b| b.is_dynamic())
            .map(|b| 0.5 * (b.mass as f64 * b.linear_velocity.length_squared() as f64 + b.inertia as f64 * (b.angular_velocity as f64) * (b.angular_velocity as f64)))
            .sum()
    }

    /// The angle of a body, read from its rotation pair (for tests and debugging; the step never needs it).
    pub fn angle(&self, body: u32) -> f32 {
        let q = self.bodies[body as usize].xf.q;
        crate::math::atan2(q.s, q.c)
    }
}

/// The length of the gravity vector, for the solver's chain rule.
pub(crate) fn gravity_length(settings: &Settings) -> f32 {
    sqrt(settings.gravity.length_squared())
}
