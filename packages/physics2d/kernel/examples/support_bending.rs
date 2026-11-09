//! Static bending derivative of the current contact force law.
//! See docs/architecture/physics2d-support-bending.md. This never calls World::step.
use margoengine_physics2d_kernel::{
    error::PhysicsError,
    manifold::{Manifold, collide_coherent, reference_flip},
    math::{Rot, V2, Xf, v2},
    shape::Core,
    solver::{Soft, soft},
    world::{BodyDef, Kind, SPECULATIVE, ShapeDef, World},
};

const SHAPE: [f64; 4] = [0.25, 0.5, 0.75, 1.0];
const EPSILONS: [f64; 3] = [1e-3, 3e-4, 1e-4];

#[derive(Clone, Copy)]
struct Sample {
    manifold: Manifold,
    ra: [V2; 2],
    rb: [V2; 2],
}

struct Column {
    cores: [Core; 5],
    masses: [f32; 5],
    inertias: [f32; 5],
    inverse_mass: [f32; 5],
    inverse_inertia: [f32; 5],
    y: [f64; 5],
    delta: [f64; 4],
    gravity: f32,
    h: f32,
    spring: Soft,
}

struct Evaluation {
    q: f64,
    forces: [[f64; 3]; 5],
    samples: [Sample; 4],
    kii: [[f32; 2]; 4],
    point_force: [[f64; 2]; 4],
}

fn column(payload: f32) -> Result<Column, Box<dyn std::error::Error>> {
    // Checked World creation supplies the live kernel's actual mass properties.
    // No stepping, broad-phase query or private solver state is used.
    let mut world = World::default();
    let ground = Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).map_err(PhysicsError::from)?;
    let unit = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).map_err(PhysicsError::from)?;
    let cores = [ground, unit, unit, unit, unit];
    let mut masses = [0.0; 5];
    let mut inertias = [0.0; 5];
    let mut inverse_mass = [0.0; 5];
    let mut inverse_inertia = [0.0; 5];
    for i in 0..5 {
        let id = world.create_body(&BodyDef {
            kind: if i == 0 { Kind::Static } else { Kind::Dynamic },
            ..Default::default()
        })?;
        world.create_shape(
            id,
            cores[i],
            &ShapeDef {
                density: if i == 4 { payload } else { 1.0 },
                friction: 0.6,
                restitution: 0.0,
            },
        )?;
        let body = &world.bodies[id as usize];
        masses[i] = body.mass;
        inertias[i] = body.inertia;
        inverse_mass[i] = body.inv_mass;
        inverse_inertia[i] = body.inv_inertia;
    }
    let mut delta = [0.0; 4];
    let mut y = [0.0; 5];
    let omega = 2.0 * std::f64::consts::PI * 60.0;
    for j in 0..4 {
        let load = masses[j + 1..].iter().map(|&x| x as f64).sum::<f64>();
        // Existing closed-form centered column: corner normal arms +/-0.5.
        let k_ii = inverse_mass[j] as f64
            + inverse_mass[j + 1] as f64
            + 0.25 * (inverse_inertia[j] as f64 + inverse_inertia[j + 1] as f64);
        delta[j] = load * 9.81 * k_ii / (2.0 * omega * omega);
        y[j + 1] = if j == 0 {
            0.5 - delta[j]
        } else {
            y[j] + 1.0 - delta[j]
        };
    }
    let h = (1.0_f32 / 60.0) / 4.0;
    let spring = soft(60.0, 10.0, h);
    Ok(Column {
        cores,
        masses,
        inertias,
        inverse_mass,
        inverse_inertia,
        y,
        delta,
        gravity: world.settings.gravity.y,
        h,
        spring,
    })
}

impl Column {
    fn sample(
        &self,
        j: usize,
        epsilon: f64,
        zx: &[f64; 5],
        history: bool,
    ) -> Result<Sample, Box<dyn std::error::Error>> {
        let a = j;
        let b = j + 1;
        let rotation = |body: usize| {
            let angle = if body == 0 {
                0.0
            } else {
                epsilon * SHAPE[body - 1]
            };
            Rot {
                c: angle.cos() as f32,
                s: angle.sin() as f32,
            }
        };
        // Like World's narrow phase, use A's center as a pair-local origin.
        // The static ground shape's authored origin is at y=0; its mass center
        // is irrelevant because its inverse metrics are exactly zero.
        let offset = v2(
            (epsilon * (zx[b] - zx[a])) as f32,
            (self.y[b] - self.y[a]) as f32,
        );
        let xa = Xf {
            p: V2::ZERO,
            q: rotation(a),
        };
        let xb = Xf {
            p: offset,
            q: rotation(b),
        };
        let manifold = collide_coherent(
            &self.cores[a],
            xa,
            &self.cores[b],
            xb,
            SPECULATIVE,
            Some(history),
        )?;
        if manifold.count != 2 {
            return Err(format!(
                "j={j} epsilon={epsilon}: expected the specified closed two-point branch, got {}",
                manifold.count
            )
            .into());
        }
        let actual_history = reference_flip(&manifold).ok_or_else(|| {
            format!("j={j} epsilon={epsilon}: expected clipped-face feature history")
        })?;
        if actual_history != history {
            return Err(format!("j={j} epsilon={epsilon}: requested reference history {history}, got {actual_history}").into());
        }
        let ra = manifold.points.map(|p| p.point);
        let rb = ra.map(|p| p.sub(offset));
        Ok(Sample { manifold, ra, rb })
    }

    fn baseline(
        &self,
        history: [bool; 4],
    ) -> Result<([Sample; 4], [f64; 5]), Box<dyn std::error::Error>> {
        let samples = [
            self.sample(0, 0.0, &[0.0; 5], history[0])?,
            self.sample(1, 0.0, &[0.0; 5], history[1])?,
            self.sample(2, 0.0, &[0.0; 5], history[2])?,
            self.sample(3, 0.0, &[0.0; 5], history[3])?,
        ];
        let mut zx = [0.0; 5];
        for j in 0..4 {
            let rly = 0.5 * (samples[j].ra[0].y as f64 + samples[j].ra[1].y as f64);
            let ruy = 0.5 * (samples[j].rb[0].y as f64 + samples[j].rb[1].y as f64);
            let lower_angle = if j == 0 { 0.0 } else { SHAPE[j - 1] };
            // Baseline J_t Z=0: dxU-dxL-rU.y*dthetaU+rL.y*dthetaL=0.
            zx[j + 1] = zx[j] + ruy * SHAPE[j] - rly * lower_angle;
        }
        Ok((samples, zx))
    }

    fn evaluate(
        &self,
        epsilon: f64,
        zx: &[f64; 5],
        histories: [bool; 4],
    ) -> Result<Evaluation, Box<dyn std::error::Error>> {
        let mut forces = [[0.0; 3]; 5];
        for i in 1..5 {
            forces[i][1] = self.masses[i] as f64 * self.gravity as f64;
        }
        let samples = [
            self.sample(0, epsilon, zx, histories[0])?,
            self.sample(1, epsilon, zx, histories[1])?,
            self.sample(2, epsilon, zx, histories[2])?,
            self.sample(3, epsilon, zx, histories[3])?,
        ];
        let mut kii = [[0.0; 2]; 4];
        let mut point_force = [[0.0; 2]; 4];
        for j in 0..4 {
            let sample = samples[j];
            let normal = sample.manifold.normal;
            for p in 0..2 {
                let (ra, rb) = (sample.ra[p], sample.rb[p]);
                // Same f32 cross products, arithmetic order, stored inverse
                // metrics and Soft ratio as the live two-point normal block.
                let (rna, rnb) = (ra.cross(normal), rb.cross(normal));
                let k = self.inverse_mass[j]
                    + self.inverse_mass[j + 1]
                    + self.inverse_inertia[j] * rna * rna
                    + self.inverse_inertia[j + 1] * rnb * rnb;
                let compliance = k * (self.spring.impulse_scale / self.spring.mass_scale);
                if !(k.is_finite() && k > 0.0 && compliance.is_finite() && compliance > 0.0) {
                    return Err(format!("j={j} point={p} epsilon={epsilon}: nonpositive or nonfinite normal metric/compliance").into());
                }
                // Actual f32 geometry/coefficient values, promoted for the
                // force evaluation and accumulation to avoid a second noisy
                // rounding layer. This is the steady force law, not an impulse
                // visit or a reimplementation of the discrete solver.
                let f = -(self.spring.bias_rate as f64)
                    * (sample.manifold.points[p].separation as f64)
                    / (self.h as f64 * compliance as f64);
                if !(f.is_finite() && f > 0.0) {
                    return Err(format!("j={j} point={p} epsilon={epsilon}: expected strictly positive finite normal support, got {f}").into());
                }
                kii[j][p] = k;
                point_force[j][p] = f;
                let (fx, fy) = (f * normal.x as f64, f * normal.y as f64);
                forces[j][0] -= fx;
                forces[j][1] -= fy;
                forces[j][2] -= ra.x as f64 * fy - ra.y as f64 * fx;
                forces[j + 1][0] += fx;
                forces[j + 1][1] += fy;
                forces[j + 1][2] += rb.x as f64 * fy - rb.y as f64 * fx;
            }
        }
        let q: f64 = (1..5)
            .map(|i| zx[i] * forces[i][0] + SHAPE[i - 1] * forces[i][2])
            .sum();
        if !q.is_finite() || forces.iter().flatten().any(|f| !f.is_finite()) {
            return Err(format!("epsilon={epsilon}: nonfinite generalized force").into());
        }
        Ok(Evaluation {
            q,
            forces,
            samples,
            kii,
            point_force,
        })
    }
}

fn flips(samples: &[Sample; 4]) -> Result<[bool; 4], Box<dyn std::error::Error>> {
    let mut histories = [false; 4];
    for (j, sample) in samples.iter().enumerate() {
        histories[j] = reference_flip(&sample.manifold)
            .ok_or_else(|| format!("j={j}: expected clipped-face feature history"))?;
    }
    Ok(histories)
}

fn analytic(column: &Column, history: [bool; 4]) -> f64 {
    let mut total = 0.0;
    let omega = 2.0 * std::f64::consts::PI * 60.0;
    for j in 0..4 {
        let a = 0.5;
        let b = 0.5;
        let d = column.delta[j];
        let n = column.masses[j + 1..]
            .iter()
            .map(|&m| m as f64)
            .sum::<f64>()
            * 9.81;
        let (ul, uu) = (
            column.inverse_inertia[j] as f64,
            column.inverse_inertia[j + 1] as f64,
        );
        let k_ii =
            column.inverse_mass[j] as f64 + column.inverse_mass[j + 1] as f64 + a * a * (ul + uu);
        let k = omega * omega / k_ii;
        if j == 0 {
            let stiffness = if history[0] {
                2.0 * k * a * a - n * (b - d / 2.0)
            } else {
                2.0 * k * a * a + 2.0 * a * a * n * uu * b / k_ii - n * b
            };
            total += stiffness * SHAPE[0] * SHAPE[0];
        } else {
            let (ul, uu) = if history[j] { (uu, ul) } else { (ul, uu) };
            let kappa =
                2.0 * k * a * a + a * a * n / k_ii * (ul * d / 2.0 + uu * (2.0 * b - d / 2.0));
            let (lo, hi) = (SHAPE[j - 1], SHAPE[j]);
            total += kappa * (hi - lo) * (hi - lo)
                - n * ((b - d / 4.0) * (lo * lo + hi * hi) - d / 2.0 * lo * hi);
        }
    }
    total
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Static contact-force derivative: no World::step or performance measurement.");
    for payload in [100.0, 1000.0] {
        let column = column(payload)?;
        println!(
            "COLUMN payload={payload} mass={:?} inertia={:?} inv_mass={:?} inv_inertia={:?}",
            column.masses, column.inertias, column.inverse_mass, column.inverse_inertia
        );
        println!(
            "GEOMETRY y={:?} delta={:?} h={} soft={:?}",
            column.y, column.delta, column.h, column.spring
        );
        for (label, history) in [
            ("all-lower", [false; 4]),
            ("top-upper", [false, false, false, true]),
            ("ground-upper", [true, false, false, false]),
            ("ground-and-top-upper", [true, false, false, true]),
        ] {
            let (base_samples, zx) = column.baseline(history)?;
            let baseline_history = flips(&base_samples)?;
            let base = column.evaluate(0.0, &zx, baseline_history)?;
            let tangent_residual = base_samples
                .iter()
                .enumerate()
                .flat_map(|(j, s)| {
                    (0..2).map(move |p| {
                        let low = if j == 0 { 0.0 } else { SHAPE[j - 1] };
                        zx[j + 1] - zx[j] - s.rb[p].y as f64 * SHAPE[j] + s.ra[p].y as f64 * low
                    })
                })
                .fold(0.0_f64, |a, b| a.max(b.abs()));
            println!(
                "BASE payload={payload} history={label} requested={history:?} actual={baseline_history:?} zx={zx:?} q0={:.9} JtZmax={tangent_residual:.9} kii={:?} point_force={:?} body_force={:?}",
                base.q, base.kii, base.point_force, base.forces
            );
            let predicted = analytic(&column, baseline_history);
            for epsilon in EPSILONS {
                let plus = column.evaluate(epsilon, &zx, baseline_history)?;
                let minus = column.evaluate(-epsilon, &zx, baseline_history)?;
                let measured = -(plus.q - minus.q) / (2.0 * epsilon);
                let one_plus = -(plus.q - base.q) / epsilon;
                let one_minus = -(base.q - minus.q) / epsilon;
                let plus_history = flips(&plus.samples)?;
                let minus_history = flips(&minus.samples)?;
                let min_normal = plus
                    .point_force
                    .iter()
                    .chain(&minus.point_force)
                    .flatten()
                    .copied()
                    .fold(f64::INFINITY, f64::min);
                println!(
                    "DATA payload={payload} history={label} eps={epsilon:.7} predicted={predicted:.6} measured={measured:.6} plus={one_plus:.6} minus={one_minus:.6} qplus={:.9} qminus={:.9} refplus={plus_history:?} refminus={minus_history:?} min_normal_force={min_normal:.6}",
                    plus.q, minus.q
                );
            }
        }
    }
    Ok(())
}
