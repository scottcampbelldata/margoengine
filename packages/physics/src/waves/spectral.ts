// The sea's waves (SEA-01 of docs/physics-solvers.md): a third-generation spectral wave model, the energy balance of the
// WAM model (WAMDI Group 1988) as SWAN states it (Booij, Ris and Holthuijsen 1999), on a grid of the water, driven by the
// framework's wind. Wind seas grow with fetch and duration, swell runs out ahead of the storm at its group velocity and
// slowly decays, waves feel the bottom where the water is shallow, and the spectrum is published for the sea surface to
// synthesise (`WaveSpectrumField` of `@margoengine/math/fields`).
//
// Written from the SWAN Scientific and Technical Documentation (swanmodel.sourceforge.io, online_doc/swantech, read
// 2026-11-25, nodes 11, 12 and 14 to 19, 43, 47 and 48):
// - the energy balance dE/dt + div(c_g E) + d(c_theta E)/dtheta = S (eqs. 2.17 and 2.19; no currents, so action and
//   energy balance alike), the dispersion relation sigma^2 = g k tanh(k d), c_g = d sigma / d k;
// - wind input S_in = A + B E (eq. 2.33): the linear growth of Cavaleri and Malanotte-Rizzoli (1981), A = 1.5e-3 / (2 pi
//   g^2) (U* max(0, cos(theta - theta_w)))^4 H with the filter H = exp(-(sigma / sigma*_PM)^-4), sigma*_PM = 2 pi 0.13 g /
//   (28 U*) (eq. 2.37, Tolman 1992), and the exponential growth of Komen et al. (1984), B = max(0, 0.25 rho_a / rho_w (28
//   U* / c_ph cos(theta - theta_w) - 1)) sigma (eq. 2.38); U*^2 = C_D U10^2 with C_D = (0.55 + 2.97 U~ - 1.49 U~^2) 1e-3,
//   U~ = U10 / 31.5 m/s (eqs. 2.34 and 2.36);
// - whitecapping of Komen et al. (WAM Cycle 3), S = -Gamma sigma~ (k / k~) E, Gamma = 2.36e-5 (s~ / s~_PM)^4, s~ = k~
//   sqrt(E_tot), s~_PM = sqrt(3.02e-3), with the mean frequency and wavenumber of eqs. 2.46 to 2.49;
// - the quadruplet wave-wave interactions by the discrete interaction approximation of Hasselmann et al. (1985): the
//   quadruplet sigma, sigma(1 + lambda) at +11.48 degrees and sigma(1 - lambda) at -33.56 degrees and its mirror image,
//   lambda = 0.25, C_nl4 = 3e7, and the shallow-water factor R(k_p d) (eqs. 2.76 to 2.80);
// - bottom friction of JONSWAP (Hasselmann et al. 1973), S = -C_b sigma^2 / (g^2 sinh^2(k d)) E, C_b = 0.038 m^2/s^3
//   (eq. 2.60);
// - depth-induced breaking of Battjes and Janssen (1978), S = -alpha Q_b sigma~ / (beta^2 pi) E with H_max = 0.73 d and
//   (1 - Q_b) / ln Q_b = -(H_rms / H_max)^2 (eqs. 2.65 to 2.69);
// - the action limiter of Hersbach and Janssen (1999) as SWAN takes it: a change of at most 0.1 alpha_PM / (2 sigma k^3
//   c_g) in action a step, alpha_PM = 8.1e-3 (eq. 3.42).
//
// By default the wind input and dissipation are ST4 (Ardhuin et al. 2010, st4.ts) with its quadruplet constant C_nl4 =
// 2.5e7 and an f^-5 tail above 2.5 times the mean frequency; `physics: 'wam3'` keeps the WAM Cycle 3 terms above.
// Propagation in space is the third-order ULTIMATE QUICKEST scheme (Leonard 1979 and 1991, as the WAVEWATCH III 5.16 manual
// states it, eqs. 3.12 to 3.23), split by axis; first-order upwind spread fetch-limited growth too far downwind
// (KB-SEA-GROWTH1).
//
// Accepted differences: no garden-sprinkler correction, no currents (no Doppler shift, no frequency shift), no diffraction or reflection, no triads, the source terms
// integrated semi-implicitly in each cell (the decay implicitly, the growth and transfer explicitly) rather than WAM's
// implicit scheme, and a spectral range of its frequencies only (no parametric tail).

import type { Bed, FlowSample, Wind, WaveSpectrumField, WaveSpectrumSample } from '@margoengine/math/fields';
import { cos, exp, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { angleOf } from '../flight.js';
import { ST4, st4Rates, type SpectralCell } from './st4.js';
import { waveError } from './errors.js';
import {
  loadWaveTransport,
  type WaveTransportBuild,
  type WaveTransportKernel,
  type WaveTransportWorkCounts,
} from './transport-kernel.js';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  RateLevel,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';

/** The registry field of the waves: E(f, theta) per cell, m^2/(Hz rad), owned by {@link WaveSolver}. */
export const WAVE_SPECTRUM_FIELD: FieldDescriptor = {
  name: 'waveSpectrum',
  kind: 'uniformGrid',
  quantity: 'spectralDensity',
  unit: 'm^2/(Hz rad)',
  centring: 'cell',
};
/** The layout of a wave solver's regions: per cell (x fastest, then z), frequency-major spectra. */
export const WAVE_LAYOUT = 1;
/** Density of sea water, kg/m^3. */
export const SEA_WATER_DENSITY = 1025;
/** Density of fresh water, kg/m^3: a lake. */
export const FRESH_WATER_DENSITY = 1000;

const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;
const DEGREE = 0.017453292519943295;
const AIR_DENSITY = 1.225;
/** Kinematic viscosity of air at 15 C, m^2/s: Sutherland's law with the U.S. Standard Atmosphere (1976) constants over 1.225 kg/m^3. */
const AIR_VISCOSITY = 1.4607e-5;
/** Komen whitecapping. */
const C_DS = 2.36e-5;
const S_PM = 0.05495452665613635; // sqrt(3.02e-3)
/** Discrete interaction approximation. */
const LAMBDA = 0.25;
const C_NL4 = 3e7;
const ANGLE_PLUS = 11.48 * DEGREE;
const ANGLE_MINUS = 33.56 * DEGREE;
/** JONSWAP bottom friction, m^2/s^3. */
const C_BOTTOM = 0.038;
/** Battjes and Janssen. */
const BREAKER_INDEX = 0.73;
/** The limiter's share of the Phillips level, and the Phillips constant. */
const LIMITER = 0.1;
const ALPHA_PM = 8.1e-3;

/** The wavenumber of waves of frequency `f` Hz in water `depth` m deep under gravity `g`: sigma^2 = g k tanh(k d). */
export function wavenumber(f: number, depth: number, g = gravityMagnitude(DEFAULT_GRAVITY)): number {
  const sigma = TWO_PI * f,
    deep = (sigma * sigma) / g;
  if (!(depth < 1e6)) return deep;
  if (!(depth > 0)) return 0;
  // Newton on F(k) = g k tanh(k d) - sigma^2, from the larger of the deep and shallow wavenumbers, both at most the root
  // (tanh(kd) <= 1 and <= kd); F is increasing and convex there, so Newton converges.
  const shallow = sigma / pow(g * depth, 0.5);
  let k = deep > shallow ? deep : shallow;
  for (let i = 0; i < 60; i++) {
    const kd = k * depth,
      t = tanhOf(kd),
      f0 = g * k * t - sigma * sigma,
      df = g * t + g * kd * (1 - t * t),
      next = k - f0 / df;
    if (!(next > 0)) {
      k = k / 2;
      continue;
    }
    const change = next > k ? next - k : k - next;
    k = next;
    if (change <= 1e-15 * k) break;
  }
  return k;
}

/** The group velocity of waves of frequency `f` Hz in water `depth` m deep: 1/2 (1 + 2 k d / sinh 2 k d) sigma / k. */
export function groupVelocity(f: number, depth: number, g = gravityMagnitude(DEFAULT_GRAVITY)): number {
  const k = wavenumber(f, depth, g),
    sigma = TWO_PI * f;
  if (!(k > 0)) return 0;
  const kd = k * depth,
    factor = depth < 1e6 && kd < 20 ? 1 + (2 * kd) / sinhOf(2 * kd) : 1;
  return (0.5 * factor * sigma) / k;
}

function tanhOf(x: number): number {
  if (x > 20) return 1;
  const e = exp(-2 * x);
  return (1 - e) / (1 + e);
}

function sinhOf(x: number): number {
  return 0.5 * (exp(x) - exp(-x));
}

/** A JONSWAP sea: significant height, peak period and the direction it travels toward. */
export interface SeaState {
  /** Significant wave height, m. */
  height: number;
  /** Peak period, s. */
  period: number;
  /** Direction the waves travel toward, radians from +x toward +z. */
  direction: number;
  /** Peak enhancement gamma (default 3.3; 1 is a Pierson-Moskowitz sea, larger is a narrow swell). */
  peakedness?: number;
}

/**
 * The JONSWAP spectrum E(f) shape, alpha g^2 (2 pi)^-4 f^-5 exp(-5/4 (f_p / f)^4) gamma^r with r = exp(-(f - f_p)^2 /
 * (2 s^2 f_p^2)), s = 0.07 below the peak and 0.09 above (Hasselmann et al. 1973), times a cos^2 spread about the direction,
 * scaled to the height asked for, on the grid of `out`.
 */
export function jonswap(
  state: SeaState,
  out: WaveSpectrumSample,
  g = gravityMagnitude(DEFAULT_GRAVITY),
): WaveSpectrumSample {
  const { height, period, direction, peakedness = 3.3 } = state ?? {};
  if (
    !(
      height >= 0 &&
      period > 0 &&
      peakedness > 0 &&
      [height, period, direction, peakedness, g].every(Number.isFinite) &&
      g > 0
    )
  )
    throw waveError(
      'unsupported',
      'JONSWAP needs nonnegative height, positive period, peak enhancement and gravity, and finite direction; pass a resolved sea state in SI units.',
    );
  const { frequencies: fs, directions: ds, energy } = out ?? {};
  if (!(fs?.length && ds?.length && energy?.length === fs.length * ds.length && typeof energy.set === 'function'))
    throw waveError(
      'unsupported',
      'JONSWAP needs a nonempty frequency and direction grid and an energy word per bin; pass a matching spectrum buffer.',
    );
  let previous = 0;
  for (const frequency of fs) {
    if (!(frequency > previous && Number.isFinite(frequency)))
      throw waveError(
        'unsupported',
        'The JONSWAP frequencies must increase from positive finite hertz; fix the frequency grid.',
      );
    previous = frequency;
  }
  if (!ds.every(Number.isFinite))
    throw waveError('unsupported', 'JONSWAP directions must be finite radians; fix the direction grid.');
  const nf = fs.length,
    nd = ds.length,
    fp = 1 / period,
    dtheta = TWO_PI / nd;
  if (height === 0) {
    energy.fill(0);
    return out;
  }
  const candidate = new Float64Array(energy.length);
  let total = 0;
  for (let i = 0; i < nf; i++) {
    const f = fs[i]!,
      s = f <= fp ? 0.07 : 0.09,
      r = exp(-((f - fp) * (f - fp)) / (2 * s * s * fp * fp)),
      ef =
        ((g * g) / (TWO_PI * TWO_PI * TWO_PI * TWO_PI)) * pow(f, -5) * exp(-1.25 * pow(fp / f, 4)) * pow(peakedness, r),
      df = bandWidth(fs, i);
    for (let j = 0; j < nd; j++) {
      const c = cos(ds[j]! - direction),
        spread = c > 0 ? (2 / PI) * c * c : 0,
        e = ef * spread;
      candidate[i * nd + j] = e;
      total += e * df * dtheta;
    }
  }
  const scale = (height * height) / 16 / total;
  if (!(scale > 0 && Number.isFinite(scale)))
    throw waveError(
      'unsupported',
      'The JONSWAP peak or energy is unresolved; use a representable height and a frequency grid around the peak.',
    );
  for (let k = 0; k < candidate.length; k++) {
    candidate[k]! *= scale;
    if (!Number.isFinite(candidate[k]))
      throw waveError(
        'unsupported',
        'JONSWAP normalization exceeds the spectrum range; reduce the height or use a resolved grid.',
      );
  }
  energy.set(candidate);
  return out;
}

/** The width of frequency bin i of a log-spaced grid, Hz. */
export function bandWidth(fs: Float64Array, i: number): number {
  const n = fs.length;
  if (n === 1) return fs[0]!;
  const lo = i > 0 ? (fs[i]! + fs[i - 1]!) / 2 : fs[0]! - (fs[1]! - fs[0]!) / 2,
    hi = i < n - 1 ? (fs[i]! + fs[i + 1]!) / 2 : fs[n - 1]! + (fs[n - 1]! - fs[n - 2]!) / 2;
  return hi - lo;
}

/** The significant wave height of a spectrum, 4 sqrt(m0), m. */
export function significantHeight(spectrum: WaveSpectrumSample): number {
  const { frequencies: fs, directions: ds, energy } = spectrum,
    nd = ds.length,
    dtheta = TWO_PI / nd;
  let m0 = 0;
  for (let i = 0; i < fs.length; i++) {
    const df = bandWidth(fs, i);
    for (let j = 0; j < nd; j++) m0 += energy[i * nd + j]! * df * dtheta;
  }
  return 4 * pow(m0 > 0 ? m0 : 0, 0.5);
}

/** The peak frequency of a spectrum, Hz (of the frequency band with the most energy). */
export function peakFrequency(spectrum: WaveSpectrumSample): number {
  const { frequencies: fs, directions: ds, energy } = spectrum,
    nd = ds.length;
  let best = 0,
    at = fs[0]!;
  for (let i = 0; i < fs.length; i++) {
    let e = 0;
    for (let j = 0; j < nd; j++) e += energy[i * nd + j]!;
    if (e > best) {
      best = e;
      at = fs[i]!;
    }
  }
  return at;
}

/** Settings of a {@link WaveSolver}; each has a default. */
export interface WaveParams {
  /** Cells of the water's grid along x and z (default [32, 32]). */
  cells?: readonly [number, number];
  /** The edge of a cell, m (default 1000). */
  cellSize?: number;
  /** The grid's centre, [x, z] m from the solver's cell origin (default [0, 0]). */
  centre?: readonly [number, number];
  /** Still-water depth, m: a number everywhere, or a function of (x, z); 0 or less is land (default deep water). */
  depth?: number | ((x: number, z: number) => number);
  /** The terrain bed under the water; its depth is `waterLevel` minus the bed's elevation (instead of `depth`). */
  bed?: Bed;
  /** The water's surface height, y m (default 0). */
  waterLevel?: number;
  /** Metres per origin cell for shared wind and bed coordinates (default 4096). */
  originCellSize?: number;
  /** Density of the water, kg/m^3 (default 1025, the sea; 1000 for a lake). */
  density?: number;
  /** The wind over the water, sampled 10 m above it (default none: swell only). */
  wind?: Wind;
  /** Frequencies: lowest and highest, Hz, and how many, log-spaced (default 0.04 to 1 Hz in 34). */
  frequencies?: { min: number; max: number; count: number };
  /** Directions, evenly spread (default 24, 15 degrees apart). */
  directions?: number;
  /** A sea or swell coming in over the open edges of the grid, a JONSWAP state (default none). */
  swell?: SeaState;
  /** The sea at the start, everywhere on the water (default calm). */
  start?: SeaState;
  /** Seconds of sea time per second of world time (default 1). */
  timeScale?: number;
  /** The waves' own time step, s of sea time (default 60). */
  interval?: number;
  /** Seconds of sea time to run at the start, before the first world step, under the wind at time 0 (default 0). */
  warmUp?: number;
  /** Edges that wrap around to the opposite side: 'x', 'z' or both, for a sea that goes on the same way (default none). */
  periodic?: readonly ('x' | 'z')[];
  /**
   * The wind input and dissipation: 'st4', Ardhuin et al. (2010) with the WAVEWATCH III TEST471 constants (default), or
   * 'wam3', WAM Cycle 3 (Komen et al. 1984) as SWAN states it.
   */
  physics?: 'st4' | 'wam3';
}

function flowOffset(from: Cell, to: Cell, size: number): [number, number, number] {
  if (!(to?.length === 3 && to.every(Number.isSafeInteger)))
    throw waveError('unsupported', 'A wave input field needs three integer cell indices; give it a valid origin.');
  const offset: [number, number, number] = [
    (from[0] - to[0]) * size,
    (from[1] - to[1]) * size,
    (from[2] - to[2]) * size,
  ];
  if (!offset.every(Number.isFinite))
    throw waveError(
      'unsupported',
      'Wave input coordinates exceed numeric range; bring the input field into the wave grid cell.',
    );
  return offset;
}

function finiteWave(value: number): number {
  if (!Number.isFinite(value))
    throw waveError(
      'failed',
      'The wave step cannot represent its energy or flux; reduce the wind, wave height or interval, or refine the grid.',
    );
  return value;
}

/** Optional native transport configuration for a wave solver. */
export interface WaveSolverNativeOptions {
  /** Native participants including the caller. Default one. Use Node or an isolated browser worker for two or four. */
  readonly threads?: 1 | 2 | 4;
  /** Cancels loading and releases active helpers on abort. */
  readonly signal?: AbortSignal;
}

/**
 * The sea's waves: a spectral wave model on a grid of the water, a framework solver (`Solver`). Add it to a `PhysicsWorld`
 * with its {@link WaveParams}; read the spectrum anywhere through {@link WaveSolver.field}.
 */
export class WaveSolver implements Solver<WaveParams> {
  private readonly id: string;
  private host!: SolverHost;
  private initialized = false;
  private stepping = false;
  private disposed = false;
  private nativeBuild: WaveTransportBuild | undefined;
  private transport: WaveTransportKernel | undefined;
  private nativeWork: WaveTransportWorkCounts | undefined;
  private nx = 0;
  private nz = 0;
  private h = 0;
  private x0 = 0;
  private z0 = 0;
  private g = gravityMagnitude(DEFAULT_GRAVITY);
  private nf = 0;
  private nd = 0;
  private freqs!: Float64Array;
  private dirs!: Float64Array;
  private widths!: Float64Array;
  private depth!: Float64Array;
  private k!: Float64Array; // per cell and frequency
  private cg!: Float64Array; // per cell and frequency
  private settings!: { density: number; timeScale: number; interval: number; waterLevel: number };
  private wind: Wind | undefined;
  private swell: Float64Array | undefined;
  private wrapX = false;
  private wrapZ = false;
  private physics: 'st4' | 'wam3' = 'st4';
  private energy!: Region;
  private candidateEnergy!: Float64Array;
  private candidateFriction!: Float64Array;
  private originCellSize = 4096;
  private clock!: Region;
  /** Each cell's friction velocity u* in its last source step, m/s (derived each step; kept so a restore reports it too). */
  private friction!: Region;
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /** @param id The solver's id (default `'waves'`). */
  constructor(id = 'waves') {
    this.id = id;
  }

  /** Load native spatial transport before adding the solver to a world. Dispose it when the world finishes. */
  static async load(id = 'waves', native: WaveSolverNativeOptions = {}): Promise<WaveSolver> {
    const solver = new WaveSolver(id);
    solver.nativeBuild = await loadWaveTransport(native);
    return solver;
  }

  /** Native work of the last accepted advancing tick, or of warm-up until the first advancing tick. */
  readNativeWork(): WaveTransportWorkCounts | undefined {
    const work = this.nativeWork;
    return work && { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  [Symbol.dispose](): void {
    this.nativeBuild?.[Symbol.dispose]();
    this.disposed = true;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [{ field: WAVE_SPECTRUM_FIELD, access: 'write' }],
      rate: 0 as RateLevel,
      stableRate: () => 0 as RateLevel,
    };
  }

  init(host: SolverHost, params: WaveParams = {}): void {
    if (this.disposed) throw waveError('disposed', 'This wave solver was disposed; construct or load another solver.');
    if (this.initialized)
      throw waveError('attached', 'This wave solver already belongs to a world; construct or load another solver.');
    if (!params || typeof params !== 'object')
      throw waveError('unsupported', 'Pass wave solver settings as an object or omit them.');
    const {
      cells = [32, 32],
      cellSize = 1000,
      centre = [0, 0],
      depth = Infinity,
      bed,
      waterLevel = 0,
      originCellSize = 4096,
      density = SEA_WATER_DENSITY,
      wind,
      frequencies = { min: 0.04, max: 1, count: 34 },
      directions = 24,
      swell,
      start,
      timeScale = 1,
      interval = 60,
      warmUp = 0,
      periodic = [],
      physics = 'st4',
    } = params;
    if (physics !== 'st4' && physics !== 'wam3')
      throw waveError('unsupported', `A wave model's physics is 'st4' or 'wam3' (got ${physics}); pass one of them.`);
    this.physics = physics;
    if (!(cells?.length === 2 && cells.every((n) => Number.isInteger(n) && n >= 1 && n <= 1024)))
      throw waveError('unsupported', `A wave grid has 1 to 1024 whole cells along x and z (got ${cells}); pass two.`);
    for (const [name, value] of [
      ['cell size', cellSize],
      ['origin cell size', originCellSize],
      ['water density', density],
      ['time scale', timeScale],
      ['interval', interval],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw waveError('unsupported', `A wave solver's ${name} is a finite number above 0 (got ${value}); pass one.`);
    if (!(warmUp >= 0 && Number.isFinite(warmUp)))
      throw waveError('unsupported', `A warm-up is 0 or more seconds (got ${warmUp}); pass one.`);
    const { min, max, count } = frequencies ?? {};
    if (!(min > 0 && max > min && Number.isFinite(max) && Number.isInteger(count) && count >= 2 && count <= 128))
      throw waveError(
        'unsupported',
        `Wave frequencies need 0 < min < max and a whole count from 2 to 128 (got ${min}, ${max}, ${count}); pass them.`,
      );
    if (!(Number.isInteger(directions) && directions >= 4 && directions <= 180))
      throw waveError('unsupported', `A wave spectrum has 4 to 180 whole directions (got ${directions}); pass one.`);
    if (!(centre?.length === 2 && centre.every(Number.isFinite) && Number.isFinite(waterLevel)))
      throw waveError('unsupported', 'A wave grid needs a finite centre [x, z] and water level; pass them.');
    if (!Array.isArray(periodic))
      throw waveError('unsupported', 'Periodic edges are a list of x and z axes; pass a list.');
    for (const edge of periodic)
      if (edge !== 'x' && edge !== 'z')
        throw waveError('unsupported', `A periodic edge is 'x' or 'z' (got ${edge}); pass them.`);
    if (wind !== undefined && (wind?.medium !== 'air' || typeof wind?.sample !== 'function'))
      throw waveError('unsupported', 'Wave forcing needs a sampled air wind; pass a Wind field or omit it.');
    if (bed !== undefined && typeof bed?.sample !== 'function')
      throw waveError('unsupported', 'Wave bathymetry needs a bed sampler; pass a TerrainBed view or use depth.');
    this.host = host;
    this.originCellSize = originCellSize;
    this.wrapX = periodic.includes('x');
    this.wrapZ = periodic.includes('z');
    [this.nx, this.nz] = cells;
    this.h = cellSize;
    this.x0 = centre[0] - (this.nx * cellSize) / 2;
    this.z0 = centre[1] - (this.nz * cellSize) / 2;
    if (![this.x0, this.z0, this.x0 + this.nx * cellSize, this.z0 + this.nz * cellSize].every(Number.isFinite))
      throw waveError(
        'unsupported',
        'The wave grid extent is too large to represent; use finite local dimensions and centre.',
      );
    const [gx, gy, gz] = host.gravity;
    this.g = hypot(gx, gy, gz);
    if (!(this.g > 0 && Number.isFinite(this.g)))
      throw waveError('unsupported', 'Waves need finite positive gravity; set the world gravity.');
    this.nf = count;
    this.nd = directions;
    this.freqs = new Float64Array(count);
    for (let i = 0; i < count; i++) this.freqs[i] = min * pow(max / min, i / (count - 1));
    this.dirs = new Float64Array(directions);
    for (let j = 0; j < directions; j++) this.dirs[j] = (TWO_PI * j) / directions;
    this.widths = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const width = bandWidth(this.freqs, i);
      if (!(width > 0 && Number.isFinite(width)))
        throw waveError(
          'unsupported',
          'Wave frequency bins cannot be resolved; use a wider or smaller frequency range.',
        );
      this.widths[i] = width;
    }
    this.wind = wind;
    this.settings = { density, timeScale, interval, waterLevel };
    const n = this.nx * this.nz;
    this.depth = new Float64Array(n);
    this.k = new Float64Array(n * count);
    this.cg = new Float64Array(n * count);
    const [bedX, bedY, bedZ] = bed ? flowOffset(host.cell, bed.cell, originCellSize) : [0, 0, 0];
    for (let c = 0; c < this.nz; c++)
      for (let r = 0; r < this.nx; r++) {
        const at = r + this.nx * c,
          x = this.x0 + (r + 0.5) * cellSize,
          z = this.z0 + (c + 0.5) * cellSize,
          bedHeight = bed ? bed.sample(x + bedX, z + bedZ)?.elevation : undefined,
          d = bed ? waterLevel + bedY - (bedHeight ?? NaN) : typeof depth === 'function' ? depth(x, z) : depth;
        if (bed && !Number.isFinite(bedHeight))
          throw waveError(
            'unsupported',
            'The terrain bed returned an invalid height; return a finite elevation in metres.',
          );
        if (!(Number.isFinite(d) || d === Infinity))
          throw waveError('unsupported', `The water's depth at (${x}, ${z}) is not a number; pass finite metres.`);
        this.depth[at] = d;
        for (let i = 0; i < count; i++) {
          this.k[at * count + i] = d > 0 ? wavenumber(this.freqs[i]!, d, this.g) : 0;
          this.cg[at * count + i] = d > 0 ? groupVelocity(this.freqs[i]!, d, this.g) : 0;
          if (
            d > 0 &&
            !(
              this.k[at * count + i]! > 0 &&
              this.cg[at * count + i]! > 0 &&
              Number.isFinite(this.k[at * count + i]) &&
              Number.isFinite(this.cg[at * count + i])
            )
          )
            throw waveError(
              'unsupported',
              'The wave dispersion is outside numeric range; pass resolved frequency, depth and gravity.',
            );
        }
      }
    const per = count * directions;
    if (n * per * Float64Array.BYTES_PER_ELEMENT >= 0x100000000) {
      throw waveError(
        'unsupported',
        'The spectrum exceeds the addressable world memory; reduce the grid or the spectral bins.',
      );
    }
    this.energy = host.allocate('spectrum', n * per * 8, 'f64', WAVE_LAYOUT);
    this.clock = host.allocate('clock', 16, 'f64', WAVE_LAYOUT);
    this.friction = host.allocate('friction', n * 8, 'f64', WAVE_LAYOUT);
    this.candidateEnergy = new Float64Array(n * per);
    this.candidateFriction = new Float64Array(n);
    const blank = (): WaveSpectrumSample => ({
      frequencies: this.freqs,
      directions: this.dirs,
      energy: new Float64Array(per),
      depth: Infinity,
      density,
    });
    this.swell = swell === undefined ? undefined : jonswap(swell, blank(), this.g).energy;
    if (start !== undefined) {
      const e = jonswap(start, blank(), this.g).energy,
        words = this.words();
      for (let c = 0; c < n; c++) if (this.depth[c]! > 0) words.set(e, c * per);
    }
    this.transport = this.nativeBuild?.bind({
      nx: this.nx,
      nz: this.nz,
      nf: count,
      nd: directions,
      spacing: cellSize,
      depth: this.depth,
      groupVelocity: this.cg,
      swell: this.swell,
      directionX: Float64Array.from(this.dirs, cos),
      directionZ: Float64Array.from(this.dirs, sin),
      wrapX: this.wrapX,
      wrapZ: this.wrapZ,
    });
    if (warmUp > 0) {
      const steps = Math.ceil(warmUp / interval);
      if (!Number.isSafeInteger(steps))
        throw waveError(
          'unsupported',
          'The warm-up has too many intervals to represent; shorten it or increase the interval.',
        );
      this.candidateEnergy.set(this.words());
      for (let s = 0; s < steps; s++) this.advance(warmUp / steps, 0, host.cell);
      this.acceptSpectrum();
    }
    this.initialized = true;
  }

  private checkInitialized(): void {
    if (this.disposed) throw waveError('disposed', 'This wave solver was disposed; construct or load another solver.');
    if (!this.initialized)
      throw waveError('state', 'The wave grid is not initialized; add the solver to a PhysicsWorld first.');
  }

  private clockWords(): Float64Array {
    return regionWords(this.host.memory, this.clock) as Float64Array;
  }

  private frictionWords(): Float64Array {
    return regionWords(this.host.memory, this.friction) as Float64Array;
  }

  private acceptSpectrum(): void {
    this.words().set(this.candidateEnergy);
    this.frictionWords().set(this.candidateFriction);
    if (this.transport) this.nativeWork = this.transport.workCounts();
  }

  private words(): Float64Array {
    return regionWords(this.host.memory, this.energy) as Float64Array;
  }

  step(context: StepContext, dt: number): void {
    this.checkInitialized();
    if (this.stepping)
      throw waveError(
        'state',
        'The wave step is already running; sample the accepted spectrum without advancing again.',
      );
    if (!(dt >= 0 && Number.isFinite(dt)))
      throw waveError('unsupported', 'A wave step needs finite nonnegative seconds; advance with the world time step.');
    this.stepping = true;
    try {
      const { interval, timeScale } = this.settings;
      let remaining = this.clockWords()[0]! + dt * timeScale,
        elapsed = this.clockWords()[1]!;
      if (!Number.isFinite(remaining))
        throw waveError('unsupported', 'The wave time exceeds numeric range; reduce the time scale or frame duration.');
      if (remaining >= interval) {
        this.candidateEnergy.set(this.words());
        this.candidateFriction.set(this.frictionWords());
        this.transport?.resetWork();
        while (remaining >= interval) {
          const next = remaining - interval,
            nextElapsed = elapsed + interval;
          if (!(next < remaining && nextElapsed > elapsed && Number.isFinite(nextElapsed)))
            throw waveError(
              'failed',
              'The wave clock cannot resolve another interval; reduce the time scale or start a new sea.',
            );
          this.advance(interval, elapsed / timeScale, context.cell);
          remaining = next;
          elapsed = nextElapsed;
        }
        this.acceptSpectrum();
      }
      this.clockWords().set([remaining, elapsed]);
    } finally {
      this.stepping = false;
    }
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: WAVE_SPECTRUM_FIELD.name, region: this.energy, tick, cell: this.host.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.energy];
  }

  extraState(): readonly Region[] {
    return [this.clock, this.friction];
  }

  /** Seconds of sea time simulated since the start (after any warm-up). */
  get time(): number {
    this.checkInitialized();
    return this.clockWords()[1]!;
  }

  /** The grid: cells along x and z, the cell edge and the corner it starts at, [x, z]. */
  get grid(): { cells: [number, number]; cellSize: number; origin: [number, number] } {
    return { cells: [this.nx, this.nz], cellSize: this.h, origin: [this.x0, this.z0] };
  }

  /** The waves as the framework's `WaveSpectrumField`: the spectrum of the cell under (x, z). */
  get field(): WaveSpectrumField {
    return {
      cell: this.host?.cell ?? [0, 0, 0],
      sample: (x: number, z: number, out?: WaveSpectrumSample) => this.sample(x, z, out),
    };
  }

  /** The spectrum of the cell under (x, z), m^2/(Hz rad); outside the grid, the nearest edge cell's. */
  sample(x: number, z: number, out?: WaveSpectrumSample): WaveSpectrumSample {
    const at = this.indexAt(x, z),
      per = this.nf * this.nd;
    if (
      out &&
      !(
        out.energy instanceof Float64Array &&
        out.energy.length === per &&
        out.frequencies?.length === this.nf &&
        out.directions?.length === this.nd
      )
    )
      throw waveError(
        'unsupported',
        'The output spectrum does not match the wave grid; supply a matching buffer or omit it.',
      );
    const s = out ?? {
      frequencies: this.freqs,
      directions: this.dirs,
      energy: new Float64Array(per),
      depth: 0,
      density: this.settings.density,
    };
    s.energy.set(this.words().subarray(at * per, (at + 1) * per));
    s.depth = this.depth[at]!;
    s.density = this.settings.density;
    return s;
  }

  /** The significant wave height at (x, z), m. */
  /**
   * The wind's friction velocity u* over the water at (x, z) in the last step, m/s: with ST4 the waves' own roughness sets it
   * (young, steep seas drag harder), with WAM Cycle 3 the drag fit of U10. The stress on the sea is rho_a u*^2; 0 without wind.
   */
  frictionVelocity(x: number, z: number): number {
    const index = this.indexAt(x, z);
    return this.frictionWords()[index]!;
  }

  private indexAt(x: number, z: number): number {
    this.checkInitialized();
    if (!(Number.isFinite(x) && Number.isFinite(z)))
      throw waveError('unsupported', 'A wave sample needs finite local metres; pass finite x and z in the wave cell.');
    const r = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.h))),
      c = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.h)));
    return r + this.nx * c;
  }

  significantHeight(x: number, z: number): number {
    return significantHeight(this.sample(x, z));
  }

  /** The peak period at (x, z), s. */
  peakPeriod(x: number, z: number): number {
    return 1 / peakFrequency(this.sample(x, z));
  }

  /** One step of `dt` seconds of sea time, at world time `time` (for the wind). */
  private advance(dt: number, time: number, cell: Cell): void {
    this.propagate(dt);
    this.sources(dt, time, cell);
  }

  /**
   * Propagation in space by ULTIMATE QUICKEST fluxes of c_g E across cell faces (in substeps that keep the Courant number
   * of every bin at most 1/2), with refraction in direction where the depth changes, waves turning toward shallower water.
   */
  private propagate(dt: number): void {
    const { nx, nz, nf, nd, h } = this,
      per = nf * nd,
      words = this.candidateEnergy;
    let fastest = 0;
    for (let k = 0; k < this.cg.length; k++) if (this.cg[k]! > fastest) fastest = this.cg[k]!;
    const steps = Math.max(1, Math.ceil((2 * fastest * dt) / h));
    if (!Number.isSafeInteger(steps))
      throw waveError(
        'failed',
        'Wave transport needs too many Courant substeps to represent; shorten its interval or resolve the grid at a larger spacing.',
      );
    const sub = dt / steps,
      next = new Float64Array(words.length);
    for (let s = 0; s < steps; s++) {
      // Space: ULTIMATE QUICKEST along x and along z in turn, alternating which goes first.
      if (s % 2 === 0) {
        this.advect(words, 'x', sub);
        this.advect(words, 'z', sub);
      } else {
        this.advect(words, 'z', sub);
        this.advect(words, 'x', sub);
      }
      next.set(words);
      // Refraction: c_theta = -(1/k) (d sigma / d d) (d d / d m), m across the wave's direction.
      for (let c = 0; c < nz; c++)
        for (let r = 0; r < nx; r++) {
          const at = r + nx * c,
            d = this.depth[at]!;
          if (!(d > 0) || !(d < 1e6)) continue;
          const dx = (this.depthAt(r + 1, c, d) - this.depthAt(r - 1, c, d)) / (2 * h),
            dz = (this.depthAt(r, c + 1, d) - this.depthAt(r, c - 1, d)) / (2 * h);
          if (dx === 0 && dz === 0) continue;
          const dtheta = TWO_PI / nd;
          for (let i = 0; i < nf; i++) {
            const kk = this.k[at * nf + i]!,
              sigma = TWO_PI * this.freqs[i]!,
              kd = kk * d;
            if (!(kk > 0) || kd > 20) continue;
            const dsdd = (kk * sigma) / sinhOf(2 * kd);
            for (let j = 0; j < nd; j++) {
              const theta = this.dirs[j]!,
                across = -sin(theta) * dx + cos(theta) * dz,
                ctheta = -(dsdd / kk) * across,
                from = ctheta > 0 ? (j - 1 + nd) % nd : (j + 1) % nd,
                speed = ctheta < 0 ? -ctheta : ctheta,
                bin = i * nd + j;
              next[at * per + bin]! +=
                (sub / dtheta) * speed * (words[at * per + i * nd + from]! - words[at * per + bin]!);
            }
          }
        }
      for (let k = 0; k < next.length; k++) {
        const value = finiteWave(next[k]!);
        words[k] = value > 0 ? value : 0;
      }
    }
  }

  /**
   * One step of `dt` of propagation along `axis` by the ULTIMATE QUICKEST scheme (Leonard 1979 and 1991, as the WAVEWATCH III
   * manual states it, eqs. 3.12 to 3.23): each face's value from the upstream cells and the upstream curvature, third order
   * in space and time, limited so it makes no new extremum; first-order upwind at a face beside land, an open edge or a
   * stencil cell beyond either. Waves entering over an open edge carry the open sea's swell.
   */
  private advect(words: Float64Array, axis: 'x' | 'z', dt: number): void {
    if (this.transport) {
      this.transport.advect(words, axis, dt);
      return;
    }
    const { nx, nz, nf, nd, h } = this,
      per = nf * nd,
      along = axis === 'x' ? nx : nz,
      across = axis === 'x' ? nz : nx,
      wrap = axis === 'x' ? this.wrapX : this.wrapZ,
      before = words.slice(),
      // Cell index of position p along the axis at position q across it, or -1 beyond an edge that does not wrap.
      cellAt = (p: number, q: number): number => {
        if (wrap) p = ((p % along) + along) % along;
        else if (p < 0 || p >= along) return -1;
        return axis === 'x' ? p + nx * q : q + nx * p;
      },
      wet = (cell: number): boolean => cell >= 0 && this.depth[cell]! > 0,
      // A cell's value of a bin: 0 on land, the open sea's swell beyond an open edge.
      value = (cell: number, bin: number): number =>
        cell >= 0 ? (this.depth[cell]! > 0 ? before[cell * per + bin]! : 0) : this.swell ? this.swell[bin]! : 0,
      flux = new Float64Array(along + 1);
    for (let q = 0; q < across; q++)
      for (let i = 0; i < nf; i++)
        for (let j = 0; j < nd; j++) {
          const bin = i * nd + j,
            direction = axis === 'x' ? cos(this.dirs[j]!) : sin(this.dirs[j]!);
          // The flux through face p, between cells p - 1 and p.
          for (let p = 0; p <= along; p++) {
            const left = cellAt(p - 1, q),
              right = cellAt(p, q),
              lw = wet(left),
              rw = wet(right);
            if (!lw && !rw) {
              flux[p] = 0;
              continue;
            }
            const speed =
                (lw && rw
                  ? 0.5 * (this.cg[left * nf + i]! + this.cg[right * nf + i]!)
                  : this.cg[(lw ? left : right) * nf + i]!) * direction,
              courant = (speed * dt) / h,
              upstream = speed >= 0 ? left : right,
              downstream = speed >= 0 ? right : left,
              far = speed >= 0 ? cellAt(p - 2, q) : cellAt(p + 1, q),
              nc = value(upstream, bin);
            // First order beside land or an open edge, or where the stencil reaches past one.
            if (!lw || !rw || !wet(far)) {
              flux[p] = finiteWave(speed * nc);
              continue;
            }
            const nu = value(far, bin),
              nd2 = value(downstream, bin),
              curvature = nu - 2 * nc + nd2,
              c = courant < 0 ? -courant : courant;
            let face = 0.5 * ((1 + c) * nc + (1 - c) * nd2) - ((1 - c * c) / 6) * curvature;
            // The ULTIMATE limiter in normalised variables: monotone data keep the face between N_c and min(1, N_c / C).
            const span = nd2 - nu;
            if (span !== 0) {
              const tc = (nc - nu) / span;
              if (tc >= 0 && tc <= 1) {
                let tb = (face - nu) / span;
                const top = c > 0 && tc / c < 1 ? tc / c : 1;
                if (tb < tc) tb = tc;
                if (tb > top) tb = top;
                face = nu + tb * span;
              } else face = nc;
            } else face = nc;
            flux[p] = finiteWave(speed * face);
          }
          for (let p = 0; p < along; p++) {
            const cell = cellAt(p, q);
            if (!wet(cell)) continue;
            const updated = finiteWave(before[cell * per + bin]! + (dt / h) * (flux[p]! - flux[p + 1]!));
            words[cell * per + bin] = updated > 0 ? updated : 0;
          }
        }
  }

  private depthAt(r: number, c: number, fallback: number): number {
    if (this.wrapX) r = (r + this.nx) % this.nx;
    if (this.wrapZ) c = (c + this.nz) % this.nz;
    if (r < 0 || c < 0 || r >= this.nx || c >= this.nz) return fallback;
    const d = this.depth[r + this.nx * c]!;
    return d > 0 ? d : 0;
  }

  /** The source terms in every wet cell, integrated over `dt`. */
  private sources(dt: number, time: number, cell: Cell): void {
    const { nx, nz, nf, nd, g } = this,
      per = nf * nd,
      words = this.candidateEnergy,
      eSigma = new Float64Array(per),
      grow = new Float64Array(per),
      decay = new Float64Array(per),
      transfer = new Float64Array(per),
      energyF = new Float64Array(per),
      inputRate = new Float64Array(per),
      sinkRate = new Float64Array(per),
      dtheta = TWO_PI / nd,
      rhoRatio = AIR_DENSITY / this.settings.density,
      windOffset = this.wind ? flowOffset(cell, this.wind.cell, this.originCellSize) : undefined;
    for (let c = 0; c < nz; c++)
      for (let r = 0; r < nx; r++) {
        const at = r + nx * c,
          d = this.depth[at]!;
        if (!(d > 0)) continue;
        // E(sigma, theta) = E(f, theta) / 2 pi.
        for (let b = 0; b < per; b++) eSigma[b] = words[at * per + b]! / TWO_PI;
        // Integral parameters: E_tot, the mean frequency for whitecapping and breaking, the mean wavenumber.
        let total = 0,
          inverseSigma = 0,
          inverseRootK = 0,
          meanSigma = 0;
        for (let i = 0; i < nf; i++) {
          const sigma = TWO_PI * this.freqs[i]!,
            dsigma = TWO_PI * this.widths[i]!,
            kk = this.k[at * nf + i]!;
          for (let j = 0; j < nd; j++) {
            const e = eSigma[i * nd + j]! * dsigma * dtheta;
            total += e;
            inverseSigma += e / sigma;
            inverseRootK += e / pow(kk, 0.5);
            meanSigma += e * sigma;
          }
        }
        // The wind 10 m above the water.
        let u10 = 0,
          windDirection = 0;
        if (this.wind && windOffset) {
          const x = this.x0 + (r + 0.5) * this.h + windOffset[0],
            z = this.z0 + (c + 0.5) * this.h + windOffset[2],
            y = this.settings.waterLevel + 10 + windOffset[1];
          if (![x, y, z, time].every(Number.isFinite))
            throw waveError(
              'unsupported',
              'The wind sample coordinates exceed numeric range; place the field closer to the wave grid.',
            );
          const v = this.wind.sample(x, y, z, time, this.flow)?.velocity;
          if (!(v?.length === 3 && v.every(Number.isFinite)))
            throw waveError(
              'unsupported',
              'The wind returned invalid velocity; supply three finite components in m/s.',
            );
          u10 = finiteWave(hypot(v[0], v[2]));
          windDirection = u10 > 0 ? angleTo(v[2], v[0]) : 0;
        }
        const st4 = this.physics === 'st4';
        let ustar = 0,
          cutoff = nf - 1;
        if (st4) {
          for (let b = 0; b < per; b++) energyF[b] = words[at * per + b]!;
          ({ ustar, cutoff } = st4Rates(
            energyF,
            this.cellOf(at, d, rhoRatio),
            u10,
            windDirection,
            inputRate,
            sinkRate,
          ));
        } else {
          const ut = u10 / 31.5,
            drag = (0.55 + 2.97 * ut - 1.49 * ut * ut) * 1e-3;
          ustar = u10 * pow(drag > 0 ? drag : 0, 0.5);
        }
        this.candidateFriction[at] = finiteWave(ustar);
        const sigmaPM = (TWO_PI * 0.13 * g) / (28 * (ustar > 0 ? ustar : 1e-9));
        let gamma = 0,
          meanS = 0,
          meanK = 0,
          breaking = 0;
        if (total > 0) {
          meanS = total / inverseSigma;
          meanK = pow(total / inverseRootK, 2);
          const steep = meanK * pow(total, 0.5);
          gamma = C_DS * pow(steep / S_PM, 4);
          // Battjes and Janssen: the breaking fraction from (1 - Q) / ln Q = -(H_rms / H_max)^2.
          if (d < 1e6) {
            const hmax = BREAKER_INDEX * d,
              beta = pow(8 * total, 0.5) / hmax;
            if (beta > 0.2) {
              const q = breakingFraction(beta);
              breaking = (q * (meanSigma / total)) / (beta * beta * PI);
            }
          }
        }
        // The shallow-water factor of the quadruplets at the mean wavenumber's peak, k_p = 0.75 k~.
        const kp = 0.75 * meanK,
          kpd = d < 1e6 ? (kp * d > 0.5 ? kp * d : 0.5) : 1e9,
          shallow = kpd < 1e8 ? 1 + (5.5 / kpd) * (1 - (5 / 6) * kpd) * exp(-1.25 * kpd) : 1;
        transfer.fill(0);
        if (total > 0) this.quadruplets(eSigma, transfer, shallow);
        for (let i = 0; i < nf; i++) {
          const sigma = TWO_PI * this.freqs[i]!,
            kk = this.k[at * nf + i]!,
            cph = sigma / kk,
            kd = kk * d,
            friction = d < 1e6 && kd < 20 ? (C_BOTTOM * sigma * sigma) / (g * g * sinhOf(kd) * sinhOf(kd)) : 0,
            filter = ustar > 0 ? exp(-pow(sigma / sigmaPM, -4)) : 0;
          for (let j = 0; j < nd; j++) {
            const b = i * nd + j,
              along = cos(this.dirs[j]! - windDirection),
              lin = ustar > 0 && along > 0 ? (1.5e-3 / (TWO_PI * g * g)) * pow(ustar * along, 4) * filter : 0,
              exponential = ustar > 0 ? 0.25 * rhoRatio * ((28 * ustar) / cph) * along - 0.25 * rhoRatio : 0;
            grow[b] = lin;
            if (st4) {
              grow[b]! += inputRate[b]! * eSigma[b]!;
              decay[b] = sinkRate[b]! - friction - breaking;
              continue;
            }
            // Gamma = C_ds ((1 - delta) + delta k / k~) (s~ / s~_PM)^p with delta = 1, SWAN's default since 40.91A.
            const relative = kk / (meanK > 0 ? meanK : kk);
            decay[b] = -(gamma * relative * meanS * relative) - friction - breaking;
            // The positive part of B grows; the rest of the energy-proportional terms decay, implicitly.
            const bRate = exponential > 0 ? exponential * sigma : 0;
            grow[b]! += bRate * eSigma[b]!;
          }
        }
        // E_new = (E + dt (A + B E + S_nl)) / (1 - dt D), D <= 0; then the change limited in action.
        for (let i = 0; i < nf; i++) {
          const kk = this.k[at * nf + i]!,
            cgi = this.cg[at * nf + i]!,
            // At most 0.1 alpha_PM / (2 sigma k^3 c_g) of action, so sigma times that of energy, E(sigma, theta).
            limit = kk > 0 && cgi > 0 ? (LIMITER * ALPHA_PM) / (2 * kk * kk * kk * cgi) : 0;
          for (let j = 0; j < nd; j++) {
            const b = i * nd + j,
              e = eSigma[b]!,
              numerator = finiteWave(e + dt * (grow[b]! + transfer[b]!)),
              denominator = finiteWave(1 - dt * decay[b]!),
              updated = finiteWave(numerator / denominator);
            let change = updated - e;
            if (change > limit) change = limit;
            else if (change < -limit) change = -limit;
            const value = e + change;
            words[at * per + b] = finiteWave((value > 0 ? value : 0) * TWO_PI);
          }
        }
        // ST4 integrates up to 2.5 times the mean frequency; above it the spectrum is the f^-5 tail (WAVEWATCH III eq. 2.17).
        if (st4)
          for (let i = cutoff + 1; i < nf; i++) {
            const decline = pow(this.freqs[i]! / this.freqs[cutoff]!, -5);
            for (let j = 0; j < nd; j++)
              words[at * per + i * nd + j] = finiteWave(words[at * per + cutoff * nd + j]! * decline);
          }
      }
  }

  /** The spectral grid and water of cell `at` for the ST4 source terms. */
  private cellOf(at: number, depth: number, densityRatio: number): SpectralCell {
    const nf = this.nf;
    return {
      nf,
      nd: this.nd,
      freqs: this.freqs,
      widths: this.widths,
      dirs: this.dirs,
      k: this.k.subarray(at * nf, (at + 1) * nf),
      cg: this.cg.subarray(at * nf, (at + 1) * nf),
      depth,
      g: this.g,
      densityRatio,
      airViscosity: AIR_VISCOSITY,
    };
  }

  /**
   * The discrete interaction approximation into `out` (E(sigma, theta) per second): for each bin and each of the two mirror
   * quadruplets, X = C_nl4 (2 pi)^2 g^-4 f^11 [E^2 (E+ / (1 + l)^4 + E- / (1 - l)^4) - 2 E E+ E- / (1 - l^2)^4] times the
   * shallow-water factor, taken from the bin twice and given once to each of its partners, spread over the bins around them
   * so action and energy are both kept.
   */
  private quadruplets(e: Float64Array, out: Float64Array, shallow: number): void {
    const { nf, nd, g } = this,
      dtheta = TWO_PI / nd,
      ratio = this.freqs[1]! / this.freqs[0]!,
      logRatio = ln(ratio),
      scale = ((this.physics === 'st4' ? ST4.nonlinear : C_NL4) * TWO_PI * TWO_PI) / (g * g * g * g),
      up = pow(1 + LAMBDA, 4),
      down = pow(1 - LAMBDA, 4),
      both = pow(1 - LAMBDA * LAMBDA, 4),
      // Where sigma (1 + l) and sigma (1 - l) fall on the frequency grid, in bins.
      shiftUp = ln(1 + LAMBDA) / logRatio,
      shiftDown = ln(1 - LAMBDA) / logRatio,
      weights: [number, number, number, number] = [0, 0, 0, 0],
      bins: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < nf; i++) {
      const f = this.freqs[i]!,
        factor = scale * pow(f, 11) * shallow;
      for (let j = 0; j < nd; j++) {
        const here = e[i * nd + j]!;
        if (!(here > 0)) continue;
        for (const mirror of [1, -1]) {
          const plus = this.spot(i + shiftUp, j + (mirror * ANGLE_PLUS) / dtheta, weights, bins),
            ePlus = plus ? weighted(e, weights, bins) : 0,
            minus = this.spot(i + shiftDown, j - (mirror * ANGLE_MINUS) / dtheta, weights, bins),
            eMinus = minus ? weighted(e, weights, bins) : 0,
            x = factor * (here * here * (ePlus / up + eMinus / down) - (2 * here * ePlus * eMinus) / both);
          out[i * nd + j]! -= 2 * x;
          if (this.spot(i + shiftUp, j + (mirror * ANGLE_PLUS) / dtheta, weights, bins)) spread(out, weights, bins, x);
          if (this.spot(i + shiftDown, j - (mirror * ANGLE_MINUS) / dtheta, weights, bins))
            spread(out, weights, bins, x);
        }
      }
    }
  }

  /**
   * The four bins around fractional bin (fi, fj) and their bilinear weights; false when the point lies beyond the frequency
   * grid (its energy is lost off the grid's end, or taken as none there).
   */
  private spot(
    fi: number,
    fj: number,
    weights: [number, number, number, number],
    bins: [number, number, number, number],
  ): boolean {
    if (fi < 0 || fi > this.nf - 1) return false;
    const i0 = Math.min(this.nf - 2, Math.floor(fi)),
      a = fi - i0,
      j0 = Math.floor(fj),
      b = fj - j0,
      j0w = ((j0 % this.nd) + this.nd) % this.nd,
      j1w = (j0w + 1) % this.nd;
    weights[0] = (1 - a) * (1 - b);
    weights[1] = (1 - a) * b;
    weights[2] = a * (1 - b);
    weights[3] = a * b;
    bins[0] = i0 * this.nd + j0w;
    bins[1] = i0 * this.nd + j1w;
    bins[2] = (i0 + 1) * this.nd + j0w;
    bins[3] = (i0 + 1) * this.nd + j1w;
    return true;
  }
}

function weighted(e: Float64Array, w: readonly number[], bins: readonly number[]): number {
  return w[0]! * e[bins[0]!]! + w[1]! * e[bins[1]!]! + w[2]! * e[bins[2]!]! + w[3]! * e[bins[3]!]!;
}

/** Adds `x` of density at a point spread over its four bins by their weights. */
function spread(out: Float64Array, w: readonly number[], bins: readonly number[], x: number): void {
  for (let k = 0; k < 4; k++) out[bins[k]!]! += w[k]! * x;
}

/** The Battjes-Janssen breaking fraction Q for beta = H_rms / H_max: (1 - Q) / ln Q = -beta^2, by bisection on (0, 1). */
function breakingFraction(beta: number): number {
  if (beta >= 1) return 1;
  const target = -beta * beta;
  let lo = 1e-300,
    hi = 1 - 1e-15;
  // (1 - Q) / ln Q falls from 0 at Q -> 0 to -1 at Q -> 1.
  for (let i = 0; i < 200; i++) {
    const q = 0.5 * (lo + hi),
      value = (1 - q) / ln(q);
    if (value > target) lo = q;
    else hi = q;
  }
  return 0.5 * (lo + hi);
}

/** The direction, radians from +x toward +z, of the vector (x, z) given as (z, x). */
function angleTo(z: number, x: number): number {
  const a = angleOf(z < 0 ? -z : z, x < 0 ? -x : x),
    quadrant = x < 0 ? PI - a : a;
  return z < 0 ? -quadrant : quadrant;
}
