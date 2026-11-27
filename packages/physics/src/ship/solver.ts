// Ships under way as a solver of the physics framework (SEA-09): each step it reads where each ship's body is from the rigid
// solver's `bodies` port and holds it through `bodyForces` with the MMG standard method's surge, sway and yaw (mmg.ts): the
// hull's manoeuvring forces, its propeller's thrust and its rudder in the race, with the added masses and their coupling, so
// the rigid body turns, drifts and stops as the method's ship does. Couple it before the rigid solver:
// `world.couple(['ship', 'rigid'], 'staggered')`; with a `HullSolver` floating the hulls, before both.
//
// Around that it gives:
// - squat: the water drawn down along a hull at speed in shallow water (squat.ts), as a sea (`sea(base)`) whose surface is
//   lowered by the ship's sinkage and trim over its length, for the HullSolver to float the hull on, so the hull sinks and
//   trims by its own hydrostatics and the drawdown shows;
// - the propellers' races as the water's flow (`water`, a FlowField; propeller.ts), for foam, bubbles, the bed and divers;
// - a bow thruster's push, its ideal thrust (4 rho A)^(1/3) P^(2/3) times (C / 2)^(2/3) for its measured static merit
//   coefficient C, its force and moment falling and rising again with way on as Chislett's captive tests show (Beveridge 1971);
// - suction toward a quay or bank alongside, from the return flow squeezed through the gap (a one-dimensional continuity
//   estimate, uncalibrated: docs/limits.md);
// - the hull's pressure on the surface as wake sources (`sources(t)`) for a `WakeSolver`, so it makes a bow wave and a Kelvin
//   wake, and the races' boil where they reach the surface (`wash(t)`) for a `FoamSolver`'s ships.
//
// State: each ship's rudder angle. Its controls (revolutions, rudder order, thruster) are inputs, set with `control()`.
import type { FlowField, FlowSample, SeaSource, SeaSurface } from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { atan2, cos, exp, hypot, pow, sin } from '@margoengine/math/pinned';
import type { SeaQuery } from '../seakeeping/wetted.js';
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
import { CLAIM_ADDED_MASS, CLAIM_DAMPING, MANOEUVRING_CLAIMS_FIELD } from '../world/manoeuvring.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { type HeadingGains, headingGains, type ShipTrack, steerTrack, type TrackState, wrap } from './autopilot.js';
import { Manoeuvring, type ManoeuvringForces, type ManoeuvringModel } from './mmg.js';
import { type HoltropHull, holtropMennen } from './resistance.js';
import { type BankLoads, bankLoads } from './bank.js';
import { iceResistance } from './ice.js';
import type { IrregularWaves, RegularWaves } from './waves.js';
import { shallowWater } from './shallow.js';
import { raceVelocity, thrusterThrust } from './propeller.js';
import {
  cavityRadius,
  inceptionIndex,
  type ResolvedRace,
  raceNumbers,
  resolvedRace,
  TIP_VORTEX_GONE,
  VAPOUR_PRESSURE,
  VortexCavity,
} from './race.js';
import { squat } from './squat.js';
import { shipError } from './errors.js';

type Vec3 = [number, number, number];
const SHIP_LAYOUT = 1;
/**
 * f64 words of a ship's autopilot state: the integral, the track's leg, the reference heading and rate, a started flag and
 * the drift angle low-passed.
 */
const PILOT_WORDS = 6;
const THRUSTER_JET_WORDS = 8;
/**
 * A tunnel thruster's static merit coefficient C = T^(3/2) / (P sqrt(rho A)), whose ideal for a straight duct is 2 (Beveridge,
 * "Design and performance of bow thrusters", NSRDC report 3611, 1971, pages 5 to 11, read): measured on models 0.55 to 0.87
 * for stock and installed units and up to 1.5 for the best (his Table 1); 0.82 is his 800-hp LST unit's. The thrust over the
 * momentum bound `thrusterThrust` is then (C / 2)^(2/3).
 */
export const THRUSTER_MERIT_COEFFICIENT = 0.82;
/** The thrust over the momentum bound of a thruster of merit coefficient 0.82: (0.82 / 2)^(2/3). */
export const THRUSTER_MERIT = pow(THRUSTER_MERIT_COEFFICIENT / 2, 2 / 3);
/**
 * A bow thruster's body force and moment at ahead speed over their static values, against the ship's speed over the jet's,
 * U / U_j: Chislett's captive tanker model as Beveridge (1971) reproduces it (his Figure 2b, read from the figure to about
 * 0.02). The force falls to 0.30 near U / U_j 0.6 and the moment to 0.55 near 0.4, both rising after; held past 1.6.
 */
export const THRUSTER_AHEAD: readonly (readonly [number, number, number])[] = [
  [0, 1, 1],
  [0.1, 1.03, 1.04],
  [0.15, 1, 1],
  [0.2, 0.75, 0.8],
  [0.3, 0.48, 0.6],
  [0.4, 0.37, 0.55],
  [0.5, 0.32, 0.57],
  [0.6, 0.3, 0.62],
  [0.8, 0.33, 0.75],
  [1, 0.38, 0.86],
  [1.2, 0.43, 0.95],
  [1.4, 0.48, 1.02],
  [1.6, 0.53, 1.07],
];

/** The thruster's force and moment ratios at U / U_j = `m`, by straight lines between `THRUSTER_AHEAD`'s points. */
export function thrusterAhead(m: number): [number, number] {
  const table = THRUSTER_AHEAD,
    x = Math.max(0, Math.min(table[table.length - 1]![0], m));
  let i = 1;
  while (i < table.length - 1 && table[i]![0] < x) i++;
  const [x0, f0, n0] = table[i - 1]!,
    [x1, f1, n1] = table[i]!,
    s = (x - x0) / (x1 - x0);
  return [f0 + s * (f1 - f0), n0 + s * (n1 - n0)];
}

/** A ship: the body row it is the hull of, its MMG model and where its frame lies on the body. */
export interface Ship {
  readonly row: number;
  readonly model: ManoeuvringModel;
  /** The midship on the waterline, in the body's frame, m (default the body's origin). */
  readonly midship?: readonly [number, number, number];
  /** The body's forward and up axes, unit vectors in its frame (default +X and +Y). */
  readonly forward?: readonly [number, number, number];
  readonly up?: readonly [number, number, number];
  /** A bow thruster: its tunnel's diameter, m, its power, W, and its place forward of the midship, m (default 0.42 L). */
  readonly thruster?: {
    readonly diameter: number;
    readonly power: number;
    readonly position?: number;
    /** Its static merit coefficient C (default 0.82; Beveridge's measured 0.55 to 1.5, ideal 2). */
    readonly merit?: number;
  };
  /**
   * The propeller shaft's depth below the waterline at rest, m (default the draught less 0.6 diameters: a tip 0.1 diameter
   * above the keel, an assumption, not a published figure; give the ship's own).
   */
  readonly shaftDepth?: number;
  /** Symmetric tunnel outlets in metres for the water field: `halfSpan` from centreline, `depth` below the design waterline. */
  readonly thrusterOutlet?: { readonly halfSpan: number; readonly depth: number };
  /** Its block coefficient, for its squat (default the model's volume over L B T). */
  readonly block?: number;
  /**
   * Hold the added masses and their coupling (default true). The ship claims its hull's surge, sway and yaw damping always,
   * and their added mass with this (`manoeuvringClaims`), so a HullSolver on the same body leaves its own of those out;
   * false leaves the added mass to the HullSolver's strips.
   */
  readonly addedMass?: boolean;
  /** The propeller's blades (default 4) and the water's gas saturation, 0 to 1, for its cavities' hysteresis (default 1). */
  readonly blades?: number;
  readonly gas?: number;
  /** How fast the rudder turns, rad/s (default 2.32 degrees a second, the IMO's 35 to 30 degrees on the other side in 28 s). */
  readonly rudderRate?: number;
  /**
   * The hull's form for Holtrop and Mennen's resistance (`holtropMennen`): given, the straight run's resistance at each speed
   * is theirs, rising with the waves the hull makes, in place of the model's constant R'_0.
   */
  readonly hull?: HoltropHull;
  /**
   * The autopilot's tuning: its closed loop's natural frequency in units of U / L (default 0.5) and damping ratio (default
   * 0.8). Higher answers faster and works the rudder harder.
   */
  readonly autopilot?: { readonly bandwidth?: number; readonly damping?: number };
  /**
   * For a model with heel: what holds the ship upright. 'model' (default) gives the body the model's restoring moment g m GM
   * sin(phi) and roll damping with its own roll moments; 'hull' leaves the restoring and damping to a HullSolver floating
   * the body, whose pressures give them.
   */
  readonly roll?: 'model' | 'hull';
  /** Its ice-going form for level ice (`ice`): stem angle, rad, and the lengths of its bow and parallel midbody, m. */
  readonly iceHull?: { readonly stem: number; readonly bow: number; readonly parallel: number };
  /** Its hull as waves see it: pitch gyration over L (default 0.25), and its waterline's entrance and run, m (`WaveHull`). */
  readonly waveHull?: { readonly pitchGyration?: number; readonly entrance?: number; readonly run?: number };
}

/** A quay or a bank, as a vertical wall along the segment from `from` to `to`, [x, z] m. */
export interface ShipWall {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

/** What a {@link ShipSolver} is made from. */
export interface ShipParams {
  readonly ships: readonly Ship[];
  /** The water's depth under the ships, m, a number or a function of (x, z) (default deep: no squat). */
  readonly depth?: number | ((x: number, z: number) => number);
  /** Quays and banks the ships feel (default none). */
  readonly walls?: readonly ShipWall[];
  /** The water's density, kg/m^3 (default 1025). */
  readonly density?: number;
  /**
   * Level ice over the water: its thickness, m, a number or a function of (x, z) (0 open water), which each ship whose
   * `iceHull` is given breaks with Riska et al.'s (1997) resistance (`iceResistance`) (default none).
   */
  readonly ice?: { readonly thickness: number | ((x: number, z: number) => number) };
  /**
   * The waves the ships meet, regular `{amplitude, period, direction}` or irregular `{significantHeight, period, direction,
   * spread}` (direction the way they travel, rad on the ground plane): their mean drift loads (`driftLoads`,
   * `irregularDriftLoads`) join each ship's MMG forces (default none). The wave-frequency motions are a HullSolver's.
   */
  readonly waves?: RegularWaves | IrregularWaves;
  /**
   * Body rows its `bodyForces` port covers: the world's (`PhysicsWorld.bodyRows`, the rigid world's capacity), which it reads;
   * given, it must be the same.
   */
  readonly capacity?: number;
  /** Its rate level (default 0); step with the rigid solver. */
  readonly level?: RateLevel;
}

/**
 * A ship's controls: propeller revolutions, rev/s (negative astern), rudder order, rad (positive to starboard), thruster -1 to
 * 1 (positive pushes the bow to starboard). With a `heading` (rad on the ground plane, from +X toward +Z, the way the ship
 * turns to starboard) or a `track`, the autopilot orders the rudder instead of `rudder`.
 */
export interface ShipControl {
  revolutions: number;
  rudder: number;
  thruster: number;
  heading: number | null;
  track: ShipTrack | null;
}

/** What a ship is doing, from the last step. */
export interface ShipStatus {
  /** Speed through the water, m/s, surge and sway at the midship, m/s, and yaw rate, rad/s (to starboard). */
  speed: number;
  u: number;
  v: number;
  r: number;
  /** Rudder angle, rad. */
  rudder: number;
  /** Heel, rad (starboard down positive), and roll rate, rad/s, of the body. */
  heel: number;
  rollRate: number;
  /** The MMG forces of the step. */
  forces: ManoeuvringForces;
  /** Sinkage at the midship, m, and trim by the stern, rad, from its squat. */
  sinkage: number;
  trim: number;
  /**
   * The thruster's push, N, and the banks' sway force, N (positive to starboard; toward a bank at usual depths, away from
   * it in very shallow water), their yaw moment, N m (positive turning the bow to starboard), and whether the hull is in the
   * bank regression's range.
   */
  thruster: number;
  suction: number;
  /** Level ice's resistance on it, N (0 in open water). */
  ice: number;
  bankMoment: number;
  bankInRange: boolean;
  /** The midship on the waterline, forward and starboard unit vectors on the ground plane. */
  midship: Vec3;
  forward: Vec3;
  starboard: Vec3;
  /** The propeller's race. */
  race: ResolvedRace | undefined;
  /** The tip vortices' cavitation: whether a cavity stands, its radius, m, the tip's cavitation number and the inception index. */
  cavity: { cavitating: boolean; radius: number; sigma: number; inception: number };
  /** Its heading on the ground plane, rad (from +X toward +Z), and the heading the autopilot holds (null when off). */
  heading: number;
  headingOrdered: number | null;
  /** On a track: the leg it is on (from waypoint `leg`), its cross-track error, m (positive to starboard of the leg), and whether it passed the last waypoint. */
  track: TrackState | null;
}

interface Runtime {
  /** The model the ship runs on now: its own, or corrected for the depth under it (`shallowWater`), and T/h it was made at. */
  model: ManoeuvringModel;
  shallowKey: number;
  /** The autopilot's gains and the speed they were placed at. */
  gains: HeadingGains | null;
  gainSpeed: number;
  readonly cavity: VortexCavity;
  readonly ship: Ship;
  readonly mmg: Manoeuvring;
  readonly control: ShipControl;
  readonly status: ShipStatus;
}

/** Ships under way: MMG manoeuvring on rigid bodies, their races, squat, thrusters and quay suction. `id` is `'ship'` by default. */
export class ShipSolver implements Solver<ShipParams> {
  private readonly id: string;
  private host!: SolverHost;
  private level: RateLevel = 0;
  private capacity = 0;
  private density = 1025;
  private g = 9.81;
  /** The world's up, against its gravity (+Y with none). */
  private vertical: Vec3 = [0, 1, 0];
  private depth: ShipParams['depth'];
  private ice: ShipParams['ice'];
  private walls: readonly ShipWall[] = [];
  private runtime: Runtime[] = [];
  private rudders!: Region;
  private forces!: Region;
  private claims!: Region;
  private thrusterJets?: Region;
  private cell: [number, number, number] = [0, 0, 0];
  private readonly flowSample: Vec3 = [0, 0, 0];
  /** The water moved by propeller races and configured bow-thruster outlets, as a flow field. */
  readonly water: FlowField;

  constructor(id = 'ship') {
    this.id = id;
    const solver = this;
    this.water = {
      medium: 'water',
      get cell() {
        return solver.cell;
      },
      sample: (x, y, z, _t, out?: FlowSample) => solver.flow(x, y, z, out),
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
        { field: MANOEUVRING_CLAIMS_FIELD, access: 'write' },
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  init(host: SolverHost, params: ShipParams): void {
    const { ships, depth, walls = [], density = 1025, level = 0 } = params ?? ({} as ShipParams);
    if (!Array.isArray(ships) || ships.length === 0)
      throw shipError('Ships under way need their bodies: pass {ships: [{row, model}]}, a model such as KVLCC2_L7.');
    if (!(density > 0 && Number.isFinite(density)))
      throw shipError(`Water's density is finite kg/m^3 above 0 (got ${density}); pass one, or 1025.`);
    if (depth !== undefined && typeof depth !== 'function' && !(depth > 0))
      throw shipError(
        `The water's depth is metres above 0 or a function of (x, z) (got ${depth}); pass one, or none for deep water.`,
      );
    for (const wall of walls)
      if (!(wall?.from?.length === 2 && wall.to?.length === 2 && [...wall.from, ...wall.to].every(Number.isFinite)))
        throw shipError('A wall is {from: [x, z], to: [x, z]} in metres; pass its two ends.');
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw shipError(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    this.host = host;
    this.level = level as RateLevel;
    this.density = density;
    this.g = gravityMagnitude(host.gravity ?? DEFAULT_GRAVITY);
    const gv = host.gravity ?? DEFAULT_GRAVITY,
      gl = hypot(gv[0], gv[1], gv[2]);
    this.vertical = gl > 0 ? [-gv[0] / gl, -gv[1] / gl, -gv[2] / gl] : [0, 1, 0];
    this.depth = depth;
    this.walls = walls;
    const ice = params.ice;
    if (
      ice !== undefined &&
      !(typeof ice?.thickness === 'function' || (ice?.thickness >= 0 && Number.isFinite(ice.thickness)))
    )
      throw shipError(
        `Level ice is {thickness}: metres, 0 or more, or a function of (x, z) (got ${String(ice?.thickness)}); pass one.`,
      );
    this.ice = ice;
    let top = -1;
    this.runtime = ships.map((ship) => {
      if (!(Number.isInteger(ship?.row) && ship.row >= 0))
        throw shipError(`A ship's body row is a whole number, 0 or more (got ${ship?.row}); pass the body's row.`);
      top = Math.max(top, ship.row);
      if (ship.iceHull)
        iceResistance(
          { length: ship.model?.length, beam: ship.model?.beam, draught: ship.model?.draught, ...ship.iceHull },
          0,
          0,
        );
      if (ship.roll !== undefined && ship.roll !== 'model' && ship.roll !== 'hull')
        throw shipError(`A ship's roll is held by 'model' or 'hull' (got ${String(ship.roll)}); pass one.`);
      if (ship.model?.heel && ship.roll !== 'hull' && !(this.g > 0))
        throw shipError(
          "A ship that heels is held upright by its weight over its metacentric height, and this world has no gravity; give the PhysicsWorld its gravity (the rigid bodies' own physics may still have none), or roll: 'hull' with a HullSolver.",
        );
      if (
        ship.thruster &&
        !(
          ship.thruster.diameter > 0 &&
          ship.thruster.power >= 0 &&
          [ship.thruster.diameter, ship.thruster.power, ship.thruster.position ?? 0].every(Number.isFinite)
        )
      )
        throw shipError('A thruster is {diameter in m above 0, power in W, position}; pass them.');
      if (ship.thruster?.merit !== undefined && !(ship.thruster.merit > 0 && ship.thruster.merit <= 2))
        throw shipError(
          `A thruster's static merit coefficient lies in (0, 2], 2 the ideal straight duct (got ${ship.thruster.merit}); pass one, or leave it for 0.82.`,
        );
      if (ship.shaftDepth !== undefined && !(ship.shaftDepth > 0 && Number.isFinite(ship.shaftDepth)))
        throw shipError(
          `A shaft's depth is finite metres below the waterline above 0 (got ${ship.shaftDepth}); pass one.`,
        );
      const outlet = ship.thrusterOutlet;
      if (
        outlet &&
        !(
          ship.thruster &&
          outlet.halfSpan > 0 &&
          outlet.depth >= ship.thruster.diameter / 2 &&
          Number.isFinite(outlet.halfSpan) &&
          Number.isFinite(outlet.depth)
        )
      )
        throw shipError(
          'A bow thruster outlet needs a tunnel, positive half-span and full submergence; pass finite dimensions in metres and depth at least half the diameter.',
        );
      if (ship.rudderRate !== undefined && !(ship.rudderRate > 0 && Number.isFinite(ship.rudderRate)))
        throw shipError(`A rudder's rate is finite rad/s above 0 (got ${ship.rudderRate}); pass one.`);
      const hull = ship.hull,
        mmg = new Manoeuvring(
          ship.model,
          {},
          {
            density,
            gravity: this.g > 0 ? this.g : 9.80665,
            rudderRate: ship.rudderRate ?? (65 / 28) * (Math.PI / 180),
            ...(params.waves ? { waves: params.waves, waveHull: ship.waveHull ?? {} } : {}),
            ...(hull
              ? { resistance: (speed: number) => (speed > 0 ? holtropMennen(hull, speed, { density }).total : 0) }
              : {}),
          },
        );
      const pilot = ship.autopilot ?? {};
      if (
        !(
          (pilot.bandwidth ?? 1) > 0 &&
          Number.isFinite(pilot.bandwidth ?? 1) &&
          (pilot.damping ?? 0.8) > 0 &&
          Number.isFinite(pilot.damping ?? 0.8)
        )
      )
        throw shipError(
          `An autopilot's bandwidth (in U / L) and damping ratio are finite and above 0 (got ${pilot.bandwidth}, ${pilot.damping}); pass them, or leave them for 0.5 and 0.8.`,
        );
      return {
        model: ship.model,
        shallowKey: 0,
        gains: null,
        gainSpeed: 0,
        cavity: new VortexCavity(ship.gas ?? 1),
        ship,
        mmg,
        control: { revolutions: 0, rudder: 0, thruster: 0, heading: null, track: null },
        status: {
          speed: 0,
          u: 0,
          v: 0,
          r: 0,
          rudder: 0,
          heel: 0,
          rollRate: 0,
          forces: mmg.forces(mmg.state),
          sinkage: 0,
          trim: 0,
          thruster: 0,
          suction: 0,
          ice: 0,
          bankMoment: 0,
          bankInRange: true,
          midship: [0, 0, 0],
          forward: [1, 0, 0],
          starboard: [0, 0, 1],
          race: undefined,
          cavity: { cavitating: false, radius: 0, sigma: Number.POSITIVE_INFINITY, inception: 0 },
          heading: 0,
          headingOrdered: null,
          track: null,
        },
      };
    });
    this.capacity = bodyRowsOf(
      host,
      'A ShipSolver',
      ships.map((s) => s.row),
      params.capacity,
    );
    this.rudders = host.allocate('rudders', ships.length * 8, 'f64', SHIP_LAYOUT);
    // Per ship: the autopilot's integral of its heading error, rad s, the track's leg, and its reference heading and turn
    // rate, with a flag that the reference has started.
    this.pilots = host.allocate('pilots', ships.length * PILOT_WORDS * 8, 'f64', SHIP_LAYOUT);
    this.forces = host.allocate('forces', this.capacity * FORCE_WORDS * 8, 'f64', SHIP_LAYOUT);
    // What each ship's model owns of its hull, for a HullSolver on the same body.
    this.claims = host.allocate('claims', this.capacity * 8, 'f64', SHIP_LAYOUT);
    this.thrusterJets = ships.some((ship) => ship.thrusterOutlet)
      ? host.allocate('thruster-jets', ships.length * THRUSTER_JET_WORDS * 8, 'f64', SHIP_LAYOUT)
      : undefined;
    const claims = regionWords(host.memory, this.claims) as Float64Array;
    for (const s of ships) claims[s.row] = CLAIM_DAMPING + (s.addedMass === false ? 0 : CLAIM_ADDED_MASS);
  }

  private pilots!: Region;

  /**
   * The autopilot's rudder order for ship `rt` (null when it holds no heading or track): the heading ordered (a track's
   * course less the drift angle), then δ = -(k_v v + k_r r + k_e e + k_i ∫e) with gains placed on the ship's own model
   * linearised at its speed, placed again when the speed moves by a tenth. The integral stops while the rudder is hard over.
   */
  private autopilot(
    rt: Runtime,
    index: number,
    heading: number,
    mid: Vec3,
    u: number,
    v: number,
    r: number,
    dt: number,
  ): number | null {
    const { control, status, ship, mmg } = rt,
      words = regionWords(this.host.memory, this.pilots) as Float64Array,
      L = ship.model.length;
    status.heading = heading;
    let wanted: number | null = null;
    if (control.track) {
      const track = control.track;
      if (!Array.isArray(track.waypoints) || track.waypoints.length < 2)
        throw shipError('A track is {waypoints: [[x, z], ...]} with two or more waypoints; pass them.');
      const at = PILOT_WORDS * index,
        state: TrackState = status.track ?? { leg: words[at + 1]!, course: 0, crossTrack: 0, done: false };
      state.leg = words[at + 1]!;
      steerTrack(track, mid[0], mid[2], L, state);
      words[at + 1] = state.leg;
      status.track = state;
      // The heading ordered is the course less the drift angle, low-passed over 10 L / U so a steady crosswind or current
      // is crabbed into without the turns' own sideslip feeding back into the steering.
      const drift = atan2(v, Math.max(Math.abs(u), 1e-9)),
        blend = Math.min(1, (dt * Math.max(Math.abs(u), 1e-9)) / (10 * L));
      words[at + 5] = words[at + 5]! + blend * (drift - words[at + 5]!);
      wanted = wrap(state.course - words[at + 5]!);
    } else {
      status.track = null;
      if (control.heading !== null && control.heading !== undefined) {
        if (!Number.isFinite(control.heading))
          throw shipError(`A heading is finite radians (got ${control.heading}); pass one, or null to steer by hand.`);
        wanted = control.heading;
      }
    }
    status.headingOrdered = wanted;
    const at = PILOT_WORDS * index;
    if (wanted === null) {
      words[at] = 0;
      words[at + 4] = 0;
      return null;
    }
    const speed = Math.abs(u);
    // Too slow to steer by the rudder: hold it amidships, the integral at rest and the reference on the ship.
    if (speed < 0.02 * Math.sqrt(9.81 * L)) {
      words[at] = 0;
      words[at + 4] = 0;
      return 0;
    }
    if (!rt.gains || Math.abs(speed - rt.gainSpeed) > 0.1 * rt.gainSpeed) {
      const { a, b } = mmg.linearize(speed),
        pilot = ship.autopilot ?? {};
      rt.gains = headingGains(a, b, (pilot.bandwidth ?? 1) * (speed / L), pilot.damping ?? 0.8);
      rt.gainSpeed = speed;
    }
    const k = rt.gains;
    if (!k) return 0;
    // The reference: the ordered heading reached through a critically damped second-order filter at the loop's own
    // frequency (Fossen's reference model), so a large change is asked for at a pace the rudder can give; the controller
    // follows the reference's heading and turn rate.
    const pilot = ship.autopilot ?? {},
      w = (pilot.bandwidth ?? 1) * (speed / L);
    if (words[at + 4] !== 1) {
      words[at + 2] = heading;
      words[at + 3] = r;
      words[at + 4] = 1;
    }
    const ref = words[at + 2]!,
      rate = words[at + 3]!,
      accel = w * w * wrap(wanted - ref) - 2 * w * rate;
    words[at + 3] = rate + accel * dt;
    words[at + 2] = wrap(ref + words[at + 3]! * dt);
    const e = wrap(heading - words[at + 2]!),
      integral = words[at]!,
      raw = -(k.v * v + k.r * (r - words[at + 3]!) + k.heading * e + k.integral * integral),
      limit = mmg.rudderLimit;
    if (Math.abs(raw) < limit) words[at] = integral + e * dt;
    return Math.max(-limit, Math.min(limit, raw));
  }

  /** Ship `index`'s controls, to read and set: `ships.control(0).revolutions = 2`. */
  control(index: number): ShipControl {
    const r = this.runtime[index];
    if (!r) throw shipError(`There is no ship ${index}; pass 0 to ${this.runtime.length - 1}.`);
    return r.control;
  }

  /** What ship `index` did in the last step. */
  status(index: number): ShipStatus {
    const r = this.runtime[index];
    if (!r) throw shipError(`There is no ship ${index}; pass 0 to ${this.runtime.length - 1}.`);
    return r.status;
  }

  /** The self-propulsion revolutions of ship `index` at `speed` m/s (thrust balancing its resistance). */
  revolutionsFor(index: number, speed: number): number {
    const r = this.runtime[index];
    if (!r) throw shipError(`There is no ship ${index}; pass 0 to ${this.runtime.length - 1}.`);
    return r.mmg.selfPropulsion(speed);
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array,
      rudders = regionWords(this.host.memory, this.rudders) as Float64Array,
      dt = 1 / rateOf(context.level);
    out.fill(0);
    const jets = this.thrusterJets && (regionWords(this.host.memory, this.thrusterJets) as Float64Array);
    jets?.fill(0);
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    const memory = port.region.memory ?? this.host.memory,
      bodies = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4);
    this.runtime.forEach((rt, index) => {
      const { ship, mmg, control, status } = rt,
        at = ship.row * BODY_WORDS;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) return;
      const q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
        origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
        centre: Vec3 = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!],
        velocity: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
        spin: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
        inverseMass = bodies[at + 16]!,
        mid = add(origin, rotate(q, ship.midship ?? [0, 0, 0])),
        up = rotate(q, ship.up ?? [0, 1, 0]),
        vertical = this.vertical,
        // MMG's horizontal body axes: the body's forward laid level, starboard level across it, z down the vertical, so a
        // heeled or trimmed hull's sway and yaw stay horizontal.
        ahead = rotate(q, ship.forward ?? [1, 0, 0]),
        levelled = sub(ahead, scale(vertical, dot(ahead, vertical))),
        levelLength = hypot(levelled[0], levelled[1], levelled[2]),
        f = levelLength > 1e-9 ? scale(levelled, 1 / levelLength) : ahead,
        s = cross(f, vertical),
        // Velocity at the midship: the centre's plus spin x (midship - centre).
        vm = add(velocity, cross(spin, sub(mid, centre))),
        u = dot(vm, f),
        v = dot(vm, s),
        // Yaw rate about MMG's z, which points down.
        r = -dot(spin, vertical),
        // Heel: the body's up leaning toward starboard (starboard down), and its roll rate.
        phi = atan2(dot(up, s), dot(up, vertical)),
        p = dot(spin, f);
      // In shallow water the hull's derivatives and added masses are the depth's (Kijima et al. 1990; Li and Wu 1990),
      // made again when the draught over depth moves by a hundredth.
      const depth = this.depthAt(mid[0], mid[2]),
        key = Number.isFinite(depth) ? Math.round((100 * ship.model.draught) / depth) : 0;
      if (key !== rt.shallowKey) {
        rt.shallowKey = key;
        rt.model = key === 0 ? ship.model : shallowWater(ship.model, (100 * ship.model.draught) / key);
        mmg.setModel(rt.model);
        rt.gains = null;
      }
      const M = rt.model,
        L = M.length;
      // The rudder turns toward its order: the autopilot's when it holds a heading or a track.
      mmg.revolutions = control.revolutions;
      const heading = atan2(f[2], f[0]),
        ordered = this.autopilot(rt, index, heading, mid, u, v, r, dt),
        order = Math.max(-mmg.rudderLimit, Math.min(mmg.rudderLimit, ordered ?? control.rudder)),
        turn = mmg.rudderRate * dt;
      rudders[index] = rudders[index]! + Math.max(-turn, Math.min(turn, order - rudders[index]!));
      const state = { x: 0, z: 0, heading, u, v, r, rudder: rudders[index]!, heel: phi, rollRate: p },
        forces = mmg.forces(state, status.forces);
      let X = forces.X,
        Y = forces.Y,
        N = forces.N;
      // The bow thruster: its push across the bow, falling as the ship gathers way (the jet bends aft and the low pressure
      // behind its outlet takes back part of it), by the ratio m of the ship's speed to the jet's.
      let push = 0;
      if (ship.thruster && ship.thruster.power > 0 && control.thruster !== 0) {
        const { diameter, power } = ship.thruster,
          merit = ship.thruster.merit ?? THRUSTER_MERIT_COEFFICIENT,
          full = pow(merit / 2, 2 / 3) * thrusterThrust(power, diameter, this.density),
          jet = Math.sqrt(full / (this.density * 0.25 * Math.PI * diameter * diameter)),
          [force, moment] = thrusterAhead(Math.abs(u) / jet),
          command = Math.max(-1, Math.min(1, control.thruster));
        push = command * full * force;
        Y += push;
        const forwardOffset = ship.thruster.position ?? 0.42 * L;
        N += forwardOffset * command * full * moment;
        const outlet = ship.thrusterOutlet;
        if (jets && outlet && Math.abs(command) > 0) {
          const direction = scale(s, -Math.sign(command));
          const position = add(
            add(mid, scale(f, forwardOffset)),
            add(scale(direction, outlet.halfSpan), scale(up, -outlet.depth)),
          );
          jets.set(
            [...position, ...direction, jet * Math.sqrt(Math.abs(command)), diameter],
            index * THRUSTER_JET_WORDS,
          );
        }
      }
      // Suction toward a wall alongside: the return flow pressed through the gap.
      // The banks alongside (Vantorre et al. 2003), with last step's sinkage.
      const banked = this.bank(mid, f, s, u, forces.thrust, status.sinkage, M, M.propeller.diameter);
      Y += banked.Y;
      N += banked.N;
      // Level ice (Riska et al. 1997): breaking it resists the ship going ahead; stopped, it holds the ship up to its
      // breaking part C1.
      let iceDrag = 0;
      if (this.ice && ship.iceHull) {
        const t = this.ice.thickness,
          h = typeof t === 'function' ? t(mid[0], mid[2]) : t;
        if (h > 0) {
          const r = iceResistance({ length: L, beam: M.beam, draught: M.draught, ...ship.iceHull }, h, u);
          iceDrag = u > 0 ? r.resistance : Math.max(0, Math.min(X, r.c1));
          X -= iceDrag;
        }
      }
      status.ice = iceDrag;
      const mass = inverseMass > 0 ? 1 / inverseMass : 0;
      if (mass === 0) return;
      // The added masses and their coupling: hold the body so it moves as eq. 4 says (its own mass and inertia from the port).
      const rho = this.density,
        d = M.draught,
        [mx, my, jz] = ship.addedMass === false ? [0, 0, 0] : M.addedMass,
        ax = mx * 0.5 * rho * L * L * d,
        ay = my * 0.5 * rho * L * L * d,
        az = jz * 0.5 * rho * L * L * L * L * d,
        xG = dot(sub(centre, mid), f),
        // The body's yaw inertia about its centre: 1 / (z . I^-1 z) about the vertical.
        iinv =
          vertical[0] *
            (bodies[at + 17]! * vertical[0] + bodies[at + 18]! * vertical[1] + bodies[at + 19]! * vertical[2]) +
          vertical[1] *
            (bodies[at + 18]! * vertical[0] + bodies[at + 20]! * vertical[1] + bodies[at + 21]! * vertical[2]) +
          vertical[2] *
            (bodies[at + 19]! * vertical[0] + bodies[at + 21]! * vertical[1] + bodies[at + 22]! * vertical[2]),
        izG = iinv > 0 ? 1 / iinv : 0,
        mu = mass + ax,
        mv = mass + ay,
        xm = xG * mass,
        iz = izG + xG * xG * mass + az,
        bu = X + mv * v * r + xm * r * r,
        bv = Y - mu * u * r,
        bn = N - xm * u * r,
        det = mv * iz - xm * xm,
        du = bu / mu,
        dv = (bv * iz - xm * bn) / det,
        dr = (mv * bn - xm * bv) / det,
        // Eq. 3: the forces on the body's mass alone, then the moment about its centre of mass.
        Fx = -ax * du + ay * v * r + X,
        Fy = -ay * dv - ax * u * r + Y,
        Mz = -az * dr + N - xG * Fy,
        w = ship.row * FORCE_WORDS;
      for (let k = 0; k < 3; k++) {
        out[w + k]! += Fx * f[k]! + Fy * s[k]!;
        // MMG's z points down: a moment about it is minus one about the vertical.
        out[w + 3 + k]! -= Mz * vertical[k]!;
      }
      const H = M.heel;
      if (H) {
        // The roll (Fukui et al. 2016, eq. 4): the hull's and rudder's moments about G, the added masses' reaction at z_H, and
        // the model's restoring moment and damping unless a HullSolver's pressures give them; the body takes its own inertia's
        // share, the rest is the added inertia J_xx.
        const fi =
            f[0] * (bodies[at + 17]! * f[0] + bodies[at + 18]! * f[1] + bodies[at + 19]! * f[2]) +
            f[1] * (bodies[at + 18]! * f[0] + bodies[at + 20]! * f[1] + bodies[at + 21]! * f[2]) +
            f[2] * (bodies[at + 19]! * f[0] + bodies[at + 21]! * f[1] + bodies[at + 22]! * f[2]),
          ixx = fi > 0 ? 1 / fi : 0,
          jxx = (H.addedInertia ?? 0.2) * ixx;
        let K = forces.K + ((H.hullDepth ?? 0.5 * d) - H.gravityDepth) * (ay * dv + ax * u * r);
        if (ship.roll !== 'hull') {
          const c44 = this.g * mass * H.metacentricHeight;
          K -= ((2 * (H.decay ?? 0.035)) / Math.PI) * Math.sqrt(c44 * (ixx + jxx)) * p + c44 * sin(phi);
        }
        const own = ixx > 0 ? (K * ixx) / (ixx + jxx) : 0;
        for (let k = 0; k < 3; k++) out[w + 3 + k]! += own * f[k]!;
      }
      status.heel = phi;
      status.rollRate = p;
      // Squat in shallow water.
      const h = this.depthAt(mid[0], mid[2]),
        speed = Math.sqrt(u * u + v * v);
      let sinkage = 0,
        trim = 0;
      if (Number.isFinite(h) && speed > 0) {
        const block = ship.block ?? M.volume / (L * M.beam * d);
        if (h > d) {
          // Held below the laws' limit of Fn_h 0.7.
          const sq = squat({
            length: L,
            beam: M.beam,
            draught: d,
            block,
            speed: Math.min(speed, 0.69 * Math.sqrt(this.g * h)),
            depth: h,
            gravity: this.g,
          });
          sinkage = sq.mean;
          trim = sq.trim;
        }
      }
      // The race: behind the propeller at its shaft, along -forward for thrust ahead.
      const P = M.propeller,
        shaftDepth = ship.shaftDepth ?? Math.max(P.diameter / 2, d - 0.6 * P.diameter),
        prop = add(add(mid, scale(f, P.position * L)), scale(up, -shaftDepth)),
        // The race's own speed over the water it came from: the far wake less the inflow (momentum theory).
        induced = Math.max(0, forces.race - Math.max(0, forces.thrust > 0 ? forces.inflow : -forces.inflow));
      // The rudder behind it pushes the race aside: the side force the rudder takes, on the world's starboard.
      const rudderSide = -forces.rudderNormal * cos(rudders[index]!),
        // The rudder's distance aft of the propeller, at least half a diameter.
        rudderAft = Math.max(0.5 * P.diameter, (P.position - (M.rudder.position ?? -0.5)) * L);
      status.race =
        forces.thrust !== 0 && induced > 0
          ? {
              position: prop,
              direction: forces.thrust > 0 ? scale(f, -1) : f,
              diameter: P.diameter,
              pitch: P.curves.pitch,
              efflux: induced,
              blades: ship.blades ?? 4,
              revolutions: mmg.revolutions,
              torque: forces.torque,
              thrust: forces.thrust,
              inflow: Math.abs(forces.inflow),
              up,
              density: this.density,
              rudder: forces.thrust > 0 ? { distance: rudderAft, force: scale(s, rudderSide) } : undefined,
            }
          : undefined;
      // Cavitation in the tip vortices: the tip's cavitation number at the shaft's depth against the Lamb-Oseen core's
      // inception index, with the cavity's hysteresis.
      const cavity = rt.cavity;
      if (status.race) {
        const n = Math.abs(mmg.revolutions),
          tip = Math.sqrt(forces.inflow * forces.inflow + Math.PI * n * P.diameter * (Math.PI * n * P.diameter)),
          ambient = 101325 + this.density * this.g * shaftDepth,
          numbers = raceNumbers(status.race),
          core = 0.02 * P.diameter,
          sigma = tip > 0 ? (ambient - VAPOUR_PRESSURE) / (0.5 * this.density * tip * tip) : Number.POSITIVE_INFINITY,
          inception = tip > 0 ? inceptionIndex(numbers.circulation, core, tip) : 0,
          on = cavity.update(sigma, inception);
        status.cavity = {
          cavitating: on,
          // A gas-filled cavity held past inception keeps the size the core's vapour cavity had at inception's edge.
          radius: on
            ? Math.max(cavityRadius(numbers.circulation, core, ambient, VAPOUR_PRESSURE, this.density), 0.25 * core)
            : 0,
          sigma,
          inception,
        };
      } else status.cavity = { cavitating: false, radius: 0, sigma: Number.POSITIVE_INFINITY, inception: 0 };
      status.speed = speed;
      status.u = u;
      status.v = v;
      status.r = r;
      status.rudder = rudders[index]!;
      status.sinkage = sinkage;
      status.trim = trim;
      status.thruster = push;
      status.suction = banked.Y;
      status.bankMoment = banked.N;
      status.bankInRange = banked.inRange;
      status.midship = mid;
      status.forward = f;
      status.starboard = s;
    });
  }

  /** The water's depth at (x, z), m (Infinity for deep water). */
  private depthAt(x: number, z: number): number {
    const d = this.depth;
    if (d === undefined) return Number.POSITIVE_INFINITY;
    const h = typeof d === 'function' ? d(x, z) : d;
    return h > 0 ? h : Number.POSITIVE_INFINITY;
  }

  /**
   * The banks' sway force and yaw moment (Vantorre et al. 2003, `bankLoads`): the nearest wall alongside on each side,
   * within half a ship length of the midship along it, gives y_B = (B / 2) (1 / y_s - 1 / y_p); the depth less the last
   * step's sinkage is the effective depth.
   */
  private bank(
    mid: Vec3,
    f: Vec3,
    s: Vec3,
    u: number,
    thrust: number,
    sinkage: number,
    M: ManoeuvringModel,
    diameter: number,
  ): BankLoads {
    const none: BankLoads = { Y: 0, N: 0, inRange: true };
    if (this.walls.length === 0) return none;
    let starboard = Number.POSITIVE_INFINITY,
      port = Number.POSITIVE_INFINITY;
    for (const wall of this.walls) {
      const [ax, az] = wall.from,
        [bx, bz] = wall.to,
        ex = bx - ax,
        ez = bz - az,
        length2 = ex * ex + ez * ez,
        t = length2 > 0 ? Math.max(0, Math.min(1, ((mid[0] - ax) * ex + (mid[2] - az) * ez) / length2)) : 0,
        px = ax + t * ex - mid[0],
        pz = az + t * ez - mid[2],
        along = Math.abs(px * f[0] + pz * f[2]),
        across = px * s[0] + pz * s[2];
      // Only a wall alongside: within half a ship length of the midship along the ship, and clear of its side.
      if (along > M.length / 2 || !(Math.abs(across) > M.beam / 2)) continue;
      if (across > 0) starboard = Math.min(starboard, across);
      else port = Math.min(port, -across);
    }
    if (!Number.isFinite(starboard) && !Number.isFinite(port)) return none;
    const yB = (M.beam / 2) * (1 / starboard - 1 / port),
      depth = this.depthAt(mid[0], mid[2]) - Math.max(0, sinkage);
    if (!(depth > M.draught)) return none;
    return bankLoads(
      {
        length: M.length,
        beam: M.beam,
        draught: M.draught,
        block: M.volume / (M.length * M.beam * M.draught),
        diameter,
      },
      yB,
      depth,
      u,
      thrust,
      this.density,
      this.g,
    );
  }

  /** The races' and configured tunnel jets' water velocity at (x, y, z), into a flow sample. */
  private flow(x: number, y: number, z: number, out?: FlowSample): FlowSample {
    const o = out ?? { velocity: [0, 0, 0], density: 0, temperature: 288.15 },
      p: Vec3 = [x, y, z],
      v = this.flowSample;
    o.velocity[0] = o.velocity[1] = o.velocity[2] = 0;
    for (const { status } of this.runtime) {
      if (!status.race) continue;
      resolvedRace(status.race, p, v);
      o.velocity[0] += v[0];
      o.velocity[1] += v[1];
      o.velocity[2] += v[2];
    }
    if (this.thrusterJets && y <= 0) {
      const jets = regionWords(this.host.memory, this.thrusterJets) as Float64Array;
      for (let i = 0; i < jets.length; i += THRUSTER_JET_WORDS) {
        const speed = jets[i + 6]!;
        if (!(speed > 0)) continue;
        const dx = x - jets[i]!,
          dy = y - jets[i + 1]!,
          dz = z - jets[i + 2]!;
        const sx = jets[i + 3]!,
          sy = jets[i + 4]!,
          sz = jets[i + 5]!;
        const distance = dx * sx + dy * sy + dz * sz;
        if (!(distance >= 0)) continue;
        const radius = jets[i + 7]! / 2;
        // Albertson et al. (1950): centreline decay 6.2 D/x in the established round jet.
        // A momentum-normalized Gaussian keeps the core speed bounded at the outlet.
        const width = Math.max(radius, distance / 12.4);
        const rx = (dx - distance * sx) / width,
          ry = (dy - distance * sy) / width,
          rz = (dz - distance * sz) / width;
        const axial = speed * (radius / width) * exp(-0.5 * (rx * rx + ry * ry + rz * rz));
        o.velocity[0] += axial * sx;
        o.velocity[1] += axial * sy;
        o.velocity[2] += axial * sz;
      }
    }
    o.density = y <= 0 ? this.density : 0;
    o.temperature = 288.15;
    return o;
  }

  /**
   * The sea the hulls float on: `base` with its surface drawn down along each ship by its squat (the sinkage at the midship
   * and the trim by the stern over its length, fading over a beam past its ends and sides), its pressure under the lowered
   * surface. Pass it to the HullSolver as its `sea`.
   */
  sea(base: SeaSurface | SeaQuery): SeaQuery & { readonly cell?: readonly [number, number, number] } {
    const solver = this,
      down = (x: number, z: number) => solver.drawdown(x, z);
    return {
      cell: (base as Partial<SeaSurface>).cell,
      density: base.density,
      elevation: (x, z, t) => base.elevation(x, z, t) - down(x, z),
      pressure: (x, y, z, t) => {
        const d = down(x, z);
        if (base.pressure) return base.pressure(x, y + d, z, t);
        const below = base.elevation(x, z, t) - d - y;
        return below > 0 ? (base.density ?? 1025) * solver.g * below : 0;
      },
    };
  }

  /** The squat's drawdown of the surface at (x, z), m. */
  drawdown(x: number, z: number): number {
    let total = 0;
    for (const { ship, status } of this.runtime) {
      if (!(status.sinkage > 0)) continue;
      const M = ship.model,
        dx = x - status.midship[0],
        dz = z - status.midship[2],
        xi = dx * status.forward[0] + dz * status.forward[2],
        eta = dx * status.starboard[0] + dz * status.starboard[2],
        half = M.length / 2,
        outLong = Math.max(0, Math.abs(xi) - half) / M.beam,
        outSide = Math.max(0, Math.abs(eta) - M.beam / 2) / M.beam,
        fade = exp(-(outLong * outLong + outSide * outSide)),
        along = Math.max(-half, Math.min(half, xi));
      total += (status.sinkage - status.trim * along) * fade;
    }
    return total;
  }

  /**
   * The hulls' pressure on the surface for a `WakeSolver` (`sources: (t) => ships.sources(t)`): each hull as patches along its
   * length, the pressure of its draught rho g T over its beam, so it pushes up a bow wave and trails a Kelvin wake.
   */
  sources(_t: number): readonly SeaSource[] {
    const out: SeaSource[] = [];
    for (const { ship, status } of this.runtime) {
      const M = ship.model,
        count = Math.max(3, Math.min(24, Math.round((2 * M.length) / M.beam)));
      for (let k = 0; k < count; k++) {
        const xi = (k + 0.5) / count - 0.5,
          // A waterline that narrows to the ends: the draught's pressure over (1 - (2 xi)^4).
          shape = 1 - 16 * xi * xi * xi * xi;
        out.push({
          x: status.midship[0] + xi * M.length * status.forward[0],
          z: status.midship[2] + xi * M.length * status.forward[2],
          radius: M.beam / 2,
          pressure: this.density * this.g * M.draught * shape,
          volume: 0,
        });
      }
    }
    return out;
  }

  /**
   * Where each race boils up to the surface, for a `FoamSolver` ship's `wash`: from where its spreading jet's e-folding
   * radius reaches the shaft's depth, along the race, with the race's speed there.
   */
  wash(_t: number): readonly {
    position: [number, number];
    direction: [number, number];
    reach: number;
    speed: number;
    radius: number;
  }[] {
    const out: {
      position: [number, number];
      direction: [number, number];
      reach: number;
      speed: number;
      radius: number;
    }[] = [];
    for (const { status } of this.runtime) {
      const race = status.race;
      if (!race) continue;
      const depth = Math.max(race.diameter / 2, -race.position[1]),
        // The established jet's e-folding radius is X / sqrt(22.2): it meets the surface at X = 4.71 times the shaft's depth.
        start = 4.71 * depth,
        dir = race.direction,
        flat = Math.sqrt(dir[0] * dir[0] + dir[2] * dir[2]) || 1,
        at: Vec3 = [
          race.position[0] + dir[0] * start,
          race.position[1] + dir[1] * start,
          race.position[2] + dir[2] * start,
        ],
        // The race's speed at the surface there: its axis speed at one e-folding radius out.
        axis = raceVelocity(race, at),
        speed = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]) * exp(-1);
      out.push({
        position: [at[0], at[2]],
        direction: [dir[0] / flat, dir[2] / flat],
        reach: 10 * race.diameter,
        speed,
        radius: depth,
      });
    }
    return out;
  }

  /**
   * Where the races release air for the bubbles (SEA-15) and the foam (SEA-13): each cavitating propeller's tip-vortex
   * cavities, carried off where the vortices break down (1.5 diameters aft), at the gas volume they hold, Z pi r_c^2 times the
   * race's speed through the disc, m^3/s, on a ring of the slipstream's radius.
   */
  aeration(_t: number): readonly { position: [number, number, number]; radius: number; rate: number }[] {
    const out: { position: [number, number, number]; radius: number; rate: number }[] = [];
    for (const { status } of this.runtime) {
      const race = status.race;
      if (!race || !status.cavity.cavitating) continue;
      const numbers = raceNumbers(race),
        x = TIP_VORTEX_GONE * race.diameter,
        r = status.cavity.radius;
      out.push({
        position: [
          race.position[0] + race.direction[0] * x,
          race.position[1] + race.direction[1] * x,
          race.position[2] + race.direction[2] * x,
        ],
        radius: (numbers.contraction * race.diameter) / 2,
        rate: race.blades * Math.PI * r * r * numbers.disc,
      });
    }
    return out;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [
      { field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell },
      { field: MANOEUVRING_CLAIMS_FIELD.name, region: this.claims, tick, cell: this.cell },
    ];
  }

  stateRegions(): readonly Region[] {
    return this.thrusterJets ? [this.rudders, this.pilots, this.thrusterJets] : [this.rudders, this.pilots];
  }

  extraState(): readonly Region[] {
    return [this.forces];
  }
}

function rotate(q: readonly [number, number, number, number], v: readonly [number, number, number]): Vec3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
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
