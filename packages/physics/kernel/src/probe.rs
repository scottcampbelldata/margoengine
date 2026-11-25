// Particle probes for soft bodies: where a particle of radius r, moving from one position to another over a step, meets the
// colliders of the world. For each collider within reach, a sweep of a ball (van den Bergen 2004, the cast of cast.rs) gives
// the first touch, so a fast particle never tunnels; a particle that ends the move within reach of a surface, or inside a
// solid, gets the nearest point of the surface. Each contact is a plane (the point and the normal out of the collider) with the
// gap or depth to it, the velocity of the surface there (a rigid body's, and a deformable mesh's vertices') and the time of
// the touch. A soft solver asks once a step and applies the planes through its substeps, or asks again after it has moved
// the particle.
//
// The batch reads and writes two fixed buffers in the kernel's memory (`probe_input`, `probe_output`), so a soft solver fills
// a typed array over Wasm memory, makes one call, and reads another: no call a particle, no copy through the host.
use crate::cast::{CastOptions, Shape};
use crate::layout::*;
use crate::math::*;
use crate::query::Filter;
use crate::sat::Pose;
use crate::world::{NONE, World};

/// Particles one call takes.
pub const PROBE_MAX: usize = 1024;
/// Contacts a particle may be given at most.
pub const PROBE_K: usize = 4;
/// Words of an input record: x0, y0, z0 (where the particle was), x1, y1, z1 (where it ends), radius, margin (how far past its
/// radius a surface still counts: how far it can travel in the step), groups (as `collisionGroups` packs them, or all ones to
/// meet everything), the length of the step in seconds (0 to meet every collider where it is, not along its own motion), and two
/// spare.
pub const PROBE_IN_WORDS: usize = 12;
/// Words of an output record, a particle's K contacts each: collider (NONE for no contact), body, then as floats the fraction of
/// the move at which the touch happens, the unit normal out of the collider (x, y, z), the depth the end of the move is inside
/// the radius (negative: the gap still open), the point on the surface (x, y, z), the surface's velocity there (x, y, z), a
/// started flag, the triangle of a mesh it touches (NONE for none), and what the collider's surface is at the point (`face.rs`
/// `contact_feature`: -1 a flat face, else its radius of curvature).
pub const PROBE_OUT_WORDS: usize = 16;

/// What a particle's move meets.
#[derive(Clone, Copy, Debug)]
pub struct ParticleContact {
    pub collider: u32,
    /// The fraction of the move, from 0 to 1, at which the particle first touches; 1 for a particle that only ends the move
    /// within the collider's reach, 0 for one that starts touching.
    pub t: f32,
    /// The unit normal out of the collider at the touch.
    pub normal: V3,
    /// The point on the collider's surface.
    pub point: V3,
    /// How far the end of the move is inside the particle's radius from that surface, along the normal: push out by this when
    /// positive, a gap of this much still open when negative.
    pub depth: f32,
    pub started: bool,
}

impl World {
    /// The contact of a ball of `radius` moving from `from` to `to` with collider `c`, or None when the collider is further than
    /// `margin` past the radius at the end of the move and the sweep touches nothing. A collider whose body moves (`dt` seconds a
    /// step, at its linear and angular velocity) is met in its own frame: the contact's point and normal are in the collider's
    /// pose at the start of the step, and the surface goes on from there at the velocity `surface_velocity` gives.
    pub fn probe_collider(&self, c: usize, from: V3, to: V3, radius: f32, margin: f32, dt: f32) -> Option<ParticleContact> {
        let reach = radius + margin.max(0.0);
        let body = self.uu(COLLIDER_BODY, c) as usize;
        let (com, v, w) = (self.v(CENTER_X, body), self.v(LINEAR_X, body), self.v(ANGULAR_X, body));
        let moving = dt > 0.0 && self.flags(body) & KIND != FIXED && v.dot(v) + w.dot(w) > 1e-12;
        // The collider's box against the box of the move, grown by reach: most colliders end here. (A moving collider's box is
        // grown by how far it can reach in the step: its travel, and its spin about the centre of mass at its farthest point.)
        let (mut low, mut high) = (self.v(FAT_MIN_X, c), self.v(FAT_MAX_X, c));
        if moving {
            let far = high.sub(low).scale(0.5);
            let radius_of_box = length_of(far) + length_of(low.add(far).sub(com));
            let grow = (length_of(v) + length_of(w) * radius_of_box) * dt;
            low = low.sub(v3(grow, grow, grow));
            high = high.add(v3(grow, grow, grow));
        }
        let (lo, hi) = (from.min(to).sub(v3(reach, reach, reach)), from.max(to).add(v3(reach, reach, reach)));
        if low.x > hi.x || low.y > hi.y || low.z > hi.z || lo.x > high.x || lo.y > high.y || lo.z > high.z {
            return None;
        }
        // The particle at a fraction `t` of the step, in the collider's frame as it was at the start: the collider has moved by
        // its linear velocity and turned about its centre of mass by the first-order rotation of its angular velocity (the
        // pose update of the solver), so the particle is taken back by the same.
        let frame = |t: f32| -> V3 {
            let p = from.add(to.sub(from).scale(t));
            if !moving {
                return p;
            }
            let half = 0.5 * t * dt;
            let turn = Q { x: half * w.x, y: half * w.y, z: half * w.z, w: 1.0 }.normalized();
            turn.unrotate(p.sub(com).sub(v.scale(t * dt))).add(com)
        };
        let end = if moving { frame(1.0) } else { to };
        let step = end.sub(from);
        let length = sqrt(step.dot(step));
        // A ball that starts touching the collider, or inside its radius, has no sweep to make: the surface it touches is the one
        // nearest where it is now, on the side it started on, and the move says whether it goes into it. (A thin solid has two
        // faces; the end of the move may be nearer the far one, but the move came from the near one.)
        if let Some(start) = self.project_collider(c, from, false) {
            let offset = from.sub(start.point);
            let distance = sqrt(offset.dot(offset));
            let gap = if start.inside { -distance - radius } else { distance - radius };
            if gap <= 1e-5 * (1.0 + radius) {
                let away = if length > 1e-9 { step.scale(-1.0 / length) } else { v3(0.0, 1.0, 0.0) };
                let touching = distance <= 1e-5 * (1.0 + radius);
                let normal = match if touching { self.surface_normal(c, start.point) } else { None } {
                    Some(out) => out,
                    None if distance > 1e-9 => offset.scale(if start.inside { -1.0 } else { 1.0 } / distance),
                    None => away,
                };
                let depth = radius - end.sub(start.point).dot(normal);
                // Going into it, or still within reach at the end.
                if step.dot(normal) < 0.0 || depth > -margin.max(0.0) {
                    return Some(ParticleContact { collider: c as u32, t: 0.0, normal, point: start.point, depth, started: true });
                }
                return None;
            }
        }
        if moving {
            // Conservative advancement in the collider's frame (Mirtich 1996), as the halving of first_within: the signed gap
            // changes no faster than the particle's own speed plus the collider's, its linear speed and its spin at the farthest
            // the particle can be from the centre of mass.
            let reach_from_centre = {
                let (a, b) = (from.sub(com), to.sub(com));
                sqrt(a.dot(a)).max(sqrt(b.dot(b))) + sqrt(v.dot(v)) * dt
            };
            let speed = length_of(to.sub(from)) + (sqrt(v.dot(v)) + sqrt(w.dot(w)) * reach_from_centre) * dt;
            let gap_at = |t: f32| -> f32 {
                let q = frame(t);
                match self.project_collider(c, q, false) {
                    Some(nearest) => {
                        let d = length_of(q.sub(nearest.point));
                        if nearest.inside { -d - radius } else { d - radius }
                    }
                    None => f32::MAX,
                }
            };
            if let Some(t) = first_within(&gap_at, speed, 1e-6) {
                let q = frame(t);
                if let Some(nearest) = self.project_collider(c, q, false) {
                    let offset = q.sub(nearest.point);
                    let distance = length_of(offset);
                    let touching = distance <= 1e-5 * (1.0 + radius);
                    let normal = match if touching { self.surface_normal(c, nearest.point) } else { None } {
                        Some(out) => out,
                        None if distance > 1e-9 => offset.scale(if nearest.inside { -1.0 } else { 1.0 } / distance),
                        None => v3(0.0, 1.0, 0.0),
                    };
                    let depth = radius - end.sub(nearest.point).dot(normal);
                    return Some(ParticleContact { collider: c as u32, t, normal, point: nearest.point, depth, started: false });
                }
            }
        } else {
            let identity = Pose { p: from, q: Q::IDENTITY };
            let ball = Shape { kind: SHAPE_BALL, size: v3(radius, 0.0, 0.0), hull: 0, border: 0.0 };
            if length > 1e-9 && self.query_valid(ball, identity) {
                let direction = step.scale(1.0 / length);
                let options = CastOptions { max: length, target: 0.0, stop: true, geometry: false };
                if let Some(hit) = self.cast_collider(c, ball, identity, direction, &options) {
                    if !hit.started {
                        let depth = radius - to.sub(hit.on_target).dot(hit.normal);
                        return Some(ParticleContact { collider: c as u32, t: (hit.t / length).min(1.0), normal: hit.normal, point: hit.on_target, depth, started: false });
                    }
                }
            }
        }
        self.probe_overlap(c, end, radius, margin)
    }

    /// Where a ball of `radius` at `to` sits against collider `c`: within `margin` past its radius of the surface, or inside a
    /// solid. None when it is clear.
    fn probe_overlap(&self, c: usize, to: V3, radius: f32, margin: f32) -> Option<ParticleContact> {
        let nearest = self.project_collider(c, to, false)?;
        let offset = to.sub(nearest.point);
        let distance = sqrt(offset.dot(offset));
        let touching = distance <= 1e-5 * (1.0 + radius);
        let on_surface = if touching { self.surface_normal(c, nearest.point) } else { None };
        if nearest.inside {
            // From inside, out through the nearest face.
            let normal = on_surface.unwrap_or(if distance > 1e-9 { offset.scale(-1.0 / distance) } else { v3(0.0, 1.0, 0.0) });
            return Some(ParticleContact { collider: c as u32, t: 1.0, normal, point: nearest.point, depth: radius + distance, started: false });
        }
        if distance >= radius + margin.max(0.0) {
            return None;
        }
        let normal = on_surface.unwrap_or(if distance > 1e-9 { offset.scale(1.0 / distance) } else { v3(0.0, 1.0, 0.0) });
        Some(ParticleContact { collider: c as u32, t: 1.0, normal, point: nearest.point, depth: radius - distance, started: false })
    }

    /// The velocity of collider `c`'s surface at a world `point`: its body's linear velocity plus its spin about the centre of
    /// mass, and for a deformable mesh aimed for this step the motion of the triangle `triangle` besides. Also that triangle.
    pub fn surface_velocity(&self, c: usize, point: V3) -> (V3, u32) {
        let body = self.uu(COLLIDER_BODY, c) as usize;
        let r = point.sub(self.v(CENTER_X, body));
        let mut v = self.v(LINEAR_X, body).add(self.v(ANGULAR_X, body).cross(r));
        let mut triangle = NONE;
        if self.uu(COLLIDER_SHAPE, c) == SHAPE_TRIMESH {
            let mesh = self.uu(COLLIDER_HULL, c) as usize;
            if self.uu(MESH_FLAGS, mesh) & MESH_AIMED != 0 {
                let local = self.collider_pose(c).unapply(point);
                if let Some(t) = self.nearest_triangle(mesh, local) {
                    triangle = t as u32;
                    v = v.add(self.mesh_surface_velocity(c, t));
                }
            }
        }
        (v, triangle)
    }

    /// The outward normal of collider `c` at a point `at` on its surface, when it is an oriented mesh: the angle-weighted
    /// pseudonormal of the triangle, edge or corner the point is on (face.rs, `outward_normal`). A particle that touches
    /// such a mesh at no distance (a cut's two halves, each one's corners on the other's surface) has no offset to take a
    /// normal from, and the reverse of its own move, the fallback, pushed the two halves of a cut cube along each other.
    fn surface_normal(&self, c: usize, at: V3) -> Option<V3> {
        if self.uu(COLLIDER_SHAPE, c) != SHAPE_TRIMESH || self.is_round_triangle(c) {
            return None;
        }
        let mesh = self.uu(COLLIDER_HULL, c) as usize;
        if self.uu(MESH_FLAGS, mesh) & MESH_ORIENTED == 0 || self.grid_size(mesh).is_some() || self.is_voxels(mesh) {
            return None;
        }
        let pose = self.collider_pose(c);
        let local = pose.unapply(at);
        let t = self.nearest_triangle(mesh, local)?;
        let corners = self.triangle_corners(self.uu(MESH_FIRST_VERTEX, mesh) as usize, self.uu(MESH_FIRST_TRIANGLE, mesh) as usize + t);
        self.outward_normal(mesh, t as u32, crate::face::barycentric(local, corners), pose)
    }

    /// The triangle of a mesh nearest a point in the mesh's frame, by walking its tree nearest box first.
    fn nearest_triangle(&self, mesh: usize, p: V3) -> Option<usize> {
        let (n0, v0, t0) = (self.uu(MESH_FIRST_NODE, mesh) as usize, self.uu(MESH_FIRST_VERTEX, mesh) as usize, self.uu(MESH_FIRST_TRIANGLE, mesh) as usize);
        if self.uu(MESH_NODES, mesh) == 0 {
            return None;
        }
        let box_distance = |node: usize| {
            let (lo, hi) = (self.v(NODE_MIN_X, n0 + node), self.v(NODE_MAX_X, n0 + node));
            let d = lo.sub(p).max(v3(0.0, 0.0, 0.0)).max(p.sub(hi));
            d.dot(d)
        };
        let mut best: Option<(f32, usize)> = None;
        let mut stack = [0usize; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = stack[top];
            if best.is_some_and(|(b, _)| box_distance(node) > b) {
                continue;
            }
            let (first, count) = (self.uu(NODE_FIRST, n0 + node) as usize, self.uu(NODE_COUNT, n0 + node) as usize);
            if count == 0 {
                if top + 2 <= stack.len() {
                    stack[top] = first + 1;
                    stack[top + 1] = first;
                    top += 2;
                }
                continue;
            }
            for k in first..first + count {
                let t = self.uu(TRIANGLE_ORDER, t0 + k) as usize;
                let [a, b, c] = self.triangle_corners(v0, t0 + t);
                let d = closest_distance_squared(p, a, b, c);
                if best.is_none_or(|(b, _)| d < b) {
                    best = Some((d, t));
                }
            }
        }
        best.map(|(_, t)| t)
    }

    /// Every contact of a ball moving from `from` to `to` among the colliders `filter` lets through, nearest first (the most
    /// depth first), at most K of them, as `(contact, surface velocity, triangle)`.
    pub fn probe_particle(&self, from: V3, to: V3, radius: f32, margin: f32, dt: f32, filter: &Filter, out: &mut [(ParticleContact, V3, u32); PROBE_K]) -> usize {
        let mut count = 0;
        self.each_queried(filter, &mut |c| {
            if let Some(contact) = self.probe_collider(c, from, to, radius, margin, dt) {
                // Kept sorted by depth, deepest first; one past the last place falls off.
                let mut at = count.min(PROBE_K);
                while at > 0 && out[at - 1].0.depth < contact.depth {
                    at -= 1;
                }
                if at < PROBE_K {
                    let end = count.min(PROBE_K - 1);
                    for k in (at..end).rev() {
                        out[k + 1] = out[k];
                    }
                    let (velocity, triangle) = self.surface_velocity(c, contact.point);
                    out[at] = (contact, velocity, triangle);
                    if count < PROBE_K {
                        count += 1;
                    }
                }
            }
            true
        });
        count
    }
}

fn length_of(v: V3) -> f32 {
    sqrt(v.dot(v))
}

/// The first fraction of the step in [0, 1] at which `gap` is within `reach`, for a gap that changes by at most `speed` over
/// the whole step. An interval whose middle is further than reach plus what half the interval can change is dropped, the
/// others are halved, earliest first, down to a width below rounding (the inclusion search of cloth.rs).
pub(crate) fn first_within(gap: &dyn Fn(f32) -> f32, speed: f32, reach: f32) -> Option<f32> {
    let mut stack = [(0.0f32, 1.0f32); 80];
    let mut top = 1;
    while top > 0 {
        top -= 1;
        let (lo, hi) = stack[top];
        let half = 0.5 * (hi - lo);
        let mid = lo + half;
        if gap(mid) - half * speed > reach {
            continue;
        }
        if half < 1e-6 || top + 2 > stack.len() {
            return Some(lo);
        }
        stack[top] = (mid, hi);
        stack[top + 1] = (lo, mid);
        top += 2;
    }
    None
}

/// The squared distance from a point to a triangle (Ericson 5.1.5).
fn closest_distance_squared(p: V3, a: V3, b: V3, c: V3) -> f32 {
    let (ab, ac, ap) = (b.sub(a), c.sub(a), p.sub(a));
    let (d1, d2) = (ab.dot(ap), ac.dot(ap));
    let point = if d1 <= 0.0 && d2 <= 0.0 {
        a
    } else {
        let bp = p.sub(b);
        let (d3, d4) = (ab.dot(bp), ac.dot(bp));
        if d3 >= 0.0 && d4 <= d3 {
            b
        } else if d1 * d4 - d3 * d2 <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
            a.add(ab.scale(d1 / (d1 - d3)))
        } else {
            let cp = p.sub(c);
            let (d5, d6) = (ab.dot(cp), ac.dot(cp));
            if d6 >= 0.0 && d5 <= d6 {
                c
            } else if d5 * d2 - d1 * d6 <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                a.add(ac.scale(d2 / (d2 - d6)))
            } else if d3 * d6 - d5 * d4 <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
                b.add(c.sub(b).scale((d4 - d3) / ((d4 - d3) + (d5 - d6))))
            } else {
                let sum = (d3 * d6 - d5 * d4) + (d5 * d2 - d1 * d6) + (d1 * d4 - d3 * d2);
                let denominator = 1.0 / sum;
                a.add(ab.scale((d5 * d2 - d1 * d6) * denominator)).add(ac.scale((d1 * d4 - d3 * d2) * denominator))
            }
        }
    };
    let d = p.sub(point);
    d.dot(d)
}

#[cfg(target_arch = "wasm32")]
mod batch {
    use super::*;

    static mut PROBE_IN: [f32; PROBE_IN_WORDS * PROBE_MAX] = [0.0; PROBE_IN_WORDS * PROBE_MAX];
    static mut PROBE_OUT: [u32; PROBE_OUT_WORDS * PROBE_K * PROBE_MAX] = [0; PROBE_OUT_WORDS * PROBE_K * PROBE_MAX];

    /// Where the input records go.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_input() -> u32 {
        core::ptr::addr_of!(PROBE_IN) as u32
    }
    /// Where the output records are: K a particle, in the order of the input.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_output() -> u32 {
        core::ptr::addr_of!(PROBE_OUT) as u32
    }
    /// Particles one call takes.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_capacity() -> u32 {
        PROBE_MAX as u32
    }
    /// Contacts a particle gets at most.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_depth() -> u32 {
        PROBE_K as u32
    }

    /// Probes `count` particles, the records JS wrote at `probe_input`; the records at `probe_output` answer them, `k` for each
    /// (at most `probe_depth`). `flags` are a query filter's flags (see `query.rs`; sensors are always left out), `body` a body
    /// whose colliders are left out (NONE for none). Returns how many contacts were found, or -1 for a count or k past the
    /// capacity.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_probe(count: u32, k: u32, flags: u32, body: u32) -> i32 {
        if count as usize > PROBE_MAX || k as usize > PROBE_K || k == 0 {
            return -1;
        }
        let world = crate::api::world();
        let input = core::ptr::addr_of!(PROBE_IN) as *const f32;
        let output = core::ptr::addr_of_mut!(PROBE_OUT) as *mut u32;
        let mut found = 0;
        for i in 0..count as usize {
            // SAFETY: one thread, and i < PROBE_MAX keeps both records inside their buffers.
            let r = unsafe { core::slice::from_raw_parts(input.add(PROBE_IN_WORDS * i), PROBE_IN_WORDS) };
            let out = unsafe { core::slice::from_raw_parts_mut(output.add(PROBE_OUT_WORDS * k as usize * i), PROBE_OUT_WORDS * k as usize) };
            out.fill(0);
            for slot in 0..k as usize {
                out[PROBE_OUT_WORDS * slot] = NONE;
                out[PROBE_OUT_WORDS * slot + 1] = NONE;
                out[PROBE_OUT_WORDS * slot + 14] = NONE;
            }
            let finite = r[..8].iter().all(|v| v.is_finite());
            if !finite || !(r[6] >= 0.0) {
                continue;
            }
            let groups = r[8].to_bits();
            let filter = Filter { flags: flags | crate::query::EXCLUDE_SENSORS | crate::query::NO_GROUPS * (groups == u32::MAX) as u32, groups, collider: NONE, body };
            let mut list = [(ParticleContact { collider: NONE, t: 0.0, normal: v3(0.0, 0.0, 0.0), point: v3(0.0, 0.0, 0.0), depth: 0.0, started: false }, v3(0.0, 0.0, 0.0), NONE); PROBE_K];
            let n = world.probe_particle(v3(r[0], r[1], r[2]), v3(r[3], r[4], r[5]), r[6], r[7], r[9], &filter, &mut list).min(k as usize);
            for (slot, (c, v, triangle)) in list.iter().take(n).enumerate() {
                let base = PROBE_OUT_WORDS * slot;
                out[base] = c.collider;
                out[base + 1] = world.uu(COLLIDER_BODY, c.collider as usize);
                for (j, value) in [c.t, c.normal.x, c.normal.y, c.normal.z, c.depth, c.point.x, c.point.y, c.point.z, v.x, v.y, v.z].iter().enumerate() {
                    out[base + 2 + j] = value.to_bits();
                }
                out[base + 13] = c.started as u32;
                out[base + 14] = *triangle;
                out[base + 15] = world.contact_feature(c.collider as usize, c.point, c.normal).to_bits();
                found += 1;
            }
        }
        found
    }
}
