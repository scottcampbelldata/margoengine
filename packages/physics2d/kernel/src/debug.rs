// Lines to draw a world: every shape's outline, joints, contact points and normals and the broad phase's boxes, as
// segments of five numbers (x1, y1, x2, y2, colour). A circle is 24 segments, a rounded corner 6; the drawing is for
// eyes and never reaches the step.
use alloc::vec::Vec;

use crate::math::{Rot, V2, Xf, v2};
use crate::shape::Core;
use crate::world::{Kind, World};

/// What to draw: `DEBUG_*` bits.
pub const DEBUG_SHAPES: u32 = 1;
pub const DEBUG_JOINTS: u32 = 2;
pub const DEBUG_CONTACTS: u32 = 4;
pub const DEBUG_BOXES: u32 = 8;
pub const DEBUG_ALL: u32 = 15;

/// Colours of a line, by what it draws.
pub const COLOUR_FIXED: f32 = 0.0;
pub const COLOUR_AWAKE: f32 = 1.0;
pub const COLOUR_SLEEPING: f32 = 2.0;
pub const COLOUR_KINEMATIC: f32 = 3.0;
pub const COLOUR_SENSOR: f32 = 4.0;
pub const COLOUR_JOINT: f32 = 5.0;
pub const COLOUR_CONTACT_POINT: f32 = 6.0;
pub const COLOUR_CONTACT_NORMAL: f32 = 7.0;
pub const COLOUR_BOX: f32 = 8.0;

const CIRCLE: usize = 24;
const ARC: usize = 6;

fn push(out: &mut Vec<f32>, a: V2, b: V2, colour: f32) {
    out.extend_from_slice(&[a.x, a.y, b.x, b.y, colour]);
}

/// The segments of an arc about `centre` of `radius` from direction `from` to direction `to`, counter-clockwise through
/// `sweep` radians, in `steps` segments; the last ends exactly at `to`.
fn arc(out: &mut Vec<f32>, centre: V2, radius: f32, from: V2, to: V2, sweep: f32, steps: usize, colour: f32) {
    let d = sweep / steps as f32;
    let step = Rot::from_pair(1.0 - 0.5 * d * d, d);
    let mut n = from;
    let mut last = centre.add(n.scale(radius));
    for k in 0..steps {
        n = step.apply(n);
        let next = if k + 1 == steps { centre.add(to.scale(radius)) } else { centre.add(n.scale(radius)) };
        push(out, last, next, colour);
        last = next;
    }
}

/// An outline of `core` placed at `xf`.
fn outline(out: &mut Vec<f32>, core: &Core, xf: Xf, colour: f32) {
    let n = core.count;
    let r = core.radius;
    if n == 1 {
        let c = xf.apply(core.vertices[0]);
        arc(out, c, r, v2(1.0, 0.0), v2(1.0, 0.0), 2.0 * core::f32::consts::PI, CIRCLE, colour);
        return;
    }
    for i in 0..core.edges() {
        let (a, b) = core.edge(i);
        let offset = xf.q.apply(core.normals[i]).scale(r);
        push(out, xf.apply(a).add(offset), xf.apply(b).add(offset), colour);
    }
    if r > 0.0 {
        for i in 0..n {
            let (before, after) = (xf.q.apply(core.normals[(i + n - 1) % n]), xf.q.apply(core.normals[i]));
            let (cross, dot) = (before.cross(after), before.dot(after));
            // A capsule's end turns half way round, a flat turn the other way would be a corner that is not there.
            let sweep = if cross == 0.0 && dot < 0.0 { core::f32::consts::PI } else { crate::math::atan2(cross, dot) };
            if sweep > 0.0 {
                arc(out, xf.apply(core.vertices[i]), r, before, after, sweep, ARC, colour);
            }
        }
    }
}

impl World {
    /// Segments of five numbers (x1, y1, x2, y2, colour) for what `what` (`DEBUG_*` bits) names.
    pub fn debug_lines(&self, what: u32) -> Vec<f32> {
        let mut out = Vec::new();
        if what & DEBUG_SHAPES != 0 {
            for s in self.shapes.iter().filter(|s| !s.dead) {
                let b = &self.bodies[s.body as usize];
                let colour = if s.sensor {
                    COLOUR_SENSOR
                } else {
                    match (b.kind, b.awake) {
                        (Kind::Static, _) => COLOUR_FIXED,
                        (Kind::Kinematic, _) => COLOUR_KINEMATIC,
                        (Kind::Dynamic, true) => COLOUR_AWAKE,
                        (Kind::Dynamic, false) => COLOUR_SLEEPING,
                    }
                };
                outline(&mut out, &s.core, b.xf, colour);
            }
        }
        if what & DEBUG_JOINTS != 0 {
            for j in &self.joints {
                let (a, b) = (&self.bodies[j.def.a as usize], &self.bodies[j.def.b as usize]);
                push(&mut out, a.xf.apply(j.def.anchor_a), b.xf.apply(j.def.anchor_b), COLOUR_JOINT);
            }
        }
        if what & DEBUG_CONTACTS != 0 {
            for c in &self.contacts {
                let m = &c.manifold;
                if m.count == 0 {
                    continue;
                }
                let from = self.bodies[self.shapes[c.a as usize].body as usize].exact_center;
                for p in &m.points[..m.count] {
                    let at = v2((from[0] + p.point.x as f64) as f32, (from[1] + p.point.y as f64) as f32);
                    let arm = v2(0.05, 0.0);
                    push(&mut out, at.sub(arm), at.add(arm), COLOUR_CONTACT_POINT);
                    push(&mut out, at.sub(v2(0.0, 0.05)), at.add(v2(0.0, 0.05)), COLOUR_CONTACT_POINT);
                    push(&mut out, at, at.add(m.normal.scale(0.25)), COLOUR_CONTACT_NORMAL);
                }
            }
        }
        if what & DEBUG_BOXES != 0 {
            for id in 0..self.shapes.len() as u32 {
                let Some(f) = self.broad_fat(id) else { continue };
                let (a, b, c, d) = (v2(f.min[0], f.min[1]), v2(f.max[0], f.min[1]), v2(f.max[0], f.max[1]), v2(f.min[0], f.max[1]));
                for (p, q) in [(a, b), (b, c), (c, d), (d, a)] {
                    push(&mut out, p, q, COLOUR_BOX);
                }
            }
        }
        out
    }
}
