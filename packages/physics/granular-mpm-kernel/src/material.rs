use margoengine_physics_kernel_common::pinned::{exp, ln};

use super::tensor::{M, Spectrum, V, dot, sqrt};

#[repr(C)]
pub(crate) struct Material {
    pub(crate) shear: f64,
    pub(crate) lame: f64,
    pub(crate) friction: f64,
    pub(crate) cohesion: f64,
    pub(crate) snow: f64,
    pub(crate) compression: f64,
    pub(crate) stretch: f64,
    pub(crate) hardening: f64,
    pub(crate) static_friction: f64,
    pub(crate) friction_range: f64,
    pub(crate) inertial_scale: f64,
}

impl Material {
    pub(crate) fn moduli(&self, plastic: f64) -> (f64, f64) {
        let factor = if self.snow == 0.0 {
            1.0
        } else {
            exp(self.hardening * (1.0 - exp(plastic)))
        };
        (self.shear * factor, self.lame * factor)
    }

    pub(crate) fn stress(&self, frame: &Spectrum, plastic: f64) -> M {
        let (mu, lambda) = self.moduli(plastic);
        let diagonal = if self.snow == 0.0 {
            let strain = frame.stretch.map(ln);
            let bulk = lambda * (strain[0] + strain[1] + strain[2]);
            strain.map(|value| 2.0 * mu * value + bulk)
        } else {
            let j = frame.stretch[0] * frame.stretch[1] * frame.stretch[2];
            let bulk = lambda * (j - 1.0) * j;
            frame
                .stretch
                .map(|value| 2.0 * mu * (value - 1.0) * value + bulk)
        };
        frame.kirchhoff(diagonal)
    }

    fn inertial_limit(&self, length: f64, trace: f64, plastic: f64, dt: f64) -> f64 {
        let pressure = -(self.lame + 2.0 * self.shear / 3.0) * trace;
        let shear_scale = core::f64::consts::SQRT_2 * self.shear;
        let static_limit = pressure * self.static_friction;
        let excess = length * shear_scale - static_limit;
        if excess <= 0.0 {
            return length;
        }
        // Plastic flow preserves the trace. Convert Kirchhoff pressure to Cauchy pressure for I.
        let range = pressure * self.friction_range;
        let scale =
            self.shear * dt * self.inertial_scale * sqrt(pressure) * exp(-0.5 * (trace + plastic));
        if range == 0.0 || !scale.is_finite() {
            return static_limit / shear_scale;
        }
        // The shifted quadratic for the excess shear x has x² - (a + b + c)x + ab = 0.
        // Normalization avoids range overflow, and the rationalized smaller root avoids cancellation.
        let max = excess.max(range).max(scale);
        let (a, b, c) = (excess / max, range / max, scale / max);
        let denominator = a + b + c + sqrt((a - b) * (a - b) + c * (2.0 * (a + b) + c));
        (static_limit + excess * (2.0 * b / denominator)) / shear_scale
    }

    pub(crate) fn project(&self, trial: &Spectrum, previous_plastic: f64, dt: f64) -> (V, f64) {
        let elastic = if self.snow != 0.0 {
            trial
                .stretch
                .map(|value| value.max(1.0 - self.compression).min(1.0 + self.stretch))
        } else {
            let log_stretch = trial.stretch.map(ln);
            let trace = log_stretch[0] + log_stretch[1] + log_stretch[2];
            let apex = self.cohesion / (self.friction * (3.0 * self.lame + 2.0 * self.shear));
            if trace > apex {
                [exp(apex / 3.0); 3]
            } else {
                let mean = trace / 3.0;
                let deviator = log_stretch.map(|strain| strain - mean);
                let length = sqrt(dot(deviator, deviator));
                let pressure = -(3.0 * self.lame + 2.0 * self.shear) * trace;
                let allowed = if self.inertial_scale > 0.0 {
                    self.inertial_limit(length, trace, previous_plastic, dt)
                } else {
                    ((self.cohesion + self.friction * pressure) / (2.0 * self.shear)).max(0.0)
                };
                if length > allowed {
                    deviator.map(|strain| exp(mean + strain * allowed / length))
                } else {
                    trial.stretch
                }
            }
        };
        let plastic = ln(trial.stretch[0] / elastic[0])
            + ln(trial.stretch[1] / elastic[1])
            + ln(trial.stretch[2] / elastic[2]);
        (elastic, plastic)
    }
}
