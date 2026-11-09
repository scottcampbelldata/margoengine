// The 2D world: bodies, the shapes on them, the contacts between shapes, and the step. A step finds candidate pairs by
// sweep and prune over fat boxes (kernel-common, PK38), builds each awake pair's manifold (manifold.rs), joins bodies
// touching each other into islands, wakes an island any awake body touches, solves the awake contacts (solver.rs), then
// lets an island sleep once every body in it has been slow for the sleep time.
//
// Everything runs in an order that depends on the ids alone: shapes and bodies by index, pairs and contacts sorted by
// their shape ids, so two worlds built the same way step the same, bit for bit.
use alloc::vec::Vec;
use margoengine_physics_kernel_common::broad::{Bounds, SweepPrune};
use margoengine_physics_kernel_common::tree::Tree;
use margoengine_physics_kernel_common::island::{UnionFind, sleep_tick};

use crate::error::PhysicsError;
use crate::joint::{Joint, JointDef, JointKind, Motor};
use crate::manifold::{Manifold, collide_coherent_trusted, collide_four_trusted, reference_flip, validate_collision_core, validate_collision_pose};
use crate::mass::checked_mass_of;
use crate::math::{Rot, V2, Xf, sqrt, v2};
use crate::shape::{Core, LINEAR_SLOP};
use crate::smooth::{CHAIN_WELD, collide_smooth_trusted};
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
    /// For a segment of a chain: the far vertices of the segments before and after it, in the body's frame (smooth.rs);
    /// `None` at a chain's open end, and for every other shape.
    pub ghosts: [Option<V2>; 2],
    pub chain: bool,
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

    /// Carries matching point ids' impulses into a new manifold; counts unmatched points when the old one pushed.
    #[inline]
    fn refresh(&mut self, manifold: Manifold) -> u64 {
        let (mut normal, mut tangent) = ([0.0f32; 2], [0.0f32; 2]);
        let pushed = self.normal_impulse[..self.manifold.count].iter().any(|&i| i != 0.0);
        let mut cold = 0;
        for (k, point) in manifold.points[..manifold.count].iter().enumerate() {
            let mut found = false;
            for j in 0..self.manifold.count {
                if self.manifold.points[j].id == point.id {
                    normal[k] = self.normal_impulse[j];
                    tangent[k] = self.tangent_impulse[j];
                    found = true;
                }
            }
            if !found && pushed {
                cold += 1;
            }
        }
        self.manifold = manifold;
        self.normal_impulse = normal;
        self.tangent_impulse = tangent;
        cold
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
    /// The joint spring of the biased pass (joint.rs), held to a quarter of the substep rate, its damping ratio, and how
    /// fast a joint's error is pulled out at most.
    pub joint_hertz: f32,
    pub joint_damping: f32,
    pub joint_max_push: f32,
    /// Joints solve with each body's turning stiffened by the pull of its taut point joints (joint.rs, `stiffen`), which
    /// keeps a heavily loaded chain from flying apart at a few substeps; off, the plain inertia.
    pub joint_geometric_stiffness: bool,
    /// How the broad phase finds pairs; read when the world is made.
    pub broad_phase: BroadPhase,
    /// Contacts solved four at a time in SIMD lanes (the default); off, one at a time, every bit the same. Native builds
    /// only: the Wasm build always solves in lanes.
    pub contact_lanes: bool,
}

/// The broad phase. Both give the same pairs in the same order, so the same step to the bit; they differ in work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BroadPhase {
    /// A dynamic box tree with the pairs kept from step to step: work follows the boxes that moved (the default).
    Tree,
    /// Sweep and prune along one axis, every box each step: kept for the paired comparison.
    Sweep,
}

enum Broad {
    Tree(Tree<2>),
    Sweep(SweepPrune<2>),
}

impl Broad {
    fn place(&mut self, key: u32, tight: &Bounds<2>, margin: f32) -> bool {
        match self {
            Broad::Tree(t) => t.place(key, tight, margin),
            Broad::Sweep(s) => s.place(key, tight, margin),
        }
    }
    fn pairs(&mut self, out: &mut Vec<(u32, u32)>, keep: impl FnMut(u32, u32) -> bool) {
        match self {
            Broad::Tree(t) => t.pairs(out, keep),
            Broad::Sweep(s) => s.pairs(out, keep),
        }
    }
    fn compared(&self) -> u64 {
        match self {
            Broad::Tree(t) => t.compared,
            Broad::Sweep(s) => s.compared,
        }
    }
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
            joint_hertz: 60.0,
            joint_damping: 2.0,
            joint_max_push: 3.0,
            joint_geometric_stiffness: true,
            broad_phase: BroadPhase::Tree,
            contact_lanes: true,
        }
    }
}

/// Work counts, reset each step: they prove speed changes by work done, not by wall clock (AGENTS.md).
#[derive(Clone, Copy, Debug, Default)]
pub struct Counts {
    /// Fat boxes tested by the broad phase (tree nodes its queries opened, or box pairs the sweep compared), pairs it
    /// kept, manifolds built.
    pub compared: u64,
    pub pairs: u64,
    pub manifolds: u64,
    /// Manifold points that found no id in the contact's last manifold while that manifold pushed (a point with a
    /// normal impulse): each starts from zero impulse, losing its warm start.
    pub cold_points: u64,
    /// Contacts solved, and of their two-point normal solves, how many took the block and how many fell back.
    pub constraints: u64,
    pub block: u64,
    pub sequential: u64,
    /// Colours the contacts took (no two contacts of a colour write the same body), and contacts that fit in none.
    pub colours: u64,
    pub overflow: u64,
    pub islands: u64,
    pub awake_bodies: u64,
}

pub struct World {
    pub settings: Settings,
    pub bodies: Vec<Body>,
    pub shapes: Vec<Shape>,
    pub contacts: Vec<Contact>,
    pub joints: Vec<Joint>,
    pub counts: Counts,
    pub steps: u64,
    broad: Broad,
    pairs: Vec<(u32, u32)>,
    /// Body pairs a joint keeps from colliding, sorted, rebuilt each step.
    apart: Vec<(u32, u32)>,
    union: UnionFind,
    island_of: Vec<u32>,
    /// Reused linear-time witness that current public shape lists name every shape exactly once.
    shape_marks: Vec<bool>,
    pub(crate) scratch: solver::Scratch,
}

impl Default for World {
    fn default() -> Self {
        Self::new(Settings::default())
    }
}

/// The box around `core` at `xf`.
pub fn bounds_of(core: &Core, xf: Xf) -> Result<Bounds<2>, PhysicsError> {
    validate_collision_core(core)?;
    validate_collision_pose(xf)?;
    let first = xf.apply(core.vertices[0]);
    let (mut lo, mut hi) = (first, first);
    for i in 1..core.count {
        let p = xf.apply(core.vertices[i]);
        lo = v2(lo.x.min(p.x), lo.y.min(p.y));
        hi = v2(hi.x.max(p.x), hi.y.max(p.y));
    }
    let r = core.radius;
    let bounds = Bounds { min: [lo.x - r, lo.y - r], max: [hi.x + r, hi.y + r] };
    if bounds.min.into_iter().chain(bounds.max).any(|v| !v.is_finite()) { return Err(PhysicsError::ArithmeticOverflow); }
    Ok(bounds)
}

impl World {
    pub fn new(settings: Settings) -> Self {
        World {
            settings,
            bodies: Vec::new(),
            shapes: Vec::new(),
            contacts: Vec::new(),
            joints: Vec::new(),
            counts: Counts::default(),
            steps: 0,
            broad: if settings.broad_phase == BroadPhase::Sweep { Broad::Sweep(SweepPrune::new()) } else { Broad::Tree(Tree::new()) },
            apart: Vec::new(),
            pairs: Vec::new(),
            union: UnionFind::new(),
            island_of: Vec::new(),
            shape_marks: Vec::new(),
            scratch: solver::Scratch::default(),
        }
    }

    pub fn create_body(&mut self, def: &BodyDef) -> Result<u32, PhysicsError> {
        if [def.position.x, def.position.y, def.rotation.c, def.rotation.s, def.linear_velocity.x, def.linear_velocity.y, def.angular_velocity, def.linear_damping, def.angular_damping, def.gravity_scale].into_iter().any(|v| !v.is_finite()) { return Err(PhysicsError::NotFinite); }
        let rotation = Rot::from_pair(def.rotation.c, def.rotation.s);
        if !rotation.c.is_finite() || !rotation.s.is_finite() || rotation.c == 0.0 && rotation.s == 0.0 { return Err(PhysicsError::ArithmeticOverflow); }
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
        });
        let id = self.bodies.len() as u32 - 1;
        if let Err(error) = self.update_mass(id) {
            self.bodies.pop();
            return Err(error);
        }
        Ok(id)
    }

    /// Adds `core`, given in the body's frame, to `body`, and works out the body's mass again.
    pub fn create_shape(&mut self, body: u32, core: Core, def: &ShapeDef) -> Result<u32, PhysicsError> {
        let (id, bounds) = self.append_shape(body, core, def)?;
        self.broad.place(id, &bounds, BOX_MARGIN);
        Ok(id)
    }

    /// Validate and update mass before publishing a broad-phase proxy. A whole chain can therefore commit proxies
    /// only after its last segment succeeds, while keeping the existing per-segment mass arithmetic.
    fn append_shape(&mut self, body: u32, core: Core, def: &ShapeDef) -> Result<(u32, Bounds<2>), PhysicsError> {
        let target = self.bodies.get(body as usize).ok_or(PhysicsError::InvalidHandle)?;
        let bounds = bounds_of(&core, target.xf)?;
        if [def.density, def.friction, def.restitution].into_iter().any(|v| !v.is_finite()) { return Err(PhysicsError::NotFinite); }
        if def.density < 0.0 || def.friction < 0.0 || def.restitution < 0.0 { return Err(PhysicsError::InvalidParameter); }
        let id = self.shapes.len() as u32;
        self.shapes.push(Shape { body, core, density: def.density, friction: def.friction, restitution: def.restitution, ghosts: [None; 2], chain: false });
        self.bodies[body as usize].shapes.push(id);
        if let Err(error) = self.update_mass(body) {
            self.bodies[body as usize].shapes.pop();
            self.shapes.pop();
            return Err(error);
        }
        Ok((id, bounds))
    }

    /// A polyline through `points` (the body's frame) as one segment shape a pair of points, each knowing its neighbours'
    /// far vertices so shapes slide across the joins (smooth.rs). `closed` joins the last point to the first. Points
    /// closer than `CHAIN_WELD` to the one before are dropped. Returns the segment shapes in order.
    pub fn create_chain(&mut self, body: u32, points: &[V2], closed: bool, def: &ShapeDef) -> Result<Vec<u32>, PhysicsError> {
        let previous_body = self.bodies.get(body as usize).ok_or(PhysicsError::InvalidHandle)?.clone();
        if points.iter().any(|p| !(p.x.is_finite() && p.y.is_finite())) {
            return Err(PhysicsError::NotFinite);
        }
        let mut kept: Vec<V2> = Vec::with_capacity(points.len());
        for &p in points {
            if kept.last().is_none_or(|q| p.sub(*q).length() > CHAIN_WELD) {
                kept.push(p);
            }
        }
        if closed && kept.len() > 1 && kept[0].sub(kept[kept.len() - 1]).length() <= CHAIN_WELD {
            kept.pop();
        }
        let n = kept.len();
        if n < 2 || (closed && n < 3) {
            return Err(PhysicsError::Degenerate);
        }
        let segments = if closed { n } else { n - 1 };
        let previous_shapes = self.shapes.len();
        let staged = (|| -> Result<Vec<(u32, Bounds<2>)>, PhysicsError> {
            let mut staged = Vec::with_capacity(segments);
            for i in 0..segments {
                let (a, b) = (kept[i], kept[(i + 1) % n]);
                let before = if i > 0 { Some(kept[i - 1]) } else if closed { Some(kept[n - 1]) } else { None };
                let after = if i + 2 < n || closed { Some(kept[(i + 2) % n]) } else { None };
                let (id, bounds) = self.append_shape(body, Core::segment(a, b)?, def)?;
                let shape = &mut self.shapes[id as usize];
                shape.ghosts = [before, after];
                shape.chain = true;
                staged.push((id, bounds));
            }
            Ok(staged)
        })();
        match staged {
            Ok(staged) => {
                let mut ids = Vec::with_capacity(staged.len());
                for (id, bounds) in staged {
                    self.broad.place(id, &bounds, BOX_MARGIN);
                    ids.push(id);
                }
                Ok(ids)
            }
            Err(error) => {
                self.shapes.truncate(previous_shapes);
                self.bodies[body as usize] = previous_body;
                Err(error)
            }
        }
    }

    /// Mass, centre and inertia from the shapes. A dynamic body with no area gets a mass of 1 kg and does not turn.
    fn update_mass(&mut self, id: u32) -> Result<(), PhysicsError> {
        let body = self.bodies.get(id as usize).ok_or(PhysicsError::InvalidHandle)?;
        validate_collision_pose(body.xf)?;
        validate_body_state(body)?;
        validate_inverse_metric(body.inv_mass)?;
        validate_inverse_metric(body.inv_inertia)?;
        let (mut mass, mut first, mut list) = (0.0f32, V2::ZERO, Vec::new());
        for &s in &body.shapes {
            let shape = self.shapes.get(s as usize).ok_or(PhysicsError::InvalidHandle)?;
            if shape.body != id { return Err(PhysicsError::InvalidHandle); }
            validate_shape(shape)?;
            let data = checked_mass_of(&shape.core, shape.density)?;
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
            let core = &self.shapes.get(s as usize).ok_or(PhysicsError::InvalidHandle)?.core;
            for i in 0..core.count {
                extent = extent.max(core.vertices[i].sub(local_center).length() + core.radius);
            }
        }
        let dynamic_mass = if mass > 0.0 { mass } else { 1.0 };
        let inverse_mass = 1.0 / dynamic_mass;
        let inverse_inertia = if inertia > 0.0 && !body.fixed_rotation { 1.0 / inertia } else { 0.0 };
        if [mass, first.x, first.y, local_center.x, local_center.y, inertia, extent, inverse_mass, inverse_inertia].into_iter().any(|v| !v.is_finite()) { return Err(PhysicsError::ArithmeticOverflow); }
        validate_inverse_metric(inverse_mass)?;
        validate_inverse_metric(inverse_inertia)?;
        let origin = body.exact_origin();
        let offset = body.xf.q.apply(local_center);
        let exact_center = [origin[0] + offset.x as f64, origin[1] + offset.y as f64];
        if exact_center.into_iter().any(|v| !v.is_finite() || !(v as f32).is_finite()) { return Err(PhysicsError::ArithmeticOverflow); }
        // round_pose recomputes this origin from the new center and offset. Stage its exact arithmetic too:
        // a finite new center alone does not prove that the published origin fits f32.
        let rounded_origin = [exact_center[0] - offset.x as f64, exact_center[1] - offset.y as f64];
        if rounded_origin.into_iter().any(|v| !v.is_finite() || !(v as f32).is_finite()) { return Err(PhysicsError::ArithmeticOverflow); }
        let body = &mut self.bodies[id as usize];
        body.local_center = local_center;
        body.exact_center = exact_center;
        body.round_pose();
        body.extent = extent;
        if body.kind != Kind::Dynamic {
            (body.mass, body.inv_mass, body.inertia, body.inv_inertia) = (0.0, 0.0, 0.0, 0.0);
            return Ok(());
        }
        let mass = dynamic_mass;
        body.mass = mass;
        body.inv_mass = 1.0 / mass;
        body.inertia = inertia;
        body.inv_inertia = inverse_inertia;
        Ok(())
    }

    /// Joins two bodies (joint.rs) and wakes both.
    pub fn create_joint(&mut self, def: &JointDef) -> Result<u32, PhysicsError> {
        if def.a as usize >= self.bodies.len() || def.b as usize >= self.bodies.len() { return Err(PhysicsError::InvalidHandle); }
        validate_joint_def(def)?;
        validate_body_state(&self.bodies[def.a as usize])?;
        validate_body_state(&self.bodies[def.b as usize])?;
        self.joints.push(Joint::new(*def));
        self.wake(def.a)?;
        self.wake(def.b)?;
        Ok(self.joints.len() as u32 - 1)
    }


    /// Wakes `body` and resets its sleep timer.
    pub fn wake(&mut self, body: u32) -> Result<(), PhysicsError> {
        let b = self.bodies.get_mut(body as usize).ok_or(PhysicsError::InvalidHandle)?;
        validate_body_state(b)?;
        if b.kind != Kind::Static {
            b.awake = true;
            b.sleep_time = 0.0;
        }
        Ok(())
    }

    /// Whether a contact between the two shapes' bodies can do anything: two shapes of one body, or two bodies that
    /// nothing moves, never touch.
    fn may_touch(&self, a: u32, b: u32) -> bool {
        let (ba, bb) = (self.shapes[a as usize].body, self.shapes[b as usize].body);
        ba != bb && (self.bodies[ba as usize].is_dynamic() || self.bodies[bb as usize].is_dynamic())
    }

    pub fn step(&mut self, dt: f32) -> Result<(), PhysicsError> {
        let settings = &self.settings;
        if [dt, settings.gravity.x, settings.gravity.y, settings.contact_hertz, settings.contact_damping, settings.contact_max_push, settings.restitution_threshold, settings.sleep_threshold, settings.sleep_time, settings.joint_hertz, settings.joint_damping, settings.joint_max_push].into_iter().any(|v| !v.is_finite()) { return Err(PhysicsError::NotFinite); }
        if settings.contact_max_push < 0.0 || settings.joint_max_push < 0.0 { return Err(PhysicsError::InvalidParameter); }
        self.shape_marks.resize(self.shapes.len(), false);
        self.shape_marks.fill(false);
        for (id, body) in self.bodies.iter().enumerate() {
            validate_collision_pose(body.xf)?;
            validate_body_state(body)?;
            validate_inverse_metric(body.inv_mass)?;
            validate_inverse_metric(body.inv_inertia)?;
            if body.kind == Kind::Dynamic && body.inv_mass <= 0.0 { return Err(PhysicsError::InvalidParameter); }
            for &shape in &body.shapes {
                let seen = self.shape_marks.get_mut(shape as usize).ok_or(PhysicsError::InvalidHandle)?;
                if *seen { return Err(PhysicsError::InvalidHandle); }
                *seen = true;
                let shape = self.shapes.get(shape as usize).ok_or(PhysicsError::InvalidHandle)?;
                if shape.body as usize != id { return Err(PhysicsError::InvalidHandle); }
                validate_shape(shape)?;
            }
        }
        if self.shape_marks.iter().any(|&seen| !seen) { return Err(PhysicsError::InvalidHandle); }
        for contact in &self.contacts {
            if contact.a as usize >= self.shapes.len() || contact.b as usize >= self.shapes.len() { return Err(PhysicsError::InvalidHandle); }
            if contact.manifold.count > contact.manifold.points.len() { return Err(PhysicsError::InvalidParameter); }
            let n = contact.manifold.count;
            if n > 0 && (!finite_vector(contact.manifold.normal)
                || contact.manifold.points[..n].iter().any(|p| !finite_vector(p.point) || !p.separation.is_finite())
                || contact.normal_impulse[..n].iter().chain(&contact.tangent_impulse[..n]).any(|v| !v.is_finite())) { return Err(PhysicsError::NotFinite); }
            if contact.normal_impulse[..n].iter().any(|&v| v < 0.0) { return Err(PhysicsError::InvalidParameter); }
        }
        for joint in &self.joints {
            if joint.def.a as usize >= self.bodies.len() || joint.def.b as usize >= self.bodies.len() { return Err(PhysicsError::InvalidHandle); }
            validate_joint_def(&joint.def)?;
            if joint.lock.into_iter().chain([joint.lower, joint.upper, joint.motor]).any(|v| !v.is_finite()) { return Err(PhysicsError::NotFinite); }
        }
        if !(dt > 0.0) {
            return Ok(());
        }
        self.counts = Counts::default();
        self.steps = self.steps.checked_add(1).ok_or(PhysicsError::ArithmeticOverflow)?;
        self.broad_phase()?;
        self.narrow_phase()?;
        self.wake_and_join();
        solver::solve(self, dt)?;
        if self.bodies.iter().any(|body| !finite_body(body) || !nonzero_rotation(body.xf.q)) || !finite_solver_caches(self) { return Err(PhysicsError::ArithmeticOverflow); }
        self.sleep(dt);
        if self.bodies.iter().any(|body| !finite_body(body) || !nonzero_rotation(body.xf.q)) { return Err(PhysicsError::ArithmeticOverflow); }
        Ok(())
    }

    /// Refits the boxes of moving shapes, then merges the sweep's pairs into the contact list, keeping what the
    /// contacts that remain had.
    fn broad_phase(&mut self) -> Result<(), PhysicsError> {
        for s in 0..self.shapes.len() {
            let body = &self.bodies[self.shapes[s].body as usize];
            if body.kind != Kind::Static && body.awake {
                let tight = bounds_of(&self.shapes[s].core, body.xf)?;
                self.broad.place(s as u32, &tight, BOX_MARGIN);
            }
        }
        // The body pairs joints keep apart, sorted once, so each pair's filter is a binary search, not a scan of every
        // joint (the 30 by 30 joint grid has 1,711).
        self.apart.clear();
        self.apart.extend(self.joints.iter().filter(|j| !j.def.collide).map(|j| (j.def.a.min(j.def.b), j.def.a.max(j.def.b))));
        self.apart.sort_unstable();
        self.apart.dedup();
        let mut pairs = core::mem::take(&mut self.pairs);
        let shapes = &self.shapes;
        let bodies = &self.bodies;
        let apart = &self.apart;
        let mut invalid_handle = false;
        self.broad.pairs(&mut pairs, |a, b| {
            let (Some(sa), Some(sb)) = (shapes.get(a as usize), shapes.get(b as usize)) else { invalid_handle = true; return false; };
            let (ba, bb) = (sa.body, sb.body);
            ba != bb && (bodies[ba as usize].is_dynamic() || bodies[bb as usize].is_dynamic()) && (apart.is_empty() || apart.binary_search(&(ba.min(bb), ba.max(bb))).is_err())
        });
        if invalid_handle { self.pairs = pairs; return Err(PhysicsError::InvalidHandle); }
        debug_assert!(pairs.iter().all(|&(a, b)| self.may_touch(a, b)));
        self.counts.compared = self.broad.compared();
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
        Ok(())
    }

    /// New manifolds for the contacts with an awake body; each new point takes the impulses of the old point with its id.
    fn narrow_phase(&mut self) -> Result<(), PhysicsError> {
        let (mut built, mut cold) = (0u64, 0u64);
        let mut inputs = [None; 4];
        let mut pending: [Option<&mut Contact>; 4] = [None, None, None, None];
        let mut queued = 0;
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
            if !sa.chain && !sb.chain && sa.core.count == 4 && sb.core.count == 4 {
                inputs[queued] = Some((&sa.core, xa, &sb.core, xb, reference_flip(&contact.manifold)));
                pending[queued] = Some(contact);
                queued += 1;
                if queued == 4 {
                    let manifolds = collide_four_trusted(inputs.map(Option::unwrap), SPECULATIVE)?;
                    for (slot, manifold) in pending.iter_mut().zip(manifolds) {
                        cold += slot.take().unwrap().refresh(manifold);
                    }
                    queued = 0;
                }
                continue;
            }
            // A chain segment takes its ghosts (smooth.rs); with the chain second, the pair is solved the other way round
            // and the normal turned back, so it still runs from `a` to `b`.
            let manifold = if sa.chain {
                collide_smooth_trusted(&sa.core, sa.ghosts, xa, &sb.core, xb, SPECULATIVE)?
            } else if sb.chain {
                let mut m = collide_smooth_trusted(&sb.core, sb.ghosts, xb, &sa.core, xa, SPECULATIVE)?;
                m.normal = m.normal.neg();
                m
            } else {
                // Last step's reference face is kept within the hysteresis, so resting points keep their ids.
                collide_coherent_trusted(&sa.core, xa, &sb.core, xb, SPECULATIVE, reference_flip(&contact.manifold))?
            };
            cold += contact.refresh(manifold);
        }
        // Fewer than four remaining quads keep the scalar path, with the same per-contact frame and last face.
        for (slot, input) in pending.into_iter().zip(inputs).take(queued) {
            let (a, xa, b, xb, last) = input.unwrap();
            cold += slot.unwrap().refresh(collide_coherent_trusted(a, xa, b, xb, SPECULATIVE, last)?);
        }
        self.counts.manifolds = built;
        self.counts.cold_points = cold;
        Ok(())
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
        // A joint between two dynamic bodies joins them; one to a kinematic body wakes the dynamic one while it moves.
        for joint in &self.joints {
            let (a, b) = (joint.def.a, joint.def.b);
            let (ba, bb) = (&self.bodies[a as usize], &self.bodies[b as usize]);
            if ba.is_dynamic() && bb.is_dynamic() {
                self.union.union(a, b);
            } else {
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
    pub fn angle(&self, body: u32) -> Result<f32, PhysicsError> {
        let q = self.bodies.get(body as usize).ok_or(PhysicsError::InvalidHandle)?.xf.q;
        if !q.c.is_finite() || !q.s.is_finite() { return Err(PhysicsError::NotFinite); }
        if !nonzero_rotation(q) { return Err(PhysicsError::InvalidParameter); }
        Ok(crate::math::atan2(q.s, q.c))
    }
}

fn nonzero_rotation(q: Rot) -> bool { q.c != 0.0 || q.s != 0.0 }

fn validate_body_state(body: &Body) -> Result<(), PhysicsError> {
    if !finite_body(body) { return Err(PhysicsError::NotFinite); }
    if !nonzero_rotation(body.xf.q) { return Err(PhysicsError::InvalidParameter); }
    Ok(())
}

fn finite_body(body: &Body) -> bool {
    [body.xf.p.x, body.xf.p.y, body.xf.q.c, body.xf.q.s, body.center.x, body.center.y, body.local_center.x, body.local_center.y, body.linear_velocity.x, body.linear_velocity.y, body.angular_velocity, body.mass, body.inv_mass, body.inertia, body.inv_inertia, body.extent, body.linear_damping, body.angular_damping, body.gravity_scale, body.sleep_time].into_iter().all(f32::is_finite)
        && body.exact_center.into_iter().all(f64::is_finite)
}

fn finite_vector(v: V2) -> bool { v.x.is_finite() && v.y.is_finite() }

fn validate_inverse_metric(inverse: f32) -> Result<(), PhysicsError> {
    if !inverse.is_finite() { return Err(PhysicsError::NotFinite); }
    if inverse < 0.0 { return Err(PhysicsError::InvalidParameter); }
    if inverse > 0.0 && !(1.0 / inverse).is_finite() { return Err(PhysicsError::ArithmeticOverflow); }
    Ok(())
}

fn finite_solver_caches(world: &World) -> bool {
    world.contacts.iter().all(|c| c.normal_impulse[..c.manifold.count].iter().chain(&c.tangent_impulse[..c.manifold.count]).all(|v| v.is_finite()))
        && world.joints.iter().all(|j| j.lock.into_iter().chain([j.lower, j.upper, j.motor]).all(f32::is_finite))
}

fn validate_shape(shape: &Shape) -> Result<(), PhysicsError> {
    validate_collision_core(&shape.core)?;
    if [shape.density, shape.friction, shape.restitution].into_iter().any(|v| !v.is_finite())
        || shape.ghosts.into_iter().flatten().any(|v| !finite_vector(v)) { return Err(PhysicsError::NotFinite); }
    if shape.density < 0.0 || shape.friction < 0.0 || shape.restitution < 0.0 { return Err(PhysicsError::InvalidParameter); }
    Ok(())
}

fn validate_joint_def(def: &JointDef) -> Result<(), PhysicsError> {
    if !finite_vector(def.anchor_a) || !finite_vector(def.anchor_b) { return Err(PhysicsError::NotFinite); }
    let nonnegative = |values: &[f32]| -> Result<(), PhysicsError> {
        if values.iter().any(|v| !v.is_finite()) { return Err(PhysicsError::NotFinite); }
        if values.iter().any(|&v| v < 0.0) { return Err(PhysicsError::InvalidParameter); }
        Ok(())
    };
    let limits_and_motor = |limits: Option<(f32, f32)>, motor: Option<Motor>| -> Result<(), PhysicsError> {
        if let Some((lo, hi)) = limits {
            if !lo.is_finite() || !hi.is_finite() { return Err(PhysicsError::NotFinite); }
            if lo > hi { return Err(PhysicsError::InvalidParameter); }
        }
        if let Some(motor) = motor {
            if !motor.target_position.is_finite() || !motor.target_velocity.is_finite()
                || motor.max_force.is_nan() || motor.max_force == f32::NEG_INFINITY { return Err(PhysicsError::NotFinite); }
            nonnegative(&[motor.stiffness, motor.damping])?;
            // Positive infinity is the documented unbounded-force sentinel, including Motor::velocity's default.
            if motor.max_force < 0.0 { return Err(PhysicsError::InvalidParameter); }
        }
        Ok(())
    };
    match def.kind {
        JointKind::Revolute { limits, motor } => limits_and_motor(limits, motor),
        JointKind::Prismatic { axis, limits, motor } => {
            if !finite_vector(axis) { return Err(PhysicsError::NotFinite); }
            if axis.x == 0.0 && axis.y == 0.0 { return Err(PhysicsError::Degenerate); }
            limits_and_motor(limits, motor)
        }
        JointKind::Fixed { angle_a, angle_b } => {
            if [angle_a.c, angle_a.s, angle_b.c, angle_b.s].into_iter().any(|v| !v.is_finite()) { Err(PhysicsError::NotFinite) } else { Ok(()) }
        }
        JointKind::Rope { length } => nonnegative(&[length]),
        JointKind::Spring { rest_length, stiffness, damping } => nonnegative(&[rest_length, stiffness, damping]),
    }
}

/// The length of the gravity vector, for the solver's chain rule.
pub(crate) fn gravity_length(settings: &Settings) -> f32 {
    sqrt(settings.gravity.length_squared())
}
