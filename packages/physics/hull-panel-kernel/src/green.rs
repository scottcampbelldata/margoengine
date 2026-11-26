use std::f64::consts::{FRAC_PI_2, PI};

use crate::complex::Complex;
use crate::depth::BedCorrection;
use crate::geometry::{Panel, Vector};

const EULER: f64 = 0.577_215_664_901_532_9;

/// Scaled E1 on the upper side of its cut. The branch term is combined with the logarithm in the series.
fn exponential_integral(z: Complex) -> (Complex, Complex) {
    let exponential = z.exp();
    if z.squared() > 24.0 * 24.0 {
        // DLMF 6.12.1, cut off at the least term.
        let inverse = Complex::ONE / z;
        let mut term = inverse;
        let mut sum = term;
        for n in 1..64 {
            let next = term * inverse * -(n as f64);
            if next.squared() >= term.squared() {
                break;
            }
            sum += next;
            term = next;
        }
        return (sum + exponential * Complex::new(0.0, PI), exponential);
    }
    let base = -z;
    let mut term = Complex::ONE;
    let mut sum = Complex::ZERO;
    for n in 1..128 {
        term = term * base * (1.0 / n as f64);
        sum += term * (1.0 / n as f64);
        if term.squared() <= 1e-32 * (1.0 + sum.squared()) {
            break;
        }
    }
    let log = Complex::new(0.5 * base.squared().ln(), base.im.atan2(base.re));
    (
        exponential * (Complex::real(-EULER) - log - sum),
        exponential,
    )
}

pub struct Green {
    pub wavenumber: f64,
    pub depth: f64,
    angular: Vec<f64>,
    bed: Option<BedCorrection>,
}

impl Green {
    pub fn new(wavenumber: f64, depth: f64, diameter: f64) -> Self {
        let bed = (wavenumber > 0.0 && depth.is_finite())
            .then(|| BedCorrection::new(wavenumber, depth, diameter));
        // The deep outgoing function at this same frequency has k = omega^2/g.
        let wavenumber = if bed.is_some() {
            wavenumber * (wavenumber * depth).tanh()
        } else {
            wavenumber
        };
        let count = 24 + (wavenumber.max(0.0) * diameter).ceil() as usize;
        let angular = (0..count)
            .map(|i| ((i as f64 + 0.5) * FRAC_PI_2 / count as f64).cos())
            .collect();
        Self {
            wavenumber,
            depth,
            angular,
            bed,
        }
    }

    /// Integrated Green potential and minus its source-normal derivative on an outward hull panel.
    pub fn panel(&self, target: Vector, source: &Panel, diagonal: bool) -> (Complex, Complex) {
        let (direct, direct_angle) = source.rankine(target, diagonal);
        let mirror_position = Vector(target.0, -target.1, target.2);
        let (mirror, mirror_angle) = source.rankine(mirror_position, false);
        if self.wavenumber < 0.0 {
            let mut potential = direct - mirror;
            let mut angle = direct_angle - mirror_angle;
            if self.depth.is_finite() {
                // Alternating free-surface and bed images in the infinite-frequency limit.
                for i in 1..=12 {
                    let sign = if i % 2 == 1 { -1.0 } else { 1.0 };
                    let distance = 2.0 * i as f64 * self.depth;
                    for shift in [-distance, distance] {
                        let (p, a) = source.rankine(target + Vector(0.0, shift, 0.0), false);
                        let (m, b) =
                            source.rankine(mirror_position + Vector(0.0, shift, 0.0), false);
                        potential += sign * (p - m);
                        angle += sign * (a - b);
                    }
                }
            }
            return (Complex::real(potential), Complex::real(angle));
        }
        // The angular integral of -1/z transfers two mirror terms into the analytic Rankine part.
        let mut potential = Complex::real(direct + mirror);
        let mut angle = Complex::real(direct_angle + mirror_angle);
        if self.bed.is_some() {
            let (p, a) = source.rankine(
                Vector(target.0, -2.0 * self.depth - target.1, target.2),
                false,
            );
            potential += Complex::real(p);
            angle += Complex::real(a);
        }
        for point in source.quadrature {
            let (p, a) = self.deep_wave(target, point, source.normal);
            let weight = source.area / 3.0;
            potential += p * weight;
            angle += a * weight;
            if let Some(bed) = &self.bed {
                let (p, a) = bed.point(target, point, source.normal);
                potential += p * weight;
                angle += a * weight;
            }
        }
        (potential, angle)
    }

    /// Rohrer et al. (2024), Eqs. 22–24, after analytic extraction of the Rankine image.
    fn deep_wave(&self, target: Vector, point: Vector, normal: Vector) -> (Complex, Complex) {
        let k = self.wavenumber;
        let delta = point - target;
        let horizontal = delta.0.hypot(delta.2);
        let vertical = k * (point.1 + target.1);
        let radial = if horizontal > 0.0 {
            (delta.0 * normal.0 + delta.2 * normal.2) / horizontal
        } else {
            0.0
        };
        let mut potential = Complex::ZERO;
        let mut derivative = Complex::ZERO;
        if k == 0.0 {
            return (potential, derivative);
        }
        for cosine in &self.angular {
            let z = Complex::new(vertical, k * horizontal * cosine);
            let dz = Complex::new(k * normal.1, k * radial * cosine);
            let (j, exponential) = exponential_integral(z);
            potential += Complex::new(j.re, PI * exponential.re);
            derivative -=
                Complex::new(((j - Complex::ONE / z) * dz).re, PI * (exponential * dz).re);
        }
        let weight = 2.0 * k / self.angular.len() as f64;
        (potential * weight, derivative * weight)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(green: &Green, target: Vector, source: Vector) -> Complex {
        let rankine = |point: Vector| Complex::real(1.0 / (point - target).length());
        let mut point = rankine(source) + rankine(Vector(source.0, -source.1, source.2));
        point += green.deep_wave(target, source, Vector(0.0, 1.0, 0.0)).0;
        if let Some(bed) = &green.bed {
            point += rankine(Vector(source.0, -2.0 * green.depth - source.1, source.2));
            point += bed.point(target, source, Vector(0.0, 1.0, 0.0)).0;
        }
        point
    }

    #[test]
    fn finite_depth_outgoing_kernel_satisfies_surface_and_bed() {
        let source = Vector(0.0, -0.4, 0.0);
        let depth = 1.5;
        let epsilon = 1e-6;
        for k in [0.12, 0.8, 2.1] {
            let green = Green::new(k, depth, 4.0);
            let surface = at(&green, Vector(0.92, 0.0, 0.4), source);
            let surface_away = at(&green, Vector(0.92, -epsilon, 0.4), source);
            let surface_slope = (surface - surface_away) * (1.0 / epsilon);
            let error = surface_slope - surface * (k * (k * depth).tanh());
            assert!(
                error.squared().sqrt() < 2e-5,
                "k={k}, surface error {error:?}"
            );
            let bottom = at(&green, Vector(0.92, -depth, 0.4), source);
            let bottom_away = at(&green, Vector(0.92, -depth + epsilon, 0.4), source);
            let error = (bottom_away - bottom) * (1.0 / epsilon);
            assert!(
                error.squared().sqrt() < 2e-5,
                "k={k}, bottom error {error:?}"
            );
        }
    }
}
