// Mass, centre of mass and inertia of a body from its colliders. Closed forms for each solid, the parallel axis theorem to
// add them up, and Jacobi rotations to find the principal axes, kept as a quaternion from the start.
use crate::layout::*;
use crate::math::*;
use crate::world::{NONE, World};

const PI: f32 = core::f32::consts::PI;

/// A symmetric 3x3 matrix: xx, yy, zz, xy, xz, yz.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sym {
    pub xx: f32,
    pub yy: f32,
    pub zz: f32,
    pub xy: f32,
    pub xz: f32,
    pub yz: f32,
}

/// Mass and moments of one solid about its own centre, in its own frame.
pub struct Solid {
    pub mass: f32,
    pub moments: V3,
}

/// A solid box of half extents `h`: I_xx = m (b^2 + c^2) / 3 for half extents a, b, c.
pub fn solid_box(h: V3, density: f32) -> Solid {
    let mass = 8.0 * h.x * h.y * h.z * density;
    let third = mass / 3.0;
    Solid { mass, moments: v3(h.y * h.y + h.z * h.z, h.x * h.x + h.z * h.z, h.x * h.x + h.y * h.y).scale(third) }
}

/// A solid ball: m = 4/3 pi r^3 rho, I = 2/5 m r^2.
pub fn solid_ball(radius: f32, density: f32) -> Solid {
    let mass = 4.0 / 3.0 * PI * radius * radius * radius * density;
    let moment = 0.4 * mass * radius * radius;
    Solid { mass, moments: v3(moment, moment, moment) }
}

/// A capsule along Y: a cylinder of radius r and length 2a with a hemisphere on each end.
/// About Y: the cylinder's m r^2 / 2 and the ball's 2/5 m r^2. Across it, the cylinder gives m (r^2 / 4 + (2a)^2 / 12). A
/// hemisphere of mass m has 2/5 m r^2 about a diameter of its flat face and its centre 3r/8 from that face; moved to its
/// own centre and then out to the capsule's, by the parallel axis theorem, that is m (2/5 r^2 + a^2 + 3/4 a r).
pub fn solid_capsule(radius: f32, half: f32, density: f32) -> Solid {
    let r2 = radius * radius;
    let cylinder = PI * r2 * 2.0 * half * density;
    let ball = 4.0 / 3.0 * PI * r2 * radius * density;
    let along = cylinder * r2 * 0.5 + ball * 0.4 * r2;
    let across = cylinder * (r2 * 0.25 + half * half / 3.0) + ball * (0.4 * r2 + half * half + 0.75 * half * radius);
    Solid { mass: cylinder + ball, moments: v3(across, along, across) }
}

/// Adds rotation `q` of diag(moments) to `sum`: R D R^T, one column of R at a time.
fn add_rotated(sum: &mut Sym, q: Q, moments: V3) {
    let (x, y, z) = (q.rotate(v3(1.0, 0.0, 0.0)), q.rotate(v3(0.0, 1.0, 0.0)), q.rotate(v3(0.0, 0.0, 1.0)));
    for (axis, moment) in [(x, moments.x), (y, moments.y), (z, moments.z)] {
        sum.xx += moment * axis.x * axis.x;
        sum.yy += moment * axis.y * axis.y;
        sum.zz += moment * axis.z * axis.z;
        sum.xy += moment * axis.x * axis.y;
        sum.xz += moment * axis.x * axis.z;
        sum.yz += moment * axis.y * axis.z;
    }
}

/// The parallel axis term of a point mass at `d`: m (|d|^2 E - d d^T).
pub(crate) fn add_offset(sum: &mut Sym, mass: f32, d: V3) {
    sum.xx += mass * (d.y * d.y + d.z * d.z);
    sum.yy += mass * (d.x * d.x + d.z * d.z);
    sum.zz += mass * (d.x * d.x + d.y * d.y);
    sum.xy -= mass * d.x * d.y;
    sum.xz -= mass * d.x * d.z;
    sum.yz -= mass * d.y * d.z;
}

/// Principal moments and the frame whose axes they lie along: A = R(frame) diag(moments) R(frame)^T. Cyclic Jacobi: each
/// rotation zeroes one off-diagonal element, and sweeps repeat until none is left at f32 size. Each plane rotation is a
/// turn of at most 45 degrees about a coordinate axis, so it joins the frame as a quaternion by its half angle, and the
/// frame stays a proper rotation with no conversion from a matrix. A diagonal matrix returns the identity, exactly.
pub fn principal(a: Sym) -> (V3, Q) {
    let mut m = a;
    let mut frame = Q::IDENTITY;
    for _ in 0..12 {
        let off = m.xy * m.xy + m.xz * m.xz + m.yz * m.yz;
        let size = m.xx * m.xx + m.yy * m.yy + m.zz * m.zz;
        if !(off > size * 1e-14) {
            break;
        }
        // (p, q) = (x, y), (x, z), (y, z): the axis each plane turns about, with the sign of its rotation.
        for plane in 0..3 {
            let (app, aqq, apq) = match plane {
                0 => (m.xx, m.yy, m.xy),
                1 => (m.xx, m.zz, m.xz),
                _ => (m.yy, m.zz, m.yz),
            };
            if apq == 0.0 {
                continue;
            }
            let theta = (aqq - app) / (2.0 * apq);
            let t = theta.signum() / (theta.abs() + sqrt(theta * theta + 1.0));
            let c = 1.0 / sqrt(t * t + 1.0);
            let s = t * c;
            let (new_p, new_q) = (app - t * apq, aqq + t * apq);
            match plane {
                0 => {
                    (m.xx, m.yy, m.xy) = (new_p, new_q, 0.0);
                    (m.xz, m.yz) = (c * m.xz - s * m.yz, s * m.xz + c * m.yz);
                }
                1 => {
                    (m.xx, m.zz, m.xz) = (new_p, new_q, 0.0);
                    (m.xy, m.yz) = (c * m.xy - s * m.yz, s * m.xy + c * m.yz);
                }
                _ => {
                    (m.yy, m.zz, m.yz) = (new_p, new_q, 0.0);
                    (m.xy, m.xz) = (c * m.xy - s * m.xz, s * m.xy + c * m.xz);
                }
            }
            // [[c, s], [-s, c]] in the plane (p, q): a turn of -phi about +Z or +X, and of +phi about +Y.
            let w = sqrt(0.5 * (1.0 + c));
            let half = 0.5 * s / w;
            let turn = match plane {
                0 => Q { x: 0.0, y: 0.0, z: -half, w },
                1 => Q { x: 0.0, y: half, z: 0.0, w },
                _ => Q { x: -half, y: 0.0, z: 0.0, w },
            };
            frame = frame.mul(turn).normalized();
        }
    }
    (v3(m.xx, m.yy, m.zz), frame)
}

impl World {
    /// Mass, centre and inertia of `body`: its colliders and its own solid added by the parallel axis theorem, then its
    /// additional mass, which scales the inertia with the mass: it adds weight spread as the rest is. With no collider
    /// mass the own solid is the body, its figures kept exactly as given. Keeps the pose of the origin; the centre moves
    /// within it.
    pub fn update_mass(&mut self, body: u32) {
        let at = body as usize;
        let (own_mass, own_center, own_moments, own_frame) =
            (self.s(OWN_MASS, at), self.v(OWN_CENTER_X, at), self.v(OWN_INERTIA_X, at), self.q(OWN_FRAME_X, at));
        let own = own_mass > 0.0 || own_moments.x > 0.0 || own_moments.y > 0.0 || own_moments.z > 0.0;
        let mut mass = 0.0f32;
        let mut moment_sum = v3(0.0, 0.0, 0.0);
        // First pass: total mass and centre.
        let mut collider = unsafe { *self.u(FIRST_COLLIDER).add(at) };
        while collider != NONE {
            let c = collider as usize;
            let solid = self.collider_solid(c);
            mass += solid.mass;
            moment_sum = moment_sum.add(self.solid_center(c).scale(solid.mass));
            collider = unsafe { *self.u(COLLIDER_NEXT).add(c) };
        }
        let base = mass + own_mass;
        let center = if mass == 0.0 {
            own_center
        } else if own {
            moment_sum.add(own_center.scale(own_mass)).scale(1.0 / base)
        } else {
            moment_sum.scale(1.0 / mass)
        };
        let (mut moments, frame) = if mass == 0.0 {
            (own_moments, own_frame)
        } else {
            // Second pass: inertia about that centre.
            let mut inertia = Sym { xx: 0.0, yy: 0.0, zz: 0.0, xy: 0.0, xz: 0.0, yz: 0.0 };
            let mut collider = unsafe { *self.u(FIRST_COLLIDER).add(at) };
            while collider != NONE {
                let c = collider as usize;
                let solid = self.collider_solid(c);
                add_rotated(&mut inertia, self.solid_frame(c), solid.moments);
                add_offset(&mut inertia, solid.mass, self.solid_center(c).sub(center));
                collider = unsafe { *self.u(COLLIDER_NEXT).add(c) };
            }
            if own {
                add_rotated(&mut inertia, own_frame, own_moments);
                add_offset(&mut inertia, own_mass, own_center.sub(center));
            }
            principal(inertia)
        };
        let total = base + self.s(ADDITIONAL_MASS, at);
        if base > 0.0 {
            moments = moments.scale(total / base);
        }
        let invert = |value: f32| if value > 0.0 { 1.0 / value } else { 0.0 };
        self.set_s(INVERSE_MASS, at, invert(total));
        self.set_v(LOCAL_CENTER_X, at, center);
        self.set_v(INERTIA_X, at, moments);
        self.set_v(INVERSE_INERTIA_X, at, v3(invert(moments.x), invert(moments.y), invert(moments.z)));
        self.set_q(INERTIA_FRAME_X, at, frame);
    }

    /// Sets a body's own solid and works out its mass again. The frame is made unit length here, and the additional mass
    /// goes: the own solid takes its place, as one figure of what is added.
    pub fn set_own_solid(&mut self, body: u32, mass: f32, center: V3, moments: V3, frame: Q) {
        let at = body as usize;
        self.set_s(OWN_MASS, at, mass);
        self.set_v(OWN_CENTER_X, at, center);
        self.set_v(OWN_INERTIA_X, at, moments);
        self.set_q(OWN_FRAME_X, at, frame.normalized());
        self.set_s(ADDITIONAL_MASS, at, 0.0);
        self.update_mass(body);
    }

    fn collider_solid(&self, c: usize) -> Solid {
        let density = self.s(COLLIDER_DENSITY, c);
        let size = self.v(COLLIDER_A, c);
        match unsafe { *self.u(COLLIDER_SHAPE).add(c) } {
            SHAPE_BALL => solid_ball(size.x, density),
            SHAPE_BOX => solid_box(size, density),
            SHAPE_HULL => {
                let hull = self.uu(COLLIDER_HULL, c) as usize;
                Solid { mass: self.s(HULL_VOLUME, hull) * density, moments: self.v(HULL_MOMENT_X, hull).scale(density) }
            }
            // A surface has no volume, so no mass, as a Rapier trimesh gives a dynamic body none.
            SHAPE_TRIMESH => Solid { mass: 0.0, moments: v3(0.0, 0.0, 0.0) },
            _ => solid_capsule(size.x, size.y, density),
        }
    }

    /// A collider's centre of mass in its body's frame: only a hull's is not at the collider's origin.
    fn solid_center(&self, c: usize) -> V3 {
        let place = self.v(COLLIDER_X, c);
        if self.uu(COLLIDER_SHAPE, c) == SHAPE_HULL {
            let center = self.v(HULL_CENTER_X, self.uu(COLLIDER_HULL, c) as usize);
            return place.add(self.q(COLLIDER_ROTATION_X, c).rotate(center));
        }
        place
    }

    /// The frame a collider's principal moments lie along, in its body's frame.
    fn solid_frame(&self, c: usize) -> Q {
        let turn = self.q(COLLIDER_ROTATION_X, c);
        if self.uu(COLLIDER_SHAPE, c) == SHAPE_HULL {
            return turn.mul(self.q(HULL_FRAME_X, self.uu(COLLIDER_HULL, c) as usize));
        }
        turn
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R D R^T back from moments and frame.
    fn rebuilt(moments: V3, frame: Q) -> Sym {
        let mut out = Sym { xx: 0.0, yy: 0.0, zz: 0.0, xy: 0.0, xz: 0.0, yz: 0.0 };
        add_rotated(&mut out, frame, moments);
        out
    }

    #[test]
    fn a_diagonal_matrix_keeps_the_identity_frame_exactly() {
        let (moments, frame) = principal(Sym { xx: 3.0, yy: 1.0, zz: 2.0, xy: 0.0, xz: 0.0, yz: 0.0 });
        assert_eq!(moments, v3(3.0, 1.0, 2.0));
        assert_eq!(frame, Q::IDENTITY);
    }

    #[test]
    fn jacobi_rebuilds_the_matrix_it_was_given() {
        // A deterministic spread of symmetric positive matrices.
        let mut seed = 12345u32;
        let mut next = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / 16_777_216.0
        };
        for _ in 0..500 {
            let (a, b, c) = (next() + 0.1, next() + 0.1, next() + 0.1);
            let turn = Q { x: next() - 0.5, y: next() - 0.5, z: next() - 0.5, w: next() - 0.5 }.normalized();
            let matrix = rebuilt(v3(a, b, c), turn);
            let (moments, frame) = principal(matrix);
            let back = rebuilt(moments, frame);
            for (got, want) in [
                (back.xx, matrix.xx),
                (back.yy, matrix.yy),
                (back.zz, matrix.zz),
                (back.xy, matrix.xy),
                (back.xz, matrix.xz),
                (back.yz, matrix.yz),
            ] {
                assert!((got - want).abs() < 2e-5, "{got} against {want}");
            }
            let mut sorted = [moments.x, moments.y, moments.z];
            sorted.sort_by(f32::total_cmp);
            let mut wanted = [a, b, c];
            wanted.sort_by(f32::total_cmp);
            for k in 0..3 {
                assert!((sorted[k] - wanted[k]).abs() < 2e-5);
            }
        }
    }
}
