use crate::math::{atan2, sqrt};
use crate::membrane::{Vector, combine, cross, dot, sub};

pub(crate) struct Angle {
    pub value: f64,
    pub gradient: [Vector; 4],
}

/// Vertices a,b share the edge, c and d lie on oppositely wound faces.
pub(crate) fn angle([a, b, c, d]: [Vector; 4]) -> Option<Angle> {
    let edge = sub(b, a);
    let e2 = dot(edge, edge);
    let length = sqrt(e2);
    let left_arm = sub(c, a);
    let right_arm = sub(d, a);
    let left = cross(edge, left_arm);
    let right = cross(right_arm, edge);
    let left2 = dot(left, left);
    let right2 = dot(right, right);
    if !(length > 0.0 && left2 > 0.0 && right2 > 0.0) {
        return None;
    }
    let sine = dot(edge, cross(left, right)) / length;
    let cosine = dot(left, right);
    let value = atan2(sine, cosine);
    let c_gradient = left.map(|component| -component * length / left2);
    let d_gradient = right.map(|component| -component * length / right2);
    let c_projection = dot(edge, left_arm) / e2;
    let d_projection = dot(edge, right_arm) / e2;
    let a_gradient = combine(
        c_gradient,
        c_projection - 1.0,
        d_gradient,
        d_projection - 1.0,
    );
    let b_gradient = combine(c_gradient, -c_projection, d_gradient, -d_projection);
    Some(Angle {
        value,
        gradient: [a_gradient, b_gradient, c_gradient, d_gradient],
    })
}

/// Bending energy and reciprocal nodal forces of a Grinspun/Tamstorf hinge.
pub(crate) fn bend(
    points: [Vector; 4],
    rest_angle: f64,
    stiffness: f64,
) -> Option<(f64, [Vector; 4])> {
    let current = angle(points)?;
    let raw = current.value - rest_angle;
    let turn = if raw > core::f64::consts::PI {
        raw - core::f64::consts::TAU
    } else if raw < -core::f64::consts::PI {
        raw + core::f64::consts::TAU
    } else {
        raw
    };
    let moment = stiffness * turn;
    let forces = current
        .gradient
        .map(|g| g.map(|component| -moment * component));
    Some((0.5 * moment * turn, forces))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_curved_rest_hinge_exerts_no_force_and_energy_is_rigid_motion_invariant() {
        let points = [
            [0.0, 0.0, 0.0],
            [0.875, 0.125, 0.25],
            [0.125, 0.375, 0.5],
            [0.625, -0.5, 0.3125],
        ];
        let rest = angle(points).unwrap().value;
        assert_eq!(bend(points, rest, 7.0).unwrap(), (0.0, [[0.0; 3]; 4]));
        let moved = points.map(|p| [3.0 - p[1], -9.0 + p[2], 8.0 - p[0]]);
        let left = bend(points, rest + 0.2, 7.0).unwrap();
        let right = bend(moved, rest + 0.2, 7.0).unwrap();
        assert!((left.0 - right.0).abs() < 1e-14);
        for (local, world) in left.1.into_iter().zip(right.1) {
            let rotated = [-local[1], local[2], -local[0]];
            assert!(sub(rotated, world).into_iter().all(|v| v.abs() < 2e-14));
        }
    }

    #[test]
    fn bending_forces_are_virtual_work_derivatives_and_each_hinge_conserves_momentum() {
        let points = [
            [0.0, 0.0, 0.1],
            [2.0, 0.2, 0.0],
            [-0.2, 1.0, 0.4],
            [1.1, -0.6, -0.5],
        ];
        let (_, forces) = bend(points, 0.1, 37.0).unwrap();
        let mut sum = [0.0; 3];
        let mut torque = [0.0; 3];
        let epsilon = 1e-6;
        for a in 0..4 {
            sum = combine(sum, 1.0, forces[a], 1.0);
            torque = combine(torque, 1.0, cross(points[a], forces[a]), 1.0);
            for axis in 0..3 {
                let mut q = points;
                q[a][axis] -= epsilon;
                let low = bend(q, 0.1, 37.0).unwrap().0;
                q[a][axis] += 2.0 * epsilon;
                let high = bend(q, 0.1, 37.0).unwrap().0;
                assert!((forces[a][axis] + (high - low) / (2.0 * epsilon)).abs() < 2e-8);
            }
        }
        assert!(sum.into_iter().chain(torque).all(|v| v.abs() < 1e-13));
    }
}
