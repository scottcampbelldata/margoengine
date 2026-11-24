// Cloth meeting itself and other cloth: the triangles of soft bodies (indices into the particle columns) and a thickness give,
// every substep, the pairs of vertex and triangle and of edge and edge that are within the thickness or would pass through
// each other, found with `margoengine_physics_kernel_common::cloth` (Bridson, Fedkiw, Anderson 2002 for the two kinds of
// proximity and the thickness; Harmon et al. 2008 for the groups of contacts that share vertices; Wang et al. 2021 for the
// continuous search that misses nothing; Mirtich 1996 for the bound it uses; the sources are in that file), and pushed apart
// as position constraints (Mueller et al., "Position Based Dynamics", 2007): each contact moves its particles along its normal,
// each by its share of the inverse masses and the weights of the point it touches, until the thickness is open again. The
// solver's velocities follow from the positions, as for every other constraint.
//
// Off until a thickness and triangles are given. The state lives here, in the module, so the world's own rows are not touched:
// one world to a Wasm instance, as the rest of this crate has.
use crate::World;
use crate::col::Col;
use crate::math::sqrt;
use margoengine_physics_kernel_common::cloth::{ClothContact, EDGE_EDGE, Found, POINT_TRIANGLE, Scratch, find_contacts};

pub use margoengine_physics_kernel_common::cloth::ClothContact as Contact;

struct State {
    triangles: Col<u32>,
    count: usize,
    thickness: f32,
    friction: f32,
    boxes: Col<f32>,
    order: Col<u32>,
    parent: Col<u32>,
    x0: Col<f32>,
    x1: Col<f32>,
    out: Col<ClothContact>,
    capacity: usize,
    found: Found,
    /// How many contacts the last substep pushed apart.
    pushed: usize,
}

static mut STATE: State = State {
    triangles: Col::new(),
    count: 0,
    thickness: 0.0,
    friction: 0.0,
    boxes: Col::new(),
    order: Col::new(),
    parent: Col::new(),
    x0: Col::new(),
    x1: Col::new(),
    out: Col::new(),
    capacity: 0,
    found: Found { count: 0, overflow: false },
    pushed: 0,
};

#[allow(static_mut_refs)]
fn state() -> &'static mut State {
    unsafe { &mut *(&raw mut STATE) }
}

/// Makes room for this many triangles and contacts. Views over the memory are stale after it.
pub fn reserve(triangles: usize, contacts: usize) {
    let s = state();
    s.triangles.resize(3 * triangles);
    s.out.resize(contacts);
    s.capacity = contacts;
}

/// Sets the triangles (three particle indices each) and the thickness, in metres, from which cloth is kept apart: 0 or no
/// triangles turns the search off. Friction is Coulomb's coefficient between cloth surfaces, 0 for none (see `set_friction`).
pub fn configure(triangles: &[u32], thickness: f32) {
    reserve(triangles.len() / 3, state().capacity.max(16384));
    let s = state();
    s.triangles[..triangles.len()].copy_from_slice(triangles);
    s.count = triangles.len() / 3;
    s.thickness = thickness;
    s.friction = 0.0;
}

/// Where the triangles go: the host writes three particle indices a triangle here after `reserve`, then calls `enable`.
pub fn buffer() -> *mut u32 {
    state().triangles.as_mut_ptr()
}

/// Puts the first `count` triangles of the buffer, a thickness and a friction coefficient into force (0 thickness or no
/// triangles turns the search off).
pub fn enable(count: usize, thickness: f32, friction: f32) {
    let s = state();
    s.count = count;
    s.thickness = thickness;
    s.friction = friction;
}

/// Sets Coulomb's friction coefficient between cloth surfaces that touch: the tangential motion two touching points make
/// against each other in a substep is cut by up to this much of the push that separated them (Bridson, Fedkiw, Anderson 2002,
/// section 5; Mueller et al. 2007, section 4.4).
pub fn set_friction(friction: f32) {
    state().friction = friction;
}

/// The contacts the last substep found, sorted and grouped (see `ClothContact`).
pub fn contacts() -> &'static [ClothContact] {
    let s = state();
    &s.out[..s.found.count]
}

/// Whether the last substep found more contacts than there was room for.
pub fn overflowed() -> bool {
    state().found.overflow
}

impl World {
    /// Finds the contacts of the cloth over the motion of this substep (from where each particle was to where it is) and moves
    /// the particles of each apart along its normal until the thickness is open. The particles' inverse masses weigh the move;
    /// a particle with none stays.
    pub(crate) fn collide(&mut self, _h: f32) {
        let s = state();
        if s.count == 0 || !(s.thickness > 0.0) || self.particles == 0 {
            return;
        }
        let n = self.particles;
        s.x0.resize(3 * n);
        s.x1.resize(3 * n);
        s.boxes.resize(6 * s.count);
        s.order.resize(s.count);
        s.parent.resize(n);
        for i in 0..n {
            s.x0[3 * i] = self.px[i];
            s.x0[3 * i + 1] = self.py[i];
            s.x0[3 * i + 2] = self.pz[i];
            s.x1[3 * i] = self.x[i];
            s.x1[3 * i + 1] = self.y[i];
            s.x1[3 * i + 2] = self.z[i];
        }
        let tri = &s.triangles[..3 * s.count];
        let mut scratch = Scratch { boxes: &mut s.boxes[..6 * s.count], order: &mut s.order[..s.count], parent: &mut s.parent[..n] };
        let capacity = s.capacity;
        s.found = find_contacts(&s.x0[..3 * n], &s.x1[..3 * n], tri, s.thickness, &mut scratch, &mut s.out[..capacity]);
        let mut pushed = 0;
        for k in 0..s.found.count {
            let c = s.out[k];
            if self.push_apart(&c, s.thickness, s.friction) {
                pushed += 1;
            }
        }
        s.pushed = pushed;
    }

    /// Moves the particles of one contact along its normal until its two primitives are `thickness` apart again. False when
    /// they already are, or when none of the particles can move.
    fn push_apart(&mut self, c: &ClothContact, thickness: f32, friction: f32) -> bool {
        // The coefficient of each particle in the move of the touching points, and which way each goes: the first primitive along
        // the normal, the second against it.
        let (ids, coefficients): ([usize; 4], [f32; 4]) = if c.kind == POINT_TRIANGLE {
            ([c.v[0] as usize, c.v[1] as usize, c.v[2] as usize, c.v[3] as usize], [1.0, -c.w[0], -c.w[1], -c.w[2]])
        } else {
            let (s, t) = (c.w[0], c.w[1]);
            ([c.v[0] as usize, c.v[1] as usize, c.v[2] as usize, c.v[3] as usize], [1.0 - s, s, -(1.0 - t), -t])
        };
        debug_assert!(c.kind == POINT_TRIANGLE || c.kind == EDGE_EDGE);
        let n = c.normal;
        // The gap along the normal now: the first primitive's point minus the second's.
        let mut gap = 0.0;
        for k in 0..4 {
            let i = ids[k];
            gap += coefficients[k] * (self.x[i] * n[0] + self.y[i] * n[1] + self.z[i] * n[2]);
        }
        let violation = thickness - gap;
        if !(violation > 0.0) {
            return false;
        }
        let mut weight = 0.0;
        for k in 0..4 {
            weight += self.w[ids[k]] * coefficients[k] * coefficients[k];
        }
        if !(weight > 0.0) {
            return false;
        }
        let lambda = violation / weight;
        for k in 0..4 {
            let i = ids[k];
            let move_by = self.w[i] * coefficients[k] * lambda;
            self.x[i] += move_by * n[0];
            self.y[i] += move_by * n[1];
            self.z[i] += move_by * n[2];
        }
        if friction > 0.0 {
            // What the touching points moved against each other in this substep, along the surface: the first primitive's point
            // less the second's. Coulomb's cone: up to `friction` of the push that separated them is taken back, all of it when
            // that is less (static friction), so a cloth on a slope holds when tan(slope) is under the coefficient.
            let mut slide = [0.0f32; 3];
            for k in 0..4 {
                let i = ids[k];
                slide[0] += coefficients[k] * (self.x[i] - self.px[i]);
                slide[1] += coefficients[k] * (self.y[i] - self.py[i]);
                slide[2] += coefficients[k] * (self.z[i] - self.pz[i]);
            }
            let along = slide[0] * n[0] + slide[1] * n[1] + slide[2] * n[2];
            let tangent = [slide[0] - along * n[0], slide[1] - along * n[1], slide[2] - along * n[2]];
            let length = sqrt(tangent[0] * tangent[0] + tangent[1] * tangent[1] + tangent[2] * tangent[2]);
            if length > 1e-12 {
                let take = if length < friction * violation { length } else { friction * violation };
                let lambda = take / weight;
                let scale = lambda / length;
                for k in 0..4 {
                    let i = ids[k];
                    let move_by = self.w[i] * coefficients[k] * scale;
                    self.x[i] -= move_by * tangent[0];
                    self.y[i] -= move_by * tangent[1];
                    self.z[i] -= move_by * tangent[2];
                }
            }
        }
        true
    }
}

#[cfg(target_arch = "wasm32")]
mod exports {
    use super::*;

    /// Makes room for this many triangles and contacts. Views over the memory are stale after it.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_collide_reserve(triangles: u32, contacts: u32) {
        reserve(triangles as usize, contacts as usize);
    }
    /// Where the triangles go (three particle indices each), after `soft_collide_reserve`.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_collide_triangles() -> u32 {
        state().triangles.as_mut_ptr() as usize as u32
    }
    /// Turns the search on for `triangles` triangles already written, with a thickness in metres (0 turns it off) and Coulomb's
    /// friction coefficient between the cloth surfaces (0 for none).
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_collide_set(triangles: u32, thickness: f32, friction: f32) {
        let s = state();
        s.count = triangles as usize;
        s.thickness = thickness;
        s.friction = friction;
    }
    /// Where the last substep's contacts are, `soft_collide_stride` words each.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_collide_contacts() -> u32 {
        state().out.as_mut_ptr() as usize as u32
    }
    /// How many contacts the last substep found, with the top bit set when there were more than the room.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_collide_found() -> u32 {
        let s = state();
        s.found.count as u32 | if s.found.overflow { 0x8000_0000 } else { 0 }
    }
    /// Words of a contact: kind, four vertices, three weights, three normal numbers, time, depth, zone.
    #[unsafe(no_mangle)]
    pub extern "C" fn soft_collide_stride() -> u32 {
        (core::mem::size_of::<ClothContact>() / 4) as u32
    }
}
