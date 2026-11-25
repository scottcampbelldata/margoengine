// Face probes for soft bodies: where a triangle of a cloth, moving corner by corner from one place to another over a step, meets
// the colliders of the world. A particle probe (probe.rs) meets what touches a cloth's corners; a body smaller than the spacing
// of the corners, or a thin one lying between them, touches the inside of a triangle, and only the triangle can hold it. The
// sheet is the triangles thickened by `thickness` on both sides (Bridson, Fedkiw and Anderson 2002, "Robust treatment of
// collisions, contact and friction for cloth animation", the proximity of a point and a triangle within the cloth's thickness;
// Mueller, Heidelberger, Hennix and Ratcliff 2007, "Position based dynamics", section 4.4, the point and triangle constraint
// with a thickness), so the corner balls of the particle probe and the faces here make one surface.
//
// For each collider within reach the triangle is met as it moves: in the collider's own frame at the start of the step (a
// moving body's motion is taken off the corners, as probe.rs takes it off a particle), the first fraction of the move at which
// the triangle comes within its thickness of the collider is found by conservative advancement on their distance (Mirtich 1996,
// "Impulse-based dynamic simulation of rigid body systems", the bound of probe.rs), so a fast triangle does not pass a thin
// body; a triangle that starts within its thickness is met where it is, and one that only ends within reach at the end. The
// distance is GJK's (van den Bergen 2004) and the points are the contact manifold of the triangle and each convex piece of the
// collider (smooth.rs), up to four, so a box lying on a triangle rests on it flat. Each contact is a point on the collider's
// surface with the normal out of it and the weights of the point of the triangle it faces (its barycentric coordinates), which
// a soft solver holds apart by the thickness at every substep, the reaction shared among the three corners by those weights
// (Shinar, Schroeder and Fedkiw 2008, "Two-way coupling of rigid and deformable bodies").
use crate::cast::Solid;
use crate::hull::BoxData;
use crate::layout::*;
use crate::math::*;
use crate::narrow::Manifold;
use crate::query::Filter;
use crate::smooth::collide_solids;
use crate::world::{NONE, World};

/// Triangles one call takes.
pub const FACE_MAX: usize = 1024;
/// Contacts a triangle may be given at most.
pub const FACE_K: usize = 4;
/// Words of an input record: the corners where they were (x, y, z three times), where they end (three times), the thickness,
/// the margin (how far past the thickness a surface still counts), the groups (as `collisionGroups` packs them, or all ones to
/// meet everything), the length of the step in seconds (0 to meet every collider where it is), and two spare.
pub const FACE_IN_WORDS: usize = 24;
/// Words of an output record, a triangle's K contacts each: collider (NONE for no contact), body, then as floats the fraction of
/// the move at which the touch happens, the unit normal out of the collider (x, y, z), the depth the end of the move is inside
/// the thickness (negative: the gap still open), the point on the collider's surface (x, y, z), the surface's velocity there
/// (x, y, z), the weights of the triangle's three corners at the point it faces, what the collider's surface is there
/// (`contact_feature`), and three spare.
pub const FACE_OUT_WORDS: usize = 20;

/// What a triangle's move meets at one point.
#[derive(Clone, Copy, Debug)]
pub struct FaceContact {
    pub collider: u32,
    /// The fraction of the move, from 0 to 1, at which the triangle first comes within its thickness; 0 for one that starts
    /// there, 1 for one that only ends within reach.
    pub t: f32,
    /// The unit normal out of the collider, toward the triangle.
    pub normal: V3,
    /// The point on the collider's surface, in its pose at the start of the step.
    pub point: V3,
    /// The weights of the corners at the point of the triangle that faces `point` (they add to 1).
    pub weights: [f32; 3],
    /// How far that point of the triangle, at the end of the move, is inside the thickness from the surface: push out by this
    /// when positive, a gap still open when negative.
    pub depth: f32,
    /// What the collider's surface is at the point (`contact_feature`): -1 flat, else its radius of curvature.
    pub curvature: f32,
}

impl FaceContact {
    pub const NONE: FaceContact = FaceContact { collider: NONE, t: 0.0, normal: V3 { x: 0.0, y: 0.0, z: 0.0 }, point: V3 { x: 0.0, y: 0.0, z: 0.0 }, weights: [0.0; 3], depth: 0.0, curvature: 0.0 };
}

impl World {
    /// What collider `c`'s surface is at `point` (on it, `normal` out of it), for a solver that holds a contact found there through
    /// a step while the body moves: `-1` for a flat face (the contact is the plane through the point, which turns with the body,
    /// and a thing on it is held where it stands), else the radius of the sphere that fits the surface there, whose centre
    /// `point - radius * normal` is fixed in the body (a thing is held that far from the centre, along the line to it): a ball's
    /// or a capsule's radius, the rounding of a rounded shape's corners and edges, the distance along the normal to the axis on
    /// the curved side of a cylinder or a cone (the normal of a surface of revolution meets its axis), and 0 at a sharp corner or
    /// edge. Either way the push on the body and the push on the thing it meets lie on one line, so the contact gives the body no
    /// turn it does not give the thing (the centre of curvature of a contact: do Carmo 1976, "Differential geometry of curves and
    /// surfaces", 3.2; Kerr and Roth 1986, "Analysis of multifingered hands", for rolling contact described by it). A face is
    /// told from an edge or a corner by where the shape's support goes as the direction turns a little about the normal: over a
    /// face it moves in two directions, along an edge in one, at a corner not at all.
    pub fn contact_feature(&self, c: usize, point: V3, normal: V3) -> f32 {
        let kind = self.uu(COLLIDER_SHAPE, c);
        if kind == SHAPE_COMPOUND {
            // The child whose surface is nearest the point.
            let (mut best, mut found) = (f32::MAX, -1.0);
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != NONE {
                if let Some(hit) = self.project_collider(child as usize, point, false) {
                    let d = length(hit.point.sub(point));
                    if d < best {
                        best = d;
                        found = self.contact_feature(child as usize, point, normal);
                    }
                }
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return found;
        }
        let size = self.v(COLLIDER_A, c);
        let border = self.s(COLLIDER_BORDER, c).max(0.0);
        match kind {
            SHAPE_HALFSPACE => -1.0,
            SHAPE_BALL | SHAPE_CAPSULE => size.x,
            SHAPE_CYLINDER | SHAPE_CONE => {
                // In the shape's frame, its axis along y: the curved side's normal leans off the axis and meets it; a cap is flat
                // inside its rim.
                let pose = self.collider_pose(c);
                let (at, n) = (pose.unapply(point), pose.q.unrotate(normal));
                let across = sqrt(n.x * n.x + n.z * n.z);
                let out = sqrt(at.x * at.x + at.z * at.z);
                if across > 0.5 {
                    out / across
                } else {
                    // The cap's rim is where the radius there is reached: the cylinder's radius, a cone's at the cap (its base).
                    let rim = size.x;
                    if out + border < rim * (1.0 - 1e-4) { -1.0 } else { border }
                }
            }
            _ => {
                // A box, a hull, a rounded one, or a part of a mesh, height field or voxel grid: the convex piece under the point,
                // its core (the shape without its rounding), and how its support moves.
                let reach = v3(1e-3, 1e-3, 1e-3);
                let core_point = point.sub(normal.scale(border));
                let mut feature = border;
                let mut best = f32::MAX;
                self.each_piece_near(c, core_point.sub(reach), core_point.add(reach), &mut |piece| {
                    let core = match *piece {
                        Solid::RoundPoly { poly, pose, .. } => Solid::Poly { poly, pose },
                        Solid::RoundTriangle(corners, _) => Solid::Triangle(corners),
                        other => other,
                    };
                    let on = crate::gjk::Convex::support(&core, normal);
                    // The piece the point lies on: its support toward what it meets is level with the point.
                    let gap = (normal.dot(core_point.sub(on))).abs();
                    if gap < best {
                        best = gap;
                        feature = if flat_at(&core, normal) { -1.0 } else { border };
                    }
                });
                feature
            }
        }
    }

    /// Calls `visit` with each convex piece of collider `c` in the world whose box may reach the box `low` to `high`: a convex
    /// collider's solid, each child of a compound, each triangle or cell of a mesh, height field or voxel grid near the box. A
    /// half space has none: its deepest point under a triangle is always a corner, which the particle probe meets.
    fn each_piece_near(&self, c: usize, low: V3, high: V3, visit: &mut dyn FnMut(&Solid)) {
        let kind = self.uu(COLLIDER_SHAPE, c);
        if kind == SHAPE_COMPOUND {
            let mut child = self.uu(COLLIDER_HULL, c);
            while child != NONE {
                let (lo, hi) = self.reach(child as usize, 0.0);
                if !(lo.x > high.x || lo.y > high.y || lo.z > high.z || hi.x < low.x || hi.y < low.y || hi.z < low.z) {
                    self.each_piece_near(child as usize, low, high, visit);
                }
                child = self.uu(COLLIDER_NEXT, child as usize);
            }
            return;
        }
        if kind == SHAPE_HALFSPACE {
            return;
        }
        if kind == SHAPE_TRIMESH && !self.is_round_triangle(c) {
            // The box in the mesh's own frame: the box around the eight corners of the world box taken into it.
            let frame = self.collider_pose(c);
            let (mut lo, mut hi) = (v3(f32::MAX, f32::MAX, f32::MAX), v3(f32::MIN, f32::MIN, f32::MIN));
            for corner in 0..8 {
                let p = v3(if corner & 1 == 0 { low.x } else { high.x }, if corner & 2 == 0 { low.y } else { high.y }, if corner & 4 == 0 { low.z } else { high.z });
                let local = frame.unapply(p);
                lo = lo.min(local);
                hi = hi.max(local);
            }
            self.each_part(self.uu(COLLIDER_HULL, c) as usize, (lo, hi), &|a, b| !(a.x > hi.x || a.y > hi.y || a.z > hi.z || b.x < lo.x || b.y < lo.y || b.z < lo.z), &mut |part| {
                visit(&crate::soup::placed(&part, frame));
                true
            });
            return;
        }
        let mut data = BoxData::new();
        if let Some(solid) = self.solid(self.shape_of(c), self.collider_pose(c), &mut data) {
            visit(&solid);
        }
    }

    /// The contacts of a triangle of `thickness` moving corner by corner from `from` to `to` with collider `c`, deepest first, at
    /// most `FACE_K`, into `out`; how many. None when the collider stays further than `margin` past the thickness and the move
    /// never brings them within it. A collider whose body moves (`dt` seconds a step) is met in its own frame, as `probe_collider`
    /// meets one: the contacts' points and normals are in its pose at the start of the step.
    pub fn probe_face(&self, c: usize, from: [V3; 3], to: [V3; 3], thickness: f32, margin: f32, dt: f32, out: &mut [FaceContact; FACE_K]) -> usize {
        if self.uu(COLLIDER_SHAPE, c) == SHAPE_HALFSPACE {
            return 0;
        }
        let reach = thickness + margin.max(0.0);
        let body = self.uu(COLLIDER_BODY, c) as usize;
        let (com, v, w) = (self.v(CENTER_X, body), self.v(LINEAR_X, body), self.v(ANGULAR_X, body));
        let moving = dt > 0.0 && self.flags(body) & KIND != FIXED && v.dot(v) + w.dot(w) > 1e-12;
        let (mut low, mut high) = (self.v(FAT_MIN_X, c), self.v(FAT_MAX_X, c));
        if moving {
            let far = high.sub(low).scale(0.5);
            let radius_of_box = length(far) + length(low.add(far).sub(com));
            let grow = (length(v) + length(w) * radius_of_box) * dt;
            low = low.sub(v3(grow, grow, grow));
            high = high.add(v3(grow, grow, grow));
        }
        let (mut lo, mut hi) = (from[0], from[0]);
        for p in from.iter().chain(to.iter()) {
            lo = lo.min(*p);
            hi = hi.max(*p);
        }
        let (lo, hi) = (lo.sub(v3(reach, reach, reach)), hi.add(v3(reach, reach, reach)));
        if low.x > hi.x || low.y > hi.y || low.z > hi.z || lo.x > high.x || lo.y > high.y || lo.z > high.z {
            return 0;
        }
        // A corner at a fraction `t` of the step, in the collider's frame as it was at the start (probe.rs `frame`).
        let frame = |p0: V3, p1: V3, t: f32| -> V3 {
            let p = p0.add(p1.sub(p0).scale(t));
            if !moving {
                return p;
            }
            let half = 0.5 * t * dt;
            let turn = Q { x: half * w.x, y: half * w.y, z: half * w.z, w: 1.0 }.normalized();
            turn.unrotate(p.sub(com).sub(v.scale(t * dt))).add(com)
        };
        let triangle = |t: f32| -> [V3; 3] { [frame(from[0], to[0], t), frame(from[1], to[1], t), frame(from[2], to[2], t)] };
        // Every piece of the collider that the triangle can reach over the step, in the collider's frame at the start: the box of
        // the corners there through the move.
        let (mut plo, mut phi) = (v3(f32::MAX, f32::MAX, f32::MAX), v3(f32::MIN, f32::MIN, f32::MIN));
        for t in [0.0, 0.5, 1.0] {
            for p in triangle(t) {
                plo = plo.min(p);
                phi = phi.max(p);
            }
        }
        let spread = if moving { length(v) * dt + length(w) * dt * (length(phi.sub(plo)) + length(plo.sub(com))) } else { 0.0 };
        let (plo, phi) = (plo.sub(v3(reach + spread, reach + spread, reach + spread)), phi.add(v3(reach + spread, reach + spread, reach + spread)));
        // The gap from the triangle at `t` to the nearest piece, less the thickness.
        let gap_at = |t: f32| -> f32 {
            let face = Solid::Triangle(triangle(t));
            let mut best = f32::MAX;
            self.each_piece_near(c, plo, phi, &mut |piece| {
                let (d, _, _) = Self::solid_distance(&face, piece);
                if d < best {
                    best = d;
                }
            });
            best - thickness
        };
        let start = gap_at(0.0);
        if start == f32::MAX - thickness {
            return 0;
        }
        let end = triangle(1.0);
        let touch = if start <= 1e-5 * (1.0 + thickness) {
            Some(0.0)
        } else {
            // How fast the gap can close: the fastest corner in the collider's frame, at most.
            let mut speed = 0.0f32;
            let first = triangle(0.0);
            for k in 0..3 {
                speed = speed.max(length(end[k].sub(first[k])));
            }
            if moving {
                let mut far = 0.0f32;
                for p in from.iter().chain(to.iter()) {
                    far = far.max(length(p.sub(com)));
                }
                speed += (length(v) + length(w) * (far + length(v) * dt)) * dt;
            }
            match first_within(&gap_at, speed, 1e-6) {
                Some(t) => Some(t),
                None if gap_at(1.0) < margin.max(0.0) => Some(1.0),
                None => None,
            }
        };
        let Some(t) = touch else { return 0 };
        // The manifold of the triangle there with each piece: points on both, the normal from the triangle to the piece.
        let at = triangle(t);
        let face = Solid::Triangle(at);
        let mut count = 0;
        let mut manifold = Manifold::new();
        // A first touch is found to within a millionth of the thickness; the manifold takes it in.
        let limit = reach + 1e-5 * (1.0 + reach);
        self.each_piece_near(c, plo, phi, &mut |piece| {
            collide_solids(&face, piece, limit, &mut manifold);
            for k in 0..manifold.count {
                let point = manifold.points[k];
                let normal = manifold.normal.scale(-1.0);
                let weights = barycentric(point.on_a, at);
                let facing = end[0].scale(weights[0]).add(end[1].scale(weights[1])).add(end[2].scale(weights[2]));
                let depth = thickness - facing.sub(point.on_b).dot(normal);
                let curvature = self.contact_feature(c, point.on_b, normal);
                let contact = FaceContact { collider: c as u32, t, normal, point: point.on_b, weights, depth, curvature };
                // Kept sorted by depth, deepest first; one past the last place falls off.
                let mut place = count.min(FACE_K);
                while place > 0 && out[place - 1].depth < depth {
                    place -= 1;
                }
                if place < FACE_K {
                    let last = count.min(FACE_K - 1);
                    for j in (place..last).rev() {
                        out[j + 1] = out[j];
                    }
                    out[place] = contact;
                    if count < FACE_K {
                        count += 1;
                    }
                }
            }
        });
        count
    }

    /// Every contact of a moving triangle among the colliders `filter` lets through, deepest first, at most K, as
    /// `(contact, surface velocity)`.
    pub fn probe_triangle(&self, from: [V3; 3], to: [V3; 3], thickness: f32, margin: f32, dt: f32, filter: &Filter, out: &mut [(FaceContact, V3); FACE_K]) -> usize {
        let mut count = 0;
        let mut found = [FaceContact::NONE; FACE_K];
        self.each_queried(filter, &mut |c| {
            let n = self.probe_face(c, from, to, thickness, margin, dt, &mut found);
            for contact in found.iter().take(n) {
                let mut place = count.min(FACE_K);
                while place > 0 && out[place - 1].0.depth < contact.depth {
                    place -= 1;
                }
                if place < FACE_K {
                    let last = count.min(FACE_K - 1);
                    for j in (place..last).rev() {
                        out[j + 1] = out[j];
                    }
                    let (velocity, _) = self.surface_velocity(c, contact.point);
                    out[place] = (*contact, velocity);
                    if count < FACE_K {
                        count += 1;
                    }
                }
            }
            true
        });
        count
    }
}

fn length(v: V3) -> f32 {
    sqrt(v.dot(v))
}

/// The weights of the corners of triangle `t` at a point `p` on it (Ericson 2005, "Real-Time Collision Detection", 3.4), kept
/// inside the triangle and adding to 1; the nearest corner's for a triangle with no area.
fn barycentric(p: V3, t: [V3; 3]) -> [f32; 3] {
    let (e0, e1, d) = (t[1].sub(t[0]), t[2].sub(t[0]), p.sub(t[0]));
    let (d00, d01, d11, d20, d21) = (e0.dot(e0), e0.dot(e1), e1.dot(e1), d.dot(e0), d.dot(e1));
    let denominator = d00 * d11 - d01 * d01;
    if !(denominator > 1e-20 * (d00 * d11).max(1e-30)) {
        let distances = [length(p.sub(t[0])), length(p.sub(t[1])), length(p.sub(t[2]))];
        let nearest = if distances[0] <= distances[1] && distances[0] <= distances[2] { 0 } else if distances[1] <= distances[2] { 1 } else { 2 };
        let mut w = [0.0; 3];
        w[nearest] = 1.0;
        return w;
    }
    let b = (d11 * d20 - d01 * d21) / denominator;
    let c = (d00 * d21 - d01 * d20) / denominator;
    let w = [(1.0 - b - c).max(0.0), b.max(0.0), c.max(0.0)];
    let sum = w[0] + w[1] + w[2];
    [w[0] / sum, w[1] / sum, w[2] / sum]
}

/// Whether a convex shape's support along `normal` (out of it, toward what it meets) is a face: turned a twentieth of a radian
/// either way about two axes across the normal, the support moves over the face in both, along an edge in one, and stays at a
/// corner.
fn flat_at(core: &Solid, normal: V3) -> bool {
    let away = normal;
    let t1 = if normal.x.abs() < 0.6 { v3(1.0, 0.0, 0.0) } else { v3(0.0, 1.0, 0.0) };
    let t1 = t1.sub(normal.scale(t1.dot(normal)));
    let t1 = t1.scale(1.0 / length(t1));
    let t2 = normal.cross(t1);
    let s = |d: V3| crate::gjk::Convex::support(core, d);
    let spread = |t: V3| {
        let (a, b) = (s(away.add(t.scale(0.05))), s(away.sub(t.scale(0.05))));
        let (c, d) = (s(away.add(t.cross(normal).scale(0.05))), s(away.sub(t.cross(normal).scale(0.05))));
        let along = [a.dot(t), b.dot(t), c.dot(t), d.dot(t)];
        let (mut lo, mut hi) = (along[0], along[0]);
        for v in along {
            lo = lo.min(v);
            hi = hi.max(v);
        }
        hi - lo
    };
    // Over a face both spreads are the face's breadths; along an edge one is the edge's length and the other rounding; at a corner
    // both are rounding (a millionth of the coordinates, so a thousandth of the larger spread or a hundred thousandth of the
    // coordinates tells them apart).
    let (a, b) = (spread(t1), spread(t2));
    let (small, large) = if a < b { (a, b) } else { (b, a) };
    small > 1e-3 * large && small > 1e-5 * (1.0 + length(s(away)))
}

/// The first fraction of the step at which `gap` is within `reach` (probe.rs).
fn first_within(gap: &dyn Fn(f32) -> f32, speed: f32, reach: f32) -> Option<f32> {
    crate::probe::first_within(gap, speed, reach)
}

#[cfg(target_arch = "wasm32")]
mod batch {
    use super::*;

    static mut FACE_IN: [f32; FACE_IN_WORDS * FACE_MAX] = [0.0; FACE_IN_WORDS * FACE_MAX];
    static mut FACE_OUT: [u32; FACE_OUT_WORDS * FACE_K * FACE_MAX] = [0; FACE_OUT_WORDS * FACE_K * FACE_MAX];

    /// Where the input records go.
    #[unsafe(no_mangle)]
    pub extern "C" fn face_input() -> u32 {
        core::ptr::addr_of!(FACE_IN) as u32
    }
    /// Where the output records are: K a triangle, in the order of the input.
    #[unsafe(no_mangle)]
    pub extern "C" fn face_output() -> u32 {
        core::ptr::addr_of!(FACE_OUT) as u32
    }
    /// Triangles one call takes.
    #[unsafe(no_mangle)]
    pub extern "C" fn face_capacity() -> u32 {
        FACE_MAX as u32
    }

    /// Probes `count` triangles, the records JS wrote at `face_input`; the records at `face_output` answer them, `k` for each (at
    /// most `FACE_K`). `flags` are a query filter's flags (sensors are always left out), `body` a body whose colliders are left out
    /// (NONE for none). Returns how many contacts were found, or -1 for a count or k past the capacity.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_probe_faces(count: u32, k: u32, flags: u32, body: u32) -> i32 {
        if count as usize > FACE_MAX || k as usize > FACE_K || k == 0 {
            return -1;
        }
        let world = crate::api::world();
        let input = core::ptr::addr_of!(FACE_IN) as *const f32;
        let output = core::ptr::addr_of_mut!(FACE_OUT) as *mut u32;
        let mut found = 0;
        for i in 0..count as usize {
            // SAFETY: one thread, and i < FACE_MAX keeps both records inside their buffers.
            let r = unsafe { core::slice::from_raw_parts(input.add(FACE_IN_WORDS * i), FACE_IN_WORDS) };
            let out = unsafe { core::slice::from_raw_parts_mut(output.add(FACE_OUT_WORDS * k as usize * i), FACE_OUT_WORDS * k as usize) };
            out.fill(0);
            for slot in 0..k as usize {
                out[FACE_OUT_WORDS * slot] = NONE;
                out[FACE_OUT_WORDS * slot + 1] = NONE;
            }
            if !r[..20].iter().all(|v| v.is_finite()) || !(r[18] >= 0.0) {
                continue;
            }
            let corner = |at: usize| v3(r[at], r[at + 1], r[at + 2]);
            let groups = r[20].to_bits();
            let filter = Filter { flags: flags | crate::query::EXCLUDE_SENSORS | crate::query::NO_GROUPS * (groups == u32::MAX) as u32, groups, collider: NONE, body };
            let mut list = [(FaceContact::NONE, v3(0.0, 0.0, 0.0)); FACE_K];
            let n = world
                .probe_triangle([corner(0), corner(3), corner(6)], [corner(9), corner(12), corner(15)], r[18], r[19], r[21], &filter, &mut list)
                .min(k as usize);
            for (slot, (c, v)) in list.iter().take(n).enumerate() {
                let base = FACE_OUT_WORDS * slot;
                out[base] = c.collider;
                out[base + 1] = world.uu(COLLIDER_BODY, c.collider as usize);
                for (j, value) in [c.t, c.normal.x, c.normal.y, c.normal.z, c.depth, c.point.x, c.point.y, c.point.z, v.x, v.y, v.z, c.weights[0], c.weights[1], c.weights[2], c.curvature].iter().enumerate() {
                    out[base + 2 + j] = value.to_bits();
                }
                found += 1;
            }
        }
        found
    }
}
