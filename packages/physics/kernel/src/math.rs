// Scalar helpers. Every one is a correctly rounded IEEE 754 operation on both targets, so native and Wasm agree bit for
// bit: Rust never contracts a * b + c into a fused operation, and Wasm has none outside relaxed SIMD.

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
