// Four f32 lanes for solvers that visit four independent constraints at once (Catto, "SIMD Matters", 2024, as the
// description of a wide contact solve). wasm32 with simd128 (the shipped build) uses `core::arch::wasm32`, x86_64 uses
// SSE2 (part of every x86_64 CPU), anything else plain arrays. Only add, sub, mul, div, negation, compares and
// bitwise selects: each lane is the IEEE result the scalar operation gives, so a four-lane solve and the same solve one
// constraint at a time agree bit for bit. Min and max are left out on purpose: the instructions' rules for zeros and NaN
// differ between targets and from Rust's `f32::max`; a solver writes them as a compare and a select, or as `pmin` and
// `pmax`, which are defined as exactly that compare and select on both targets.
use core::ops::{Add, Div, Mul, Neg, Sub};

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::*;
    pub type F = v128;
    pub type M = v128;
    #[inline(always)]
    pub fn splat(x: f32) -> F {
        f32x4_splat(x)
    }
    #[inline(always)]
    pub fn from_array(a: [f32; 4]) -> F {
        f32x4(a[0], a[1], a[2], a[3])
    }
    #[inline(always)]
    pub fn to_array(x: F) -> [f32; 4] {
        [f32x4_extract_lane::<0>(x), f32x4_extract_lane::<1>(x), f32x4_extract_lane::<2>(x), f32x4_extract_lane::<3>(x)]
    }
    #[inline(always)]
    pub fn add(a: F, b: F) -> F {
        f32x4_add(a, b)
    }
    #[inline(always)]
    pub fn sub(a: F, b: F) -> F {
        f32x4_sub(a, b)
    }
    #[inline(always)]
    pub fn mul(a: F, b: F) -> F {
        f32x4_mul(a, b)
    }
    #[inline(always)]
    pub fn div(a: F, b: F) -> F {
        f32x4_div(a, b)
    }
    #[inline(always)]
    pub fn neg(a: F) -> F {
        f32x4_neg(a)
    }
    #[inline(always)]
    pub fn eq(a: F, b: F) -> M { f32x4_eq(a, b) }
    #[inline(always)]
    pub fn lt(a: F, b: F) -> M {
        f32x4_lt(a, b)
    }
    #[inline(always)]
    pub fn le(a: F, b: F) -> M {
        f32x4_le(a, b)
    }
    #[inline(always)]
    pub fn select(m: M, a: F, b: F) -> F {
        v128_bitselect(a, b, m)
    }
    /// b < a ? b : a, lane by lane (f32x4.pmin is defined as exactly this).
    #[inline(always)]
    pub fn pmin(a: F, b: F) -> F {
        f32x4_pmin(a, b)
    }
    /// a < b ? b : a, lane by lane (f32x4.pmax).
    #[inline(always)]
    pub fn pmax(a: F, b: F) -> F {
        f32x4_pmax(a, b)
    }
    #[inline(always)]
    pub fn transpose(r: [F; 4]) -> [F; 4] {
        let t0 = i32x4_shuffle::<0, 4, 1, 5>(r[0], r[1]);
        let t1 = i32x4_shuffle::<0, 4, 1, 5>(r[2], r[3]);
        let t2 = i32x4_shuffle::<2, 6, 3, 7>(r[0], r[1]);
        let t3 = i32x4_shuffle::<2, 6, 3, 7>(r[2], r[3]);
        [i64x2_shuffle::<0, 2>(t0, t1), i64x2_shuffle::<1, 3>(t0, t1), i64x2_shuffle::<0, 2>(t2, t3), i64x2_shuffle::<1, 3>(t2, t3)]
    }
    #[inline(always)]
    pub fn and(a: M, b: M) -> M {
        v128_and(a, b)
    }
    #[inline(always)]
    pub fn or(a: M, b: M) -> M {
        v128_or(a, b)
    }
    #[inline(always)]
    pub fn andnot(a: M, b: M) -> M {
        // a and not b
        v128_andnot(a, b)
    }
    #[inline(always)]
    pub fn bits(m: M) -> u32 {
        i32x4_bitmask(m) as u32
    }
    #[inline(always)]
    pub fn from_bits(b: u32) -> M {
        let lane = |k: u32| if b >> k & 1 == 1 { -1i32 } else { 0 };
        i32x4(lane(0), lane(1), lane(2), lane(3))
    }
}

#[cfg(target_arch = "x86_64")]
mod imp {
    use core::arch::x86_64::*;
    pub type F = __m128;
    pub type M = __m128;
    // SSE2 is part of the x86_64 baseline, so these intrinsics are always available.
    #[inline(always)]
    pub fn splat(x: f32) -> F {
        unsafe { _mm_set1_ps(x) }
    }
    #[inline(always)]
    pub fn from_array(a: [f32; 4]) -> F {
        unsafe { _mm_loadu_ps(a.as_ptr()) }
    }
    #[inline(always)]
    pub fn to_array(x: F) -> [f32; 4] {
        let mut a = [0.0f32; 4];
        unsafe { _mm_storeu_ps(a.as_mut_ptr(), x) };
        a
    }
    #[inline(always)]
    pub fn add(a: F, b: F) -> F {
        unsafe { _mm_add_ps(a, b) }
    }
    #[inline(always)]
    pub fn sub(a: F, b: F) -> F {
        unsafe { _mm_sub_ps(a, b) }
    }
    #[inline(always)]
    pub fn mul(a: F, b: F) -> F {
        unsafe { _mm_mul_ps(a, b) }
    }
    #[inline(always)]
    pub fn div(a: F, b: F) -> F {
        unsafe { _mm_div_ps(a, b) }
    }
    #[inline(always)]
    pub fn neg(a: F) -> F {
        unsafe { _mm_xor_ps(a, _mm_set1_ps(-0.0)) }
    }
    #[inline(always)]
    pub fn eq(a: F, b: F) -> M { unsafe { _mm_cmpeq_ps(a, b) } }
    #[inline(always)]
    pub fn lt(a: F, b: F) -> M {
        unsafe { _mm_cmplt_ps(a, b) }
    }
    #[inline(always)]
    pub fn le(a: F, b: F) -> M {
        unsafe { _mm_cmple_ps(a, b) }
    }
    #[inline(always)]
    pub fn select(m: M, a: F, b: F) -> F {
        unsafe { _mm_or_ps(_mm_and_ps(m, a), _mm_andnot_ps(m, b)) }
    }
    /// b < a ? b : a: minps(x, y) is x < y ? x : y, so the operands go in swapped.
    #[inline(always)]
    pub fn pmin(a: F, b: F) -> F {
        unsafe { _mm_min_ps(b, a) }
    }
    /// a < b ? b : a: maxps(x, y) is x > y ? x : y.
    #[inline(always)]
    pub fn pmax(a: F, b: F) -> F {
        unsafe { _mm_max_ps(b, a) }
    }
    #[inline(always)]
    pub fn transpose(r: [F; 4]) -> [F; 4] {
        unsafe {
            let t0 = _mm_unpacklo_ps(r[0], r[1]);
            let t1 = _mm_unpacklo_ps(r[2], r[3]);
            let t2 = _mm_unpackhi_ps(r[0], r[1]);
            let t3 = _mm_unpackhi_ps(r[2], r[3]);
            [_mm_movelh_ps(t0, t1), _mm_movehl_ps(t1, t0), _mm_movelh_ps(t2, t3), _mm_movehl_ps(t3, t2)]
        }
    }
    #[inline(always)]
    pub fn and(a: M, b: M) -> M {
        unsafe { _mm_and_ps(a, b) }
    }
    #[inline(always)]
    pub fn or(a: M, b: M) -> M {
        unsafe { _mm_or_ps(a, b) }
    }
    #[inline(always)]
    pub fn andnot(a: M, b: M) -> M {
        // a and not b (the intrinsic takes the negated operand first)
        unsafe { _mm_andnot_ps(b, a) }
    }
    #[inline(always)]
    pub fn bits(m: M) -> u32 {
        unsafe { _mm_movemask_ps(m) as u32 }
    }
    #[inline(always)]
    pub fn from_bits(b: u32) -> M {
        let lane = |k: u32| if b >> k & 1 == 1 { -1i32 } else { 0 };
        unsafe { _mm_castsi128_ps(_mm_setr_epi32(lane(0), lane(1), lane(2), lane(3))) }
    }
}

#[cfg(not(any(target_arch = "x86_64", all(target_arch = "wasm32", target_feature = "simd128"))))]
mod imp {
    pub type F = [f32; 4];
    pub type M = [bool; 4];
    #[inline(always)]
    fn map(a: F, b: F, f: impl Fn(f32, f32) -> f32) -> F {
        [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
    }
    #[inline(always)]
    fn test(a: F, b: F, f: impl Fn(f32, f32) -> bool) -> M {
        [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
    }
    pub fn splat(x: f32) -> F {
        [x; 4]
    }
    pub fn from_array(a: [f32; 4]) -> F {
        a
    }
    pub fn to_array(x: F) -> [f32; 4] {
        x
    }
    pub fn add(a: F, b: F) -> F {
        map(a, b, |x, y| x + y)
    }
    pub fn sub(a: F, b: F) -> F {
        map(a, b, |x, y| x - y)
    }
    pub fn mul(a: F, b: F) -> F {
        map(a, b, |x, y| x * y)
    }
    pub fn div(a: F, b: F) -> F {
        map(a, b, |x, y| x / y)
    }
    pub fn neg(a: F) -> F {
        a.map(|x| -x)
    }
    pub fn eq(a: F, b: F) -> M { test(a, b, |x, y| x == y) }
    #[inline(always)]
    pub fn lt(a: F, b: F) -> M {
        test(a, b, |x, y| x < y)
    }
    pub fn le(a: F, b: F) -> M {
        test(a, b, |x, y| x <= y)
    }
    pub fn select(m: M, a: F, b: F) -> F {
        [0, 1, 2, 3].map(|k| if m[k] { a[k] } else { b[k] })
    }
    pub fn pmin(a: F, b: F) -> F {
        map(a, b, |x, y| if y < x { y } else { x })
    }
    pub fn pmax(a: F, b: F) -> F {
        map(a, b, |x, y| if x < y { y } else { x })
    }
    pub fn transpose(r: [F; 4]) -> [F; 4] {
        [0, 1, 2, 3].map(|i| [r[0][i], r[1][i], r[2][i], r[3][i]])
    }
    pub fn and(a: M, b: M) -> M {
        [0, 1, 2, 3].map(|k| a[k] && b[k])
    }
    pub fn or(a: M, b: M) -> M {
        [0, 1, 2, 3].map(|k| a[k] || b[k])
    }
    pub fn andnot(a: M, b: M) -> M {
        [0, 1, 2, 3].map(|k| a[k] && !b[k])
    }
    pub fn bits(m: M) -> u32 {
        (0..4).map(|k| (m[k] as u32) << k).sum()
    }
    pub fn from_bits(b: u32) -> M {
        [0, 1, 2, 3].map(|k| b >> k & 1 == 1)
    }
}

/// Four f32 lanes.
#[derive(Clone, Copy)]
pub struct F4(imp::F);

/// Four lane flags, the result of a compare.
#[derive(Clone, Copy)]
pub struct M4(imp::M);

impl F4 {
    #[inline(always)]
    pub fn splat(x: f32) -> F4 {
        F4(imp::splat(x))
    }
    #[inline(always)]
    pub fn new(a: [f32; 4]) -> F4 {
        F4(imp::from_array(a))
    }
    #[inline(always)]
    pub fn get(self) -> [f32; 4] {
        imp::to_array(self.0)
    }
    /// Lanes where self == o (signed zeros equal, either NaN unequal).
    #[inline(always)]
    pub fn eq(self, o: F4) -> M4 { M4(imp::eq(self.0, o.0)) }
    /// Lanes where self < o.
    #[inline(always)]
    pub fn lt(self, o: F4) -> M4 {
        M4(imp::lt(self.0, o.0))
    }
    #[inline(always)]
    pub fn le(self, o: F4) -> M4 {
        M4(imp::le(self.0, o.0))
    }
    #[inline(always)]
    pub fn gt(self, o: F4) -> M4 {
        M4(imp::lt(o.0, self.0))
    }
    #[inline(always)]
    pub fn ge(self, o: F4) -> M4 {
        M4(imp::le(o.0, self.0))
    }
    /// `a` where `m` is set, else `b`, lane by lane.
    #[inline(always)]
    pub fn select(m: M4, a: F4, b: F4) -> F4 {
        F4(imp::select(m.0, a.0, b.0))
    }
    /// `o < self ? o : self` lane by lane: `select(o.lt(self), o, self)` in one instruction on both SIMD targets
    /// (SSE2 `minps`, Wasm `f32x4.pmin`), so the same bits as the compare and select, zeros and NaN included. It is
    /// not `f32::min`.
    #[inline(always)]
    pub fn pmin(self, o: F4) -> F4 {
        F4(imp::pmin(self.0, o.0))
    }
    /// `self < o ? o : self` lane by lane: `select(self.lt(o), o, self)` in one instruction (`maxps`, `f32x4.pmax`).
    #[inline(always)]
    pub fn pmax(self, o: F4) -> F4 {
        F4(imp::pmax(self.0, o.0))
    }
    /// Rows to columns: lane i of result j is lane j of row i. Moves only, so every bit is kept; four structures of four
    /// floats loaded whole become four lanes of each field (Catto, "SIMD Matters", 2024, describes gathering bodies so).
    #[inline(always)]
    pub fn transpose(rows: [F4; 4]) -> [F4; 4] {
        imp::transpose(rows.map(|r| r.0)).map(F4)
    }
}

impl M4 {
    /// Lane k set where bit k of `bits` is.
    #[inline(always)]
    pub fn from_bits(bits: u32) -> M4 {
        M4(imp::from_bits(bits))
    }
    /// Bit k set where lane k is.
    #[inline(always)]
    pub fn bits(self) -> u32 {
        imp::bits(self.0)
    }
    #[inline(always)]
    pub fn and(self, o: M4) -> M4 {
        M4(imp::and(self.0, o.0))
    }
    #[inline(always)]
    pub fn or(self, o: M4) -> M4 {
        M4(imp::or(self.0, o.0))
    }
    /// Lanes set in self and not in `o`.
    #[inline(always)]
    pub fn and_not(self, o: M4) -> M4 {
        M4(imp::andnot(self.0, o.0))
    }
}

impl Add for F4 {
    type Output = F4;
    #[inline(always)]
    fn add(self, o: F4) -> F4 {
        F4(imp::add(self.0, o.0))
    }
}
impl Sub for F4 {
    type Output = F4;
    #[inline(always)]
    fn sub(self, o: F4) -> F4 {
        F4(imp::sub(self.0, o.0))
    }
}
impl Mul for F4 {
    type Output = F4;
    #[inline(always)]
    fn mul(self, o: F4) -> F4 {
        F4(imp::mul(self.0, o.0))
    }
}
impl Div for F4 {
    type Output = F4;
    #[inline(always)]
    fn div(self, o: F4) -> F4 {
        F4(imp::div(self.0, o.0))
    }
}
impl Neg for F4 {
    type Output = F4;
    #[inline(always)]
    fn neg(self) -> F4 {
        F4(imp::neg(self.0))
    }
}
