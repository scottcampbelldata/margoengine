use std::ops::{Add, Mul, Sub};

#[derive(Clone, Copy)]
pub struct Vector(pub f64, pub f64, pub f64);

impl Vector {
    pub fn dot(self, rhs: Self) -> f64 {
        self.0 * rhs.0 + self.1 * rhs.1 + self.2 * rhs.2
    }

    pub fn cross(self, rhs: Self) -> Self {
        Self(
            self.1 * rhs.2 - self.2 * rhs.1,
            self.2 * rhs.0 - self.0 * rhs.2,
            self.0 * rhs.1 - self.1 * rhs.0,
        )
    }

    pub fn length(self) -> f64 {
        self.dot(self).sqrt()
    }
}

impl Add for Vector {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self(self.0 + rhs.0, self.1 + rhs.1, self.2 + rhs.2)
    }
}

impl Sub for Vector {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self {
        Self(self.0 - rhs.0, self.1 - rhs.1, self.2 - rhs.2)
    }
}

impl Mul<f64> for Vector {
    type Output = Self;

    fn mul(self, rhs: f64) -> Self {
        Self(self.0 * rhs, self.1 * rhs, self.2 * rhs)
    }
}

#[derive(Clone, Copy)]
struct Edge {
    length: f64,
    along: Vector,
    outward: Vector,
}

pub struct Panel {
    pub centre: Vector,
    pub normal: Vector,
    pub area: f64,
    pub motion: [f64; 6],
    pub quadrature: [Vector; 3],
    vertices: [Vector; 3],
    edges: [Edge; 3],
}

impl Panel {
    pub fn new(vertices: [Vector; 3], reference: Vector) -> Option<Self> {
        let [a, b, c] = vertices;
        let direction = (b - a).cross(c - a);
        let twice_area = direction.length();
        if !twice_area.is_finite() || twice_area <= f64::MIN_POSITIVE {
            return None;
        }
        let area = twice_area * 0.5;
        let normal = direction * (1.0 / twice_area);
        let centre = (a + b + c) * (1.0 / 3.0);
        let moment = (centre - reference).cross(normal);
        let motion = [normal.0, normal.1, normal.2, moment.0, moment.1, moment.2];
        let edges = std::array::from_fn(|i| {
            let tangent = vertices[(i + 1) % 3] - vertices[i];
            let length = tangent.length();
            let along = tangent * (1.0 / length);
            Edge {
                length,
                along,
                outward: along.cross(normal),
            }
        });
        let quadrature = vertices.map(|v| (centre + v) * 0.5);
        Some(Self {
            vertices,
            centre,
            normal,
            area,
            motion,
            edges,
            quadrature,
        })
    }

    /// Analytic integral of 1/r and minus its source-normal derivative (signed solid angle).
    pub fn rankine(&self, target: Vector, same_panel: bool) -> (f64, f64) {
        let rays = self.vertices.map(|v| v - target);
        let lengths = rays.map(Vector::length);
        let [a, b, c] = rays;
        let [ra, rb, rc] = lengths;
        let angle = if same_panel {
            0.0
        } else {
            let numerator = a.dot(b.cross(c));
            let denominator = ra * rb * rc + a.dot(b) * rc + b.dot(c) * ra + c.dot(a) * rb;
            2.0 * numerator.atan2(denominator)
        };
        let mut potential = -a.dot(self.normal) * angle;
        for (i, edge) in self.edges.iter().enumerate() {
            let next = (i + 1) % 3;
            let ray = rays[i];
            let offset = ray.dot(edge.outward);
            if offset == 0.0 {
                continue;
            }
            let distance = lengths[i] + lengths[next];
            let remainder = distance - edge.length;
            let integral = if remainder > 1e-8 * distance {
                ((distance + edge.length) / remainder).ln()
            } else {
                let from = ray.dot(edge.along);
                let to = rays[next].dot(edge.along);
                let p = lengths[i] + from.abs();
                let q = lengths[next] + to.abs();
                if from < 0.0 && to >= 0.0 {
                    let perpendicular = ray.cross(edge.along).length();
                    (p / perpendicular).ln() + (q / perpendicular).ln()
                } else {
                    to.signum() * (q / p).ln()
                }
            };
            potential += offset * integral;
        }
        (potential, angle)
    }
}
