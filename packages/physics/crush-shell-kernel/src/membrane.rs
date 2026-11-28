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
    resolve(element, x, y, total, steel, plastic, hill)
}

fn resolve(
    element: Element,
    x: Vector,
    y: Vector,
    total: Vector,
    steel: Steel,
    plastic: Plastic,
    hill: Option<Hill>,
) -> Membrane {
    let [bx, by] = element.gradient_b;
    let [cx, cy] = element.gradient_c;
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

/// Two objective Green-strain evaluations with independent inelastic returns.
#[cfg(target_arch = "wasm32")]
pub(crate) fn membrane_pair(
    left: (Element, [Vector; 3], Plastic),
    right: (Element, [Vector; 3], Plastic),
    steel: Steel,
    hill: Option<Hill>,
) -> (Membrane, Membrane) {
    use core::arch::wasm32::{
        f64x2, f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sub, v128,
    };
    let (a, pa, hist_a) = left;
    let (b, pb, hist_b) = right;
    let pair = |u: Vector, v: Vector| [f64x2(u[0], v[0]), f64x2(u[1], v[1]), f64x2(u[2], v[2])];
    let first = pair(sub(pa[1], pa[0]), sub(pb[1], pb[0]));
    let second = pair(sub(pa[2], pa[0]), sub(pb[2], pb[0]));
    let combine = |b0, b1, c0, c1| {
        let l = f64x2(b0, b1);
        let r = f64x2(c0, c1);
        core::array::from_fn(|i| f64x2_add(f64x2_mul(first[i], l), f64x2_mul(second[i], r)))
    };
    let dot = |[x0, x1, x2]: [v128; 3], [y0, y1, y2]: [v128; 3]| {
        f64x2_add(
            f64x2_add(f64x2_mul(x0, y0), f64x2_mul(x1, y1)),
            f64x2_mul(x2, y2),
        )
    };
    let x = combine(
        a.gradient_b[0],
        b.gradient_b[0],
        a.gradient_c[0],
        b.gradient_c[0],
    );
    let y = combine(
        a.gradient_b[1],
        b.gradient_b[1],
        a.gradient_c[1],
        b.gradient_c[1],
    );
    let strain = |gradient| {
        f64x2_mul(
            f64x2_splat(0.5),
            f64x2_sub(dot(gradient, gradient), f64x2_splat(1.0)),
        )
    };
    let total = [strain(x), strain(y), dot(x, y)];
    let left = |v: [v128; 3]| v.map(|lane| f64x2_extract_lane::<0>(lane));
    let right = |v: [v128; 3]| v.map(|lane| f64x2_extract_lane::<1>(lane));
    (
        resolve(a, left(x), left(y), left(total), steel, hist_a, hill),
        resolve(b, right(x), right(y), right(total), steel, hist_b, hill),
    )
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
