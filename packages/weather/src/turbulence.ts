// Atmospheric turbulence as a Mann box (ATMO-02 of docs/physics-solvers.md): a periodic box of the three velocity
// fluctuations of neutral surface-layer turbulence under a uniform mean shear, synthesised from a spectral tensor, so gusts
// have the right size, the right shape (stretched along the wind), the right ratio of the components and the right
// correlation between them (the Reynolds stress), and the field has no divergence. Sampled at any point and advected by the
// mean wind (Taylor's frozen turbulence), it gives every solver the same gust at the same place and time.
//
// The spectral tensor is Mann's uniform-shear model (J. Mann, "The spatial structure of neutral atmospheric surface-layer
// turbulence", Journal of Fluid Mechanics 273, 1994; not read here, its equations taken as restated in full by B. Keith, U.
// Khristenko and B. Wohlmuth, "Learning the structure of wind: A data-driven nonlocal turbulence model for the atmospheric
// boundary layer", Physics of Fluids 33, 2021, arXiv:2107.11046, read in full, eqs. 4-5 and 12-17):
//   the von Karman energy spectrum E(k) = A L^(5/3) (kL)^4 / (1 + (kL)^2)^(17/6),
//   the isotropic tensor Phi_ij(k0) = E(k0) / (4 pi k0^2) (delta_ij - k0_i k0_j / k0^2),
//   rapid distortion over a non-dimensional time beta: k = (k1, k2, k3), k0 = (k1, k2, k3 + beta k1), dZ(k) = D dZ0(k0) with
//     D = [[1, 0, zeta1], [0, 1, zeta2], [0, 0, zeta3]], zeta1 = C1 - C2 k2 / k1, zeta2 = C1 k2 / k1 + C2, zeta3 = k0^2 / k^2,
//     C1 = beta k1^2 (k0^2 - 2 k30^2 + beta k1 k30) / (k^2 (k1^2 + k2^2)),
//     C2 = k2 k0^2 / (k1^2 + k2^2)^(3/2) (atan(k30 / s) - atan(k3 / s)), s = sqrt(k1^2 + k2^2),
//   and the eddy lifetime of the IEC model, beta(k) = Gamma (kL)^(-2/3) / sqrt(2F1(1/3, 17/6; 4/3; -(kL)^-2)).
// The synthesis is the discrete Fourier one of Mann ("Wind field simulation", Probabilistic Engineering Mechanics 13(4), 1998;
// not read here, as restated by M. Faccioni, D. Kiehn and P. Vrancken, "Generating high-fidelity wind fields from the wind
// speed correlation tensor", Wind Energy Science 11, 2093-2101, 2026, eqs. 3-5, read in full): u(x) = sum_k exp(i k x)
// C(k) n(k) with C C* = (2 pi)^3 / V Phi(k) and n a unit complex Gaussian with the symmetry of a real field, here the
// transform of real white noise. A factor of the tensor is G = D G0(k0), G0 = sqrt(E / (4 pi)) / k0^2 [k0]x (the cross-product
// matrix, as [k0]x [k0]x^T = k0^2 I - k0 k0^T). The box is scaled to a requested standard deviation of the along-wind
// component. Everything is computed with the pinned maths (K01) and the pinned FFT (K17), so a box is the same bits on every
// engine.
//
// Accepted differences: a finite box under-represents the largest eddies (Faccioni et al. 2026, figure 2), so a box should
// span several length scales; the box repeats past its size.

import { Fft3 } from '@margoengine/math/fft';
import { cos, ln, pow } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';

const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;

/** Settings of a {@link MannBox}; each has a default. */
export interface MannBoxOptions {
  /** Cells along x (the mean wind), y (across) and z (up); each a length whose prime factors are 2, 3 and 5. */
  cells?: readonly [number, number, number];
  /** The box's size, m, along x, y and z. */
  size?: readonly [number, number, number];
  /** The turbulence length scale L, m (default 33.6: the IEC 61400-1 value, 0.8 times 42 m). */
  lengthScale?: number;
  /** The shear distortion Gamma (default 3.9, the IEC 61400-1 value; 0 is isotropic turbulence). */
  shear?: number;
  /** Standard deviation of the along-wind component, m/s (default 1). */
  sigma?: number;
  /** The seed of its random numbers (default 1). */
  seed?: number;
}

/** A periodic box of the three turbulent velocity fluctuations, m/s, stored x fastest. */
export class MannBox {
  readonly cells: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly lengthScale: number;
  readonly shear: number;
  readonly sigma: number;
  readonly seed: number;
  /** The along-wind, across and upward fluctuations, one value a cell. */
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly w: Float64Array;

  /** @throws RangeError for cells that the FFT cannot take, or a size, scale, shear or sigma that is not finite and positive. */
  constructor(options: MannBoxOptions = {}) {
    const {
      cells = [512, 32, 32],
      size = [4096, 256, 256],
      lengthScale = 33.6,
      shear = 3.9,
      sigma = 1,
      seed = 1,
    } = options;
    for (const [name, v] of [
      ['lengthScale', lengthScale],
      ['sigma', sigma],
      ...size.map((s, i) => [`size[${i}]`, s] as const),
    ] as const)
      if (!(v > 0 && Number.isFinite(v)))
        throw new RangeError(
          `A Mann box's ${name} is a finite number above 0 (got ${v}); pass a positive finite value.`,
        );
    if (!(shear >= 0 && Number.isFinite(shear)))
      throw new RangeError(
        `A Mann box's shear is 0 or more (got ${shear}); pass a finite shear, 0 for isotropic turbulence.`,
      );
    this.cells = [cells[0], cells[1], cells[2]];
    this.size = [size[0], size[1], size[2]];
    this.lengthScale = lengthScale;
    this.shear = shear;
    this.sigma = sigma;
    this.seed = seed;
    const [nx, ny, nz] = this.cells,
      n = nx * ny * nz,
      grid = new Fft3(nx, ny, nz),
      random = new RandomStream(seed, solverNumber('mann-box')),
      // Real white noise per component, unit variance (Box-Muller on the pinned ln, sin and cos), then its transform.
      noise = [0, 1, 2].map((component) => {
        const field = new Float64Array(2 * n);
        for (let i = 0; i < n; i++) {
          const [u1, u2] = random.unitF64(component, i, 0),
            r = Math.sqrt(-2 * ln(1 - u1));
          field[2 * i] = r * cos(TWO_PI * u2);
        }
        grid.transform(field);
        return field;
      }),
      out = [0, 1, 2].map(() => new Float64Array(2 * n)),
      L = lengthScale,
      dk = [TWO_PI / size[0], TWO_PI / size[1], TWO_PI / size[2]],
      // With the forward transform unnormalised, |noise|^2 averages n; u(x) = sum_k ... asks for a unit Gaussian per k, so
      // the amplitude takes 1 / sqrt(n), times sqrt(dk1 dk2 dk3) for the integral, times n to undo the inverse's 1 / n.
      scale = Math.sqrt((dk[0]! * dk[1]! * dk[2]!) / n) * n;
    for (let c = 0; c < nz; c++)
      for (let b = 0; b < ny; b++)
        for (let a = 0; a < nx; a++) {
          const k1 = wave(a, nx) * dk[0]!,
            k2 = wave(b, ny) * dk[1]!,
            k3 = wave(c, nz) * dk[2]!,
            kk = k1 * k1 + k2 * k2 + k3 * k3;
          // The mean is the wind's, and a Nyquist bin is its own mirror, where i G n cannot stay real: both stay 0.
          if (kk === 0 || 2 * a === nx || 2 * b === ny || 2 * c === nz) continue;
          const G = tensorFactor(k1, k2, k3, kk, L, shear),
            at = 2 * (a + nx * (b + ny * c));
          for (let i = 0; i < 3; i++) {
            // u_i = i G_ij n_j: the factor i keeps the field real (G(-k) = -G(k), real).
            let re = 0,
              im = 0;
            for (let j = 0; j < 3; j++) {
              const g = G[3 * i + j]!;
              re += g * noise[j]![at]!;
              im += g * noise[j]![at + 1]!;
            }
            out[i]![at] = -im * scale;
            out[i]![at + 1] = re * scale;
          }
        }
    for (const field of out) grid.transform(field, true);
    // Scale to the requested along-wind standard deviation (the spectrum's amplitude A cancels).
    let mean = 0;
    for (let i = 0; i < n; i++) mean += out[0]![2 * i]!;
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = out[0]![2 * i]! - mean;
      variance += d * d;
    }
    const factor = sigma / Math.sqrt(variance / n);
    [this.u, this.v, this.w] = out.map((field) => {
      const real = new Float64Array(n);
      for (let i = 0; i < n; i++) real[i] = field[2 * i]! * factor;
      return real;
    }) as [Float64Array, Float64Array, Float64Array];
  }

  /**
   * The fluctuation at (x, y, z) metres in the box's frame (it repeats past its size), trilinear between cells, into
   * `out` [u, v, w].
   */
  sample(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const [nx, ny, nz] = this.cells,
      [sx, sy, sz] = this.size,
      fx = wrap((x / sx) * nx, nx),
      fy = wrap((y / sy) * ny, ny),
      fz = wrap((z / sz) * nz, nz),
      i0 = Math.floor(fx),
      j0 = Math.floor(fy),
      k0 = Math.floor(fz),
      tx = fx - i0,
      ty = fy - j0,
      tz = fz - k0,
      i1 = (i0 + 1) % nx,
      j1 = (j0 + 1) % ny,
      k1 = (k0 + 1) % nz;
    const fields = [this.u, this.v, this.w];
    for (let c = 0; c < 3; c++) {
      const f = fields[c]!,
        at = (i: number, j: number, k: number) => f[i + nx * (j + ny * k)]!,
        x00 = at(i0, j0, k0) + (at(i1, j0, k0) - at(i0, j0, k0)) * tx,
        x10 = at(i0, j1, k0) + (at(i1, j1, k0) - at(i0, j1, k0)) * tx,
        x01 = at(i0, j0, k1) + (at(i1, j0, k1) - at(i0, j0, k1)) * tx,
        x11 = at(i0, j1, k1) + (at(i1, j1, k1) - at(i0, j1, k1)) * tx,
        y0 = x00 + (x10 - x00) * ty,
        y1 = x01 + (x11 - x01) * ty;
      out[c] = y0 + (y1 - y0) * tz;
    }
    return out;
  }
}

/** The signed wave index of FFT bin `m` of `n`: 0, 1, ..., n/2, then -(n/2 - 1), ..., -1. */
function wave(m: number, n: number): number {
  return m <= n / 2 ? m : m - n;
}

/** `f` brought into [0, n). */
function wrap(f: number, n: number): number {
  const r = f - Math.floor(f / n) * n;
  return r >= n ? 0 : r;
}

/**
 * A factor G of Mann's sheared spectral tensor at wavevector k (G G^T = Phi(k) up to the spectrum's amplitude), row-major.
 * Exported for tests.
 */
export function tensorFactor(k1: number, k2: number, k3: number, kk: number, L: number, shear: number): Float64Array {
  const kL = Math.sqrt(kk) * L,
    beta = shear === 0 ? 0 : (shear * pow(kL, -2 / 3)) / Math.sqrt(hypergeometric(1 / (kL * kL))),
    k30 = k3 + beta * k1,
    kk0 = k1 * k1 + k2 * k2 + k30 * k30,
    k0L = Math.sqrt(kk0) * L,
    // E(k0) / (4 pi), amplitude 1: L^(5/3) (k0 L)^4 / (1 + (k0 L)^2)^(17/6).
    energy = (pow(L, 5 / 3) * k0L * k0L * k0L * k0L) / pow(1 + k0L * k0L, 17 / 6) / (4 * PI),
    a = Math.sqrt(energy) / kk0;
  // G0 = a [k0]x
  const g0 = [0, k30 * a, -k2 * a, -k30 * a, 0, k1 * a, k2 * a, -k1 * a, 0];
  let z1 = 0,
    z2 = 0,
    z3 = 1;
  if (k1 !== 0 && beta !== 0) {
    const s2 = k1 * k1 + k2 * k2,
      s = Math.sqrt(s2),
      c1 = (beta * k1 * k1 * (kk0 - 2 * k30 * k30 + beta * k1 * k30)) / (kk * s2),
      c2 = ((k2 * kk0) / (s2 * s)) * (atan(k30 / s) - atan(k3 / s));
    z1 = c1 - (c2 * k2) / k1;
    z2 = (c1 * k2) / k1 + c2;
    z3 = kk0 / kk;
  }
  const g = new Float64Array(9);
  for (let j = 0; j < 3; j++) {
    g[j] = g0[j]! + z1 * g0[6 + j]!;
    g[3 + j] = g0[3 + j]! + z2 * g0[6 + j]!;
    g[6 + j] = z3 * g0[6 + j]!;
  }
  return g;
}

/**
 * 2F1(1/3, 17/6; 4/3; -x) for x >= 0 by Pfaff's transformation to (1 + x)^(-1/3) 2F1(1/3, -3/2; 4/3; x / (1 + x)), whose
 * series converges for every x (its argument is below 1, and c - a - b = 5/2 > 0). Summed until a term falls below 2^-60
 * of the sum.
 */
export function hypergeometric(x: number): number {
  const w = x / (1 + x);
  let term = 1,
    sum = 1;
  for (let n = 0; n < 10000; n++) {
    term *= (((1 / 3 + n) * (-3 / 2 + n)) / ((4 / 3 + n) * (n + 1))) * w;
    sum += term;
    if (Math.abs(term) < 8.673617379884035e-19 * Math.abs(sum)) break;
  }
  return pow(1 + x, -1 / 3) * sum;
}

/**
 * atan(x) from + - * / only, the same bits on every engine: reduced to |x| <= 1 by atan(x) = pi/2 - atan(1/x), then to
 * |t| <= tan(pi/12) by atan(x) = pi/6 + atan((x sqrt(3) - 1) / (x + sqrt(3))), then Taylor to t^31.
 */
export function atan(x: number): number {
  if (x !== x) return x;
  if (x < 0) return -atan(-x);
  if (x > 1) return PI / 2 - atan(1 / x);
  let base = 0,
    t = x;
  if (t > 0.2679491924311227) {
    t = (t * 1.7320508075688772 - 1) / (t + 1.7320508075688772);
    base = PI / 6;
  }
  const z = t * t;
  let sum = 0;
  for (let n = 15; n >= 0; n--) sum = sum * z + (n % 2 === 0 ? 1 : -1) / (2 * n + 1);
  return base + t * sum;
}
