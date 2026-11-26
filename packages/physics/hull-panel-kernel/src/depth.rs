use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};

use crate::complex::Complex;
use crate::geometry::Vector;

const NODES: [f64; 4] = [
    -0.861_136_311_594_052_6,
    -0.339_981_043_584_856_3,
    0.339_981_043_584_856_3,
    0.861_136_311_594_052_6,
];
const WEIGHTS: [f64; 4] = [
    0.347_854_845_137_453_8,
    0.652_145_154_862_546_1,
    0.652_145_154_862_546_1,
    0.347_854_845_137_453_8,
];
const CONTOUR_DEPTH: f64 = 0.45;
const MAX_WAVENUMBER: f64 = 36.0;

pub struct BedCorrection {
    depth: f64,
    contour: Vec<ContourPoint>,
}

struct ContourPoint {
    q: Complex,
    r: Complex,
    factor: Complex,
    bottom: Complex,
}

impl BedCorrection {
    pub fn new(wave_number: f64, depth: f64, diameter: f64) -> Self {
        // The free-surface Robin coefficient is nu/h, where nu = kh tanh(kh).
        let kh = wave_number * depth;
        let nu = Complex::real(kh * kh.tanh());
        let mut contour = Vec::new();
        let mut add = |q: Complex, weight: Complex| {
            let r = (q + nu) / (q - nu);
            let bottom = (q * -2.0).exp();
            let factor = weight * r / (Complex::ONE - r * bottom);
            contour.push(ContourPoint {
                q,
                r,
                factor,
                bottom,
            });
        };
        let mut begin = 0.0;
        let mut step = (0.5 * nu.re).clamp(1e-7, 0.125 * CONTOUR_DEPTH);
        while begin < CONTOUR_DEPTH {
            let end = (begin + step).min(CONTOUR_DEPTH);
            let half = 0.5 * (end - begin);
            for (node, weight) in NODES.into_iter().zip(WEIGHTS) {
                add(
                    Complex::new(0.0, -(begin + half * (1.0 + node))),
                    Complex::new(0.0, -half * weight),
                );
            }
            begin = end;
            step *= 1.5;
        }
        // Integrate below both outgoing-wave poles. The largest remaining exponent is exp(-q)
        // after taking out the nearest bottom image. Subdivision also resolves the Bessel phase.
        let intervals = (MAX_WAVENUMBER * (diameter / depth).max(4.0)).ceil() as usize;
        let step = MAX_WAVENUMBER / intervals as f64;
        for segment in 0..intervals {
            for (node, weight) in NODES.into_iter().zip(WEIGHTS) {
                add(
                    Complex::new(step * (segment as f64 + 0.5 * (1.0 + node)), -CONTOUR_DEPTH),
                    Complex::real(0.5 * step * weight),
                );
            }
        }
        Self { depth, contour }
    }

    /// The bottom reflected correction to the deep-water Green function, with the nearest image removed.
    /// The Hankel transform accounts for repeated reflections by dividing by one minus r exp(-2q).
    /// Here q is the integration wavenumber times depth and r is the surface reflection coefficient.
    pub fn point(&self, target: Vector, source: Vector, normal: Vector) -> (Complex, Complex) {
        let delta = source - target;
        let distance = delta.0.hypot(delta.2);
        let radial = if distance > 0.0 {
            (delta.0 * normal.0 + delta.2 * normal.2) / distance
        } else {
            0.0
        };
        let radius = distance / self.depth;
        let a = target.1 / self.depth;
        let b = source.1 / self.depth;
        let mut potential = Complex::ZERO;
        let mut derivative = Complex::ZERO;
        for point in &self.contour {
            let q = point.q;
            let toward = (q * (-2.0 - a + b)).exp();
            let away = (q * (-2.0 + a - b)).exp();
            let upper = (q * (-2.0 + a + b)).exp() * point.r;
            let lower = (q * (-2.0 - a - b)).exp() * point.bottom;
            let value = toward + away + upper + lower;
            let slope = toward - away + upper - lower;
            let z = q * radius;
            let j0 = bessel(0, z);
            let j1 = if radial == 0.0 {
                Complex::ZERO
            } else {
                bessel(1, z)
            };
            potential += point.factor * j0 * value;
            derivative += point.factor * q * (j1 * value * radial - j0 * slope * normal.1);
        }
        (
            potential * (1.0 / self.depth),
            derivative * (1.0 / (self.depth * self.depth)),
        )
    }
}

/// J0 and J1 for complex arguments on the shallow contour, using DLMF 10.2.2 and 10.17.3.
fn bessel(order: usize, z: Complex) -> Complex {
    if z.squared() < 100.0 {
        let mut term = if order == 0 { Complex::ONE } else { z * 0.5 };
        let mut sum = term;
        let ratio = z * z * -0.25;
        for m in 1..48 {
            term = term * ratio * (1.0 / (m * (m + order)) as f64);
            sum += term;
            if term.squared() < 1e-33 {
                break;
            }
        }
        return sum;
    }
    let phase = z - Complex::real(FRAC_PI_4 + order as f64 * FRAC_PI_2);
    let forward = Complex::new(-phase.im, phase.re).exp();
    let backward = Complex::new(phase.im, -phase.re).exp();
    let cosine = (forward + backward) * 0.5;
    let sine = (forward - backward) * Complex::new(0.0, -0.5);
    let inverse = Complex::ONE / z;
    let mut term = Complex::ONE;
    let mut sum = cosine;
    for m in 1..40 {
        let odd = (2 * m - 1) as f64;
        let next =
            term * inverse * ((4 * order * order) as f64 - odd * odd) * (1.0 / (8 * m) as f64);
        if next.squared() >= term.squared() {
            break;
        }
        sum += next
            * match m % 4 {
                0 => cosine,
                1 => -sine,
                2 => -cosine,
                _ => sine,
            };
        term = next;
    }
    let root_re = (0.5 * (z.re.hypot(z.im) + z.re)).sqrt();
    sum * (2.0 / PI).sqrt() / Complex::new(root_re, 0.5 * z.im / root_re)
}
