// Scalar and vector helpers for the 2D kernel. Every operation is a correctly rounded IEEE 754 one on both targets, so
// native and Wasm agree bit for bit: Rust never fuses a * b + c, and the kernel uses no trigonometry on the step path.
// A rotation is the pair (cos, sin), advanced by a first order update and normalised (own-physics-plan.md, section 2).

/// The ordinary IEEE clamp with the same comparisons and signed-zero behavior. A derived invalid bound is an
/// arithmetic failure, carried as NaN to the checked step boundary rather than a Rust assertion/panic.
#[inline(always)]
pub(crate) fn clamp(value: f32, minimum: f32, maximum: f32) -> f32 {
    if minimum.is_nan() || maximum.is_nan() || minimum > maximum { return f32::NAN; }
    if value < minimum { minimum } else if value > maximum { maximum } else { value }
}

#[cfg(test)]
mod clamp_tests {
    #[test]
    fn dynamic_bounds_preserve_ieee_results_and_propagate_invalid_bounds() {
        for (lo, hi) in [(-1.0, 1.0), (-0.0, 0.0), (f32::NEG_INFINITY, f32::INFINITY)] {
            for value in [f32::NEG_INFINITY, -2.0, -0.0, 0.0, 0.5, 2.0, f32::INFINITY] {
                assert_eq!(super::clamp(value, lo, hi).to_bits(), value.clamp(lo, hi).to_bits());
            }
            assert!(super::clamp(f32::NAN, lo, hi).is_nan());
        }
        for (lo, hi) in [(1.0, -1.0), (f32::NAN, 1.0), (0.0, f32::NAN)] {
            assert!(super::clamp(0.0, lo, hi).is_nan());
        }
    }
}

/// Correctly rounded square root. Wasm: the `f32.sqrt` instruction through the SIMD form, as core has no float maths.
#[inline(always)]
pub fn sqrt(value: f32) -> f32 {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(value)))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        value.sqrt()
    }
}

/// Correctly rounded square root of a double (the joint solver's Cholesky factor). Wasm: `f64.sqrt` through the SIMD
/// form, as core has no float maths and a no_std Wasm build has no `f64::sqrt`.
#[inline(always)]
pub fn sqrt64(value: f64) -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        value.sqrt()
    }
}

/// pi and half of it as the nearest f32.
pub const PI: f32 = 3.141_592_7;
pub const HALF_PI: f32 = 1.570_796_4;

/// The arc tangent of `t` from 0 to 1 by two halvings, atan t = 2 atan(t / (1 + sqrt(1 + t^2))), then the Gregory
/// series, which stops under f32 rounding below tan(pi / 16). Used for mass properties only, never on the step path.
fn arc_tangent(t: f32) -> f32 {
    let t = t / (1.0 + sqrt(1.0 + t * t));
    let t = t / (1.0 + sqrt(1.0 + t * t));
    let s = t * t;
    4.0 * t * (1.0 + s * (-1.0 / 3.0 + s * (1.0 / 5.0 + s * (-1.0 / 7.0 + s * (1.0 / 9.0)))))
}

/// The angle of (x, y) from the X axis, from -pi to pi; 0 at the origin.
pub fn atan2(y: f32, x: f32) -> f32 {
    let (size_y, size_x) = (y.abs(), x.abs());
    if size_x == 0.0 && size_y == 0.0 {
        return 0.0;
    }
    let angle = if size_y <= size_x { arc_tangent(size_y / size_x) } else { HALF_PI - arc_tangent(size_x / size_y) };
    let angle = if x < 0.0 { PI - angle } else { angle };
    if y < 0.0 { -angle } else { angle }
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct V2 {
    pub x: f32,
    pub y: f32,
}

#[inline(always)]
pub const fn v2(x: f32, y: f32) -> V2 {
    V2 { x, y }
}

impl V2 {
    pub const ZERO: V2 = v2(0.0, 0.0);
    #[inline(always)]
    pub fn add(self, o: V2) -> V2 {
        v2(self.x + o.x, self.y + o.y)
    }
    #[inline(always)]
    pub fn sub(self, o: V2) -> V2 {
        v2(self.x - o.x, self.y - o.y)
    }
    #[inline(always)]
    pub fn scale(self, s: f32) -> V2 {
        v2(self.x * s, self.y * s)
    }
    #[inline(always)]
    pub fn neg(self) -> V2 {
        v2(-self.x, -self.y)
    }
    #[inline(always)]
    pub fn dot(self, o: V2) -> f32 {
        self.x * o.x + self.y * o.y
    }
    /// The z part of the 3D cross product of (x, y, 0) and (o.x, o.y, 0).
    #[inline(always)]
    pub fn cross(self, o: V2) -> f32 {
        self.x * o.y - self.y * o.x
    }
    /// The vector turned a quarter turn to the left, (-y, x).
    #[inline(always)]
    pub fn left(self) -> V2 {
        v2(-self.y, self.x)
    }
    /// The vector turned a quarter turn to the right, (y, -x): the outward normal of a counter-clockwise edge.
    #[inline(always)]
    pub fn right(self) -> V2 {
        v2(self.y, -self.x)
    }
    #[inline(always)]
    pub fn length_squared(self) -> f32 {
        self.dot(self)
    }
    #[inline(always)]
    pub fn length(self) -> f32 {
        sqrt(self.dot(self))
    }
    /// The unit vector along `self` and the length; (0, 0) and 0 for the zero vector.
    #[inline]
    pub fn normalize(self) -> (V2, f32) {
        let length = self.length();
        if length > 0.0 { (self.scale(1.0 / length), length) } else { (V2::ZERO, 0.0) }
    }
    #[inline(always)]
    pub fn lerp(self, o: V2, t: f32) -> V2 {
        v2(self.x + (o.x - self.x) * t, self.y + (o.y - self.y) * t)
    }
}

/// A rotation as (cos, sin) of its angle.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rot {
    pub c: f32,
    pub s: f32,
}

impl Rot {
    pub const IDENTITY: Rot = Rot { c: 1.0, s: 0.0 };
    /// The rotation whose (cos, sin) is the unit vector along (c, s); identity for (0, 0).
    pub fn from_pair(c: f32, s: f32) -> Rot {
        if c == 0.0 && s == 0.0 { return Rot::IDENTITY; }
        let squared = c * c + s * s;
        if squared.is_finite() && squared >= f32::MIN_POSITIVE {
            // Preserve every ordinary normalization operation and result bit.
            let inverse = 1.0 / sqrt(squared);
            return Rot { c: c * inverse, s: s * inverse };
        }
        if !c.is_finite() || !s.is_finite() { return Rot { c: f32::NAN, s: f32::NAN }; }
        // Scaling makes the squared norm lie in [1,2], even for subnormal or MAX pairs.
        // Nonfinite integration intermediates must reach the checked arithmetic-error boundary.
        let scale = if c.abs() > s.abs() { c.abs() } else { s.abs() };
        let (c, s) = (c / scale, s / scale);
        let inverse = 1.0 / sqrt(c * c + s * s);
        Rot { c: c * inverse, s: s * inverse }
    }
    #[inline(always)]
    pub fn apply(self, v: V2) -> V2 {
        v2(self.c * v.x - self.s * v.y, self.s * v.x + self.c * v.y)
    }
    #[inline(always)]
    pub fn apply_inverse(self, v: V2) -> V2 {
        v2(self.c * v.x + self.s * v.y, -self.s * v.x + self.c * v.y)
    }
    /// self then o: the rotation by both angles.
    #[inline(always)]
    pub fn mul(self, o: Rot) -> Rot {
        Rot { c: self.c * o.c - self.s * o.s, s: self.s * o.c + self.c * o.s }
    }
    /// The rotation from self to o: self^-1 o.
    #[inline(always)]
    pub fn inverse_mul(self, o: Rot) -> Rot {
        Rot { c: self.c * o.c + self.s * o.s, s: self.c * o.s - self.s * o.c }
    }
    /// The rotation advanced by angle `h w` to first order, then normalised: (c, s) + h w (-s, c).
    #[inline]
    pub fn integrate(self, delta: f32) -> Rot {
        Rot::from_pair(self.c - delta * self.s, self.s + delta * self.c)
    }
}

/// A rigid transform: rotate by `q`, then move by `p`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Xf {
    pub p: V2,
    pub q: Rot,
}

impl Xf {
    pub const IDENTITY: Xf = Xf { p: V2::ZERO, q: Rot::IDENTITY };
    #[inline(always)]
    pub fn apply(self, v: V2) -> V2 {
        self.q.apply(v).add(self.p)
    }
    #[inline(always)]
    pub fn apply_inverse(self, v: V2) -> V2 {
        self.q.apply_inverse(v.sub(self.p))
    }
    /// The transform of `o`'s frame in self's frame: self^-1 o.
    #[inline]
    pub fn inverse_mul(self, o: Xf) -> Xf {
        Xf { p: self.q.apply_inverse(o.p.sub(self.p)), q: self.q.inverse_mul(o.q) }
    }
}
