// Cylinders and cones, with or without a border radius. Each is a solid of revolution about its local Y axis, its origin at
// half its height, as Rapier frames them (measured through its npm API, outputs only): a cylinder of radius r spans y from
// -h to h; a cone has its apex at y = h and its base disk of radius r at y = -h. Seen in the plane of the axis, either is a
// 2D profile in (rho, y), rho the distance from the axis: a rectangle, or a triangle with one side on the axis. A border
// radius b grows the solid by a ball of radius b (a Minkowski sum), and since a ball is the same turned about any axis, the
// rounded solid is the profile grown by a disk of radius b and turned the same way. Rapier adds the border outside the
// sizes it is given, so a round cylinder of radius r and border b reaches r + b from its axis; this kernel does the same.
//
// Mass: the moments of a solid of revolution are integrals over its profile of rho times a polynomial (Pappus's centroid
// theorem in its general form), as the ring at (rho, y) has mass 2 pi rho drho dy. The rounded profile is cut into
// triangles and circular sectors; each triangle's integral is exact by Radon's seven point rule of degree 5 (Stroud,
// "Approximate Calculation of Multiple Integrals", 1971, formula T2:5-1), each sector's from closed forms of the integrals
// of cos^i sin^j. Unlike Rapier, whose round shapes keep the mass of their core (measured: the same mass and inertia with
// a border as without), the border's volume counts here: a body's mass is the solid it collides as.
use crate::math::*;

/// A cylinder's or cone's core: radius `r`, half height `h`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Revolved {
    pub cone: bool,
    pub r: f32,
    pub h: f32,
}

/// Sides of the regular polygon a cap disk is clipped as. Its corners lie on the rim, so every point of a manifold on a
/// cap is on the true surface; between corners the polygon runs at most r (1 - cos(pi / 16)), 1.9 percent of r, inside it.
pub const CAP_SIDES: usize = 16;
/// A face or a side line takes part when the direction is within this cosine of its normal, about 2.6 degrees, the
/// narrow phase's `PARALLEL`.
pub const PARALLEL: f32 = 0.999;
/// The sine of the same angle: a segment lies square to a direction when the cosine between them is under this.
pub const SQUARE: f32 = 0.044_710;

/// What of a core lies farthest along a direction, in the core's frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Part {
    Point(V3),
    Segment(V3, V3),
    /// A cap disk at height `y`, its outward normal along +Y when `up`.
    Disk { y: f32, up: bool },
}

impl Revolved {
    /// The point of the core farthest along `d` (any length), in its frame.
    #[inline]
    pub fn support(&self, d: V3) -> V3 {
        let s = sqrt(d.x * d.x + d.z * d.z);
        let (ux, uz) = if s > 0.0 { (d.x / s, d.z / s) } else { (0.0, 0.0) };
        if self.cone {
            // The apex (0, h) against the rim (r, -h): the apex is farther when h t >= r s - h t.
            if 2.0 * self.h * d.y >= self.r * s { v3(0.0, self.h, 0.0) } else { v3(self.r * ux, -self.h, self.r * uz) }
        } else {
            v3(self.r * ux, if d.y >= 0.0 { self.h } else { -self.h }, self.r * uz)
        }
    }

    /// The part of the core farthest along unit `d`, in its frame: a cap within `PARALLEL` of `d`, a side line square to it
    /// within `SQUARE`, else the support point.
    pub fn part(&self, d: V3) -> Part {
        let s = sqrt(d.x * d.x + d.z * d.z);
        let rim = |y: f32| if s > 0.0 { v3(self.r * d.x / s, y, self.r * d.z / s) } else { v3(self.r, y, 0.0) };
        if self.cone {
            if d.y <= -PARALLEL {
                return Part::Disk { y: -self.h, up: false };
            }
            // The side's outward normal in the profile plane is (2h, r) over its length.
            let length = sqrt(4.0 * self.h * self.h + self.r * self.r);
            if s > 0.0 && (s * 2.0 * self.h + d.y * self.r) >= PARALLEL * length {
                return Part::Segment(v3(0.0, self.h, 0.0), rim(-self.h));
            }
        } else {
            if d.y >= PARALLEL {
                return Part::Disk { y: self.h, up: true };
            }
            if d.y <= -PARALLEL {
                return Part::Disk { y: -self.h, up: false };
            }
            if d.y.abs() <= SQUARE {
                return Part::Segment(rim(-self.h), rim(self.h));
            }
        }
        Part::Point(self.support(d))
    }

    /// Corner `k` of a cap disk's polygon at height `y`, counterclockwise seen from +Y.
    #[inline]
    pub fn cap_corner(&self, y: f32, k: usize) -> V3 {
        let (c, s) = CAP[k];
        v3(self.r * c, y, -self.r * s)
    }

    /// The farthest the solid reaches from its origin, with border `b`.
    pub fn reach(&self, b: f32) -> f32 {
        sqrt(self.r * self.r + self.h * self.h) + b
    }

    /// The least distance from the centre of mass of the core to its surface, plus the border: how thick it is.
    pub fn thickness(&self, b: f32) -> f32 {
        if self.cone {
            // From (0, -h/2): h/2 to the base, 3 r h / 2 over the side's length to the side.
            let length = sqrt(4.0 * self.h * self.h + self.r * self.r);
            (0.5 * self.h).min(1.5 * self.r * self.h / length) + b
        } else {
            self.r.min(self.h) + b
        }
    }

    /// The lowest and highest the solid reaches along unit world axis component `a` of its own Y axis, along a world axis
    /// whose component on that axis is `a`: (low, high) of the core about its origin, before the border.
    #[inline]
    pub fn span(&self, a: f32) -> (f32, f32) {
        let across = self.r * sqrt((1.0 - a * a).max(0.0));
        if self.cone {
            let (apex, base) = (self.h * a, -self.h * a);
            (apex.min(base - across), apex.max(base + across))
        } else {
            let along = self.h * a.abs();
            (-along - across, along + across)
        }
    }

    /// The point of the solid with border `b` nearest `p` (its frame), and whether `p` is inside. A point inside gets the
    /// nearest point of the surface. In the profile plane through `p`: the nearest point of the core's profile, or from
    /// inside the nearest side line's foot, pushed out by `b`.
    pub fn project(&self, p: V3, b: f32) -> (V3, bool) {
        let rho = sqrt(p.x * p.x + p.z * p.z);
        let (ux, uz) = if rho > 0.0 { (p.x / rho, p.z / rho) } else { (1.0, 0.0) };
        let q = (rho, p.y);
        // The sides of the profile that are surface (the axis side is not): ends and outward unit normals.
        let (h, r) = (self.h, self.r);
        let mut sides = [((0.0, 0.0), (0.0, 0.0), (0.0, 0.0)); 3];
        let count = if self.cone {
            let length = sqrt(4.0 * h * h + r * r);
            sides[0] = ((0.0, h), (r, -h), (2.0 * h / length, r / length));
            sides[1] = ((r, -h), (0.0, -h), (0.0, -1.0));
            2
        } else {
            sides[0] = ((0.0, h), (r, h), (0.0, 1.0));
            sides[1] = ((r, h), (r, -h), (1.0, 0.0));
            sides[2] = ((r, -h), (0.0, -h), (0.0, -1.0));
            3
        };
        let (mut most, mut nearest, mut best, mut best_side) = (f32::NEG_INFINITY, f32::INFINITY, (0.0, 0.0), 0);
        for (k, &(a, e, n)) in sides.iter().take(count).enumerate() {
            let height = (q.0 - a.0) * n.0 + (q.1 - a.1) * n.1;
            if height > most {
                most = height;
                best_side = k;
            }
            let (ex, ey) = (e.0 - a.0, e.1 - a.1);
            let t = (((q.0 - a.0) * ex + (q.1 - a.1) * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
            let foot = (a.0 + ex * t, a.1 + ey * t);
            let (dx, dy) = (q.0 - foot.0, q.1 - foot.1);
            let squared = dx * dx + dy * dy;
            if squared < nearest {
                nearest = squared;
                best = foot;
            }
        }
        let out = |(x, y): (f32, f32)| v3(x * ux, y, x * uz);
        if most <= 0.0 {
            // Inside the core: the nearest side line, its foot pushed out by the border.
            let (a, _, n) = sides[best_side];
            let height = (q.0 - a.0) * n.0 + (q.1 - a.1) * n.1;
            let foot = (q.0 - n.0 * height, q.1 - n.1 * height);
            return (out((foot.0 + n.0 * b, foot.1 + n.1 * b)), true);
        }
        let distance = sqrt(nearest);
        let way = ((q.0 - best.0) / distance, (q.1 - best.1) / distance);
        (out((best.0 + way.0 * b, best.1 + way.1 * b)), distance <= b)
    }
}

/// cos and sin of 2 pi k / 16, k from 0 to 15, as the nearest f32: fixed numbers, so no trigonometry reaches the state.
const CAP: [(f32, f32); CAP_SIDES] = [
    (1.0, 0.0),
    (0.923_879_5, 0.382_683_43),
    (0.707_106_77, 0.707_106_77),
    (0.382_683_43, 0.923_879_5),
    (0.0, 1.0),
    (-0.382_683_43, 0.923_879_5),
    (-0.707_106_77, 0.707_106_77),
    (-0.923_879_5, 0.382_683_43),
    (-1.0, 0.0),
    (-0.923_879_5, -0.382_683_43),
    (-0.707_106_77, -0.707_106_77),
    (-0.382_683_43, -0.923_879_5),
    (0.0, -1.0),
    (0.382_683_43, -0.923_879_5),
    (0.707_106_77, -0.707_106_77),
    (0.923_879_5, -0.382_683_43),
];

/// The profile integrals of rho, rho y, rho^3 and rho y^2 over a region of the (rho, y) plane.
#[derive(Clone, Copy, Default, Debug)]
struct Moments {
    m0: f64,
    m1: f64,
    m3: f64,
    m12: f64,
}

impl Moments {
    fn add(&mut self, o: Moments) {
        self.m0 += o.m0;
        self.m1 += o.m1;
        self.m3 += o.m3;
        self.m12 += o.m12;
    }
}

/// Radon's seven point rule: barycentric points and weights, exact for every polynomial of degree 5 or less.
fn triangle(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> Moments {
    const S15: f64 = 3.872_983_346_207_417;
    let (a1, a2) = ((6.0 - S15) / 21.0, (6.0 + S15) / 21.0);
    let (w1, w2) = ((155.0 - S15) / 1200.0, (155.0 + S15) / 1200.0);
    let rule: [((f64, f64, f64), f64); 7] = [
        ((1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0), 9.0 / 40.0),
        ((a1, a1, 1.0 - 2.0 * a1), w1),
        ((a1, 1.0 - 2.0 * a1, a1), w1),
        ((1.0 - 2.0 * a1, a1, a1), w1),
        ((a2, a2, 1.0 - 2.0 * a2), w2),
        ((a2, 1.0 - 2.0 * a2, a2), w2),
        ((1.0 - 2.0 * a2, a2, a2), w2),
    ];
    let area = 0.5 * ((b.0 - a.0) * (c.1 - a.1) - (c.0 - a.0) * (b.1 - a.1)).abs();
    let mut m = Moments::default();
    for ((u, v, w), weight) in rule {
        let (x, y) = (u * a.0 + v * b.0 + w * c.0, u * a.1 + v * b.1 + w * c.1);
        let k = weight * area;
        m.add(Moments { m0: k * x, m1: k * x * y, m3: k * x * x * x, m12: k * x * y * y });
    }
    m
}

/// A quadrilateral a, b, c, d (convex, in order) as two triangles.
fn quad(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> Moments {
    let mut m = triangle(a, b, c);
    m.add(triangle(a, c, d));
    m
}

/// The sector of radius `r` about `c` from the angle of unit (c0, s0) at `t0` to that of (c1, s1) at `t1`, counterclockwise.
/// With rho = c.rho + s cos t, y = c.y + s sin t and dA = s ds dt, each integrand is a sum of s^k cos^i sin^j terms.
fn sector(c: (f64, f64), r: f64, (t0, c0, s0): (f64, f64, f64), (t1, c1, s1): (f64, f64, f64)) -> Moments {
    // The integral of cos^i sin^j from t0 to t1, from antiderivatives in cos and sin.
    let at = |t: f64, cs: f64, sn: f64, i: u32, j: u32| -> f64 {
        match (i, j) {
            (0, 0) => t,
            (1, 0) => sn,
            (0, 1) => -cs,
            (2, 0) => 0.5 * t + 0.5 * sn * cs,
            (0, 2) => 0.5 * t - 0.5 * sn * cs,
            (1, 1) => 0.5 * sn * sn,
            (3, 0) => sn - sn * sn * sn / 3.0,
            (1, 2) => sn * sn * sn / 3.0,
            _ => 0.0,
        }
    };
    let ang = |i: u32, j: u32| at(t1, c1, s1, i, j) - at(t0, c0, s0, i, j);
    // The integral of s^k s ds from 0 to r times the angular part.
    let term = |k: i32, i: u32, j: u32| {
        let mut p = 1.0;
        for _ in 0..k + 2 {
            p *= r;
        }
        p / (k + 2) as f64 * ang(i, j)
    };
    let (cr, cy) = c;
    Moments {
        m0: cr * term(0, 0, 0) + term(1, 1, 0),
        m1: cr * cy * term(0, 0, 0) + cr * term(1, 0, 1) + cy * term(1, 1, 0) + term(2, 1, 1),
        m3: cr * cr * cr * term(0, 0, 0) + 3.0 * cr * cr * term(1, 1, 0) + 3.0 * cr * term(2, 2, 0) + term(3, 3, 0),
        m12: cr * cy * cy * term(0, 0, 0)
            + 2.0 * cr * cy * term(1, 0, 1)
            + cr * term(2, 0, 2)
            + cy * cy * term(1, 1, 0)
            + 2.0 * cy * term(2, 1, 1)
            + term(3, 1, 2),
    }
}

/// Mass, centre height on the axis, and principal moments (across, along the axis, across) about the centre of a cylinder
/// or cone of core `shape` and border `b` at `density`.
pub fn revolved_mass(shape: Revolved, b: f32, density: f32) -> (f32, f32, V3) {
    let (r, h, b) = (shape.r as f64, shape.h as f64, b as f64);
    let quarter = core::f64::consts::FRAC_PI_2;
    let mut m = Moments::default();
    if shape.cone {
        let length = sqrt64(4.0 * h * h + r * r);
        let (nr, ny) = (2.0 * h / length, r / length);
        let side = atan2(ny as f32, nr as f32) as f64;
        m.add(triangle((0.0, h), (r, -h), (0.0, -h)));
        if b > 0.0 {
            m.add(quad((0.0, h), (r, -h), (r + b * nr, -h + b * ny), (b * nr, h + b * ny)));
            m.add(quad((0.0, -h - b), (r, -h - b), (r, -h), (0.0, -h)));
            m.add(sector((r, -h), b, (-quarter, 0.0, -1.0), (side, nr, ny)));
            m.add(sector((0.0, h), b, (side, nr, ny), (quarter, 0.0, 1.0)));
        }
    } else {
        m.add(quad((0.0, -h), (r, -h), (r, h), (0.0, h)));
        if b > 0.0 {
            m.add(quad((r, -h), (r + b, -h), (r + b, h), (r, h)));
            m.add(quad((0.0, h), (r, h), (r, h + b), (0.0, h + b)));
            m.add(quad((0.0, -h - b), (r, -h - b), (r, -h), (0.0, -h)));
            m.add(sector((r, h), b, (0.0, 1.0, 0.0), (quarter, 0.0, 1.0)));
            m.add(sector((r, -h), b, (-quarter, 0.0, -1.0), (0.0, 1.0, 0.0)));
        }
    }
    let ring = 2.0 * core::f64::consts::PI * density as f64;
    let mass = ring * m.m0;
    let center = if m.m0 > 0.0 { m.m1 / m.m0 } else { 0.0 };
    let along = ring * m.m3;
    let across = ring * (0.5 * m.m3 + m.m12) - mass * center * center;
    (mass as f32, center as f32, v3(across as f32, along as f32, across as f32))
}
