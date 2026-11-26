use crate::math::sqrt;
use crate::membrane::{Vector, combine, cross, dot, sub};

#[derive(Clone, Copy)]
pub(crate) struct Closest {
    pub weights: Vector,
    pub separation: Vector,
}

fn closest_edge(base: Vector, delta: Vector, center: Vector, ia: usize, ib: usize) -> Closest {
    let relative = sub(center, base);
    let squared = dot(delta, delta);
    let along = if squared > 0.0 {
        (dot(relative, delta) / squared).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut weights = [0.0; 3];
    // The caller's only edge pairs are fixed indices in a three-point face.
    unsafe {
        *weights.get_unchecked_mut(ia) = 1.0 - along;
        *weights.get_unchecked_mut(ib) = along;
    }
    Closest {
        weights,
        separation: combine(relative, 1.0, delta, -along),
    }
}

/// Projects into the face barycentrics. If the minimizer lies outside, tests the three closed edges.
pub(crate) fn closest(center: Vector, [a, b, c]: [Vector; 3]) -> Closest {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(center, a);
    let normal = cross(ab, ac);
    let area_squared = dot(normal, normal);
    if area_squared > 0.0 {
        let v = dot(cross(ap, ac), normal) / area_squared;
        let w = dot(cross(ab, ap), normal) / area_squared;
        let u = 1.0 - v - w;
        if u >= 0.0 && v >= 0.0 && w >= 0.0 {
            return Closest {
                weights: [u, v, w],
                separation: combine(ap, 1.0, combine(ab, v, ac, w), -1.0),
            };
        }
    }
    let mut best = closest_edge(a, ab, center, 0, 1);
    for candidate in [
        closest_edge(b, sub(c, b), center, 1, 2),
        closest_edge(a, ac, center, 0, 2),
    ] {
        if dot(candidate.separation, candidate.separation) < dot(best.separation, best.separation) {
            best = candidate;
        }
    }
    best
}

pub(crate) fn within_bounds(center: Vector, radius: f64, vertices: [Vector; 3]) -> bool {
    (0..3).all(|axis| {
        let min = vertices[0][axis]
            .min(vertices[1][axis])
            .min(vertices[2][axis]);
        let max = vertices[0][axis]
            .max(vertices[1][axis])
            .max(vertices[2][axis]);
        center[axis] + radius >= min && center[axis] - radius <= max
    })
}

impl Closest {
    /// Feature index in the host's per-face incidence table. Interior points need no neighbors.
    pub fn boundary_slot(&self) -> Option<usize> {
        let active = self.weights.map(|weight| weight > 16.0 * f64::EPSILON);
        match active {
            [true, true, true] => None,
            [true, false, false] => Some(0),
            [false, true, false] => Some(1),
            [false, false, true] => Some(2),
            [false, true, true] => Some(3),
            [true, false, true] => Some(4),
            _ => Some(5),
        }
    }

    /// The squared-distance derivative into any neighboring face must be nonnegative.
    pub fn descends_toward(&self, relative_vertex: Vector) -> bool {
        let direction = sub(self.separation, relative_vertex);
        // Allow cancellation in the dot product and point subtraction at a shared feature.
        let roundoff = 32.0
            * f64::EPSILON
            * (dot(self.separation, self.separation) + dot(direction, direction));
        dot(self.separation, direction) > roundoff
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Contact {
    pub force: Vector,
    pub energy: f64,
}

/// Hertz normal compliance at the closest feature, with energy conjugate to overlap.
pub(crate) fn contact(separation: Vector, skin_radius: f64, stiffness: f64) -> Option<Contact> {
    let distance = sqrt(dot(separation, separation));
    if !(distance > 0.0 && distance < skin_radius) {
        return None;
    }
    let overlap = skin_radius - distance;
    let force = stiffness * (overlap * sqrt(overlap));
    Some(Contact {
        force: separation.map(|component| component * (force / distance)),
        energy: 0.4 * force * overlap,
    })
}

pub(crate) fn inertia_product(inverse: [f64; 6], vector: Vector) -> Vector {
    let [xx, xy, xz, yy, yz, zz] = inverse;
    let [x, y, z] = vector;
    [
        xx * x + xy * y + xz * z,
        xy * x + yy * y + yz * z,
        xz * x + yz * y + zz * z,
    ]
}

/// Maximum energy dissipation in the tangent plane under a round Coulomb impulse bound.
pub(crate) fn friction_impulse(
    relative: Vector,
    normal: Vector,
    arm: Vector,
    inverse_translation: f64,
    inverse_inertia: [f64; 6],
    limit: f64,
) -> Option<(Vector, f64)> {
    let tangent = combine(relative, 1.0, normal, -dot(relative, normal));
    let speed = sqrt(dot(tangent, tangent));
    if speed == 0.0 || limit == 0.0 {
        return Some(([0.0; 3], 0.0));
    }
    let first = tangent.map(|value| value / speed);
    let second = cross(normal, first);
    let a = cross(arm, first);
    let b = cross(arm, second);
    let ia = inertia_product(inverse_inertia, a);
    let ib = inertia_product(inverse_inertia, b);
    let xx = inverse_translation + dot(a, ia);
    let xy = dot(a, ib);
    let yy = inverse_translation + dot(b, ib);
    if !(xx > 0.0 && yy > 0.0 && (speed + limit + xx + yy).is_finite()) {
        return None;
    }
    let solve = |shift: f64| {
        let ratio = xy / (yy + shift);
        let along = -speed / (xx + shift - xy * ratio);
        (along, -ratio * along)
    };
    let norm = |(x, y): (f64, f64)| sqrt(x * x + y * y);
    let (mut x, mut y) = solve(0.0);
    if norm((x, y)) > limit {
        let (mut lo, mut hi) = (0.0, speed / limit);
        for _ in 0..32 {
            let mid = 0.5 * (lo + hi);
            if norm(solve(mid)) > limit {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        (x, y) = solve(hi);
    }
    let loss = -(speed * x + 0.5 * (xx * x * x + 2.0 * xy * x * y + yy * y * y));
    if !loss.is_finite() {
        return None;
    }
    Some((combine(first, x, second, y), loss.max(0.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closest_feature_interior_edge_and_vertex_preserve_interpolated_contact_position() {
        let face = [[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]];
        for (center, weights, separation) in [
            ([0.25, 0.75, 0.5], [0.5, 0.125, 0.375], [0., 0., 0.5]),
            ([1.5, 1.5, 0.5], [0., 0.5, 0.5], [0.5, 0.5, 0.5]),
            ([-1., -1., 0.5], [1., 0., 0.], [-1., -1., 0.5]),
        ] {
            let result = closest(center, face);
            assert_eq!(result.weights, weights);
            assert_eq!(result.separation, separation);
        }
    }

    #[test]
    fn friction_sticks_with_inertia_cross_response_and_caps_circular_sliding() {
        let relative = [3., 4., 2.];
        let normal = [0., 0., 1.];
        let arm = [0., 0., -0.2];
        let inverse = [3., 0.7, 0., 2., 0., 4.];
        let (sticking, loss) = friction_impulse(relative, normal, arm, 2., inverse, 10.).unwrap();
        let angular = inertia_product(inverse, cross(arm, sticking));
        let after = combine(
            combine(relative, 1., sticking, 2.),
            1.,
            cross(angular, arm),
            1.,
        );
        assert!(after[0].abs() + after[1].abs() < 1e-12);
        assert!((loss + 0.5 * dot(relative, sticking)).abs() < 1e-12);
        let (slide, work) =
            friction_impulse(relative, normal, arm, 2., [3., 0., 0., 3., 0., 3.], 0.2).unwrap();
        assert!((slide[0] + 0.12).abs() + (slide[1] + 0.16).abs() < 1e-9);
        assert!((work - (1. - 0.5 * 2.12 * 0.04)).abs() < 1e-9);
    }

    #[test]
    fn hertz_force_is_the_negative_gradient_of_contact_energy() {
        let displacement = 0.15;
        let skin_radius = 0.2;
        let stiffness = 400.0;
        let eval = |z| contact([0., 0., z], skin_radius, stiffness).unwrap();
        let center = eval(displacement);
        let delta = 1e-7;
        let derivative =
            (eval(displacement + delta).energy - eval(displacement - delta).energy) / (2.0 * delta);
        assert!((derivative + center.force[2]).abs() < 2e-9);
    }
}
