// Planing boats as a solver of the physics framework (SEA-09): each step it reads each boat's body from the rigid solver's
// `bodies` port, finds how its prismatic bottom is wetted from where the body lies on the water (its trim and the keel's
// immersion at the transom: the keel wetted over L_k = d / sin(tau), the chine b tan(beta) / (pi tan(tau)) less), and holds
// it through `bodyForces` with Savitsky's normal force at his centre of pressure, the bottom's friction and the boat's
// thrust (planing.ts). The body then trims and runs at its own attitude; steady, it runs at `savitsky()`'s. Its sinking
// and pitching over the speed add to the trim in the dynamic lift along the wetted length, quasi-steadily, which damps its
// heave and pitch. Couple it before the rigid solver: `world.couple(['planing', 'rigid'], 'staggered')`.
//
// Surge, heave and pitch only: no side force or yaw moment of a planing hull is modelled (docs/limits.md).
import { DEFAULT_GRAVITY } from '@margoengine/math/gravity';
import { atan2, cos, hypot, sin } from '@margoengine/math/pinned';
import { regionWords } from '../world/memory.js';
import type { Port, RateLevel, Region, Solver, SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { shipError } from './errors.js';
import { type PlaningLoads, type PlaningWater, planingLoads } from './planing.js';

type Vec3 = [number, number, number];
const LAYOUT = 1;
/** The least trim the bottom's loads are taken at, rad: Savitsky's lift has no meaning at or below a level keel. */
const LEAST_TRIM = 0.5 / (180 / Math.PI);
/** Points along the wetted length the heave and pitch damping is summed over. */
const DAMPING_POINTS = 8;

/** A planing boat: its body row and its prismatic bottom, laid on the body. */
export interface PlaningBoat {
  readonly row: number;
  /** Chine beam, m, and deadrise, rad. */
  readonly beam: number;
  readonly deadrise: number;
  /** The bottom's length along the keel from the transom, m: a wetted length beyond it is held at it. */
  readonly length: number;
  /** The keel at the transom, in the body's frame, m (default the body's origin). */
  readonly transom?: readonly [number, number, number];
  /** The body's forward (along the keel) and up axes, unit vectors in its frame (default +X and +Y). */
  readonly forward?: readonly [number, number, number];
  readonly up?: readonly [number, number, number];
  /** Where the thrust acts, in the body's frame (default the transom), and its angle up from the keel, rad (default 0). */
  readonly propeller?: readonly [number, number, number];
  readonly thrustAngle?: number;
}

/** What a {@link PlaningSolver} is made from. */
export interface PlaningParams extends PlaningWater {
  readonly boats: readonly PlaningBoat[];
  /** The still water's height along the vertical, m (default 0). */
  readonly waterLevel?: number;
  /** Body rows its `bodyForces` port covers (default the world's). */
  readonly capacity?: number;
  /** Its rate level (default 0); step with the rigid solver. */
  readonly level?: RateLevel;
}

/** A boat's control: its thrust, N, along its shaft line. */
export interface PlaningControl {
  thrust: number;
}

/** What a planing boat did in the last step. */
export interface PlaningStatus extends PlaningLoads {
  /** Its trim, rad (bow up), the keel's immersion at the transom, m, and its speed along the keel, m/s. */
  trim: number;
  immersion: number;
  speed: number;
  /** The water's drag on it along its course, N: the friction and the normal force's backward part. */
  resistance: number;
  /** Whether its bottom is out of the water. */
  airborne: boolean;
}

/** Planing boats on rigid bodies, by Savitsky's planing surface. `id` is `'planing'` by default. */
export class PlaningSolver implements Solver<PlaningParams> {
  private readonly id: string;
  private host!: SolverHost;
  private rate: RateLevel = 0;
  private capacity = 0;
  private water: PlaningWater = {};
  private levelHeight = 0;
  private density = 1025;
  private vertical: Vec3 = [0, 1, 0];
  private boats: readonly PlaningBoat[] = [];
  private controls: PlaningControl[] = [];
  private statuses: PlaningStatus[] = [];
  private forces!: Region;
  private cell: [number, number, number] = [0, 0, 0];

  constructor(id = 'planing') {
    this.id = id;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
      ],
      rate: this.rate,
      stableRate: () => this.rate,
    };
  }

  init(host: SolverHost, params: PlaningParams): void {
    const { boats, waterLevel = 0, level: rate = 0 } = params ?? ({} as PlaningParams);
    if (!Array.isArray(boats) || boats.length === 0)
      throw shipError('Planing boats need their bodies: pass {boats: [{row, beam, deadrise, length}]}.');
    for (const b of boats) {
      if (!(Number.isInteger(b?.row) && b.row >= 0))
        throw shipError(`A planing boat's body row is a whole number, 0 or more (got ${b?.row}); pass the body's row.`);
      if (
        !(b.beam > 0 && b.length > 0 && b.deadrise >= 0 && b.deadrise < Math.PI / 2) ||
        ![b.beam, b.length, b.deadrise, b.thrustAngle ?? 0].every(Number.isFinite)
      )
        throw shipError(
          `A planing boat's beam and length are finite metres above 0 and its deadrise 0 to under pi / 2 rad (got ${[b.beam, b.length, b.deadrise].join(', ')}); pass them.`,
        );
    }
    if (!Number.isFinite(waterLevel))
      throw shipError(`The water's level is finite metres (got ${waterLevel}); pass one, or 0.`);
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw shipError(`A rate level is a whole number from 0 to 7 (got ${rate}); pass one.`);
    // The water's properties, checked once by the loads.
    planingLoads({ beam: 1, deadrise: 0, mass: 1, lcg: 1 }, 0.05, 1, 1, params);
    this.host = host;
    this.rate = rate as RateLevel;
    this.water = {
      density: params.density,
      viscosity: params.viscosity,
      gravity: params.gravity,
      roughness: params.roughness,
    };
    this.levelHeight = waterLevel;
    this.density = params.density ?? 1025;
    const gv = host.gravity ?? DEFAULT_GRAVITY,
      gl = hypot(gv[0], gv[1], gv[2]);
    if (!(gl > 0))
      throw shipError(
        'A planing boat rises on its speed against its weight, and this world has no gravity; give the PhysicsWorld its gravity.',
      );
    this.vertical = [-gv[0] / gl, -gv[1] / gl, -gv[2] / gl];
    this.water = { ...this.water, gravity: params.gravity ?? gl };
    this.boats = boats;
    this.controls = boats.map(() => ({ thrust: 0 }));
    this.statuses = boats.map(() => ({
      normal: 0,
      friction: 0,
      centre: 0,
      lambda: 0,
      keel: 0,
      chine: 0,
      speedCoefficient: 0,
      lift: 0,
      dynamic: 0,
      inRange: false,
      trim: 0,
      immersion: 0,
      speed: 0,
      resistance: 0,
      airborne: true,
    }));
    this.capacity = bodyRowsOf(
      host,
      'A PlaningSolver',
      boats.map((b) => b.row),
      params.capacity,
    );
    this.forces = host.allocate('forces', this.capacity * FORCE_WORDS * 8, 'f64', LAYOUT);
  }

  /** Boat `index`'s control: `planing.control(0).thrust = 2000`. */
  control(index: number): PlaningControl {
    const c = this.controls[index];
    if (!c) throw shipError(`There is no planing boat ${index}; pass 0 to ${this.controls.length - 1}.`);
    return c;
  }

  /** What boat `index` did in the last step. */
  status(index: number): PlaningStatus {
    const s = this.statuses[index];
    if (!s) throw shipError(`There is no planing boat ${index}; pass 0 to ${this.statuses.length - 1}.`);
    return s;
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array;
    out.fill(0);
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    const memory = port.region.memory ?? this.host.memory,
      bodies = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4),
      vertical = this.vertical;
    this.boats.forEach((boat, index) => {
      const at = boat.row * BODY_WORDS,
        status = this.statuses[index]!;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) return;
      const q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
        origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
        centre: Vec3 = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!],
        velocity: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
        spin: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
        inverseMass = bodies[at + 16]!,
        up = rotate(q, boat.up ?? [0, 1, 0]),
        fwd = rotate(q, boat.forward ?? [1, 0, 0]),
        transom = add(origin, rotate(q, boat.transom ?? [0, 0, 0])),
        // Trim: the keel's rise over the horizontal, bow up.
        sinTrim = Math.max(-1, Math.min(1, dot(fwd, vertical))),
        trim = atan2(sinTrim, Math.sqrt(1 - sinTrim * sinTrim)),
        immersion = this.levelHeight - dot(transom, vertical),
        level = sub(fwd, scale(vertical, sinTrim)),
        levelLength = hypot(level[0], level[1], level[2]),
        course = levelLength > 1e-9 ? scale(level, 1 / levelLength) : fwd,
        speed = dot(velocity, course);
      status.trim = trim;
      status.immersion = immersion;
      status.speed = speed;
      status.airborne = immersion <= 0;
      const mass = inverseMass > 0 ? 1 / inverseMass : 0;
      let loads: PlaningLoads | null = null;
      if (immersion > 0 && speed > 0 && mass > 0) {
        // The wetted bottom: the keel from the transom to where it meets the water, the chine shorter by the spray root's
        // rise; past the bottom's length it is held there.
        const t = Math.max(trim, LEAST_TRIM),
          keel = Math.min(immersion / sin(t), boat.length),
          rise = (boat.beam * (sin(boat.deadrise) / cos(boat.deadrise))) / (Math.PI * (sin(t) / cos(t))),
          chine = keel - rise,
          // Chines dry: the mean of the keel's and chine's lengths, no less than a quarter of the keel's.
          lambda = Math.max(0.5 * (keel + chine), 0.25 * keel) / boat.beam,
          lcg = dot(sub(centre, transom), fwd),
          hull = { beam: boat.beam, deadrise: boat.deadrise, mass, lcg: Math.max(lcg, 1e-6) },
          l = planingLoads(hull, t, lambda, speed, this.water);
        l.inRange = l.inRange && trim >= LEAST_TRIM && keel < boat.length;
        loads = l;
        const w = boat.row * FORCE_WORDS,
          pressureAt = add(transom, scale(fwd, l.centre)),
          frictionAt = add(pressureAt, scale(up, (boat.beam / 4) * (sin(boat.deadrise) / cos(boat.deadrise)))),
          normal = scale(up, l.normal),
          friction = scale(fwd, -l.friction);
        apply(out, w, centre, pressureAt, normal);
        apply(out, w, centre, frictionAt, friction);
        // The bottom's sinking (its heave and pitch) adds to the trim along the wetted length, quasi-steadily: the dynamic
        // lift, d(tau^1.1) = 1.1 tau^0.1 d(tau), laid along the mean wetted length as x^2, so it centres 0.75 of the way
        // forward as Savitsky's dynamic lift does; this damps the heave and pitch.
        const wetted = lambda * boat.beam,
          slope = (1.1 * (0.5 * this.density * speed * speed * boat.beam * boat.beam * l.dynamic)) / (t * cos(t));
        for (let i = 0; i < DAMPING_POINTS; i++) {
          const x = ((i + 0.5) / DAMPING_POINTS) * wetted,
            share = (3 * x * x) / (wetted * wetted * DAMPING_POINTS),
            at = add(transom, scale(fwd, x)),
            sinking = -dot(add(velocity, cross(spin, sub(at, centre))), vertical);
          apply(out, w, centre, at, scale(up, (slope * share * sinking) / speed));
        }
        status.resistance = -dot(add(normal, friction), course);
      } else status.resistance = 0;
      Object.assign(
        status,
        loads ?? {
          normal: 0,
          friction: 0,
          centre: 0,
          lambda: 0,
          keel: 0,
          chine: 0,
          speedCoefficient: 0,
          lift: 0,
          dynamic: 0,
          inRange: false,
        },
      );
      // The thrust along the shaft line, whether or not the bottom is wet (a jumping boat's screw races).
      const thrust = this.controls[index]!.thrust;
      if (thrust !== 0 && mass > 0 && Number.isFinite(thrust)) {
        const e = boat.thrustAngle ?? 0,
          direction = add(scale(fwd, cos(e)), scale(up, sin(e))),
          where = boat.propeller ? add(origin, rotate(q, boat.propeller)) : transom;
        apply(out, boat.row * FORCE_WORDS, centre, where, scale(direction, thrust));
      }
    });
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [];
  }

  extraState(): readonly Region[] {
    return [this.forces];
  }
}

/** Adds force `f` at `point` to the body's force and its moment about `centre`. */
function apply(out: Float64Array, w: number, centre: Vec3, point: Vec3, f: Vec3): void {
  const m = cross(sub(point, centre), f);
  for (let k = 0; k < 3; k++) {
    out[w + k]! += f[k]!;
    out[w + 3 + k]! += m[k]!;
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
