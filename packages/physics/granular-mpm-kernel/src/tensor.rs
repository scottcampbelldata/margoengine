use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sqrt,
};

pub(crate) type V = [f64; 3];
pub(crate) type M = [V; 3];
pub(crate) const ZERO: V = [0.0; 3];
use super::{at, at_mut};

fn identity() -> M {
    let mut result = [ZERO; 3];
    // Store the diagonal into this solve's stack, not an active Wasm data segment.
    for i in 0..3 {
        unsafe { core::ptr::write_volatile(&raw mut result[i][i], 1.0) };
    }
    result
}

pub(crate) fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn scale(a: V, q: f64) -> V {
    [q * a[0], q * a[1], q * a[2]]
}

pub(crate) fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn dot(a: V, b: V) -> f64 {
    let xy = f64x2_mul(f64x2(a[0], a[1]), f64x2(b[0], b[1]));
    f64x2_extract_lane::<0>(xy) + f64x2_extract_lane::<1>(xy) + a[2] * b[2]
}

pub(crate) fn apply(m: M, v: V) -> V {
    add(add(scale(m[0], v[0]), scale(m[1], v[1])), scale(m[2], v[2]))
}

pub(crate) fn determinant(m: M) -> f64 {
    let [x, y, z] = m;
    dot(
        x,
        [
            y[1] * z[2] - y[2] * z[1],
            y[2] * z[0] - y[0] * z[2],
            y[0] * z[1] - y[1] * z[0],
        ],
    )
}

pub(crate) fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

pub(crate) fn floor(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(value)))
}

fn rotate(m: &mut M, p: usize, q: usize, cosine: f64, sine: f64) {
    let a = *at(m, p);
    let b = *at(m, q);
    *at_mut(m, p) = sub(scale(a, cosine), scale(b, sine));
    *at_mut(m, q) = add(scale(a, sine), scale(b, cosine));
}

pub(crate) struct Spectrum {
    pub(crate) left: M,
    pub(crate) stretch: V,
    right: M,
}

impl Spectrum {
    pub(crate) fn of(f: M) -> Option<Self> {
        let determinant = determinant(f);
        if !determinant.is_finite() || determinant <= 0.0 {
            return None;
        }
        let mut left = f;
        let mut right = identity();
        for _ in 0..8 {
            let mut changed = false;
            for (p, q) in [(0, 1), (0, 2), (1, 2)] {
                let u = *at(&left, p);
                let v = *at(&left, q);
                let a = dot(u, u);
                let b = dot(v, v);
                let ab = dot(u, v);
                if ab.abs() <= 8.0 * f64::EPSILON * sqrt(a * b) {
                    continue;
                }
                let slope = (b - a) / (2.0 * ab);
                let tangent = 1.0_f64.copysign(slope) / (slope.abs() + sqrt(1.0 + slope * slope));
                let cosine = 1.0 / sqrt(1.0 + tangent * tangent);
                let sine = cosine * tangent;
                rotate(&mut left, p, q, cosine, sine);
                rotate(&mut right, p, q, cosine, sine);
                changed = true;
            }
            if !changed {
                break;
            }
        }
        let stretch = left.map(|axis| sqrt(dot(axis, axis)));
        if !stretch.iter().all(|&s| s.is_finite() && s > 0.0) {
            return None;
        }
        for i in 0..3 {
            left[i] = scale(left[i], 1.0 / stretch[i]);
        }
        Some(Self {
            left,
            stretch,
            right,
        })
    }

    pub(crate) fn rebuild(&self, stretch: V) -> M {
        compose(self.left, stretch, self.right)
    }

    pub(crate) fn kirchhoff(&self, diagonal: V) -> M {
        compose(self.left, diagonal, self.left)
    }
}

fn compose(left: M, diagonal: V, right: M) -> M {
    let left = [
        scale(left[0], diagonal[0]),
        scale(left[1], diagonal[1]),
        scale(left[2], diagonal[2]),
    ];
    core::array::from_fn(|i| apply(left, [right[0][i], right[1][i], right[2][i]]))
}
