// FFT and spectral synthesis (K17 of docs/physics-solvers.md): a mixed-radix Stockham FFT for any length whose prime factors
// are 2, 3 and 5, its twiddles computed once from the pinned sin and cos (K01) and stored, and every operation in a fixed
// order, so a native build, a Wasm build and the TypeScript twin (`@margoengine/math/fft`) give the same bits;
// tests/fft-vectors.txt pins both. Complex transforms in 1, 2 and 3 dimensions (along x, then y, then z), and a 2D
// real-to-complex transform and its inverse for real fields (the sea's spectra, a wind box's components).
//
// Method (decimation in frequency, autosort): with s interleaved sequences of the current length n_c = p m, element i of
// sequence q at q + s i, a stage of radix p writes
//   y[q + s (k2 + p j1)] = w_{n_c}^(j1 k2) sum_{j2} x[q + s (j1 + m j2)] w_p^(j2 k2)
// for j1 < m and k2 < p, then goes on with s p sequences of length m; after the last stage the transform is in natural
// order. J. W. Cooley and J. W. Tukey, Mathematics of Computation 19(90), 1965; T. G. Stockham, AFIPS 1966; C. Van Loan,
// "Computational Frameworks for the Fast Fourier Transform", SIAM 1992, sections 1.7 and 2.3.
use crate::pinned::{cos, sin};
use alloc::vec;
use alloc::vec::Vec;

const TWO_PI: f64 = 6.283185307179586;

/// A plan for complex transforms of length `n`.
pub struct Fft {
    pub n: usize,
    pub factors: Vec<usize>,
    twiddles: Vec<f64>,
    a: Vec<f64>,
    b: Vec<f64>,
}

impl Fft {
    /// A plan for length `n` (1 to 2^24, prime factors 2, 3 and 5 only); `None` for any other length.
    pub fn new(n: usize) -> Option<Self> {
        if n == 0 || n > 1 << 24 {
            return None;
        }
        let mut factors = Vec::new();
        let mut m = n;
        for p in [2usize, 3, 5] {
            while m % p == 0 {
                factors.push(p);
                m /= p;
            }
        }
        if m != 1 {
            return None;
        }
        let mut twiddles = vec![0.0; 2 * n];
        for j in 0..n {
            let angle = (TWO_PI * j as f64) / n as f64;
            twiddles[2 * j] = cos(angle);
            twiddles[2 * j + 1] = -sin(angle);
        }
        Some(Fft { n, factors, twiddles, a: vec![0.0; 2 * n], b: vec![0.0; 2 * n] })
    }

    /// Transforms the `n` complex values of `data` at `offset + 2 i stride` (real) and the word after (imaginary), in place;
    /// `inverse` uses exp(+...) and divides by n.
    pub fn transform(&mut self, data: &mut [f64], inverse: bool, offset: usize, stride: usize) {
        let n = self.n;
        for i in 0..n {
            self.a[2 * i] = data[offset + 2 * i * stride];
            self.a[2 * i + 1] = data[offset + 2 * i * stride + 1];
        }
        let sign = if inverse { -1.0 } else { 1.0 };
        let (mut s, mut length) = (1usize, n);
        let mut in_a = true;
        for &p in &self.factors {
            let m = length / p;
            let step_c = n / length;
            let step_p = n / p;
            let w = &self.twiddles;
            let (x, y) = if in_a { (&self.a, &mut self.b) } else { (&self.b, &mut self.a) };
            for q in 0..s {
                for j1 in 0..m {
                    for k2 in 0..p {
                        let (mut re, mut im) = (0.0f64, 0.0f64);
                        for j2 in 0..p {
                            let at = 2 * (q + s * (j1 + m * j2));
                            let t = 2 * (((j2 * k2) % p) * step_p);
                            let (wr, wi) = (w[t], sign * w[t + 1]);
                            let (xr, xi) = (x[at], x[at + 1]);
                            re += xr * wr - xi * wi;
                            im += xr * wi + xi * wr;
                        }
                        let t = 2 * ((j1 * k2 * step_c) % n);
                        let (wr, wi) = (w[t], sign * w[t + 1]);
                        let to = 2 * (q + s * (k2 + p * j1));
                        y[to] = re * wr - im * wi;
                        y[to + 1] = re * wi + im * wr;
                    }
                }
            }
            in_a = !in_a;
            s *= p;
            length = m;
        }
        let x = if in_a { &self.a } else { &self.b };
        let scale = if inverse { 1.0 / n as f64 } else { 1.0 };
        for i in 0..n {
            data[offset + 2 * i * stride] = x[2 * i] * scale;
            data[offset + 2 * i * stride + 1] = x[2 * i + 1] * scale;
        }
    }
}

/// Complex transforms of an nx by ny by nz grid stored x fastest, interleaved: along x, then y, then z.
pub struct Fft3 {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    plans: [Fft; 3],
}

impl Fft3 {
    pub fn new(nx: usize, ny: usize, nz: usize) -> Option<Self> {
        Some(Fft3 { nx, ny, nz, plans: [Fft::new(nx)?, Fft::new(ny)?, Fft::new(nz)?] })
    }

    /// Transforms `data` (2 nx ny nz words) in place; `inverse` divides by nx ny nz.
    pub fn transform(&mut self, data: &mut [f64], inverse: bool) {
        let (nx, ny, nz) = (self.nx, self.ny, self.nz);
        assert_eq!(data.len(), 2 * nx * ny * nz);
        for k in 0..nz {
            for j in 0..ny {
                self.plans[0].transform(data, inverse, 2 * nx * (j + ny * k), 1);
            }
        }
        if ny > 1 {
            for k in 0..nz {
                for i in 0..nx {
                    self.plans[1].transform(data, inverse, 2 * (i + nx * ny * k), nx);
                }
            }
        }
        if nz > 1 {
            for j in 0..ny {
                for i in 0..nx {
                    self.plans[2].transform(data, inverse, 2 * (i + nx * j), nx * ny);
                }
            }
        }
    }
}

/// The 2D transform of a real nx by ny field (x fastest) as its half spectrum, (nx / 2 + 1) by ny complex values.
pub struct RealFft2 {
    pub nx: usize,
    pub ny: usize,
    grid: Fft3,
    full: Vec<f64>,
}

impl RealFft2 {
    /// `None` for an odd nx or a length with a prime factor other than 2, 3 and 5.
    pub fn new(nx: usize, ny: usize) -> Option<Self> {
        if nx % 2 != 0 {
            return None;
        }
        Some(RealFft2 { nx, ny, grid: Fft3::new(nx, ny, 1)?, full: vec![0.0; 2 * nx * ny] })
    }

    /// The half spectrum of `field` (nx ny reals) into `out` (2 (nx / 2 + 1) ny words).
    pub fn forward(&mut self, field: &[f64], out: &mut [f64]) {
        let (nx, ny) = (self.nx, self.ny);
        let half = nx / 2 + 1;
        for i in 0..nx * ny {
            self.full[2 * i] = field[i];
            self.full[2 * i + 1] = 0.0;
        }
        self.grid.transform(&mut self.full, false);
        for j in 0..ny {
            for i in 0..half {
                out[2 * (i + half * j)] = self.full[2 * (i + nx * j)];
                out[2 * (i + half * j) + 1] = self.full[2 * (i + nx * j) + 1];
            }
        }
    }

    /// The real field (nx ny values, into `out`) whose half spectrum is `spectrum`.
    pub fn inverse(&mut self, spectrum: &[f64], out: &mut [f64]) {
        let (nx, ny) = (self.nx, self.ny);
        let half = nx / 2 + 1;
        for j in 0..ny {
            for i in 0..nx {
                let mirrored = i >= half;
                let (si, sj) = if mirrored { (nx - i, (ny - j) % ny) } else { (i, j) };
                let from = 2 * (si + half * sj);
                self.full[2 * (i + nx * j)] = spectrum[from];
                self.full[2 * (i + nx * j) + 1] = if mirrored { -spectrum[from + 1] } else { spectrum[from + 1] };
            }
        }
        self.grid.transform(&mut self.full, true);
        for i in 0..nx * ny {
            out[i] = self.full[2 * i];
        }
    }
}
