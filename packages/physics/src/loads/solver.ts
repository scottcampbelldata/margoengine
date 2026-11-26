// Hydrodynamic loads on bodies in the water as a solver of the physics framework (SEA-12): divers, debris, buoys, hoses,
// piles and dolphins. Each step it reads where the bodies are from the rigid solver's `bodies` port and holds them through
// `bodyForces` with the water's loads (morison.ts, shapes.ts):
// - a compact body (a diver, a crate, a buoy) as its equivalent ellipsoid: buoyancy of its submerged share (the share of an
//   ellipsoid under a plane is the sphere's, (2 + 3 s - s^3) / 4 at s, the centre's depth over the ellipsoid's half-height
//   along the vertical), the Froude-Krylov force rho V a, added mass per axis from Lamb's integrals, quadratic drag on its
//   relative velocity per axis over its projected areas (a box's submerged share is a prism's, linear in depth), a rotating body's drag by strip theory along each axis, and the
//   wind's drag on its emerged share, so floating debris drifts at a few percent of the wind as the leeway measurements say;
// - a member (a pile, a dolphin, a hose segment, a diver's limb) by Morison's equation over its wetted length at two Gauss
//   points, its drag and added mass coefficients from its roughness and Keulegan-Carpenter number (DNV-RP-C205), the
//   tangential drag of Eames, and optionally its vortex shedding by Facchinetti's wake oscillator, the lift 1/4 rho U^2 D
//   C_L0 q across the flow; a member on no body is fixed (a pile) and its load is reported.
// The added mass is held implicitly, as the hull solver holds its own: F_held = M (M + A)^-1 (F + W) - W, its translational
// part, so a body far lighter than the water it moves stays stable. The water's velocity and acceleration come from the sea
// (a `SeaSurface`'s `water`) plus any other flows (a ship's race, a river), the acceleration by a centred difference of the
// pure sample in time.
//
// State: the wake oscillators. Couple it before the rigid solver: `world.couple(['loads', 'rigid'], 'staggered')`.
import type { FlowField, FlowSample, SeaSurface, Wind } from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { pow } from '@margoengine/math/pinned';
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
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, FORCE_WORDS } from '../world/solvers/rigid.js';
import { cylinderCoefficients, sphereDrag, tangentialDrag } from './morison.js';
import { ellipsoidAddedMass, equivalentEllipsoid } from './shapes.js';

type Vec3 = [number, number, number];
const LOADS_LAYOUT = 1;
/** Sea water's kinematic viscosity at 15 degrees C, m^2/s (DNV-RP-C205 table F-1). */
export const SEA_WATER_VISCOSITY = 1.19e-6;

/** The water a {@link LoadSolver} loads bodies in: its surface's height, its flow and its density. */
export type LoadWater = Pick<SeaSurface, 'elevation' | 'water' | 'density'>;

/** A compact body's shape in its frame: an ellipsoid (semi-axes, m), a sphere (radius), a box (half extents) or a mesh. */
export type LoadShape =
  | { readonly ellipsoid: readonly [number, number, number] }
  | { readonly sphere: number }
  | { readonly box: readonly [number, number, number] }
  | { readonly mesh: { readonly vertices: ArrayLike<number>; readonly indices: ArrayLike<number> } };

/** A compact body in the water. */
export interface LoadBody {
  readonly row: number;
  readonly shape: LoadShape;
  /** Where the shape's centre is in the body's frame, m (default the body's origin; a mesh's own centroid when a mesh). */
  readonly centre?: readonly [number, number, number];
  /** Drag coefficients along the shape's three axes (default a sphere's by Reynolds number, else 1.0, a bluff body). */
  readonly drag?: number | readonly [number, number, number];
  /** Added mass coefficients along its three axes (default Lamb's for the ellipsoid; 0.25 of the body's mass across for a diver, `0.68` for a cube). */
  readonly addedMass?: readonly [number, number, number];
  /** The wind's drag coefficient on its emerged part (default 1.0). */
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
  /** The period of the waves for its Keulegan-Carpenter number, s (default 8). */
  readonly period?: number;
  /** Vortex shedding: Strouhal number and fixed-cylinder lift amplitude (default none; {strouhal: 0.2, lift: 0.3}). */
  readonly vortex?: { readonly strouhal?: number; readonly lift?: number };
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
  /** Body rows its `bodyForces` port covers (default one past the highest row). */
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
  readonly sphere: boolean;
  /** A box's half extents (its submerged share is a prism's, linear in depth), or none for an ellipsoid's. */
  readonly box: Vec3 | undefined;
}

/** A member's load from the last step, world axes: force, N, at its middle, and its wake's lift coefficient. */
export interface MemberLoad {
  force: Vec3;
  lift: number;
}

/** The water's loads on bodies and members. `id` is `'loads'` by default. */
export class LoadSolver implements Solver<LoadParams> {
  private readonly id: string;
  private host!: SolverHost;
  private level: RateLevel = 0;
  private capacity = 0;
  private g = 9.81;
  private nu = SEA_WATER_VISCOSITY;
  private sea!: LoadWater;
  private flows: readonly FlowField[] = [];
  private wind: Wind | undefined;
  private bodies: BodyRuntime[] = [];
  private members: readonly LoadMember[] = [];
  private memberLoads: MemberLoad[] = [];
  private forces!: Region;
  private wakes!: Region;
  private cell: [number, number, number] = [0, 0, 0];
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  constructor(id = 'loads') {
    this.id = id;
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

  init(host: SolverHost, params: LoadParams): void {
    const {
      sea,
      flows = [],
      wind,
      bodies = [],
      members = [],
      viscosity = SEA_WATER_VISCOSITY,
      level = 0,
    } = params ?? ({} as LoadParams);
    if (!sea || typeof sea.elevation !== 'function' || typeof sea.water?.sample !== 'function')
      throw new TypeError(
        'Loads in the water need the water: pass {sea}, a SeaSurface (a SpectralSea or NonlinearSea) or {elevation, water, density}.',
      );
    if (!(sea.density > 0)) throw new RangeError(`The water's density is above 0 (got ${sea.density}); pass kg/m^3.`);
    if (!(viscosity > 0 && Number.isFinite(viscosity)))
      throw new RangeError(`A kinematic viscosity is finite m^2/s above 0 (got ${viscosity}); pass one, or 1.19e-6.`);
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    this.host = host;
    this.g = gravityMagnitude(host.gravity ?? DEFAULT_GRAVITY);
    this.sea = sea;
    this.flows = flows;
    this.wind = wind;
    this.nu = viscosity;
    this.level = level as RateLevel;
    let top = -1;
    this.bodies = bodies.map((spec) => {
      if (!(Number.isInteger(spec?.row) && spec.row >= 0))
        throw new RangeError(`A body's row is a whole number, 0 or more (got ${spec?.row}); pass the body's row.`);
      top = Math.max(top, spec.row);
      return this.prepare(spec);
    });
    for (const m of members) {
      if (
        !(m?.diameter > 0 && m.from?.length === 3 && m.to?.length === 3 && [...m.from, ...m.to].every(Number.isFinite))
      )
        throw new RangeError(
          'A member is {from: [x, y, z], to: [x, y, z], diameter} in metres, its diameter above 0; pass them.',
        );
      if (m.row !== undefined) {
        if (!(Number.isInteger(m.row) && m.row >= 0))
          throw new RangeError(
            `A member's row is a whole number, 0 or more, or none for a fixed pile (got ${m.row}); pass one.`,
          );
        top = Math.max(top, m.row);
      }
    }
    this.members = members;
    this.memberLoads = members.map(() => ({ force: [0, 0, 0], lift: 0 }));
    this.capacity = params.capacity ?? top + 1;
    this.forces = host.allocate('forces', Math.max(1, this.capacity) * FORCE_WORDS * 8, 'f64', LOADS_LAYOUT);
    this.wakes = host.allocate('wakes', Math.max(1, members.length) * 2 * 8, 'f64', LOADS_LAYOUT);
    // The wake oscillators start at the free van der Pol cycle's amplitude, q = 2.
    const wakes = regionWords(host.memory, this.wakes) as Float64Array;
    for (let i = 0; i < members.length; i++) wakes[2 * i] = 2;
  }

  /** A body's equivalent ellipsoid, frame and added mass. */
  private prepare(spec: LoadBody): BodyRuntime {
    const shape = spec.shape as Record<string, unknown>;
    let axes: Vec3,
      frame: [Vec3, Vec3, Vec3] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      centre: Vec3 = spec.centre ? [spec.centre[0], spec.centre[1], spec.centre[2]] : [0, 0, 0],
      volume: number;
    if (shape && 'sphere' in shape) {
      const r = shape.sphere as number;
      if (!(r > 0)) throw new RangeError(`A sphere's radius is above 0 (got ${r}); pass one.`);
      axes = [r, r, r];
    } else if (shape && 'ellipsoid' in shape) axes = [...(shape.ellipsoid as Vec3)] as Vec3;
    else if (shape && 'box' in shape) {
      // A box as the ellipsoid of its second moments: semi-axes sqrt(5/3) of its half extents, its volume kept below.
      const h = shape.box as Vec3;
      axes = [h[0] * Math.sqrt(5 / 3), h[1] * Math.sqrt(5 / 3), h[2] * Math.sqrt(5 / 3)];
    } else if (shape && 'mesh' in shape) {
      const e = equivalentEllipsoid(shape.mesh as { vertices: ArrayLike<number>; indices: ArrayLike<number> });
      axes = e.axes;
      frame = e.directions;
      if (!spec.centre) centre = e.centre;
    } else throw new TypeError('A body in the water has a shape: {ellipsoid}, {sphere}, {box} or {mesh}; pass one.');
    if (!axes.every((a) => a > 0 && Number.isFinite(a)))
      throw new RangeError(`A body's semi-axes are finite and above 0 (got ${axes.join(', ')}); pass them.`);
    volume = (4 / 3) * Math.PI * axes[0] * axes[1] * axes[2];
    if (shape && 'box' in shape) {
      const h = shape.box as Vec3;
      volume = 8 * h[0] * h[1] * h[2];
    }
    const sphere = Math.max(...axes) < 1.05 * Math.min(...axes),
      addedMass = (spec.addedMass ? [...spec.addedMass] : ellipsoidAddedMass(axes)) as Vec3;
    const box = shape && 'box' in shape ? ([...(shape.box as Vec3)] as Vec3) : undefined;
    return { spec, axes, frame, centre, volume, addedMass, sphere, box };
  }

  /** The water's velocity at a point and time: the sea's water plus every flow. */
  private water(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    const s = this.sea.water.sample(x, y, z, t, this.sample);
    out[0] = s.velocity[0];
    out[1] = s.velocity[1];
    out[2] = s.velocity[2];
    for (const flow of this.flows) {
      const f = flow.sample(x, y, z, t, this.sample);
      out[0] += f.velocity[0];
      out[1] += f.velocity[1];
      out[2] += f.velocity[2];
    }
    return out;
  }

  /** The water's acceleration at a point: a centred difference of its pure velocity over 2 ms. */
  private acceleration(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    const a: Vec3 = [0, 0, 0],
      b: Vec3 = [0, 0, 0],
      h = 1e-3;
    this.water(x, y, z, t + h, a);
    this.water(x, y, z, t - h, b);
    out[0] = (a[0] - b[0]) / (2 * h);
    out[1] = (a[1] - b[1]) / (2 * h);
    out[2] = (a[2] - b[2]) / (2 * h);
    return out;
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array,
      wakes = regionWords(this.host.memory, this.wakes) as Float64Array,
      dt = 1 / rateOf(context.level),
      t = (context.tick + 0.5) / rateOf(context.level),
      rho = this.sea.density;
    out.fill(0);
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name),
      bodies = port
        ? new Float32Array(
            (port.region.memory ?? this.host.memory).buffer,
            port.region.byteOffset,
            port.region.byteLength / 4,
          )
        : undefined;
    for (const b of this.bodies) {
      if (!bodies) break;
      const at = b.spec.row * BODY_WORDS;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) continue;
      this.loadBody(b, bodies, at, t, rho, out);
    }
    this.members.forEach((m, index) => this.loadMember(m, index, bodies, t, dt, rho, wakes));
    this.hold(out);
  }

  /** A compact body's load, held with its added mass. */
  private loadBody(b: BodyRuntime, bodies: Float32Array, at: number, t: number, rho: number, out: Float64Array): void {
    const q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
      origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
      cm: Vec3 = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!],
      v: Vec3 = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!],
      w: Vec3 = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!],
      inverseMass = bodies[at + 16]!,
      mass = inverseMass > 0 ? 1 / inverseMass : 0;
    if (mass === 0) return;
    const centre = add(origin, rotate(q, b.centre)),
      axesWorld = b.frame.map((d) => rotate(q, d)) as [Vec3, Vec3, Vec3],
      [ax, ay, az] = b.axes,
      // The ellipsoid's half-height along the vertical (its support function along up).
      h0 = ax * axesWorld[0][1],
      h1 = ay * axesWorld[1][1],
      h2 = az * axesWorld[2][1],
      surface = this.sea.elevation(centre[0], centre[2], t),
      // The submerged share: a box's as a prism of its vertical extent (exact upright), an ellipsoid's as a sphere's cap.
      half = b.box
        ? Math.abs(b.box[0] * axesWorld[0][1]) +
          Math.abs(b.box[1] * axesWorld[1][1]) +
          Math.abs(b.box[2] * axesWorld[2][1])
        : Math.sqrt(h0 * h0 + h1 * h1 + h2 * h2),
      s = Math.max(-1, Math.min(1, (surface - centre[1]) / half)),
      wet = b.box ? (1 + s) / 2 : (2 + 3 * s - s * s * s) / 4;
    const force: Vec3 = [0, 0, 0],
      torque: Vec3 = [0, 0, 0];
    let added: Vec3 = [0, 0, 0];
    if (wet > 0) {
      const u = this.water(centre[0], Math.min(centre[1], surface), centre[2], t, [0, 0, 0]),
        a = this.acceleration(centre[0], Math.min(centre[1], surface), centre[2], t, [0, 0, 0]),
        vc = add(v, cross(w, sub(centre, cm))),
        vr = sub(u, vc),
        speed = Math.sqrt(dot(vr, vr)),
        submerged = wet * b.volume;
      // Buoyancy and the Froude-Krylov force: the water's pressure gradient, rho V (a - g).
      force[1] += rho * this.g * submerged;
      for (let k = 0; k < 3; k++) force[k]! += rho * submerged * a[k]!;
      // Added mass per axis: its part pushed by the water's acceleration, rho C_A V a; the part the body's own acceleration
      // takes is held implicitly below.
      added = b.addedMass.map((c) => c * rho * submerged) as Vec3;
      for (let i = 0; i < 3; i++) {
        const along = dot(a, axesWorld[i]!);
        for (let k = 0; k < 3; k++) force[k]! += added[i]! * along * axesWorld[i]![k]!;
      }
      // Drag on the relative velocity per axis, over the projected area across each axis.
      const areas = [Math.PI * ay * az, Math.PI * ax * az, Math.PI * ax * ay],
        diameter = 2 * pow(ax * ay * az, 1 / 3),
        given = b.spec.drag,
        cd = (i: number) =>
          given === undefined
            ? b.sphere && speed > 0
              ? sphereDrag((speed * diameter) / this.nu)
              : 1
            : typeof given === 'number'
              ? given
              : given[i]!;
      for (let i = 0; i < 3; i++) {
        const along = dot(vr, axesWorld[i]!),
          f = 0.5 * rho * cd(i) * areas[i]! * wet * speed * along;
        for (let k = 0; k < 3; k++) force[k]! += f * axesWorld[i]![k]!;
      }
      // A spinning body's drag by strip theory: about axis i, the two others sweep as rods, -1/2 rho C_D w |w| (a_j a_k^4 +
      // a_k a_j^4) / 2.
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3,
          k2 = (i + 2) % 3,
          spin = dot(w, axesWorld[i]!),
          aj = b.axes[j]!,
          ak = b.axes[k2]!,
          lever = (aj * ak * ak * ak * ak + ak * aj * aj * aj * aj) / 2,
          m = -0.5 * rho * cd(i) * wet * spin * Math.abs(spin) * lever;
        for (let k = 0; k < 3; k++) torque[k]! += m * axesWorld[i]![k]!;
      }
    }
    // The wind on the emerged part.
    if (this.wind && wet < 1) {
      const air = this.wind.sample(centre[0], Math.max(centre[1], surface) + 1, centre[2], t, this.sample),
        rel: Vec3 = [air.velocity[0] - v[0], 0, air.velocity[2] - v[2]],
        speed = Math.sqrt(dot(rel, rel)),
        horizontal = Math.sqrt(ax * ay + ay * az + ax * az),
        area = Math.PI * horizontal * half * (1 - wet),
        f = 0.5 * (air.density || 1.225) * (b.spec.windage ?? 1) * area * speed;
      force[0] += f * rel[0];
      force[2] += f * rel[2];
    }
    // The added mass tensor sum_i A_i e_i e_i^T in world axes, held with the row's other loads.
    const acc = this.rowOf(b.spec.row, mass),
      arm = cross(sub(centre, cm), force);
    for (let k = 0; k < 3; k++) {
      acc.force[k]! += force[k]!;
      acc.torque[k]! += torque[k]! + arm[k]!;
    }
    for (let i = 0; i < 3; i++)
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) acc.added[3 * r + c]! += added[i]! * axesWorld[i]![r]! * axesWorld[i]![c]!;
  }

  /** The loads gathered for a body row this step. */
  private rows = new Map<number, { mass: number; force: Vec3; torque: Vec3; added: Float64Array }>();
  private rowOf(row: number, mass: number): { mass: number; force: Vec3; torque: Vec3; added: Float64Array } {
    let r = this.rows.get(row);
    if (!r) {
      r = { mass, force: [0, 0, 0], torque: [0, 0, 0], added: new Float64Array(9) };
      this.rows.set(row, r);
    }
    return r;
  }

  /** Writes each row's loads, held with its added mass: F_held = M (M I + A)^-1 (F + W) - W, its translational part. */
  private hold(out: Float64Array): void {
    for (const [row, r] of this.rows) {
      const m = r.mass,
        W: Vec3 = [0, -m * this.g, 0],
        F = add(r.force, W),
        a = r.added,
        M = [m + a[0]!, a[1]!, a[2]!, a[3]!, m + a[4]!, a[5]!, a[6]!, a[7]!, m + a[8]!],
        inverse = invert3(M),
        held: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++)
        held[k] = m * (inverse[3 * k]! * F[0] + inverse[3 * k + 1]! * F[1] + inverse[3 * k + 2]! * F[2]);
      const at = row * FORCE_WORDS;
      for (let k = 0; k < 3; k++) {
        out[at + k]! += held[k]! - W[k]!;
        out[at + 3 + k]! += r.torque[k]!;
      }
    }
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
  ): void {
    let from: Vec3 = [m.from[0], m.from[1], m.from[2]],
      to: Vec3 = [m.to[0], m.to[1], m.to[2]],
      v: Vec3 = [0, 0, 0],
      w: Vec3 = [0, 0, 0],
      cm: Vec3 = [0, 0, 0],
      mass = 0,
      onBody = false;
    if (m.row !== undefined) {
      if (!bodies) return;
      const at = m.row * BODY_WORDS;
      if (at + BODY_WORDS > bodies.length || bodies[at + 23] !== 1) return;
      const q: [number, number, number, number] = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
        origin: Vec3 = [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!];
      from = add(origin, rotate(q, m.from));
      to = add(origin, rotate(q, m.to));
      v = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!];
      w = [bodies[at + 13]!, bodies[at + 14]!, bodies[at + 15]!];
      cm = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!];
      mass = bodies[at + 16]! > 0 ? 1 / bodies[at + 16]! : 0;
      if (mass === 0) return;
      onBody = true;
    }
    const axis = sub(to, from),
      length = Math.sqrt(dot(axis, axis));
    if (!(length > 0)) return;
    const e = scale(axis, 1 / length),
      D = m.diameter,
      area = (Math.PI * D * D) / 4,
      roughness = (m.roughness ?? 5e-5) / D,
      period = m.period ?? 8,
      total: Vec3 = [0, 0, 0],
      moment: Vec3 = [0, 0, 0],
      added = new Float64Array(9);
    let liftSum = 0,
      wetSpeed = 0,
      across: Vec3 = [0, 0, 0];
    // Two-point Gauss over the member.
    for (const g of [0.5 - 0.5 / Math.sqrt(3), 0.5 + 0.5 / Math.sqrt(3)]) {
      const p = add(from, scale(axis, g));
      if (p[1] > this.sea.elevation(p[0], p[2], t)) continue;
      const u = this.water(p[0], p[1], p[2], t, [0, 0, 0]),
        a = this.acceleration(p[0], p[1], p[2], t, [0, 0, 0]),
        vp = onBody ? add(v, cross(w, sub(p, cm))) : ([0, 0, 0] as Vec3),
        vr = sub(u, vp),
        vrN = sub(vr, scale(e, dot(vr, e))),
        aN = sub(a, scale(e, dot(a, e))),
        speedN = Math.sqrt(dot(vrN, vrN)),
        speed = Math.sqrt(dot(vr, vr)),
        kc = (speedN * period) / D,
        { drag, addedMass } = cylinderCoefficients(kc, roughness),
        half = length / 2,
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
      wetSpeed = Math.max(wetSpeed, speedN);
      if (speedN > 0) across = normalise(cross(e, vrN));
      liftSum += half;
    }
    // Vortex shedding: van der Pol's wake q'' + eps w_f (q^2 - 1) q' + w_f^2 q = 0 at w_f = 2 pi St U / D (the member held
    // still: its cross-flow motion's coupling is left to the rigid body), lift 1/4 rho U^2 D C_L0 q across the flow.
    let lift = 0;
    if (m.vortex && wetSpeed > 0) {
      const st = m.vortex.strouhal ?? 0.2,
        cl0 = m.vortex.lift ?? 0.3,
        wf = (2 * Math.PI * st * wetSpeed) / D,
        eps = 0.3,
        steps = Math.max(1, Math.ceil((wf * dt) / 0.05)),
        h = dt / steps;
      let q = wakes[2 * index]!,
        dq = wakes[2 * index + 1]!;
      for (let k = 0; k < steps; k++) {
        // Semi-implicit Euler: the velocity first, then the position with it.
        dq += h * (-eps * wf * (q * q - 1) * dq - wf * wf * q);
        q += h * dq;
      }
      wakes[2 * index] = q;
      wakes[2 * index + 1] = dq;
      lift = 0.25 * rho * wetSpeed * wetSpeed * D * cl0 * q;
      for (let k = 0; k < 3; k++) total[k]! += lift * liftSum * across[k]!;
    }
    const report = this.memberLoads[index]!;
    report.force = [total[0], total[1], total[2]];
    // C_L = C_L0 q / 2.
    report.lift = wetSpeed > 0 ? lift / (0.5 * rho * wetSpeed * wetSpeed * D) : 0;
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
  memberLoad(index: number): MemberLoad {
    const load = this.memberLoads[index];
    if (!load) throw new RangeError(`There is no member ${index}; pass 0 to ${this.memberLoads.length - 1}.`);
    return load;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [this.wakes];
  }

  extraState(): readonly Region[] {
    return [this.forces];
  }
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
