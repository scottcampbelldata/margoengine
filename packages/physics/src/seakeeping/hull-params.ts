// The description of a hull and the settings of the hull solver: the types a world passes to `HullSolver`. Split from
// solver.ts along this seam; solver.ts re-exports every name.
import type { SeaSurface } from '@margoengine/math/fields';
import type { FieldDescriptor, RateLevel } from '../world/solver.js';
import type { HullBilgeKeel } from './bilge-keel.js';
import type { HullCourse } from './course.js';
import type { Deck } from './deck.js';
import type { FloodVolumeKernel } from './flood-volume-kernel.js';
import type { Compartment, Opening } from './flooding.js';
import type { HullPanelResponse } from './panels.js';
import type { HullSlammingTable } from './slamming-table.js';
import type { WakeAdvancePoints } from './wake-advance-points.js';
import type { WakeWaterplane } from './wake-waterplane.js';
import type { HullMesh, SeaQuery, Vec3 } from './wetted.js';

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
  /** Optional native Wagner tables made for this exact body-local mesh, liquid density and station count. */
  readonly slammingTable?: HullSlammingTable;
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

/** A hull's most recently accepted green-water surface in the body frame, x fastest. */
export interface HullDeckSurface extends Deck {
  /** The water column above each cell's deck height in metres. */
  readonly depth: Float64Array;
}

/** Accepted contents of a configured flood compartment. */
export interface HullFloodedCompartment {
  /** Floodwater volume, in m³. */
  readonly waterVolume: number;
  /** Trapped air mass, in kg. */
  readonly airMass: number;
  /** Remaining cargo mass, in kg. */
  readonly cargoMass: number;
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
  /** Optional caller-owned Wasm volume kernel. Keep it open until the world has finished using it. */
  readonly floodVolumeKernel?: FloodVolumeKernel;
  /** The solver's rate level, 60 * 2^level steps a second (default 0); step with the rigid solver. */
  readonly level?: RateLevel;
  /** Side length of an origin cell, m (default 4096). Match PhysicsWorld.cellSize for a separate rigid origin. */
  readonly originCellSize?: number;
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
