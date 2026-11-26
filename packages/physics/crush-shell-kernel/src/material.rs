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
    let stress = [mean + difference, mean - difference, shear];
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
}
