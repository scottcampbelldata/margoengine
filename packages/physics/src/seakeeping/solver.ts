// The water's load on rigid hulls as a solver of the physics framework (docs/physics-framework.md, sections 4 and 5; SEA-08):
// each step it reads where each hull's body is from the rigid solver's `bodies` port, integrates the water's pressure over the
// hull's wetted surface at the middle of the step (wetted.ts), and holds the body with that force and its moment about the
// centre of mass over the rigid solver's next step through `bodyForces`. A world couples it before the rigid solver:
// `world.couple(['hull', 'rigid'], 'staggered')`.
//
// Added mass. A hull moves water with it: the hull's added mass A (strips.ts, from its sections under the waterline it floats
// at this step) makes its equations (M + A) a = F + W, F the water's load and W its weight. The rigid kernel moves the body
// by M a = F_held + W, so the solver holds F_held = M (M + A)^-1 (F + W) - W, a six-by-six solve in world axes: exact for a
// free hull (the research summary for SEA-08 in docs/clean-room.md; given explicitly instead, -A a goes unstable once A is
// about M, a light hull's case). Forces the solver does not see (contacts, joints, a tow) act on M alone.
//
// Radiation: the waves a moving hull makes damp it, with memory (memory.ts, Cummins 1962): the hull's heave velocity and pitch
// rate over the last seconds, convolved with its kernels, add to the load before the added-mass solve.
//
// State: the hulls' motion histories (the radiation's memory). Each step's load and added mass otherwise come from where
// the bodies are and the sea at that time.
import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, SeaSurface, SeaSurfaceSample, SeaWater } from '@margoengine/math/fields';
import { cos, exp, hypot, sin } from '@margoengine/math/pinned';
import {
  type CrushInertiaChannel,
  WET_IMPULSE_WORDS,
  WET_INERTIA_LAYOUT,
  WET_INERTIA_WORDS,
  wetInertiaWords,
} from '../crush/contact-inertia.js';
import {
  CRUSH_DAMAGE_QUANTITY,
  CRUSH_LAYOUT,
  CRUSH_SEAL_LOSS_WORD,
  CRUSH_WORDS,
  GIRDER_SEAM_BROKEN_WORD,
  GIRDER_SEAM_LAYOUT,
  GIRDER_SEAM_QUANTITY,
  GIRDER_SEAM_WORDS,
} from '../crush/port.js';
import { entryCavityRows, ENTRY_CAVITY_WORDS, isEntryCavityField } from '../entry/cavity-port.js';
import { WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS } from '../sea/wake.js';
import {
  SUBMERGED_WAKE_LAYOUT,
  SUBMERGED_WAKE_MAX_ROWS,
  SUBMERGED_WAKE_QUANTITY,
  SUBMERGED_WAKE_WORDS,
  type SubmergedWakeSource,
  wakeDepths,
} from '../sea/submerged-wake.js';
import { atan2 } from '../ship/propeller.js';
import { regionWords } from '../world/memory.js';
import {
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
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { DECK_CLAIMS_FIELD, DECK_INFLOW_FIELD, DECK_INFLOW_WORDS } from '../world/deck.js';
import {
  addBilgeKeelInertia,
  type HullBilgeKeel,
  bilgeKeelDamping,
  type RollKeel,
  rollKeelsOf,
  validateBilgeKeels,
} from './bilge-keel.js';
import { courseLoad, courseSpeedLimit, courseWords, lateralCourseLoad, type HullCourse } from './course.js';
import { CLAIM_ADDED_MASS, CLAIM_DAMPING, MANOEUVRING_CLAIMS_FIELD } from '../world/manoeuvring.js';
import { type Deck, deckOf, stepDeck } from './deck.js';
import { courseWaveCorrection } from './excitation.js';
import { type SlamStation, slamSlope, slamStations } from './slamming.js';
import {
  AIR_DENSITY,
  ATMOSPHERE,
  type Compartment,
  FLOOD_OPENING_GRID,
  Flooding,
  type Opening,
  volumeBelow,
} from './flooding.js';
import { BREACH_CARGO, HULL_BREACH_WORDS, HULL_BREACHES_FIELD } from '../world/flooding.js';
import { buildHullMemory, type HullMemory, type HullWaveMemory, type RadiationPair, stillWaterline } from './memory.js';
import { panelDampingKernels, panelDiffraction } from './panel-runtime.js';
import { surgePanelMass } from './panel-surge.js';
import type { HullPanelResponse } from './panels.js';
import { heaveSection, lateralSection, scatterSection } from './radiation.js';
import { isShellApertureField, panelAperture, type ShellAperture, shellApertureRows } from './shell-opening.js';
import { SHELL_PRESSURE_LAYOUT, SHELL_PRESSURE_WORDS, shellPressureField } from '../crush/shell-aperture.js';
import { addedMassInfinite, hullSections, type Section } from './strips.js';
import { submergedWakeNodes, type SubmergedWakeNode } from './submerged-wake.js';
import { type ForwardRoll, forwardRollOf } from './viscous.js';
import type { WakeAdvancePoints } from './wake-advance-points.js';
import type { WakeWaterplane } from './wake-waterplane.js';
import {
  interceptedBreadth,
  type ReflectingWaterline,
  reflectingWaterline,
  wallReflectance,
} from './wave-reflection.js';
import {
  GRAVITY,
  type HullMesh,
  SEA_WATER,
  type SeaQuery,
  type Vec3,
  FORM_DRAG,
  type WettedDrag,
  type WettedLoads,
  wettedLoads,
} from './wetted.js';

/** A hull: the kernel body row it is the hull of, and its surface in the body's frame. */
export interface Hull {
  readonly row: number;
  readonly mesh: HullMesh;
  /** Enable forward-speed strip loads in heave and pitch and the bare-hull roll corrections. */
  readonly course?: HullCourse;
  /** Thin bilateral or single-side plates that add normal viscous roll damping when wet. */
  readonly bilgeKeels?: readonly HullBilgeKeel[];
  /** Carry the 3D high-frequency water inertia along the hull's x axis. Default false. */
  readonly surgeAddedMass?: boolean;
  /** Optional three-dimensional radiation, infinite inertia and directional diffraction at the reference draft. */
  readonly panels?: HullPanelResponse;
  /** Add mean axial wave-reflection loads on the hull's waterline. Default false. */
  readonly shortWaveResistance?: boolean;
  /** Baked reference waterplane for heave, roll and pitch sources. A wake-enabled HullSolver copies its nodes. */
  readonly wakeWaterplane?: {
    /** Bake the hull mesh at its equilibrium waterline for the configured mass and density. */
    readonly plane: WakeWaterplane;
    /** Positive projection radius in metres, independent of the panel spacing. */
    readonly radius: number;
  };
  /** Reference advancing panel points for a finite point-depth wake. */
  readonly wakeAdvancePoints?: {
    readonly geometry: WakeAdvancePoints;
    /** Positive receiver projection radius in metres, separate from the bake bins. */
    readonly radius: number;
  };
  /**
   * Its spaces that can flood (flooding.ts): closed meshes in the body's frame inside the hull, each with its permeability,
   * its water at the start and its cargo. The body's mass includes the cargo, not the floodwater.
   */
  readonly compartments?: readonly Compartment[];
  /** Its openings between the compartments and to the outside: breaches, doors, hatches, vents. */
  readonly openings?: readonly Opening[];
}

/** Publish the hull's linearized waterplane displacement for a WakeSolver. */
export interface HullWake {
  /** Minimum radius of the surface patches in metres. Default 0, using their geometric size. */
  readonly minimumRadius?: number;
  /** Displace water at the advancing end and draw it in behind the hull. Default false. */
  readonly advance?: boolean;
  /** Project advancing flux from its actual depth and breadth. Pass one to eight bands covering every reference draft. */
  readonly submergedAdvance?: readonly number[];
  /** Publish the baked advancing points to a finiteQuayPointSource descriptor. Use one advancing source mode. */
  readonly pointAdvance?: FieldDescriptor;
}

/** What a {@link HullSolver} is made from. */
export interface HullParams {
  /** The hulls, each on its own body row. */
  readonly hulls: readonly Hull[];
  /** The sea they float on. */
  /**
   * The sea they float on: a `SeaSurface` (the framework's, such as `SpectralSea` from `@margoengine/physics/sea`) in the
   * solver's own origin cell, or anything with `elevation` (and `pressure`, `density`).
   */
  readonly sea: SeaSurface | SeaQuery;
  /** The solver's rate level, 60 * 2^level steps a second (default 0); step with the rigid solver. */
  readonly level?: RateLevel;
  /**
   * Body rows its `bodyForces` port covers: the world's (`PhysicsWorld.bodyRows`, the rigid world's capacity), which it reads;
   * given, it must be the same.
   */
  readonly capacity?: number;
  /** The rigid world's gravity, m/s^2 (default [0, -9.81, 0]): the weight the added-mass solve takes with the load. */
  readonly gravity?: Vec3;
  /** Carry the water the hull and any wet bilge keel plates move (default true). */
  readonly addedMass?: boolean;
  /** Stations along the hull for its sections (default 24). */
  readonly stations?: number;
  /**
   * Take the waves a hull makes as it moves (default true): its heave and pitch damping with memory, Cummins' convolution of
   * its strip-theory damping over the last `memory` seconds of its motion (memory.ts).
   */
  readonly radiation?: boolean;
  /** Seconds of a hull's motion its radiation remembers (default 20). */
  readonly memory?: number;
  /**
   * Take the waves' diffraction (default true, when the sea gives the water's motion, as a `SeaSurface`'s `water` does): the
   * relative motion principle of strip theory (Journee and Massie eqs. 8.19 and 8.45-8.47), each section loaded by its added
   * mass times the water's acceleration and its radiation memory convolved with the water's velocity, at the depths that
   * stand for the section's motion. The Froude-Krylov part comes from the pressure over the wetted surface.
   */
  readonly diffraction?: boolean;
  /**
   * Take the waves' mean and slow drift (default true, when the sea gives its waves, as `SpectralSea`'s `waveComponents`
   * do): each section's far-field drift in beam waves, 1/2 rho g R^2 per metre and square metre of wave amplitude, R the
   * wave it sends back held by the hull's motions (Maruo; the momentum the waves carry), less the part the Froude-Krylov
   * pressure over the moving wetted surface already gives, over the waves by Newman's approximation.
   */
  readonly drift?: boolean;
  /**
   * Take the sea coming over the deck (default true): shallow water on each hull's deck in its moving frame, coming in where
   * the sea stands above a deck edge and running off where it does not, its weight (rho G h) on the deck (deck.ts). The
   * deck's own faces then take no Froude-Krylov pressure, so the water over them is counted once. Where a liquid solver
   * owns a hull's on-deck load (`deckClaims`), the hull solver leaves its own out.
   */
  readonly greenWater?: boolean;
  /**
   * Take the hull's slamming (default true): each section that comes down into the water takes the momentum of the water
   * it sets moving, (dm/dh) V^2 a metre, m its added mass at its depth of entry with Wagner's wetted width and V its speed
   * into the water (slamming.ts).
   */
  readonly slamming?: boolean;
  /**
   * Take the form drag of the hull moving through the water (default true): on each wet piece facing the way it moves,
   * the stagnation pressure 1/2 rho C (v . n)^2, v its velocity relative to the water at the centre of mass (the sea's
   * `water` there, when it gives it), the roll's part left to the roll damping where that is on. It sets the speed a
   * hull that has lost its buoyancy sinks at, and how it turns as it goes down.
   */
  readonly drag?: boolean;
  /** The drag coefficient C (default 1.05, Hoerner's cube face-on; a flat disk is 1.17). */
  readonly dragCoefficient?: number;
  /** The deck's grid, cells along the hull and across it (default [32, 12]). */
  readonly deckCells?: readonly [number, number];
  /**
   * Damp a hull's roll by its bilge eddies and its skin friction (default true): Ikeda's component method (viscous.ts), the
   * viscous part of roll damping that potential flow leaves out and that damps a real hull's roll most near its resonance.
   */
  readonly rollDamping?: boolean;
  /** The water's kinematic viscosity, m^2/s (default 1.19e-6, sea water at 15 degrees C; fresh water 1.14e-6). */
  readonly viscosity?: number;
}

/** Sea water's kinematic viscosity at 15 degrees C, m^2/s (ITTC 7.5-02-01-03, 2011). */
export const SEA_VISCOSITY = 1.19e-6;

/** A hull's roll: its eddy coefficient, its linear damping, its inertia with and without its added inertia, its stiffness. */
interface Roll {
  readonly eddy: number;
  readonly linear: number;
  readonly forward?: ForwardRoll;
  readonly natural: number;
  readonly keels?: readonly RollKeel[];
  readonly inertia: number;
  readonly own: number;
  readonly stiffness: number;
}

/** A sea that gives its waves one by one (`SpectralSea`). */
interface SeaWaves {
  readonly waveCount: number;
  readonly stillDepth?: number;
  waveComponents(t: number, out: Float32Array): number;
}

/** The layout version of the `forces` port region and the state regions. */
const HULL_LAYOUT = 3;
/** f64 words a hull keeps of its last step: a flag, the body's velocity (six) and the load held (six). */
const CARRY_WORDS = 20;

/** The water's load on rigid hulls, for the rigid solver through `bodyForces`. `id` is `'hull'` unless a world holds more. */
export class HullSolver implements Solver<HullParams> {
  private host: SolverHost | null = null;
  private hulls: readonly Hull[] = [];
  private sea: SeaQuery | null = null;
  private level: RateLevel = 0;
  private forces: Region | null = null;
  private capacity = 0;
  private readonly loads: WettedLoads & { surfacePiercing?: boolean } = {
    force: [0, 0, 0],
    torque: [0, 0, 0],
    area: 0,
  };
  private gravity: Vec3 = [0, -GRAVITY, 0];
  private addedMass = true;
  private stations = 24;
  private radiation = true;
  private lags = 0;
  private history: Region | null = null;
  private courseHistory: Region | null = null;
  private course: readonly ({
    speed?: number;
    trimSine: number;
    heading?: readonly [number, number];
    historyIndex: number;
  } | null)[] = [];
  private readonly courseLimits = new Map<Hull, number>();
  /** Per hull: 1 once it has radiated, then the radiation force of its last step (body frame, force then moment). */
  private radiated: Region | null = null;
  /** What a manoeuvring model owns of the hull being stepped (`manoeuvringClaims` flags; 0 when none). */
  private claim = 0;
  /** Per hull and station: the water's heave and sway velocity at the section, in the body's frame, each of the last `lags` steps. */
  private waves: Region | null = null;
  private diffraction = true;
  private panelScatter = true;
  private readonly panelForce = new Float64Array(6);
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly surfaceSample: SeaSurfaceSample = {
    height: 0,
    normal: [0, 1, 0],
    velocity: [0, 0, 0],
    current: [0, 0, 0],
    depth: 0,
    density: 0,
  };
  /** Per hull: 1 once it has a last step, the body's velocity (linear, angular) then and the load the solver held over it. */
  private carry: Region | null = null;
  private readonly memories = new Map<Hull, HullWaveMemory>();
  private readonly panelMemories = new Map<Hull, readonly RadiationPair[]>();
  private readonly surgeMasses = new Map<Hull, number>();
  private rollDamping = true;
  private viscosity = SEA_VISCOSITY;
  /** Per hull: its eddy coefficient, its linear (friction) roll damping and its roll inertia with the water it carries. */
  private readonly rolls = new Map<Hull, Roll>();
  private drift = true;
  /** Per hull: its drift coefficient (N per m of hull and square metre of wave amplitude, summed along it) by frequency. */
  private readonly drifts = new Map<Hull, { frequencies: Float64Array; coefficient: Float64Array }>();
  private readonly reflectingWaterlines = new Map<Hull, ReflectingWaterline>();
  private waves32 = new Float32Array(0);
  private courseWaveScratch = new Float64Array(0);
  private greenWater = true;
  private slamming = true;
  private drag = true;
  private dragCoefficient = FORM_DRAG;
  /** Per hull: its mesh's whole volume. */
  private readonly volumes = new Map<Hull, number>();
  /** Per hull: a flag, then each station's depth of entry a step ago. */
  private slam: Region | null = null;
  private readonly slams = new Map<Hull, SlamStation[]>();
  private deckCells: readonly [number, number] = [32, 12];
  /** Per hull: the water on its deck (h, h u, h w a cell, body frame), then its velocity a step ago (flag, linear). */
  private deckWater: Region | null = null;
  /** The `deckInflow` port: a count word, then `DECK_INFLOW_WORDS` f64 a record, room for `inflowRecords` a hull. */
  private inflow: Region | null = null;
  private inflowRecords = 0;
  /** Per hull: its deck, and its mesh without the deck's faces (for the Froude-Krylov load). */
  private readonly decks = new Map<Hull, { deck: Deck; wet: HullMesh }>();
  /** Per hull with compartments: its flooding, and where its state starts in the `flood` region. */
  private readonly floods = new Map<Hull, { flooding: Flooding; at: number; record: number }>();
  private flood: Region | null = null;
  private breaches: Region | null = null;
  private lastCrushPatch = -1;
  private lastGirderJoint = -1;
  private lastShellSeam = -1;
  private shellApertures?: { readonly field: FieldDescriptor; readonly cellSize?: number };
  private shellPressureField?: FieldDescriptor;
  private shellPressure: Region | null = null;
  private entryCavity?: FieldDescriptor;
  private wetChannel?: CrushInertiaChannel;
  private wetMobility: Region | null = null;

  /** The hull's signed volume source rows, named from the solver's id. Enabled with the wake option. */
  readonly wakeSourceField: FieldDescriptor;
  /** Optional advancing flux from depth bands, connected as WakeSolver's third argument. */
  readonly submergedWakeSource?: SubmergedWakeSource;
  /** Optional layout-1 point-depth port read by FiniteQuayWake. */
  readonly pointWakeSource?: FieldDescriptor;

  private wakeSources: Region | null = null;
  private submergedWakeSources: Region | null = null;
  private submergedWakeRowsPerHull = 0;
  private wakePointGeometry: ({ geometry: WakeAdvancePoints; radius: number; row: number } | undefined)[] = [];
  private readonly wakePlanes = new Map<
    Hull,
    {
      waterline: number;
      mass: number;
      density: number;
      sections: readonly Section[];
      submerged?: readonly SubmergedWakeNode[];
    }
  >();
  private readonly wakeRadius: number | null;
  private readonly wakeAdvance: boolean;
  private wakeOffsets: number[] = [];
  private wakeWaterplanes: Hull['wakeWaterplane'][] = [];

  /** Pass the crush damage or girder seam field to enable structural compartment openings. */
  constructor(
    readonly id = 'hull',
    wake?: HullWake,
    private readonly crushDamage?: FieldDescriptor,
    private readonly girderSeams?: FieldDescriptor,
  ) {
    const radius = wake?.minimumRadius ?? 0;
    if (!(Number.isFinite(radius) && radius >= 0))
      throw new MargoError('state', 'Invalid hull wake patch radius. Use a finite nonnegative radius in metres.');
    this.wakeRadius = wake ? radius : null;
    this.wakeAdvance = wake?.advance ?? false;
    if (wake?.pointAdvance !== undefined) {
      const points = wake.pointAdvance;
      if (this.wakeAdvance || wake.submergedAdvance !== undefined)
        throw new MargoError('state', 'Choose one advancing wake mode: pointAdvance, submergedAdvance or advance.');
      if (
        points?.kind !== 'surfaceSampleSet' ||
        points.quantity !== 'submergedPointSeaSource' ||
        points.unit !== 'SI' ||
        points.centring !== 'particle' ||
        typeof points.name !== 'string' ||
        !points.name.trim()
      )
        throw new MargoError('state', 'Pass finiteQuayPointSource as the HullSolver pointAdvance descriptor.');
      this.pointWakeSource = points;
    }
    if (wake?.submergedAdvance !== undefined) {
      if (this.wakeAdvance)
        throw new MargoError(
          'state',
          'A hull needs one advancing wake source; set submergedAdvance or advance, not both.',
        );
      this.submergedWakeSource = Object.freeze({
        field: Object.freeze({
          name: id + '.submergedWakeSources',
          kind: 'surfaceSampleSet',
          quantity: SUBMERGED_WAKE_QUANTITY,
          unit: 'SI',
          centring: 'particle',
        }),
        depths: wakeDepths(wake.submergedAdvance),
      });
    }
    if (crushDamage && (crushDamage.kind !== 'surfaceSampleSet' || crushDamage.quantity !== CRUSH_DAMAGE_QUANTITY))
      throw new MargoError('state', 'Pass CrushSolver.damageField to link structural seal damage to a hull.');
    if (girderSeams && (girderSeams.kind !== 'surfaceSampleSet' || girderSeams.quantity !== GIRDER_SEAM_QUANTITY))
      throw new MargoError('state', 'Pass GirderJointSolver.seamField to link a failed girder to a hull opening.');
    this.wakeSourceField = Object.freeze({
      name: id + '.wakeSources',
      kind: 'surfaceSampleSet',
      quantity: 'seaSource',
      unit: 'SI',
      centring: 'particle',
    });
  }

  /** Connects released shell polygons to the hull's `shellSeam` openings. */
  static withShellApertures(
    field: FieldDescriptor,
    options: {
      readonly id?: string;
      readonly cellSize?: number;
      readonly wake?: HullWake;
      readonly crushDamage?: FieldDescriptor;
      readonly girderSeams?: FieldDescriptor;
    } = {},
  ): HullSolver {
    if (!isShellApertureField(field))
      throw new MargoError('state', 'Pass CrushShellSolver.apertureField to link live shell seams.');
    const { id, wake, crushDamage, girderSeams, cellSize } = options;
    if (cellSize !== undefined && !(cellSize > 0 && Number.isFinite(cellSize)))
      throw new MargoError('state', 'Use a positive finite world cell size when connecting shell apertures.');
    const hull = new HullSolver(id, wake, crushDamage, girderSeams);
    hull.shellApertures = { field, cellSize };
    return hull;
  }

  /** Couples a stationary fixed hull's live shell opening and hydrostatic return pressure. */
  static withShellPressure(
    field: FieldDescriptor,
    pressure: FieldDescriptor,
    options: Parameters<typeof HullSolver.withShellApertures>[1] = {},
  ): HullSolver {
    const hull = HullSolver.withShellApertures(field, options);
    const expected = shellPressureField(field.name.slice(0, -':shellApertures'.length));
    if (
      pressure.name !== expected.name ||
      pressure.kind !== expected.kind ||
      pressure.quantity !== expected.quantity ||
      pressure.unit !== expected.unit ||
      pressure.centring !== expected.centring
    )
      throw new MargoError('state', 'Pass the matching CrushShellSolver.aperturePressureField.');
    hull.shellPressureField = pressure;
    return hull;
  }

  /** Supplies instantaneous added and carried-water inertia to the paired crush solver. */
  static withContactInertia(
    channel: CrushInertiaChannel,
    options: {
      readonly id?: string;
      readonly wake?: HullWake;
      readonly crushDamage?: FieldDescriptor;
      readonly girderSeams?: FieldDescriptor;
      readonly shell?: { readonly field: FieldDescriptor; readonly cellSize?: number };
    } = {},
  ): HullSolver {
    const { id, wake, crushDamage, girderSeams, shell } = options;
    const hull = shell
      ? HullSolver.withShellApertures(shell.field, { id, wake, crushDamage, girderSeams, cellSize: shell.cellSize })
      : new HullSolver(id, wake, crushDamage, girderSeams);
    hull.wetChannel = channel;
    return hull;
  }

  /** Uses the wet side of each open entry cavity for this hull's pressure and form drag. */
  connectEntryCavity(field: FieldDescriptor): this {
    if (this.host) throw new MargoError('state', 'Connect an entry cavity before adding the hull to the world.');
    if (!isEntryCavityField(field))
      throw new MargoError('state', 'Pass EntrySolver.cavityPressureField to connect open entry cavities.');
    this.entryCavity = field;
    return this;
  }

  describe(): SolverDescription {
    const level = this.level;
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
        { field: DECK_INFLOW_FIELD, access: 'write' },
        { field: DECK_CLAIMS_FIELD, access: 'read', optional: true },
        { field: MANOEUVRING_CLAIMS_FIELD, access: 'read', optional: true },
        { field: HULL_BREACHES_FIELD, access: 'write' },
        ...(this.wakeRadius !== null ? [{ field: this.wakeSourceField, access: 'write' as const }] : []),
        ...(this.submergedWakeSource ? [{ field: this.submergedWakeSource.field, access: 'write' as const }] : []),
        ...(this.pointWakeSource ? [{ field: this.pointWakeSource, access: 'write' as const }] : []),
        ...(this.crushDamage ? [{ field: this.crushDamage, access: 'read' as const }] : []),
        ...(this.girderSeams ? [{ field: this.girderSeams, access: 'read' as const }] : []),
        ...(this.shellApertures ? [{ field: this.shellApertures.field, access: 'read' as const }] : []),
        ...(this.shellPressureField ? [{ field: this.shellPressureField, access: 'write' as const }] : []),
        ...(this.entryCavity ? [{ field: this.entryCavity, access: 'read' as const }] : []),
        ...(this.wetChannel
          ? ([
              { field: this.wetChannel.mobility, access: 'write' },
              { field: this.wetChannel.receipt, access: 'read' },
            ] as const)
          : []),
      ],
      rate: level,
      // Asked after init, which sets the level (describe comes first, before the Physics is known).
      stableRate: () => (this.host ? this.level : 0),
    };
  }

  init(host: SolverHost, params: HullParams): void {
    const { hulls, sea, level = 0 } = params ?? ({} as HullParams);
    if (!Array.isArray(hulls) || hulls.length === 0)
      throw new TypeError(
        'A HullSolver floats one or more hulls; pass them: world.add(new HullSolver(), {hulls: [{row, mesh}], sea}).',
      );
    if (!sea || typeof sea.elevation !== 'function')
      throw new TypeError('A HullSolver needs a sea with elevation(x, z, t): pass {sea}.');
    let lastCrushPatch = -1;
    let lastGirderJoint = -1;
    let lastShellSeam = -1;
    const pressureSeams = new Set<number>();
    for (const hull of hulls) {
      if (hull.bilgeKeels !== undefined) validateBilgeKeels(hull.bilgeKeels);
      for (const { crushPatch, girderJoint, shellSeam, to } of hull.openings ?? []) {
        if (crushPatch !== undefined) {
          if (!this.crushDamage || !Number.isSafeInteger(crushPatch) || crushPatch < 0)
            throw new MargoError(
              'state',
              'Pass CrushSolver.damageField and a nonnegative crushPatch index for the hull opening.',
            );
          lastCrushPatch = Math.max(lastCrushPatch, crushPatch);
        }
        if (girderJoint !== undefined) {
          if (!this.girderSeams || !Number.isSafeInteger(girderJoint) || girderJoint < 0)
            throw new MargoError(
              'state',
              'Pass GirderJointSolver.seamField and a nonnegative girderJoint index for the hull opening.',
            );
          lastGirderJoint = Math.max(lastGirderJoint, girderJoint);
        }
        if (shellSeam !== undefined) {
          if (!this.shellApertures || !Number.isSafeInteger(shellSeam) || shellSeam < 0)
            throw new MargoError('state', 'Use HullSolver.withShellApertures and a nonnegative shellSeam index.');
          if (this.shellPressureField) {
            if (to !== 'outside' || pressureSeams.has(shellSeam))
              throw new MargoError('state', 'Use one opening to the outside per pressure seam.');
            pressureSeams.add(shellSeam);
          }
          lastShellSeam = Math.max(lastShellSeam, shellSeam);
        }
      }
      if (!(Number.isInteger(hull.row) && hull.row >= 0))
        throw new RangeError(
          `A hull's row is a kernel body row (got ${hull.row}); pass the body's row, a whole number of 0 or more.`,
        );
      const { vertices, indices } = hull.mesh ?? {};
      if (!vertices || !indices || vertices.length % 3 !== 0 || indices.length % 3 !== 0 || indices.length === 0)
        throw new RangeError(
          'A hull mesh is not whole; pass vertices (three numbers each) and triangles (three indices each, wound outward).',
        );
      for (let k = 0; k < indices.length; k++)
        if (!(Number.isInteger(indices[k]) && indices[k]! >= 0 && indices[k]! < vertices.length / 3))
          throw new RangeError(
            `Hull triangle index ${indices[k]} names no vertex of the ${vertices.length / 3}; keep each index under the vertex count.`,
          );
    }
    const capacity = bodyRowsOf(
      host,
      'A HullSolver',
      hulls.map((h) => h.row),
      params.capacity,
    );
    this.capacity = capacity;
    this.hulls = hulls;
    this.courseLimits.clear();
    this.surgeMasses.clear();
    let courseCount = 0;
    this.course = hulls.map(({ course }) => {
      if (!course) return null;
      const trim = course.trim ?? 0;
      if (!(Number.isFinite(trim) && Math.abs(trim) < Math.PI / 2))
        throw new MargoError(
          'state',
          'The steady hull trim is invalid. Use finite radians below 90 degrees in magnitude.',
        );
      if (course.speed !== undefined && !Number.isFinite(course.speed))
        throw new MargoError('state', 'The hull course speed is invalid. Use finite metres per second.');
      const heading = course.lateralHeading;
      if (heading !== undefined && !Number.isFinite(heading))
        throw new MargoError('state', 'Pass a finite course direction in radians for lateralHeading.');
      return {
        speed: course.speed,
        trimSine: sin(trim),
        heading: heading !== undefined ? [cos(heading), sin(heading)] as const : undefined,
        historyIndex: courseCount++,
      };
    });
    this.sea = sea;
    this.level = level;
    this.gravity = params.gravity ?? [0, -GRAVITY, 0];
    this.addedMass = params.addedMass ?? true;
    this.stations = params.stations ?? 24;
    if (!(Number.isInteger(this.stations) && this.stations >= 2))
      throw new RangeError(`A hull's stations are ${this.stations}; pass a whole number of 2 or more.`);
    this.host = host;
    this.lastCrushPatch = lastCrushPatch;
    this.lastGirderJoint = lastGirderJoint;
    this.lastShellSeam = lastShellSeam;
    if (this.shellPressureField) {
      if (lastShellSeam < 0)
        throw new MargoError('state', 'Give the pressure-enabled hull at least one shellSeam opening.');
      const [gx, gy, gz] = this.gravity;
      if (gx !== 0 || gz !== 0 || !(gy < 0 && Number.isFinite(gy)))
        throw new MargoError('state', 'Use downward Y gravity when linking shell aperture pressure.');
      this.shellPressure = host.allocate(
        'shell-pressure',
        (lastShellSeam + 1) * SHELL_PRESSURE_WORDS * 8,
        'f64',
        SHELL_PRESSURE_LAYOUT,
      );
    }
    this.forces = host.allocate('forces', capacity * FORCE_WORDS * 8, 'f64', HULL_LAYOUT);
    if (this.wetChannel)
      this.wetMobility = host.allocate('wet-mobility', capacity * WET_INERTIA_WORDS * 8, 'f64', WET_INERTIA_LAYOUT);
    this.wakeSources = null;
    this.submergedWakeSources = null;
    this.wakePlanes.clear();
    this.wakeWaterplanes = hulls.map(({ wakeWaterplane }) => {
      if (wakeWaterplane === undefined) return undefined;
      const { plane, radius } = wakeWaterplane ?? {};
      if (this.wakeRadius === null)
        throw new MargoError('state', 'Enable the HullSolver wake option before assigning a baked waterplane.');
      if (!(radius > 0 && Number.isFinite(radius)))
        throw new MargoError('state', 'Set the baked waterplane projection radius to positive finite metres.');
      const nodes = plane?.nodes;
      if (
        !(nodes instanceof Float64Array) ||
        nodes.length === 0 ||
        nodes.length % 3 !== 0 ||
        !Number.isFinite(plane.waterline) ||
        nodes.some((value, i) => !Number.isFinite(value) || (i % 3 === 2 && !(value > 0)))
      )
        throw new MargoError(
          'state',
          'You must bake a nonempty reference waterplane with finite XZ coordinates and positive areas.',
        );
      return { plane: { waterline: plane.waterline, nodes: nodes.slice() }, radius };
    });
    this.reflectingWaterlines.clear();
    if (this.wakeRadius !== null || hulls.some((hull) => hull.shortWaveResistance)) this.loads.surfacePiercing = false;
    else delete this.loads.surfacePiercing;
    if (this.wakeRadius !== null) {
      if (level !== 0)
        throw new MargoError('state', 'Hull wake sources use the world base rate. Set the hull and wake to level 0.');
      let rows = 0;
      this.wakeOffsets = this.wakeWaterplanes.map((baked) => {
        const start = rows;
        rows += (baked ? baked.plane.nodes.length / 3 : 2 * this.stations) + (this.wakeAdvance ? this.stations + 1 : 0);
        return start;
      });
      const bytes = rows * WAKE_SOURCE_WORDS * Float64Array.BYTES_PER_ELEMENT;
      if (bytes > 0xffffffff)
        throw new MargoError(
          'state',
          'Reduce the number of hulls or bake fewer waterplane rows to fit in the wake field.',
        );
      this.wakeSources = host.allocate('wakeSources', bytes, 'f64', WAKE_SOURCE_LAYOUT);
    }
    this.wakePointGeometry = [];
    if (this.pointWakeSource) {
      let rows = 0;
      this.wakePointGeometry = hulls.map(({ wakeAdvancePoints }) => {
        if (wakeAdvancePoints === undefined) return undefined;
        const { geometry, radius } = wakeAdvancePoints ?? {};
        if (!(radius > 0 && Number.isFinite(radius)))
          throw new MargoError('state', 'Set the point wake projection radius to positive finite metres.');
        const nodes = geometry?.nodes;
        if (
          !(nodes instanceof Float64Array) ||
          nodes.length === 0 ||
          nodes.length % 4 !== 0 ||
          !Number.isFinite(geometry.waterline) ||
          nodes.some(
            (value, i) => !Number.isFinite(value) || (i % 4 === 2 && value < 0) || (i % 4 === 3 && value === 0),
          )
        )
          throw new MargoError(
            'state',
            'You must bake nonempty finite wake points with nonnegative depths and nonzero signed areas.',
          );
        const row = rows;
        rows += nodes.length / 4;
        return { geometry: { waterline: geometry.waterline, nodes: nodes.slice() }, radius, row };
      });
      if (rows === 0)
        throw new MargoError(
          'state',
          'Give at least one hull baked wakeAdvancePoints for the pointAdvance descriptor.',
        );
      const bytes = rows * SUBMERGED_WAKE_WORDS * Float64Array.BYTES_PER_ELEMENT;
      if (bytes > 0xffffffff)
        throw new MargoError(
          'state',
          'Reduce the number of hulls or bake fewer point sources before allocating the wake field.',
        );
      this.submergedWakeSources = host.allocate('pointWakeSources', bytes, 'f64', SUBMERGED_WAKE_LAYOUT);
    } else if (hulls.some(({ wakeAdvancePoints }) => wakeAdvancePoints !== undefined)) {
      throw new MargoError(
        'state',
        'Pass the finite pointAdvance descriptor before assigning baked wakeAdvancePoints.',
      );
    }
    if (this.submergedWakeSource) {
      this.submergedWakeRowsPerHull = 4 * (this.stations + 1) * (this.submergedWakeSource.depths.length - 1);
      const rows = hulls.length * this.submergedWakeRowsPerHull;
      if (rows > SUBMERGED_WAKE_MAX_ROWS)
        throw new MargoError(
          'state',
          'A projected wake field supports up to 16,384 rows; reduce the number of hulls, stations or depth bands.',
        );
      this.submergedWakeSources = host.allocate(
        'submergedWakeSources',
        rows * SUBMERGED_WAKE_WORDS * Float64Array.BYTES_PER_ELEMENT,
        'f64',
        SUBMERGED_WAKE_LAYOUT,
      );
    }
    this.radiation = params.radiation ?? true;
    this.rollDamping = params.rollDamping ?? true;
    this.viscosity = params.viscosity ?? SEA_VISCOSITY;
    if (!(this.viscosity > 0 && Number.isFinite(this.viscosity)))
      throw new RangeError(`A sea's viscosity is ${this.viscosity} m^2/s; pass a finite number above 0.`);
    const window = params.memory ?? 20;
    if (!(window > 0 && Number.isFinite(window)))
      throw new RangeError(`A hull's radiation memory is ${window} s; pass a finite number of seconds above 0.`);
    // Each hull's velocity (linear then angular), in its body's frame, at each of the last `lags` steps (by tick).
    this.lags = Math.ceil(window * rateOf(level));
    this.courseHistory = null;
    if (courseCount > 0) {
      if (!this.radiation || !this.addedMass)
        throw new MargoError(
          'state',
          'Hull course loads need radiation and added mass. Enable both on the HullSolver.',
        );
      this.courseHistory = host.allocate('course', courseCount * courseWords(this.lags) * 8, 'f64', HULL_LAYOUT);
    }
    if (this.radiation) {
      this.history = host.allocate('history', hulls.length * this.lags * 6 * 8, 'f64', HULL_LAYOUT);
      this.radiated = host.allocate('radiated', hulls.length * 7 * 8, 'f64', HULL_LAYOUT);
    }
    // Internal floodwater contributes inertia even when the exterior hydrodynamic added mass is disabled.
    if (this.addedMass || hulls.some((hull) => hull.compartments?.length))
      this.carry = host.allocate('carry', hulls.length * CARRY_WORDS * 8, 'f64', HULL_LAYOUT);
    this.diffraction = (params.diffraction ?? true) && this.waterOf() !== null;
    this.panelScatter = (params.diffraction ?? true) && this.wavesOf() !== null;
    const seaDepth = this.wavesOf()?.stillDepth;
    for (const hull of hulls) {
      const table = hull.panels;
      if (!table) continue;
      if (hull.surgeAddedMass)
        throw new MargoError('state', 'Choose either bakeHullPanels or surgeAddedMass for this hull.');
      if (table.density !== (sea.density ?? SEA_WATER) || table.gravity !== -this.gravity[1] ||
        (seaDepth !== undefined && seaDepth !== table.depth))
        throw new MargoError('state', 'Use the same density, gravity and still depth as the world when baking hull panels.');
      const top = 2 * table.frequencies.at(-1)! - table.frequencies.at(-2)!;
      if (!(top < Math.PI * rateOf(level)))
        throw new MargoError('state', 'Choose panel frequencies below the hull tick rate’s Nyquist frequency or increase its rate.');
    }
    this.drift = (params.drift ?? true) && this.wavesOf() !== null;
    this.greenWater = params.greenWater ?? true;
    this.slamming = params.slamming ?? true;
    this.drag = params.drag ?? true;
    this.dragCoefficient = params.dragCoefficient ?? FORM_DRAG;
    if (!(this.dragCoefficient >= 0 && Number.isFinite(this.dragCoefficient)))
      throw new RangeError(`A hull's drag coefficient is ${this.dragCoefficient}; pass a finite number of 0 or more.`);
    if (this.slamming) this.slam = host.allocate('slam', hulls.length * (this.stations + 1) * 8, 'f64', HULL_LAYOUT);
    this.deckCells = params.deckCells ?? [32, 12];
    const [cx, cz] = this.deckCells;
    if (!(Number.isInteger(cx) && Number.isInteger(cz) && cx >= 2 && cz >= 2 && cx * cz <= 65536))
      throw new RangeError(`A deck's cells are ${cx} by ${cz}; pass whole numbers of 2 or more, at most 65,536 cells.`);
    this.inflowRecords = 4 * (cx + cz);
    this.inflow = host.allocate(
      'deckInflow',
      (1 + hulls.length * this.inflowRecords * DECK_INFLOW_WORDS) * 8,
      'f64',
      HULL_LAYOUT,
    );
    if (this.greenWater)
      this.deckWater = host.allocate('deckWater', hulls.length * (3 * cx * cz + 4) * 8, 'f64', HULL_LAYOUT);
    if (this.diffraction)
      this.waves = host.allocate('waves', hulls.length * this.stations * this.lags * 2 * 8, 'f64', HULL_LAYOUT);
    // Flooding: each hull's compartments' water, air and cargo, and its openings' state; one breach record an opening to
    // the outside.
    let words = 0,
      records = 0;
    for (const hull of hulls) {
      if (!hull.compartments?.length) {
        if (hull.openings?.length)
          throw new RangeError(
            `Hull ${hull.row} has openings but no compartments; pass the compartments they open from.`,
          );
        continue;
      }
      const flooding = new Flooding(hull.compartments, hull.openings ?? []);
      this.floods.set(hull, { flooding, at: words, record: records });
      words += flooding.words;
      for (let k = 0; k < flooding.openingCount; k++) if (flooding.ends(k)[1] === -1) records++;
    }
    this.breaches = host.allocate('hullBreaches', (1 + records * HULL_BREACH_WORDS) * 8, 'f64', HULL_LAYOUT);
    if (words > 0) {
      this.flood = host.allocate('flood', words * 8, 'f64', HULL_LAYOUT);
      const state = new Float64Array(host.memory.buffer, this.flood.byteOffset, words);
      for (const { flooding, at } of this.floods.values()) flooding.initialise(state.subarray(at, at + flooding.words));
    }
  }

  /**
   * The hull's form drag for `wettedLoads`: a point's velocity from the body's velocity `v` and spin `spin` (the roll's
   * part about the body's x taken out where the roll damping takes it), less the water's at the centre of mass.
   */
  private dragOf(
    hull: Hull,
    inverseMass: number,
    v: readonly number[],
    spin: readonly number[],
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
  ): WettedDrag | undefined {
    if (!this.drag || !(this.dragCoefficient > 0) || !(inverseMass > 0)) return undefined;
    // How far the hull has gone under: 0 at the displacement it floats at (its mass over the water's density), 1 with all
    // of it under. A floating hull's resistance is its surface models' (the waves it makes, its roll's eddies, a
    // manoeuvring model's resistance); the form drag takes over as it goes under, where they do not reach.
    const rotation = pose.rotation,
      q = rotation,
      up: Vec3 = [
        2 * (q[0] * q[1] + q[3] * q[2]),
        1 - 2 * (q[0] * q[0] + q[2] * q[2]),
        2 * (q[1] * q[2] - q[3] * q[0]),
      ],
      density = this.sea!.density ?? SEA_WATER,
      floating = 1 / inverseMass / density;
    let whole = this.volumes.get(hull);
    if (whole === undefined) {
      whole = volumeBelow(hull.mesh, [0, 1, 0], Infinity);
      this.volumes.set(hull, whole);
    }
    const under = volumeBelow(hull.mesh, up, this.sea!.elevation(centre[0], centre[2], t) - pose.position[1]),
      share = whole > floating ? Math.min(1, Math.max(0, (under - floating) / (whole - floating))) : 1;
    if (!(share > 0)) return undefined;
    const water = this.waterOf(),
      flow = water ? water.sample(centre[0], centre[1], centre[2], t, this.flow).velocity : [0, 0, 0],
      w = [spin[0]!, spin[1]!, spin[2]!];
    if (this.rollDamping) {
      const x = rotate(rotation, [1, 0, 0]),
        along = w[0]! * x[0] + w[1]! * x[1] + w[2]! * x[2];
      for (let k = 0; k < 3; k++) w[k]! -= along * x[k]!;
    }
    const u = [v[0]! - flow[0]!, v[1]! - flow[1]!, v[2]! - flow[2]!];
    return {
      coefficient: this.dragCoefficient * share,
      velocity: (x, y, z, out) => {
        const r0 = x - centre[0],
          r1 = y - centre[1],
          r2 = z - centre[2];
        out[0] = u[0]! + w[1]! * r2 - w[2]! * r1;
        out[1] = u[1]! + w[2]! * r0 - w[0]! * r2;
        out[2] = u[2]! + w[0]! * r1 - w[1]! * r0;
      },
    };
  }

  /** The sea's waves, when it gives them (`SpectralSea`'s `waveComponents`, its count and its depth). */
  private wavesOf(): SeaWaves | null {
    const sea = this.sea as Partial<SeaWaves> | null;
    return sea && typeof sea.waveComponents === 'function' && typeof sea.waveCount === 'number'
      ? (sea as SeaWaves)
      : null;
  }

  /** The water under the sea's surface, when the sea gives it. */
  private waterOf(): SeaWater | null {
    const water = (this.sea as Partial<SeaSurface>).water;
    return water && typeof water.sample === 'function' ? water : null;
  }

  private throughWaterSpeed(
    velocity: readonly number[],
    rotation: readonly [number, number, number, number],
    centre: Vec3,
    t: number,
  ): number {
    const forward = rotate(rotation, [1, 0, 0]);
    const horizontal = hypot(forward[0], forward[2]);
    if (horizontal === 0) return 0;
    const sea = this.sea as Partial<SeaSurface>;
    const current =
      typeof sea.sample === 'function' ? sea.sample(centre[0], centre[2], t, this.surfaceSample).current : undefined;
    const vx = velocity[0]! - (current?.[0] ?? 0);
    const vz = velocity[2]! - (current?.[2] ?? 0);
    return (vx * forward[0] + vz * forward[2]) / horizontal;
  }

  step(context: StepContext, dt: number): void {
    const host = this.host;
    if (!host || !this.sea || !this.forces)
      throw new MargoError('state', 'HullSolver is not in a world yet; add it with world.add(solver, {hulls, sea}).');
    const out = new Float64Array(host.memory.buffer, this.forces.byteOffset, this.capacity * FORCE_WORDS),
      records = new Float64Array(host.memory.buffer, this.inflow!.byteOffset, this.inflow!.byteLength / 8),
      breaches = new Float64Array(host.memory.buffer, this.breaches!.byteOffset, this.breaches!.byteLength / 8);
    records.fill(0);
    breaches.fill(0);
    out.fill(0);
    const wake = this.wakeSources
      ? new Float64Array(host.memory.buffer, this.wakeSources.byteOffset, this.wakeSources.byteLength / 8)
      : null;
    wake?.fill(0);
    const submergedWake = this.submergedWakeSources
      ? (regionWords(host.memory, this.submergedWakeSources) as Float64Array)
      : undefined;
    submergedWake?.fill(0);
    const cell = (this.sea as Partial<SeaSurface>).cell;
    if (cell && (cell[0] !== context.cell[0] || cell[1] !== context.cell[1] || cell[2] !== context.cell[2]))
      throw new MargoError(
        'state',
        `The sea's origin cell is [${cell.join(', ')}] and the HullSolver's is [${context.cell.join(', ')}]; make the sea in the hull's cell (a SpectralSea's positions are offsets from its cell).`,
      );
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    const crush = this.crushDamage && context.inputs.get(this.crushDamage.name);
    if (
      crush &&
      (crush.region.type !== 'f64' ||
        crush.region.layout !== CRUSH_LAYOUT ||
        crush.region.byteLength % (CRUSH_WORDS * Float64Array.BYTES_PER_ELEMENT) !== 0)
    )
      throw new MargoError('state', 'Use the layout-1 f64 CrushSolver damage port to connect the hull.');
    const damage = crush && (regionWords(crush.region.memory ?? host.memory, crush.region) as Float64Array);
    if (damage && this.lastCrushPatch * CRUSH_WORDS >= damage.length)
      throw new MargoError('state', 'Choose a hull opening crushPatch within the connected damage port.');
    const girder = this.girderSeams && context.inputs.get(this.girderSeams.name);
    const girderRowBytes = GIRDER_SEAM_WORDS * Float64Array.BYTES_PER_ELEMENT;
    if (
      girder &&
      (girder.region.type !== 'f64' ||
        girder.region.layout !== GIRDER_SEAM_LAYOUT ||
        girder.region.byteLength % girderRowBytes !== 0)
    )
      throw new MargoError('state', 'Use the layout-1 f64 GirderJointSolver seam port to connect the hull.');
    const seams = girder && (regionWords(girder.region.memory ?? host.memory, girder.region) as Float64Array);
    if (seams && this.lastGirderJoint * GIRDER_SEAM_WORDS >= seams.length)
      throw new MargoError('state', 'Choose a hull opening girderJoint within the connected seam port.');
    const aperturePort = this.shellApertures && context.inputs.get(this.shellApertures.field.name);
    const shellPressure = this.shellPressure
      ? (regionWords(host.memory, this.shellPressure) as Float64Array)
      : undefined;
    if (shellPressure && (aperturePort?.tick !== context.tick || port.tick !== context.tick - 1))
      throw new MargoError('state', 'Use the same rate and the order shell, hull, rigid for aperture pressure.');
    shellPressure?.fill(0);
    let shellInput: { rows: Float64Array; offset: Vec3 } | undefined;
    if (aperturePort && this.lastShellSeam >= 0) {
      const { cell } = aperturePort;
      const delta = [cell[0] - context.cell[0], cell[1] - context.cell[1], cell[2] - context.cell[2]] as const;
      const size = this.shellApertures?.cellSize;
      if (size === undefined && delta.some((value) => value !== 0))
        throw new MargoError('state', 'Set the common cellSize for shell apertures and hulls in different cells.');
      const offset = [delta[0] * (size ?? 1), delta[1] * (size ?? 1), delta[2] * (size ?? 1)] as const;
      if (!offset.every(Number.isFinite))
        throw new MargoError('state', 'Use a finite metre offset between the hull and shell cells.');
      shellInput = {
        rows: shellApertureRows(host.memory, aperturePort, this.lastShellSeam),
        offset,
      };
    }
    const wet = this.wetMobility && (regionWords(host.memory, this.wetMobility) as Float64Array);
    wet?.fill(0);
    let received: Float64Array | undefined;
    if (this.wetChannel) {
      const receipt = context.inputs.get(this.wetChannel.receipt.name);
      if (!receipt || receipt.tick !== context.tick - 1 || port.tick !== context.tick - 1)
        throw new MargoError('state', 'Use the solver order hull, crush and rigid at the same rate.');
      received = wetInertiaWords(host.memory, receipt, this.capacity, WET_IMPULSE_WORDS);
    }
    const cavityPort = this.entryCavity && context.inputs.get(this.entryCavity.name);
    if (this.entryCavity && (cavityPort?.tick !== context.tick || port.tick !== context.tick - 1))
      throw new MargoError('state', 'Use the solver order entry, hull and rigid at the same rate for cavity pressure.');
    const cavity = cavityPort && entryCavityRows(host.memory, cavityPort, this.capacity);
    const memory = port.region.memory ?? host.memory,
      bodies = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4),
      // The middle of the step the load is held over.
      t = (context.tick + 0.5) / rateOf(context.level),
      // A ship solver's manoeuvring model owns its hull's surge, sway and yaw damping, and their added mass unless told not to.
      claimed = context.inputs.get(MANOEUVRING_CLAIMS_FIELD.name),
      claims = claimed
        ? new Float64Array(
            claimed.region.memory?.buffer ?? host.memory.buffer,
            claimed.region.byteOffset,
            claimed.region.byteLength / 8,
          )
        : undefined;
    for (const [index, hull] of this.hulls.entries()) {
      const at = hull.row * BODY_WORDS;
      if (at + BODY_WORDS > bodies.length) continue;
      if (shellPressure && hull.openings?.some((opening) => opening.shellSeam !== undefined)) {
        const position: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!];
        const rotation = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!] as const;
        if (
          bodies[at + 23] !== 0 ||
          bodies.subarray(at + 10, at + 16).some((component) => component !== 0) ||
          rotation.every((component) => component === 0) ||
          port.cell.some((cell, axis) => cell !== context.cell[axis])
        )
          throw new MargoError(
            'state',
            'Use a live, stationary fixed hull in its rigid origin cell for shell pressure.',
          );
        this.floodLoad(
          hull,
          { position, rotation },
          position,
          t,
          dt,
          context.tick,
          breaches,
          undefined,
          damage,
          seams,
          shellInput,
          shellPressure,
        );
        continue;
      }
      if (bodies[at + 23] !== 1) continue;
      const cavityAt = hull.row * ENTRY_CAVITY_WORDS,
        cavityNormal: Vec3 | undefined =
          cavity?.[cavityAt] === 1 ? [cavity[cavityAt + 1]!, cavity[cavityAt + 2]!, cavity[cavityAt + 3]!] : undefined;
      this.claim = claims && hull.row < claims.length ? claims[hull.row]! : 0;
      // The pose a fraction of the step on (the body's velocity and spin carried over it), where a load held through the step
      // neither feeds the motion energy nor takes it. The rigid step moves a body by (v + F dt (s + 1) / (2 s m)) dt over its
      // s symplectic-Euler substeps (the `bodies` port gives s), so a restoring load -k x taken at x + theta v dt has the
      // update's determinant 1 + (w dt)^2 (1 - theta - (s + 1) / (2 s)), which is 1 at theta = (s - 1) / (2 s): 7/16 of the
      // step at 8 substeps. Taken at the middle, a hull lost about pi w dt / (2 s) of its amplitude a cycle (4.6 percent for a
      // box heaving at 14 rad/s at 60 steps a second); taken where the step starts, it gained w dt (s - 1) / (2 s) times that.
      const substeps = Math.max(1, bodies[at + 24]!),
        ahead = (substeps - 1) / (2 * substeps) / rateOf(context.level),
        v = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
        spin = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
        start = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!] as const,
        turned = turn(start, spin, ahead),
        centre = [
          bodies[at + 7]! + v[0]! * ahead,
          bodies[at + 8]! + v[1]! * ahead,
          bodies[at + 9]! + v[2]! * ahead,
        ] as const,
        // The origin rides with the centre of mass and turns about it.
        offset = rotate(
          turned,
          rotate(
            [-start[0], -start[1], -start[2], start[3]],
            [bodies[at]! - bodies[at + 7]!, bodies[at + 1]! - bodies[at + 8]!, bodies[at + 2]! - bodies[at + 9]!],
          ),
        ),
        pose = {
          position: [centre[0] + offset[0], centre[1] + offset[1], centre[2] + offset[2]] as const,
          rotation: turned,
        },
        loads = wettedLoads(
          this.greenWater ? this.deckFor(hull, bodies, at, pose, centre, 1 / rateOf(context.level)).wet : hull.mesh,
          pose,
          this.sea,
          t,
          centre,
          this.loads,
          this.dragOf(hull, bodies[at + 16]!, v, spin, pose, centre, t),
          cavityNormal,
        );
      const course = this.course[index];
      const wetWake = wake && this.loads.surfacePiercing && bodies[at + 16]! > 0;
      const reflecting = hull.shortWaveResistance && this.loads.surfacePiercing && bodies[at + 16]! > 0;
      const throughWater =
        (wetWake && (this.wakeAdvance || this.submergedWakeSource || this.pointWakeSource)) ||
        ((course || reflecting) && course?.speed === undefined)
          ? this.throughWaterSpeed(v, turned, centre, t)
          : 0;
      const speed = course ? (course.speed ?? throughWater) : 0;
      if (wetWake)
        this.displaceWake(
          hull,
          index,
          1 / bodies[at + 16]!,
          pose,
          centre,
          v[1]!,
          spin,
          throughWater,
          dt,
          wake,
          submergedWake,
        );
      if (reflecting)
        this.reflectShortWaves(hull, 1 / bodies[at + 16]!, turned, t, course?.speed ?? throughWater, loads);
      if (this.radiation)
        this.radiate(
          hull,
          bodies,
          at,
          pose,
          centre,
          context.tick,
          1 / rateOf(context.level),
          ahead * rateOf(context.level),
          speed,
          loads,
        );
      if (this.rollDamping) this.dampRoll(hull, bodies, at, pose, centre, t, 1 / rateOf(context.level), speed, loads);
      if (hull.panels?.headings && this.panelScatter) {
        if (loads.area > 0) this.diffractPanels(hull.panels, pose, t, loads);
      }
      else if (this.diffraction)
        this.diffract(hull, bodies, at, pose, centre, context.tick, t, 1 / rateOf(context.level), speed, loads);
      if (this.drift) this.driftLoad(hull, bodies, at, pose, centre, t, 1 / rateOf(context.level), loads);
      if (this.slamming) this.slamLoad(hull, pose, centre, t, 1 / rateOf(context.level), loads);
      if (this.greenWater) this.deckLoad(hull, bodies, at, pose, centre, t, 1 / rateOf(context.level), context, loads);
      const points = this.floodLoad(
          hull,
          pose,
          centre,
          t,
          1 / rateOf(context.level),
          context.tick,
          breaches,
          loads,
          damage,
          seams,
          shellInput,
        ),
        w = hull.row * FORCE_WORDS,
        held =
          this.addedMass || points.length > 0
            ? this.carried(hull, bodies, at, pose, centre, t, 1 / rateOf(context.level), loads, points, wet, received)
            : [...loads.force, ...loads.torque];
      for (let k = 0; k < 6; k++) out[w + k]! += held[k]!;
    }
  }

  /** Add the mean longitudinal pressure of reflected short waves using the reference waterline. */
  private reflectShortWaves(
    hull: Hull,
    mass: number,
    rotation: readonly [number, number, number, number],
    t: number,
    speed: number,
    loads: WettedLoads,
  ): void {
    const sea = this.wavesOf();
    if (!sea) return;
    const gravity = -this.gravity[1];
    if (gravity <= 0) return;
    const axis = rotate(rotation, [1, 0, 0]);
    const heading = hypot(axis[0], axis[2]);
    if (heading === 0) return;
    let waterline = this.reflectingWaterlines.get(hull);
    const density = this.sea!.density ?? SEA_WATER;
    if (!waterline) {
      const height = stillWaterline(hull.mesh, mass, density);
      waterline = reflectingWaterline(hull.mesh, height);
      this.reflectingWaterlines.set(hull, waterline);
    }
    const { beam, length, draft } = waterline;
    if (!(beam > 0 && length > 0 && draft > 0)) return;
    if (this.waves32.length < 4 * sea.waveCount) this.waves32 = new Float32Array(4 * sea.waveCount);
    const count = sea.waveComponents(t, this.waves32);
    const depth = sea.stillDepth ?? Infinity;
    const forwardX = axis[0] / heading;
    const forwardZ = axis[2] / heading;
    const froude = Math.abs(speed) / Math.sqrt(gravity * length);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const kx = this.waves32[4 * i]!;
      const kz = this.waves32[4 * i + 1]!;
      const amplitude = this.waves32[4 * i + 2]!;
      const k = hypot(kx, kz);
      if (!(k > 0 && amplitude > 0)) continue;
      const along = kx * forwardX + kz * forwardZ;
      const across = -kx * forwardZ + kz * forwardX;
      const width = interceptedBreadth(waterline, along / k, across / k);
      if (width === 0) continue;
      const decay = depth < Infinity ? exp(-2 * k * depth) : 0;
      const omega = Math.sqrt((gravity * k * (1 - decay)) / (1 + decay));
      const encounter = omega - along * speed;
      const reflection = wallReflectance((encounter * encounter * draft) / gravity);
      const bluntness = Math.abs(width) / beam;
      // Tsujimoto et al. (2008), Figure 7, conventional hulls without a measured speed coefficient.
      const coefficient = Math.max(10, 68 - 310 * bluntness);
      total += amplitude * amplitude * width * reflection * (1 + coefficient * froude);
    }
    const force = -0.5 * density * gravity * total;
    loads.force[0] += force * forwardX;
    loads.force[2] += force * forwardZ;
  }

  /** Project the wet boundary's vertical and longitudinal fluxes onto its still-water waterplane. */
  private displaceWake(
    hull: Hull,
    index: number,
    mass: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    heave: number,
    spin: readonly number[],
    throughWater: number,
    dt: number,
    rows: Float64Array,
    submergedRows?: Float64Array,
  ): void {
    const baked = this.wakeWaterplanes[index];
    const points = this.wakePointGeometry[index];
    let plane = this.wakePlanes.get(hull);
    const density = baked || points || !plane ? (this.sea!.density ?? SEA_WATER) : plane.density;
    if (!plane || ((baked || points) && (plane.mass !== mass || plane.density !== density))) {
      const waterline = stillWaterline(hull.mesh, mass, density);
      if (baked && Math.abs(baked.plane.waterline - waterline) > 2e-6 * Math.max(1, Math.abs(waterline)))
        throw new MargoError(
          'state',
          'You must rebake the wake waterplane for the hull’s current reference mass and sea density.',
        );
      if (points && Math.abs(points.geometry.waterline - waterline) > 2e-6 * Math.max(1, Math.abs(waterline)))
        throw new MargoError(
          'state',
          'You must rebake the point wake panels for the hull’s current reference mass and sea density.',
        );
      const sections =
        !baked || this.wakeAdvance || this.submergedWakeSource ? hullSections(hull.mesh, waterline, this.stations) : [];
      plane = {
        waterline,
        mass,
        density,
        sections,
        submerged: this.submergedWakeSource
          ? submergedWakeNodes(hull.mesh, waterline, sections, this.submergedWakeSource.depths, this.wakeRadius!)
          : undefined,
      };
      this.wakePlanes.set(hull, plane);
    }
    let at = this.wakeOffsets[index]! * WAKE_SOURCE_WORDS;
    if (baked) {
      const { nodes, waterline } = baked.plane;
      const origin = rotate(pose.rotation, [0, waterline, 0]);
      const forward = rotate(pose.rotation, [1, 0, 0]);
      const right = rotate(pose.rotation, [0, 0, 1]);
      const x0 = pose.position[0] + origin[0];
      const z0 = pose.position[2] + origin[2];
      const vertical = heave + spin[2]! * (x0 - centre[0]) - spin[0]! * (z0 - centre[2]);
      const along = spin[2]! * forward[0] - spin[0]! * forward[2];
      const across = spin[2]! * right[0] - spin[0]! * right[2];
      for (let i = 0; i < nodes.length; i += 3, at += WAKE_SOURCE_WORDS) {
        const x = nodes[i]!;
        const z = nodes[i + 1]!;
        rows[at] = x0 + x * forward[0] + z * right[0];
        rows[at + 1] = z0 + x * forward[2] + z * right[2];
        rows[at + 2] = baked.radius;
        rows[at + 4] = -nodes[i + 2]! * (vertical + x * along + z * across) * dt;
      }
    } else {
      const gauss = 1 / (2 * Math.sqrt(3));
      for (const { x, width, breadth } of plane.sections) {
        const radius = Math.max(this.wakeRadius!, 0.5 * hypot(width, 0.5 * breadth));
        const area = 0.5 * width * breadth;
        // Two Gauss points integrate the transverse first flux moment of a rectangular waterplane strip.
        for (const side of [-1, 1]) {
          const point = rotate(pose.rotation, [x, plane.waterline, side * gauss * breadth]);
          const px = pose.position[0] + point[0];
          const pz = pose.position[2] + point[2];
          const vertical = heave + spin[2]! * (px - centre[0]) - spin[0]! * (pz - centre[2]);
          rows[at] = px;
          rows[at + 1] = pz;
          rows[at + 2] = radius;
          rows[at + 4] = -area * vertical * dt;
          at += WAKE_SOURCE_WORDS;
        }
      }
    }
    if (submergedRows && throughWater !== 0 && points) {
      const { nodes, waterline } = points.geometry;
      const surface = rotate(pose.rotation, [0, waterline, 0]);
      const forward = rotate(pose.rotation, [1, 0, 0]);
      const right = rotate(pose.rotation, [0, 0, 1]);
      const x0 = pose.position[0] + surface[0];
      const z0 = pose.position[2] + surface[2];
      const scale = throughWater * dt;
      let row = points.row * SUBMERGED_WAKE_WORDS;
      for (let i = 0; i < nodes.length; i += 4, row += SUBMERGED_WAKE_WORDS) {
        const x = nodes[i]!;
        const z = nodes[i + 1]!;
        submergedRows[row] = x0 + x * forward[0] + z * right[0];
        submergedRows[row + 1] = z0 + x * forward[2] + z * right[2];
        submergedRows[row + 2] = points.radius;
        submergedRows[row + 3] = nodes[i + 2]!;
        submergedRows[row + 4] = nodes[i + 3]! * scale;
      }
    } else if (submergedRows && throughWater !== 0 && this.submergedWakeSource) {
      let row = index * this.submergedWakeRowsPerHull * SUBMERGED_WAKE_WORDS;
      for (const node of plane.submerged!) {
        const point = rotate(pose.rotation, [node.x, plane.waterline, node.z]);
        submergedRows[row] = pose.position[0] + point[0];
        submergedRows[row + 1] = pose.position[2] + point[2];
        submergedRows[row + 2] = node.radius;
        submergedRows[row + 3] = node.band;
        submergedRows[row + 4] = node.area * throughWater * dt;
        row += SUBMERGED_WAKE_WORDS;
      }
    }
    if (this.wakeAdvance && throughWater !== 0) {
      const { sections, waterline } = plane;
      const first = sections[0]!;
      const start = first.x - first.width / 2;
      const surface = rotate(pose.rotation, [0, waterline, 0]);
      const forward = rotate(pose.rotation, [1, 0, 0]);
      // The depth integral of the slender-hull source sheet is -U dA/dx. Adjacent
      // sections share a face, so their volume change transfers water without adding it.
      for (let i = 0; i <= sections.length; i++, at += WAKE_SOURCE_WORDS) {
        const after = sections[i];
        const before = sections[i - 1];
        const volume = ((before?.area ?? 0) - (after?.area ?? 0)) * throughWater * dt;
        if (volume === 0) continue;
        const x = start + i * first.width;
        const breadth = Math.max(before?.breadth ?? 0, after?.breadth ?? 0);
        rows[at] = pose.position[0] + surface[0] + forward[0] * x;
        rows[at + 1] = pose.position[2] + surface[2] + forward[2] * x;
        rows[at + 2] = Math.max(this.wakeRadius!, 0.5 * hypot(first.width, breadth));
        rows[at + 4] = volume;
      }
    }
  }

  /** The hull's radiation memory at its still-water draft, made at its first step (from its mesh and mass alone). */
  private memoryOf(hull: Hull, bodies: Float32Array, at: number, local: Vec3, dt: number): HullWaveMemory | null {
    const inverseMass = bodies[at + 16]!;
    if (!(inverseMass > 0)) return null;
    let memory = this.memories.get(hull);
    if (!memory) {
      memory = buildHullMemory(hull.mesh, 1 / inverseMass, local, this.sea!.density ?? SEA_WATER, dt, {
        stations: this.stations,
        window: Math.max(1, this.lags) * dt,
        waveResponse: this.diffraction && Boolean(hull.course && this.wavesOf()),
      });
      this.memories.set(hull, memory);
    }
    return memory;
  }

  private diffractPanels(
    table: HullPanelResponse,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    t: number,
    loads: WettedLoads,
  ): void {
    const sea = this.wavesOf()!;
    if (this.waves32.length < 4 * sea.waveCount) this.waves32 = new Float32Array(4 * sea.waveCount);
    const count = sea.waveComponents(t, this.waves32);
    const q = pose.rotation;
    const forward = rotate(q, [1, 0, 0]);
    const across = rotate(q, [0, 0, 1]);
    panelDiffraction(table, this.waves32, count, pose.position, forward, across, this.panelForce);
    const f = rotate(q, [this.panelForce[0]!, this.panelForce[1]!, this.panelForce[2]!]);
    const m = rotate(q, [this.panelForce[3]!, this.panelForce[4]!, this.panelForce[5]!]);
    for (let k = 0; k < 3; k++) {
      loads.force[k]! += f[k]!;
      loads.torque[k]! += m[k]!;
    }
  }

  /**
   * Adds the waves' diffraction loads to `loads` (the relative motion principle): each section takes its added mass at
   * infinite frequency times the water's acceleration plus its damping kernel convolved with the water's velocity, in heave
   * at its mean draft and in sway and roll at its centroid's depth, under the still-water level at the section's station.
   * The velocities at time t go into the history at this tick; the accelerations are their central differences over the
   * step. Integrated along the hull in the body's axes: heave and pitch from the heave loads, sway, roll and yaw from the
   * sway loads.
   */
  private diffract(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    tick: number,
    t: number,
    dt: number,
    speed: number,
    loads: WettedLoads,
  ): void {
    const q = pose.rotation,
      conjugate = [-q[0], -q[1], -q[2], q[3]] as const,
      local = rotate(conjugate, [
        centre[0] - pose.position[0],
        centre[1] - pose.position[1],
        centre[2] - pose.position[2],
      ]),
      memory = this.memoryOf(hull, bodies, at, local, dt),
      water = this.waterOf();
    if (!memory || !water || memory.strips.length === 0) return;
    const lags = this.lags,
      stations = this.stations,
      index = this.hulls.indexOf(hull),
      ring = new Float64Array(
        this.host!.memory.buffer,
        this.waves!.byteOffset + index * stations * lags * 2 * 8,
        stations * lags * 2,
      ),
      slot = tick % lags,
      flow = this.flow,
      // The water's velocity in the body's axes at body point (x, 0, z) on the still-water plane, `depth` under it.
      motion = (x: number, depth: number, time: number) => {
        const p = rotate(q, [x, 0, local[2]]);
        water.sample(pose.position[0] + p[0], -depth, pose.position[2] + p[2], time, flow);
        return rotate(conjugate, flow.velocity);
      },
      body = [0, 0, 0, 0, 0, 0];
    memory.strips.forEach((strip, s) => {
      const form = memory.stripForms[strip.form]!,
        x = local[0] + strip.x,
        heave = motion(x, strip.heaveDepth, t)[1],
        sway = motion(x, strip.swayDepth, t)[2],
        heaveRate = (motion(x, strip.heaveDepth, t + dt / 2)[1] - motion(x, strip.heaveDepth, t - dt / 2)[1]) / dt,
        swayRate = (motion(x, strip.swayDepth, t + dt / 2)[2] - motion(x, strip.swayDepth, t - dt / 2)[2]) / dt,
        base = s * lags * 2;
      ring[base + 2 * slot] = heave;
      ring[base + 2 * slot + 1] = sway;
      let k33 = 0,
        k22 = 0,
        k24 = 0;
      const n = Math.min(lags, form.k33.length);
      for (let lag = 0; lag < n; lag++) {
        const r = base + 2 * ((slot - lag + lags) % lags),
          weight = lag === 0 ? 0.5 : 1;
        k33 += weight * form.k33[lag]! * ring[r]!;
        k22 += weight * form.k22[lag]! * ring[r + 1]!;
        k24 += weight * form.k24[lag]! * ring[r + 1]!;
      }
      const w = strip.width,
        f3 = w * (form.a33 * heaveRate + k33 * dt),
        f2 = w * (form.a22 * swayRate + k22 * dt),
        m4 = w * (form.a24 * swayRate + k24 * dt);
      body[1]! += f3;
      body[5]! += strip.x * f3;
      body[2]! += f2;
      body[3]! += m4;
      body[4]! -= strip.x * f2;
    });
    const sea = this.wavesOf();
    const course = this.course[index];
    if (course && sea && memory.waveResponses) {
      const forward = rotate(q, [1, 0, 0]);
      const vx = bodies[at + 10]!;
      const vz = bodies[at + 12]!;
      if (speed !== 0) {
        if (this.waves32.length < 4 * sea.waveCount) this.waves32 = new Float32Array(4 * sea.waveCount);
        const count = sea.waveComponents(t, this.waves32);
        if (this.courseWaveScratch.length < 3 * memory.stripForms.length)
          this.courseWaveScratch = new Float64Array(3 * memory.stripForms.length);
        const [force, moment] = courseWaveCorrection(
          memory,
          this.waves32,
          count,
          sea.stillDepth ?? Infinity,
          -this.gravity[1],
          centre,
          forward,
          vx,
          vz,
          speed,
          this.courseWaveScratch,
        );
        body[1]! += force;
        body[5]! += moment;
      }
    }
    const f = rotate(q, [body[0]!, body[1]!, body[2]!]),
      m = rotate(q, [body[3]!, body[4]!, body[5]!]);
    for (let k = 0; k < 3; k++) {
      loads.force[k]! += f[k]!;
      loads.torque[k]! += m[k]!;
    }
  }

  /**
   * Adds the waves' drift to `loads`, by Newman's approximation over the sea's waves: with each wave's amplitude a_i, its
   * phase theta_i over the hull's centre and its drift coefficient D_i (the hull's, at its frequency, times s|s|, s the
   * share of its direction across the hull, so a wave from abeam pushes hardest and one from ahead not at all), the force
   * across the hull is Re[(sum a_i D_i e^(i theta_i)) (sum a_j e^(-i theta_j))]: the mean sum a_i^2 D_i and the slow beat of
   * the waves' groups, none of their sum frequencies.
   */
  private driftLoad(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
    dt: number,
    loads: WettedLoads,
  ): void {
    const sea = this.wavesOf();
    if (!sea) return;
    const q = pose.rotation,
      conjugate = [-q[0], -q[1], -q[2], q[3]] as const,
      local = rotate(conjugate, [
        centre[0] - pose.position[0],
        centre[1] - pose.position[1],
        centre[2] - pose.position[2],
      ]),
      memory = this.memoryOf(hull, bodies, at, local, dt);
    if (!memory || memory.strips.length === 0) return;
    let table = this.drifts.get(hull);
    if (!table) {
      table = this.driftOf(hull, bodies, at, q, local, memory);
      this.drifts.set(hull, table);
    }
    if (this.waves32.length < 4 * sea.waveCount) this.waves32 = new Float32Array(4 * sea.waveCount);
    const n = sea.waveComponents(t, this.waves32),
      w = this.waves32,
      g = -this.gravity[1],
      depth = sea.stillDepth ?? Infinity;
    let ar = 0,
      ai = 0,
      br = 0,
      bi = 0;
    for (let i = 0; i < n; i++) {
      const kx = w[4 * i]!,
        kz = w[4 * i + 1]!,
        a = w[4 * i + 2]!,
        k = hypot(kx, kz);
      if (!(k > 0 && a > 0)) continue;
      const deep = depth < Infinity ? (1 - exp(-2 * k * depth)) / (1 + exp(-2 * k * depth)) : 1,
        omega = Math.sqrt(g * k * deep),
        across = rotate(conjugate, [kx / k, 0, kz / k])[2],
        d = a * interpolate(table.frequencies, table.coefficient, omega) * across * Math.abs(across),
        theta = kx * centre[0] + kz * centre[2] + w[4 * i + 3]!,
        c = cos(theta),
        sn = sin(theta);
      ar += d * c;
      ai += d * sn;
      br += a * c;
      bi += a * sn;
    }
    const force = ar * br + ai * bi,
      f = rotate(q, [0, 0, force]);
    for (let k = 0; k < 3; k++) loads.force[k]! += f[k]!;
  }

  /**
   * A hull's drift coefficient at each of its memory's frequencies, in waves from abeam (along its z), from its still-water
   * pose. At each frequency: the hull's heave and its coupled sway and roll in a wave of unit amplitude (its added mass and
   * damping from its sections, the Froude-Krylov load from its wetted surface, the diffraction as the solver takes it, its
   * mass, inertia, waterplane and roll stiffness); each section's reflected wave held by those motions (`scatterSection`),
   * giving the far-field drift sum 1/2 rho g |R|^2 over the sections' widths (Maruo); less the mean force the Froude-Krylov
   * pressure over the moving wetted surface gives the hull in those motions (the time average of `wettedLoads`), which
   * the solver already takes.
   */
  private driftOf(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    q: readonly [number, number, number, number],
    local: Vec3,
    memory: HullMemory,
  ): { frequencies: Float64Array; coefficient: Float64Array } {
    const roll = this.rollState(hull, bodies, at, q, local, memory);
    const density = this.sea!.density ?? SEA_WATER,
      g = -this.gravity[1],
      mass = 1 / bodies[at + 16]!,
      { strips, stripForms, pivot, frequencies, waterline } = memory,
      count = frequencies.length,
      coefficient = new Float64Array(count),
      waterplane = strips.reduce((sum, s) => sum + stripForms[s.form]!.breadth * s.width, 0),
      c33 = density * g * waterplane,
      c44 = roll.stiffness,
      still = { density, elevation: () => waterline },
      rest = wettedLoads(hull.mesh, { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, still, 0, local),
      restZ = rest.force[2];
    for (let f = 0; f < count; f++) {
      const omega = frequencies[f]!,
        k = (omega * omega) / g,
        // The hull's coefficients at omega, summed over its sections (one solve a form).
        perForm = stripForms.map((form) => ({
          heave: heaveSection(form.lewis, omega, density, g),
          lateral: lateralSection(form.lewis, omega, density, pivot, g),
          // The wave's load on the section held still (Froude-Krylov and diffraction, exact in two dimensions).
          held: scatterSection(form.lewis, omega, pivot, {}, g, 16, 64, density),
        }));
      let a33 = 0,
        b33 = 0,
        a22 = 0,
        b22 = 0,
        a24 = 0,
        b24 = 0,
        a44 = 0,
        b44 = 0,
        f3: [number, number] = [0, 0],
        f2: [number, number] = [0, 0],
        f4: [number, number] = [0, 0],
        // The diffraction as the solver takes it (the relative motion principle): (-i w a + b) U, U the water's vertical
        // velocity at the mean draft (-i w e^(-k d)) and its velocity across at the centroid (w e^(-k d)).
        d3: [number, number] = [0, 0],
        d2: [number, number] = [0, 0],
        d4: [number, number] = [0, 0];
      for (const strip of strips) {
        const { heave, lateral, held } = perForm[strip.form]!,
          w = strip.width,
          s24 = (lateral.swayOfRoll.addedMass + lateral.rollOfSway.addedMass) / 2,
          t24 = (lateral.swayOfRoll.damping + lateral.rollOfSway.damping) / 2,
          u3: [number, number] = [0, -omega * exp(-k * strip.heaveDepth)],
          u2 = omega * exp(-k * strip.swayDepth);
        d3 = add(d3, times([heave.damping * w, -omega * heave.addedMass * w], u3));
        d2 = add(d2, [lateral.sway.damping * w * u2, -omega * lateral.sway.addedMass * w * u2]);
        d4 = add(d4, [t24 * w * u2, -omega * s24 * w * u2]);
        a33 += heave.addedMass * w;
        b33 += heave.damping * w;
        a22 += lateral.sway.addedMass * w;
        b22 += lateral.sway.damping * w;
        a24 += s24 * w;
        b24 += t24 * w;
        a44 += lateral.roll.addedMass * w;
        b44 += lateral.roll.damping * w;
        // The book's heave is down, the body's y up.
        f3 = add(f3, [-held.heaveForce[0] * w, -held.heaveForce[1] * w]);
        f2 = add(f2, [held.swayForce[0] * w, held.swayForce[1] * w]);
        f4 = add(f4, [held.rollMoment[0] * w, held.rollMoment[1] * w]);
      }
      const small =
          1e-3 *
          Math.max(
            1e-3,
            strips.reduce((m, s) => Math.max(m, s.heaveDepth), 0),
          ),
        wave = (amplitude: number) => ({
          density,
          elevation: (_x: number, z: number, t: number) => waterline + amplitude * cos(k * z - omega * t),
          pressure: (_x: number, y: number, z: number, t: number) => {
            const level = Math.min(y - waterline, 0);
            return density * g * (amplitude * exp(k * level) * cos(k * z - omega * t) - (y - waterline));
          },
        }),
        // The Froude-Krylov load of a small wave over the hull at rest (its complex amplitude from a quarter period apart),
        // with which the solver's own loads move the hull.
        frozen = (t: number) =>
          wettedLoads(hull.mesh, { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, wave(small), t, local),
        [l0, l1] = [frozen(0), frozen(Math.PI / (2 * omega))],
        fk = (index: number, torque: boolean): [number, number] => {
          const base = torque ? rest.torque[index]! : rest.force[index]!,
            at0 = torque ? l0.torque[index]! : l0.force[index]!,
            at1 = torque ? l1.torque[index]! : l1.force[index]!;
          return [(at0 - base) / small, (at1 - base) / small];
        },
        // The motions under loads (f3, f2, f4), e^(-i w t): heave alone, sway and roll together.
        m22: [number, number] = [-omega * omega * (mass + a22), -omega * b22],
        m24: [number, number] = [-omega * omega * a24, -omega * b24],
        m44: [number, number] = [c44 - omega * omega * (roll.own + a44), -omega * b44],
        det = sub(times(m22, m44), times(m24, m24)),
        motions = (g3: [number, number], g2: [number, number], g4: [number, number]) => ({
          x3: divide(g3, [c33 - omega * omega * (mass + a33), -omega * b33]),
          x2: divide(sub(times(g2, m44), times(m24, g4)), det),
          x4: divide(sub(times(m22, g4), times(m24, g2)), det),
        }),
        // The true motions, from the loads of the two-dimensional scattering: they give the far-field drift.
        exact = motions(f3, f2, f4),
        // The motions the solver gives the hull, from its own loads: they give the Froude-Krylov mean it already takes.
        own = motions(add(fk(1, false), d3), add(fk(2, false), d2), add(fk(0, true), d4)),
        velocity = (x: [number, number]): [number, number] => [omega * x[1], -omega * x[0]];
      // Each section's reflected wave held by the hull's motions (the book's heave down, sway along z, roll about x).
      let far = 0;
      const heaveDown = velocity([-exact.x3[0], -exact.x3[1]]),
        sway = velocity(exact.x2),
        turn = velocity(exact.x4),
        { x2, x3, x4 } = own;
      const reflected = stripForms.map(
        (form) =>
          scatterSection(form.lewis, omega, pivot, { heave: heaveDown, sway, roll: turn }, g, 16, 64, density)
            .reflected,
      );

      for (const strip of strips) {
        const r = reflected[strip.form]!;
        far += 0.5 * density * g * (r[0] * r[0] + r[1] * r[1]) * strip.width;
      }
      // The mean the Froude-Krylov pressure gives over the moving wetted surface, by the time average over a period.
      const phases = 16;
      let mean = 0;
      for (let j = 0; j < phases; j++) {
        const t = (2 * Math.PI * j) / (phases * omega),
          c = cos(-omega * t),
          sn = sin(-omega * t),
          part = (x: [number, number]) => small * (x[0] * c - x[1] * sn),
          angle = part(x4),
          r = [sin(angle / 2), 0, 0, cos(angle / 2)] as const,
          moved = rotate(r, local),
          position: Vec3 = [local[0] - moved[0], local[1] - moved[1] + part(x3), local[2] - moved[2] + part(x2)],
          centreNow: Vec3 = [local[0], local[1] + part(x3), local[2] + part(x2)];
        mean += wettedLoads(hull.mesh, { position, rotation: r }, wave(small), t, centreNow).force[2] - restZ;
      }
      coefficient[f] = far - mean / phases / (small * small);
    }
    return { frequencies: Float64Array.from(frequencies), coefficient };
  }

  /** A hull's deck and its mesh without the deck's faces (upward faces above its still waterline), made at its first step. */
  private deckFor(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    dt: number,
  ): { deck: Deck; wet: HullMesh } {
    let found = this.decks.get(hull);
    if (found) return found;
    const q = pose.rotation,
      local = rotate(
        [-q[0], -q[1], -q[2], q[3]],
        [centre[0] - pose.position[0], centre[1] - pose.position[1], centre[2] - pose.position[2]],
      ),
      memory = this.memoryOf(hull, bodies, at, local, dt),
      { vertices: v, indices } = hull.mesh;
    let waterline = memory?.waterline;
    if (waterline === undefined) {
      // A body of no mass: its deck is whatever faces up above its lowest point.
      waterline = Infinity;
      for (let i = 1; i < v.length; i += 3) waterline = Math.min(waterline, v[i]!);
    }
    const [nx, nz] = this.deckCells,
      deck = deckOf(hull.mesh, waterline, nx, nz),
      kept: number[] = [];
    for (let k = 0; k + 2 < indices.length; k += 3) {
      const a = 3 * indices[k]!,
        b = 3 * indices[k + 1]!,
        c = 3 * indices[k + 2]!,
        ux = v[b]! - v[a]!,
        uy = v[b + 1]! - v[a + 1]!,
        uz = v[b + 2]! - v[a + 2]!,
        wx = v[c]! - v[a]!,
        wy = v[c + 1]! - v[a + 1]!,
        wz = v[c + 2]! - v[a + 2]!,
        ny = uz * wx - ux * wz,
        length = hypot(hypot(uy * wz - uz * wy, ny), ux * wy - uy * wx),
        lowest = Math.min(v[a + 1]!, v[b + 1]!, v[c + 1]!);
      if (length > 0 && ny > 0.5 * length && lowest > waterline) continue;
      kept.push(indices[k]!, indices[k + 1]!, indices[k + 2]!);
    }
    found = { deck, wet: { vertices: v, indices: Uint32Array.from(kept) } };
    this.decks.set(hull, found);
    return found;
  }

  /**
   * Moves the water on a hull's deck over the step and adds its weight to `loads` (deck.ts): the frame's gravity in the
   * body's axes (the world's less the body's acceleration over its last step); the sea beyond each deck edge its height
   * over the edge and the water's velocity relative to it; the deck's pressure rho G h on each cell, down the deck, about
   * the centre of mass, unless a liquid solver owns the hull's on-deck load (`deckClaims`). What came aboard goes into the
   * `deckInflow` port, a record an edge face.
   */
  private deckLoad(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
    dt: number,
    context: StepContext,
    loads: WettedLoads,
  ): void {
    const { deck } = this.deckFor(hull, bodies, at, pose, centre, dt),
      [nx, nz] = this.deckCells,
      cells = nx * nz,
      index = this.hulls.indexOf(hull),
      words = 3 * cells + 4,
      memory = this.host!.memory.buffer,
      water = new Float64Array(memory, this.deckWater!.byteOffset + index * words * 8, 3 * cells),
      last = new Float64Array(memory, this.deckWater!.byteOffset + (index * words + 3 * cells) * 8, 4),
      q = pose.rotation,
      conjugate = [-q[0], -q[1], -q[2], q[3]] as const,
      v: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
      spin: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
      // The body's acceleration over its last step, the frame's.
      a: Vec3 = last[0] === 1 ? [(v[0] - last[1]!) / dt, (v[1] - last[2]!) / dt, (v[2] - last[3]!) / dt] : [0, 0, 0],
      g = this.gravity,
      gravity = rotate(conjugate, [g[0] - a[0], g[1] - a[1], g[2] - a[2]]),
      water3 = this.waterOf(),
      flow = this.flow,
      sea = this.sea!,
      outside = (x: number, z: number, b: number): readonly [number, number, number] => {
        const r = rotate(q, [x, b, z]),
          p: Vec3 = [pose.position[0] + r[0], pose.position[1] + r[1], pose.position[2] + r[2]],
          height = sea.elevation(p[0], p[2], t) - p[1];
        if (!(height > 0)) return [0, 0, 0];
        // The water's velocity there (its orbital motion, where the sea gives it) less the deck's, in the body's axes.
        let u: Vec3 = [0, 0, 0];
        if (water3) {
          water3.sample(p[0], p[1], p[2], t, flow);
          u = [flow.velocity[0], flow.velocity[1], flow.velocity[2]];
        }
        const arm: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]],
          deckVelocity: Vec3 = [
            v[0] + spin[1] * arm[2] - spin[2] * arm[1],
            v[1] + spin[2] * arm[0] - spin[0] * arm[2],
            v[2] + spin[0] * arm[1] - spin[1] * arm[0],
          ],
          relative = rotate(conjugate, [u[0] - deckVelocity[0], u[1] - deckVelocity[1], u[2] - deckVelocity[2]]);
        return [height, relative[0], relative[2]];
      },
      came: number[] = [];
    stepDeck(deck, water, gravity, outside, dt, came);
    last.set([1, v[0], v[1], v[2]]);
    // The inflow records: each edge face that took water in, as a segment across the face.
    const records = new Float64Array(memory, this.inflow!.byteOffset, this.inflow!.byteLength / 8),
      room = (records.length - 1) / DECK_INFLOW_WORDS;
    for (let r = 0; r * 8 < came.length && records[0]! < room; r++) {
      const [x, z, nX, nZ, h, u, w, flux] = came.slice(8 * r, 8 * r + 8) as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ],
        // The face runs across its normal, half a cell each way.
        hx = nZ !== 0 ? deck.dx / 2 : 0,
        hz = nX !== 0 ? deck.dz / 2 : 0,
        i = Math.min(nx - 1, Math.max(0, Math.floor((x - nX * 1e-6 - deck.x0) / deck.dx))),
        j = Math.min(nz - 1, Math.max(0, Math.floor((z - nZ * 1e-6 - deck.z0) / deck.dz))),
        b = deck.height[j * nx + i] ?? 0,
        o = 1 + records[0]! * DECK_INFLOW_WORDS;
      records.set([hull.row, x - hx, b, z - hz, x + hx, b, z + hz, nX, 0, nZ, h, u, 0, w, flux, context.tick], o);
      records[0]! += 1;
    }
    // The deck's load, unless a liquid solver owns it.
    const claims = context.inputs.get(DECK_CLAIMS_FIELD.name);
    if (claims) {
      const owned = new Float64Array(
        claims.region.memory?.buffer ?? memory,
        claims.region.byteOffset,
        claims.region.byteLength / 8,
      );
      if (owned[hull.row] === 1) return;
    }
    const G = -gravity[1];
    if (!(G > 0)) return;
    const local = rotate(conjugate, [
        centre[0] - pose.position[0],
        centre[1] - pose.position[1],
        centre[2] - pose.position[2],
      ]),
      density = sea.density ?? SEA_WATER,
      area = deck.dx * deck.dz,
      body = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i,
          h = water[c]!;
        if (!(h > 0)) continue;
        const f = -density * G * h * area,
          rx = deck.x0 + (i + 0.5) * deck.dx - local[0],
          ry = deck.height[c]! - local[1],
          rz = deck.z0 + (j + 0.5) * deck.dz - local[2];
        body[1]! += f;
        // r x (0, f, 0).
        body[3]! += -rz * f;
        body[5]! += rx * f;
        void ry;
      }
    const force = rotate(q, [body[0]!, body[1]!, body[2]!]),
      moment = rotate(q, [body[3]!, body[4]!, body[5]!]);
    for (let k = 0; k < 3; k++) {
      loads.force[k]! += force[k]!;
      loads.torque[k]! += moment[k]!;
    }
  }

  /**
   * Adds the hull's slamming to `loads`: at each station, its keel's depth under the sea's surface over it (h) and that
   * depth's rate over the step (V, the step before kept as state); where the section comes down into the water (V > 0) it
   * takes (dm/dh) V^2 of its width up its own axis (the body's y), at its keel, about the centre of mass.
   */
  private slamLoad(
    hull: Hull,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
    dt: number,
    loads: WettedLoads,
  ): void {
    let stations = this.slams.get(hull);
    if (!stations) {
      stations = slamStations(hull.mesh, this.sea!.density ?? SEA_WATER, this.stations);
      this.slams.set(hull, stations);
    }
    const index = this.hulls.indexOf(hull),
      words = this.stations + 1,
      state = new Float64Array(this.host!.memory.buffer, this.slam!.byteOffset + index * words * 8, words),
      q = pose.rotation,
      conjugate = [-q[0], -q[1], -q[2], q[3]] as const,
      local = rotate(conjugate, [
        centre[0] - pose.position[0],
        centre[1] - pose.position[1],
        centre[2] - pose.position[2],
      ]),
      seen = state[0] === 1,
      body = [0, 0, 0, 0, 0, 0];
    stations.forEach((station, s) => {
      const r = rotate(q, [station.x, station.keel, local[2]]),
        p: Vec3 = [pose.position[0] + r[0], pose.position[1] + r[1], pose.position[2] + r[2]],
        h = this.sea!.elevation(p[0], p[2], t) - p[1],
        rate = seen ? (h - state[1 + s]!) / dt : 0;
      state[1 + s] = h;
      if (!(rate > 0)) return;
      const f = slamSlope(station, h) * rate * rate * station.width;
      body[1]! += f;
      // r x (0, f, 0), r from the centre of mass to the keel point on its centre line: a pitch about z.
      body[5]! += (station.x - local[0]) * f;
    });
    state[0] = 1;
    const force = rotate(q, [body[0]!, body[1]!, body[2]!]),
      moment = rotate(q, [body[3]!, body[4]!, body[5]!]);
    for (let k = 0; k < 3; k++) {
      loads.force[k]! += force[k]!;
      loads.torque[k]! += moment[k]!;
    }
  }

  /**
   * Adds the viscous roll moment to `loads`: -(eddy |p| + linear) p about the body's x axis through its centre of mass, p its
   * roll rate, taken implicitly in the damping alone (backward Euler against the roll inertia with the water carried), so a
   * light hull's eddy damping stays stable at any step: -c p / (1 + dt c / I).
   */
  /**
   * The hull's flooding over the step (flooding.ts): the water, air and cargo moved, the floodwater's weight (less the
   * cargo lost's) added to the load at their centres, the breaches' records written. Returns the point masses (m, x, y, z
   * in world axes) the hull carries for the added-mass solve.
   */
  private floodLoad(
    hull: Hull,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
    dt: number,
    tick: number,
    breaches: Float64Array,
    loads: WettedLoads | undefined,
    damage: Float64Array | undefined,
    seams: Float64Array | undefined,
    shellInput: { rows: Float64Array; offset: Vec3 } | undefined,
    shellPressure?: Float64Array,
  ): number[] {
    const entry = this.floods.get(hull);
    if (!entry || !this.flood) return [];
    const { flooding, at, record } = entry;
    const state = new Float64Array(this.host!.memory.buffer, this.flood.byteOffset + at * 8, flooding.words);
    const openings = hull.openings ?? [];
    const live = shellInput ? new Map<number, ShellAperture>() : undefined;
    if (shellInput && live) {
      for (const [k, opening] of openings.entries()) {
        if (opening.shellSeam === undefined) continue;
        const n = opening.normal;
        const length = hypot(n[0], n[1], n[2]);
        const outward = rotate(pose.rotation, [n[0] / length, n[1] / length, n[2] / length]);
        const aperture = panelAperture(
          shellInput.rows,
          opening.shellSeam,
          shellInput.offset,
          outward,
          FLOOD_OPENING_GRID,
        );
        if (aperture) live.set(k, aperture);
      }
    }
    if (damage || seams) {
      for (let k = 0; k < openings.length; k++) {
        const { crushPatch, girderJoint } = openings[k]!;
        const crushed =
          damage && crushPatch !== undefined && damage[crushPatch * CRUSH_WORDS + CRUSH_SEAL_LOSS_WORD]! >= 1;
        const broken =
          seams && girderJoint !== undefined && seams[girderJoint * GIRDER_SEAM_WORDS + GIRDER_SEAM_BROKEN_WORD] === 1;
        if (crushed || broken) flooding.failOpening(state, k);
      }
    }
    const density = this.sea!.density ?? SEA_WATER,
      g = this.gravity,
      magnitude = hypot(g[0], g[1], g[2]),
      r = flooding.stepWithShellApertures(state, pose, this.sea!, t, dt, density, magnitude, live),
      points: number[] = [],
      add = (m: number, x: number, y: number, z: number) => {
        if (m === 0 || !loads) return;
        const f = [m * g[0], m * g[1], m * g[2]],
          d = [x - centre[0], y - centre[1], z - centre[2]];
        loads.force[0] += f[0]!;
        loads.force[1] += f[1]!;
        loads.force[2] += f[2]!;
        loads.torque[0] += d[1]! * f[2]! - d[2]! * f[1]!;
        loads.torque[1] += d[2]! * f[0]! - d[0]! * f[2]!;
        loads.torque[2] += d[0]! * f[1]! - d[1]! * f[0]!;
        points.push(m, x, y, z);
      };
    for (let i = 0; i < flooding.compartments.length; i++) {
      add(r.mass[i]!, r.centre[i * 3]!, r.centre[i * 3 + 1]!, r.centre[i * 3 + 2]!);
      add(-r.lost[i]!, r.lostCentre[i * 3]!, r.lostCentre[i * 3 + 1]!, r.lostCentre[i * 3 + 2]!);
    }
    // The breaches: one record an opening to the outside, after the count word.
    const q = pose.rotation;
    let n = record;
    for (let k = 0; k < openings.length; k++) {
      const o = openings[k]!;
      if (o.to !== 'outside') continue;
      const aperture = live?.get(k);
      const c = rotate(q, o.centre),
        nl = hypot(o.normal[0], o.normal[1], o.normal[2]),
        normal = aperture?.normal ?? rotate(q, [o.normal[0] / nl, o.normal[1] / nl, o.normal[2] / nl]),
        [x, y, z] = aperture?.centre ?? [c[0] + pose.position[0], c[1] + pose.position[1], c[2] + pose.position[2]],
        openArea =
          o.shellSeam === undefined ? r.open[k]! * o.width * o.height : r.open[k] === 1 ? (aperture?.area ?? 0) : 0,
        cargo = flooding.compartments[o.from]!.cargo,
        w = 1 + n * HULL_BREACH_WORDS;
      if (shellPressure && o.shellSeam !== undefined) {
        const exterior = this.sea!.elevation(x, z, t);
        const interior = r.level[o.from]!;
        const air = r.pressure[o.from]! - ATMOSPHERE;
        const waterWeight = density * magnitude;
        if (![exterior, interior, air, waterWeight].every(Number.isFinite) || waterWeight <= 0)
          throw new MargoError(
            'state',
            'Provide finite water levels, positive density and a finite compartment pressure.',
          );
        shellPressure.set([1, exterior, interior, air, waterWeight], o.shellSeam * SHELL_PRESSURE_WORDS);
      }
      breaches.set(
        [
          hull.row,
          k,
          x,
          y,
          z,
          normal[0],
          normal[1],
          normal[2],
          openArea,
          r.water[k]!,
          r.air[k]!,
          r.air[k]! / AIR_DENSITY,
          r.cargo[k]!,
          cargo ? BREACH_CARGO.indexOf(cargo.material) : 0,
          this.sea!.elevation(x, z, t) - y,
          tick,
        ],
        w,
      );
      n++;
    }
    breaches[0] = Math.max(breaches[0]!, n);
    return points;
  }

  private dampRoll(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
    dt: number,
    courseSpeed: number,
    loads: WettedLoads,
  ): void {
    const q = pose.rotation,
      conjugate = [-q[0], -q[1], -q[2], q[3]] as const,
      local = rotate(conjugate, [
        centre[0] - pose.position[0],
        centre[1] - pose.position[1],
        centre[2] - pose.position[2],
      ]),
      memory = this.memoryOf(hull, bodies, at, local, dt);
    if (!memory) return;
    const roll = this.rollState(hull, bodies, at, q, local, memory);
    const p = rotate(conjugate, [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!])[0];
    let c = roll.eddy * Math.abs(p) + roll.linear;
    const speed = Math.max(0, courseSpeed);
    if (speed > 0 && roll.forward) {
      const { liftPerSpeed, frictionPerSpeed, eddySpeed } = roll.forward;
      const reduced = speed / eddySpeed;
      c =
        (roll.eddy * Math.abs(p)) / (1 + reduced * reduced) +
        roll.linear * (1 + speed * frictionPerSpeed) +
        speed * liftPerSpeed;
    }
    if (roll.keels?.length && p !== 0) {
      const up = rotate(q, [0, 1, 0]);
      const across = rotate(q, [0, 0, 1]);
      const angle = atan2(-across[1], up[1]);
      const sea = this.sea!;
      c += bilgeKeelDamping(roll.keels, p, angle, roll.natural, sea.density ?? SEA_WATER, speed, local, (point) => {
        const r = rotate(q, point);
        const eta = sea.elevation(pose.position[0] + r[0], pose.position[2] + r[2], t);
        return eta - pose.position[1] - r[1];
      });
    }
    const moment = roll.inertia > 0 ? (-c * p) / (1 + (dt * c) / roll.inertia) : -c * p,
      m = rotate(q, [moment, 0, 0]);
    for (let k = 0; k < 3; k++) loads.torque[k]! += m[k]!;
  }

  private rollState(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    q: readonly [number, number, number, number],
    local: Vec3,
    memory: HullMemory,
  ): Roll {
    let roll = this.rolls.get(hull);
    if (!roll) {
      roll = this.rollOf(hull, bodies, at, q, local, memory);
      this.rolls.set(hull, roll);
    }
    return roll;
  }

  /**
   * A hull's roll at its still-water draft: its eddy coefficient, its skin friction at its natural roll frequency (the
   * restoring moment from its wetted surface heeled a little each way at its still waterline, over its roll inertia with
   * its added inertia at infinite frequency), and that inertia.
   */
  private rollOf(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    q: readonly [number, number, number, number],
    local: Vec3,
    memory: HullMemory,
  ): Roll {
    const world = invertSymmetric([
        bodies[at + 17]!,
        bodies[at + 18]!,
        bodies[at + 19]!,
        bodies[at + 20]!,
        bodies[at + 21]!,
        bodies[at + 22]!,
      ]),
      axis = rotate(q, [1, 0, 0]);
    let own = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) own += axis[i]! * world[i * 3 + j]! * axis[j]!;
    const inertia = own + memory.lateralInfinite[3 * 6 + 3]!,
      density = this.sea!.density ?? SEA_WATER,
      still = { density, elevation: () => memory.waterline },
      h = 1e-3,
      heeled = (angle: number) => {
        // Turned about the body's x axis through its centre of mass, which stays put.
        const r = [sin(angle / 2), 0, 0, cos(angle / 2)] as const,
          moved = rotate(r, local);
        return wettedLoads(
          hull.mesh,
          { position: [local[0] - moved[0], local[1] - moved[1], local[2] - moved[2]], rotation: r },
          still,
          0,
          local,
        ).torque[0];
      },
      stiffness = -(heeled(h) - heeled(-h)) / (2 * h),
      natural = stiffness > 0 && inertia > 0 ? Math.sqrt(stiffness / inertia) : 0;
    return {
      eddy: memory.rollEddy,
      linear: memory.rollFriction * Math.sqrt(2 * Math.PI * this.viscosity * natural),
      forward: hull.course ? forwardRollOf(memory, density, natural) : undefined,
      natural,
      keels: hull.bilgeKeels ? rollKeelsOf(hull.bilgeKeels, local, memory, hull.mesh) : undefined,
      inertia,
      own,
      stiffness,
    };
  }

  /**
   * Adds the radiation force to `loads`: the hull's velocity (body frame: linear then angular) goes into its history at this
   * tick, and the force is minus each pair's kernel convolved with the history (trapezoid in time, the oldest lag dropped).
   */
  private radiate(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    tick: number,
    dt: number,
    theta: number,
    speed: number,
    loads: WettedLoads,
  ): void {
    const q = pose.rotation,
      conjugate = [-q[0], -q[1], -q[2], q[3]] as const,
      local = rotate(conjugate, [
        centre[0] - pose.position[0],
        centre[1] - pose.position[1],
        centre[2] - pose.position[2],
      ]),
      memory = !hull.panels || hull.course ? this.memoryOf(hull, bodies, at, local, dt) : null;
    if (!(bodies[at + 16]! > 0)) return;
    const lags = this.lags,
      index = this.hulls.indexOf(hull),
      ring = new Float64Array(this.host!.memory.buffer, this.history!.byteOffset + index * lags * 6 * 8, lags * 6),
      velocity = rotate(conjugate, [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!]),
      spin = rotate(conjugate, [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!]),
      slot = tick % lags;
    const last = new Float64Array(this.host!.memory.buffer, this.radiated!.byteOffset + index * 7 * 8, 7);
    if (hull.panels && loads.area === 0) {
      if (last[0] === 1) ring.fill(0);
      last.fill(0);
      return;
    }
    const force = [0, 0, 0, 0, 0, 0];
    const course = this.course[index];
    const diagonal = memory?.pairs[0];
    let courseSamples = 0;
    let lateralSlope = 0;
    let courseRoll = 0;
    if (course && memory && diagonal) {
      const forward = rotate(q, [1, 0, 0]);
      const up = rotate(q, [0, 1, 0]);
      const horizontal = hypot(forward[0], forward[2]);
      const x = horizontal > 0 ? forward[0] / horizontal : 0;
      const z = horizontal > 0 ? forward[2] / horizontal : 0;
      const horizontalSpeed = bodies[at + 10]! * x + bodies[at + 12]! * z;
      let limit = this.courseLimits.get(hull);
      if (limit === undefined) {
        limit = courseSpeedLimit(memory, diagonal.kernel, this.sea!.density ?? SEA_WATER, -this.gravity[1]);
        this.courseLimits.set(hull, limit);
      }
      if (!(Math.abs(speed) < limit) && speed !== 0)
        throw new MargoError(
          'state',
          `Course speed ${speed} m/s exceeds this hull's ordinary-strip pitch stability range. Use a speed below ${limit} m/s or choose a hull with stronger longitudinal restoring.`,
        );
      // The steady horizontal course has a component along the tilted body's up axis.
      // Remove that component before ordinary radiation, then add the exact vertical speed terms.
      velocity[1] -= horizontalSpeed * (x * up[0] + z * up[2]);
      const words = courseWords(lags);
      const history = new Float64Array(
        this.host!.memory.buffer,
        this.courseHistory!.byteOffset + course.historyIndex * words * 8,
        words,
      );
      [force[1], force[5]] = courseLoad(
        history,
        lags,
        slot,
        velocity[1],
        forward[1] - course.trimSine,
        spin[2],
        speed,
        diagonal.kernel,
        memory.heaveInfinite,
        dt,
      );
      courseSamples = history[0]!;
      if (hull.panels) velocity[0] -= speed;
      if (course.heading) {
        const [refX, refZ] = course.heading;
        const across = rotate(q, [0, 0, 1]);
        // Remove the steady course component from the ordinary sway history, keeping the oscillatory sway.
        velocity[2] -= speed * (refX * across[0] + refZ * across[2]);
        lateralSlope = refX * z - refZ * x;
        courseRoll = atan2(-across[1], up[1]);
      }
    }
    ring.set([...velocity, ...spin], 6 * slot);
    if (course?.heading && memory && speed !== 0) {
      const sway = memory.pairs.find(({ i, j }) => i === 2 && j === 2);
      const cross = memory.pairs.find(({ i, j }) => i === 2 && j === 3);
      if (sway && cross) {
        [force[2], force[3], force[4]] = lateralCourseLoad(
          ring, lags, slot, courseSamples, lateralSlope, courseRoll, speed, sway.kernel, cross.kernel,
          memory.lateralInfinite[14]!, memory.lateralInfinite[15]!, dt,
        );
      }
    }
    let pairs = memory?.pairs ?? [];
    if (hull.panels) {
      let kernels = this.panelMemories.get(hull);
      if (!kernels) {
        kernels = panelDampingKernels(hull.panels, dt, lags);
        this.panelMemories.set(hull, kernels);
      }
      pairs = kernels;
    }
    for (const { i, j, kernel } of pairs) {
      const n = Math.min(lags, kernel.length);
      let ij = 0,
        ji = 0;
      for (let lag = 0; lag < n; lag++) {
        const s = 6 * ((slot - lag + lags) % lags),
          weight = (lag === 0 ? 0.5 : 1) * kernel[lag]!;
        ij += weight * ring[s + j]!;
        ji += weight * ring[s + i]!;
      }
      force[i]! -= ij * dt;
      if (i !== j) force[j]! -= ji * dt;
    }
    // A manoeuvring model's derivatives hold the surge, sway and yaw damping it claims: those rows are its, not the waves'.
    if (this.claim & CLAIM_DAMPING) force[0] = force[2] = force[4] = 0;
    // The convolution ends at the step's start (the last velocity the history holds); the load is taken theta of the step on,
    // so the force is carried there along the line through its last two values. Held from the start, it lagged the load by
    // theta dt, a phase error of w theta dt that moved a driven hull's damped response first order in the step (a heaving
    // and pitching hull 9 percent off at 60 steps a second, 1 percent with the force carried on).
    const now = force.slice();
    if (last[0] === 1) for (let k = 0; k < 6; k++) force[k] = now[k]! + theta * (now[k]! - last[1 + k]!);
    last[0] = 1;
    last.set(now, 1);
    // Into world axes.
    const f = rotate(q, [force[0]!, force[1]!, force[2]!]),
      m = rotate(q, [force[3]!, force[4]!, force[5]!]);
    for (let k = 0; k < 3; k++) {
      loads.force[k]! += f[k]!;
      loads.torque[k]! += m[k]!;
    }
  }

  /**
   * The load to hold so the body moves as the hull and the water it carries: M (M + A)^-1 (F + W + E) - W - E in world axes
   * about the centre of mass, A the added mass of the sections under the waterline the hull floats at now and E every other
   * load on the body (a tow, the wind, a sail, a contact), which the rigid world applies to M alone: (M + A) a = F + W + E.
   * E is what the body's last step shows: its change of velocity times M, less the load held and its weight then.
   */
  private carried(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
    dt: number,
    loads: WettedLoads,
    points: readonly number[] = [],
    wet: Float64Array | null = null,
    received?: Float64Array,
  ): number[] {
    const inverseMass = bodies[at + 16]!,
      f = [...loads.force, ...loads.torque];
    if (!(inverseMass > 0)) return f;
    const mass = 1 / inverseMass,
      q = pose.rotation,
      // The body's frame: rotate a world vector into it by the conjugate.
      toBody = (v: Vec3) => rotate([-q[0], -q[1], -q[2], q[3]], v),
      local = toBody([centre[0] - pose.position[0], centre[1] - pose.position[1], centre[2] - pose.position[2]]),
      // The mean waterline in the body's frame: the surface over the centre of mass (small heel and trim, as linear
      // seakeeping takes it).
      level = this.sea!.elevation(centre[0], centre[2], t),
      waterline = toBody([0, level - pose.position[1], 0])[1],
      density = this.sea!.density ?? SEA_WATER,
      body = this.addedMass && hull.panels && loads.area > 0
        ? Float64Array.from(hull.panels.infiniteMass)
        : this.addedMass && !hull.panels
        ? addedMassInfinite(hullSections(hull.mesh, waterline, this.stations), local, density)
        : new Float64Array(36),
      memory = this.addedMass && (!hull.panels || hull.bilgeKeels?.length)
        ? this.memoryOf(hull, bodies, at, local, dt)
        : null;
    if (hull.panels && hypot(local[0] - hull.panels.centre[0], local[1] - hull.panels.centre[1],
      local[2] - hull.panels.centre[2]) > 1e-4)
      throw new MargoError('state', 'Use the rigid body’s local centre of mass when baking hull panels.');
    // The lateral block (sway, roll, yaw), from the radiation at the still-water draft.
    if (memory && !hull.panels) for (let k = 0; k < 36; k++) body[k]! += memory.lateralInfinite[k]!;
    if (memory && hull.surgeAddedMass && loads.area > 0 && !(this.claim & CLAIM_ADDED_MASS)) {
      let surge = this.surgeMasses.get(hull);
      if (surge === undefined) {
        surge = surgePanelMass(hull.mesh, memory.waterline, density, this.wavesOf()?.stillDepth);
        this.surgeMasses.set(hull, surge);
      }
      body[0]! += surge;
    }
    if (memory && hull.bilgeKeels?.length) {
      const roll = this.rollState(hull, bodies, at, q, local, memory);
      const p = toBody([bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!])[0];
      const up = rotate(q, [0, 1, 0]);
      const across = rotate(q, [0, 0, 1]);
      addBilgeKeelInertia(body, roll.keels!, p, atan2(-across[1], up[1]), roll.natural, density, local, (point) => {
        const r = rotate(q, point);
        return this.sea!.elevation(pose.position[0] + r[0], pose.position[2] + r[2], t) - pose.position[1] - r[1];
      });
    }
    // Surge, sway and yaw added mass a manoeuvring model claims are its: their rows and columns leave the hull's.
    if (this.claim & CLAIM_ADDED_MASS)
      for (const k of [0, 2, 4]) for (let j = 0; j < 6; j++) body[6 * k + j] = body[6 * j + k] = 0;
    let any = points.length > 0;
    for (let k = 0; k < 36; k++) any ||= body[k] !== 0;
    if (!any) return f;
    // Into world axes: A_world = T A T^T, T the rotation on both the linear and the angular block.
    const r = [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])],
      R = (i: number, j: number) => r[j]![i]!,
      T = (i: number, j: number) => (i < 3 === j < 3 ? R(i % 3, j % 3) : 0),
      a = new Float64Array(36);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) {
        let sum = 0;
        for (let k = 0; k < 6; k++) for (let l = 0; l < 6; l++) sum += T(i, k) * body[k * 6 + l]! * T(j, l);
        a[i * 6 + j] = sum;
      }
    // Floodwater (and cargo lost, with a negative mass) moves with the hull as point masses m at r from the centre of mass:
    // momentum m (v + w x r), moment of momentum m r x (v + w x r): [[m I, -m [r]x], [m [r]x, -m [r]x [r]x]].
    for (let k = 0; k + 3 < points.length; k += 4) {
      const m = points[k]!,
        r = [points[k + 1]! - centre[0], points[k + 2]! - centre[1], points[k + 3]! - centre[2]],
        cross = [0, -r[2]!, r[1]!, r[2]!, 0, -r[0]!, -r[1]!, r[0]!, 0];
      for (let i = 0; i < 3; i++) {
        a[i * 6 + i]! += m;
        for (let j = 0; j < 3; j++) {
          a[i * 6 + j + 3]! -= m * cross[i * 3 + j]!;
          a[(i + 3) * 6 + j]! += m * cross[i * 3 + j]!;
          let sq = 0;
          for (let l = 0; l < 3; l++) sq += cross[i * 3 + l]! * cross[l * 3 + j]!;
          a[(i + 3) * 6 + j + 3]! -= m * sq;
        }
      }
    }
    // M: the mass on the linear block, the world inertia (the inverse of the port's inverse inertia) on the angular.
    const ii = [
        bodies[at + 17]!,
        bodies[at + 18]!,
        bodies[at + 19]!,
        bodies[at + 20]!,
        bodies[at + 21]!,
        bodies[at + 22]!,
      ],
      inertia = invertSymmetric(ii),
      m = new Float64Array(36);
    for (let k = 0; k < 3; k++) m[k * 6 + k] = mass;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[(i + 3) * 6 + j + 3] = inertia[i * 3 + j]!;
    const g = this.gravity,
      weight = [mass * g[0], mass * g[1], mass * g[2], 0, 0, 0],
      system = new Float64Array(36),
      rhs = new Float64Array(6);
    for (let k = 0; k < 36; k++) system[k] = m[k]! + a[k]!;
    if (wet && inertia[0]! > 0 && inertia[4]! > 0 && inertia[8]! > 0) writeWetMobility(wet, hull.row, m, system);
    // Every other load, from the last step: M (v - v_last) / dt - held_last - W.
    const index = this.hulls.indexOf(hull),
      last = new Float64Array(this.host!.memory.buffer, this.carry!.byteOffset + index * CARRY_WORDS * 8, CARRY_WORDS),
      velocity = [
        bodies[at + 10]!,
        bodies[at + 11]!,
        bodies[at + 12]!,
        bodies[at + 13]!,
        bodies[at + 14]!,
        bodies[at + 15]!,
      ],
      other = [0, 0, 0, 0, 0, 0];
    const seen = [0, 0, 0, 0, 0, 0];
    if (last[0] >= 1)
      for (let i = 0; i < 6; i++) {
        let sum = 0;
        for (let j = 0; j < 6; j++) sum += (m[i * 6 + j]! * (velocity[j]! - last[1 + j]!)) / dt;
        const accounted = received ? received[hull.row * WET_IMPULSE_WORDS + i]! / dt : 0;
        seen[i] = sum - last[7 + i]! - weight[i]! - accounted;
        // Carried on to this step's middle from the last two steps' (a straight line), or held where there is one.
        other[i] = last[0] >= 2 ? 2 * seen[i]! - last[13 + i]! : seen[i]!;
      }
    for (let k = 0; k < 6; k++) rhs[k] = f[k]! + weight[k]! + other[k]!;
    const acceleration = solve6(system, rhs),
      held: number[] = [];
    for (let i = 0; i < 6; i++) {
      let sum = 0;
      for (let j = 0; j < 6; j++) sum += m[i * 6 + j]! * acceleration[j]!;
      held.push(sum - weight[i]! - other[i]!);
    }
    if (last[0] >= 1) for (let k = 0; k < 6; k++) last[13 + k] = seen[k]!;
    last[0] = last[0] >= 1 ? 2 : 1;
    for (let k = 0; k < 6; k++) {
      last[1 + k] = velocity[k]!;
      last[7 + k] = held[k]!;
    }
    return held;
  }

  exportPorts(tick: number): readonly Port[] {
    if (!this.forces)
      throw new MargoError('state', 'HullSolver is not in a world yet; add it with world.add(solver, {hulls, sea}).');
    return [
      { field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: [0, 0, 0] },
      { field: DECK_INFLOW_FIELD.name, region: this.inflow!, tick, cell: [0, 0, 0] },
      { field: HULL_BREACHES_FIELD.name, region: this.breaches!, tick, cell: [0, 0, 0] },
      ...(this.wakeSources
        ? [{ field: this.wakeSourceField.name, region: this.wakeSources, tick, cell: [0, 0, 0] as const }]
        : []),
      ...(this.submergedWakeSources && this.submergedWakeSource
        ? [
            {
              field: this.submergedWakeSource.field.name,
              region: this.submergedWakeSources,
              tick,
              cell: [0, 0, 0] as const,
            },
          ]
        : []),
      ...(this.submergedWakeSources && this.pointWakeSource && this.host
        ? [{ field: this.pointWakeSource.name, region: this.submergedWakeSources, tick, cell: this.host.cell }]
        : []),
      ...(this.wetMobility && this.wetChannel
        ? [{ field: this.wetChannel.mobility.name, region: this.wetMobility, tick, cell: [0, 0, 0] as const }]
        : []),
      ...(this.shellPressure && this.shellPressureField
        ? [{ field: this.shellPressureField.name, region: this.shellPressure, tick, cell: [0, 0, 0] as const }]
        : []),
    ];
  }

  importPorts(_tick: number): void {}

  /** The hulls' motion histories, which their radiation remembers. */
  stateRegions(): readonly Region[] {
    return [
      this.history,
      this.courseHistory,
      this.wakeSources,
      this.submergedWakeSources,
      this.radiated,
      this.waves,
      this.carry,
      this.deckWater,
      this.slam,
      this.flood,
      this.wetMobility,
      this.shellPressure,
    ].filter((r): r is Region => r !== null);
  }

  extraState(): readonly Region[] {
    return [];
  }
}

function rotate(q: readonly [number, number, number, number], v: Vec3): [number, number, number] {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The inverse of a symmetric 3 by 3 matrix given as xx, xy, xz, yy, yz, zz, row-major 3 by 3 (zeros where it is singular). */
function invertSymmetric(e: readonly number[]): Float64Array {
  const [a, b, c, d, f, g] = e as [number, number, number, number, number, number],
    // [[a b c] [b d f] [c f g]]
    A = d * g - f * f,
    B = c * f - b * g,
    C = b * f - c * d,
    det = a * A + b * B + c * C,
    out = new Float64Array(9);
  if (!(det !== 0 && Number.isFinite(det))) return out;
  const k = 1 / det;
  out.set([
    A * k,
    B * k,
    C * k,
    B * k,
    (a * g - c * c) * k,
    (b * c - a * f) * k,
    C * k,
    (b * c - a * f) * k,
    (a * d - b * b) * k,
  ]);
  return out;
}

/** Solves the 6 by 6 system (row-major) by Gaussian elimination with partial pivoting, in a fixed order. */
function solve6(matrix: Float64Array, rhs: Float64Array): Float64Array {
  const a = matrix.slice(),
    b = rhs.slice(),
    n = 6;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(a[row * n + col]!) > Math.abs(a[pivot * n + col]!)) pivot = row;
    if (a[pivot * n + col] === 0) continue;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) [a[col * n + k], a[pivot * n + k]] = [a[pivot * n + k]!, a[col * n + k]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    for (let row = col + 1; row < n; row++) {
      const f = a[row * n + col]! / a[col * n + col]!;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k]! -= f * a[col * n + k]!;
      b[row]! -= f * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row]!;
    for (let k = row + 1; k < n; k++) sum -= a[row * n + k]! * x[k]!;
    x[row] = a[row * n + row]! !== 0 ? sum / a[row * n + row]! : 0;
  }
  return x;
}

/** Publishes world twist mobility and its mapping to the dry kernel's impulse. */
function writeWetMobility(out: Float64Array, row: number, dry: Float64Array, system: Float64Array): void {
  const at = row * WET_INERTIA_WORDS;
  const basis = new Float64Array(6);
  for (let column = 0; column < 6; column++) {
    basis[column] = 1;
    const columnMobility = solve6(system, basis);
    basis[column] = 0;
    if (!(columnMobility[column]! > 0 && columnMobility.every(Number.isFinite)))
      throw new MargoError('failed', 'Use a hull with finite positive effective rigid and water inertia.');
    for (let i = 0; i < 6; i++) {
      let mapped = 0;
      for (let j = 0; j < 6; j++) mapped += dry[i * 6 + j]! * columnMobility[j]!;
      out[at + 1 + i * 6 + column] = columnMobility[i]!;
      out[at + 37 + i * 6 + column] = mapped;
    }
  }
  out[at] = 1;
}

/** The rotation `q` turned by the angular velocity `w` (world axes) for `h` seconds: q + (h / 2) [w, 0] q, made a unit. */
function turn(
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

/** Complex numbers as [re, im]. */
function add(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}
function sub(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}
function times(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
function divide(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  const m = b[0] * b[0] + b[1] * b[1];
  return m > 0 ? [(a[0] * b[0] + a[1] * b[1]) / m, (a[1] * b[0] - a[0] * b[1]) / m] : [0, 0];
}

/** `values` at `x`, linear between `at`'s samples (rising), held at the ends. */
function interpolate(at: Float64Array, values: Float64Array, x: number): number {
  const n = at.length;
  if (n === 0) return 0;
  if (x <= at[0]!) return values[0]!;
  if (x >= at[n - 1]!) return values[n - 1]!;
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - at[lo]!) / (at[hi]! - at[lo]!);
  return values[lo]! + t * (values[hi]! - values[lo]!);
}
