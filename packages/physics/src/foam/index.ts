// Whitecaps, foam and spray (SEA-13 of docs/physics-solvers.md): the foam on the sea's surface as a framework solver, made by
// the breakers of the sea's own spectrum (breaking.ts, the breaking ST4's dissipation describes), carried and stretched by the
// water's surface drift, gathered into windrows, and fading as its bubbles burst; ships leave wakes of it; and the spray the
// whitecaps throw into the air (spray.ts).
//
// Breakers are events, not a smooth field. Each statistics cell's spectrum gives, per (frequency, direction) bin, the
// breaking crest length per area Lambda (Leckler et al. 2013), hence N = Lambda / (L_b tau*) breakers per area per second,
// each a crest of length L_b = 0.3 lambda (Duncan 1981) breaking for tau* = 0.8 T (Reul and Chapron 2003, after Phillips et
// al. 2001). The solver draws them as a Poisson process on the world's counter-based random numbers, so the same seed
// gives the same breakers. An active breaker is a white patch, its crest across the wave and 0.048 lambda deep, moving at
// the crest speed c: over its life it sweeps a strip 0.8 lambda long. Behind it lies residual foam of whiteness d that
// fades with e-folding time tau_e. d and tau_e are set so that, on average, the foam covers what Leckler et al.'s ST4
// whitecap law gives, W = 0.30 integral of lambda Lambda, with Reul and Chapron's active share of 0.16:
// - d tau_e = 0.2377 T: the residual area-time, 0.84 of kappa lambda L_b tau*, over the strip's area;
// - tau_e = tau_B (3.8 s in salt water, 2.5 s fresh; Monahan and Zietlow 1969 via Reul and Chapron) while d <= 1;
// - for big breakers, d = 1 and tau_e = 0.2377 T: thick foam lasts longer (Callaghan et al. 2012: decay time rises with
//   patch size).
// So small breakers leave faint foam that is soon gone and storm breakers leave dense foam that trails.
//
// Transport. Foam is carried by the water's surface: the current (a water FlowField), the waves' surface Stokes drift (from
// the spectrum), a wind drift of `windDrift` of U10 (default 0.6 percent, the quasi-Eulerian 0.4 to 0.8 percent of Ardhuin et
// al. 2009), and Langmuir circulation. Above 3 m/s the windrows converge foam into lines along the wind, `spacing` apart
// (default 30 m), sweeping at 1 percent of U10, spun up over 5 minutes (Leibovich 1983). The transport is in flux form with a
// limiter, so foam is conserved, piles into the convergence lines, and is stretched by the flow's shear without
// spreading. Coverage is held at 1; what would pile beyond it thickens the foam that is there.
//
// Ships. Each ship lays its wake foam around and behind its hull each step:
// - the bow waves' breaking along two arms 19.5 degrees off the track, by its Froude number;
// - the stern's white water, two beams long and fully white (Reed and Milgram 2002);
// - the turbulent wake out to one ship length, its width growing as x^(1/5).
// It fades with `wakePersistence` (default 150 s: the bubbles of a ship's wake keep feeding its foam for minutes, about 7.5
// minutes acoustically at 10 knots, Trevorrow, Vagle and Farmer 1994, taken as three e-foldings).
//
// Fields. It owns `seaFoam`: per cell, the foam coverage and the active whitecap coverage, f32, x fastest.
// State: the foam's whiteness and decay rate per cell, the breakers alive, and the windrows' age.
import type { FlowField, FlowSample, WaveSpectrumField, WaveSpectrumSample, Wind } from '@margoengine/math/fields';
import { cos, exp, pow, sin } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import type { PhysicsBody } from '../body.js';
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
import { ACTIVE_PERIODS, ACTIVE_SHARE, type BreakingStatistics, breakingStatistics, CREST_SHARE } from './breaking.js';
import { bagBreakups, sprayFlux } from './spray.js';
import { bubblePlume, surfaceCurrent } from './plume.js';
import { HULL_BREACH_WORDS, HULL_BREACHES_FIELD } from '../world/flooding.js';
import { MargoError } from '@margoengine/math/errors';

export {
  ACTIVE_PERIODS,
  ACTIVE_SHARE,
  type BreakingStatistics,
  breakingStatistics,
  CREST_SHARE,
  SATURATION_THRESHOLD,
  WHITECAP_COEFFICIENT,
} from './breaking.js';
export { bagBreakups, sprayFlux, sprayPerWhitecap } from './spray.js';
export {
  BUBBLE_SLIP,
  type BubblePlumeOptions,
  bubblePlume,
  PLUME_ENTRAINMENT,
  SURFACE_ENTRAINMENT,
  type SurfacingPlume,
  surfaceCurrent,
} from './plume.js';

/** The registry field of the foam: per cell, the foam coverage and the active whitecap coverage (0 to 1), f32. */
export const SEA_FOAM_FIELD: FieldDescriptor = {
  name: 'seaFoam',
  kind: 'uniformGrid',
  quantity: 'foamCoverage',
  unit: '1',
  centring: 'cell',
};
/** The layout of the foam solver's regions. */
export const SEA_FOAM_LAYOUT = 1;

/** Residual foam's e-folding time in sea water, s (Monahan and Zietlow 1969, 3.85 s). */
export const SALT_FOAM_DECAY = 3.8;
/** Residual foam's e-folding time in fresh water, s (2.54 s). */
export const FRESH_FOAM_DECAY = 2.5;
/** The active patch's depth along the wave, as a share of its wavelength: Reul and Chapron's active share of the coverage. */
const ACTIVE_DEPTH = ACTIVE_SHARE * 0.3;
/**
 * The residual foam's whiteness times its persistence per period, d tau_e = 0.2377 T: the residual share of kappa lambda L_b
 * tau* over the strip a breaker leaves, its sweep of 0.8 lambda and its patch's depth.
 */
const RESIDUAL = ((1 - ACTIVE_SHARE) * 0.3 * ACTIVE_PERIODS) / (ACTIVE_PERIODS + ACTIVE_DEPTH);
/** Words of a breaker: x, z, direction x, z, speed, half crest length, half depth, age, life, whiteness, decay rate. */
const BREAKER = 11;
const TWO_PI = 6.283185307179586;
/** The bow waves' arms: Kelvin's half-angle, 19.47 degrees. */
const KELVIN = 0.3398369094541219;

/** A ship whose hull lays wake foam: a rigid body, or a track of its own. */
export interface FoamShip {
  /** The ship's body; its position and velocity (the ship heads the way it moves) are read every step. */
  readonly body?: PhysicsBody;
  /** Or a track: where the ship's centre is and how fast it moves at time t, [x, z] m and [u, w] m/s. */
  readonly track?: (time: number) => { position: readonly [number, number]; velocity: readonly [number, number] };
  /** Length on the waterline, m. */
  readonly length: number;
  /** Beam, m. */
  readonly beam: number;
  /**
   * Where its propellers' races boil up to the surface (a `ShipSolver`'s `wash`): each from `position` [x, z] m along
   * `direction` for `reach` m, `radius` m wide where it surfaces, its water moving at `speed` m/s there (default none).
   */
  readonly wash?: (time: number) => readonly {
    readonly position: readonly [number, number];
    readonly direction: readonly [number, number];
    readonly reach: number;
    readonly radius: number;
    readonly speed: number;
  }[];
}

/** The race speed at the surface that whitens it fully, m/s: the boil behind a working screw (a calibration: docs/limits.md). */
export const WASH_SPEED = 1;

/** What a {@link FoamSolver} is made from. */
export interface FoamParams {
  /** The sea: a wave spectrum field (`WaveSolver.field`, or the solver itself for its friction velocity). */
  readonly waves:
    | WaveSpectrumField
    | { readonly field: WaveSpectrumField; frictionVelocity?(x: number, z: number): number };
  /** The grid: cells along x and z (default 128 by 128). */
  readonly cells?: readonly [number, number];
  /** Cell size, m (default 2). */
  readonly cellSize?: number;
  /** The grid's centre, [x, z] m (default [0, 0]). */
  readonly centre?: readonly [number, number];
  /** Spacing of the breaking statistics, m: the spectrum is sampled this far apart (default 64). */
  readonly statistics?: number;
  /** The wind 10 m above the sea, for the wind drift and the windrows (default none). */
  readonly wind?: Wind;
  /** The water's current at the surface (default none). */
  readonly current?: FlowField;
  /** Residual foam's e-folding time, s (default 3.8 in sea water, 2.5 in fresh, from the waves' density). */
  readonly decay?: number;
  /** The wind drift of the surface, a share of U10 (default 0.006). */
  readonly windDrift?: number;
  /** Langmuir windrows: their spacing, m, sweep speed as a share of U10 and spin-up time, s, or false for none. */
  readonly windrows?: { readonly spacing?: number; readonly speed?: number; readonly spinUp?: number } | false;
  /** Ships laying wake foam. */
  readonly ships?: readonly FoamShip[];
  /**
   * Take the air escaping damaged hulls under water (`hullBreaches`, written by a `HullSolver` with compartments; default
   * true): each breach's bubble plume rises to the surface (`bubblePlume`) and its boil whitens the water out to where
   * its surface current (`surfaceCurrent`) falls under the wash's speed. The hull solver must step in the foam's cell.
   */
  readonly bubbles?: boolean;
  /** The wake foam's e-folding time, s (default 150). */
  readonly wakePersistence?: number;
  /** At most this many breakers alive at once (default 8192). */
  readonly capacity?: number;
  /** Its rate level (default 0, the world's base rate). */
  readonly rate?: RateLevel;
}

const ORIGIN: Cell = [0, 0, 0];

/** The sea's foam, a framework solver. `id` is `'foam'` unless a world holds more. */
export class FoamSolver implements Solver<FoamParams> {
  private readonly id: string;
  private host!: SolverHost;
  private cell: Cell = ORIGIN;
  private field!: WaveSpectrumField;
  private friction: ((x: number, z: number) => number) | undefined;
  private nx = 0;
  private nz = 0;
  private h = 0;
  private x0 = 0;
  private z0 = 0;
  private g = 9.80665;
  private sx = 0;
  private sz = 0;
  private wind: Wind | undefined;
  private current: FlowField | undefined;
  private decay = SALT_FOAM_DECAY;
  private windDrift = 0.006;
  private rows: { spacing: number; speed: number; spinUp: number } | undefined;
  private ships: readonly FoamShip[] = [];
  private wakeRate = 1 / 150;
  private bubbles = true;
  private capacity = 0;
  private level: RateLevel = 0;
  private random = new RandomStream(0, 0);
  private foam!: Region;
  private breakers!: Region;
  private clock!: Region;
  private published!: Region;
  private spectrum: WaveSpectrumSample | undefined;
  private stats: BreakingStatistics[] = [];
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /** @param id The solver's id (default `'foam'`). */
  constructor(id = 'foam') {
    this.id = id;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: SEA_FOAM_FIELD, access: 'write' },
        // The air leaving damaged hulls, when a hull solver writes it.
        { field: HULL_BREACHES_FIELD, access: 'read', optional: true },
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  init(host: SolverHost, params: FoamParams): void {
    const waves = params?.waves;
    const field =
      waves && typeof (waves as WaveSpectrumField).sample === 'function'
        ? (waves as WaveSpectrumField)
        : (waves as { field?: WaveSpectrumField } | undefined)?.field;
    if (!field || typeof field.sample !== 'function')
      throw new TypeError(
        'Foam needs a sea: pass {waves}, a wave spectrum field (WaveSolver.field) or the WaveSolver itself.',
      );
    this.field = field;
    const solverLike = waves as { frictionVelocity?(x: number, z: number): number };
    this.friction =
      typeof solverLike.frictionVelocity === 'function' ? (x, z) => solverLike.frictionVelocity!(x, z) : undefined;
    const [nx, nz] = params.cells ?? [128, 128],
      h = params.cellSize ?? 2,
      [cx, cz] = params.centre ?? [0, 0];
    if (!(Number.isInteger(nx) && Number.isInteger(nz) && nx >= 1 && nz >= 1 && nx <= 4096 && nz <= 4096))
      throw new RangeError(`Foam cells are 1 to 4096 a side, whole numbers (got ${nx} by ${nz}); pass [nx, nz].`);
    if (!(h > 0 && Number.isFinite(h)))
      throw new RangeError(`A foam cell's size is a finite number of metres above 0 (got ${h}); pass one.`);
    const statistics = params.statistics ?? 64;
    if (!(statistics > 0 && Number.isFinite(statistics)))
      throw new RangeError(
        `The breaking statistics' spacing is a finite number of metres above 0 (got ${statistics}); pass one.`,
      );
    this.nx = nx;
    this.nz = nz;
    this.h = h;
    this.x0 = cx - (nx * h) / 2;
    this.z0 = cz - (nz * h) / 2;
    this.sx = Math.max(1, Math.ceil((nx * h) / statistics));
    this.sz = Math.max(1, Math.ceil((nz * h) / statistics));
    this.host = host;
    const [gx, gy, gz] = host.gravity;
    this.g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    this.wind = params.wind;
    this.current = params.current;
    this.spectrum = field.sample(cx, cz);
    const decay = params.decay ?? (this.spectrum.density < 1010 ? FRESH_FOAM_DECAY : SALT_FOAM_DECAY);
    if (!(decay > 0 && Number.isFinite(decay)))
      throw new RangeError(`Foam's decay time is a finite number of seconds above 0 (got ${decay}); pass one.`);
    this.decay = decay;
    const windDrift = params.windDrift ?? 0.006;
    if (!(windDrift >= 0 && windDrift < 0.1))
      throw new RangeError(`The wind drift is a share of U10 from 0 to 0.1 (got ${windDrift}); pass one, or 0.006.`);
    this.windDrift = windDrift;
    if (params.windrows !== false) {
      const { spacing = 30, speed = 0.01, spinUp = 300 } = params.windrows ?? {};
      if (!(spacing > 0 && speed >= 0 && speed < 0.1 && spinUp > 0) || ![spacing, speed, spinUp].every(Number.isFinite))
        throw new RangeError(
          `Windrows have a spacing above 0 m, a speed from 0 to 0.1 of U10 and a spin-up above 0 s (got ${spacing}, ${speed}, ${spinUp}); pass them, or false for none.`,
        );
      this.rows = { spacing, speed, spinUp };
    }
    this.ships = params.ships ?? [];
    for (const ship of this.ships) {
      if (!ship || (!ship.body && typeof ship.track !== 'function'))
        throw new TypeError('A ship is {body, length, beam} or {track(t), length, beam}; pass one of them.');
      if (!(ship.length > 0 && ship.beam > 0 && Number.isFinite(ship.length) && Number.isFinite(ship.beam)))
        throw new RangeError(
          `A ship's length and beam are finite metres above 0 (got ${ship.length} and ${ship.beam}); pass both.`,
        );
    }
    const persistence = params.wakePersistence ?? 150;
    if (!(persistence > 0 && Number.isFinite(persistence)))
      throw new RangeError(
        `Wake foam's persistence is a finite number of seconds above 0 (got ${persistence}); pass one.`,
      );
    this.wakeRate = 1 / persistence;
    this.bubbles = params.bubbles ?? true;
    const capacity = params.capacity ?? 8192;
    if (!(Number.isInteger(capacity) && capacity >= 1 && capacity <= 1 << 22))
      throw new RangeError(`A foam solver holds 1 to 4194304 breakers (got ${capacity}); pass a whole number.`);
    this.capacity = capacity;
    const rate = params.rate ?? 0;
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${rate}); pass one.`);
    this.level = rate as RateLevel;
    this.random = new RandomStream(0, solverNumber(this.id));
    const count = nx * nz;
    // Per cell: whiteness, then its decay rate times its whiteness (so mixed foam fades at its mean rate).
    this.foam = host.allocate('foam', count * 2 * 8, 'f64', SEA_FOAM_LAYOUT);
    this.breakers = host.allocate('breakers', capacity * BREAKER * 8, 'f64', SEA_FOAM_LAYOUT);
    // The live breakers' count and the windrows' age, s.
    this.clock = host.allocate('clock', 2 * 8, 'f64', SEA_FOAM_LAYOUT);
    this.published = host.allocate('published', count * 2 * 4, 'f32', SEA_FOAM_LAYOUT);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  step(context: StepContext, dt: number): void {
    if (this.random.seed !== context.seed) this.random = new RandomStream(context.seed, solverNumber(this.id));
    this.cell = context.cell;
    const time = context.tick / rateOf(context.level),
      foam = this.words(this.foam),
      clock = this.words(this.clock),
      { nx, nz } = this,
      n = nx * nz,
      active = new Float32Array(n);
    this.statistics();
    // The wind at the grid's centre: the windrows' direction and the wind drift.
    let ux = 0,
      uz = 0;
    if (this.wind) {
      const v = this.wind.sample(
        this.x0 + (nx * this.h) / 2,
        10,
        this.z0 + (nz * this.h) / 2,
        time,
        this.flow,
      ).velocity;
      ux = v[0];
      uz = v[2];
    }
    const u10 = Math.sqrt(ux * ux + uz * uz);
    clock[1] = u10 >= 3 ? clock[1]! + dt : 0;
    this.spawn(context.tick, dt);
    this.sweep(dt, foam, active);
    this.wakes(time, dt, foam);
    if (this.bubbles) this.boils(context, foam);
    this.transport(time, dt, foam, ux, uz, u10, clock[1]!);
    this.fade(dt, foam);
    const p = regionWords(this.host.memory, this.published) as Float32Array;
    for (let k = 0; k < n; k++) {
      const a = active[k]!,
        w = foam[2 * k]!;
      p[2 * k] = w > a ? w : a;
      p[2 * k + 1] = a;
    }
  }

  /** The breaking statistics at each statistics cell, from the sea's spectrum there now. */
  private statistics(): void {
    const { sx, sz } = this;
    for (let j = 0; j < sz; j++)
      for (let i = 0; i < sx; i++) {
        const x = this.x0 + (i + 0.5) * ((this.nx * this.h) / sx),
          z = this.z0 + (j + 0.5) * ((this.nz * this.h) / sz),
          spectrum = this.field.sample(x, z, this.spectrum),
          at = i + sx * j;
        this.spectrum = spectrum;
        this.stats[at] = breakingStatistics(spectrum, this.g, this.stats[at]);
      }
  }

  /** The statistics cell of (x, z). */
  private statsAt(x: number, z: number): BreakingStatistics {
    const wx = (this.nx * this.h) / this.sx,
      wz = (this.nz * this.h) / this.sz,
      i = Math.min(this.sx - 1, Math.max(0, Math.floor((x - this.x0) / wx))),
      j = Math.min(this.sz - 1, Math.max(0, Math.floor((z - this.z0) / wz)));
    return this.stats[i + this.sx * j]!;
  }

  /** New breakers this step: a Poisson draw per statistics cell and bin, at the rate the spectrum breaks there. */
  private spawn(tick: number, dt: number): void {
    const b = this.words(this.breakers),
      clock = this.words(this.clock),
      spectrum = this.spectrum!,
      { frequencies: fs, directions: ds } = spectrum,
      nf = fs.length,
      nd = ds.length,
      wx = (this.nx * this.h) / this.sx,
      wz = (this.nz * this.h) / this.sz;
    let live = clock[0]!,
      draw = 0;
    const uniform = (): [number, number] => this.random.unitF64(tick, draw++, 1);
    for (let s = 0; s < this.sx * this.sz; s++) {
      const stats = this.stats[s]!,
        si = s % this.sx,
        sj = (s - si) / this.sx;
      for (let bin = 0; bin < nf * nd; bin++) {
        if (!(stats.events[bin]! > 0)) continue;
        // Breakers born up to a sweep and a half crest beyond the grid's edges sweep in, as those of the grid sweep out.
        const reach = 0.95 * (TWO_PI / stats.wavenumbers[(bin - (bin % nd)) / nd]!),
          left = si === 0 ? reach : 0,
          right = si === this.sx - 1 ? reach : 0,
          below = sj === 0 ? reach : 0,
          above = sj === this.sz - 1 ? reach : 0,
          mean = stats.events[bin]! * (wx + left + right) * (wz + below + above) * dt;
        // Poisson by inversion of its distribution, one uniform number a draw (mean well under 1 per step and bin).
        let [u] = uniform(),
          count = 0,
          p = exp(-mean),
          sum = p;
        while (u > sum && count < 64) {
          count++;
          p *= mean / count;
          sum += p;
        }
        const i = (bin - (bin % nd)) / nd,
          k = stats.wavenumbers[i]!,
          lambda = TWO_PI / k,
          sigma = TWO_PI * fs[i]!,
          period = 1 / fs[i]!,
          c = sigma / k,
          theta = ds[bin % nd]!,
          residual = RESIDUAL * period,
          whiteness = residual / this.decay < 1 ? residual / this.decay : 1,
          persistence = residual / this.decay < 1 ? this.decay : residual;
        for (let e = 0; e < count; e++) {
          if (live >= this.capacity) break;
          const [r0, r1] = uniform(),
            at = live * BREAKER;
          b[at] = this.x0 + si * wx - left + r0 * (wx + left + right);
          b[at + 1] = this.z0 + sj * wz - below + r1 * (wz + below + above);
          b[at + 2] = cos(theta);
          b[at + 3] = sin(theta);
          b[at + 4] = c;
          b[at + 5] = (CREST_SHARE * lambda) / 2;
          b[at + 6] = (ACTIVE_DEPTH * lambda) / 2;
          b[at + 7] = 0;
          b[at + 8] = ACTIVE_PERIODS * period;
          b[at + 9] = whiteness;
          b[at + 10] = 1 / persistence;
          live++;
        }
      }
    }
    clock[0] = live;
  }

  /**
   * Moves the live breakers, marks the active whitecaps where their patches are, and leaves residual foam in the strip each
   * has just left behind (and under the whole patch when it ends), so the active stage and the residual one follow each
   * other; retires the finished breakers.
   */
  private sweep(dt: number, foam: Float64Array, active: Float32Array): void {
    const b = this.words(this.breakers),
      clock = this.words(this.clock);
    let live = clock[0]!,
      at = 0;
    while (at < live) {
      const o = at * BREAKER,
        dx = b[o + 2]!,
        dz = b[o + 3]!,
        half = b[o + 5]!,
        depth = b[o + 6]!,
        travel = b[o + 4]! * dt,
        x = b[o]! + dx * travel,
        z = b[o + 1]! + dz * travel,
        whiteness = b[o + 9]!,
        rate = b[o + 10]!,
        done = b[o + 7]! + dt >= b[o + 8]!;
      b[o] = x;
      b[o + 1] = z;
      b[o + 7] = b[o + 7]! + dt;
      this.patch(x, z, dx, dz, half, -depth - travel, depth, (k, along) => {
        if (along >= -depth) {
          active[k] = 1;
          if (!done) return;
        }
        deposit(foam, k, whiteness, rate);
      });
      if (done) {
        // Finished: the last live breaker takes its place.
        live--;
        if (at !== live) b.copyWithin(o, live * BREAKER, live * BREAKER + BREAKER);
        continue;
      }
      at++;
    }
    clock[0] = live;
  }

  /** Calls `visit(cell, along)` for each cell whose centre is within +-half across (dx, dz) and from `back` to `front` along it, from (x, z). */
  private patch(
    x: number,
    z: number,
    dx: number,
    dz: number,
    half: number,
    back: number,
    front: number,
    visit: (cell: number, along: number) => void,
  ): void {
    const { nx, nz, h } = this,
      reach = Math.max(-back, front),
      reachX = Math.abs(dz) * half + Math.abs(dx) * reach,
      reachZ = Math.abs(dx) * half + Math.abs(dz) * reach,
      i0 = Math.max(0, Math.floor((x - reachX - this.x0) / h)),
      i1 = Math.min(nx - 1, Math.floor((x + reachX - this.x0) / h)),
      j0 = Math.max(0, Math.floor((z - reachZ - this.z0) / h)),
      j1 = Math.min(nz - 1, Math.floor((z + reachZ - this.z0) / h));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = this.x0 + (i + 0.5) * h - x,
          pz = this.z0 + (j + 0.5) * h - z,
          along = px * dx + pz * dz,
          across = -px * dz + pz * dx;
        if (across < -half || across > half || along < back || along > front) continue;
        visit(i + nx * j, along);
      }
  }

  /**
   * The boils of the air escaping damaged hulls this step: each breach letting air out under the surface, its plume's
   * surface current whitening the water as a propeller race's does (`WASH_SPEED`), out to where it is a twentieth of it.
   */
  private boils(context: StepContext, foam: Float64Array): void {
    const port = context.inputs.get(HULL_BREACHES_FIELD.name);
    if (!port) return;
    const c = port.cell;
    if (c[0] !== this.cell[0] || c[1] !== this.cell[1] || c[2] !== this.cell[2])
      throw new MargoError(
        'state',
        `The hull breaches come from origin cell [${c.join(', ')}] and the foam steps in [${this.cell.join(', ')}]; step the hull solver and the foam in one cell.`,
      );
    const memory = port.region.memory ?? this.host.memory,
      rec = new Float64Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 8),
      count = Math.min(rec[0]!, Math.floor((rec.length - 1) / HULL_BREACH_WORDS));
    for (let k = 0; k < count; k++) {
      const r = 1 + k * HULL_BREACH_WORDS,
        gas = rec[r + 11]!,
        depth = rec[r + 14]!,
        area = rec[r + 8]!;
      if (!(gas > 0 && depth > 0 && area > 0)) continue;
      const plume = bubblePlume(depth, gas, { source: Math.sqrt(area / Math.PI), g: this.g }),
        whiteAt = (d: number) => Math.min(1, surfaceCurrent(plume, d).speed / WASH_SPEED);
      if (!(whiteAt(0) > 0.05)) continue;
      // Out to where the current is a twentieth of the wash's speed (it falls as 1 / r far out), by bisection.
      let lo = 2 * plume.radius,
        hi = lo;
      while (whiteAt(hi) > 0.05 && hi < 1e4) hi *= 2;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (whiteAt(mid) > 0.05) lo = mid;
        else hi = mid;
      }
      this.disk(foam, rec[r + 2]!, rec[r + 4]!, lo, whiteAt, this.wakeRate);
    }
  }

  /** Paints a round patch of foam about (x, z) out to `radius`, its whiteness `shape(r)` at r from the centre. */
  private disk(
    foam: Float64Array,
    x: number,
    z: number,
    radius: number,
    shape: (r: number) => number,
    rate: number,
  ): void {
    const { nx, nz, h } = this,
      i0 = Math.max(0, Math.floor((x - radius - this.x0) / h)),
      i1 = Math.min(nx - 1, Math.floor((x + radius - this.x0) / h)),
      j0 = Math.max(0, Math.floor((z - radius - this.z0) / h)),
      j1 = Math.min(nz - 1, Math.floor((z + radius - this.z0) / h));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = this.x0 + (i + 0.5) * h - x,
          pz = this.z0 + (j + 0.5) * h - z,
          d = Math.sqrt(px * px + pz * pz);
        if (d > radius) continue;
        const white = shape(d),
          k = i + nx * j;
        if (white > foam[2 * k]!) {
          foam[2 * k] = white;
          foam[2 * k + 1] = white * rate;
        }
      }
  }

  /** The ships' wake foam this step. */
  private wakes(time: number, _dt: number, foam: Float64Array): void {
    for (const ship of this.ships) {
      // The races' boil: white where a race breaks the surface, as fast as its water moves there, spreading and fading as
      // the established jet does (2.6 D / X): its whiteness falls as start / (start + s) along it.
      for (const patch of ship.wash?.(time) ?? []) {
        const white = Math.min(1, patch.speed / WASH_SPEED),
          { radius, reach } = patch;
        if (!(white > 0 && radius > 0 && reach > 0)) continue;
        this.paint(
          foam,
          patch.position[0],
          patch.position[1],
          patch.direction[0],
          patch.direction[1],
          reach,
          // The established jet's e-folding half width X / sqrt(22.2) = 0.212 X from where it surfaces, 4.71 radii out.
          (x) => [radius + 0.212 * x, (white * 4.71 * radius) / (4.71 * radius + x)],
          this.wakeRate,
        );
      }
      let px: number, pz: number, vx: number, vz: number;
      if (ship.body) {
        if (!ship.body.valid) continue;
        const p = ship.body.position,
          v = ship.body.linearVelocity;
        px = p[0];
        pz = p[2];
        vx = v[0];
        vz = v[2];
      } else {
        const t = ship.track!(time);
        [px, pz] = t.position;
        [vx, vz] = t.velocity;
      }
      const speed = Math.sqrt(vx * vx + vz * vz);
      if (!(speed > 0.2)) continue;
      const fx = vx / speed,
        fz = vz / speed,
        { length, beam } = ship,
        froude = speed / Math.sqrt(this.g * length),
        // Bow waves break from a Froude number of about 0.15 and fully by 0.4.
        bow = froude <= 0.15 ? 0 : froude >= 0.4 ? 1 : (froude - 0.15) / 0.25,
        stern = 1,
        rate = this.wakeRate;
      // Stern white water and the turbulent wake: from the stern aft one ship length, width beam (1 + x / L)^(1/5), whiteness
      // falling as the wake's turbulence does, (x / L + 0.07)^(-4/5) relative to the stern (Reed and Milgram 2002, eq. 26).
      const sternX = px - (fx * length) / 2,
        sternZ = pz - (fz * length) / 2;
      this.paint(
        foam,
        sternX,
        sternZ,
        -fx,
        -fz,
        length,
        (x) => {
          const white =
              x < 2 * beam ? stern : stern * Math.min(1, pow((x / length + 0.07) / ((2 * beam) / length + 0.07), -0.8)),
            half = (beam / 2) * pow(1 + x / length, 0.2);
          return [half, white];
        },
        rate,
      );
      // Bow arms at Kelvin's half-angle each side, half a ship length long, a quarter beam wide.
      if (bow > 0)
        for (const side of [-1, 1]) {
          const ax = fx * cos(KELVIN) - side * fz * sin(KELVIN),
            az = fz * cos(KELVIN) + side * fx * sin(KELVIN),
            bowX = px + (fx * length) / 2,
            bowZ = pz + (fz * length) / 2;
          this.paint(foam, bowX, bowZ, -ax, -az, length / 2, () => [beam / 8, 0.6 * bow], rate);
        }
    }
  }

  /** Whitens the strip from (x, z) along (dx, dz) for `reach` m; `shape(s)` gives its half width and whiteness at s. */
  private paint(
    foam: Float64Array,
    x: number,
    z: number,
    dx: number,
    dz: number,
    reach: number,
    shape: (s: number) => [number, number],
    rate: number,
  ): void {
    const { nx, nz, h } = this,
      [widest] = shape(reach),
      r = reach + widest,
      i0 = Math.max(0, Math.floor((x - r - this.x0) / h)),
      i1 = Math.min(nx - 1, Math.floor((x + r - this.x0) / h)),
      j0 = Math.max(0, Math.floor((z - r - this.z0) / h)),
      j1 = Math.min(nz - 1, Math.floor((z + r - this.z0) / h));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = this.x0 + (i + 0.5) * h - x,
          pz = this.z0 + (j + 0.5) * h - z,
          s = px * dx + pz * dz,
          across = Math.abs(-px * dz + pz * dx);
        if (s < 0 || s > reach) continue;
        const [half, white] = shape(s);
        if (across > half) continue;
        const k = i + nx * j;
        if (white > foam[2 * k]!) {
          foam[2 * k] = white;
          foam[2 * k + 1] = white * rate;
        }
      }
  }

  /** The surface velocity of the foam at (x, z): current, Stokes drift, wind drift and the windrows' convergence. */
  private velocity(
    x: number,
    z: number,
    time: number,
    ux: number,
    uz: number,
    u10: number,
    age: number,
  ): [number, number] {
    let vx = 0,
      vz = 0;
    if (this.current) {
      const v = this.current.sample(x, 0, z, time, this.flow).velocity;
      vx = v[0];
      vz = v[2];
    }
    const stokes = this.statsAt(x, z).stokes;
    vx += stokes[0] + this.windDrift * ux;
    vz += stokes[1] + this.windDrift * uz;
    if (this.rows && u10 >= 3) {
      // Cells of Langmuir circulation along the wind: at the surface the flow converges onto lines `spacing` apart, the
      // cross-wind speed -A sin(2 pi n / L), n across the wind.
      const ex = ux / u10,
        ez = uz / u10,
        n = -x * ez + z * ex,
        grow = 1 - exp(-age / this.rows.spinUp),
        amplitude = this.rows.speed * u10 * grow,
        across = -amplitude * sin((TWO_PI * n) / this.rows.spacing);
      vx += -ez * across;
      vz += ex * across;
    }
    return [vx, vz];
  }

  /** Carries the foam over `dt` in flux form, along x then z, with the MC-limited upwind face values; substeps keep the Courant number at 1/2. */
  private transport(
    time: number,
    dt: number,
    foam: Float64Array,
    ux: number,
    uz: number,
    u10: number,
    age: number,
  ): void {
    const { nx, nz, h } = this,
      n = nx * nz,
      // Face velocities: x faces (nx + 1 by nz), z faces (nx by nz + 1).
      fx = new Float64Array((nx + 1) * nz),
      fz = new Float64Array(nx * (nz + 1));
    let fastest = 0;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i <= nx; i++) {
        const [vx] = this.velocity(this.x0 + i * h, this.z0 + (j + 0.5) * h, time, ux, uz, u10, age);
        fx[i + (nx + 1) * j] = vx;
        if (Math.abs(vx) > fastest) fastest = Math.abs(vx);
      }
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i < nx; i++) {
        const [, vz] = this.velocity(this.x0 + (i + 0.5) * h, this.z0 + j * h, time, ux, uz, u10, age);
        fz[i + nx * j] = vz;
        if (Math.abs(vz) > fastest) fastest = Math.abs(vz);
      }
    if (!(fastest > 0)) return;
    const steps = Math.max(1, Math.ceil((2 * fastest * dt) / h)),
      sub = dt / steps,
      w = new Float64Array(n),
      q = new Float64Array(n);
    for (let s = 0; s < steps; s++) {
      for (let k = 0; k < n; k++) {
        w[k] = foam[2 * k]!;
        q[k] = foam[2 * k + 1]!;
      }
      this.advect(w, q, fx, true, sub);
      this.advect(w, q, fz, false, sub);
      for (let k = 0; k < n; k++) {
        const white = w[k]! > 0 ? w[k]! : 0;
        // Coverage is held at 1: foam piled beyond it thickens what is there.
        const scale = white > 1 ? 1 / white : 1;
        foam[2 * k] = white * scale;
        foam[2 * k + 1] = (q[k]! > 0 ? q[k]! : 0) * scale;
      }
    }
  }

  /** One direction of the flux-form transport of the whiteness `w` and its rate-weighted share `q` (they move together). */
  private advect(w: Float64Array, q: Float64Array, faces: Float64Array, alongX: boolean, dt: number): void {
    const { nx, nz, h } = this,
      along = alongX ? nx : nz,
      across = alongX ? nz : nx,
      wOld = w.slice(),
      qOld = q.slice(),
      at = (p: number, line: number): number => (alongX ? p + nx * line : line + nx * p),
      face = (p: number, line: number): number => (alongX ? faces[p + (nx + 1) * line]! : faces[line + nx * p]!),
      value = (field: Float64Array, p: number, line: number): number => (p < 0 || p >= along ? 0 : field[at(p, line)]!),
      mc = (a: number, b: number): number => {
        if (a * b <= 0) return 0;
        const m = Math.min(Math.abs(a + b) / 2, 2 * Math.abs(a), 2 * Math.abs(b));
        return a > 0 ? m : -m;
      };
    for (let line = 0; line < across; line++) {
      // The flux through face p (between cells p - 1 and p), the upwind cell's value extrapolated by its limited slope.
      let previousW = 0,
        previousQ = 0;
      for (let p = 0; p <= along; p++) {
        const u = face(p, line),
          c = (u * dt) / h,
          up = u >= 0 ? p - 1 : p,
          sign = u >= 0 ? 1 : -1,
          faceOf = (field: Float64Array): number => {
            const v = value(field, up, line),
              slope = mc(v - value(field, up - 1, line), value(field, up + 1, line) - v);
            return v + 0.5 * sign * (1 - Math.abs(c)) * slope;
          },
          fluxW = up < 0 || up >= along ? 0 : u * faceOf(wOld),
          fluxQ = up < 0 || up >= along ? 0 : u * faceOf(qOld);
        if (p > 0) {
          const k = at(p - 1, line);
          w[k] = wOld[k]! + (dt / h) * (previousW - fluxW);
          q[k] = qOld[k]! + (dt / h) * (previousQ - fluxQ);
        }
        previousW = fluxW;
        previousQ = fluxQ;
      }
    }
  }

  /** Fades the residual foam: each cell at its mean decay rate, the rate kept with the foam. */
  private fade(dt: number, foam: Float64Array): void {
    for (let k = 0; k < this.nx * this.nz; k++) {
      const w = foam[2 * k]!;
      if (!(w > 0)) continue;
      const rate = foam[2 * k + 1]! / w,
        f = exp(-rate * dt);
      foam[2 * k] = w * f;
      foam[2 * k + 1] = foam[2 * k + 1]! * f;
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: SEA_FOAM_FIELD.name, region: this.published, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [this.foam, this.breakers, this.clock];
  }

  extraState(): readonly Region[] {
    return [];
  }

  private cellOf(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.h),
      j = Math.floor((z - this.z0) / this.h);
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz ? i + this.nx * j : -1;
  }

  /**
   * Lays foam over the box from `min` to `max` [x, z] m: a splash, an impact, a breaking wave of another solver's. Its
   * `whiteness` (0 to 1, default 1) joins what is there as independent overlap, and fades with e-folding `persistence` s
   * (default the solver's residual decay). It shows from the next step.
   * @throws RangeError for a box that is not min below max, or a whiteness or persistence out of range.
   */
  addFoam(
    min: readonly [number, number],
    max: readonly [number, number],
    whiteness = 1,
    persistence = this.decay,
  ): void {
    if (!(min?.length === 2 && max?.length === 2 && min[0] < max[0] && min[1] < max[1]))
      throw new RangeError('Foam goes in a box [x, z] from min to max, min below max on both axes; pass two corners.');
    if (!(whiteness >= 0 && whiteness <= 1))
      throw new RangeError(`Foam's whiteness is 0 to 1 (got ${whiteness}); pass one.`);
    if (!(persistence > 0 && Number.isFinite(persistence)))
      throw new RangeError(`Foam's persistence is a finite number of seconds above 0 (got ${persistence}); pass one.`);
    const foam = this.words(this.foam),
      { nx, nz, h } = this,
      i0 = Math.max(0, Math.ceil((min[0] - this.x0) / h - 0.5)),
      i1 = Math.min(nx - 1, Math.floor((max[0] - this.x0) / h - 0.5)),
      j0 = Math.max(0, Math.ceil((min[1] - this.z0) / h - 0.5)),
      j1 = Math.min(nz - 1, Math.floor((max[1] - this.z0) / h - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) deposit(foam, i + nx * j, whiteness, 1 / persistence);
  }

  /** The foam coverage at (x, z), 0 to 1 (active whitecaps included); 0 off the grid. */
  coverage(x: number, z: number): number {
    const k = this.cellOf(x, z);
    return k < 0 ? 0 : (regionWords(this.host.memory, this.published) as Float32Array)[2 * k]!;
  }

  /** The active whitecap coverage at (x, z), 0 or 1 in a cell a breaker crosses now. */
  activeCoverage(x: number, z: number): number {
    const k = this.cellOf(x, z);
    return k < 0 ? 0 : (regionWords(this.host.memory, this.published) as Float32Array)[2 * k + 1]!;
  }

  /** The mean foam coverage over the grid, 0 to 1. */
  meanCoverage(): number {
    const p = regionWords(this.host.memory, this.published) as Float32Array;
    let sum = 0;
    for (let k = 0; k < this.nx * this.nz; k++) sum += p[2 * k]!;
    return sum / (this.nx * this.nz);
  }

  /** The whitecap coverage the sea's breakers give at (x, z) on average (Leckler et al.), 0 to 1. */
  expectedCoverage(x: number, z: number): number {
    return this.statsAt(x, z).coverage;
  }

  /** The breakers alive now. */
  get breakerCount(): number {
    return this.words(this.clock)[0]!;
  }

  /**
   * Spray into the air at (x, z): droplets per m^2 per s per micrometre of r80 at `r80` micrometres, the film and jet drops
   * of the foam there (Gong 2003 by the whitecap method).
   */
  spray(x: number, z: number, r80: number): number {
    return sprayFlux(this.coverage(x, z), r80);
  }

  /** Bag-breakup spume events per m^2 per s at (x, z) (Troitskaya et al. 2017), from the waves' friction velocity. */
  bagBreakups(x: number, z: number): number {
    return this.friction ? bagBreakups(this.friction(x, z)) : 0;
  }
}

/**
 * Lays foam of whiteness `white` fading at `rate` on cell k, over what is there as independent overlap, 1 - (1 - w)(1 - white),
 * the added share carrying its own rate.
 */
function deposit(foam: Float64Array, k: number, white: number, rate: number): void {
  const w = foam[2 * k]!,
    added = white * (1 - w);
  if (!(added > 0)) return;
  foam[2 * k] = w + added;
  foam[2 * k + 1] = foam[2 * k + 1]! + added * rate;
}
