use crate::membrane::{Vector, combine, cross, sub};

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct PanelPressure {
    pub outside: f64,
    pub inside: f64,
    pub air: f64,
    pub water_weight: f64,
}

#[derive(Clone, Copy)]
struct ClipPoint {
    weights: Vector,
    depth: f64,
}

/// Integrates the positive part of a linear depth times each linear shape function.
fn nodal_head(depth: Vector) -> Vector {
    let mut points = [ClipPoint {
        weights: [0.0; 3],
        depth: 0.0,
    }; 4];
    let mut count = 0_usize;
    for (index, after) in depth.into_iter().enumerate() {
        let previous = (index + 2) % 3;
        let before = depth[previous];
        if (before < 0.0) != (after < 0.0) {
            let along = before / (before - after);
            let mut weights = [0.0; 3];
            weights[previous] = 1.0 - along;
            weights[index] = along;
            // A plane clips this triangle to at most four vertices.
            unsafe {
                *points.get_unchecked_mut(count) = ClipPoint {
                    weights,
                    depth: 0.0,
                }
            };
            count += 1;
        }
        if after >= 0.0 {
            let mut weights = [0.0; 3];
            weights[index] = 1.0;
            unsafe {
                *points.get_unchecked_mut(count) = ClipPoint {
                    weights,
                    depth: after,
                }
            };
            count += 1;
        }
    }
    let mut result = [0.0; 3];
    for index in 1..count.saturating_sub(1) {
        let [a, b, c] = unsafe {
            [
                points[0],
                *points.get_unchecked(index),
                *points.get_unchecked(index + 1),
            ]
        };
        let ab = sub(b.weights, a.weights);
        let ac = sub(c.weights, a.weights);
        let fraction = ab[1] * ac[2] - ab[2] * ac[1];
        let sum_head = a.depth + b.depth + c.depth;
        for (corner, weight) in result.iter_mut().enumerate() {
            let sum_weight = a.weights[corner] + b.weights[corner] + c.weights[corner];
            let products = a.depth * a.weights[corner]
                + b.depth * b.weights[corner]
                + c.depth * c.weights[corner];
            *weight += fraction * (sum_head * sum_weight + products) / 12.0;
        }
    }
    result
}

/// Consistent interior-minus-exterior pressure on the outward-wound live face.
pub(crate) fn pressure_forces(pressure: PanelPressure, positions: [Vector; 3]) -> [Vector; 3] {
    let [a, b, c] = positions;
    let area_normal = cross(sub(b, a), sub(c, a)).map(|component| 0.5 * component);
    let inside = nodal_head(positions.map(|position| pressure.inside - position[1]));
    let outside = nodal_head(positions.map(|position| pressure.outside - position[1]));
    let head = combine(
        inside,
        pressure.water_weight,
        outside,
        -pressure.water_weight,
    );
    head.map(|value| area_normal.map(|component| component * (value + pressure.air / 3.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipped_water_pressure_matches_the_triangular_integral_and_centre_of_pressure() {
        let positions = [[0., -0.5, 0.], [1., -0.5, 0.], [0., 0.5, 0.]];
        let forces = pressure_forces(
            PanelPressure {
                outside: 0.,
                inside: -0.5,
                air: 0.,
                water_weight: 10000.,
            },
            positions,
        );
        // The triangle's width at y is 0.5-y, hence total = k integral_0^.5 s(0.5+s) ds.
        let normal = 10000. * (0.25 * 0.5_f64.powi(2) + 0.5_f64.powi(3) / 3.);
        let moment = 10000. * (0.5 * 0.5_f64.powi(3) / 3. + 0.5_f64.powi(4) / 4.);
        assert!((forces.iter().map(|force| force[2]).sum::<f64>() + normal).abs() < 1e-12);
        assert!(
            (forces
                .iter()
                .zip(positions)
                .map(|(force, position)| force[2] * position[1])
                .sum::<f64>()
                - moment)
                .abs()
                < 1e-12
        );
    }

    #[test]
    fn equal_heads_cancel_and_uniform_overpressure_follows_current_area_normal() {
        let positions = [[0., -1., 1.], [0., 1., 1.], [0., -1., 3.]];
        let forces = pressure_forces(
            PanelPressure {
                outside: 0.,
                inside: 0.,
                air: 300.,
                water_weight: 10000.,
            },
            positions,
        );
        assert_eq!(forces, [[200., 0., 0.]; 3]);
    }
}
