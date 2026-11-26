use crate::material::{Hill, Plastic, Steel, Stress, return_hill, return_stress};

pub(crate) type Vector = [f64; 3];

#[derive(Clone, Copy)]
#[repr(C)]
pub(crate) struct Element {
    pub gradient_b: [f64; 2],
    pub gradient_c: [f64; 2],
    pub volume: f64,
}

pub(crate) struct Membrane {
    pub forces: [Vector; 3],
    pub result: Stress,
}

pub(crate) fn sub(a: Vector, b: Vector) -> Vector {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn dot(a: Vector, b: Vector) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross(a: Vector, b: Vector) -> Vector {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn combine(a: Vector, x: f64, b: Vector, y: f64) -> Vector {
    [
        a[0] * x + b[0] * y,
        a[1] * x + b[1] * y,
        a[2] * x + b[2] * y,
    ]
}

/// Constant-strain membrane element, with objective Green strain and virtual-work forces.
pub(crate) fn membrane(
    element: Element,
    points: [Vector; 3],
    steel: Steel,
    plastic: Plastic,
    hill: Option<Hill>,
) -> Membrane {
    let b = sub(points[1], points[0]);
    let c = sub(points[2], points[0]);
    let [bx, by] = element.gradient_b;
    let [cx, cy] = element.gradient_c;
    let x = combine(b, bx, c, cx);
    let y = combine(b, by, c, cy);
    let total = [0.5 * (dot(x, x) - 1.0), 0.5 * (dot(y, y) - 1.0), dot(x, y)];
    let result = match hill {
        Some(metric) => return_hill(steel, metric, total, plastic),
        None => return_stress(steel, total, plastic),
    };
    let [sxx, syy, sxy] = result.stress;
    let p = combine(x, -element.volume * sxx, y, -element.volume * sxy);
    let q = combine(x, -element.volume * sxy, y, -element.volume * syy);
    let b_force = combine(p, bx, q, by);
    let c_force = combine(p, cx, q, cy);
    let a_force = combine(b_force, -1.0, c_force, -1.0);
    Membrane {
        forces: [a_force, b_force, c_force],
        result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ELEMENT: Element = Element {
        gradient_b: [1.0, 0.0],
        gradient_c: [0.0, 1.0],
        volume: 0.002,
    };
    const STEEL: Steel = Steel {
        young: 200e9,
        poisson: 0.3,
        yield_stress: 270e6,
        hardening: 1.2e9,
    };

    #[test]
    fn finite_rigid_motion_rotates_the_forces_and_preserves_energy() {
        let initial = [[0.0, 0.0, 0.0], [1.003, 0.0, 0.0], [0.02, 0.9991, 0.0]];
        let world = initial.map(|p| [4.0 - p[1], -7.0 + p[2], 3.0 - p[0]]);
        let local = membrane(ELEMENT, initial, STEEL, Plastic::default(), None);
        let rotated = membrane(ELEMENT, world, STEEL, Plastic::default(), None);
        for (a, b) in local.forces.into_iter().zip(rotated.forces) {
            let expected = [-a[1], a[2], -a[0]];
            assert!(sub(expected, b).into_iter().all(|v| v.abs() < 1e-5));
        }
        assert!((local.result.elastic - rotated.result.elastic).abs() < 2e-6);
        assert!((local.result.state.equivalent - rotated.result.state.equivalent).abs() < 2e-14);
    }

    #[test]
    fn elastic_forces_are_the_negative_gradient_of_the_sheet_energy() {
        let points = [
            [0.0, 0.0, 0.0],
            [1.0001, 0.0, 0.0],
            [0.0002, 1.0001, 0.0002],
        ];
        let state = Plastic::default();
        let result = membrane(ELEMENT, points, STEEL, state, None);
        let epsilon = 1e-7;
        for i in 0..3 {
            for axis in 0..3 {
                let mut perturbed = points;
                perturbed[i][axis] -= epsilon;
                let minus = membrane(ELEMENT, perturbed, STEEL, state, None)
                    .result
                    .elastic;
                perturbed[i][axis] += 2.0 * epsilon;
                let plus = membrane(ELEMENT, perturbed, STEEL, state, None)
                    .result
                    .elastic;
                let derivative = ELEMENT.volume * (plus - minus) / (2.0 * epsilon);
                assert!((result.forces[i][axis] + derivative).abs() < 0.003);
            }
        }
    }
}
