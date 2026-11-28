// Atmospheric turbulence as a Mann box (ATMO-02 of docs/physics-solvers.md): a periodic box of the three velocity
// fluctuations of neutral surface-layer turbulence under a uniform mean shear, synthesised from a spectral tensor, so gusts
// have the right size, the right shape (stretched along the wind), the right ratio of the components and the right
// correlation between them (the Reynolds stress), and the field has no divergence. Sampled at any point and advected by the
// mean wind (Taylor's frozen turbulence), it gives every solver the same gust at the same place and time.
//
// The spectral tensor is Mann's uniform-shear model (J. Mann, "The spatial structure of neutral atmospheric surface-layer
// turbulence", Journal of Fluid Mechanics 273, 1994, eqs. 2.16–2.17, 3.3 and 3.13–3.17; also restated by B. Keith, U.
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
// see also Mann, Risø-R-727(EN), Part IB §1.3 and M. Faccioni, D. Kiehn and P. Vrancken, "Generating high-fidelity wind fields from the wind
// speed correlation tensor", Wind Energy Science 11, 2093-2101, 2026, eqs. 3-5, read in full): u(x) = sum_k exp(i k x)
// C(k) n(k) with C C* = (2 pi)^3 / V Phi(k) and n a unit complex Gaussian with the symmetry of a real field, here the
// transform of real white noise. A factor of the tensor is G = D G0(k0), G0 = sqrt(E / (4 pi)) / k0^2 [k0]x (the cross-product
// matrix, as [k0]x [k0]x^T = k0^2 I - k0 k0^T). The box is scaled to a requested standard deviation of the along-wind
// component. Everything is computed with the pinned maths (K01) and the pinned FFT (K17), so a box is the same bits on every
// engine.
//
// Accepted differences: a finite box under-represents the largest eddies (Faccioni et al. 2026, figure 2), so a box should
// span several length scales; the box repeats past its size.

import { MargoError } from '@margoengine/math/errors';
import { Fft3 } from '@margoengine/math/fft';
import { cos, ln, pow } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import type { MannFftWork } from './turbulence-native.js';

export { type TravellingGustOptions, travellingGust } from './travelling-gust.js';
export type { MannFftParticipantWork, MannFftWork } from './turbulence-native.js';

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

/** Options for lazy, native synthesis of a Mann tile. */
export interface MannBoxCreateOptions extends MannBoxOptions {
  /** Total threads, including the caller. Use one, two or three (default one). */
  readonly threads?: number;
  /** Cancel Wasm loading or a pending transform. */
  readonly signal?: AbortSignal;
}

type Dimensions = readonly [number, number, number];
type Planes = [Float64Array, Float64Array, Float64Array];

interface MannConfiguration {
  readonly cells: Dimensions;
  readonly size: Dimensions;
  readonly lengthScale: number;
  readonly shear: number;
  readonly sigma: number;
  readonly seed: number;
}

function fftLength(length: number): boolean {
  if (!(Number.isInteger(length) && length >= 1 && length <= 1 << 24)) return false;
  let remainder = length;
  for (const radix of [2, 3, 5]) while (remainder % radix === 0) remainder /= radix;
  return remainder === 1;
}

function resolveMann(options: MannBoxOptions): MannConfiguration {
  if (!options || typeof options !== 'object')
    throw new MargoError('state', 'Invalid Mann box options. Pass a settings object or omit it.');
  const {
    cells = [512, 32, 32],
    size = [4096, 256, 256],
    lengthScale = 33.6,
    shear = 3.9,
    sigma = 1,
    seed = 1,
  } = options;
  if (
    !Array.isArray(cells) ||
    cells.length !== 3 ||
    !fftLength(cells[0]) ||
    !fftLength(cells[1]) ||
    !fftLength(cells[2])
  )
    throw new MargoError(
      'state',
      'Invalid Mann box cell counts. Supply three lengths with only 2, 3 and 5 as prime factors, up to 2²⁴ each.',
    );
  const [nx, ny, nz] = cells;
  if (nx * ny * nz > 0x100000000)
    throw new MargoError(
      'state',
      'Too many Mann box cells for the random stream. Reduce the total to 2³² cells or fewer.',
    );
  if (ny < 3 && nz < 3)
    throw new MargoError(
      'state',
      'The Mann box has no along-wind fluctuation modes. Use at least three cells across the wind or vertically.',
    );
  if (
    !Array.isArray(size) ||
    size.length !== 3 ||
    ![size[0], size[1], size[2]].every((extent) => extent > 0 && Number.isFinite(extent))
  )
    throw new MargoError('state', 'Invalid Mann box size. You must supply three positive finite extents in metres.');
  if (!(lengthScale > 0 && Number.isFinite(lengthScale) && sigma > 0 && Number.isFinite(sigma)))
    throw new MargoError(
      'state',
      'Invalid Mann length scale or standard deviation. Set lengthScale and sigma to finite numbers above zero.',
    );
  if (!(shear >= 0 && Number.isFinite(shear)))
    throw new MargoError(
      'state',
      'Invalid Mann box shear. Pass a finite nonnegative shear, with zero for isotropic turbulence.',
    );
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff))
    throw new MargoError('state', 'Invalid Mann box seed. Use an integer from 0 to 4294967295.');
  return {
    cells: [nx, ny, nz],
    size: [size[0], size[1], size[2]],
    lengthScale,
    shear,
    sigma,
    seed,
  };
}

function whiteNoise(config: MannConfiguration): Planes {
  const [nx, ny, nz] = config.cells;
  const n = nx * ny * nz;
  const random = new RandomStream(config.seed, solverNumber('mann-box'));
  const unit: [number, number] = [0, 0];
  return [0, 1, 2].map((component) => {
    const field = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      const [u1, u2] = random.unitF64(component, i, 0, unit);
      const r = Math.sqrt(-2 * ln(1 - u1));
      field[2 * i] = r * cos(TWO_PI * u2);
    }
    return field;
  }) as Planes;
}

function colourModes(config: MannConfiguration, noise: Planes): Planes {
  const {
    cells: [nx, ny, nz],
    size: [sx, sy, sz],
    lengthScale,
    shear,
  } = config;
  const n = nx * ny * nz;
  const dk1 = TWO_PI / sx;
  const dk2 = TWO_PI / sy;
  const dk3 = TWO_PI / sz;
  // FFT of real white noise has n variance. Multiply unit spectral noise by sqrt(dk1 dk2 dk3),
  // and undo the inverse transform's 1 / n.
  const scale = Math.sqrt((dk1 * dk2 * dk3) / n) * n;
  if (!(scale > 0 && Number.isFinite(scale)))
    throw new MargoError('state', 'Mann frequency volume exceeds numeric range. Use representable box extents.');
  const out = [0, 1, 2].map(() => new Float64Array(2 * n)) as Planes;
  for (let c = 0; c < nz; c++)
    for (let b = 0; b < ny; b++)
      for (let a = 0; a < nx; a++) {
        const k1 = wave(a, nx) * dk1;
        const k2 = wave(b, ny) * dk2;
        const k3 = wave(c, nz) * dk3;
        const kk = k1 * k1 + k2 * k2 + k3 * k3;
        // The mean belongs to the wind. A Nyquist bin is its own mirror, where i G n cannot stay real.
        if (kk === 0 || 2 * a === nx || 2 * b === ny || 2 * c === nz) continue;
        const factor = tensorFactor(k1, k2, k3, kk, lengthScale, shear);
        const at = 2 * (a + nx * (b + ny * c));
        for (let i = 0; i < 3; i++) {
          let re = 0;
          let im = 0;
          for (let j = 0; j < 3; j++) {
            const g = factor[3 * i + j]!;
            re += g * noise[j]![at]!;
            im += g * noise[j]![at + 1]!;
          }
          // The factor i keeps the field real, since G(-k) = -G(k).
          out[i]![at] = -im * scale;
          out[i]![at + 1] = re * scale;
        }
      }
  return out;
}

function physicalPlanes(out: Planes, sigma: number): Planes {
  const n = out[0].length / 2;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[0][2 * i]!;
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = out[0][2 * i]! - mean;
    variance += d * d;
  }
  const factor = sigma / Math.sqrt(variance / n);
  if (!(factor > 0 && Number.isFinite(factor)))
    throw new MargoError(
      'state',
      'Mann spectral normalisation exceeds numeric range. Use a smaller contrast between box sizes and length scale.',
    );
  return out.map((field) => {
    const real = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const value = field[2 * i]! * factor;
      if (!Number.isFinite(value))
        throw new MargoError('state', 'Mann turbulent velocity exceeds numeric range. Reduce sigma or shear.');
      real[i] = value;
    }
    return real;
  }) as Planes;
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

  /** Actual native FFT work when synthesised with create(); otherwise undefined. */
  readonly fftWork?: MannFftWork;

  /** Sets up a periodic wind tile. Invalid or unrepresentable settings throw a coded error. */
  constructor(options: MannBoxOptions = {}) {
    const config = resolveMann(options);
    const grid = new Fft3(...config.cells);
    const noise = whiteNoise(config);
    for (const field of noise) grid.transform(field);
    const out = colourModes(config, noise);
    for (const field of out) grid.transform(field, true);
    [this.u, this.v, this.w] = physicalPlanes(out, config.sigma);
    this.cells = config.cells;
    this.size = config.size;
    this.lengthScale = config.lengthScale;
    this.shear = config.shear;
    this.sigma = config.sigma;
    this.seed = config.seed;
  }

  /**
   * Synthesize the same tile with the lazy Rust SIMD FFT. One thread by default, up to three for the three planes.
   * An abort signal cancels loading or the transform batches.
   */
  static async create(options: MannBoxCreateOptions = {}): Promise<MannBox> {
    const config = resolveMann(options);
    const { signal, threads } = options;
    const { loadMannFft } = await import('./turbulence-native.js');
    const grid = await loadMannFft(config.cells, { signal, threads });
    try {
      const noise = whiteNoise(config);
      await grid.transformBatch(noise);
      const spectral = colourModes(config, noise);
      await grid.transformBatch(spectral, true);
      const [u, v, w] = physicalPlanes(spectral, config.sigma);
      return Object.assign(Object.create(MannBox.prototype) as MannBox, config, {
        u,
        v,
        w,
        fftWork: grid.workCounts(),
      });
    } finally {
      grid.close();
    }
  }

  /**
   * The fluctuation at (x, y, z) metres in the box's frame (it repeats past its size), trilinear between cells, into
   * `out` [u, v, w].
   */
  sample(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    if (![x, y, z].every(Number.isFinite))
      throw new MargoError('state', 'Invalid Mann sample position. You must supply finite metres in the box frame.');
    const [nx, ny, nz] = this.cells;
    const [sx, sy, sz] = this.size;
    const fx = wrappedCell(x, sx, nx);
    const fy = wrappedCell(y, sy, ny);
    const fz = wrappedCell(z, sz, nz);
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const k0 = Math.floor(fz);
    const tx = fx - i0;
    const ty = fy - j0;
    const tz = fz - k0;
    const i1 = (i0 + 1) % nx;
    const j1 = (j0 + 1) % ny;
    const k1 = (k0 + 1) % nz;
    const interpolate = (field: Float64Array): number => {
      const at = (i: number, j: number, k: number) => field[i + nx * (j + ny * k)]!;
      const x00 = blend(at(i0, j0, k0), at(i1, j0, k0), tx);
      const x10 = blend(at(i0, j1, k0), at(i1, j1, k0), tx);
      const x01 = blend(at(i0, j0, k1), at(i1, j0, k1), tx);
      const x11 = blend(at(i0, j1, k1), at(i1, j1, k1), tx);
      return blend(blend(x00, x10, ty), blend(x01, x11, ty), tz);
    };
    const u = interpolate(this.u);
    const v = interpolate(this.v);
    const w = interpolate(this.w);
    if (![u, v, w].every(Number.isFinite))
      throw new MargoError(
        'state',
        'Mann interpolation found a nonfinite velocity. Keep the box planes finite or regenerate the tile.',
      );
    out[0] = u;
    out[1] = v;
    out[2] = w;
    return out;
  }
}

/** The signed wave index of FFT bin `m` of `n`: 0, 1, ..., n/2, then -(n/2 - 1), ..., -1. */
function wave(m: number, n: number): number {
  return m <= n / 2 ? m : m - n;
}

/** Signed location in a periodic FFT tile. Reduce in metres if cell scaling would lose the fractional phase. */
function wrappedCell(position: number, size: number, cells: number): number {
  const scaled = (position / size) * cells;
  const x = Math.abs(scaled) < 0x10000000000000 ? scaled : ((position % size) / size) * cells;
  const r = x - Math.floor(x / cells) * cells;
  return r >= cells ? 0 : r;
}

function blend(start: number, end: number, fraction: number): number {
  const distance = end - start;
  return Number.isFinite(distance) ? start + distance * fraction : start * (1 - fraction) + end * fraction;
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
  if (beta !== 0) {
    if (k1 === 0) {
      // The continuous limit of Mann (1994) eqs. 3.15–3.17 is zeta1 = -beta if k2 is nonzero.
      // For an exactly vertical wave, incompressibility already makes the initial vertical velocity zero.
      if (k2 !== 0) z1 = -beta;
    } else {
      const s2 = k1 * k1 + k2 * k2;
      const s = Math.sqrt(s2);
      const c1 = (beta * k1 * k1 * (s2 - k3 * k30)) / (kk * s2);
      let c2OverK1 = 0;
      if (k2 !== 0) {
        // Evaluate the angle difference before dividing by k1. Subtracting two nearly equal arctangents
        // loses the shear for long along-wind modes.
        const denominator = s2 + k3 * k30;
        const tangent = (beta * k1 * s) / denominator;
        const angleOverK1 =
          denominator > 0 && Number.isFinite(tangent)
            ? ((tangent === 0 ? 1 : atan(tangent) / tangent) * beta * s) / denominator
            : (atan(k30 / s) - atan(k3 / s)) / k1;
        c2OverK1 = ((k2 * kk0) / (s2 * s)) * angleOverK1;
      }
      z1 = c1 - c2OverK1 * k2;
      z2 = (c1 * k2) / k1 + c2OverK1 * k1;
      z3 = kk0 / kk;
    }
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
