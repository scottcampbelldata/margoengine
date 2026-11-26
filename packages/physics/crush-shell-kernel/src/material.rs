use crate::math::sqrt;

/// Plane stress material with a linear isotropic hardening modulus.
#[derive(Clone, Copy)]
#[repr(C)]
pub(crate) struct Steel {
    pub young: f64,
    pub poisson: f64,
    pub yield_stress: f64,
    pub hardening: f64,
}

/// Hill's orthotropic plane-stress metric, normalized by the rolling-direction yield stress.
#[derive(Clone, Copy)]
#[repr(C)]
pub(crate) struct Hill {
    pub f: f64,
    pub g: f64,
    pub h: f64,
    pub n: f64,
}

impl Hill {
    fn equivalent(self, [xx, yy, xy]: [f64; 3]) -> f64 {
        let scale = xx.abs().max(yy.abs()).max(xy.abs());
        if scale == 0.0 {
            return 0.0;
        }
        let u = xx / scale;
        let v = yy / scale;
        let w = xy / scale;
        let difference = u - v;
        scale
            * sqrt(
                self.g * u * u
                    + self.f * v * v
                    + self.h * difference * difference
                    + 2.0 * self.n * w * w,
            )
    }
}

/// In-plane plastic normal strains and engineering shear, equivalent strain and work.
#[derive(Clone, Copy, Default)]
#[repr(C)]
pub(crate) struct Plastic {
    pub strain: [f64; 3],
    pub equivalent: f64,
    pub dissipated: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct Stress {
    pub stress: [f64; 3],
    pub state: Plastic,
    pub elastic: f64,
    pub hardened: f64,
}

fn equivalent(mean: f64, difference: f64, shear: f64) -> f64 {
    // Normalize before squaring the stress components.
    let scale = mean.abs().max(difference.abs()).max(shear.abs());
    if scale == 0.0 {
        return 0.0;
    }
    let a = mean / scale;
    let b = difference / scale;
    let c = shear / scale;
    scale * sqrt(a * a + 3.0 * (b * b + c * c))
}

/// Constrained backward Euler in the plane-stress subspace (Simo and Taylor, 1986).
pub(crate) fn return_stress(steel: Steel, total: [f64; 3], mut state: Plastic) -> Stress {
    let shear_modulus = steel.young / (2.0 * (1.0 + steel.poisson));
    let area_modulus = steel.young / (1.0 - steel.poisson);
    let x = total[0] - state.strain[0];
    let y = total[1] - state.strain[1];
    let xy = total[2] - state.strain[2];
    let trial_mean = 0.5 * area_modulus * (x + y);
    let trial_difference = shear_modulus * (x - y);
    let trial_shear = shear_modulus * xy;
    let yield_at_start = steel.yield_stress + steel.hardening * state.equivalent;
    let q_trial = equivalent(trial_mean, trial_difference, trial_shear);
    let (mean, difference, shear) = if q_trial <= yield_at_start {
        (trial_mean, trial_difference, trial_shear)
    } else {
        let area = 0.5 * area_modulus;
        let distort = 3.0 * shear_modulus;
        let projected = |gamma: f64| {
            let q = yield_at_start + steel.hardening * gamma;
            let step = gamma / q;
            let mean = trial_mean / (1.0 + area * step);
            let lateral = 1.0 + distort * step;
            (q, mean, trial_difference / lateral, trial_shear / lateral)
        };
        // Both principal return factors are at least the smaller elastic slope.
        // At this gamma their equivalent stress cannot exceed the new yield stress.
        let mut low = 0.0;
        let mut high = (q_trial - yield_at_start) / (steel.hardening + area.min(distort));
        for _ in 0..48 {
            let gamma = low + 0.5 * (high - low);
            let (q, mean, difference, shear) = projected(gamma);
            if equivalent(mean, difference, shear) > q {
                low = gamma;
            } else {
                high = gamma;
            }
        }
        let gamma = low + 0.5 * (high - low);
        let (q, mean, difference, shear) = projected(gamma);
        let rate = 0.5 * gamma / q;
        state.strain[0] += rate * (mean + 3.0 * difference);
        state.strain[1] += rate * (mean - 3.0 * difference);
        state.strain[2] += 6.0 * rate * shear;
        state.equivalent += gamma;
        state.dissipated += steel.yield_stress * gamma;
        (mean, difference, shear)
    };
    finish(
        steel,
        total,
        state,
        [mean + difference, mean - difference, shear],
    )
}

/// Backward Euler with the full Hill yield normal in the constrained plane-stress space.
pub(crate) fn return_hill(steel: Steel, hill: Hill, total: [f64; 3], mut state: Plastic) -> Stress {
    let nu = steel.poisson;
    let c = steel.young / (1.0 - nu * nu);
    let shear = steel.young / (2.0 * (1.0 + nu));
    let x = total[0] - state.strain[0];
    let y = total[1] - state.strain[1];
    let xy = total[2] - state.strain[2];
    let trial = [c * (x + nu * y), c * (y + nu * x), shear * xy];
    let current_yield = steel.yield_stress + steel.hardening * state.equivalent;
    let trial_equivalent = hill.equivalent(trial);
    if trial_equivalent <= current_yield {
        return finish(steel, total, state, trial);
    }

    let ax = hill.g + hill.h;
    let ay = hill.f + hill.h;
    let az = 2.0 * hill.n;
    // All normal entries below use the scaled C A matrix. Its determinant is a
    // sum of positive principal minors, even when an off-diagonal sign changes.
    let bxx = ax - nu * hill.h;
    let byy = ay - nu * hill.h;
    let bxy = nu * ay - hill.h;
    let byx = nu * ax - hill.h;
    let det_a = hill.f * hill.g + hill.h * (hill.f + hill.g);
    let det_b = (1.0 - nu * nu) * det_a;
    let project = |gamma: f64| {
        let yield_at_return = current_yield + steel.hardening * gamma;
        let factor = gamma / yield_at_return;
        let p = c * factor;
        let det = 1.0 + p * (bxx + byy) + p * p * det_b;
        (
            yield_at_return,
            [
                ((1.0 + p * byy) * trial[0] - p * bxy * trial[1]) / det,
                ((1.0 + p * bxx) * trial[1] - p * byx * trial[0]) / det,
                trial[2] / (1.0 + shear * az * factor),
            ],
        )
    };
    // The return contracts in the A metric. A lower eigenvalue bound of C A is
    // the product of the minimum eigenvalues of C and A.
    let lower_a = (det_a / (ax + ay)).min(az);
    let lower_c = shear.min(steel.young / (1.0 - nu));
    let lower = lower_a * lower_c;
    let mut low = 0.0;
    let mut high = (trial_equivalent - current_yield) / (steel.hardening + lower);
    for _ in 0..48 {
        let gamma = low + 0.5 * (high - low);
        let (yield_at_return, stress) = project(gamma);
        if hill.equivalent(stress) > yield_at_return {
            low = gamma;
        } else {
            high = gamma;
        }
    }
    let gamma = low + 0.5 * (high - low);
    let (yield_at_return, stress) = project(gamma);
    let multiplier = gamma / yield_at_return;
    state.strain[0] += multiplier * (ax * stress[0] - hill.h * stress[1]);
    state.strain[1] += multiplier * (ay * stress[1] - hill.h * stress[0]);
    state.strain[2] += multiplier * az * stress[2];
    state.equivalent += gamma;
    state.dissipated += steel.yield_stress * gamma;
    finish(steel, total, state, stress)
}

fn finish(steel: Steel, total: [f64; 3], state: Plastic, stress: [f64; 3]) -> Stress {
    let elastic = 0.5
        * (stress[0] * (total[0] - state.strain[0])
            + stress[1] * (total[1] - state.strain[1])
            + stress[2] * (total[2] - state.strain[2]));
    let hardened = 0.5 * steel.hardening * state.equivalent * state.equivalent;
    Stress {
        stress,
        state,
        elastic,
        hardened,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MATERIAL: Steel = Steel {
        young: 200e9,
        poisson: 0.3,
        yield_stress: 270e6,
        hardening: 1.2e9,
    };

    fn near(got: f64, want: f64, bound: f64) {
        assert!(
            (got - want).abs() <= bound,
            "{got} differs from {want} by more than {bound}"
        );
    }

    #[test]
    fn uniaxial_stress_under_plane_stress_reaches_the_analytic_hardened_state() {
        let plastic = 0.012;
        let strength = MATERIAL.yield_stress + MATERIAL.hardening * plastic;
        let elongation = strength / MATERIAL.young;
        let axial = elongation + plastic;
        let transverse = -MATERIAL.poisson * elongation - 0.5 * plastic;
        let answer = return_stress(MATERIAL, [axial, transverse, 0.0], Plastic::default());
        near(answer.stress[0], strength, 3e-6);
        near(answer.stress[1], 0.0, 3e-6);
        near(answer.state.equivalent, plastic, 2e-16);
        near(
            answer.state.dissipated,
            MATERIAL.yield_stress * plastic,
            6e-8,
        );
        near(answer.elastic, 0.5 * strength * elongation, 2e-8);
        near(
            answer.hardened,
            0.5 * MATERIAL.hardening * plastic * plastic,
            6e-8,
        );
        let unloaded = return_stress(MATERIAL, answer.state.strain, answer.state);
        assert_eq!(unloaded.stress, [0.0, 0.0, 0.0]);
        assert_eq!(unloaded.state.dissipated, answer.state.dissipated);
    }

    #[test]
    fn shear_and_equal_biaxial_loads_have_distinct_return_factors() {
        let plastic = 0.008;
        let strength = MATERIAL.yield_stress + MATERIAL.hardening * plastic;
        let yield_shear = strength / 3.0_f64.sqrt();
        let shear_modulus = MATERIAL.young / (2.0 * (1.0 + MATERIAL.poisson));
        let shear = yield_shear / shear_modulus + 3.0_f64.sqrt() * plastic;
        let shear_answer = return_stress(MATERIAL, [0.0, 0.0, shear], Plastic::default());
        near(shear_answer.stress[2], yield_shear, 3e-6);
        near(shear_answer.state.equivalent, plastic, 2e-16);

        let area_strain = strength * (1.0 - MATERIAL.poisson) / MATERIAL.young + 0.5 * plastic;
        let biaxial = return_stress(
            MATERIAL,
            [area_strain, area_strain, 0.0],
            Plastic::default(),
        );
        near(biaxial.stress[0], strength, 3e-6);
        near(biaxial.stress[1], strength, 3e-6);
        near(biaxial.state.equivalent, plastic, 2e-16);
    }

    #[test]
    fn the_isotropic_hill_metric_matches_j2_loading_and_unloading() {
        let hill = Hill {
            f: 0.5,
            g: 0.5,
            h: 0.5,
            n: 1.5,
        };
        let mut left = Plastic::default();
        let mut right = left;
        for strain in [
            [0.003, -0.0002, 0.0016],
            [0.001, 0.0012, 0.0025],
            [0.0012, 0.0013, 0.0017],
        ] {
            let j2 = return_stress(MATERIAL, strain, left);
            let metric = return_hill(MATERIAL, hill, strain, right);
            for (a, b) in j2.stress.into_iter().zip(metric.stress) {
                near(a, b, 1e-5);
            }
            near(j2.state.equivalent, metric.state.equivalent, 3e-16);
            near(j2.state.dissipated, metric.state.dissipated, 1e-7);
            left = j2.state;
            right = metric.state;
        }
    }

    #[test]
    fn uniaxial_aa5086_inputs_predict_all_three_held_out_biaxial_yields() {
        // Chen et al. (2023) section 3.1 and Table 2. Only uniaxial inputs below.
        let [r0, r45, r90] = [0.49, 0.59, 0.51];
        let g = 1.0 / (1.0 + r0);
        let h = r0 * g;
        let f = h / r90;
        let n = (r0 + r90) * (r45 + 0.5) * g / r90;
        let hill = Hill { f, g, h, n };
        let alloy = Steel {
            young: 70e9,
            poisson: 0.33,
            yield_stress: 119.704e6,
            hardening: 150.4e6 * 10.7,
        };
        let gamma = 1e-4;
        let biaxial_metric = (f + g).sqrt();
        let sigma = (alloy.yield_stress + alloy.hardening * gamma) / biaxial_metric;
        let elastic = sigma * (1.0 - alloy.poisson) / alloy.young;
        let strain = [
            elastic + gamma * g / biaxial_metric,
            elastic + gamma * f / biaxial_metric,
            0.0,
        ];
        let result = return_hill(alloy, hill, strain, Plastic::default());
        near(result.stress[0], result.stress[1], 2e-6);
        near(result.state.equivalent, gamma, 3e-17);
        let onset = result.stress[0] - alloy.hardening * result.state.equivalent / biaxial_metric;
        for measured in [106.155e6, 106.259e6, 105.787e6] {
            near(onset, measured, 0.02 * measured);
            assert!(alloy.yield_stress > 1.12 * measured);
        }
    }
}
