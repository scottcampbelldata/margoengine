// Tracers and slicks in water (SEA-15 of docs/physics-solvers.md): dye, discoloured water, silt and cargo plumes and oil
// slicks as particles carried by the water's velocity at their depth, spread by turbulence, settling by grain size onto
// the bed or floating on the surface and drifting with the wind, as a solver of the physics framework. Each particle
// carries a mass of one material, so what was released, what is in the water and what lies on the bed always add up, and
// the colour of discoloured water follows the concentration of what is in it.
//
// - Turbulent spreading is a random walk: each step a particle moves by sqrt(2 K dt) times a standard normal number along
//   each axis, K the eddy diffusivity (horizontal and vertical), so a cloud's variance grows as 2 K t, the solution of
//   the diffusion equation (Einstein 1905; Taylor 1921), with the normal numbers from the framework's counter-based random
//   numbers by the Box-Muller transform (Box and Muller 1958).
// - A grain settles at Ferguson and Church's speed, w = R g D^2 / (C1 nu + sqrt(0.75 C2 R g D^3)), R = (rho_s - rho_w) /
//   rho_w, C1 = 18 (Stokes's limit), C2 the turbulent drag of the grain's shape (0.4 for spheres to 1.2 for angular natural
//   grains; R. I. Ferguson and M. Church, J. Sediment. Res. 74, 2004, as restated by Metelkin and Vowinckel,
//   arXiv:2410.12477, eqs. 2 and 3, read); a lighter-than-water droplet rises by the same law with R < 0.
// - Floating material (oil, fuel) stays on the surface and drifts with the water there plus a share of the wind 10 m above
//   it, the wind drift factor (3 percent by default, the traditional constant; Liu, Li and Mu, Frontiers in Marine Science
//   2023, read in its abstract).
//
// Accepted differences: no oil weathering (evaporation, emulsification, dispersion into droplets by breaking waves), slicks
// spread by turbulence only (no Fay gravity-viscous spreading), constant diffusivities (no profile, so no drift correction
// is needed), no flocculation of fine silt, and settled tracer parcels remain in the bed ledger.

import type { Bed, FlowField, FlowSample, Wind } from '@margoengine/math/fields';
import { cos, exp, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT, SWIM_WAKE_WORDS } from './life/wake.js';
import { MargoError } from '@margoengine/math/errors';
import { evaluateWallJet, wallJetProfile } from './tracer-wall-jet.js';
import { BREACH_CARGO, HULL_BREACH_WORDS, HULL_BREACHES_FIELD } from './world/flooding.js';
import { regionWords } from './world/memory.js';
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
} from './world/solver.js';

export { type SubmergedJet, submergedJetWallShear } from './tracer-wall-jet.js';

/** The registry field of the tracers: each particle's position (x, y, z) and mass, owned by {@link TracerSolver}. */
export const TRACER_FIELD: FieldDescriptor = {
  name: 'tracers',
  kind: 'particleSet',
  quantity: 'mass',
  unit: 'kg',
  centring: 'particle',
};
/** The layout of a tracer solver's regions. */
export const TRACER_LAYOUT = 1;

/** What a tracer is made of. */
export interface TracerMaterial {
  /** Its density, kg/m^3: above the water's it sinks, below it rises; a dissolved dye takes the water's. */
  density: number;
  /** Grain or droplet diameter, m (default 0: dissolved, it neither settles nor rises). */
  diameter?: number;
  /** Turbulent drag of the grain's shape, C2 (default 1: natural grains; 0.4 for spheres). */
  shape?: number;
  /** Whether it floats on the surface as a slick (default false). */
  floats?: boolean;
  /** The share of the wind a floating slick drifts at (default 0.03). */
  windage?: number;
  /** Its colour in the water, linear RGB 0 to 1. */
  colour: readonly [number, number, number];
}

/** Materials a scene can release. */
export const TRACER_MATERIALS = {
  /** A dye such as fluorescein: dissolved, bright green. */
  dye: { density: 1000, colour: [0.1, 0.8, 0.2] },
  /** Fine silt from a river or a stirred bed: 40 micrometres of quartz, brown. */
  silt: { density: 2650, diameter: 4e-5, colour: [0.45, 0.35, 0.2] },
  /** Sand: 0.25 mm of quartz. */
  sand: { density: 2650, diameter: 2.5e-4, colour: [0.7, 0.6, 0.4] },
  /** Iron ore fines (hematite): 0.1 mm, red. */
  ironOre: { density: 5200, diameter: 1e-4, colour: [0.55, 0.12, 0.06] },
  /** Coal dust: 0.5 mm, black. */
  coal: { density: 1400, diameter: 5e-4, colour: [0.05, 0.05, 0.05] },
  /** Grain (wheat): 4 mm, pale. */
  grain: { density: 1300, diameter: 4e-3, colour: [0.8, 0.7, 0.4] },
  /** Crude oil: a floating slick, dark. */
  oil: { density: 870, floats: true, colour: [0.03, 0.03, 0.02] },
} as const satisfies Record<string, TracerMaterial>;

/** A source of tracer. */
export interface TracerSource {
  /** What it releases: a material or the name of one of {@link TRACER_MATERIALS}. */
  material: TracerMaterial | keyof typeof TRACER_MATERIALS;
  /** Where, m from the solver's cell origin: fixed, or a function of time (a breach in a moving hull). */
  position: readonly [number, number, number] | ((time: number) => readonly [number, number, number]);
  /** How fast, kg/s: constant or a function of time (a breach's outflow). */
  rate: number | ((time: number) => number);
  /** When it starts and stops, s on the world clock (default from 0, never stopping). */
  start?: number;
  stop?: number;
}

/** Erodible bed material for a tracer solver with bed-jet coupling enabled. */
export interface TracerBedJets {
  /** The mobile fraction of the bed. Default 'sand'. */
  material?: 'sand' | 'silt';
  /** Wall stress model. Default 'wall-jet', with 'footprint' for clearances below one jet diameter. */
  shear?: 'wall-jet' | 'footprint';
  /** Shields threshold for initiation of motion. Default: the Soulsby–Whitehouse curve for the selected grain. */
  criticalShields?: number;
  /** Optional linear erosion rate at unit excess stress, kg/m²/s. Default: van Rijn's grain-dependent pick-up. */
  erodibility?: number;
  /** Total erodible bed mass in this simulation cell, kg. Default Infinity. */
  availableMass?: number;
}

/** The grain-size or material mixture at an opening that publishes cargo outflow. */
export interface BreachTracerMix {
  /** Rigid body row of the hull that owns the opening. */
  body: number;
  /** Index in that hull's openings array. */
  opening: number;
  /** Positive dry-mass shares summing to one. */
  fractions: readonly { material: TracerMaterial | keyof typeof TRACER_MATERIALS; fraction: number }[];
}

/** Settings of a {@link TracerSolver}; each has a default. */
export interface TracerParams {
  /** The sources. */
  sources?: readonly TracerSource[];
  /** The water's velocity at any depth (default still water). */
  water?: FlowField;
  /** The wind over the water, for floating slicks (default none). */
  wind?: Wind;
  /** The water's surface height, y m (default 0). */
  waterLevel?: number;
  /** The bed: a terrain bed, or a depth below the surface everywhere, m (default 30 m). */
  bed?: Bed | number;
  /** Density of the water, kg/m^3 (default 1025, the sea). */
  waterDensity?: number;
  /** Kinematic viscosity of the water, m^2/s (default 1e-6). */
  viscosity?: number;
  /** Horizontal eddy diffusivity, m^2/s (default 0.1). */
  horizontalDiffusivity?: number;
  /** Vertical eddy diffusivity, m^2/s (default 0.001). */
  verticalDiffusivity?: number;
  /** The mass each particle carries, kg (default 1). */
  particleMass?: number;
  /** The most particles at once (default 20000); a source that would pass it releases heavier particles meanwhile. */
  capacity?: number;
  /**
   * The breaches of damaged hulls whose cargo it takes (`hullBreaches`, written by a `HullSolver` with compartments): up to
   * this many breaches, each released as its cargo's material at its centre at its outflow's rate (default 64; 0 none).
   * The hull solver must step in the tracers' origin cell.
   */
  breaches?: number;
  /** Per-opening cargo mixtures (default: one material from the port's cargo code). */
  breachMixes?: readonly BreachTracerMix[];
  /** Erodible layer struck by the swimming wake when bed-jet coupling is enabled. */
  bedJets?: TracerBedJets;
}

/** Columns of a particle: x, y, z, mass, material, state (0 free, 1 in the water, 2 on the surface, 3 on the bed). */
const STRIDE = 6;
const FREE = 0;
const WATER = 1;
const SURFACE = 2;
const BED = 3;
const ORIGIN: Cell = [0, 0, 0];
const JET_PARCELS = 4;
const JET_CORE_RINGS = 32;
const JET_OUTER_RINGS = 16;
const GAUSS_OFFSET = Math.sqrt(1 / 3) / 2;

interface JetBed {
  material: number;
  threshold: number;
  pickupScale: number;
  pickupExponent: number;
  limit: number;
  rings?: Float64Array;
}

interface CargoFraction {
  material: number;
  share: number;
  slot: number;
}

function pickupRate(shear: number, bed: JetBed): number {
  const excess = (shear - bed.threshold) / bed.threshold;
  return excess > 0 ? bed.pickupScale * pow(excess, bed.pickupExponent) : 0;
}

/** Invert the cumulative ring weights and sample an area inside the selected ring. */
function pickupRadius(rings: Float64Array, target: number): number {
  let innerSquared = 0;
  let accumulated = 0;
  for (let i = 0; i < rings.length; i += 2) {
    const outerSquared = rings[i]!;
    const next = rings[i + 1]!;
    if (target < next)
      return Math.sqrt(innerSquared + ((target - accumulated) / (next - accumulated)) * (outerSquared - innerSquared));
    innerSquared = outerSquared;
    accumulated = next;
  }
  return Math.sqrt(innerSquared);
}

/** Ferguson and Church's settling speed, m/s, of a grain of `material` in water of `density` and viscosity `nu` (negative rises). */
export function settlingVelocity(
  material: TracerMaterial,
  density = 1025,
  nu = 1e-6,
  g = gravityMagnitude(DEFAULT_GRAVITY),
): number {
  const d = material.diameter ?? 0;
  if (!(d > 0)) return 0;
  const r = (material.density - density) / density,
    magnitude = r < 0 ? -r : r,
    c2 = material.shape ?? 1,
    w = (magnitude * g * d * d) / (18 * nu + pow(0.75 * c2 * magnitude * g * d * d * d, 0.5));
  return r < 0 ? -w : w;
}

/**
 * Tracers and slicks in water: particles of material from its sources, carried, spread, settled and floated. A framework
 * solver (`Solver`): add it to a `PhysicsWorld` with its {@link TracerParams}.
 */
export class TracerSolver implements Solver<TracerParams> {
  private readonly id: string;
  private readonly useBedJets: boolean;
  private host!: SolverHost;
  private cell: Cell = ORIGIN;
  private params!: Required<
    Omit<TracerParams, 'water' | 'wind' | 'bed' | 'sources' | 'bedJets' | 'breaches' | 'breachMixes'>
  > & {
    bed: Bed | number;
  };
  private sources: { material: number; source: TracerSource }[] = [];
  private materials: TracerMaterial[] = [];
  private settling: number[] = [];
  private water: FlowField | undefined;
  private wind: Wind | undefined;
  private random!: RandomStream;
  private particles!: Region;
  private ledger!: Region;
  private jetBed?: JetBed;
  /** Breaches it takes cargo from, and each breach cargo's material (by its code in BREACH_CARGO, -1 for none). */
  private breachSlots = 0;
  private breachMaterials: number[] = [];
  private breachMixes?: Map<string, readonly CargoFraction[]>;
  private g = gravityMagnitude(DEFAULT_GRAVITY);
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /**
   * @param id The solver's id (default `'tracers'`).
   * @param options Enable `bedJets` to receive `SwimSolver` water impulses (default false).
   */
  constructor(id = 'tracers', options: { bedJets?: boolean } = {}) {
    this.id = id;
    this.useBedJets = options.bedJets ?? false;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: TRACER_FIELD, access: 'write' },
        ...(this.useBedJets ? [{ field: SWIM_WAKE_FIELD, access: 'read' as const }] : []),
        // The cargo leaving damaged hulls, when a hull solver writes it.
        { field: HULL_BREACHES_FIELD, access: 'read', optional: true },
      ],
      rate: 0 as RateLevel,
      stableRate: () => 0 as RateLevel,
    };
  }

  init(host: SolverHost, params: TracerParams = {}): void {
    const {
      sources = [],
      water,
      wind,
      waterLevel = 0,
      bed = 30,
      waterDensity = 1025,
      viscosity = 1e-6,
      horizontalDiffusivity = 0.1,
      verticalDiffusivity = 0.001,
      particleMass = 1,
      capacity = 20000,
      breaches = 64,
    } = params;
    if (!(Number.isInteger(breaches) && breaches >= 0 && breaches <= 65536))
      throw new RangeError(`A tracer solver takes 0 to 65536 whole breaches (got ${breaches}); pass a whole number.`);
    for (const [name, value] of [
      ['water density', waterDensity],
      ['viscosity', viscosity],
      ['particle mass', particleMass],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw new RangeError(`A tracer solver's ${name} is a finite number above 0 (got ${value}); pass one.`);
    for (const [name, value] of [
      ['horizontal diffusivity', horizontalDiffusivity],
      ['vertical diffusivity', verticalDiffusivity],
    ] as const)
      if (!(value >= 0 && Number.isFinite(value)))
        throw new RangeError(`A tracer solver's ${name} is a finite number, 0 or more (got ${value}); pass one.`);
    if (!(Number.isInteger(capacity) && capacity >= 1 && capacity <= 1 << 22))
      throw new RangeError(
        `A tracer solver holds 1 to 4194304 whole particles (got ${capacity}); pass a whole number.`,
      );
    if (!Number.isFinite(waterLevel))
      throw new RangeError(`The water level is a finite height (got ${waterLevel}); pass one.`);
    if (typeof bed === 'number' && !(bed > 0 && Number.isFinite(bed)))
      throw new RangeError(
        `A water depth is a finite number of metres above 0 (got ${bed}); pass one, or a terrain bed.`,
      );
    this.host = host;
    const [gx, gy, gz] = host.gravity;
    this.g = hypot(gx, gy, gz);
    this.params = {
      waterLevel,
      bed,
      waterDensity,
      viscosity,
      horizontalDiffusivity,
      verticalDiffusivity,
      particleMass,
      capacity,
    };
    this.water = water;
    this.wind = wind;
    sources.forEach((source, n) => {
      const material: TracerMaterial =
        typeof source.material === 'string' ? TRACER_MATERIALS[source.material] : source.material;
      if (!material)
        throw new RangeError(
          `Source ${n}'s material is not one of ${Object.keys(TRACER_MATERIALS).join(', ')}; pass one or a material.`,
        );
      if (!(material.density > 0 && Number.isFinite(material.density)))
        throw new RangeError(
          `Source ${n}'s material density is a finite number of kg/m^3 above 0 (got ${material.density}); pass one.`,
        );
      if (typeof source.rate === 'number' && !(source.rate >= 0 && Number.isFinite(source.rate)))
        throw new RangeError(
          `Source ${n}'s rate is a finite number of kg/s, 0 or more (got ${source.rate}); pass one.`,
        );
      this.sources.push({ material: this.materialIndex(material), source });
    });
    if (this.useBedJets) {
      const {
        material = 'sand',
        shear = 'wall-jet',
        criticalShields,
        erodibility,
        availableMass = Infinity,
      } = params.bedJets ?? {};
      if (
        (material !== 'sand' && material !== 'silt') ||
        (shear !== 'wall-jet' && shear !== 'footprint') ||
        (criticalShields !== undefined && !(criticalShields > 0 && Number.isFinite(criticalShields))) ||
        (erodibility !== undefined && !(erodibility >= 0 && Number.isFinite(erodibility))) ||
        !(availableMass >= 0)
      )
        throw new RangeError(
          'Invalid erodible tracer bed; pass sand or silt, wall-jet or footprint shear, positive Shields and non-negative erosion and mass.',
        );
      const grains = TRACER_MATERIALS[material];
      if (!(waterDensity < grains.density && this.g > 0))
        throw new RangeError(
          'The tracer bed requires sinking grains under gravity; use water less dense than the grains and nonzero gravity.',
        );
      const reducedGravity = ((grains.density - waterDensity) / waterDensity) * this.g;
      const grainSize = grains.diameter * pow(reducedGravity / viscosity / viscosity, 1 / 3);
      // Soulsby–Whitehouse (1997) onset and van Rijn (1984) dry sediment mass flux per bed area.
      const shields = criticalShields ?? 0.3 / (1 + 1.2 * grainSize) + 0.055 * (1 - exp(-0.02 * grainSize));
      const threshold = shields * (grains.density - waterDensity) * this.g * grains.diameter;
      const pickupScale =
        erodibility ?? 0.00033 * grains.density * Math.sqrt(reducedGravity * grains.diameter) * pow(grainSize, 0.3);
      if (!(threshold > 0 && Number.isFinite(threshold) && Number.isFinite(pickupScale)))
        throw new MargoError(
          'unsupported',
          'The tracer bed shear threshold or pick-up rate is outside numeric range; use physical water density, viscosity and gravity.',
        );
      this.jetBed = {
        material: this.materialIndex(grains),
        threshold,
        pickupScale,
        pickupExponent: erodibility === undefined ? 1.5 : 1,
        limit: availableMass,
        rings: shear === 'wall-jet' ? new Float64Array(2 * (JET_CORE_RINGS + JET_OUTER_RINGS)) : undefined,
      };
    }
    // Each breach cargo's material, registered here so a particle's material index means the same after a restore.
    this.breachSlots = breaches;
    this.breachMaterials = BREACH_CARGO.map((name) =>
      name === 'none' ? -1 : this.materialIndex(TRACER_MATERIALS[name]),
    );
    const base = 4 + this.sources.length + Number(this.useBedJets) + breaches;
    const ledgerWords = this.initBreachMixes(params.breachMixes ?? [], base);
    this.random = new RandomStream(0, solverNumber(this.id));
    this.particles = host.allocate('particles', capacity * STRIDE * 8, 'f64', TRACER_LAYOUT);
    // Released, in the water, on the surface, on the bed (kg), each source's mass not yet released as a particle, the
    // bed jets' and each breach's.
    this.ledger = host.allocate('ledger', ledgerWords * 8, 'f64', TRACER_LAYOUT);
  }

  private initBreachMixes(mixes: readonly BreachTracerMix[], firstSlot: number): number {
    if (mixes.length === 0) return firstSlot;
    if (this.breachSlots === 0)
      throw new MargoError('unsupported', 'Cargo mixtures require hull breaches; set breaches to a positive count.');
    const byOpening = new Map<string, readonly CargoFraction[]>();
    let nextSlot = firstSlot;
    for (const { body, opening, fractions } of mixes) {
      if (!(Number.isSafeInteger(body) && body >= 0 && Number.isSafeInteger(opening) && opening >= 0))
        throw new MargoError(
          'unsupported',
          'A cargo mixture needs nonnegative whole body and opening indices; use the hull record indices.',
        );
      const key = `${body}/${opening}`;
      if (byOpening.has(key))
        throw new MargoError('unsupported', `Opening ${key} has more than one cargo mixture; combine them into one.`);
      const total = fractions.reduce((sum, entry) => sum + entry.fraction, 0);
      if (!Number.isFinite(total) || Math.abs(total - 1) > Number.EPSILON * 2 * fractions.length)
        throw new MargoError('unsupported', `Opening ${key} has invalid cargo shares; use fractions that sum to one.`);
      const entries = fractions.map(({ material, fraction }) => {
        const grain: TracerMaterial | undefined = typeof material === 'string' ? TRACER_MATERIALS[material] : material;
        const diameter = grain?.diameter ?? 0;
        const shape = grain?.shape ?? 1;
        if (
          !(
            grain &&
            grain.density > 0 &&
            Number.isFinite(grain.density) &&
            diameter >= 0 &&
            Number.isFinite(diameter) &&
            shape > 0 &&
            Number.isFinite(shape) &&
            fraction > 0
          )
        )
          throw new MargoError(
            'unsupported',
            `Opening ${key} has an invalid cargo fraction; use positive shares and finite valid grain properties.`,
          );
        return { material: this.materialIndex(grain), share: fraction / total, slot: nextSlot++ };
      });
      byOpening.set(key, entries);
    }
    this.breachMixes = byOpening;
    return nextSlot;
  }

  /**
   * Releases the mass waiting in ledger slot `slot` at `at` as particles of `material`, from the free particle `free` on;
   * returns where the next free particle may be. Full, the mass waits for room and its next particle carries all of it.
   */
  private release(
    slot: number,
    at: readonly [number, number, number],
    material: number,
    words: Float64Array,
    book: Float64Array,
    free: number,
  ): number {
    const { capacity, particleMass, waterLevel } = this.params;
    while (book[slot]! >= particleMass) {
      while (free < capacity && words[free * STRIDE + 5]! !== FREE) free++;
      if (free >= capacity) break;
      const mass = book[slot]!,
        take = free + 1 < capacity ? particleMass : mass,
        p = free * STRIDE,
        floats = this.materials[material]!.floats === true;
      words[p] = at[0];
      words[p + 1] = floats ? waterLevel : at[1];
      words[p + 2] = at[2];
      words[p + 3] = take;
      words[p + 4] = material;
      words[p + 5] = floats ? SURFACE : WATER;
      book[slot]! -= take;
      book[0]! += take;
      book[floats ? 2 : 1]! += take;
    }
    return free;
  }

  private materialIndex(material: TracerMaterial): number {
    const index = this.materials.indexOf(material);
    if (index !== -1) return index;
    this.settling.push(
      material.floats ? 0 : settlingVelocity(material, this.params.waterDensity, this.params.viscosity, this.g),
    );
    return this.materials.push(material) - 1;
  }

  private words(): Float64Array {
    return regionWords(this.host.memory, this.particles) as Float64Array;
  }

  private book(): Float64Array {
    return regionWords(this.host.memory, this.ledger) as Float64Array;
  }

  /** The bed's height under (x, z), y m. */
  private bedAt(x: number, z: number): number {
    const bed = this.params.bed;
    return typeof bed === 'number' ? this.params.waterLevel - bed : bed.sample(x, z).elevation;
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    if (this.random.seed !== context.seed) this.random = new RandomStream(context.seed, solverNumber(this.id));
    const time = (context.tick + 1) * dt,
      words = this.words(),
      book = this.book(),
      { capacity, horizontalDiffusivity: kh, verticalDiffusivity: kv, waterLevel } = this.params;
    // Release: each source's mass this step, in particles of the set mass, the remainder carried to the next step.
    let free = 0;
    for (let s = 0; s < this.sources.length; s++) {
      const { source, material } = this.sources[s]!,
        start = source.start ?? 0,
        stop = source.stop ?? Infinity;
      if (time <= start || time - dt >= stop) continue;
      const rate = typeof source.rate === 'function' ? source.rate(time) : source.rate;
      if (!(rate >= 0 && Number.isFinite(rate)))
        throw new RangeError(
          `Source ${s} gave a rate of ${rate} kg/s at ${time} s; its rate must be a finite number, 0 or more.`,
        );
      const overlap = (time < stop ? time : stop) - (time - dt > start ? time - dt : start);
      book[4 + s]! += rate * overlap;
      const at = typeof source.position === 'function' ? source.position(time) : source.position;
      free = this.release(4 + s, at, material, words, book, free);
    }
    // The breaches' cargo: each record's outflow over the step, at its centre, as its cargo's material.
    const breaches = context.inputs.get(HULL_BREACHES_FIELD.name);
    if (breaches && this.breachSlots > 0) {
      const c = breaches.cell;
      if (c[0] !== this.cell[0] || c[1] !== this.cell[1] || c[2] !== this.cell[2])
        throw new MargoError(
          'state',
          `The hull breaches come from origin cell [${c.join(', ')}] and the tracers step in [${this.cell.join(', ')}]; step the hull solver and the tracers in one cell.`,
        );
      const memory = breaches.region.memory ?? this.host.memory,
        rec = new Float64Array(memory.buffer, breaches.region.byteOffset, breaches.region.byteLength / 8),
        base = 4 + this.sources.length + Number(this.useBedJets),
        count = Math.min(this.breachSlots, rec[0]!, Math.floor((rec.length - 1) / HULL_BREACH_WORDS));
      for (let k = 0; k < count; k++) {
        const r = 1 + k * HULL_BREACH_WORDS,
          rate = rec[r + 12]!,
          material = this.breachMaterials[rec[r + 13]!] ?? -1;
        if (!(rate > 0 && Number.isFinite(rate)) || material < 0) continue;
        const at = [rec[r + 2]!, rec[r + 3]!, rec[r + 4]!] as const;
        const mixture = this.breachMixes?.get(`${rec[r]}/${rec[r + 1]}`);
        const mass = rate * dt;
        if (mixture) {
          let remaining = mass;
          for (let i = 0; i < mixture.length; i++) {
            const item = mixture[i]!;
            const amount = i + 1 < mixture.length ? Math.min(remaining, mass * item.share) : remaining;
            remaining -= amount;
            book[item.slot]! += amount;
            free = this.release(item.slot, at, item.material, words, book, free);
          }
        } else {
          book[base + k]! += mass;
          free = this.release(base + k, at, material, words, book, free);
        }
      }
    }
    // Motion: the water's velocity (and a slick's windage), settling, and the random walk.
    const sh = pow(2 * kh * dt, 0.5),
      sv = pow(2 * kv * dt, 0.5);
    for (let i = 0; i < capacity; i++) {
      const p = i * STRIDE,
        state = words[p + 5]!;
      if (state !== WATER && state !== SURFACE) continue;
      const x = words[p]!,
        y = words[p + 1]!,
        z = words[p + 2]!,
        material = this.materials[words[p + 4]!]!,
        [n0, n1, n2] = this.normals(context.tick, i);
      let ux = 0,
        uy = 0,
        uz = 0;
      if (this.water) {
        const v = this.water.sample(x, y, z, time, this.flow).velocity;
        ux = v[0];
        uy = v[1];
        uz = v[2];
      }
      if (state === SURFACE) {
        if (this.wind) {
          const share = material.windage ?? 0.03,
            w = this.wind.sample(x, waterLevel + 10, z, time, this.flow).velocity;
          ux += share * w[0];
          uz += share * w[2];
        }
        words[p] = x + ux * dt + sh * n0;
        words[p + 2] = z + uz * dt + sh * n2;
        continue;
      }
      const nx = x + ux * dt + sh * n0;
      let ny = y + (uy - this.settling[words[p + 4]!]!) * dt + sv * n1;
      const nz = z + uz * dt + sh * n2;
      // The surface reflects what is in the water; the bed keeps what reaches it.
      if (ny > waterLevel) ny = 2 * waterLevel - ny;
      const floor = this.bedAt(nx, nz);
      if (ny <= floor) {
        ny = floor;
        words[p + 5] = BED;
        book[1]! -= words[p + 3]!;
        book[3]! += words[p + 3]!;
      }
      words[p] = nx;
      words[p + 1] = ny;
      words[p + 2] = nz;
    }
    if (this.jetBed) this.entrainBed(context, dt, free, this.jetBed);
  }

  private entrainBed(context: StepContext, dt: number, free: number, bed: JetBed): void {
    const port = context.inputs.get(SWIM_WAKE_FIELD.name);
    if (!port) return;
    const { region } = port;
    if (region.layout !== SWIM_WAKE_LAYOUT || region.type !== 'f64' || region.byteLength % (SWIM_WAKE_WORDS * 8))
      throw new RangeError(
        'The swim wake port has an incompatible layout; connect the current SwimSolver wake output.',
      );
    const wake = regionWords(region.memory ?? this.host.memory, region) as Float64Array;
    const words = this.words(),
      book = this.book(),
      lifted = 4 + this.sources.length,
      { capacity, waterLevel } = this.params;
    for (let w = 0; w < wake.length; w += SWIM_WAKE_WORDS) {
      const x = wake[w]!,
        y = wake[w + 1]!,
        z = wake[w + 2]!,
        downward = -wake[w + 4]!,
        radius = wake[w + 6]!,
        height = y - this.bedAt(x, z);
      if (!(wake[w + 7]! > 0 && downward > 0 && radius > 0 && height > 0 && y <= waterLevel)) continue;
      const centreX = x + height * (wake[w + 3]! / downward),
        centreZ = z + height * (wake[w + 5]! / downward);
      const rings = height >= 2 * radius ? bed.rings : undefined;
      const spread = rings ? radius : radius + 0.1 * hypot(height, centreX - x, centreZ - z);
      const area = Math.PI * spread * spread;
      const rate = rings
        ? this.radialPickup(height, radius, downward / dt, bed, rings)
        : pickupRate((0.05 * downward) / (dt * area), bed) * area;
      const mass = Math.min(rate * dt, bed.limit - book[lifted]!);
      if (!(mass > 0 && Number.isFinite(mass))) continue;
      for (let parcel = 0; parcel < JET_PARCELS; parcel++) {
        while (free < capacity && words[free * STRIDE + 5] !== FREE) free++;
        if (free === capacity) return;
        const random = this.random.block(context.tick, w / SWIM_WAKE_WORDS, parcel + 1);
        const angle = (2 * Math.PI * (parcel + (random[0]! + 0.5) / 4294967296)) / JET_PARCELS;
        const quantile = (random[1]! + 0.5) / 4294967296;
        const distance = rings
          ? pickupRadius(rings, (rate * (parcel + quantile)) / JET_PARCELS)
          : spread * pow(0.0625 + 0.7475 * quantile, 0.5);
        const px = centreX + distance * cos(angle),
          pz = centreZ + distance * sin(angle),
          floor = this.bedAt(px, pz);
        if (!(floor < waterLevel)) continue;
        const at = free++ * STRIDE,
          amount = mass / JET_PARCELS;
        words[at] = px;
        words[at + 1] = floor + Math.min(spread * 0.3, (waterLevel - floor) * 0.5);
        words[at + 2] = pz;
        words[at + 3] = amount;
        words[at + 4] = bed.material;
        words[at + 5] = WATER;
        book[lifted]! += amount;
        book[0]! += amount;
        book[1]! += amount;
      }
    }
  }

  private radialPickup(height: number, radius: number, force: number, bed: JetBed, rings: Float64Array): number {
    const { waterDensity, viscosity } = this.params;
    // Match the delivered normal momentum to a top-hat circular jet at the source.
    const speed = Math.sqrt(force / (waterDensity * Math.PI * radius * radius));
    const jet = wallJetProfile(height, 2 * radius, speed, waterDensity, viscosity);
    const outer = Math.max(1, pow((jet.scale * jet.outer) / bed.threshold, 1 / 2.3));
    if (!Number.isFinite(outer)) return 0;

    let innerSquared = 0;
    let rate = 0;
    const stretch = pow(outer, 1 / JET_OUTER_RINGS);
    let wallRadius = 1;
    for (let i = 1; i <= JET_CORE_RINGS + JET_OUTER_RINGS; i++) {
      const radial = i <= JET_CORE_RINGS ? i / JET_CORE_RINGS : (wallRadius *= stretch);
      const outerSquared = height * radial * (height * radial);
      const widthSquared = outerSquared - innerSquared;
      // Integrate in squared radius, where the area element is constant, with two-point Gauss–Legendre quadrature.
      const near = Math.sqrt(innerSquared + (0.5 - GAUSS_OFFSET) * widthSquared) / height;
      const far = Math.sqrt(innerSquared + (0.5 + GAUSS_OFFSET) * widthSquared) / height;
      const flux = pickupRate(evaluateWallJet(jet, near), bed) + pickupRate(evaluateWallJet(jet, far), bed);
      rate += flux * (Math.PI * widthSquared * 0.5);
      const ring = 2 * (i - 1);
      rings[ring] = outerSquared;
      rings[ring + 1] = rate;
      innerSquared = outerSquared;
    }
    return rate;
  }

  /** Three standard normal numbers for particle `i` at `tick`, by Box-Muller from the counter-based stream. */
  private normals(tick: number, i: number): [number, number, number] {
    const block = this.random.block(tick, i, 0),
      u = (k: number) => (block[k]! + 0.5) / 4294967296,
      r1 = pow(-2 * ln(u(0)), 0.5),
      r2 = pow(-2 * ln(u(2)), 0.5),
      a1 = 6.283185307179586 * u(1),
      a2 = 6.283185307179586 * u(3);
    return [r1 * cos(a1), r1 * sin(a1), r2 * cos(a2)];
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: TRACER_FIELD.name, region: this.particles, tick, cell: this.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.particles, this.ledger];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** The mass, kg: released, in the water, floating on the surface and settled on the bed. */
  get budget(): { released: number; water: number; surface: number; bed: number } {
    const b = this.book();
    return { released: b[0]!, water: b[1]!, surface: b[2]!, bed: b[3]! };
  }

  /** Cumulative kg lifted out of the erodible layer by water jets. Included in `budget.released`. */
  get jetErosion(): number {
    return this.jetBed ? this.book()[4 + this.sources.length]! : 0;
  }

  /** Every live particle: position, mass, material index (into {@link TracerSolver.materialList}) and where it is. */
  *particlesOf(): Generator<{
    position: [number, number, number];
    mass: number;
    material: number;
    state: 'water' | 'surface' | 'bed';
  }> {
    const words = this.words();
    for (let i = 0; i < this.params.capacity; i++) {
      const p = i * STRIDE,
        state = words[p + 5]!;
      if (state === FREE) continue;
      yield {
        position: [words[p]!, words[p + 1]!, words[p + 2]!],
        mass: words[p + 3]!,
        material: words[p + 4]!,
        state: state === WATER ? 'water' : state === SURFACE ? 'surface' : 'bed',
      };
    }
  }

  /** The materials of the releases, including the erodible bed layer, in the order particles name them. */
  get materialList(): readonly TracerMaterial[] {
    return this.materials;
  }

  /**
   * The concentration in the water on a grid of `cells` over the box from `min` to `max`, kg/m^3 (x fastest, then y, then
   * z), with the colour it gives the water: the mass-weighted colour of the material in each cell and its concentration.
   */
  concentration(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
    cells: readonly [number, number, number],
  ): { mass: Float32Array; colour: Float32Array } {
    const [nx, ny, nz] = cells,
      mass = new Float32Array(nx * ny * nz),
      colour = new Float32Array(nx * ny * nz * 3),
      volume = ((((max[0] - min[0]) / nx) * (max[1] - min[1])) / ny) * ((max[2] - min[2]) / nz);
    for (const particle of this.particlesOf()) {
      if (particle.state === 'bed') continue;
      const [x, y, z] = particle.position,
        i = Math.floor(((x - min[0]) / (max[0] - min[0])) * nx),
        j = Math.floor(((y - min[1]) / (max[1] - min[1])) * ny),
        k = Math.floor(((z - min[2]) / (max[2] - min[2])) * nz);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const c = i + nx * (j + ny * k),
        rgb = this.materials[particle.material]!.colour;
      mass[c]! += particle.mass / volume;
      for (let n = 0; n < 3; n++) colour[3 * c + n]! += (particle.mass / volume) * rgb[n]!;
    }
    for (let c = 0; c < mass.length; c++) if (mass[c]! > 0) for (let n = 0; n < 3; n++) colour[3 * c + n]! /= mass[c]!;
    return { mass, colour };
  }
}
