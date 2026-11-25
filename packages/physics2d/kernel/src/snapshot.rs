// A snapshot of a world as bytes, and a world made from one. Every number is written as its bits, little endian, in a
// fixed order, so a world restored from a snapshot steps bit for bit as the one it was taken from would have: bodies,
// shapes, joints with their warm start, contacts with theirs, the fat boxes of the broad phase (a pair appears when
// boxes overlap, and the boxes only change when a shape leaves its own), free slots and the step counter.
use alloc::vec::Vec;
use margoengine_physics_kernel_common::broad::Bounds;

use crate::error::PhysicsError;
use crate::joint::{Joint, JointDef, JointKind, Motor};
use crate::manifold::{Manifold, ManifoldPoint};
use crate::math::{Rot, V2, Xf, v2};
use crate::shape::{Core, MAX_VERTICES};
use crate::world::{Body, BroadPhase, Contact, Event, EventKind, Kind, Settings, Shape, World};

const MAGIC: u32 = 0x3253_4e50; // "PNS2"
/// The version written. Versions 5 to 8 are still read: a version 5 motor has no per-mass word, a version below 7 no extra solid, a version below 8 no enabled flag, a version below 9 no angular speed limit, a version below 10 no extra solver passes, a version below 11 one continuous collision impact a step, a version below 12 the default continuous collision tolerances.
const VERSION: u32 = 12;

struct Writer(Vec<u8>);
impl Writer {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn bool(&mut self, v: bool) {
        self.0.push(v as u8);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.u32(v.to_bits());
    }
    fn f64(&mut self, v: f64) {
        self.u64(v.to_bits());
    }
    fn v2(&mut self, v: V2) {
        self.f32(v.x);
        self.f32(v.y);
    }
    fn rot(&mut self, q: Rot) {
        self.f32(q.c);
        self.f32(q.s);
    }
    fn opt_v2(&mut self, v: Option<V2>) {
        self.bool(v.is_some());
        self.v2(v.unwrap_or(V2::ZERO));
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    version: u32,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], PhysicsError> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.bytes.len()).ok_or(PhysicsError::InvalidParameter)?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, PhysicsError> {
        Ok(self.take(1)?[0])
    }
    fn bool(&mut self) -> Result<bool, PhysicsError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(PhysicsError::InvalidParameter),
        }
    }
    fn u32(&mut self) -> Result<u32, PhysicsError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, PhysicsError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, PhysicsError> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn f64(&mut self) -> Result<f64, PhysicsError> {
        Ok(f64::from_bits(self.u64()?))
    }
    fn v2(&mut self) -> Result<V2, PhysicsError> {
        Ok(v2(self.f32()?, self.f32()?))
    }
    fn rot(&mut self) -> Result<Rot, PhysicsError> {
        Ok(Rot { c: self.f32()?, s: self.f32()? })
    }
    fn opt_v2(&mut self) -> Result<Option<V2>, PhysicsError> {
        let some = self.bool()?;
        let v = self.v2()?;
        Ok(some.then_some(v))
    }
    /// A count that the rest of the bytes could hold at `each` bytes apiece: a corrupt length cannot make a huge list.
    fn count(&mut self, each: usize) -> Result<usize, PhysicsError> {
        let n = self.u32()? as usize;
        if n.checked_mul(each).is_none_or(|bytes| bytes > self.bytes.len() - self.at) {
            return Err(PhysicsError::InvalidParameter);
        }
        Ok(n)
    }
}

fn kind_code(k: Kind) -> u8 {
    match k {
        Kind::Static => 0,
        Kind::Kinematic => 1,
        Kind::Dynamic => 2,
    }
}

fn write_motor(w: &mut Writer, m: Option<Motor>) {
    w.bool(m.is_some());
    let m = m.unwrap_or(Motor { target_position: 0.0, target_velocity: 0.0, stiffness: 0.0, damping: 0.0, max_force: 0.0, per_mass: 0.0 });
    for v in [m.target_position, m.target_velocity, m.stiffness, m.damping, m.max_force, m.per_mass] {
        w.f32(v);
    }
}
fn read_motor(r: &mut Reader) -> Result<Option<Motor>, PhysicsError> {
    let some = r.bool()?;
    let m = Motor { target_position: r.f32()?, target_velocity: r.f32()?, stiffness: r.f32()?, damping: r.f32()?, max_force: r.f32()?, per_mass: if r.version >= 6 { r.f32()? } else { 0.0 } };
    Ok(some.then_some(m))
}
fn write_limits(w: &mut Writer, l: Option<(f32, f32)>) {
    w.bool(l.is_some());
    let (a, b) = l.unwrap_or((0.0, 0.0));
    w.f32(a);
    w.f32(b);
}
fn read_limits(r: &mut Reader) -> Result<Option<(f32, f32)>, PhysicsError> {
    let some = r.bool()?;
    let (a, b) = (r.f32()?, r.f32()?);
    Ok(some.then_some((a, b)))
}

impl World {
    /// The world as bytes: `World::from_snapshot` makes a world that steps exactly as this one would.
    pub fn snapshot(&self) -> Vec<u8> {
        let mut w = Writer(Vec::new());
        w.u32(MAGIC);
        w.u32(VERSION);
        let s = &self.settings;
        w.v2(s.gravity);
        w.u32(s.substeps);
        w.u32(s.passes);
        for v in [s.contact_hertz, s.contact_damping, s.contact_max_push, s.restitution_threshold, s.sleep_threshold, s.sleep_time] {
            w.f32(v);
        }
        w.bool(s.sleep);
        w.bool(s.block_solver);
        for v in [s.joint_hertz, s.joint_damping, s.joint_max_push] {
            w.f32(v);
        }
        w.bool(s.joint_geometric_stiffness);
        w.u8(matches!(s.broad_phase, BroadPhase::Sweep) as u8);
        w.bool(s.contact_lanes);
        w.u32(s.max_ccd_substeps);
        w.f32(s.min_ccd_dt);
        w.f32(s.ccd_tolerance);
        w.u32(s.ccd_max_advances);
        w.u64(self.steps);
        w.u32(self.bodies.len() as u32);
        for b in &self.bodies {
            w.u8(kind_code(b.kind));
            w.v2(b.xf.p);
            w.rot(b.xf.q);
            w.v2(b.center);
            w.v2(b.local_center);
            w.f64(b.exact_center[0]);
            w.f64(b.exact_center[1]);
            w.v2(b.linear_velocity);
            for v in [b.angular_velocity, b.mass, b.inv_mass, b.inertia, b.inv_inertia, b.extent, b.linear_damping, b.angular_damping, b.gravity_scale, b.additional_mass, b.torque, b.sleep_time, b.soft_ccd] {
                w.f32(v);
            }
            w.v2(b.force);
            w.bool(b.can_sleep);
            w.bool(b.fixed_rotation);
            w.bool(b.ccd);
            w.u8(b.dominance as u8);
            w.bool(b.next_target.is_some());
            let (p, q) = b.next_target.unwrap_or((V2::ZERO, Rot::IDENTITY));
            w.v2(p);
            w.rot(q);
            w.bool(b.awake);
            w.bool(b.dead);
            w.bool(b.enabled);
            w.f32(b.max_angular_speed);
            w.u32(b.extra_passes);
            let (extra_mass, extra_center, extra_inertia) = b.extra_solid.unwrap_or((0.0, V2::ZERO, 0.0));
            w.bool(b.extra_solid.is_some());
            w.f32(extra_mass);
            w.v2(extra_center);
            w.f32(extra_inertia);
            w.u32(b.shapes.len() as u32);
            for &id in &b.shapes {
                w.u32(id);
            }
        }
        w.u32(self.shapes.len() as u32);
        for (index, sh) in self.shapes.iter().enumerate() {
            w.u32(sh.body);
            w.u32(sh.core.count as u32);
            for i in 0..MAX_VERTICES {
                w.v2(sh.core.vertices[i]);
                w.v2(sh.core.normals[i]);
            }
            w.f32(sh.core.radius);
            for v in [sh.density, sh.friction, sh.restitution, sh.force_threshold] {
                w.f32(v);
            }
            w.opt_v2(sh.ghosts[0]);
            w.opt_v2(sh.ghosts[1]);
            w.bool(sh.chain);
            w.u32(sh.groups);
            w.u32(sh.solver_groups);
            w.bool(sh.sensor);
            w.u8(sh.events);
            w.u8(sh.active_types);
            w.bool(sh.one_sided);
            w.u8(sh.hooks);
            w.bool(sh.dead);
            // The fat box the broad phase keeps for it, which only changes when the shape leaves it.
            let fat = if sh.dead { None } else { self.broad_fat(index as u32) };
            w.bool(fat.is_some());
            let f = fat.unwrap_or(Bounds { min: [0.0; 2], max: [0.0; 2] });
            for v in [f.min[0], f.min[1], f.max[0], f.max[1]] {
                w.f32(v);
            }
            w.bool(sh.grid.is_some());
            if let Some(g) = &sh.grid {
                w.u32(g.cols);
                w.u32(g.rows);
                w.v2(g.cell);
                w.v2(g.origin);
                let bits = g.bits();
                w.u32(bits.len() as u32);
                for word in bits {
                    w.u32(word);
                }
            }
        }
        w.u32(self.joints.len() as u32);
        for (j, &id) in self.joints.iter().zip(&self.joint_ids) {
            w.u32(id);
            w.u32(j.def.a);
            w.u32(j.def.b);
            w.v2(j.def.anchor_a);
            w.v2(j.def.anchor_b);
            w.bool(j.def.collide);
            match j.def.kind {
                JointKind::Revolute { limits, motor } => {
                    w.u8(0);
                    write_limits(&mut w, limits);
                    write_motor(&mut w, motor);
                }
                JointKind::Prismatic { axis, limits, motor } => {
                    w.u8(1);
                    w.v2(axis);
                    write_limits(&mut w, limits);
                    write_motor(&mut w, motor);
                }
                JointKind::Fixed { angle_a, angle_b } => {
                    w.u8(2);
                    w.rot(angle_a);
                    w.rot(angle_b);
                }
                JointKind::Generic { lock_x, lock_y, lock_angle, frame_a, frame_b } => {
                    w.u8(5);
                    w.u8(lock_x as u8 | (lock_y as u8) << 1 | (lock_angle as u8) << 2);
                    w.rot(frame_a);
                    w.rot(frame_b);
                }
                JointKind::Rope { length } => {
                    w.u8(3);
                    w.f32(length);
                }
                JointKind::Spring { rest_length, stiffness, damping } => {
                    w.u8(4);
                    for v in [rest_length, stiffness, damping] {
                        w.f32(v);
                    }
                }
            }
            for v in [j.lock[0], j.lock[1], j.lock[2], j.lower, j.upper, j.motor] {
                w.f32(v);
            }
        }
        w.u32(self.joint_slot.len() as u32);
        for &slot in &self.joint_slot {
            w.u32(slot);
        }
        w.u32(self.contacts.len() as u32);
        for c in &self.contacts {
            w.u32(c.a);
            w.u32(c.b);
            w.v2(c.manifold.normal);
            w.u32(c.manifold.count as u32);
            for p in &c.manifold.points {
                w.v2(p.point);
                w.f32(p.separation);
                w.u32(p.id);
            }
            for v in [c.normal_impulse[0], c.normal_impulse[1], c.tangent_impulse[0], c.tangent_impulse[1], c.total_impulse] {
                w.f32(v);
            }
            w.bool(c.solved);
            w.bool(c.overlap);
            w.bool(c.primed);
            w.f32(c.tangent_speed);
            for o in [c.friction, c.restitution] {
                w.bool(o.is_some());
                w.f32(o.unwrap_or(0.0));
            }
        }
        for list in [&self.free_bodies, &self.free_shapes] {
            w.u32(list.len() as u32);
            for &id in list {
                w.u32(id);
            }
        }
        w.u32(self.pending_events.len() as u32);
        for e in &self.pending_events {
            w.u8((e.kind == EventKind::Started) as u8);
            w.u32(e.a);
            w.u32(e.b);
            w.bool(e.sensor);
        }
        w.0
    }

    /// A world made from `bytes`; the same bytes always make the same world. A truncated, altered or foreign snapshot is
    /// refused with `InvalidParameter`.
    pub fn from_snapshot(bytes: &[u8]) -> Result<World, PhysicsError> {
        let mut r = Reader { bytes, at: 0, version: 0 };
        let magic = r.u32()?;
        r.version = r.u32()?;
        if magic != MAGIC || !(5..=VERSION).contains(&r.version) {
            return Err(PhysicsError::InvalidParameter);
        }
        let gravity = r.v2()?;
        let (substeps, passes) = (r.u32()?, r.u32()?);
        let [contact_hertz, contact_damping, contact_max_push, restitution_threshold, sleep_threshold, sleep_time] =
            [r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?];
        let (sleep, block_solver) = (r.bool()?, r.bool()?);
        let [joint_hertz, joint_damping, joint_max_push] = [r.f32()?, r.f32()?, r.f32()?];
        let joint_geometric_stiffness = r.bool()?;
        let broad_phase = if r.u8()? == 1 { BroadPhase::Sweep } else { BroadPhase::Tree };
        let contact_lanes = r.bool()?;
        let max_ccd_substeps = if r.version >= 11 { r.u32()? } else { 1 };
        let (min_ccd_dt, ccd_tolerance, ccd_max_advances) = if r.version >= 12 { (r.f32()?, r.f32()?, r.u32()?) } else { (0.0, crate::shape::LINEAR_SLOP, 32) };
        let settings = Settings { gravity, substeps, passes, contact_hertz, contact_damping, contact_max_push, restitution_threshold, sleep_threshold, sleep_time, sleep, block_solver, joint_hertz, joint_damping, joint_max_push, joint_geometric_stiffness, broad_phase, contact_lanes, max_ccd_substeps, min_ccd_dt, ccd_tolerance, ccd_max_advances };
        let mut world = World::new(settings);
        world.steps = r.u64()?;
        let n = r.count(60)?;
        for _ in 0..n {
            let kind = match r.u8()? {
                0 => Kind::Static,
                1 => Kind::Kinematic,
                2 => Kind::Dynamic,
                _ => return Err(PhysicsError::InvalidParameter),
            };
            let xf = Xf { p: r.v2()?, q: r.rot()? };
            let (center, local_center) = (r.v2()?, r.v2()?);
            let exact_center = [r.f64()?, r.f64()?];
            let linear_velocity = r.v2()?;
            let [angular_velocity, mass, inv_mass, inertia, inv_inertia, extent, linear_damping, angular_damping, gravity_scale, additional_mass, torque, sleep_time, soft_ccd] =
                [r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?];
            let force = r.v2()?;
            let (can_sleep, fixed_rotation, ccd) = (r.bool()?, r.bool()?, r.bool()?);
            let dominance = r.u8()? as i8;
            let has_next = r.bool()?;
            let (np, nq) = (r.v2()?, r.rot()?);
            let (awake, dead) = (r.bool()?, r.bool()?);
            let enabled = if r.version >= 8 { r.bool()? } else { true };
            let max_angular_speed = if r.version >= 9 { r.f32()? } else { 0.0 };
            let extra_passes = if r.version >= 10 { r.u32()? } else { 0 };
            let extra_solid = if r.version >= 7 {
                let some = r.bool()?;
                let (m, c, i) = (r.f32()?, r.v2()?, r.f32()?);
                some.then_some((m, c, i))
            } else {
                None
            };
            let k = r.count(4)?;
            let mut shapes = Vec::with_capacity(k);
            for _ in 0..k {
                shapes.push(r.u32()?);
            }
            world.bodies.push(Body { kind, xf, center, local_center, exact_center, linear_velocity, angular_velocity, mass, inv_mass, inertia, inv_inertia, extent, linear_damping, angular_damping, gravity_scale, max_angular_speed, extra_passes, can_sleep, fixed_rotation, ccd, dominance, soft_ccd, additional_mass, extra_solid, force, torque, next_target: has_next.then_some((np, nq)), awake, enabled, sleep_time, shapes, dead });
        }
        let n = r.count(100)?;
        for id in 0..n {
            let body = r.u32()?;
            let count = r.u32()? as usize;
            if count > MAX_VERTICES || body as usize >= world.bodies.len() {
                return Err(PhysicsError::InvalidParameter);
            }
            let mut core = Core { count, vertices: [V2::ZERO; MAX_VERTICES], normals: [V2::ZERO; MAX_VERTICES], radius: 0.0 };
            for i in 0..MAX_VERTICES {
                core.vertices[i] = r.v2()?;
                core.normals[i] = r.v2()?;
            }
            core.radius = r.f32()?;
            let [density, friction, restitution, force_threshold] = [r.f32()?, r.f32()?, r.f32()?, r.f32()?];
            let ghosts = [r.opt_v2()?, r.opt_v2()?];
            let chain = r.bool()?;
            let (groups, solver_groups) = (r.u32()?, r.u32()?);
            let sensor = r.bool()?;
            let (events, active_types) = (r.u8()?, r.u8()?);
            let (one_sided, hooks, dead) = (r.bool()?, r.u8()?, r.bool()?);
            let has_fat = r.bool()?;
            let f = [r.f32()?, r.f32()?, r.f32()?, r.f32()?];
            let grid = if r.bool()? {
                let (cols, rows) = (r.u32()?, r.u32()?);
                let (cell, origin) = (r.v2()?, r.v2()?);
                let n = r.count(4)?;
                let mut bits = Vec::with_capacity(n);
                for _ in 0..n {
                    bits.push(r.u32()?);
                }
                Some(alloc::boxed::Box::new(crate::voxel::Grid::new(cols, rows, cell, origin, &bits).ok_or(PhysicsError::InvalidParameter)?))
            } else {
                None
            };
            if has_fat {
                world.broad_place_exact(id as u32, &Bounds { min: [f[0], f[1]], max: [f[2], f[3]] });
            }
            world.shapes.push(Shape { body, core, density, friction, restitution, ghosts, chain, groups, solver_groups, sensor, events, active_types, force_threshold, one_sided, hooks, grid, dead });
        }
        let n = r.count(40)?;
        for _ in 0..n {
            let (id, a, b) = (r.u32()?, r.u32()?, r.u32()?);
            let (anchor_a, anchor_b) = (r.v2()?, r.v2()?);
            let collide = r.bool()?;
            let kind = match r.u8()? {
                0 => JointKind::Revolute { limits: read_limits(&mut r)?, motor: read_motor(&mut r)? },
                1 => {
                    let axis = r.v2()?;
                    JointKind::Prismatic { axis, limits: read_limits(&mut r)?, motor: read_motor(&mut r)? }
                }
                2 => JointKind::Fixed { angle_a: r.rot()?, angle_b: r.rot()? },
                5 => {
                    let mask = r.u8()?;
                    JointKind::Generic { lock_x: mask & 1 != 0, lock_y: mask & 2 != 0, lock_angle: mask & 4 != 0, frame_a: r.rot()?, frame_b: r.rot()? }
                }
                3 => JointKind::Rope { length: r.f32()? },
                4 => JointKind::Spring { rest_length: r.f32()?, stiffness: r.f32()?, damping: r.f32()? },
                _ => return Err(PhysicsError::InvalidParameter),
            };
            let mut joint = Joint::new(JointDef { kind, a, b, anchor_a, anchor_b, collide });
            joint.lock = [r.f32()?, r.f32()?, r.f32()?];
            (joint.lower, joint.upper, joint.motor) = (r.f32()?, r.f32()?, r.f32()?);
            if a as usize >= world.bodies.len() || b as usize >= world.bodies.len() {
                return Err(PhysicsError::InvalidParameter);
            }
            world.joints.push(joint);
            world.joint_ids.push(id);
        }
        let n = r.count(4)?;
        for _ in 0..n {
            world.joint_slot.push(r.u32()?);
        }
        let n = r.count(60)?;
        for _ in 0..n {
            let (a, b) = (r.u32()?, r.u32()?);
            let normal = r.v2()?;
            let count = r.u32()? as usize;
            let mut points = [ManifoldPoint::default(); 2];
            for p in points.iter_mut() {
                *p = ManifoldPoint { point: r.v2()?, separation: r.f32()?, id: r.u32()? };
            }
            let [n0, n1, t0, t1, total_impulse] = [r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?];
            let (solved, overlap, primed) = (r.bool()?, r.bool()?, r.bool()?);
            let tangent_speed = r.f32()?;
            let mut over = [None; 2];
            for slot in over.iter_mut() {
                let some = r.bool()?;
                let v = r.f32()?;
                *slot = some.then_some(v);
            }
            if count > 2 || a as usize >= world.shapes.len() || b as usize >= world.shapes.len() {
                return Err(PhysicsError::InvalidParameter);
            }
            world.contacts.push(Contact { a, b, manifold: Manifold { normal, points, count }, normal_impulse: [n0, n1], tangent_impulse: [t0, t1], solved, overlap, primed, total_impulse, friction: over[0], restitution: over[1], tangent_speed });
        }
        for which in 0..2 {
            let n = r.count(4)?;
            let mut list = Vec::with_capacity(n);
            for _ in 0..n {
                list.push(r.u32()?);
            }
            if which == 0 { world.free_bodies = list } else { world.free_shapes = list }
        }
        let n = r.count(10)?;
        for _ in 0..n {
            let started = r.u8()? == 1;
            let (a, b, sensor) = (r.u32()?, r.u32()?, r.bool()?);
            world.pending_events.push(Event { kind: if started { EventKind::Started } else { EventKind::Stopped }, a, b, sensor });
        }
        if r.at != bytes.len() {
            return Err(PhysicsError::InvalidParameter);
        }
        // Everything that refers to something else must find it, so a stepped world cannot index out of its lists.
        let (nb, ns, nj) = (world.bodies.len(), world.shapes.len(), world.joints.len());
        let live_shape = |id: u32| world.shapes.get(id as usize).is_some_and(|s| !s.dead);
        if world.bodies.iter().enumerate().any(|(i, b)| b.shapes.iter().any(|&s| !live_shape(s) || world.shapes[s as usize].body as usize != i))
            || world.shapes.iter().any(|s| s.body as usize >= nb)
            || world.joint_slot.iter().any(|&slot| slot != u32::MAX && slot as usize >= nj)
            || world.joint_ids.iter().any(|&id| id as usize >= world.joint_slot.len())
            || world.contacts.iter().any(|c| c.a as usize >= ns || c.b as usize >= ns)
            || world.free_bodies.iter().any(|&id| id as usize >= nb)
            || world.free_shapes.iter().any(|&id| id as usize >= ns)
            || world.pending_events.iter().any(|e| e.a as usize >= ns || e.b as usize >= ns)
        {
            return Err(PhysicsError::InvalidHandle);
        }
        Ok(world)
    }
}
