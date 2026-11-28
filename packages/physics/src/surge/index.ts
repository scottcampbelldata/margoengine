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
import { DRY, SURFACE_WATER_POTENTIAL_FIELD, type ShallowWaterSolver } from '../hydro/index.js';
import { type GeodeticSite, localHorizon } from '../space/effects.js';
import { TIDAL_POTENTIAL_FIELD, tideFromPort } from '../space/solver.js';
import { regionWords } from '../world/memory.js';
import {
  type Cell,
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';

const TWO_PI = 6.283185307179586;
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

/**
 * Storm surge and tides on a `ShallowWaterSolver`: the inverse barometer of the air's pressure and the equilibrium tide of the
 * world's Sun and Moon, as one forcing potential the water adds to its bed. Couple it before the water.
 */
export class SurgeSolver implements Solver<SurgeParams> {
  private readonly id: string;
  private readonly tide: boolean;
  private host!: SolverHost;
  private water!: ShallowWaterSolver;
  private cell: Cell = [0, 0, 0];
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

  /**
   * @param id The solver's id (default `'surge'`).
   * @param options `{tide: true}` to read the world's tide (add a `CelestialSolver` to the world).
   */
  constructor(id = 'surge', options: SurgeOptions = {}) {
    this.id = id;
    this.tide = options?.tide === true;
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
    const { water } = params ?? ({} as SurgeParams);
    if (!water || typeof water.sample !== 'function')
      throw new TypeError(
        'A surge forces a shallow water: pass {water}, a ShallowWaterSolver added to the world first.',
      );
    const shape: BedShape = water.shape;
    this.water = water;
    this.host = host;
    const [gx, gy, gz] = host.gravity;
    this.g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    this.density = water.waterDensity;
    this.nx = shape.columns;
    this.nz = shape.rows;
    this.dx = shape.width / shape.columns;
    this.dz = shape.depth / shape.rows;
    this.x0 = shape.centre[0] - shape.width / 2;
    this.z0 = shape.centre[1] - shape.depth / 2;
    const { pressure, reference, love = TIDE_LOVE_FACTOR, ramp = 0, rate = 0, site } = params;
    if (pressure !== undefined && typeof pressure !== 'function')
      throw new TypeError("The air's pressure is a function of (x, z, time) giving Pa; pass one, or none.");
    if (reference !== undefined && !(reference > 0 && Number.isFinite(reference)))
      throw new RangeError(
        `A reference pressure is finite Pa above 0 (got ${reference}); pass one such as 101325, or none.`,
      );
    if (!(love > 0 && love <= 1))
      throw new RangeError(
        `The Love numbers' reduction lies in (0, 1] (got ${love}); pass one, or leave it for 0.693.`,
      );
    if (!(ramp >= 0 && Number.isFinite(ramp)))
      throw new RangeError(`A ramp is finite seconds, 0 or more (got ${ramp}); pass one, or leave it for 0.`);
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${rate}); pass one.`);
    this.pressure = pressure;
    this.reference = reference;
    this.love = love;
    this.ramp = ramp;
    this.level = rate as RateLevel;
    const count = this.nx * this.nz;
    if (this.tide) {
      if (!site)
        throw new TypeError(
          'A tide needs the place on the Earth: pass {site: {latitude, longitude}} in radians, where the world origin lies.',
        );
      const north = site.north ?? 0;
      if (!Number.isFinite(north))
        throw new RangeError(`North is finite radians from -Z toward +X (got ${north}); pass one, or leave it for 0.`);
      const frame = localHorizon(site),
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
          const scale = radius / Math.sqrt(length);
          for (let a = 0; a < 3; a++) this.positions[k + a]! *= scale;
        }
    }
    this.potential = host.allocate('potential', count * 8, 'f64', SURGE_LAYOUT);
    this.parts = host.allocate('parts', 2 * count * 8, 'f64', SURGE_LAYOUT);
  }

  step(context: StepContext, _dt: number): void {
    this.cell = context.cell;
    // The water's time: the pressure and the ramp are the water's inputs (the tide, a field, is the world's).
    const time = (context.tick / rateOf(context.level)) * this.water.timeScale,
      { nx, nz } = this,
      count = nx * nz,
      psi = regionWords(this.host.memory, this.potential) as Float64Array,
      parts = regionWords(this.host.memory, this.parts) as Float64Array,
      wet = new Uint8Array(count),
      port = this.tide ? context.inputs.get(TIDAL_POTENTIAL_FIELD.name) : undefined,
      grow = this.ramp > 0 ? tanhOf(time / this.ramp) : 1;
    let wetCount = 0,
      pressureSum = 0,
      tideSum = 0;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = i + nx * j,
          x = this.x0 + (i + 0.5) * this.dx,
          z = this.z0 + (j + 0.5) * this.dz;
        if (this.water.sample(x, z).depth > DRY) {
          wet[k] = 1;
          wetCount++;
        }
        let p = 0;
        if (this.pressure) {
          p = this.pressure(x, z, time);
          if (!Number.isFinite(p))
            throw new RangeError(`The air's pressure at (${x}, ${z}) at ${time} s is ${p}; return Pa.`);
        }
        let u = 0;
        if (port && this.positions) {
          const at = 3 * k;
          u = tideFromPort(this.host.memory, port, [
            this.positions[at]!,
            this.positions[at + 1]!,
            this.positions[at + 2]!,
          ]).potential;
        }
        parts[2 * k] = p;
        parts[2 * k + 1] = u;
        if (wet[k]) {
          pressureSum += p;
          tideSum += u;
        }
      }
    const pMean = wetCount ? pressureSum / wetCount : 0,
      uMean = wetCount ? tideSum / wetCount : 0,
      pRef = this.reference ?? pMean,
      rhoG = this.density * this.g;
    for (let k = 0; k < count; k++) {
      // psi = (p - p_ref) / (rho g) - gamma_2 (U - mean U) / g: the water stands at -psi when it has settled.
      const barometer = this.pressure ? (parts[2 * k]! - pRef) / rhoG : 0,
        tide = port ? (-this.love * (parts[2 * k + 1]! - uMean)) / this.g : 0;
      psi[k] = grow * (barometer + tide);
    }
  }

  /** The forcing potential at (x, z) from the last step, m: where the water stands at rest, it stands at minus this. */
  potentialAt(x: number, z: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.dx))),
      j = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.dz)));
    return (regionWords(this.host.memory, this.potential) as Float64Array)[i + this.nx * j]!;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: SURFACE_WATER_POTENTIAL_FIELD.name, region: this.potential, tick, cell: this.cell }];
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
    throw new TypeError('A tide is a list of constituents {amplitude, speed, phase}; pass at least one.');
  const { mean = 0, ramp = 0 } = options;
  if (!Number.isFinite(mean) || !(ramp >= 0 && Number.isFinite(ramp)))
    throw new RangeError(
      `A tide's mean must be finite metres and its ramp finite seconds, 0 or more (got ${mean}, ${ramp}).`,
    );
  const lines = constituents.map((c) => {
    const period =
        typeof c?.speed === 'string' ? TIDAL_CONSTITUENTS[c.speed as keyof typeof TIDAL_CONSTITUENTS] : undefined,
      speed = typeof c?.speed === 'number' ? c.speed : period ? TWO_PI / period : Number.NaN,
      phase = c?.phase ?? 0;
    if (!(Number.isFinite(c?.amplitude) && speed > 0 && Number.isFinite(speed) && Number.isFinite(phase)))
      throw new RangeError(
        `A constituent is {amplitude in m, speed in rad/s above 0 or a name (${Object.keys(TIDAL_CONSTITUENTS).join(', ')}), phase in rad}; got ${JSON.stringify(c)}.`,
      );
    return { amplitude: c.amplitude, speed, phase };
  });
  return (time: number) => {
    let level = 0;
    for (const { amplitude, speed, phase } of lines) level += amplitude * cos(speed * time + phase);
    return mean + (ramp > 0 ? tanhOf(time / ramp) : 1) * level;
  };
}

/** The inverse barometer: the water's rise under a pressure `drop` Pa below the reference, m (about 1 cm per hPa). */
export function inverseBarometer(drop: number, density = 1025, gravity = gravityMagnitude(DEFAULT_GRAVITY)): number {
  return drop / (density * gravity);
}

function tanhOf(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e = exp(2 * x);
  return (e - 1) / (e + 1);
}
