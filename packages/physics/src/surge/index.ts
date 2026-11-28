// Tides, storm surge and the currents they drive (SEA-07 of docs/physics-solvers.md), over the shallow water of HYDRO-01. The
// air's pressure and the Sun's and Moon's pull both act on the water as the gradient of a height: the inverse barometer
// (p - p_ref) / (rho g), a centimetre a hectopascal, and the equilibrium tide gamma_2 U / g of the tide-generating potential U.
// `SurgeSolver` sums them into one forcing potential per cell, which the shallow water adds to its bed in its hydrostatic
// reconstruction, so a lake under a still pressure dome stands at the inverse barometer to rounding; the wind's stress, the
// Coriolis force and the bed's friction are the shallow water's own. At an open sea, `tidalLevel` gives the tide coming in from
// its harmonic constituents.
//
// Written from (papers and public documentation only; no code of ADCIRC, SLOSH, Delft3D, FVCOM, ROMS or any tide model read):
// - R. A. Luettich and J. J. Westerink, "Formulation and numerical implementation of the 2D/3D ADCIRC finite element model
//   version 44.XX", 2004 (eqs. 2.2 to 2.6, read): the depth-integrated momentum with -g H grad(zeta + P_s / (g rho_0) - alpha
//   eta), the tide, the air's pressure and the surface as one gradient.
// - C. P. Jelesnianski, J. Chen and W. A. Shaffer, "SLOSH: Sea, Lake, and Overland Surges from Hurricanes", NOAA Technical
//   Report NWS 48, 1992 (sections 1 to 4, read): the hydrostatic (inverse-barometer) height and its use at an open sea.
// - The degree-2 tide-generating potential and its equilibrium tide: R. H. Stewart, "Introduction to Physical Oceanography",
//   chapter 17 (read); the potential itself is the celestial solver's (`@margoengine/physics/space`, SPACE-02).
// - The Love numbers' reduction gamma_2 = 1 + k_2 - h_2 = 0.693 (IERS Conventions 2010, Petit and Luzum eds., IERS Technical
//   Note 36, chapters 6 and 7, as secondary sources quote k_2 = 0.30102 and h_2 = 0.6078).
// - The constituents' periods: Apel (1987) as Stewart tabulates them (read).
// - E. Audusse, F. Bouchut, M.-O. Bristeau, R. Klein and B. Perthame, SIAM J. Sci. Comput. 25, 2004: a potential added to the
//   bed of the hydrostatic reconstruction is balanced as the bed is.
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { cos, exp, sin } from '@margoengine/math/pinned';
import type { BedShape } from '../earth/bed.js';
import { DRY, SURFACE_WATER_POTENTIAL_FIELD, type ShallowWaterSolver, type WaterSample } from '../hydro/index.js';
import { type GeodeticSite, localHorizon, tidalDrive } from '../space/effects.js';
import { TIDAL_POTENTIAL_FIELD } from '../space/solver.js';
import { regionWords } from '../world/memory.js';
import {
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { surgeError } from './errors.js';
import {
  loadSurgePotential,
  type SurgePotentialBuild,
  type SurgePotentialKernel,
  type SurgePotentialWorkCounts,
} from './potential-kernel.js';

export type { SurgePotentialWorkerWork, SurgePotentialWorkCounts } from './potential-kernel.js';

const TWO_PI = 6.283185307179586;
type TideBody = readonly [number, number, number];
type TideBodies = readonly [sun: TideBody, moon: TideBody];

function finiteSurge(value: number): number {
  if (!Number.isFinite(value))
    throw surgeError(
      'failed',
      'The surge potential exceeds numeric range; reduce extreme forcing or fix the water density and gravity.',
    );
  return value;
}

function readTideBodies(memory: WebAssembly.Memory, port: Port): TideBodies {
  const region = port.region;
  const source = region.memory ?? memory;
  if (
    port.field !== TIDAL_POTENTIAL_FIELD.name ||
    region.layout !== 1 ||
    region.type !== 'f64' ||
    region.byteLength !== 48 ||
    !Number.isSafeInteger(region.byteOffset) ||
    region.byteOffset < 0 ||
    region.byteOffset % 8 !== 0 ||
    region.byteOffset + 48 > source.buffer.byteLength
  )
    throw surgeError(
      'version',
      'The tide input must be the six-word layout 1 celestial position port; attach a matching CelestialSolver.',
    );
  const words = regionWords(source, region) as Float64Array;
  const sun: TideBody = [words[0]!, words[1]!, words[2]!];
  const moon: TideBody = [words[3]!, words[4]!, words[5]!];
  for (const [x, y, z] of [sun, moon]) {
    const radiusSquared = x * x + y * y + z * z;
    if (!(radiusSquared > 0 && Number.isFinite(radiusSquared)))
      throw surgeError(
        'unsupported',
        'The Sun and Moon positions need finite nonzero Earth-fixed metres; fix the celestial ephemeris.',
      );
  }
  return [sun, moon];
}
/** The Love numbers' reduction of the equilibrium tide, 1 + k_2 - h_2 (semidiurnal; IERS Conventions 2010). */
export const TIDE_LOVE_FACTOR = 0.693;
/** A standard atmosphere at sea level, Pa. */
export const STANDARD_PRESSURE = 101325;
/** The layout of the surge's regions. */
export const SURGE_LAYOUT = 1;

/** The world's site: where on the Earth its origin lies, and which way north is. */
export interface SurgeSite extends GeodeticSite {
  /** North on the ground plane, radians from -Z toward +X (default 0: north -Z, east +X). */
  readonly north?: number;
}

/** What a {@link SurgeSolver} is made from. */
export interface SurgeParams {
  /** The shallow water it forces, added to the world first. */
  readonly water: ShallowWaterSolver;
  /** The air's pressure at the water at (x, z) and the water's time t, Pa (default none: no inverse barometer). */
  readonly pressure?: (x: number, z: number, time: number) => number;
  /**
   * The pressure the water is level under, Pa (default the mean over the wet water each step, so only the pressure's
   * differences move water and a closed lake keeps its mean level; pass 101325 for a sea whose open side is held).
   */
  readonly reference?: number;
  /** Where the world's origin lies on the Earth (latitude and longitude in radians), for the tide. */
  readonly site?: SurgeSite;
  /** The Love numbers' reduction gamma_2 of the equilibrium tide (default 0.693). */
  readonly love?: number;
  /**
   * Seconds of the water's time over which the tide and the pressure grow from nothing at the start, tanh-shaped (default 0:
   * at once).
   */
  readonly ramp?: number;
  /** Its rate level (default 0, the world's base rate). */
  readonly rate?: RateLevel;
}

/** Options of a {@link SurgeSolver}'s construction. */
export interface SurgeOptions {
  /** Read the world's tide (`tidalPotential` of a `CelestialSolver`) and force the water with it (default false). */
  readonly tide?: boolean;
}

/** Optional native tide and pressure evaluation settings. */
export interface SurgeNativeOptions {
  /** Native participants including the caller, default 1. Use Node or an isolated browser worker for 2 or 4. */
  readonly threads?: 1 | 2 | 4;
  /** Cancels loading and releases native helpers on abort. */
  readonly signal?: AbortSignal;
}

/**
 * Storm surge and tides on a `ShallowWaterSolver`: the inverse barometer of the air's pressure and the equilibrium tide of the
 * world's Sun and Moon, as one forcing potential the water adds to its bed. Couple it before the water.
 */
export class SurgeSolver implements Solver<SurgeParams> {
  private readonly id: string;
  private readonly tide: boolean;
  private host!: SolverHost;
  private water!: ShallowWaterSolver;
  private initialized = false;
  private disposed = false;
  private nativeBuild: SurgePotentialBuild | undefined;
  private native: SurgePotentialKernel | undefined;
  private nativeWork: SurgePotentialWorkCounts | undefined;
  private stepping = false;
  private sampledWater: WaterSample = { depth: 0, surface: 0, velocity: [0, 0] };
  private level: RateLevel = 0;
  private nx = 0;
  private nz = 0;
  private dx = 0;
  private dz = 0;
  private x0 = 0;
  private z0 = 0;
  private g = 0;
  private density = 1000;
  private pressure: SurgeParams['pressure'];
  private reference: number | undefined;
  private love = TIDE_LOVE_FACTOR;
  private ramp = 0;
  /** Each cell's Earth-fixed position, m (for the tide). */
  private positions: Float64Array | undefined;
  private potential!: Region;
  private parts!: Region;
  private wet!: Uint8Array;
  private nextPotential!: Float64Array;
  private nextParts!: Float64Array;

  /**
   * @param id The solver's id (default `'surge'`).
   * @param options `{tide: true}` to read the world's tide (add a `CelestialSolver` to the world).
   */
  constructor(id = 'surge', options: SurgeOptions = {}) {
    this.id = id;
    this.tide = options?.tide === true;
  }

  /** Load optional native pressure and celestial potential evaluation before adding the surge to its world. */
  static async load(id = 'surge', options: SurgeOptions = {}, native: SurgeNativeOptions = {}): Promise<SurgeSolver> {
    const solver = new SurgeSolver(id, options);
    solver.nativeBuild = await loadSurgePotential(native);
    return solver;
  }

  /** Native work from the last accepted surge step. */
  readNativeWork(): SurgePotentialWorkCounts | undefined {
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
      fields: [
        { field: SURFACE_WATER_POTENTIAL_FIELD, access: 'accumulate' },
        ...(this.tide ? [{ field: TIDAL_POTENTIAL_FIELD, access: 'read' as const }] : []),
      ],
      rate: this.level,
      stableRate: () => this.level,
      // The water's: the surge is part of it.
      timeScale: () => (this.water ? this.water.timeScale : 1),
    };
  }

  init(host: SolverHost, params: SurgeParams): void {
    if (this.disposed) throw surgeError('disposed', 'The surge solver was disposed; create or load a new solver.');
    if (this.initialized)
      throw surgeError('attached', 'The surge solver already belongs to a world; create a new solver.');
    const { water } = params ?? ({} as SurgeParams);
    if (!water || typeof water.sample !== 'function')
      throw surgeError(
        'unsupported',
        'A surge forces a shallow water: pass {water}, a ShallowWaterSolver added to the world first.',
      );
    const shape: BedShape = water.shape;
    if (
      !(
        shape?.columns > 0 &&
        Number.isSafeInteger(shape.columns) &&
        shape.rows > 0 &&
        Number.isSafeInteger(shape.rows) &&
        shape.width > 0 &&
        shape.depth > 0 &&
        shape.centre?.length === 2 &&
        [shape.width, shape.depth, ...shape.centre].every(Number.isFinite)
      )
    )
      throw surgeError(
        'unsupported',
        'Surge needs a valid local shallow-water grid; add its water to the world first.',
      );
    this.water = water;
    this.host = host;
    const [gx, gy, gz] = host.gravity;
    this.g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    this.density = water.waterDensity;
    if (!(this.g > 0 && this.density > 0 && this.g * this.density > 0 && Number.isFinite(this.g * this.density)))
      throw surgeError(
        'unsupported',
        'Surge needs finite positive gravity and water density; set the world gravity and shallow-water density.',
      );
    this.nx = shape.columns;
    this.nz = shape.rows;
    this.dx = shape.width / shape.columns;
    this.dz = shape.depth / shape.rows;
    this.x0 = shape.centre[0] - shape.width / 2;
    this.z0 = shape.centre[1] - shape.depth / 2;
    if (
      !(
        this.dx > 0 &&
        this.dz > 0 &&
        [this.x0, this.z0, this.x0 + shape.width, this.z0 + shape.depth].every(Number.isFinite)
      )
    )
      throw surgeError(
        'unsupported',
        'The surge grid cannot resolve its local coordinates; use finite cell dimensions and centre.',
      );
    const { pressure, reference, love = TIDE_LOVE_FACTOR, ramp = 0, rate = 0, site } = params;
    if (pressure !== undefined && typeof pressure !== 'function')
      throw surgeError('unsupported', "The air's pressure is a function of (x, z, time) giving Pa; pass one, or none.");
    if (reference !== undefined && !(reference > 0 && Number.isFinite(reference)))
      throw surgeError(
        'unsupported',
        `A reference pressure is finite Pa above 0 (got ${reference}); pass one such as 101325, or none.`,
      );
    if (!(love > 0 && love <= 1))
      throw surgeError(
        'unsupported',
        `The Love numbers' reduction lies in (0, 1] (got ${love}); pass one, or leave it for 0.693.`,
      );
    if (!(ramp >= 0 && Number.isFinite(ramp)))
      throw surgeError(
        'unsupported',
        `A ramp is finite seconds, 0 or more (got ${ramp}); pass one, or leave it for 0.`,
      );
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw surgeError('unsupported', `A rate level is a whole number from 0 to 7 (got ${rate}); pass one.`);
    this.pressure = pressure;
    this.reference = reference;
    this.love = love;
    this.ramp = ramp;
    this.level = rate as RateLevel;
    const count = this.nx * this.nz;
    if (this.tide) {
      if (!site)
        throw surgeError(
          'unsupported',
          'A tide needs the place on the Earth: pass {site: {latitude, longitude}} in radians, where the world origin lies.',
        );
      const north = site.north ?? 0;
      if (!Number.isFinite(north))
        throw surgeError(
          'unsupported',
          `North is finite radians from -Z toward +X (got ${north}); pass one, or leave it for 0.`,
        );
      const frame = this.geodeticFrame(site),
        radius = Math.sqrt(
          frame.position[0] * frame.position[0] +
            frame.position[1] * frame.position[1] +
            frame.position[2] * frame.position[2],
        ),
        cn = cos(north),
        sn = sin(north);
      this.positions = new Float64Array(3 * count);
      for (let j = 0; j < this.nz; j++)
        for (let i = 0; i < this.nx; i++) {
          const x = this.x0 + (i + 0.5) * this.dx,
            z = this.z0 + (j + 0.5) * this.dz,
            east = x * cn + z * sn,
            up = x * sn - z * cn,
            k = 3 * (i + this.nx * j);
          let length = 0;
          for (let a = 0; a < 3; a++) {
            const v = frame.position[a]! + east * frame.east[a]! + up * frame.north[a]!;
            this.positions[k + a] = v;
            length += v * v;
          }
          // Back down onto the sphere through the site, so a lake's far shore is not tens of kilometres up.
          if (!(length > 0 && Number.isFinite(length) && radius > 0 && Number.isFinite(radius)))
            throw surgeError(
              'unsupported',
              'The Earth-fixed surge grid exceeds numeric range; use a resolved local grid and geodetic site.',
            );
          const scale = radius / Math.sqrt(length);
          for (let a = 0; a < 3; a++) this.positions[k + a]! *= scale;
        }
    }
    this.potential = host.allocate('potential', count * 8, 'f64', SURGE_LAYOUT);
    this.parts = host.allocate('parts', 2 * count * 8, 'f64', SURGE_LAYOUT);
    this.wet = new Uint8Array(count);
    this.nextPotential = new Float64Array(count);
    this.nextParts = new Float64Array(2 * count);
    this.native = this.nativeBuild?.bind(count, this.positions);
    this.initialized = true;
  }

  private geodeticFrame(site: SurgeSite): ReturnType<typeof localHorizon> {
    try {
      return localHorizon(site);
    } catch (cause) {
      if (!(cause instanceof RangeError)) throw cause;
      throw surgeError(
        'unsupported',
        'A surge tide needs a valid WGS 84 latitude, longitude and height; set the geodetic site in radians and metres.',
        cause,
      );
    }
  }

  private checkInitialized(): void {
    if (this.disposed) throw surgeError('disposed', 'The surge solver was disposed; create or load a new solver.');
    if (!this.initialized)
      throw surgeError('state', 'The surge grid is not initialized; add its water and then the surge solver.');
  }

  step(context: StepContext, _dt: number): void {
    this.checkInitialized();
    if (!(_dt > 0 && Number.isFinite(_dt)))
      throw surgeError(
        'unsupported',
        'A surge step needs finite seconds above zero; advance it through the world clock.',
      );
    if (this.stepping)
      throw surgeError(
        'state',
        'The surge step is already running; read the previous accepted surface without advancing again.',
      );
    this.stepping = true;
    try {
      this.advance(context);
    } finally {
      this.stepping = false;
    }
  }

  private advance(context: StepContext): void {
    // The water's time: pressure and ramp are the water's inputs, while the tide is a world field.
    const time = finiteSurge((context.tick / rateOf(context.level)) * this.water.timeScale),
      port = this.tide ? context.inputs.get(TIDAL_POTENTIAL_FIELD.name) : undefined,
      bodies = port ? readTideBodies(this.host.memory, port) : undefined,
      { nx, nz, wet, nextParts, nextPotential } = this,
      grow = this.ramp > 0 ? tanhOf(time / this.ramp) : 1;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const cell = i + nx * j,
          x = this.x0 + (i + 0.5) * this.dx,
          z = this.z0 + (j + 0.5) * this.dz,
          depth = this.water.sample(x, z, this.sampledWater)?.depth;
        if (!(depth >= 0 && Number.isFinite(depth)))
          throw surgeError('unsupported', 'The water returned an invalid depth; supply finite nonnegative metres.');
        wet[cell] = Number(depth > DRY);
        const p = this.pressure ? this.pressure(x, z, time) : 0;
        if (!(p >= 0 && Number.isFinite(p)))
          throw surgeError(
            'unsupported',
            `The air's pressure at (${x}, ${z}) at ${time} s is ${p}; return Pa as a finite nonnegative value.`,
          );
        nextParts[2 * cell] = p;
        nextParts[2 * cell + 1] = 0;
      }
    if (this.native) {
      const bodyWords = bodies ? Float64Array.of(...bodies[0], ...bodies[1]) : undefined;
      this.native.apply(
        nextParts,
        wet,
        bodyWords,
        {
          hasPressure: this.pressure !== undefined,
          reference: this.reference,
          rhoG: this.density * this.g,
          gravity: this.g,
          love: this.love,
          grow,
        },
        nextPotential,
      );
    } else {
      if (bodies && this.positions) this.tideParts(bodies, this.positions, nextParts);
      this.composePotential(grow, bodies !== undefined, wet, nextParts, nextPotential);
    }
    (regionWords(this.host.memory, this.parts) as Float64Array).set(nextParts);
    (regionWords(this.host.memory, this.potential) as Float64Array).set(nextPotential);
    if (this.native) this.nativeWork = this.native.workCounts();
  }

  private tideParts([sun, moon]: TideBodies, positions: Float64Array, out: Float64Array): void {
    for (let k = 0; k < positions.length / 3; k++) {
      const at = 3 * k;
      try {
        out[2 * k + 1] = finiteSurge(
          tidalDrive(sun, moon, [positions[at]!, positions[at + 1]!, positions[at + 2]!]).potential,
        );
      } catch (cause) {
        if (!(cause instanceof RangeError)) throw cause;
        throw surgeError(
          'unsupported',
          'An Earth-fixed sample is singular at a tide source; use a valid site and celestial ephemeris.',
          cause,
        );
      }
    }
  }

  private composePotential(
    grow: number,
    tideActive: boolean,
    wet: Uint8Array,
    parts: Float64Array,
    psi: Float64Array,
  ): void {
    let wetCount = 0,
      pressureSum = 0,
      tideSum = 0;
    for (let k = 0; k < wet.length; k++)
      if (wet[k]) {
        wetCount++;
        pressureSum += parts[2 * k]!;
        tideSum += parts[2 * k + 1]!;
      }
    finiteSurge(pressureSum);
    finiteSurge(tideSum);
    const pMean = wetCount ? pressureSum / wetCount : 0,
      uMean = wetCount ? tideSum / wetCount : 0,
      pRef = this.reference ?? pMean,
      rhoG = this.density * this.g;
    for (let k = 0; k < psi.length; k++) {
      // The water stands at minus psi in static equilibrium.
      const barometer = this.pressure ? (parts[2 * k]! - pRef) / rhoG : 0,
        tide = tideActive ? (-this.love * (parts[2 * k + 1]! - uMean)) / this.g : 0;
      psi[k] = finiteSurge(grow * (barometer + tide));
    }
  }

  /** The forcing potential at (x, z) from the last step, m: where the water stands at rest, it stands at minus this. */
  potentialAt(x: number, z: number): number {
    this.checkInitialized();
    if (!(Number.isFinite(x) && Number.isFinite(z)))
      throw surgeError('unsupported', 'Surge queries need finite local coordinates; pass x and z in metres.');
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.dx))),
      j = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.dz)));
    return (regionWords(this.host.memory, this.potential) as Float64Array)[i + this.nx * j]!;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: SURFACE_WATER_POTENTIAL_FIELD.name, region: this.potential, tick, cell: this.host.cell }];
  }

  stateRegions(): readonly Region[] {
    return [];
  }

  extraState(): readonly Region[] {
    return [this.potential, this.parts];
  }
}

/** A tidal constituent: its amplitude, m, its speed (rad/s) or name, and its phase at the world's time 0, rad. */
export interface TidalConstituent {
  readonly amplitude: number;
  /** A constituent's name from {@link TIDAL_CONSTITUENTS}, or its speed in rad/s. */
  readonly speed: keyof typeof TIDAL_CONSTITUENTS | number;
  /** The phase at time 0, rad: the level is amplitude cos(speed t + phase) (default 0). */
  readonly phase?: number;
}

/**
 * The periods of the main tidal constituents, s (Apel 1987, as Stewart tabulates them): semidiurnal M2, S2, N2, K2, diurnal
 * K1, O1, P1, Q1, long-period Mf and Mm.
 */
export const TIDAL_CONSTITUENTS = Object.freeze({
  M2: 12.4206012 * 3600,
  S2: 12 * 3600,
  N2: 12.6583475 * 3600,
  K2: 11.9672361 * 3600,
  K1: 23.9344697 * 3600,
  O1: 25.8193417 * 3600,
  P1: 24.0658901 * 3600,
  Q1: 26.86835 * 3600,
  Mf: 327.85 * 3600,
  Mm: 661.31 * 3600,
});

/**
 * The tide at an open sea from its harmonic constituents (amplitudes and phases from a gauge or published tables), as a
 * level over time for a shallow water's `{sea}` side: `sides: {minX: {sea: tidalLevel([{amplitude: 1.2, speed: 'M2'}])}}`.
 * `mean` is the mean level, m (default 0); `ramp`, seconds over which the tide grows from the mean, tanh-shaped (default 0).
 */
export function tidalLevel(
  constituents: readonly TidalConstituent[],
  options: { readonly mean?: number; readonly ramp?: number } = {},
): (time: number) => number {
  if (!Array.isArray(constituents) || constituents.length === 0)
    throw surgeError('unsupported', 'A tide is a list of constituents {amplitude, speed, phase}; pass at least one.');
  const { mean = 0, ramp = 0 } = options;
  if (!Number.isFinite(mean) || !(ramp >= 0 && Number.isFinite(ramp)))
    throw surgeError(
      'unsupported',
      `A tide's mean must be finite metres and its ramp finite seconds, 0 or more (got ${mean}, ${ramp}); pass those values.`,
    );
  const lines = constituents.map((c) => {
    const period =
        typeof c?.speed === 'string' ? TIDAL_CONSTITUENTS[c.speed as keyof typeof TIDAL_CONSTITUENTS] : undefined,
      speed = typeof c?.speed === 'number' ? c.speed : period ? TWO_PI / period : Number.NaN,
      phase = c?.phase ?? 0;
    if (!(Number.isFinite(c?.amplitude) && speed > 0 && Number.isFinite(speed) && Number.isFinite(phase)))
      throw surgeError(
        'unsupported',
        `A constituent is {amplitude in m, speed in rad/s above 0 or a name (${Object.keys(TIDAL_CONSTITUENTS).join(', ')}), phase in rad}; pass a supported constituent.`,
      );
    return { amplitude: c.amplitude, speed, phase };
  });
  return (time: number) => {
    let level = 0;
    if (!Number.isFinite(time))
      throw surgeError('unsupported', 'A tidal boundary needs finite seconds; sample it on the water clock.');
    for (const { amplitude, speed, phase } of lines) level += amplitude * cos(finiteSurge(speed * time + phase));
    return finiteSurge(mean + (ramp > 0 ? tanhOf(time / ramp) : 1) * level);
  };
}

/** The inverse barometer: the water's rise under a pressure `drop` Pa below the reference, m (about 1 cm per hPa). */
export function inverseBarometer(drop: number, density = 1025, gravity = gravityMagnitude(DEFAULT_GRAVITY)): number {
  if (
    !(
      Number.isFinite(drop) &&
      density > 0 &&
      gravity > 0 &&
      density * gravity > 0 &&
      Number.isFinite(density * gravity)
    )
  )
    throw surgeError(
      'unsupported',
      'The inverse barometer needs a finite pressure drop, positive density and gravity; pass Pa, kg/m³ and m/s².',
    );
  return finiteSurge(drop / (density * gravity));
}

function tanhOf(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e = exp(2 * x);
  return (e - 1) / (e + 1);
}
