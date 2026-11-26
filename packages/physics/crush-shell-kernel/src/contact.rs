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
