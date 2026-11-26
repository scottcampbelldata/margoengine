//! A compressible continuation of the Arruda–Boyce chain energy and the Gent–Thomas transverse invariant.
//! The volume term restores the caller's small-strain Lamé parameters and gives zero stress at rest.

use crate::vertex_block::{Columns, Vec3, cross, dot, transform};
use margoengine_physics_kernel_common::pinned::ln;

const COEFFICIENTS: [f64; 5] = [
    0.5,
    1.0 / 20.0,
    11.0 / 1050.0,
    19.0 / 7050.0,
    519.0 / 673750.0,
];

#[derive(Clone, Copy)]
struct Term {
    energy: f64,
    first: f64,
    second: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct RubberLaw {
    inverse_links: f64,
    chain_scale: f64,
    transverse: f64,
    spread: f64,
    pressure: f64,
    bulk: f64,
}

impl RubberLaw {
    pub(crate) fn new(
        mu: f64,
        lambda: f64,
        locking_stretch: f64,
        transverse_fraction: f64,
        spread: f64,
    ) -> Self {
        let inverse_links = 1.0 / (locking_stretch * locking_stretch);
        let rest = chain(3.0, inverse_links);
        let transverse = 0.5 * mu * transverse_fraction;
        let chain_scale = (0.5 * mu - transverse) / rest.first;
        let chain_rest = chain_scale * rest.first;
        let pressure = 2.0 * chain_rest + 4.0 * transverse;
        let bulk = lambda + 2.0 * chain_rest - 4.0 * chain_scale * rest.second
            + 16.0 * transverse / spread;
        Self {
            inverse_links,
            chain_scale,
            transverse,
            spread,
            pressure,
            bulk,
        }
    }

    pub(crate) fn valid(self) -> bool {
        self.bulk.is_finite() && self.bulk > 0.0
    }

    /// Value and first/second derivative with respect to I₁, I₂ and J.
    pub(crate) fn invariants(
        self,
        first: f64,
        second: f64,
        jacobian: f64,
    ) -> (f64, [f64; 3], [f64; 3]) {
        let t1 = chain(first, self.inverse_links);
        let rest = chain(3.0, self.inverse_links).energy;
        let t2 = transverse(second, self.spread);
        let gap = jacobian - 1.0;
        let value = self.chain_scale * (t1.energy - rest)
            + self.transverse * t2.energy
            + (0.5 * self.bulk * gap - self.pressure) * gap;
        let derivative = [
            self.chain_scale * t1.first,
            self.transverse * t2.first,
            self.bulk * gap - self.pressure,
        ];
        let curvature = [
            self.chain_scale * t1.second,
            self.transverse * t2.second,
            self.bulk,
        ];
        (value, derivative, curvature)
    }
}

fn chain(invariant: f64, inverse_links: f64) -> Term {
    let ratio = invariant * inverse_links;
    let mut energy = 0.0;
    let mut first = 0.0;
    let mut second = 0.0;
    for k in (1..=COEFFICIENTS.len()).rev() {
        let coefficient = COEFFICIENTS[k - 1];
        energy = energy * ratio + coefficient;
        first = first * ratio + k as f64 * coefficient;
        if k >= 2 {
            second = second * ratio + (k * (k - 1)) as f64 * coefficient;
        }
    }
    Term {
        energy: invariant * energy,
        first,
        second: inverse_links * second,
    }
}

/// Continues the logarithm with its second-order Taylor polynomial below I₂ = 3. The
/// isochoric law is exact on I₂ ≥ 3. A collapsed element still has finite stresses.
fn transverse(invariant: f64, spread: f64) -> Term {
    let delta = invariant - 3.0;
    let q = delta / spread;
    if delta < 0.0 {
        return Term {
            energy: delta * (1.0 - q * 0.5),
            first: 1.0 - q,
            second: -1.0 / spread,
        };
    }
    let reciprocal = 1.0 / (1.0 + q);
    Term {
        energy: spread * ln(1.0 + q),
        first: reciprocal,
        second: -reciprocal * reciprocal / spread,
    }
}

pub(crate) const COMPONENTS: [(usize, usize); 6] = [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)];

/// Per-vertex energy derivative. F is affine and both its determinant and cofactor are affine in a single vertex update.
pub(crate) fn vertex_terms(
    law: RubberLaw,
    f: Columns,
    cofactor: Columns,
    shape: Vec3,
) -> (Vec3, [f64; 6]) {
    let i1 = f.iter().map(|&axis| dot(axis, axis)).sum();
    let i2 = cofactor.iter().map(|&axis| dot(axis, axis)).sum();
    let j = dot(f[0], cofactor[0]);
    let (_, s, h) = law.invariants(i1, i2, j);
    let g1 = transform(f, shape).map(|value| 2.0 * value);
    let gj = transform(cofactor, shape);

    let mut g2 = [0.0; 3];
    let mut h2 = [0.0; 6];
    for (column, a, b) in [(0, 1, 2), (1, 2, 0), (2, 0, 1)] {
        let u = [0, 1, 2].map(|axis| shape[a] * f[b][axis] - shape[b] * f[a][axis]);
        let g = cross(u, cofactor[column]);
        for axis in 0..3 {
            g2[axis] += 2.0 * g[axis];
        }
        let u2 = dot(u, u);
        for (k, (a, b)) in COMPONENTS.into_iter().enumerate() {
            h2[k] += 2.0 * ((if a == b { u2 } else { 0.0 }) - u[a] * u[b]);
        }
    }

    let volume = 2.0 * dot(shape, shape);
    let grad = [0, 1, 2].map(|i| s[0] * g1[i] + s[1] * g2[i] + s[2] * gj[i]);
    // Take the tangent majorizer of the concave transverse energy. Its dropped term is negative semidefinite.
    let block = core::array::from_fn(|component| {
        let (a, b) = COMPONENTS[component];
        let isotropic = if a == b { s[0] * volume } else { 0.0 };
        isotropic + h[0] * g1[a] * g1[b] + s[1] * h2[component] + h[2] * gj[a] * gj[b]
    });
    (grad, block)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivatives_and_lame_constants_at_rest() {
        let (mu, lambda) = (9000.0, 45000.0);
        let law = RubberLaw::new(mu, lambda, 4.0, 0.37, 3.0);
        assert!(law.valid());
        let (energy, p, h) = law.invariants(3.0, 3.0, 1.0);
        assert_eq!(energy, 0.0);
        assert!((2.0 * p[0] + 4.0 * p[1] + p[2]).abs() < 16.0 * f64::EPSILON * mu);
        assert!((2.0 * p[0] + 2.0 * p[1] - mu).abs() < 16.0 * f64::EPSILON * mu);
        assert!(
            (4.0 * h[0] + 16.0 * h[1] + h[2] - 2.0 * p[0] - lambda).abs()
                < 16.0 * f64::EPSILON * lambda
        );
    }

    #[test]
    fn large_stretch_and_collapsed_inversion_have_consistent_derivatives() {
        let law = RubberLaw::new(6000.0, 60000.0, 4.2, 0.2, 3.0);
        for [i1, i2, jacobian] in [[29.0, 43.0, 1.0], [1.0, 0.1, -0.02], [3.45, 3.0, 0.25]] {
            let (_, derivative, curvature) = law.invariants(i1, i2, jacobian);
            let inputs = [i1, i2, jacobian];
            for axis in 0..3 {
                let step = 2e-5;
                let mut lower = inputs;
                let mut upper = inputs;
                lower[axis] -= step;
                upper[axis] += step;
                let (e0, p0, _) = law.invariants(lower[0], lower[1], lower[2]);
                let (e1, p1, _) = law.invariants(upper[0], upper[1], upper[2]);
                let measured = (e1 - e0) / (2.0 * step);
                let tangent = (p1[axis] - p0[axis]) / (2.0 * step);
                assert!(
                    (measured - derivative[axis]).abs() < 2e-5 * derivative[axis].abs().max(1.0)
                );
                assert!((tangent - curvature[axis]).abs() < 2e-5 * curvature[axis].abs().max(1.0));
            }
        }
    }
}
