// Nearshore waves and the surf zone (SEA-05 of docs/physics-solvers.md): the short waves of a sea or swell coming ashore over
// the water of a `ShallowWaterSolver` (HYDRO-01), as a framework solver. The waves shoal and refract over the bed, break as
// the water shoals, and hand what they lose to a roller of broken water; the gradient of their radiation stress drives the
// water, so the shallow water itself sets up at the shore, runs along it as a longshore current, returns seaward as undertow
// and rips, surges with the wave groups (surf beat) and runs up and down the beach.
//
// The phase-averaged "surfbeat" chain of D. Roelvink, A. Reniers, A. van Dongeren, J. van Thiel de Vries, R. McCall and J.
// Lescinski, "Modelling storm impacts on beaches, dunes and barrier islands", Coastal Engineering 56, 1133-1152, 2009, as the
// public XBeach manual states it (read; the model's code was not):
// - the short waves' energy per direction, at one representative period T: dE/dt + d(c_g cos(theta) E)/dx + d(c_g sin(theta)
//   E)/dz + d(c_theta E)/dtheta = -D_w E(theta) / E_w, refraction c_theta = (sigma / sinh(2 k h)) (h_x sin(theta) - h_z
//   cos(theta)) (manual eqs. 1 to 4);
// - breaking, J. A. Roelvink, "Dissipation in random wave groups incident on a beach", Coastal Engineering 19, 1993: D_w = 2
//   (alpha / T) Q_b E_w (H_rms / h), Q_b = 1 - exp(-(H_rms / (gamma h))^n), with gamma 0.55, alpha 1, n 10 (manual eq. 12, its
//   stable defaults), and H_rms at most 2 h;
// - the roller of broken water, dE_r/dt + div(E_r c (cos, sin)(theta_m)) = D_w - 2 beta g E_r / c, beta 0.1 (eqs. 38 to 43;
//   Nairn, Roelvink and Southgate 1990, Reniers et al. 2004);
// - the radiation stress S_xx = integral of [n (1 + cos^2) - 1/2] E, S_xz = integral of n sin cos E, S_zz likewise (M. S.
//   Longuet-Higgins and R. W. Stewart, Deep-Sea Res. 11, 1964), plus the roller's 2 E_r (cos^2, sin cos, sin^2)(theta_m), the
//   form whose momentum, mass flux 2 E_r / c and dissipation agree for Svendsen's roller; the force on the water -div S;
// - the waves' and roller's Stokes drift (E_w + 2 E_r) (cos, sin)(theta_m) / (rho h c), which the water carries as part of its
//   Lagrangian momentum and its bed friction does not see, so the depth-mean return flow below the waves, the undertow, is
//   -u_S where the water's net flow is nothing (manual eqs. 46 to 48);
// - the rms orbital velocity at the bed, u_rms = pi H_rms / (sqrt 2 T sinh(k h)), stirring the bed friction.
// Wave groups: with `groups`, the incoming energy at the offshore side is the envelope of the sea's components, |sum of a_i
// e^(i (omega_i t - k_i . x + phi_i))|^2 rho g / 2, the phases from the world's counter-based random numbers, so the energy
// comes ashore in groups and the shallow water answers with surf beat and swash.
//
// Run-up: each line of cells across the shore keeps its shoreline (the last cell, going landward, wetter than 1 cm), its
// highest water and the time each cell was last wet, so the wet sand's edge and the highest run-up are known.
//
// State: the waves' energy per cell and direction, the roller's energy, the highest shoreline of each line, and the time each
// cell was last wet.
import type { WaveSpectrumField } from '@margoengine/math/fields';
import { cos, exp, pow, sin } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import type { BedShape } from '../earth/bed.js';
import { FORCING_WORDS, SURFACE_WATER_FORCING_FIELD, type ShallowWaterSolver } from '../hydro/index.js';
import { angleOf } from '../flight.js';
import { bandWidth, wavenumber } from '../waves/spectral.js';
import { regionWords } from '../world/memory.js';
import {
  type Cell,
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';

/** The registry field of the surf: per cell, the short waves' H_rms (m), mean direction (rad) and roller energy (J/m^2), f32. */
export const SURF_FIELD: FieldDescriptor = {
  name: 'surf',
  kind: 'uniformGrid',
  quantity: 'waveHeight',
  unit: 'm, rad, J/m^2',
  centring: 'cell',
};
/** The layout of the surf solver's regions. */
export const SURF_LAYOUT = 1;

const TWO_PI = 6.283185307179586;
/** Water shallower than this, m, carries no short waves. */
const WAVE_DEPTH = 0.05;
/** A cell wetter than this, m, is wet for the shoreline and the wet sand. */
const WET = 0.01;
/** Components of the synthesised wave groups. */
const COMPONENTS = 48;

/** A side of the water's grid. */
export type SurfSide = 'minX' | 'maxX' | 'minZ' | 'maxZ';

/** The waves coming in: a sea state, or a spectrum sampled at the offshore side's middle. */
export type SurfIncident =
  | {
      /** Significant wave height H_m0, m. */
      readonly height: number;
      /** Peak period, s. */
      readonly period: number;
      /** The direction the waves travel toward, radians from +x toward +z (default straight in from `side`). */
      readonly direction?: number;
      /** Directional spreading cos^(2s) (default s = 10). */
      readonly spreading?: number;
      /** JONSWAP peak enhancement for the wave groups (default 3.3). */
      readonly gamma?: number;
    }
  | { readonly waves: WaveSpectrumField };

/** What a {@link SurfSolver} is made from. */
export interface SurfParams {
  /** The shallow water the waves come ashore over (its grid, depth and flow). */
  readonly water: ShallowWaterSolver;
  /** The waves coming in. */
  readonly incident: SurfIncident;
  /** The offshore side they come in over (default 'minX'). */
  readonly side?: SurfSide;
  /** The coast along the shore: 'open' (default; waves leave over the ends) or 'periodic', a coast that goes on the same way (give the water periodic sides there too). */
  readonly alongshore?: 'open' | 'periodic';
  /**
   * Waves ride the water's currents (default true): they keep their absolute frequency, so a current along them stretches them
   * and one against them steepens and, past c_g + U = 0, blocks them; the currents' shear turns them.
   */
  readonly currents?: boolean;
  /** Wave groups at the offshore side (default true): surf beat and swash. Off, the incoming energy is steady. */
  readonly groups?: boolean;
  /** The still water level the set-up and run-up are measured from, m (default 0). */
  readonly level?: number;
  /** Directions over the half-plane the waves come in through, +-90 degrees about the shoreward one (default 36: 5 degrees). */
  readonly directions?: number;
  /** Breaking (Roelvink 1993): gamma (default 0.55), alpha (1) and n (10). */
  readonly breaking?: { readonly gamma?: number; readonly alpha?: number; readonly n?: number };
  /** The roller's front slope beta (default 0.1), or false for no roller. */
  readonly roller?: { readonly beta?: number } | false;
  /** The water's density, kg/m^3 (default 1025). */
  readonly density?: number;
  /** Its rate level (default 0, the world's base rate). */
  readonly rate?: RateLevel;
}

const ORIGIN: Cell = [0, 0, 0];

/** The surf zone over a shallow water, a framework solver. `id` is `'surf'` unless a world holds more. */
export class SurfSolver implements Solver<SurfParams> {
  private readonly id: string;
  private host!: SolverHost;
  private cell: Cell = ORIGIN;
  private water!: ShallowWaterSolver;
  private nx = 0;
  private nz = 0;
  private dx = 0;
  private dz = 0;
  private x0 = 0;
  private z0 = 0;
  private nd = 36;
  private dtheta = Math.PI / 36;
  private dirs!: Float64Array;
  private g = 9.80665;
  private rho = 1025;
  private side: SurfSide = 'minX';
  private period = 10;
  private sigma = 0;
  /** The incoming energy's share in each direction, summing to 1 / dtheta. */
  private spread!: Float64Array;
  private meanEnergy = 0;
  private gamma = 0.55;
  private alpha = 1;
  private n = 10;
  private beta: number | undefined = 0.1;
  private groups = true;
  private peakPeriod = 10;
  private height = 1;
  private stillLevel = 0;
  private wrapX = false;
  private wrapZ = false;
  private currents = true;
  private components: { a: number; omega: number; kx: number; kz: number; phi: number }[] = [];
  private level: RateLevel = 0;
  private energy!: Region;
  private roller!: Region;
  private shorelines!: Region;
  private wetted!: Region;
  private swash!: Region;
  /** The time of the last step, s (the wet sand's clock). */
  private clock!: Region;
  private forces!: Region;
  private published!: Region;
  // Per-cell scratch of the step: depth, wavenumber, phase and group speeds, n.
  private depth!: Float64Array;
  private k!: Float64Array;
  private c!: Float64Array;
  private cg!: Float64Array;
  private bed!: Float64Array;
  /** Per cell: the waves' intrinsic frequency (rad/s) and the water's current along x and z (m/s). */
  private sig!: Float64Array;
  private ux!: Float64Array;
  private uz!: Float64Array;

  /** @param id The solver's id (default `'surf'`). */
  constructor(id = 'surf') {
    this.id = id;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: SURF_FIELD, access: 'write' },
        { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  init(host: SolverHost, params: SurfParams): void {
    const { water, incident } = params ?? ({} as SurfParams);
    if (!water || typeof water.sample !== 'function')
      throw new TypeError(
        'Surf comes ashore over a shallow water: pass {water}, a ShallowWaterSolver added to the world first.',
      );
    const shape: BedShape = water.shape;
    this.water = water;
    this.host = host;
    const [gx, gy, gz] = host.gravity;
    this.g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    this.nx = shape.columns;
    this.nz = shape.rows;
    this.dx = shape.width / shape.columns;
    this.dz = shape.depth / shape.rows;
    this.x0 = shape.centre[0] - shape.width / 2;
    this.z0 = shape.centre[1] - shape.depth / 2;
    const side = params.side ?? 'minX';
    if (side !== 'minX' && side !== 'maxX' && side !== 'minZ' && side !== 'maxZ')
      throw new RangeError(`The waves come in over 'minX', 'maxX', 'minZ' or 'maxZ' (got ${String(side)}); pass one.`);
    this.side = side;
    const nd = params.directions ?? 36;
    if (!(Number.isInteger(nd) && nd >= 4 && nd <= 360))
      throw new RangeError(`Surf has 4 to 360 directions (got ${nd}); pass a whole number.`);
    this.nd = nd;
    // The incoming half-plane, +-90 degrees about the shoreward direction (as XBeach's directional sector): bins of pi / nd.
    const inward = { minX: 0, maxX: Math.PI, minZ: Math.PI / 2, maxZ: -Math.PI / 2 }[side];
    this.dtheta = Math.PI / nd;
    this.dirs = new Float64Array(nd).map((_, j) => inward - Math.PI / 2 + (j + 0.5) * this.dtheta);
    const density = params.density ?? 1025;
    if (!(density > 0 && Number.isFinite(density)))
      throw new RangeError(`Water's density is a finite number of kg/m^3 above 0 (got ${density}); pass one.`);
    this.rho = density;
    const { gamma = 0.55, alpha = 1, n = 10 } = params.breaking ?? {};
    if (!(gamma > 0 && gamma <= 2 && alpha > 0 && alpha <= 10 && n >= 1 && n <= 50))
      throw new RangeError(
        `Breaking takes gamma in (0, 2], alpha in (0, 10] and n from 1 to 50 (got ${gamma}, ${alpha}, ${n}); pass them, or leave them for 0.55, 1 and 10.`,
      );
    this.gamma = gamma;
    this.alpha = alpha;
    this.n = n;
    if (params.roller === false) this.beta = undefined;
    else {
      const beta = params.roller?.beta ?? 0.1;
      if (!(beta > 0 && beta < 1))
        throw new RangeError(`The roller's slope beta lies in (0, 1) (got ${beta}); pass one, or leave it for 0.1.`);
      this.beta = beta;
    }
    this.groups = params.groups ?? true;
    this.currents = params.currents ?? true;
    const still = params.level ?? 0;
    if (!Number.isFinite(still))
      throw new RangeError(`The still water level is a finite height in metres (got ${still}); pass one.`);
    this.stillLevel = still;
    const alongshore = params.alongshore ?? 'open';
    if (alongshore !== 'open' && alongshore !== 'periodic')
      throw new RangeError(`The coast along the shore is 'open' or 'periodic' (got ${String(alongshore)}); pass one.`);
    if (alongshore === 'periodic') {
      if (side === 'minX' || side === 'maxX') this.wrapZ = true;
      else this.wrapX = true;
    }
    const level = params.rate ?? 0;
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    this.level = level as RateLevel;
    this.incoming(incident, host);
    const count = this.nx * this.nz;
    this.energy = host.allocate('energy', count * nd * 8, 'f64', SURF_LAYOUT);
    this.roller = host.allocate('roller', count * 8, 'f64', SURF_LAYOUT);
    const lines = side === 'minX' || side === 'maxX' ? this.nz : this.nx;
    this.shorelines = host.allocate('shorelines', lines * 8, 'f64', SURF_LAYOUT);
    // Per line: steps seen, and the sum and sum of squares of the shoreline's height above the still water.
    this.swash = host.allocate('swash', lines * 3 * 8, 'f64', SURF_LAYOUT);
    this.wetted = host.allocate('wetted', count * 8, 'f64', SURF_LAYOUT);
    this.clock = host.allocate('clock', 8, 'f64', SURF_LAYOUT);
    this.forces = host.allocate('forces', count * FORCING_WORDS * 8, 'f64', SURF_LAYOUT);
    this.published = host.allocate('published', count * 3 * 4, 'f32', SURF_LAYOUT);
    (regionWords(host.memory, this.shorelines) as Float64Array).fill(Number.NEGATIVE_INFINITY);
    (regionWords(host.memory, this.wetted) as Float64Array).fill(Number.NEGATIVE_INFINITY);
    this.depth = new Float64Array(count);
    this.k = new Float64Array(count);
    this.c = new Float64Array(count);
    this.cg = new Float64Array(count);
    this.bed = new Float64Array(count);
    this.sig = new Float64Array(count);
    this.ux = new Float64Array(count);
    this.uz = new Float64Array(count);
  }

  /** The incoming sea: its representative period, mean energy, directional share and the wave groups' components. */
  private incoming(incident: SurfIncident, host: SolverHost): void {
    if (!incident || typeof incident !== 'object')
      throw new TypeError('Surf needs the waves coming in: pass {incident: {height, period}} or {incident: {waves}}.');
    const nd = this.nd,
      dtheta = this.dtheta,
      inward = { minX: 0, maxX: Math.PI, minZ: Math.PI / 2, maxZ: -Math.PI / 2 }[this.side];
    this.spread = new Float64Array(nd);
    // The sea's frequencies and directions: a JONSWAP sea state, or the given spectrum's, kept to those coming in.
    let fs: Float64Array,
      density: (i: number, j: number) => number,
      nf: number,
      ds: Float64Array,
      binWidth = this.dtheta;
    if ('waves' in incident) {
      if (!incident.waves || typeof incident.waves.sample !== 'function')
        throw new TypeError('An incident spectrum is a WaveSpectrumField: pass {waves}.');
      const [cx, cz] = this.sideCentre(),
        spectrum = incident.waves.sample(cx, cz);
      fs = spectrum.frequencies;
      ds = spectrum.directions;
      nf = fs.length;
      density = (i, j) => spectrum.energy[i * ds.length + j]!;
      binWidth = TWO_PI / ds.length;
    } else {
      const { height, period, direction = inward, spreading = 10, gamma = 3.3 } = incident;
      if (!(height > 0 && Number.isFinite(height) && period > 0 && Number.isFinite(period)))
        throw new RangeError(
          `Incoming waves have a height and a period, finite and above 0 (got ${height} m and ${period} s); pass both.`,
        );
      if (!(spreading >= 0.5 && spreading <= 1000) || !Number.isFinite(direction) || !(gamma >= 1 && gamma <= 10))
        throw new RangeError(
          `Incoming waves' spreading s is 0.5 to 1000, their direction finite and gamma 1 to 10 (got ${spreading}, ${direction}, ${gamma}); pass them.`,
        );
      // A JONSWAP spectrum of the height and period over 0.5 to 3 times the peak, cos^2s spread about the direction.
      nf = 40;
      fs = new Float64Array(nf).map((_, i) => (0.5 * pow(6, i / (nf - 1))) / period);
      ds = this.dirs;
      const fp = 1 / period,
        shape = new Float64Array(nf);
      let m0 = 0;
      for (let i = 0; i < nf; i++) {
        const f = fs[i]!,
          s = f <= fp ? 0.07 : 0.09,
          r = exp(-((f - fp) * (f - fp)) / (2 * s * s * fp * fp));
        shape[i] = pow(f, -5) * exp(-1.25 * pow(fp / f, 4)) * pow(gamma, r);
        m0 += shape[i]! * bandWidth(fs, i);
      }
      const spreadOf = new Float64Array(nd);
      let total = 0;
      for (let j = 0; j < nd; j++) {
        const cd = cos(ds[j]! - direction);
        spreadOf[j] = cd > 0 ? pow(cd, 2 * spreading) : 0;
        total += spreadOf[j]! * dtheta;
      }
      const scale = (height * height) / 16 / m0;
      density = (i, j) => (shape[i]! * scale * spreadOf[j]!) / total;
    }
    // Moments: m0, m1 for the representative period T_m01, and the energy share per direction.
    let m0 = 0,
      m1 = 0;
    const share = new Float64Array(nd);
    for (let i = 0; i < nf; i++) {
      const df = bandWidth(fs, i);
      for (let j = 0; j < ds.length; j++) {
        const e = density(i, j) * df * binWidth;
        if (!(cos(ds[j]! - inward) > 0)) continue;
        m0 += e;
        m1 += e * fs[i]!;
        // Into this solver's bin of that direction, in the incoming half-plane.
        let rel = (((ds[j]! - inward) % TWO_PI) + TWO_PI) % TWO_PI;
        if (rel > Math.PI) rel -= TWO_PI;
        const into = Math.min(nd - 1, Math.max(0, Math.floor((rel + Math.PI / 2) / dtheta)));
        share[into]! += e;
      }
    }
    if (!(m0 > 0))
      throw new RangeError('The incoming sea carries no energy toward the shore; pass waves that come in.');
    this.period = m0 / m1;
    this.sigma = TWO_PI / this.period;
    // The peak period and the significant height, for the incident swash (Stockdon et al. 2006).
    let peak = 0,
      most = -1;
    for (let i = 0; i < nf; i++) {
      let sum = 0;
      for (let j = 0; j < ds.length; j++) if (cos(ds[j]! - inward) > 0) sum += density(i, j);
      if (sum > most) {
        most = sum;
        peak = fs[i]!;
      }
    }
    this.peakPeriod = 1 / peak;
    this.height = 4 * Math.sqrt(m0);
    this.meanEnergy = this.rho * this.g * m0;
    for (let j = 0; j < nd; j++) this.spread[j] = share[j]! / m0 / dtheta;
    // The wave groups' components: COMPONENTS draws of (frequency, direction) by energy, each of equal variance, with the
    // world's random numbers (seed 0 here; the step re-keys by the world's seed).
    const cumulative: number[] = [],
      bins: [number, number][] = [];
    let sum = 0;
    for (let i = 0; i < nf; i++)
      for (let j = 0; j < ds.length; j++) {
        if (!(cos(ds[j]! - inward) > 0)) continue;
        const e = density(i, j) * bandWidth(fs, i) * binWidth;
        if (!(e > 0)) continue;
        sum += e;
        cumulative.push(sum);
        bins.push([fs[i]!, ds[j]!]);
      }
    this.draws = { cumulative, bins, sum, m0 };
    this.drawComponents(0);
    void host;
  }

  /** The inputs of the wave groups' components, kept to draw them again under the world's seed. */
  private draws: { cumulative: number[]; bins: [number, number][]; sum: number; m0: number } | undefined;
  private seed = -1;

  /** Draws the wave groups' components by energy, each of equal variance, on the random stream of `seed`. */
  private drawComponents(seed: number): void {
    const { cumulative, bins, sum, m0 } = this.draws!,
      random = new RandomStream(seed, solverNumber(this.id)),
      g = this.g;
    this.seed = seed;
    this.components = [];
    for (let c = 0; c < COMPONENTS; c++) {
      const [u, v] = random.unitF64(0, c, 2),
        target = u * sum;
      let lo = 0,
        hi = cumulative.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid]! < target) lo = mid + 1;
        else hi = mid;
      }
      const [f, theta] = bins[lo]!,
        // Deep-water wavenumbers along the offshore side: only their component along the side sets the groups' phase there.
        kk = wavenumber(f, Infinity, g);
      this.components.push({
        a: Math.sqrt((2 * m0) / COMPONENTS),
        omega: TWO_PI * f,
        kx: kk * cos(theta),
        kz: kk * sin(theta),
        phi: TWO_PI * v,
      });
    }
  }

  /** The middle of the offshore side, [x, z] m. */
  private sideCentre(): [number, number] {
    const xm = this.x0 + (this.nx * this.dx) / 2,
      zm = this.z0 + (this.nz * this.dz) / 2;
    return {
      minX: [this.x0, zm] as [number, number],
      maxX: [this.x0 + this.nx * this.dx, zm] as [number, number],
      minZ: [xm, this.z0] as [number, number],
      maxZ: [xm, this.z0 + this.nz * this.dz] as [number, number],
    }[this.side];
  }

  /** The incoming energy at the boundary point (x, z) at time t, J/m^2: steady, or the wave groups' envelope. */
  private boundaryEnergy(x: number, z: number, t: number): number {
    if (!this.groups) return this.meanEnergy;
    let re = 0,
      im = 0;
    for (const p of this.components) {
      const phase = p.omega * t - p.kx * x - p.kz * z + p.phi;
      re += p.a * cos(phase);
      im += p.a * sin(phase);
    }
    return 0.5 * this.rho * this.g * (re * re + im * im);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    if (this.seed !== context.seed) this.drawComponents(context.seed);
    const time = context.tick / rateOf(context.level),
      { nx, nz, nd } = this,
      n = nx * nz,
      E = this.words(this.energy),
      Er = this.words(this.roller),
      forces = this.words(this.forces);
    // The water now: depth, bed, and the waves' wavenumber and speeds at the representative period.
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = i + nx * j,
          s = this.water.sample(this.x0 + (i + 0.5) * this.dx, this.z0 + (j + 0.5) * this.dz);
        this.depth[k] = s.depth;
        this.bed[k] = s.surface - s.depth;
        const u = this.currents && s.depth > WAVE_DEPTH ? s.velocity[0] : 0,
          w = this.currents && s.depth > WAVE_DEPTH ? s.velocity[1] : 0;
        this.ux[k] = u;
        this.uz[k] = w;
        if (s.depth > WAVE_DEPTH) this.disperse(k, s.depth, E);
        else this.k[k] = this.c[k] = this.cg[k] = this.sig[k] = 0;
      }
    // Substeps for the waves' Courant number (space and direction) at most 0.7.
    let fastest = 0;
    for (let k = 0; k < n; k++) {
      const rate = (this.cg[k]! + Math.abs(this.ux[k]!)) / this.dx + (this.cg[k]! + Math.abs(this.uz[k]!)) / this.dz;
      if (rate > fastest) fastest = rate;
    }
    const steps = Math.max(1, Math.ceil((fastest * dt) / 0.5)),
      sub = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.propagate(E, sub, time + s * sub);
      this.dissipate(E, Er, sub);
      if (this.beta !== undefined) this.carryRoller(Er, sub);
    }
    this.force(E, Er, forces);
    this.shore(time);
    // Published: H_rms, mean direction, roller energy.
    const p = regionWords(this.host.memory, this.published) as Float32Array,
      dtheta = this.dtheta;
    for (let k = 0; k < n; k++) {
      let ew = 0,
        cx = 0,
        cz = 0;
      for (let b = 0; b < nd; b++) {
        const e = E[k * nd + b]! * dtheta;
        ew += e;
        cx += e * cos(this.dirs[b]!);
        cz += e * sin(this.dirs[b]!);
      }
      p[3 * k] = Math.sqrt((8 * ew) / (this.rho * this.g));
      p[3 * k + 1] = ew > 0 ? angleOf(cz, cx) : 0;
      p[3 * k + 2] = Er[k]!;
    }
  }

  /**
   * The waves' wavenumber at cell k on water `depth` m deep riding its current: the absolute frequency omega = sigma(k) + k U
   * is the incoming sea's, U the current along the waves' mean direction there (the Doppler relation, solved by Newton's
   * method). Where c_g + U falls to 0 the current blocks the waves, and the cell carries none.
   */
  private disperse(k: number, depth: number, E: Float64Array): void {
    const g = this.g,
      omega = this.sigma,
      nd = this.nd;
    let cx = 0,
      cz = 0;
    for (let b = 0; b < nd; b++) {
      cx += E[k * nd + b]! * cos(this.dirs[b]!);
      cz += E[k * nd + b]! * sin(this.dirs[b]!);
    }
    const norm = Math.sqrt(cx * cx + cz * cz),
      along =
        norm > 0
          ? (this.ux[k]! * cx + this.uz[k]! * cz) / norm
          : this.ux[k]! * cos(this.dirs[nd >> 1]!) + this.uz[k]! * sin(this.dirs[nd >> 1]!);
    let kk = wavenumber(omega / TWO_PI, depth, g);
    let blocked = false;
    for (let it = 0; it < 30 && along !== 0; it++) {
      const kh = kk * depth,
        th = kh < 20 ? tanhOf(kh) : 1,
        sigma = Math.sqrt(g * kk * th),
        group = (sigma / kk) * (0.5 + (kh < 20 ? kh / sinhOf(2 * kh) : 0)),
        slope = group + along;
      if (!(slope > 1e-6)) {
        blocked = true;
        break;
      }
      const next = kk - (sigma + kk * along - omega) / slope;
      if (!(next > 0)) {
        blocked = true;
        break;
      }
      if (Math.abs(next - kk) < 1e-12 * kk) {
        kk = next;
        break;
      }
      kk = next;
    }
    const kh = kk * depth,
      sigma = Math.sqrt(g * kk * (kh < 20 ? tanhOf(kh) : 1)),
      cg = (sigma / kk) * (0.5 + (kh < 20 ? kh / sinhOf(2 * kh) : 0));
    if (blocked || !(sigma > 0) || !(cg + along > 0)) {
      this.k[k] = this.c[k] = this.cg[k] = this.sig[k] = 0;
      return;
    }
    this.k[k] = kk;
    this.sig[k] = sigma;
    this.c[k] = sigma / kk;
    this.cg[k] = cg;
  }

  /** The waves' energy over `dt`: upwind fluxes in x, z and direction; the offshore side feeds the incoming directions. */
  private propagate(E: Float64Array, dt: number, time: number): void {
    const { nx, nz, nd, dx, dz } = this,
      dtheta = this.dtheta,
      cg = this.cg,
      sig = this.sig,
      depth = this.depth;
    // Action A = E / sigma is what is carried: with currents, energy is not kept, action is (Bretherton and Garrett 1968).
    for (let k = 0; k < nx * nz; k++) {
      const s = sig[k]!;
      for (let b = 0; b < nd; b++) E[k * nd + b] = s > 0 ? E[k * nd + b]! / s : 0;
    }
    const before = E.slice();
    const at = (i: number, j: number, b: number) => (i + nx * j) * nd + b,
      // The action beyond the grid in direction b at the edge cell (i, j): the incoming sea on the offshore side, none elsewhere.
      ghost = (i: number, j: number, b: number, edge: SurfSide): number => {
        if (edge !== this.side) return 0;
        const x = this.x0 + (i + 0.5) * dx,
          z = this.z0 + (j + 0.5) * dz,
          s = sig[i + nx * j]!;
        return s > 0 ? (this.boundaryEnergy(x, z, time) * this.spread[b]!) / s : 0;
      },
      // The speed of direction b's action at cell k: the group velocity along it plus the current.
      speedX = (k: number, cx: number) => (cg[k]! > 0 ? cg[k]! * cx + this.ux[k]! : 0),
      speedZ = (k: number, cz: number) => (cg[k]! > 0 ? cg[k]! * cz + this.uz[k]! : 0),
      upwind = (vl: number, vr: number, al: number, ar: number) => (vl + vr >= 0 ? vl * al : vr * ar);
    for (let b = 0; b < nd; b++) {
      const cx = cos(this.dirs[b]!),
        cz = sin(this.dirs[b]!);
      // Along x: the flux through each face from its upwind side.
      for (let j = 0; j < nz; j++)
        for (let f = this.wrapX ? 1 : 0; f <= nx; f++) {
          const left = f - 1,
            right = this.wrapX && f === nx ? 0 : f;
          let flux: number;
          if (left < 0) {
            const v = speedX(right + nx * j, cx);
            flux = v > 0 ? v * ghost(right, j, b, 'minX') : v * before[at(right, j, b)]!;
          } else if (right >= nx) {
            const v = speedX(left + nx * j, cx);
            flux = v < 0 ? v * ghost(left, j, b, 'maxX') : v * before[at(left, j, b)]!;
          } else
            flux = upwind(
              speedX(left + nx * j, cx),
              speedX(right + nx * j, cx),
              before[at(left, j, b)]!,
              before[at(right, j, b)]!,
            );
          if (left >= 0) E[at(left, j, b)]! -= (dt / dx) * flux;
          if (right < nx && (this.wrapX || right === f)) E[at(right, j, b)]! += (dt / dx) * flux;
        }
      if (nz > 1 || this.side === 'minZ' || this.side === 'maxZ')
        for (let i = 0; i < nx; i++)
          for (let f = this.wrapZ ? 1 : 0; f <= nz; f++) {
            const lo = f - 1,
              hi = this.wrapZ && f === nz ? 0 : f;
            let flux: number;
            if (lo < 0) {
              const v = speedZ(i + nx * hi, cz);
              flux = v > 0 ? v * ghost(i, hi, b, 'minZ') : v * before[at(i, hi, b)]!;
            } else if (hi >= nz) {
              const v = speedZ(i + nx * lo, cz);
              flux = v < 0 ? v * ghost(i, lo, b, 'maxZ') : v * before[at(i, lo, b)]!;
            } else
              flux = upwind(
                speedZ(i + nx * lo, cz),
                speedZ(i + nx * hi, cz),
                before[at(i, lo, b)]!,
                before[at(i, hi, b)]!,
              );
            if (lo >= 0) E[at(i, lo, b)]! -= (dt / dz) * flux;
            if (hi < nz && (this.wrapZ || hi === f)) E[at(i, hi, b)]! += (dt / dz) * flux;
          }
    }
    // Refraction: turning in direction at c_theta = (sigma / sinh 2kh) (h_x sin - h_z cos), plus the currents' shear
    // cos (sin u_x - cos u_z) + sin (sin w_x - cos w_z) (the XBeach manual's eq. 10), upwind between neighbouring bins.
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = i + nx * j,
          d = depth[k]!;
        if (!(cg[k]! > 0)) continue;
        const kk = this.k[k]!,
          kh = kk * d,
          dhx = (this.depthAt(i + 1, j, d) - this.depthAt(i - 1, j, d)) / (2 * dx),
          dhz = nz > 1 ? (this.depthAt(i, j + 1, d) - this.depthAt(i, j - 1, d)) / (2 * dz) : 0,
          factor = kh > 10 ? 0 : sig[k]! / sinhOf(2 * kh),
          grad = (field: Float64Array, di: number, dj: number, h: number) =>
            (this.fieldAt(field, i + di, j + dj, field[k]!) - this.fieldAt(field, i - di, j - dj, field[k]!)) / (2 * h),
          uxx = grad(this.ux, 1, 0, dx),
          uxz = nz > 1 ? grad(this.ux, 0, 1, dz) : 0,
          uzx = grad(this.uz, 1, 0, dx),
          uzz = nz > 1 ? grad(this.uz, 0, 1, dz) : 0,
          flux = new Float64Array(nd + 1);
        if (factor === 0 && uxx === 0 && uxz === 0 && uzx === 0 && uzz === 0) continue;
        // Face b between bins b - 1 and b, at the direction halfway; the half-plane's edges are closed.
        for (let b = 1; b < nd; b++) {
          const theta = this.dirs[b]! - dtheta / 2,
            cs = cos(theta),
            sn = sin(theta),
            ct = factor * (dhx * sn - dhz * cs) + cs * (sn * uxx - cs * uxz) + sn * (sn * uzx - cs * uzz),
            from = ct >= 0 ? b - 1 : b;
          flux[b] = ct * before[k * nd + from]!;
        }
        for (let b = 0; b < nd; b++) E[k * nd + b]! += (dt / dtheta) * (flux[b]! - flux[b + 1]!);
      }
    // Back to energy. No short waves in water too shallow for them, or where a current blocks them: what reaches there is spent.
    for (let k = 0; k < nx * nz; k++)
      if (!(cg[k]! > 0)) for (let b = 0; b < nd; b++) E[k * nd + b] = 0;
      else for (let b = 0; b < nd; b++) E[k * nd + b] = E[k * nd + b]! > 0 ? E[k * nd + b]! * sig[k]! : 0;
  }

  private fieldAt(field: Float64Array, i: number, j: number, fallback: number): number {
    if (this.wrapX) i = (i + this.nx) % this.nx;
    if (this.wrapZ) j = (j + this.nz) % this.nz;
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return fallback;
    return field[i + this.nx * j]!;
  }

  private depthAt(i: number, j: number, fallback: number): number {
    if (this.wrapX) i = (i + this.nx) % this.nx;
    if (this.wrapZ) j = (j + this.nz) % this.nz;
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return fallback;
    return this.depth[i + this.nx * j]!;
  }

  /** Breaking (Roelvink 1993), implicitly: each cell's energy loses D_w dt, which the roller gains. */
  private dissipate(E: Float64Array, Er: Float64Array, dt: number): void {
    const { nd } = this,
      dtheta = this.dtheta,
      rhoG = this.rho * this.g;
    for (let k = 0; k < this.nx * this.nz; k++) {
      const h = this.depth[k]!;
      if (!(this.cg[k]! > 0)) {
        Er[k] = 0;
        continue;
      }
      let ew = 0;
      for (let b = 0; b < nd; b++) ew += E[k * nd + b]! * dtheta;
      if (!(ew > 0)) continue;
      let hrms = Math.sqrt((8 * ew) / rhoG);
      // At most H_rms = 2 h.
      if (hrms > 2 * h) {
        const f = ((2 * h) / hrms) * ((2 * h) / hrms);
        for (let b = 0; b < nd; b++) E[k * nd + b]! *= f;
        ew *= f;
        hrms = 2 * h;
      }
      const qb = 1 - exp(-pow(hrms / (this.gamma * h), this.n)),
        // D_w / E_w = 2 alpha Q_b H_rms / (T h).
        // T the waves' intrinsic period here, 2 pi / sigma.
        rate = (2 * this.alpha * qb * hrms * this.sig[k]!) / (TWO_PI * h),
        keep = 1 / (1 + rate * dt);
      for (let b = 0; b < nd; b++) E[k * nd + b]! *= keep;
      if (this.beta !== undefined) Er[k]! += ew * (1 - keep);
    }
  }

  /** The roller over `dt`: carried at c along the waves' mean direction, losing 2 beta g E_r / c, implicitly. */
  private carryRoller(Er: Float64Array, dt: number): void {
    const { nx, nz, dx, dz, nd } = this,
      E = this.words(this.energy),
      before = Er.slice(),
      dirX = new Float64Array(nx * nz),
      dirZ = new Float64Array(nx * nz);
    for (let k = 0; k < nx * nz; k++) {
      let cx = 0,
        cz = 0;
      for (let b = 0; b < nd; b++) {
        cx += E[k * nd + b]! * cos(this.dirs[b]!);
        cz += E[k * nd + b]! * sin(this.dirs[b]!);
      }
      const norm = Math.sqrt(cx * cx + cz * cz);
      dirX[k] = norm > 0 ? cx / norm : 0;
      dirZ[k] = norm > 0 ? cz / norm : 0;
    }
    const speedX = (k: number) => this.c[k]! * dirX[k]!,
      speedZ = (k: number) => this.c[k]! * dirZ[k]!;
    for (let j = 0; j < nz; j++)
      for (let f = this.wrapX ? 1 : 0; f <= nx; f++) {
        const l = f - 1,
          r = this.wrapX && f === nx ? 0 : f;
        const ul = l >= 0 ? speedX(l + nx * j) : 0,
          ur = r < nx ? speedX(r + nx * j) : 0,
          u = 0.5 * (ul + ur),
          flux = u >= 0 ? (l >= 0 ? ul * before[l + nx * j]! : 0) : r < nx ? ur * before[r + nx * j]! : 0;
        if (l >= 0) Er[l + nx * j]! -= (dt / dx) * flux;
        if (r < nx && (this.wrapX || r === f)) Er[r + nx * j]! += (dt / dx) * flux;
      }
    if (nz > 1)
      for (let i = 0; i < nx; i++)
        for (let f = this.wrapZ ? 1 : 0; f <= nz; f++) {
          const lo = f - 1,
            hi = this.wrapZ && f === nz ? 0 : f;
          const ul = lo >= 0 ? speedZ(i + nx * lo) : 0,
            ur = hi < nz ? speedZ(i + nx * hi) : 0,
            u = 0.5 * (ul + ur),
            flux = u >= 0 ? (lo >= 0 ? ul * before[i + nx * lo]! : 0) : hi < nz ? ur * before[i + nx * hi]! : 0;
          if (lo >= 0) Er[i + nx * lo]! -= (dt / dz) * flux;
          if (hi < nz && (this.wrapZ || hi === f)) Er[i + nx * hi]! += (dt / dz) * flux;
        }
    const beta = this.beta!;
    for (let k = 0; k < nx * nz; k++) {
      const c = this.c[k]!;
      Er[k] = c > 0 && Er[k]! > 0 ? Er[k]! / (1 + (dt * 2 * beta * this.g) / c) : 0;
    }
  }

  /** The waves' forcing on the water: -div S over the density, the Stokes drift and the orbital velocity, per cell. */
  private force(E: Float64Array, Er: Float64Array, out: Float64Array): void {
    const { nx, nz, nd, dx, dz } = this,
      n = nx * nz,
      dtheta = this.dtheta,
      sxx = new Float64Array(n),
      sxz = new Float64Array(n),
      szz = new Float64Array(n);
    out.fill(0);
    for (let k = 0; k < n; k++) {
      if (!(this.cg[k]! > 0)) continue;
      const ratio = this.cg[k]! / this.c[k]!;
      let xx = 0,
        xz = 0,
        zz = 0,
        ew = 0,
        mx = 0,
        mz = 0;
      for (let b = 0; b < nd; b++) {
        const e = E[k * nd + b]! * dtheta,
          cs = cos(this.dirs[b]!),
          sn = sin(this.dirs[b]!);
        xx += (ratio * (1 + cs * cs) - 0.5) * e;
        xz += ratio * sn * cs * e;
        zz += (ratio * (1 + sn * sn) - 0.5) * e;
        ew += e;
        mx += e * cs;
        mz += e * sn;
      }
      const norm = Math.sqrt(mx * mx + mz * mz),
        ex = norm > 0 ? mx / norm : 0,
        ez = norm > 0 ? mz / norm : 0,
        r = Er[k]!;
      sxx[k] = xx + 2 * r * ex * ex;
      sxz[k] = xz + 2 * r * ex * ez;
      szz[k] = zz + 2 * r * ez * ez;
      const h = this.depth[k]!,
        drift = (ew + 2 * r) / (this.rho * h * this.c[k]!),
        hrms = Math.sqrt((8 * ew) / (this.rho * this.g)),
        kh = this.k[k]! * h;
      out[FORCING_WORDS * k + 2] = drift * ex;
      out[FORCING_WORDS * k + 3] = drift * ez;
      out[FORCING_WORDS * k + 4] = kh < 20 ? (this.sig[k]! * hrms) / (2 * Math.SQRT2 * sinhOf(kh)) : 0;
    }
    // F = -div S by central differences; a neighbour without waves (dry, or beyond the grid) holds the cell's own stress, so
    // the shore and the grid's edges push only by the gradient inside.
    const sAt = (s: Float64Array, i: number, j: number, own: number): number => {
      if (this.wrapX) i = (i + nx) % nx;
      if (this.wrapZ) j = (j + nz) % nz;
      return i < 0 || j < 0 || i >= nx || j >= nz || !(this.cg[i + nx * j]! > 0) ? own : s[i + nx * j]!;
    };
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = i + nx * j;
        if (!(this.depth[k]! > WET)) continue;
        const own = (s: Float64Array) => (this.cg[k]! > 0 ? s[k]! : 0),
          ddx = (s: Float64Array) => (sAt(s, i + 1, j, own(s)) - sAt(s, i - 1, j, own(s))) / (2 * dx),
          ddz = (s: Float64Array) => (nz > 1 ? (sAt(s, i, j + 1, own(s)) - sAt(s, i, j - 1, own(s))) / (2 * dz) : 0);
        out[FORCING_WORDS * k] = -(ddx(sxx) + ddz(sxz)) / this.rho;
        out[FORCING_WORDS * k + 1] = -(ddx(sxz) + ddz(szz)) / this.rho;
      }
  }

  /** The shoreline of each line across the shore, its highest water, and the time each cell was last wet. */
  private shore(time: number): void {
    this.words(this.clock)[0] = time;
    const { nx, nz } = this,
      high = this.words(this.shorelines),
      wetted = this.words(this.wetted),
      across = this.side === 'minX' || this.side === 'maxX',
      lines = across ? nz : nx,
      length = across ? nx : nz;
    const swash = this.words(this.swash),
      reach = this.incidentSwash() / 2;
    for (let k = 0; k < nx * nz; k++) if (this.depth[k]! > WET) wetted[k] = time;
    for (let line = 0; line < lines; line++) {
      // Landward from the offshore side: the last wet cell.
      let last = -1;
      const cellOf = (p: number) => {
        const q = this.side === 'minX' || this.side === 'minZ' ? p : length - 1 - p;
        return across ? q + nx * line : line + nx * q;
      };
      for (let p = 0; p < length; p++) if (this.depth[cellOf(p)]! > WET) last = p;
      if (last < 0) continue;
      const k = cellOf(last),
        level = this.bed[k]! + this.depth[k]!,
        above = level - this.stillLevel;
      if (level + reach > high[line]!) high[line] = level + reach;
      swash[3 * line]! += 1;
      swash[3 * line + 1]! += above;
      swash[3 * line + 2]! += above * above;
      // The short waves' uprush, which the shallow water does not resolve, wets the sand up to half the incident swash
      // height above the shoreline.
      for (let p = last + 1; p < length; p++) {
        const c = cellOf(p);
        if (this.bed[c]! > level + reach) break;
        wetted[c] = time;
      }
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [
      { field: SURF_FIELD.name, region: this.published, tick, cell: this.cell },
      { field: SURFACE_WATER_FORCING_FIELD.name, region: this.forces, tick, cell: this.cell },
    ];
  }

  stateRegions(): readonly Region[] {
    return [this.energy, this.roller, this.shorelines, this.wetted, this.clock, this.swash];
  }

  extraState(): readonly Region[] {
    return [];
  }

  private cellOf(x: number, z: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.dx))),
      j = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.dz)));
    return i + this.nx * j;
  }

  /**
   * The long wave bound to the wave groups at a point (x, z) of the offshore side, at time `t`: [elevation m, velocity along x
   * and z m/s]. The groups' radiation stress pushes the water down under each group and up between them, zeta_b = (2n - 1/2)
   * (E - mean E) / (rho (c_g^2 - g h)), carried at the groups' speed, u_b = c_g zeta_b / h along the waves (M. S.
   * Longuet-Higgins and R. W. Stewart, "Radiation stress and mass transport in gravity waves", J. Fluid Mech. 13, 1962, as the
   * Delft3D manual states it, eqs. B.66 and B.67). Feed it to the water's open sea so the long waves come in with the groups:
   * `sides: {minX: {sea: 0, incoming: (t, x, z) => surf.boundWave(t, x, z)}}`. Without groups it is nothing.
   */
  boundWave(t: number, x: number, z: number): [number, number, number] {
    if (!this.groups || !this.host) return [0, 0, 0];
    const h = this.water.sample(x, z).depth;
    if (!(h > WAVE_DEPTH)) return [0, 0, 0];
    const kk = wavenumber(1 / this.period, h, this.g),
      kh = kk * h,
      ratio = 0.5 + (kh < 20 ? kh / sinhOf(2 * kh) : 0),
      cg = (this.sigma / kk) * ratio,
      gap = cg * cg - this.g * h;
    if (!(gap < 0)) return [0, 0, 0];
    const zeta = ((2 * ratio - 0.5) * (this.boundaryEnergy(x, z, t) - this.meanEnergy)) / (this.rho * gap);
    let cx = 0,
      cz = 0;
    for (let b = 0; b < this.nd; b++) {
      cx += this.spread[b]! * cos(this.dirs[b]!);
      cz += this.spread[b]! * sin(this.dirs[b]!);
    }
    const norm = Math.sqrt(cx * cx + cz * cz) || 1,
      speed = (cg * zeta) / h;
    return [zeta, (speed * cx) / norm, (speed * cz) / norm];
  }

  /**
   * The incident band's swash height, m: S_inc = 0.75 beta_f sqrt(H0 L0) (H. F. Stockdon, R. A. Holman, P. A. Howd and A. H.
   * Sallenger, "Empirical parameterization of setup, swash, and runup", Coastal Engineering 53, 2006), the short waves' uprush
   * that a phase-averaged surf does not resolve: H0 the incoming sea deshoaled to deep water, L0 = g T_p^2 / (2 pi), beta_f
   * the beach's slope at the shoreline.
   */
  incidentSwash(at?: readonly [number, number]): number {
    const slope = this.foreshore(at);
    if (!(slope > 0)) return 0;
    const g = this.g,
      tp = this.peakPeriod,
      [cx, cz] = this.sideCentre(),
      h = this.water.sample(cx, cz).depth,
      deep = (g * tp) / (4 * Math.PI),
      here = h > 0 ? groupSpeed(TWO_PI / tp, h, g) : deep,
      offshore = this.height * Math.sqrt(here / deep),
      wavelength = (g * tp * tp) / TWO_PI;
    return 0.75 * slope * Math.sqrt(offshore * wavelength);
  }

  /**
   * The 2 percent exceedance run-up, m above the still water: R2 = 1.1 (<eta> + S / 2) with S = sqrt(S_inc^2 + S_IG^2)
   * (Stockdon et al. 2006), <eta> and the infragravity swash S_IG = 4 sigma from this surf's own shoreline record on the line
   * through `at` ([x, z]; default the middle line), S_inc from {@link incidentSwash}.
   */
  runUp2(at?: readonly [number, number]): number {
    const line = this.lineOf(at),
      s = this.words(this.swash),
      count = s[3 * line]!;
    if (!(count > 0)) return 0;
    const mean = s[3 * line + 1]! / count,
      variance = Math.max(0, s[3 * line + 2]! / count - mean * mean),
      infragravity = 4 * Math.sqrt(variance),
      incident = this.incidentSwash(at);
    return 1.1 * (mean + Math.sqrt(incident * incident + infragravity * infragravity) / 2);
  }

  /** The line of cells across the shore through `at`, or the middle one. */
  private lineOf(at?: readonly [number, number]): number {
    const across = this.side === 'minX' || this.side === 'maxX',
      lines = across ? this.nz : this.nx;
    if (!at) return lines >> 1;
    const k = this.cellOf(at[0], at[1]);
    return across ? (k - (k % this.nx)) / this.nx : k % this.nx;
  }

  /** The beach's slope at the mean shoreline of the line through `at`: the bed's rise over a cell each side of it. */
  private foreshore(at?: readonly [number, number]): number {
    const line = this.lineOf(at),
      { nx, nz } = this,
      across = this.side === 'minX' || this.side === 'maxX',
      length = across ? nx : nz,
      step = across ? this.dx : this.dz,
      cellOf = (p: number) => {
        const q = this.side === 'minX' || this.side === 'minZ' ? p : length - 1 - p;
        return across ? q + nx * line : line + nx * q;
      };
    let last = -1;
    for (let p = 0; p < length; p++) if (this.depth[cellOf(p)]! > WET) last = p;
    if (last < 1 || last >= length - 1) return 0;
    return (this.bed[cellOf(last + 1)]! - this.bed[cellOf(last - 1)]!) / (2 * step);
  }

  /** The representative frequency of the incoming waves, 1 / T_m01, Hz: the short waves' frequency in the surf. */
  get meanFrequency(): number {
    return 1 / this.period;
  }

  /**
   * The waves' forcing on the water at (x, z): the radiation stress's force over the density (m^2/s^2 along x and z), the
   * Stokes drift (m/s) and the rms orbital velocity at the bed (m/s), as handed to the shallow water.
   */
  forcing(x: number, z: number): { force: [number, number]; stokes: [number, number]; orbital: number } {
    const f = this.words(this.forces),
      at = FORCING_WORDS * this.cellOf(x, z);
    return { force: [f[at]!, f[at + 1]!], stokes: [f[at + 2]!, f[at + 3]!], orbital: f[at + 4]! };
  }

  /** The short waves' rms height at (x, z), m (their significant height is about sqrt 2 times it). */
  waveHeight(x: number, z: number): number {
    return (regionWords(this.host.memory, this.published) as Float32Array)[3 * this.cellOf(x, z)]!;
  }

  /** The direction the short waves travel toward at (x, z), radians from +x toward +z. */
  waveDirection(x: number, z: number): number {
    return (regionWords(this.host.memory, this.published) as Float32Array)[3 * this.cellOf(x, z) + 1]!;
  }

  /** The roller's energy at (x, z), J/m^2. */
  rollerEnergy(x: number, z: number): number {
    return this.words(this.roller)[this.cellOf(x, z)]!;
  }

  /** The waves' Stokes drift at (x, z), m/s along x and z. */
  stokesDrift(x: number, z: number): [number, number] {
    const f = this.words(this.forces),
      k = this.cellOf(x, z);
    return [f[FORCING_WORDS * k + 2]!, f[FORCING_WORDS * k + 3]!];
  }

  /** The undertow at (x, z): the water's depth-mean Eulerian velocity, its flow less the Stokes drift, m/s along x and z. */
  undertow(x: number, z: number): [number, number] {
    const s = this.water.sample(x, z),
      [ux, uz] = this.stokesDrift(x, z);
    return [s.velocity[0] - ux, s.velocity[1] - uz];
  }

  /**
   * The highest the water has run up the shore, m above the datum: on the line of cells across the shore through `at` ([x, z])
   * or, without it, the highest of all lines.
   */
  runUp(at?: readonly [number, number]): number {
    const arg = at,
      high = this.words(this.shorelines);
    if (!arg) {
      let best = Number.NEGATIVE_INFINITY;
      for (let l = 0; l < high.length; l++) if (high[l]! > best) best = high[l]!;
      return best;
    }
    const k = this.cellOf(arg[0], arg[1]),
      line = this.side === 'minX' || this.side === 'maxX' ? (k - (k % this.nx)) / this.nx : k % this.nx;
    return high[line]!;
  }

  /** Whether (x, z) has been wet within the last `window` seconds (default 600): the wet sand, with the water itself. */
  wetSand(x: number, z: number, window = 600): boolean {
    const wetted = this.words(this.wetted)[this.cellOf(x, z)]!,
      now = this.words(this.clock)[0]!;
    return Number.isFinite(wetted) && now - wetted <= window;
  }
}

function sinhOf(x: number): number {
  const e = exp(x);
  return (e - 1 / e) / 2;
}

function tanhOf(x: number): number {
  const e = exp(2 * x);
  return (e - 1) / (e + 1);
}

/** The group speed of waves of angular frequency sigma on water h m deep. */
function groupSpeed(sigma: number, h: number, g: number): number {
  const k = wavenumber(sigma / TWO_PI, h, g),
    kh = k * h;
  return (sigma / k) * (0.5 + (kh < 20 ? kh / sinhOf(2 * kh) : 0));
}
