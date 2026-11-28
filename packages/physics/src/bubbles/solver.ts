// Bubbles in the water (FW-4 of docs/physics-demo-review.md): the cloud and aerated plume a ship's propeller and stern
// leave, as parcels of bubbles of one size carried by the water's flow, rising at their own speed, dissolving as they go,
// and laying foam where they surface. Sources (papers and a thesis, read as text; no code; docs/clean-room.md "Bubbles"):
// - The rise of a bubble in sea water, whose surfactants make its surface behave as a rigid sphere's: the formula of S. A.
//   Thorpe (1982) and R. F. Keeling (1993), as L. Deike and W. K. Melville ("Gas transfer by breaking waves", Geophys.
//   Res. Lett. 45, 10482-10492, 2018, https://doi.org/10.1029/2018GL078758) print it: w = (2 r^2 g / 9 nu)
//   (sqrt(eta^2 + 2 eta) - eta), eta = 10.82 / chi, chi = g r^3 / nu^2 (Stokes' law for small bubbles).
// - Dissolution, as A. M. Castro ("Polydispersed bubbly flow model for ship hydrodynamics with application to Athena R/V",
//   PhD thesis, University of Iowa, 2011) models it after Whitaker and Levich: m' = -2 pi Sh kappa r (C0 - Cinf), Sh =
//   2 + 0.997 Pe^(1/3) for Re < 3.5 and 2 + (0.4 Re^(1/2) + 0.06 Re^(2/3)) Sc^0.4 above, C0 = H (p_atm + rho g d + 2 sigma
//   / r) at the bubble's wall and Cinf = H p_atm far from it, with kappa = 2e-9 m^2/s and H = 2.38e-7 kg/(m^3 Pa). His
//   time scales at the Athena's stern, about 2 min for a 100 um bubble and 2.5 s for a 10 um one, are the check.
// - The sizes air enters as: the spectrum of G. B. Deane and M. D. Stokes (Nature 418, 839-844, 2002), as E. Moraga, P.
//   Carrica, D. Drew and R. Lahey (Mecanica Computacional XXIV, 2005) take it for a ship: r^(-3/2) under 1 mm, r^(-10/3)
//   above.
// - Where a ship puts it: Moraga et al. place the entrainment where the surface is broken (the bow wave's line, the
//   contact line, the transom), void fractions of 10 to 20 percent; P. Carrica, F. Bonetto and D. Drew (1997) and
//   E. Paterson et al. (1997) inject 10 percent void. Here a ship's air enters where its propeller's race boils up to the
//   surface (the ship solver's `wash`), 10 percent void over the entrainment depth phi_ent = 0.1 m of Castro, carried by
//   the race's water through the boil's width: Q = alpha phi_ent 2 R U. The strength alpha is the models' tuned
//   constant (docs/clean-room.md says how it was set).
import type { FlowField, FlowSample, SeaSurface } from '@margoengine/math/fields';
import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';
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
import { regionWords } from '../world/memory.js';

type V3 = [number, number, number];

/** f64 words of a parcel: position (3), bubble radius, bubbles in it, age, each bubble's air mass (kg). */
export const PARCEL_WORDS = 7;

/** Sea water's kinematic viscosity, m^2/s, the gas's diffusivity, m^2/s, Henry's constant for air, kg/(m^3 Pa). */
export const SEA_VISCOSITY_KINEMATIC = 1.05e-6;
/** Diffusivity of air in sea water, 2e-9 m²/s. */
export const AIR_DIFFUSIVITY = 2e-9;
/** Henry's constant for air in sea water, 2.38e-7 kg/(m³ Pa). */
export const AIR_HENRY = 2.38e-7;
/** Air's molar mass, kg/mol, the gas constant, J/(mol K), the atmosphere's pressure, Pa, sea water's surface tension, N/m. */
const AIR_MOLAR = 0.02896,
  GAS_CONSTANT = 8.314462618,
  ATMOSPHERE = 101325,
  SURFACE_TENSION = 0.072;

/**
 * A bubble's rise speed in sea water, m/s, at radius `r` m (its surface rigid with surfactants): Thorpe's and Keeling's
 * formula, w = (2 r^2 g / 9 nu) (sqrt(eta^2 + 2 eta) - eta), eta = 10.82 nu^2 / (g r^3).
 */
export function riseSpeed(r: number, g = 9.81, nu = SEA_VISCOSITY_KINEMATIC): number {
  if (!(r > 0)) return 0;
  const chi = (g * r * r * r) / (nu * nu),
    eta = 10.82 / chi;
  return ((2 * r * r * g) / (9 * nu)) * (Math.sqrt(eta * eta + 2 * eta) - eta);
}

/**
 * The rate a bubble of radius `r` m at depth `depth` m loses its air, kg/s (Castro's model): 2 pi Sh kappa r H
 * (rho g depth + 2 sigma / r), Sh by Levich under Re = 3.5 and Whitaker above.
 */
export function dissolution(r: number, depth: number, g = 9.81, rho = 1025, nu = SEA_VISCOSITY_KINEMATIC): number {
  const w = riseSpeed(r, g, nu),
    re = (2 * r * w) / nu,
    sc = nu / AIR_DIFFUSIVITY,
    sh =
      re < 3.5
        ? 2 + 0.997 * pow((2 * r * w) / AIR_DIFFUSIVITY, 1 / 3)
        : 2 + (0.4 * Math.sqrt(re) + 0.06 * pow(re, 2 / 3)) * pow(sc, 0.4),
    excess = rho * g * Math.max(0, depth) + (2 * SURFACE_TENSION) / r;
  return 2 * Math.PI * sh * AIR_DIFFUSIVITY * r * AIR_HENRY * excess;
}

/** The air's density in a bubble of radius `r` at depth `depth`, kg/m^3 (ideal gas at `temperature` K). */
export function airDensity(r: number, depth: number, g = 9.81, rho = 1025, temperature = 288): number {
  return (
    ((ATMOSPHERE + rho * g * Math.max(0, depth) + (2 * SURFACE_TENSION) / r) * AIR_MOLAR) / (GAS_CONSTANT * temperature)
  );
}

/** Where air enters the water: a place, a spread, a rate. */
export interface BubbleSource {
  /** The centre of the entrainment, m from the world's cell (on or under the surface). */
  readonly position: readonly [number, number, number];
  /** Its spread across (x, z) and down, m: parcels start in a box this wide and this deep under the position. */
  readonly width: number;
  readonly depth: number;
  /** The air it takes in, m^3/s at the surface's pressure. */
  readonly rate: number;
  /** The velocity the air is taken in with, m/s (default the water's there). */
  readonly velocity?: readonly [number, number, number];
}

/** Something that takes foam over a box: a FoamSolver of `@margoengine/physics/foam`. */
export interface BubbleFoam {
  addFoam(
    min: readonly [number, number],
    max: readonly [number, number],
    whiteness?: number,
    persistence?: number,
  ): void;
}

/** What a {@link BubbleSolver} is made from. */
export interface BubbleParams {
  /** Where air enters, at time t: a list, or the ships' entrainment (`shipAeration(ships)`). */
  readonly sources: (t: number) => readonly BubbleSource[];
  /** The water's flow that carries the bubbles (a ship solver's races, a sea's water; default still water). */
  readonly water?: FlowField;
  /** The sea's surface, where bubbles surface (default the still level y = 0). */
  readonly sea?: Pick<SeaSurface, 'elevation'>;
  /** Lays foam where bubbles surface (default none). */
  readonly foam?: BubbleFoam;
  /** The bubble radii the air enters as, m (default eight from 20 um to 1 mm). */
  readonly radii?: readonly number[];
  /** Parcels it may hold (default 20,000). */
  readonly capacity?: number;
  /** The water's density, kg/m^3 (default 1025). */
  readonly density?: number;
  /** Its rate level (default 0). */
  readonly rate?: RateLevel;
}

/**
 * The radii the air enters as, m: eight, log-spaced from 20 um to 1 mm, the range the rise formula holds over (larger
 * bubbles rise faster than a rigid sphere, 25 to 29 cm/s at 2.5 to 4.2 mm across against its 12, as T. D. Anguelova and
 * P. Huq measured, J. Mar. Sci. Eng. 5, 41, 2017; they surface within seconds and are left out).
 */
export const BUBBLE_RADII: readonly number[] = Object.freeze(
  Array.from({ length: 8 }, (_, i) => 20e-6 * pow(50, i / 7)),
);

/**
 * The share of the air volume each radius of `radii` carries, from Deane and Stokes' number density per radius,
 * r^(-3/2) under 1 mm and r^(-10/3) above (continuous at 1 mm), times the bubble's volume and the radius class's width.
 */
export function spectrumShares(radii: readonly number[]): Float64Array {
  const n = radii.length,
    shares = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = radii[i]!,
      lo = i > 0 ? Math.sqrt(radii[i - 1]! * r) : r / Math.sqrt(radii[1]! / r),
      hi = i < n - 1 ? Math.sqrt(radii[i + 1]! * r) : r * Math.sqrt(r / radii[n - 2]!),
      density = r < 1e-3 ? pow(r / 1e-3, -1.5) : pow(r / 1e-3, -10 / 3);
    shares[i] = density * r * r * r * (hi - lo);
    sum += shares[i]!;
  }
  for (let i = 0; i < n; i++) shares[i]! /= sum;
  return shares;
}

const BUBBLE_LAYOUT = 1;

/** Bubbles in the water: parcels carried, rising, dissolving and surfacing. `id` is `'bubbles'` unless a world holds more. */
export class BubbleSolver implements Solver<BubbleParams> {
  private host: SolverHost | null = null;
  private params: BubbleParams | null = null;
  private level: RateLevel = 0;
  private capacity = 0;
  private g = 9.81;
  private rho = 1025;
  private radii: readonly number[] = BUBBLE_RADII;
  private shares: Float64Array = new Float64Array(0);
  private parcels: Region | null = null;
  private header: Region | null = null;
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  /** The air that surfaced over the last step, m^3. */
  private surfacedLast = 0;

  constructor(readonly id = 'bubbles') {}

  describe(): SolverDescription {
    return { id: this.id, fields: [], rate: this.level, stableRate: () => this.level };
  }

  /** @throws TypeError without sources; RangeError for radii, capacity, density or rate out of range, naming the fix. */
  init(host: SolverHost, params: BubbleParams): void {
    if (!params || typeof params.sources !== 'function')
      throw new TypeError(
        'A BubbleSolver takes its air from sources(t) => BubbleSource[]; pass one (shipAeration(ships)).',
      );
    const radii = params.radii ?? BUBBLE_RADII,
      capacity = params.capacity ?? 20000,
      density = params.density ?? 1025,
      rate = params.rate ?? 0;
    if (!(radii.length >= 2 && radii.every((r, i) => r > 0 && r <= 1e-3 && (i === 0 || r > radii[i - 1]!))))
      throw new RangeError(
        "Bubble radii rise from above 0 to at most 1 mm (the rise formula's range), two or more of them; pass them in order.",
      );
    if (!(Number.isInteger(capacity) && capacity >= 1))
      throw new RangeError(`Bubbles' capacity is a whole number of parcels of 1 or more (got ${capacity}); pass one.`);
    if (!(density > 0 && Number.isFinite(density)))
      throw new RangeError(`The water's density is a finite number of kg/m^3 above 0 (got ${density}); pass one.`);
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw new RangeError(`Bubbles' rate level is 0 to 7 (got ${rate}); pass one.`);
    if (params.foam !== undefined && typeof params.foam?.addFoam !== 'function')
      throw new TypeError('Foam goes through addFoam(min, max, whiteness, persistence); pass a FoamSolver or none.');
    const [gx, gy, gz] = host.gravity;
    this.g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    this.host = host;
    this.params = params;
    this.radii = radii;
    this.shares = spectrumShares(radii);
    this.capacity = capacity;
    this.rho = density;
    this.level = rate as RateLevel;
    this.parcels = host.allocate(`${this.id}:parcels`, capacity * PARCEL_WORDS * 8, 'f64', BUBBLE_LAYOUT);
    // How many parcels, how many were ever made (their places' sequence), and the air's ledger: kg taken in, dissolved,
    // surfaced.
    this.header = host.allocate(`${this.id}:header`, 5 * 8, 'f64', BUBBLE_LAYOUT);
  }

  private words(region: Region | null): Float64Array {
    if (!this.host || !region)
      throw new MargoError('state', 'BubbleSolver is not in a world yet; add it with world.add(solver, {sources}).');
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private surface(x: number, z: number, t: number): number {
    return this.params!.sea ? this.params!.sea.elevation(x, z, t) : 0;
  }

  step(context: StepContext, dt: number): void {
    const p = this.words(this.parcels),
      head = this.words(this.header),
      params = this.params!,
      t = (context.tick + 0.5) / rateOf(context.level),
      g = this.g,
      rho = this.rho;
    let count = head[0]!;
    // New air: each source's volume this step, split over the radii by the spectrum, one parcel a radius.
    for (const source of params.sources(t)) {
      if (!(source.rate > 0)) continue;
      for (let i = 0; i < this.radii.length; i++) {
        if (count >= this.capacity)
          throw new MargoError(
            'state',
            `Bubbles hold at most ${this.capacity} parcels; raise capacity or slow the sources.`,
          );
        const r = this.radii[i]!,
          volume = source.rate * dt * this.shares[i]!,
          k = head[1]!,
          // An R2 sequence over the source's box (across, along, down), by the parcels made so far.
          a = (0.5 + k * 0.8191725133961645) % 1,
          b = (0.5 + k * 0.6710436067037893) % 1,
          c = (0.5 + k * 0.5497004779019703) % 1,
          at = count * PARCEL_WORDS;
        head[1] = k + 1;
        const x = source.position[0] + (a - 0.5) * source.width,
          y = source.position[1] - c * source.depth,
          z = source.position[2] + (b - 0.5) * source.width,
          bubbles = volume / ((4 / 3) * Math.PI * r * r * r),
          // The air taken in at the surface's pressure, in bubbles of radius r where they start.
          each = airDensity(r, 0, g, rho) * (4 / 3) * Math.PI * r * r * r;
        p[at] = x;
        p[at + 1] = y;
        p[at + 2] = z;
        p[at + 3] = pow(each / (airDensity(r, this.surface(x, z, t) - y, g, rho) * (4 / 3) * Math.PI), 1 / 3);
        p[at + 4] = bubbles;
        p[at + 5] = 0;
        p[at + 6] = each;
        head[2]! += bubbles * each;
        count++;
      }
    }
    // Carry, rise, dissolve, surface.
    let kept = 0,
      surfaced = 0;
    for (let q = 0; q < count; q++) {
      const o = q * PARCEL_WORDS,
        x = p[o]!,
        y = p[o + 1]!,
        z = p[o + 2]!;
      let r = p[o + 3]!,
        each = p[o + 6]!;
      const level = this.surface(x, z, t),
        depth = Math.max(0, level - y),
        bubbles = p[o + 4]!;
      // Dissolving: each bubble's air falls by the transfer rate over the step; its radius follows its mass and the
      // pressure where it is (so it also swells as it rises).
      const lost = Math.min(each, dissolution(r, depth, g, rho) * dt);
      each -= lost;
      head[3]! += bubbles * lost;
      if (!(each > 0) || r < 1e-6) {
        head[3]! += bubbles * each;
        continue;
      }
      r = pow(each / (airDensity(r, depth, g, rho) * (4 / 3) * Math.PI), 1 / 3);
      const v = params.water ? params.water.sample(x, y, z, t, this.flow).velocity : ([0, 0, 0] as V3),
        w = riseSpeed(r, g),
        nx = x + v[0] * dt,
        ny = y + (v[1] + w) * dt,
        nz = z + v[2] * dt;
      if (ny >= this.surface(nx, nz, t)) {
        // Surfaced: the parcel's air, at the surface's pressure, whitens the water where it breaks.
        const air = bubbles * (4 / 3) * Math.PI * r * r * r;
        surfaced += air;
        head[4]! += bubbles * each;
        if (params.foam) {
          // A patch the size the surfaced air would cover a millimetre deep, at most a metre and a half across, and as
          // white as that air would make a 1 m^2 patch 1 mm deep: whiteness min(1, air / (1 m^2 x 1 mm)).
          const half = Math.min(0.75, Math.max(0.05, 0.5 * Math.sqrt(air / 1e-3)));
          params.foam.addFoam([nx - half, nz - half], [nx + half, nz + half], Math.min(1, air / 1e-3));
        }
        continue;
      }
      const d = kept * PARCEL_WORDS;
      p[d] = nx;
      p[d + 1] = ny;
      p[d + 2] = nz;
      p[d + 3] = r;
      p[d + 4] = bubbles;
      p[d + 5] = p[o + 5]! + dt;
      p[d + 6] = each;
      kept++;
    }
    p.fill(0, kept * PARCEL_WORDS, count * PARCEL_WORDS);
    head[0] = kept;
    this.surfacedLast = surfaced;
  }

  /** How many parcels it holds. */
  get count(): number {
    return this.words(this.header)[0]!;
  }

  /** The parcels for drawing: position (x, y, z), bubble radius, bubbles in it, age, air per bubble, PARCEL_WORDS each. */
  parcelData(): Float64Array {
    const p = this.words(this.parcels);
    return p.slice(0, this.count * PARCEL_WORDS);
  }

  /** The air in the water, m^3, at the surface's pressure (the parcels' bubbles' volume). */
  airVolume(): number {
    const p = this.words(this.parcels);
    let v = 0;
    for (let q = 0; q < this.count; q++) {
      const r = p[q * PARCEL_WORDS + 3]!;
      v += p[q * PARCEL_WORDS + 4]! * (4 / 3) * Math.PI * r * r * r;
    }
    return v;
  }

  /** The air's ledger, kg: taken in, dissolved into the water, surfaced, and in the water now. */
  ledger(): { taken: number; dissolved: number; surfaced: number; held: number } {
    const head = this.words(this.header),
      p = this.words(this.parcels);
    let held = 0;
    for (let q = 0; q < this.count; q++) held += p[q * PARCEL_WORDS + 4]! * p[q * PARCEL_WORDS + 6]!;
    return { taken: head[2]!, dissolved: head[3]!, surfaced: head[4]!, held };
  }

  /** The air that surfaced over the last step, m^3. */
  get surfaced(): number {
    return this.surfacedLast;
  }

  /**
   * The void fraction (the share of the water that is air) in the box of side `cell` m centred on (x, y, z): the
   * parcels' bubbles' volume in it over its volume.
   */
  voidFraction(x: number, y: number, z: number, cell: number): number {
    const p = this.words(this.parcels),
      half = cell / 2;
    let v = 0;
    for (let q = 0; q < this.count; q++) {
      const o = q * PARCEL_WORDS;
      if (Math.abs(p[o]! - x) > half || Math.abs(p[o + 1]! - y) > half || Math.abs(p[o + 2]! - z) > half) continue;
      const r = p[o + 3]!;
      v += p[o + 4]! * (4 / 3) * Math.PI * r * r * r;
    }
    return v / (cell * cell * cell);
  }

  exportPorts(_tick: number): readonly Port[] {
    return [];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.header, this.parcels].filter((r): r is Region => r !== null);
  }

  extraState(): readonly Region[] {
    return [];
  }
}

/**
 * The air ships take in where their propellers' races boil up to the surface, as bubble sources: for each race boil of
 * a ship solver's `wash(t)`, 10 percent void (`voidFraction`) over the entrainment depth phi_ent = 0.1 m (`depth`) across
 * the boil's width, carried by the race's speed there: Q = alpha phi_ent 2 R U.
 */
export function shipAeration(
  ships: {
    wash(t: number): readonly {
      position: readonly [number, number];
      direction: readonly [number, number];
      speed: number;
      radius: number;
    }[];
  },
  options: { voidFraction?: number; depth?: number; level?: (x: number, z: number, t: number) => number } = {},
): (t: number) => BubbleSource[] {
  const alpha = options.voidFraction ?? 0.1,
    depth = options.depth ?? 0.1;
  if (!(alpha > 0 && alpha <= 0.3))
    throw new RangeError(`Entrained void is above 0 and at most 0.3 (got ${alpha}); pass one.`);
  if (!(depth > 0 && depth <= 2))
    throw new RangeError(`The entrainment depth is above 0 and at most 2 m (got ${depth}); pass one.`);
  return (t) =>
    ships.wash(t).map((boil) => {
      const y = options.level ? options.level(boil.position[0], boil.position[1], t) : 0;
      return {
        position: [boil.position[0], y, boil.position[1]] as [number, number, number],
        width: 2 * boil.radius,
        depth,
        rate: alpha * depth * 2 * boil.radius * boil.speed,
      };
    });
}
