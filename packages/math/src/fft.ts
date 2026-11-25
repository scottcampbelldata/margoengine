// FFT and spectral synthesis (K17 of docs/physics-solvers.md), the TypeScript twin of kernel-common's fft.rs: a
// mixed-radix Stockham FFT for any length whose prime factors are 2, 3 and 5, its twiddles computed once from the pinned
// sin and cos (K01) and stored, and every operation in a fixed order, so the TypeScript and the Rust give the same bits on
// every engine. Complex transforms in 1, 2 and 3 dimensions (along x, then y, then z), and a 2D real-to-complex transform
// and its inverse for real fields (the sea's height spectra, SEA-01 and SEA-02; a wind box's components).
//
// Method (decimation in frequency, autosort): with s interleaved sequences of the current length n_c = p m, element i of
// sequence q at q + s i, a stage of radix p writes
//   y[q + s (k2 + p j1)] = w_{n_c}^(j1 k2) sum_{j2} x[q + s (j1 + m j2)] w_p^(j2 k2)
// for j1 < m and k2 < p, then goes on with s p sequences of length m; after the last stage the transform is in natural
// order. J. W. Cooley and J. W. Tukey, "An algorithm for the machine calculation of complex Fourier series", Mathematics of
// Computation 19(90), 1965; T. G. Stockham, "High-speed convolution and correlation", AFIPS Spring Joint Computer Conference,
// 1966; C. Van Loan, "Computational Frameworks for the Fast Fourier Transform", SIAM, 1992 (sections 1.7 and 2.3).

import { cos, sin } from './pinned.js';

const TWO_PI = 6.283185307179586;

/** A plan for complex transforms of length `n`: its prime factors and its twiddles. */
export class Fft {
  /** The length. */
  readonly n: number;
  /** Its prime factors in the order the stages use them (2s, then 3s, then 5s). */
  readonly factors: readonly number[];
  /** w^j = exp(-2 pi i j / n) for j from 0 to n - 1, interleaved [re, im]. */
  private readonly twiddles: Float64Array;
  private readonly a: Float64Array;
  private readonly b: Float64Array;

  /** @throws RangeError for a length that is not a whole number from 1 to 2^24 whose prime factors are 2, 3 and 5. */
  constructor(n: number) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 16777216)
      throw new RangeError(`An FFT length is a whole number from 1 to 2^24 (got ${n}).`);
    this.n = n;
    this.factors = factor(n);
    this.twiddles = new Float64Array(2 * n);
    for (let j = 0; j < n; j++) {
      const angle = (TWO_PI * j) / n;
      this.twiddles[2 * j] = cos(angle);
      this.twiddles[2 * j + 1] = -sin(angle);
    }
    this.a = new Float64Array(2 * n);
    this.b = new Float64Array(2 * n);
  }

  /**
   * Transforms the `n` complex values of `data` at `offset + 2 i stride` (real) and the word after (imaginary), in place:
   * X_k = sum_i x_i exp(-2 pi i i k / n), or with `inverse` exp(+...) divided by n.
   */
  transform(data: Float64Array, inverse = false, offset = 0, stride = 1): void {
    const n = this.n,
      w = this.twiddles;
    let x = this.a,
      y = this.b;
    for (let i = 0; i < n; i++) {
      x[2 * i] = data[offset + 2 * i * stride]!;
      x[2 * i + 1] = data[offset + 2 * i * stride + 1]!;
    }
    const sign = inverse ? -1 : 1;
    let s = 1,
      length = n;
    for (const p of this.factors) {
      const m = length / p,
        // Table steps of w_{n_c} and of w_p.
        stepC = n / length,
        stepP = n / p;
      for (let q = 0; q < s; q++)
        for (let j1 = 0; j1 < m; j1++)
          for (let k2 = 0; k2 < p; k2++) {
            let re = 0,
              im = 0;
            for (let j2 = 0; j2 < p; j2++) {
              const at = 2 * (q + s * (j1 + m * j2)),
                t = 2 * (((j2 * k2) % p) * stepP),
                wr = w[t]!,
                wi = sign * w[t + 1]!,
                xr = x[at]!,
                xi = x[at + 1]!;
              re += xr * wr - xi * wi;
              im += xr * wi + xi * wr;
            }
            const t = 2 * ((j1 * k2 * stepC) % n),
              wr = w[t]!,
              wi = sign * w[t + 1]!,
              to = 2 * (q + s * (k2 + p * j1));
            y[to] = re * wr - im * wi;
            y[to + 1] = re * wi + im * wr;
          }
      const swap = x;
      x = y;
      y = swap;
      s *= p;
      length = m;
    }
    const scale = inverse ? 1 / n : 1;
    for (let i = 0; i < n; i++) {
      data[offset + 2 * i * stride] = x[2 * i]! * scale;
      data[offset + 2 * i * stride + 1] = x[2 * i + 1]! * scale;
    }
  }
}

/**
 * Complex transforms of an nx by ny (by nz) grid stored x fastest, interleaved [re, im]: every row along x, then every
 * column along y, then every line along z, each with its own plan.
 */
export class Fft3 {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  private readonly plans: readonly [Fft, Fft, Fft];

  constructor(nx: number, ny = 1, nz = 1) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.plans = [new Fft(nx), new Fft(ny), new Fft(nz)];
  }

  /** Transforms `data` (2 nx ny nz words) in place; `inverse` divides by nx ny nz. */
  transform(data: Float64Array, inverse = false): void {
    const { nx, ny, nz } = this;
    if (data.length !== 2 * nx * ny * nz)
      throw new RangeError(
        `A ${nx} by ${ny} by ${nz} complex grid holds ${2 * nx * ny * nz} words (got ${data.length}).`,
      );
    const [px, py, pz] = this.plans;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) px.transform(data, inverse, 2 * nx * (j + ny * k), 1);
    if (ny > 1)
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) py.transform(data, inverse, 2 * (i + nx * ny * k), nx);
    if (nz > 1)
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pz.transform(data, inverse, 2 * (i + nx * j), nx * ny);
  }
}

/**
 * The 2D transform of a real nx by ny field (x fastest) as its half spectrum: (nx / 2 + 1) by ny complex values (the
 * rest follow by symmetry, X(-k) = conj X(k)). `inverseReal` takes such a half spectrum back to the real field.
 */
export class RealFft2 {
  readonly nx: number;
  readonly ny: number;
  private readonly grid: Fft3;
  private readonly full: Float64Array;

  /** @throws RangeError for an odd nx, or a length whose prime factors are not 2, 3 and 5. */
  constructor(nx: number, ny: number) {
    if (nx % 2 !== 0) throw new RangeError(`A real 2D transform takes an even nx (got ${nx}).`);
    this.nx = nx;
    this.ny = ny;
    this.grid = new Fft3(nx, ny);
    this.full = new Float64Array(2 * nx * ny);
  }

  /** The half spectrum of `field` (nx ny reals) into `out` ((nx / 2 + 1) ny complex values, interleaved). */
  forward(field: Float64Array, out: Float64Array = new Float64Array(2 * (this.nx / 2 + 1) * this.ny)): Float64Array {
    const { nx, ny, full } = this,
      half = nx / 2 + 1;
    if (field.length !== nx * ny)
      throw new RangeError(`A ${nx} by ${ny} real field holds ${nx * ny} values (got ${field.length}).`);
    for (let i = 0; i < nx * ny; i++) {
      full[2 * i] = field[i]!;
      full[2 * i + 1] = 0;
    }
    this.grid.transform(full);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < half; i++) {
        out[2 * (i + half * j)] = full[2 * (i + nx * j)]!;
        out[2 * (i + half * j) + 1] = full[2 * (i + nx * j) + 1]!;
      }
    return out;
  }

  /** The real field (nx ny values, into `out`) whose half spectrum is `spectrum`; the inverse of {@link forward}. */
  inverse(spectrum: Float64Array, out: Float64Array = new Float64Array(this.nx * this.ny)): Float64Array {
    const { nx, ny, full } = this,
      half = nx / 2 + 1;
    if (spectrum.length !== 2 * half * ny)
      throw new RangeError(`A ${nx} by ${ny} half spectrum holds ${2 * half * ny} words (got ${spectrum.length}).`);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        // The missing half by symmetry: X(i, j) = conj X(nx - i, ny - j).
        const mirrored = i >= half,
          si = mirrored ? nx - i : i,
          sj = mirrored ? (ny - j) % ny : j,
          from = 2 * (si + half * sj);
        full[2 * (i + nx * j)] = spectrum[from]!;
        full[2 * (i + nx * j) + 1] = mirrored ? -spectrum[from + 1]! : spectrum[from + 1]!;
      }
    this.grid.transform(full, true);
    for (let i = 0; i < nx * ny; i++) out[i] = full[2 * i]!;
    return out;
  }
}

function factor(n: number): number[] {
  const out: number[] = [];
  let m = n;
  for (const p of [2, 3, 5])
    while (m % p === 0) {
      out.push(p);
      m /= p;
    }
  if (m !== 1) throw new RangeError(`An FFT length has only the prime factors 2, 3 and 5 (got ${n}).`);
  return out;
}
