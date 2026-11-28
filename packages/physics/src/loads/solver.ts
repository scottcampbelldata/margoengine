// Hydrodynamic loads on bodies in the water as a solver of the physics framework (SEA-12): divers, debris, buoys, hoses,
// piles and dolphins. Each step it reads where the bodies are from the rigid solver's `bodies` port and holds them through
// `bodyForces` with the water's loads (morison.ts, shapes.ts):
// - a compact body (a diver, a crate, a buoy) displaces water below a locally horizontal surface. Analytic ellipsoid caps
//   and triangle pressure integration give its buoyancy and righting moment. The body also takes Froude-Krylov force rho V a,
//   Lamb added mass, quadratic drag, rotational strip drag and windage.
// - a member (a pile, a dolphin, a hose segment, a diver's limb) by Morison's equation over its wetted length at two Gauss
//   points, its drag and added mass coefficients from its roughness and Keulegan-Carpenter number (DNV-RP-C205), the
//   tangential drag of Eames, and optionally its vortex shedding by Facchinetti's wake oscillator, the lift 1/4 rho U^2 D
//   C_L0 q across the flow; a member on no body is fixed (a pile) and its load is reported.
// The added mass is held implicitly: (I + A D)(F_held + W) = F + W, with dry mobility D and added inertia A, so a body
// far lighter than the water it moves stays stable. The water's velocity and acceleration come from the sea
// (a `SeaSurface`'s `water`) plus any other flows (a ship's race, a river), the acceleration by a centred difference of the
// pure sample in time.
//
// State: the wake oscillators. Couple it before the rigid solver: `world.couple(['loads', 'rigid'], 'staggered')`.
import { pow } from '@margoengine/math/pinned';
import { invalidLoad } from './errors.js';
import type { FlowCell, FlowField, FlowSample, SeaSurface, Wind } from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { type HullMesh, type WettedLoads, wettedLoads } from '../seakeeping/wetted.js';
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
import {
  BODIES_FIELD,
  BODY_FORCES_FIELD,
  BODY_MOBILITY_FIELD,
  BODY_MOBILITY_WORDS,
  BODY_WORDS,
  bodyRowsOf,
  FORCE_WORDS,
} from '../world/solvers/rigid.js';
import { boxSurface, ellipsoidHydrostatics, meshBuoyancyCentre, meshHydrostatics } from './buoyancy.js';
import {
  analyticOutline,
  BUOYANCY,
  BUOYANCY_CENTRE,
  drawWetted,
  LineSink,
  LOAD,
  type LoadLines,
} from './debug-lines.js';
import { type CapsuleDimensions, capsuleHydrostatics, capsuleInertiaAxes, capsuleVolume } from './capsule.js';
import {
  compactDragArea,
  compactDragGeometry,
  type CompactDragGeometry,
  compactSpinTorque,
  compactWindLoad,
} from './compact-drag.js';
import {
  addCoupledRadiation,
  holdCoupledRadiation,
  prepareCoupledRadiation,
  type PreparedCoupledRadiation,
  validateCoupledCentre,
} from './coupled-radiation.js';
import {
  bindLoadsKernel,
  LOADS_KERNEL_COUPLED_WORDS,
  LOADS_KERNEL_WORDS,
  loadLoadsBuilds,
  type LoadsBuilds,
  type LoadsKernel,
} from './kernel.js';
import { cylinderCoefficients, tangentialDrag, wakeStep } from './morison.js';
import { memberOrbit } from './oscillatory.js';
import { type LocatedWater, localFlow, localSea } from './origin.js';
import { prepareCoupledRadiationProfile, type LoadCoupledRadiationProfile } from './radiation-coupled-profile.js';
import { rigidMobilityWords } from './rigid-mobility.js';
import {
  type LoadRadiationMode,
  type LoadRadiationResonance,
  prepareRadiation,
  prepareRadiationResonance,
  type RadiationMode,
  type RadiationResonance,
} from './radiation.js';
import { ellipsoidAddedInertia, ellipsoidAddedMass, equivalentEllipsoid } from './shapes.js';
import { smoothOscillatoryCylinder } from './smooth-cylinder.js';
import { flowAcceleration, waterAcceleration, waterVelocity } from './water.js';

type Vec3 = [number, number, number];
const LOADS_LAYOUT = 1;
/** Sea water's kinematic viscosity at 15 degrees C, m^2/s (DNV-RP-C205 table F-1). */
export const SEA_WATER_VISCOSITY = 1.19e-6;

/** The water a {@link LoadSolver} loads bodies in: its surface's height, its flow and its density. */
export type LoadWater = Pick<SeaSurface, 'elevation' | 'water' | 'density'>;

/** A compact body's shape in its frame, in metres. A capsule's straight section runs along local Y. */
export type LoadShape =
  | { readonly ellipsoid: readonly [number, number, number] }
  | { readonly sphere: number }
  | { readonly box: readonly [number, number, number] }
  | { readonly capsule: { readonly radius: number; readonly halfHeight: number } }
  | { readonly mesh: { readonly vertices: ArrayLike<number>; readonly indices: ArrayLike<number> } };

/** A compact body in the water. */
export interface LoadBody {
  readonly row: number;
  readonly shape: LoadShape;
  /** Where the shape's centre is in the body's frame, m (default the body's origin; a mesh's own centroid when a mesh). */
  readonly centre?: readonly [number, number, number];
  /**
   * The shape's turn in the body's frame about its centre, a unit quaternion [x, y, z, w] (default none): a box, capsule
   * or ellipsoid set at an angle on its body, as a collider's `rotation`. A mesh carries its turn in its vertices.
   */
  readonly rotation?: readonly [number, number, number, number];
  /** Drag coefficients along the shape's three axes. The default follows Reynolds number and shape. */
  readonly drag?: number | readonly [number, number, number];
  /** Scale the independent rotational viscous torque, default 1. */
  readonly spinDrag?: number;
  /** Added mass coefficients along its three axes (default Lamb's for the ellipsoid; 0.25 of the body's mass across for a diver, `0.68` for a cube). */
  readonly addedMass?: readonly [number, number, number];
  /** Rotational added inertia in m² per displaced kilogram, or 'ellipsoid' for Lamb's value. Default zero. */
  readonly addedInertia?: 'ellipsoid' | readonly [number, number, number];
  /** Passive exponential radiation kernels in the principal motions at the rigid centre of mass. Default empty. */
  readonly radiation?: readonly LoadRadiationMode[];
  /** Passive resonant radiation kernels in the principal motions at the rigid centre of mass. Default empty. */
  readonly radiationResonances?: readonly LoadRadiationResonance[];
  /** Optional six-motion radiation at the rigid COM, replacing the principal-axis added inertia and radiation options. */
  readonly coupledRadiation?: LoadCoupledRadiationProfile;
  /** 'surface' integrates incident pressure on a box or closed mesh. Default 'compact' uses a local plane and point acceleration. */
  readonly pressureModel?: 'compact' | 'surface';
  /** The wind's drag coefficient on its emerged area. The default follows Reynolds number and shape. */
  readonly windage?: number;
}

/** A member: a slender cylinder from `from` to `to` (in its body's frame, or the world's when it is on no body). */
export interface LoadMember {
  /** The body row it belongs to (default none: fixed in the world, as a pile). */
  readonly row?: number;
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  readonly diameter: number;
  /** Surface roughness k, m (default 5e-5, new steel; marine growth 5e-3 to 5e-2). */
  readonly roughness?: number;
  /** The dominant wave period in seconds (default 8), or Infinity for steady flow. */
  readonly period?: number;
  /** Use the measured smooth-cylinder interpolation for oscillatory flow. Default 'dnv' uses DNV/White. */
  readonly coefficients?: 'dnv' | 'sarpkaya-1976';
  /** Vortex shedding: Strouhal number and fixed-cylinder lift amplitude (default none; {strouhal: 0.2, lift: 0.3}). */
  readonly vortex?: {
    readonly strouhal?: number;
    readonly lift?: number;
  };
  /** Drive the coherent wake with the rigid midpoint's cross-flow acceleration. Default is free shedding. */
  readonly vortexCoupling?: 'body-acceleration';
}

/** What a {@link LoadSolver} is made from. */
export interface LoadParams {
  /**
   * The water's surface and motion: a `SeaSurface` (a SpectralSea, a NonlinearSea), or any `{elevation(x, z, t), water,
   * density}` (a flood: `{elevation: (x, z) => shallow.sample(x, z).surface, water: shallow.flow, density: 1000}`).
   */
  readonly sea: LoadWater;
  /** More water moving: currents, a ship's race (`ShipSolver.water`), a river (default none). */
  readonly flows?: readonly FlowField[];
  /** The wind, for the windage of floating bodies (default still air). */
  readonly wind?: Wind;
  readonly bodies?: readonly LoadBody[];
  readonly members?: readonly LoadMember[];
  /** The water's kinematic viscosity, m^2/s (default 1.19e-6). */
  readonly viscosity?: number;
  /** Metres per PhysicsWorld origin cell, default 4096. Match the containing world when it uses another cell size. */
  readonly cellSize?: number;
  /** Body rows its `bodyForces` port covers. Omit to use the world's rigid body capacity. */
  readonly capacity?: number;
  readonly level?: RateLevel;
}

interface BodyRuntime {
  readonly spec: LoadBody;
  readonly axes: Vec3;
  /** The shape's axes in the body's frame (rows). */
  readonly frame: [Vec3, Vec3, Vec3];
  readonly centre: Vec3;
  readonly volume: number;
  readonly addedMass: Vec3;
  readonly addedInertia: Vec3;
  readonly radiation: readonly RadiationMode[];
  readonly resonances: readonly RadiationResonance[];
  readonly coupledRadiation: PreparedCoupledRadiation | undefined;
  readonly dragGeometry: CompactDragGeometry;
  readonly sphere: boolean;
  /** A box's exact half extents, also used for its vertical support. */
  readonly box: Vec3 | undefined;
  readonly capsule: CapsuleDimensions | undefined;
  /** Body-local pressure integration surface relative to the geometric centre. */
  readonly mesh: HullMesh | undefined;
  /** What the last step found, for {@link LoadSolver.bodyLoad} and {@link LoadSolver.debugRender}. */
  readonly last: LastLoad;
  /** A closed surface to draw an analytic shape with, body frame about its centre (made on first draw). */
  outline?: HullMesh;
}

/** The pose and loads of a compact body at the last step, in the solver's origin cell. */
interface LastLoad {
  active: boolean;
  time: number;
  submerged: number;
  centre: Vec3;
  rotation: [number, number, number, number];
  /** Water height above the shape's centre at the centre, m. */
  depth: number;
  /** The centre of buoyancy from the centre, world axes (analytic shapes; NaN for meshes until asked). */
  offset: Vec3;
  buoyancy: Vec3;
  force: Vec3;
}

/** What the water did to a compact body at the last step: {@link LoadSolver.bodyLoad}. World axes, the solver's origin cell. */
export interface BodyLoad {
  /** Whether the body was in the last step (false before the first step or while its row is empty). */
  readonly active: boolean;
  /** Displaced volume, m^3. */
  readonly submerged: number;
  /** Displaced fraction of the shape's volume, 0 to 1. */
  readonly wet: number;
  /** The shape's centre, m. */
  readonly centre: Vec3;
  /** The centroid of the displaced volume below the local water plane, m (the shape's centre when dry). */
  readonly centreOfBuoyancy: Vec3;
  /** The water's height above the shape's centre at the centre, m: the draft reference of the local plane. */
  readonly depth: number;
  /** Buoyancy, N: rho g V up, or the integrated pressure with `pressureModel: 'surface'`. */
  readonly buoyancy: Vec3;
  /**
   * The water's other loads before the added-mass hold, N, through the shape's centre: Froude-Krylov, the water's
   * acceleration on the added mass, drag and windage.
   */
  readonly force: Vec3;
}

/** What {@link LoadSolver.debugRender} draws; every field has a default. */
export interface LoadDebugOptions {
  /** The shape's edges below the water, blue (default true). */
  readonly submerged?: boolean;
  /** Where the water's surface cuts the shape, white (default true). */
  readonly waterline?: boolean;
  /** A cross at the centre of buoyancy, magenta (default true). */
  readonly centreOfBuoyancy?: boolean;
  /** Buoyancy from the centre of buoyancy, cyan, and the other loads from the shape's centre, orange (default true). */
  readonly forces?: boolean;
  /**
   * Arrow length in metres per newton (default: each body's own, so its full-immersion buoyancy draws as long as the
   * cube root of its volume times 2).
   */
  readonly forceScale?: number;
}

interface BodyLoads {
  mass: number;
  force: Vec3;
  torque: Vec3;
  added: Float64Array;
  rotational?: Float64Array;
  coupled?: Float64Array;
}

/** A member's load from the last step, world axes: force, N, at its middle, and its wake's lift coefficient. */
export interface MemberLoad {
  force: Vec3;
  lift: number;
}

/** Options for reading a rigid body's mobility. */
export interface LoadSolverOptions {
  /** Read effective mobility when the rigid solver publishes it (default true). Disable for snapshots from before this read was added. */
  readonly readMobility?: boolean;
}

/** The water's loads on bodies and members. `id` is `'loads'` by default. */
export class LoadSolver implements Solver<LoadParams> {
  /** Create a solver that holds body wrenches in one optional Rust/SIMD batch. */
  static async load({
    id = 'loads',
    signal,
    readMobility,
  }: LoadSolverOptions & {
    readonly id?: string;
    readonly signal?: AbortSignal;
  } = {}): Promise<LoadSolver> {
    const solver = new LoadSolver(id, { readMobility });
    solver.builds = await loadLoadsBuilds(signal);
    return solver;
  }

  private readonly id: string;
  private readonly readMobility: boolean;
  private host!: SolverHost;
  private level: RateLevel = 0;
  private g = 9.81;
  private nu = SEA_WATER_VISCOSITY;
  private sea!: LocatedWater;
  private flows: readonly FlowField[] = [];
  private wind: Wind | undefined;
  private bodies: BodyRuntime[] = [];
  private members: readonly LoadMember[] = [];
  private memberLoads: MemberLoad[] = [];
  private forces!: Region;
  private wakes!: Region;
  private wakeMotion: Region | undefined;
  private history: Region | undefined;
  private hasCoupledRadiation = false;
  private builds: LoadsBuilds | undefined;
  private native: { kernel: LoadsKernel; scratch: Region } | undefined;
  private heldBodies = 0;
  private batchCalls = 0;
  private cell: [number, number, number] = [0, 0, 0];
  private sampleCell: FlowCell = [0, 0, 0];
  private cellSize = 4096;
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly hydrostatic: WettedLoads = { force: [0, 0, 0], torque: [0, 0, 0], area: 0 };
  private readonly pressure: WettedLoads = { force: [0, 0, 0], torque: [0, 0, 0], area: 0 };

  constructor(id = 'loads', { readMobility = true }: LoadSolverOptions = {}) {
    this.id = id;
    this.readMobility = readMobility;
  }

  /** Counts from the last step. Native workspace size remains fixed for the world's row capacity. */
  workCounts(): { readonly heldBodies: number; readonly batchCalls: number; readonly scratchBytes: number } {
    return {
      heldBodies: this.heldBodies,
      batchCalls: this.batchCalls,
      scratchBytes: this.native?.scratch.byteLength ?? 0,
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        ...(this.readMobility ? [{ field: BODY_MOBILITY_FIELD, access: 'read' as const, optional: true }] : []),
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  init(host: SolverHost, params: LoadParams): void {
    const {
      sea,
      flows = [],
      wind,
      bodies = [],
      members = [],
      viscosity = SEA_WATER_VISCOSITY,
      cellSize = 4096,
      level = 0,
    } = params ?? ({} as LoadParams);
    if (!sea || typeof sea.elevation !== 'function' || typeof sea.water?.sample !== 'function')
      throw invalidLoad(
        'Loads in the water need the water: pass {sea}, a SeaSurface (a SpectralSea or NonlinearSea) or {elevation, water, density}.',
      );
    if (!(sea.density > 0 && Number.isFinite(sea.density)))
      throw invalidLoad('Invalid water density for hydrodynamic loads; pass positive finite kg/m³.');
    if (!(viscosity > 0 && Number.isFinite(viscosity)))
      throw invalidLoad(`A kinematic viscosity is finite m^2/s above 0 (got ${viscosity}); pass one, or 1.19e-6.`);
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw invalidLoad(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    if (!(Number.isFinite(cellSize) && cellSize > 0))
      throw invalidLoad('Invalid hydrodynamic origin cell size; use the positive length in metres from PhysicsWorld.');
    this.host = host;
    this.g = gravityMagnitude(host.gravity ?? DEFAULT_GRAVITY);
    this.cellSize = cellSize;
    const offsetOf = (cell: FlowCell) => this.offsetOf(cell);
    this.sea = localSea(sea, offsetOf);
    this.flows = flows.map((flow) => localFlow(flow, offsetOf));
    this.wind = wind && localFlow(wind, offsetOf);
    this.nu = viscosity;
    this.level = level as RateLevel;
    const rows: number[] = [];
    let radiationWords = 1;
    const dt = 1 / rateOf(this.level);
    this.bodies = bodies.map((spec) => {
      if (!(Number.isInteger(spec?.row) && spec.row >= 0))
        throw invalidLoad(`A body's row is a whole number, 0 or more (got ${spec?.row}); pass the body's row.`);
      rows.push(spec.row);
      let coupled: PreparedCoupledRadiation | undefined;
      if (spec.coupledRadiation !== undefined) {
        if (
          spec.addedMass !== undefined ||
          spec.addedInertia !== undefined ||
          spec.radiation !== undefined ||
          spec.radiationResonances !== undefined
        )
          throw invalidLoad(
            'Coupled radiation already includes water inertia and memory; supply only coupledRadiation.',
          );
        const profile = prepareCoupledRadiationProfile(spec.coupledRadiation);
        if (profile.density !== sea.density)
          throw invalidLoad(
            'Coupled radiation density differs from the water; generate the profile using sea.density.',
          );
        coupled = prepareCoupledRadiation(profile, dt, radiationWords);
        radiationWords += coupled.words;
      }
      if (spec.radiation !== undefined && !Array.isArray(spec.radiation))
        throw invalidLoad('Invalid radiation modes; supply an array of axis, strength and decayTime records.');
      const modes = (spec.radiation ?? []).map((mode) => {
        const prepared = prepareRadiation(mode, dt, radiationWords);
        radiationWords += 2;
        return prepared;
      });
      if (spec.radiationResonances !== undefined && !Array.isArray(spec.radiationResonances))
        throw invalidLoad(
          'Invalid radiation resonances; supply an array of axis, frequency, decayRate and strength records.',
        );
      const resonances = (spec.radiationResonances ?? []).map((mode) => {
        const prepared = prepareRadiationResonance(mode, dt, radiationWords);
        radiationWords += 3;
        return prepared;
      });
      return this.prepare(spec, modes, resonances, coupled);
    });
    this.hasCoupledRadiation = this.bodies.some((body) => body.coupledRadiation !== undefined);
    for (const m of members) {
      if (
        !(
          m?.diameter > 0 &&
          Number.isFinite(m.diameter) &&
          m.from?.length === 3 &&
          m.to?.length === 3 &&
          [...m.from, ...m.to].every(Number.isFinite)
        )
      )
        throw invalidLoad(
          'A member is {from: [x, y, z], to: [x, y, z], diameter} in metres, its diameter above 0; pass them.',
        );
      if (m.row !== undefined) {
        if (!(Number.isInteger(m.row) && m.row >= 0))
          throw invalidLoad(
            `A member's row is a whole number, 0 or more, or none for a fixed pile (got ${m.row}); pass one.`,
          );
        rows.push(m.row);
      }
      if (m.period !== undefined && !(m.period > 0))
        throw invalidLoad('Invalid member wave period; pass positive seconds, or Infinity for steady flow.');
      if (m.roughness !== undefined && !(m.roughness >= 0 && Number.isFinite(m.roughness)))
        throw invalidLoad('Invalid member roughness; pass a finite nonnegative roughness in metres.');
      if (m.coefficients !== undefined && m.coefficients !== 'dnv' && m.coefficients !== 'sarpkaya-1976')
        throw invalidLoad("Invalid member coefficient model; choose 'dnv' or 'sarpkaya-1976'.");
      if (m.coefficients === 'sarpkaya-1976' && m.roughness !== undefined && m.roughness !== 0)
        throw invalidLoad(
          "The 'sarpkaya-1976' member model needs a smooth cylinder; set roughness to 0 or select 'dnv'.",
        );
      if (m.vortexCoupling !== undefined) {
        const { strouhal = 0.2, lift = 0.3 } = m.vortex ?? {};
        if (
          m.vortexCoupling !== 'body-acceleration' ||
          m.row === undefined ||
          !m.from.some((value, axis) => value !== m.to[axis]) ||
          !(strouhal > 0 && Number.isFinite(strouhal) && lift >= 0 && Number.isFinite(lift))
        )
          throw invalidLoad(
            'Use body-acceleration vortex coupling on a finite-length rigid member with positive Strouhal number and nonnegative lift.',
          );
      }
    }
    this.members = members;
    this.memberLoads = members.map(() => ({ force: [0, 0, 0], lift: 0 }));
    const capacity = rows.length > 0 ? bodyRowsOf(host, this.id, rows) : (params.capacity ?? 0);
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 0 ||
      (params.capacity !== undefined && params.capacity !== capacity)
    )
      throw invalidLoad('Invalid hydrodynamic force capacity; omit capacity to use the world body rows.');
    this.forces = host.allocate('forces', Math.max(1, capacity) * FORCE_WORDS * 8, 'f64', LOADS_LAYOUT);
    this.wakes = host.allocate('wakes', Math.max(1, members.length) * 2 * 8, 'f64', LOADS_LAYOUT);
    if (members.some((member) => member.vortexCoupling === 'body-acceleration'))
      this.wakeMotion = host.allocate('wake-motion', members.length * 4 * 8, 'f64', LOADS_LAYOUT);
    if (radiationWords > 1) this.history = host.allocate('radiation', radiationWords * 8, 'f64', LOADS_LAYOUT);
    if (this.builds) {
      const kernel = bindLoadsKernel(host, this.builds);
      const stride = this.hasCoupledRadiation ? LOADS_KERNEL_COUPLED_WORDS : LOADS_KERNEL_WORDS;
      const scratch = host.allocate('held-wrench-scratch', Math.max(1, capacity) * stride * 8, 'f64', LOADS_LAYOUT);
      this.native = { kernel, scratch };
    }
    // The wake oscillators start at the free van der Pol cycle's amplitude, q = 2.
    const wakes = regionWords(host.memory, this.wakes) as Float64Array;
    for (let i = 0; i < members.length; i++) wakes[2 * i] = 2;
  }

  /** A body's equivalent ellipsoid, frame and added mass. */
  private prepare(
    spec: LoadBody,
    radiation: readonly RadiationMode[],
    resonances: readonly RadiationResonance[],
    coupledRadiation: PreparedCoupledRadiation | undefined,
  ): BodyRuntime {
    const shape = spec.shape;
    if (!shape || typeof shape !== 'object')
      throw invalidLoad('Missing hydrodynamic shape; pass {ellipsoid}, {sphere}, {box}, {capsule} or {mesh}.');
    let axes: Vec3,
      frame: [Vec3, Vec3, Vec3] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      centre: Vec3 = spec.centre ? [spec.centre[0], spec.centre[1], spec.centre[2]] : [0, 0, 0],
      volume: number | undefined,
      mesh: HullMesh | undefined,
      capsule: CapsuleDimensions | undefined,
      box: Vec3 | undefined;
    if (!centre.every(Number.isFinite))
      throw invalidLoad('Invalid hydrodynamic shape centre; pass three finite coordinates in metres.');
    if ('sphere' in shape) {
      const r = shape.sphere;
      axes = [r, r, r];
    } else if ('ellipsoid' in shape) {
      const h = shape.ellipsoid;
      axes = [h?.[0], h?.[1], h?.[2]];
    } else if ('box' in shape) {
      // A box as the ellipsoid of its second moments: semi-axes sqrt(5/3) of its half extents, its volume kept below.
      const h = shape.box;
      box = [h?.[0], h?.[1], h?.[2]];
      axes = box.map((a) => a * Math.sqrt(5 / 3)) as Vec3;
      volume = 8 * box[0] * box[1] * box[2];
      mesh = boxSurface(box);
    } else if ('capsule' in shape) {
      const dimensions = shape.capsule;
      if (
        !dimensions ||
        !Number.isFinite(dimensions.radius) ||
        dimensions.radius <= 0 ||
        !Number.isFinite(dimensions.halfHeight) ||
        dimensions.halfHeight < 0 ||
        !Number.isFinite(dimensions.radius + dimensions.halfHeight)
      )
        throw invalidLoad('Invalid hydrodynamic capsule; pass a positive radius and nonnegative halfHeight in metres.');
      const { radius, halfHeight } = dimensions;
      capsule = { radius, halfHeight };
      axes = capsuleInertiaAxes(radius, halfHeight);
      volume = capsuleVolume(radius, halfHeight);
    } else if ('mesh' in shape) {
      const e = equivalentEllipsoid(shape.mesh);
      axes = e.axes;
      frame = e.directions;
      if (!spec.centre) centre = e.centre;
      volume = e.volume;
      mesh = {
        vertices: Float64Array.from(shape.mesh.vertices, (v, i) => v - e.centre[i % 3]!),
        indices: Uint32Array.from(shape.mesh.indices),
      };
    } else throw invalidLoad('Missing hydrodynamic shape; pass {ellipsoid}, {sphere}, {box}, {capsule} or {mesh}.');
    if (spec.rotation !== undefined) {
      const turn = spec.rotation,
        length =
          Array.isArray(turn) && turn.length === 4
            ? Math.sqrt(turn[0] * turn[0] + turn[1] * turn[1] + turn[2] * turn[2] + turn[3] * turn[3])
            : NaN;
      if (!(Math.abs(length - 1) < 1e-5))
        throw invalidLoad(
          'Invalid hydrodynamic shape rotation; pass a unit quaternion [x, y, z, w] in the body frame.',
        );
      if ('mesh' in shape)
        throw invalidLoad('A mesh shape carries its turn in its vertices; turn them and leave rotation out.');
      const q = turn.map((value) => value / length) as [number, number, number, number];
      frame = frame.map((row) => rotate(q, row)) as [Vec3, Vec3, Vec3];
      if (mesh) {
        const v = mesh.vertices,
          turned = new Float64Array(v.length);
        for (let i = 0; i < v.length; i += 3) turned.set(rotate(q, [v[i]!, v[i + 1]!, v[i + 2]!]), i);
        mesh = { vertices: turned, indices: mesh.indices };
      }
    }
    if (!axes.every((a) => a > 0 && Number.isFinite(a)))
      throw invalidLoad('Invalid hydrodynamic shape size; pass three positive finite dimensions or a positive radius.');
    volume ??= (4 / 3) * Math.PI * axes[0] * axes[1] * axes[2];
    if (!(volume > 0 && Number.isFinite(volume)))
      throw invalidLoad('Hydrodynamic shape volume is outside numeric range; pass physical dimensions in metres.');
    if (spec.pressureModel !== undefined && spec.pressureModel !== 'compact' && spec.pressureModel !== 'surface')
      throw invalidLoad("Invalid pressure model; choose 'compact' or 'surface'.");
    if (spec.pressureModel === 'surface' && (!mesh || typeof this.sea.pressure !== 'function'))
      throw invalidLoad(
        "Surface pressure needs a box or closed mesh and sea.pressure; supply both or choose 'compact'.",
      );
    const drag = spec.drag;
    const validDrag = (coefficient: number) => coefficient >= 0 && Number.isFinite(coefficient);
    if (
      drag !== undefined &&
      !(typeof drag === 'number' ? validDrag(drag) : Array.isArray(drag) && drag.length === 3 && drag.every(validDrag))
    )
      throw invalidLoad(
        'Invalid body drag; give one finite nonnegative coefficient or three coefficients along the shape axes.',
      );
    if (!validDrag(spec.spinDrag ?? 1) || !validDrag(spec.windage ?? 1))
      throw invalidLoad('Invalid wind or spin drag; supply finite nonnegative windage and spinDrag values.');
    const sphere = capsule ? capsule.halfHeight === 0 : Math.max(...axes) < 1.05 * Math.min(...axes),
      addedMass = (
        coupledRadiation ? [0, 0, 0] : spec.addedMass ? [...spec.addedMass] : ellipsoidAddedMass(axes)
      ) as Vec3;
    if (addedMass.length !== 3 || !addedMass.every((coefficient) => coefficient >= 0 && Number.isFinite(coefficient)))
      throw invalidLoad('Invalid hydrodynamic added mass; supply three finite nonnegative coefficients.');
    if (spec.addedInertia !== undefined && spec.addedInertia !== 'ellipsoid' && !Array.isArray(spec.addedInertia))
      throw invalidLoad('Invalid rotational added inertia; give three finite nonnegative m² values or use ellipsoid.');
    const addedInertia =
      spec.addedInertia === 'ellipsoid' ? ellipsoidAddedInertia(axes) : ([...(spec.addedInertia ?? [0, 0, 0])] as Vec3);
    if (
      addedInertia.length !== 3 ||
      !addedInertia.every((coefficient) => coefficient >= 0 && Number.isFinite(coefficient))
    )
      throw invalidLoad('Invalid rotational added inertia; give three finite nonnegative m² values or use ellipsoid.');
    const dragGeometry = compactDragGeometry(volume, axes, frame, mesh, box, capsule);
    return {
      spec,
      axes,
      frame,
      centre,
      volume,
      addedMass,
      addedInertia,
      radiation,
      resonances,
      coupledRadiation,
      dragGeometry,
      sphere,
      box,
      capsule,
      mesh,
      last: {
        active: false,
        time: 0,
        submerged: 0,
        centre: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        depth: -Infinity,
        offset: [0, 0, 0],
        buoyancy: [0, 0, 0],
        force: [0, 0, 0],
      },
    };
  }

  /** The water's velocity at a point and time: the sea's water plus every flow (water.ts). */
  private water(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    return waterVelocity(this.sea, this.flows, x, y, z, t, this.sample, out);
  }

  /** The water's acceleration at a point: a centred difference of its pure velocity over 2 ms (water.ts). */
  private acceleration(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    return waterAcceleration(this.sea, this.flows, x, y, z, t, this.sample, out);
  }

  private offsetOf(cell: FlowCell): Vec3 {
    return [
      (this.sampleCell[0] - cell[0]) * this.cellSize,
      (this.sampleCell[1] - cell[1]) * this.cellSize,
      (this.sampleCell[2] - cell[2]) * this.cellSize,
    ];
  }

  step(context: StepContext, _dt: number): void {
    if (this.history && context.level !== this.level)
      throw invalidLoad(
        'Radiation memory needs a fixed rate; match the Loads level to its coupling group or use a staggered group.',
      );
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    this.sampleCell = port?.cell ?? this.cell;
    const out = regionWords(this.host.memory, this.forces) as Float64Array,
      wakes = regionWords(this.host.memory, this.wakes) as Float64Array,
      wakeMotion = this.wakeMotion ? (regionWords(this.host.memory, this.wakeMotion) as Float64Array) : undefined,
      dt = 1 / rateOf(context.level),
      t = (context.tick + 0.5) / rateOf(context.level),
      rho = this.sea.density,
      history = this.history ? (regionWords(this.host.memory, this.history) as Float64Array) : undefined;
    out.fill(0);
    this.rows.clear();
    const bodies = port
      ? new Float32Array(
          (port.region.memory ?? this.host.memory).buffer,
          port.region.byteOffset,
          port.region.byteLength / 4,
        )
      : undefined;
    const mobility =
      port && bodies && this.readMobility
        ? rigidMobilityWords(
            this.host.memory,
            context.inputs.get(BODY_MOBILITY_FIELD.name),
            port.tick,
            port.cell,
            bodies.length / BODY_WORDS,
          )
        : undefined;
    for (const b of this.bodies) {
      b.last.active = false;
      if (!bodies) continue;
      const at = b.spec.row * BODY_WORDS;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) continue;
      this.loadBody(b, bodies, at, t, dt, rho, history);
    }
    this.members.forEach((m, index) => this.loadMember(m, index, bodies, t, dt, rho, wakes, wakeMotion));
    this.heldBodies = this.rows.size;
    this.batchCalls = 0;
    if (this.native && bodies && this.heldBodies > 0 && (!mobility || mobility.buffer === this.host.memory.buffer))
      this.holdNative(bodies, this.native, mobility);
    else this.hold(out, bodies, mobility);
    if (history) history[0] = 1;
  }

  /** A compact body's load, held with its added mass. */
  private loadBody(
    b: BodyRuntime,
    bodies: Float32Array,
    at: number,
    t: number,
    dt: number,
    rho: number,
    history: Float64Array | undefined,
  ): void {
    const q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
      origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
      cm: Vec3 = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!],
      v: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
      w: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
      inverseMass = bodies[at + 16]!,
      mass = inverseMass > 0 ? 1 / inverseMass : 0;
    if (mass === 0) return;
    if (b.coupledRadiation) validateCoupledCentre(b.coupledRadiation, q, origin, cm);
    const centre = add(origin, rotate(q, b.centre)),
      axesWorld = b.frame.map((d) => rotate(q, d)) as [Vec3, Vec3, Vec3],
      surface = this.sea.elevation(centre[0], centre[2], t);
    if (!Number.isFinite(surface))
      throw invalidLoad('Non-finite hydrodynamic surface height; return a finite elevation in metres.');
    const depth = surface - centre[1];
    // The displaced water is taken at the pose (s - 1) / (2 s) of the step on, the body's velocity and spin carried over
    // it, where a restoring load held through the step neither feeds the motion's energy nor takes it: the rigid step moves
    // a body by (v + F dt (s + 1) / (2 s m)) dt over its s symplectic-Euler substeps (the port gives s), so a load -k x
    // taken at x + theta v dt updates with determinant 1 + (w dt)^2 (1 - theta - (s + 1) / (2 s)), 1 at theta =
    // (s - 1) / (2 s), as the hull solver takes its loads (seakeeping/solver.ts). Taken where the step starts, a floating box
    // gained 1.8 % of its heave amplitude a cycle at 240 steps a second and 20 % at 60 (KB-LOADS-HEAVEGAIN1). The loads
    // that follow the velocity (drag, added mass, radiation, wind) stay at the step's start.
    const substeps = Math.max(1, bodies[at + 24]!),
      ahead = ((substeps - 1) / (2 * substeps)) * dt,
      spinning = ahead > 0 && (w[0] !== 0 || w[1] !== 0 || w[2] !== 0),
      hq = spinning ? turnBy(q, w, ahead) : q,
      shift: Vec3 = [v[0] * ahead, v[1] * ahead, v[2] * ahead],
      hcm = add(cm, shift),
      // The origin rides with the centre of mass and turns about it.
      horigin = spinning
        ? add(hcm, rotate(hq, rotate([-q[0], -q[1], -q[2], q[3]], sub(origin, cm))))
        : add(origin, shift),
      hcentre = spinning ? add(horigin, rotate(hq, b.centre)) : add(centre, shift),
      haxes = spinning ? (b.frame.map((d) => rotate(hq, d)) as [Vec3, Vec3, Vec3]) : axesWorld,
      [ax, ay, az] = b.axes,
      // The ellipsoid's half-height along the vertical (its support function along up).
      h0 = ax * haxes[0][1],
      h1 = ay * haxes[1][1],
      h2 = az * haxes[2][1],
      // Vertical support bounds for the compact and ellipsoid calculations.
      half = b.box
        ? Math.abs(b.box[0] * haxes[0][1]) + Math.abs(b.box[1] * haxes[1][1]) + Math.abs(b.box[2] * haxes[2][1])
        : Math.sqrt(h0 * h0 + h1 * h1 + h2 * h2),
      hsurface = ahead > 0 ? this.sea.elevation(hcentre[0], hcentre[2], t) : surface;
    if (!Number.isFinite(hsurface))
      throw invalidLoad('Non-finite hydrodynamic surface height; return a finite elevation in metres.');
    const hdepth = hsurface - hcentre[1];
    const densityGravity = rho * this.g;
    const surfacePressure = b.spec.pressureModel === 'surface';
    const force: Vec3 = [0, 0, 0];
    let submerged: number;
    let torque: Vec3;
    // The centre of buoyancy from the centre for the analytic shapes; a mesh's is found when asked (bodyLoad).
    let analyticOffset: Vec3 = [NaN, NaN, NaN];
    if (surfacePressure) {
      const pose = { position: hcentre, rotation: hq };
      wettedLoads(
        b.mesh!,
        pose,
        {
          elevation: (x, z, time) => this.sea.elevation(x, z, time),
          pressure: (x, y, z, time) => Math.max(0, this.sea.elevation(x, z, time) - y),
        },
        t,
        hcm,
        this.hydrostatic,
      );
      submerged = Math.max(0, Math.min(b.volume, this.hydrostatic.force[1]));
      wettedLoads(b.mesh!, pose, this.sea, t, hcm, this.pressure);
      torque = [...this.pressure.torque];
      if (!this.pressure.force.every(Number.isFinite) || !torque.every(Number.isFinite))
        throw invalidLoad(
          'Non-finite mesh pressure load; return finite water elevations and gauge pressure in pascals.',
        );
    } else if (b.mesh) {
      meshHydrostatics(b.mesh, hq, hdepth, sub(hcm, hcentre), this.hydrostatic);
      submerged = Math.max(0, Math.min(b.volume, this.hydrostatic.force[1]));
      torque = [densityGravity * this.hydrostatic.torque[0], 0, densityGravity * this.hydrostatic.torque[2]];
    } else {
      const offset: Vec3 = [0, 0, 0];
      submerged = b.capsule
        ? capsuleHydrostatics(b.capsule, haxes[1], hdepth, b.volume, offset)
        : b.volume * ellipsoidHydrostatics(b.axes, haxes, half, hdepth, offset);
      analyticOffset = offset;
      const buoyancyArm = add(sub(hcentre, hcm), offset);
      torque = cross(buoyancyArm, [0, densityGravity * submerged, 0]);
    }
    const wet = submerged / b.volume;
    const buoyancy = densityGravity * submerged;
    const last = b.last;
    last.active = true;
    last.time = t;
    last.submerged = submerged;
    // The pose the displaced water was taken at.
    last.centre = hcentre;
    last.rotation = hq;
    last.depth = hdepth;
    last.force = force;
    last.buoyancy = surfacePressure ? [...this.pressure.force] : [0, buoyancy, 0];
    last.offset = analyticOffset;
    let added: Vec3 = [0, 0, 0];
    const spinInertia: Vec3 = [0, 0, 0];
    if (wet > 0) {
      const u = this.water(centre[0], Math.min(centre[1], surface), centre[2], t, [0, 0, 0]),
        a = this.acceleration(centre[0], Math.min(centre[1], surface), centre[2], t, [0, 0, 0]),
        vc = add(v, cross(w, sub(centre, cm))),
        vr = sub(u, vc),
        speed = Math.sqrt(dot(vr, vr));
      // Surface pressure already contains the sea's incident acceleration. Only the additional flows
      // still need the velocity-derived displaced-water force.
      const incident = surfacePressure
        ? this.flows.length === 0
          ? [0, 0, 0]
          : flowAcceleration(
              undefined,
              this.flows,
              centre[0],
              Math.min(centre[1], surface),
              centre[2],
              t,
              this.sample,
              [0, 0, 0],
            )
        : a;
      for (let k = 0; k < 3; k++) force[k]! += rho * submerged * incident[k]!;
      // Added mass per axis: its part pushed by the water's acceleration, rho C_A V a; the part the body's own acceleration
      // takes is held implicitly below.
      added = b.addedMass.map((c) => c * rho * submerged) as Vec3;
      for (let i = 0; i < 3; i++) {
        const along = dot(a, axesWorld[i]!);
        for (let k = 0; k < 3; k++) force[k]! += added[i]! * along * axesWorld[i]![k]!;
      }
      // Use the actual projection normal to each principal axis and the local relative speed.
      const geometry = b.dragGeometry;
      const given = b.spec.drag;
      for (let i = 0; i < 3; i++) {
        const axis = axesWorld[i]!;
        const area = compactDragArea(
          geometry,
          speed,
          this.nu,
          geometry.areas[i]!,
          b.sphere,
          typeof given === 'number' ? given : given?.[i],
          i,
        );
        const damping = 0.5 * rho * area * wet * speed;
        const spin = dot(w, axis);
        const f = damping * dot(vr, axis);
        const m = compactSpinTorque(geometry, i, spin, wet, rho, this.nu, b.spec.spinDrag);
        // Freeze the positive slip and spin coefficients, then hold the resulting
        // drag at the end-of-step velocity. This keeps a strong drag from reversing a light body.
        added[i]! += dt * damping;
        if (spin !== 0) spinInertia[i] = (-dt * m) / spin;
        for (let k = 0; k < 3; k++) {
          force[k]! += f * axis[k]!;
          torque[k]! += m * axis[k]!;
        }
      }
    }
    const wind = this.wind;
    if (wind) {
      const load = compactWindLoad(
        b.dragGeometry,
        axesWorld,
        q,
        depth,
        v,
        w,
        sub(centre, cm),
        (offset) => wind.sample(centre[0] + offset[0], centre[1] + offset[1], centre[2] + offset[2], t, this.sample),
        b.sphere,
        b.spec.windage,
      );
      if (load) {
        const arm = cross(load.offset, load.force);
        for (let k = 0; k < 3; k++) {
          force[k]! += load.force[k]!;
          torque[k]! += arm[k]!;
        }
      }
    }
    // The added mass tensor sum_i A_i e_i e_i^T in world axes, held with the row's other loads.
    const acc = this.rowOf(b.spec.row, mass),
      arm = cross(sub(centre, cm), force);
    for (let k = 0; k < 3; k++) {
      acc.force[k]! += force[k]!;
      acc.torque[k]! += torque[k]! + arm[k]!;
    }
    if (surfacePressure) {
      for (let k = 0; k < 3; k++) acc.force[k]! += this.pressure.force[k]!;
    } else acc.force[1] += buoyancy;
    for (let axis = 0; axis < 3; axis++) {
      addInertiaAxis(acc.added, axesWorld[axis]!, added[axis]!);
      const inertia = b.addedInertia[axis]! * rho * submerged + spinInertia[axis]!;
      if (inertia > 0) addInertiaAxis((acc.rotational ??= new Float64Array(9)), axesWorld[axis]!, inertia);
    }
    if (history) {
      if (b.coupledRadiation) addCoupledRadiation(acc, b.coupledRadiation, q, v, w, wet, dt, history);
      const exposed = Math.sqrt(wet);
      for (const mode of b.radiation) {
        const angular = mode.axis >= 3;
        const direction = axesWorld[mode.axis % 3]!;
        const velocity = dot(angular ? w : v, direction);
        const previous = mode.index;
        if (history[0] === 1)
          history[previous] = mode.decay * history[previous]! + mode.integral * history[previous + 1]! * velocity;
        history[previous + 1] = exposed;
        // Eliminate the end-of-step velocity from the implicit exponential update.
        // Its incremental acceleration contributes a positive term on the inertial side.
        const load = -mode.strength * exposed * (mode.decay * history[previous]! + mode.integral * exposed * velocity);
        const inertia = mode.strength * mode.integral * wet * dt;
        addRadiationWrench(acc, direction, angular, load, inertia);
      }
      for (const resonance of b.resonances) {
        const angular = resonance.axis >= 3;
        const direction = axesWorld[resonance.axis % 3]!;
        const velocity = dot(angular ? w : v, direction);
        const previous = resonance.index;
        if (history[0] === 1) {
          history[previous + 1] =
            resonance.inverse *
            (history[previous + 1]! -
              resonance.stiffnessTime * history[previous]! +
              dt * history[previous + 2]! * velocity);
          history[previous]! += dt * history[previous + 1]!;
        }
        history[previous + 2] = exposed;
        const predicted =
          resonance.inverse *
          (history[previous + 1]! - resonance.stiffnessTime * history[previous]! + dt * exposed * velocity);
        const inertia = resonance.strength * wet * dt * dt * resonance.inverse;
        addRadiationWrench(acc, direction, angular, -resonance.strength * exposed * predicted, inertia);
      }
    }
  }

  /** The loads gathered for a body row this step. */
  private rows = new Map<number, BodyLoads>();
  private rowOf(row: number, mass: number): BodyLoads {
    let r = this.rows.get(row);
    if (!r) {
      r = { mass, force: [0, 0, 0], torque: [0, 0, 0], added: new Float64Array(9) };
      this.rows.set(row, r);
    }
    return r;
  }

  /** Writes each dry-body wrench that produces the acceleration of the body and its carried water. */
  private hold(out: Float64Array, bodies: Float32Array | undefined, mobility: Float32Array | undefined): void {
    for (const [row, r] of this.rows) {
      const m = r.mass,
        W: Vec3 = [0, -m * this.g, 0],
        F = add(r.force, W),
        at = row * FORCE_WORDS,
        free = freeTranslation(mobility, row),
        angular = mobility ?? bodies,
        inertia = mobility ? row * BODY_MOBILITY_WORDS + 3 : row * BODY_WORDS + 17;
      if (r.coupled && bodies) {
        const held = holdCoupledRadiation(r.coupled, r.added, r.rotational, scale(free, 1 / m), angular!, inertia, [
          ...F,
          ...r.torque,
        ]);
        for (let k = 0; k < 3; k++) {
          out[at + k]! += held[k]! - W[k]!;
          out[at + 3 + k]! += held[k + 3]!;
        }
        continue;
      }
      const M = projectTranslation(r.added, free);
      for (let k = 0; k < 3; k++) M[4 * k]! += m;
      const inverse = invert3(M),
        held: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++)
        held[k] = m * (inverse[3 * k]! * F[0] + inverse[3 * k + 1]! * F[1] + inverse[3 * k + 2]! * F[2]);
      const torque = r.rotational && angular ? holdTorque(r.torque, r.rotational, angular, inertia) : r.torque;
      for (let k = 0; k < 3; k++) {
        out[at + k]! += held[k]! - W[k]!;
        out[at + 3 + k]! += torque[k]!;
      }
    }
    this.rows.clear();
  }

  private holdNative(
    bodies: Float32Array,
    { kernel, scratch }: { kernel: LoadsKernel; scratch: Region },
    mobility: Float32Array | undefined,
  ): void {
    const words = regionWords(this.host.memory, scratch) as Float64Array;
    // Keep ordinary 32-word rows at the front and coupled rows at the end of one arena region.
    let regular = 0;
    let coupled = words.length;
    for (const [row, load] of this.rows) {
      const matrix = load.coupled;
      const at = matrix ? coupled - LOADS_KERNEL_COUPLED_WORDS : regular;
      if (matrix) coupled = at;
      else regular += LOADS_KERNEL_WORDS;
      words[at] = row;
      words[at + 1] = load.mass;
      words.set(load.force, at + 2);
      words.set(load.torque, at + 5);
      if (matrix) {
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) {
            const axis = 3 * i + j;
            words[at + 8 + axis] = matrix[6 * i + j]! + load.added[axis]!;
            const angular = matrix[6 * (i + 3) + j + 3]!;
            words[at + 17 + axis] = load.rotational ? angular + load.rotational[axis]! : angular;
            words[at + LOADS_KERNEL_WORDS + axis] = matrix[6 * i + j + 3]!;
          }
      } else {
        words.set(mobility ? projectTranslation(load.added, freeTranslation(mobility, row)) : load.added, at + 8);
        if (load.rotational) words.set(load.rotational, at + 17);
        else words.fill(0, at + 17, at + 26);
      }
      const angular = mobility ?? bodies;
      const inertia = mobility ? row * BODY_MOBILITY_WORDS + 3 : row * BODY_WORDS + 17;
      for (let axis = 0; axis < 6; axis++) words[at + 26 + axis] = angular[inertia + axis]!;
    }
    const forceRows = this.forces.byteLength / (FORCE_WORDS * 8);
    const run = (hold: LoadsKernel['loads_hold'], from: number, count: number): void => {
      if (count === 0) return;
      const result = hold(scratch.byteOffset + from * 8, count, this.forces.byteOffset, forceRows, this.g);
      if (result !== 0)
        throw invalidLoad(
          `Cannot hold hydrodynamic loads at batch row ${result}; supply finite wrenches and physical inertia.`,
        );
      this.batchCalls++;
    };
    run(kernel.loads_hold, 0, regular / LOADS_KERNEL_WORDS);
    const holdCoupled = mobility
      ? (input: number, count: number, output: number, capacity: number, gravity: number) =>
          kernel.loads_hold_coupled_mobility(input, count, output, capacity, gravity, mobility.byteOffset)
      : kernel.loads_hold_coupled;
    run(holdCoupled, coupled, (words.length - coupled) / LOADS_KERNEL_COUPLED_WORDS);
    this.rows.clear();
  }

  /** A member's Morison load at two Gauss points, with its wake oscillator. */
  private loadMember(
    m: LoadMember,
    index: number,
    bodies: Float32Array | undefined,
    t: number,
    dt: number,
    rho: number,
    wakes: Float64Array,
    wakeMotion: Float64Array | undefined,
  ): void {
    const coupled = m.vortexCoupling === 'body-acceleration';
    const motionAt = 4 * index;
    let from: Vec3 = [m.from[0], m.from[1], m.from[2]],
      to: Vec3 = [m.to[0], m.to[1], m.to[2]],
      v: Vec3 = [0, 0, 0],
      w: Vec3 = [0, 0, 0],
      cm: Vec3 = [0, 0, 0],
      mass = 0,
      onBody = false;
    if (coupled) {
      // A circular member uses a canonical local direction for its wake and wet quadrature.
      const first = to.findIndex((coordinate, k) => coordinate !== from[k]);
      if (to[first]! < from[first]!) [from, to] = [to, from];
    }
    if (m.row !== undefined) {
      const at = m.row * BODY_WORDS;
      if (!bodies || at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) {
        if (coupled) {
          resetMemberWake(wakes, wakeMotion!, index);
          const report = this.memberLoads[index]!;
          report.force = [0, 0, 0];
          report.lift = 0;
        }
        return;
      }
      const q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
        origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!];
      from = add(origin, rotate(q, from));
      to = add(origin, rotate(q, to));
      v = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!];
      w = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!];
      cm = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!];
      mass = bodies[at + 16]! > 0 ? 1 / bodies[at + 16]! : 0;
      if (mass === 0) return;
      onBody = true;
    } else {
      const offset = this.offsetOf(this.cell);
      from = sub(from, offset);
      to = sub(to, offset);
    }
    const axis = sub(to, from),
      length = Math.sqrt(dot(axis, axis));
    if (!(length > 0)) return;
    const d0 = this.sea.elevation(from[0], from[2], t) - from[1];
    const d1 = this.sea.elevation(to[0], to[2], t) - to[1];
    if (!(Number.isFinite(d0) && Number.isFinite(d1)))
      throw invalidLoad('Non-finite member submergence; return a finite water elevation at both member ends.');
    const wetFrom = d0 < 0 && d1 > 0 ? -d0 / (d1 - d0) : 0;
    const wetTo = d1 < 0 && d0 > 0 ? d0 / (d0 - d1) : 1;
    const wet = d0 <= 0 && d1 <= 0 ? 0 : wetTo - wetFrom;
    const e = scale(axis, 1 / length),
      D = m.diameter,
      area = (Math.PI * D * D) / 4,
      roughness = (m.roughness ?? (m.coefficients === 'sarpkaya-1976' ? 0 : 5e-5)) / D,
      period = m.period ?? 8,
      total: Vec3 = [0, 0, 0],
      moment: Vec3 = [0, 0, 0],
      added = new Float64Array(9);
    const incident = coupled ? ([0, 0, 0] as Vec3) : undefined;
    let liftSum = 0,
      wetSpeed = 0,
      across: Vec3 = [0, 0, 0];
    // Clip the segment against its linear waterline before the two-point Gauss integration.
    for (const g of [0.5 - 0.5 / Math.sqrt(3), 0.5 + 0.5 / Math.sqrt(3)]) {
      if (!(wet > 0)) break;
      const p = add(from, scale(axis, wetFrom + g * wet));
      const u = this.water(p[0], p[1], p[2], t, [0, 0, 0]),
        a = this.acceleration(p[0], p[1], p[2], t, [0, 0, 0]),
        vp = onBody ? add(v, cross(w, sub(p, cm))) : ([0, 0, 0] as Vec3),
        vr = sub(u, vp),
        vrN = sub(vr, scale(e, dot(vr, e))),
        aN = sub(a, scale(e, dot(a, e))),
        speedN = Math.sqrt(dot(vrN, vrN)),
        speed = Math.sqrt(dot(vr, vr)),
        orbital = Number.isFinite(period)
          ? memberOrbit(
              u,
              this.water(p[0], p[1], p[2], t + period / 4, [0, 0, 0]),
              this.water(p[0], p[1], p[2], t + period / 2, [0, 0, 0]),
              vp,
              e,
            )
          : { peak: 0, mean: speedN },
        kc = Number.isFinite(period) ? (orbital.peak * period) / D : 0,
        re = ((orbital.peak + orbital.mean) * D) / this.nu,
        dnv = cylinderCoefficients(kc, roughness, orbital.mean, orbital.peak, re),
        { drag, addedMass } =
          m.coefficients === 'sarpkaya-1976' && orbital.peak > 0 && Number.isFinite(period)
            ? smoothOscillatoryCylinder(kc, (D * D) / (this.nu * period), orbital.mean / orbital.peak, dnv)
            : dnv,
        half = (length * wet) / 2,
        // Normal: rho A a + rho C_A A a, the water's acceleration, and the drag; the member's own acceleration's added mass
        // rho C_A A (I - e e^T) per length is held implicitly with its body.
        fN = add(scale(aN, rho * area * (1 + addedMass) * half), scale(vrN, 0.5 * rho * drag * D * speedN * half)),
        // Eames: the angle phi between the flow and the member, cos phi along it, sin phi across.
        cosPhi = speed > 0 ? Math.abs(dot(vr, e)) / speed : 0,
        sinPhi = speed > 0 ? speedN / speed : 0,
        tangent = 0.5 * rho * tangentialDrag(drag, sinPhi, cosPhi) * D * speed * speed * half * Math.sign(dot(vr, e)),
        f = add(fN, scale(e, tangent));
      if (onBody) {
        const ma = rho * addedMass * area * half;
        for (let r = 0; r < 3; r++)
          for (let c = 0; c < 3; c++) added[3 * r + c]! += ma * ((r === c ? 1 : 0) - e[r]! * e[c]!);
      }
      for (let k = 0; k < 3; k++) total[k]! += f[k]!;
      const arm = onBody ? cross(sub(p, cm), f) : ([0, 0, 0] as Vec3);
      for (let k = 0; k < 3; k++) moment[k]! += arm[k]!;
      if (incident) {
        const perpendicular = sub(u, scale(e, dot(u, e)));
        const stream = Math.sqrt(dot(perpendicular, perpendicular));
        if (!Number.isFinite(stream)) throw invalidLoad('Use a finite incident water speed for rigid vortex coupling.');
        if (stream > 0) {
          // The shedding frequency uses the incident streamwise speed in the cylinder's frame.
          // Body motion transverse to that direction drives q through acceleration.
          const inline = (stream - dot(vp, perpendicular) / stream) / (2 * stream);
          for (let k = 0; k < 3; k++) incident[k]! += inline * perpendicular[k]!;
        }
      } else {
        wetSpeed = Math.max(wetSpeed, speedN);
        if (speedN > 0) across = normalise(cross(e, vrN));
      }
      liftSum += half;
    }
    let liftCoefficient = 0;
    if (incident) {
      wetSpeed = Math.sqrt(dot(incident, incident));
      const motion = wakeMotion!;
      if (!Number.isFinite(wetSpeed)) throw invalidLoad('Use a finite incident water speed for rigid vortex coupling.');
      if (wetSpeed > 0 && wet > 0) {
        across = normalise(cross(e, incident));
        const midpoint = add(from, scale(axis, 0.5));
        const velocity = add(v, cross(w, sub(midpoint, cm)));
        const elapsed = t - motion[motionAt + 3]!;
        const previous: Vec3 = [motion[motionAt]!, motion[motionAt + 1]!, motion[motionAt + 2]!];
        const acceleration =
          motion[motionAt + 3]! > 0 && elapsed > 0 ? dot(sub(velocity, previous), across) / elapsed : 0;
        const omega = (2 * Math.PI * (m.vortex?.strouhal ?? 0.2) * wetSpeed) / D;
        // Facchinetti, de Langre and Biolley (2004), Eqs. 5, 9 and 14. Their A=12 uses the material
        // acceleration, in m/s², divided by diameter. Lift is coherent over the clipped wet interval.
        const drive = (12 * acceleration) / D;
        if (!Number.isFinite(drive))
          throw invalidLoad('Choose a physical member diameter and acceleration for the vortex oscillator.');
        if (!(omega > 0 && omega * dt < Math.PI))
          throw invalidLoad(
            'Resolve vortex shedding below the world step’s Nyquist frequency; raise the Loads and rigid rates or use a larger member diameter.',
          );
        const prior = wakes[2 * index]!;
        const priorDerivative = wakes[2 * index + 1]!;
        const q = wakeStep(wakes, index, omega, drive, dt);
        liftCoefficient = ((m.vortex?.lift ?? 0.3) * q) / 2;
        const lift = scale(across, 0.5 * rho * wetSpeed * wetSpeed * D * liftSum * liftCoefficient);
        const centreOfLift = add(from, scale(axis, (wetFrom + wetTo) / 2));
        const torque = cross(sub(centreOfLift, cm), lift);
        if (![q, wakes[2 * index + 1]!, ...lift, ...torque].every(Number.isFinite)) {
          wakes[2 * index] = prior;
          wakes[2 * index + 1] = priorDerivative;
          throw invalidLoad(
            'Use smaller vortex forcing or a finer fixed world step to keep the wake and wrench finite.',
          );
        }
        motion.set(velocity, motionAt);
        motion[motionAt + 3] = t;
        for (let k = 0; k < 3; k++) {
          total[k]! += lift[k]!;
          moment[k]! += torque[k]!;
        }
      } else resetMemberWake(wakes, motion, index);
    } else if (m.vortex && wetSpeed > 0) {
      const st = m.vortex.strouhal ?? 0.2,
        cl0 = m.vortex.lift ?? 0.3,
        wf = (2 * Math.PI * st * wetSpeed) / D,
        q = wakeStep(wakes, index, wf, 0, dt),
        lift = 0.25 * rho * wetSpeed * wetSpeed * D * cl0 * q;
      for (let k = 0; k < 3; k++) total[k]! += lift * liftSum * across[k]!;
      liftCoefficient = lift / (0.5 * rho * wetSpeed * wetSpeed * D);
    }
    const report = this.memberLoads[index]!;
    report.force = [total[0], total[1], total[2]];
    report.lift = liftCoefficient;
    if (onBody) {
      const acc = this.rowOf(m.row!, mass);
      for (let k = 0; k < 3; k++) {
        acc.force[k]! += total[k]!;
        acc.torque[k]! += moment[k]!;
      }
      for (let k = 0; k < 9; k++) acc.added[k]! += added[k]!;
    }
  }

  /** Member `index`'s load from the last step (a fixed pile's is what it holds the water with). */
  /**
   * What the water did to compact body `index` (its place in `bodies`) at the last step: displaced volume, centre of
   * buoyancy, buoyancy and the other loads. A mesh's centre of buoyancy is integrated when asked.
   * @throws MargoError `unsupported` (errors#hydrodynamic-loads) for an index that names no body.
   */
  bodyLoad(index: number): BodyLoad {
    const b = this.bodies[index];
    if (!b) throw invalidLoad(`There is no body ${index}; pass 0 to ${this.bodies.length - 1}.`);
    const l = b.last,
      offset: Vec3 =
        l.submerged > 0
          ? b.mesh
            ? meshBuoyancyCentre(b.mesh, l.rotation, l.depth, [0, 0, 0])
            : [l.offset[0], l.offset[1], l.offset[2]]
          : [0, 0, 0];
    return {
      active: l.active,
      submerged: l.submerged,
      wet: l.submerged / b.volume,
      centre: [l.centre[0], l.centre[1], l.centre[2]],
      centreOfBuoyancy: add(l.centre, offset),
      depth: l.depth,
      buoyancy: [l.buoyancy[0], l.buoyancy[1], l.buoyancy[2]],
      force: [l.force[0], l.force[1], l.force[2]],
    };
  }

  /**
   * The debug view of the compact bodies at the last step, for `PhysicsDebugView.add(loads)`
   * (`@margoengine/physics/debug-view`): each body's edges below the water (blue), its waterline on the water drawn now
   * (white), its centre of buoyancy (magenta cross), its buoyancy (cyan) and the water's other loads (orange). In the
   * solver's origin cell.
   * @throws MargoError `unsupported` (errors#hydrodynamic-loads) for a `forceScale` that is not positive and finite.
   */
  debugRender(options: LoadDebugOptions = {}): LoadLines {
    const { submerged = true, waterline = true, centreOfBuoyancy = true, forces = true, forceScale } = options;
    if (forceScale !== undefined && !(forceScale > 0 && Number.isFinite(forceScale)))
      throw invalidLoad('Invalid debug force scale; pass metres per newton above 0, or leave it out.');
    const out = new LineSink();
    this.bodies.forEach((b, index) => {
      const l = b.last;
      if (!l.active) return;
      if (submerged || waterline) {
        b.outline ??= b.mesh ?? analyticOutline(b.axes, b.frame, b.capsule);
        drawWetted(
          out,
          b.outline,
          l.centre,
          l.rotation,
          (x, z) => this.sea.elevation(x, z, l.time),
          submerged,
          waterline,
        );
      }
      if (!(l.submerged > 0)) return;
      const load = this.bodyLoad(index),
        size = 2 * pow(b.volume, 1 / 3),
        perNewton = forceScale ?? size / (this.sea.density * this.g * b.volume);
      if (centreOfBuoyancy) out.cross(load.centreOfBuoyancy, 0.08 * size, BUOYANCY_CENTRE);
      if (forces) {
        out.arrow(load.centreOfBuoyancy, scale(load.buoyancy, perNewton), BUOYANCY);
        out.arrow(load.centre, scale(load.force, perNewton), LOAD);
      }
    });
    return out.lines();
  }

  memberLoad(index: number): MemberLoad {
    const load = this.memberLoads[index];
    if (!load) throw invalidLoad(`There is no member ${index}; pass 0 to ${this.memberLoads.length - 1}.`);
    return load;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    const regions = [this.wakes];
    if (this.history) regions.push(this.history);
    if (this.wakeMotion) regions.push(this.wakeMotion);
    return regions;
  }

  extraState(): readonly Region[] {
    return [this.forces];
  }
}

function resetMemberWake(wakes: Float64Array, motion: Float64Array, index: number): void {
  wakes[2 * index] = 2;
  wakes[2 * index + 1] = 0;
  motion.fill(0, 4 * index, 4 * (index + 1));
}

function addInertiaAxis(matrix: Float64Array, direction: Vec3, coefficient: number): void {
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++)
      matrix[row * 3 + column]! += coefficient * direction[row]! * direction[column]!;
}

function addRadiationWrench(loads: BodyLoads, direction: Vec3, angular: boolean, load: number, inertia: number): void {
  const wrench = angular ? loads.torque : loads.force;
  for (let axis = 0; axis < 3; axis++) wrench[axis]! += load * direction[axis]!;
  if (inertia > 0)
    addInertiaAxis(angular ? (loads.rotational ??= new Float64Array(9)) : loads.added, direction, inertia);
}

function freeTranslation(mobility: Float32Array | undefined, row: number): Vec3 {
  if (!mobility) return [1, 1, 1];
  const at = row * BODY_MOBILITY_WORDS;
  const x = mobility[at]!,
    y = mobility[at + 1]!,
    z = mobility[at + 2]!;
  if (![x, y, z].every((value) => Number.isFinite(value) && value >= 0))
    throw invalidLoad('Publish finite nonnegative linear inverse masses in the matching rigid mobility port.');
  return [Number(x > 0), Number(y > 0), Number(z > 0)];
}

function projectTranslation(added: Float64Array, free: Vec3): number[] {
  // Scale columns of A by the dry mobility. A locked row can still carry the hydrodynamic reaction.
  const [x, y, z] = free;
  return [
    added[0]! * x,
    added[1]! * y,
    added[2]! * z,
    added[3]! * x,
    added[4]! * y,
    added[5]! * z,
    added[6]! * x,
    added[7]! * y,
    added[8]! * z,
  ];
}

function holdTorque(torque: Vec3, added: Float64Array, bodies: Float32Array, at: number): Vec3 {
  // Solve (identity + A * dry mobility) * held = torque.
  const xx = bodies[at]!;
  const xy = bodies[at + 1]!;
  const xz = bodies[at + 2]!;
  const yy = bodies[at + 3]!;
  const yz = bodies[at + 4]!;
  const zz = bodies[at + 5]!;
  const mobility = [xx, xy, xz, xy, yy, yz, xz, yz, zz];
  const system = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++)
      for (let k = 0; k < 3; k++) system[row * 3 + column]! += added[row * 3 + k]! * mobility[k * 3 + column]!;
  const inverse = invert3(system);
  const held: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++)
    held[i] = inverse[i * 3]! * torque[0] + inverse[i * 3 + 1]! * torque[1] + inverse[i * 3 + 2]! * torque[2];
  if (!held.every(Number.isFinite))
    throw invalidLoad('Rotational water inertia exceeds numeric range; supply physical SI inertia and torque.');
  return held;
}

/** The rotation `q` turned by the angular velocity `w` (world axes) for `h` seconds: q + (h / 2) [w, 0] q, made a unit. */
function turnBy(
  q: readonly [number, number, number, number],
  w: readonly number[],
  h: number,
): [number, number, number, number] {
  const [x, y, z, s] = q,
    a = (w[0]! * h) / 2,
    b = (w[1]! * h) / 2,
    c = (w[2]! * h) / 2,
    nx = x + (s * a + b * z - c * y),
    ny = y + (s * b + c * x - a * z),
    nz = z + (s * c + a * y - b * x),
    ns = s - (a * x + b * y + c * z),
    length = Math.sqrt(nx * nx + ny * ny + nz * nz + ns * ns);
  return [nx / length, ny / length, nz / length, ns / length];
}

function rotate(q: readonly [number, number, number, number], v: readonly number[]): Vec3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}
function add(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}
function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function scale(a: readonly number[], k: number): Vec3 {
  return [a[0]! * k, a[1]! * k, a[2]! * k];
}
function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
function normalise(a: Vec3): Vec3 {
  const l = Math.sqrt(dot(a, a));
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
}

/** The inverse of a 3 by 3 matrix, row-major. */
function invert3(m: readonly number[]): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number],
    A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g,
    det = a * A + b * B + c * C,
    out = new Float64Array(9);
  out[0] = A / det;
  out[1] = -(b * i - c * h) / det;
  out[2] = (b * f - c * e) / det;
  out[3] = B / det;
  out[4] = (a * i - c * g) / det;
  out[5] = -(a * f - c * d) / det;
  out[6] = C / det;
  out[7] = -(a * h - b * g) / det;
  out[8] = (a * e - b * d) / det;
  return out;
}
