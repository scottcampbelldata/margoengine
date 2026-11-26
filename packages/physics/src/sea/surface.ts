// The sea's surface and the water below it (SEA-02 of docs/physics-solvers.md; PA-11): a pure, synchronous query of the
// waves the wave solver's spectrum holds (`WaveSpectrumField`, SEA-01), so a hull, a fish, kelp and the drawn water all read
// one sea. The spectrum is synthesised as a sum of linear waves, one per frequency and direction bin of the spectrum, each
// with the amplitude its energy gives, a phase from the world's counter-based random numbers, and the wavenumber of the
// finite-depth dispersion relation; the sum gives the height, its slope (the normal), and the water's orbital velocity at
// the surface and at any depth below it.
//
// Written from J. Tessendorf, "Simulating Ocean Water" (course notes, 1999-2004; read pages 3-4 to 3-12), the linearised
// potential flow of the surface:
// - the velocity is the gradient of a potential, u = grad phi (eq. 11), with Laplace's equation inside the water (eqs. 13
//   and 17-18) and, on the surface, d phi / dt = -g h (eq. 20);
// - the dispersion relation, omega^2 = g k for deep water (eq. 31) and omega^2 = g k tanh(k D) over a bottom D deep (eq.
//   32), solved here by the wave solver's `wavenumber`;
// - the surface as a sum of waves, h = sum A_i cos(k_i . x - omega_i t + phi_i) (eq. 30), and its slope as the sum of the
//   waves' slopes (the gradient of eq. 36, eq. 37).
// Below the surface each wave's potential solves Laplace's equation (eq. 18: d^2/dy^2 = k^2 for a wave of wavenumber k)
// with no flow through a flat bottom at depth D, so its depth profile is cosh(k (y + D)); eq. 20 fixes its size, phi =
// (A g / omega) cosh(k (y + D)) / cosh(k D) sin(theta). Its gradient with eq. 32 gives the orbital velocity
//   u = A omega cosh(k (y + D)) / sinh(k D) cos(theta) along k,   w = A omega sinh(k (y + D)) / sinh(k D) sin(theta),
// which at the surface is w = dh/dt (the surface moves with the water), and in deep water (k D large) both fall off as
// e^(k y). Each wave's amplitude comes from the spectrum's energy in its bin, A = sqrt(2 E df dtheta), so the surface's
// variance is the spectrum's m0 (`WaveSpectrumSample`: the variance is the sum of E df dtheta). The linearised Bernoulli
// equation (eq. 14, d phi / dt = -p / rho - g y with the density written out) gives the gauge pressure under the waves,
//   p = rho g (sum A cosh(k (y + D)) / cosh(k D) cos(theta) - y),
// the hydrostatic pressure plus each wave's dynamic pressure, falling off with depth as the velocity does.
//
// Accepted differences, by method: linear (first-order) waves, so crests and troughs are alike (no Stokes asymmetry and no
// breaking: SEA-13 and FLUID-03); the orbital velocity between the still-water level and a crest takes its value at the
// still-water level (linear theory has none above it); a flat bottom under each place, at the spectrum's depth; the spectrum
// is read at one place (`at`) and taken for the whole sea until `refresh()`.
import type {
  FlowCell,
  FlowField,
  FlowSample,
  SeaSurface,
  SeaSurfaceSample,
  SeaWater,
  WaveSpectrumField,
  WaveSpectrumSample,
} from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { cos, exp, sin } from '@margoengine/math/pinned';
import { philox } from '@margoengine/math/random';
import { bandWidth, wavenumber } from '../waves/spectral.js';

const TWO_PI = 6.283185307179586;
/** The random-number stream of the waves' phases (an id of its own among the world's streams). */
const PHASE_STREAM = 0x5ea02;

/** Options of {@link SpectralSea}. */
export interface SpectralSeaOptions {
  /** The waves: the wave solver's field (read at `at`) or one spectrum. */
  waves: WaveSpectrumField | WaveSpectrumSample;
  /** Where the field's spectrum is read, m from its cell (default [0, 0]). */
  at?: readonly [number, number];
  /** The seed of the waves' phases: another seed is another sea of the same spectrum (default 1). */
  seed?: number;
  /** A current: a flow field of water added to the waves' motion (default none). */
  current?: FlowField;
  /** Gravity's magnitude, m/s^2 (default the world's, as the wave solver uses). */
  gravity?: number;
  /** The water's temperature, K, when no current gives one (default 288.15). */
  temperature?: number;
}

const isField = (waves: WaveSpectrumField | WaveSpectrumSample): waves is WaveSpectrumField =>
  typeof (waves as WaveSpectrumField).sample === 'function';

/**
 * A sea of linear waves synthesised from a wave spectrum: `sample(x, z, t)` gives the surface's height, normal and velocity,
 * and `water.sample(x, y, z, t)` the water's velocity at any depth. Pure and synchronous: the same place and time give the
 * same bits on every machine.
 *
 * ```ts
 * const sea = new SpectralSea({waves: jonswap({height: 2, period: 8, direction: 0}, spectrum)});
 * sea.sample(10, 0, 3.5).height;            // m above the still-water level
 * sea.water.sample(10, -4, 0, 3.5).velocity; // the water 4 m down
 * ```
 */
export class SpectralSea implements SeaSurface {
  readonly cell: FlowCell;
  /** The water below the surface. */
  readonly water: SeaWater;
  private readonly waves: WaveSpectrumField | WaveSpectrumSample;
  private readonly at: readonly [number, number];
  private readonly seed: number;
  private readonly current?: FlowField;
  private readonly g: number;
  private readonly temperature: number;
  private spectrum!: WaveSpectrumSample;
  // One entry per wave with energy: amplitude, wavevector, its direction, frequency and phase.
  private amp = new Float64Array(0);
  private kx = new Float64Array(0);
  private kz = new Float64Array(0);
  private k = new Float64Array(0);
  private omega = new Float64Array(0);
  private phase = new Float64Array(0);
  private count = 0;
  private depth = Infinity;
  private waterDensity = 0;
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /**
   * @throws TypeError for waves that are neither a spectrum field nor a spectrum; RangeError for a spectrum whose energy
   * does not match its frequencies and directions, or a gravity, seed, place or temperature out of range.
   */
  constructor(options: SpectralSeaOptions) {
    const {
      waves,
      at = [0, 0],
      seed = 1,
      current,
      gravity = gravityMagnitude(DEFAULT_GRAVITY),
      temperature = 288.15,
    } = options ?? ({} as never);
    if (!waves || typeof waves !== 'object')
      throw new TypeError('A sea needs its waves: a WaveSpectrumField or a spectrum.');
    if (!(gravity > 0 && Number.isFinite(gravity)))
      throw new RangeError(`Gravity is a finite number above 0 (got ${gravity}); pass m/s^2 such as 9.81, or leave it out for the world's gravity.`);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new RangeError(`A sea's seed is a whole number from 0 to 2^32 - 1 (got ${seed}); pass an integer seed in that range.`);
    if (!(Number.isFinite(at?.[0]) && Number.isFinite(at?.[1])))
      throw new RangeError('A sea reads its spectrum at a finite [x, z]; pass `at`.');
    if (!(temperature > 0 && Number.isFinite(temperature)))
      throw new RangeError(`A water temperature is finite kelvin above 0 (got ${temperature}); pass kelvin such as 288.15 (15 C).`);
    if (current !== undefined && (typeof current.sample !== 'function' || current.medium !== 'water'))
      throw new TypeError('A current is a flow field of water (medium "water"); pass one, or none.');
    this.waves = waves;
    this.at = [at[0], at[1]];
    this.seed = seed;
    this.current = current;
    this.g = gravity;
    this.temperature = temperature;
    this.cell = isField(waves) ? waves.cell : [0, 0, 0];
    const sea = this;
    this.water = {
      medium: 'water',
      cell: this.cell,
      sample: (x, y, z, t, out) => sea.below(x, y, z, t, out),
    };
    this.refresh();
  }

  /** How many waves the sea sums (the bins of its spectrum that hold energy). */
  get waveCount(): number {
    return this.count;
  }

  /** The still-water depth the sea's waves feel, m (Infinity for deep water). */
  get stillDepth(): number {
    return this.depth;
  }

  /** Density of the water, kg/m^3 (the spectrum's: about 1000 fresh, 1025 sea; 0 on land). */
  get density(): number {
    return this.waterDensity;
  }

  /** Height of the surface at (x, z) at time `t`, m: the sum of the waves alone. */
  elevation(x: number, z: number, t: number): number {
    let h = 0;
    for (let n = 0; n < this.count; n++)
      h += this.amp[n]! * cos(this.kx[n]! * x + this.kz[n]! * z - this.omega[n]! * t + this.phase[n]!);
    return h;
  }

  /**
   * Gauge pressure at (x, y, z) at time `t`, Pa: rho g (sum A K(y) cos(theta) - y), with K the waves' depth factor
   * cosh(k (y + D)) / cosh(k D) (e^(k y) in deep water) taken at the still-water level above it; 0 at the surface and above.
   */
  pressure(x: number, y: number, z: number, t: number): number {
    if (!(this.waterDensity > 0)) return 0;
    const deep = !(this.depth < Infinity),
      level = y < 0 ? y : 0;
    let dynamic = 0,
      h = 0;
    for (let n = 0; n < this.count; n++) {
      const k = this.k[n]!,
        c = cos(this.kx[n]! * x + this.kz[n]! * z - this.omega[n]! * t + this.phase[n]!);
      h += this.amp[n]! * c;
      const factor = deep
        ? exp(k * level)
        : (exp(k * level) + exp(-k * (level + 2 * this.depth))) / (1 + exp(-2 * k * this.depth));
      dynamic += this.amp[n]! * factor * c;
    }
    if (y >= h) return 0;
    return this.waterDensity * this.g * (dynamic - y);
  }

  /**
   * The waves at time `t` s for a renderer (`WaterSea` of `@margoengine/water`): four numbers a wave into `out` (kx, kz in
   * rad/m, amplitude in m, and the phase at `t` in rad, so a wave's height at (x, z) is amplitude cos(kx x + kz z +
   * phase)); returns how many. The phase is worked out in doubles and brought into [0, 2 pi) before it is rounded to the
   * f32 of `out`, so a GPU summing these draws the surface `sample` gives, to f32 precision, at any time.
   * @throws RangeError when `out` is shorter than four numbers a wave.
   */
  waveComponents(t: number, out: Float32Array): number {
    const n = this.count;
    if (!(out.length >= 4 * n))
      throw new RangeError(`waveComponents writes ${4 * n} numbers (${n} waves); pass a Float32Array that long.`);
    for (let i = 0; i < n; i++) {
      const phase = this.phase[i]! - this.omega[i]! * t;
      out[4 * i] = this.kx[i]!;
      out[4 * i + 1] = this.kz[i]!;
      out[4 * i + 2] = this.amp[i]!;
      out[4 * i + 3] = phase - TWO_PI * Math.floor(phase / TWO_PI);
    }
    return n;
  }

  /**
   * Reads the spectrum again (the wave solver moves it on with the world clock) and sets the waves' amplitudes from it. A
   * wave keeps its phase, so the sea changes smoothly as its spectrum grows or decays.
   * @throws RangeError for a spectrum whose energy does not match its frequencies and directions.
   */
  refresh(): this {
    const s = isField(this.waves) ? this.waves.sample(this.at[0], this.at[1], this.spectrum) : this.waves,
      { frequencies: fs, directions: ds, energy } = s,
      nf = fs?.length ?? 0,
      nd = ds?.length ?? 0;
    if (!(nf >= 1 && nd >= 1 && energy?.length === nf * nd))
      throw new RangeError(
        `A wave spectrum holds frequencies x directions energies (got ${nf} x ${nd} and ${energy?.length}); pass the wave solver's sample.`,
      );
    this.spectrum = s;
    this.depth = s.depth;
    this.waterDensity = s.depth > 0 ? s.density : 0;
    if (this.amp.length !== nf * nd) {
      for (const name of ['amp', 'kx', 'kz', 'k', 'omega', 'phase'] as const) this[name] = new Float64Array(nf * nd);
    }
    const dtheta = TWO_PI / nd,
      random = new Uint32Array(4);
    let n = 0;
    for (let i = 0; i < nf; i++) {
      const f = fs[i]!,
        df = nf > 1 ? bandWidth(fs, i) : f,
        k = s.depth > 0 ? wavenumber(f, s.depth, this.g) : 0;
      if (!(k > 0)) continue;
      for (let j = 0; j < nd; j++) {
        const e = energy[i * nd + j]!;
        if (!(e > 0)) continue;
        const theta = ds[j]!;
        philox(i, j, 0, 0, this.seed, PHASE_STREAM, random);
        this.amp[n] = Math.sqrt(2 * e * df * dtheta);
        this.k[n] = k;
        this.kx[n] = k * cos(theta);
        this.kz[n] = k * sin(theta);
        this.omega[n] = TWO_PI * f;
        this.phase[n] = (TWO_PI * random[0]!) / 4294967296;
        n++;
      }
    }
    this.count = n;
    return this;
  }

  /** The surface at (x, z) m from the sea's cell at time `t` s. Writes into `out` when given and returns it. */
  sample(x: number, z: number, t: number, out?: SeaSurfaceSample): SeaSurfaceSample {
    const s = out ?? { height: 0, normal: [0, 1, 0], velocity: [0, 0, 0], current: [0, 0, 0], depth: 0, density: 0 },
      deep = !(this.depth < Infinity);
    let h = 0,
      dx = 0,
      dz = 0,
      ux = 0,
      uz = 0,
      w = 0;
    for (let n = 0; n < this.count; n++) {
      const a = this.amp[n]!,
        kx = this.kx[n]!,
        kz = this.kz[n]!,
        k = this.k[n]!,
        om = this.omega[n]!,
        theta = kx * x + kz * z - om * t + this.phase[n]!,
        c = cos(theta),
        sn = sin(theta),
        // coth(k D) at the surface: (1 + e^(-2 k D)) / (1 - e^(-2 k D)); 1 in deep water.
        q = deep ? 1 : (1 + exp(-2 * k * this.depth)) / (1 - exp(-2 * k * this.depth)),
        horizontal = (a * om * q * c) / k;
      h += a * c;
      dx -= a * kx * sn;
      dz -= a * kz * sn;
      ux += horizontal * kx;
      uz += horizontal * kz;
      w += a * om * sn;
    }
    const length = Math.sqrt(dx * dx + 1 + dz * dz);
    s.height = h;
    s.normal[0] = -dx / length;
    s.normal[1] = 1 / length;
    s.normal[2] = -dz / length;
    this.currentAt(x, h, z, t, s.current);
    s.velocity[0] = ux + s.current[0];
    s.velocity[1] = w + s.current[1];
    s.velocity[2] = uz + s.current[2];
    s.depth = this.depth;
    s.density = this.waterDensity;
    return s;
  }

  /** The water at (x, y, z) at time t: the waves' orbital velocity at that depth plus the current; none above the surface. */
  private below(x: number, y: number, z: number, t: number, out?: FlowSample): FlowSample {
    const s = out ?? { velocity: [0, 0, 0], density: 0, temperature: 0 },
      deep = !(this.depth < Infinity);
    const h = this.elevation(x, z, t);
    if (!(this.waterDensity > 0) || y > h || (!deep && y < -this.depth)) {
      s.velocity[0] = s.velocity[1] = s.velocity[2] = 0;
      s.density = 0;
      s.temperature = this.temperature;
      return s;
    }
    // Linear theory has no water above the still-water level: between it and a crest the water moves as it does at it.
    const level = y < 0 ? y : 0;
    let ux = 0,
      uz = 0,
      w = 0;
    for (let n = 0; n < this.count; n++) {
      const a = this.amp[n]!,
        kx = this.kx[n]!,
        kz = this.kz[n]!,
        k = this.k[n]!,
        om = this.omega[n]!,
        theta = kx * x + kz * z - om * t + this.phase[n]!,
        rise = exp(k * level);
      let ch = rise,
        sh = rise;
      if (!deep) {
        // cosh(k (y + D)) / sinh(k D) and sinh(k (y + D)) / sinh(k D), written with decaying exponentials only.
        const fall = exp(-k * (level + 2 * this.depth)),
          denominator = 1 - exp(-2 * k * this.depth);
        ch = (rise + fall) / denominator;
        sh = (rise - fall) / denominator;
      }
      const horizontal = (a * om * ch * cos(theta)) / k;
      ux += horizontal * kx;
      uz += horizontal * kz;
      w += a * om * sh * sin(theta);
    }
    this.currentAt(x, y, z, t, this.flow.velocity);
    s.velocity[0] = ux + this.flow.velocity[0];
    s.velocity[1] = w + this.flow.velocity[1];
    s.velocity[2] = uz + this.flow.velocity[2];
    s.density = this.waterDensity;
    s.temperature = this.current ? this.flow.temperature : this.temperature;
    return s;
  }

  private currentAt(x: number, y: number, z: number, t: number, into: [number, number, number]): void {
    if (!this.current) {
      into[0] = into[1] = into[2] = 0;
      this.flow.temperature = this.temperature;
      return;
    }
    const c = this.current.sample(x, y, z, t, this.flow);
    into[0] = c.velocity[0];
    into[1] = c.velocity[1];
    into[2] = c.velocity[2];
  }
}
