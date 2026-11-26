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
import type { SeaSurface } from '@margoengine/math/fields';
import { cos, sin } from '@margoengine/math/pinned';
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
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, FORCE_WORDS } from '../world/solvers/rigid.js';
import { type HullMemory, hullMemory } from './memory.js';
import { addedMassInfinite, hullSections } from './strips.js';
import {
  GRAVITY,
  type HullMesh,
  SEA_WATER,
  type SeaQuery,
  type Vec3,
  type WettedLoads,
  wettedLoads,
} from './wetted.js';

/** A hull: the kernel body row it is the hull of, and its surface in the body's frame. */
export interface Hull {
  readonly row: number;
  readonly mesh: HullMesh;
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
  /** Body rows its `bodyForces` port covers (default one past the highest hull row). */
  readonly capacity?: number;
  /** The rigid world's gravity, m/s^2 (default [0, -9.81, 0]): the weight the added-mass solve takes with the load. */
  readonly gravity?: Vec3;
  /** Carry the water a hull moves (default true): its added mass at infinite frequency from its sections (strips.ts). */
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
   * Damp a hull's roll by its bilge eddies and its skin friction (default true): Ikeda's component method (viscous.ts), the
   * viscous part of roll damping that potential flow leaves out and that damps a real hull's roll most near its resonance.
   */
  readonly rollDamping?: boolean;
  /** The water's kinematic viscosity, m^2/s (default 1.19e-6, sea water at 15 degrees C; fresh water 1.14e-6). */
  readonly viscosity?: number;
}

/** Sea water's kinematic viscosity at 15 degrees C, m^2/s (ITTC 7.5-02-01-03, 2011). */
export const SEA_VISCOSITY = 1.19e-6;

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
  private readonly loads: WettedLoads = { force: [0, 0, 0], torque: [0, 0, 0], area: 0 };
  private gravity: Vec3 = [0, -GRAVITY, 0];
  private addedMass = true;
  private stations = 24;
  private radiation = true;
  private lags = 0;
  private history: Region | null = null;
  /** Per hull: 1 once it has radiated, then the radiation force of its last step (body frame, force then moment). */
  private radiated: Region | null = null;
  /** Per hull: 1 once it has a last step, the body's velocity (linear, angular) then and the load the solver held over it. */
  private carry: Region | null = null;
  private readonly memories = new Map<Hull, HullMemory>();
  private rollDamping = true;
  private viscosity = SEA_VISCOSITY;
  /** Per hull: its eddy coefficient, its linear (friction) roll damping and its roll inertia with the water it carries. */
  private readonly rolls = new Map<Hull, { eddy: number; linear: number; inertia: number }>();

  constructor(readonly id = 'hull') {}

  describe(): SolverDescription {
    const level = this.level;
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
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
    for (const hull of hulls) {
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
    const capacity = params.capacity ?? Math.max(...hulls.map((h) => h.row)) + 1;
    if (!(Number.isInteger(capacity) && hulls.every((h) => h.row < capacity)))
      throw new RangeError(
        `A HullSolver's capacity of ${capacity} misses a hull's row; set it above every hull's row.`,
      );
    this.capacity = capacity;
    this.hulls = hulls;
    this.sea = sea;
    this.level = level;
    this.gravity = params.gravity ?? [0, -GRAVITY, 0];
    this.addedMass = params.addedMass ?? true;
    this.stations = params.stations ?? 24;
    if (!(Number.isInteger(this.stations) && this.stations >= 2))
      throw new RangeError(`A hull's stations are ${this.stations}; pass a whole number of 2 or more.`);
    this.host = host;
    this.forces = host.allocate('forces', capacity * FORCE_WORDS * 8, 'f64', HULL_LAYOUT);
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
    if (this.radiation) {
      this.history = host.allocate('history', hulls.length * this.lags * 6 * 8, 'f64', HULL_LAYOUT);
      this.radiated = host.allocate('radiated', hulls.length * 7 * 8, 'f64', HULL_LAYOUT);
    }
    if (this.addedMass) this.carry = host.allocate('carry', hulls.length * CARRY_WORDS * 8, 'f64', HULL_LAYOUT);
  }

  step(context: StepContext, dt: number): void {
    const host = this.host;
    if (!host || !this.sea || !this.forces)
      throw new MargoError('state', 'HullSolver is not in a world yet; add it with world.add(solver, {hulls, sea}).');
    const out = new Float64Array(host.memory.buffer, this.forces.byteOffset, this.capacity * FORCE_WORDS);
    out.fill(0);
    const cell = (this.sea as Partial<SeaSurface>).cell;
    if (cell && (cell[0] !== context.cell[0] || cell[1] !== context.cell[1] || cell[2] !== context.cell[2]))
      throw new MargoError(
        'state',
        `The sea's origin cell is [${cell.join(', ')}] and the HullSolver's is [${context.cell.join(', ')}]; make the sea in the hull's cell (a SpectralSea's positions are offsets from its cell).`,
      );
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    const memory = port.region.memory ?? host.memory,
      bodies = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4),
      // The middle of the step the load is held over.
      t = (context.tick + 0.5) / rateOf(context.level);
    void dt;
    for (const hull of this.hulls) {
      const at = hull.row * BODY_WORDS;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) continue;
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
        loads = wettedLoads(hull.mesh, pose, this.sea, t, centre, this.loads);
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
          loads,
        );
      if (this.rollDamping) this.dampRoll(hull, bodies, at, pose, centre, 1 / rateOf(context.level), loads);
      const w = hull.row * FORCE_WORDS,
        held = this.addedMass
          ? this.carried(hull, bodies, at, pose, centre, t, 1 / rateOf(context.level), loads)
          : [...loads.force, ...loads.torque];
      for (let k = 0; k < 6; k++) out[w + k]! += held[k]!;
    }
  }

  /** The hull's radiation memory at its still-water draft, made at its first step (from its mesh and mass alone). */
  private memoryOf(hull: Hull, bodies: Float32Array, at: number, local: Vec3, dt: number): HullMemory | null {
    const inverseMass = bodies[at + 16]!;
    if (!(inverseMass > 0)) return null;
    let memory = this.memories.get(hull);
    if (!memory) {
      memory = hullMemory(hull.mesh, 1 / inverseMass, local, this.sea!.density ?? SEA_WATER, dt, {
        stations: this.stations,
        window: Math.max(1, this.lags) * dt,
      });
      this.memories.set(hull, memory);
    }
    return memory;
  }

  /**
   * Adds the viscous roll moment to `loads`: -(eddy |p| + linear) p about the body's x axis through its centre of mass, p its
   * roll rate, taken implicitly in the damping alone (backward Euler against the roll inertia with the water carried), so a
   * light hull's eddy damping stays stable at any step: -c p / (1 + dt c / I).
   */
  private dampRoll(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    dt: number,
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
    let roll = this.rolls.get(hull);
    if (!roll) {
      roll = this.rollOf(hull, bodies, at, q, local, memory);
      this.rolls.set(hull, roll);
    }
    const p = rotate(conjugate, [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!])[0],
      c = roll.eddy * Math.abs(p) + roll.linear,
      moment = roll.inertia > 0 ? (-c * p) / (1 + (dt * c) / roll.inertia) : -c * p,
      m = rotate(q, [moment, 0, 0]);
    for (let k = 0; k < 3; k++) loads.torque[k]! += m[k]!;
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
  ): { eddy: number; linear: number; inertia: number } {
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
      inertia,
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
    const lags = this.lags,
      index = this.hulls.indexOf(hull),
      ring = new Float64Array(this.host!.memory.buffer, this.history!.byteOffset + index * lags * 6 * 8, lags * 6),
      velocity = rotate(conjugate, [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!]),
      spin = rotate(conjugate, [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!]),
      slot = tick % lags;
    ring.set([...velocity, ...spin], 6 * slot);
    const force = [0, 0, 0, 0, 0, 0];
    for (const { i, j, kernel } of memory.pairs) {
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
    // The convolution ends at the step's start (the last velocity the history holds); the load is taken theta of the step on,
    // so the force is carried there along the line through its last two values. Held from the start, it lagged the load by
    // theta dt, a phase error of w theta dt that moved a driven hull's damped response first order in the step (a heaving
    // and pitching hull 9 percent off at 60 steps a second, 1 percent with the force carried on).
    const last = new Float64Array(this.host!.memory.buffer, this.radiated!.byteOffset + index * 7 * 8, 7),
      now = force.slice();
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
      body = addedMassInfinite(hullSections(hull.mesh, waterline, this.stations), local, density),
      memory = this.memoryOf(hull, bodies, at, local, dt);
    // The lateral block (sway, roll, yaw), from the radiation at the still-water draft.
    if (memory) for (let k = 0; k < 36; k++) body[k]! += memory.lateralInfinite[k]!;
    let any = false;
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
        seen[i] = sum - last[7 + i]! - weight[i]!;
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
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: [0, 0, 0] }];
  }

  importPorts(_tick: number): void {}

  /** The hulls' motion histories, which their radiation remembers. */
  stateRegions(): readonly Region[] {
    return [this.history, this.radiated, this.carry].filter((r): r is Region => r !== null);
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
