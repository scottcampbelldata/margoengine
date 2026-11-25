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
// Accepted differences: first-order upwind propagation in space (diffusive; no garden-sprinkler correction needed at this
// order), no currents (no Doppler shift, no frequency shift), no diffraction or reflection, no triads, the source terms
// integrated semi-implicitly in each cell (the decay implicitly, the growth and transfer explicitly) rather than WAM's
// implicit scheme, and a spectral range of its frequencies only (no parametric tail).

import type { Bed, FlowSample, Wind, WaveSpectrumField, WaveSpectrumSample } from '@margoengine/math/fields';
import { cos, exp, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { angleOf } from '../flight.js';
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
  const { height, period, direction, peakedness = 3.3 } = state,
    { frequencies: fs, directions: ds, energy } = out,
    nf = fs.length,
    nd = ds.length,
    fp = 1 / period,
    dtheta = TWO_PI / nd;
  energy.fill(0);
  if (!(height > 0)) return out;
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
      energy[i * nd + j] = e;
      total += e * df * dtheta;
    }
  }
  const scale = (height * height) / 16 / total;
  for (let k = 0; k < energy.length; k++) energy[k]! *= scale;
  return out;
}

/** The width of frequency bin i of a log-spaced grid, Hz. */
function bandWidth(fs: Float64Array, i: number): number {
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
}

const ORIGIN: Cell = [0, 0, 0];

/**
 * The sea's waves: a spectral wave model on a grid of the water, a framework solver (`Solver`). Add it to a `PhysicsWorld`
 * with its {@link WaveParams}; read the spectrum anywhere through {@link WaveSolver.field}.
 */
export class WaveSolver implements Solver<WaveParams> {
  private readonly id: string;
  private host!: SolverHost;
  private cell: Cell = ORIGIN;
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
  private energy!: Region;
  private clock!: Region;
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /** @param id The solver's id (default `'waves'`). */
  constructor(id = 'waves') {
    this.id = id;
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
    const {
      cells = [32, 32],
      cellSize = 1000,
      centre = [0, 0],
      depth = Infinity,
      bed,
      waterLevel = 0,
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
    } = params;
    if (!(cells.length === 2 && cells.every((n) => Number.isInteger(n) && n >= 1 && n <= 1024)))
      throw new RangeError(`A wave grid has 1 to 1024 whole cells along x and z (got ${cells}); pass two.`);
    for (const [name, value] of [
      ['cell size', cellSize],
      ['water density', density],
      ['time scale', timeScale],
      ['interval', interval],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw new RangeError(`A wave solver's ${name} is a finite number above 0 (got ${value}); pass one.`);
    if (!(warmUp >= 0 && Number.isFinite(warmUp)))
      throw new RangeError(`A warm-up is 0 or more seconds (got ${warmUp}); pass one.`);
    const { min, max, count } = frequencies;
    if (!(min > 0 && max > min && Number.isFinite(max) && Number.isInteger(count) && count >= 2 && count <= 128))
      throw new RangeError(
        `Wave frequencies need 0 < min < max and a whole count from 2 to 128 (got ${min}, ${max}, ${count}); pass them.`,
      );
    if (!(Number.isInteger(directions) && directions >= 4 && directions <= 180))
      throw new RangeError(`A wave spectrum has 4 to 180 whole directions (got ${directions}); pass one.`);
    if (!(centre.length === 2 && centre.every(Number.isFinite) && Number.isFinite(waterLevel)))
      throw new RangeError('A wave grid needs a finite centre [x, z] and water level; pass them.');
    for (const edge of periodic)
      if (edge !== 'x' && edge !== 'z') throw new RangeError(`A periodic edge is 'x' or 'z' (got ${edge}); pass them.`);
    this.wrapX = periodic.includes('x');
    this.wrapZ = periodic.includes('z');
    this.host = host;
    [this.nx, this.nz] = cells;
    this.h = cellSize;
    this.x0 = centre[0] - (this.nx * cellSize) / 2;
    this.z0 = centre[1] - (this.nz * cellSize) / 2;
    const [gx, gy, gz] = host.gravity;
    this.g = hypot(gx, gy, gz);
    if (!(this.g > 0)) throw new RangeError('Waves need gravity; give the world a gravity above 0.');
    this.nf = count;
    this.nd = directions;
    this.freqs = new Float64Array(count);
    for (let i = 0; i < count; i++) this.freqs[i] = min * pow(max / min, i / (count - 1));
    this.dirs = new Float64Array(directions);
    for (let j = 0; j < directions; j++) this.dirs[j] = (TWO_PI * j) / directions;
    this.widths = new Float64Array(count);
    for (let i = 0; i < count; i++) this.widths[i] = bandWidth(this.freqs, i);
    this.wind = wind;
    this.settings = { density, timeScale, interval, waterLevel };
    const n = this.nx * this.nz;
    this.depth = new Float64Array(n);
    this.k = new Float64Array(n * count);
    this.cg = new Float64Array(n * count);
    for (let c = 0; c < this.nz; c++)
      for (let r = 0; r < this.nx; r++) {
        const at = r + this.nx * c,
          x = this.x0 + (r + 0.5) * cellSize,
          z = this.z0 + (c + 0.5) * cellSize,
          d = bed ? waterLevel - bed.sample(x, z).elevation : typeof depth === 'function' ? depth(x, z) : depth;
        if (Number.isNaN(d))
          throw new RangeError(`The water's depth at (${x}, ${z}) is not a number; pass finite metres.`);
        this.depth[at] = d;
        for (let i = 0; i < count; i++) {
          this.k[at * count + i] = d > 0 ? wavenumber(this.freqs[i]!, d, this.g) : 0;
          this.cg[at * count + i] = d > 0 ? groupVelocity(this.freqs[i]!, d, this.g) : 0;
        }
      }
    const per = count * directions;
    this.energy = host.allocate('spectrum', n * per * 8, 'f64', WAVE_LAYOUT);
    this.clock = host.allocate('clock', 16, 'f64', WAVE_LAYOUT);
    const blank = (): WaveSpectrumSample => ({
      frequencies: this.freqs,
      directions: this.dirs,
      energy: new Float64Array(per),
      depth: Infinity,
      density,
    });
    if (swell) this.swell = jonswap(swell, blank(), this.g).energy;
    if (start) {
      const e = jonswap(start, blank(), this.g).energy,
        words = this.words();
      for (let c = 0; c < n; c++) if (this.depth[c]! > 0) words.set(e, c * per);
    }
    if (warmUp > 0) {
      const steps = Math.ceil(warmUp / interval);
      for (let s = 0; s < steps; s++) this.advance(warmUp / steps, 0);
    }
  }

  private words(): Float64Array {
    return regionWords(this.host.memory, this.energy) as Float64Array;
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const clock = regionWords(this.host.memory, this.clock) as Float64Array,
      { interval, timeScale } = this.settings;
    clock[0]! += dt * timeScale;
    while (clock[0]! >= interval) {
      this.advance(interval, clock[1]! / timeScale);
      clock[0]! -= interval;
      clock[1]! += interval;
    }
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: WAVE_SPECTRUM_FIELD.name, region: this.energy, tick, cell: this.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.energy];
  }

  extraState(): readonly Region[] {
    return [this.clock];
  }

  /** Seconds of sea time simulated since the start (after any warm-up). */
  get time(): number {
    return (regionWords(this.host.memory, this.clock) as Float64Array)[1]!;
  }

  /** The grid: cells along x and z, the cell edge and the corner it starts at, [x, z]. */
  get grid(): { cells: [number, number]; cellSize: number; origin: [number, number] } {
    return { cells: [this.nx, this.nz], cellSize: this.h, origin: [this.x0, this.z0] };
  }

  /** The waves as the framework's `WaveSpectrumField`: the spectrum of the cell under (x, z). */
  get field(): WaveSpectrumField {
    return {
      cell: this.cell,
      sample: (x: number, z: number, out?: WaveSpectrumSample) => this.sample(x, z, out),
    };
  }

  /** The spectrum of the cell under (x, z), m^2/(Hz rad); outside the grid, the nearest edge cell's. */
  sample(x: number, z: number, out?: WaveSpectrumSample): WaveSpectrumSample {
    const per = this.nf * this.nd,
      s = out ?? {
        frequencies: this.freqs,
        directions: this.dirs,
        energy: new Float64Array(per),
        depth: 0,
        density: this.settings.density,
      },
      r = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.h))),
      c = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.h))),
      at = r + this.nx * c;
    s.energy.set(this.words().subarray(at * per, (at + 1) * per));
    s.depth = this.depth[at]!;
    s.density = this.settings.density;
    return s;
  }

  /** The significant wave height at (x, z), m. */
  significantHeight(x: number, z: number): number {
    return significantHeight(this.sample(x, z));
  }

  /** The peak period at (x, z), s. */
  peakPeriod(x: number, z: number): number {
    return 1 / peakFrequency(this.sample(x, z));
  }

  /** One step of `dt` seconds of sea time, at world time `time` (for the wind). */
  private advance(dt: number, time: number): void {
    this.propagate(dt);
    this.sources(dt, time);
  }

  /**
   * Propagation in space by first-order upwind fluxes of c_g E across cell faces (in substeps that keep the Courant number
   * of every bin at most 1/2), with refraction in direction where the depth changes, waves turning toward shallower water.
   */
  private propagate(dt: number): void {
    const { nx, nz, nf, nd, h } = this,
      per = nf * nd,
      words = this.words();
    let fastest = 0;
    for (let k = 0; k < this.cg.length; k++) if (this.cg[k]! > fastest) fastest = this.cg[k]!;
    const steps = Math.max(1, Math.ceil((2 * fastest * dt) / h)),
      sub = dt / steps,
      next = new Float64Array(words.length);
    for (let s = 0; s < steps; s++) {
      next.set(words);
      for (let c = 0; c < nz; c++)
        for (let r = 0; r < nx; r++) {
          const at = r + nx * c;
          if (!(this.depth[at]! > 0)) continue;
          for (let i = 0; i < nf; i++) {
            const cgHere = this.cg[at * nf + i]!;
            for (let j = 0; j < nd; j++) {
              const theta = this.dirs[j]!,
                ux = cgHere * cos(theta),
                uz = cgHere * sin(theta),
                bin = i * nd + j,
                here = words[at * per + bin]!;
              // Out through each face this bin's waves cross; in from the upwind neighbour (or the open sea's swell).
              let change = -((ux < 0 ? -ux : ux) + (uz < 0 ? -uz : uz)) * here;
              const fromX = ux > 0 ? r - 1 : r + 1,
                fromZ = uz > 0 ? c - 1 : c + 1;
              change += (ux < 0 ? -ux : ux) * this.upwind(words, fromX, c, bin);
              change += (uz < 0 ? -uz : uz) * this.upwind(words, r, fromZ, bin);
              next[at * per + bin]! += (sub / h) * change;
            }
          }
        }
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
      for (let k = 0; k < next.length; k++) words[k] = next[k]! > 0 ? next[k]! : 0;
    }
  }

  private depthAt(r: number, c: number, fallback: number): number {
    if (this.wrapX) r = (r + this.nx) % this.nx;
    if (this.wrapZ) c = (c + this.nz) % this.nz;
    if (r < 0 || c < 0 || r >= this.nx || c >= this.nz) return fallback;
    const d = this.depth[r + this.nx * c]!;
    return d > 0 ? d : 0;
  }

  /** The energy of bin `bin` coming from cell (r, c): 0 from land, the open sea's swell from beyond the grid. */
  private upwind(words: Float64Array, r: number, c: number, bin: number): number {
    if (this.wrapX) r = (r + this.nx) % this.nx;
    if (this.wrapZ) c = (c + this.nz) % this.nz;
    if (r < 0 || c < 0 || r >= this.nx || c >= this.nz) return this.swell ? this.swell[bin]! : 0;
    const at = r + this.nx * c;
    if (!(this.depth[at]! > 0)) return 0;
    return words[at * this.nf * this.nd + bin]!;
  }

  /** The source terms in every wet cell, integrated over `dt`. */
  private sources(dt: number, time: number): void {
    const { nx, nz, nf, nd, g } = this,
      per = nf * nd,
      words = this.words(),
      eSigma = new Float64Array(per),
      grow = new Float64Array(per),
      decay = new Float64Array(per),
      transfer = new Float64Array(per),
      dtheta = TWO_PI / nd,
      rhoRatio = AIR_DENSITY / this.settings.density;
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
        if (this.wind) {
          const x = this.x0 + (r + 0.5) * this.h,
            z = this.z0 + (c + 0.5) * this.h,
            v = this.wind.sample(x, this.settings.waterLevel + 10, z, time, this.flow).velocity;
          u10 = hypot(v[0], v[2]);
          windDirection = u10 > 0 ? angleTo(v[2], v[0]) : 0;
        }
        const ut = u10 / 31.5,
          drag = (0.55 + 2.97 * ut - 1.49 * ut * ut) * 1e-3,
          ustar = u10 * pow(drag > 0 ? drag : 0, 0.5),
          sigmaPM = (TWO_PI * 0.13 * g) / (28 * (ustar > 0 ? ustar : 1e-9));
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
              updated = (e + dt * (grow[b]! + transfer[b]!)) / (1 - dt * decay[b]!);
            let change = updated - e;
            if (change > limit) change = limit;
            else if (change < -limit) change = -limit;
            const value = e + change;
            words[at * per + b] = (value > 0 ? value : 0) * TWO_PI;
          }
        }
      }
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
      scale = (C_NL4 * TWO_PI * TWO_PI) / (g * g * g * g),
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
