use crate::math::sqrt;
use crate::membrane::{Vector, combine, cross, dot, sub};

/// A coincident pair of two-node shell boundaries. The cohesive law uses the norm
/// of the relative displacement, with equal opening and shear energy.
#[derive(Clone, Copy)]
#[repr(C)]
pub(crate) struct CohesiveEdge {
    pub vertices: [u32; 4],
    pub stiffness: f64,
    pub initiation: f64,
    pub failure: f64,
    pub rest_area: f64,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub(crate) struct History {
    pub peak: [f64; 2],
    pub gap: [f64; 2],
    pub elastic: f64,
    pub dissipation: f64,
    pub opening_area: f64,
    pub broken: f64,
}

struct CohesivePoint {
    force: Vector,
    gap: f64,
    peak: f64,
    energy: f64,
    dissipation: f64,
}

fn point(edge: CohesiveEdge, separation: Vector, previous: f64) -> CohesivePoint {
    let distance = sqrt(dot(separation, separation));
    let peak = previous.max(distance).min(edge.failure);
    let (remaining, dissipated_fraction) = if peak <= edge.initiation {
        (1.0, 0.0)
    } else {
        let softening = edge.failure - edge.initiation;
        let remaining = (edge.initiation / peak) * ((edge.failure - peak) / softening);
        (remaining, (peak - edge.initiation) / softening)
    };
    let weight = 0.5 * edge.rest_area;
    let secant = remaining * edge.stiffness * weight;
    CohesivePoint {
        force: separation.map(|value| secant * value),
        gap: distance,
        peak,
        energy: 0.5 * secant * distance * distance,
        dissipation: 0.5
            * edge.stiffness
            * edge.initiation
            * edge.failure
            * weight
            * dissipated_fraction,
    }
}

fn half_area(a: Vector, b: Vector) -> f64 {
    let normal = cross(a, b);
    0.5 * sqrt(dot(normal, normal))
}

pub(crate) fn seam(
    edge: CohesiveEdge,
    [a, b, c, d]: [Vector; 4],
    history: History,
) -> ([Vector; 4], History) {
    // Two-point Gauss–Legendre quadrature of the real shared line, normalized to [0,1].
    let low = 0.211_324_865_405_187_1;
    let high = 1.0 - low;
    let ac = sub(c, a);
    let bd = sub(d, b);
    let low_end = point(edge, combine(ac, high, bd, low), history.peak[0]);
    let high_end = point(edge, combine(ac, low, bd, high), history.peak[1]);
    let first = combine(low_end.force, high, high_end.force, low);
    let last = combine(low_end.force, low, high_end.force, high);
    let broken = low_end.peak == edge.failure && high_end.peak == edge.failure;
    let opening_area = if broken {
        // Two triangles of the live front/back edge quad. Collinear slip has zero area.
        let diagonal = sub(d, a);
        half_area(sub(b, a), diagonal) + half_area(diagonal, ac)
    } else {
        0.0
    };
    (
        [first, last, first.map(|v| 0.0 - v), last.map(|v| 0.0 - v)],
        History {
            peak: [low_end.peak, high_end.peak],
            gap: [low_end.gap, high_end.gap],
            elastic: low_end.energy + high_end.energy,
            dissipation: low_end.dissipation + high_end.dissipation,
            opening_area,
            broken: if broken { 1.0 } else { 0.0 },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EDGE: CohesiveEdge = CohesiveEdge {
        vertices: [0, 1, 2, 3],
        stiffness: 1e6,
        initiation: 0.03125,
        failure: 0.125,
        rest_area: 0.02,
    };
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-10, "got {a}, expected {b}");
    }

    fn positions(gap: f64) -> [Vector; 4] {
        [
            [0.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [gap, 0.0, 0.0],
            [gap, 2.0, 0.0],
        ]
    }

    #[test]
    fn cohesive_traction_unloads_on_the_secant_and_dissipates_the_area_times_toughness() {
        let middle = 0.0625;
        let (loaded, history) = seam(EDGE, positions(middle), History::default());
        let traction = EDGE.stiffness * EDGE.initiation * (EDGE.failure - middle)
            / (EDGE.failure - EDGE.initiation);
        near(loaded[0][0], 0.5 * traction * EDGE.rest_area);
        near(loaded[1][0], loaded[0][0]);
        near(history.elastic, 0.5 * traction * middle * EDGE.rest_area);
        assert!(history.dissipation > 0.0);
        let (unloaded, drained) = seam(EDGE, positions(middle / 4.0), history);
        near(unloaded[0][0], loaded[0][0] / 4.0);
        assert_eq!(drained.dissipation, history.dissipation);
        let (released, cracked) = seam(EDGE, positions(0.2), drained);
        assert_eq!(released, [[0.0; 3]; 4]);
        near(
            cracked.dissipation,
            0.5 * EDGE.stiffness * EDGE.initiation * EDGE.failure * EDGE.rest_area,
        );
        assert_eq!(cracked.broken, 1.0);
        near(cracked.opening_area, 0.4);
        let (_, closed) = seam(EDGE, positions(0.0), cracked);
        assert_eq!(closed.broken, 1.0);
        assert_eq!(closed.opening_area, 0.0);
    }

    #[test]
    fn rotated_split_boundaries_keep_reciprocal_force_torque_and_fracture_work() {
        let original = [
            [0.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.03125, 0.02, 0.0],
            [0.0625, 2.0, 0.01],
        ];
        let rotated = original.map(|p| [1.0 - p[1], 2.0 + p[2], 3.0 - p[0]]);
        let (local_forces, local) = seam(EDGE, original, History::default());
        let (world_forces, world) = seam(EDGE, rotated, History::default());
        near(local.elastic, world.elastic);
        near(local.dissipation, world.dissipation);
        let mut net_force = [0.0; 3];
        let mut net_torque = [0.0; 3];
        for ((p, f), g) in original.into_iter().zip(local_forces).zip(world_forces) {
            let expected = [-f[1], f[2], -f[0]];
            for (component, target) in g.into_iter().zip(expected) {
                near(component, target);
            }
            net_force = combine(net_force, 1.0, f, 1.0);
            net_torque = combine(net_torque, 1.0, cross(p, f), 1.0);
        }
        for v in net_force.into_iter().chain(net_torque) {
            near(v, 0.0);
        }
    }

    #[test]
    fn uniform_rupture_work_and_open_area_are_invariant_under_edge_bisection() {
        let edge = CohesiveEdge {
            rest_area: EDGE.rest_area / 2.0,
            ..EDGE
        };
        let points = positions(0.25);
        let [a, b, c, d] = points;
        let mid_a = [0.0, 1.0, 0.0];
        let mid_c = [0.25, 1.0, 0.0];
        let (_, full) = seam(EDGE, points, History::default());
        let (_, first) = seam(edge, [a, mid_a, c, mid_c], History::default());
        let (_, last) = seam(edge, [mid_a, b, mid_c, d], History::default());
        near(full.dissipation, first.dissipation + last.dissipation);
        near(full.opening_area, first.opening_area + last.opening_area);
    }
}
