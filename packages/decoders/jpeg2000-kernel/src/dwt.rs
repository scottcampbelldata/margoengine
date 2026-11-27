//! The inverse discrete wavelet transform of T.800 Annex F: 2D_SR as 2D_INTERLEAVE, then HOR_SR on every row, then
//! VER_SR on every column, each a 1D_SR lifting with whole-sample symmetric extension (F.3.7), by the reversible 5-3
//! filter (F.3.8.1) or the irreversible 9-7 filter (F.3.8.2).
use crate::geometry::Rect;

/// The 9-7 lifting constants of Table F.4 and its scaling K.
pub const ALPHA: f32 = -1.586_134_342_059_924;
pub const BETA: f32 = -0.052_980_118_572_961;
pub const GAMMA: f32 = 0.882_911_075_530_934;
pub const DELTA: f32 = 0.443_506_852_043_971;
pub const K: f32 = 1.230_174_104_914_001;

/// Whole-sample symmetric extension of an index into [0, n).
#[inline]
fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    if n == 1 {
        return 0;
    }
    let period = 2 * (n - 1);
    let mut i = i.rem_euclid(period);
    if i >= n {
        i = period - i;
    }
    i as usize
}

/// 1D_SR of the 5-3 filter on `x` (interleaved, x[k] at absolute index i0 + k): low-pass samples at even absolute
/// indices.
pub fn synth53(x: &mut [i32], i0: u32) {
    let n = x.len();
    if n == 0 {
        return;
    }
    if n == 1 {
        // F.3.7: a lone odd sample was doubled by the analysis.
        if i0 % 2 == 1 {
            x[0] /= 2;
        }
        return;
    }
    let first_even = (i0 % 2) as usize;
    let first_odd = 1 - first_even;
    // Equation F-5: X(2n) = Y(2n) - floor((Y(2n-1) + Y(2n+1) + 2) / 4).
    for k in (first_even..n).step_by(2) {
        let a = x[reflect(k as isize - 1, n)];
        let b = x[reflect(k as isize + 1, n)];
        x[k] -= (a + b + 2) >> 2;
    }
    // Equation F-6: X(2n+1) = Y(2n+1) + floor((X(2n) + X(2n+2)) / 2).
    for k in (first_odd..n).step_by(2) {
        let a = x[reflect(k as isize - 1, n)];
        let b = x[reflect(k as isize + 1, n)];
        x[k] += (a + b) >> 1;
    }
}

/// 1D_SR of the 9-7 filter (Equations F-7, steps 1 to 6).
pub fn synth97(x: &mut [f32], i0: u32) {
    let n = x.len();
    if n == 0 {
        return;
    }
    if n == 1 {
        if i0 % 2 == 1 {
            x[0] /= 2.0;
        }
        return;
    }
    let even = (i0 % 2) as usize;
    let odd = 1 - even;
    for k in (even..n).step_by(2) {
        x[k] *= K;
    }
    for k in (odd..n).step_by(2) {
        x[k] /= K;
    }
    let lift = |x: &mut [f32], start: usize, c: f32| {
        for k in (start..n).step_by(2) {
            let a = x[reflect(k as isize - 1, n)];
            let b = x[reflect(k as isize + 1, n)];
            x[k] -= c * (a + b);
        }
    };
    lift(x, even, DELTA);
    lift(x, odd, GAMMA);
    lift(x, even, BETA);
    lift(x, odd, ALPHA);
}

/// Samples a transform works on.
pub trait Sample: Copy + Default {
    fn synth(x: &mut [Self], i0: u32);
}
impl Sample for i32 {
    fn synth(x: &mut [i32], i0: u32) {
        synth53(x, i0)
    }
}
impl Sample for f32 {
    fn synth(x: &mut [f32], i0: u32) {
        synth97(x, i0)
    }
}

/// One 2D_SR level: the resolution `res` from the LL band of the level below and its HL, LH and HH bands (each a
/// rectangle in band coordinates and its samples, row by row).
pub fn level<T: Sample>(res: &Rect, ll: (&Rect, &[T]), hl: (&Rect, &[T]), lh: (&Rect, &[T]), hh: (&Rect, &[T])) -> Vec<T> {
    let (w, h) = (res.width() as usize, res.height() as usize);
    let mut out = vec![T::default(); w * h];
    if w == 0 || h == 0 {
        return out;
    }
    // 2D_INTERLEAVE (F.3.3): an absolute coordinate u takes band index u >> 1, low-pass at even u.
    for v in 0..h {
        let av = res.y0 + v as u32;
        for u in 0..w {
            let au = res.x0 + u as u32;
            let (rect, data) = match (au % 2, av % 2) {
                (0, 0) => ll,
                (1, 0) => hl,
                (0, _) => lh,
                _ => hh,
            };
            let bx = (au >> 1) - rect.x0;
            let by = (av >> 1) - rect.y0;
            out[v * w + u] = data[by as usize * rect.width() as usize + bx as usize];
        }
    }
    // HOR_SR, then VER_SR.
    for row in out.chunks_exact_mut(w) {
        T::synth(row, res.x0);
    }
    let mut column = vec![T::default(); h];
    for u in 0..w {
        for v in 0..h {
            column[v] = out[v * w + u];
        }
        T::synth(&mut column, res.y0);
        for v in 0..h {
            out[v * w + u] = column[v];
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 1D_SD of the 5-3 filter (F.4.8.1), for tests.
    pub fn analyse53(x: &mut [i32], i0: u32) {
        let n = x.len();
        if n == 1 {
            if i0 % 2 == 1 {
                x[0] *= 2;
            }
            return;
        }
        let even = (i0 % 2) as usize;
        for k in (1 - even..n).step_by(2) {
            let (a, b) = (x[reflect(k as isize - 1, n)], x[reflect(k as isize + 1, n)]);
            x[k] -= (a + b) >> 1;
        }
        for k in (even..n).step_by(2) {
            let (a, b) = (x[reflect(k as isize - 1, n)], x[reflect(k as isize + 1, n)]);
            x[k] += (a + b + 2) >> 2;
        }
    }

    /// 1D_SD of the 9-7 filter (F.4.8.2), for tests.
    pub fn analyse97(x: &mut [f32], i0: u32) {
        let n = x.len();
        if n == 1 {
            if i0 % 2 == 1 {
                x[0] *= 2.0;
            }
            return;
        }
        let even = (i0 % 2) as usize;
        let odd = 1 - even;
        let lift = |x: &mut [f32], start: usize, c: f32| {
            for k in (start..n).step_by(2) {
                let (a, b) = (x[reflect(k as isize - 1, n)], x[reflect(k as isize + 1, n)]);
                x[k] += c * (a + b);
            }
        };
        lift(x, odd, ALPHA);
        lift(x, even, BETA);
        lift(x, odd, GAMMA);
        lift(x, even, DELTA);
        for k in (even..n).step_by(2) {
            x[k] /= K;
        }
        for k in (odd..n).step_by(2) {
            x[k] *= K;
        }
    }

    /// One 2D_SD level (VER_SD, then HOR_SD, then de-interleaving) of a resolution's samples into its four bands.
    pub fn analyse<T: Copy + Default>(res: &Rect, data: &[T], f: fn(&mut [T], u32), bands: [&Rect; 4]) -> [Vec<T>; 4] {
        let (w, h) = (res.width() as usize, res.height() as usize);
        let mut x = data.to_vec();
        let mut column = vec![T::default(); h];
        for u in 0..w {
            for v in 0..h {
                column[v] = x[v * w + u];
            }
            f(&mut column, res.y0);
            for v in 0..h {
                x[v * w + u] = column[v];
            }
        }
        for row in x.chunks_exact_mut(w) {
            f(row, res.x0);
        }
        let mut out: [Vec<T>; 4] = std::array::from_fn(|b| vec![T::default(); bands[b].area() as usize]);
        for v in 0..h {
            let av = res.y0 + v as u32;
            for u in 0..w {
                let au = res.x0 + u as u32;
                let b = match (au % 2, av % 2) {
                    (0, 0) => 0,
                    (1, 0) => 1,
                    (0, _) => 2,
                    _ => 3,
                };
                let r = bands[b];
                let i = ((av >> 1) - r.y0) as usize * r.width() as usize + ((au >> 1) - r.x0) as usize;
                out[b][i] = x[v * w + u];
            }
        }
        out
    }

    #[test]
    fn one_d_round_trips_at_every_parity_and_length() {
        for n in 1..12 {
            for i0 in 0..3 {
                let src: Vec<i32> = (0..n).map(|k| ((k * 37 + i0 as usize * 11) % 23) as i32 - 9).collect();
                let mut x = src.clone();
                analyse53(&mut x, i0);
                synth53(&mut x, i0);
                assert_eq!(x, src, "5-3 n {n} i0 {i0}");
                let src: Vec<f32> = src.iter().map(|&v| v as f32 * 1.5).collect();
                let mut x = src.clone();
                analyse97(&mut x, i0);
                synth97(&mut x, i0);
                for (a, b) in x.iter().zip(&src) {
                    assert!((a - b).abs() < 1e-3, "9-7 n {n} i0 {i0}");
                }
            }
        }
    }

    #[test]
    fn nine_seven_gains_match_table_e1() {
        // The low-pass passes a constant with gain 1 (log2 gain 0 of LL), the high-pass the alternating signal with
        // gain 2 (log2 gain 1), which fixes K's direction in the scaling steps.
        let mut x = vec![1.0f32; 64];
        analyse97(&mut x, 0);
        assert!((x[32] - 1.0).abs() < 1e-5);
        let mut x: Vec<f32> = (0..64).map(|k| if k % 2 == 0 { 1.0 } else { -1.0 }).collect();
        analyse97(&mut x, 0);
        assert!((x[33].abs() - 2.0).abs() < 1e-4);
    }

    #[test]
    fn two_d_level_round_trip() {
        use crate::geometry::{Band, band, resolution};
        let comp = Rect { x0: 3, y0: 2, x1: 16, y1: 13 };
        let res = resolution(&comp, 1, 1);
        let bands: Vec<Rect> = [Band::LL, Band::HL, Band::LH, Band::HH].iter().map(|&b| band(&comp, 1, if b == Band::LL { 0 } else { 1 }, b)).collect();
        let src: Vec<i32> = (0..res.area() as i32).map(|k| (k * 7919) % 255 - 128).collect();
        let [ll, hl, lh, hh] = analyse(&res, &src, analyse53, [&bands[0], &bands[1], &bands[2], &bands[3]]);
        let back = level(&res, (&bands[0], &ll), (&bands[1], &hl), (&bands[2], &lh), (&bands[3], &hh));
        assert_eq!(back, src);
    }
}
