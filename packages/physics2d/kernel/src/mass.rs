// Mass properties of 2D shapes at a density, exact for rounded shapes: a rounded polygon is its core, a rectangle of
// width `radius` on each edge and a circular sector at each corner, whose angles sum to a full turn. Area, first and
// second moments are summed about a point inside the core (its vertex mean) for precision, then moved to the centre
// of mass by the parallel axis rule (Mirtich, "Fast and Accurate Computation of Polyhedral Mass Properties", JGT 1(2),
// 1996, reduced to the plane: a triangle from the origin to a and b has area a x b / 2, first moment area (a + b) / 3
// and polar second moment area (a.a + a.b + b.b) / 6).
use crate::math::{PI, V2, atan2, sqrt, v2};
use crate::error::PhysicsError;
use crate::shape::Core;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct MassData {
    pub mass: f32,
    /// The centre of mass in the shape's frame.
    pub center: V2,
    /// The moment of inertia about the centre of mass.
    pub inertia: f32,
}

/// Area, first moment and polar second moment about a reference point, in doubles: sums of many small terms.
#[derive(Default)]
struct Moments {
    area: f64,
    first: (f64, f64),
    second: f64,
}

impl Moments {
    /// The triangle from the reference point to `a` and `b`, both relative to it.
    fn triangle(&mut self, a: V2, b: V2) {
        let (ax, ay, bx, by) = (a.x as f64, a.y as f64, b.x as f64, b.y as f64);
        let area = 0.5 * (ax * by - ay * bx);
        self.area += area;
        self.first.0 += area * (ax + bx) / 3.0;
        self.first.1 += area * (ay + by) / 3.0;
        self.second += area * (ax * ax + ay * ay + ax * bx + ay * by + bx * bx + by * by) / 6.0;
    }
    /// The circular sector of `radius` and `angle` with its apex at `apex` (relative to the reference point), opening
    /// about the unit `bisector`: area angle r^2 / 2, first moment about the apex (2/3) r^3 sin(angle / 2) along the
    /// bisector, polar moment about the apex angle r^4 / 4.
    fn sector(&mut self, apex: V2, bisector: V2, radius: f64, angle: f64, half_sine: f64) {
        let (px, py) = (apex.x as f64, apex.y as f64);
        let area = 0.5 * angle * radius * radius;
        let lever = (2.0 / 3.0) * radius * radius * radius * half_sine;
        let (lx, ly) = (lever * bisector.x as f64, lever * bisector.y as f64);
        self.area += area;
        self.first.0 += area * px + lx;
        self.first.1 += area * py + ly;
        self.second += area * (px * px + py * py) + 2.0 * (px * lx + py * ly) + 0.25 * angle * radius * radius * radius * radius;
    }
    fn finish(&self, density: f32, reference: V2) -> MassData {
        if self.area <= 0.0 {
            return MassData { mass: 0.0, center: reference, inertia: 0.0 };
        }
        let (cx, cy) = (self.first.0 / self.area, self.first.1 / self.area);
        let inertia = density as f64 * (self.second - self.area * (cx * cx + cy * cy));
        MassData {
            mass: (density as f64 * self.area) as f32,
            center: v2(reference.x + cx as f32, reference.y + cy as f32),
            inertia: inertia as f32,
        }
    }
}

/// The mass of `core` at `density` (kilograms per square metre). A segment, with no area, has none.
pub fn mass_of(core: &Core, density: f32) -> MassData {
    mass_properties(core, density).0
}

/// Zero density and zero area deliberately have no mass. A positive geometric property rounded to zero cannot
/// take that fallback: its reciprocal (or the physical property itself) is unrepresentable.
pub(crate) fn checked_mass_of(core: &Core, density: f32) -> Result<MassData, PhysicsError> {
    let (data, positive_mass, positive_inertia) = mass_properties(core, density);
    if !data.mass.is_finite() || !data.inertia.is_finite() || !data.center.x.is_finite() || !data.center.y.is_finite()
        || positive_mass && !(data.mass > 0.0) || positive_inertia && !(data.inertia > 0.0) {
        Err(PhysicsError::ArithmeticOverflow)
    } else { Ok(data) }
}

fn mass_properties(core: &Core, density: f32) -> (MassData, bool, bool) {
    let r = core.radius;
    match core.count {
        1 => {
            let mass = density * PI * r * r;
            (MassData { mass, center: core.vertices[0], inertia: 0.5 * mass * r * r }, density > 0.0 && r > 0.0, density > 0.0 && r > 0.0)
        }
        2 => capsule(core.vertices[0], core.vertices[1], r, density),
        _ => polygon(core, density),
    }
}

/// A capsule: the rectangle between the two half discs plus the two half discs, which make one disc.
fn capsule(a: V2, b: V2, r: f32, density: f32) -> (MassData, bool, bool) {
    let center = a.lerp(b, 0.5);
    let length = b.sub(a).length() as f64;
    let (r, rho) = (r as f64, density as f64);
    let box_mass = rho * length * 2.0 * r;
    let disc_mass = rho * core::f64::consts::PI * r * r;
    let box_inertia = box_mass * (length * length + 4.0 * r * r) / 12.0;
    // A half disc of mass m has m r^2 / 2 about its flat edge's middle and its centre of mass 4 r / (3 pi) out from it.
    let half = 0.5 * disc_mass;
    let offset = 4.0 * r / (3.0 * core::f64::consts::PI);
    let own = half * r * r / 2.0 - half * offset * offset;
    let shift = 0.5 * length + offset;
    let caps = 2.0 * (own + half * shift * shift);
    (MassData { mass: (box_mass + disc_mass) as f32, center, inertia: (box_inertia + caps) as f32 }, box_mass + disc_mass > 0.0, box_inertia + caps > 0.0)
}

fn polygon(core: &Core, density: f32) -> (MassData, bool, bool) {
    let n = core.count;
    let mut reference = V2::ZERO;
    for i in 0..n {
        reference = reference.add(core.vertices[i]);
    }
    let reference = reference.scale(1.0 / n as f32);
    let at = |i: usize| core.vertices[i % n].sub(reference);
    let mut m = Moments::default();
    for i in 0..n {
        m.triangle(at(i), at(i + 1));
    }
    let r = core.radius;
    if r > 0.0 {
        for i in 0..n {
            // The edge's rectangle, out along its normal.
            let (a, b, out) = (at(i), at(i + 1), core.normals[i].scale(r));
            m.triangle(a.add(out), b.add(out));
            m.triangle(a, a.add(out));
            m.triangle(b.add(out), b);
            m.triangle(b, a);
            // The corner at the edge's end, between this edge's normal and the next one's.
            let (n0, n1) = (core.normals[i], core.normals[(i + 1) % n]);
            let cosine = n0.dot(n1) as f64;
            let angle = atan2(n0.cross(n1), n0.dot(n1)) as f64;
            let half_sine = sqrt(((1.0 - cosine) * 0.5).max(0.0) as f32) as f64;
            let bisector = n0.add(n1).normalize().0;
            m.sector(b, bisector, r as f64, angle, half_sine);
        }
    }
    let data = m.finish(density, reference);
    let positive_mass = density > 0.0 && m.area > 0.0;
    let positive_inertia = if positive_mass {
        let (cx, cy) = (m.first.0 / m.area, m.first.1 / m.area);
        m.second - m.area * (cx * cx + cy * cy) > 0.0
    } else { false };
    (data, positive_mass, positive_inertia)
}
