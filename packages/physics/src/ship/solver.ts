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
// - a bow thruster's push, its ideal thrust (4 rho A)^(1/3) P^(2/3) times a figure of merit, falling as the ship gathers way;
// - suction toward a quay or bank alongside, from the return flow squeezed through the gap (a one-dimensional continuity
//   estimate, uncalibrated: docs/limits.md);
// - the hull's pressure on the surface as wake sources (`sources(t)`) for a `WakeSolver`, so it makes a bow wave and a Kelvin
//   wake, and the races' boil where they reach the surface (`wash(t)`) for a `FoamSolver`'s ships.
//
// State: each ship's rudder angle. Its controls (revolutions, rudder order, thruster) are inputs, set with `control()`.
import type { FlowField, FlowSample, SeaSource, SeaSurface } from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { exp } from '@margoengine/math/pinned';
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
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { Manoeuvring, type ManoeuvringForces, type ManoeuvringModel } from './mmg.js';
import { type PropellerRace, raceVelocity, thrusterThrust } from './propeller.js';
import { squat } from './squat.js';

type Vec3 = [number, number, number];
const SHIP_LAYOUT = 1;
/** A tunnel thruster's figure of merit: its thrust over the momentum bound (installed thrusters give about 0.45 to 0.65). */
export const THRUSTER_MERIT = 0.55;

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
  readonly thruster?: { readonly diameter: number; readonly power: number; readonly position?: number };
  /** Its block coefficient, for its squat (default the model's volume over L B T). */
  readonly block?: number;
  /** Hold the added masses and their coupling (default true; false when a HullSolver already carries them). */
  readonly addedMass?: boolean;
  /** How fast the rudder turns, rad/s (default 2.32 degrees a second, the IMO's 35 to 30 degrees on the other side in 28 s). */
  readonly rudderRate?: number;
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
   * Body rows its `bodyForces` port covers: the world's (`PhysicsWorld.bodyRows`, the rigid world's capacity), which it reads;
   * given, it must be the same.
   */
  readonly capacity?: number;
  /** Its rate level (default 0); step with the rigid solver. */
  readonly level?: RateLevel;
}

/** A ship's controls: propeller revolutions, rev/s (negative astern), rudder order, rad (positive to starboard), thruster -1 to 1 (positive pushes the bow to starboard). */
export interface ShipControl {
  revolutions: number;
  rudder: number;
  thruster: number;
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
  /** The MMG forces of the step. */
  forces: ManoeuvringForces;
  /** Sinkage at the midship, m, and trim by the stern, rad, from its squat. */
  sinkage: number;
  trim: number;
  /** The thruster's push, N, and the walls' suction, N (toward the wall). */
  thruster: number;
  suction: number;
  /** The midship on the waterline, forward and starboard unit vectors on the ground plane. */
  midship: Vec3;
  forward: Vec3;
  starboard: Vec3;
  /** The propeller's race. */
  race: PropellerRace | undefined;
}

interface Runtime {
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
  private depth: ShipParams['depth'];
  private walls: readonly ShipWall[] = [];
  private runtime: Runtime[] = [];
  private rudders!: Region;
  private forces!: Region;
  private cell: [number, number, number] = [0, 0, 0];
  private readonly flowSample: Vec3 = [0, 0, 0];
  /** The water the races move, as a flow field. */
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
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  init(host: SolverHost, params: ShipParams): void {
    const { ships, depth, walls = [], density = 1025, level = 0 } = params ?? ({} as ShipParams);
    if (!Array.isArray(ships) || ships.length === 0)
      throw new TypeError(
        'Ships under way need their bodies: pass {ships: [{row, model}]}, a model such as KVLCC2_L7.',
      );
    if (!(density > 0 && Number.isFinite(density)))
      throw new RangeError(`Water's density is finite kg/m^3 above 0 (got ${density}); pass one, or 1025.`);
    if (depth !== undefined && typeof depth !== 'function' && !(depth > 0))
      throw new RangeError(
        `The water's depth is metres above 0 or a function of (x, z) (got ${depth}); pass one, or none for deep water.`,
      );
    for (const wall of walls)
      if (!(wall?.from?.length === 2 && wall.to?.length === 2 && [...wall.from, ...wall.to].every(Number.isFinite)))
        throw new RangeError('A wall is {from: [x, z], to: [x, z]} in metres; pass its two ends.');
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    this.host = host;
    this.level = level as RateLevel;
    this.density = density;
    this.g = gravityMagnitude(host.gravity ?? DEFAULT_GRAVITY);
    this.depth = depth;
    this.walls = walls;
    let top = -1;
    this.runtime = ships.map((ship) => {
      if (!(Number.isInteger(ship?.row) && ship.row >= 0))
        throw new RangeError(`A ship's body row is a whole number, 0 or more (got ${ship?.row}); pass the body's row.`);
      top = Math.max(top, ship.row);
      if (ship.thruster && !(ship.thruster.diameter > 0 && ship.thruster.power >= 0))
        throw new RangeError('A thruster is {diameter in m above 0, power in W, position}; pass them.');
      if (ship.rudderRate !== undefined && !(ship.rudderRate > 0 && Number.isFinite(ship.rudderRate)))
        throw new RangeError(`A rudder's rate is finite rad/s above 0 (got ${ship.rudderRate}); pass one.`);
      const mmg = new Manoeuvring(
        ship.model,
        {},
        { density, rudderRate: ship.rudderRate ?? (65 / 28) * (Math.PI / 180) },
      );
      return {
        ship,
        mmg,
        control: { revolutions: 0, rudder: 0, thruster: 0 },
        status: {
          speed: 0,
          u: 0,
          v: 0,
          r: 0,
          rudder: 0,
          forces: mmg.forces(mmg.state),
          sinkage: 0,
          trim: 0,
          thruster: 0,
          suction: 0,
          midship: [0, 0, 0],
          forward: [1, 0, 0],
          starboard: [0, 0, 1],
          race: undefined,
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
    this.forces = host.allocate('forces', this.capacity * FORCE_WORDS * 8, 'f64', SHIP_LAYOUT);
  }

  /** Ship `index`'s controls, to read and set: `ships.control(0).revolutions = 2`. */
  control(index: number): ShipControl {
    const r = this.runtime[index];
    if (!r) throw new RangeError(`There is no ship ${index}; pass 0 to ${this.runtime.length - 1}.`);
    return r.control;
  }

  /** What ship `index` did in the last step. */
  status(index: number): ShipStatus {
    const r = this.runtime[index];
    if (!r) throw new RangeError(`There is no ship ${index}; pass 0 to ${this.runtime.length - 1}.`);
    return r.status;
  }

  /** The self-propulsion revolutions of ship `index` at `speed` m/s (thrust balancing its resistance). */
  revolutionsFor(index: number, speed: number): number {
    const r = this.runtime[index];
    if (!r) throw new RangeError(`There is no ship ${index}; pass 0 to ${this.runtime.length - 1}.`);
    return r.mmg.selfPropulsion(speed);
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array,
      rudders = regionWords(this.host.memory, this.rudders) as Float64Array,
      dt = 1 / rateOf(context.level);
    out.fill(0);
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
        f = rotate(q, ship.forward ?? [1, 0, 0]),
        s = cross(f, up),
        // Velocity at the midship: the centre's plus spin x (midship - centre).
        vm = add(velocity, cross(spin, sub(mid, centre))),
        u = dot(vm, f),
        v = dot(vm, s),
        // Yaw rate about MMG's z, which points down.
        r = -dot(spin, up),
        M = ship.model,
        L = M.length;
      // The rudder turns toward its order.
      mmg.revolutions = control.revolutions;
      const order = Math.max(-mmg.rudderLimit, Math.min(mmg.rudderLimit, control.rudder)),
        turn = mmg.rudderRate * dt;
      rudders[index] = rudders[index]! + Math.max(-turn, Math.min(turn, order - rudders[index]!));
      const state = { x: 0, z: 0, heading: 0, u, v, r, rudder: rudders[index]! },
        forces = mmg.forces(state, status.forces);
      let X = forces.X,
        Y = forces.Y,
        N = forces.N;
      // The bow thruster: its push across the bow, falling as the ship gathers way (the jet bends aft and the low pressure
      // behind its outlet takes back part of it), by the ratio m of the ship's speed to the jet's.
      let push = 0;
      if (ship.thruster && control.thruster !== 0) {
        const { diameter, power } = ship.thruster,
          full = THRUSTER_MERIT * thrusterThrust(power, diameter, this.density),
          jet = Math.sqrt(full / (this.density * 0.25 * Math.PI * diameter * diameter)),
          m = Math.abs(u) / jet,
          loss = m <= 0 ? 1 : Math.max(0.5, 1 - 1.25 * m * exp(1 - 2.5 * m)),
          command = Math.max(-1, Math.min(1, control.thruster));
        push = command * full * loss;
        Y += push;
        N += (ship.thruster.position ?? 0.42 * L) * push;
      }
      // Suction toward a wall alongside: the return flow pressed through the gap.
      const suction = this.suction(mid, f, s, Math.sqrt(u * u + v * v), M);
      Y += suction.force;
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
        // The body's yaw inertia about its centre: 1 / (up . I^-1 up).
        iinv =
          up[0] * (bodies[at + 17]! * up[0] + bodies[at + 18]! * up[1] + bodies[at + 19]! * up[2]) +
          up[1] * (bodies[at + 18]! * up[0] + bodies[at + 20]! * up[1] + bodies[at + 21]! * up[2]) +
          up[2] * (bodies[at + 19]! * up[0] + bodies[at + 21]! * up[1] + bodies[at + 22]! * up[2]),
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
        // MMG's z points down: a moment about it is minus one about up.
        out[w + 3 + k]! -= Mz * up[k]!;
      }
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
        shaftDepth = Math.max(P.diameter / 2, d - 0.6 * P.diameter),
        prop = add(add(mid, scale(f, P.position * L)), scale(up, -shaftDepth)),
        // The race's own speed over the water it came from: the far wake less the inflow (momentum theory).
        induced = Math.max(0, forces.race - Math.max(0, forces.thrust > 0 ? forces.inflow : -forces.inflow));
      status.race =
        forces.thrust !== 0 && induced > 0
          ? {
              position: prop,
              direction: forces.thrust > 0 ? scale(f, -1) : f,
              diameter: P.diameter,
              pitch: P.curves.pitch,
              efflux: induced,
            }
          : undefined;
      status.speed = speed;
      status.u = u;
      status.v = v;
      status.r = r;
      status.rudder = rudders[index]!;
      status.sinkage = sinkage;
      status.trim = trim;
      status.thruster = push;
      status.suction = suction.force;
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
   * The lateral pull toward the nearest wall alongside (positive to starboard): the hull's section C_M B T, half of whose
   * return flow is pressed through the gap of width g and depth h, speeds the gap's water to U (1 + 0.5 A_S / (g h)); the
   * pressure drop 1/2 rho (U_gap^2 - U^2) acts on the parallel middle body, taken as 0.6 L by T.
   */
  private suction(mid: Vec3, f: Vec3, s: Vec3, speed: number, M: ManoeuvringModel): { force: number } {
    if (this.walls.length === 0 || speed <= 0) return { force: 0 };
    let best = Number.POSITIVE_INFINITY,
      side = 0;
    for (const wall of this.walls) {
      const [ax, az] = wall.from,
        [bx, bz] = wall.to,
        ex = bx - ax,
        ez = bz - az,
        length2 = ex * ex + ez * ez,
        t = length2 > 0 ? Math.max(0, Math.min(1, ((mid[0] - ax) * ex + (mid[2] - az) * ez) / length2)) : 0,
        px = ax + t * ex - mid[0],
        pz = az + t * ez - mid[2],
        distance = Math.sqrt(px * px + pz * pz),
        // Only a wall alongside: within half a ship length of the midship along the ship.
        along = Math.abs(px * f[0] + pz * f[2]);
      if (along > M.length / 2 || !(distance < best)) continue;
      best = distance;
      side = px * s[0] + pz * s[2] >= 0 ? 1 : -1;
    }
    const gap = best - M.beam / 2;
    if (!Number.isFinite(best) || !(gap > 0) || gap > 2 * M.beam) return { force: 0 };
    const h = Math.min(this.depthAt(mid[0], mid[2]), 4 * M.draught),
      section = 0.98 * M.beam * M.draught,
      ugap = speed * (1 + (0.5 * section) / (gap * h)),
      drop = 0.5 * this.density * (ugap * ugap - speed * speed);
    return { force: side * drop * 0.6 * M.length * M.draught };
  }

  /** The races' water velocity at (x, y, z), into a flow sample: their axial speed, still water elsewhere. */
  private flow(x: number, y: number, z: number, out?: FlowSample): FlowSample {
    const o = out ?? { velocity: [0, 0, 0], density: 0, temperature: 288.15 },
      p: Vec3 = [x, y, z],
      v = this.flowSample;
    o.velocity[0] = o.velocity[1] = o.velocity[2] = 0;
    for (const { status } of this.runtime) {
      if (!status.race) continue;
      raceVelocity(status.race, p, v);
      o.velocity[0] += v[0];
      o.velocity[1] += v[1];
      o.velocity[2] += v[2];
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

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [this.rudders];
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
