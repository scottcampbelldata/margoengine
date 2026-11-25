// Scalar helpers. Every one is a correctly rounded IEEE 754 operation on both targets, so native and Wasm agree bit for
// bit: Rust never contracts a * b + c into a fused operation, and Wasm has none outside relaxed SIMD.

/// Correctly rounded square root. Wasm: the `f32.sqrt` instruction through the SIMD form, as core has no float maths.
#[inline(always)]
pub fn sqrt(value: f32) -> f32 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;
        f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(value)))
    }
    #[cfg(all(target_arch = "wasm32", not(target_feature = "simd128")))]
    {
        soft_sqrt(value)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        value.sqrt()
    }
}

/// The square root of an f32 by integer arithmetic: the same correctly rounded result as the hardware instruction, for the Wasm
/// build without SIMD, whose core has no float square root. The mantissa, with its exponent made even, is square-rooted as an
/// integer with 28 more bits than the result needs, and the remainder says whether the root is exact or past a tie.
pub fn soft_sqrt(value: f32) -> f32 {
    let bits = value.to_bits();
    let (negative, mut exponent, mut mantissa) = (bits >> 31 != 0, ((bits >> 23) & 0xff) as i32, (bits & 0x7f_ffff) as u64);
    if exponent == 0xff {
        // Infinity stays, a NaN comes back quiet as the instruction gives it, and minus infinity is not a number.
        return if mantissa == 0 && negative { f32::from_bits(0x7fc0_0000) } else if mantissa != 0 { f32::from_bits(bits | 0x40_0000) } else { value };
    }
    if exponent == 0 && mantissa == 0 {
        return value;
    }
    if negative {
        return f32::from_bits(0x7fc0_0000);
    }
    if exponent == 0 {
        // A subnormal: shift its leading bit to the hidden place.
        exponent = 1;
        while mantissa & 0x80_0000 == 0 {
            mantissa <<= 1;
            exponent -= 1;
        }
    } else {
        mantissa |= 0x80_0000;
    }
    // value = mantissa * 2^t.
    let mut t = exponent - 127 - 23;
    if t & 1 != 0 {
        mantissa <<= 1;
        t -= 1;
    }
    let scaled = mantissa << 28;
    // Digit by digit integer square root of `scaled` (below 2^54): the root has 27 bits at most.
    let (mut root, mut remainder, mut bit) = (0u64, scaled, 1u64 << 54);
    while bit > remainder {
        bit >>= 2;
    }
    while bit != 0 {
        if remainder >= root + bit {
            remainder -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    // `root` squared plus `remainder` is `scaled`. Keep 24 bits of root, rounding to nearest, ties to even.
    let shift = 64 - root.leading_zeros() as i32 - 24;
    let (mut kept, low, half) = (root >> shift, root & ((1 << shift) - 1), 1u64 << (shift - 1));
    if low > half || (low == half && (remainder != 0 || kept & 1 == 1)) {
        kept += 1;
    }
    let mut place = shift - 14 + t / 2;
    if kept == 1 << 24 {
        kept >>= 1;
        place += 1;
    }
    f32::from_bits((((place + 23 + 127) as u32) << 23) | (kept as u32 & 0x7f_ffff))
}

/// Correctly rounded square root of a double, as `sqrt`: Wasm's `f64.sqrt` through the SIMD form.
#[inline(always)]
pub fn sqrt64(value: f64) -> f64 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;
        f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
    }
    #[cfg(all(target_arch = "wasm32", not(target_feature = "simd128")))]
    {
        soft_sqrt64(value)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        value.sqrt()
    }
}

/// The square root of an f64 by integer arithmetic, as `soft_sqrt` does for an f32 (a 128-bit root of the mantissa).
pub fn soft_sqrt64(value: f64) -> f64 {
    let bits = value.to_bits();
    let (negative, mut exponent, mut mantissa) = (bits >> 63 != 0, ((bits >> 52) & 0x7ff) as i32, bits & 0xf_ffff_ffff_ffff);
    if exponent == 0x7ff {
        return if mantissa == 0 && negative { f64::from_bits(0x7ff8_0000_0000_0000) } else if mantissa != 0 { f64::from_bits(bits | (1 << 51)) } else { value };
    }
    if exponent == 0 && mantissa == 0 {
        return value;
    }
    if negative {
        return f64::from_bits(0x7ff8_0000_0000_0000);
    }
    if exponent == 0 {
        exponent = 1;
        while mantissa & (1 << 52) == 0 {
            mantissa <<= 1;
            exponent -= 1;
        }
    } else {
        mantissa |= 1 << 52;
    }
    let mut t = exponent - 1023 - 52;
    let mut m = mantissa as u128;
    if t & 1 != 0 {
        m <<= 1;
        t -= 1;
    }
    let scaled = m << 56;
    let (mut root, mut remainder, mut bit) = (0u128, scaled, 1u128 << 110);
    while bit > remainder {
        bit >>= 2;
    }
    while bit != 0 {
        if remainder >= root + bit {
            remainder -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    let shift = 128 - root.leading_zeros() as i32 - 53;
    let (mut kept, low, half) = (root >> shift, root & ((1u128 << shift) - 1), 1u128 << (shift - 1));
    if low > half || (low == half && (remainder != 0 || kept & 1 == 1)) {
        kept += 1;
    }
    let mut place = shift - 28 + t / 2;
    if kept == 1 << 53 {
        kept >>= 1;
        place += 1;
    }
    f64::from_bits((((place + 52 + 1023) as u64) << 52) | (kept as u64 & 0xf_ffff_ffff_ffff))
}

/// pi and half of it as the nearest f32.
pub const PI: f32 = 3.141_592_7;
pub const HALF_PI: f32 = 1.570_796_4;

/// The arc tangent of `t` from 0 to 1: two halvings by atan t = 2 atan(t / (1 + sqrt(1 + t^2))) bring it under tan(pi/16),
/// where the Gregory series stops under f32 rounding. Plus, times, divide and sqrt only, so bit-equal everywhere.
#[inline]
fn arc_tangent(t: f32) -> f32 {
    let t = t / (1.0 + sqrt(1.0 + t * t));
    let t = t / (1.0 + sqrt(1.0 + t * t));
    let s = t * t;
    4.0 * t * (1.0 + s * (-1.0 / 3.0 + s * (1.0 / 5.0 + s * (-1.0 / 7.0 + s * (1.0 / 9.0)))))
}

/// The angle of the point (x, y) from the X axis, from -pi to pi; 0 at the origin.
#[inline]
pub fn atan2(y: f32, x: f32) -> f32 {
    let (size_y, size_x) = (y.abs(), x.abs());
    if size_x == 0.0 && size_y == 0.0 {
        return 0.0;
    }
    let angle = if size_y <= size_x { arc_tangent(size_y / size_x) } else { HALF_PI - arc_tangent(size_x / size_y) };
    let angle = if x < 0.0 { PI - angle } else { angle };
    if y < 0.0 { -angle } else { angle }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct V3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[inline(always)]
pub const fn v3(x: f32, y: f32, z: f32) -> V3 {
    V3 { x, y, z }
}

impl V3 {
    #[inline(always)]
    pub fn add(self, o: V3) -> V3 {
        v3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    #[inline(always)]
    pub fn sub(self, o: V3) -> V3 {
        v3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    #[inline(always)]
    pub fn scale(self, s: f32) -> V3 {
        v3(self.x * s, self.y * s, self.z * s)
    }
    /// Each component times the other's: a diagonal matrix applied to a vector.
    #[inline(always)]
    pub fn mul(self, o: V3) -> V3 {
        v3(self.x * o.x, self.y * o.y, self.z * o.z)
    }
    #[inline(always)]
    pub fn dot(self, o: V3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    /// Each component's size.
    #[inline(always)]
    pub fn abs(self) -> V3 {
        v3(self.x.abs(), self.y.abs(), self.z.abs())
    }
    #[inline(always)]
    pub fn min(self, o: V3) -> V3 {
        v3(if o.x < self.x { o.x } else { self.x }, if o.y < self.y { o.y } else { self.y }, if o.z < self.z { o.z } else { self.z })
    }
    #[inline(always)]
    pub fn max(self, o: V3) -> V3 {
        v3(if o.x > self.x { o.x } else { self.x }, if o.y > self.y { o.y } else { self.y }, if o.z > self.z { o.z } else { self.z })
    }
    #[inline(always)]
    pub fn cross(self, o: V3) -> V3 {
        v3(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x)
    }
}

/// A rotation quaternion, x, y, z, w. `a.mul(b)` turns by `b`, then by `a`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Q {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Q {
    pub const IDENTITY: Q = Q { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };

    #[inline(always)]
    pub fn mul(self, o: Q) -> Q {
        Q {
            x: self.w * o.x + self.x * o.w + self.y * o.z - self.z * o.y,
            y: self.w * o.y - self.x * o.z + self.y * o.w + self.z * o.x,
            z: self.w * o.z + self.x * o.y - self.y * o.x + self.z * o.w,
            w: self.w * o.w - self.x * o.x - self.y * o.y - self.z * o.z,
        }
    }
    #[inline(always)]
    pub fn conjugate(self) -> Q {
        Q { x: -self.x, y: -self.y, z: -self.z, w: self.w }
    }
    #[inline(always)]
    pub fn normalized(self) -> Q {
        let inverse = 1.0 / sqrt(self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w);
        Q { x: self.x * inverse, y: self.y * inverse, z: self.z * inverse, w: self.w * inverse }
    }
    /// The vector turned by this unit quaternion.
    #[inline(always)]
    pub fn rotate(self, v: V3) -> V3 {
        let axis = v3(self.x, self.y, self.z);
        let t = axis.cross(v).scale(2.0);
        v.add(t.scale(self.w)).add(axis.cross(t))
    }
    /// The vector turned back by this unit quaternion.
    #[inline(always)]
    pub fn unrotate(self, v: V3) -> V3 {
        self.conjugate().rotate(v)
    }

    /// The exact turn by a rotation vector (its length is the angle), from the Maclaurin series of sin(a/2)/a and
    /// cos(a/2) in a^2: plus and times only, so bit-equal everywhere. A turn over one radian is halved first and squared
    /// back, so any speed stays exact. The series stop where the next term is under f32 rounding at a = 1.
    #[inline]
    pub fn from_rotation_vector(r: V3) -> Q {
        let mut v = r;
        let mut a2 = v.dot(v);
        let mut halvings = 0;
        while a2 > 1.0 {
            v = v.scale(0.5);
            a2 *= 0.25;
            halvings += 1;
        }
        let s = 0.5 + a2 * (-1.0 / 48.0 + a2 * (1.0 / 3840.0 + a2 * (-1.0 / 645120.0)));
        let c = 1.0 + a2 * (-1.0 / 8.0 + a2 * (1.0 / 384.0 + a2 * (-1.0 / 46080.0)));
        let mut q = Q { x: v.x * s, y: v.y * s, z: v.z * s, w: c };
        while halvings > 0 {
            q = q.mul(q);
            halvings -= 1;
        }
        q
    }

    /// The rotation vector of this unit quaternion, the shorter way round: the inverse of `from_rotation_vector`, from
    /// the series of asin(s)/s. Above s^2 = 1/16 the turn is halved first, by the half-angle rule q^(1/2) = |q + 1|, which
    /// leaves the next term of the series under f32 rounding.
    #[inline]
    pub fn to_rotation_vector(self) -> V3 {
        let mut q = if self.w < 0.0 { Q { x: -self.x, y: -self.y, z: -self.z, w: -self.w } } else { self };
        let mut scale = 2.0;
        while q.x * q.x + q.y * q.y + q.z * q.z > 0.0625 {
            q = Q { x: q.x, y: q.y, z: q.z, w: q.w + 1.0 }.normalized();
            scale *= 2.0;
        }
        let s2 = q.x * q.x + q.y * q.y + q.z * q.z;
        let series = 1.0 + s2 * (1.0 / 6.0 + s2 * (3.0 / 40.0 + s2 * (15.0 / 336.0 + s2 * (105.0 / 3456.0))));
        v3(q.x, q.y, q.z).scale(scale * series)
    }
}

/// x with `a b c` as the columns of the matrix: Cramer's rule. None when the matrix is singular to f32.
#[inline]
pub fn solve3(a: V3, b: V3, c: V3, rhs: V3) -> Option<V3> {
    let bc = b.cross(c);
    let det = a.dot(bc);
    let size = a.dot(a) * b.dot(b) * c.dot(c);
    if !(det * det > size * 1e-12) {
        return None;
    }
    let inverse = 1.0 / det;
    Some(v3(rhs.dot(bc) * inverse, a.dot(rhs.cross(c)) * inverse, a.dot(b.cross(rhs)) * inverse))
}
