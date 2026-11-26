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
// Finite oil spills add Fay's axisymmetric spreading and optional Stiver–Mackay evaporation. Use a depth profile for
// vertical turbulence where mixing varies with depth. Horizontal mixing can use a constant or a scale law.
// Settled parcels remain in the bed ledger. Breaking waves can entrain buoyant oil droplets from a finite slick.

import type {
  Bed,
  FlowField,
  FlowSample,
  SeaSurface,
  SeaSurfaceSample,
  WaveSpectrumSample,
  Wind,
} from '@margoengine/math/fields';
import { cos, exp, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT, SWIM_WAKE_WORDS } from './life/wake.js';
import { MargoError } from '@margoengine/math/errors';
import { BED_CHANGE_FIELD } from './earth/bed.js';
import { TracerBedExchange } from './tracer-bed.js';
import {
  depthDiffusivity,
  type HorizontalDispersionLaw,
  horizontalDispersionLaw,
  horizontalSpread,
  type TracerDiffusionKnot,
  type TracerHorizontalDispersion,
  turbulentVerticalStep,
} from './tracer-diffusion.js';
import {
  type EvaporationRates,
  evaporatedFraction,
  evaporationRates,
  type TracerOilEvaporation,
} from './tracer-evaporation.js';
import { type FayCoefficients, fayAreaTime, fayCoefficients, fayRadius } from './tracer-fay.js';
import {
  oilBreaking,
  type OilDispersionLaw,
  oilDispersionLaw,
  type TracerOilDispersion,
} from './tracer-oil-dispersion.js';
import { stokesAt, type StokesProfile, stokesProfile } from './tracer-stokes.js';
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
export type { TracerDiffusionKnot, TracerHorizontalDispersion } from './tracer-diffusion.js';
export type { TracerOilEvaporation } from './tracer-evaporation.js';
export type { TracerBreakerExposure, TracerOilDispersion } from './tracer-oil-dispersion.js';

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
  /** Mobile layer for {@link TracerSolver.withBedChange}. Its thickness must fit above the terrain's bedrock. */
  mobileLayer?: { thickness: number; porosity: number };
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

/** One finite oil release, represented by a spreading patch of floating tracer parcels. */
export interface TracerOilSpill {
  /** Oil mass in kg. */
  mass: number;
  /** X and Z, m from the tracer solver's origin cell. */
  position: readonly [number, number];
  /** Time of release on the world clock, s (default 0). */
  start?: number;
  /** Air–water tension minus oil–air and oil–water tensions, N/m. Use zero for gravity-only spreading. */
  spreadingCoefficient: number;
  /** Initial floating oil (default the `oil` preset). */
  material?: TracerMaterial;
  /** Slots reserved for this release (default 128, at least two). Counts against `capacity`. */
  parcels?: number;
  /** Stiver–Mackay vapour loss from the expanding slick (default no evaporation). */
  evaporation?: TracerOilEvaporation;
  /** Delvigne–Sweeney entrainment under breaking waves, with buoyant resurfacing (default none). */
  dispersion?: TracerOilDispersion;
}

/** Settings of a {@link TracerSolver}; each has a default. */
export interface TracerParams {
  /** The sources. */
  sources?: readonly TracerSource[];
  /** Instantaneous oil releases that spread by Fay's radial model (default none). */
  oilSpills?: readonly TracerOilSpill[];
  /** Live surface, wave velocity at depth, and water density (default: flat, still water). */
  sea?: SeaSurface;
  /** Override the water's velocity at any depth (default: sea.water when supplied). */
  water?: FlowField;
  /** Wave-averaged Stokes drift from a fixed directional spectrum. Use `water` for the mean current in this mode. */
  stokesSpectrum?: WaveSpectrumSample;
  /** Size of an origin cell, m. Match the PhysicsWorld setting (default 4096). */
  cellSize?: number;
  /** The wind over the water, for floating slicks (default none). */
  wind?: Wind;
  /** Still-water height in the sea's origin cell, or fixed local water height without a sea (default 0 m). */
  waterLevel?: number;
  /** The bed: a terrain bed, or a depth below the surface everywhere, m (default 30 m). */
  bed?: Bed | number;
  /** Density of the water, kg/m^3 (default: sea density, or 1025 without a sea). */
  waterDensity?: number;
  /** Kinematic viscosity of the water, m^2/s (default 1e-6). */
  viscosity?: number;
  /** Horizontal eddy diffusivity, m^2/s (default 0.1). With `horizontalDispersion`, this is the reference value. */
  horizontalDiffusivity?: number;
  /** Optional horizontal scale law for the unresolved spreading of each release. */
  horizontalDispersion?: TracerHorizontalDispersion;
  /** Vertical eddy diffusivity, m^2/s (default 0.001). */
  verticalDiffusivity?: number;
  /** Optional depth-dependent vertical diffusivity. Linear between knots, constant outside, overriding the scalar. */
  verticalDiffusivityProfile?: readonly TracerDiffusionKnot[];
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
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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

interface OilSpillState {
  first: number;
  count: number;
  material: number;
  mass: number;
  position: readonly [number, number];
  start: number;
  profile: FayCoefficients;
  evaporation?: EvaporationRates;
  drops?: { first: number; law: OilDispersionLaw; materials: readonly number[] };
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
  private writeBedChange = false;
  private host!: SolverHost;
  private cell: Cell = ORIGIN;
  private params!: Required<
    Omit<
      TracerParams,
      | 'sea'
      | 'water'
      | 'stokesSpectrum'
      | 'wind'
      | 'bed'
      | 'sources'
      | 'oilSpills'
      | 'horizontalDispersion'
      | 'verticalDiffusivityProfile'
      | 'bedJets'
      | 'breaches'
      | 'breachMixes'
    >
  > & {
    bed: Bed | number;
  };
  private sources: { material: number; source: TracerSource }[] = [];
  private readonly oilSpills: OilSpillState[] = [];
  private spillRadii?: Region;
  private spillVapour?: Region;
  private spillWater?: Region;
  private dropletOwners?: Map<number, number>;
  private depthDiffusivity?: ReturnType<typeof depthDiffusivity>;
  private horizontalLaw?: HorizontalDispersionLaw;
  private dispersionAges?: Region;
  private stokes?: StokesProfile;
  private readonly stokesVelocity: [number, number] = [0, 0];
  private emissionCapacity = 0;
  private materials: TracerMaterial[] = [];
  private settling: number[] = [];
  private sea?: SeaSurface;
  private readonly seaOffset: [number, number, number] = [0, 0, 0];
  private readonly bedOffset: [number, number, number] = [0, 0, 0];
  private readonly seaSample: SeaSurfaceSample = {
    height: 0,
    normal: [0, 1, 0],
    velocity: [0, 0, 0],
    current: [0, 0, 0],
    depth: Infinity,
    density: 0,
  };
  private water: FlowField | undefined;
  private wind: Wind | undefined;
  private random!: RandomStream;
  private particles!: Region;
  private ledger!: Region;
  private jetBed?: JetBed;
  private bedExchange?: TracerBedExchange;
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

  /** Receives fin impulses and exchanges their suspended sediment with a live TerrainBed. */
  static withBedChange(id = 'tracers'): TracerSolver {
    const solver = new TracerSolver(id, { bedJets: true });
    solver.writeBedChange = true;
    return solver;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: TRACER_FIELD, access: 'write' },
        ...(this.useBedJets ? [{ field: SWIM_WAKE_FIELD, access: 'read' as const }] : []),
        ...(this.writeBedChange ? [{ field: BED_CHANGE_FIELD, access: 'accumulate' as const }] : []),
        // The cargo leaving damaged hulls, when a hull solver writes it.
        { field: HULL_BREACHES_FIELD, access: 'read', optional: true },
      ],
      rate: 0 as RateLevel,
      stableRate: () => 0 as RateLevel,
    };
  }

  init(host: SolverHost, params: TracerParams = {}): void {
    this.depthDiffusivity = params.verticalDiffusivityProfile && depthDiffusivity(params.verticalDiffusivityProfile);
    const {
      sources = [],
      sea,
      water,
      wind,
      cellSize = 4096,
      waterLevel = 0,
      bed = 30,
      waterDensity = sea?.density ?? 1025,
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
    if (!(Number.isInteger(cellSize) && cellSize >= 1 && cellSize <= 1 << 20 && (cellSize & (cellSize - 1)) === 0))
      throw new MargoError(
        'unsupported',
        'Tracer cells must be powers of two from 1 to 2^20 m; use the PhysicsWorld cell size.',
      );
    if (typeof bed === 'number' && !(bed > 0 && Number.isFinite(bed)))
      throw new RangeError(
        `A water depth is a finite number of metres above 0 (got ${bed}); pass one, or a terrain bed.`,
      );
    const horizontalLaw =
      params.horizontalDispersion && horizontalDispersionLaw(params.horizontalDispersion, horizontalDiffusivity);
    this.host = host;
    const [gx, gy, gz] = host.gravity;
    this.g = hypot(gx, gy, gz);
    this.stokes = params.stokesSpectrum && stokesProfile(params.stokesSpectrum, this.g);
    this.params = {
      cellSize,
      waterLevel,
      bed,
      waterDensity,
      viscosity,
      horizontalDiffusivity,
      verticalDiffusivity,
      particleMass,
      capacity,
    };
    this.sea = sea;
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
      if (this.writeBedChange) {
        const layer = params.bedJets?.mobileLayer;
        if (
          typeof bed === 'number' ||
          !layer ||
          !(layer.thickness > 0 && Number.isFinite(layer.thickness) && layer.porosity >= 0 && layer.porosity < 1)
        )
          throw new MargoError(
            'unsupported',
            'Tracer bed change needs a live TerrainBed and a finite positive mobile layer with porosity in [0, 1); pass both.',
          );
        this.bedExchange = new TracerBedExchange(host, bed, grains.density * (1 - layer.porosity), layer.thickness);
      }
    }
    // Each breach cargo's material, registered here so a particle's material index means the same after a restore.
    this.breachSlots = breaches;
    this.breachMaterials = BREACH_CARGO.map((name) =>
      name === 'none' ? -1 : this.materialIndex(TRACER_MATERIALS[name]),
    );
    this.initOilSpills(params.oilSpills ?? [], capacity);
    const base = 4 + this.sources.length + Number(this.useBedJets) + breaches;
    const ledgerWords = this.initBreachMixes(params.breachMixes ?? [], base);
    this.random = new RandomStream(0, solverNumber(this.id));
    this.particles = host.allocate('particles', capacity * STRIDE * 8, 'f64', TRACER_LAYOUT);
    if (horizontalLaw && horizontalLaw.rate > 0 && horizontalLaw.power > 1) {
      this.horizontalLaw = horizontalLaw;
      this.dispersionAges = host.allocate('horizontal-dispersion-ages', capacity * 8, 'f64', 1);
    }
    // Released, in the water, on the surface, on the bed (kg), each source's mass not yet released as a particle, the
    // bed jets' and each breach's.
    this.ledger = host.allocate('ledger', ledgerWords * 8, 'f64', TRACER_LAYOUT);
  }

  private initOilSpills(spills: readonly TracerOilSpill[], capacity: number): void {
    const { waterDensity, viscosity } = this.params;
    let first = capacity;
    for (const spill of spills) {
      const { mass, position, spreadingCoefficient, start = 0, parcels = 128, material = TRACER_MATERIALS.oil } = spill;
      if (!(Number.isInteger(parcels) && parcels >= 2 && parcels <= first))
        throw new MargoError(
          'unsupported',
          'Oil spill parcels cannot resolve a patch or exceed available slots; use at least two whole parcels within tracer capacity.',
        );
      if (
        !(
          mass / parcels > 0 &&
          Number.isFinite(mass) &&
          Number.isFinite(start) &&
          start >= 0 &&
          position.length === 2 &&
          position.every(Number.isFinite) &&
          material.floats &&
          material.density > 0 &&
          material.density < waterDensity &&
          spreadingCoefficient >= 0 &&
          Number.isFinite(spreadingCoefficient)
        )
      )
        throw new MargoError(
          'unsupported',
          'Oil spreading needs finite mass, position, time and tension with oil lighter than the water; pass positive mass, nonnegative time and tension, and a floating material.',
        );
      const volume = mass / material.density;
      const profile = fayCoefficients(
        volume,
        this.g * (1 - material.density / waterDensity),
        waterDensity,
        viscosity,
        spreadingCoefficient,
      );
      if (!profile.every(Number.isFinite) || !(fayRadius(profile, 1) > 0))
        throw new MargoError(
          'unsupported',
          'Oil spill radius is outside numeric range; use physical oil mass, buoyancy, viscosity and tension.',
        );
      first -= parcels;
      const surfaceFirst = first;
      const drops = spill.dispersion && this.reserveOilDrops(spill.dispersion, material, first);
      if (drops) first = drops.first;
      this.oilSpills.push({
        first: surfaceFirst,
        count: parcels,
        material: this.materialIndex(material),
        position,
        mass,
        start,
        profile,
        evaporation: spill.evaporation && evaporationRates(spill.evaporation, volume),
        drops,
      });
    }
    this.emissionCapacity = first;
    if (this.oilSpills.length)
      this.spillRadii = this.host.allocate('fay-spill-radii', 8 * this.oilSpills.length, 'f64', 1);
    if (this.oilSpills.some((spill) => spill.evaporation))
      this.spillVapour = this.host.allocate('oil-spill-vapour', 8 * this.oilSpills.length, 'f64', 1);
    if (this.dropletOwners)
      this.spillWater = this.host.allocate('oil-spill-water', 8 * this.oilSpills.length, 'f64', 1);
  }

  private reserveOilDrops(options: TracerOilDispersion, material: TracerMaterial, free: number) {
    const law = oilDispersionLaw(options, free);
    const first = free - law.classes.length;
    this.dropletOwners ??= new Map();
    const materials = law.classes.map(({ diameter }, i) => {
      this.dropletOwners!.set(first + i, this.oilSpills.length);
      return this.materialIndex({ ...material, diameter, floats: false, shape: 0.4 });
    });
    return { first, law, materials };
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
    const { particleMass, waterLevel } = this.params;
    const capacity = this.emissionCapacity;
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
    const [dx, dy, dz] = this.bedOffset;
    return typeof bed === 'number'
      ? this.params.waterLevel - this.seaOffset[1] - bed
      : bed.sample(x + dx, z + dz).elevation - dy;
  }

  private surfaceAt(x: number, z: number, time: number): number {
    const [dx, dy, dz] = this.seaOffset;
    return this.params.waterLevel - dy + (this.sea?.elevation(x + dx, z + dz, time) ?? 0);
  }

  private spreadOil(time: number, dt: number, tick: number, words: Float64Array, book: Float64Array): void {
    if (!this.spillRadii) return;
    const radii = regionWords(this.host.memory, this.spillRadii) as Float64Array;
    const vapour = this.spillVapour && (regionWords(this.host.memory, this.spillVapour) as Float64Array);
    const immersed = this.spillWater && (regionWords(this.host.memory, this.spillWater) as Float64Array);
    // Check all supplied breaker conditions before moving any parcels or transferring mass.
    const waves =
      immersed &&
      this.oilSpills.map((spill, i) => {
        const age = time - spill.start;
        if (!spill.drops || !(age > 0) || spill.mass <= (vapour?.[i] ?? 0) + immersed[i]!) return undefined;
        const centre = radii[i] === 0 ? spill.position : this.oilCentre(spill, words);
        return { centre, ...oilBreaking(spill.drops.law, centre[0], centre[1], time - 0.5 * Math.min(age, dt)) };
      });
    for (let i = 0; i < this.oilSpills.length; i++) {
      const spill = this.oilSpills[i]!;
      const age = time - spill.start;
      if (!(age > 0) || vapour?.[i] === spill.mass) continue;
      const radius = fayRadius(spill.profile, age);
      if (!(radius > 0 && Number.isFinite(radius)))
        throw new MargoError(
          'unsupported',
          'The oil spill radius exceeds numeric range; use a physical release mass and time.',
        );
      const previous = radii[i]!;
      if (previous === 0) {
        this.seedOil(spill, radius, words);
        book[0]! += spill.mass;
        book[2]! += spill.mass;
      } else {
        this.expandOil(spill, radius / previous, words, waves?.[i]?.centre ?? this.oilCentre(spill, words));
      }
      radii[i] = radius;
      const priorAge = Math.max(0, age - dt);
      let remaining = Math.max(0, spill.mass - (vapour?.[i] ?? 0) - (immersed?.[i] ?? 0));
      let changed = false;
      if (vapour && spill.evaporation) {
        const previousMass = vapour[i]!;
        const exposed = spill.mass * evaporatedFraction(spill.evaporation, spill.profile, age);
        const evaporated = spill.drops
          ? previousMass +
            Math.min(remaining, exposed - spill.mass * evaporatedFraction(spill.evaporation, spill.profile, priorAge))
          : exposed;
        if (evaporated > previousMass) {
          vapour[i] = evaporated;
          const transfer = evaporated - previousMass;
          book[2]! -= transfer;
          remaining = Math.max(0, spill.mass - evaporated - (immersed?.[i] ?? 0));
          changed = true;
        }
      }
      const wave = waves?.[i];
      if (immersed && wave && remaining > 0) {
        const { rate, depth } = wave;
        if (rate > 0 && depth > 0) {
          const areaTime = fayAreaTime(spill.profile, age) - fayAreaTime(spill.profile, priorAge);
          const amount = Math.min(remaining, rate * areaTime);
          const transfer = this.entrainOil(spill, words, time, tick, amount, depth);
          immersed[i]! += transfer;
          book[1]! += transfer;
          book[2]! -= transfer;
          remaining -= transfer;
          changed ||= transfer > 0;
        }
      }
      if (changed) this.setOilMass(spill, remaining, words, (immersed?.[i] ?? 0) > 0);
    }
  }

  private entrainOil(
    spill: OilSpillState,
    words: Float64Array,
    time: number,
    tick: number,
    amount: number,
    depth: number,
  ): number {
    const drops = spill.drops!;
    const bins = drops.law.classes;
    let assigned = 0;
    for (let i = 0; i < bins.length; i++) {
      const slot = drops.first + i;
      const p = slot * STRIDE;
      const surfaceParcel = (spill.first + (i % spill.count)) * STRIDE;
      const x = words[surfaceParcel]!;
      const z = words[surfaceParcel + 2]!;
      const surface = this.surfaceAt(x, z, time);
      const intrusion = Math.min(depth, surface - this.bedAt(x, z));
      if (!(intrusion > 0)) continue;
      const mass = Math.min(amount - assigned, amount * bins[i]!.share);
      if (!(mass > 0)) continue;
      const y = surface - intrusion * ((this.random.block(tick, slot, 1)[0]! + 0.5) / 4294967296);
      const existing = words[p + 3]!;
      if (existing > 0) {
        const mix = mass / (existing + mass);
        words[p]! += (x - words[p]!) * mix;
        words[p + 1]! += (y - words[p + 1]!) * mix;
        words[p + 2]! += (z - words[p + 2]!) * mix;
      } else {
        words[p] = x;
        words[p + 1] = y;
        words[p + 2] = z;
        if (this.dispersionAges) (regionWords(this.host.memory, this.dispersionAges) as Float64Array)[slot] = 0;
      }
      words[p + 3] = existing + mass;
      words[p + 4] = drops.materials[i]!;
      words[p + 5] = WATER;
      assigned += mass;
    }
    return assigned;
  }

  private setOilMass(spill: OilSpillState, mass: number, words: Float64Array, keepPatch: boolean): void {
    const share = mass / spill.count;
    const last = (spill.first + spill.count - 1) * STRIDE;
    for (let p = spill.first * STRIDE; p <= last; p += STRIDE) {
      words[p + 3] = p === last ? mass - share * (spill.count - 1) : share;
      if (mass === 0 && !keepPatch) words[p + 5] = FREE;
    }
  }

  private resurfaceOil(owner: number, p: number, words: Float64Array, book: Float64Array): void {
    const immersed = regionWords(this.host.memory, this.spillWater!) as Float64Array;
    const vapour = this.spillVapour && (regionWords(this.host.memory, this.spillVapour) as Float64Array);
    const returned = words[p + 3]!;
    const spill = this.oilSpills[owner]!;
    immersed[owner] = Math.max(0, immersed[owner]! - returned);
    book[1]! -= returned;
    book[2]! += returned;
    words[p + 3] = 0;
    words[p + 5] = FREE;
    this.setOilMass(
      spill,
      Math.max(0, spill.mass - (vapour?.[owner] ?? 0) - immersed[owner]!),
      words,
      immersed[owner]! > 0,
    );
  }

  private seedOil(spill: OilSpillState, radius: number, words: Float64Array): void {
    const { first, count, position, material, mass } = spill;
    const pairs = Math.floor(count / 2);
    const share = mass / count;
    for (let i = 0; i < count; i++) {
      const pair = Math.floor(i / 2);
      const angle = pair * GOLDEN_ANGLE;
      const signedRadius = pair === pairs ? 0 : (i % 2 === 0 ? 1 : -1) * radius * Math.sqrt((pair + 0.5) / pairs);
      const p = (first + i) * STRIDE;
      words[p] = position[0] + signedRadius * cos(angle);
      words[p + 1] = this.params.waterLevel;
      words[p + 2] = position[1] + signedRadius * sin(angle);
      words[p + 3] = i + 1 < count ? share : mass - share * (count - 1);
      words[p + 4] = material;
      words[p + 5] = SURFACE;
    }
  }

  private oilCentre(spill: OilSpillState, words: Float64Array): readonly [number, number] {
    const first = spill.first * STRIDE;
    const end = first + spill.count * STRIDE;
    let cx = 0;
    let cz = 0;
    for (let p = first; p < end; p += STRIDE) {
      cx += words[p]! - words[first]!;
      cz += words[p + 2]! - words[first + 2]!;
    }
    return [words[first]! + cx / spill.count, words[first + 2]! + cz / spill.count];
  }

  private expandOil(
    spill: OilSpillState,
    scale: number,
    words: Float64Array,
    [cx, cz]: readonly [number, number],
  ): void {
    const first = spill.first * STRIDE;
    const end = first + spill.count * STRIDE;
    for (let p = first; p < end; p += STRIDE) {
      words[p] = cx + (words[p]! - cx) * scale;
      words[p + 2] = cz + (words[p + 2]! - cz) * scale;
    }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const sea = this.sea;
    const column = this.depthDiffusivity;
    const stokes = this.stokes;
    const { bed, cellSize } = this.params;
    if (sea)
      for (let axis = 0; axis < 3; axis++) this.seaOffset[axis] = (context.cell[axis]! - sea.cell[axis]!) * cellSize;
    if (typeof bed !== 'number')
      for (let axis = 0; axis < 3; axis++) this.bedOffset[axis] = (context.cell[axis]! - bed.cell[axis]!) * cellSize;
    this.bedExchange?.clear();
    if (this.random.seed !== context.seed) this.random = new RandomStream(context.seed, solverNumber(this.id));
    const time = (context.tick + 1) * dt,
      words = this.words(),
      book = this.book(),
      { capacity, horizontalDiffusivity: kh, verticalDiffusivity: kv, waterLevel } = this.params;
    const [seaX, seaY, seaZ] = this.seaOffset;
    this.spreadOil(time, dt, context.tick, words, book);
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
    const baseSpread = pow(2 * kh * dt, 0.5),
      sv = pow(2 * kv * dt, 0.5);
    const horizontalLaw = this.horizontalLaw;
    const ages = this.dispersionAges && (regionWords(this.host.memory, this.dispersionAges) as Float64Array);
    for (let i = 0; i < capacity; i++) {
      const p = i * STRIDE,
        state = words[p + 5]!;
      if (state !== WATER && state !== SURFACE) continue;
      const x = words[p]!,
        y = words[p + 1]!,
        z = words[p + 2]!,
        material = this.materials[words[p + 4]!]!,
        [n0, n1, n2] = this.normals(context.tick, i);
      let sh = baseSpread;
      if (horizontalLaw && ages) {
        sh = horizontalSpread(horizontalLaw, ages[i]! * dt, dt);
        ages[i]! += 1;
      }
      let ux = 0,
        uy = 0,
        uz = 0;
      if (this.water) {
        const sampleY = sea && state === SURFACE ? this.surfaceAt(x, z, time) : y;
        const v = this.water.sample(x, sampleY, z, time, this.flow).velocity;
        ux = v[0];
        uy = v[1];
        uz = v[2];
      } else if (sea && !stokes) {
        const v =
          state === SURFACE
            ? sea.sample(x + seaX, z + seaZ, time, this.seaSample).velocity
            : sea.water.sample(x + seaX, y + seaY - waterLevel, z + seaZ, time, this.flow).velocity;
        ux = v[0];
        uy = v[1];
        uz = v[2];
      }
      if (stokes) {
        stokesAt(stokes, state === SURFACE ? 0 : waterLevel - seaY - y, this.stokesVelocity);
        ux += this.stokesVelocity[0];
        uz += this.stokesVelocity[1];
      }
      if (state === SURFACE) {
        if (this.wind) {
          const share = material.windage ?? 0.03,
            w = this.wind.sample(x, this.surfaceAt(x, z, time) + 10, z, time, this.flow).velocity;
          ux += share * w[0];
          uz += share * w[2];
        }
        words[p] = x + ux * dt + sh * n0;
        words[p + 2] = z + uz * dt + sh * n2;
        if (sea) words[p + 1] = this.surfaceAt(words[p]!, words[p + 2]!, time);
        continue;
      }
      const nx = x + ux * dt + sh * n0;
      const vertical = column ? turbulentVerticalStep(column, this.surfaceAt(x, z, time) - y, dt, n1) : sv * n1;
      let ny = y + (uy - this.settling[words[p + 4]!]!) * dt + vertical;
      const nz = z + uz * dt + sh * n2;
      // The surface reflects what is in the water; the bed keeps what reaches it.
      const surface = this.surfaceAt(nx, nz, time);
      const floor = this.bedAt(nx, nz);
      const parentSlick = this.dropletOwners?.get(i);
      if (parentSlick !== undefined) {
        if (ny < floor) ny = 2 * floor - ny;
        if (ny >= surface || floor >= surface) {
          this.resurfaceOil(parentSlick, p, words, book);
          continue;
        }
      }
      if (ny > surface) ny = 2 * surface - ny;
      if (parentSlick === undefined && ny <= floor) {
        ny = floor;
        words[p + 5] = BED;
        book[1]! -= words[p + 3]!;
        book[3]! += words[p + 3]!;
        if (words[p + 4] === this.jetBed?.material)
          this.bedExchange?.deposit(nx + this.bedOffset[0], nz + this.bedOffset[2], words[p + 3]!);
      }
      words[p] = nx;
      words[p + 1] = ny;
      words[p + 2] = nz;
    }
    if (this.jetBed) this.entrainBed(context, dt, time, free, this.jetBed);
  }

  private entrainBed(context: StepContext, dt: number, time: number, free: number, bed: JetBed): void {
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
      capacity = this.emissionCapacity;
    for (let w = 0; w < wake.length; w += SWIM_WAKE_WORDS) {
      const x = wake[w]!,
        y = wake[w + 1]!,
        z = wake[w + 2]!,
        downward = -wake[w + 4]!,
        radius = wake[w + 6]!,
        height = y - this.bedAt(x, z);
      if (!(wake[w + 7]! > 0 && downward > 0 && radius > 0 && height > 0 && y <= this.surfaceAt(x, z, time))) continue;
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
          floor = this.bedAt(px, pz),
          surface = this.surfaceAt(px, pz, time);
        if (!(floor < surface)) continue;
        const share = mass / JET_PARCELS;
        const amount = this.bedExchange?.erode(px + this.bedOffset[0], pz + this.bedOffset[2], share) ?? share;
        if (!(amount > 0)) continue;
        const at = free++ * STRIDE;
        words[at] = px;
        words[at + 1] = floor + Math.min(spread * 0.3, (surface - floor) * 0.5);
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
    const tracer = { field: TRACER_FIELD.name, region: this.particles, tick, cell: this.cell };
    return this.bedExchange ? [tracer, this.bedExchange.port(tick)] : [tracer];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const regions = [this.particles, this.ledger];
    if (this.bedExchange) regions.push(...this.bedExchange.regions());
    if (this.spillRadii) regions.push(this.spillRadii);
    if (this.spillVapour) regions.push(this.spillVapour);
    if (this.spillWater) regions.push(this.spillWater);
    if (this.dispersionAges) regions.push(this.dispersionAges);
    return regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** The mass, kg: released, in the water, floating on the surface and settled on the bed. */
  get budget(): { released: number; water: number; surface: number; bed: number } {
    const b = this.book();
    return { released: b[0]!, water: b[1]!, surface: b[2]!, bed: b[3]! };
  }

  /** Cumulative oil vapour, kg. Included in `budget.released` and excluded from the liquid and bed terms. */
  get evaporatedMass(): number {
    if (!this.spillVapour) return 0;
    const vapour = regionWords(this.host.memory, this.spillVapour) as Float64Array;
    return vapour.reduce((total, mass) => total + mass, 0);
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
      if (state === FREE || words[p + 3] === 0) continue;
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
