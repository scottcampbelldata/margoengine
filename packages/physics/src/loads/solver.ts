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
// The added mass is held implicitly, as the hull solver holds its own: F_held = M (M + A)^-1 (F + W) - W, its translational
// part, so a body far lighter than the water it moves stays stable. The water's velocity and acceleration come from the sea
// (a `SeaSurface`'s `water`) plus any other flows (a ship's race, a river), the acceleration by a centred difference of the
// pure sample in time.
//
// State: the wake oscillators. Couple it before the rigid solver: `world.couple(['loads', 'rigid'], 'staggered')`.
import { invalidLoad } from './errors.js';
import type { FlowField, FlowSample, SeaSurface, Wind } from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { pow } from '@margoengine/math/pinned';
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
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { boxSurface, ellipsoidHydrostatics, meshHydrostatics } from './buoyancy.js';
import { cylinderCoefficients, sphereDrag, tangentialDrag, wakeStep } from './morison.js';
import { memberOrbit } from './oscillatory.js';
import { type LoadRadiationMode, prepareRadiation, type RadiationMode } from './radiation.js';
import { ellipsoidAddedInertia, ellipsoidAddedMass, equivalentEllipsoid } from './shapes.js';
import { smoothOscillatoryCylinder } from './smooth-cylinder.js';
import { flowAcceleration, waterAcceleration, waterVelocity } from './water.js';

type Vec3 = [number, number, number];
const LOADS_LAYOUT = 1;
/** Sea water's kinematic viscosity at 15 degrees C, m^2/s (DNV-RP-C205 table F-1). */
export const SEA_WATER_VISCOSITY = 1.19e-6;

/** The water a {@link LoadSolver} loads bodies in: its surface's height, its flow and its density. */
export type LoadWater = Pick<SeaSurface, 'elevation' | 'water' | 'density'>;
type PressureWater = LoadWater & Partial<Pick<SeaSurface, 'pressure'>>;

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
  /** Rotational added inertia in m² per displaced kilogram, or 'ellipsoid' for Lamb's value. Default zero. */
  readonly addedInertia?: 'ellipsoid' | readonly [number, number, number];
  /** Passive exponential radiation kernels in the principal motions at the rigid centre of mass. Default empty. */
  readonly radiation?: readonly LoadRadiationMode[];
  /** 'surface' integrates incident pressure on a box or closed mesh. Default 'compact' uses a local plane and point acceleration. */
  readonly pressureModel?: 'compact' | 'surface';
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
  /** The dominant wave period in seconds (default 8), or Infinity for steady flow. */
  readonly period?: number;
  /** Use the measured smooth-cylinder interpolation for oscillatory flow. Default 'dnv' uses DNV/White. */
  readonly coefficients?: 'dnv' | 'sarpkaya-1976';
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
  readonly sphere: boolean;
  /** A box's exact half extents, also used for its vertical support. */
  readonly box: Vec3 | undefined;
  /** Body-local pressure integration surface relative to the geometric centre. */
  readonly mesh: HullMesh | undefined;
}

interface BodyLoads {
  mass: number;
  force: Vec3;
  torque: Vec3;
  added: Float64Array;
  rotational?: Float64Array;
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
  private g = 9.81;
  private nu = SEA_WATER_VISCOSITY;
  private sea!: PressureWater;
  private flows: readonly FlowField[] = [];
  private wind: Wind | undefined;
  private bodies: BodyRuntime[] = [];
  private members: readonly LoadMember[] = [];
  private memberLoads: MemberLoad[] = [];
  private forces!: Region;
  private wakes!: Region;
  private history: Region | undefined;
  private cell: [number, number, number] = [0, 0, 0];
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly hydrostatic: WettedLoads = { force: [0, 0, 0], torque: [0, 0, 0], area: 0 };
  private readonly pressure: WettedLoads = { force: [0, 0, 0], torque: [0, 0, 0], area: 0 };

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
      throw invalidLoad(
        'Loads in the water need the water: pass {sea}, a SeaSurface (a SpectralSea or NonlinearSea) or {elevation, water, density}.',
      );
    if (!(sea.density > 0 && Number.isFinite(sea.density)))
      throw invalidLoad('Invalid water density for hydrodynamic loads; pass positive finite kg/m³.');
    if (!(viscosity > 0 && Number.isFinite(viscosity)))
      throw invalidLoad(`A kinematic viscosity is finite m^2/s above 0 (got ${viscosity}); pass one, or 1.19e-6.`);
    if (!(Number.isInteger(level) && level >= 0 && level <= 7))
      throw invalidLoad(`A rate level is a whole number from 0 to 7 (got ${level}); pass one.`);
    this.host = host;
    this.g = gravityMagnitude(host.gravity ?? DEFAULT_GRAVITY);
    this.sea = sea;
    this.flows = flows;
    this.wind = wind;
    this.nu = viscosity;
    this.level = level as RateLevel;
    const rows: number[] = [];
    let radiationWords = 1;
    this.bodies = bodies.map((spec) => {
      if (!(Number.isInteger(spec?.row) && spec.row >= 0))
        throw invalidLoad(`A body's row is a whole number, 0 or more (got ${spec?.row}); pass the body's row.`);
      rows.push(spec.row);
      if (spec.radiation !== undefined && !Array.isArray(spec.radiation))
        throw invalidLoad('Invalid radiation modes; supply an array of axis, strength and decayTime records.');
      const modes = (spec.radiation ?? []).map((mode) => {
        const prepared = prepareRadiation(mode, 1 / rateOf(this.level), radiationWords);
        radiationWords += 2;
        return prepared;
      });
      return this.prepare(spec, modes);
    });
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
    if (radiationWords > 1) this.history = host.allocate('radiation', radiationWords * 8, 'f64', LOADS_LAYOUT);
    // The wake oscillators start at the free van der Pol cycle's amplitude, q = 2.
    const wakes = regionWords(host.memory, this.wakes) as Float64Array;
    for (let i = 0; i < members.length; i++) wakes[2 * i] = 2;
  }

  /** A body's equivalent ellipsoid, frame and added mass. */
  private prepare(spec: LoadBody, radiation: readonly RadiationMode[]): BodyRuntime {
    const shape = spec.shape;
    if (!shape || typeof shape !== 'object')
      throw invalidLoad('Missing hydrodynamic shape; pass {ellipsoid}, {sphere}, {box} or {mesh}.');
    let axes: Vec3,
      frame: [Vec3, Vec3, Vec3] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      centre: Vec3 = spec.centre ? [spec.centre[0], spec.centre[1], spec.centre[2]] : [0, 0, 0],
      volume: number | undefined,
      mesh: HullMesh | undefined,
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
    } else throw invalidLoad('Missing hydrodynamic shape; pass {ellipsoid}, {sphere}, {box} or {mesh}.');
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
    const sphere = Math.max(...axes) < 1.05 * Math.min(...axes),
      addedMass = (spec.addedMass ? [...spec.addedMass] : ellipsoidAddedMass(axes)) as Vec3;
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
    return { spec, axes, frame, centre, volume, addedMass, addedInertia, radiation, sphere, box, mesh };
  }

  /** The water's velocity at a point and time: the sea's water plus every flow (water.ts). */
  private water(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    return waterVelocity(this.sea, this.flows, x, y, z, t, this.sample, out);
  }

  /** The water's acceleration at a point: a centred difference of its pure velocity over 2 ms (water.ts). */
  private acceleration(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    return waterAcceleration(this.sea, this.flows, x, y, z, t, this.sample, out);
  }

  step(context: StepContext, _dt: number): void {
    this.cell = [context.cell[0], context.cell[1], context.cell[2]];
    const out = regionWords(this.host.memory, this.forces) as Float64Array,
      wakes = regionWords(this.host.memory, this.wakes) as Float64Array,
      dt = 1 / rateOf(context.level),
      t = (context.tick + 0.5) / rateOf(context.level),
      rho = this.sea.density,
      history = this.history ? (regionWords(this.host.memory, this.history) as Float64Array) : undefined;
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
      this.loadBody(b, bodies, at, t, dt, rho, history);
    }
    this.members.forEach((m, index) => this.loadMember(m, index, bodies, t, dt, rho, wakes));
    this.hold(out, bodies);
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
    const centre = add(origin, rotate(q, b.centre)),
      axesWorld = b.frame.map((d) => rotate(q, d)) as [Vec3, Vec3, Vec3],
      [ax, ay, az] = b.axes,
      // The ellipsoid's half-height along the vertical (its support function along up).
      h0 = ax * axesWorld[0][1],
      h1 = ay * axesWorld[1][1],
      h2 = az * axesWorld[2][1],
      surface = this.sea.elevation(centre[0], centre[2], t),
      // Vertical support bounds for the compact and ellipsoid calculations.
      half = b.box
        ? Math.abs(b.box[0] * axesWorld[0][1]) +
          Math.abs(b.box[1] * axesWorld[1][1]) +
          Math.abs(b.box[2] * axesWorld[2][1])
        : Math.sqrt(h0 * h0 + h1 * h1 + h2 * h2);
    if (!Number.isFinite(surface))
      throw invalidLoad('Non-finite hydrodynamic surface height; return a finite elevation in metres.');
    const depth = surface - centre[1];
    const densityGravity = rho * this.g;
    const surfacePressure = b.spec.pressureModel === 'surface';
    const force: Vec3 = [0, 0, 0];
    let submerged: number;
    let torque: Vec3;
    if (surfacePressure) {
      const pose = { position: centre, rotation: q };
      wettedLoads(
        b.mesh!,
        pose,
        {
          elevation: (x, z, time) => this.sea.elevation(x, z, time),
          pressure: (x, y, z, time) => Math.max(0, this.sea.elevation(x, z, time) - y),
        },
        t,
        cm,
        this.hydrostatic,
      );
      submerged = Math.max(0, Math.min(b.volume, this.hydrostatic.force[1]));
      wettedLoads(b.mesh!, pose, this.sea, t, cm, this.pressure);
      torque = [...this.pressure.torque];
      if (!this.pressure.force.every(Number.isFinite) || !torque.every(Number.isFinite))
        throw invalidLoad(
          'Non-finite mesh pressure load; return finite water elevations and gauge pressure in pascals.',
        );
    } else if (b.mesh) {
      meshHydrostatics(b.mesh, q, depth, sub(cm, centre), this.hydrostatic);
      submerged = Math.max(0, Math.min(b.volume, this.hydrostatic.force[1]));
      torque = [densityGravity * this.hydrostatic.torque[0], 0, densityGravity * this.hydrostatic.torque[2]];
    } else {
      const offset: Vec3 = [0, 0, 0];
      submerged = b.volume * ellipsoidHydrostatics(b.axes, axesWorld, half, depth, offset);
      const buoyancyArm = add(sub(centre, cm), offset);
      torque = cross(buoyancyArm, [0, densityGravity * submerged, 0]);
    }
    const wet = submerged / b.volume;
    const buoyancy = densityGravity * submerged;
    let added: Vec3 = [0, 0, 0];
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
    if (surfacePressure) {
      for (let k = 0; k < 3; k++) acc.force[k]! += this.pressure.force[k]!;
    } else acc.force[1] += buoyancy;
    for (let axis = 0; axis < 3; axis++) {
      addInertiaAxis(acc.added, axesWorld[axis]!, added[axis]!);
      const inertia = b.addedInertia[axis]! * rho * submerged;
      if (inertia > 0) addInertiaAxis((acc.rotational ??= new Float64Array(9)), axesWorld[axis]!, inertia);
    }
    if (history && b.radiation.length > 0) {
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
        const wrench = angular ? acc.torque : acc.force;
        for (let k = 0; k < 3; k++) wrench[k]! += load * direction[k]!;
        if (inertia > 0) {
          const addedMatrix = angular ? (acc.rotational ??= new Float64Array(9)) : acc.added;
          addInertiaAxis(addedMatrix, direction, inertia);
        }
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
  private hold(out: Float64Array, bodies: Float32Array | undefined): void {
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
      const torque =
        r.rotational && bodies ? holdTorque(r.torque, r.rotational, bodies, row * BODY_WORDS + 17) : r.torque;
      for (let k = 0; k < 3; k++) {
        out[at + k]! += held[k]! - W[k]!;
        out[at + 3 + k]! += torque[k]!;
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
        q = wakeStep(wakes, index, wf, 0, dt);
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
    if (!load) throw invalidLoad(`There is no member ${index}; pass 0 to ${this.memberLoads.length - 1}.`);
    return load;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return this.history ? [this.wakes, this.history] : [this.wakes];
  }

  extraState(): readonly Region[] {
    return [this.forces];
  }
}

function addInertiaAxis(matrix: Float64Array, direction: Vec3, coefficient: number): void {
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++)
      matrix[row * 3 + column]! += coefficient * direction[row]! * direction[column]!;
}

function holdTorque(torque: Vec3, added: Float64Array, bodies: Float32Array, at: number): Vec3 {
  // Solve (identity + A * dry mobility) * held = torque. Inverse inertia comes
  // from BODIES, including singular mobility when the rigid body is axis-locked.
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
