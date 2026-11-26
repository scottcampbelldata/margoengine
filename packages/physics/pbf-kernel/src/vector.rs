use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sqrt,
    f64x2_sub, v128_load,
};

pub type Vec3 = [f64; 3];
pub const ZERO: Vec3 = [0.0; 3];

#[inline]
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    let v = f64x2_add(f64x2(a[0], a[1]), f64x2(b[0], b[1]));
    [
        f64x2_extract_lane::<0>(v),
        f64x2_extract_lane::<1>(v),
        a[2] + b[2],
    ]
}

#[inline]
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    let v = f64x2_sub(f64x2(a[0], a[1]), f64x2(b[0], b[1]));
    [
        f64x2_extract_lane::<0>(v),
        f64x2_extract_lane::<1>(v),
        a[2] - b[2],
    ]
}

#[inline]
pub fn scale(a: Vec3, n: f64) -> Vec3 {
    let v = f64x2_mul(f64x2(a[0], a[1]), f64x2_splat(n));
    [
        f64x2_extract_lane::<0>(v),
        f64x2_extract_lane::<1>(v),
        a[2] * n,
    ]
}

#[inline]
pub fn norm2(a: Vec3) -> f64 {
    let xy = unsafe { v128_load(a.as_ptr().cast()) };
    let p = f64x2_mul(xy, xy);
    f64x2_extract_lane::<0>(p) + f64x2_extract_lane::<1>(p) + a[2] * a[2]
}

#[inline]
pub fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

pub fn length(a: Vec3) -> f64 {
    let squared = norm2(a);
    if squared > 0.0 && squared.is_finite() {
        return sqrt(squared);
    }
    let largest = a[0].abs().max(a[1].abs()).max(a[2].abs());
    if largest == 0.0 || !largest.is_finite() {
        return largest;
    }
    largest * sqrt(norm2(a.map(|value| value / largest)))
}

#[inline]
pub fn floor(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(value)))
}

#[inline]
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn rotate(v: Vec3, q: [f64; 4], inverse: bool) -> Vec3 {
    let axis = if inverse {
        [-q[0], -q[1], -q[2]]
    } else {
        [q[0], q[1], q[2]]
    };
    let twice = scale(cross(axis, v), 2.0);
    add(v, add(scale(twice, q[3]), cross(axis, twice)))
}
