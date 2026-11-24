// Particle probes for soft bodies: where a particle of radius r, moving from one position to another over a step, meets the
// colliders of the world. A sweep of a ball (van den Bergen 2004, the cast of cast.rs) gives the first touch, so a fast particle
// never tunnels; a particle that ends the move inside a collider's reach, or starts in contact, gets the nearest point of the
// surface and the depth. One contact a particle: the solver asks again after it has moved the particle, which finds the next
// one in a corner.
//
// The batch reads and writes two fixed buffers in the kernel's memory (`probe_input`, `probe_output`), so a soft solver fills
// a typed array over Wasm memory, makes one call, and reads another: no call a particle, no copy through the host.
use crate::cast::{CastOptions, Shape};
use crate::layout::*;
use crate::math::*;
use crate::query::Filter;
use crate::sat::Pose;
use crate::world::World;

/// Particles one call takes.
pub const PROBE_MAX: usize = 4096;
/// Words of an input record: x0, y0, z0, x1, y1, z1, radius, one spare.
pub const PROBE_IN_WORDS: usize = 8;
/// Words of an output record: collider (NONE for no contact), body, then as floats: the fraction of the move at which the
/// touch happens (0 to 1), the unit normal out of the collider (x, y, z), the depth the move's end is inside the radius
/// (positive: push out along the normal by that much), the point on the collider's surface (x, y, z), a started flag.
pub const PROBE_OUT_WORDS: usize = 12;

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
    /// How far the end of the move is inside the particle's radius from that surface, along the normal: push out by this
    /// when positive, nothing to do when not.
    pub depth: f32,
    pub started: bool,
}

impl World {
    /// The first contact of a ball of `radius` moving from `from` to `to` among the colliders `filter` lets through, or None
    /// when it meets nothing and ends clear of everything.
    pub fn probe_particle(&self, from: V3, to: V3, radius: f32, filter: &Filter) -> Option<ParticleContact> {
        let step = to.sub(from);
        let length = sqrt(step.dot(step));
        let identity = Pose { p: from, q: Q::IDENTITY };
        let ball = Shape { kind: SHAPE_BALL, size: v3(radius, 0.0, 0.0), hull: 0, border: 0.0 };
        if length > 1e-9 && self.query_valid(ball, identity) {
            let direction = step.scale(1.0 / length);
            let options = CastOptions { max: length, target: 0.0, stop: true, geometry: false };
            if let Some((collider, hit)) = self.cast_shape(ball, identity, direction, &options, filter) {
                if hit.started {
                    // Touching at the start: the end of the move says whether it still is, and where the surface is.
                    return self.probe_overlap(to, radius, filter).map(|c| ParticleContact { t: 0.0, started: true, ..c });
                }
                let depth = radius - to.sub(hit.on_target).dot(hit.normal);
                return Some(ParticleContact { collider, t: (hit.t / length).min(1.0), normal: hit.normal, point: hit.on_target, depth, started: false });
            }
        }
        self.probe_overlap(to, radius, filter)
    }

    /// Where a ball of `radius` at `at` sits against the nearest collider within its reach, or inside a solid: the point on the
    /// surface, the normal out of it and the depth. None when it is clear of everything.
    fn probe_overlap(&self, to: V3, radius: f32, filter: &Filter) -> Option<ParticleContact> {
        let (collider, nearest) = self.project_point(to, false, filter)?;
        let offset = to.sub(nearest.point);
        let distance = sqrt(offset.dot(offset));
        if nearest.inside {
            // From inside, out through the nearest face.
            let normal = if distance > 1e-9 { offset.scale(-1.0 / distance) } else { v3(0.0, 1.0, 0.0) };
            return Some(ParticleContact { collider, t: 1.0, normal, point: nearest.point, depth: radius + distance, started: false });
        }
        if distance >= radius {
            return None;
        }
        let normal = if distance > 1e-9 { offset.scale(1.0 / distance) } else { v3(0.0, 1.0, 0.0) };
        Some(ParticleContact { collider, t: 1.0, normal, point: nearest.point, depth: radius - distance, started: false })
    }
}

#[cfg(target_arch = "wasm32")]
mod batch {
    use super::*;
    use crate::layout::*;
    use crate::world::NONE;

    static mut PROBE_IN: [f32; PROBE_IN_WORDS * PROBE_MAX] = [0.0; PROBE_IN_WORDS * PROBE_MAX];
    static mut PROBE_OUT: [u32; PROBE_OUT_WORDS * PROBE_MAX] = [0; PROBE_OUT_WORDS * PROBE_MAX];

    /// Where the input records go.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_input() -> u32 {
        core::ptr::addr_of!(PROBE_IN) as u32
    }
    /// Where the output records are.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_output() -> u32 {
        core::ptr::addr_of!(PROBE_OUT) as u32
    }
    /// Particles one call takes.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_capacity() -> u32 {
        PROBE_MAX as u32
    }

    /// Probes `count` particles, the records JS wrote at `probe_input`; the records at `probe_output` answer them one for one.
    /// `flags` and `groups` are a query filter's (see `query.rs`), `body` a body whose colliders are left out (NONE for none).
    /// Returns how many particles touch something, or -1 for a count past the capacity.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_probe(count: u32, flags: u32, groups: u32, body: u32) -> i32 {
        if count as usize > PROBE_MAX {
            return -1;
        }
        let world = crate::api::world();
        let filter = Filter { flags, groups, collider: NONE, body };
        let input = core::ptr::addr_of!(PROBE_IN) as *const f32;
        let output = core::ptr::addr_of_mut!(PROBE_OUT) as *mut u32;
        let mut touching = 0;
        for i in 0..count as usize {
            // SAFETY: one thread, and i < PROBE_MAX keeps both records inside their buffers.
            let r = unsafe { core::slice::from_raw_parts(input.add(PROBE_IN_WORDS * i), PROBE_IN_WORDS) };
            let (from, to, radius) = (v3(r[0], r[1], r[2]), v3(r[3], r[4], r[5]), r[6]);
            let out = unsafe { core::slice::from_raw_parts_mut(output.add(PROBE_OUT_WORDS * i), PROBE_OUT_WORDS) };
            out.fill(0);
            out[0] = NONE;
            out[1] = NONE;
            let finite = [r[0], r[1], r[2], r[3], r[4], r[5], radius].iter().all(|v| v.is_finite());
            if !finite || !(radius >= 0.0) {
                continue;
            }
            if let Some(c) = world.probe_particle(from, to, radius, &filter) {
                touching += 1;
                out[0] = c.collider;
                out[1] = world.uu(COLLIDER_BODY, c.collider as usize);
                for (k, v) in [c.t, c.normal.x, c.normal.y, c.normal.z, c.depth, c.point.x, c.point.y, c.point.z].iter().enumerate() {
                    out[2 + k] = v.to_bits();
                }
                out[10] = c.started as u32;
            }
        }
        touching
    }
}
